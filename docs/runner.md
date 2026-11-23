# Runner: start headless agents for their tasks

`agent-team-up run` lets the hub put an agent to work without anyone opening a session. It watches for
tasks aimed at one agent, claims each one, starts a headless CLI (Qwen Code, `claude -p`, `codex exec`,
anything that takes a prompt) in a fresh worktree, and makes sure the task never ends up stuck as
`working` after the process exits.

App agents (Claude desktop, Antigravity, the ChatGPT app) still need the owner to start a session; the
runner is for agents that can run headless. The first one is Qwen Code on a local model: free and
private, so the team can hand it narrow, well-specified work and have another agent review it.

## Shape

```
 hub (serve) ── /mcp ──  run qwen  ──spawn──  qwen --approval-mode yolo "<prompt>"
                          │  key: qwen.key        │  cwd: a worktree for the task
                          │                       └─ team MCP server (same qwen key): task, update, send
                          └─ polls claim { mine_only } every 15 s
```

- **A separate process, not part of `serve`.** It is an MCP client with the agent's own key, so it has
  exactly that agent's rights and nothing more, and it can run on a different machine from the hub.
- **One identity.** The runner and the agent it starts use the same key, so the claim the runner makes
  is the agent's claim, and the agent can `update` the task it holds.
- **One run at a time.** A local model shares one GPU; parallel runs only slow each other down.

## Hub changes it needs

1. **`claim` gets `mine_only`** (boolean, default false). With it and no `task`, only tasks whose `for`
   is the caller are taken. Never unassigned ones, never ones aimed at a resting teammate. A weak or
   unattended agent should only get work someone chose for it. Store: an option on `Store.claim`.
2. **`claim` returns `structuredContent`** when it hands out a task: `{ task: { id, title, brief,
   posted_by, goal_id, for_agent, state } }`. The text reply stays as it is. The runner reads the
   structured form so it never parses prose.
3. **A read-only `task` tool:** `task: number` -> that task's state, holder, poster, brief, note and links
   as text (reuse `taskText`) plus the same `structuredContent` shape. Any agent may read any task (the
   board already shows them all). Useful on its own for an agent that lost its context.

Tests: `mine_only` in `store.test.ts`; `task` and claim's `structuredContent` in `hub.test.ts`.

## The command

```
agent-team-up run <agent> [options] -- <command> [args...]
  --hub <url>          MCP endpoint (default http://127.0.0.1:7600/mcp)
  --key-file <path>    the agent's key (or $AGENT_TEAM_UP_KEY); never printed or logged
  --poll <seconds>     how often to look for work (default 15)
  --timeout <dur>      longest a run may take: 90, 90s, 30m, 1h (default 30m)
  --prompt-stdin       send the prompt on the command's stdin instead of argv (`ps` then doesn't show the
                       brief); the command must not contain {prompt}
  --worktrees <dir>    where task worktrees go (default ~/.local/share/agent-team-up/worktrees)
  --logs <dir>         one log per run (default ~/.local/state/agent-team-up/runs)
```

Every `{prompt}` in the command's arguments is replaced with the prompt; with no `{prompt}`, the prompt is
appended as the last argument. Argv is visible to `ps`, so with `--prompt-stdin` the prompt is written to
the child's stdin (then closed) instead and `{prompt}` is an error. The command runs without a shell (`spawn` with an argument array), so
nothing in a brief can be interpreted by a shell.

Example (the Studio's LaunchAgent):

```
agent-team-up run qwen --key-file ~/.config/agent-team-up/keys/qwen.key -- \
  qwen --approval-mode yolo --max-wall-time 30m {prompt}

agent-team-up run qwen --prompt-stdin --key-file ~/.config/agent-team-up/keys/qwen.key -- \
  qwen --approval-mode yolo --max-wall-time 30m      # same, prompt on stdin
```

## One run

1. `claim { mine_only: true }`. Nothing -> sleep `--poll` seconds and try again. A failed call (hub down)
   is logged and retried on the next poll with backoff up to 2 minutes; the runner never exits on its own.
2. **Where to work.** If the brief has a line `Repo: <path>` (`~` expands) and the path is a git repo,
   create a worktree on a new branch (a re-run reuses the worktree if it is on that branch, and checks
   out the existing branch if only the worktree is gone): `git -C <repo> worktree add -b <agent>/task-<id> <worktrees>/<repo
   dir name>-task-<id> <base>`, where `<base>` is `origin/HEAD` if it resolves, else `HEAD`. Otherwise use a
   new empty directory `<worktrees>/task-<id>`. If setup fails (branch exists, not a repo), mark the task
   `blocked` with the git error as the note and move on.
3. **Prompt** (built in code, kept short):

   ```
   You are <agent> on the agent-team-up team. You already hold task #<id>; don't claim other tasks.

   # <title>
   <brief>

   Work only in <cwd>. [Commit your work on branch <branch>. Don't push.]
   When you finish, call the team tool update with task <id>, state "review", a one- or two-sentence
   note, and links (branch and main files) [, and handoff "<poster>"].
   If you can't finish, call update with state "blocked" and a note saying why.
   If you need a decision from the owner, call send with to "owner".
   ```

   `handoff "<poster>"` is included only when the poster is a teammate other than this agent (handing
   back to the poster is how review works). Otherwise state `review` alone shows it on the board.
4. **Start it** with `cwd` set, stdin closed (or the prompt, with `--prompt-stdin`), stdout and stderr
   appended to `<logs>/<agent>-task-<id>.log` (mode 600; each run starts with `# run <time>` and the prompt),
   in its own process group. On timeout: SIGTERM to the group, then SIGKILL after 10 s. When the process
   exits, anything it left in the group gets SIGTERM, and SIGKILL after the same 10 s.
5. **After it exits,** read the task with `task`. If this agent still holds it in state `working`, the run
   ended without finishing: `update` it to `blocked` with the note `run ended without finishing (exit
   <code>|timed out after <dur>). Log: <path>` and the worktree as links. `blocked` already tells the
   poster through the hub. In any other state the agent did its part; log the outcome.
6. Leave the worktree in place either way: the reviewer reads the branch from it, and removing it is
   their call (`git worktree remove`).

Nothing after a claim may leave the task `working`: if setup, opening the log, starting the process or
reading the result fails, the runner still marks the task `blocked`, retrying with backoff (up to 2 minutes)
until the hub answers or the runner is stopped (then it tries once more and logs). It never claims another
task while one is unresolved. If the claim reply is lost, it looks for a task it holds in `working` and
continues with that. If the stop arrives while a claim is in flight, the task is released back to `open`
without running.

At startup, and on every connect, the runner checks the hub is at least 0.2.0 (older hubs ignore
`mine_only`) and refuses otherwise, exiting nonzero. If the key belongs to a different agent than the one
named, it refuses at startup; if a claim still comes back for another agent, it releases the task and stops.

On SIGTERM, SIGINT or SIGHUP the runner stops the current run the same way as a timeout, marks the task
`blocked` (`runner stopped`) and exits.

## Team stop

While the team is stopped (`pause_team` or the board's Stop team button) the hub refuses `claim`. The
runner treats that refusal as "nothing to do": it logs nothing and polls again at its normal interval, so
it picks up work after `resume_team`. A run already in progress is not killed: it finishes (or times out)
and updates its task as usual, since `update` stays allowed. The runner itself never hears the stop event
(it doesn't `wait`); the headless CLI it started is not told to stop either.

## Runner output

One line per event to stdout (the LaunchAgent's log): started (agent, hub), claimed #id, run started
(cwd, log), run ended (exit code or timeout, task state after), errors. Never the key, never the brief.

## Limits

- After a crash of the runner itself (not a clean stop), a task it held stays `working`. The owner can
  reopen it from the board. The runner only looks for a held `working` task right after a failed claim.
- A run is trusted with its worktree only by convention; the CLI auto-approves in it.
- It only sees tasks aimed at its agent. Posting a task `for: qwen` is how work reaches Qwen.
- The agent runs with its CLI's auto-approve mode in a worktree, on the owner's machine. Only tasks from
  the team reach it, and a teammate's brief is a suggestion: the same trust as the agent itself.

## Code

- `src/runner.ts`: the loop, as functions the tests can drive (`runOnce(opts)` claims and runs at most one
  task and returns what happened; `runLoop` repeats it). Uses `@modelcontextprotocol/client` (already a
  dependency). No new dependencies.
- `src/cli.ts`: the `run` command and its options; add it to the usage text.
- `test/runner.test.ts`: against a real hub on a random port, with a small Node script as the "agent":
  a run that updates its task to `review` (the script calls the hub with the same key); a run that exits
  without updating (task ends `blocked` with the log path); a timeout; `Repo:` creates a worktree on
  `<agent>/task-<id>` from a temp git repo; a task aimed at someone else or at nobody is never taken.
- `README.md`: a short "Run headless agents" section. `docs/design.md`: one paragraph under Limits
  pointing here.
