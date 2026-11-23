// All state lives here: agents, goals, tasks, questions and an append-only event log.
// One SQLite file (WAL). Every write that others should hear about adds an event and
// calls `changed`, which wakes waiting agents and refreshes open boards.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const TASK_STATES = ['open', 'working', 'review', 'blocked', 'done', 'dropped'] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const GOAL_STATES = ['open', 'done', 'dropped'] as const;
export type GoalState = (typeof GOAL_STATES)[number];

/** Who an event is for: an agent's name, every agent, the owner, or only the board's log. */
export type Audience = string | 'all' | 'owner' | 'log';

export interface Agent {
  name: string;
  strengths: string;
  status: 'available' | 'resting';
  resting_until: number | null;
  status_note: string;
  last_seen: number | null;
  created_at: number;
}

export interface Goal {
  id: number;
  title: string;
  detail: string;
  state: GoalState;
  created_at: number;
  updated_at: number;
}

export interface Task {
  id: number;
  goal_id: number | null;
  title: string;
  brief: string;
  for_agent: string | null;
  posted_by: string;
  claimed_by: string | null;
  state: TaskState;
  note: string;
  links: string;
  created_at: number;
  updated_at: number;
}

export interface TeamEvent {
  id: number;
  at: number;
  sender: string;
  audience: Audience;
  kind: string;
  task_id: number | null;
  goal_id: number | null;
  text: string;
}

export interface Question {
  id: number;
  asker: string;
  task_id: number | null;
  text: string;
  answer: string | null;
  asked_at: number;
  answered_at: number | null;
}

export class TeamError extends Error {}

/** The team-wide stop switch (see `pause`). */
export interface PauseState {
  by: string;
  reason: string;
  at: number;
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED = new Set(['all', 'owner', 'log', 'you', 'me', 'team']);
const SESSION_DAYS = 30;
/** Names of agents resting right now; takes the current time as its one parameter. */
const RESTING = "SELECT name FROM agents WHERE status = 'resting' AND (resting_until IS NULL OR resting_until > ?)";

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function newKey(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function validName(name: string): boolean {
  return NAME.test(name) && !RESERVED.has(name);
}

const NOTE_IN_EVENT = 200;

/** Squeezes whitespace and cuts to `n` characters. */
export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** A task note as it appears in an event line: clipped, with a pointer to the full text. */
function noteTail(note: string | null | undefined, id: number): string {
  if (!note) return '.';
  const one = note.replace(/\s+/g, ' ').trim();
  return one.length <= NOTE_IN_EVENT ? `: ${one}` : `: ${clip(one, NOTE_IN_EVENT)} (task ${id} for the full note)`;
}

export class Store {
  readonly db: DatabaseSync;
  /** Emits 'change' after every write. */
  readonly events = new EventEmitter();
  now: () => number = () => Date.now();
  /** A working task nobody has touched for this long counts as paused (see `paused`). */
  staleMs = 45 * 60_000;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600); // messages and briefs are private
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (
        name TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        strengths TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'available',
        resting_until INTEGER,
        status_note TEXT NOT NULL DEFAULT '',
        last_seen INTEGER,
        cursor INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goals (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY,
        goal_id INTEGER REFERENCES goals(id),
        title TEXT NOT NULL,
        brief TEXT NOT NULL,
        for_agent TEXT,
        posted_by TEXT NOT NULL,
        claimed_by TEXT,
        state TEXT NOT NULL DEFAULT 'open',
        note TEXT NOT NULL DEFAULT '',
        links TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        sender TEXT NOT NULL,
        audience TEXT NOT NULL,
        kind TEXT NOT NULL,
        task_id INTEGER,
        goal_id INTEGER,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_audience ON events (audience, id);
      CREATE TABLE IF NOT EXISTS questions (
        id INTEGER PRIMARY KEY,
        asker TEXT NOT NULL,
        task_id INTEGER,
        text TEXT NOT NULL,
        answer TEXT,
        asked_at INTEGER NOT NULL,
        answered_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
    `);
    this.events.setMaxListeners(0);
  }

  private watcher?: NodeJS.Timeout;

  /** Notices writes by other processes (the CLI, say) and announces them like local ones. */
  watch(intervalMs = 1000): void {
    let last = this.dataVersion();
    this.watcher = setInterval(() => {
      const v = this.dataVersion();
      if (v !== last) {
        last = v;
        this.changed();
      }
    }, intervalMs);
    this.watcher.unref();
  }

  private dataVersion(): number {
    return Number((this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version);
  }

  close(): void {
    if (this.watcher) clearInterval(this.watcher);
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private changed(): void {
    this.events.emit('change');
  }

  private log(e: Omit<TeamEvent, 'id' | 'at'>): number {
    const r = this.db
      .prepare('INSERT INTO events (at, sender, audience, kind, task_id, goal_id, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(this.now(), e.sender, e.audience, e.kind, e.task_id, e.goal_id, e.text);
    return Number(r.lastInsertRowid);
  }

  private lastEventId(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get() as { id: number };
    return Number(row.id);
  }

  // ── Keys and identity ────────────────────────────────────────────────

  initialized(): boolean {
    return this.db.prepare("SELECT 1 FROM meta WHERE key = 'owner_key_hash'").get() !== undefined;
  }

  /** Sets a new owner key and returns it. Replaces any old one and signs out every board. */
  resetOwnerKey(): string {
    const key = newKey('owner');
    this.tx(() => {
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('owner_key_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(hashKey(key));
      this.db.exec('DELETE FROM sessions');
    });
    return key;
  }

  isOwnerKey(key: string): boolean {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'owner_key_hash'").get() as { value: string } | undefined;
    return row !== undefined && sameHash(row.value, hashKey(key));
  }

  /** The agent a key belongs to, or undefined. Marks the agent as seen. */
  agentForKey(key: string): string | undefined {
    const row = this.db.prepare('SELECT name FROM agents WHERE key_hash = ?').get(hashKey(key)) as { name: string } | undefined;
    if (row) this.db.prepare('UPDATE agents SET last_seen = ? WHERE name = ?').run(this.now(), row.name);
    return row?.name;
  }

  addAgent(name: string, strengths = ''): string {
    if (!validName(name)) {
      throw new TeamError(`"${name}" can't be an agent name: use 1-32 lower-case letters, digits or dashes, starting with a letter (not all, owner, log, you, me or team).`);
    }
    if (this.getAgent(name)) throw new TeamError(`There is already an agent called ${name}. Use rotate to give it a new key.`);
    const key = newKey(`team_${name}`);
    this.tx(() => {
      this.db
        .prepare('INSERT INTO agents (name, key_hash, strengths, created_at) VALUES (?, ?, ?, ?)')
        .run(name, hashKey(key), strengths.trim(), this.now());
      this.log({ sender: 'owner', audience: 'all', kind: 'joined', task_id: null, goal_id: null, text: `${name} joined the team${strengths ? ` (${strengths.trim()})` : ''}.` });
      // Start past everything so far, its own arrival included.
      this.db.prepare('UPDATE agents SET cursor = ? WHERE name = ?').run(this.lastEventId(), name);
    });
    this.changed();
    return key;
  }

  rotateKey(name: string): string {
    const key = newKey(`team_${name}`);
    const r = this.db.prepare('UPDATE agents SET key_hash = ? WHERE name = ?').run(hashKey(key), name);
    if (r.changes === 0) throw new TeamError(`There is no agent called ${name}.`);
    return key;
  }

  removeAgent(name: string): void {
    this.tx(() => {
      const r = this.db.prepare('DELETE FROM agents WHERE name = ?').run(name);
      if (r.changes === 0) throw new TeamError(`There is no agent called ${name}.`);
      this.db.prepare("UPDATE tasks SET claimed_by = NULL, state = 'open', updated_at = ? WHERE claimed_by = ? AND state IN ('working', 'review', 'blocked')").run(this.now(), name);
      this.db.prepare('UPDATE tasks SET for_agent = NULL WHERE for_agent = ?').run(name);
      this.log({ sender: 'owner', audience: 'all', kind: 'left', task_id: null, goal_id: null, text: `${name} left the team; its tasks are open again.` });
    });
    this.changed();
  }

  // ── Owner board sessions ─────────────────────────────────────────────

  newSession(): string {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    this.db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').run(hashKey(token), now + SESSION_DAYS * 86_400_000);
    return token;
  }

  isSession(token: string): boolean {
    const row = this.db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(hashKey(token)) as { expires_at: number } | undefined;
    return row !== undefined && row.expires_at > this.now();
  }

  endSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashKey(token));
  }

  // ── Reads ────────────────────────────────────────────────────────────

  getAgent(name: string): Agent | undefined {
    const a = this.db
      .prepare('SELECT name, strengths, status, resting_until, status_note, last_seen, created_at FROM agents WHERE name = ?')
      .get(name) as Agent | undefined;
    return a && this.wake(a);
  }

  agents(): Agent[] {
    const rows = this.db
      .prepare('SELECT name, strengths, status, resting_until, status_note, last_seen, created_at FROM agents ORDER BY name')
      .all() as unknown as Agent[];
    return rows.map((a) => this.wake(a));
  }

  /** A resting agent whose time is up is available again. */
  private wake(a: Agent): Agent {
    if (a.status === 'resting' && a.resting_until !== null && a.resting_until <= this.now()) {
      this.db.prepare("UPDATE agents SET status = 'available', resting_until = NULL, status_note = '' WHERE name = ?").run(a.name);
      return { ...a, status: 'available', resting_until: null, status_note: '' };
    }
    return a;
  }

  goal(id: number): Goal | undefined {
    return this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Goal | undefined;
  }

  goals(states: GoalState[] = ['open']): Goal[] {
    return this.db
      .prepare(`SELECT * FROM goals WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY id`)
      .all(...states) as unknown as Goal[];
  }

  task(id: number): Task | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
  }

  /** Tasks that are not finished, plus finished ones from the last `recentMs`. */
  tasks(recentMs = 0): Task[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE state NOT IN ('done', 'dropped') OR updated_at >= ? ORDER BY id")
      .all(recentMs > 0 ? this.now() - recentMs : Number.MAX_SAFE_INTEGER) as unknown as Task[];
  }

  /**
   * Why a task is paused, or null. Paused = working, and either its holder is resting right now or the
   * task itself has had no update for `staleMs`. Uses the task's own update time, not the holder's
   * last_seen: a background waiter keeps last_seen fresh after an agent runs out of usage.
   */
  paused(t: Task): string | null {
    if (t.state !== 'working' || !t.claimed_by) return null;
    // While the whole team is stopped nothing is takeable; resume refreshes the update times.
    if (this.pauseState()) return null;
    const now = this.now();
    const a = this.db.prepare('SELECT status, resting_until FROM agents WHERE name = ?').get(t.claimed_by) as
      | { status: string; resting_until: number | null }
      | undefined;
    if (a && a.status === 'resting' && (a.resting_until === null || a.resting_until > now)) return `${t.claimed_by} resting`;
    if (now - t.updated_at >= this.staleMs) return `no update ${Math.round((now - t.updated_at) / 60_000)}m`;
    return null;
  }

  /** Who stopped the team, why and when; null when it is running. */
  pauseState(): PauseState | null {
    const rows = this.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'paused%'").all() as { key: string; value: string }[];
    const m = new Map(rows.map((r) => [r.key, r.value]));
    if (m.get('paused') !== '1') return null;
    return { by: m.get('paused_by') ?? '', reason: m.get('paused_reason') ?? '', at: Number(m.get('paused_at') ?? 0) };
  }

  private requireRunning(): void {
    const p = this.pauseState();
    if (p) throw new TeamError(`Team is stopped by ${p.by}${p.reason ? `: ${p.reason}` : ''}. Don't start anything new until the owner resumes.`);
  }

  openQuestions(): Question[] {
    return this.db.prepare('SELECT * FROM questions WHERE answer IS NULL ORDER BY id').all() as unknown as Question[];
  }

  recentEvents(limit = 50): TeamEvent[] {
    return (this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as unknown as TeamEvent[]).reverse();
  }

  private inboxWhere = "audience IN ('all', ?) AND sender != ?";

  unread(agent: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE id > (SELECT cursor FROM agents WHERE name = ?) AND ${this.inboxWhere}`)
      .get(agent, agent, agent) as { n: number };
    return Number(row.n);
  }

  /** Events for `agent` since it last read, oldest first, and moves its cursor past them. */
  takeInbox(agent: string, limit = 20): { events: TeamEvent[]; more: number } {
    return this.tx(() => {
      const cur = this.db.prepare('SELECT cursor FROM agents WHERE name = ?').get(agent) as { cursor: number } | undefined;
      if (!cur) throw new TeamError(`There is no agent called ${agent}.`);
      const rows = this.db
        .prepare(`SELECT * FROM events WHERE id > ? AND ${this.inboxWhere} ORDER BY id LIMIT ?`)
        .all(cur.cursor, agent, agent, limit + 1) as unknown as TeamEvent[];
      let events = rows;
      let next = this.lastEventId();
      let more = 0;
      if (rows.length > limit) {
        events = rows.slice(0, limit);
        next = events[events.length - 1].id;
        const n = this.db
          .prepare(`SELECT COUNT(*) AS n FROM events WHERE id > ? AND ${this.inboxWhere}`)
          .get(next, agent, agent) as { n: number };
        more = Number(n.n);
      }
      this.db.prepare('UPDATE agents SET cursor = ? WHERE name = ?').run(next, agent);
      return { events, more };
    });
  }

  // ── Writes by agents (and the owner) ─────────────────────────────────

  private requireAgent(name: string): void {
    if (!this.getAgent(name)) throw new TeamError(`There is no agent called ${name}. Teammates: ${this.agents().map((a) => a.name).join(', ') || 'none yet'}.`);
  }

  private requireTask(id: number): Task {
    const t = this.task(id);
    if (!t) throw new TeamError(`There is no task #${id}.`);
    return t;
  }

  postTask(by: string, p: { title: string; brief: string; goal?: number | null; for?: string | null }): Task {
    const title = p.title.trim();
    const brief = p.brief.trim();
    if (!title) throw new TeamError('A task needs a title.');
    if (!brief) throw new TeamError('A task needs a brief that someone else could start from.');
    if (by !== 'owner') this.requireRunning();
    if (p.goal != null) {
      const g = this.goal(p.goal);
      if (!g) throw new TeamError(`There is no goal G${p.goal}.`);
      if (g.state !== 'open') throw new TeamError(`Goal G${p.goal} is ${g.state}.`);
    }
    const forAgent = p.for?.trim() || null;
    if (forAgent) this.requireAgent(forAgent);
    const id = this.tx(() => {
      const now = this.now();
      const r = this.db
        .prepare('INSERT INTO tasks (goal_id, title, brief, for_agent, posted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(p.goal ?? null, title, brief, forAgent, by, now, now);
      const id = Number(r.lastInsertRowid);
      this.log({
        sender: by,
        audience: forAgent ?? 'all',
        kind: 'task',
        task_id: id,
        goal_id: p.goal ?? null,
        text: `posted #${id} "${title}"${forAgent ? ` for ${forAgent}` : ''}.`,
      });
      return id;
    });
    this.changed();
    return this.task(id)!;
  }

  /** An agent that claims or updates is evidently back: clear its resting status. */
  private back(agent: string): void {
    this.db.prepare("UPDATE agents SET status = 'available', resting_until = NULL, status_note = '' WHERE name = ? AND status = 'resting'").run(agent);
  }

  /** Claims task `id`, or the best open task for `agent`. Returns undefined when there is nothing to take. */
  claim(agent: string, id?: number, opts: { mineOnly?: boolean } = {}): Task | undefined {
    this.requireRunning();
    const out = this.tx(() => {
      this.back(agent);
      let t: Task | undefined;
      if (id !== undefined) {
        t = this.requireTask(id);
        if (t.claimed_by === agent && t.state !== 'done' && t.state !== 'dropped') return t;
        const why = this.paused(t);
        if (why) {
          const g = t.goal_id !== null ? this.goal(t.goal_id) : undefined;
          if (g && g.state !== 'open') throw new TeamError(`#${id} belongs to goal G${g.id}, which is ${g.state}.`);
          // Takeover: the note and links stay as the handover.
          const old = t.claimed_by!;
          const r = this.db.prepare("UPDATE tasks SET claimed_by = ?, updated_at = ? WHERE id = ? AND state = 'working' AND claimed_by = ?").run(agent, this.now(), t.id, old);
          if (Number(r.changes) !== 1) throw new TeamError(`#${id} changed while you were claiming it. Try again.`);
          const text = `took over #${t.id} "${t.title}" (paused: ${why}).`;
          this.log({ sender: agent, audience: old, kind: 'takeover', task_id: t.id, goal_id: t.goal_id, text });
          if (t.posted_by !== old && t.posted_by !== agent) {
            this.log({ sender: agent, audience: t.posted_by, kind: 'update', task_id: t.id, goal_id: t.goal_id, text });
          }
          return this.task(t.id);
        }
        if (t.state !== 'open') throw new TeamError(`#${id} is ${t.state}${t.claimed_by ? ` (${t.claimed_by})` : ''}, so it can't be claimed.`);
        const g = t.goal_id !== null ? this.goal(t.goal_id) : undefined;
        if (g && g.state !== 'open') throw new TeamError(`#${id} belongs to goal G${g.id}, which is ${g.state}.`);
        if (t.for_agent && t.for_agent !== agent) {
          const owner = this.getAgent(t.for_agent);
          if (owner && owner.status !== 'resting') {
            throw new TeamError(`#${id} is meant for ${t.for_agent}. Ask them (send) or the owner to hand it over.`);
          }
        }
      } else {
        // Mine first, then anyone's, then those aimed at a resting teammate; never under a closed goal.
        // With mineOnly, only those aimed at me.
        const who = opts.mineOnly ? 't.for_agent = ?' : `(t.for_agent IS NULL OR t.for_agent = ? OR t.for_agent IN (${RESTING}))`;
        t = this.db
          .prepare(
            `SELECT t.* FROM tasks t LEFT JOIN goals g ON g.id = t.goal_id
             WHERE t.state = 'open' AND t.claimed_by IS NULL AND (t.goal_id IS NULL OR g.state = 'open')
               AND ${who}
             ORDER BY CASE WHEN t.for_agent = ? THEN 0 WHEN t.for_agent IS NULL THEN 1 ELSE 2 END, t.id LIMIT 1`,
          )
          .get(...(opts.mineOnly ? [agent, agent] : [agent, this.now(), agent])) as Task | undefined;
        if (!t) return undefined;
      }
      this.db
        .prepare("UPDATE tasks SET claimed_by = ?, state = 'working', updated_at = ? WHERE id = ? AND state = 'open'")
        .run(agent, this.now(), t.id);
      this.log({ sender: agent, audience: 'log', kind: 'claim', task_id: t.id, goal_id: t.goal_id, text: `claimed #${t.id} "${t.title}".` });
      return this.task(t.id);
    });
    if (out) this.changed();
    return out;
  }

  update(
    by: string,
    id: number,
    p: { state?: TaskState; note?: string; links?: string; handoff?: string },
    asOwner = false,
  ): Task {
    const out = this.tx(() => {
      const t = this.requireTask(id);
      const holder = t.claimed_by === by;
      const poster = t.posted_by === by;
      if (!asOwner && !holder && !(poster && t.claimed_by === null)) {
        // An approximation: after later handoffs or takeovers this may name someone who no longer matters.
        const took = this.db
          .prepare("SELECT sender FROM events WHERE kind = 'takeover' AND task_id = ? AND audience = ? ORDER BY id DESC LIMIT 1")
          .get(id, by) as { sender: string } | undefined;
        if (took && took.sender === t.claimed_by) throw new TeamError(`#${id} was taken over by ${took.sender}; coordinate with send.`);
        throw new TeamError(
          t.claimed_by
            ? `#${id} is held by ${t.claimed_by}. Only they (or the owner) can change it; send them a message instead.`
            : `#${id} isn't yours. Claim it first.`,
        );
      }
      this.back(by);
      const note = p.note?.trim();
      const links = p.links?.trim();
      const now = this.now();
      const state = p.state ?? t.state;
      if (!TASK_STATES.includes(state)) throw new TeamError(`Unknown state ${state}.`);
      // Without holding it, the poster may only drop or re-aim a task, and the owner may also close
      // or reopen it. Someone has to hold a task that is being worked on.
      const allowed = holder ? TASK_STATES : asOwner ? ['open', 'done', 'dropped'] : ['dropped'];
      if (!p.handoff && state !== t.state && !(allowed as readonly string[]).includes(state)) {
        throw new TeamError(
          asOwner ? `#${id} has nobody on it. Hand it to a teammate instead.` : `Claim #${id} before moving it to ${state}.`,
        );
      }
      if (p.handoff) {
        const to = p.handoff.trim();
        this.requireAgent(to);
        if (to === by) throw new TeamError('You can\'t hand a task to yourself.');
        this.db
          .prepare("UPDATE tasks SET for_agent = ?, claimed_by = NULL, state = 'open', note = COALESCE(?, note), links = COALESCE(?, links), updated_at = ? WHERE id = ?")
          .run(to, note ?? null, links ?? null, now, id);
        this.log({
          sender: by,
          audience: to,
          kind: 'handoff',
          task_id: id,
          goal_id: t.goal_id,
          text: `handed you #${id} "${t.title}"${noteTail(note, id)}`,
        });
        return this.task(id)!;
      }
      const claimedBy = state === 'open' ? null : t.claimed_by;
      this.db
        .prepare('UPDATE tasks SET state = ?, claimed_by = ?, note = COALESCE(?, note), links = COALESCE(?, links), updated_at = ? WHERE id = ?')
        .run(state, claimedBy, note ?? null, links ?? null, now, id);
      // Tell the poster when their task finishes, gets stuck or comes back; the rest is for the board.
      let audience: Audience = 'log';
      if (state !== t.state && ['done', 'blocked', 'review', 'dropped', 'open'].includes(state) && t.posted_by !== by) {
        audience = t.posted_by;
      }
      const verb = state !== t.state ? `moved #${id} "${t.title}" to ${state}` : `updated #${id} "${t.title}"`;
      this.log({ sender: by, audience, kind: 'update', task_id: id, goal_id: t.goal_id, text: `${verb}${noteTail(note, id)}${links ? ` (${links})` : ''}` });
      return this.task(id)!;
    });
    this.changed();
    return out;
  }

  send(from: string, to: string, text: string, taskId?: number | null): { question?: Question } {
    const body = text.trim();
    if (!body) throw new TeamError('The message is empty.');
    if (to !== 'all' && to !== 'owner') this.requireAgent(to);
    if (to === from) throw new TeamError('That is you.');
    if (taskId != null) this.requireTask(taskId);
    const out = this.tx(() => {
      if (to === 'owner') {
        const r = this.db.prepare('INSERT INTO questions (asker, task_id, text, asked_at) VALUES (?, ?, ?, ?)').run(from, taskId ?? null, body, this.now());
        const qid = Number(r.lastInsertRowid);
        this.log({ sender: from, audience: 'owner', kind: 'question', task_id: taskId ?? null, goal_id: null, text: `Q${qid}: ${body}` });
        return { question: this.db.prepare('SELECT * FROM questions WHERE id = ?').get(qid) as unknown as Question };
      }
      this.log({ sender: from, audience: to, kind: 'message', task_id: taskId ?? null, goal_id: null, text: body });
      return {};
    });
    this.changed();
    return out;
  }

  /**
   * Stops the whole team: one event to every agent (the pauser included), and claim and post_task are
   * refused until `resume`. update, send, task, team and wiki reads keep working so agents can checkpoint.
   */
  pause(by: string, reason: string): PauseState {
    const why = clip(reason, 300);
    if (!why) throw new TeamError('Say why the team is stopping.');
    const out = this.tx(() => {
      const cur = this.pauseState();
      if (cur) throw new TeamError(`Already stopped by ${cur.by}${cur.reason ? `: ${cur.reason}` : ''}.`);
      const at = this.now();
      const set = this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      set.run('paused', '1');
      set.run('paused_by', by);
      set.run('paused_reason', why);
      set.run('paused_at', String(at));
      // Sent by 'team' (a reserved name), so the one who paused hears it too.
      this.log({
        sender: 'team',
        audience: 'all',
        kind: 'pause',
        task_id: null,
        goal_id: null,
        text: `TEAM STOPPED by ${by}: ${why}. Checkpoint now (commit + push WIP, update your task note with done/next), stop your background waiter, and end your turn. Don't start anything new until the owner resumes.`,
      });
      return { by, reason: why, at };
    });
    this.changed();
    return out;
  }

  /**
   * Lifts the stop. Working tasks get a fresh update time, so the stopped interval doesn't count towards
   * the takeover timer (stale-minutes) and nothing turns "paused" the moment the team resumes.
   */
  resume(by: string): void {
    this.tx(() => {
      if (!this.pauseState()) throw new TeamError("The team isn't stopped.");
      this.db.prepare("DELETE FROM meta WHERE key LIKE 'paused%'").run();
      this.db.prepare("UPDATE tasks SET updated_at = ? WHERE state = 'working'").run(this.now());
      this.log({ sender: 'team', audience: 'all', kind: 'resume', task_id: null, goal_id: null, text: `Team resumed by ${by}. Call team and carry on with your tasks.` });
    });
    this.changed();
  }

  /** Notes in the board's activity that an agent saved a wiki page. */
  noteWiki(agent: string, slug: string): void {
    this.log({ sender: agent, audience: 'log', kind: 'wiki', task_id: null, goal_id: null, text: `saved wiki page ${slug}.` });
    this.changed();
  }

  setStatus(agent: string, status: 'available' | 'resting', untilMs: number | null, note: string): Agent {
    this.db
      .prepare('UPDATE agents SET status = ?, resting_until = ?, status_note = ? WHERE name = ?')
      .run(status, status === 'resting' ? untilMs : null, status === 'resting' ? note.trim() : '', agent);
    this.log({
      sender: agent,
      audience: 'log',
      kind: 'status',
      task_id: null,
      goal_id: null,
      text: status === 'resting' ? `is resting${note.trim() ? `: ${note.trim()}` : ''}.` : 'is available.',
    });
    this.changed();
    return this.getAgent(agent)!;
  }

  // ── Writes by the owner ──────────────────────────────────────────────

  postGoal(title: string, detail = ''): Goal {
    const t = title.trim();
    if (!t) throw new TeamError('A goal needs a title.');
    const id = this.tx(() => {
      const now = this.now();
      const r = this.db.prepare('INSERT INTO goals (title, detail, created_at, updated_at) VALUES (?, ?, ?, ?)').run(t, detail.trim(), now, now);
      const id = Number(r.lastInsertRowid);
      this.log({ sender: 'owner', audience: 'all', kind: 'goal', task_id: null, goal_id: id, text: `new goal G${id} "${t}"${detail.trim() ? `: ${detail.trim()}` : '.'}` });
      return id;
    });
    this.changed();
    return this.goal(id)!;
  }

  setGoal(id: number, state: GoalState): Goal {
    if (!GOAL_STATES.includes(state)) throw new TeamError(`Unknown goal state ${state}.`);
    const g = this.goal(id);
    if (!g) throw new TeamError(`There is no goal G${id}.`);
    this.tx(() => {
      this.db.prepare('UPDATE goals SET state = ?, updated_at = ? WHERE id = ?').run(state, this.now(), id);
      if (state === 'dropped') {
        this.db.prepare("UPDATE tasks SET state = 'dropped', updated_at = ? WHERE goal_id = ? AND state = 'open' AND claimed_by IS NULL").run(this.now(), id);
      }
      this.log({ sender: 'owner', audience: 'all', kind: 'goal', task_id: null, goal_id: id, text: `marked goal G${id} "${g.title}" ${state}.` });
    });
    this.changed();
    return this.goal(id)!;
  }

  answer(questionId: number, text: string): Question {
    const body = text.trim();
    if (!body) throw new TeamError('The answer is empty.');
    const q = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId) as Question | undefined;
    if (!q) throw new TeamError(`There is no question Q${questionId}.`);
    if (q.answer !== null) throw new TeamError(`Q${questionId} is already answered.`);
    this.tx(() => {
      this.db.prepare('UPDATE questions SET answer = ?, answered_at = ? WHERE id = ?').run(body, this.now(), questionId);
      this.log({
        sender: 'owner',
        audience: q.asker,
        kind: 'answer',
        task_id: q.task_id,
        goal_id: null,
        text: `answered Q${questionId} ("${q.text.length > 80 ? `${q.text.slice(0, 77)}...` : q.text}"): ${body}`,
      });
    });
    this.changed();
    return this.db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId) as unknown as Question;
  }
}
