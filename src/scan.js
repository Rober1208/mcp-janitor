import path from 'node:path';
import { parentOf, subtree } from './processes.js';

// Agents that start MCP servers, recognized by their process.
const CLAUDE_DESKTOP = /[\\/](AnthropicClaude|WindowsApps[\\/]Claude_[^\\/]*|Claude\.app)[\\/]/i;
// Claude Desktop runs Node.js extensions with its own executable.
const runsScript = p => /\.(c|m)?js["']?(\s|$)/i.test(p.command);
const AGENTS = [
  ['Codex', p => /^codex(\.exe)?$/i.test(p.name) || /^codex-(x86_64|aarch64)-/i.test(p.name)],
  ['Claude Desktop', p => /^claude(\.exe)?$/i.test(p.name) && CLAUDE_DESKTOP.test(p.command) && !/\s--type=/.test(p.command) && !runsScript(p)],
  ['Claude Code', p => (/^claude(\.exe)?$/i.test(p.name) && !CLAUDE_DESKTOP.test(p.command)) || /@anthropic-ai[\\/]claude-code[\\/]cli\.js/i.test(p.command)],
  ['Cursor', p => /^(cursor(\.exe)?|Cursor Helper \(Plugin\))$/i.test(p.name)],
  ['VS Code', p => /^(code(\.exe)?|code - insiders(\.exe)?|Code Helper \(Plugin\)|Code - Insiders Helper \(Plugin\))$/i.test(p.name)],
  ['Gemini CLI', p => /@google[\\/]gemini-cli[\\/]/i.test(p.command)],
];

/** The agent a process is, if any. `extra` recognizes other agents by their command line. */
export function agentOf(p, extra = null) {
  if (extra?.test(p.command)) return 'Other';
  return AGENTS.find(([, test]) => test(p))?.[0] ?? null;
}

// Where an agent runs, when that is not obvious from its name.
function hostOf(byPid, agentProcess) {
  if (/[\\/]\.vscode(-insiders)?[\\/]extensions[\\/]/i.test(agentProcess.command)) return 'VS Code';
  if (/[\\/]\.cursor[\\/]extensions[\\/]/i.test(agentProcess.command)) return 'Cursor';
  for (let p = parentOf(byPid, agentProcess); p; p = parentOf(byPid, p)) {
    if (/^chatgpt(\.exe)?$/i.test(p.name)) return 'ChatGPT app';
    if (p.name === 'Codex' && /Codex\.app\//.test(p.command)) return 'Codex app';
    if (agentOf(p) === 'Claude Desktop') return 'Claude app';
    if (/^(code|code - insiders)(\.exe)?$/i.test(p.name) || /^Code( - Insiders)? Helper/.test(p.name)) return 'VS Code';
    if (/^cursor(\.exe)?$/i.test(p.name) || /^Cursor Helper/.test(p.name)) return 'Cursor';
  }
  return null;
}

/**
 * Whether a process outlived the agent that started it. Windows keeps the
 * dead parent's PID; POSIX systems hand orphans to init or to a subreaper
 * such as systemd or launchd.
 */
function isOrphan(p, parent, platform) {
  if (platform === 'win32') return !parent && p.ppid > 0;
  // WSL gives each session a subreaper of its own, which shows as Relay(<pid>).
  return p.ppid === 1 || Boolean(parent && (/^(systemd|launchd|init)$/.test(parent.name) || /^Relay\(\d+\)$/.test(parent.name)));
}

const normalize = text => text.replace(/\\/g, '/').replace(/["']/g, '').toLowerCase();
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A placeholder that was not expanded, such as ${user_config.key}, matches anything.
const fragments = text => normalize(text).split(/\$\{[^}]*\}/).filter(Boolean);
const EXTENSIONS = 'cmd|exe|bat|ps1|js|mjs|cjs';
// Programs that say nothing about which server they run.
const GENERIC = /^(node|nodejs|bun|bunx|deno|npx|npm|pnpm|pnpx|yarn|python|python3|py|pythonw|uv|uvx|pipx|java|dotnet|ruby|php|cmd|powershell|pwsh|bash|sh|zsh|docker)$/;

/** Whether a command line starts the configured server: its program, then its arguments in order. */
export function matchesServer(command, server) {
  const line = normalize(command);
  const program = normalize(server.command);
  const args = server.args.flatMap(fragments);
  const base = path.posix.basename(program).replace(new RegExp(`\\.(${EXTENSIONS})$`), '');
  // A bare interpreter would match every program it runs.
  if (GENERIC.test(base) && !args.some(arg => !arg.startsWith('-'))) return false;
  let at = -1;
  if (program.includes('${')) {
    at = 0;
    for (const part of fragments(server.command)) {
      const found = line.indexOf(part, at);
      if (found < 0) return false;
      at = found + part.length;
    }
  } else if (program.includes('/') && line.includes(program)) {
    at = line.indexOf(program) + program.length;
  } else {
    // A program found on PATH, possibly run with an extension (npx.cmd), or
    // the script behind it (npx-cli.js).
    const match = new RegExp(`(^|[\\s/])${escape(base)}(-cli)?(\\.(${EXTENSIONS}))?(?=\\s|$)`).exec(line);
    if (match) at = match.index + match[0].length;
    // Claude Desktop runs Node.js extensions with its own executable; the
    // full path of the script is enough to know the server.
    else if (/^([a-z]:)?\/.+\.(c|m)?js$/.test(args[0] ?? '')) at = 0;
    else return false;
  }
  for (const arg of args) {
    const found = line.indexOf(arg, at);
    if (found < 0) return false;
    at = found + arg.length;
  }
  return true;
}

// A name for a server that no configuration names: its package or program.
function derivedName(command) {
  const line = command.replace(/\\/g, '/');
  const pkg = /node_modules\/((?:@[^/\s"]+\/)?[^/\s"]+)\//.exec(line);
  if (pkg) return pkg[1].split('/').pop();
  const program = /^"([^"]+)"|^(\S+)/.exec(line);
  return path.posix.basename(program?.[1] ?? program?.[2] ?? line).replace(new RegExp(`\\.(${EXTENSIONS})$`, 'i'), '');
}

// Programs an agent runs your commands with. cmd.exe is not one of them here:
// on Windows agents start servers that are batch files, or found on PATH
// (npx), through cmd.exe.
const RUNNERS = /^(powershell|pwsh|bash|sh|zsh|dash|fish|sandbox-exec|bwrap|codex-linux-sandbox|codex-command-runner)(\.exe)?$/i;
const programName = command => path.posix.basename(command.replace(/\\/g, '/'));
// A browser that a server drives keeps busy on its own; it says nothing about
// whether the agent still uses the server.
const BROWSERS = /^(chrome|msedge|chromium|chromium-browser|firefox|headless_shell|google chrome|google chrome for testing|microsoft edge|brave)(\.exe)?$/i;

/**
 * Find the running copies of configured MCP servers and the agent each
 * belongs to. A server is a copy when its agent started it directly; a copy
 * whose agent has exited is an orphan. Each copy:
 * { key, name, agent, host, agentPid, agentStart, orphan, latest, root,
 *   processes, start, memoryBytes, cpuMs, ioBytes }
 * where cpuMs and ioBytes leave out browsers that the server drives.
 */
export function findCopies(processes, servers, { extraAgents = null, platform = process.platform, self = process.pid } = {}) {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const agents = new Map();
  for (const p of processes) {
    const agent = agentOf(p, extraAgents);
    if (agent) agents.set(p.pid, agent);
  }
  const copies = [];
  const add = (root, name, agentProcess, orphan, configuredFor) => {
    const tree = subtree(processes, root);
    const watched = subtree(processes, root, p => !BROWSERS.test(p.name));
    copies.push({
      key: `${root.pid}:${Math.round(root.start)}`, name,
      agent: agentProcess ? agents.get(agentProcess.pid) : configuredFor,
      host: agentProcess ? hostOf(byPid, agentProcess) : null,
      agentPid: agentProcess?.pid ?? null, agentStart: agentProcess?.start ?? null, orphan, latest: false,
      root: { pid: root.pid, start: root.start }, processes: tree.map(p => ({ pid: p.pid, start: p.start })), start: root.start,
      memoryBytes: tree.reduce((sum, p) => sum + (p.memoryBytes || 0), 0),
      cpuMs: watched.reduce((sum, p) => sum + (p.cpuMs || 0), 0),
      ioBytes: watched.some(p => p.ioBytes === null || p.ioBytes === undefined) ? null : watched.reduce((sum, p) => sum + p.ioBytes, 0),
    });
  };

  for (const p of processes) {
    if (agents.has(p.pid) || p.pid === self) continue;
    const parent = parentOf(byPid, p);
    // Only what an agent started itself: the commands an agent runs for you
    // go through a shell, and are not its servers.
    const agentProcess = parent && agents.has(parent.pid) ? parent : null;
    const orphan = !agentProcess && isOrphan(p, parent, platform);
    if (!agentProcess && !orphan) continue;
    const agent = agentProcess ? agents.get(agentProcess.pid) : null;
    // A shell command whose text names a server is still a shell command,
    // unless the server itself is configured to start through that shell.
    const fits = s => matchesServer(p.command, s) && (!RUNNERS.test(p.name) || RUNNERS.test(programName(s.command)));
    const server = (agent && servers.find(s => s.agent === agent && fits(s))) || servers.find(fits);
    if (server) add(p, server.name, agentProcess, orphan, server.agent);
  }

  // Codex starts all servers of a conversation at once. A process it started
  // together with known servers is one of them, even when no configuration
  // names it (a plugin that brings its own runtime).
  for (const p of processes) {
    const parent = parentOf(byPid, p);
    if (!parent || agents.get(parent.pid) !== 'Codex' || agents.has(p.pid) || RUNNERS.test(p.name) || /^(cmd|conhost|openconsole|codex.*)(\.exe)?$/i.test(p.name)) continue;
    if (copies.some(copy => copy.root.pid === p.pid)) continue;
    if (copies.some(copy => copy.agentPid === parent.pid && Math.abs(copy.start - p.start) <= 2000)) add(p, derivedName(p.command), parent, false, 'Codex');
  }

  return copies;
}

/**
 * Mark the copies of the conversation you are most likely to come back to:
 * the one most recently active in each app (agent and host). Without a known
 * conversation, the servers an agent started together count as one; Claude
 * Desktop shares its servers with all its conversations. Orphans are never
 * the latest.
 */
export function markLatest(copies, now = Date.now()) {
  const conversations = new Map();
  const sets = [];
  for (const copy of [...copies].sort((a, b) => a.start - b.start)) {
    copy.latest = false;
    if (copy.orphan) continue;
    let key;
    if (copy.agent === 'Claude Desktop') key = `app:${copy.agentPid}`;
    else if (copy.conversation?.id) key = `conversation:${copy.conversation.id}`;
    else {
      let set = sets.find(s => s.agentPid === copy.agentPid && copy.start - s.start <= 5000);
      if (!set) sets.unshift(set = { agentPid: copy.agentPid, start: copy.start, key: `set:${copy.agentPid}:${copy.start}` });
      key = set.key;
    }
    const entry = conversations.get(key) ?? { app: `${copy.agent}|${copy.host ?? ''}`, recency: 0, copies: [] };
    entry.recency = Math.max(entry.recency, copy.start, copy.conversation?.lastActivity ?? 0, copy.conversation?.busy ? now : 0);
    entry.copies.push(copy);
    conversations.set(key, entry);
  }
  const latest = new Map();
  for (const entry of conversations.values()) {
    if (!latest.has(entry.app) || latest.get(entry.app).recency < entry.recency) latest.set(entry.app, entry);
  }
  for (const entry of latest.values()) for (const copy of entry.copies) copy.latest = true;
  return copies;
}
