# ROSTUM - AI Usage & Cost Monitor — user guide

[![tests](https://github.com/eng3alaa/ROSTUM-ai-usage-dashboard/actions/workflows/tests.yml/badge.svg)](https://github.com/eng3alaa/ROSTUM-ai-usage-dashboard/actions/workflows/tests.yml)

One HTML file that shows how much you use AI — tokens, messages and the API-equivalent cost — across every platform you touch: Claude Code, ChatGPT, Gemini, Copilot, Cursor, local models, cloud endpoints and more. It runs entirely in your browser from `AI Usage Dashboard.html`; nothing is installed and nothing is uploaded anywhere except the API calls you explicitly trigger with your own keys.

Every number on the page is labeled with where it came from and how trustworthy it is. The dashboard never guesses silently.

A styled, printable HTML version of this guide is at [`docs/user-guide.html`](docs/user-guide.html) (double-click to open; same content, light/dark aware).

---

## 1. Quick start

1. Double-click `AI Usage Dashboard.html`. It opens as a `file://` page — no server needed.
2. Use **Chrome or Edge** for the full experience. Only the folder picker needs the File System Access API; dropping files works everywhere. In other browsers the folder buttons fall back to the classic folder chooser automatically. ZIP imports and Bedrock signing rely on `DecompressionStream` and WebCrypto, which current Chromium browsers provide on `file://` pages.
3. In the **accounts hub** at the top, click **Connect** on a card and follow its instructions. The fastest wins:
   - **Local collector (automatic)** — the fastest path for every coding tool and local runner that writes logs: run `node docs/tools/ai-usage-collector.mjs` once and every tool it finds on this machine connects by itself, no folder picking — Claude Code and Cowork, Codex CLI, Copilot CLI, Gemini CLI, Continue, Cline, Roo, Kilo Code, Junie, OpenCode, Goose, Devin CLI, Amp, Zed, LM Studio, Ollama and Jan (see [Automatic mode](#automatic-mode)).
   - **Claude Code / Desktop** — pick your `.claude` folder and, for **Cowork** (the desktop app's agent sessions), the Claude app's data folder — or let the collector find both. Exact tokens for every session.
   - **Anthropic API / OpenAI API** — paste an Admin key: exact usage plus what you were actually billed.
   - **Poe** — paste a Poe API key: exact tokens per bot and Poe's own dollar figure per query.
   - Any coding tool that writes logs (Codex CLI, Copilot CLI, Cline, Continue, Gemini CLI, Roo, Kilo Code, Aider, Junie, OpenCode, Goose, Devin CLI, Amp, Zed) — pick its log folder. Cursor exports a usage CSV instead; drop it on Imports.
4. Folder choices, imported data and settings are remembered in the browser's storage for this file; API keys only if you tick **Remember key on this computer**, and cloud tokens never. Re-open the page any time; folder sources re-scan on demand (or on a timer with **Auto re-scan**).

The page is a single static file. Copy it anywhere, keep it on a USB stick, or open it in a private window if you want nothing remembered.

---

<a id="automatic-mode"></a>
## 1b. Automatic mode: the local collector

A `file://` page cannot read your disk on its own, which is why every folder-based card asks for a folder pick. The **local collector** removes that step. It is an optional, zero-dependency Node script (Node 20 or newer) that finds the standard log folders of the AI tools installed on this machine and serves them, read-only, to the dashboard on `127.0.0.1`. Without it nothing changes; with it, every tool it finds shows up connected and stays current by itself.

**Start it**

```bash
node docs/tools/ai-usage-collector.mjs
```

It prints one line per tool (found or not, file count, size, watch mode), then the token and a ready-made URL:

```
Token: <64 hex characters>
Open the dashboard: http://127.0.0.1:11436/?token=<token>
listening on http://127.0.0.1:11436
```

The token is created on the first run and kept in `~/.ai-usage/collector.token` (`%USERPROFILE%\.ai-usage\collector.token` on Windows); later runs reuse it. Leave the collector running in that terminal; Ctrl+C stops it.

**Use it — two ways**

1. **Open the printed URL.** The collector serves the dashboard itself, so page and collector share one origin. The token is taken from the URL into the **Local collector (automatic)** card (first card in Coding tools) and removed from the address bar; click **Validate & connect** on that card — nothing to paste.
2. **Keep your `file://` copy.** Open the **Local collector (automatic)** card, paste the token from the terminal (or from the token file), tick **Remember token on this computer** if you want it kept, and click **Validate & connect**. The Collector URL field defaults to `http://127.0.0.1:11436`; if you started the collector with `--port`, change it to the printed URL.

Either way, each tool the collector finds connects under its own card — Claude Code / Desktop, OpenAI Codex CLI, GitHub Copilot CLI and so on — labelled **N files · via collector**, with exactly the rows, project rows and re-scan cache a folder pick would produce. The collector card shows `N tools · M files · checked <time>` and a table of every tool it looked for: root folder, file count (or *not found* / *found, nothing to read*) and the newest change.

**What it discovers**

| Tool id | Card | Folder(s) looked for |
|---|---|---|
| `local` | Claude Code / Desktop | `~/.claude` (`CLAUDE_CONFIG_DIR` when set) **plus every Claude desktop data folder that holds `local-agent-mode-sessions`** (Cowork): `%APPDATA%\Claude`, `%LOCALAPPDATA%\Claude-Data\<package>` (Microsoft Store build), `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude` (older Store builds), `%LOCALAPPDATA%\Claude-3p` (3P edition); `~/Library/Application Support/Claude` and `…/Claude-3p`; `~/.config/Claude` and `…/Claude-3p` — each one that exists is its own root, and the paths it serves start with the root's folder name |
| `codex` | OpenAI Codex CLI | `~/.codex/sessions` and `~/.codex/archived_sessions` (`CODEX_HOME` when set) — only those two; the rest of `~/.codex` is never read |
| `copilot-cli` | GitHub Copilot CLI (logs) | `~/.copilot` |
| `gemini-cli` | Gemini CLI | `~/.gemini` (`GEMINI_CLI_HOME` when set) |
| `continue` | Continue.dev | `~/.continue` |
| `cline` | Cline (VS Code) | `globalStorage/saoudrizwan.claude-dev` under the user folder of VS Code, VS Code Insiders, Cursor, Windsurf or VSCodium — the first that exists |
| `roo` | Roo Code (VS Code) | `…/globalStorage/rooveterinaryinc.roo-cline`, same editors |
| `kilo` | Kilo Code (VS Code) | `…/globalStorage/kilocode.kilo-code`, same editors |
| `junie` | JetBrains AI Assistant / Junie | `~/.junie` plus every `matterhorn` folder under the JetBrains cache (`%LOCALAPPDATA%\JetBrains`, `~/Library/Caches/JetBrains`, `~/.cache/JetBrains`) |
| `lmstudio` | LM Studio | `~/.lmstudio/conversations` or `~/.cache/lm-studio/conversations` |
| `ollama` | Ollama | `~/.ai-usage` (the usage logger's folder, §9) and the desktop app folder (`%LOCALAPPDATA%\Ollama`, `~/Library/Application Support/Ollama`, `~/.ollama`) |
| `jan` | Jan | `%APPDATA%\Jan\data`, `~/Library/Application Support/Jan/data` or `~/.local/share/Jan/data` |
| `opencode` | OpenCode | `OPENCODE_DATA_DIR` or `OPENCODE_HOME` when set, else `~/.local/share/opencode` (`XDG_DATA_HOME`; on Windows `%USERPROFILE%\.local\share\opencode`, then `%APPDATA%\opencode`) — the first that exists; its `snapshot`, `bin`, `log` and `cache` folders are never walked |
| `goose` | Goose (Block) | `%APPDATA%\Block\goose\sessions` (Windows) or `~/.local/share/goose/sessions` |
| `devin` | Devin CLI (Cognition) | `DEVIN_DATA_DIR` when set, else `%APPDATA%\devin\cli`, `~/Library/Application Support/devin/cli` or `~/.local/share/devin/cli` |
| `amp` | Amp (Sourcegraph) | the `threads` folder under `AMP_DATA_DIR`, `~/.local/share/amp` or (Windows) `%LOCALAPPDATA%\amp` — the first that exists |
| `zed` | Zed (Agent Panel) | `%LOCALAPPDATA%\Zed\threads`, `~/Library/Application Support/Zed/threads` or `~/.local/share/zed/threads` — the one tool whose file the collector can decode for the page (`threads.db` holds zstd-compressed rows; needs Node 22.15 or newer) |
| `copilot-vscode` | GitHub Copilot Chat (VS Code OTel file) | the folder of `COPILOT_OTEL_FILE_EXPORTER_PATH` when that variable is set; the outfile has no fixed location, so otherwise only with `--root copilot-vscode=<folder>` |
| `aider`, `tgwebui` | Aider, text-generation-webui | no fixed folder — only with `--root` |

A tool is *found* when its folder exists. *Found, nothing to read* means the folder is there but holds no file the card's parser recognises — normal for `ollama` when `~/.ai-usage` holds only the token file, or for a tool that has not logged anything yet.

Flags: `--port <n>` (or `COLLECTOR_PORT`; default 11436; `0` picks a free port and prints it), `--root <id>=<path>` (use that folder for a tool instead of auto-discovery; repeatable; the only way to add `aider` or `tgwebui`, and `copilot-vscode` without its environment variable), `--no-<id>` (skip a tool, e.g. `--no-ollama`), `--html <path>` (which dashboard file to serve at `/`), `--help`.

**Automatic refresh**

- The collector watches every found folder (`fs.watch`); a change marks that tool for a re-walk on its next status request. Where recursive watching is unavailable (some network shares, old kernels) that tool is re-walked when its counts are older than 30 s instead — the startup table says `watch polling`.
- While the collector card is connected, the dashboard asks it for status **every 60 s** (skipped while the tab is hidden) and re-reads only the tools whose file count or newest change moved; unchanged files hit the scan cache, so a tick with nothing new costs one small request. **Refresh all** runs one such check now; a tool card's **Re-scan** / **Sync** goes through the collector while it feeds that card.
- After a reload the watch resumes by itself only if the token was remembered; otherwise the card says *Reconnect* and the tools' stored data stays on screen until you paste the token again.
- **Disconnect** on the collector card forgets the token and stops the watch; the tools keep their entries and data (their cards keep the *via collector* label until the next folder pick or Clear stored data). Disconnecting a tool's own card while the collector feeds it takes that tool out of the collector's reads (its row in the table says *disconnected*) until you click **Validate & connect** on the collector card again.

**Security**

- Binds `127.0.0.1` only; nothing is reachable from other machines.
- Every `/api/*` request needs the token in the `Authorization: Bearer …` header, otherwise `401` — a `?token=` query is refused on the API (the `?token=` in the printed URL only pre-fills the card and is removed from the address bar). Without the token any web page open in your browser could read the machine's AI transcripts through the port; the origin is deliberately not the gate (a `file://` page and a sandboxed iframe both have a `null` origin). Only `Host: 127.0.0.1`, `localhost` or `[::1]` is answered (anything else gets `421`).
- Read-only, and only inside the discovered roots (or the `--root` folders): paths with `..`, absolute paths and symbolic links are refused. Only usage-log file types are listed or served (`.jsonl`, `.json`, `.md`, `.sqlite`, `.db`, `.csv`, `.txt`), and never a file whose name says credential, oauth, token, secret, password or api key, nor `.env*`, `auth.json`, `settings.json`, `config.json`, `mcp.json` or `.claude.json`; the token file is never listed or served. The walk skips `node_modules`, `.git` and `checkpoints`, a tool's own non-log folders (OpenCode's `snapshot`, `bin`, `log`, `cache`) and, under a Cowork root, the files a session handled (`outputs`, `uploads`, `uploads-tmp`, `.project-cache`, `session-env`, `backups`) — those are never listed or served either.
- The collector logs one line per request (method, path, status, bytes) — never file contents, never the token. The page sends the token only to the Collector URL on the card, as a header — never in a request URL, never into the page's HTML — and stores it only with **Remember token on this computer**. Every request the page makes times out after 30 s.
- `GET /api/file?…&decode=zstd` hands the page a Zed `threads.db` with its zstd rows decoded (one JSON line per thread) when the browser cannot decompress zstd itself. It is offered for the `zed` tool only, gated and path-checked like every other file request, and the decoded bytes are never written to disk.
- What the page keeps is the same as after a folder pick: aggregated tokens per day / platform / model. Raw log files stream through the page's memory while they are parsed, exactly as with a folder pick, and are not stored.

**Two copies, two storages.** The page the collector serves (`http://127.0.0.1:11436`) and your `file://` copy are different origins, so each keeps its own browser storage: folder choices, imports, remembered keys and settings do not carry over between them. Pick one and stick with it (or export a CSV backup before switching).

**Troubleshooting**

| Symptom | What to do |
|---|---|
| Card says *Not running at http://127.0.0.1:11436* | Start it: `node docs/tools/ai-usage-collector.mjs` (Node 20+). If you used `--port`, put that URL in the card's Collector URL field. |
| *Token rejected* | Copy the token from the terminal, or from `~/.ai-usage/collector.token`, and paste it again. Deleting that file makes the next start mint a new one. |
| A tool is listed *found, nothing to read* | The folder exists but none of its files match what the card parses (§3 says what each tool must write) — the tool has not logged yet, or it logs elsewhere: point the collector there with `--root <id>=<path>`. |
| `port 11436 is already in use` | Another collector (or something else) has the port: stop it, or start with `--port <n>` and change the card's Collector URL. |
| Files change on disk but the dashboard lags | Ticks run every 60 s while the tab is visible; **Refresh all** checks now. Under `watch polling` the collector itself re-walks at most every 30 s. |

---

## 2. The accounts hub

Cards are grouped the way you use them (85 cards):

| Group | Cards (as titled in the app) |
|---|---|
| Coding tools (29) | Local collector (automatic), Claude Code / Desktop, GitHub Copilot, OpenAI Codex CLI, Gemini CLI, GitHub Copilot CLI (logs), Continue.dev, Cline (VS Code), Roo Code (VS Code), Aider, JetBrains AI Assistant / Junie, OpenCode, Goose (Block), Devin CLI (Cognition), Kilo Code (VS Code), Amp (Sourcegraph), Zed (Agent Panel), GitHub Copilot Chat (VS Code OTel file), Cursor, Sourcegraph Cody (Enterprise), Amazon Q / Kiro, Windsurf (Codeium), v0 (Vercel), Tabnine, Augment Code, Gemini Code Assist, Lovable, Bolt.new (StackBlitz), Replit Agent |
| Chat apps (18) | Claude Enterprise (org analytics), ChatGPT (web + desktop), Claude.ai (web + desktop), Grok (grok.com / X), Microsoft Copilot (consumer), Perplexity (app), Meta AI, DeepSeek chat, Mistral Vibe (Le Chat), Character.ai, Poe (poe.com), Qwen Chat (chat.qwen.ai), Kimi (kimi.com), Z.ai chat / ChatGLM, You.com, NotebookLM / Gemini Notebook, Microsoft 365 Copilot (work), Imports |
| Local runners (8) | LM Studio, Ollama, LocalAI, vLLM, llama.cpp (llama-server), GPT4All, Jan, text-generation-webui |
| API vendors (27) | Anthropic API, OpenAI API, Gemini (Google AI), OpenRouter, Groq, Replicate, Mistral (La Plateforme), Cohere, Together AI, Hugging Face (Inference Providers), xAI API (Grok models), Perplexity API (Sonar), Fireworks AI, DeepSeek API, OpenAI-compatible server (any base URL), DeepInfra, Moonshot / Kimi Open Platform, Cerebras Inference, Nebius Token Factory (ex AI Studio), Meta Model API (ex Llama API), Novita AI, Alibaba Cloud Model Studio / DashScope, Z.ai / Zhipu GLM API, MiniMax Open Platform, SambaNova Cloud, NVIDIA NIM API catalog, Baseten |
| Cloud (3) | Azure OpenAI (Foundry), Google Vertex AI, AWS Bedrock |

**What the card tells you**

- **Dot**: green = connected, amber = needs attention (an error, or the last sync is more than 7 days old), gray = not connected.
- **Quality badge** — the honesty label, shown first on every card except the six original cards (Claude Code, Anthropic, OpenAI, Gemini, GitHub Copilot, OpenRouter) and Imports, whose own panels carry their own wording (`billed usage`, `key validation`, `best-effort usage`, `credits + activity`):
  - `exact` — token counts come from the tool or vendor itself.
  - `estimated` — tokens are estimated from text (about 4 characters per token) because the source keeps no counts. Rows carry an `est.` mark everywhere they appear.
  - `validate-only` — the card can verify your key and show what the account can reach, but the vendor offers no usage history to a local page. Spend lives on the vendor's own usage page (linked from the card).
  - `no data` — there is no data path at all from a local page; the card explains why and links to the vendor's usage page.
- **Buttons**: **Connect / Manage** opens the card's details; **Sync** re-reads the source; **Disconnect** forgets the connection (and asks whether to keep or delete the data it loaded). Export-based cards (the chat exports, Cursor, Cody) show **Manage** and **Import file…** (which opens the Imports drop zone) — they have no key to connect or disconnect. In the Chat apps group, Claude Enterprise and Poe take a key like an API card, and Imports has no Sync button. No-data cards show **Details** and a vendor usage link.
- **Click a card** (or press Enter on it) to **drill down**: the whole dashboard filters to that platform and a `drilled: … — clear` chip undoes it. No-data cards open their Details instead.
- The **subtitle** under the page title lists the data span, the connected sources and when the page last rendered.

**Tidying the hub**

- **✕** on a card hides it. A "N hidden — show" chip brings everything back. A hidden card un-hides itself when it becomes connected.
- Each group header collapses with **▾**.
- With more than 12 visible cards a **Search accounts…** box appears.
- **Show legacy source cards** reveals the older per-source panels below the charts (the same panels the Manage dialog shows). Cards that read both a server and a folder (Ollama, Jan, text-generation-webui) show two status lines and a **Re-scan** button for the folder half.
- Keyboard: cards are focusable; hiding, collapsing and closing a dialog keep focus where you were.

---

## 3. Connecting each source

Every card carries the full instructions (paths, what to paste, what the numbers mean). This is the short version; the "Quality" column uses the badge words the app shows.

### Coding tools

Every folder-based row below can also be fed by the **local collector** (§1b) — then you provide nothing (Aider needs a `--root`): the tool's card connects by itself with the label *via collector*.

| Card | You provide | Quality | Notes |
|---|---|---|---|
| Claude Code / Desktop | the `.claude` folder (`%USERPROFILE%\.claude` / `~/.claude`) — or nothing, with the local collector running | exact (no badge) | Per-message input, output, cache-write and cache-read tokens from `projects/**/*.jsonl`; projects table; re-scan only reads changed files. |
| GitHub Copilot | a GitHub PAT | best-effort usage | GitHub's billing usage for Copilot: premium-request counts and net billed amounts — never tokens. |
| OpenAI Codex CLI | `~/.codex` (sessions + archived_sessions) | exact | Per-turn usage from `rollout-*.jsonl`; resumed sessions and repeated snapshots never double count. |
| Gemini CLI | `~/.gemini` or `~/.gemini/tmp` | exact | `chats/session-*.json`. The CLI prunes sessions after 30 days / 50 files by default — a re-scan counts only what is still on disk. |
| GitHub Copilot CLI (logs) | `~/.copilot` | exact | `session-state/<id>/events.jsonl`. Copilot is flat-rate: the dollars shown are the API list-price equivalent, not your bill. |
| Continue.dev | `~/.continue` | exact | `dev_data/<version>/tokensGenerated.jsonl`. Requests served by a local runner (Ollama, LM Studio, …) are $0. |
| Cline (VS Code) / Roo Code (VS Code) / Kilo Code (VS Code) | the extension's `globalStorage/…/tasks` folder (`saoudrizwan.claude-dev`, `rooveterinaryinc.roo-cline`, `kilocode.kilo-code`) | exact | `ui_messages.json` per task; model (and local-provider $0) from `task_metadata.json` when present. Kilo is a Roo fork with the same files and its own card; its layout was confirmed from source, not on real files. |
| Aider | a project folder (or a parent holding several repos) | estimated | `.aider.chat.history.md` prints rounded token lines; models on `ollama_chat/` etc. are $0. For exact numbers run aider with `--analytics-log`. |
| JetBrains AI Assistant / Junie | the IDE's `matterhorn/.matterhorn/events` folder or `~/.junie/sessions` | estimated | Junie agent runs carry exact counts; regular AI Assistant chat writes no token log, so totals understate. |
| OpenCode | the OpenCode data folder (`%USERPROFILE%\.local\share\opencode`, `~/.local/share/opencode`) | exact | `opencode.db` is read in the page (the 1.x `message` table and the ≥ 2.0.3 `session_message` table) plus legacy `storage/message/**/msg_*.json`; per-message input / output / reasoning / cache tokens, model and provider; local providers are $0. Quit OpenCode first — rows still in the `-wal` sidecar are not read. Source-based: the DB on the research machine held 0 rows. |
| Goose (Block) | the `goose/sessions` folder | exact | `sessions.db`: per-session accumulated input / output tokens, provider and model — session-level only, so a whole session lands on its start day, no cache split, no cost. Source-based, not yet verified on real files. |
| Devin CLI (Cognition) | the `devin/cli` folder | exact | `sessions.db`: input, cache-read and cache-write tokens per message node (output only where a node records one, so output understates); a retried request counts once. Devin bills ACUs, kept in the scan metadata — never turned into dollars. Source-based. |
| Amp (Sourcegraph) | the amp data folder or its `threads` folder | exact | `threads/**/*.json` usageLedger events: model, time, tokens, credits (credits summed in the metadata, never dollars). Threads run in cloud orbs are not on disk. Source-based; the Windows path is unverified. |
| Zed (Agent Panel) | the Zed `threads` folder | exact | `threads.db`: one zstd-compressed JSON per thread with the thread's cumulative tokens and model; a whole thread lands on its `updated_at` day. The page decompresses it when the browser's `DecompressionStream` knows zstd; otherwise the card needs the local collector (Node 22.15 or newer) — a folder pick without it counts the file as unreadable, never as zero usage. Source-based. |
| GitHub Copilot Chat (VS Code OTel file) | the folder of the OTel outfile — exact **only** with the exporter on: `github.copilot.chat.otel.enabled: true`, `exporterType: "file"`, `outfile: "<path>"` (or `COPILOT_OTEL_ENABLED` / `COPILOT_OTEL_FILE_EXPORTER_PATH`) | exact | `gen_ai.usage.*` per chat span (input booked net of cache reads, reasoning inside output, session totals never counted on top). Without the exporter VS Code keeps no token data. Flat-rate: the $ shown is the list-price equivalent. |
| Cursor | the usage-events CSV from cursor.com/dashboard → Usage → Export CSV (drop it on Imports, or use the card's **Import file…**) | exact | The card is the front door to the CSV importer: tokens and Cost per day and model; a re-import replaces the days the export covers. No folder pick, because Cursor's local `state.vscdb` carries no real token counts; the team Admin API is CORS-blocked, so it would need a local proxy (not built). |
| Sourcegraph Cody (Enterprise) | the JSON from Cody's chat History → Export | estimated | No tokens and no model per turn in the export, so tokens come from text. Cody Free and Pro ended 2025-07 — Enterprise only. Layout from the 2023 release notes; source-based. |
| Amazon Q / Kiro, Windsurf (Codeium), v0 (Vercel), Tabnine, Augment Code, Gemini Code Assist, Lovable, Bolt.new (StackBlitz), Replit Agent | — | no data | Credits- or dollars-only products, cookie-bound dashboards, admin-only or CORS-closed APIs; each card says exactly why and links to the vendor's usage page. v0's credits endpoint could be read through the collector as a proxy in a later version — the card says so. |

### Chat apps (data exports)

Consumer chat products never expose usage to a local page (their endpoints are cookie-bound and blocked cross-origin), so these cards work from **your own data export**. Tokens are estimated from the text.

| Card | Where the export comes from |
|---|---|
| ChatGPT (web + desktop) | chatgpt.com → Settings → Data controls → Export data → drop the ZIP or `conversations.json` |
| Claude.ai (web + desktop) | claude.ai → Settings → Privacy → Export data → ZIP or `conversations.json` |
| Grok (grok.com / X) | grok.com → Settings → Data → Export Data → one JSON |
| Microsoft Copilot (consumer) | account.microsoft.com/privacy → Copilot activity history → Export (CSV) |
| Perplexity (app) | Settings → Account → Request data export → ZIP or its JSON threads |
| Meta AI | Accounts Center → Download your information → Meta AI (JSON) → `message_*.json` |
| DeepSeek chat | chat.deepseek.com → Settings → Data → Export data → ZIP, or a JSON with "deepseek" in its name |
| Mistral Vibe (Le Chat) | admin.mistral.ai → Account → Export → one JSON (`conversations[].model` + `messages[].role/content`; the layout is known from a third-party guide, so the importer sniffs it) |
| Character.ai | Profile Settings → Account → Manage Account & Data → Export Data → an emailed ZIP after 3–4 weeks (link valid 7 days); drop it as-is or its message files, with "character" in the name. The export names no model (`character.ai`, $0 unless you add a price row) |

Chat exports are priced as if the conversations had run on the API; pick the assumed Claude model in the Imports card. **Gemini web app** history comes through Google Takeout (see Imports).

**Claude Enterprise (org analytics)** sits in the Chat apps group but takes an Analytics API key (Enterprise orgs only; no data before 2026-01-01): exact org-wide usage and cost under its own platform, so it never mixes with your local Claude Code rows.

**Poe (poe.com)** is the one consumer chat app with a real usage API: paste a key from poe.com/api/keys and the card reads the points history — one row per UTC day and bot with exact tokens (parsed from the cost breakdown), Poe's own `cost_usd` into Actual billed, the balance in the label. Poe keeps 30 days, so sync at least monthly; whether `cost_usd` is your real bill or a nominal value of points is unverified without a live key, and the card says so.

**Qwen Chat, Kimi (kimi.com), Z.ai chat / ChatGLM, You.com, NotebookLM / Gemini Notebook, Microsoft 365 Copilot (work)** are no-data cards: no export, no local files, no usage API a local page can call — each says why (API usage of the same vendors is the Alibaba Model Studio, Moonshot and Z.ai cards under API vendors).

### Local runners

Models on your own hardware are always **$0** — gated by platform, so a hosted model that shares a name (say, Llama on Groq) is still priced.

| Card | How it reads usage | Quality |
|---|---|---|
| LM Studio | `~/.lmstudio/conversations/*.conversation.json` | exact |
| Ollama | live check of `http://localhost:11434` plus, for history, the one-file proxy `docs/tools/ollama-usage-logger.mjs` (exact per-request JSONL) and/or the desktop app's `db.sqlite` chats (estimated; close the Ollama app first — the `-wal` sidecar is not read) | exact / estimated |
| LocalAI | `GET /api/usage` daily buckets on every sync (history is an in-memory ring buffer unless the server runs with auth) | exact |
| vLLM, llama.cpp (llama-server) | polls `/metrics` counters while the page is open and books the difference — not full history; llama.cpp needs `--metrics` | exact (while open) |
| GPT4All | validates the local API server | validate-only |
| Jan | validates the server; `threads/*/messages.jsonl` from the data folder (output counts recorded, input estimated) | estimated |
| text-generation-webui | validates the server; `user_data/logs/chat/**` and `logs/instruct/**` | estimated |

### API vendors

| Card | You provide | What you get |
|---|---|---|
| Anthropic API | Admin key (`sk-ant-admin…`) + how far back (30 / 90 / 365 days) | `billed usage`: exact usage and billed cost from the Admin usage & cost reports |
| OpenAI API | Admin key + how far back | `billed usage`: exact usage and billed cost |
| OpenRouter | API key | `credits + activity`: exact activity rows and billed credits |
| Fireworks AI | API key + account id | exact tokens (serverless), accelerator-hours for dedicated deployments, billed USD |
| DeepSeek API | API key (balance check) + the monthly usage ZIP from platform.deepseek.com | exact tokens + billed amounts from the export |
| Gemini (Google AI) | API key | `key validation` only; usage history comes from a Cloud Billing CSV via Imports |
| Groq, Mistral (La Plateforme), Cohere, Together AI, Hugging Face (Inference Providers), xAI API (Grok models), Perplexity API (Sonar) | API key | validate-only — no usage endpoint for a local page; spend is on the vendor's dashboard (linked) |
| Replicate | — | no data (the API sends no CORS headers) |
| OpenAI-compatible server (any base URL) | a base URL (any vendor not listed, a self-hosted server, a gateway) + an optional key | validate-only: `GET {base}/v1/models`, then it fingerprints the gateway and says which — OpenRouter (`/v1/key`: the key's spend, today's figure into Actual billed), LiteLLM proxy (`/key/info`), vLLM (`/metrics`); plain servers just validate. Never adds token rows. CORS depends on the host (SambaNova, NVIDIA and Baseten refuse even validation) |
| DeepInfra | API key | exact (gated): `GET /v1/me` validates; `GET /payment/usage` returns one item per model per **month** (tokens, cost in cents) — rows and the billed amount land on the month's first day. Whether the usage route accepts a plain API key is unverified: when it answers 401 / 403 the card downgrades itself to validate-only and says why. Payload shape source-based |
| Moonshot / Kimi Open Platform | API key from platform.kimi.ai (China-site keys are refused by that host) | validate-only, with the available balance in the label; no usage history |
| Cerebras Inference | API key, plus the Analytics **Download Report** CSV (Usage / Cached-Usage / Request Logs) dropped on Imports with "cerebras" in its file name | validate-only from the key; exact tokens from the CSV land under the card per UTC day and model (headers matched tolerantly — not verified on a real file). The Cost tab has no export, so dollars are priced from the list |
| Nebius Token Factory (ex AI Studio) | API key | validate-only (`api.tokenfactory.nebius.com`, with the legacy `api.studio.nebius.com` host as fallback) |
| Meta Model API (ex Llama API) | Model API key from dev.meta.ai | validate-only |
| Novita AI | API key | validate-only, with the credit balance in the label; the billing endpoints refuse the browser preflight, so they could only be read through the collector as a proxy (not built) |
| Alibaba Cloud Model Studio / DashScope | DashScope key + the region's base URL (an `*.aliyuncs.com` host only), plus the console's **Export Bill CSV** dropped on Imports | validate-only from the key; exact tokens and billed cost per bill day from the CSV (the Instance ID's 3rd field names the model) land under the card. Column names are not published in English, so headers are matched tolerantly — not verified on a real export |
| Z.ai / Zhipu GLM API | API key | validate-only, plus an **experimental** Coding Plan quota line (an undocumented endpoint community widgets use) in the status line only — never in rows, billed amounts or totals |
| MiniMax Open Platform | API key (+ optional GroupId and Coding Plan key) | validate-only, plus the same kind of experimental quota line |
| SambaNova Cloud, NVIDIA NIM API catalog, Baseten | — | no data: the hosts send no CORS headers (NIM also has nothing to measure since its credits were removed; Baseten's full usage API is collector-proxy material for a later version) |

If a vendor blocks the browser (CORS), the Anthropic and OpenAI cards offer a PowerShell fallback: run the printed command, then drop the saved JSON on Imports.

### Cloud (session-only tokens)

These cards never store credentials. Paste a short-lived token; it lives in this tab only and is gone on reload.

| Card | You provide | What you get |
|---|---|---|
| Azure OpenAI (Foundry) | `az account get-access-token --resource https://management.azure.com` + the resource id(s), optional cost scope | exact tokens per model per UTC day (Azure Monitor; several resource ids are summed); billed dollars from Cost Management |
| Google Vertex AI | `gcloud auth print-access-token` + project id, optional BigQuery billing-export table | exact tokens per model (Cloud Monitoring); billed from the export |
| AWS Bedrock | a read-only IAM access key + secret (+ session token), region | exact tokens per model (CloudWatch); billed from Cost Explorer — which charges $0.01 per request, including auto-refresh ticks |

---

## 4. Imports — files you can drop

The **Imports** card (and every export-based chat card's **Import file…**) accepts:

- ChatGPT / Claude.ai exports (ZIP or `conversations.json`), Grok JSON, Microsoft Copilot activity CSV, Perplexity ZIP/JSON, Meta AI `message_*.json`, DeepSeek chat export, Mistral Vibe export JSON, Sourcegraph Cody History export JSON, Character.ai export (ZIP or its message files, "character" in the name) — all estimated, each routed to its own card.
- **Gemini Google Takeout** — `My Activity/Gemini Apps/MyActivity.json` (choose JSON format in Takeout).
- **Cursor** usage-events CSV (cursor.com/dashboard → Usage → Export CSV) — exact tokens; cost when the column is present; a re-import replaces only the days the export covers.
- **DeepSeek API** monthly usage ZIP (`amount-*.csv` + `cost-*.csv`) — exact; months merge.
- **Cerebras** Analytics CSV (**Download Report**; keep "cerebras" in the file name) — exact tokens, lands under the Cerebras card; re-imports merge by day and model.
- **Alibaba Cloud Model Studio** bill CSV (**Export Bill CSV**) — exact tokens and the billed amount per bill day, under that card.
- Anthropic / OpenAI usage and cost JSON saved by the PowerShell fallback commands.
- Any `.jsonl` log: Claude Code files import directly; Codex, Copilot CLI, Continue, Junie, usage-logger and Copilot Chat OTel files are recognised and routed to their own card (this replaces that card's previous scan, and the note says so).
- A generic CSV: `date, platform, model, input_tokens, output_tokens[, cache_read_tokens, cache_write_tokens, cost_usd]` — re-imports merge by day/platform/model; a `cost_usd` column feeds "Actual billed".

Large exports parse in a background worker so the tab stays responsive.

---

## 5. Reading the dashboard

- **Date range**: 7 / 30 / 90 days, month to date, all, or a custom range. Provider data is bucketed by UTC day; local logs by your local day.
- **Cost vs Tokens** switches every chart; **By platform / By model** switches the series. Click a platform chip to hide it; when more than 12 platforms have data the rest fold into one "Other". A drill-down (click a hub card) narrows everything to one platform until you clear it.
- **KPIs** — tokens, output tokens, messages / requests, **API-equivalent cost** (list prices from the editable price list) and **Actual billed (from APIs)** — each with a delta against the previous period and a sparkline. Actual billed comes only from sources that report real dollars: Anthropic, OpenAI, OpenRouter, Fireworks, DeepSeek export, Cursor export with cost, GitHub Copilot billing, Azure, Vertex, Bedrock, Claude Enterprise, Poe, DeepInfra, the Alibaba bill CSV, an OpenRouter key behind the OpenAI-compatible card, and a generic CSV with a `cost_usd` column. A billed figure marked stale means the last cost fetch failed and the old number is still shown. The line under the KPIs says which price set priced the figures — `prices: bundled set of <date>` plus the number of your own edits — and the CSV export's first line carries the same provenance.
- **Daily usage** stacks by platform or model; wide ranges bucket to weeks or months. Hover for the exact numbers; click a legend entry to hide that series; **Table** lists the same series day by day even where the chart buckets to weeks or months.
- **By model**, **Platform share**, **Model breakdown** (input / cache write / cache read / output / cost per model, with `est.` marks, a **fallback price** badge where no row knows the model and a **priced as <successor>** badge where a retired id is billed as its successor) and **Projects** (from Claude Code, Codex, Gemini CLI, Copilot CLI and Junie logs).
- **Cowork, reported vs estimated**: when the window holds Cowork sessions, the Claude Code / Desktop card shows *Anthropic's own figure for Cowork* — the `total_cost_usd` each session's `audit.jsonl` records — next to our list-price estimate for the same sessions and days; sessions without an audit record are counted and disclosed. The figure is never added to Actual billed: a flat plan is not a bill.
- **Insights** — seven tiles: month-to-date and projected spend, a 13-week activity heatmap, week over week, cache savings, busiest hours (last 90 days of hourly detail), model efficiency (models with at least 20 messages), top project movers. Each tile has a **✕** to hide it; a chip above the row brings it back.
- **This period in AI** summarises the period in plain sentences.
- **Budgets**: a total and per-platform monthly limit; the editor lists the platforms you actually use (connected, budgeted, or with data). Alerts appear at 80 %, at 100 % (only when spend has really reached the limit) and when the projection overruns; dismiss per month. Hub cards show a budget bar.
- **API price list**: per-million prices per model pattern, grouped **by vendor**. Each group header reads `<vendor> · N rows · M matched your data` (and `K overridden by a platform rate` where that applies); the groups your data lands on open first, matched rows first within them, and a closed group builds its rows when you open it. Every row shows its provenance — `verified <date>` with a confidence pill and a link to the source page, `unverified since Aug 2026` for a row carried over without a re-check, `your edit` with a `user` pill for yours. The banner above the list reads `Prices verified <date> — N days ago` and turns amber past 90 days. **Platform overrides** — a host's own rate for a model it bills differently from the vendor (Groq, DeepInfra, SambaNova, Together AI, Cerebras) — are a read-only group at the bottom and win over the vendor row for data from that platform; the vendor row then says `wins for <platform>: $X in / $Y out`, so an edit of that row changes nothing for that platform's data. Retired model ids are priced as their successor. Edit, add (**+ Add model**, into a "Your rows" group) or reset; edits are stored in this browser only. Patterns match a normalised id (dots → hyphens, family-first for Claude 4+, vendor prefixes and date suffixes stripped), so `claude-opus-4.1`, `claude-4.1-opus` and `anthropic.claude-opus-4-1-20250805-v1:0` all hit the Opus row.
- **Unpriced models**: a model id that matches no row in the price list is priced at the catch-all "Unknown model" row (pattern `.*`, $3 in / $15 out per million by default) — and the dashboard says so rather than guessing silently. A notice above the KPIs names the models (messages and guessed cost each, up to five, then "+N more") and the fallback rate in force; a second sentence names the models priced from an unverified or user-edited row ("… so its cost is an estimate"), and when only those exist the notice is informational rather than a warning. **Set prices** jumps to the price list, **Dismiss** hides the notice until a *new* model joins the set. The Model breakdown marks fallback rows with a **fallback price** badge, and "This period in AI" states how much of the list-price figure is a fallback guess. Totals are not changed — the fallback price still applies; the point is disclosure. Local runners are $0 and are never flagged.
- **Export CSV** writes the rows currently in view — the selected date range, minus hidden platforms — with the API-equivalent cost per row. **Print report** produces a clean paper layout: collapsed sections re-appear, and the hub, data-source panels, budgets editor, price list and buttons are left out. **◐ Theme** toggles light/dark. **? Help** opens a short in-page guide (start here, what the badges mean, where the numbers come from, troubleshooting, keyboard, links to the full guide and this README); the `?` key toggles it whenever focus is not in a text field, and Esc closes it.
- **↻ Refresh** re-syncs every connected source; **Auto re-scan** does it every 5 / 15 / 60 minutes (remembered keys only — session-only tokens re-sync while they are still pasted).

Each major section header has a **▾** to collapse it; collapses are remembered and ignored when printing.

---

## 6. How costs are computed (the honesty rules)

- **API-equivalent cost** = tokens × the list price for that model, split into input, cache write, cache read and output. It is what the same usage would cost on the vendor's API — useful for comparing plans, not an invoice. Prices are the **currently loaded** list prices (the bundled set of the date the banner shows, plus your edits); historical price changes are not applied to older rows.
- **Actual billed** comes only from vendors that report money; the two figures are always shown separately. Anthropic's own Cowork figure is shown beside our estimate on the Claude Code card and is never counted as billed.
- Rows from **estimated** sources are marked `est.` everywhere and never mix silently with exact ones.
- **Validate-only** cards add no rows and no dollars — a balance in the label is the most they show. **Experimental** figures (the Z.ai and MiniMax quota endpoints, reverse-engineered) live in that card's status line only and never feed rows, billed amounts or totals.
- Where a vendor reports **months, not days** (DeepInfra), the month's tokens and cost land on the month's first day, so day and week views show whole months on the 1st; the card says so.
- **Local runners are $0**, and coding-tool requests that name a local backend (Continue + Ollama, Cline / Roo / Kilo + LM Studio, Aider `ollama_chat/…`, Codex OSS models, OpenCode / Goose / Zed on a local provider) are $0 too.
- Flat-rate plans (ChatGPT, Copilot, Claude.ai, Cursor) show the list-price equivalent so you can see what the plan is worth; the card says so. Devin's ACUs and Amp's credits stay in the scan metadata and are never turned into dollars.
- Parsers written from published code or docs rather than real files (OpenCode, Goose, Devin CLI, Kilo Code, Amp, Zed, Cody, the Cerebras and Alibaba CSV importers, DeepInfra's usage payload) say **source-based, not yet verified on real files** on their card.
- No card claims to read a consumer chat product through your web login. If a vendor offers nothing, the card says "no data" and links you to their page.

---

## 7. Privacy and security

- The page makes network requests only when you click Validate / Fetch / Sync (or enable auto-refresh), and only to the vendor whose key you pasted.
- API keys are kept in the browser's storage **only if you tick "Remember key on this computer"**. Cloud tokens and secrets (Azure, Vertex, Bedrock) are never stored.
- Folder access uses the browser's folder picker; files are read locally and never uploaded. Only aggregated rows (day, platform, model, token counts) are stored, not message text.
- With the local collector (§1b) the files are read by that Node process on this machine and fetched by the page from `127.0.0.1` over a token-gated, read-only API — the token travels in a header only, the collector lists and serves only usage-log file types and never a credential file by name, and under a Cowork root it never touches the files a session handled (`outputs`, `uploads`, `.project-cache`, …). Still nothing leaves the machine, and the same aggregated rows are all that is stored.
- Keys go to their vendor's host and nowhere else: the Alibaba card accepts an `*.aliyuncs.com` base URL only, the OpenAI-compatible card accepts `http://` for localhost only, and the Z.ai / MiniMax quota probes are sent only after the key validated.
- **Clear stored data…** (Data sources section) wipes everything the page remembered. Disconnect asks whether to keep or delete a source's data.
- If the browser's storage is full the page says so in a banner; export a CSV backup, then clear.
- The threat model, what is out of scope, and how to report a vulnerability privately are in [`SECURITY.md`](SECURITY.md).

---

## 8. Troubleshooting

| Symptom | What to do |
|---|---|
| Ollama card says "likely CORS (see card)" | Set `OLLAMA_ORIGINS="*"` (or your page origin), restart Ollama, validate again. |
| llama.cpp shows no counters | Start `llama-server` with `--metrics` (`--tools` / `--agent` restrict CORS to localhost origins). |
| text-generation-webui validate fails | Run it with `--listen` or `--public-api`; without them a `file://` page is blocked. |
| LocalAI "stats disabled" | The server was started with `--disable-stats`; history needs stats on, and survives restarts only with auth enabled. |
| Azure / Vertex "token expired" | Tokens last about an hour — mint a new one with the printed CLI command and paste it again. |
| Bedrock "AccessDenied" | The IAM key needs `cloudwatch:GetMetricData`, `cloudwatch:ListMetrics` and `ce:GetCostAndUsage` (read-only). |
| Anthropic / OpenAI fetch fails with a network or CORS error | Use the PowerShell fallback on the card and drop the resulting JSON on Imports. |
| Folder picker does nothing | Use Chrome or Edge, or the card's "classic folder chooser" link — or skip pickers altogether with the local collector (§1b). |
| Local collector card says "Not running at …" | Start it: `node docs/tools/ai-usage-collector.mjs`; with `--port <n>`, put that URL in the card's Collector URL field. |
| Local collector card says "Token rejected" | Paste the token the collector printed (also in `~/.ai-usage/collector.token`). |
| Collector table shows a tool as "found, nothing to read" | The folder exists but holds nothing the card parses yet; if the tool logs elsewhere, add `--root <id>=<path>`. |
| Zed card says it "needs the local collector on this browser" | This browser's `DecompressionStream` has no zstd, so the page cannot read `threads.db` itself. Run the collector (Node 22.15 or newer) and connect through it. |
| DeepInfra card says it downgraded to validate-only | The usage route refused the key (401 / 403); the key itself is fine. Spend stays on deepinfra.com/dash until that route accepts plain API keys. |
| A Cerebras or Alibaba CSV is not recognised | Keep "cerebras" in the Cerebras report's file name (it needs date, model, input and output columns); the Alibaba bill must keep its `Instance ID`, `Usage` and amount columns. Both importers match headers tolerantly but need those. |

| Numbers changed after updating the file | Parsers improve between versions; the first re-scan after an update re-reads files once (scan cache version bump). |
| "browser storage is full" banner | Export CSV, then Clear stored data; large multi-year imports are compacted to daily rows after 90 days. |

---

## 9. The Ollama usage logger

Ollama keeps no usage history, so exact per-request counts exist only inside each API response. `docs/tools/ollama-usage-logger.mjs` is a zero-dependency Node proxy: run it, point your clients at it instead of Ollama, and it appends one JSONL line per completed request with the exact counts.

```bash
node docs/tools/ollama-usage-logger.mjs
```

Then set `OLLAMA_HOST=127.0.0.1:11435` (or `base_url=http://127.0.0.1:11435/v1` for OpenAI SDKs) and pick the logger's folder (`~/.ai-usage` by default) in the Ollama card — or run the local collector (§1b), which finds `~/.ai-usage` by itself. Environment: `LOG_PORT`, `OLLAMA_URL`, `USAGE_LOG`. Counts are read from the last 64 KB of each response, so a stream of any size is logged as cheaply as a small one. OpenAI-style streaming clients must set `stream_options.include_usage`, or the server sends no usage object — the proxy then logs nothing and prints a warning. Nothing is ever estimated.

---

## 10. For developers

- The product is still one file, `AI Usage Dashboard.html` (vanilla JS, no dependencies), but since Plan 9 it is **built** from `src/`: `src/index.html` is the markup skeleton with two placeholder lines (`<!-- BUILD:STYLES -->` inside `<style>`, `<!-- BUILD:SCRIPTS -->` inside `<script>`), `src/styles.css` is the stylesheet, and `src/js/<nn>-<name>.js` are the script parts in build order (the numeric prefix is the order: helpers, the generated price block, pricing, insights/budgets, the `CONNECTORS` registry, the store, the parser parts — one per vendor family at the split; the Plan 9 OpenCode / Goose / Devin / Amp / Zed / Copilot OTel parsers currently sit at the end of `13-parse-aider-junie.js` pending a renumbering — the SQLite reader, the scan cache, exports/CSV/API-payload parsers, fetchers, the ZIP reader and import sniffs, charts, the `App` object, boot). `node tools/build.mjs` concatenates them byte-for-byte into the HTML (CRLF, no control bytes — both asserted); `node tools/build.mjs --check` exits 1 when the committed HTML differs from the build (CI runs it before the suite; `tests/checks/96b-build.mjs` runs it inside the suite). **Edit `src/`, run the build, never hand-edit the built file.** The built file must stay under 1,024 KB (`95-ui-misc` and CI both check). The price block (`PRICES:BEGIN … PRICES:END` in `src/js/02-prices.js`) is generated by `node tests/tools/sync-prices.mjs` from the price JSON; the tool runs the build itself.
- Adding a platform is one entry in the `CONNECTORS` registry (`src/js/05-connectors.js`) plus one parser, fetcher or validator function in its own `src/js/` part; cards, hub groups, the budgets editor and the platform list derive from the registry, and `tests/checks/97-registry.mjs` pins the per-entry invariants (kind-specific fields, honesty copy that opens with the quality word, every named driver function resolving).
- Tests: `node tests/run.mjs` runs the headless suite against the real page in Chrome; `ONLY=87,94 node tests/run.mjs` runs only the check files whose names contain one of the comma-separated tokens. Fixtures are generated by `tests/fixtures/gen.mjs`; the SQLite stores under `tests/fixtures/sqlite/` are committed binaries regenerated by `gen-sqlite.mjs` (needs `node:sqlite`), and the Zed fixture ships both as JSON and as a committed zstd frame. `node tests/tools/screenshots.mjs` renders light / dark / print / Manage-modal screenshots into `tests/artifacts/` (`TAG=v9` prefixes the files).
- The local collector: `tests/tools/collector.test.mjs` is a plain Node test of `docs/tools/ai-usage-collector.mjs` (no browser; spawns it against a temp HOME seeded with the fixtures; runs alone with `node tests/tools/collector.test.mjs`). `tests/checks/89c-collector.mjs` relays it into the suite and adds the end-to-end block — a real collector plus the real page over HTTP, both the `file://` page (CORS / Private Network Access to `127.0.0.1` in real Chrome) and the collector-served `/?token=` page, plus a tick re-scan after a file is written; `87f-collector.mjs` covers the page side with a stubbed `fetch`.
- Design notes, plans and review records are under `docs/superpowers/` (start with `HANDOFF-2026-08-19.md`).

### Price-list freshness check

`docs/tools/price-check.mjs` re-fetches every vendor pricing page named in the price spec (`docs/superpowers/specs/2026-10-15-price-rows.json` — `source_url` per row and per platform override) and compares what the page says with what we have (`in` / `out`, USD per 1M tokens, ±0.005). One generic extractor, no per-vendor scrapers: the page's static HTML is reduced to text, every money figure is located (`$2.00`, `USD 3.00`, `2.00 per million`, `2.00 / 1M`), each row's ids (token-bounded, case-insensitive) and then its label are looked up, and the figures in a short window after the hit are compared. Zero dependencies, Node ≥ 20, 20 s per page, 3 pages at a time, User-Agent `ROSTUM price-check`, one fetch per distinct URL.

- Run: `node docs/tools/price-check.mjs` prints a markdown report (summary table, coverage per vendor, one line per row that is not a match); `--json <out>` also writes the full report; `--quiet` prints only the one-line summary; `--rows <json>` checks another spec file of the same shape. Exit code 1 when any row drifted **or** overall coverage is below 70 %, else 0.
- The six statuses: `match` (both numbers found after an anchor), `drift` (anchor found with figures, but not both of ours — the line says `page says X / Y, we have A / B`), `id-missing` (neither an id nor the label is on the page — retired or renamed?), `page-unreachable` (fetch error or non-2xx, the error is the detail), `unknown` (anchor found but no parseable figure near it, a lone figure that cannot tell input from output, or a page with no figure at all — JS-rendered), `no-source` (the row has `source_url: null`; informational).
- Coverage = (match + drift) / rows that have a source, overall and per vendor (an override's platform counts as its vendor). It measures how much of the list the checker could actually compare — a low number means JS-rendered pages or ids the page no longer lists, not wrong prices.
- It never changes data. When a row drifted, a human verifies the page, edits the JSON and re-runs `node tests/tools/sync-prices.mjs` to render the dashboard's PRICES block. `.github/workflows/price-check.yml` runs the check weekly and on demand, uploads the JSON report as an artifact and fails its own job (never the test suite) on drift or low coverage. `tests/tools/price-check.test.mjs` is the Node test (stub pages on 127.0.0.1, no network; runs alone with `node tests/tools/price-check.test.mjs`); `tests/checks/89f-price-check.mjs` relays it into the suite. The first weekly runs are expected to come back red: live coverage was 37.9 % on 2026-10-27 because many `source_url` pages are JS-rendered or no longer list the ids, and the job stays red until those URLs are repointed (Plan 10 Task 3c).

---

## 11. License and status

This repository is published for reading, running and auditing. **No open-source license has been chosen yet, so all rights are reserved** by the author: you may use the dashboard and the helper scripts for yourself, but please ask before redistributing or building on the code. A license decision is pending and this section will change when it lands.

Security policy: [`SECURITY.md`](SECURITY.md). Development plans, reviews and the design debates that shaped the roadmap are under `docs/superpowers/`.
