// Experiment: how does Codex react when a conversation's MCP server is stopped?
//
// Starts `codex app-server` (what the ChatGPT desktop app runs), opens two
// ephemeral threads, records which MCP server processes each thread starts,
// stops thread A's node_repl servers, then asks thread A (and, as a control,
// thread B) to use node_repl. Only those two turns call the model, at low
// reasoning effort. Windows only: processes are read through Win32_Process.
//
//   node experiments/codex-mcp-kill.mjs
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);

function processes() {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n="Created";e={$_.CreationDate.ToString("o")}} | ConvertTo-Json -Compress';
  const all = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  return all.map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, command: p.CommandLine ?? '', created: p.Created }));
}

function descendants(all, rootPid) {
  const byParent = new Map();
  for (const p of all) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p]);
  const root = all.find(p => p.pid === rootPid);
  const result = [];
  const visit = parent => {
    for (const child of byParent.get(parent.pid) ?? []) {
      if (child.created < parent.created) continue; // a reused PID, not a real child
      result.push(child);
      visit(child);
    }
  };
  if (root) visit(root);
  return result;
}

const kinds = [['node_repl', /node_repl/i], ['playwright', /playwright/i], ['drawio', /drawio/i], ['obsidian', /obsidian/i], ['server.mjs', /server\.mjs/i]];

// MCP servers: the subtrees under codex.exe, one per direct child.
function mcpServers(rootPid) {
  const all = processes();
  const tree = descendants(all, rootPid);
  const codex = tree.find(p => /^codex(\.exe)?$/i.test(p.name));
  if (!codex) return [];
  return tree.filter(p => p.ppid === codex.pid && p.created >= codex.created && !/^conhost\.exe$/i.test(p.name)).map(child => {
    const subtree = [child, ...descendants(all, child.pid)];
    const text = subtree.map(p => p.command).join(' ');
    return { pid: child.pid, created: child.created, pids: subtree.map(p => p.pid), kind: kinds.find(([, pattern]) => pattern.test(text))?.[0] ?? child.name };
  });
}

const summary = servers => Object.entries(servers.reduce((counts, s) => ({ ...counts, [s.kind]: (counts[s.kind] ?? 0) + 1 }), {}))
  .map(([kind, count]) => `${kind} x${count}`).join(', ') || '(none)';

async function waitForServers(rootPid, known, timeoutMs = 30000) {
  let previous = -1;
  let stableSince = Date.now();
  for (const end = Date.now() + timeoutMs; Date.now() < end; await delay(1000)) {
    const fresh = mcpServers(rootPid).filter(s => !known.has(s.pid));
    if (fresh.length !== previous) { previous = fresh.length; stableSince = Date.now(); }
    if (fresh.length > 0 && Date.now() - stableSince >= 4000) return fresh;
  }
  return mcpServers(rootPid).filter(s => !known.has(s.pid));
}

// --- JSON-RPC over the app server's stdio, one JSON message per line ---
const codexJs = path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-janitor-exp-'));
const server = spawn(process.execPath, [codexJs, 'app-server', '-c', 'model_reasoning_effort="low"'], { cwd: work, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
server.stderr.pipe(fs.createWriteStream(path.join(work, 'app-server.stderr.log')));
let nextId = 1;
const pending = new Map();
const notifications = [];
let buffered = '';
server.stdout.setEncoding('utf8');
server.stdout.on('data', chunk => {
  buffered += chunk;
  for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
    const line = buffered.slice(0, end).trim();
    buffered = buffered.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id) && !message.method) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    } else if (message.id !== undefined && message.method) {
      log('server request (declined):', message.method);
      server.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'not handled by this experiment' } }) + '\n');
    } else {
      notifications.push(message);
    }
  }
});
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  server.stdin.write(JSON.stringify({ method, id, params }) + '\n');
});

async function turn(threadId, text) {
  const start = notifications.length;
  await request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], effort: 'low' });
  const completed = () => notifications.slice(start).find(n => n.method === 'turn/completed' && n.params?.threadId === threadId);
  for (const end = Date.now() + 180000; Date.now() < end && !completed(); ) await delay(500);
  const mine = notifications.slice(start).filter(n => n.params?.threadId === threadId || n.method === 'error');
  const items = mine.filter(n => n.method === 'item/completed').map(n => n.params.item);
  const tools = items.filter(item => item.type === 'mcpToolCall');
  const reply = items.filter(item => item.type === 'agentMessage').map(item => item.text).join(' ');
  const errors = mine.filter(n => n.method === 'error' || /error|failed/i.test(n.method)).map(n => `${n.method}: ${JSON.stringify(n.params).slice(0, 300)}`);
  const turnInfo = completed()?.params?.turn;
  return {
    status: turnInfo?.status ?? 'no turn/completed within 3 minutes', turnError: turnInfo?.error ?? null,
    tools: tools.map(t => ({ server: t.server, tool: t.tool, status: t.status, error: t.error?.message?.slice(0, 300) ?? null })),
    reply: reply.slice(0, 300), errors,
  };
}

const results = {};
try {
  await request('initialize', { clientInfo: { name: 'mcp-janitor-experiment', title: null, version: '0.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
  server.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  log(`app server ${server.pid} initialized; working in ${work}`);

  // The configured model may not be available to this account; prefer the
  // smallest available one, to keep the two model calls cheap.
  const models = (await request('model/list', {})).data.filter(m => !m.hidden);
  log(`models: ${models.map(m => m.id + (m.isDefault ? ' (default)' : '')).join(', ')}`);
  const model = (models.find(m => /luna|mini/i.test(m.id) && m.supportedReasoningEfforts.some(e => e.reasoningEffort === 'low'))
    ?? models.find(m => m.isDefault) ?? models[0]).id;
  log(`using ${model} at low reasoning effort`);
  results.model = model;

  const threadParams = { cwd: work, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, model };
  const a = (await request('thread/start', threadParams)).thread.id;
  const setA = await waitForServers(server.pid, new Set());
  log(`thread A ${a}: ${summary(setA)}`);
  const b = (await request('thread/start', threadParams)).thread.id;
  const setB = await waitForServers(server.pid, new Set(setA.map(s => s.pid)));
  log(`thread B ${b}: ${summary(setB)}`);
  results.perThread = { a: summary(setA), b: summary(setB) };

  const victims = setA.filter(s => s.kind === 'node_repl');
  for (const victim of victims) execFileSync('taskkill.exe', ['/PID', String(victim.pid), '/T', '/F'], { stdio: 'ignore' });
  await delay(2000);
  log(`stopped thread A's node_repl servers: ${victims.map(v => v.pid).join(', ') || '(none found)'}`);
  results.stopped = victims.map(v => v.pid);

  const before = new Set(mcpServers(server.pid).map(s => s.pid));
  const prompt = 'Use the node_repl MCP tool to evaluate the JavaScript expression 1+1. Reply with only the result.';
  results.turnA = await turn(a, prompt);
  const afterA = mcpServers(server.pid);
  const restarted = afterA.filter(s => !before.has(s.pid));
  const alive = new Set(afterA.map(s => s.pid));
  const oldAStillRunning = setA.filter(s => !victims.includes(s) && alive.has(s.pid));
  results.restartedDuringTurnA = summary(restarted);
  results.oldAServersStillRunning = summary(oldAStillRunning);
  results.totalServersAfterTurnA = summary(afterA);
  log('thread A turn:', JSON.stringify(results.turnA));
  log(`new MCP servers during thread A's turn: ${results.restartedDuringTurnA}`);
  log(`thread A's original servers still running: ${results.oldAServersStillRunning}`);
  log(`all MCP servers now: ${results.totalServersAfterTurnA}`);

  // Control: thread B's servers were never touched. Does its turn restart them too?
  const beforeB = new Set(mcpServers(server.pid).map(s => s.pid));
  results.turnB = await turn(b, prompt);
  const afterB = mcpServers(server.pid);
  const aliveAfterB = new Set(afterB.map(s => s.pid));
  results.newDuringTurnB = summary(afterB.filter(s => !beforeB.has(s.pid)));
  results.originalBServersStillRunning = summary(setB.filter(s => aliveAfterB.has(s.pid)));
  log('thread B turn (control):', JSON.stringify(results.turnB));
  log(`new MCP servers during thread B's turn: ${results.newDuringTurnB}`);
  log(`thread B's original servers still running: ${results.originalBServersStillRunning}`);

  const beforeUnsubscribe = mcpServers(server.pid);
  await request('thread/unsubscribe', { threadId: a }).catch(error => log('unsubscribe failed:', error.message));
  await delay(5000);
  const afterUnsubscribe = new Set(mcpServers(server.pid).map(s => s.pid));
  const ended = beforeUnsubscribe.filter(s => !afterUnsubscribe.has(s.pid));
  results.endedAfterUnsubscribeA = summary(ended);
  log(`servers that ended after unsubscribing thread A: ${results.endedAfterUnsubscribeA}`);
} catch (error) {
  log('experiment failed:', error.message);
  results.failure = error.message;
} finally {
  // Record every MCP process the app server started, end the app server,
  // and check whether they ended with it.
  const all = processes();
  const leftovers = descendants(all, server.pid).map(p => ({ pid: p.pid, created: p.created }));
  server.stdin.end();
  await delay(3000);
  if (server.exitCode === null) execFileSync('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  await delay(2000);
  const still = processes().filter(p => leftovers.some(l => l.pid === p.pid && l.created === p.created));
  results.leftAfterAppServerExit = still.length;
  for (const p of still) { try { process.kill(p.pid); } catch {} }
  log(`processes left after the app server exited: ${still.length}${still.length ? ' (stopped now)' : ''}`);
  fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
