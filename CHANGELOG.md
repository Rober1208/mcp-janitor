# Changelog

## 0.1.0

First release.

- `mcp-janitor` lists the MCP servers that Codex, Claude Code, Claude Desktop,
  Cursor, VS Code and Gemini CLI keep running, grouped by agent and by the
  conversation that started them, with memory use and idle time.
- `mcp-janitor stop` lets you pick servers from a numbered list, or stops them
  by PID, by idle time (`--idle 1h`) or because their agent has exited
  (`--orphans`). It asks before stopping.
- `mcp-janitor watch --idle 1h` keeps checking and stops servers once they
  have been idle that long.
- Each app's latest conversation keeps its servers unless you add
  `--include-latest`.
- Windows, Linux (including WSL) and macOS, Node.js 22 or later, no
  dependencies.
