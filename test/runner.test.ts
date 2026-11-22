import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createHub } from '../src/http.ts';
import { parseDuration, runLoop, runOnce, type RunnerOptions } from '../src/runner.ts';
import { Store } from '../src/store.ts';

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
    const r = await runOnce(opts('finish'));
    assert.equal(r!.outcome, 'finished');
    assert.match(r!.cwd!, /myrepo-task-\d+$/);
    assert.equal(execFileSync('git', ['-C', r!.cwd!, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), `qwen/task-${t.id}`);
    assert.match(readFileSync(r!.log!, 'utf8'), new RegExp(`Commit your work on branch qwen/task-${t.id}`));
    assert.equal(g('rev-parse', 'HEAD'), execFileSync('git', ['-C', r!.cwd!, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
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

  test('runner output never contains the key or a brief', () => {
    assert.ok(lines.length > 0);
    const all = lines.join('\n');
    assert.ok(!all.includes(keys.qwen));
    assert.ok(!all.includes('secret brief text'));
    assert.ok(!all.includes('Write the thing'));
  });

  test('durations', () => {
    assert.equal(parseDuration('90'), 90_000);
    assert.equal(parseDuration('90s'), 90_000);
    assert.equal(parseDuration('30m'), 1_800_000);
    assert.equal(parseDuration('1h'), 3_600_000);
    assert.throws(() => parseDuration('soon'));
  });
});
