# Changelog

## Unreleased

- In the conversation you used last, only the newest copy of each server is
  kept. When an agent starts a conversation's servers again while the old
  copies keep running, as Codex does on every turn of some tasks
  ([openai/codex#38754](https://github.com/openai/codex/issues/38754)), the
  old copies are listed as `(replaced)`, count as idle from the moment they
  were replaced however busy the conversation is, and `stop --idle` and
  `watch` stop them. `--json` has a new `replaced` field.

## 0.1.2

- An option that would do nothing is an error now, instead of being ignored:
  `--every` goes with `watch`, `--json` with the list, `--include-latest`
  with `--idle`, and PIDs with `stop`, without `--idle`, `--orphans`,
  `--server` or `--agent`. `mcp-janitor 4180` says to use
  `mcp-janitor stop 4180`.
- Stopping takes one look at the process list fewer: waiting for servers to
  exit only asks whether their PIDs are gone. This saves about half a second
  on Windows, and on Linux and macOS no longer reads the whole process list five
  times a second while a server takes its time to exit.

## 0.1.1

First release.

- `mcp-janitor` lists the MCP servers that Codex, Claude Code, Claude Desktop,
  Cursor, VS Code and Gemini CLI keep running, grouped by agent and by the
  conversation that started them, with memory use and idle time.
- `mcp-janitor stop` lets you pick servers from a numbered list, or stops them
  by PID, by idle time (`--idle 1h`) or because their agent has exited
  (`--orphans`). It asks before stopping.
- `mcp-janitor watch --idle 1h` keeps checking and stops servers once they
  have been idle that long.
- The conversation you used last keeps its servers unless you add
  `--include-latest`: in each Codex process, and for Claude Code, which can
  reconnect a stopped server, in each place it runs.
- `mcp-janitor doctor` checks what it can read on this machine: the process
  list, the agents, their MCP settings, the files that name conversations and
  its state file.
- Only your own processes, started directly by an agent with a command from
  its own configuration matched word for word, count as its servers. Orphans
  are stopped by `--orphans`, `--idle` and `watch` only when an earlier check
  saw them with their agent; nothing is stopped for being idle before two
  checks.
- Windows, Linux (including WSL) and macOS, Node.js 22 or later, no
  dependencies.
