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

export const AGENT_NAMES = [...AGENTS.map(([name]) => name), 'Other'];

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
  return p.ppid === 1 || Boolean(parent && /^(systemd|launchd|init)$/.test(parent.name));
}

const normalize = text => text.replace(/\\/g, '/').replace(/["']/g, '').toLowerCase();
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PLACEHOLDERS = /\$\{[^}]*\}/g;
const EXTENSIONS = 'cmd|exe|bat|ps1|js|mjs|cjs';
// Programs that say nothing about which server they run.
const GENERIC = /^(node|nodejs|bun|bunx|deno|npx|npm|pnpm|pnpx|yarn|python|python3|py|pythonw|uv|uvx|pipx|java|dotnet|ruby|php|cmd|powershell|pwsh|bash|sh|zsh|docker)$/;

/**
 * Whether a command line starts the configured server: its program, then its
 * arguments in order, each one whole words of the command line. A
 * placeholder that was not expanded, such as ${user_config.key}, stands for
 * anything inside an argument; a program that is still a placeholder could be
 * anything, so it matches nothing.
 */
export function matchesServer(command, server) {
  if (/\$\{/.test(server.command)) return false;
  const line = normalize(command);
  const program = normalize(server.command);
  const args = server.args.map(normalize).filter(arg => arg.replace(PLACEHOLDERS, ''));
  const base = path.posix.basename(program).replace(new RegExp(`\\.(${EXTENSIONS})$`), '');
  // A bare interpreter would match every program it runs.
  if (GENERIC.test(base) && !args.some(arg => !arg.startsWith('-') && arg.replace(PLACEHOLDERS, '').length >= 2)) return false;
  const find = (source, from, left = '^|\\s') => {
    const pattern = new RegExp(`(?<=${left})(?:${source})(?=\\s|$)`, 'g');
    pattern.lastIndex = from;
    return pattern.exec(line);
  };
  // A program given by its path must be that path; one found on PATH may
  // carry an extension (npx.cmd) or be the script behind it (npx-cli.js).
  const found = program.includes('/')
    ? find(`${escape(program)}(?:\\.(?:${EXTENSIONS}))?`, 0)
    : find(`${escape(base)}(?:-cli)?(?:\\.(?:${EXTENSIONS}))?`, 0, '^|\\s|/');
  let at;
  if (found) at = found.index + found[0].length;
  // Claude Desktop runs Node.js extensions with its own executable; the full
  // path of the script is enough to know the server.
  else if (/^([a-z]:)?\/[^$]+\.(c|m)?js$/.test(args[0] ?? '')) at = 0;
  else return false;
  for (const arg of args) {
    const next = find(arg.split(/\$\{[^}]*\}/).map(escape).join('.*?'), at);
    if (!next) return false;
    at = next.index + next[0].length;
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

/** The key that tells a process apart from a later one with the same PID. */
export const processKey = p => `${p.pid}:${Math.round(p.start)}`;

/**
 * Find the running copies of configured MCP servers and the agent each
 * belongs to. A server is a copy when its agent started it directly with a
 * command from that agent's configuration. A copy whose agent has exited is
 * an orphan: `confirmed` when an earlier check saw it with its agent (from
 * `known`, the records of earlier checks), not when it only looks left
 * behind. Each copy:
 * { key, name, agent, host, agentPid, agentStart, orphan, confirmed, latest,
 *   root, processes, start, memoryBytes, cpuMs, ioBytes }
 * where cpuMs and ioBytes leave out browsers that the server drives.
 */
export function findCopies(processes, servers, { extraAgents = null, platform = process.platform, self = process.pid, known = {} } = {}) {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  // Only your own agents and servers: on a shared machine, other people's
  // are none of your business.
  const mine = p => p.mine !== false;
  const agents = new Map();
  for (const p of processes) {
    const agent = mine(p) && agentOf(p, extraAgents);
    if (agent) agents.set(p.pid, agent);
  }
  // Each agent starts the servers of its own configuration. VS Code and
  // Cursor can also start servers they find in other apps' files.
  const serversOf = agent => (agent === 'VS Code' || agent === 'Cursor' ? servers : servers.filter(s => s.agent === agent || s.agent === 'Other'));
  const copies = [];
  const add = (root, name, agentProcess, { orphan = false, confirmed = true, agent = null } = {}) => {
    const tree = subtree(processes, root);
    const watched = subtree(processes, root, p => !BROWSERS.test(p.name));
    copies.push({
      key: processKey(root), name,
      agent: agentProcess ? agents.get(agentProcess.pid) : agent,
      host: agentProcess ? hostOf(byPid, agentProcess) : null,
      agentPid: agentProcess?.pid ?? null, agentStart: agentProcess?.start ?? null, orphan, confirmed, latest: false,
      root: { pid: root.pid, start: root.start }, processes: tree.map(p => ({ pid: p.pid, start: p.start })), start: root.start,
      memoryBytes: tree.reduce((sum, p) => sum + (p.memoryBytes || 0), 0),
      cpuMs: watched.reduce((sum, p) => sum + (p.cpuMs || 0), 0),
      ioBytes: watched.some(p => p.ioBytes === null || p.ioBytes === undefined) ? null : watched.reduce((sum, p) => sum + p.ioBytes, 0),
    });
  };

  for (const p of processes) {
    if (agents.has(p.pid) || p.pid === self || !mine(p)) continue;
    const parent = parentOf(byPid, p);
    const record = known[processKey(p)];
    // A shell command whose text names a server is still a shell command,
    // unless the server itself is configured to start through that shell.
    const fits = s => matchesServer(p.command, s) && (!RUNNERS.test(p.name) || RUNNERS.test(programName(s.command)));
    if (parent && agents.has(parent.pid)) {
      // Only what an agent started itself.
      const server = serversOf(agents.get(parent.pid)).find(fits);
      if (server) add(p, server.name, parent);
      // Seen before as this agent's server, under a name since taken out of the configuration.
      else if (record?.confirmed && record.agentPid === parent.pid) add(p, record.name, parent);
    } else if (record?.confirmed) {
      // Seen with its agent before; that agent is gone now.
      add(p, record.name, null, { orphan: true, agent: record.agent });
    } else if (isOrphan(p, parent, platform)) {
      const server = servers.find(fits);
      if (server) add(p, server.name, null, { orphan: true, confirmed: false, agent: server.agent });
    }
  }

  // Codex starts all servers of a conversation at once. A process it started
  // in the same instant as known servers is one of them, even when no
  // configuration names it (a plugin that brings its own runtime).
  for (const p of processes) {
    const parent = parentOf(byPid, p);
    if (!parent || agents.get(parent.pid) !== 'Codex' || agents.has(p.pid) || !mine(p) || RUNNERS.test(p.name) || /^(cmd|conhost|openconsole|codex.*)(\.exe)?$/i.test(p.name)) continue;
    if (copies.some(copy => copy.root.pid === p.pid)) continue;
    if (copies.some(copy => copy.agentPid === parent.pid && Math.abs(copy.start - p.start) <= 500)) add(p, derivedName(p.command), parent);
  }

  return copies;
}

/**
 * Which copies compete for "latest". Codex never restarts a server it lost,
 * so each agent process (the ChatGPT app, a Codex terminal, a VS Code window)
 * keeps the conversation used last. Claude Code reconnects one from /mcp, so
 * its sessions compete per app: only the session used last in a terminal, in
 * VS Code or in the Claude app is kept.
 */
// Servers an agent starts within this long of each other were started together.
const SET_MS = 5000;

export const latestGroup = copy => (copy.agent === 'Claude Code'
  ? `${copy.agent}|${copy.host ?? ''}` : `${copy.agent}|${copy.host ?? ''}|${copy.agentPid}`);

/**
 * Mark the copies of the conversation you are most likely to come back to:
 * the most recently active one of each group (see latestGroup). Without a
 * known conversation, the servers an agent started together count as one;
 * Claude Desktop shares its servers with all its conversations. Orphans are
 * never the latest.
 *
 * An agent can start a conversation's servers again while the old copies
 * keep running (Codex does on every turn of some tasks). It talks only to
 * the newest copy of each server, so an older one is marked replaced, with
 * replacedAt the moment the agent moved on, and is not the latest.
 */
export function markLatest(copies, now = Date.now()) {
  const conversations = new Map();
  const sets = [];
  for (const copy of [...copies].sort((a, b) => a.start - b.start)) {
    copy.latest = false;
    copy.replaced = false;
    copy.replacedAt = null;
    if (copy.orphan) continue;
    let key;
    if (copy.agent === 'Claude Desktop') key = `app:${copy.agentPid}`;
    else if (copy.conversation?.id) key = `conversation:${copy.conversation.id}`;
    else {
      let set = sets.find(s => s.agentPid === copy.agentPid && copy.start - s.start <= SET_MS);
      if (!set) sets.unshift(set = { agentPid: copy.agentPid, start: copy.start, key: `set:${copy.agentPid}:${copy.start}` });
      key = set.key;
    }
    const entry = conversations.get(key) ?? { app: latestGroup(copy), recency: 0, copies: [] };
    entry.recency = Math.max(entry.recency, copy.start, copy.conversation?.lastActivity ?? 0, copy.conversation?.busy ? now : 0);
    entry.copies.push(copy);
    conversations.set(key, entry);
  }
  // Copies of one server that start together belong to one set; a later set
  // replaces it. The same conversation open in two agent processes is two
  // conversations to talk to.
  for (const entry of conversations.values()) {
    for (const copy of entry.copies) {
      const newer = entry.copies.filter(other => other.name === copy.name && other.agentPid === copy.agentPid && other.start - copy.start > SET_MS);
      if (newer.length) {
        copy.replaced = true;
        copy.replacedAt = Math.min(...newer.map(other => other.start));
      }
    }
  }
  const latest = new Map();
  for (const entry of conversations.values()) {
    if (!latest.has(entry.app) || latest.get(entry.app).recency < entry.recency) latest.set(entry.app, entry);
  }
  for (const entry of latest.values()) for (const copy of entry.copies) copy.latest = !copy.replaced;
  return copies;
}
