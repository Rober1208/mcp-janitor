# mcp-janitor

[![CI](https://github.com/Rober1208/mcp-janitor/actions/workflows/ci.yml/badge.svg)](https://github.com/Rober1208/mcp-janitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) · **繁體中文**

看你的 AI agent 開著哪些 MCP server、各屬於哪個對話、閒置多久，再把用不到的關掉；
也可以設定閒置太久就自動關。

![mcp-janitor 列出三個 Codex 對話的 MCP，並關掉閒置的那些](docs/demo.png)

<sub>實際執行結果：ChatGPT 桌面版所用的 Codex app server，每隔兩分鐘開一個對話，共三個，全程沒有呼叫模型。
可用 [experiments/demo-codex.mjs](experiments/demo-codex.mjs) 重現。</sub>

Codex 每開一個對話，就把你設定的 MCP server 全部再啟動一份，而且一直留到 app 關閉為止。
寫這個工具的那台電腦上，ChatGPT 桌面版累積了 11 份：11 個 Playwright、其他每個也各 11 個，
共 5.6 GB，全部閒置。Claude Code 也是每個 session 各開一份。

```bash
npx github:Rober1208/mcp-janitor
```

沒有相依套件、不用設定：它直接讀各個 agent 本來就有的 MCP 設定。
支援 Windows、Linux（含 WSL）和 macOS，需要 Node.js 22 以上和 Git。想隨時直接打 `mcp-janitor`：

```bash
npm install -g github:Rober1208/mcp-janitor
```

## 用法

```bash
mcp-janitor                    # 依 agent 和對話列出 MCP server
mcp-janitor stop               # 從編號清單挑要關的
mcp-janitor stop 4180 5236     # 關掉這幾個（PID 見清單）
mcp-janitor stop --idle 1h     # 關掉閒置一小時以上的
mcp-janitor stop --orphans     # 關掉 agent 已經結束、被留下來的
mcp-janitor watch --idle 1h    # 持續檢查，閒置滿一小時就關
```

用 `--idle` 或 `--orphans` 時，`stop` 會先列出要關的項目並詢問；在腳本裡可加 `--yes` 跳過詢問，
或用 `--dry-run` 只看不關。任何指令都能用 `--server playwright` 縮小範圍，或用 `--agent` 加上
`codex`、`"claude code"`、`"claude desktop"`、`cursor`、`vscode`、`gemini` 其中之一。

**預設不會動到你正在用的對話。** 在每個 app 裡（ChatGPT app、VS Code、終端機裡的 Claude Code……），
你最後用的那個對話即使閒置也會保留，因為你可能隨時回來繼續。加上 `--include-latest` 才會一起關。

### MCP 被關掉之後，對話會怎樣

| Agent | MCP 被關掉之後 |
| --- | --- |
| Codex（CLI、IDE 擴充、ChatGPT 桌面版） | 對話還在，但呼叫那個 MCP 會失敗（"Transport closed"）。開新對話或重開 app 會重新啟動它。 |
| Claude Code | `/mcp` 裡會顯示失敗，可以在那裡重新連線。 |
| Claude Desktop | 重開 app 才會再啟動。 |

### 讓它一直跑

`watch` 每分鐘檢查一次（用 `--every` 調整），並記錄它關了什麼：

```text
$ mcp-janitor watch --idle 1h
Checking MCP servers every 1m. Servers idle for 1h or more will be stopped, except those of each app's latest conversation. Ctrl+C to quit.
[15:42] stopped 4 servers, 610 MB: playwright (Codex in ChatGPT app, idle 1h 2m), drawio (Codex in ChatGPT app, idle 1h 2m), ...
```

可以開在一個不關的終端機裡，或放到背景：

```bash
nohup mcp-janitor watch --idle 1h > ~/mcp-janitor.log 2>&1 &   # Linux、macOS
```

```powershell
Start-Process -WindowStyle Minimized mcp-janitor 'watch --idle 1h'   # Windows
```

## 運作方式

**怎麼判斷哪些程序是 MCP server。** mcp-janitor 先讀你替各 agent 設定的 MCP server，
再找由 agent *直接*啟動、指令和它自己設定裡的某一筆逐字相符的程序。agent 替你執行的指令通常會經過 shell，
而 shell 永遠不會被當成 MCP。Codex 還會啟動一些沒寫在設定檔裡的插件 server；
只有和同一個對話的其他 server 在同一瞬間啟動的程序，才會被算成其中之一。

**孤兒程序。** agent 已經結束、被留下來的 server 叫做孤兒（orphan），已經沒有任何東西能跟它溝通。
只有在之前的檢查中看過它跟著 agent 的，mcp-janitor 才確定它是孤兒，也只有這種會被 `--orphans`、`--idle`、`watch` 關掉。
只是「看起來」被留下的程序（跑的是設定裡的 server 指令、父程序已經不在）會分開列出，
只有你親自挑選或指定 PID 時才會關。

**怎麼知道是哪個對話開的。** Claude Code 會在 `~/.claude/sessions/<pid>.json` 記錄每個程序正在跑的對話。
Codex 的 thread ID 是 UUIDv7，本身帶有建立時間，重新打開舊對話時 Codex 也會寫進 log；
一組 server 屬於在它啟動前一刻建立或重新打開的那個對話。
Claude Desktop 則是所有對話共用同一份 server。

**怎麼算閒置多久。** agent 只會在處理對話的時候呼叫 MCP，所以對話最後一次有動靜之後，
它的 server 不可能再被用到。mcp-janitor 也會在每次檢查之間記錄 server 有沒有用到 CPU 或做 I/O。
閒置時間從兩者中較晚的那個算起，也就是兩邊都沒動靜才算閒置。
server 操控的瀏覽器（Playwright、Puppeteer）在背景的動作不算 server 在忙。
從沒看過、也對不到對話的 server 會顯示 `–`，下次檢查才有數字。
沒有被檢查過兩次的 server 不會因為閒置被關：`stop --idle` 第一次看到某個 server 時，會在三秒後再看一次。

**怎麼關。** 送出訊號前，mcp-janitor 會確認那個 PID 仍然是清單上的同一個程序。
Linux 和 macOS 先送 SIGTERM，三秒後還在才送 SIGKILL；Windows 直接結束程序。

## 支援的 Agent

| Agent | 從哪裡讀 MCP 設定 | 對話名稱 |
| --- | --- | --- |
| Codex：CLI、IDE 擴充、ChatGPT 與 Codex 桌面版 | `~/.codex/config.toml`、插件 | 有 |
| Claude Code | `~/.claude.json`、專案的 `.mcp.json`、插件 | 有 |
| Claude Desktop | `claude_desktop_config.json`、擴充 | 所有對話共用 |
| Cursor | `~/.cursor/mcp.json` | 無 |
| VS Code | 使用者設定的 `mcp.json` 和 `settings.json` | 無 |
| Gemini CLI | `~/.gemini/settings.json` | 無 |

其他 agent：把 `MCP_JANITOR_SERVERS` 指向一個 `{ "mcpServers": { ... } }` 格式的 JSON 檔，
再把 `MCP_JANITOR_AGENTS` 設成能比對到該 agent 指令列的正規表示式。

目前實測過：Windows 11 上 ChatGPT 桌面版裡的 Codex，以及 Codex app server 0.160，都是真的 MCP server；
測試套件會在 Windows、Linux、macOS 上跑真實程序。Cursor、VS Code、Gemini CLI 依官方文件的設定檔位置讀取，
但還沒在實際安裝上試過。如果你的電腦上漏抓或抓錯，歡迎
[開 issue](https://github.com/Rober1208/mcp-janitor/issues) 並附上 `mcp-janitor --json` 的輸出。
輸出裡有你的對話標題，不想公開的請先換掉。

## 隱私

mcp-janitor 只讀本機檔案和程序清單，不會傳送任何資料。對話標題只會顯示在你的終端機。
為了比較兩次檢查之間的活動，它會存一個小小的狀態檔：Windows 在 `%LOCALAPPDATA%\mcp-janitor`，
macOS 在 `~/Library/Application Support/mcp-janitor`，Linux 在 `~/.local/state/mcp-janitor`。

## 授權

[MIT](LICENSE)
