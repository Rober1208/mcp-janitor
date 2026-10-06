import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * A snapshot of the processes on this machine:
 * { pid, ppid, name, command, start (ms since epoch), cpuMs, ioBytes (null on
 * macOS), memoryBytes, mine }. `start` tells a process apart from a later one
 * that reuses its PID. `mine` is whether the process belongs to the user
 * running this: on Windows, whether it runs in the same logon session.
 */
export function snapshot() {
  if (process.platform === 'win32') return windowsProcesses();
  if (process.platform === 'linux') return linuxProcesses();
  if (process.platform === 'darwin') return macProcesses();
  throw new Error(`mcp-janitor does not support ${process.platform} yet.`);
}

function windowsProcesses() {
  // Windows PowerShell writes in the console code page unless told otherwise,
  // which garbles command lines with non-ASCII paths.
  const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
  Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{
    p = $_.ProcessId; pp = $_.ParentProcessId; n = $_.Name; c = $_.CommandLine
    s = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
    t = ([double]$_.UserModeTime + [double]$_.KernelModeTime) / 10000
    io = [double]$_.ReadTransferCount + [double]$_.WriteTransferCount
    m = [double]$_.WorkingSetSize; o = $_.SessionId -eq $session } } | ConvertTo-Json -Compress`;
  const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return [].concat(JSON.parse(output)).map(p => ({
    pid: p.p, ppid: p.pp, name: p.n ?? '', command: p.c ?? '', start: p.s ? Date.parse(p.s) : 0,
    cpuMs: p.t, ioBytes: p.io, memoryBytes: p.m, mine: p.o === true,
  }));
}

function linuxProcesses() {
  const ticks = 100; // USER_HZ, the unit of /proc/<pid>/stat times on Linux
  const boot = Number(/^btime (\d+)/m.exec(fs.readFileSync('/proc/stat', 'utf8'))[1]) * 1000;
  const result = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const name = stat.slice(stat.indexOf('(') + 1, close);
      // Fields after "pid (comm) ": state is the first, so field N is at N - 3.
      const fields = stat.slice(close + 2).split(' ');
      const command = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
      const status = fs.readFileSync(`/proc/${entry}/status`, 'utf8');
      const rss = /^VmRSS:\s+(\d+) kB/m.exec(status);
      const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
      let ioBytes = null;
      try {
        const io = fs.readFileSync(`/proc/${entry}/io`, 'utf8');
        ioBytes = Number(/^rchar: (\d+)/m.exec(io)[1]) + Number(/^wchar: (\d+)/m.exec(io)[1]);
      } catch {}
      result.push({
        pid: Number(entry), ppid: Number(fields[1]), name, command: command || `[${name}]`,
        start: boot + (Number(fields[19]) / ticks) * 1000,
        cpuMs: ((Number(fields[11]) + Number(fields[12])) / ticks) * 1000,
        ioBytes, memoryBytes: rss ? Number(rss[1]) * 1024 : 0, mine: uid === process.getuid(),
      });
    } catch {
      // The process exited while it was being read.
    }
  }
  return result;
}

function macProcesses() {
  // Dates in English, so they can be parsed; characters in UTF-8, so non-ASCII
  // command lines come through as they are.
  const env = { ...process.env, LC_ALL: '', LC_TIME: 'C', LC_CTYPE: /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '') ? (process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG) : 'UTF-8' };
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,uid=,rss=,time=,lstart=,command='], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env });
  const result = [];
  for (const line of output.split('\n')) {
    // lstart is five words, e.g. "Mon Oct  5 14:22:06 2026".
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d:.]+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const cpuMs = match[5].split(':').reduce((total, part) => total * 60 + Number(part), 0) * 1000;
    const command = match[7];
    result.push({
      pid: Number(match[1]), ppid: Number(match[2]), name: executableName(command), command,
      start: Date.parse(match[6]), cpuMs, ioBytes: null, memoryBytes: Number(match[4]) * 1024, mine: Number(match[3]) === process.getuid(),
    });
  }
  return result;
}

// The program a macOS command line runs. App bundles have spaces in their
// paths ("Code Helper (Plugin).app"), so take the first leading run of words
// that names a file.
function executableName(command) {
  const words = command.split(' ');
  if (command.startsWith('/')) {
    for (let n = 1; n <= Math.min(words.length, 12); n++) {
      const candidate = words.slice(0, n).join(' ');
      try { if (fs.statSync(candidate).isFile()) return candidate.split('/').pop(); } catch {}
    }
  }
  return words[0].split('/').pop();
}

/** The living parent of a process, if any; a younger process with that PID is not it. */
export function parentOf(byPid, process_) {
  const parent = byPid.get(process_.ppid);
  return parent && parent.pid !== process_.pid && parent.start <= process_.start ? parent : null;
}

/** A process and its living descendants, leaving out those that fail `keep` and theirs. */
export function subtree(processes, root, keep = () => true) {
  const children = new Map();
  for (const p of processes) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const result = [];
  const visit = p => {
    result.push(p);
    for (const child of children.get(p.pid) ?? []) if (child.start >= p.start && child.pid !== p.pid && keep(child)) visit(child);
  };
  visit(root);
  return result;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// The targets still running: a PID with another start time is someone else now.
function living(targets) {
  const current = new Map(snapshot().map(p => [p.pid, p]));
  return targets.filter(target => Math.abs((current.get(target.pid)?.start ?? -Infinity) - target.start) < 1000);
}

// Whether a PID is in use, by anyone; a process we may not signal is there too.
// Far cheaper than a snapshot, which on Windows can take seconds.
function exists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/**
 * Stop processes, given as { pid, start } from a snapshot. Each one is
 * checked against a fresh snapshot right before it is signaled. POSIX
 * processes get SIGTERM first and SIGKILL after a grace period. Waiting only
 * asks whether the PIDs are gone; a snapshot is taken only for those that
 * are not, to tell them from new processes with the same PID.
 */
export async function stopProcesses(targets, { graceMs = 3000 } = {}) {
  const signal = (list, name) => {
    for (const target of list) { try { process.kill(target.pid, name); } catch {} }
  };
  let remaining = living(targets);
  if (process.platform === 'win32') {
    signal(remaining, 'SIGKILL');
  } else {
    signal(remaining, 'SIGTERM');
    for (const end = Date.now() + graceMs; remaining.length && Date.now() < end;) {
      await delay(200);
      remaining = remaining.filter(target => exists(target.pid));
    }
    if (remaining.length) signal(living(remaining), 'SIGKILL');
  }
  await delay(300);
  const answering = targets.filter(target => exists(target.pid));
  const failed = answering.length ? living(answering) : [];
  return { stopped: targets.length - failed.length, failed };
}
