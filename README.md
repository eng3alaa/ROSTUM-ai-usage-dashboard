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
   - **Local collector (automatic)** — the fastest path for every coding tool and local runner that writes logs: run `node docs/tools/ai-usage-collector.mjs` once and every tool it finds on this machine connects by itself, no folder picking (see [Automatic mode](#automatic-mode)).
   - **Claude Code / Desktop** — pick your `.claude` folder (or let the collector find it). Exact tokens for every session.
   - **Anthropic API / OpenAI API** — paste an Admin key: exact usage plus what you were actually billed.
   - Any coding tool that writes logs (Codex CLI, Copilot CLI, Cline, Continue, Gemini CLI, Roo, Aider, Junie) — pick its log folder.
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
| `local` | Claude Code / Desktop | `~/.claude` (`CLAUDE_CONFIG_DIR` when set) |
| `codex` | OpenAI Codex CLI | `~/.codex/sessions` and `~/.codex/archived_sessions` (`CODEX_HOME` when set) — only those two; the rest of `~/.codex` is never read |
| `copilot-cli` | GitHub Copilot CLI (logs) | `~/.copilot` |
| `gemini-cli` | Gemini CLI | `~/.gemini` (`GEMINI_CLI_HOME` when set) |
| `continue` | Continue.dev | `~/.continue` |
| `cline` | Cline (VS Code) | `globalStorage/saoudrizwan.claude-dev` under the user folder of VS Code, VS Code Insiders, Cursor, Windsurf or VSCodium — the first that exists |
| `roo` | Roo Code (VS Code) | `…/globalStorage/rooveterinaryinc.roo-cline` and `…/globalStorage/kilocode.kilo-code`, same editors |
| `junie` | JetBrains AI Assistant / Junie | `~/.junie` plus every `matterhorn` folder under the JetBrains cache (`%LOCALAPPDATA%\JetBrains`, `~/Library/Caches/JetBrains`, `~/.cache/JetBrains`) |
| `lmstudio` | LM Studio | `~/.lmstudio/conversations` or `~/.cache/lm-studio/conversations` |
| `ollama` | Ollama | `~/.ai-usage` (the usage logger's folder, §9) and the desktop app folder (`%LOCALAPPDATA%\Ollama`, `~/Library/Application Support/Ollama`, `~/.ollama`) |
| `jan` | Jan | `%APPDATA%\Jan\data`, `~/Library/Application Support/Jan/data` or `~/.local/share/Jan/data` |
| `aider`, `tgwebui` | Aider, text-generation-webui | no fixed folder — only with `--root` |

A tool is *found* when its folder exists. *Found, nothing to read* means the folder is there but holds no file the card's parser recognises — normal for `ollama` when `~/.ai-usage` holds only the token file, or for a tool that has not logged anything yet.

Flags: `--port <n>` (or `COLLECTOR_PORT`; default 11436; `0` picks a free port and prints it), `--root <id>=<path>` (use that folder for a tool instead of auto-discovery; repeatable; the only way to add `aider` or `tgwebui`), `--no-<id>` (skip a tool, e.g. `--no-ollama`), `--html <path>` (which dashboard file to serve at `/`), `--help`.

**Automatic refresh**

- The collector watches every found folder (`fs.watch`); a change marks that tool for a re-walk on its next status request. Where recursive watching is unavailable (some network shares, old kernels) that tool is re-walked when its counts are older than 30 s instead — the startup table says `watch polling`.
- While the collector card is connected, the dashboard asks it for status **every 60 s** (skipped while the tab is hidden) and re-reads only the tools whose file count or newest change moved; unchanged files hit the scan cache, so a tick with nothing new costs one small request. **Refresh all** runs one such check now; a tool card's **Re-scan** / **Sync** goes through the collector while it feeds that card.
- After a reload the watch resumes by itself only if the token was remembered; otherwise the card says *Reconnect* and the tools' stored data stays on screen until you paste the token again.
- **Disconnect** on the collector card forgets the token and stops the watch; the tools keep their entries and data (their cards keep the *via collector* label until the next folder pick or Clear stored data). Disconnecting a tool's own card while the collector feeds it takes that tool out of the collector's reads (its row in the table says *disconnected*) until you click **Validate & connect** on the collector card again.

**Security**

- Binds `127.0.0.1` only; nothing is reachable from other machines.
- Every `/api/*` request needs the token (`Authorization: Bearer …`, or `?token=`), otherwise `401`. Without it any web page open in your browser could read the machine's AI transcripts through the port; the origin is deliberately not the gate (a `file://` page and a sandboxed iframe both have a `null` origin).
- Read-only, and only inside the discovered roots (or the `--root` folders): paths with `..`, absolute paths and symbolic links are refused; the walk skips `node_modules`, `.git` and `checkpoints`; the token file is never listed or served.
- The collector logs one line per request (method, path, status, bytes) — never file contents, never the token. The page sends the token only to the Collector URL on the card, as a header — never in a request URL, never into the page's HTML — and stores it only with **Remember token on this computer**.
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

Cards are grouped the way you use them (47 cards):

| Group | Cards (as titled in the app) |
|---|---|
| Coding tools | Local collector (automatic), Claude Code / Desktop, GitHub Copilot, OpenAI Codex CLI, Gemini CLI, GitHub Copilot CLI (logs), Continue.dev, Cline (VS Code), Roo Code (VS Code), Aider, JetBrains AI Assistant / Junie, Amazon Q / Kiro, Windsurf (Codeium) |
| Chat apps | Claude Enterprise (org analytics), ChatGPT (web + desktop), Claude.ai (web + desktop), Grok (grok.com / X), Microsoft Copilot (consumer), Perplexity (app), Meta AI, DeepSeek chat, Imports |
| Local runners | LM Studio, Ollama, LocalAI, vLLM, llama.cpp (llama-server), GPT4All, Jan, text-generation-webui |
| API vendors | Anthropic API, OpenAI API, Gemini (Google AI), OpenRouter, Groq, Replicate, Mistral (La Plateforme), Cohere, Together AI, Hugging Face (Inference Providers), xAI API (Grok models), Perplexity API (Sonar), Fireworks AI, DeepSeek API |
| Cloud | Azure OpenAI (Foundry), Google Vertex AI, AWS Bedrock |

**What the card tells you**

- **Dot**: green = connected, amber = needs attention (an error, or the last sync is more than 7 days old), gray = not connected.
- **Quality badge** — the honesty label, shown first on every card except the six original cards (Claude Code, Anthropic, OpenAI, Gemini, GitHub Copilot, OpenRouter) and Imports, whose own panels carry their own wording (`billed usage`, `key validation`, `best-effort usage`, `credits + activity`):
  - `exact` — token counts come from the tool or vendor itself.
  - `estimated` — tokens are estimated from text (about 4 characters per token) because the source keeps no counts. Rows carry an `est.` mark everywhere they appear.
  - `validate-only` — the card can verify your key and show what the account can reach, but the vendor offers no usage history to a local page. Spend lives on the vendor's own usage page (linked from the card).
  - `no data` — there is no data path at all from a local page; the card explains why and links to the vendor's usage page.
- **Buttons**: **Connect / Manage** opens the card's details; **Sync** re-reads the source; **Disconnect** forgets the connection (and asks whether to keep or delete the data it loaded). Export-based chat cards show **Manage** and **Import file…** (which opens the Imports drop zone) — they have no key to connect or disconnect. In the same group, Claude Enterprise takes a key like an API card, and Imports has no Sync button. No-data cards show **Details** and a vendor usage link.
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
| Cline (VS Code) / Roo Code (VS Code) | the extension's `globalStorage/…/tasks` folder | exact | `ui_messages.json` per task; model per task from `task_metadata.json` when present. Kilo Code uses the same layout (use the Roo card). |
| Aider | a project folder (or a parent holding several repos) | estimated | `.aider.chat.history.md` prints rounded token lines; models on `ollama_chat/` etc. are $0. For exact numbers run aider with `--analytics-log`. |
| JetBrains AI Assistant / Junie | the IDE's `matterhorn/.matterhorn/events` folder or `~/.junie/sessions` | estimated | Junie agent runs carry exact counts; regular AI Assistant chat writes no token log, so totals understate. |
| Amazon Q / Kiro, Windsurf (Codeium) | — | no data | Personal plans expose no usage API or export to a local page; the card links to the vendor's usage page. |

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

Chat exports are priced as if the conversations had run on the API; pick the assumed Claude model in the Imports card. **Gemini web app** history comes through Google Takeout (see Imports).

**Claude Enterprise (org analytics)** sits in the Chat apps group but takes an Analytics API key (Enterprise orgs only; no data before 2026-01-01): exact org-wide usage and cost under its own platform, so it never mixes with your local Claude Code rows.

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

- ChatGPT / Claude.ai exports (ZIP or `conversations.json`), Grok JSON, Microsoft Copilot activity CSV, Perplexity ZIP/JSON, Meta AI `message_*.json`, DeepSeek chat export — all estimated.
- **Gemini Google Takeout** — `My Activity/Gemini Apps/MyActivity.json` (choose JSON format in Takeout).
- **Cursor** usage-events CSV (cursor.com/dashboard → Usage → Export CSV) — exact tokens; cost when the column is present; a re-import replaces only the days the export covers.
- **DeepSeek API** monthly usage ZIP (`amount-*.csv` + `cost-*.csv`) — exact; months merge.
- Anthropic / OpenAI usage and cost JSON saved by the PowerShell fallback commands.
- Any `.jsonl` log: Claude Code files import directly; Codex, Copilot CLI, Continue, Junie and usage-logger files are recognised and routed to their own card (this replaces that card's previous scan, and the note says so).
- A generic CSV: `date, platform, model, input_tokens, output_tokens[, cache_read_tokens, cache_write_tokens, cost_usd]` — re-imports merge by day/platform/model; a `cost_usd` column feeds "Actual billed".

Large exports parse in a background worker so the tab stays responsive.

---

## 5. Reading the dashboard

- **Date range**: 7 / 30 / 90 days, month to date, all, or a custom range. Provider data is bucketed by UTC day; local logs by your local day.
- **Cost vs Tokens** switches every chart; **By platform / By model** switches the series. Click a platform chip to hide it; when more than 12 platforms have data the rest fold into one "Other". A drill-down (click a hub card) narrows everything to one platform until you clear it.
- **KPIs** — tokens, output tokens, messages / requests, **API-equivalent cost** (list prices from the editable price list) and **Actual billed (from APIs)** — each with a delta against the previous period and a sparkline. Actual billed comes only from sources that report real dollars: Anthropic, OpenAI, OpenRouter, Fireworks, DeepSeek export, Cursor export with cost, GitHub Copilot billing, Azure, Vertex, Bedrock, Claude Enterprise, and a generic CSV with a `cost_usd` column. A billed figure marked stale means the last cost fetch failed and the old number is still shown.
- **Daily usage** stacks by platform or model; wide ranges bucket to weeks or months. Hover for the exact numbers; click a legend entry to hide that series; **Table** lists the same series day by day even where the chart buckets to weeks or months.
- **By model**, **Platform share**, **Model breakdown** (input / cache write / cache read / output / cost per model, with `est.` marks) and **Projects** (from Claude Code, Codex, Gemini CLI, Copilot CLI and Junie logs).
- **Insights** — seven tiles: month-to-date and projected spend, a 13-week activity heatmap, week over week, cache savings, busiest hours (last 90 days of hourly detail), model efficiency (models with at least 20 messages), top project movers. Each tile has a **✕** to hide it; a chip above the row brings it back.
- **This period in AI** summarises the period in plain sentences.
- **Budgets**: a total and per-platform monthly limit; the editor lists the platforms you actually use (connected, budgeted, or with data). Alerts appear at 80 %, at 100 % (only when spend has really reached the limit) and when the projection overruns; dismiss per month. Hub cards show a budget bar.
- **API price list**: per-million prices per model pattern. Edit, add or reset. Patterns match a normalised id (dots → hyphens, family-first for Claude 4+, vendor prefixes and date suffixes stripped), so `claude-opus-4.1`, `claude-4.1-opus` and `anthropic.claude-opus-4-1-20250805-v1:0` all hit the Opus row.
- **Unpriced models**: a model id that matches no row in the price list is priced at the catch-all "Unknown model" row (pattern `.*`, $3 in / $15 out per million by default) — and the dashboard says so rather than guessing silently. A notice above the KPIs names the models (messages and guessed cost each, up to five, then "+N more") and the fallback rate in force; **Set prices** jumps to the price list, **Dismiss** hides the notice until a *new* unknown model appears. The Model breakdown marks such rows with a **fallback price** badge, and "This period in AI" states how much of the list-price figure is a fallback guess. Totals are not changed — the fallback price still applies; the point is disclosure. Local runners are $0 and are never flagged.
- **Export CSV** writes the rows currently in view — the selected date range, minus hidden platforms — with the API-equivalent cost per row. **Print report** produces a clean paper layout: collapsed sections re-appear, and the hub, data-source panels, budgets editor, price list and buttons are left out. **◐ Theme** toggles light/dark. **? Help** opens a short in-page guide (start here, what the badges mean, where the numbers come from, troubleshooting, keyboard, links to the full guide and this README); the `?` key toggles it whenever focus is not in a text field, and Esc closes it.
- **↻ Refresh** re-syncs every connected source; **Auto re-scan** does it every 5 / 15 / 60 minutes (remembered keys only — session-only tokens re-sync while they are still pasted).

Each major section header has a **▾** to collapse it; collapses are remembered and ignored when printing.

---

## 6. How costs are computed (the honesty rules)

- **API-equivalent cost** = tokens × the list price for that model, split into input, cache write, cache read and output. It is what the same usage would cost on the vendor's API — useful for comparing plans, not an invoice.
- **Actual billed** comes only from vendors that report money; the two figures are always shown separately.
- Rows from **estimated** sources are marked `est.` everywhere and never mix silently with exact ones.
- **Local runners are $0**, and coding-tool requests that name a local backend (Continue + Ollama, Cline + LM Studio, Aider `ollama_chat/…`, Codex OSS models) are $0 too.
- Flat-rate plans (ChatGPT, Copilot, Claude.ai, Cursor) show the list-price equivalent so you can see what the plan is worth; the card says so.
- No card claims to read a consumer chat product through your web login. If a vendor offers nothing, the card says "no data" and links you to their page.

---

## 7. Privacy and security

- The page makes network requests only when you click Validate / Fetch / Sync (or enable auto-refresh), and only to the vendor whose key you pasted.
- API keys are kept in the browser's storage **only if you tick "Remember key on this computer"**. Cloud tokens and secrets (Azure, Vertex, Bedrock) are never stored.
- Folder access uses the browser's folder picker; files are read locally and never uploaded. Only aggregated rows (day, platform, model, token counts) are stored, not message text.
- With the local collector (§1b) the files are read by that Node process on this machine and fetched by the page from `127.0.0.1` over a token-gated, read-only API — still nothing leaves the machine, and the same aggregated rows are all that is stored.
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

- The product is still one file, `AI Usage Dashboard.html` (vanilla JS, no dependencies), but since Plan 9 it is **built** from `src/`: `src/index.html` is the markup skeleton with two placeholder lines (`<!-- BUILD:STYLES -->` inside `<style>`, `<!-- BUILD:SCRIPTS -->` inside `<script>`), `src/styles.css` is the stylesheet, and `src/js/<nn>-<name>.js` are the script parts in build order (the numeric prefix is the order: helpers, the generated price block, pricing, insights/budgets, the `CONNECTORS` registry, the store, one parser file per vendor family, the SQLite reader, the scan cache, exports/CSV/API-payload parsers, fetchers, the ZIP reader and import sniffs, charts, the `App` object, boot). `node tools/build.mjs` concatenates them byte-for-byte into the HTML (CRLF, no control bytes — both asserted); `node tools/build.mjs --check` exits 1 when the committed HTML differs from the build (CI runs it before the suite; `tests/checks/96b-build.mjs` runs it inside the suite). **Edit `src/`, run the build, never hand-edit the built file.** The price block (`PRICES:BEGIN … PRICES:END` in `src/js/02-prices.js`) is generated by `node tests/tools/sync-prices.mjs` from the price JSON; the tool runs the build itself.
- Adding a platform is one entry in the `CONNECTORS` registry (`src/js/05-connectors.js`) plus one parser, fetcher or validator function in its own `src/js/` part; cards, hub groups, the budgets editor and the platform list derive from the registry.
- Tests: `node tests/run.mjs` runs the headless suite against the real page in Chrome; `ONLY=87,94 node tests/run.mjs` runs only the check files whose names contain one of the comma-separated tokens. Fixtures are generated by `tests/fixtures/gen.mjs`; `node tests/tools/screenshots.mjs` renders light / dark / print / Manage-modal screenshots into `tests/artifacts/`.
- The local collector: `tests/tools/collector.test.mjs` is a plain Node test of `docs/tools/ai-usage-collector.mjs` (no browser; spawns it against a temp HOME seeded with the fixtures; runs alone with `node tests/tools/collector.test.mjs`). `tests/checks/89c-collector.mjs` relays it into the suite and adds the end-to-end block — a real collector plus the real page over HTTP, both the `file://` page (CORS / Private Network Access to `127.0.0.1` in real Chrome) and the collector-served `/?token=` page, plus a tick re-scan after a file is written; `87f-collector.mjs` covers the page side with a stubbed `fetch`.
- Design notes, plans and review records are under `docs/superpowers/` (start with `HANDOFF-2026-08-19.md`).

### Price-list freshness check

`docs/tools/price-check.mjs` re-fetches every vendor pricing page named in the price spec (`docs/superpowers/specs/2026-10-15-price-rows.json` — `source_url` per row and per platform override) and compares what the page says with what we have (`in` / `out`, USD per 1M tokens, ±0.005). One generic extractor, no per-vendor scrapers: the page's static HTML is reduced to text, every money figure is located (`$2.00`, `USD 3.00`, `2.00 per million`, `2.00 / 1M`), each row's ids (token-bounded, case-insensitive) and then its label are looked up, and the figures in a short window after the hit are compared. Zero dependencies, Node ≥ 20, 20 s per page, 3 pages at a time, User-Agent `ROSTUM price-check`, one fetch per distinct URL.

- Run: `node docs/tools/price-check.mjs` prints a markdown report (summary table, coverage per vendor, one line per row that is not a match); `--json <out>` also writes the full report; `--quiet` prints only the one-line summary; `--rows <json>` checks another spec file of the same shape. Exit code 1 when any row drifted **or** overall coverage is below 70 %, else 0.
- The six statuses: `match` (both numbers found after an anchor), `drift` (anchor found with figures, but not both of ours — the line says `page says X / Y, we have A / B`), `id-missing` (neither an id nor the label is on the page — retired or renamed?), `page-unreachable` (fetch error or non-2xx, the error is the detail), `unknown` (anchor found but no parseable figure near it, a lone figure that cannot tell input from output, or a page with no figure at all — JS-rendered), `no-source` (the row has `source_url: null`; informational).
- Coverage = (match + drift) / rows that have a source, overall and per vendor (an override's platform counts as its vendor). It measures how much of the list the checker could actually compare — a low number means JS-rendered pages or ids the page no longer lists, not wrong prices.
- It never changes data. When a row drifted, a human verifies the page, edits the JSON and re-runs `node tests/tools/sync-prices.mjs` to render the dashboard's PRICES block. `.github/workflows/price-check.yml` runs the check weekly and on demand, uploads the JSON report as an artifact and fails its own job (never the test suite) on drift or low coverage. `tests/tools/price-check.test.mjs` is the Node test (stub pages on 127.0.0.1, no network; runs alone with `node tests/tools/price-check.test.mjs`); `tests/checks/89f-price-check.mjs` relays it into the suite.

---

## 11. License and status

This repository is published for reading, running and auditing. **No open-source license has been chosen yet, so all rights are reserved** by the author: you may use the dashboard and the helper scripts for yourself, but please ask before redistributing or building on the code. A license decision is pending and this section will change when it lands.

Security policy: [`SECURITY.md`](SECURITY.md). Development plans, reviews and the design debates that shaped the roadmap are under `docs/superpowers/`.
