// The demo in the README, run for real: a Codex app server (what the ChatGPT
// desktop app runs) opens three conversations, two minutes apart, and keeps
// every conversation's MCP servers. No model is called. Codex runs with a
// home of its own, so the demo threads stay out of your history, and with
// the MCP servers of your own config.toml.
//
//   node experiments/demo-codex.mjs [minutes-between=2]
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, render } from '../src/cli.js';
import { codexServers } from '../src/configs.js';
import { snapshot } from '../src/processes.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = text => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${text}`);
const minutes = Number(process.argv[2] ?? 2);
const cli = fileURLToPath(new URL('../bin/mcp-janitor.js', import.meta.url));

// A Codex home with only the MCP servers of the real one.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-janitor-demo-'));
const home = path.join(work, 'codex-home');
fs.mkdirSync(home);
const real = codexServers(fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8'));
const toml = Object.entries(real).filter(([, s]) => s.command).map(([name, s]) =>
  `[mcp_servers.${JSON.stringify(name)}]\ncommand = ${JSON.stringify(s.command)}\nargs = ${JSON.stringify(s.args ?? [])}\n`).join('\n');
fs.writeFileSync(path.join(home, 'config.toml'), toml);
const env = { ...process.env, CODEX_HOME: home };

const codexJs = path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const server = spawn(process.execPath, [codexJs, 'app-server'], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
server.stderr.pipe(fs.createWriteStream(path.join(work, 'app-server.log')));
let nextId = 1;
const pending = new Map();
let buffered = '';
server.stdout.setEncoding('utf8');
server.stdout.on('data', chunk => {
  buffered += chunk;
  for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
    const message = JSON.parse(buffered.slice(0, end));
    buffered = buffered.slice(end + 1);
    if (message.id !== undefined && pending.has(message.id) && !message.method) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
    } else if (message.id !== undefined && message.method) {
      server.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'not handled' } })}\n`);
    }
  }
});
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  server.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
});

const titles = ['Fix the flaky login test', 'Refactor the billing API', 'Draft the 0.4 release notes'];
try {
  await request('initialize', { clientInfo: { name: 'mcp-janitor-demo', title: null, version: '0.0.0' }, capabilities: { experimentalApi: true } });
  server.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  for (const [i, title] of titles.entries()) {
    if (i) await delay(minutes * 60000);
    const { thread } = await request('thread/start', { cwd: work, approvalPolicy: 'never', sandbox: 'read-only' });
    await request('thread/name/set', { threadId: thread.id, name: title });
    log(`opened "${title}" (${thread.id})`);
  }
  await delay(minutes * 60000);

  const codex = snapshot().find(p => p.ppid === server.pid && /^codex/i.test(p.name));
  const copies = (await check({ env })).filter(copy => copy.agentPid === codex.pid);
  const listing = [
    '$ mcp-janitor',
    ...render(copies).lines,
    `Total: ${copies.length} servers, ${(copies.reduce((sum, c) => sum + c.memoryBytes, 0) / 1024 ** 3).toFixed(1)} GB.`,
  ];
  console.log(listing.join('\n'));
  fs.writeFileSync(path.join(work, 'list.txt'), listing.join('\n'));

  // Stop by idle time, but only if that would touch nothing outside this demo.
  const idle = `${minutes + 1}m`;
  const everything = await check({ env });
  const due = everything.filter(copy => !copy.latest && copy.idleMs !== null && copy.idleMs >= (minutes + 1) * 60000 && copy.agent === 'Codex');
  if (due.some(copy => copy.agentPid !== codex.pid)) {
    log(`not running "stop --idle ${idle}": it would also stop servers outside the demo`);
  } else {
    const output = execFileSync(process.execPath, [cli, 'stop', '--idle', idle, '--agent', 'codex', '--yes'], { env, encoding: 'utf8' });
    console.log(`$ mcp-janitor stop --idle ${idle} --agent codex --yes\n${output}`);
    fs.writeFileSync(path.join(work, 'stop.txt'), `$ mcp-janitor stop --idle ${idle} --agent codex --yes\n${output}`);
    const after = (await check({ env })).filter(copy => copy.agentPid === codex.pid);
    console.log(render(after).lines.join('\n'));
    fs.writeFileSync(path.join(work, 'after.txt'), render(after).lines.join('\n'));
  }
} finally {
  server.stdin.end();
  await delay(3000);
  if (server.exitCode === null) execFileSync('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  log(`files in ${work}`);
}
