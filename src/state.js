import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where mcp-janitor remembers what it saw at its last check. */
export function stateFile({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (env.MCP_JANITOR_STATE) return env.MCP_JANITOR_STATE;
  const dir = platform === 'win32' ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'mcp-janitor')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'mcp-janitor')
      : path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'mcp-janitor');
  return path.join(dir, 'state.json');
}

/** The records of the last check, by copy key. */
export function loadState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return state?.version === 1 && state.copies && typeof state.copies === 'object' ? state.copies : {};
  } catch {
    return {};
  }
}

// CPU time below this between two checks is the noise of an idle process.
const CPU_NOISE_MS = 20;

const worked = (before, copy) => copy.cpuMs - before.cpuMs >= CPU_NOISE_MS
  || (copy.ioBytes !== null && before.ioBytes !== null && copy.ioBytes !== before.ioBytes);

/**
 * Compare each copy with the previous check, and work out when the agent
 * last used it. Sets copy.measured (whether there was a previous check to
 * compare with), copy.lastUsed (ms, or null when it cannot be known yet) and
 * copy.idleMs, and saves this check's records.
 *
 * Two kinds of evidence count. A server reads and writes when it is called,
 * so CPU time or I/O since the last check means it was busy. And an agent
 * only calls servers while it works on the conversation, so a server cannot
 * have been used after its conversation was last active.
 */
export function track(copies, { file = stateFile(), now = Date.now(), before = loadState(file) } = {}) {
  const after = {};
  for (const copy of copies) {
    const previous = before[copy.key];
    const record = {
      firstSeen: previous?.firstSeen ?? now, lastActive: previous?.lastActive ?? null, cpuMs: copy.cpuMs, ioBytes: copy.ioBytes,
      name: copy.name, agent: copy.agent, agentPid: copy.agentPid ?? previous?.agentPid ?? null,
      // Seen with its agent, now or at an earlier check.
      confirmed: Boolean(copy.confirmed || previous?.confirmed),
    };
    if (previous && worked(previous, copy)) record.lastActive = now;
    after[copy.key] = record;

    const evidence = [];
    if (record.lastActive !== null) evidence.push(record.lastActive);
    if (copy.conversation?.busy) evidence.push(now);
    else if (copy.conversation?.lastActivity) evidence.push(copy.conversation.lastActivity);
    // Seen before and quiet ever since: idle at least since that first look.
    else if (previous) evidence.push(record.firstSeen);
    // A server cannot have been used before it started.
    copy.measured = Boolean(previous);
    copy.lastUsed = evidence.length ? Math.min(now, Math.max(copy.start, ...evidence)) : null;
    copy.idleMs = copy.lastUsed === null ? null : now - copy.lastUsed;
  }
  save(file, after);
}

function save(file, copies) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, copies }));
    fs.renameSync(temporary, file);
  } catch {
    // Without a place to remember, idle times still come from the
    // conversations; only the measurements between checks are lost.
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}
