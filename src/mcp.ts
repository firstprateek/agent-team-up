// The MCP surface: one server instance per request, bound to the agent whose key made it.

import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { type Store, TASK_STATES, type Task, TeamError } from './store.ts';
import { boardState, boardText, eventLine, taskText, teamText } from './view.ts';

export const VERSION = '0.1.0';
export const BOARD_URI = 'ui://agent-team-up/board.html';
const WAIT_DEFAULT = 45;
const WAIT_MAX = 55;

const INSTRUCTIONS = `agent-team-up connects you to a team of coding agents from other apps and subscriptions, plus the owner (the human).
How to work:
1. Call team first. It shows your teammates and their strengths, the owner's goals and the tasks.
2. claim a task (no id takes the best one for you; task reads any task), do it, and keep it current with update: a short note and links (branch, PR, files). Set state done when finished.
3. Split big work with post_task. Write a brief someone in another app could start from cold: what, where, done-when. Point at files and PRs; don't paste them. Use for to aim a task at the teammate whose strengths fit.
4. To get a review or pass work on, update with handoff set to that teammate.
5. When you need the owner, send to "owner". It shows on their board; carry on with other work meanwhile. The answer comes back through wait.
6. When you have nothing to do, call wait. It returns as soon as something arrives for you, or after about 45 seconds with nothing; then call it again or end your turn.
7. If you hit your plan's usage limit, set_status resting with until, so work routes to others.
Durable decisions and designs belong in the project's repo, not in messages.`;

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

/** The task fields machine clients (the runner) read, so they never parse prose. */
function taskData(t: Task) {
  return { task: { id: t.id, title: t.title, brief: t.brief, posted_by: t.posted_by, goal_id: t.goal_id, for_agent: t.for_agent, claimed_by: t.claimed_by, state: t.state, note: t.note, links: t.links } };
}

function fail(s: string) {
  return { content: [{ type: 'text' as const, text: s }], isError: true };
}

type Ctx = { mcpReq: { signal: AbortSignal }; http?: { req?: Request } };

/** Runs a tool body and turns a TeamError into a readable tool error. */
function guard<A, R extends object = ReturnType<typeof text>>(fn: (args: A, signal: AbortSignal) => Promise<R | ReturnType<typeof fail>> | R | ReturnType<typeof fail>) {
  // Tools without an input schema are called with the context alone.
  return async (args: A, ctx?: Ctx) => {
    const c = ctx ?? (args as unknown as Ctx);
    // Abort on a cancel notification or when the HTTP client goes away, whichever comes first.
    const signals = [c.mcpReq.signal, c.http?.req?.signal].filter((x): x is AbortSignal => x instanceof AbortSignal);
    try {
      return await fn(args, AbortSignal.any(signals));
    } catch (err) {
      if (err instanceof TeamError) return fail(err.message);
      throw err;
    }
  };
}

/** Resolves when the store changes, `ms` passes or `signal` aborts. */
function nextChange(store: Store, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      store.events.off('change', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    store.events.on('change', done);
    signal.addEventListener('abort', done);
  });
}

export function createTeamServer(store: Store, me: string, boardHtml: () => string): McpServer {
  const server = new McpServer({ name: 'agent-team-up', version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'team',
    {
      title: 'Team overview',
      description: 'Your teammates and their strengths, the owner\'s goals, every open task, and how many messages wait for you. Call it first.',
      annotations: { readOnlyHint: true },
    },
    guard(() => text(teamText(store, me))),
  );

  server.registerTool(
    'post_task',
    {
      title: 'Post a task',
      description: 'Add a task to the board. The brief must stand on its own: what to do, where (paths, branches, PRs), and what done means.',
      inputSchema: {
        title: z.string().min(1).max(200).describe('Short imperative title.'),
        brief: z.string().min(1).max(8000).describe('Everything a teammate in another app needs to start. Point at files and PRs instead of pasting them.'),
        goal: z.number().int().optional().describe('The goal it serves, as a number (G3 is 3).'),
        for: z.string().optional().describe('A teammate to aim it at. Leave out to let anyone take it.'),
      },
    },
    guard((a: { title: string; brief: string; goal?: number; for?: string }) => {
      const t = store.postTask(me, a);
      return text(`Posted #${t.id} "${t.title}"${t.for_agent ? ` for ${t.for_agent}` : ' for anyone'}.`);
    }),
  );

  server.registerTool(
    'claim',
    {
      title: 'Claim a task',
      description: 'Take a task and get its brief. With no id, takes the best open one for you: those aimed at you first, then the oldest open to anyone.',
      inputSchema: {
        task: z.number().int().optional().describe('Task number (#7 is 7).'),
        mine_only: z.boolean().optional().describe('With no task number, take only tasks aimed at you.'),
      },
    },
    guard((a: { task?: number; mine_only?: boolean }) => {
      const t = store.claim(me, a.task, { mineOnly: a.mine_only });
      if (!t) return text('Nothing open for you. Post a task, or call wait.');
      return { ...text(`You have #${t.id}. Keep it current with update.\n\n${taskText(t, me)}`), structuredContent: taskData(t) };
    }),
  );

  server.registerTool(
    'task',
    {
      title: 'Read a task',
      description: 'A task\'s state, holder, brief, note and links. Read-only; any task.',
      inputSchema: { task: z.number().int().describe('Task number (#7 is 7).') },
      annotations: { readOnlyHint: true },
    },
    guard((a: { task: number }) => {
      const t = store.task(a.task);
      if (!t) return fail(`No task #${a.task}.`);
      return { ...text(taskText(t, me)), structuredContent: taskData(t) };
    }),
  );

  server.registerTool(
    'update',
    {
      title: 'Update a task',
      description:
        'Change a task you hold: its state, a short note, links. Set handoff to give it to a teammate (for a review, say); that releases it to them. State open gives it back to everyone.',
      inputSchema: {
        task: z.number().int().describe('Task number.'),
        state: z.enum(TASK_STATES).optional(),
        note: z.string().max(4000).optional().describe('What changed, in a sentence or two. Replaces the previous note.'),
        links: z.string().max(1000).optional().describe('Branch, PR, files. Replaces the previous links.'),
        handoff: z.string().optional().describe('Teammate to hand the task to.'),
      },
    },
    guard((a: { task: number; state?: (typeof TASK_STATES)[number]; note?: string; links?: string; handoff?: string }) => {
      const t = store.update(me, a.task, a);
      if (a.handoff) return text(`Handed #${t.id} to ${t.for_agent}.`);
      return text(`#${t.id} is ${t.state}.`);
    }),
  );

  server.registerTool(
    'send',
    {
      title: 'Send a message',
      description: 'Message a teammate, "all", or "owner". A message to the owner becomes a question on their board; the answer comes back through wait.',
      inputSchema: {
        to: z.string().min(1).describe('A teammate\'s name, "all" or "owner".'),
        text: z.string().min(1).max(4000),
        task: z.number().int().optional().describe('The task it is about, if any.'),
      },
    },
    guard((a: { to: string; text: string; task?: number }) => {
      const out = store.send(me, a.to.trim(), a.text, a.task);
      if (out.question) return text(`Asked the owner (Q${out.question.id}). Carry on with other work; the answer will come through wait.`);
      return text(`Sent to ${a.to.trim()}.`);
    }),
  );

  server.registerTool(
    'wait',
    {
      title: 'Wait for news',
      description: `Returns as soon as something arrives for you (a message, a task aimed at you, a handoff, an answer, a new goal), or after ${WAIT_DEFAULT} seconds with nothing. Reading moves you past those messages.`,
      inputSchema: {
        seconds: z.number().int().min(0).max(WAIT_MAX).optional().describe(`How long to wait, at most ${WAIT_MAX}. 0 just reads.`),
      },
    },
    guard(async (a: { seconds?: number }, signal) => {
      const deadline = Date.now() + (a.seconds ?? WAIT_DEFAULT) * 1000;
      while (store.unread(me) === 0 && !signal.aborted) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        // Look again every 2 s as well, in case a change was missed.
        await nextChange(store, Math.min(left, 2000), signal);
      }
      // Nobody is listening any more: leave the messages for the next wait.
      if (signal.aborted) return text('Cancelled.');
      const { events, more } = store.takeInbox(me);
      if (!events.length) return text('Nothing new. Call wait again, or end your turn if you are done.');
      const now = store.now();
      const lines = events.map((e) => eventLine(e, me, now));
      if (more) lines.push(`…and ${more} more. Call wait again to read them.`);
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'set_status',
    {
      title: 'Set your status',
      description: 'Say you are resting (out of usage until a time, say) or available again, so teammates and the owner route work around you.',
      inputSchema: {
        status: z.enum(['available', 'resting']),
        until: z.string().optional().describe('When you are back, as an ISO time (2026-11-18T09:00) or minutes from now (90).'),
        note: z.string().max(200).optional(),
      },
    },
    guard((a: { status: 'available' | 'resting'; until?: string; note?: string }) => {
      let untilMs: number | null = null;
      if (a.status === 'resting' && a.until) {
        untilMs = /^\d+$/.test(a.until.trim()) ? store.now() + Number(a.until.trim()) * 60_000 : Date.parse(a.until);
        if (Number.isNaN(untilMs)) return fail(`Can't read the time "${a.until}". Use an ISO time or a number of minutes.`);
      }
      const ag = store.setStatus(me, a.status, untilMs, a.note ?? '');
      return text(ag.status === 'resting' ? `You are resting${ag.resting_until ? ` until ${new Date(ag.resting_until).toISOString()}` : ''}.` : 'You are available.');
    }),
  );

  registerAppTool(
    server,
    'board',
    {
      title: 'Show the board',
      description: 'Shows the team board: goals, tasks and who is on them, and questions waiting on the owner. Renders as an app where the client supports it.',
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: BOARD_URI } },
    },
    async () => {
      const s = boardState(store, me);
      return { content: [{ type: 'text' as const, text: boardText(s) }], structuredContent: s as unknown as Record<string, unknown> };
    },
  );

  registerAppResource(server, 'Team board', BOARD_URI, { mimeType: RESOURCE_MIME_TYPE, description: 'The agent-team-up board.' }, async () => ({
    contents: [{ uri: BOARD_URI, mimeType: RESOURCE_MIME_TYPE, text: boardHtml() }],
  }));

  return server;
}
