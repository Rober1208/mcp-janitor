// A stand-in for an agent: starts MCP servers the way agents do, with
// pipes for stdin and stdout, prints their PIDs and stays until killed.
//   node fake-agent.js <server-count> <marker> [detach|exit]
// With "detach" its servers outlive it when it is killed; with "exit" it
// also leaves right away. (On Windows, Node.js ends the children it did not
// detach when it exits.)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('./fake-server.js', import.meta.url));
const count = Number(process.argv[2] ?? 1);
const marker = process.argv[3];
const mode = process.argv[4];
const children = [];
for (let i = 0; i < count; i++) {
  children.push(spawn(process.execPath, [server, marker], { stdio: ['pipe', 'pipe', 'ignore'], detached: Boolean(mode) }));
  await new Promise(resolve => setTimeout(resolve, 1200));
}
process.stdout.write(`${JSON.stringify(children.map(child => child.pid))}\n`);
if (mode === 'exit') {
  for (const child of children) child.unref();
  process.exit(0);
}
setInterval(() => {}, 1 << 30);
