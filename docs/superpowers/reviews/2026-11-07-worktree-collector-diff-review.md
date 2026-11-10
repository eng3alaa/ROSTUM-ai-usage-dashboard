# Review of the uncommitted "collector half" security edits (2026-11-07)

Independent read-only review by Claude Opus 5.5 (mohd security-engineer role, dispatched by the mohmd router) of the uncommitted diff in worktree `.claude/worktrees/v9-all-models` (8 files, +441/−155, written 2026-10-27 against the findings in `2026-10-27-plan9-security-review.md`, never committed). The committed base of the 8 files is identical to `main` b820e70. Line numbers are in the worktree's new files. This review is the input to Plan 11 Task T2 (`docs/superpowers/plans/2026-11-07-v11-review-fixes.md`).

## Coverage of the 2026-10-27 findings

| Item | Status in the diff | Hunk | Test |
|---|---|---|---|
| 1 copilot-vscode root = HOME | fixed — single-file root (collector :160-161, :190, :363-366 `walkSingleFiles`); HOME / parent-of-HOME / drive roots refused (:311-330) for TABLE and `--root` roots | | collector.test.mjs:289, :517 |
| 2 deny-list gaps, `.md`/`.json` served everywhere | fixed for the 18 tools with an include list (per-tool include globs :160-211; wider DENY_NAME :283); **partly** overall — `aider` and `tgwebui` have no include | | :243, :358 (404 body identical to a missing file) |
| 3 Windows 8.3 short names | fixed — `~\d` requests rejected (:451/:460); skip-dir, include, deny and single-file rules re-applied after realpath in `recheckReal` (:497-510); skip-dir match case-insensitive (:299) | | :379, :592 |
| 4 page sqlite | not in scope of this diff (page half) | | |
| 5 decode=zstd, collector half | fixed — `trusted_schema=OFF` + `query_only` (:593-594), TABLE only (:599-603), `iterate()` with a total budget (:604-613), per-row and row-count caps (:554-555, :622) | | :527 (VIEW → 415, budget → 413); row-count cap and per-row 413 untested |
| 6, 7, 8, 10 | page / docs items, not in this diff | | |
| 9 walk cap | partly — `WALK_CAP` (:304, :340-361) counts listed files only; directories visited and depth unbounded | | :550 |
| 11 workflow permissions, price-check body cap | fixed — `contents: read` in both workflows; 5 MB cap (price-check.mjs :38, :148-158) | | price-check.test.mjs:150 |
| 12 logger writeHead after headers sent | fixed — `failClient` (ollama-usage-logger.mjs :134-146) | | usage-logger.test.mjs:144 |
| new: `new URL(req.url, …)` outside try (collector :698, logger :126) | **not fixed** — `//` throws ERR_INVALID_URL before the Host check (constructor throw confirmed with node; process crash not verified live) | | — |
| new: `--root aider=` / env roots serve whole repos | partly — env roots limited by includes + HOME refusal; `--root aider=` / `tgwebui=` still serve any allowed extension | | — |
| new: `cline_mcp_settings.json`, `mcp_settings.json`, `mcp-config.json`, `settings.local.json` | fixed (:283) | | — |

## Hunk verdicts

- Header doc, SERVE_EXT `.ndjson` + DENY_NAME, walkTool / reportRefused / toolStatus (additive `capped`, `refused` fields), resolveFile split / NOT_FOUND / deniedReason / recheckReal (Host, token and `/api/file` framing untouched; 404 text unchanged, so the page's `RemoteFile` shim is unaffected), CT `.ndjson`, banner, logger `failClient`, price-check `readBodyCapped`, both workflow `permissions` hunks, tests/tools/*: **PORT**.
- `envInt` (:120) and its uses (:304, :555): **PORT WITH CHANGE** — clamp to `Math.min(value, default)`; as written the environment can raise the walk cap and the zstd budget.
- TABLE includes + `globToRegExp` (:158-211): **PORT WITH CHANGE** — remove `api_conversation_history` from `TASK_FILES` (:160; the page reads only `ui_messages` and `task_metadata`, 05-connectors.js:97/104/148, and this file holds full conversation content); add includes copied from the page's patterns: aider `**/.aider.chat.history.md` (05-connectors.js:111), tgwebui `**/logs/{chat,instruct}/**/*.json` (:365).
- walk functions (:296-366): **PORT WITH CHANGE** — count every directory entry visited toward the cap and add a depth limit (≤ 10, as the page does at 07-parse-claude.js:51 and 08-folder-scan.js:6).
- zstd budget (:550-627): **PORT WITH CHANGE** (minor) — count the budget in bytes (`Buffer.byteLength`), not `line.length`.
- Tests: coverage dropped — the frame-decode 200 (byte-exact) and corrupt-frame 422 assertions are gone because frames are now 404; the frame branch is still reachable by a `threads.db` that is a raw frame. Whether the `seedHome` change still satisfies `tests/checks/89c-collector.mjs:91-93` ("3 tools · 9 files"; gemini "found, nothing to read") is NOT VERIFIED (no test run).
- No regression found that serves more overall, weakens Host / Origin / token checks, or changes `/api/file` framing.

## Gaps T2 must still close after the port

1. Wrap `new URL(req.url, …)` in try at collector :698 and logger :126 → 400 + log; test with a raw-socket `GET // HTTP/1.1`: process survives, next request 200.
2. Add the aider and tgwebui include globs; test that a `.json` / `.md` beside `.aider.chat.history.md` gets 404.
3. Remove `api_conversation_history.json` from `TASK_FILES`; assert it is not listed.
4. Walk cap counts visited entries + depth limit; test a tree of non-matching files → `capped: true`.
5. Widen the DENY_NAME backstop: Copilot `hosts.json`, `apps.json`, plus `keys.json`, `accounts.json`, `places.sqlite`, `config.*.json` (all pass today).
6. Apply the `~\d` rule in `fileEntry` too, so the listing and `/api/file` agree.
7. Clamp the `COLLECTOR_*` test variables so they can only lower the cap and budget.
8. Restore the frame-decode 200/422 tests; add > 10,000 rows → 413 and one row > 64 MB → 413.
9. Pin `actions/checkout`, `actions/setup-node`, `actions/upload-artifact` to commit SHAs (Plan 11 T7).
10. Optional: allow a single-file copilot-vscode root in HOME (no walk, no watcher) instead of refusing it — safe as written, but a functional loss.

## Findings in the diff itself

| # | Severity | Finding |
|---|---|---|
| SEC-R-01 | Medium | `//` request target throws outside any try (collector :698 / logger :126; main :568 / :126), before the Host check; a browser `fetch('http://127.0.0.1:<port>//')` sends exactly that target (whether Private Network Access blocks it: NOT VERIFIED). |
| SEC-R-02 | Medium | `--root aider=` / `tgwebui=` still serve any file with an allowed extension; deny-list misses Copilot `hosts.json` / `apps.json`. |
| SEC-R-03 | Low | `api_conversation_history.json` served although the page never reads it. |
| SEC-R-04 | Low | Walk cap bounds listed files, not entries visited or depth. |
| SEC-R-05 | Low | Test-only env variables can raise the decode budget and walk cap. |
| SEC-R-06 | Low | Frame-decode 200/422 coverage removed; row-count and per-row 413 untested. |
| SEC-R-07 | Low | Actions pinned by tag, not SHA. |

No High finding in the diff. **Verdict: port with fixes** — the diff closes items 1, 3, 5 (collector half), 11 and 12 and most of 2, loosens no check; gap 1 (the `//` crash) must land before release.

Evidence: `git diff` of all 8 files; per-file blob hashes compared between the checkouts; registry patterns (`src/js/05-connectors.js`) and the `RemoteFile` shim (`src/js/08-folder-scan.js:16-78`) read; read-only `node -e` runs: `new URL('//')` throw, the new DENY_NAME over 40 sample names, the worktree's `globToRegExp` over sample paths. No tests run.
