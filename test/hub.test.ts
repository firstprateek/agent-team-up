import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHub } from '../src/http.ts';
import { BOARD_URI } from '../src/mcp.ts';
import { Store } from '../src/store.ts';

let store: Store;
let base: string;
let ownerKey: string;
const keys: Record<string, string> = {};
let close: () => Promise<void>;

before(async () => {
  store = new Store(':memory:');
  ownerKey = store.resetOwnerKey();
  for (const [n, s] of [['claude', 'writing'], ['codex', 'reviews'], ['gemini', 'browser']]) keys[n] = store.addAgent(n, s);
  const hub = createHub({ store, allowedHosts: ['hub.example'] });
  await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  close = () => new Promise((r) => { hub.closeAllConnections(); hub.close(() => r()); });
});
after(async () => {
  await close();
  store.close();
});

/** fetch() can't set Host, so use node:http for the tests that need to. */
function withHost(path: string, host: string, method = 'GET', body?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method, headers: { host, ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode!, headers: res.headers });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function connect(name: string): Promise<Client> {
  const client = new Client({ name: `test-${name}`, version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${keys[name]}` } } }));
  return client;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await c.callTool({ name, arguments: args });
  const t = (r.content as { type: string; text: string }[]).map((x) => x.text).join('\n');
  if (r.isError) throw new Error(t);
  return t;
}

async function ownerFetch(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${ownerKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('access', () => {
  test('/mcp refuses a missing or wrong key', async () => {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } };
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    let r = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(init) });
    assert.equal(r.status, 401);
    r = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, authorization: 'Bearer nope' }, body: JSON.stringify(init) });
    assert.equal(r.status, 401);
  });

  test('an unknown Host is refused (DNS rebinding)', async () => {
    assert.equal((await withHost('/board', 'evil.example')).status, 403);
    assert.equal((await withHost('/mcp', 'evil.example', 'POST', '{}')).status, 403);
    assert.equal((await withHost('/board', 'hub.example:443')).status, 200);
  });

  test('the owner API needs the owner key or a session, and refuses cross-origin writes', async () => {
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    const agentKey = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${keys.claude}` } });
    assert.equal(agentKey.status, 401, 'an agent key is not the owner key');
    assert.equal((await ownerFetch('/api/state')).status, 200);
    const cross = await ownerFetch('/api/goals', { title: 'x' }, { origin: 'https://evil.example' });
    assert.equal(cross.status, 403);
    const noJson = await fetch(`${base}/api/goals`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'text/plain' }, body: '{"title":"x"}' });
    assert.equal(noJson.status, 400);
  });

  test('signing in sets an HttpOnly, SameSite=Strict session cookie', async () => {
    const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'wrong' }) });
    assert.equal(bad.status, 401);
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: ownerKey }) });
    assert.equal(r.status, 200);
    const set = r.headers.get('set-cookie')!;
    assert.match(set, /^team_session=[\w-]+; HttpOnly; SameSite=Strict; Path=\//);
    assert.doesNotMatch(set, /Secure/, 'plain http on loopback');
    const cookie = set.split(';')[0];
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie } })).status, 200);
    const out = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(out.status, 200);
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie } })).status, 401);
    const viaHub = await withHost('/api/login', 'hub.example', 'POST', JSON.stringify({ key: ownerKey }));
    assert.match(String(viaHub.headers['set-cookie']), /Secure/, 'Secure on any non-loopback name');
  });

  test('the board page allows only its own inline script', async () => {
    const r = await fetch(`${base}/board`);
    const html = await r.text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const hash = createHash('sha256').update(script).digest('base64');
    const csp = r.headers.get('content-security-policy')!;
    assert.match(csp, new RegExp(`script-src 'sha256-${hash.replace(/[+/]/g, '\\$&')}'`));
    assert.match(csp, /frame-ancestors 'none'/);
  });
});

describe('MCP', () => {
  test('tools, and the board as an MCP App', async () => {
    const c = await connect('claude');
    const { tools } = await c.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['board', 'claim', 'post_task', 'send', 'set_status', 'team', 'update', 'wait']);
    const board = tools.find((t) => t.name === 'board')!;
    assert.equal((board._meta as { ui: { resourceUri: string } }).ui.resourceUri, BOARD_URI);
    const res = await c.readResource({ uri: BOARD_URI });
    const content = res.contents[0] as { mimeType: string; text: string };
    assert.equal(content.mimeType, 'text/html;profile=mcp-app');
    assert.match(content.text, /ui\/initialize/);
    await c.close();
  });

  test('a 2025-era client (initialize handshake, no session) works', async () => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${keys.gemini}`, 'mcp-protocol-version': '2025-06-18' };
    const post = async (body: unknown) => {
      const r = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
      const t = await r.text();
      const json = t.startsWith('{') ? t : t.split('\n').find((l) => l.startsWith('data: '))!.slice(6);
      return JSON.parse(json);
    };
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '0' } } });
    assert.equal(init.result.serverInfo.name, 'agent-team-up');
    assert.match(init.result.instructions, /Call team first/);
    const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'team', arguments: {} } });
    assert.match(r.result.content[0].text, /^You are gemini\./);
  });

  test('the whole loop: goal, task, wait, claim, handoff, question, answer', async () => {
    const claude = await connect('claude');
    const codex = await connect('codex');
    await call(codex, 'wait', { seconds: 0 }); // start clean

    // The owner posts a goal; a waiting agent wakes up for it.
    const waiting = call(codex, 'wait', { seconds: 10 });
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    const goal = await (await ownerFetch('/api/goals', { title: 'Ship v1', detail: 'Repo and article' })).json();
    const woke = await waiting;
    assert.ok(Date.now() - started < 2000, 'wait returns as soon as news arrives');
    assert.match(woke, /owner new goal G\d+ "Ship v1": Repo and article/);

    // Claude splits it and aims a task at codex.
    assert.match(await call(claude, 'post_task', { title: 'Review the claim logic', brief: 'Read src/store.ts claim(); try to make two agents hold one task.', goal: goal.id, for: 'codex' }), /Posted #\d+ .* for codex/);
    const news = await call(codex, 'wait', { seconds: 1 });
    assert.match(news, /claude posted #(\d+) "Review the claim logic" for codex/);
    const claimed = await call(codex, 'claim');
    assert.match(claimed, /You have #\d+/);
    assert.match(claimed, /Read src\/store\.ts claim\(\)/);
    const id = Number(/#(\d+)/.exec(claimed)![1]);

    // Codex hands it back to Claude with a note.
    assert.match(await call(codex, 'update', { task: id, handoff: 'claude', note: 'No race found; one nit in the PR', links: 'PR #3' }), /Handed #\d+ to claude/);
    assert.match(await call(claude, 'wait', { seconds: 1 }), /codex handed you #\d+ "Review the claim logic": No race found/);

    // Someone else can't change a task Claude holds.
    await call(claude, 'claim', { task: id });
    await assert.rejects(call(codex, 'update', { task: id, state: 'done' }), /held by claude/);

    // A question for the owner shows on the board; the answer comes back through wait.
    assert.match(await call(codex, 'send', { to: 'owner', text: 'MIT or Apache-2.0?', task: id }), /Asked the owner \(Q(\d+)\)/);
    const state = await (await ownerFetch('/api/state')).json();
    const q = state.questions.find((x: { text: string }) => x.text === 'MIT or Apache-2.0?');
    assert.ok(q);
    assert.equal((await ownerFetch(`/api/questions/${q.id}/answer`, { text: 'MIT' })).status, 200);
    assert.match(await call(codex, 'wait', { seconds: 1 }), /owner answered Q\d+ \("MIT or Apache-2\.0\?"\): MIT/);

    // The overview reflects it all.
    const team = await call(claude, 'team');
    assert.match(team, /Yours:\n- #\d+ \[working, you\] Review the claim logic \(G\d+\)/);
    const board = await claude.callTool({ name: 'board', arguments: {} });
    assert.ok((board.structuredContent as { tasks: unknown[] }).tasks.length >= 1);

    await claude.close();
    await codex.close();
  });

  test('a wait whose client goes away leaves the next message for later', async () => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${keys.gemini}`, 'mcp-protocol-version': '2025-06-18' };
    store.takeInbox('gemini');
    const ctrl = new AbortController();
    const pending = fetch(`${base}/mcp`, {
      method: 'POST',
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'wait', arguments: { seconds: 20 } } }),
    }).then((r) => r.text()).catch(() => 'aborted');
    await new Promise((r) => setTimeout(r, 300));
    ctrl.abort();
    assert.equal(await pending, 'aborted');
    await new Promise((r) => setTimeout(r, 100));
    store.send('claude', 'gemini', 'still here?');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(store.unread('gemini'), 1, 'the abandoned wait did not take it');
    store.takeInbox('gemini');
  });

  test('wait returns empty-handed after its time', async () => {
    const gemini = await connect('gemini');
    await call(gemini, 'wait', { seconds: 0 });
    const started = Date.now();
    assert.match(await call(gemini, 'wait', { seconds: 1 }), /Nothing new/);
    assert.ok(Date.now() - started >= 900);
    await gemini.close();
  });

  test('tool errors read as errors, not crashes', async () => {
    const c = await connect('gemini');
    await assert.rejects(call(c, 'claim', { task: 999 }), /There is no task #999/);
    await assert.rejects(call(c, 'send', { to: 'nobody', text: 'hi' }), /no agent called nobody/);
    await assert.rejects(call(c, 'set_status', { status: 'resting', until: 'whenever' }), /Can't read the time/);
    assert.match(await call(c, 'set_status', { status: 'resting', until: '90', note: 'quota' }), /resting until/);
    await c.close();
  });
});

describe('owner API', () => {
  test('the owner can post, reassign, drop and message', async () => {
    const t = await (await ownerFetch('/api/tasks', { title: 'From the owner', brief: 'Do the thing', for: 'claude' })).json();
    assert.equal(t.posted_by, 'owner');
    const moved = await (await ownerFetch(`/api/tasks/${t.id}`, { handoff: 'codex', note: 'codex is free' })).json();
    assert.equal(moved.for_agent, 'codex');
    const dropped = await (await ownerFetch(`/api/tasks/${t.id}`, { state: 'dropped' })).json();
    assert.equal(dropped.state, 'dropped');
    assert.equal((await ownerFetch('/api/messages', { to: 'claude', text: 'hello' })).status, 200);
    const bad = await ownerFetch('/api/goals/1', { state: 'finished' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /state must be one of/);
  });

  test('the board stream announces changes', async () => {
    const ctrl = new AbortController();
    const r = await fetch(`${base}/api/stream`, { headers: { authorization: `Bearer ${ownerKey}` }, signal: ctrl.signal });
    const reader = r.body!.getReader();
    const seen = (async () => {
      let buf = '';
      while (!buf.includes('event: change')) buf += new TextDecoder().decode((await reader.read()).value);
      return buf;
    })();
    await ownerFetch('/api/messages', { to: 'all', text: 'ping' });
    assert.match(await seen, /event: change/);
    ctrl.abort();
  });
});
