# AI Usage Dashboard v4 — Every LLM + Customizable View

**Date:** 2026-08-16
**Status:** Implemented — Wave 1 (Plan 4a, merged) + Wave 2 (Plan 4b, branch v4b-wave2; integration review + merge decision pending). See "Wave 2 status" below.
**Target:** `AI Usage Dashboard.html` (single self-contained file; v3 = 127 checks green)
**Research basis:** `2026-08-16-llm-platform-research.json` (40 platforms, web-verified Aug 2026 by 4 research agents + 6 skeptic verifications; every card's copy must match its row).

## Background

v3 ships an accounts hub with 7 connectors (Claude Code/Desktop, Anthropic API, OpenAI API, Gemini API, GitHub Copilot, OpenRouter, Imports), insights, narrative, budgets, print. The user asked: (1) **"check what else I can add — by login or web login"**, (2) **"add everything LLM — by locating a folder, or by web login/login"**, (3) **"give me the option to hide and unhide"**.

Research finding that shapes the design: **consumer web-login usage access does not exist** for any chat product (ChatGPT, Claude.ai, Gemini, MS Copilot, Perplexity, Grok, Meta AI, DeepSeek chat) — their usage endpoints are cookie-bound and CORS-blocked from a local page, with no OAuth usage scope. The real paths are: **local log folders** (many coding tools + local runners write exact token counts), **local servers**, **API/admin keys**, **cloud CLI tokens**, and **data exports**. The design says this plainly on every card.

## Goals

1. **Hide/unhide** for account cards, dashboard sections, individual insight cards, and the legacy Data sources section — persisted, always reversible, connected cards auto-reveal.
2. **Every viable platform** from the research table, honestly labeled by data quality; platforms with no path get a link-only card.
3. **Generic connector kinds** so each new platform is one registry entry + one small parser/adapter, not bespoke code.
4. **Hub at scale**: category groups, connected-first ordering, search when >12 cards.
5. Preserve all v3 behavior; suite stays green; single file ≤ 600 KB.

## Non-goals

- No consumer OAuth / cookie-session scraping of chat sites (impossible from file:// and against the honesty rules).
- No bundled proxy/server binaries. The optional **usage-logger** for local runners is a documented one-file script the user runs themselves; the dashboard only READS its JSONL.
- No persistence of cloud CLI tokens (session-only by design).
- Anyscale: not added (no LLM-usage path; recorded here as intentionally excluded).

## Architecture

### View preferences (`aiusage:view`)

```
{ hiddenCards: [connectorId], collapsed: [sectionId], hiddenInsights: [insightKey], showLegacySources: bool }
```
- Account cards: hover ✕ → hidden; "**N hidden — show**" chip restores; `Store.connectors[id]` transitioning to connected removes the id from `hiddenCards` (auto-reveal).
- Sections: each major card header gets a ▾/▸ toggle (insights row, narrative, daily chart, by-model, platform share, model breakdown, projects, budgets, price list, data sources). Collapsed = body hidden, header stays. Print ignores collapse.
- Insight cards: ✕ per card, "show all insights" chip.
- Data sources section: hidden by default in v4 (the modal hosts the real cards); settings toggle "show legacy source cards".

### Connector kinds (registry `kind` + shared driver)

| kind | credential | driver behavior | data quality |
|---|---|---|---|
| `folder-log` | folder pick / file drop | glob-match files → per-platform parser → rows (exact tokens, hour, project); incremental cache by (path,size,mtime); reuses the Claude-log scan pipeline generalized (`scanFolder(connector, handle)`) | exact (or estimated where the format lacks counts — Aider fallback, Jan input) |
| `local-server` | base URL | validate ping; then one of: **history** (LocalAI `/api/usage`), **metrics-poll** (vLLM/llama.cpp `/metrics` counter diffs → daily rows while page open, persisted), **live-validate** (Ollama `/api/ps`, GPT4All/Jan `/v1/models`) + optional usage-logger JSONL via folder-log | exact (poll/live: "counts while this page is open" label) |
| `api-key` | key | validate URL; optional usage fetcher (Fireworks billingUsage; DeepSeek balance) | exact / validate-only |
| `cloud-token` | pasted CLI token (session-only) | Azure Monitor metrics + Cost Mgmt; GCP Monitoring + BigQuery billing; AWS CloudWatch + Cost Explorer via in-page SigV4 | exact + billed |
| `export-file` | dropped file | shape-sniffed parser (Gemini Takeout, Grok, MS Copilot CSV, Perplexity, Meta AI, DeepSeek chat + API ZIP, Cursor CSV) | estimated / exact per format |
| `link-only` | none | honest card: reason + vendor usage-page link | none |
| existing `admin-key` / `folder` / `files` | unchanged | Anthropic/OpenAI/local Claude/imports | as today |

The registry entry carries: `id, name, category, kind, platform, brand, mark, statusEl?, quality ('exact'|'estimated'|'validate'|'none'), qualityNote, patterns? (folder-log globs), parser? (function name), baseUrl? (local-server default), validate? (url or fn name), fetchMethod?, links {get, usage}`. Drivers are generic; per-platform code = parser or fetcher only.

### Hub at scale

Groups in this order: **Coding tools · Chat apps · Local runners · API vendors · Cloud**. Group headers collapsible (View store). Within a group: connected → attention → disconnected, then registry order. A search box appears above the hub when visible cards > 12; it filters by name. Existing 7 connectors map: Claude Code/Desktop → Coding tools; Anthropic/OpenAI/Gemini/OpenRouter → API vendors; Copilot → Coding tools; Imports → Chat apps (front door for all export-file formats).

### Platform table (from research; card copy must match)

| Platform | Category | Data quality | Best method | Path / endpoint | Confidence |
|---|---|---|---|---|---|
| ChatGPT web + desktop app (consumer) | chat-app | estimated | data-export-file | Settings > Data controls > Export data -> ZIP: conversations.json, chat.html, message_feed | high |
| Claude.ai web + Claude Desktop app | chat-app | estimated | local-logs-folder | ~/.claude/projects/**/*.jsonl (Cowork+Code transcripts, tokens); Claude/local-agent-mode-s | high |
| Gemini web app (gemini.google.com) incl. Google Takeout | chat-app | estimated | data-export-file | Takeout/My Activity/Gemini Apps/MyActivity.json (choose JSON format) | high |
| Microsoft Copilot (consumer + Microsoft 365) | chat-app | estimated | data-export-file | account.microsoft.com/privacy > Copilot activity history > Export all activity history (CS | medium |
| Perplexity | chat-app | estimated | data-export-file | Settings > Account > Request data export (ZIP of JSON) / privacy@perplexity.ai | medium |
| Grok / xAI (chat + API) | chat-app | exact | admin-key | POST https://management-api.x.ai/v1/billing/teams/{teamId}/usage ; GET /v1/billing/teams/{ | high |
| Meta AI (meta.ai / Facebook / Instagram / WhatsApp) | chat-app | estimated | data-export-file | Accounts Center > Download your information (JSON/HTML) ; WhatsApp /download-all-ai-info | medium |
| DeepSeek (chat + API) | chat-app | validate-only | data-export-file | chat.deepseek.com Settings > Data > Export data (JSON archive) | high |
| Cursor | coding-tool | exact | admin-key | https://api.cursor.com/teams/filtered-usage-events (POST), /teams/daily-usage-data (POST), | high |
| Windsurf / Codeium (now Cognition 'Devin Desktop') | coding-tool | validate-only | admin-key | POST https://server.codeium.com/api/v1/UserPageAnalytics (also /Analytics, /CascadeAnalyti | medium |
| GitHub Copilot | coding-tool | exact | local-logs-folder | Copilot CLI: %USERPROFILE%\.copilot\session-state\<session-id>\events.jsonl (+ %USERPROFIL | high |
| Cline / Roo Code (VS Code extensions) | coding-tool | exact | local-logs-folder | Cline: %APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\tasks\<taskId>\ui_messages | high |
| Continue.dev | coding-tool | exact | local-logs-folder | %USERPROFILE%\.continue\dev_data\<schemaVersion, e.g. 0.2.0>\tokensGenerated.jsonl, chatIn | high |
| Aider | coding-tool | estimated | local-logs-folder | Per-repo: .aider.chat.history.md (AIDER_CHAT_HISTORY_FILE), .aider.input.history; optional | medium |
| Gemini CLI | coding-tool | exact | local-logs-folder | %USERPROFILE%\.gemini\tmp\<project_hash>\chats\session-*.json (auto-recorded sessions; ~/. | medium |
| OpenAI Codex CLI | coding-tool | exact | local-logs-folder | %USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-<timestamp>-<uuid>.jsonl (+ ~/.codex/arch | high |
| Amazon Q Developer (IDE) / Kiro CLI (ex Q Developer CLI) | coding-tool | none | local-logs-folder | Kiro CLI: ~/.local/share/kiro-cli/data.sqlite3 (Linux), ~/Library/Application Support/kiro | medium |
| JetBrains AI Assistant / Junie | coding-tool | estimated | local-logs-folder | Junie IDE plugin: %LOCALAPPDATA%\JetBrains\<IDE-version>\projects\<project>\matterhorn\.ma | medium |
| Ollama | local | exact | local-server | http://localhost:11434 — POST /api/generate, POST /api/chat (native), POST /v1/chat/comple | high |
| LM Studio | local | exact | local-logs-folder | macOS/Linux: ~/.lmstudio/conversations/ ; Windows: %USERPROFILE%\.lmstudio\conversations\  | medium |
| llama.cpp (llama-server) | local | exact | local-server | http://localhost:8080 — POST /completion (fields tokens_evaluated, tokens_predicted, timin | high |
| vLLM | local | exact | local-server | http://localhost:8000 — GET /metrics (Prometheus, on by default: vllm:prompt_tokens_total, | high |
| LocalAI | local | exact | local-server | http://localhost:8080 — GET /api/usage?period=day/week/month/all (current/'local' user; ti | medium |
| GPT4All | local | validate-only | local-server | http://localhost:4891/v1 (Settings > Application > Advanced > 'Enable Local API Server'; p | high |
| Jan.ai | local | estimated | local-server | http://127.0.0.1:1337 (prefix /v1 configurable) — POST /v1/chat/completions, GET /v1/model | medium |
| text-generation-webui (oobabooga) | local | estimated | local-server | http://127.0.0.1:5000 (--api, --api-port, OPENEDAI_PORT) — POST /v1/chat/completions, /v1/ | high |
| Mistral (La Plateforme) | api | validate-only | api-key | GET https://api.mistral.ai/v1/models | medium |
| Cohere | api | validate-only | api-key | POST https://api.cohere.com/v1/check-api-key ; GET https://api.cohere.com/v2/models | high |
| Together AI | api | validate-only | api-key | GET https://api.together.xyz/v1/models | high |
| Fireworks AI | api | exact | api-key | GET https://api.fireworks.ai/v1/accounts/{account_id}/billingUsage ; POST .../billingUsage | high |
| Groq | api | validate-only | api-key | GET https://api.groq.com/openai/v1/models | high |
| Perplexity API (Sonar) | api | validate-only | api-key | GET https://api.perplexity.ai/v1/models | medium |
| DeepSeek API | api | exact | data-export-file | platform.deepseek.com/usage -> Export monthly data (ZIP: amount-*.csv + cost-*.csv) | medium |
| xAI (Grok API) | api | validate-only | admin-key | POST https://management-api.x.ai/v1/billing/teams/{team_id}/usage ; GET .../prepaid/balanc | medium |
| Azure OpenAI (Microsoft Foundry) | api | exact | oauth | GET https://management.azure.com/{resourceId}/providers/microsoft.insights/metrics?api-ver | medium |
| AWS Bedrock | api | exact | api-key | POST https://monitoring.{region}.amazonaws.com/ (GetMetricData, Namespace AWS/Bedrock, Dim | high |
| Google Vertex AI | api | exact | oauth | GET https://monitoring.googleapis.com/v3/projects/{project}/timeSeries (metric.type aiplat | medium |
| Hugging Face Inference Providers | api | validate-only | api-key | GET https://huggingface.co/api/whoami-v2 | high |
| Replicate | api | none | api-key | GET https://api.replicate.com/v1/account ; GET https://api.replicate.com/v1/predictions | medium |
| Anyscale | api | none | none |  | high |

Wave assignment: **Wave 1** = View layer, hub grouping/search, `folder-log` driver + parsers (Codex CLI, Gemini CLI, Copilot CLI, Continue.dev, Cline, Roo Code, Aider, JetBrains Junie, LM Studio, Ollama history), Ollama `local-server` live-validate + usage-logger doc, Gemini Takeout export parser, Cursor CSV export parser. **Wave 2** = LocalAI history, vLLM/llama.cpp metrics-poll, GPT4All/Jan/text-generation-webui, Fireworks + DeepSeek api-key, cloud-token trio (Azure/Vertex/Bedrock), remaining export parsers (Grok, MS Copilot, Perplexity, Meta AI, DeepSeek chat/API ZIP), validate-only vendors (Mistral, Cohere, Together, Groq, HF, xAI, Perplexity API, Windsurf), link-only (Amazon Q, Replicate), Claude.ai Enterprise Analytics API (admin-key kind).

Wave 1 status: DONE (Plan 4a) — with Ollama desktop db.sqlite history deferred to Wave 2 (needs sql.js), and folder-log projects not yet surfaced in the Projects table.

Wave 2 status: DONE (Plan 4b, branch v4b-wave2, 20 commits, suite 298/298 ×2, 441 KB, 0 control bytes) — `link-only` kind (Amazon Q / Kiro, Replicate, Windsurf); generic key driver `App.connectKey` (api-key / admin-key / cloud-token, `keyLabel`/`keyHint`, extra `fields`, `sessionOnly`); validate-only vendors (Mistral, Cohere, Together AI, Groq, Hugging Face, xAI API, Perplexity API); `connectServer` rows extension + LocalAI history; `parsePrometheus` + metrics-poll driver (`App.startPoll` / `stopPoll`, `LS poll:<id>` baseline, "counts while this page is open") for vLLM + llama.cpp; GPT4All (validate), Jan (server + threads folder-log, est), text-generation-webui (logs folder-log, est + server); Fireworks AI (exact tokens + billed); `readZipEntries` + DeepSeek API (balance validate + monthly usage ZIP, routed through Imports); Claude Enterprise Analytics (usage_report + cost_report) + the Anthropic cost cents fix (string/number amounts are lowest units → /100); cloud-token trio — Azure OpenAI (Monitor metrics + Cost Management), Google Vertex AI (Monitoring token_count + optional BigQuery billing export), `sigv4Sign` + AWS Bedrock (CloudWatch + Cost Explorer); `export-file` kind + chat-export parsers (Grok, DeepSeek chat, Meta AI, Perplexity ZIP/JSON, Microsoft Copilot activity CSV) with front-door cards for ChatGPT / Claude.ai / Grok / Microsoft Copilot / Perplexity / Meta AI / DeepSeek chat; `readSqliteTable` + Ollama desktop `db.sqlite` history (est — resolves Wave 1 note (a) without sql.js); folder-log projects in the Projects table (Codex cwd, Gemini CLI project-hash folder, Copilot CLI cwd, Junie project dir; `Store.projectsBy`; scan cache v5 — resolves Wave 1 note (b)); price rows for Grok 4 / Grok fast-mini / DeepSeek Reasoner / DeepSeek chat / Perplexity Sonar / Meta AI (+ `^copilot$` on the ChatGPT row). Registry: 46 entries (17 Wave 1 + 29 Wave 2), all five hub groups populated; 97-registry pins the per-entry invariants.

Wave 2 deviations from the platform table (honesty first — the card copy is the source of truth):
- **Windsurf** — table: validate-only via server.codeium.com analytics (admin-key). Shipped **link-only**: Windsurf meters prompt credits, never tokens; individual plans have no usage API or export (windsurf.com/subscription/usage shows credits only), and the Teams/Enterprise `UserPageAnalytics` endpoint takes the service key in the JSON body, is CORS-blocked from a `file://` page and is not available on Free/Pro. The card says so and links to the usage page.
- **Perplexity API** — table: validate-only via `GET /v1/models`. Shipped validate-only, with the card stating the caveat: `/v1/models` is unauthenticated, so the card can only confirm the API is reachable — it cannot verify the key (only a paid completion would); there is no balance or usage endpoint for Sonar keys, spend and invoices live on the API console Billing tab (no export), and the org-admin analytics endpoint covers the "Computer" product only, not Sonar. Consumer Perplexity usage comes from the data export (separate export-file card).
- **Amazon Q Developer / Kiro** — table: local-logs (Kiro CLI `data.sqlite3`). Shipped **link-only** with the reason: personal accounts (Free tier / Builder ID) have no usage API or export and the IDE plugin writes no usable local log; org-admin reports land in S3/CloudWatch behind AWS SigV4 (admin only; counts, not tokens or dollars); the Kiro CLI SQLite schema is undocumented and unverified — `readSqliteTable` now exists, so a Kiro reader can follow once the schema is confirmed (Post-4b backlog).
- **Replicate** — table: api-key (none). Shipped **link-only**: api.replicate.com sends no CORS headers, so even key validation fails from `file://` (verified by preflight); there is no spend API or CSV export — billing is dashboard-only.
- **Ollama desktop history** is read without sql.js (`readSqliteTable`: no WAL, no WITHOUT ROWID — close the app first so the -wal sidecar is checkpointed); the DB carries no token counts, so rows are chars ÷ 4 estimates (`est:1`; input = the previous user message).
- **Projects table labels**: Codex / Copilot CLI use `prettyProject(cwd)` (same normalization as Claude Code, so one repo used from several tools is one row); Gemini CLI shows `~/.gemini/tmp/<hash>` (no cwd in the session file); Junie shows the `projects/<project>` dir name (JetBrains' `.<hash>` cache suffix stripped); unknown → `(unknown project)` (same bucket as Claude Code).
- **Scan cache** prefix moved to `scan:v5:` (parsers now emit project rows) — one-time re-parse of existing folders; older-version keys are swept. **Prices**: a saved custom price list keeps its rows; Reset to defaults picks up the Wave 2 rows.
- Still deferred (Post-4b backlog): Aider `--analytics-log` JSONL, Gemini CLI telemetry outfile, VS Code Copilot Chat OTel file, Cursor `state.vscdb`, Kiro CLI `data.sqlite3`, the Post-4a backlog items 1–11 below.

Plan 4a integration review (2026-08-19, 7 lenses + adversarial verification, 16 confirmed findings — all fixed on the branch, suite 209/209 ×3): Ollama dual driver (own gen slot, per-half status/label/err, unreachable server keeps a data-owned folder entry connected — no phantom auto-reveal); Cline/Roo per-request model from model_usage[] + inclusive-of-cache tokensIn subtraction (Roo, OpenAI-protocol Cline); Cursor CSV four ADDITIVE token columns reconciled with Total Tokens; row-level `local:1` (Continue provider, Cline/Roo model_provider_id, Aider LiteLLM prefix, Codex model_provider) → $0 alongside the platform gate; Pricing.resolve normalizes vendor-native Claude ids (dotted / family-last / dated); compactRows compacts by age regardless of sid; hub search drops its query when the box hides + no-match note; Cursor re-import rewrites the billed envelope; Budgets editor lists every platform with data; non-Claude .jsonl on Imports no longer wipes local-import; ScanCache v4 (stale keys swept); copy corrections (Local open-weight row, Copilot CLI list-price statement, Gemini CLI prune, CORS wording, busiest-hours "last 90 days").

### Post-4a backlog (from the 2026-08-19 integration review; not blockers, carry into Plan 4b or later)

1. Imports dropzone: sniff-route non-Claude .jsonl (Codex rollout / Copilot CLI events / Continue tokensGenerated / Junie / usage-logger) to the registered folder-log parser under that connector's srcId (today: honest "no Claude Code messages — use the tool's hub card" note only).
2. Per-file scan-cache order dependence: a file whose ids were all skipped as duplicates of an earlier file is cached empty; if the earlier file disappears, the survivor's stale empty entry hides its usage until that file changes.
3. Codex delta-of-cumulative: a resumed session whose first snapshot is ≥ the previous cumulative is not detected; `last_token_usage` is ignored.
4. Cursor CSV re-import replaces the whole `cursor-csv` source although each export is a date window — merge by window/month instead (label says "re-import replaces").
5. `docs/tools/ollama-usage-logger.mjs`: responses over 8 MB drop the final done/usage chunk and are never logged — stream-parse the usage fields or log the cap honestly.
6. Keyboard focus lands on <body> after ✕ hide, hub-group collapse, hidden-chip restore, and modal close when the hub re-rendered underneath.
7. Cline heuristic: a task with no task_metadata.json and no apiProtocol is treated as inclusive-of-cache (guarded by tokensIn ≥ cr+cw); Roo detection is by connector id — revisit against real files; a Kilo Code entry would need its own flag.
8. Codex custom providers under arbitrary config.toml names cannot be flagged local (only ollama / lmstudio / oss ids are recognized).
9. Busiest hours beyond 90 days: rows compact without hour (label says "last 90 days"); a per-day 24-bucket rollup would keep the histogram for older data.
10. Legacy persisted dual-driver entries without serverLabel/filesLabel show only one half until the next validate (cosmetic; cannot occur for entries created on this branch).
11. Ollama no-cors probe: "something answered at <base>" is the honest ceiling — a non-Ollama HTTP server on 11434 reads as "likely CORS".

## Honesty rules

- Card copy states data quality first: **exact / estimated / validate-only / no data**. Estimated rows carry `est.`.
- Metrics-poll / live connectors say "counts while this page is open — not full history".
- Cloud tokens: never persisted; card explains minting (`az account get-access-token`, `gcloud auth print-access-token`, IAM read-only key).
- No card claims web-login access to consumer chat usage; chat-app cards say "usage comes from your data export".
- Anyscale intentionally excluded; Amazon Q / Replicate / Windsurf link-only with the reason.

**Pricing note.** Local-runner rows (category local: LM Studio, Ollama) are priced $0 by platform, not by model name — hosted models with the same base names (Mistral API, Groq, OpenRouter) still price normally. Users with a saved custom price list keep it as-is (Pricing.load takes the saved list wholesale); Reset to defaults picks up new rows.

## Storage & migration

`aiusage:view` new. Rows unchanged in shape (platform strings extend to new names). `PLATFORM_ORDER` derives from the registry (already). Series palette: 12 slots + honest overflow to Other (existing). ScanCache keys per (connectorId, path, size, mtime) so folder-log platforms don't collide.

## Error handling

Folder-log: unrecognized files skipped and counted; parse errors per file → note, never abort the batch. Local-server: unreachable → "not running" (off, not error); CORS-blocked (Ollama without `OLLAMA_ORIGINS`) → card explains the one-line env fix. Cloud-token: 401 → "token expired — mint a new one". Export: unrecognized shape → "format not recognized" as today.

## Testing

Per parser: synthetic fixture (real format shape, ≥3 lines incl. one duplicate/malformed) + exact-totals check. Per driver: one behavior check (folder-log incremental + skip; local-server validate/unreachable/CORS messages with stubbed fetch; metrics-poll diff math with stubbed /metrics; cloud-token 401 path; export sniff routing). View layer: hide/unhide/persist/auto-reveal/collapse/print-ignores-collapse checks. Hub: grouping order, connected-first, search filter. Suite runs twice per task; whole-branch integration review before each wave's merge; light/dark/print screenshots at each wave end.

## Acceptance

- Every platform in the table has a card whose copy matches its row; hide/unhide works for all four surfaces and persists; connected cards auto-reveal.
- Wave 1 folder-log parsers produce exact totals against fixtures; Ollama validates against a stubbed `/api/ps`; Gemini Takeout and Cursor CSV import as expected.
- File ≤ 600 KB; suite green ×2; both themes + print verified.
