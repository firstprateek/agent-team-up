#!/usr/bin/env node
// agent-team-up: init | add | rotate | remove | list | owner-key | serve | run

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHub } from './http.ts';
import { VERSION } from './mcp.ts';
import { defaultLogs, defaultWorktrees, parseDuration, runLoop } from './runner.ts';
import { Store, TeamError } from './store.ts';
import { ago } from './view.ts';

const HELP = `agent-team-up ${VERSION}: one MCP server for a team of coding agents across apps and subscriptions.

Usage:
  agent-team-up init                          Create the database and print the owner key (for the board).
  agent-team-up add <name> [--strengths ...]  Add an agent and print its key and client config.
  agent-team-up rotate <name>                 Give an agent a new key (the old one stops working).
  agent-team-up remove <name>                 Remove an agent; its tasks open up again.
  agent-team-up list                          List agents.
  agent-team-up owner-key                     Make a new owner key (signs out every board).
  agent-team-up serve [--port 7600] [--host 127.0.0.1] [--allowed-host name]...
  agent-team-up run <agent> [--hub url] [--key-file path] [--poll s] [--timeout 30m]
                    [--worktrees dir] [--logs dir] -- <command> [args...]
                                            Run a headless agent on tasks aimed at <agent>; {prompt} is replaced.

Options:
  --db <path>        Database file (default $AGENT_TEAM_UP_DB or ~/.local/share/agent-team-up/team.db).
  --url <url>        The address clients use, for the config add prints (default http://127.0.0.1:7600/mcp).
  --key-file <path>  Write the key to this file (mode 600) instead of printing it.
`;

function fail(msg: string): never {
  process.stderr.write(`agent-team-up: ${msg}\n`);
  process.exit(1);
}

function clientConfig(name: string, url: string, key: string): string {
  return `Claude Code:
  claude mcp add --transport http --scope user team ${url} --header "Authorization: Bearer ${key}"

Codex (~/.codex/config.toml):
  [mcp_servers.team]
  url = "${url}"
  http_headers = { "Authorization" = "Bearer ${key}" }
  tool_timeout_sec = 70

Antigravity (mcp_config.json, under "mcpServers"):
  "team": { "serverUrl": "${url}", "headers": { "X-Team-Key": "${key}" } }

Then tell ${name}: "Use the team tools: call team, then claim work."`;
}

function output(key: string, keyFile: string | undefined, label: string, extra: string): void {
  if (keyFile) {
    writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
    process.stdout.write(`${label} written to ${keyFile}.\n`);
    return;
  }
  process.stdout.write(`${label} (shown once; keep it private):\n  ${key}\n${extra ? `\n${extra}\n` : ''}`);
}

async function runCommand(
  [agent, ...command]: string[],
  v: { hub?: string; poll: string; timeout: string; worktrees?: string; logs?: string; 'key-file'?: string },
): Promise<void> {
  if (!agent || !command.length) fail('Usage: agent-team-up run <agent> [options] -- <command> [args...]');
  const keyFile = v['key-file'];
  const key = (keyFile ? readFileSync(keyFile, 'utf8') : (process.env.AGENT_TEAM_UP_KEY ?? '')).trim();
  if (!key) fail('No key: pass --key-file or set AGENT_TEAM_UP_KEY.');
  const poll = Number(v.poll);
  if (!(poll > 0)) fail(`--poll ${v.poll} isn't a number of seconds.`);
  let timeoutMs: number;
  try {
    timeoutMs = parseDuration(v.timeout);
  } catch (err) {
    return fail((err as Error).message);
  }
  const hub = v.hub ?? 'http://127.0.0.1:7600/mcp';
  const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  log(`runner started: agent ${agent}, hub ${hub}`);
  await runLoop({ agent, hub, key, command, pollMs: poll * 1000, timeoutMs, worktrees: v.worktrees ?? defaultWorktrees(), logs: v.logs ?? defaultLogs(), signal: ac.signal, log });
  log('runner stopped');
  process.exit(0);
}

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      port: { type: 'string', default: '7600' },
      host: { type: 'string', default: '127.0.0.1' },
      'allowed-host': { type: 'string', multiple: true, default: [] },
      strengths: { type: 'string', default: '' },
      url: { type: 'string' },
      'key-file': { type: 'string' },
      hub: { type: 'string' },
      poll: { type: 'string', default: '15' },
      timeout: { type: 'string', default: '30m' },
      worktrees: { type: 'string' },
      logs: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.version) return void process.stdout.write(`${VERSION}\n`);
  const [cmd, name] = positionals;
  if (values.help || !cmd) return void process.stdout.write(HELP);

  if (cmd === 'run') return runCommand(positionals.slice(1), values);

  const dbPath = values.db ?? process.env.AGENT_TEAM_UP_DB ?? join(homedir(), '.local', 'share', 'agent-team-up', 'team.db');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port ${values.port} isn't a port.`);
  const url = values.url ?? `http://127.0.0.1:${port}/mcp`;
  const store = new Store(dbPath);
  const needInit = () => {
    if (!store.initialized()) fail('Run "agent-team-up init" first.');
  };

  try {
    switch (cmd) {
      case 'init': {
        if (store.initialized()) fail(`${dbPath} is already set up. "owner-key" makes a new owner key.`);
        output(store.resetOwnerKey(), values['key-file'], 'Owner key (for signing in to the board)', `Database: ${dbPath}\nNext: agent-team-up add <name> --strengths "..."`);
        break;
      }
      case 'owner-key': {
        needInit();
        output(store.resetOwnerKey(), values['key-file'], 'New owner key', '');
        break;
      }
      case 'add': {
        needInit();
        if (!name) fail('Usage: agent-team-up add <name> [--strengths "..."]');
        const key = store.addAgent(name, values.strengths);
        output(key, values['key-file'], `Key for ${name}`, clientConfig(name, url, key));
        break;
      }
      case 'rotate': {
        needInit();
        if (!name) fail('Usage: agent-team-up rotate <name>');
        const key = store.rotateKey(name);
        output(key, values['key-file'], `New key for ${name}`, clientConfig(name, url, key));
        break;
      }
      case 'remove': {
        needInit();
        if (!name) fail('Usage: agent-team-up remove <name>');
        store.removeAgent(name);
        process.stdout.write(`Removed ${name}.\n`);
        break;
      }
      case 'list': {
        const now = store.now();
        const agents = store.agents();
        if (!agents.length) process.stdout.write('No agents yet.\n');
        for (const a of agents) process.stdout.write(`${a.name}\t${a.status}\tseen ${ago(a.last_seen, now)}\t${a.strengths}\n`);
        break;
      }
      case 'serve': {
        needInit();
        store.watch();
        const hub = createHub({ store, allowedHosts: values['allowed-host'] });
        hub.listen(port, values.host, () => {
          const addr = hub.address();
          const p = typeof addr === 'object' && addr ? addr.port : port;
          const h = values.host.includes(':') ? `[${values.host}]` : values.host;
          process.stdout.write(`agent-team-up ${VERSION} on http://${h}:${p}\n  MCP:   http://${h}:${p}/mcp\n  Board: http://${h}:${p}/board\n`);
        });
        const stop = () => {
          hub.close();
          hub.closeAllConnections();
          store.close();
          process.exit(0);
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        return;
      }
      default:
        fail(`Unknown command "${cmd}". Run agent-team-up --help.`);
    }
  } catch (err) {
    if (err instanceof TeamError) fail(err.message);
    throw err;
  }
  store.close();
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
