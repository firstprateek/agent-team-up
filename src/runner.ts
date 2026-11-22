// The runner: claims tasks aimed at one agent and runs a headless CLI for each. See docs/runner.md.

import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export interface RunnerOptions {
  agent: string;
  /** MCP endpoint, e.g. http://127.0.0.1:7600/mcp */
  hub: string;
  /** The agent's key. Never logged. */
  key: string;
  /** The command and its arguments; `{prompt}` is replaced, else the prompt is appended. */
  command: string[];
  worktrees: string;
  logs: string;
  pollMs?: number;
  timeoutMs?: number;
  /** How long after SIGTERM before SIGKILL. */
  killGraceMs?: number;
  /** Aborting stops the current run like a timeout and marks its task blocked. */
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface RunResult {
  task: number;
  outcome: 'finished' | 'blocked' | 'setup-failed';
  /** Exit code, or null when killed or never started. */
  exitCode: number | null;
  timedOut: boolean;
  stopped: boolean;
  /** The task's state after the run. */
  state: string;
  log?: string;
  cwd?: string;
}

interface TaskData {
  id: number;
  title: string;
  brief: string;
  posted_by: string;
  goal_id: number | null;
  for_agent: string | null;
  claimed_by: string | null;
  state: string;
}

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_KILL_GRACE_MS = 10_000;
const MAX_BACKOFF_MS = 120_000;

export const defaultWorktrees = (): string => join(homedir(), '.local', 'share', 'agent-team-up', 'worktrees');
export const defaultLogs = (): string => join(homedir(), '.local', 'state', 'agent-team-up', 'runs');

/** "90", "90s", "30m", "1h" -> milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([smh]?)$/.exec(s.trim());
  if (!m || Number(m[1]) <= 0) throw new Error(`"${s}" isn't a duration. Use 90, 90s, 30m or 1h.`);
  return Math.round(Number(m[1]) * { '': 1000, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as '' | 's' | 'm' | 'h']);
}

function showDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${+(ms / 1000).toFixed(2)}s`;
}

async function withClient<T>(o: RunnerOptions, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: `runner-${o.agent}`, version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(o.hub), { requestInit: { headers: { authorization: `Bearer ${o.key}` } } }));
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function tool(c: Client, name: string, args: Record<string, unknown>): Promise<TaskData | undefined> {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(((r.content as { text?: string }[])[0]?.text ?? 'tool error').slice(0, 300));
  return (r.structuredContent as { task?: TaskData } | undefined)?.task;
}

function git(args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    execFile('git', args, { encoding: 'utf8' }, (err, stdout, stderr) => (err ? rej(new Error((stderr || err.message).trim())) : res(stdout.trim())));
  });
}

function clip(s: string, n = 300): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function buildPrompt(agent: string, t: TaskData, cwd: string, branch: string | undefined): string {
  const handoff = t.posted_by !== agent && t.posted_by !== 'owner' ? `, and handoff "${t.posted_by}"` : '';
  return [
    `You are ${agent} on the agent-team-up team. You already hold task #${t.id}; don't claim other tasks.`,
    '',
    `# ${t.title}`,
    t.brief,
    '',
    `Work only in ${cwd}.${branch ? ` Commit your work on branch ${branch}. Don't push.` : ''}`,
    `When you finish, call the team tool update with task ${t.id}, state "review", a one- or two-sentence note, and links (branch and main files)${handoff}.`,
    'If you can\'t finish, call update with state "blocked" and a note saying why.',
    'If you need a decision from the owner, call send with to "owner".',
  ].join('\n');
}

/** Makes the directory the agent works in. Returns the branch when it is a git worktree. */
async function setupWorkdir(o: RunnerOptions, t: TaskData): Promise<{ cwd: string; branch?: string }> {
  const m = /^Repo:[ \t]*(.+?)[ \t]*$/m.exec(t.brief);
  mkdirSync(o.worktrees, { recursive: true });
  if (!m) {
    const cwd = join(o.worktrees, `task-${t.id}`);
    mkdirSync(cwd, { recursive: true });
    return { cwd };
  }
  const raw = m[1];
  const repo = resolve(raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw);
  await git(['-C', repo, 'rev-parse', '--git-dir']);
  const base = await git(['-C', repo, 'rev-parse', '--verify', '--quiet', 'origin/HEAD']).then(() => 'origin/HEAD', () => 'HEAD');
  const branch = `${o.agent}/task-${t.id}`;
  const cwd = join(o.worktrees, `${basename(repo)}-task-${t.id}`);
  await git(['-C', repo, 'worktree', 'add', '-b', branch, cwd, base]);
  return { cwd, branch };
}

interface Exit {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  stopped: boolean;
  error?: string;
}

function runCommand(o: RunnerOptions, argv: string[], cwd: string, logPath: string, prompt: string): Promise<Exit> {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const grace = o.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  mkdirSync(o.logs, { recursive: true });
  const fd = openSync(logPath, 'w', 0o600);
  writeSync(fd, `# prompt\n${prompt}\n\n# output\n`);
  return new Promise((res) => {
    const out: Exit = { code: null, signal: null, timedOut: false, stopped: false };
    let timers: NodeJS.Timeout[] = [];
    let child;
    let finished = false;
    // A spawn failure can emit both 'error' and 'close'; settle once.
    const finish = () => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      o.signal?.removeEventListener('abort', onAbort);
      closeSync(fd);
      res(out);
    };
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child!.pid!, sig);
      } catch {
        // already gone
      }
    };
    const stop = () => {
      killGroup('SIGTERM');
      timers.push(setTimeout(() => killGroup('SIGKILL'), grace));
    };
    const onAbort = () => {
      out.stopped = true;
      stop();
    };
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', fd, fd], detached: true, shell: false });
    } catch (err) {
      out.error = (err as Error).message;
      return finish();
    }
    child.on('error', (err) => {
      out.error = err.message;
      finish();
    });
    child.on('close', (code, signal) => {
      out.code = code;
      out.signal = signal;
      finish();
    });
    timers.push(setTimeout(() => {
      out.timedOut = true;
      stop();
    }, timeoutMs));
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Claims at most one task aimed at the agent and runs it. Undefined when nothing was waiting. */
export async function runOnce(o: RunnerOptions): Promise<RunResult | undefined> {
  const log = o.log ?? (() => {});
  const t = await withClient(o, (c) => tool(c, 'claim', { mine_only: true }));
  if (!t) return undefined;
  log(`claimed #${t.id}`);

  const markBlocked = async (note: string, links: string): Promise<string> => {
    await withClient(o, (c) => tool(c, 'update', { task: t.id, state: 'blocked', note: clip(note, 3900), links: clip(links, 900) }));
    return 'blocked';
  };

  let work: { cwd: string; branch?: string };
  try {
    work = await setupWorkdir(o, t);
  } catch (err) {
    const msg = clip((err as Error).message);
    log(`#${t.id} setup failed: ${msg}`);
    await markBlocked(`couldn't set up a workspace: ${msg}`, '');
    return { task: t.id, outcome: 'setup-failed', exitCode: null, timedOut: false, stopped: false, state: 'blocked' };
  }

  const logPath = join(o.logs, `${o.agent}-task-${t.id}.log`);
  const prompt = buildPrompt(o.agent, t, work.cwd, work.branch);
  const argv = o.command.some((a) => a.includes('{prompt}')) ? o.command.map((a) => a.replaceAll('{prompt}', () => prompt)) : [...o.command, prompt];
  log(`#${t.id} run started (cwd ${work.cwd}, log ${logPath})`);
  const exit = await runCommand(o, argv, work.cwd, logPath, prompt);

  const after = await withClient(o, (c) => tool(c, 'task', { task: t.id }));
  let state = after?.state ?? 'unknown';
  const how = exit.stopped ? 'runner stopped' : exit.timedOut ? `timed out after ${showDuration(o.timeoutMs ?? DEFAULT_TIMEOUT_MS)}` : exit.error ? `failed to start: ${clip(exit.error, 120)}` : `exit ${exit.code ?? exit.signal}`;
  const stillMine = after !== undefined && after.claimed_by === o.agent && after.state === 'working';
  let outcome: RunResult['outcome'] = 'finished';
  if (stillMine) {
    const note = exit.stopped ? 'runner stopped' : `run ended without finishing (${how}). Log: ${logPath}`;
    state = await markBlocked(note, work.cwd);
    outcome = 'blocked';
  }
  log(`#${t.id} run ended (${how}); task is ${state}`);
  return { task: t.id, outcome, exitCode: exit.code, timedOut: exit.timedOut, stopped: exit.stopped, state, log: logPath, cwd: work.cwd };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res) => {
    if (signal?.aborted) return res();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      res();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Repeats runOnce until `signal` aborts. Errors (hub down) are logged and retried with backoff. */
export async function runLoop(o: RunnerOptions): Promise<void> {
  const log = o.log ?? (() => {});
  const poll = o.pollMs ?? DEFAULT_POLL_MS;
  let fails = 0;
  while (!o.signal?.aborted) {
    try {
      const r = await runOnce(o);
      fails = 0;
      if (r) continue;
      await sleep(poll, o.signal);
    } catch (err) {
      fails++;
      const wait = Math.min(MAX_BACKOFF_MS, poll * 2 ** Math.min(fails, 10));
      log(`error: ${clip((err as Error).message, 200)}; retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait, o.signal);
    }
  }
}
