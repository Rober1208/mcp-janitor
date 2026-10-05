import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stateFile, track } from '../src/state.js';

const MINUTE = 60000;
const copy = (key, extra = {}) => ({ key, start: 0, cpuMs: 100, ioBytes: 1000, conversation: null, ...extra });

function file(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-janitor-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'nested', 'state.json');
}

test('the first look cannot tell how long a server has been idle', t => {
  const at = file(t);
  const copies = [copy('1:0')];
  track(copies, { file: at, now: 10 * MINUTE });
  assert.equal(copies[0].lastUsed, null);
  assert.equal(copies[0].idleMs, null);
  assert.equal(copies[0].measured, false);
  assert.ok(fs.existsSync(at));
  const again = [copy('1:0')];
  track(again, { file: at, now: 11 * MINUTE });
  assert.equal(again[0].measured, true);
});

test('records remember which agent a server belonged to', t => {
  const at = file(t);
  track([copy('1:0', { name: 'notes', agent: 'Codex', agentPid: 30, confirmed: true }), copy('2:0', { name: 'x', agent: 'Codex', agentPid: null, confirmed: false })], { file: at, now: 0 });
  // Later its agent is gone: still confirmed, and the agent is remembered.
  track([copy('1:0', { name: 'notes', agent: 'Codex', agentPid: null, confirmed: true, orphan: true }), copy('2:0', { name: 'x', agent: 'Codex', agentPid: null, confirmed: false })], { file: at, now: MINUTE });
  const { copies } = JSON.parse(fs.readFileSync(at, 'utf8'));
  assert.deepEqual([copies['1:0'].confirmed, copies['1:0'].agentPid, copies['1:0'].name], [true, 30, 'notes']);
  assert.equal(copies['2:0'].confirmed, false);
});

test('a quiet conversation bounds when its servers were last used', t => {
  const at = file(t);
  const copies = [
    copy('1:0', { start: 2 * MINUTE, conversation: { lastActivity: 5 * MINUTE } }),
    // Opened again after its last message: idle since the server started.
    copy('2:0', { start: 8 * MINUTE, conversation: { lastActivity: 5 * MINUTE } }),
    copy('3:0', { conversation: { lastActivity: 5 * MINUTE, busy: true } }),
  ];
  track(copies, { file: at, now: 65 * MINUTE });
  assert.equal(copies[0].idleMs, 60 * MINUTE);
  assert.equal(copies[1].idleMs, 57 * MINUTE);
  assert.equal(copies[2].idleMs, 0);
});

test('between checks, work shows as CPU time or I/O', t => {
  const at = file(t);
  track([copy('quiet:0'), copy('cpu:0'), copy('io:0'), copy('noise:0'), copy('mac:0', { ioBytes: null })], { file: at, now: 0 });
  const later = [
    copy('quiet:0'),
    copy('cpu:0', { cpuMs: 400 }),
    copy('io:0', { ioBytes: 1500 }),
    copy('noise:0', { cpuMs: 110 }),
    copy('mac:0', { ioBytes: null, cpuMs: 300 }),
  ];
  track(later, { file: at, now: 30 * MINUTE });
  const idle = Object.fromEntries(later.map(c => [c.key, c.idleMs]));
  assert.deepEqual(idle, { 'quiet:0': 30 * MINUTE, 'cpu:0': 0, 'io:0': 0, 'noise:0': 30 * MINUTE, 'mac:0': 0 });

  // Later still, the work seen at 30 minutes is the last.
  const latest = [copy('cpu:0', { cpuMs: 400 })];
  track(latest, { file: at, now: 50 * MINUTE });
  assert.equal(latest[0].idleMs, 20 * MINUTE);
  // Servers that are gone are forgotten.
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(at, 'utf8')).copies), ['cpu:0']);
});

test('work seen between checks beats a quiet conversation', t => {
  const at = file(t);
  track([copy('1:0', { conversation: { lastActivity: 0 } })], { file: at, now: 10 * MINUTE });
  const later = [copy('1:0', { ioBytes: 5000, conversation: { lastActivity: 0 } })];
  track(later, { file: at, now: 20 * MINUTE });
  assert.equal(later[0].idleMs, 0);
});

test('a broken state file starts over', t => {
  const at = file(t);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, '{ not json');
  const copies = [copy('1:0')];
  track(copies, { file: at, now: 0 });
  assert.equal(copies[0].idleMs, null);
  assert.equal(JSON.parse(fs.readFileSync(at, 'utf8')).version, 1);
});

test('the state file lives where each system keeps such files', () => {
  assert.equal(stateFile({ env: { LOCALAPPDATA: 'C:\\L' }, home: 'C:\\H', platform: 'win32' }), path.join('C:\\L', 'mcp-janitor', 'state.json'));
  assert.equal(stateFile({ env: {}, home: '/h', platform: 'linux' }), path.join('/h', '.local', 'state', 'mcp-janitor', 'state.json'));
  assert.equal(stateFile({ env: { XDG_STATE_HOME: '/x' }, home: '/h', platform: 'linux' }), path.join('/x', 'mcp-janitor', 'state.json'));
  assert.equal(stateFile({ env: {}, home: '/h', platform: 'darwin' }), path.join('/h', 'Library', 'Application Support', 'mcp-janitor', 'state.json'));
  assert.equal(stateFile({ env: { MCP_JANITOR_STATE: '/s.json' } }), '/s.json');
});
