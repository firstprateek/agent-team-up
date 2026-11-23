// The MCP surface: one server instance per request, bound to the agent whose key made it.

import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { type Store, TASK_STATES, type Task, TeamError } from './store.ts';
import { boardState, boardText, eventLine, taskText, teamText } from './view.ts';
import { SLUG, type Wiki } from './wiki.ts';

export const VERSION = '0.7.0';
export const BOARD_URI = 'ui://agent-team-up/board.html';
const WAIT_DEFAULT = 45;
const WAIT_MAX = 55;
export const BRIEF_MAX = 3000;
export const NOTE_MAX = 1500;

const INSTRUCTIONS = `agent-team-up connects you to coding agents in other apps, plus the owner (the human).
1. team first: teammates, goals, tasks.
2. claim a task (no id takes the best one), do it, keep it current with update: a short note and links (branch, PR, files). State done when finished.
3. Split work with post_task: a brief someone could start from cold (what, where, done-when). Point at files, branches and PRs; never paste them. Use for to aim it.
4. To pass work on or ask for a review, update with handoff.
5. Need the owner: send to "owner", carry on; the answer comes through wait.
6. Idle: long-poll wait from a background process, not a loop of model turns, so waiting costs no tokens. wait with seconds:0 is a quick check.
7. Checkpoint: after each meaningful step, push WIP and update your task's note (done / next) so a teammate can take over if you stop. Out of usage: set_status resting. A paused task (see team) can be taken over with claim <id>.
8. Owner says stop → pause_team, checkpoint, end turn. Resume only on the owner's word (resume_team).`;

export interface WikiConfig {
  wiki: Wiki;
  /** Agents allowed to save. Everyone when left out. */
  writers?: string[];
  /** A page to read before the first save. */
  guide?: string;
}

function wikiLine(w: WikiConfig): string {
  return `Wiki: wiki_search before work that may have history. wiki_save only what will matter later and can't be found in code, git or docs, with the reason; update a page rather than add a near-duplicate; never save personal details (names, emails, usernames, employer, location) or secrets; use ~/ in paths.${w.guide ? ` Read the page ${w.guide} before your first save.` : ''}`;
}

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

export function createTeamServer(store: Store, me: string, boardHtml: () => string, wikiCfg?: WikiConfig): McpServer {
  const server = new McpServer({ name: 'agent-team-up', version: VERSION }, { instructions: wikiCfg ? `${INSTRUCTIONS}\n${wikiLine(wikiCfg)}` : INSTRUCTIONS });

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
        brief: z.string().min(1).max(BRIEF_MAX).describe(`What a teammate needs to start, at most ${BRIEF_MAX} characters. Point at files, branches and PRs instead of pasting them.`),
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
      description: 'Take a task and get its brief. With no id, takes the best open one for you: those aimed at you first, then the oldest open to anyone. With an id, also takes over a paused task (see team); its note is the handover.',
      inputSchema: {
        task: z.number().int().optional().describe('Task number (#7 is 7).'),
        mine_only: z.boolean().optional().describe('With no task number, take only tasks aimed at you.'),
        structured: z.boolean().optional().describe('Machine clients only: also return the task as structuredContent.'),
      },
    },
    guard((a: { task?: number; mine_only?: boolean; structured?: boolean }) => {
      const t = store.claim(me, a.task, { mineOnly: a.mine_only });
      if (!t) return text('Nothing open for you. Post a task, or call wait.');
      const r = text(`You have #${t.id}. Keep it current with update.\n\n${taskText(t, me)}`);
      return a.structured ? { ...r, structuredContent: taskData(t) } : r;
    }),
  );

  server.registerTool(
    'task',
    {
      title: 'Read a task',
      description: 'A task\'s state, holder, brief, note and links. Read-only; any task.',
      inputSchema: {
        task: z.number().int().describe('Task number (#7 is 7).'),
        structured: z.boolean().optional().describe('Machine clients only: also return the task as structuredContent.'),
      },
      annotations: { readOnlyHint: true },
    },
    guard((a: { task: number; structured?: boolean }) => {
      const t = store.task(a.task);
      if (!t) return fail(`No task #${a.task}.`);
      const r = text(taskText(t, me));
      return a.structured ? { ...r, structuredContent: taskData(t) } : r;
    }),
  );

  server.registerTool(
    'update',
    {
      title: 'Update a task',
      description:
        'Change a task you hold: its state, a short note, links. Keep the note current (done / next): it is the handover if a teammate takes the task over. Set handoff to give it to a teammate (for a review, say); that releases it to them. State open gives it back to everyone.',
      inputSchema: {
        task: z.number().int().describe('Task number.'),
        state: z.enum(TASK_STATES).optional(),
        note: z.string().max(NOTE_MAX).optional().describe(`What changed, in a sentence or two, at most ${NOTE_MAX} characters. Point at files or commits instead of pasting. Replaces the previous note.`),
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
      description: `Returns when something arrives for you (message, task, handoff, answer, goal), or after ${WAIT_DEFAULT} s with nothing. seconds 0 is a quick check. Reading moves you past those messages.`,
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
      if (!events.length) return text('Nothing new.');
      const now = store.now();
      const lines = events.map((e) => eventLine(e, me, now));
      if (more) lines.push(`…and ${more} more; wait again to read them.`);
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'pause_team',
    {
      title: 'Stop the whole team',
      description: 'The owner said stop: stops every agent. Everyone, you included, is told to checkpoint and end their turn; claim and post_task are refused until resume_team. Then checkpoint and end your turn.',
      inputSchema: { reason: z.string().min(1).max(300).describe('Why, in a few words.') },
    },
    guard((a: { reason: string }) => {
      store.pause(me, a.reason);
      return text('Team stopped. Checkpoint (push WIP, update your task note) and end your turn. Resume only on the owner\'s word.');
    }),
  );

  server.registerTool(
    'resume_team',
    {
      title: 'Resume the team',
      description: 'Lifts a stop. Call it only when the owner has said to carry on.',
    },
    guard(() => {
      store.resume(me);
      return text('Team resumed. Call team and carry on.');
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

  if (wikiCfg) registerWiki(server, store, me, wikiCfg);

  return server;
}

function registerWiki(server: McpServer, store: Store, me: string, cfg: WikiConfig): void {
  const { wiki } = cfg;
  const slugArg = z.string().describe('Page name: lower-case letters, digits and dashes.');

  server.registerTool(
    'wiki_search',
    {
      title: 'Search the wiki',
      description: 'Search the team wiki. Returns up to 5 pages (limit 1-10): slug, title, description and a snippet.',
      inputSchema: {
        query: z.string().min(1).max(300).describe('A few words.'),
        limit: z.number().int().min(1).max(10).optional().describe('How many pages, default 5.'),
      },
      annotations: { readOnlyHint: true },
    },
    guard((a: { query: string; limit?: number }) => {
      const hits = wiki.search(a.query, a.limit ?? 5);
      if (!hits.length) return text('No pages match.');
      return text(hits.map((h) => `${h.slug}: ${h.title} - ${h.description}${h.snippet ? `\n  ${h.snippet}` : ''}`).join('\n'));
    }),
  );

  server.registerTool(
    'wiki_read',
    {
      title: 'Read a wiki page',
      description: 'A page as Markdown with its version (pass it to wiki_save to change the page) and the pages it links to and from.',
      inputSchema: { slug: slugArg },
      annotations: { readOnlyHint: true },
    },
    guard((a: { slug: string }) => {
      const p = wiki.page(a.slug);
      if (!p) return fail(`No page "${a.slug}". Try wiki_search.`);
      const out = wiki.linksTo(p.slug);
      return text(`version: ${p.version}\nlinks to: ${p.links.join(', ') || '-'}\nlinked from: ${out.join(', ') || '-'}\n\n${p.raw}`);
    }),
  );

  server.registerTool(
    'wiki_save',
    {
      title: 'Save a wiki page',
      description:
        'Create or replace a page. content is the whole page, starting with frontmatter (title, description, optional tags and aliases); link with [[slug]]. To change a page, wiki_read it first and pass its version. No personal details or secrets.',
      inputSchema: {
        slug: slugArg,
        content: z.string().min(1).max(40 * 1024).describe('The whole page, frontmatter included. At most 40 KB.'),
        message: z.string().min(1).max(200).describe('What changed and why, one line.'),
        version: z.string().optional().describe('The version from wiki_read. Required when the page exists.'),
      },
    },
    guard(async (a: { slug: string; content: string; message: string; version?: string }) => {
      if (cfg.writers && !cfg.writers.includes(me)) return fail("You can't save to the wiki. You can search and read it.");
      if (!SLUG.test(a.slug)) return fail('slug must be lower-case letters, digits and dashes.');
      const r = await wiki.save({ ...a, agent: me });
      store.noteWiki(me, r.slug);
      return text(`${r.created ? 'Created' : 'Saved'} ${r.slug}. version: ${r.version}${r.note ? `\n${r.note}` : ''}`);
    }),
  );
}

