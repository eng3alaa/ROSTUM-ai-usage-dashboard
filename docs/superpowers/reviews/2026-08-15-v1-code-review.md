# Code Review: AI Usage Dashboard.html (v1) — 2026-08-15

Method: 4 dimension reviewers (security / performance / correctness / maintainability) fanned out over the file; 27 raw findings, deduped to 25; the top 10 by severity were each adversarially verified against the source by an independent agent instructed to refute them. All 10 were confirmed (two were the same defect found twice → 9 unique). 15 lower-severity findings were not verified (cap) and are listed as unverified notes.

## Confirmed — Major

| # | Line | Issue |
|---|------|-------|
| 1 | 2033 | **CSV re-import double-counts everything.** The CSV path is the only importer that *concatenates* (`Store.sources.csv.rows.concat(res.rows)`, same for `Store.billed.csv`) instead of replacing. Re-dropping the same or a refreshed cumulative CSV silently doubles tokens, estimated cost, and the "Actual billed" KPI; persists across reloads; only recovery is wiping all sources. Fix: merge by (day, platform, model); billed keyed by day. |
| 2 | 1194 | **sniffJSON reads only `data[0]`.** Providers emit empty buckets (`results: []`) for zero-usage days. An Anthropic usage/cost file whose first bucket is empty is rejected as "format not recognized" — breaking the tool's own PowerShell-fallback workflow (default 90-day window). Worse, an OpenAI *cost* file with an empty first bucket is classified as *usage* and overwrites real fetched usage with all-zero rows. Fix: sniff on first non-empty bucket; all-empty is its own case. |
| 3 | 2072 | **Same .jsonl logs counted twice across sources.** Dropzone .jsonl imports store as `local-import`; the folder picker stores as `local`. `allRows()` concatenates with no cross-source dedupe (the parser's `seen` set is per-invocation), both label as "Claude Code/Desktop", and the subtitle hides that two sources exist. Fix: one dedupe space / one source id for local logs. |
| 4 | 1348 | **No bucketing for wide date ranges.** "All"/custom ranges render one hit-rect + 4 listeners per day (up to 4,000 days ⇒ ~16k listeners) with `barW` clamped to 2px while the band drops below 1px — thousands of DOM nodes rebuilt per interaction for an unreadable, overlapping smear. Fix: bucket to weeks/months past ~160 columns; one delegated pointer handler. |
| 5 | 705 | **No connector registry.** What a "source" is lives in 7 hand-synced places: `PLATFORM_ORDER`, `renderSubtitle`'s if-chain, `sniffJSON` kinds, the import dispatch, `refreshAll`'s refetch list, the clear-data resets, and the HTML card ids. A new platform that misses one spot *silently half-works*. This is the dominant cost of the planned v2 expansion — the v2 spec's `CONNECTORS` registry addresses it directly. |

## Confirmed — Minor

| # | Line | Issue |
|---|------|-------|
| 6 | 2087 | **CSV formula injection in export.** `cell()` handles CSV quoting but not formula prefixes; a crafted `model`/`platform` value from any import path (`=HYPERLINK(...)` etc.) lands as a live formula when the export opens in Excel/Sheets. One-line fix: apostrophe-prefix values starting with `= + - @ \t \r`. |
| 7 | 2143 | **Full re-parse on every load / rescan / auto-refresh tick.** No incremental scanning: every .jsonl is re-streamed and re-parsed even though logs are append-only. Opt-in timer and instant render from saved aggregates soften it, but a per-file cache keyed (path, size, lastModified) — IDB helper already exists — would remove nearly all of the repeat work. |
| 8 | 2038 | **Import parse freezes the tab with zero feedback.** `JSON.parse(await f.text())` plus a synchronous conversation walk on the main thread; status area is cleared *before* and only repopulated *after*. Cheap fix: "Parsing <name>…" + paint before parse; worker for the large tail. |
| 9 | 999 | **UTC day buckets shifted through local-time `dayKey`.** Provider UTC buckets and bare `YYYY-MM-DD` CSV dates land one day early for any UTC-negative user (verified empirically). Currently unreachable on this machine (UTC+3, no DST) — a latent portability bug. Fix: UTC date extraction (`slice(0,10)` / UTC getters) for provider buckets and date-only strings. |

## Unverified notes (found, not adversarially verified — cap of 10)

- Admin API key is embedded (unescaped) in the PowerShell fallback command rendered into the DOM on load, even before the fallback is opened.
- localStorage quota failures on persist are swallowed twice — data loss would be invisible.
- Literal NUL (U+0000) bytes are used as map-key separators in JS string literals — harmless at runtime but makes the file read as binary to grep/rg and some editors; use `\0`/`\u0001` escapes.
- Projects parsed from *dropped* .jsonl files are assigned after persist and never saved.
- Refresh/auto-refresh silently skips API re-fetch unless the key was persisted ("remember" checked).
- Each render makes ~9–10 full passes over the event store; hidden table twins are rebuilt even when the chart view is active; pagination loop duplicated 4× with magic constants; color-slot count hardcoded in two places; Store internals mutated from 8 call sites.

## What looks good

- Streamed .jsonl reading with bounded memory; per-file try/catch so one bad file never kills an import batch.
- Replace-semantics `setSource` everywhere except the CSV path; aggregates persist so the UI renders instantly while scans run.
- Honest estimation labeling (`est.`), editable pricing table, accessible focus/keyboard handling, disciplined two-theme token system.
- The behavioral test rig (27 headless checks) that shipped with v1.

## Second opinion — OpenAI Codex (same day)

An independent review was delegated to the Codex CLI (read-only sandbox, high reasoning effort, explicitly blind to this document). Full text: `2026-08-15-codex-second-opinion.md`.

- **Independently reproduced 8 of the 9 confirmed findings** (all 5 majors, plus formula injection, the import freeze/chart bucketing pair, and the UTC shift). Only the incremental-rescan finding (#7) went unmentioned.
- **Elevated two previously-unverified notes to confirmed** with mechanism: imported projects lost because persist runs before assignment (line 719 vs 2073), and the API key mirrored in plaintext into the PowerShell fallback `<pre>` on every keypress.
- **Four new findings, verified against source by us:** stale billed data presented as current after a failed/empty cost fetch (1117/1987/2010); ChatGPT branch inflation — all mapping branches counted, not just the active `current_node` chain (892–895); out-of-order refresh commits from un-awaited `refreshAll()` (2127); CSV numbers unvalidated — `Infinity`/prefix-garbage accepted (984).
- Codex also found **no XSS sink** (imported strings consistently reach `textContent`), matching the "what looks good" assessment above.

All four new defects were added to the v2 spec as items 10–13 of "v1 defects folded into v2".

## Verdict

**Request changes** — nothing is data-destroying beyond recovery, but three majors (1, 2, 3) silently corrupt the very numbers the dashboard exists to report, and #5 is the main structural risk to v2. All nine confirmed defects are folded into the v2 spec as mandatory fixes with regression checks.

## Status — 2026-08-15 (post Plan 1)

v1.1 (branch `v1.1-defect-fixes`) fixes 11 of the 13 verified defects — #5 (connector registry) and #7 (incremental scan cache) are deferred by design to Plan 2, where they are built once as part of the connector rework. Also fixed: the carried-in unverified-note items (key never rendered into DOM, storage-quota banner, NUL bytes removed, imported projects persisted). Every fix has a regression check; suite: 35 checks green, one commit per fix.

Plan 2 (branch v2-accounts-hub) closes #5 (CONNECTORS registry) and #7 (incremental scan cache).

Plan 3 (branch v3-rich-content) delivers the four rich-content packs and closes backlog 2–4, 9–18.

Plan 4a (branch v4a-view-folder-logs) delivers Wave 1 of the every-LLM spec: view layer (hide/unhide cards, sections, insights, legacy sources), hub groups + search, the generic folder-log driver, 9 folder-log parsers, Ollama local-server + usage-logger, Gemini Takeout + Cursor CSV importers.
