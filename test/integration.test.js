// End to end: real processes, the real process list, the real command line.
// Everything runs in a home of its own, so only the test's servers count.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { parentOf, snapshot } from '../src/processes.js';

const cli = fileURLToPath(new URL('../bin/mcp-janitor.js', import.meta.url));
const agentScript = fileURLToPath(new URL('./fixtures/fake-agent.js', import.meta.url));
const serverScript = fileURLToPath(new URL('./fixtures/fake-server.js', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-janitor-it-'));
  // Only this test's agent and servers count, even with other tests running.
  const marker = `janitor-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const config = path.join(home, 'servers.json');
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { 'test-server': { command: process.execPath, args: [serverScript, marker] } } }));
  const env = { ...process.env };
  const set = (key, value) => {
    for (const name of Object.keys(env)) if (name.toUpperCase() === key) delete env[name];
    env[key] = value;
  };
  set('HOME', home);
  set('USERPROFILE', home);
  set('APPDATA', path.join(home, 'Roaming'));
  set('LOCALAPPDATA', path.join(home, 'Local'));
  set('XDG_CONFIG_HOME', path.join(home, '.config'));
  set('XDG_STATE_HOME', path.join(home, '.state'));
  set('CODEX_HOME', path.join(home, '.codex'));
  set('CLAUDE_CONFIG_DIR', path.join(home, '.claude'));
  set('MCP_JANITOR_SERVERS', config);
  set('MCP_JANITOR_AGENTS', `fake-agent\\.js \\d+ ${marker}`);
  set('MCP_JANITOR_STATE', path.join(home, 'state.json'));
  set('NO_COLOR', '1');
  const pids = [];
  t.after(() => {
    for (const pid of pids.reverse()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    fs.rmSync(home, { recursive: true, force: true });
  });

  const run = (...args) => new Promise(resolve => {
    execFile(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 60000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr });
    });
  });
  const list = async () => JSON.parse((await run('list', '--json', '--agent', 'other')).stdout);
  // Start a fake agent with `count` servers; resolves once they all run.
  const agent = (count, mode) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [agentScript, String(count), marker, ...(mode ? [mode] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
    pids.push(child.pid);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!output.includes('\n')) return;
      const servers = JSON.parse(output);
      pids.push(...servers);
      resolve({ pid: child.pid, servers, exited: mode === 'exit' ? new Promise(done => child.once('exit', done)) : null });
    });
    child.once('error', reject);
  });
  // A Node.js process that just started still works for a few seconds (its
  // garbage collector settles); wait until a server has been quiet for `ms`.
  const quiet = async (pid, ms) => {
    for (const end = Date.now() + 40000; Date.now() < end; await delay(1000)) {
      const copy = (await list()).find(c => c.pid === pid);
      if (copy?.idleMs >= ms) return;
    }
    throw new Error(`server ${pid} never stayed quiet for ${ms} ms`);
  };
  return { run, list, agent, quiet, env };
}

test('lists the servers an agent started, and stops the one asked for', async t => {
  const { run, list, agent } = sandbox(t);
  const { pid, servers: [older, newer] } = await agent(2);
  const copies = (await list()).filter(copy => copy.agentPid === pid);
  // Started together, without a known conversation: one set, the latest.
  assert.deepEqual(copies.map(copy => [copy.pid, copy.name, copy.agent, copy.latest, copy.orphan]).sort(), [
    [newer, 'test-server', 'Other', true, false],
    [older, 'test-server', 'Other', true, false],
  ].sort());

  const text = await run();
  assert.match(text.stdout, new RegExp(`Other \\(pid ${pid}\\): 2 servers`));
  assert.match(text.stdout, new RegExp(`test-server .* pid ${older}`));

  const stopped = await run('stop', String(older), '--yes');
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.match(stopped.stdout, /Stopped 1 server/);
  assert.equal(alive(older), false);
  assert.equal(alive(newer), true);
  assert.equal(alive(pid), true, 'the agent keeps running');

  const unknown = await run('stop', '1', '--yes');
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /No MCP server with pid 1/);
});

test('in a terminal, stop lets you pick from a numbered list', async t => {
  const { agent, env } = sandbox(t);
  const { servers: [older, newer] } = await agent(2);
  const terminal = () => Object.assign(new PassThrough(), { isTTY: true });
  const stdin = terminal();
  const stdout = terminal();
  let out = '';
  stdout.on('data', chunk => {
    out += chunk;
    if (out.endsWith('Enter for none: ')) stdin.write('1\n');
  });
  const code = await main(['stop', '--agent', 'other'], { stdin, stdout, stderr: new PassThrough(), env });
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`\\n {4}1  test-server .*pid ${older}\\n {4}2  test-server .*pid ${newer}\\n`));
  assert.match(out, /Stopped 1 server/);
  assert.equal(alive(older), false);
  assert.equal(alive(newer), true);
});

test('stopping by idle time keeps the latest conversation unless asked', async t => {
  const { run, list, agent, quiet } = sandbox(t);
  const { pid, servers: [server] } = await agent(1);
  assert.equal((await list()).find(copy => copy.agentPid === pid).idleMs, null, 'not measured at the first look');
  await quiet(server, 2000);
  const kept = await run('stop', '--idle', '2s', '--agent', 'other', '--yes');
  assert.match(kept.stdout, /latest conversation .* --include-latest/);
  assert.equal(alive(server), true);

  const dry = await run('stop', '--idle', '2s', '--agent', 'other', '--include-latest', '--dry-run');
  assert.match(dry.stdout, new RegExp(`Would stop 1 server.*\\n.*test-server \\(pid ${server}`));
  assert.equal(alive(server), true);

  const stopped = await run('stop', '--idle', '2s', '--agent', 'other', '--include-latest', '--yes');
  assert.match(stopped.stdout, /Stopped 1 server/);
  assert.equal(alive(server), false);
});

test('without a terminal, stop wants --yes', async t => {
  const { run, agent, quiet } = sandbox(t);
  const { servers: [server] } = await agent(1);
  const asked = await run('stop', '--orphans');
  assert.equal(asked.code, 0);
  const pick = await run('stop');
  assert.equal(pick.code, 2);
  assert.match(pick.stderr, /give their PIDs, --idle <time> or --orphans/);
  await quiet(server, 1000);
  const confirm = await run('stop', '--idle', '1s', '--include-latest', '--agent', 'other');
  assert.equal(confirm.code, 2);
  assert.match(confirm.stderr, /add --yes/);
  assert.equal(alive(server), true);
});

test('finds servers whose agent has exited', async t => {
  const { run, list, agent } = sandbox(t);
  const { servers: [server], exited } = await agent(1, 'exit');
  await exited;
  const parent = (() => {
    const all = snapshot();
    const byPid = new Map(all.map(p => [p.pid, p]));
    return parentOf(byPid, byPid.get(server));
  })();
  // Linux hands orphans to init or to the nearest subreaper; this tool knows
  // init, systemd, launchd and WSL's Relay.
  if (process.platform !== 'win32' && parent && parent.pid !== 1 && !/^(systemd|launchd|init|Relay\(\d+\))$/.test(parent.name)) {
    t.skip(`orphans go to ${parent.name} here`);
    return;
  }
  const copy = (await list()).find(c => c.pid === server);
  assert.ok(copy, 'the orphan is listed');
  assert.equal(copy.orphan, true);
  assert.equal(copy.agentPid, null);
  const stopped = await run('stop', '--orphans', '--yes');
  assert.match(stopped.stdout, /Stopped 1 server/);
  assert.equal(alive(server), false);
});

test('watch stops servers once they have been idle long enough', async t => {
  const { agent, env } = sandbox(t);
  const { servers: [server] } = await agent(1);
  const watch = spawn(process.execPath, [cli, 'watch', '--idle', '3s', '--every', '5s', '--include-latest', '--agent', 'other'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => watch.kill('SIGKILL'));
  let output = '';
  watch.stdout.on('data', chunk => { output += chunk; });
  watch.stderr.on('data', chunk => { output += chunk; });
  for (const end = Date.now() + 45000; Date.now() < end && !/stopped 1 server/.test(output); ) await delay(500);
  assert.match(output, /Checking MCP servers every 5s\. Servers idle for 3s or more will be stopped\./);
  assert.match(output, /stopped 1 server, \d+ MB: test-server \(Other, idle \d+s\)/);
  assert.equal(alive(server), false);
});
