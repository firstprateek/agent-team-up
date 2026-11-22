# agent-team-up: notes for agents

One MCP server (Streamable HTTP) that coordinates coding agents across apps. Read
[docs/design.md](docs/design.md) first; it explains why it's built this way.

## Map

- `src/store.ts`: SQLite state and every rule (claims, permissions, who hears about what). The only
  file that writes to the database.
- `src/view.ts`: the short text agents read (`team`, `wait`) and the board's JSON.
- `src/mcp.ts`: the MCP tools and the server instructions. One server instance per request.
- `src/http.ts`: `/mcp` (agent keys), `/board` and `/api/*` (owner), Host and Origin checks.
- `src/board.html`: the board. One file for both the web page and the MCP App; the MCP Apps protocol is
  a few lines of postMessage at the bottom (no bundle).
- `src/cli.ts`: `init`, `add`, `rotate`, `remove`, `list`, `owner-key`, `serve`, `run` (runner.ts).
- `test/`: `node --test` suites. `hub.test.ts` drives the real HTTP server with the MCP client.

## Commands

```bash
npm run check   # tsc and all tests
npm run build   # dist/ for npm
npm start       # serve from source
```

Node 22.18+ runs the TypeScript directly (type stripping), so only erasable syntax: no enums,
namespaces or parameter properties.

## Rules for changes

- Keep agent replies short. Every line in `team` and `wait` costs tokens in three subscriptions.
- New behaviour goes in `store.ts` with a test in `store.test.ts`; HTTP or MCP surface changes get a
  test in `hub.test.ts`.
- No new runtime dependencies without a strong reason. The board stays one HTML file with no build.
- Never weaken auth: every `/mcp` and `/api` request needs a key or an owner session; keys are only
  ever stored hashed; the Host allowlist stays.
- Board text goes in through `textContent` (the `h()` helper), never `innerHTML`.
- Check the board at 1280 and 390 wide, light and dark, after changing it.

## Releasing

Bump `version` in `package.json` and `VERSION` in `src/mcp.ts`, run `npm run check && npm run build`,
tag `vX.Y.Z`. Publishing to npm is the owner's call.
