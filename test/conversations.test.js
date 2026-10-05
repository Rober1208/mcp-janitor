import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { describeConversations, uuidTime } from '../src/conversations.js';

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}

const temporary = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-janitor-conv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// A UUIDv7 made at `ms`, the form of Codex thread IDs.
const v7 = (ms, tail = '8def-0123456789ab') => {
  const hex = ms.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-${tail}`;
};

test('uuidTime reads the time in a UUIDv7', () => {
  assert.equal(uuidTime('01a10acb-b185-7793-9133-63ca5d1e5420'), Date.parse('2026-10-05T06:41:23.845Z'));
  assert.equal(uuidTime(v7(1234567)), 1234567);
  assert.equal(uuidTime('f65cc0a7-f395-4db1-be82-7ab4d3372057'), null);
});

test('Claude Code: each session process names its conversation', async t => {
  const dir = temporary(t);
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.mkdirSync(path.join(dir, 'projects', 'C--work-app'), { recursive: true });
  const startedAt = Date.parse('2026-10-05T01:00:00Z');
  fs.writeFileSync(path.join(dir, 'sessions', '4242.json'), JSON.stringify({
    pid: 4242, sessionId: 'aaaa-bbbb', cwd: 'C:\\work\\app', startedAt, name: 'Fix the login bug', status: 'idle', updatedAt: startedAt + 60000,
  }));
  fs.writeFileSync(path.join(dir, 'projects', 'C--work-app', 'aaaa-bbbb.jsonl'), '{}\n');
  const written = fs.statSync(path.join(dir, 'projects', 'C--work-app', 'aaaa-bbbb.jsonl')).mtimeMs;
  fs.writeFileSync(path.join(dir, 'sessions', '777.json'), JSON.stringify({ pid: 777, sessionId: 'old', startedAt, name: 'Old', status: 'busy' }));

  const copies = [
    { agent: 'Claude Code', agentPid: 4242, agentStart: startedAt - 800, start: startedAt + 1000, orphan: false },
    // PID 777 is a newer process now: the file is from the one before it.
    { agent: 'Claude Code', agentPid: 777, agentStart: startedAt + 3600000, start: startedAt + 3601000, orphan: false },
    { agent: 'Claude Desktop', agentPid: 1, agentStart: 0, start: 5, orphan: false },
  ];
  await describeConversations(copies, { env: { CLAUDE_CONFIG_DIR: dir }, home: dir });
  assert.equal(copies[0].conversation.title, 'Fix the login bug');
  assert.equal(copies[0].conversation.busy, false);
  assert.equal(copies[0].conversation.lastActivity, Math.max(startedAt + 60000, written));
  assert.equal(copies[1].conversation, null);
  assert.equal(copies[2].conversation, null);
});

test('Codex: a server set belongs to the thread created or opened just before it', { skip: !DatabaseSync && 'node:sqlite is not available' }, async t => {
  const dir = temporary(t);
  const T = Date.parse('2026-10-05T07:15:31.200Z');
  const fresh = v7(T - 300);
  const resumed = v7(T - 6 * 86400000, '8def-000000000001');
  const sub = v7(T + 120000 - 200, '8def-000000000002');
  const ephemeral = v7(T + 240000 - 100, '8def-000000000003');
  fs.writeFileSync(path.join(dir, 'session_index.jsonl'), `${JSON.stringify({ id: fresh, thread_name: 'Fix the login bug' })}\nnot json\n`);

  const state = new DatabaseSync(path.join(dir, 'state_5.sqlite'));
  state.exec('create table threads (id text primary key, title text not null, source text not null, created_at_ms integer, updated_at_ms integer)');
  const insert = state.prepare('insert into threads values (?, ?, ?, ?, ?)');
  insert.run(fresh, 'first message', 'vscode', T - 300, T + 5000);
  insert.run(resumed, 'An old question', 'vscode', T - 6 * 86400000, T + 61000);
  insert.run(sub, '', JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: fresh, agent_nickname: 'Hubble' } } }), T + 119800, T + 130000);
  state.close();
  // An older state database is ignored.
  new DatabaseSync(path.join(dir, 'state_4.sqlite')).close();

  const logs = new DatabaseSync(path.join(dir, 'logs_2.sqlite'));
  logs.exec('create table logs (id integer primary key autoincrement, ts integer, ts_nanos integer, level text, target text, feedback_log_body text, thread_id text, process_uuid text)');
  const log = logs.prepare('insert into logs (ts, ts_nanos, thread_id, process_uuid, feedback_log_body) values (?, ?, ?, ?, ?)');
  const at = ms => [Math.floor(ms / 1000), (ms % 1000) * 1e6];
  // Thread "resumed" is opened again a minute later, in process 4200.
  log.run(...at(T + 60000 - 100), resumed, 'pid:4200:abc', 'app_server.request{rpc.method="thread/resume" rpc.request_id=7}: loaded');
  // The same happens in another Codex process, which is not ours.
  log.run(...at(T + 60000 - 50), fresh, 'pid:1111:def', 'app_server.request{rpc.method="thread/resume" rpc.request_id=9}: loaded');
  // An ephemeral thread is in no database, only in the log.
  log.run(...at(T + 240000 + 50), ephemeral, 'pid:4200:abc', 'shell_snapshot: done');
  log.run(...at(T + 300000), fresh, 'pid:4200:abc', 'turn finished');
  logs.close();

  const copy = start => ({ agent: 'Codex', agentPid: 4200, agentStart: 0, start, orphan: false });
  const copies = [copy(T), copy(T + 60000), copy(T + 120000), copy(T + 240000), copy(T + 400000)];
  await describeConversations(copies, { env: { CODEX_HOME: dir }, home: dir });
  assert.equal(copies[0].conversation.id, fresh);
  assert.equal(copies[0].conversation.title, 'Fix the login bug');
  assert.equal(copies[0].conversation.lastActivity, T + 300000);
  assert.equal(copies[1].conversation.id, resumed);
  assert.equal(copies[1].conversation.title, 'An old question');
  assert.equal(copies[2].conversation.title, 'Hubble (subagent of Fix the login bug)');
  assert.equal(copies[3].conversation.id, ephemeral);
  assert.equal(copies[3].conversation.title, null);
  assert.equal(copies[4].conversation, null);
});

test('Codex without the databases: rollout files still name new threads', async t => {
  const dir = temporary(t);
  const T = Date.parse('2026-10-05T07:15:31.200Z');
  const id = v7(T - 500);
  const day = new Date(T);
  const folder = path.join(dir, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `rollout-2026-10-05T15-15-30-${id}.jsonl`), '');
  fs.writeFileSync(path.join(dir, 'session_index.jsonl'), `${JSON.stringify({ id, thread_name: 'Named thread' })}\n`);
  const copies = [{ agent: 'Codex', agentPid: 1, agentStart: 0, start: T, orphan: false }];
  await describeConversations(copies, { env: { CODEX_HOME: dir }, home: dir });
  assert.equal(copies[0].conversation.title, 'Named thread');
});
