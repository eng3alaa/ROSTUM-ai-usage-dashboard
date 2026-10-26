# Design debate: Claude vs Codex (GPT-6, reasoning "ultra") on the Plan 9 / Plan 10 roadmap — 2026-10-27

Two rounds, Codex running read-only against this worktree (`codex exec -s read-only`), Claude verifying every code citation before replying. Owner's brief: "debate, select the best options, add the enhancements, make the repo public". Outcome: the amended Plan 9 order and the Plan 10 table in `docs/superpowers/plans/2026-10-15-v10-roadmap.md`.

## What Codex found that changed the plan (all verified in code)

| Claim | Verified at | Effect |
|---|---|---|
| The billed KPI sums every billed envelope while rows honour `filters.hiddenPlatforms`; the "(across all platforms)" label mitigates but does not fix. The generic-CSV importer drops platform when aggregating dollars. | HTML 4950 vs 5670–5675, 5192; 3348 | Plan 10 Task 1 (billing scope + unallocated disclosure), sized M. The agreed acceptance test: A $10 + B $90, hide B → $10. |
| Collector polling returns early while the tab is hidden, so `--notify` cannot be an unattended monitor. | HTML 6530, 6626 | Notifications v1 labelled "while the dashboard is open and updating"; unattended v2 deferred until Node can import the split modules. |
| Suffixing source ids in a multi-machine snapshot bypasses the literal-id de-duplication; two machines fetching one API account would double the bill. `local-server` endpoints are configurable, so kind alone is not local provenance. | HTML 1933, 2025, 6209 | Snapshot = local-only backup: local provenance required, account-level sources excluded, same-machine import = restore. |
| Project rows carry no dates; longest-common-prefix is not an identity. | HTML 2149, 6123 | Canonical key (collector-resolved git root incl. worktrees) separate from display name; per-project monthly budgets dropped from v1. |
| A re-scan replaces the connector's rows; rotated or deleted logs shrink history silently. | HTML 6109 | Warn-and-confirm on > 20 % loss of rows, tokens or cost (or unreadable files) plus one-step undo. Replacement contract kept. |
| Prices substitute successor models and ignore usage date; some bundled rows are unverified. | HTML 1417, 1437, 986 | Stamp KPIs/CSV with the bundled price-set date, disclose override/unverified-priced rows; historical price tables deferred as a recorded limitation. |
| README overstated "no message text lands in the browser" (raw files stream through memory; only aggregates persist). | README 88 | Fixed in commit 0571a55. |
| Printing renders the live DOM; there is no report model to export from. | HTML 5100 | Shared report task creates the common report model first; zero scripts (theme toggle dropped). |
| The 800 KB size gate is not urgent (605,800 bytes) but bounded ownership is; the split should precede Wave B. | tests/checks/95-ui-misc.mjs 250 | Plan 9 gains Task SPLIT after A0, before A2; byte-identical build required. |

## Where Claude pushed back and Codex conceded
- Per-vendor price scrapers (36 URLs) → one generic extractor with an `unknown` status and a coverage gate (fail on drift > 0 or coverage < 70 %).
- Retaining rows for files that no longer exist → rejected (double counting on re-import); warn-and-confirm + undo instead.
- Full historical price tables now → deferred; provenance stamping instead.
- Cutting the shared report → kept, last, zero scripts, from the new report model.
- "First merge user overrides over defaults" → already Plan 9 A0 item 32; A2 adds exposure of the winning host-specific rate.

## Going public — agreed gate
1. Plan 9 A0 (correctness + trust fixes) merged to main.
2. Full-history audit across all refs: done 2026-10-27, 199 commits, no keys, no personal paths or emails in content (commit author metadata is the owner's normal git identity).
3. SECURITY.md (threat model, header-only token, rotation = stop → delete `~/.ai-usage/collector.token` → restart → reconnect), README first-screen accuracy + CI badge: landed in 0571a55.
4. License: the owner's explicit decision. Codex recommends Apache-2.0 (explicit patent grant); Claude recommends MIT for a single-file browser tool; keeping all rights reserved is valid if stated in the README.
5. Then flip visibility and enable private vulnerability reporting.

## Codex's three objections to the approach as a whole (kept as standing risks)
1. Breadth before trust — answered by running A0 and the publication gate before any Wave B card.
2. Accounting identities are underspecified (successor models, machine ids, prettified paths) — answered by Plan 10 Tasks 1, 4, 5.
3. Acceptance tests can encode the implementation's assumptions — answered by hard-coded expectations independent of production helpers (Task 1's test is the model).
