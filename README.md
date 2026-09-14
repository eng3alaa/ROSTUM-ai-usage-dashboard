# AI Usage & Cost Monitor — user guide

One HTML file that shows how much you use AI — tokens, messages and the API-equivalent cost — across every platform you touch: Claude Code, ChatGPT, Gemini, Copilot, Cursor, local models, cloud endpoints and more. It runs entirely in your browser from `AI Usage Dashboard.html`; nothing is installed and nothing is uploaded anywhere except the API calls you explicitly trigger with your own keys.

Every number on the page is labeled with where it came from and how trustworthy it is. The dashboard never guesses silently.

---

## 1. Quick start

1. Double-click `AI Usage Dashboard.html`. It opens as a `file://` page — no server needed.
2. Use **Chrome or Edge** for the full experience. Only the folder picker needs the File System Access API; dropping files works everywhere. In other browsers the folder buttons fall back to the classic folder chooser automatically. ZIP imports and Bedrock signing rely on `DecompressionStream` and WebCrypto, which current Chromium browsers provide on `file://` pages.
3. In the **accounts hub** at the top, click **Connect** on a card and follow its instructions. The fastest wins:
   - **Claude Code / Desktop** — pick your `.claude` folder. Exact tokens for every session.
   - **Anthropic API / OpenAI API** — paste an Admin key: exact usage plus what you were actually billed.
   - Any coding tool that writes logs (Codex CLI, Copilot CLI, Cline, Continue, Gemini CLI, Roo, Aider, Junie) — pick its log folder.
4. Folder choices, imported data and settings are remembered in the browser's storage for this file; API keys only if you tick **Remember key on this computer**, and cloud tokens never. Re-open the page any time; folder sources re-scan on demand (or on a timer with **Auto re-scan**).

The page is a single static file. Copy it anywhere, keep it on a USB stick, or open it in a private window if you want nothing remembered.

---

## 2. The accounts hub

Cards are grouped the way you use them (46 cards):

| Group | Cards (as titled in the app) |
|---|---|
| Coding tools | Claude Code / Desktop, GitHub Copilot, OpenAI Codex CLI, Gemini CLI, GitHub Copilot CLI (logs), Continue.dev, Cline (VS Code), Roo Code (VS Code), Aider, JetBrains AI Assistant / Junie, Amazon Q / Kiro, Windsurf (Codeium) |
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

| Card | You provide | Quality | Notes |
|---|---|---|---|
| Claude Code / Desktop | the `.claude` folder (`%USERPROFILE%\.claude` / `~/.claude`) | exact (no badge) | Per-message input, output, cache-write and cache-read tokens from `projects/**/*.jsonl`; projects table; re-scan only reads changed files. |
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
- **Export CSV** writes the rows currently in view — the selected date range, minus hidden platforms — with the API-equivalent cost per row. **Print report** produces a clean paper layout: collapsed sections re-appear, and the hub, data-source panels, budgets editor, price list and buttons are left out. **◐ Theme** toggles light/dark.
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
- **Clear stored data…** (Data sources section) wipes everything the page remembered. Disconnect asks whether to keep or delete a source's data.
- If the browser's storage is full the page says so in a banner; export a CSV backup, then clear.

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
| Folder picker does nothing | Use Chrome or Edge, or the card's "classic folder chooser" link. |
| Numbers changed after updating the file | Parsers improve between versions; the first re-scan after an update re-reads files once (scan cache version bump). |
| "browser storage is full" banner | Export CSV, then Clear stored data; large multi-year imports are compacted to daily rows after 90 days. |

---

## 9. The Ollama usage logger

Ollama keeps no usage history, so exact per-request counts exist only inside each API response. `docs/tools/ollama-usage-logger.mjs` is a zero-dependency Node proxy: run it, point your clients at it instead of Ollama, and it appends one JSONL line per completed request with the exact counts.

```bash
node docs/tools/ollama-usage-logger.mjs
```

Then set `OLLAMA_HOST=127.0.0.1:11435` (or `base_url=http://127.0.0.1:11435/v1` for OpenAI SDKs) and pick the logger's folder (`~/.ai-usage` by default) in the Ollama card. Environment: `LOG_PORT`, `OLLAMA_URL`, `USAGE_LOG`. Counts are read from the last 64 KB of each response, so a stream of any size is logged as cheaply as a small one. OpenAI-style streaming clients must set `stream_options.include_usage`, or the server sends no usage object — the proxy then logs nothing and prints a warning. Nothing is ever estimated.

---

## 10. For developers

- Everything lives in `AI Usage Dashboard.html` (vanilla JS, no build step). Adding a platform is one entry in the `CONNECTORS` registry plus one parser, fetcher or validator function; cards, hub groups, the budgets editor and the platform list derive from the registry.
- Tests: `node tests/run.mjs` runs the headless suite against the real page in Chrome; `ONLY=87,94 node tests/run.mjs` runs only the check files whose names contain one of the comma-separated tokens. Fixtures are generated by `tests/fixtures/gen.mjs`; `node tests/tools/screenshots.mjs` renders light / dark / print / Manage-modal screenshots into `tests/artifacts/`.
- Design notes, plans and review records are under `docs/superpowers/` (start with `HANDOFF-2026-08-19.md`).
