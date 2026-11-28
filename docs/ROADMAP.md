# ROSTUM roadmap

Written 2026-11-28. This page says what is likely to be built next and why, and what will not be built. It is a direction, not a promise: the order can change, and items marked **owner decision** wait for the repository owner.

Implementation plans, with tasks and acceptance tests, live in `docs/superpowers/plans/`. This page stays one level above them.

## How this list was made

On 2026-11-13 six research passes looked at comparable tools, user complaints, vendor documentation, cost standards and what makes a repository of this kind get used. A seventh pass re-opened the sources behind the twenty strongest claims and graded each one. An eighth asked a different question: which additions would still matter in twenty years, and which would look dated.

Three results shaped the ranking:

- **Several proposed features already exist.** Period-over-period deltas, sparklines, cache savings, budget alerts and the Cost / Tokens switch are in the dashboard today (README section 5). They are not on this list.
- **Most demand evidence is about Claude Code.** ROSTUM's breadth (chat exports, API keys, local runners) was not researched, so the ranking may under-rate work for those users.
- **Launching alone does little.** Of 39 "Claude Code usage" Show HN posts found, 37 scored under 10 points. A new card is not a reason for anyone to switch; a record people can keep, and numbers they can check, may be.

Every feature below also has to fit the size gate: the built page is 851,414 bytes against a limit of 1,048,576, which leaves about 197 KB for everything on this page.

## Now: correctness before new features

Plan 11 (`docs/superpowers/plans/2026-11-07-v11-review-fixes.md`) is the fix programme from the November 2026 review. It comes first, because new surfaces built on wrong prices or loose parsers multiply the errors. Done so far: CI truth, collector hardening, the wrong-price fixes and the repair of stored prices. Still open: newly verified price rows, the page-side hardening, parser and key-card fixes, test-suite hygiene, repository guard rails and structure.

Plan 10 (`docs/superpowers/plans/2026-10-15-v10-roadmap.md`) holds the enhancement items approved on 2026-10-15. Parts of it have shipped (the price-freshness check, the notice that names estimated prices), but the plan records no status of its own, so what remains has to be audited before it resumes after Plan 11.

## Next: the front door

These cost little and decide whether anyone can legally and practically start using the tool.

1. **A licence** (**owner decision**). The README currently reserves all rights, so nobody may mirror, package or continue the project. The research compared no licences; MIT versus Apache-2.0 (which adds a patent grant) is the choice to make.
2. **A tagged release** with the HTML file and the collector as release assets, a SHA-256 for each in the README, and the version, build date and price-set date shown inside the page.
3. **A screenshot in the README and a sample-data mode**, so the dashboard can be judged in a minute without connecting an account.

## Then: features with verified demand

4. **"Is my subscription worth it?"** A small Plans table the user fills in (name, amount, currency, start, end), shown beside the API-equivalent value of the same period. The two figures are never added together, and the comparison is labelled Estimated. Five of the six research passes arrived at this independently, though much of their evidence traces to the same few sources.
5. **A ledger file the user owns** (see the long view, below). Export and import of one plain-text file. It also answers four separate requests with one feature: permanent history, merging several machines, team roll-up, and machine-readable output.
6. **Limit meters for the 5-hour and weekly windows.** Claude Code exposes these figures only to a statusline script, so this needs a hook in the user's Claude Code settings and must not break a statusline tool the user already has. For Codex the only schema description found is a third-party note from December 2025; the current CLI has to be checked before anything is built. Readings are stored as generic rows (window, percent used, resets at, observed at), so the meter is a thin adapter that can be replaced when vendors change their rationing.
7. **What-if re-pricing.** The same recorded usage priced at another price list or another model's row. Depends on item 10.
8. **A privacy claim a stranger can check.** A Content-Security-Policy that lists only the hosts the connectors can call, a "What leaves this page" table generated from the connector registry, and a CI check that fails if the built file names any other host.

## The long view: what should still matter in twenty years

Asked which additions outlast the tools of 2026, the research put these first, in this order:

9. **The ledger file.** One row per day, platform, model, token type and source, with a first line that states the schema name and version, the tool version, the price-set date and a checksum of the body. It is first for one reason: it is the only item whose value cannot be recovered later. Coding tools prune their logs, vendor APIs serve a limited history, and ROSTUM keeps its data in per-origin browser storage and compacts it to daily rows after 90 days. Every month without a durable file is a month of baseline that cannot be rebuilt.
10. **Dated price history.** Each price row gets a valid-from date; a price change appends a row instead of editing one. Usage can then be costed at the price in force on its date, or at today's list. The price list is also published in the repository at each release.
11. **Quantities with their unit.** The ledger stores quantity, unit and kind (input token, cache read, request, credit, second, image) instead of four fixed token columns, so a new billing unit does not force old rows into the wrong column.
12. **A coverage record.** For each month, which sources contributed and what this machine could not see (other devices, cloud agents, web-only use). A total with no statement of what it leaves out is hard to trust later.
13. **Paid and API-equivalent kept apart.** Item 4, stored as dated facts.

Three more were rated as lasting but can wait: an actor and account field (who or what spent it), a yearly print-ready statement, and standards at the edges only (import OpenTelemetry GenAI files, export FOCUS once version 1.5 with its AI columns is ratified, expected December 2026).

## Not planned, and why

- **Energy or CO2 column.** Demand evidence is thin, published estimates differ by two orders of magnitude, and the best factor table is licensed non-commercial, so it could not be bundled. If it is ever added, it will be a range with a versioned method, off by default.
- **An OpenTelemetry receiver in the collector.** It would duplicate data already read exactly from local logs, risk double counting, and turn a read-only file server into a listener that accepts writes.
- **Activity classification, session drill-down, cost per commit.** These need transcript content or git history. ROSTUM stores only aggregated rows and the collector serves only usage-log file types; that promise is worth more than these views.
- **Leaderboards, badges and "Wrapped" share cards.** They sit badly beside a no-telemetry promise. The yearly statement is the part worth keeping.
- **An MCP server.** No user request was found.
- **Team-only and enterprise-only connectors.** Outside the audience this tool is for.
- **Bundling third-party price catalogues or fetching them at runtime.** They are several megabytes each and would add a runtime dependency. A manual "Import price file" is the part that fits.
- **In-app translation.** No measured effect, and the strings compete for the remaining size budget.

## Questions the research did not answer

- **Accuracy.** Nobody has yet run ROSTUM against another tracker on the same logs, or against a real invoice. A published "matches the bill within X%" comparison would support the trust claim better than any feature.
- **Browser support.** The folder picker relies on an API that only Chromium browsers have. What Firefox and Safari users get has not been checked.
- **Terms of service.** Reading subscription limits through a hook, and redistributing price data, have not been assessed.
- **Unvisited communities.** Reddit, X, Bluesky, Discord and YouTube were not opened.
