// The HTTP side: /mcp for agents, /board and /api for the owner.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { toWebRequest } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createTeamServer } from './mcp.ts';
import { GOAL_STATES, type Store, TASK_STATES, TeamError } from './store.ts';
import { boardState } from './view.ts';

export interface HubOptions {
  store: Store;
  /** Extra host names clients use to reach the hub (for example a tailnet name). Loopback names are always allowed. */
  allowedHosts?: string[];
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', '::1'];
const COOKIE = 'team_session';
const MAX_BODY = 64 * 1024;

export function loadBoardHtml(): string {
  return readFileSync(new URL('./board.html', import.meta.url), 'utf8');
}

function hostName(host: string | undefined): string {
  if (!host) return '';
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1).toLowerCase();
  return host.split(':')[0].toLowerCase();
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (h?.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  const k = req.headers['x-team-key'];
  return typeof k === 'string' ? k.trim() : undefined;
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new TeamError('Send JSON (content-type: application/json).');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new TeamError('Request too large.');
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new TeamError('The body is not a JSON object.');
  }
}

function str(v: unknown, field: string, optional = false): string {
  if (v === undefined || v === null || v === '') {
    if (optional) return '';
    throw new TeamError(`${field} is required.`);
  }
  if (typeof v !== 'string') throw new TeamError(`${field} must be text.`);
  return v;
}

function int(v: unknown, field: string): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new TeamError(`${field} must be a whole number.`);
  return n;
}

export function createHub({ store, allowedHosts = [] }: HubOptions): Server {
  const hosts = new Set([...LOOPBACK, ...allowedHosts.map((h) => h.toLowerCase())]);
  let html = loadBoardHtml();
  let csp = '';
  const refresh = () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    const hash = createHash('sha256').update(script).digest('base64');
    csp = [
      "default-src 'none'",
      `script-src 'sha256-${hash}'`,
      "style-src 'unsafe-inline'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
  };
  refresh();
  // While working on the board, re-read it on every request.
  const dev = Boolean(process.env.AGENT_TEAM_UP_DEV);

  const mcp = createMcpHandler((ctx) => {
    const me = ctx.authInfo?.clientId;
    if (!me) throw new Error('unauthenticated MCP request reached the handler');
    return createTeamServer(store, me, () => html);
  });

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = bearer(req);
    const agent = key ? store.agentForKey(key) : undefined;
    if (!agent) {
      send(res, 401, { error: key ? 'Unknown key.' : 'Send your agent key as Authorization: Bearer <key> (or X-Team-Key).' }, { 'www-authenticate': 'Bearer realm="agent-team-up"' });
      return;
    }
    // A client that goes away must stop its wait before it reads (and so loses) the inbox.
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const request = await toWebRequest(req, undefined, { signal: abort.signal });
    const response = await mcp.fetch(request, { authInfo: { token: key!, clientId: agent, scopes: [] } });
    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    if (!response.body) {
      res.end();
      return;
    }
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).on('error', () => res.destroy()).pipe(res);
  }

  function owner(req: IncomingMessage): boolean {
    const key = bearer(req);
    if (key && store.isOwnerKey(key)) return true;
    const s = cookie(req, COOKIE);
    return s !== undefined && store.isSession(s);
  }

  function sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host.toLowerCase() === (req.headers.host ?? '').toLowerCase();
    } catch {
      return false;
    }
  }

  function stream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': hello\n\n');
    let pending: NodeJS.Timeout | undefined;
    const onChange = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        res.write('event: change\ndata: {}\n\n');
      }, 150);
    };
    const beat = setInterval(() => res.write(': beat\n\n'), 25_000);
    store.events.on('change', onChange);
    req.on('close', () => {
      clearInterval(beat);
      if (pending) clearTimeout(pending);
      store.events.off('change', onChange);
    });
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && !sameOrigin(req)) {
      send(res, 403, { error: 'Cross-origin request refused.' });
      return;
    }
    if (path === '/api/login' && method === 'POST') {
      const body = await readJson(req);
      if (!store.isOwnerKey(str(body.key, 'key'))) {
        send(res, 401, { error: "That isn't the owner key." });
        return;
      }
      const secure = req.headers['x-forwarded-proto'] === 'https' || !LOOPBACK.includes(hostName(req.headers.host));
      const attrs = ['HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${30 * 86_400}`, ...(secure ? ['Secure'] : [])];
      send(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=${store.newSession()}; ${attrs.join('; ')}` });
      return;
    }
    if (!owner(req)) {
      send(res, 401, { error: 'Sign in with the owner key.' });
      return;
    }
    if (path === '/api/logout' && method === 'POST') {
      const s = cookie(req, COOKIE);
      if (s) store.endSession(s);
      send(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      return;
    }
    if (path === '/api/state' && method === 'GET') return send(res, 200, boardState(store));
    if (path === '/api/stream' && method === 'GET') return stream(req, res);
    if (method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });

    const body = await readJson(req);
    let m: RegExpExecArray | null;
    if (path === '/api/goals') {
      return send(res, 200, store.postGoal(str(body.title, 'title'), str(body.detail, 'detail', true)));
    }
    if ((m = /^\/api\/goals\/(\d+)$/.exec(path))) {
      const state = str(body.state, 'state');
      if (!(GOAL_STATES as readonly string[]).includes(state)) throw new TeamError(`state must be one of ${GOAL_STATES.join(', ')}.`);
      return send(res, 200, store.setGoal(Number(m[1]), state as (typeof GOAL_STATES)[number]));
    }
    if (path === '/api/tasks') {
      return send(
        res,
        200,
        store.postTask('owner', {
          title: str(body.title, 'title'),
          brief: str(body.brief, 'brief'),
          goal: body.goal === undefined || body.goal === null || body.goal === '' ? null : int(body.goal, 'goal'),
          for: str(body.for, 'for', true) || null,
        }),
      );
    }
    if ((m = /^\/api\/tasks\/(\d+)$/.exec(path))) {
      const state = str(body.state, 'state', true);
      if (state && !(TASK_STATES as readonly string[]).includes(state)) throw new TeamError(`state must be one of ${TASK_STATES.join(', ')}.`);
      return send(
        res,
        200,
        store.update(
          'owner',
          Number(m[1]),
          {
            state: (state || undefined) as (typeof TASK_STATES)[number] | undefined,
            note: str(body.note, 'note', true) || undefined,
            handoff: str(body.handoff, 'handoff', true) || undefined,
          },
          true,
        ),
      );
    }
    if ((m = /^\/api\/questions\/(\d+)\/answer$/.exec(path))) {
      return send(res, 200, store.answer(Number(m[1]), str(body.text, 'text')));
    }
    if (path === '/api/messages') {
      store.send('owner', str(body.to, 'to'), str(body.text, 'text'));
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'Not found.' });
  }

  return createServer(async (req, res) => {
    try {
      if (!hosts.has(hostName(req.headers.host))) {
        send(res, 403, { error: `Host ${hostName(req.headers.host) || '(none)'} isn't allowed. Start the hub with --allowed-host for it.` });
        return;
      }
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path === '/mcp') {
        if (!sameOrigin(req)) return send(res, 403, { error: 'Cross-origin request refused.' });
        return await handleMcp(req, res);
      }
      if (path === '/' && req.method === 'GET') {
        res.writeHead(302, { location: '/board' });
        res.end();
        return;
      }
      if (path === '/board' && req.method === 'GET') {
        if (dev) {
          html = loadBoardHtml();
          refresh();
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': csp,
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        });
        res.end(html);
        return;
      }
      if (path.startsWith('/api/')) return await handleApi(req, res, path);
      send(res, 404, { error: 'Not found.' });
    } catch (err) {
      if (err instanceof TeamError) {
        if (!res.headersSent) send(res, 400, { error: err.message });
        return;
      }
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong.' });
      else res.destroy();
    }
  });
}
