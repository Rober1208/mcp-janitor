import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The stdio MCP servers that agents on this machine are configured to start:
 * [{ agent, name, command, args, source }]. Servers reached by URL start no
 * local process and are left out. Disabled servers are kept: conversations
 * that started before a server was disabled still run it.
 */
export function configuredServers({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const servers = [];
  const add = (agent, source, entries, variables = {}) => {
    if (!entries || typeof entries !== 'object') return;
    for (const [name, entry] of Object.entries(entries)) {
      if (!entry || typeof entry.command !== 'string' || !entry.command || entry.url) continue;
      const expand = text => expandVariables(String(text), variables, env);
      servers.push({ agent, name, command: expand(entry.command), args: Array.isArray(entry.args) ? entry.args.map(expand) : [], source });
    }
  };
  const appConfig = name => platform === 'win32' ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), name)
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', name)
      : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), name);

  // Codex: config.toml, and the .mcp.json of each plugin.
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  const codexToml = path.join(codexHome, 'config.toml');
  const toml = read(codexToml);
  if (toml !== null) add('Codex', codexToml, codexServers(toml));
  for (const file of [...findFiles(path.join(codexHome, 'plugins'), '.mcp.json', 7), ...findFiles(path.join(codexHome, '.tmp'), '.mcp.json', 7)]) {
    add('Codex', file, serverMap(readJson(file)));
  }

  // Claude Code: user and project servers, project .mcp.json files, plugins.
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const claudeJson = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json');
  const claude = readJson(claudeJson);
  if (claude) {
    add('Claude Code', claudeJson, claude.mcpServers);
    for (const [project, settings] of Object.entries(claude.projects ?? {})) {
      add('Claude Code', claudeJson, settings?.mcpServers);
      const projectFile = path.join(project, '.mcp.json');
      add('Claude Code', projectFile, serverMap(readJson(projectFile)));
    }
  }
  for (const file of findFiles(path.join(claudeDir, 'plugins'), '.mcp.json', 7)) {
    add('Claude Code', file, serverMap(readJson(file)), { CLAUDE_PLUGIN_ROOT: path.dirname(file) });
  }
  for (const file of findFiles(path.join(claudeDir, 'plugins'), 'plugin.json', 8)) {
    const servers_ = readJson(file)?.mcpServers;
    if (servers_ && typeof servers_ === 'object') add('Claude Code', file, servers_, { CLAUDE_PLUGIN_ROOT: path.dirname(path.dirname(file)) });
  }

  // Claude Desktop: its config file and installed extensions.
  const desktopDirs = [appConfig('Claude')];
  if (platform === 'win32' && env.LOCALAPPDATA) {
    // The Microsoft Store version keeps its files in a package folder.
    for (const pkg of list(path.join(env.LOCALAPPDATA, 'Packages')).filter(name => /^Claude_/i.test(name))) {
      desktopDirs.push(path.join(env.LOCALAPPDATA, 'Packages', pkg, 'LocalCache', 'Roaming', 'Claude'));
    }
  }
  for (const dir of desktopDirs) {
    const file = path.join(dir, 'claude_desktop_config.json');
    add('Claude Desktop', file, readJson(file)?.mcpServers);
    for (const manifest of findFiles(path.join(dir, 'Claude Extensions'), 'manifest.json', 2)) {
      const json = readJson(manifest);
      if (json?.server?.mcp_config) {
        add('Claude Desktop', manifest, { [json.name || path.basename(path.dirname(manifest))]: json.server.mcp_config }, { __dirname: path.dirname(manifest) });
      }
    }
  }

  // Other agents that keep MCP servers in the same { name: { command, args } } form.
  add('Cursor', path.join(home, '.cursor', 'mcp.json'), serverMap(readJson(path.join(home, '.cursor', 'mcp.json'))));
  add('Gemini CLI', path.join(home, '.gemini', 'settings.json'), readJson(path.join(home, '.gemini', 'settings.json'))?.mcpServers);
  for (const product of ['Code', 'Code - Insiders']) {
    const user = path.join(appConfig(product), 'User');
    add('VS Code', path.join(user, 'mcp.json'), serverMap(readJson(path.join(user, 'mcp.json'))));
    add('VS Code', path.join(user, 'settings.json'), readJson(path.join(user, 'settings.json'))?.mcp?.servers);
  }

  // Anything else, in the same { "mcpServers": { ... } } shape.
  if (env.MCP_JANITOR_SERVERS) add('Other', env.MCP_JANITOR_SERVERS, serverMap(readJson(env.MCP_JANITOR_SERVERS)));
  return servers;
}

// ${VAR}, ${VAR:-default} and ${env:VAR}; an unknown variable stays as it is
// and matches anything.
function expandVariables(text, variables, env) {
  return text.replace(/\$\{([^}]+)\}/g, (whole, inner) => {
    const [name, fallback] = inner.split(/:-(.*)/s);
    const key = name.replace(/^env:/, '');
    if (Object.hasOwn(variables, key)) return variables[key];
    if (env[key] !== undefined) return env[key];
    return fallback ?? whole;
  });
}

function serverMap(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.mcpServers && typeof json.mcpServers === 'object') return json.mcpServers;
  if (json.servers && typeof json.servers === 'object') return json.servers;
  return Object.values(json).some(entry => typeof entry?.command === 'string') ? json : null;
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function list(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** JSON, also with a byte order mark, comments and trailing commas (VS Code settings). */
export function readJson(file) {
  const text = read(file);
  if (text === null) return null;
  const clean = text.replace(/^\uFEFF/, '');
  try { return JSON.parse(clean); } catch {}
  try { return JSON.parse(stripJsonComments(clean)); } catch { return null; }
}

function stripJsonComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function findFiles(dir, name, depth) {
  if (depth < 0) return [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap(entry => {
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '.git' ? [] : findFiles(path.join(dir, entry.name), name, depth - 1);
    return entry.name === name ? [path.join(dir, entry.name)] : [];
  });
}

/**
 * The [mcp_servers] tables of a Codex config.toml. This reads the subset of
 * TOML that MCP settings use: tables, dotted and quoted keys, strings,
 * arrays (also across lines) and inline tables.
 */
export function codexServers(text) {
  const servers = {};
  let table = [];
  for (const statement of statements(text)) {
    if (statement.startsWith('[[')) { table = null; continue; }
    if (statement.startsWith('[')) { table = keyPath(statement.slice(1, statement.lastIndexOf(']'))); continue; }
    if (!table) continue;
    const equals = indexOutsideQuotes(statement, '=');
    if (equals < 0) continue;
    const key = [...table, ...keyPath(statement.slice(0, equals))];
    if (key[0] !== 'mcp_servers' || key.length < 2) continue;
    let value;
    try { value = parseValue(statement.slice(equals + 1).trim()); } catch { continue; }
    if (key.length === 2) { if (value && typeof value === 'object' && !Array.isArray(value)) servers[key[1]] = { ...servers[key[1]], ...value }; continue; }
    if (key.length === 3) servers[key[1]] = { ...servers[key[1]], [key[2]]: value };
  }
  return servers;
}

// Split TOML text into statements: comments removed, and an array or inline
// table that spans several lines joined into one statement.
function statements(text) {
  const result = [];
  let current = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!current && !line.trim()) continue;
    current += (current ? ' ' : '') + line.trim();
    if (nesting(current) <= 0) { result.push(current); current = ''; }
  }
  if (current) result.push(current);
  return result;
}

function stripComment(line) {
  const hash = indexOutsideQuotes(line, '#');
  return hash < 0 ? line : line.slice(0, hash);
}

function scan(text, visit) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (visit(c, i) === false) return;
  }
}

function indexOutsideQuotes(text, wanted) {
  let found = -1;
  scan(text, (c, i) => { if (c === wanted) { found = i; return false; } });
  return found;
}

function nesting(text) {
  // A table header like [a.b] is complete on its own line.
  if (/^\[/.test(text)) return 0;
  let depth = 0;
  scan(text, c => { if (c === '[' || c === '{') depth++; if (c === ']' || c === '}') depth--; });
  return depth;
}

function keyPath(text) {
  const parts = [];
  let current = '';
  let quote = null;
  for (const c of text.trim()) {
    if (quote) { if (c === quote) quote = null; else current += c; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '.') { parts.push(current.trim()); current = ''; continue; }
    current += c;
  }
  parts.push(current.trim());
  return parts;
}

function parseValue(text) {
  let i = 0;
  const space = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const value = () => {
    space();
    const c = text[i];
    if (c === '"') {
      let out = '';
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\') {
          const next = text[++i];
          if (next === 'u' || next === 'U') { const n = next === 'u' ? 4 : 8; out += String.fromCodePoint(parseInt(text.slice(i + 1, i + 1 + n), 16)); i += n; }
          else out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\' }[next] ?? next;
        } else out += text[i];
      }
      i++;
      return out;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      const out = text.slice(i + 1, end);
      i = end + 1;
      return out;
    }
    if (c === '[') {
      const out = [];
      i++;
      for (;;) {
        space();
        if (i >= text.length) throw new Error('unterminated array');
        if (text[i] === ']') { i++; return out; }
        out.push(value());
        space();
        if (text[i] === ',') i++;
      }
    }
    if (c === '{') {
      const out = {};
      i++;
      for (;;) {
        space();
        if (i >= text.length) throw new Error('unterminated table');
        if (text[i] === '}') { i++; return out; }
        const equals = indexOutsideQuotes(text.slice(i), '=');
        if (equals < 0) throw new Error('expected =');
        const key = keyPath(text.slice(i, i + equals));
        i += equals + 1;
        let target = out;
        for (const part of key.slice(0, -1)) target = target[part] ??= {};
        target[key.at(-1)] = value();
        space();
        if (text[i] === ',') i++;
      }
    }
    const match = /^[^,\]}\s]+/.exec(text.slice(i));
    if (!match) throw new Error('expected a value');
    i += match[0].length;
    const word = match[0];
    return word === 'true' ? true : word === 'false' ? false : Number.isNaN(Number(word)) ? word : Number(word);
  };
  return value();
}
