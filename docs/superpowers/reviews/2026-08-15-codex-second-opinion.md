## Major

### 1. CSV exports permit spreadsheet-formula injection

**Lines 2087–2088:** `const cell = (s) => /[",\n]/.test(String(s)) ...`

Imported `platform` and `model` values beginning with `=`, `+`, `-`, or `@` are exported unchanged. They do not execute in the dashboard, but a malicious dropped CSV can produce formulas when the resulting file is opened in Excel or another spreadsheet—a two-step but credible attack for this tool.

**Fix:** Before CSV quoting, prefix formula-like text cells—including those with leading whitespace or tabs—with an apostrophe. Apply this to every exported text field.

### 2. Failed or empty cost fetches leave old billed data presented as current

**Lines 1117, 1154, 1985–1987, 2008–2010:** `if (cost && cost.length) { Store.billed.anthropic = cost; ... }`

Cost failures are swallowed, and billed state changes only when the new response is nonempty. Fetching usage with a different key, organization, or period can therefore combine new usage with an older organization’s billed costs while the KPI still says it was reported by provider APIs.

**Fix:** Commit usage, cost, fetch status, time range, and organization identity atomically. On a failed/empty cost fetch, clear the corresponding billed dataset or explicitly mark and display it as stale/unavailable.

### 3. Imports can silently double-count the same usage

**Lines 721, 829–850, 2032–2034, 2071–2072:** `flatMap(s => s.rows || [])` and `.concat(res.rows)`

JSONL deduplication exists only inside one `parseClaudeLogs()` invocation. The same logs loaded through both the folder picker and manual JSONL import are summed as separate sources, while importing the same CSV repeatedly appends both usage and billed rows again.

**Fix:** Track imported datasets using a content hash or stable file identity and replace an existing dataset when it is reimported. Preserve message/session identifiers long enough to deduplicate overlapping folder and manual-log sources.

### 4. ChatGPT conversation branches are treated as one linear conversation

**Lines 891–906:** `const nodes = Object.values(conv.mapping) ... .sort(...)`

ChatGPT mappings contain alternate branches from regenerated or edited messages. Sorting every node by timestamp counts discarded assistant responses and includes text from unrelated branches in subsequent cumulative-context estimates. Regeneration is common enough that totals can be materially inflated beyond the accepted `chars/4` estimation error.

**Fix:** Starting at `conv.current_node`, follow each node’s `parent` chain to the root and process only that active branch. Define an explicit fallback for exports lacking `current_node`.

### 5. Format sniffing examines only the first bucket and first result

**Lines 1191–1205:** `const b = obj.data[0]; const r = (b.results && b.results[0]) || {};`

A valid report whose first day has no results can be rejected or misclassified. In particular, an OpenAI cost report with an empty first bucket is classified as `openai-usage`, causing its billed costs to be silently lost.

**Fix:** Search all buckets for the first nonempty result, then validate the complete payload structure. Use the filename only as a fallback for valid empty reports, and require the selected parser to confirm its schema.

### 6. Large imports and long ranges can monopolize the main thread

**Lines 783–795, 892–895, 938–957, 2032, 2038:** `JSON.parse(await f.text())`

ChatGPT/Claude exports and CSVs are fully materialized and parsed synchronously; conversation mappings are additionally copied and sorted. The daily chart can also create a focusable SVG hit target with four listeners per day (lines 1348–1358), for as many as 4,000 days allowed by line 603. Large personal exports can therefore freeze or exhaust the tab even without malicious input.

**Fix:** Parse imports in a Web Worker, stream CSV where possible, add progress/cancellation and file-size safeguards, and downsample long chart ranges. Use one delegated pointer handler rather than per-day listeners.

## Minor

### 7. Overlapping refreshes can commit results out of order

**Lines 1913–1923, 1977–2014, 2127–2131:** `if (this.dirHandle) this.rescan();`

`refreshAll()` starts scans and API requests without awaiting them, and buttons or auto-refresh can start another operation for the same source. If parameters change, an older, slower request can finish last and overwrite newer results. This requires user interaction or an unusually slow refresh, so exploitability is limited to local correctness.

**Fix:** Maintain a generation counter and `AbortController` per source, commit only the latest generation, disable duplicate actions while running, and have `refreshAll()` await `Promise.allSettled()`.

### 8. Date-only strings are accidentally interpreted as UTC instants

**Lines 595–599, 979, 999, 1038:** `const d = ... new Date(dateish);`

JavaScript parses `YYYY-MM-DD` as UTC, then `dayKey()` extracts local components. In time zones west of UTC, CSV date `2026-08-15` becomes `2026-08-14`; provider UTC buckets can similarly move across dates. Riyadh does not shift UTC-midnight dates, so the immediate local impact is limited, but the file is not timezone-safe.

**Fix:** Preserve strict date-only strings directly. Use separate helpers for local instants, UTC provider buckets, and calendar-date fields instead of one generic `dayKey()`.

### 9. CSV numbers are not checked for finiteness or valid ranges

**Lines 984–986:** `parseFloat(...) || 0`

Values such as `1e309` become `Infinity`, while negatives and partially numeric strings such as `12junk` are accepted. A malformed dropped CSV can corrupt totals and generate `NaN`/infinite chart geometry; this is principally a local availability and data-quality issue.

**Fix:** Parse with `Number()`, reject non-finite values, enforce nonnegative integer token/request counts, and define separately whether negative billed amounts are allowed for credits.

### 10. Manually imported project data is not persisted reliably

**Lines 719, 2071–2073:** `Store.setSource('local-import', ...); if (...) Store.projects = res.projects;`

`setSource()` persists before `Store.projects` is assigned, so imported project rows disappear after reload. The `!Store.projects.length` condition also leaves an older folder scan’s project table in place while new manual-log usage is included elsewhere.

**Fix:** Store project breakdowns per source, assign them before persistence, and deterministically replace or merge the selected source’s projects.

### 11. Masked API keys are mirrored into plaintext PowerShell commands

**Lines 1160–1162, 1175–1177, 2122–2124:** `return \`$k = "${k}"`

Every keypress copies the full key from the password input into an ordinary `<pre>` and into the command users paste into shell history. There is no remote exfiltration path in this self-contained page, but screenshots, shoulder-surfing, saved DOM, or shell-history review can reveal it. This is separate from the accepted localStorage opt-in.

**Fix:** Always generate a placeholder command that prompts for the key or reads an environment variable; never interpolate the entered key into page text or command history.

### 12. Adding a connector requires coordinated edits across several switchboards

**Lines 703–705, 1080–1155, 1562–1568, 1977–2020, 2039–2061:** repeated provider-specific source lists, pagination, fetch handlers, status rendering, and import branches.

A new platform must be added consistently to storage conventions, source labels, sniffing, parsing, fetching, billing, and duplicated UI handlers. Missing one location can produce invisible sources or mismatched billing—the existing `local-import` special case illustrates that risk.

**Fix:** Introduce a connector registry containing each connector’s ID, label, sniff predicate, parser, fetch/pagination function, billing capability, and status element IDs. Route fetching and importing through generic connector runners.

Overall, the dashboard has a strong browser-side XSS posture because imported strings consistently reach `textContent` or text nodes, with no dynamic HTML sink found. It is suitable for modest, trusted personal datasets, but duplicate ingestion, stale billing, branch handling, and import responsiveness should be corrected before treating its totals as auditable.