// The runner: claims tasks aimed at one agent and runs a headless CLI for each. See docs/runner.md.

import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { STOPPED_PREFIX } from './store.ts';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export interface RunnerOptions {
  agent: string;
  /** MCP endpoint, e.g. http://127.0.0.1:7600/mcp */
  hub: string;
  /** The agent's key. Never logged. */
  key: string;
  /** The command and its arguments; `{prompt}` is replaced, else the prompt is appended. */
  command: string[];
  /** Send the prompt on the child's stdin instead of argv (so `ps` doesn't show the brief). */
  promptStdin?: boolean;
  worktrees: string;
  logs: string;
  pollMs?: number;
  timeoutMs?: number;
  /** How long after SIGTERM before SIGKILL. */
  killGraceMs?: number;
  /** Oldest hub version the runner accepts (tests only; default MIN_HUB_VERSION). */
  minHubVersion?: string;
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

/** A problem retrying won't fix: the runner stops and the CLI exits nonzero. */
export class RunnerFatal extends Error {}
/** The hub answered, but with a tool error. */
class HubError extends Error {}

interface TaskData {
  id: number;
  title: string;
  brief: string;
  posted_by: string;
  goal_id: number | null;
  for_agent: string | null;
  claimed_by: string | null;
  state: string;
  note?: string;
}

export const MIN_HUB_VERSION = '0.5.0';
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_KILL_GRACE_MS = 10_000;
const MAX_BACKOFF_MS = 120_000;

export const defaultWorktrees = (): string => join(homedir(), '.local', 'share', 'agent-team-up', 'worktrees');
export const defaultLogs = (): string => join(homedir(), '.local', 'state', 'agent-team-up', 'runs');

/** Process groups of running children, so the CLI can kill them on a crash. */
const activeGroups = new Set<number>();
export function killActiveGroups(): void {
  for (const pid of activeGroups) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
}

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

function olderThan(version: string, min: string): boolean {
  const a = version.split('.').map((x) => parseInt(x, 10) || 0);
  const b = min.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

function checkOptions(o: RunnerOptions): void {
  if (o.promptStdin && o.command.some((a) => a.includes('{prompt}'))) throw new RunnerFatal('--prompt-stdin and {prompt} in the command are mutually exclusive.');
}

async function withClient<T>(o: RunnerOptions, fn: (c: Client) => Promise<T>, check = true): Promise<T> {
  const client = new Client({ name: `runner-${o.agent}`, version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(o.hub), { requestInit: { headers: { authorization: `Bearer ${o.key}` } } }));
  try {
    if (check) {
      const v = client.getServerVersion()?.version ?? '0';
      const min = o.minHubVersion ?? MIN_HUB_VERSION;
      if (olderThan(v, min)) throw new RunnerFatal(`the hub is version ${v}; the runner needs ${min} or newer (claim mine_only). Update the hub.`);
    }
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function tool(c: Client, name: string, args: Record<string, unknown>) {
  const r = await c.callTool({ name, arguments: args });
  const text = ((r.content as { text?: string }[] | undefined) ?? []).map((x) => x.text ?? '').join('\n');
  if (r.isError) throw new HubError(text.slice(0, 300) || 'tool error');
  return { text, task: (r.structuredContent as { task?: TaskData } | undefined)?.task };
}

function git(args: string[], raw = false): Promise<string> {
  return new Promise((res, rej) => {
    execFile('git', args, { encoding: 'utf8' }, (err, stdout, stderr) => (err ? rej(new Error((stderr || err.message).trim())) : res(raw ? stdout : stdout.trim())));
  });
}

/** Never snapshot or count dependency folders, even when a repo forgot to ignore them. */
const NO_MODULES = [':(exclude,glob)**/node_modules/**'];

/** What the task branch looks like: commits ahead of its base, and uncommitted (non-ignored) files. */
interface BranchState {
  base?: string;
  /** `git log --oneline base..HEAD`, newest first; undefined when the base is unknown. */
  commits?: string[];
  /** `git status --porcelain` lines. */
  dirty: string[];
}

async function baseOf(cwd: string, branch: string): Promise<string | undefined> {
  const saved = await git(['-C', cwd, 'config', '--get', `branch.${branch}.runnerBase`]).catch(() => '');
  if (saved) return saved;
  for (const ref of ['origin/HEAD', 'main', 'master']) {
    if (await git(['-C', cwd, 'rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false)) return ref;
  }
  return undefined;
}

async function branchState(cwd: string, branch: string): Promise<BranchState> {
  const base = await baseOf(cwd, branch);
  const commits = base ? (await git(['-C', cwd, 'log', '--oneline', `${base}..HEAD`]).catch(() => undefined))?.split('\n').filter(Boolean) : undefined;
  const dirty = (await git(['-C', cwd, 'status', '--porcelain', '--', '.', ...NO_MODULES], true)).split('\n').filter(Boolean);
  return { base, commits, dirty };
}

/** Commits everything (except ignored files and node_modules) as a WIP commit. Returns the short sha, or undefined if nothing to commit. */
async function saveWip(cwd: string, agent: string, id: number, reason: string): Promise<string | undefined> {
  const ident: string[] = [];
  if (!(await git(['-C', cwd, 'config', 'user.name']).catch(() => ''))) ident.push('-c', `user.name=${agent}`);
  if (!(await git(['-C', cwd, 'config', 'user.email']).catch(() => ''))) ident.push('-c', `user.email=${agent}@users.noreply.agent-team-up.invalid`);
  await git(['-C', cwd, 'add', '-A', '--', '.', ...NO_MODULES]);
  const msg = `WIP (auto): task ${id} (${reason})`;
  const commit = (hooks: string[]) => git(['-C', cwd, ...hooks, ...ident, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg]);
  try {
    await commit([]);
  } catch (err) {
    if (/nothing (added )?to commit/i.test((err as Error).message)) return undefined;
    // The repo's own hooks (tests, lint) must not stop us saving the work.
    await commit(['-c', 'core.hooksPath=/dev/null']);
  }
  return git(['-C', cwd, 'rev-parse', '--short', 'HEAD']);
}

function clip(s: string, n = 300): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** The first `Repo:` path in a brief: first token, trailing punctuation dropped, `~` expanded. */
export function parseRepoLine(brief: string): string | undefined {
  const raw = /^Repo:[ \t]*(\S+)/m.exec(brief)?.[1];
  if (!raw) return undefined;
  const p = raw.replace(/^["'`(]+/, '').replace(/["'`)]*[.,;:]*["'`)]*$/, '');
  if (!p) return undefined;
  return resolve(p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
}

function buildPrompt(agent: string, t: TaskData, cwd: string, branch: string | undefined, prior?: BranchState): string {
  const handoff = t.posted_by !== agent && t.posted_by !== 'owner' ? `, and handoff "${t.posted_by}"` : '';
  const lines = [
    `You are ${agent} on the agent-team-up team. You already hold task #${t.id}; don't claim other tasks.`,
    '',
    `# ${t.title}`,
    t.brief,
    '',
  ];
  if (t.note?.trim()) lines.push(`Latest note on this task (from the reviewer, or from your previous run; follow it):`, t.note.trim(), '');
  if (prior && (prior.commits?.length || prior.dirty.length)) {
    lines.push('Previous work is already on this branch; continue it, don\'t start over.');
    if (prior.commits?.length) lines.push(`Commits so far (git log --oneline ${prior.base}..HEAD):`, ...prior.commits.slice(0, 20).map((c) => `  ${c}`));
    if (prior.dirty.length) lines.push(`Uncommitted changes (${prior.dirty.length} files, git status --short):`, ...prior.dirty.slice(0, 20).map((c) => `  ${c}`));
    lines.push('');
  }
  lines.push(
    `Work only in ${cwd}.${branch ? ` Commit your work on branch ${branch}. Don't push.` : ''}`,
    'This run is time-limited and unsaved work is lost: commit after each meaningful step (small commits), not just at the end.',
    `Before you hand off: run the project's full check and test commands (the ones named in the brief, or the scripts in package.json), then \`git add -A && git commit\`, and confirm \`git status\` shows a clean tree. A task with no commits, or with uncommitted changes, is sent back as blocked.`,
    `Only then call the team tool update with task ${t.id}, state "review", a one- or two-sentence note, and links (branch and main files)${handoff}.`,
    'If you can\'t finish, commit what you have, then call update with state "blocked" and a note saying why.',
    'If you need a decision from the owner, call send with to "owner".',
  );
  return lines.join('\n');
}

/** Makes the directory the agent works in (reusing it on a re-run). Returns the branch for a git worktree. */
async function setupWorkdir(o: RunnerOptions, t: TaskData): Promise<{ cwd: string; branch?: string }> {
  const repo = parseRepoLine(t.brief);
  mkdirSync(o.worktrees, { recursive: true, mode: 0o700 });
  if (!repo) {
    const cwd = join(o.worktrees, `task-${t.id}`);
    mkdirSync(cwd, { recursive: true });
    return { cwd };
  }
  if (!existsSync(repo)) throw new Error(`Repo path "${repo}" does not exist (parsed from the Repo: line; only its first word is used)`);
  await git(['-C', repo, 'rev-parse', '--git-dir']);
  const branch = `${o.agent}/task-${t.id}`;
  const cwd = join(o.worktrees, `${basename(repo)}-task-${t.id}`);
  if (existsSync(cwd)) {
    const cur = await git(['-C', cwd, 'branch', '--show-current']).catch(() => '');
    if (cur === branch) return { cwd, branch };
    throw new Error(`${cwd} exists but is not on ${branch}`);
  }
  await git(['-C', repo, 'worktree', 'prune']).catch(() => '');
  const hasBranch = await git(['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
  if (hasBranch) {
    await git(['-C', repo, 'worktree', 'add', cwd, branch]);
  } else {
    const base = await git(['-C', repo, 'rev-parse', '--verify', '--quiet', 'origin/HEAD']).then(() => 'origin/HEAD', () => 'HEAD');
    await git(['-C', repo, 'worktree', 'add', '-b', branch, cwd, base]);
    // Remember where the branch started, so the commit gate can count commits on a later run.
    await git(['-C', repo, 'config', `branch.${branch}.runnerBase`, await git(['-C', repo, 'rev-parse', base])]);
  }
  return { cwd, branch };
}

interface Exit {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  stopped: boolean;
  error?: string;
}

const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function runCommand(o: RunnerOptions, argv: string[], cwd: string, logPath: string, prompt: string): Promise<Exit> {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const grace = o.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  mkdirSync(o.logs, { recursive: true, mode: 0o700 });
  const fd = openSync(logPath, 'a', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `\n# run ${new Date().toISOString()}\n# prompt\n${prompt}\n\n# output\n`);
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  return new Promise((res) => {
    const out: Exit = { code: null, signal: null, timedOut: false, stopped: false };
    const timers: NodeJS.Timeout[] = [];
    let child;
    let pid: number | undefined;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      o.signal?.removeEventListener('abort', onAbort);
      if (pid) activeGroups.delete(pid);
      closeSync(fd);
      res(out);
    };
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid!, sig);
      } catch {
        // already gone
      }
    };
    const alive = () => {
      try {
        process.kill(-pid!, 0);
        return true;
      } catch {
        return false;
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
    // The leader is gone: anything it left in the group gets SIGTERM, then SIGKILL after the grace.
    const reap = async () => {
      if (alive()) {
        killGroup('SIGTERM');
        const end = Date.now() + grace;
        while (alive() && Date.now() < end) await nap(25);
        if (alive()) killGroup('SIGKILL');
      }
      settle();
    };
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, stdio: [o.promptStdin ? 'pipe' : 'ignore', fd, fd], detached: true, shell: false });
    } catch (err) {
      out.error = (err as Error).message;
      return settle();
    }
    pid = child.pid;
    if (pid) activeGroups.add(pid);
    if (o.promptStdin) {
      child.stdin!.on('error', () => {});
      child.stdin!.end(prompt);
    }
    child.on('error', (err) => {
      out.error = err.message;
      settle();
    });
    child.on('close', (code, signal) => {
      out.code = code;
      out.signal = signal;
      void reap();
    });
    timers.push(setTimeout(() => {
      out.timedOut = true;
      stop();
    }, timeoutMs));
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener('abort', onAbort, { once: true });
  });
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

const backoff = (o: RunnerOptions, fails: number) => Math.min(MAX_BACKOFF_MS, (o.pollMs ?? DEFAULT_POLL_MS) * 2 ** Math.min(fails, 10));

/** Retries `fn` with backoff until it works. Once the runner is stopped it makes one last attempt. */
async function persist<T>(o: RunnerOptions, what: string, fn: () => Promise<T>): Promise<T | undefined> {
  const log = o.log ?? (() => {});
  let final = false;
  for (let fails = 0; ; ) {
    try {
      return await fn();
    } catch (err) {
      log(`error ${what}: ${clip((err as Error).message, 200)}`);
      if (final) {
        log(`gave up ${what}`);
        return undefined;
      }
      if (o.signal?.aborted) {
        final = true;
        continue;
      }
      fails++;
      await sleep(backoff(o, fails), o.signal);
    }
  }
}

/** Takes the next task aimed at this agent. A lost reply is recovered from the hub's view of what I hold. */
async function claimTask(o: RunnerOptions): Promise<TaskData | undefined> {
  try {
    const r = await withClient(o, (c) => tool(c, 'claim', { mine_only: true, structured: true }));
    if (r.task) return r.task;
    if (/^You have #/.test(r.text)) throw new Error('the hub handed out a task without structured data');
    return undefined;
  } catch (err) {
    // The team is stopped: nothing to claim. Idle quietly until the owner resumes.
    if (err instanceof HubError && err.message.startsWith(STOPPED_PREFIX)) return undefined;
    if (err instanceof RunnerFatal || err instanceof HubError) throw err;
    // The claim may have gone through with the reply lost. Look for a task I hold in `working`.
    const held = await withClient(
      o,
      async (c) => {
        const team = (await tool(c, 'team', {})).text;
        const id = /^- #(\d+) \[working, you\]/m.exec(team)?.[1];
        return id ? (await tool(c, 'task', { task: Number(id), structured: true })).task : undefined;
      },
      false,
    ).catch(() => undefined);
    if (!held) throw err;
    (o.log ?? (() => {}))(`claim reply lost; continuing with #${held.id}, which I hold`);
    return held;
  }
}

async function release(o: RunnerOptions, id: number): Promise<void> {
  await persist(o, `releasing #${id}`, () => withClient(o, (c) => tool(c, 'update', { task: id, state: 'open' }), false));
}

/** Claims at most one task aimed at the agent and runs it. Undefined when nothing was waiting. */
export async function runOnce(o: RunnerOptions): Promise<RunResult | undefined> {
  checkOptions(o);
  const log = o.log ?? (() => {});
  const t = await claimTask(o);
  if (!t) return undefined;
  log(`claimed #${t.id}`);

  if (t.claimed_by !== o.agent) {
    await release(o, t.id);
    throw new RunnerFatal(`the key belongs to ${t.claimed_by}, not ${o.agent}. Released #${t.id}; stopping.`);
  }
  if (o.signal?.aborted) {
    await release(o, t.id);
    log(`#${t.id} released: runner stopped`);
    return undefined;
  }

  let work: { cwd: string; branch?: string } | undefined;
  let exit: Exit | undefined;
  let setupError: string | undefined;
  let startError: string | undefined;
  const logPath = join(o.logs, `${o.agent}-task-${t.id}.log`);
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let result: RunResult | undefined;
  try {
    try {
      work = await setupWorkdir(o, t);
    } catch (err) {
      setupError = clip((err as Error).message);
      log(`#${t.id} setup failed: ${setupError}`);
    }
    if (work && !o.signal?.aborted) {
      const prior = work.branch ? await branchState(work.cwd, work.branch).catch(() => undefined) : undefined;
      const prompt = buildPrompt(o.agent, t, work.cwd, work.branch, prior);
      const argv = o.promptStdin ? o.command : o.command.some((a) => a.includes('{prompt}')) ? o.command.map((a) => a.replaceAll('{prompt}', () => prompt)) : [...o.command, prompt];
      log(`#${t.id} run started (cwd ${work.cwd}, log ${logPath})`);
      try {
        exit = await runCommand(o, argv, work.cwd, logPath, prompt);
      } catch (err) {
        startError = clip((err as Error).message);
        log(`#${t.id} couldn't start the run: ${startError}`);
      }
    } else if (work) {
      exit = { code: null, signal: null, timedOut: false, stopped: true };
    }
  } finally {
    // Whatever happened above, the task must not stay `working` because of this run.
    const how = setupError
      ? `couldn't set up a workspace: ${setupError}`
      : startError
        ? `couldn't start the run: ${startError}`
        : exit?.stopped
          ? 'runner stopped'
          : exit?.timedOut
            ? `timed out after ${showDuration(timeoutMs)}`
            : exit?.error
              ? `failed to start: ${clip(exit.error, 120)}`
              : `exit ${exit?.code ?? exit?.signal}`;
    // What the agent left behind, measured before anything is saved.
    let found: BranchState | undefined;
    if (work?.branch) found = await branchState(work.cwd, work.branch).catch((e) => (log(`#${t.id} couldn't inspect the branch: ${clip((e as Error).message, 150)}`), undefined));
    let wip: { sha?: string; error?: string } | undefined;
    const saveOnce = async (reason: string) => {
      if (wip || !work?.branch || !found?.dirty.length) return;
      try {
        wip = { sha: await saveWip(work.cwd, o.agent, t.id, reason) };
        log(`#${t.id} saved uncommitted work as ${wip.sha ?? 'nothing'}`);
      } catch (err) {
        wip = { error: clip((err as Error).message, 150) };
        log(`#${t.id} couldn't save WIP: ${wip.error}`);
      }
    };
    const wipNote = () => (wip?.sha ? ` Uncommitted work saved as WIP commit ${wip.sha}.` : wip?.error ? ` Saving WIP failed: ${wip.error}.` : '');
    const settled = await persist(o, `finishing #${t.id}`, () =>
      withClient(
        o,
        async (c) => {
          const after = (await tool(c, 'task', { task: t.id, structured: true })).task;
          const mine = after?.claimed_by === o.agent;
          const handedOff = !!after && !mine && after.state === 'open' && !!after.for_agent && after.for_agent !== o.agent;
          const problems: string[] = [];
          if (found && work?.branch && ((mine && (after!.state === 'review' || after!.state === 'done')) || handedOff)) {
            if (found.commits && found.commits.length === 0) problems.push(`the branch has 0 commits ahead of ${found.base}`);
            if (found.dirty.length) problems.push(`${found.dirty.length} uncommitted file${found.dirty.length === 1 ? '' : 's'} in the worktree`);
          }
          if (mine && after!.state === 'working') {
            await saveOnce(how);
            const note = setupError || startError ? how : exit?.stopped ? 'runner stopped' : `run ended without finishing (${how}). Log: ${logPath}`;
            await tool(c, 'update', { task: t.id, state: 'blocked', note: clip(`${note}${wipNote()}`, 1400), links: clip(work?.cwd ?? '', 900) });
            return { state: 'blocked', blocked: true };
          }
          if (problems.length) {
            await saveOnce('not committed at handoff');
            const found_ = `Found: ${found!.commits ? `${found!.commits.length} commits ahead of ${found!.base}` : 'commit count unknown'}, ${found!.dirty.length} uncommitted files.`;
            const fix = `Do: run the full checks, git add -A && git commit, confirm git status is clean, then update to review again.${wipNote()}`;
            if (mine) {
              await tool(c, 'update', { task: t.id, state: 'blocked', note: clip(`Not accepted: ${after!.state} was requested but ${problems.join(' and ')}. ${found_} ${fix} Log: ${logPath}`, 1400), links: clip(work?.cwd ?? '', 900) });
              return { state: 'blocked', blocked: true };
            }
            // After a handoff the task is no longer ours to change; tell its new holder instead.
            await tool(c, 'send', { to: after!.for_agent, task: t.id, text: clip(`#${t.id} was handed to you but ${problems.join(' and ')} (${work!.cwd}). ${found_} ${wipNote().trim()}`, 900) });
            return { state: after!.state, blocked: false };
          }
          await saveOnce(how);
          return { state: after?.state ?? 'unknown', blocked: false };
        },
        false,
      ),
    );
    const state = settled?.state ?? 'unknown';
    log(`#${t.id} run ended (${how}); task is ${state}`);
    result = {
      task: t.id,
      outcome: setupError ? 'setup-failed' : settled?.blocked ? 'blocked' : 'finished',
      exitCode: exit?.code ?? null,
      timedOut: exit?.timedOut ?? false,
      stopped: exit?.stopped ?? false,
      state,
      log: exit ? logPath : undefined,
      cwd: work?.cwd,
    };
  }
  return result;
}

/** Repeats runOnce until `signal` aborts. Hub errors are retried with backoff; a RunnerFatal ends the loop. */
export async function runLoop(o: RunnerOptions): Promise<void> {
  checkOptions(o);
  const log = o.log ?? (() => {});
  const poll = o.pollMs ?? DEFAULT_POLL_MS;
  let fails = 0;
  let checked = false;
  while (!o.signal?.aborted) {
    try {
      if (!checked) {
        // Version, and that the key is the agent's: `team` opens with "You are <name>."
        const who = await withClient(o, async (c) => /^You are (\S+?)\./.exec((await tool(c, 'team', {})).text)?.[1]);
        if (who && who !== o.agent) throw new RunnerFatal(`the key belongs to ${who}, not ${o.agent}.`);
        checked = true;
      }
      const r = await runOnce(o);
      fails = 0;
      if (r) continue;
      await sleep(poll, o.signal);
    } catch (err) {
      if (err instanceof RunnerFatal) {
        log(`fatal: ${err.message}`);
        throw err;
      }
      fails++;
      const wait = backoff(o, fails);
      log(`error: ${clip((err as Error).message, 200)}; retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait, o.signal);
    }
  }
}
