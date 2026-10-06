# mcp-janitor

Find and stop the idle or orphaned MCP server processes that Codex, the
ChatGPT desktop app, Claude Code and other AI agents leave running. Codex
starts a full set of your MCP servers for every conversation and keeps them
until the app quits. mcp-janitor shows which conversation each one belongs to
and how long it has been idle, then stops them by hand, or automatically once
they idle too long.

[![CI](https://github.com/Rober1208/mcp-janitor/actions/workflows/ci.yml/badge.svg)](https://github.com/Rober1208/mcp-janitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**English** · [繁體中文](README.zh-TW.md)

Codex does this in the CLI, the IDE extension and the ChatGPT desktop app
alike, for every conversation, or thread. Claude Code starts a set for every
session, and servers can outlive the agent that started them (orphans). They
pile up as dozens of idle `node.exe`, `node_repl.exe`, Playwright and browser
processes, and gigabytes of memory. mcp-janitor works with Codex, Claude Code,
Claude Desktop, Cursor, VS Code and Gemini CLI, and the conversation you are
using keeps its servers.

```bash
npx github:Rober1208/mcp-janitor#v0.1.3                  # list them
npx github:Rober1208/mcp-janitor#v0.1.3 stop --idle 1h   # stop those idle for an hour
```

It cleans up after the agents; it does not change how they start servers.
Windows, macOS and Linux (including WSL), Node.js 22 or later and Git, no
dependencies, nothing to configure: it reads the MCP settings your agents
already have. Naming Codex conversations takes Node.js 22.13 or later.
mcp-janitor is not on npm; run it from GitHub as above, or install the
`mcp-janitor` command with:

```bash
npm install -g github:Rober1208/mcp-janitor#v0.1.3
```

![mcp-janitor listing three Codex conversations and stopping the idle ones](docs/demo.png)

<sub>A real run: a Codex app server, the one the ChatGPT desktop app uses,
with three conversations opened two minutes apart. No model was called.
[experiments/demo-codex.mjs](experiments/demo-codex.mjs) reproduces it.</sub>

## Is this your problem?

- Task Manager or Activity Monitor shows many `node.exe` or `node_repl.exe`
  processes, or several copies of the same Playwright, `npx`, `uv` or Python
  server, and there are more after every new Codex conversation.
- The ChatGPT desktop app or Codex takes more memory the longer it runs, and
  only quitting it gives the memory back.
- Closing or archiving a Codex thread does not end its MCP servers.
- Within one long Codex task, another full set of the same servers appears
  on every turn.
- MCP servers keep running after you close Claude Code sessions, in a
  terminal or a VS Code tab.

On the machine this tool was written on, the ChatGPT desktop app had collected
11 sets: 11 Playwright servers, 11 of everything else, up to 5.6 GB, all idle.
Upstream, this is [openai/codex#30408](https://github.com/openai/codex/issues/30408)
(MCP server processes never cleaned up per thread),
[#35485](https://github.com/openai/codex/issues/35485) (one `node_repl.exe`
per thread on Windows) and [#38754](https://github.com/openai/codex/issues/38754)
(servers started again on every turn of a task);
Claude Code had [anthropics/claude-code#24649](https://github.com/anthropics/claude-code/issues/24649).

## Usage

```bash
mcp-janitor                    # list MCP servers by agent and conversation
mcp-janitor stop               # pick servers to stop from a numbered list
mcp-janitor stop 4180 5236     # stop these servers (PIDs from the list)
mcp-janitor stop --idle 1h     # stop servers idle for an hour or more
mcp-janitor stop --orphans     # stop servers left running by an agent that exited
mcp-janitor watch --idle 1h    # keep checking, stop servers once idle that long
mcp-janitor doctor             # check what it can read on this machine
```

The run in the picture above, as text:

```text
$ mcp-janitor
Codex (pid 48448): 12 servers, 1.6 GB
  "Fix the flaky login test"
      node_repl     19 MB  idle 6m       pid 7344
      playwright   191 MB  idle 6m       pid 17376
      obsidian     168 MB  idle 6m       pid 9652
      drawio       159 MB  idle 6m       pid 62432
  "Refactor the billing API"
      node_repl     18 MB  idle 4m       pid 16548
      obsidian     167 MB  idle 4m       pid 34912
      drawio       159 MB  idle 4m       pid 30028
      playwright   190 MB  idle 4m       pid 38572
  "Draft the 0.4 release notes"  (latest)
      playwright   190 MB  idle 2m       pid 7856
      drawio       158 MB  idle 2m       pid 58848
      obsidian     168 MB  idle 2m       pid 5360
      node_repl     18 MB  idle 2m       pid 6220

Total: 12 servers, 1.6 GB.

$ mcp-janitor stop --idle 3m --agent codex --yes
Stopped 8 servers, 1.0 GB.
```

With `--idle` or `--orphans`, `stop` lists what it is about to stop and asks
first; add `--yes` to skip the question in scripts, or `--dry-run` to only
look. Narrow the list, `stop` or `watch` with `--server playwright` or
`--agent` followed by `codex`, `"claude code"`, `"claude desktop"`, `cursor`,
`vscode` or `gemini`. Stopping a server also stops every process it started,
such as the browser a Playwright server drives.

**Your current conversation is safe by default.** Each Codex process (the
ChatGPT app, a Codex terminal, a VS Code window) keeps the servers of the
conversation you used last, marked `(latest)`, even when idle, because you may
come back to it any minute and Codex cannot start a stopped server again.
Claude Code can (from `/mcp`), so among its sessions only the one you used last
in each place (terminals, VS Code, the Claude app) is kept. With `--idle`, add
`--include-latest` to stop those too.

When an agent starts a conversation's servers again while the old ones keep
running, as Codex does on every turn of some tasks, only the newest copy of
each server is kept. The older copies are marked `(replaced)`: the agent no
longer talks to them, so they count as idle from the moment they were
replaced, however busy the conversation is.

### What happens to a conversation whose servers you stop

| Agent | After a server is stopped |
| --- | --- |
| Codex (CLI, IDE extension, ChatGPT desktop app) | The conversation keeps running, but calls to that server fail ("Transport closed"). A new conversation, or restarting the app, starts the server again. |
| Claude Code | The server shows as failed in `/mcp`, where you can reconnect it. |
| Claude Desktop | Restart the app to start the server again. |

### Stop idle MCP servers automatically

`watch` checks every minute (`--every` changes that) and logs what it stops:

```text
$ mcp-janitor watch --idle 1h
Checking MCP servers every 1m. Servers idle for 1h or more will be stopped, except those of the conversations you used last. Ctrl+C to quit.
[15:42] stopped 4 servers, 610 MB: playwright (Codex in ChatGPT app, idle 1h 2m), drawio (Codex in ChatGPT app, idle 1h 2m), ...
```

Start it in a terminal you keep open, or in the background:

```bash
nohup mcp-janitor watch --idle 1h > ~/mcp-janitor.log 2>&1 &   # Linux, macOS
```

```powershell
Start-Process -WindowStyle Minimized mcp-janitor 'watch --idle 1h'   # Windows
```

## FAQ

**How do I clean up the MCP processes that Codex or the ChatGPT desktop app
keeps running?** Run `mcp-janitor stop --idle 1h`. It shows the servers of
conversations idle for an hour or more and asks before stopping them. The
conversation you used last in each Codex process keeps its servers. To keep
doing it, run `mcp-janitor watch --idle 1h`.

**Codex starts all the MCP servers again on every turn of a long task. Does it
clean up the old copies?** Yes. Only the newest copy of each server is kept;
the older ones are marked `(replaced)` in the list, and `mcp-janitor stop --idle
10m` stops those that have been replaced for ten minutes or more, even while
the task is still running.

**How do I kill orphaned MCP servers left by Claude Code or another agent that
exited?** Run `mcp-janitor stop --orphans`. It stops the servers it saw
running under their agent at an earlier check. Processes that only look left
behind are listed apart; stop one by its PID, such as `mcp-janitor stop 4180`.

**Why not just end every `node.exe`?** Other programs run on Node.js too, and
so may the agent you are talking to, and stopping the servers of the
conversation you are in breaks its tools. mcp-janitor stops only processes
that an agent started directly from its own MCP configuration.

**Does it fix the leak in Codex?** No. It cleans up after it; the fix belongs
upstream, in [openai/codex#30408](https://github.com/openai/codex/issues/30408).
Until then, `watch --idle 1h` keeps the count down.

**Does it send anything anywhere?** No. See [Privacy](#privacy).

## For AI agents and scripts

This section describes how mcp-janitor behaves when an AI agent or a script
runs it, with no one at a terminal.

Ending processes by name (`taskkill /im node.exe`, `pkill node`) also stops
the user's other Node.js programs, and possibly the agent itself; mcp-janitor
stops only MCP servers. A careful sequence for an agent asked to clean up:

1. List the servers: `npx -y github:Rober1208/mcp-janitor#v0.1.3 --json`
2. See what would be stopped, and show the user:
   `npx -y github:Rober1208/mcp-janitor#v0.1.3 stop --idle 1h --dry-run`
3. Once the user agrees: the same with `--yes` instead of `--dry-run`, or
   `stop <pid> <pid> --yes` for the servers the user picked.

Without `--include-latest`, the conversations used last keep their servers,
and the agent's own conversation may be among them.

- Without a terminal, `stop --idle` and `stop --orphans` need `--yes`, and
  `stop` needs PIDs; otherwise it exits with 2 and stops nothing.
- Exit codes: 0 when it did what was asked, including when there was nothing
  to stop; 1 when a server could not be stopped (stderr names it), `doctor`
  found a problem, or something else failed; 2 for a mistake on the command
  line, such as a PID that is not in the list.
- `stop` prints `Stopped 3 servers, 410 MB.` or `Nothing to stop.`. Only the
  list takes `--json`; run it again afterwards to see what is left.
- Idle time needs two looks. A server seen for the first time, with no
  conversation to tell when it was last used, has `idleMs: null` and is not
  stopped for being idle; `stop --idle` looks once more three seconds later.
  Every list, `stop` and `watch` check, `--dry-run` included, records what it
  saw in the state file (see [Privacy](#privacy)), so the next run knows more.
- For unattended cleanup, `watch --idle 1h` works better than a nightly
  `stop`. Install it once with `npm install -g` rather than fetching it with
  `npx` on every run, and run it as the same user as the agents.

`--json` prints a list with one object per server:

| Field | Meaning |
| --- | --- |
| `name` | The server's name in the agent's configuration |
| `agent`, `host` | The agent, such as `"Codex"`, and where it runs, such as `"ChatGPT app"` or `"VS Code"` (`null` when nothing more is known) |
| `agentPid` | The agent process that started it; `null` for orphans |
| `pid`, `processes` | The server's PID, and the PIDs of it and every process it started |
| `orphan`, `confirmed` | Its agent has exited; it was seen with its agent at an earlier check |
| `latest` | It is the newest copy of a server of the conversation used last, which keeps its servers |
| `replaced` | A newer copy of the same server runs for the same conversation, and the agent no longer uses this one |
| `conversation` | `{ id, title, busy }`, or `null` when not known |
| `memoryBytes` | Working set of the server and the processes it started |
| `idleMs`, `measured`, `lastUsed` | Idle time (`null` until known), whether an earlier check was compared, when it was last used |
| `started` | When the server started (ISO 8601) |

## How it works

**Which processes are MCP servers.** mcp-janitor reads the MCP servers you
configured for each agent, then looks among your own processes (on a shared
machine, other people's are left out) for ones that an agent started
*directly* with one of the commands in its own configuration, word for word.
Commands an agent runs for you usually go through a shell, and a shell is
never taken for a server. Codex also starts servers that no config file names,
such as plugin servers; a process counts as one of them only when Codex
started it in the same instant as the rest of that conversation's servers.

**Orphans.** A server whose agent has exited is an orphan: nothing can talk
to it anymore. mcp-janitor is sure of that when an earlier check saw the
server with its agent, and only those orphans are stopped by `--orphans`,
`--idle` and `watch`. A process that merely looks left behind (it runs a
configured server command and its parent is gone) is listed apart, and
stopped only when you pick it or name its PID.

**Which conversation (thread) started it.** Claude Code records the
conversation each of its processes runs in `~/.claude/sessions/<pid>.json`.
Codex thread IDs carry their creation time (they are UUIDv7), and Codex logs
when it opens an old thread again; a set of servers belongs to the thread
created or opened just before it started. Claude Desktop runs one copy of each
server for all its conversations.

**How long it has been idle.** An agent only calls MCP servers while it works
on the conversation, so a server cannot have been used after its
conversation was last active, nor after a newer copy of it replaced it.
Between checks, mcp-janitor also notes whether
a server used CPU or did any I/O. The idle time is measured from whichever is
later, so a server counts as idle only when both are quiet. A browser that a
server drives (Playwright, Puppeteer) does not count as the server being
busy. A server mcp-janitor has never seen before, with no conversation to go
by, shows `–` until the next check. Nothing is stopped for being idle before
it was checked twice: the first time `stop --idle` sees a server, it looks
again three seconds later.

**Memory.** The memory shown for a server is the working set (resident
memory) of the server and every process it started. Memory those processes
share with others counts in each of them, so the totals are an upper bound.

**Stopping.** Before it signals a process, mcp-janitor checks that the PID
still belongs to the process it listed. It stops the server and every process
the server started. On Linux and macOS they get SIGTERM, then SIGKILL after
three seconds; on Windows they are terminated.

## Agents

| Agent | MCP servers read from | Conversation names |
| --- | --- | --- |
| Codex: CLI, IDE extension, ChatGPT and Codex desktop apps | `~/.codex/config.toml`, plugins | Yes |
| Claude Code | `~/.claude.json`, `.mcp.json` of your projects, plugins | Yes |
| Claude Desktop | `claude_desktop_config.json`, extensions | Shared by all conversations |
| Cursor | `~/.cursor/mcp.json` | No |
| VS Code | `mcp.json` and `settings.json` of your user profile | No |
| Gemini CLI | `~/.gemini/settings.json` | No |

For any other agent, point `MCP_JANITOR_SERVERS` at a JSON file in the usual
`{ "mcpServers": { ... } }` form, and `MCP_JANITOR_AGENTS` at a regular
expression that matches the agent's command line.

Tested so far: Codex in the ChatGPT desktop app on Windows 11 and the Codex
app server 0.160, against real servers, the bundled `node_repl` among them;
the test suite runs real processes on Windows, Linux and macOS.
Cursor, VS Code and Gemini CLI are read from their documented config files but
have not been tried against a live install yet.

Conversation names come from files the agents keep for themselves, and an
agent update can change them. `mcp-janitor doctor` checks each source and says
which ones it cannot read. If something is missing or wrong on your machine,
please [open an issue](https://github.com/Rober1208/mcp-janitor/issues) with
the output of `mcp-janitor doctor` and `mcp-janitor --json`. They show your
file paths and conversation titles: replace any you would rather not post.

## Privacy

mcp-janitor only reads local files and the process list, and sends nothing
anywhere. Conversation titles appear only in your terminal. To measure
activity between checks it keeps a small state file: `%LOCALAPPDATA%\mcp-janitor`
on Windows, `~/Library/Application Support/mcp-janitor` on macOS and
`~/.local/state/mcp-janitor` on Linux.

## License

[MIT](LICENSE)
