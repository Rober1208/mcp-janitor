# mcp-janitor

[![CI](https://github.com/Rober1208/mcp-janitor/actions/workflows/ci.yml/badge.svg)](https://github.com/Rober1208/mcp-janitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**English** · [繁體中文](README.zh-TW.md)

See which MCP servers your AI agents keep running, which conversation each
one belongs to and how long it has been idle. Then stop the ones you no
longer need, or let mcp-janitor stop them once they idle too long.

![mcp-janitor listing three Codex conversations and stopping the idle ones](docs/demo.png)

<sub>A real run: a Codex app server, the one the ChatGPT desktop app uses,
with three conversations opened two minutes apart. No model was called.
[experiments/demo-codex.mjs](experiments/demo-codex.mjs) reproduces it.</sub>

Codex starts a full set of your MCP servers for every conversation you open,
and keeps all of them until the app quits. On the machine this tool was
written on, the ChatGPT desktop app had collected 11 sets: 11 Playwright
servers, 11 of everything else, 5.6 GB, all idle. Claude Code starts a set
for every session in the same way.

```bash
npx github:Rober1208/mcp-janitor
```

No dependencies, nothing to configure: it reads the MCP settings your agents
already have. Works on Windows, Linux (including WSL) and macOS with Node.js
22 or later and Git. To have the `mcp-janitor` command at hand:

```bash
npm install -g github:Rober1208/mcp-janitor
```

## Usage

```bash
mcp-janitor                    # list MCP servers by agent and conversation
mcp-janitor stop               # pick servers to stop from a numbered list
mcp-janitor stop 4180 5236     # stop these servers (PIDs from the list)
mcp-janitor stop --idle 1h     # stop servers idle for an hour or more
mcp-janitor stop --orphans     # stop servers left running by an agent that exited
mcp-janitor watch --idle 1h    # keep checking, stop servers once idle that long
```

With `--idle` or `--orphans`, `stop` lists what it is about to stop and asks
first; add `--yes` to skip the question in scripts, or `--dry-run` to only
look. Narrow any command with `--server playwright` or `--agent` followed by
`codex`, `"claude code"`, `"claude desktop"`, `cursor`, `vscode` or `gemini`.

**Your current conversation is safe by default.** In each app (the ChatGPT
app, VS Code, Claude Code in a terminal, ...) the conversation you used last
keeps its servers even when idle, because you may come back to it any minute.
Add `--include-latest` to stop those too.

### What happens to a conversation whose servers you stop

| Agent | After a server is stopped |
| --- | --- |
| Codex (CLI, IDE extension, ChatGPT desktop app) | The conversation keeps running, but calls to that server fail ("Transport closed"). A new conversation, or restarting the app, starts the server again. |
| Claude Code | The server shows as failed in `/mcp`, where you can reconnect it. |
| Claude Desktop | Restart the app to start the server again. |

### Keep it running

`watch` checks every minute (`--every` changes that) and logs what it stops:

```text
$ mcp-janitor watch --idle 1h
Checking MCP servers every 1m. Servers idle for 1h or more will be stopped, except those of each app's latest conversation. Ctrl+C to quit.
[15:42] stopped 4 servers, 610 MB: playwright (Codex in ChatGPT app, idle 1h 2m), drawio (Codex in ChatGPT app, idle 1h 2m), ...
```

Start it in a terminal you keep open, or in the background:

```bash
nohup mcp-janitor watch --idle 1h > ~/mcp-janitor.log 2>&1 &   # Linux, macOS
```

```powershell
Start-Process -WindowStyle Minimized mcp-janitor 'watch --idle 1h'   # Windows
```

## How it works

**Which processes are MCP servers.** mcp-janitor reads the MCP servers you
configured for each agent, then looks for processes that an agent started
*directly* with one of the commands in its own configuration, word for word.
Commands an agent runs for you usually go through a shell, and a shell is
never taken for a server. Codex also starts plugin servers that no config
file names; a process counts as one of them only when Codex started it in
the same instant as the rest of that conversation's servers.

**Orphans.** A server whose agent has exited is an orphan: nothing can talk
to it anymore. mcp-janitor is sure of that when an earlier check saw the
server with its agent, and only those orphans are stopped by `--orphans`,
`--idle` and `watch`. A process that merely looks left behind (it runs a
configured server command and its parent is gone) is listed apart, and
stopped only when you pick it or name its PID.

**Which conversation started it.** Claude Code records the conversation each
of its processes runs in `~/.claude/sessions/<pid>.json`. Codex thread IDs
carry their creation time (they are UUIDv7), and Codex logs when it opens an
old thread again; a set of servers belongs to the thread created or opened
just before it started. Claude Desktop runs one copy of each server for all
its conversations.

**How long it has been idle.** An agent only calls MCP servers while it works
on the conversation, so a server cannot have been used after its
conversation was last active. Between checks, mcp-janitor also notes whether
a server used CPU or did any I/O. The idle time is measured from whichever is
later, so a server counts as idle only when both are quiet. A browser that a
server drives (Playwright, Puppeteer) does not count as the server being
busy. A server mcp-janitor has never seen before, with no conversation to go
by, shows `–` until the next check. Nothing is stopped for being idle before
it was checked twice: the first time `stop --idle` sees a server, it looks
again three seconds later.

**Stopping.** Before it signals a process, mcp-janitor checks that the PID
still belongs to the process it listed. On Linux and macOS a server gets
SIGTERM, then SIGKILL after three seconds; on Windows it is terminated.

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

Tested so far: Codex in the ChatGPT desktop app on Windows 11, and the Codex
app server 0.160, against real servers; the test suite runs real processes on
Windows, Linux and macOS. Cursor, VS Code and Gemini CLI are read from their
documented config files but have not been tried against a live install yet.
If something is missing or wrong on your machine, please
[open an issue](https://github.com/Rober1208/mcp-janitor/issues) with the
output of `mcp-janitor --json`.

## Privacy

mcp-janitor only reads local files and the process list, and sends nothing
anywhere. Conversation titles appear only in your terminal. To measure
activity between checks it keeps a small state file: `%LOCALAPPDATA%\mcp-janitor`
on Windows, `~/Library/Application Support/mcp-janitor` on macOS and
`~/.local/state/mcp-janitor` on Linux.

## Related

[treecap](https://github.com/Rober1208/treecap) runs a command with a memory
cap on its whole process tree, and stops everything it started when it ends.

## License

[MIT](LICENSE)
