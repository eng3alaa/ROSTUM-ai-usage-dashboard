# Clean-code review — ROSTUM production code (main at c98fc12), 2026-10-15

Review mode of clean-code-guard (read-only; dashboard JS, ai-usage-collector.mjs, ollama-usage-logger.mjs). Counts: 9 bug, 16 risk, 6 nit. Verdict: WARNING — fix bugs 1–8 and trust gaps 17–21 before a week of real use; then retire the legacy fetchX drivers (27), which removes most of the drift class.

## Behavioural bugs / silent failures
1. rescan() (Claude Code card): denied re-grant falls through to the folder picker — rescanFolder's own comment forbids it. Fix: status text + return.
2. _pollTick: `catch { return; }` — a dead vLLM/llama.cpp server leaves the card green. Fix: set serverErr/err like _collectorTick.
3. connectServer `startPoll(c).catch(() => {})` hides a throwing first poll.
4. fetchCopilotAll / fetchOpenRouterAll: any 403/5xx/network error reads as "no usage data for this account". Only 404 means not available.
5. fetchCopilot / fetchOpenrouter: a sync with zero rows keeps old rows and billed marked fresh (contradicts the [] = truthful-empty contract).
6. fetchAnthropic / fetchOpenAI error paths never render — hub dot stays green after an error.
7. parseChatGPTExport / parseClaudeAiExport book undated messages as today; Wave-2 parsers skip + count them.
8. collector /api/file: Content-Length from lstat, then an unbounded stream — a growing live log breaks keep-alive framing. Fix: stream `end: size-1`.
9. landDeepSeek inflates meta.rows/files on re-import. 10. generic-CSV re-import keeps stale billed days (Cursor branch removes them). 11. connectKey/connectCollector/fetchX persist a Remembered key before the fetch — a rejected key is replayed by refreshAll. 12. connectServer classifies validator programming errors as CORS/not-running and deletes the entry. 13. scanHandle/scanLocalFiles don't set connector err; collectJsonlFromHandle drops unreadable files uncounted. 14. parseClaudeLogs is the only parser not using finTok (string counts → concatenation). 15. parseClineTasks swallows corrupt task_metadata / message text uncounted. 16. LS.get on 'data': a corrupt blob loads as empty and the next persist overwrites history silently.

## Trust-boundary gaps
17. collector serves ANY regular file under its roots — ~/.claude/.credentials.json, ~/.gemini/oauth_creds.json, ~/.continue/config.yaml are readable to a token holder. Fix: extension allow-list (.jsonl/.json/.md/.sqlite/.db/.csv) + credential-name deny-list in walkRoot and resolveFile.
18. collector accepts ?token= on /api/* with no caller (page sends the header only) — token in URLs leaks to history/logs. Header only.
19. fetchAzureOpenAI follows `nextLink` to any host with the bearer token. Require host === management.azure.com.
20. fetchGemini sends the key in the URL (`?key=`); use the x-goog-api-key header.
21. ollama-usage-logger rewrites Host with no allow-list (defeats Ollama's loopback-Host check). Add HOST_OK → 421 like the collector.
22. readZipEntries inflates with no byte bound (declared size is attacker-controlled). 23. Store/Pricing/Budgets load LS blobs unchecked (one bad row poisons totals; a bad autoRefreshMins → setInterval(NaN)). 24. fetchCopilotAll builds "undefined-undefined-01" day keys; login unencoded. 25. No request timeouts anywhere (AbortSignal.timeout).

## Maintainability
26. App is a ~2,440-line god object (render + drivers + imports + collector + scheduler). 27. Five legacy fetchX drivers duplicate connectKey's skeleton (source of bugs 4–6, 11) — migrate them to the `{label, detail, rows, billed}` fetcher contract and delete fetchMethod + the second refreshAll loop. 28. Five has_more/next_page loops → one paginate(). 29. Duplicated knowledge: CSV header normaliser ×6 (one drifted), non-negative cell parser ×3, "free local row" rule ×3, total-tokens sum ×10, merge-by-sid import ×3, project-row merge ×3, error-detail extractor ×3, dual-driver err merge ×6. 30. kind if-chains (syncConnector, _importJson 15-arm, CSV sniff chain, init) → tables. 31. IDB.open per call, never closed, twice per file per scan. 32. Pricing.load: one user edit freezes the whole list — Plan 9's 251 new rows would never reach an existing user. Store only user overrides, merge over defaults (MUST land with Plan 9 A1/A2). 33. _pollTick persists the whole data blob twice per tick. 34. Dead code: Store.persist try/catch, probeServer().catch, unused _key params, renderProjects(win), parseFolderCached cache.keys branch.

## Naming / comments
35. validateLocalAI syncs and merges — rename syncLocalAI. 36. Generic names in long scopes (j, res, a/b, el2, bst, t2/u2, agg2, handle). 37. ~41 journal/ticket-id comments, a comment explaining code by test assertions, stale STORE header, 300+-char lines.

## Biggest functions (lines / branches)
handleImportFiles ~180/55 (nesting 6) · init ~148/20 · renderStackedColumns ~120/18 · readSqliteTable ~110/38 · ensureSourceCard ~96/32 · _importJson ~75/15-arm · renderKPIs ~71/15 · fetchBedrock ~70/22 · fetchAzureOpenAI ~69/24 · connectServer ~64/16 (then parseFolderCached, fetchFireworks, validateLocalAI, hubCard, disconnectConnector).

## Silent catch blocks (problematic)
LS.get('data') · IDB get/set/del/keys (+ tx.onerror = res) · ScanCache.set/prune · collectJsonlFromHandle getFile · parseClineTasks (meta + text) · _pollTick · startPoll().catch · console-only: fetchCopilotAll usage, fetchOpenRouterAll, pickFolder(For), rescan, restoreHandle, restoreFolderHandles · collector walkRoot readdir (partial listing never reported).

## Deliberate per conventions (not defects)
Single-file app; el()-only DOM writes (verified: no innerHTML/insertAdjacentHTML/eval); est/unpriced honesty labels; composite-key separators; collector logSafe scrubbing; documented test seams.

## Good
finTok/finAmt boundary helpers; gen-slot supersede pattern; collector hardening (timingSafeEqual, double realpath, token file never served, 421 Host check); Azure/Vertex/Bedrock validate inputs before building URLs/SQL.
