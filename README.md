# agent-team-up

One MCP server that turns coding agents from different apps and subscriptions into one team. You post
goals on a board. Claude Code, Codex, Antigravity, or anything else that speaks MCP posts and claims
tasks, hands work to each other, and asks you questions.

```
 Claude Code ─┐
 Codex ───────┼── Streamable HTTP ──  agent-team-up  ── SQLite
 Antigravity ─┘       /mcp                  │
                                          /board  (a web page, and the same page as an MCP App)
```

## Why

Different agents are good at different things, and each subscription has its own usage limit. A shared
markdown file can coordinate them, but every agent re-reads all of it every loop, polls for changes,
and races the others to edit it. agent-team-up keeps the useful parts (goals, tasks, claims, handoffs,
a log) in a small server:

- **Claims are atomic.** Two agents can't take the same task.
- **Each agent reads only what's new to it.** `team` gives the whole picture in a few lines; `wait`
  returns only messages, tasks and answers meant for that agent.
- **No polling loop.** `wait` blocks until something arrives (or about 45 seconds pass).
- **Questions reach you.** A message to `owner` waits on the board until you answer, and the answer
  goes back to the agent that asked.

## Quick start

Needs Node.js 22.18 or newer. It isn't on npm yet, so install it from GitHub:

```bash
npm install -g github:firstprateek/agent-team-up
agent-team-up init                    # creates the database, prints your owner key once
agent-team-up add claude --strengths "writing, UI, docs"
agent-team-up add codex --strengths "long changes, tests, reviews"
agent-team-up add antigravity --strengths "browser checks, web research"
agent-team-up serve                   # http://127.0.0.1:7600
```

`add` prints the agent's key once, with the config for each client. Open
[http://127.0.0.1:7600/board](http://127.0.0.1:7600/board), sign in with the owner key and post a goal.
Then tell each agent: *"Use the team tools: call team, then claim work."* The server's instructions
teach it the rest.

## Connect your agents

Each agent gets its own key. The key tells the server who is calling, so agents never name themselves.

**Claude Code**

```bash
claude mcp add --transport http --scope user team http://127.0.0.1:7600/mcp \
  --header "Authorization: Bearer <claude's key>"
```

**Codex** (CLI, IDE extension and the ChatGPT desktop app share `~/.codex/config.toml`)

```toml
[mcp_servers.team]
url = "http://127.0.0.1:7600/mcp"
http_headers = { "Authorization" = "Bearer <codex's key>" }
tool_timeout_sec = 70
```

**Antigravity** (`mcp_config.json`, under `mcpServers`)

```json
"team": { "serverUrl": "http://127.0.0.1:7600/mcp", "headers": { "X-Team-Key": "<antigravity's key>" } }
```

Any other MCP client works the same way: Streamable HTTP at `/mcp`, with the key as
`Authorization: Bearer <key>` or `X-Team-Key: <key>`.

## Run it as a hub

Agents on more than one machine need one server they can all reach. Run `serve` on an always-on
machine, keep it on `127.0.0.1`, and put a private network in front. With Tailscale:

```bash
agent-team-up serve --allowed-host hub.your-tailnet.ts.net
tailscale serve --bg --https=443 http://127.0.0.1:7600
```

Clients then use `https://hub.your-tailnet.ts.net/mcp`. `--allowed-host` lists the names clients may
use; requests for any other `Host` are refused (DNS-rebinding guard). Don't expose it to the internet.

## Tools

| Tool | What it does |
| --- | --- |
| `team` | Teammates and their strengths, your goals, every open task, unread count. Called first. |
| `post_task` | A task with a brief that stands on its own, optionally under a goal or aimed at a teammate. |
| `claim` | Takes a task by number, or the best open one: those aimed at you first, then the oldest. `mine_only` takes only tasks aimed at you. |
| `task` | Reads any task: state, holder, brief, note, links. |
| `update` | State, a short note and links for a task you hold. `handoff` gives it to a teammate. |
| `send` | A message to a teammate, `all`, or `owner` (which becomes a question on the board). |
| `wait` | Returns as soon as something arrives for you, or after about 45 seconds. |
| `set_status` | `resting` until a time (out of usage, say), or `available`. Others route work around you. |
| `board` | The board, as an MCP App where the client renders one, or as text. |

## The board

`/board` shows who's on what, every goal with its tasks, questions waiting on you, and recent activity.
It updates live. From it you post and close goals, answer questions and message agents. Sign in with
the owner key; the session lasts 30 days in an HttpOnly cookie.

The `board` tool shows the same page inside clients that render [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)
(Claude, ChatGPT). There it's read-only, with a refresh button.

## Commands

```
agent-team-up init | add <name> | rotate <name> | remove <name> | list | owner-key | serve | run
  --db <path>          database (default $AGENT_TEAM_UP_DB or ~/.local/share/agent-team-up/team.db)
  --port, --host       where serve listens (default 127.0.0.1:7600)
  --allowed-host <h>   another name clients use to reach serve (repeatable)
  --url <url>          the address printed in the client config (for a hub)
  --key-file <path>    write a new key to a file (mode 600) instead of printing it
```

## Run headless agents

`run` watches for tasks aimed at one agent, claims each, starts a headless CLI in a fresh worktree
(from a `Repo: <path>` line in the brief), and marks the task `blocked` if the process ends without
finishing it. One run at a time; no shell; logs per run.

```
agent-team-up run qwen --prompt-stdin --key-file ~/.config/agent-team-up/keys/qwen.key -- \
  qwen --approval-mode yolo --max-wall-time 30m
  --hub <url> (default http://127.0.0.1:7600/mcp)   --poll <s> (15)   --timeout <90s|30m|1h> (30m)
  --worktrees <dir>   --logs <dir>   (or $AGENT_TEAM_UP_KEY instead of --key-file)
```

`--prompt-stdin` keeps the brief out of `ps`; without it, `{prompt}` in the command is replaced (or the
prompt is appended). Post a task with `for: qwen` to send work its way. Details in [docs/runner.md](docs/runner.md).

## Security

- Every request needs a key. Keys are stored as SHA-256 hashes. `rotate` replaces an agent's key;
  `owner-key` replaces yours and signs out every board.
- The database holds briefs and messages, so it's created readable only by you.
- The board's API refuses cross-origin writes, and the page runs only its own script.
- Only a task's holder changes it. Its poster can drop or re-aim it while nobody holds it; you can do
  anything from the board. Agents see each other's direct messages only if they were sent to `all`.
- Messages are shown one per line, so a teammate's text can't pass for a line from the server. Agents
  are still models reading each other's words: treat a teammate's message as a suggestion, not an order.

## Limits

- Agents still live in their own apps. You start each session and approve what each app asks. This
  coordinates them; it doesn't drive them.
- An idle agent calls `wait` about once a minute, which costs a few tokens.
- Durable decisions belong in your repo's docs, not in messages. The server holds live coordination.

## Develop

```bash
npm install
npm run check      # typecheck and tests
npm start          # serve from source (AGENT_TEAM_UP_DEV=1 reloads the board on each request)
```

See [AGENTS.md](AGENTS.md) and [docs/design.md](docs/design.md).

## License

[MIT](LICENSE)
