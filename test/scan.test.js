import assert from 'node:assert/strict';
import test from 'node:test';
import { agentOf, findCopies, markLatest, matchesServer } from '../src/scan.js';

const MB = 1024 * 1024;
const proc = (pid, ppid, name, command, start = 1000 + pid, extra = {}) => ({ pid, ppid, name, command, start, cpuMs: 0, ioBytes: 0, memoryBytes: 10 * MB, ...extra });
const server = (name, command, args = [], agent = 'Codex') => ({ agent, name, command, args, source: 'test' });

test('a server matches by its program and then its arguments in order', () => {
  const playwright = server('playwright', 'C:\\Users\\me\\.codex\\mcp\\bin\\playwright-mcp.cmd');
  assert.ok(matchesServer('cmd.exe /e:ON /v:OFF /d /c ""C:\\Users\\me\\.codex\\mcp\\bin\\playwright-mcp.cmd""', playwright));
  const npx = server('playwright', 'npx', ['-y', '@playwright/mcp@latest']);
  assert.ok(matchesServer('C:\\WINDOWS\\system32\\cmd.exe /d /s /c "npx -y @playwright/mcp@latest"', npx));
  assert.ok(matchesServer('/usr/bin/node /usr/lib/node_modules/npm/bin/npx-cli.js -y @playwright/mcp@latest', npx));
  assert.ok(!matchesServer('npx -y @playwright/test', npx));
  assert.ok(matchesServer('node /home/me/github/index.js --stdio', server('github', 'node', ['/home/me/github/index.js'])));
  assert.ok(!matchesServer('npx b a', server('x', 'npx', ['a', 'b'])), 'arguments out of order');
  assert.ok(!matchesServer('node mcp-janitor.js', server('x', 'mcp')), 'a name inside another word');
});

test('a bare interpreter is not enough to recognize a server', () => {
  assert.ok(!matchesServer('node C:\\work\\build.js', server('repl', 'node')));
  assert.ok(!matchesServer('python -u worker.py', server('x', 'python', ['-u'])));
});

test('placeholders that were not expanded match anything', () => {
  const github = server('github', 'npx', ['-y', '@modelcontextprotocol/server-github', '--token', '${user_config.token}']);
  assert.ok(matchesServer('npx -y @modelcontextprotocol/server-github --token abc123', github));
  assert.ok(matchesServer('/opt/x/bin/server --port 1', server('x', '${PLUGIN}/bin/server', ['--port'])));
});

test('Claude Desktop extensions match by the script they run', () => {
  const script = 'C:\\Users\\me\\AppData\\Roaming\\Claude\\Claude Extensions\\ant.dir.files\\server\\index.js';
  const command = `"C:\\Program Files\\WindowsApps\\Claude_2.1.0.0_x64__abc\\app\\claude.exe" "${script}"`;
  assert.ok(matchesServer(command, server('files', 'node', [script], 'Claude Desktop')));
});

test('agents are recognized by their process', () => {
  const store = 'C:\\Program Files\\WindowsApps\\Claude_2.19675.0.0_x64__pzs8sxrjxfjjc\\app\\claude.exe';
  assert.equal(agentOf(proc(1, 0, 'claude.exe', `"${store}" `)), 'Claude Desktop');
  assert.equal(agentOf(proc(2, 0, 'claude.exe', `"${store}" --type=renderer`)), null);
  assert.equal(agentOf(proc(3, 0, 'claude.exe', `"${store}" "C:\\x\\Claude Extensions\\e\\server\\index.js"`)), null);
  assert.equal(agentOf(proc(4, 0, 'claude.exe', 'C:\\Users\\me\\AppData\\Local\\AnthropicClaude\\app-1.0.0\\claude.exe')), 'Claude Desktop');
  assert.equal(agentOf(proc(5, 0, 'claude.exe', 'C:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code\\2.1.286\\x\\claude.exe --output-format stream-json')), 'Claude Code');
  assert.equal(agentOf(proc(6, 0, 'Claude', '/Applications/Claude.app/Contents/MacOS/Claude')), 'Claude Desktop');
  assert.equal(agentOf(proc(7, 0, 'node', 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js')), 'Claude Code');
  assert.equal(agentOf(proc(8, 0, 'codex.exe', 'codex.exe app-server')), 'Codex');
  assert.equal(agentOf(proc(9, 0, 'codex-x86_64-un', '/x/codex-x86_64-unknown-linux-musl')), 'Codex');
  assert.equal(agentOf(proc(10, 0, 'Code Helper (Plugin)', '/Applications/Visual Studio Code.app/x --type=utility')), 'VS Code');
  assert.equal(agentOf(proc(11, 0, 'node', 'node my-agent.js'), /my-agent/), 'Other');
  assert.equal(agentOf(proc(12, 0, 'node', 'node server.js')), null);
});

// A Codex app (as in the ChatGPT desktop app) with two conversations, a
// command it runs for the user, and a server left over from an exited agent.
function codexMachine() {
  return [
    proc(10, 4, 'explorer.exe', 'C:\\WINDOWS\\Explorer.EXE', 100),
    proc(20, 10, 'ChatGPT.exe', '"C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe"', 200),
    proc(30, 20, 'codex.exe', 'C:\\x\\codex.exe app-server', 300),
    // First conversation.
    proc(40, 30, 'cmd.exe', 'cmd.exe /d /c ""C:\\mcp\\playwright-mcp.cmd""', 1000),
    proc(41, 40, 'node.exe', 'node.exe C:\\mcp\\playwright\\cli.js', 1100, { cpuMs: 500, ioBytes: 70 }),
    proc(42, 41, 'chrome.exe', 'chrome.exe --headless', 1200, { cpuMs: 9000, ioBytes: 99999, memoryBytes: 300 * MB }),
    proc(50, 30, 'node_repl.exe', 'C:\\rt\\node_repl.exe', 1010),
    // Second conversation, a minute later, with a server no configuration names.
    proc(60, 30, 'cmd.exe', 'cmd.exe /d /c ""C:\\mcp\\playwright-mcp.cmd""', 61000),
    proc(61, 30, 'node_repl.exe', 'C:\\rt\\node_repl.exe', 61010),
    proc(62, 30, 'node.exe', 'node.exe C:\\rt\\node_modules\\@oai\\cua-repl\\bin\\cua-repl.mjs', 61020),
    proc(63, 30, 'conhost.exe', 'conhost.exe 0x4', 61030),
    // A command the agent runs for the user, which happens to look like a server.
    proc(70, 30, 'powershell.exe', 'powershell.exe -Command node server.js', 90000),
    proc(71, 70, 'node.exe', 'node server.js', 90100),
    // Left behind: its parent (PID 999) is gone.
    proc(80, 999, 'cmd.exe', 'cmd.exe /d /c ""C:\\mcp\\playwright-mcp.cmd""', 500),
    // Started by hand from a terminal.
    proc(90, 10, 'pwsh.exe', 'pwsh.exe', 400),
    proc(91, 90, 'node.exe', 'node server.js', 410),
  ];
}
const codexServers = [
  server('playwright', 'C:\\mcp\\playwright-mcp.cmd'),
  server('node_repl', 'C:\\rt\\node_repl.exe'),
  server('local', 'node', ['server.js']),
];

test('copies belong to the agent that started them directly', () => {
  const copies = findCopies(codexMachine(), codexServers, { platform: 'win32', self: -1 });
  const byPid = Object.fromEntries(copies.map(copy => [copy.root.pid, copy]));
  assert.deepEqual(Object.keys(byPid).map(Number).sort((a, b) => a - b), [40, 50, 60, 61, 62, 80]);
  assert.equal(byPid[40].agent, 'Codex');
  assert.equal(byPid[40].host, 'ChatGPT app');
  assert.equal(byPid[40].agentPid, 30);
  assert.deepEqual(byPid[40].processes.map(p => p.pid), [40, 41, 42]);
  assert.equal(byPid[40].memoryBytes, 320 * MB);
  // The browser the server drives does not count as the server being busy.
  assert.equal(byPid[40].cpuMs, 500);
  assert.equal(byPid[40].ioBytes, 70);
});

test('without conversations, the servers started last are the latest; orphans never are', () => {
  const copies = markLatest(findCopies(codexMachine(), codexServers, { platform: 'win32', self: -1 }));
  const latest = Object.fromEntries(copies.map(copy => [copy.root.pid, copy.latest]));
  assert.deepEqual(latest, { 40: false, 50: false, 60: true, 61: true, 62: true, 80: false });
  assert.equal(copies.find(copy => copy.root.pid === 80).orphan, true);
  assert.equal(copies.find(copy => copy.root.pid === 80).agent, 'Codex');
});

test('the latest conversation is the one most recently active in each app', () => {
  const copy = (pid, agent, host, agentPid, start, conversation) => ({ root: { pid }, agent, host, agentPid, start, orphan: false, conversation });
  const now = 1000000;
  const copies = markLatest([
    // Codex in the ChatGPT app: the older conversation was used more recently.
    copy(1, 'Codex', 'ChatGPT app', 30, 100, { id: 'a', lastActivity: 900000 }),
    copy(2, 'Codex', 'ChatGPT app', 30, 500, { id: 'b', lastActivity: 600 }),
    // Claude Code sessions in the Claude app, one process each; one is working.
    copy(3, 'Claude Code', 'Claude app', 40, 100, { id: 'c', lastActivity: 200, busy: true }),
    copy(4, 'Claude Code', 'Claude app', 41, 900, { id: 'd', lastActivity: 950000 }),
    // A Claude Code session in a terminal is another app.
    copy(5, 'Claude Code', null, 42, 100, { id: 'e', lastActivity: 300 }),
    // Claude Desktop shares its servers with all conversations.
    copy(6, 'Claude Desktop', null, 50, 100, null),
    copy(7, 'Claude Desktop', null, 50, 90000, null),
  ], now);
  assert.deepEqual(copies.map(c => c.latest), [true, false, true, false, true, true, true]);
});

test('a process Codex started with a conversation\'s servers is one of them', () => {
  const copies = findCopies(codexMachine(), codexServers, { platform: 'win32', self: -1 });
  const cua = copies.find(copy => copy.root.pid === 62);
  assert.equal(cua.name, 'cua-repl');
  assert.ok(!copies.some(copy => copy.root.pid === 63), 'not the console host');
});

test('on Linux and macOS an orphan belongs to init or a subreaper', () => {
  const processes = [
    proc(1, 0, 'systemd', '/sbin/init', 1),
    proc(500, 1, 'systemd', '/usr/lib/systemd/systemd --user', 50),
    proc(600, 500, 'node', 'node /srv/github/index.js', 100),
    proc(700, 1, 'node', 'node /srv/github/index.js', 110),
    proc(800, 500, 'bash', 'bash', 120),
    proc(801, 800, 'node', 'node /srv/github/index.js', 130),
  ];
  const copies = findCopies(processes, [server('github', 'node', ['/srv/github/index.js'], 'Claude Code')], { platform: 'linux', self: -1 });
  assert.deepEqual(copies.map(copy => [copy.root.pid, copy.orphan, copy.agent]), [[600, true, 'Claude Code'], [700, true, 'Claude Code']]);
});

test('Claude Code sessions inside the Claude app, and the app\'s own servers', () => {
  const store = 'C:\\Program Files\\WindowsApps\\Claude_2.1.0.0_x64__abc\\app\\claude.exe';
  const processes = [
    proc(10, 4, 'explorer.exe', 'explorer.exe', 1),
    proc(20, 10, 'claude.exe', `"${store}" `, 2),
    proc(21, 20, 'claude.exe', `"${store}" --type=utility`, 3),
    proc(30, 20, 'claude.exe', 'C:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code\\2.1.286\\x\\claude.exe --output-format stream-json', 100),
    proc(31, 30, 'cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "npx -y @playwright/mcp@latest"', 110),
    proc(40, 20, 'node.exe', 'node C:\\tools\\files\\index.js', 50),
  ];
  const servers = [server('playwright', 'npx', ['-y', '@playwright/mcp@latest'], 'Claude Code'), server('files', 'node', ['C:\\tools\\files\\index.js'], 'Claude Desktop')];
  const copies = findCopies(processes, servers, { platform: 'win32', self: -1 });
  assert.deepEqual(copies.map(copy => [copy.root.pid, copy.agent, copy.host]), [[31, 'Claude Code', 'Claude app'], [40, 'Claude Desktop', null]]);
});
