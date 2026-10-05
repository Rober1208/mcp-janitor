import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Find the conversation each server copy was started for, where the agent
 * records it, and when that conversation was last active. Sets
 * copy.conversation to { id, title, lastActivity, busy } or null.
 *
 * - Claude Code writes <config>/sessions/<pid>.json for every running session.
 * - Codex starts a conversation's servers when the conversation is created
 *   or opened again. Thread IDs are UUIDv7 and so carry their creation time,
 *   and Codex logs the requests that open a thread again.
 * - Claude Desktop runs one copy of each server for all its conversations.
 */
export async function describeConversations(copies, { env = process.env, home = os.homedir() } = {}) {
  const claude = claudeSessions(env, home);
  const codex = copies.some(copy => copy.agent === 'Codex') ? await openCodex(env, home) : null;
  try {
    for (const copy of copies) {
      copy.conversation = null;
      if (copy.orphan) continue;
      if (copy.agent === 'Claude Code') {
        const session = claude.get(copy.agentPid);
        // A file left behind by an earlier process with the same PID is older than this one.
        if (session && session.startedAt >= (copy.agentStart ?? 0) - 2000) copy.conversation = session.describe();
      } else if (copy.agent === 'Codex' && codex) {
        copy.conversation = codex.conversationAt(copy.agentPid, copy.start);
      }
    }
  } finally {
    codex?.close();
  }
}

function claudeSessions(env, home) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const sessions = new Map();
  for (const name of list(path.join(dir, 'sessions'))) {
    if (!/^\d+\.json$/.test(name)) continue;
    let session;
    try { session = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', name), 'utf8')); } catch { continue; }
    if (!Number.isInteger(session?.pid)) continue;
    sessions.set(session.pid, {
      startedAt: session.startedAt ?? 0,
      describe: () => {
        // The transcript changes with every message.
        let transcript = 0;
        for (const project of list(path.join(dir, 'projects'))) {
          try { transcript = fs.statSync(path.join(dir, 'projects', project, `${session.sessionId}.jsonl`)).mtimeMs; break; } catch {}
        }
        return {
          id: session.sessionId ?? null, title: session.name || null, cwd: session.cwd ?? null,
          lastActivity: Math.max(session.updatedAt ?? 0, session.statusUpdatedAt ?? 0, transcript) || null,
          busy: session.status === 'busy',
        };
      },
    });
  }
  return sessions;
}

/** The creation time in a UUIDv7, or null for other UUIDs. */
export function uuidTime(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i.test(id ?? '') ? parseInt(id.replace(/-/g, '').slice(0, 12), 16) : null;
}

async function openCodex(env, home) {
  const dir = env.CODEX_HOME || path.join(home, '.codex');
  const Database = await sqlite();
  const open = file => {
    if (!Database || !file) return null;
    try { return new Database(file, { readOnly: true }); } catch { return null; }
  };
  const state = open(newest(dir, /^state_(\d+)\.sqlite$/));
  const logs = open(newest(dir, /^logs_(\d+)\.sqlite$/));
  const names = new Map();
  for (const line of (read(path.join(dir, 'session_index.jsonl')) ?? '').split('\n')) {
    try { const entry = JSON.parse(line); if (entry.id && entry.thread_name) names.set(entry.id, entry.thread_name); } catch {}
  }
  const query = (db, sql, ...params) => { try { return db?.prepare(sql).all(...params) ?? []; } catch { return []; } };
  const threads = new Map();
  const thread = id => {
    if (threads.has(id)) return threads.get(id);
    const row = query(state, 'select title, source, updated_at_ms from threads where id = ?', id)[0];
    const logged = query(logs, 'select max(ts * 1000 + ts_nanos / 1000000) as ms from logs where thread_id = ?', id)[0]?.ms;
    let title = names.get(id) || row?.title || null;
    let parent = null;
    try { parent = JSON.parse(row?.source ?? 'null')?.subagent?.thread_spawn ?? null; } catch {}
    if (!names.get(id) && parent?.parent_thread_id) {
      const parentTitle = names.get(parent.parent_thread_id) || query(state, 'select title from threads where id = ?', parent.parent_thread_id)[0]?.title;
      title = `${parent.agent_nickname ?? 'subagent'} (subagent of ${parentTitle || 'another conversation'})`;
    }
    const info = { id, title: title ? title.replace(/\s+/g, ' ').trim() : null, lastActivity: Math.max(row?.updated_at_ms ?? 0, logged ?? 0) || null, busy: false };
    threads.set(id, info);
    return info;
  };
  const known = start => {
    const ids = new Set(query(state, 'select id from threads where created_at_ms between ? and ?', start - 60000, start + 60000).map(row => row.id));
    if (!state) {
      // Without the state database, the rollout files name every thread.
      for (const offset of [-1, 0, 1]) {
        const day = new Date(start + offset * 86400000);
        const folder = path.join(dir, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
        for (const name of list(folder)) { const id = /([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name)?.[1]; if (id) ids.add(id); }
      }
    }
    return ids;
  };
  return {
    conversationAt(agentPid, start) {
      const candidates = [];
      const ids = known(start);
      // The agent's log around that time names the threads it worked on; a
      // thread opened again, or whose servers restarted, is logged with it.
      const sql = `select thread_id, ts, ts_nanos, (feedback_log_body like '%"thread/resume"%' or feedback_log_body like '%start_server_task%'
        or feedback_log_body like '%make_rmcp_client%') as opened from logs where ts between ? and ? and process_uuid like ? and thread_id is not null`;
      for (const row of query(logs, sql, Math.floor(start / 1000) - 10, Math.ceil(start / 1000) + 10, `pid:${agentPid}:%`)) {
        ids.add(row.thread_id);
        const at = row.ts * 1000 + Math.floor((row.ts_nanos ?? 0) / 1e6);
        if (row.opened && at <= start + 2000) candidates.push({ id: row.thread_id, at });
      }
      // A new thread's servers start right after the thread is created.
      for (const id of ids) {
        const created = uuidTime(id);
        if (created !== null && created >= start - 10000 && created <= start + 2000) candidates.push({ id, at: created });
      }
      const best = candidates.sort((a, b) => b.at - a.at)[0];
      return best ? thread(best.id) : null;
    },
    close() { state?.close(); logs?.close(); },
  };
}

// node:sqlite is built into Node.js 22.13 and later. It announces itself as
// experimental, which is noise for the people using this tool.
async function sqlite() {
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    if (/sqlite/i.test(String(warning?.message ?? warning))) return;
    return emit.call(this, warning, ...rest);
  };
  try { return (await import('node:sqlite')).DatabaseSync; } catch { return null; } finally { process.emitWarning = emit; }
}

function newest(dir, pattern) {
  let best = null;
  let version = -1;
  for (const name of list(dir)) {
    const match = pattern.exec(name);
    if (match && Number(match[1]) > version) { version = Number(match[1]); best = path.join(dir, name); }
  }
  return best;
}

function list(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
