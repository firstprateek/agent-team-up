// A tiny stand-in for a headless agent. Usage: node fake-agent.ts <hub> <key> <mode> <prompt>
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const [hub, key, mode, argPrompt = ''] = process.argv.slice(2);
let prompt = argPrompt;
if (mode === 'stdin') {
  prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
}
const id = Number(/task #(\d+)/.exec(prompt)?.[1]);
console.log(`cwd=${process.cwd()}`);
console.log(`argv=${[hub, mode, argPrompt].join(' ')}`); // not the key
console.log(`prompt=${prompt}`);

if (mode === 'finish' || mode === 'stdin') {
  const c = new Client({ name: 'fake-agent', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(hub), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  await c.callTool({ name: 'update', arguments: { task: id, state: 'review', note: 'done', links: 'branch' } });
  await c.close();
} else if (mode === 'fail') {
  process.exit(3);
} else if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'stubborn') {
  process.on('SIGTERM', () => console.log('ignoring SIGTERM'));
  setInterval(() => {}, 1000);
}
