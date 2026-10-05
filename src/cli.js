import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { configuredServers } from './configs.js';
import { describeConversations } from './conversations.js';
import { snapshot, stopProcesses } from './processes.js';
import { AGENT_NAMES, findCopies, markLatest } from './scan.js';
import { loadState, stateFile, track } from './state.js';

const HELP = `mcp-janitor: see which MCP servers your AI agents keep running, and stop the idle ones.

Usage:
  mcp-janitor                    List MCP servers by agent and conversation
  mcp-janitor stop               Pick servers to stop
  mcp-janitor stop <pid>...      Stop these servers (PIDs from the list)
  mcp-janitor stop --idle 1h     Stop servers idle for an hour or more
  mcp-janitor watch --idle 1h    Keep checking, and stop servers once idle that long

Options:
  --idle <time>       How long a server must be idle, such as 30m, 2h or 1d
  --orphans           Only servers seen with an agent that has since exited
  --server <name>     Only servers with this name
  --agent <name>      Only servers of this agent, such as codex or "claude code"
  --include-latest    Also stop servers of each app's latest conversation
  --every <time>      How often watch checks (default 1m)
  --dry-run           Show what would be stopped, and stop nothing
  -y, --yes           Do not ask before stopping
  --json              List as JSON
  -h, --help          Show this help
  -v, --version       Show the version

A server is idle when its conversation has been quiet and the server itself
did no work. Codex does not restart a server that was stopped: that
conversation loses its tools until you start a new one. In Claude Code, /mcp
reconnects a stopped server.
`;

const VALUE_OPTIONS = new Set(['idle', 'server', 'agent', 'every']);
const FLAGS = new Set(['orphans', 'include-latest', 'dry-run', 'yes', 'json', 'help', 'version']);
const SHORT = { y: 'yes', h: 'help', v: 'version' };

export function parseArgs(argv) {
  const options = { command: 'list', pids: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s);
      if (VALUE_OPTIONS.has(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined || value === '') throw new UsageError(`--${name} needs a value.`);
        options[name] = value;
      } else if (FLAGS.has(name) && inline === undefined) {
        options[name] = true;
      } else {
        throw new UsageError(`Unknown option ${arg}.`);
      }
    } else if (/^-[a-z]$/i.test(arg) && SHORT[arg[1]]) {
      options[SHORT[arg[1]]] = true;
    } else if (arg.startsWith('-')) {
      throw new UsageError(`Unknown option ${arg}.`);
    } else if (/^\d+$/.test(arg) && options.command === 'stop') {
      options.pids.push(Number(arg));
    } else if (i === 0 && ['list', 'stop', 'watch'].includes(arg)) {
      options.command = arg;
    } else {
      throw new UsageError(`Unexpected argument ${arg}.`);
    }
  }
  if (options.agent !== undefined) agentNamed(options.agent);
  if (options.idle !== undefined) options.idleMs = parseDuration(options.idle, '--idle');
  options.everyMs = options.every === undefined ? 60000 : parseDuration(options.every, '--every');
  if (options.everyMs < 5000) throw new UsageError('--every must be at least 5s.');
  return options;
}

export class UsageError extends Error {}

/** 90s, 30m, 1h30m, 2d. */
export function parseDuration(text, name = 'duration') {
  const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const clean = String(text).trim().toLowerCase();
  if (!/^(\d+(\.\d+)?[smhd])+$/.test(clean)) throw new UsageError(`${name} must be a time such as 30m, 2h or 1d, not "${text}".`);
  let total = 0;
  for (const [, value, unit] of clean.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)) total += Number(value) * units[unit];
  return Math.round(total);
}

export function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return hours % 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${Math.floor(hours / 24)}d`;
}

export function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

// Columns a string takes in a terminal: East Asian wide characters and emoji take two.
export function width(text) {
  let columns = 0;
  for (const c of text) {
    const code = c.codePointAt(0);
    columns += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6) || code >= 0x1f300 ? 2 : 1;
  }
  return columns;
}

function truncate(text, columns) {
  if (width(text) <= columns) return text;
  let out = '';
  for (const c of text) {
    if (width(out + c) > columns - 1) break;
    out += c;
  }
  return `${out}…`;
}

function style(enabled) {
  const wrap = (open, close) => text => (enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text);
  return { bold: wrap(1, 22), dim: wrap(2, 22), yellow: wrap(33, 39), green: wrap(32, 39) };
}

/** Look at the machine: the servers, their agents and conversations, and how long each has been idle. */
export async function check({ env = process.env, now = Date.now() } = {}) {
  // The home folder as the environment gives it, as Node.js would read it.
  const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
  const extraAgents = env.MCP_JANITOR_AGENTS ? new RegExp(env.MCP_JANITOR_AGENTS, 'i') : null;
  const file = stateFile({ env, home });
  const before = loadState(file);
  const copies = findCopies(snapshot(), configuredServers({ env, home }), { extraAgents, known: before });
  await describeConversations(copies, { env, home });
  markLatest(copies, now);
  track(copies, { file, now, before });
  return copies;
}

// An agent as people type it: "claude code", "claude-code", "vscode", "gemini".
function agentNamed(text) {
  const simple = name => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = simple(text) === 'gemini' ? 'geminicli' : simple(text);
  const agent = AGENT_NAMES.find(name => simple(name) === wanted);
  if (!agent) throw new UsageError(`--agent must be one of: ${AGENT_NAMES.map(name => name.toLowerCase()).join(', ')}.`);
  return agent;
}

function filtered(copies, options) {
  const agent = options.agent === undefined ? null : agentNamed(options.agent);
  return copies.filter(copy => (!options.server || copy.name.toLowerCase() === options.server.toLowerCase())
    && (agent === null || copy.agent === agent)
    && (!options.orphans || (copy.orphan && copy.confirmed)));
}

// Servers that may be stopped for being idle: measured at least twice, so
// that work between the checks shows; not of an app's latest conversation
// unless asked; and orphans only when they were seen with their agent.
function idleOnes(copies, options) {
  return filtered(copies, options).filter(copy => copy.measured && copy.idleMs !== null && copy.idleMs >= options.idleMs
    && (options['include-latest'] || !copy.latest) && (!copy.orphan || copy.confirmed));
}

const agentLabel = copy => (copy.host ? `${copy.agent} in ${copy.host}` : copy.agent);

function conversationLabel(copy) {
  const conversation = copy.conversation;
  if (copy.agent === 'Claude Desktop') return 'all conversations';
  if (!conversation) return 'conversation not found';
  if (conversation.title) return `"${conversation.title}"`;
  if (copy.agent === 'Claude Code' && conversation.cwd) return `untitled session in ${path.basename(conversation.cwd)}`;
  return `${copy.agent} conversation ${String(conversation.id).slice(0, 8)}`;
}

function idleLabel(copy) {
  if (copy.conversation?.busy) return 'in use now';
  if (copy.idleMs === null) return '–';
  if (copy.idleMs < 60000) return 'active';
  return `idle ${formatDuration(copy.idleMs)}`;
}

/** Text lines that show copies grouped by agent and conversation, numbered when `numbered`. */
export function render(copies, { color = false, numbered = false } = {}) {
  const s = style(color);
  const lines = [];
  const groups = new Map();
  for (const copy of [...copies].sort((a, b) => a.start - b.start)) {
    const key = !copy.orphan ? `${copy.agent}/${copy.agentPid}` : copy.confirmed ? 'orphans' : 'suspects';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(copy);
  }
  const rank = key => ({ orphans: 1, suspects: 2 })[key] ?? 0;
  const ordered = [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  const nameWidth = Math.max(6, ...copies.map(copy => width(copy.name)));
  // "(latest)" marks the conversation kept when others of the same app are not.
  const app = copy => `${copy.agent}|${copy.host ?? ''}`;
  const olderInApp = new Set(copies.filter(copy => !copy.orphan && !copy.latest).map(app));
  let number = 0;
  const numbers = new Map();
  for (const [key, group] of ordered) {
    const memory = formatBytes(group.reduce((sum, copy) => sum + copy.memoryBytes, 0));
    const count = `${group.length} server${group.length === 1 ? '' : 's'}`;
    const orphans = rank(key) > 0;
    lines.push(s.bold(key === 'orphans' ? `Orphans, left running by an agent that exited: ${count}, ${memory}`
      : key === 'suspects' ? `Possibly left behind (never seen with their agent): ${count}, ${memory}`
        : `${agentLabel(group[0])} (pid ${group[0].agentPid}): ${count}, ${memory}`));
    const conversations = new Map();
    for (const copy of group) {
      const label = orphans ? '' : conversationLabel(copy);
      const id = orphans ? '' : `${copy.conversation?.id ?? label}`;
      if (!conversations.has(id)) conversations.set(id, { label, copies: [] });
      conversations.get(id).copies.push(copy);
    }
    for (const { label, copies: members } of conversations.values()) {
      const kept = members.every(copy => copy.latest) && olderInApp.has(app(members[0]));
      if (label) lines.push(`  ${truncate(label, 70)}${kept ? s.dim('  (latest)') : ''}`);
      for (const copy of members) {
        numbers.set(++number, copy);
        const prefix = numbered ? `${String(number).padStart(3)}  ` : '    ';
        const idle = idleLabel(copy);
        lines.push(`  ${prefix}${copy.name}${' '.repeat(nameWidth - width(copy.name))}  ${formatBytes(copy.memoryBytes).padStart(7)}  ${(idle.startsWith('idle') ? s.yellow : String)(idle.padEnd(12))}  ${s.dim(`pid ${copy.root.pid}`)}`);
      }
    }
    lines.push('');
  }
  return { lines, numbers };
}

function summary(copies) {
  const memory = formatBytes(copies.reduce((sum, copy) => sum + copy.memoryBytes, 0));
  return `${copies.length} server${copies.length === 1 ? '' : 's'}, ${memory}`;
}

async function ask(question, io) {
  const rl = readline.createInterface({ input: io.stdin, output: io.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

/** "1,3-5", "all" or "" for the numbers 1..max. */
export function parseSelection(text, max) {
  if (!text) return [];
  if (/^(all|a)$/i.test(text)) return Array.from({ length: max }, (_, i) => i + 1);
  const chosen = new Set();
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) throw new UsageError(`"${part}" is not a number or a range like 3-5.`);
    const [from, to] = [Number(match[1]), Number(match[2] ?? match[1])];
    if (from < 1 || to > max || from > to) throw new UsageError(`${part} is not between 1 and ${max}.`);
    for (let n = from; n <= to; n++) chosen.add(n);
  }
  return [...chosen].sort((a, b) => a - b);
}

async function stop(copies, options, io) {
  const out = text => io.stdout.write(`${text}\n`);
  if (options['dry-run']) {
    out(`Would stop ${summary(copies)}:`);
    for (const copy of copies) out(`  ${copy.name} (pid ${copy.root.pid}, ${agentLabel(copy)})`);
    return 0;
  }
  const result = await stopProcesses(copies.flatMap(copy => copy.processes));
  const left = new Set(result.failed.map(target => target.pid));
  const stopped = copies.filter(copy => !copy.processes.some(p => left.has(p.pid)));
  const failed = copies.filter(copy => copy.processes.some(p => left.has(p.pid)));
  if (stopped.length) out(style(Boolean(io.stdout.isTTY) && !io.env.NO_COLOR).green(`Stopped ${summary(stopped)}.`));
  for (const copy of failed) io.stderr.write(`Could not stop ${copy.name} (pid ${copy.root.pid}); it may belong to another user or run as administrator.\n`);
  return failed.length ? 1 : 0;
}

async function stopCommand(options, io) {
  let copies = await check({ env: io.env });
  // Idle means no work between two checks; look again shortly if this is the
  // first look at some servers.
  if (options.idleMs !== undefined && filtered(copies, options).some(copy => !copy.measured)) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    copies = await check({ env: io.env });
  }
  const color = Boolean(io.stdout.isTTY) && !io.env.NO_COLOR;
  const interactive = Boolean(io.stdin.isTTY && io.stdout.isTTY);
  const out = text => io.stdout.write(`${text}\n`);
  let chosen;
  if (options.pids.length) {
    chosen = [];
    for (const pid of options.pids) {
      const copy = copies.find(c => c.root.pid === pid);
      if (!copy) throw new UsageError(`No MCP server with pid ${pid}. Run mcp-janitor to see the list.`);
      chosen.push(copy);
    }
  } else if (options.idleMs !== undefined || options.orphans) {
    chosen = options.idleMs !== undefined ? idleOnes(copies, options) : filtered(copies, options);
    if (!chosen.length) {
      const kept = options.idleMs !== undefined ? filtered(copies, options).filter(copy => copy.latest && copy.measured && copy.idleMs >= options.idleMs) : [];
      out(kept.length
        ? `Nothing to stop. ${kept.length} idle server${kept.length === 1 ? ' belongs' : 's belong'} to the latest conversation of ${kept.length === 1 ? 'its app' : 'their apps'}; add --include-latest to stop ${kept.length === 1 ? 'it' : 'them'} too.`
        : 'Nothing to stop.');
      return 0;
    }
    if (!options.yes && !options['dry-run']) {
      out(render(chosen, { color }).lines.join('\n').trimEnd());
      if (!interactive) throw new UsageError('There is no terminal to ask in; add --yes to stop these servers.');
      if (!/^y(es)?$/i.test(await ask(`\nStop ${summary(chosen)}? [y/N] `, io))) return 0;
    }
  } else {
    const shown = filtered(copies, options);
    if (!shown.length) { out('No MCP servers to stop.'); return 0; }
    if (!interactive) throw new UsageError('Say which servers to stop: give their PIDs, --idle <time> or --orphans.');
    const { lines, numbers } = render(shown, { color, numbered: true });
    out(lines.join('\n').trimEnd());
    const answer = await ask('\nStop which? Numbers or ranges (1,3-5), "all", or Enter for none: ', io);
    chosen = parseSelection(answer, numbers.size).map(n => numbers.get(n));
    if (!chosen.length) return 0;
  }
  return stop(chosen, options, io);
}

async function watchCommand(options, io) {
  const out = text => io.stdout.write(`${text}\n`);
  const time = () => new Date().toTimeString().slice(0, 5);
  out(options.idleMs === undefined
    ? `Checking MCP servers every ${formatDuration(options.everyMs)}, and stopping none (add --idle <time> to stop idle ones). Ctrl+C to quit.`
    : `Checking MCP servers every ${formatDuration(options.everyMs)}. Servers idle for ${formatDuration(options.idleMs)} or more will be stopped${options['include-latest'] ? '' : ", except those of each app's latest conversation"}${options['dry-run'] ? ' (dry run)' : ''}. Ctrl+C to quit.`);
  for (;;) {
    try {
      const copies = await check({ env: io.env });
      if (options.idleMs !== undefined) {
        const due = idleOnes(copies, options);
        if (due.length && options['dry-run']) {
          out(`[${time()}] would stop ${summary(due)}: ${due.map(copy => `${copy.name} (${agentLabel(copy)}, idle ${formatDuration(copy.idleMs)})`).join(', ')}`);
        } else if (due.length) {
          const result = await stopProcesses(due.flatMap(copy => copy.processes));
          const left = new Set(result.failed.map(target => target.pid));
          const stopped = due.filter(copy => !copy.processes.some(p => left.has(p.pid)));
          if (stopped.length) out(`[${time()}] stopped ${summary(stopped)}: ${stopped.map(copy => `${copy.name} (${agentLabel(copy)}, idle ${formatDuration(copy.idleMs)})`).join(', ')}`);
          for (const copy of due.filter(c => !stopped.includes(c))) io.stderr.write(`[${time()}] could not stop ${copy.name} (pid ${copy.root.pid})\n`);
        }
      }
    } catch (error) {
      io.stderr.write(`[${time()}] check failed: ${error.message}\n`);
    }
    await new Promise(resolve => setTimeout(resolve, options.everyMs));
  }
}

async function listCommand(options, io) {
  const copies = filtered(await check({ env: io.env }), options);
  if (options.json) {
    io.stdout.write(`${JSON.stringify(copies.map(copy => ({
      name: copy.name, agent: copy.agent, host: copy.host, agentPid: copy.agentPid, orphan: copy.orphan, confirmed: copy.confirmed, latest: copy.latest,
      pid: copy.root.pid, processes: copy.processes.map(p => p.pid), started: new Date(copy.start).toISOString(), memoryBytes: copy.memoryBytes,
      idleMs: copy.idleMs, measured: copy.measured, lastUsed: copy.lastUsed === null ? null : new Date(copy.lastUsed).toISOString(),
      conversation: copy.conversation && { id: copy.conversation.id, title: copy.conversation.title, busy: copy.conversation.busy },
    })), null, 2)}\n`);
    return 0;
  }
  const out = text => io.stdout.write(`${text}\n`);
  if (!copies.length) {
    out('No MCP servers running for Codex, Claude Code, Claude Desktop, Cursor, VS Code or Gemini CLI.');
    return 0;
  }
  const color = Boolean(io.stdout.isTTY) && !io.env.NO_COLOR;
  out(render(copies, { color }).lines.join('\n').trimEnd());
  out('');
  out(`Total: ${summary(copies)}.${copies.some(copy => copy.idleMs === null) ? ' – means not measured yet; run again later.' : ''}`);
  out('Stop some with "mcp-janitor stop", or the idle ones with "mcp-janitor stop --idle 1h".');
  return 0;
}

export async function main(argv, io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env }) {
  try {
    const options = parseArgs(argv);
    if (options.help) { io.stdout.write(HELP); return 0; }
    if (options.version) {
      const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      io.stdout.write(`${pkg.version}\n`);
      return 0;
    }
    if (options.command === 'stop') return await stopCommand(options, io);
    if (options.command === 'watch') return await watchCommand(options, io);
    if (options.pids.length || options.idleMs !== undefined) throw new UsageError('--idle and PIDs go with stop or watch.');
    return await listCommand(options, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`mcp-janitor: ${error.message}\n`);
      return 2;
    }
    io.stderr.write(`mcp-janitor: ${error.message}\n`);
    return 1;
  }
}
