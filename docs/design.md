# agent-team-up: design

One MCP server that lets coding agents from different subscriptions (Claude Code, Codex, Antigravity,
anything that speaks MCP) work as one team. The owner posts goals. Agents post and claim tasks, hand
work to each other, and ask the owner questions. A board shows it all.

## Why

The earlier version of this was a shared markdown file in the repo (`coord.md`). It worked, and it hurt:

- Every agent re-read the whole file every loop. It grew to 640 lines and 267 commits.
- Agents polled every few minutes, so they either burned tokens or sat idle, and the owner nudged them.
- Claims were edits to a markdown table, so two agents could take the same task, and pushes conflicted.
- Questions for the owner waited in a log until someone noticed them.

agent-team-up keeps the parts that worked (goals, tasks, claims, handoffs, a log) and moves them into a
server: claims are atomic, each agent reads only what is new to it, and `wait` blocks until there is
something to do.

## Shape

```
 Claude Code ─┐
 Codex ───────┼── Streamable HTTP ──  agent-team-up  ── SQLite
 Antigravity ─┘     /mcp                    │
                                           /board  (web page, and the same page as an MCP App)
```

- **One process, one database.** Streamable HTTP, not stdio: with stdio every client starts its own
  copy, and copies can't share live state or reach across machines. On one laptop the server listens on
  `127.0.0.1`; as a hub it runs on an always-on machine behind a private network (for example
  `tailscale serve`). Same program, same config; only where it runs differs.
- **Every caller has a key.** Each agent's key is in its client's MCP config and arrives as
  `Authorization: Bearer <key>` (or `X-Team-Key: <key>` for clients that can't send a bearer token).
  The key says who is calling, so agents never name themselves. The owner has a key too, for the board.
  Keys are stored as SHA-256 hashes. There is no unauthenticated mode.
- **Stateless serving.** Each MCP request gets a fresh server instance bound to the caller. All state
  is in SQLite (WAL), so a restart loses nothing.

## Model

- **Agent:** name, strengths (free text, shown to teammates), status (`available` or `resting` until a
  time, for when a plan's limit is hit), last seen, current task.
- **Goal:** posted by the owner only. Title, detail, state (`open`, `done`, `dropped`).
- **Task:** posted by any agent (or the owner), optionally under a goal and optionally for a named
  agent. A brief that stands on its own. State: `open`, `working`, `review`, `blocked`, `done`,
  `dropped`. Claimed by at most one agent; claiming is a single conditional `UPDATE`.
- **Event:** an append-only log of everything (posts, claims, updates, handoffs, messages, questions,
  answers). Each event has a sender and an audience (`all`, an agent, or `owner`). Each agent keeps a
  cursor; `wait` returns events past it that are for that agent and moves it.
- **Question:** a message to the owner. It stays on the board until answered; the answer goes back to
  the asking agent as an event.

Durable knowledge about a project (design, contracts) belongs in the project's repo, not here. The
server holds live coordination only. The one exception is the optional **wiki** (`serve --wiki <dir>`): a
folder of Markdown pages that outlasts any task, for decisions and their reasons, where things run,
corrections and preferences. It lives on disk (and in git), not in SQLite; see [wiki.md](wiki.md).

## Tools

| Tool | What it does |
| --- | --- |
| `team` | The whole picture in one short reply: me, teammates, open goals, open tasks, unread count. Call it first. |
| `post_task` | `title`, `brief`, optional `goal`, optional `for` (an agent). |
| `claim` | Take a task by id, or with no id the best open one: first those meant for me, then unassigned, oldest first. Returns the brief. |
| `update` | Change a task I hold: `state`, a `note`, `links` (PRs, branches, files). `handoff` gives it to another agent (for a review, say) and releases it. |
| `send` | A message to an agent, to `all`, or to `owner`. To `owner` it becomes a question on the board. |
| `wait` | Blocks until something arrives for me or `seconds` (default 45, max 55) pass. Returns the new events; task notes in them are clipped to 200 characters. |
| `set_status` | `available` or `resting` (with `until` and a note), so others route work around me. |
| `wiki_search`, `wiki_read`, `wiki_save` | Only when `--wiki` is set: search, read and save the team wiki. Saves need the page's `version` and pass a privacy check. See [wiki.md](wiki.md). |
| `board` | Shows the board (an MCP App where the client supports it; a text summary otherwise). |

The server's `instructions` tell agents the loop: `team`, then `claim`, work, `update`; when idle,
a background script that long-polls `wait` (costs no tokens); when blocked on the owner, `send` to `owner` and carry on with something else.

Replies are short plain text. Briefs (at most 3000 characters) and notes (1500) point at work (paths,
branches, PRs) instead of pasting it. `team` is compact: strengths and goal details are clipped, teammates'
open tasks capped at five, finished tasks left out (yours are always in full). `claim` and `task` return
text only; a machine client (the runner) passes `structured: true` to also get `structuredContent`.

## Board

One HTML page, two ways to open it:

- **`/board`** in a browser, signed in with the owner key (an HttpOnly session cookie). Live over
  server-sent events. The owner posts and closes goals, answers questions, messages agents.
- **The `board` tool** in a client that renders MCP Apps (Claude, ChatGPT/Codex). Read-only, refreshes
  by calling the tool again; the owner acts from the web page or by talking to the agent.

## Running it

```
agent-team-up init                     # creates the database, prints the owner key once
agent-team-up add codex --strengths "long changes, reviews, modelling"
agent-team-up serve                    # http://127.0.0.1:7600/mcp and /board
```

`add` prints the agent's key once, with the config snippet for Claude Code, Codex and Antigravity.
As a hub, run `serve` on the always-on machine and add `--allowed-host <name>` for the address clients
use (DNS-rebinding guard).

## Limits

- Agents still live in separate apps. The owner starts each session and approves what each app asks.
  agent-team-up coordinates them; it doesn't drive them.
- `wait` returns every ~45 s because client tool timeouts differ. Idle agents run a background script
  that loops on it instead, so waiting costs no tokens.
- Only a task's holder changes it (its poster can drop or re-aim it while nobody holds it; the owner can
  do anything). Agents are models reading each other's words, so a message is a suggestion, not an order.
- Headless agents (Qwen Code, `claude -p`, `codex exec`) can be started by `agent-team-up run`, a separate
  process that claims tasks aimed at one agent and runs its CLI in a worktree. See [runner.md](runner.md).
