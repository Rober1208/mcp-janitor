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
  const stop = parseArgs(['stop', '--idle=1h', '--agent', 'codex', '--include-latest', '-y', '123', '456']);
  assert.equal(stop.command, 'stop');
  assert.equal(stop.idleMs, 3600000);
  assert.equal(stop.agent, 'codex');
  assert.equal(stop['include-latest'], true);
  assert.equal(stop.yes, true);
  assert.deepEqual(stop.pids, [123, 456]);
  assert.equal(parseArgs(['watch', '--idle', '30m', '--every', '10s']).everyMs, 10000);
  assert.throws(() => parseArgs(['--bogus']), /Unknown option --bogus/);
  assert.throws(() => parseArgs(['--idle']), /--idle needs a value/);
  assert.throws(() => parseArgs(['list', '123']), /Unexpected argument 123/);
  assert.throws(() => parseArgs(['--json', 'stop']), /Unexpected argument stop/);
  assert.throws(() => parseArgs(['watch', '--every', '1s']), /at least 5s/);
  assert.throws(() => parseArgs(['--yes=1']), /Unknown option/);
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
    copy('ilovepdf', 99, { agent: 'Codex', host: null, agentPid: null, orphan: true }),
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
  assert.match(wrong.err, /go with stop or watch/);
  const bad = io();
  assert.equal(await main(['stop', '--idle', 'soon'], bad), 2);
  assert.match(bad.err, /--idle must be a time/);
});
