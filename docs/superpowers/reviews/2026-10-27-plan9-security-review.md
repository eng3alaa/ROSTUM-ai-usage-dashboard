# Plan 9 integration review — security / trust-boundary lens (2026-10-27)

Read-only review of branch `worktree-v9-all-models` at b153ba2 (everything since main c98fc12): collector, logger, new key cards, new parsers, workflows. Findings verified in code by the reviewer; status column maintained by the controller.

| # | Severity | Finding | Fix | Status |
|---|---|---|---|---|
| 1 | major | `copilot-vscode` root = `dirname(COPILOT_OTEL_FILE_EXPORTER_PATH)`: a file in the profile root makes HOME a served root (browser credential stores pass the extension list; no walk cap). | Single-file roots (`files: [basename]`); refuse HOME / drive roots. | fix in flight (collector half) |
| 2 | major | Deny-list misses `cline_mcp_settings.json`, `mcp_settings.json`, `mcp-config.json`, `settings.local.json`; `.md`/`.json` served everywhere (CLAUDE.md, memory, plans, caches). | Per-tool path allow-list mirrored from the registry's include patterns; wider DENY_NAME backstop. | fix in flight (collector half) |
| 3 | major (Windows) | `resolveFile` applies skipDirs / deny-list to the requested spelling only; NTFS 8.3 names (`UPLOAD~1`, `PASSWO~1.TXT`) bypass them after realpath. | Re-check every segment after realpath; reject `~\d` segments. | fix in flight (collector half) |
| 4 | major (availability) | `15-sqlite.js`: unchecked record header size → unbounded loop; no visited-page set in the b-tree walk → 10^9 visits on a crafted DB; neither throws, so the per-file try cannot contain it. | Validate `hdrSize`, visited set, cell/row caps. | fix queued (page half, after B7) |
| 5 | major (availability) | `decode=zstd`: per-frame caps only; `.all()` over all rows (no total budget; a VIEW over a recursive CTE never returns); page decodes all rows concurrently at 64 MB each. | Table-only, `trusted_schema=OFF`, `iterate()` with a running budget → 413; page decodes sequentially with a total budget. | collector half in flight; page half queued |
| 6 | minor | Alibaba host pin is a suffix match on `*.aliyuncs.com` (tenant-controlled hosts exist). | Anchor to `dashscope(-intl|-us)?.aliyuncs.com` (+ workspace form). | queued (page) |
| 7 | minor | Collector card accepts any base URL; the token is sent as Bearer to it; `?token=` on any origin sets the URL. | Loopback-only pin for the collector URL. | queued (page) |
| 8 | minor | Key-bearing fetches follow redirects (custom key headers survive cross-origin redirects). | `redirect: 'error'` on key-bearing requests. | queued (page) |
| 9 | minor | Collector walk has no file cap (page has 20,000). | Per-tool cap + status flag. | fix in flight (collector half) |
| 10 | minor (residual) | Port squatting on 127.0.0.1:11436 while the collector is down exposes that origin's remembered keys. | Document in SECURITY.md; consider not persisting vendor keys on the collector origin. | document (B7/docs) |
| 11 | minor | Workflows declare no `permissions:`; `price-check.mjs` body has no size cap. | `contents: read`; 5 MB cap. | fix in flight |
| 12 | minor (unverified) | Logger `writeHead(502)` after headers sent would throw. | `headersSent` guard. | fix in flight |

Checked and sound: header-only auth with `timingSafeEqual`; `?token=` never read by the API; `HOST_OK` before every handler; `/api/file` framing; `decode` restricted to zed + `zstd`; `logSafe`; CORS `*` without ambient credentials; no innerHTML/eval/inline handlers; price `src` links only from bundled rows; `Pricing.load` shape checks; keys in headers only; Azure/Vertex id validation and nextLink pin; `compatibleBaseUrl` rules; Remember-only persistence after a successful validation; per-file isolation in `parseFolderCached`; bounded ZIP inflate; logger stores counts only.
