# Security policy

ROSTUM is a single HTML file you open from disk plus two optional Node helpers (the local collector and the Ollama usage logger). Nothing is hosted; there is no account and no server of ours. This page says what the software protects, what it does not, and how to report a problem.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (Security tab → "Report a vulnerability"). Please do not open a public issue for anything that could expose another user's keys, transcripts or usage data. Include the file and line, a minimal reproduction, and the browser or Node version. You will get an acknowledgement within a week; fixes land on `main` with a note in the commit message.

Only the latest `main` is supported. There are no release branches.

## Threat model

**The dashboard page (`AI Usage Dashboard.html`)**

- Runs as a `file://` page. It makes network requests only to the vendor endpoint of a card you connected (and, with the collector, to `127.0.0.1`). No telemetry, no third-party scripts, no fonts or assets fetched from anywhere.
- API keys are kept only in memory unless you tick **Remember key on this computer**; then they live in the browser's local storage for that file's origin. Cloud tokens and secrets (Azure, Vertex, Bedrock) are never stored. **Clear stored data…** removes everything.
- All DOM writes go through `textContent` / element construction; there is no `innerHTML`, `eval` or dynamic script. Imported files (JSON, CSV, ZIP, SQLite) are parsed as data; a hostile file can at most make its own rows wrong, and the parsers bound what they inflate and read.
- What is persisted is aggregated: tokens per day, platform and model, plus project totals. Raw log lines pass through memory while they are parsed and are not kept.

**The local collector (`docs/tools/ai-usage-collector.mjs`)**

- Listens on `127.0.0.1` only and rejects requests whose `Host` header is not a loopback name (HTTP 421).
- The bearer token is the gate, not the browser origin: every `/api/*` request needs `Authorization: Bearer <token>` from `~/.ai-usage/collector.token` (32 random bytes, created with mode 0600 where the OS honours it). The token is accepted only in the header; the `?token=` form is used solely to prefill the page the collector serves and is stripped from the address bar. Origin checks are deliberately not relied on: a sandboxed iframe or a `file://` page has a null origin, so CORS is open and the token does the work.
- Read-only. It serves only files under the tool roots it discovered (or the `--root` folders you passed), only with the log extensions the dashboard parses (`.jsonl .json .md .sqlite .db .csv .txt`), and never files whose names look like credentials (`credentials`, `oauth`, `token`, `secret`, `.env`, `config.yaml/.yml/.toml`, `auth.json`). Paths with `..`, absolute paths and symbolic links are refused; the walk skips `node_modules`, `.git` and `checkpoints`; the token file itself is never listed or served.
- Logs one line per request (method, path, status, bytes); never file contents, never the token.
- To rotate the token: stop the collector, delete `~/.ai-usage/collector.token`, start it again, and paste the new token into the card (or open the new URL it prints).

**The Ollama usage logger (`docs/tools/ollama-usage-logger.mjs`)**

- A loopback reverse proxy in front of Ollama that records token counts per request. It forwards only to the Ollama address you configured, rejects non-loopback `Host` headers (421), and stores counts, model names and timestamps, not prompts or completions.

## Out of scope

- A malicious process already running as your user: it can read the same log folders directly, with or without ROSTUM.
- Browser extensions with access to the page, and anyone with access to your unlocked browser profile (they can read remembered keys like any other site data).
- The accuracy of vendor pricing pages and of the vendors' own usage APIs; ROSTUM labels estimates as estimates but cannot verify what a vendor reports.

## Hardening checklist for users

1. Prefer the collector-served page or the `file://` page, not both, so remembered data lives in one origin.
2. Tick **Remember key** only on a machine you trust; use the vendor's read-only or usage-scoped keys where they exist (Anthropic and OpenAI Admin keys are read-only for usage).
3. Keep the collector's port firewalled from the network (it already binds loopback only).
4. If you modify the file, run `node tests/run.mjs`: the suite includes the hygiene gate (no control bytes, size limit) and the collector's security checks.
