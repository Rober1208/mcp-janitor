// A stand-in for an agent: starts MCP servers the way agents do, with
// pipes for stdin and stdout, prints their PIDs and stays until killed.
//   node fake-agent.js <server-count> <marker> [exit]
// With "exit" it leaves right away, and its servers become orphans. (On
// Windows, Node.js ends the children it did not detach when it exits.)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('./fake-server.js', import.meta.url));
const count = Number(process.argv[2] ?? 1);
const marker = process.argv[3];
const leave = process.argv[4] === 'exit';
const children = [];
for (let i = 0; i < count; i++) {
  children.push(spawn(process.execPath, [server, marker], { stdio: ['pipe', 'pipe', 'ignore'], detached: leave }));
  await new Promise(resolve => setTimeout(resolve, 1200));
}
process.stdout.write(`${JSON.stringify(children.map(child => child.pid))}\n`);
if (leave) {
  for (const child of children) child.unref();
  process.exit(0);
}
setInterval(() => {}, 1 << 30);
