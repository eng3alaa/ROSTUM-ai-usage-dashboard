# AI Usage Dashboard v2 — Accounts Hub & Rich Content

**Date:** 2026-08-15
**Status:** Implemented through Plan 3 (v3).
**Target:** `AI Usage Dashboard.html` (single self-contained file, evolved in place — Approach A)

## Background

v1 is a 2,285-line single-file dashboard that aggregates AI usage from Claude Code/Desktop local logs, the Anthropic and OpenAI admin APIs, and file imports (ChatGPT/Claude.ai exports, CSV). It has KPI tiles, a daily stacked chart, model/project/platform breakdowns, an editable price list for API-rate cost estimates, CSV export, themes, and persistence. It was verified by a 27-check headless rig against synthetic logs.

The user asked for: **"a login for each AI"** (clarified: an accounts hub with a login-style connect flow per platform), plus **"check, study, enhance — rich content"** (clarified: all four packs — insights & analytics, visual identity, reports & summaries, budgets & alerts).

## Goals

1. Replace the flat data-source cards with an **Accounts hub**: one account card per platform with connect/validate/sync/disconnect lifecycle, status, identity label, and per-platform mini-stats.
2. Add connectors for **Gemini (Google AI)**, **GitHub Copilot**, and **OpenRouter** alongside the existing four sources.
3. Add an **insights & analytics pack**, **visual identity per platform**, **reports & summaries**, and **budgets & alerts**.
4. Preserve every working v1 behavior; all 27 existing checks keep passing.

## Non-goals

- No real OAuth sign-in flows (providers do not expose usage data to local pages via consumer OAuth).
- No account creation or password handling of any kind.
- No scraping of consumer chat sites or session cookies.
- No lock screen / dashboard-level login (offered, not selected).
- No server, no build step, no install — the file must keep working by double-click (`file://`).

## Architecture

### Connector registry

A single `CONNECTORS` registry drives everything. Each entry:

```js
{
  id: 'openrouter',            // platform key used across events, chips, budgets
  name: 'OpenRouter',
  mark: '<svg…>',              // hand-drawn monogram SVG, original artwork
  brand: '#6467f2',            // accent tint (cards/chips only, never chart series)
  credential: 'api-key' | 'folder' | 'files' | 'token',
  helpSteps: [...],            // where to get the credential, with direct links
  validate(cred) → {ok, label, detail} ,  // live check, returns identity label
  fetch(cred, opts) → events[],           // normalized usage events (may be partial)
  fallbackCommand(cred, opts) → string,   // PowerShell command when CORS blocks
  capabilities: {history: bool, cost: bool, validateOnly: bool}
}
```

Account cards, connect modals, sync, status handling, and drill-downs are generic components rendered from this registry. Adding a future platform = adding one registry entry.

### Normalized event schema (extended from v1)

```
{ day, hour?, platform, model, project?, input, output, cacheRead, cacheWrite,
  messages, costBilled?, source }
```

`hour` (0–23, local) is new — populated only where timestamps exist (local Claude logs, imports with timestamps). API daily buckets leave it undefined.

## Platform connectors

| Platform | Credential | Validation | Usage data | Notes shown on card |
|---|---|---|---|---|
| Claude Code/Desktop | Folder picker (File System Access API) | Folder readable, `projects/` found | Exact tokens per model/project/day/hour from `.jsonl` (v1 parser) | Folder name, session count |
| Anthropic API | Admin key | `GET /v1/organizations/me` → org name (live, or implicitly via fallback paste) | `usage_report/messages` + `cost_report` (v1 parsers) | Real billed usage & cost |
| OpenAI API | Admin key | 1-day usage probe (live, or implicitly via fallback paste) | `organization/usage/completions` + `organization/costs` (v1 parsers) | Real billed usage & cost; browser calls usually CORS-blocked → fallback |
| Gemini (Google AI) | API key | `GET generativelanguage.googleapis.com/v1beta/models?key=…` → model count | **No usage-history API.** Guided import of a Cloud Billing export CSV; validation + live model list only | Card states this limitation plainly |
| GitHub Copilot | Fine-grained PAT (`Plan: read`) | `GET api.github.com/user` → username | `GET /users/{username}/settings/billing/usage` — Copilot premium-request items where GitHub exposes them; otherwise plan/seat status only | Best-effort; endpoint availability varies by account type |
| OpenRouter | API key | `GET openrouter.ai/api/v1/key` → key label, limits | `GET /api/v1/credits` (balance, lifetime usage) + `GET /api/v1/activity` (daily per-model usage). If `activity` is denied for the key type, fall back to credits totals | Covers DeepSeek/Grok/Mistral etc. when routed through OpenRouter |
| Imports | Files (drag & drop) | n/a | v1 parsers: ChatGPT `conversations.json`, Claude.ai export, generic CSV; token counts estimated when absent and marked `est.` | File count, last import |

**CORS policy per connector:** Gemini, GitHub, and OpenRouter are browser-callable. Anthropic admin and OpenAI admin endpoints may be blocked from `file://` pages; each connect modal embeds the v1-style PowerShell fallback (copy command → run → paste JSON back). When live validation is CORS-blocked, successfully parsing pasted fallback output counts as validation and marks the card connected in "manual mode". The fallback is part of the connector entry, not a separate UI.

**Key storage:** keys/tokens are kept in memory for the session; persisted to `localStorage` only when the user enables "Remember on this device" (v1 behavior, now per connector). Disconnect clears the stored credential and connector status; it asks whether to also delete that platform's imported events.

## UI

### Accounts hub

A responsive card grid directly under the filter bar, one card per registry entry:

- Header: SVG mark in a brand-tinted chip, platform name, status dot — **green** connected · **amber** attention (validation ok but last sync failed, or data older than 7 days) · **gray** not connected.
- Body: identity label (org/username/key label/folder), last sync time, 30-day tokens & cost for that platform, budget progress bar when a budget is set.
- Footer buttons: **Connect** (or **Manage** when connected) → modal; **Sync**; **Disconnect**.
- Clicking the card body (not buttons) drills down: sets the platform filter and opens the platform detail panel.

### Connect modal (generic, driven by registry)

Steps list with links → credential input (masked) → **Validate & connect** with live result → remember toggle → fallback section (collapsed by default; auto-expanded when a fetch fails with a network/CORS error).

### Platform detail panel (drill-down)

Full-width panel below the hub when active: that platform's daily chart, per-model table, per-project table (local logs only), source freshness, and its budget controls. Close restores the previous filter.

### Insights row

New cards between KPIs and the daily chart:

1. **Projection** — month-to-date cost and projected month-end: `MTD + avg(last 7 full days) × remaining days`, labeled "projection", with the trend vs. last month.
2. **Calendar heatmap** — last 13 weeks × 7 days, sequential scale on the active metric (cost or tokens), tooltip per day, respects platform filters.
3. **Efficiency** — per model: average cost per message and tokens per message (only models with ≥ 20 messages, to avoid noise).
4. **Cache savings** — Anthropic cache reads × (input price − cache-read price), shown as "$ saved vs uncached".
5. **Busiest hours** — 24-bin histogram from events that carry `hour`; hidden with an explanatory note if no timestamped events exist in range.
6. **Week-over-week chips** — this ISO week vs last: tokens, cost, messages.
7. **Top movers** — projects with the largest cost change vs the previous equal-length period.

### Narrative summary ("This period in AI")

A card that renders template sentences from the filtered aggregates: totals, top model, top platform/project, biggest day, WoW change, projection, and budget status. Every sentence has an empty-data guard; the card degrades to "Not enough data in this range" rather than emitting broken sentences.

### Reports

- **Print report** button → `@media print` stylesheet: header with range and generation date, KPIs, charts (SVG prints as-is), breakdown tables, narrative; hub/controls hidden. Browser print → PDF.
- CSV export stays as in v1.

### Budgets & alerts

- Budget editor on each account card's detail panel + a **Total** budget in the pricing/settings area. Stored as `{platformId|'total': monthlyUSD}`.
- Progress bars: month-to-date cost (billed where available, otherwise estimated) vs budget.
- Dismissible banners at the top of the page: ≥ 80% ("approaching"), ≥ 100% ("exceeded"), and projected overrun ("on pace to exceed by $X"). Dismissal is stored per `(alertKey, YYYY-MM)` so alerts return next month.

### Visual identity

- Original monogram SVG marks (no copied trademark artwork) with brand-tinted chips per platform; used on cards, chips, legends, and detail panels.
- Chart series keep the existing accessible dataviz palette — brand colors are identity, not data encoding.
- All new UI honors both themes via the existing CSS custom properties; no hardcoded colors outside the token blocks.

## Storage

`localStorage`/IndexedDB (as v1) with new keys: `connectors` (per-platform: status, label, lastSync, rememberedCred?), `budgets`, `dismissedAlerts`. Event store schema gains optional `hour`. A one-time migration stamps existing stored events with `hour: undefined` — no destructive changes; v1 data loads unchanged.

## Error handling

- Validation failures are specific: 401 → "key invalid/revoked"; 403 → "key lacks admin/org permission — needs an *Admin* key"; network/CORS → auto-open fallback command; 429 → "rate-limited, retry in a minute".
- A connector error never blocks the rest of the dashboard: cards degrade to amber/gray with the message inline.
- Parsers reject malformed fixtures loudly in the import status line (v1 behavior). Note: v1 only dedupes *within* a single scan — the 2026-08-15 code review confirmed cross-source and re-import double-counting; v2 makes merge/dedupe semantics explicit (see "v1 defects folded into v2").

## Testing

Extend the existing headless-Chromium rig (synthetic Claude logs + assertions):

1. All 27 v1 checks unchanged and passing.
2. Fixture-driven parser checks for the three new connectors (canned JSON for GitHub billing usage, OpenRouter key/credits/activity, Gemini models list; canned Cloud Billing CSV).
3. Math checks: projection, cache savings, WoW deltas, efficiency, budget thresholds (79/80/100% boundaries), heatmap day-bucketing across month edges.
4. Narrative generator: sentence output for a rich fixture and the empty-data guard.
5. UI smoke: hub renders 7 cards with correct states from a seeded `connectors` store; drill-down sets the filter; alerts appear and dismiss; light + dark screenshots.
6. Print stylesheet smoke: `@media print` emulation renders without the hub/controls.

## v1 defects folded into v2 (from the 2026-08-15 code review)

The pre-v2 review (`docs/superpowers/reviews/2026-08-15-v1-code-review.md`) confirmed 9 defects. v2 fixes all of them, each with a regression check:

1. **CSV re-import double-counting** (v1 line 2033, major): imports merge by (day, platform, model); billed entries keyed by day — never blind concat.
2. **sniffJSON keys off the first bucket only** (line 1194, major): sniff on the first *non-empty* bucket; all-empty payloads are their own handled case, and a cost file can never overwrite usage data.
3. **Local logs double-counted across `local` + `local-import`** (line 2072, major): dropped .jsonl files fold into the same source/dedupe space as the folder scan.
4. **No chart bucketing on wide ranges** (line 1348, major): bucket to weeks/months beyond ~160 columns; one delegated pointer handler instead of per-day listeners.
5. **No connector registry** (line 705, major): solved by this design's `CONNECTORS` registry.
6. **CSV formula injection in export** (line 2087, minor): neutralize `= + - @ TAB CR` prefixes in every exported cell.
7. **Full re-parse on every scan** (line 2143, minor): per-file aggregate cache keyed (path, size, lastModified) in IndexedDB; only changed files re-parse.
8. **Import parse freezes the tab** (line 2038, minor): visible per-file "Parsing…" status with a paint before each parse; chunked/worker parsing for large exports.
9. **UTC day-bucket shift in UTC-negative timezones** (line 999, minor): provider buckets and date-only strings use UTC date extraction.

A second, independent review by OpenAI Codex (`docs/superpowers/reviews/2026-08-15-codex-second-opinion.md`) reproduced the findings above and surfaced four more, each verified against the source:

10. **Stale billed data after a failed/empty cost fetch** (lines 1117, 1987, 2010): cost failures are swallowed and billed data only overwrites when non-empty, so old billed costs are silently presented as current (and can mix orgs after a key switch). v2 commits usage + cost + fetch metadata atomically and marks billed data stale/unavailable when a cost fetch fails.
11. **ChatGPT branch inflation** (lines 892–895): the parser counts every branch of `conv.mapping`, including regenerated/edited messages. v2 follows the `current_node` parent chain (active branch only), with a defined fallback when `current_node` is absent.
12. **Out-of-order refresh commits** (line 2127): `refreshAll()` fires scans/fetches without awaiting; an older slow response can overwrite a newer one. v2 uses a per-connector generation counter (+ AbortController); only the latest generation commits.
13. **CSV numeric validation** (line 984): `parseFloat(...) || 0` admits `Infinity` and prefix-garbage numbers. v2 validates with `Number()` + `isFinite`, rejects negative counts, and surfaces rejected rows in the import note.

Also carried in from unverified-but-plausible review notes: fallback commands containing a key are only rendered into the DOM on user request; localStorage quota failures surface in the UI; literal NUL separators become escaped forms; projects from dropped .jsonl files persist correctly.

## Plan 2 backlog (carried from the Plan 1 integration review, 2026-08-15)

Non-blocking findings from the final whole-branch review of v1.1, accepted as Plan 2 work items alongside deferred defects #5 (connector registry) and #7 (incremental scan cache):

1. **sid row multiplication**: per-session aggregation rows multiply storage/render volume for heavy multi-session days — add a sid side-index or store sids as a list on merged rows, plus a retention policy for the localStorage blob. — DONE (Plan 2)
2. **Week-bucket edge labels**: a range starting mid-week labels its first bucket "Week of <Monday before the range>" — clamp displayed labels to the range. — DONE (Plan 3)
3. **Delegated chart pointer handler**: defect #4's second clause (one pointermove handler on the SVG deriving day index from x) — bucketing bounds the cost today; finish the remedy in the chart rewrite. — DONE (Plan 3)
4. **Worker/chunked import parsing**: defect #8's second clause — the tab still freezes on very large exports, now with honest feedback; move parse to a Blob worker in v2. — DONE (Plan 3)
5. **Harness default storage isolation**: `openDashboard` should clear `aiusage:*` storage unless seeding, instead of relying on per-check discipline. — DONE (Plan 2)
6. **postRun coverage on throw**: `tests/run.mjs` skips a module's `postRun` if its `run` throws — move postRun into a finally or its own try. — DONE (Plan 2)
7. **scanHandle catch gen-guard**: fetch error paths are gen-guarded; the folder-scan catch is not (low risk, same category). — DONE (Plan 2)
8. **Soft-fail race check**: the import-vs-fetch gen guard is covered by a hard-reject check; add a usage-OK-cost-null variant to pin the soft-fail path explicitly (mechanism verified manually in the final review). — DONE (Plan 2 T10 pin)
9. **Superseded-fetch status text**: when an import supersedes an in-flight fetch, the fetch bails before updating its status line, leaving "Fetching usage…" stuck (cosmetic; data correct). Reset or annotate the status on bail; the accounts-hub card states in v2 subsume this. — DONE (Plan 2 T10), with one residual cosmetic case for Plan 3: two overlapping fetches on the SAME connector — the older bail can blank the newer's in-flight placeholder (self-heals on resolve). — DONE (Plan 3 T9)
10. **Drill-down persistence** (Plan 2 T9 review): drill-down mutates hiddenPlatforms without persisting to LS, unlike chip toggles — decide in Plan 3 whether ephemeral is intended (likely yes: document it) or persist for consistency. Known leak path: a chip click AFTER a drill persists the drill-derived hide set. — DONE (Plan 3)

Recorded scope notes and deferred minors from the Plan 2 final integration review (all Plan 3 work):

11. **Platform detail panel**: the spec's drill-down section promises a detail panel; Plan 2 shipped filter-drill only. The panel belongs with Plan 3's insights work. — DONE (Plan 3: drill-down + insights row constitute the detail view; no separate panel)
12. **Fallback auto-expand on CORS failure** (spec Connect modal section): not yet wired for the new connectors (all three are browser-callable; revisit only if real-world blocks appear). The registry also simplified the spec's function-valued `validate/fetch/capabilities` fields into a data table + `fetchMethod` string — record as the accepted design. — accepted (registry-as-data design)
13. **Color slots**: 9 platforms now exceed the 8 accessible series slots — an `Other`-bucket collision can render two gray "Other" legend entries. Plan 3's chart work should widen the palette or fold overflow honestly. — DONE (Plan 3)
14. **Hidden source cards**: connected Gemini/Copilot/OpenRouter cards stay hidden in the Data sources section (reachable only via hub Manage) — decide whether to reveal on connect or remove the legacy section once the hub fully replaces it. — DONE (Plan 3)
15. **Scan meta diagnostics**: `parseClaudeLogsCached` drops `lines`/`badLines` from meta — restore malformed-line reporting through the cached path. — DONE (Plan 3)
16. **ScanCache eviction**: `scan:` IDB entries are never pruned; edited files orphan old signatures. Add pruning on rescan or clear-data. — DONE (Plan 3)
17. **Scan cache stores post-dedup subsets** (Plan 2 fix-round residual): when cross-file duplicate messages exist, the losing file's cache entry omits the shared messages; if the winning file later vanishes, scans under-count until the loser's signature changes. Plan 3: cache full per-file rows+ids and dedupe at merge time. — accepted trade-off (documented: under-count self-heals on file change; full-rows caching deferred)
18. **v1.1 → v2 hub migration**: persisted v1.1 data has no `connectors` entries, so existing users see all-gray "Not connected" cards (with their data still charted) until the first re-sync. Plan 3: one-time `load()` migration synthesizing `{label: 'stored data', lastSync: meta.updated}` for sources present without a connector entry; also give kept-but-disconnected cards a data-removal affordance. — DONE (Plan 3)

## Acceptance criteria

- Each of the 7 platforms has an account card with working connect → validate → sync → disconnect lifecycle and truthful capability notes.
- Gemini/Copilot/OpenRouter data lands in the same normalized store and appears in every existing chart, table, filter, and the cost model.
- All four rich-content packs render with real data and degrade gracefully with none.
- One file, double-clickable, ≤ ~300 KB, no external requests except the user-initiated connector calls.
- Full check suite green; both themes visually verified.
