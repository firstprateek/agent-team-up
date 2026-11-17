// Turns store state into the short text agents read and the JSON the board draws.

import type { Agent, Goal, Question, Store, Task, TeamEvent } from './store.ts';

const DAY = 86_400_000;

export function ago(ms: number | null, now: number): string {
  if (ms === null) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function until(ms: number, now: number): string {
  const m = Math.max(1, Math.round((ms - now) / 60_000));
  return m < 120 ? `for ${m}m more` : `for ${Math.round(m / 60)}h more`;
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function taskLine(t: Task, me: string): string {
  const who =
    t.claimed_by !== null
      ? t.claimed_by === me
        ? 'you'
        : t.claimed_by
      : t.for_agent !== null
        ? `for ${t.for_agent === me ? 'you' : t.for_agent}`
        : '';
  return `#${t.id} [${t.state}${who ? `, ${who}` : ''}] ${oneLine(t.title)}${t.goal_id !== null ? ` (G${t.goal_id})` : ''}`;
}

function agentLine(a: Agent, tasks: Task[], me: string, now: number): string {
  const doing = tasks.filter((t) => t.claimed_by === a.name && t.state === 'working');
  const parts = [`${a.name === me ? `${a.name} (you)` : a.name}${a.strengths ? ` — ${oneLine(a.strengths)}` : ''}`];
  if (a.status === 'resting') {
    parts.push(`resting${a.resting_until ? ` ${until(a.resting_until, now)}` : ''}${a.status_note ? ` (${oneLine(a.status_note)})` : ''}`);
  } else if (doing.length) {
    parts.push(`on ${doing.map((t) => `#${t.id}`).join(', ')}`);
  } else {
    parts.push('free');
  }
  parts.push(`seen ${ago(a.last_seen, now)}`);
  return `- ${parts.join('; ')}`;
}

/** The `team` tool's reply: everything an agent needs to pick its next move, in a few lines. */
export function teamText(store: Store, me: string): string {
  const now = store.now();
  const agents = store.agents();
  const goals = store.goals();
  const tasks = store.tasks();
  const questions = store.openQuestions();
  const unread = store.unread(me);
  const lines: string[] = [`You are ${me}.`, '', 'Team:'];
  for (const a of agents) lines.push(agentLine(a, tasks, me, now));
  lines.push('', goals.length ? 'Goals:' : 'Goals: none yet. The owner posts them on the board.');
  for (const g of goals) lines.push(`- G${g.id} ${oneLine(g.title)}${g.detail ? ` — ${clip(g.detail, 160)}` : ''}`);
  const mine = tasks.filter((t) => t.claimed_by === me);
  const forMe = tasks.filter((t) => t.state === 'open' && t.claimed_by === null && t.for_agent === me);
  const open = tasks.filter((t) => t.state === 'open' && t.claimed_by === null && t.for_agent === null);
  const others = tasks.filter((t) => !mine.includes(t) && !forMe.includes(t) && !open.includes(t));
  const section = (title: string, list: Task[]) => {
    if (!list.length) return;
    lines.push('', title);
    for (const t of list) lines.push(`- ${taskLine(t, me)}`);
  };
  section('Yours:', mine);
  section('Waiting for you:', forMe);
  section('Open for anyone:', open);
  section("Teammates' tasks:", others);
  if (!tasks.length) lines.push('', 'Tasks: none open.');
  const mineAsked = questions.filter((q) => q.asker === me);
  lines.push('');
  if (questions.length) {
    lines.push(`Questions waiting on the owner: ${questions.length}${mineAsked.length ? ` (${mineAsked.length} yours)` : ''}.`);
  }
  lines.push(unread ? `Unread for you: ${unread}. Call wait to read them.` : 'Nothing unread.');
  return lines.join('\n');
}

export function taskText(t: Task, me: string): string {
  const lines = [taskLine(t, me), '', 'Brief:', indent(t.brief)];
  if (t.note) lines.push('', 'Latest note:', indent(t.note));
  if (t.links) lines.push(`Links: ${oneLine(t.links)}`);
  lines.push('', `Posted by ${t.posted_by === me ? 'you' : t.posted_by}.`);
  return lines.join('\n');
}

/** Keeps a teammate's text on its own line(s), so it can't pass for a line from the server. */
function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, ' ↵ ').trim();
}

function indent(s: string): string {
  return s.trim().split(/\r?\n/).map((l) => `  | ${l}`).join('\n');
}

export function eventLine(e: TeamEvent, me: string, now: number): string {
  const when = now - e.at < DAY ? new Date(e.at).toTimeString().slice(0, 5) : new Date(e.at).toISOString().slice(0, 10);
  const from = e.sender === me ? 'you' : e.sender;
  if (e.kind === 'message') {
    const to = e.audience === me ? 'you' : e.audience;
    return `[${when}] ${from} → ${to}${e.task_id !== null ? ` (#${e.task_id})` : ''}: ${oneLine(e.text)}`;
  }
  return `[${when}] ${from} ${oneLine(e.text)}`;
}

export interface BoardState {
  now: number;
  agents: Agent[];
  goals: Goal[];
  tasks: Task[];
  questions: Question[];
  events: TeamEvent[];
}

/** The board's data. For an agent (`viewer`), direct messages and answers meant for others are left out. */
export function boardState(store: Store, viewer?: string): BoardState {
  const tasks = store.tasks(DAY);
  const used = new Set(tasks.map((t) => t.goal_id));
  const goals = store
    .goals(['open', 'done', 'dropped'])
    .filter((g) => g.state === 'open' || used.has(g.id) || (g.state === 'done' && store.now() - g.updated_at < 7 * DAY));
  const shared = new Set(['all', 'log', 'owner']);
  const events = store
    .recentEvents(viewer ? 200 : 60)
    .filter((e) => !viewer || shared.has(e.audience) || e.audience === viewer || e.sender === viewer)
    .slice(-60);
  return { now: store.now(), agents: store.agents(), goals, tasks, questions: store.openQuestions(), events };
}

/** A plain-text board for clients that don't render MCP Apps. */
export function boardText(s: BoardState): string {
  const lines: string[] = [];
  for (const g of s.goals) {
    const ts = s.tasks.filter((t) => t.goal_id === g.id);
    const done = ts.filter((t) => t.state === 'done').length;
    lines.push(`G${g.id} ${g.title} [${g.state}] — ${done}/${ts.length} tasks done`);
    for (const t of ts) lines.push(`  ${taskLine(t, '')}`);
  }
  const loose = s.tasks.filter((t) => t.goal_id === null);
  if (loose.length) {
    lines.push('No goal');
    for (const t of loose) lines.push(`  ${taskLine(t, '')}`);
  }
  if (!lines.length) lines.push('No goals or tasks yet.');
  if (s.questions.length) {
    lines.push('', 'Waiting on the owner:');
    for (const q of s.questions) lines.push(`  Q${q.id} from ${q.asker}: ${clip(q.text, 160)}`);
  }
  return lines.join('\n');
}
