import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createHub } from '../src/http.ts';
import { parseDuration, parseRepoLine, runLoop, runOnce, RunnerFatal, type RunnerOptions } from '../src/runner.ts';
import { STOPPED_PREFIX, Store } from '../src/store.ts';

const FAKE = join(import.meta.dirname, 'fake-agent.ts');
let store: Store;
let hubUrl: string;
let close: () => Promise<void>;
let tmp: string;
let n = 0;
const keys: Record<string, string> = {};
const lines: string[] = [];

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'runner-test-')));
  store = new Store(':memory:');
  store.resetOwnerKey();
  for (const name of ['claude', 'qwen', 'codex']) keys[name] = store.addAgent(name, 'x');
  const hub = createHub({ store, allowedHosts: [] });
  await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r));
  hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}/mcp`;
  close = () => new Promise((r) => { hub.closeAllConnections(); hub.close(() => r()); });
});
after(async () => {
  await close();
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

function opts(mode: string, extra: Partial<RunnerOptions> = {}): RunnerOptions {
  const dir = join(tmp, `run${n++}`);
  return {
    agent: 'qwen',
    hub: hubUrl,
    key: keys.qwen,
    command: ['node', FAKE, hubUrl, keys.qwen, mode, '{prompt}'],
    worktrees: join(dir, 'worktrees'),
    logs: join(dir, 'logs'),
    timeoutMs: 20_000,
    killGraceMs: 200,
    log: (l) => lines.push(l),
    ...extra,
  };
}

const post = (a: { title: string; brief: string; for?: string }, by = 'claude') => store.postTask(by, a);

function mkRepo(name: string): { repo: string; g: (...a: string[]) => string } {
  const repo = join(tmp, name);
  mkdirSync(repo);
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  return { repo, g };
}

describe('runner: commit gate, WIP, handback', () => {
  test('review with 0 commits ahead is sent back as blocked', async () => {
    const { repo } = mkRepo('gate-empty');
    const t = post({ title: 'Empty', brief: `Repo: ${repo}`, for: 'qwen' });
    const r = await runOnce(opts('finish'));
    assert.equal(r!.outcome, 'blocked');
    const after = store.task(t.id)!;
    assert.equal(after.state, 'blocked');
    assert.match(after.note, /Not accepted: review was requested but the branch has 0 commits ahead of /);
    assert.match(after.note, /0 uncommitted files/);
    assert.match(after.note, /git add -A && git commit/);
  });

  test('review with a dirty tree is blocked, and the work is saved as a WIP commit', async () => {
    const { repo, g } = mkRepo('gate-dirty');
    const t = post({ title: 'Dirty', brief: `Repo: ${repo}`, for: 'qwen' });
    const r = await runOnce(opts('dirty'));
    const after = store.task(t.id)!;
    assert.equal(after.state, 'blocked');
    assert.match(after.note, /1 uncommitted file in the worktree/);
    const sha = /WIP commit ([0-9a-f]+)/.exec(after.note)?.[1];
    assert.ok(sha, after.note);
    const subject = g('log', '-1', '--format=%s%n%b', `qwen/task-${t.id}`);
    assert.match(subject, new RegExp(`^WIP \\(auto\\): task ${t.id} \\(`));
    assert.doesNotMatch(subject, /Co-authored-by/i);
    assert.equal(execFileSync('git', ['-C', r!.cwd!, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  });

  test('a clean, committed review passes the gate', async () => {
    const { repo } = mkRepo('gate-ok');
    const t = post({ title: 'Good', brief: `Repo: ${repo}`, for: 'qwen' });
    assert.equal((await runOnce(opts('commit')))!.outcome, 'finished');
    assert.equal(store.task(t.id)!.state, 'review');
  });

  test('a timeout with a dirty tree saves WIP; the re-run prompt shows it and the note', async () => {
    const { repo, g } = mkRepo('wip-timeout');
    const t = post({ title: 'Slow', brief: `Repo: ${repo}`, for: 'qwen' });
    const o = opts('dirty-hang', { timeoutMs: 1500, killGraceMs: 200 });
    const first = await runOnce(o);
    assert.equal(first!.timedOut, true);
    assert.match(g('log', '-1', '--format=%s', `qwen/task-${t.id}`), new RegExp(`^WIP \\(auto\\): task ${t.id} \\(timed out after 1\\.5s\\)$`));
    assert.match(store.task(t.id)!.note, /saved as WIP commit/);
    store.update('owner', t.id, { state: 'open', note: 'Please commit after each step and finish the tests.' }, true);
    store.update('owner', t.id, { handoff: 'qwen' }, true);
    const second = await runOnce({ ...o, command: opts('fail').command });
    assert.equal(second!.cwd, first!.cwd);
    const log = readFileSync(second!.log!, 'utf8');
    const prompt = log.slice(log.lastIndexOf('# prompt'));
    assert.match(prompt, /Please commit after each step and finish the tests\./);
    assert.match(prompt, /Previous work is already on this branch/);
    assert.match(prompt, /WIP \(auto\): task \d+/);
    assert.match(prompt, /git status/);
  });

  test('a nonzero exit with changes also saves WIP, and node_modules is never committed', async () => {
    const { repo, g } = mkRepo('wip-exit');
    const t = post({ title: 'Crash', brief: `Repo: ${repo}`, for: 'qwen' });
    const o = opts('fail');
    // Pre-create the worktree through a first (clean) failing run, then dirty it by hand.
    const first = await runOnce(o);
    mkdirSync(join(first!.cwd!, 'node_modules', 'x'), { recursive: true });
    execFileSync('sh', ['-c', 'echo a > node_modules/x/i.js; echo b > new.txt'], { cwd: first!.cwd });
    store.update('owner', t.id, { state: 'open' }, true);
    store.update('owner', t.id, { handoff: 'qwen' }, true);
    await runOnce(o);
    const files = g('show', '--name-only', '--format=', `qwen/task-${t.id}`);
    assert.equal(files, 'new.txt');
  });

  test('a handoff with an empty branch cannot be reverted, so the new holder is messaged', async () => {
    const { repo } = mkRepo('gate-handoff');
    const t = post({ title: 'Handoff', brief: `Repo: ${repo}`, for: 'qwen' });
    await runOnce(opts('dirty-handoff'));
    assert.equal(store.task(t.id)!.for_agent, 'claude');
    const rows = (store as unknown as { db: { prepare: (q: string) => { all: (...a: unknown[]) => { text: string }[] } } }).db
      .prepare("SELECT text FROM events WHERE task_id = ? AND audience = 'claude' AND sender = 'qwen'")
      .all(t.id);
    assert.ok(rows.some((e) => /1 uncommitted file/.test(e.text) && /0 commits ahead/.test(e.text)), JSON.stringify(rows));
  });

  test('Repo: parsing', () => {
    assert.equal(parseRepoLine('no repo here'), undefined);
    assert.equal(parseRepoLine('Repo: /a/b'), '/a/b');
    assert.equal(parseRepoLine('x\nRepo: /a/b. Read README.md first\ny'), '/a/b');
    assert.equal(parseRepoLine('Repo: /a/b, then more'), '/a/b');
    assert.equal(parseRepoLine('Repo: /a/b;'), '/a/b');
    assert.equal(parseRepoLine('Repo:   `/a/b`.'), '/a/b');
    assert.equal(parseRepoLine('Repo: ~/projects/x'), join(homedir(), 'projects/x'));
    assert.equal(parseRepoLine('Repo: ~/projects/x. Read README'), join(homedir(), 'projects/x'));
    assert.equal(parseRepoLine('Repo: ~'), homedir());
  });

  test('a Repo: path that does not exist blocks and quotes the parsed path', async () => {
    const t = post({ title: 'Missing', brief: `Repo: ${tmp}/nope/here. Read README.md`, for: 'qwen' });
    const r = await runOnce(opts('finish'));
    assert.equal(r!.outcome, 'setup-failed');
    assert.match(store.task(t.id)!.note, new RegExp(`Repo path "${tmp}/nope/here" does not exist`));
  });
});

describe('runner', () => {
  test('a run that updates its task to review leaves it there', async () => {
    const t = post({ title: 'Do it', brief: 'Write the thing.', for: 'qwen' });
    const r = await runOnce(opts('finish'));
    assert.equal(r!.task, t.id);
    assert.equal(r!.outcome, 'finished');
    assert.equal(r!.exitCode, 0);
    assert.equal(store.task(t.id)!.state, 'review');
    const log = readFileSync(r!.log!, 'utf8');
    assert.match(log, /You already hold task #\d+/);
    assert.match(log, /Write the thing\./);
    assert.match(log, new RegExp(`handoff "claude"`), 'a teammate poster gets the handoff');
    assert.match(r!.cwd!, new RegExp(`task-${t.id}$`));
  });

  test('while the team is stopped the runner claims nothing and stays quiet; it picks up after resume', async () => {
    const t = post({ title: 'Waits for resume', brief: 'b', for: 'qwen' });
    store.pause('owner', 'lunch');
    const before = lines.length;
    assert.equal(await runOnce(opts('finish')), undefined);
    assert.equal(store.task(t.id)!.state, 'open');
    assert.equal(lines.length, before, 'no log noise');
    store.resume('owner');
    assert.equal((await runOnce(opts('finish')))!.task, t.id);
  });

  test('the hub refusal text is what the runner treats as idle (through MCP, no store shortcut)', async () => {
    post({ title: 'Hold', brief: 'b', for: 'qwen' });
    store.pause('claude', 'x');
    const l: string[] = [];
    assert.equal(await runOnce(opts('finish', { log: (x) => l.push(x) })), undefined);
    assert.deepEqual(l, []);
    assert.throws(() => store.claim('qwen'), (e: Error) => e.message.startsWith(STOPPED_PREFIX));
    store.resume('claude');
    assert.ok(await runOnce(opts('finish')));
  });

  test('a run that exits without updating leaves the task blocked, with the log path', async () => {
    const t = post({ title: 'Fails', brief: 'secret brief text', for: 'qwen' });
    const o = opts('fail');
    const r = await runOnce(o);
    assert.equal(r!.outcome, 'blocked');
    assert.equal(r!.exitCode, 3);
    const after = store.task(t.id)!;
    assert.equal(after.state, 'blocked');
    assert.match(after.note, /run ended without finishing \(exit 3\)\. Log: .*qwen-task-\d+\.log/);
    assert.ok(after.links.includes('task-'));
    assert.equal(after.claimed_by, 'qwen');
  });

  test('a run past its timeout is stopped (SIGKILL after the grace) and the task is blocked', async () => {
    const t = post({ title: 'Hangs', brief: 'b', for: 'qwen' });
    const started = Date.now();
    const r = await runOnce(opts('stubborn', { timeoutMs: 700, killGraceMs: 300 }));
    assert.equal(r!.timedOut, true);
    assert.ok(Date.now() - started < 8000);
    assert.match(store.task(t.id)!.note, /timed out after 0\.7s/);
    assert.equal(store.task(t.id)!.state, 'blocked');
    assert.match(readFileSync(r!.log!, 'utf8'), /ignoring SIGTERM/, 'it was asked nicely first');
  });

  test('a Repo: line gets a worktree on <agent>/task-<id>', async () => {
    const repo = join(tmp, 'myrepo');
    mkdirSync(repo);
    const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    g('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
    const t = post({ title: 'In a repo', brief: `Do work.\nRepo: ${repo}\n`, for: 'qwen' });
    const r = await runOnce(opts('commit'));
    assert.equal(r!.outcome, 'finished');
    assert.match(r!.cwd!, /myrepo-task-\d+$/);
    assert.equal(execFileSync('git', ['-C', r!.cwd!, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), `qwen/task-${t.id}`);
    assert.match(readFileSync(r!.log!, 'utf8'), new RegExp(`Commit your work on branch qwen/task-${t.id}`));
    assert.notEqual(g('rev-parse', 'HEAD'), execFileSync('git', ['-C', r!.cwd!, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), 'the agent committed on its branch');
  });

  test('a Repo: that is not a git repo blocks the task without running anything', async () => {
    const notRepo = join(tmp, 'plain');
    mkdirSync(notRepo);
    const t = post({ title: 'Bad repo', brief: `Repo: ${notRepo}`, for: 'qwen' });
    const r = await runOnce(opts('finish'));
    assert.equal(r!.outcome, 'setup-failed');
    assert.equal(store.task(t.id)!.state, 'blocked');
    assert.match(store.task(t.id)!.note, /couldn't set up a workspace/);
  });

  test('tasks for someone else or for nobody are never taken', async () => {
    const other = post({ title: 'for codex', brief: 'b', for: 'codex' });
    const anyone = post({ title: 'for anyone', brief: 'b' });
    assert.equal(await runOnce(opts('finish')), undefined);
    assert.equal(store.task(other.id)!.state, 'open');
    assert.equal(store.task(anyone.id)!.state, 'open');
    store.update('claude', other.id, { state: 'dropped' });
    store.update('claude', anyone.id, { state: 'dropped' });
  });

  test('the loop stops cleanly on abort, marking the running task blocked', async () => {
    const t = post({ title: 'Long', brief: 'b', for: 'qwen' });
    const ac = new AbortController();
    const done = runLoop(opts('hang', { signal: ac.signal, pollMs: 50 }));
    for (let i = 0; i < 100 && store.task(t.id)!.state !== 'working'; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    await done;
    assert.equal(store.task(t.id)!.state, 'blocked');
    assert.equal(store.task(t.id)!.note, 'runner stopped');
  });

  test('runner output and the log never contain the key; the log is mode 600 and the output has no brief', async () => {
    const out: string[] = [];
    const t = post({ title: 'Quiet', brief: 'quiet brief text', for: 'qwen' });
    const r = await runOnce(opts('finish', { log: (l) => out.push(l) }));
    assert.equal(r!.task, t.id);
    assert.ok(out.length > 0);
    const all = out.join('\n');
    assert.ok(!all.includes(keys.qwen));
    assert.ok(!all.includes('quiet brief text'));
    assert.equal(statSync(r!.log!).mode & 0o777, 0o600);
    assert.ok(!readFileSync(r!.log!, 'utf8').includes(keys.qwen));
  });

  test('the prompt goes on stdin, not argv, with --prompt-stdin', async () => {
    const t = post({ title: 'Stdin', brief: 'stdin brief text', for: 'qwen' });
    const r = await runOnce(opts('stdin', { promptStdin: true, command: ['node', FAKE, hubUrl, keys.qwen, 'stdin'] }));
    assert.equal(r!.task, t.id);
    assert.equal(store.task(t.id)!.state, 'review', 'the agent read the prompt from stdin and found its task id');
    const log = readFileSync(r!.log!, 'utf8');
    assert.match(log, /argv=\S+ stdin \n/, 'argv has no prompt');
    await assert.rejects(runOnce(opts('stdin', { promptStdin: true })), RunnerFatal, '{prompt} and --prompt-stdin conflict');
  });

  test('a leftover background child is killed after the leader exits', async () => {
    const t = post({ title: 'Leaves a child', brief: 'b', for: 'qwen' });
    const pidFile = join(tmp, `bg${n}.pid`);
    const r = await runOnce(opts('x', { command: ['sh', '-c', `trap "" TERM; (trap "" TERM; sleep 30) & echo $! > ${pidFile}; sleep 0.2; exit 0`], killGraceMs: 300 }));
    assert.equal(r!.task, t.id);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((res) => setTimeout(res, 100));
    assert.throws(() => process.kill(pid, 0), 'the sleep is gone');
  });

  test('a re-run of a Repo: task reuses its worktree and branch', async () => {
    const repo = join(tmp, 'rerepo');
    mkdirSync(repo);
    const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    g('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
    const t = post({ title: 'Twice', brief: `Repo: ${repo}`, for: 'qwen' });
    const o = opts('fail');
    const first = await runOnce(o);
    assert.equal(store.task(t.id)!.state, 'blocked');
    // The owner reopens it, aimed at qwen again.
    store.update('owner', t.id, { state: 'open' }, true);
    store.update('owner', t.id, { handoff: 'qwen' }, true);
    const second = await runOnce(o);
    assert.equal(second!.task, t.id);
    assert.equal(second!.cwd, first!.cwd);
    assert.equal(second!.outcome, 'blocked', 'it ran again, not a setup failure');
    const log = readFileSync(second!.log!, 'utf8');
    assert.equal(log.match(/^# run /gm)!.length, 2, 'the log is appended to');
    // Branch without a worktree: remove the worktree only.
    store.update('owner', t.id, { state: 'open' }, true);
    store.update('owner', t.id, { handoff: 'qwen' }, true);
    g('worktree', 'remove', '--force', first!.cwd!);
    const third = await runOnce(o);
    assert.equal(third!.outcome, 'blocked');
    assert.equal(execFileSync('git', ['-C', third!.cwd!, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), `qwen/task-${t.id}`);
  });

  test('a key that belongs to another agent releases the task and stops', async () => {
    const t = post({ title: 'Wrong key', brief: 'b', for: 'qwen' });
    const o = opts('finish', { agent: 'codex' });
    await assert.rejects(runOnce(o), /belongs to qwen, not codex/);
    assert.equal(store.task(t.id)!.state, 'open');
    assert.ok(!existsSync(o.logs), 'nothing ran');
    await assert.rejects(runLoop(opts('finish', { agent: 'codex' })), /belongs to qwen, not codex/, 'caught up front too');
    assert.equal(store.task(t.id)!.state, 'open');
    store.update('claude', t.id, { state: 'dropped' });
  });

  test('a hub older than the runner needs is refused', async () => {
    const t = post({ title: 'Old hub', brief: 'b', for: 'qwen' });
    await assert.rejects(runLoop(opts('finish', { minHubVersion: '99.0.0' })), /needs 99\.0\.0 or newer/);
    assert.equal(store.task(t.id)!.state, 'open');
    store.update('claude', t.id, { state: 'dropped' });
  });

  test('an unwritable logs dir still ends with the task blocked', async () => {
    const t = post({ title: 'No log', brief: 'b', for: 'qwen' });
    const o = opts('finish');
    mkdirSync(o.logs, { recursive: true });
    chmodSync(o.logs, 0o500);
    try {
      const r = await runOnce(o);
      assert.equal(r!.outcome, 'blocked');
      assert.equal(store.task(t.id)!.state, 'blocked');
      assert.match(store.task(t.id)!.note, /couldn't start the run/);
    } finally {
      chmodSync(o.logs, 0o700);
    }
  });

  describe('through a flaky proxy', () => {
    let proxy: Server;
    let proxyUrl: string;
    const ctl = { downUntil: 0, delayClaimMs: 0, dropClaimReply: false, armDownAfterClaim: 0 };
    before(async () => {
      proxy = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = Buffer.concat(chunks);
        const isClaim = body.includes('"name":"claim"');
        if (isClaim && ctl.delayClaimMs) await new Promise((r) => setTimeout(r, ctl.delayClaimMs));
        if (Date.now() < ctl.downUntil) return void res.writeHead(503).end('down');
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['host', 'content-length', 'connection'].includes(k)) headers[k] = v;
        const up = await fetch(hubUrl, { method: req.method, headers, body: req.method === 'GET' ? undefined : body });
        const text = await up.text();
        if (isClaim && ctl.dropClaimReply) {
          ctl.dropClaimReply = false;
          return void res.writeHead(502).end('lost');
        }
        if (isClaim && ctl.armDownAfterClaim) ctl.downUntil = Date.now() + ctl.armDownAfterClaim;
        res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' }).end(text);
      });
      await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
      proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/mcp`;
    });
    after(() => new Promise<void>((r) => { proxy.closeAllConnections(); proxy.close(() => r()); }));

    test('a hub error after the claim is retried until the task is settled', async () => {
      const t = post({ title: 'Hub blip', brief: 'b', for: 'qwen' });
      ctl.armDownAfterClaim = 1200;
      const r = await runOnce(opts('fail', { hub: proxyUrl, pollMs: 100 }));
      ctl.armDownAfterClaim = 0;
      assert.equal(r!.outcome, 'blocked');
      assert.equal(store.task(t.id)!.state, 'blocked');
    });

    test('a lost claim reply is recovered from what the agent holds', async () => {
      const t = post({ title: 'Lost reply', brief: 'b', for: 'qwen' });
      ctl.dropClaimReply = true;
      const r = await runOnce(opts('finish', { hub: proxyUrl, pollMs: 100 }));
      assert.equal(r!.task, t.id);
      assert.equal(store.task(t.id)!.state, 'review');
    });

    test('a stop while the claim is in flight releases the task without running', async () => {
      const t = post({ title: 'Stopped early', brief: 'b', for: 'qwen' });
      ctl.delayClaimMs = 600;
      const ac = new AbortController();
      const o = opts('finish', { hub: proxyUrl, pollMs: 100, signal: ac.signal });
      setTimeout(() => ac.abort(), 200);
      const r = await runOnce(o);
      ctl.delayClaimMs = 0;
      assert.equal(r, undefined);
      assert.equal(store.task(t.id)!.state, 'open');
      assert.equal(store.task(t.id)!.claimed_by, null);
      assert.ok(!existsSync(o.logs) && !existsSync(o.worktrees), 'nothing was set up or spawned');
      store.update('claude', t.id, { state: 'dropped' });
    });
  });

  test('durations', () => {
    assert.equal(parseDuration('90'), 90_000);
    assert.equal(parseDuration('90s'), 90_000);
    assert.equal(parseDuration('30m'), 1_800_000);
    assert.equal(parseDuration('1h'), 3_600_000);
    assert.throws(() => parseDuration('soon'));
  });
});
