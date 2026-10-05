import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codexServers, configuredServers, readJson } from '../src/configs.js';

test('Codex config.toml: tables, inline tables, dotted keys and arrays across lines', () => {
  const servers = codexServers(`
model = "gpt-5" # a comment
developer_instructions = """
Keep answers short. An unbalanced [ or { in here,
and a "quoted" # that is not a comment.
"""
notes = '''raw [ text'''
mcp_servers.dotted.command = "dotted-server"

[mcp_servers.playwright]
command = "npx"
args = [
  "-y", # the package is fetched
  "@playwright/mcp@latest",
]
enabled = false

[mcp_servers.playwright.env]
TOKEN = "secret"

[mcp_servers."quoted.name"]
command = 'C:\\tools\\server.exe'
args = ["--path", "C:\\\\data # not a comment"]

[mcp_servers]
inline = { command = "uvx", args = ["mcp-server-fetch"], env = { A = "1" } }

[mcp_servers.multi]
command = """multi-server"""
args = ['''--root''', "C:\\\\x"]

[profiles.work]
model = "other"
`);
  assert.deepEqual(servers.playwright.args, ['-y', '@playwright/mcp@latest']);
  assert.equal(servers.playwright.command, 'npx');
  assert.equal(servers.playwright.env, undefined, 'the env table stays out of the server');
  assert.equal(servers['quoted.name'].command, 'C:\\tools\\server.exe');
  assert.deepEqual(servers['quoted.name'].args, ['--path', 'C:\\data # not a comment']);
  assert.deepEqual(servers.inline, { command: 'uvx', args: ['mcp-server-fetch'], env: { A: '1' } });
  assert.equal(servers.dotted.command, 'dotted-server');
  assert.deepEqual(servers.multi, { command: 'multi-server', args: ['--root', 'C:\\x'] });
  assert.deepEqual(Object.keys(servers).sort(), ['dotted', 'inline', 'multi', 'playwright', 'quoted.name']);
});

test('JSON with a byte order mark, comments and trailing commas', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-janitor-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, `${String.fromCharCode(0xfeff)}{
  // a comment
  "a": "http://example.com/x", /* another */
  "b": [1, 2,],
}`);
  assert.deepEqual(readJson(file), { a: 'http://example.com/x', b: [1, 2] });
});

test('servers from every agent this tool knows', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-janitor-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
    fs.writeFileSync(path.join(home, file), typeof content === 'string' ? content : JSON.stringify(content));
  };
  write('.codex/config.toml', '[mcp_servers.repl]\ncommand = "node_repl"\n');
  write('.codex/plugins/cache/vendor/review/1.0/.mcp.json', { mcpServers: { review: { command: 'cmd.exe', args: ['/d', '/c', 'scripts\\review.cmd'] } } });
  write('.claude.json', {
    mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }, remote: { type: 'http', url: 'https://example.com/mcp' } },
    projects: { [path.join(home, 'project')]: { mcpServers: { local: { command: 'node', args: ['tools/server.js'] } } } },
  });
  write('project/.mcp.json', { mcpServers: { shared: { command: 'uvx', args: ['shared-server'] } } });
  write('.claude/plugins/cache/market/chat/1.0/.mcp.json', { chat: { command: 'bun', args: ['run', '--cwd', '${CLAUDE_PLUGIN_ROOT}', 'start'] } });
  write('.claude/plugins/cache/market/notes/1.0/.claude-plugin/plugin.json', { name: 'notes', mcpServers: { notes: { command: '${CLAUDE_PLUGIN_ROOT}/bin/notes', args: ['--home', '${NOTES_HOME:-~/notes}'] } } });
  write('.claude/plugins/cache/market/chat/1.0/node_modules/dep/.mcp.json', { ignored: { command: 'never' } });
  write('desktop/Claude/claude_desktop_config.json', { mcpServers: { files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] } } });
  write('desktop/Claude/Claude Extensions/ant.dir.search/manifest.json', { name: 'search', server: { mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] } } });
  write('.cursor/mcp.json', { mcpServers: { linear: { command: 'npx', args: ['linear-mcp'] } } });
  write('.gemini/settings.json', { mcpServers: { maps: { command: 'maps-mcp' } } });
  write('desktop/Code/User/mcp.json', '{\n  // VS Code allows comments\n  "servers": { "time": { "type": "stdio", "command": "uvx", "args": ["mcp-server-time"] }, },\n}');

  const env = { APPDATA: path.join(home, 'desktop') };
  const servers = configuredServers({ env, home, platform: 'win32' });
  const byName = Object.fromEntries(servers.map(s => [s.name, s]));
  assert.deepEqual(Object.keys(byName).sort(), ['chat', 'files', 'github', 'linear', 'local', 'maps', 'notes', 'repl', 'review', 'search', 'shared', 'time']);
  assert.equal(byName.repl.agent, 'Codex');
  assert.equal(byName.review.agent, 'Codex');
  assert.equal(byName.github.agent, 'Claude Code');
  assert.equal(byName.chat.args[2], path.join(home, '.claude/plugins/cache/market/chat/1.0'));
  assert.equal(byName.notes.command, `${path.join(home, '.claude/plugins/cache/market/notes/1.0')}/bin/notes`);
  assert.deepEqual(byName.notes.args, ['--home', '~/notes']);
  assert.equal(byName.files.agent, 'Claude Desktop');
  assert.equal(byName.search.args[0], `${path.join(home, 'desktop/Claude/Claude Extensions/ant.dir.search')}/server/index.js`);
  assert.equal(byName.linear.agent, 'Cursor');
  assert.equal(byName.maps.agent, 'Gemini CLI');
  assert.equal(byName.time.agent, 'VS Code');
});

test('each settings file read is reported, with the ones that cannot be parsed', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-janitor-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.mkdirSync(path.join(home, '.cursor'));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.a]\ncommand = "a-server"\n[mcp_servers.b]\ncommand = "b-server"\n');
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), '{ "mcpServers": { "c": ');
  const sources = [];
  const servers = configuredServers({ env: {}, home, platform: 'linux', sources });
  assert.deepEqual(servers.map(s => s.name), ['a', 'b']);
  assert.deepEqual(sources.map(s => [s.agent, path.basename(s.file), s.servers, Boolean(s.error)]), [
    ['Codex', 'config.toml', 2, false],
    ['Cursor', 'mcp.json', 0, true],
  ]);
});

test('CODEX_HOME, CLAUDE_CONFIG_DIR and MCP_JANITOR_SERVERS move the files', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-janitor-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'codex'));
  fs.mkdirSync(path.join(home, 'claude'));
  fs.writeFileSync(path.join(home, 'codex', 'config.toml'), '[mcp_servers.a]\ncommand = "a-server"\n');
  fs.writeFileSync(path.join(home, 'claude', '.claude.json'), JSON.stringify({ mcpServers: { b: { command: 'b-server' } } }));
  fs.writeFileSync(path.join(home, 'extra.json'), JSON.stringify({ mcpServers: { c: { command: 'c-server' } } }));
  const env = { CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'), MCP_JANITOR_SERVERS: path.join(home, 'extra.json') };
  const servers = configuredServers({ env, home: path.join(home, 'nowhere'), platform: 'linux' });
  assert.deepEqual(servers.map(s => [s.agent, s.name]), [['Codex', 'a'], ['Claude Code', 'b'], ['Other', 'c']]);
});
