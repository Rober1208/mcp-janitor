import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { formatBytes, formatDuration, main, parseArgs, parseDuration, parseSelection, render, UsageError, width } from '../src/cli.js';

const MB = 1024 * 1024;

test('durations', () => {
  assert.equal(parseDuration('90s'), 90000);
  assert.equal(parseDuration('30m'), 1800000);
  assert.equal(parseDuration('1h30m'), 5400000);
  assert.equal(parseDuration('1.5h'), 5400000);
  assert.equal(parseDuration('2D'), 172800000);
  for (const bad of ['', '30', 'm', '1x', '-5m', '1h 30m']) assert.throws(() => parseDuration(bad), UsageError, bad);
  assert.equal(formatDuration(45000), '45s');
  assert.equal(formatDuration(17 * 60000), '17m');
  assert.equal(formatDuration(133 * 60000), '2h 13m');
  assert.equal(formatDuration(120 * 60000), '2h');
  assert.equal(formatDuration(76 * 3600000), '3d 4h');
  assert.equal(formatBytes(166 * MB), '166 MB');
  assert.equal(formatBytes(5.6 * 1024 * MB), '5.6 GB');
});

test('arguments', () => {
  assert.deepEqual(parseArgs([]), { command: 'list', pids: [], everyMs: 60000 });
  const stop = parseArgs(['stop', '--idle=1h', '--agent', 'codex', '--include-latest', '-y']);
  assert.equal(stop.command, 'stop');
  assert.equal(stop.idleMs, 3600000);
  assert.equal(stop.agent, 'codex');
  assert.equal(stop['include-latest'], true);
  assert.equal(stop.yes, true);
  assert.deepEqual(parseArgs(['stop', '123', '-y', '456']).pids, [123, 456]);
  assert.equal(parseArgs(['watch', '--idle', '30m', '--every', '10s']).everyMs, 10000);
  assert.equal(parseArgs(['doctor']).command, 'doctor');
  assert.throws(() => parseArgs(['--bogus']), /Unknown option --bogus/);
  assert.throws(() => parseArgs(['--idle']), /--idle needs a value/);
  assert.throws(() => parseArgs(['list', '123']), /PIDs go with stop, as in: mcp-janitor stop 123/);
  assert.throws(() => parseArgs(['4180']), /PIDs go with stop/);
  assert.throws(() => parseArgs(['--json', 'stop']), /Unexpected argument stop/);
  // An option that would do nothing is a mistake.
  assert.throws(() => parseArgs(['--every', '5m']), /--every goes with watch, not list/);
  assert.throws(() => parseArgs(['stop', '--json']), /--json goes with list, not stop/);
  assert.throws(() => parseArgs(['doctor', '--agent', 'codex']), /--agent goes with list, stop or watch, not doctor/);
  assert.throws(() => parseArgs(['--dry-run']), /--dry-run goes with stop or watch, not list/);
  assert.throws(() => parseArgs(['stop', '--include-latest']), /--include-latest goes with --idle/);
  assert.throws(() => parseArgs(['watch', '--include-latest']), /--include-latest goes with --idle/);
  assert.throws(() => parseArgs(['stop', '123', '--idle', '1h']), /Give either PIDs or --idle, not both/);
  assert.throws(() => parseArgs(['stop', '123', '--agent', 'codex']), /Give either PIDs or --agent, not both/);
  assert.equal(parseArgs(['stop', '123', '--dry-run', '--yes']).pids[0], 123);
  assert.equal(parseArgs(['--orphans', '--json', '--server', 'playwright']).orphans, true);
  assert.equal(parseArgs(['watch', '--idle', '1h', '--yes']).yes, true);
  assert.equal(parseArgs(['doctor', '--help']).help, true);
  assert.throws(() => parseArgs(['watch', '--every', '1s']), /at least 5s/);
  assert.throws(() => parseArgs(['--yes=1']), /Unknown option/);
  // Agents by their whole name: "code" is not Codex, and "claude" is two agents.
  for (const name of ['codex', 'Claude Code', 'claude-desktop', 'vscode', 'gemini', 'other']) assert.doesNotThrow(() => parseArgs(['--agent', name]), name);
  for (const name of ['claude', 'code', 'chatgpt']) assert.throws(() => parseArgs(['--agent', name]), /--agent must be one of: codex, claude desktop, claude code/, name);
});

test('choosing servers by number', () => {
  assert.deepEqual(parseSelection('', 5), []);
  assert.deepEqual(parseSelection('all', 3), [1, 2, 3]);
  assert.deepEqual(parseSelection('4, 1-2 2', 5), [1, 2, 4]);
  assert.throws(() => parseSelection('0', 5), /between 1 and 5/);
  assert.throws(() => parseSelection('3-9', 5), /between 1 and 5/);
  assert.throws(() => parseSelection('two', 5), /not a number/);
});

test('terminal width of East Asian text', () => {
  assert.equal(width('abc'), 3);
  assert.equal(width('修正 bug'), 8);
});

const copy = (name, pid, extra = {}) => ({
  name, agent: 'Codex', host: 'ChatGPT app', agentPid: 30, orphan: false, latest: false, start: pid,
  root: { pid, start: pid }, memoryBytes: 100 * MB, idleMs: 3 * 3600000, conversation: null, ...extra,
});

test('the list groups servers by agent and conversation', () => {
  const old = { id: 'a', title: 'Fix the login bug', lastActivity: 1 };
  const current = { id: 'b', title: '重構設定檔', lastActivity: 2 };
  const { lines, numbers } = render([
    copy('playwright', 41, { conversation: old }),
    copy('playwright', 61, { conversation: current, latest: true, idleMs: 30000 }),
    copy('node_repl', 42, { conversation: old, idleMs: null }),
    copy('github', 90, { agent: 'Claude Code', host: null, agentPid: 80, conversation: { id: 'c', title: null, cwd: '/work/app', busy: true } }),
    copy('ilovepdf', 99, { agent: 'Codex', host: null, agentPid: null, orphan: true, confirmed: true }),
    copy('notes', 98, { agent: 'Codex', host: null, agentPid: null, orphan: true, confirmed: false, idleMs: null }),
  ], { numbered: true });
  assert.deepEqual(lines, [
    'Claude Code (pid 80): 1 server, 100 MB',
    '  untitled session in app',
    '    1  github       100 MB  in use now    pid 90',
    '',
    'Codex in ChatGPT app (pid 30): 3 servers, 300 MB',
    '  "Fix the login bug"',
    '    2  playwright   100 MB  idle 3h       pid 41',
    '    3  node_repl    100 MB  –             pid 42',
    '  "重構設定檔"  (latest)',
    '    4  playwright   100 MB  active        pid 61',
    '',
    'Orphans, left running by an agent that exited: 1 server, 100 MB',
    '    5  ilovepdf     100 MB  idle 3h       pid 99',
    '',
    'Possibly left behind (never seen with their agent): 1 server, 100 MB',
    '    6  notes        100 MB  –             pid 98',
    '',
  ]);
  assert.equal(numbers.get(4).root.pid, 61);
});

function io(env = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', chunk => { out += chunk; });
  stderr.on('data', chunk => { err += chunk; });
  return { stdin: new PassThrough(), stdout, stderr, env, get out() { return out; }, get err() { return err; } };
}

test('help, version and mistakes', async () => {
  const help = io();
  assert.equal(await main(['--help'], help), 0);
  assert.match(help.out, /mcp-janitor stop --idle 1h/);
  const version = io();
  assert.equal(await main(['-v'], version), 0);
  assert.match(version.out, /^\d+\.\d+\.\d+\n$/);
  const wrong = io();
  assert.equal(await main(['--idle', '1h'], wrong), 2);
  assert.match(wrong.err, /--idle goes with stop or watch, not list/);
  const bad = io();
  assert.equal(await main(['stop', '--idle', 'soon'], bad), 2);
  assert.match(bad.err, /--idle must be a time/);
});
