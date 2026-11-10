#!/usr/bin/env node
/**
 * ai-usage-collector.mjs — one-file, zero-dependency Node helper that finds the AI coding tools' log folders on THIS machine and
 * serves them, read-only, to the AI Usage Dashboard over http://127.0.0.1 — so every folder-based source becomes automatic: no
 * folder picking, nothing to re-pick after a browser restart, and the page can poll for changes. Without it nothing changes.
 *
 * Why: a page opened from file:// cannot read the disk on its own (browser rule), so each tool needs a folder pick per session.
 * The collector is the trusted local process that CAN read them; the dashboard's "Local collector" card talks to it.
 *
 * Run:      node docs/tools/ai-usage-collector.mjs
 *           → prints which tools were found, the token, and the ready URL  http://127.0.0.1:11436/?token=<token>
 *           Open that URL (the collector serves the dashboard itself — same origin, no CORS), or paste the token into the
 *           "Local collector" card of your file:// copy of the page.
 * Flags:    --port <n>              listen port (env COLLECTOR_PORT; default 11436; 0 = any free port, printed at start)
 *           --root <id>=<path>      use <path> for tool <id> instead of auto-discovery (repeatable: several roots for one tool;
 *                                   the only way to add aider / tgwebui, which have no fixed folder)
 *           --no-<id>               disable a tool (e.g. --no-ollama)
 *           --html <path>           the dashboard file to serve at /  (default: ../../AI Usage Dashboard.html next to this script)
 *           --help
 * Tool ids = the dashboard's connector ids: local (Claude Code / Desktop), codex, copilot-cli, gemini-cli, continue, cline, roo,
 *           junie, lmstudio, ollama, jan, opencode, goose, devin, kilo, amp (Plan 9 B5), zed, copilot-vscode (Plan 9 B6), aider, tgwebui.
 *           Plan 9 B6 roots: zed = <data>/Zed/threads (threads.db — zstd thread rows; the only tool /api/file decodes, see decode=zstd below); copilot-vscode = the folder
 *           of $COPILOT_OTEL_FILE_EXPORTER_PATH (VS Code's github.copilot.chat.otel.outfile has no fixed location — without the variable use --root copilot-vscode=<folder>).
 *           Plan 9 B5 roots: opencode = the OpenCode data dir (its snapshot/ git object store, bin/, log/ and cache/ are never walked — skipDirs);
 *           goose = <data>/goose/sessions (sessions.db); devin = <data>/devin/cli (sessions.db); kilo = the kilocode.kilo-code globalStorage folder
 *           (its own tool now — it used to be roo's second root); amp = <data>/amp/threads itself, so history.jsonl (prompt text) beside it is never listed.
 *
 * Discovery is per tool folder, not per home: codex reads ~/.codex/sessions and ~/.codex/archived_sessions only (the rest of ~/.codex is
 * tens of thousands of unrelated files). A tool with two roots prefixes every path with the root's folder name ("sessions/2026/…",
 * "archived_sessions/rollout-…"); with a single root paths are relative to it — the dashboard's Codex parser matches rollout-*.jsonl
 * anywhere in the path, so both shapes land. local (Plan 9 B1) has ~/.claude plus one root per Claude Desktop edition's
 * local-agent-mode-sessions folder (Cowork transcripts + audit.jsonl) — paths ".claude/…" and "local-agent-mode-sessions/…" when both exist.
 *
 * Change-driven, not timed: each found root is watched (fs.watch recursive). A change marks the tool dirty (2 s debounce) and the next
 * /api/status re-walks ONLY the dirty tools — a clean tool costs nothing per poll, whatever the poll interval. Where recursive fs.watch is
 * unavailable the tool falls back to a re-walk when its cache is older than 30 s (status: watch 'polling'). ?refresh=1 re-walks everything.
 * The walk is async and yields (batched stats, setImmediate every ~500 entries), so /api/file streams are served during a walk.
 *
 * Security — the token is the gate, not the origin:
 *   - 127.0.0.1 only. Every /api/* request must carry  Authorization: Bearer <token>  or it gets 401 — the header only: a ?token= query is
 *     read by the PAGE on GET / (pre-fill, then stripped from the address bar), never by the API, so the token cannot land in server logs,
 *     browser history or Referer headers through an API URL.
 *     The token lives in ~/.ai-usage/collector.token (32 random bytes, hex; created on first run, mode 0600 where the OS honours it).
 *     Without it any web page open in the browser could read the machine's AI transcripts through this port; origin checks are
 *     no substitute (a sandboxed iframe has a null origin, exactly like a file:// page).
 *   - Every response carries Access-Control-Allow-Origin: *, Access-Control-Allow-Headers: Authorization and
 *     Access-Control-Allow-Private-Network: true; OPTIONS → 204 — so a file:// page (Chrome's Private Network Access rules) and
 *     the collector-served page can both call it.
 *   - Read-only. Paths are validated to stay inside the tool's root: "..", absolute paths and symlinks are rejected (400). The
 *     recursive walk follows no symlinks and skips node_modules / .git / checkpoints; under a Cowork root (local-agent-mode-sessions) it also
 *     skips each session's outputs / uploads / uploads-tmp / .project-cache / session-env / backups — the files a task handled, not logs —
 *     and /api/file refuses any path through them (404), whatever the extension. The token file itself is never listed or served —
 *     not even through ollama, whose first root is ~/.ai-usage where the token lives (404, checked before and after realpath).
 *   - Per-tool allow-list (Plan 9 review): each TABLE row names the glob(s) of that tool's own log files (include — mirrored from the dashboard's
 *     connector patterns: local projects/**\/*.jsonl + the Cowork audit.jsonl / transcripts, codex rollout-*.jsonl, cline / roo / kilo tasks/<id>/
 *     {ui_messages,task_metadata}.json, aider **\/.aider.chat.history.md, tgwebui **\/logs/{chat,instruct}/**\/*.json, …).
 *     Nothing else under the root is listed or served (404, like a missing file): not CLAUDE.md, not memory/*.md, not settings.local.json,
 *     not an MCP config. The extension allow-list and the name deny-list stay as backstops under the include globs, including --root folders.
 *   - Single-file roots: copilot-vscode's root is the folder of $COPILOT_OTEL_FILE_EXPORTER_PATH, but ONLY that file is listed or served — nothing
 *     else in the folder. Any root that resolves to the user's home folder, a parent of it, or a drive root is refused (never walked; status.tools[].refused
 *     names it with the reason, the banner says "refused", one stderr line) — a mis-set variable or --root must not expose the whole profile.
 *   - 8.3 short names / case folding: a segment matching ~<digit> (UPLOAD~1) is never listed and answers 404 outright, and after realpath the rules — skipped
 *     folders, the include globs, the deny-list, the single-file rule — are re-applied to the segments the file system gave back, so a spelling the
 *     file system resolves differently (CHECKPOINTS → checkpoints on Windows) cannot reach what the walk skips.
 *   - Only usage-log file types are listed or served (extension allow-list), and never a credential file by name (deny-list) — see
 *     SERVE_EXT / DENY_NAME below for the exact rules and why each name is on the list. Anything else under a root answers 404.
 *   - Each tool's walk visits at most WALK_CAP directory entries (20 000, files and directories across all roots), down to depth 10 (root = 0).
 *     Hitting either limit sets status.tools[].capped = true and logs one stdout line; environment test knobs can only lower the limits.
 *   - Host allow-list: only Host 127.0.0.1, localhost or [::1] (with or without the port) is answered; anything else → 421 (a DNS name
 *     pointing at 127.0.0.1 — rebinding — reaches neither the page nor the API). Every response also carries X-Frame-Options: DENY and
 *     X-Content-Type-Options: nosniff. Malformed request targets answer 400 JSON {"error":"bad request"} and are logged without crashing the process.
 *     The 404 for a missing dashboard file names no path.
 *   - One stdout line per request (method, path, status, bytes) — never file contents, never the token; control characters in the echoed
 *     query values (tool / path / refresh) are replaced by "?" and values cut at 200 chars, so a request cannot forge a log line.
 *
 * API (JSON unless noted; collector includes mirror registry log patterns; the page also applies its patterns / exclude / siblings):
 *   GET /api/status[?refresh=1]     { version, home, os, startedAt, tools: [{ id, name, roots, candidates, found, disabled?, files, bytes, newestMtime, scannedAt, walkMs, watch, capped?, refused? }] }
 *                                   capped: true when an entry or depth limit was hit; refused: [{ dir, reason }] for a root that was refused (home folder, a parent of it, a drive root)
 *                                   counts come from the last walk of every found root; a tool is re-walked when its watcher saw a change
 *                                   (watch: 'fs'), when its cache is older than 30 s (watch: 'polling' — no recursive fs.watch there), when
 *                                   its root set changed, or on refresh=1 (all tools). walkMs = that walk's duration; watch is null when not found.
 *                                   files / newestMtime move whenever a file is added or modified, so the page's change detection works.
 *   GET /api/list?tool=<id>         { tool, name, root, roots, scannedAt, files: [{ path, size, mtime }] } — every servable regular file, paths relative,
 *                                   forward slashes; when a tool has more than one root each path is prefixed with that root's folder name
 *   GET /api/file?tool=<id>&path=<rel>   the file bytes, streamed, with Content-Length + Last-Modified (404 when missing) — exactly Content-Length
 *                                   bytes even when the file grows while it streams (a CLI appending to its live log). Waits only for the
 *                                   tool's FIRST walk (or one in flight) — it never triggers a dirty re-walk (that is /api/status's job), so a
 *                                   file streams now even when the tool just changed
 *   GET /api/file?tool=zed&path=<rel>&decode=zstd   (Plan 9 B6, design 8) the file DECODED, for a browser whose DecompressionStream lacks zstd: a zstd frame → its
 *                                   bytes (byte-exact, JSON content type); Zed's threads.db → one JSON line per `threads` row {id, summary, updated_at, data_type:
 *                                   'json', data} with the blob decompressed, or {…, error} for a row that does not decode (ndjson). Only for a tool whose TABLE row
 *                                   carries decode: 'zstd' (zed) and only the value zstd — anything else 400; 413 file too large to decode in memory, a row over
 *                                   ZSTD_ROW_MAX, the decoded output over the ZSTD_BUDGET total or more than ZSTD_ROWS_MAX rows; 415 neither a frame nor a SQLite
 *                                   store, or a store whose `threads` is not a TABLE (a VIEW could run arbitrary SQL); 422 the frame does not decode; 501 this Node
 *                                   lacks zlib zstd (< 22.15) or node:sqlite (< 22.13). The store is opened read-only with trusted_schema OFF and query_only ON and
 *                                   read row by row. Token-gated and path-checked exactly like a plain /api/file; the decoded bytes are never written to disk.
 *   GET /                           the dashboard HTML (404 with a hint when the file is not where expected); /favicon.ico → 204
 *   GET /README.md                  the repo README (text/markdown; 404 when absent) — the served page's "Where the numbers come from" link
 *                                   is README.md#automatic-mode, relative to the page
 * Test seams (environment, read once at start; tests/tools/collector.test.mjs only — not flags, not documented to users):
 *   COLLECTOR_WALK_CAP=<n>      lowers the per-tool walk cap (default 20 000)          COLLECTOR_ZSTD_BUDGET=<bytes>  lowers the decode=zstd total output budget (default 256 MB)
 *   COLLECTOR_ZSTD_ROW_MAX=<bytes>  lowers the decoded zstd row cap (default 64 MB); none of these variables can raise a limit.
 * Node ≥ 20. No dependencies.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const VERSION = '7.0';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const NODE_MAJOR = parseInt(process.versions.node.split('.')[0], 10);
if (NODE_MAJOR < 20) { console.error(`ai-usage-collector: Node 20 or newer is required (this is ${process.version})`); process.exit(1); }

// ---- discovery table (per OS) --------------------------------------------------------------------------------------------------------------
const HOME = os.homedir();
const PLAT = process.platform;
const env = (k) => (process.env[k] || '').trim();
const envInt = (k, dflt) => { const n = parseInt(env(k), 10); return n > 0 ? Math.min(n, dflt) : dflt; };   // test seams can only lower limits (see the header)
const APPDATA = env('APPDATA') || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = env('LOCALAPPDATA') || path.join(HOME, 'AppData', 'Local');const XDG_DATA = env('XDG_DATA_HOME') || path.join(HOME, '.local', 'share');   // the XDG data dir — also what OpenCode / Amp use on Windows (%USERPROFILE%\.local\share)

const EDITORS = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium'];
const editorUserDirs = PLAT === 'win32' ? EDITORS.map((n) => path.join(APPDATA, n, 'User'))
  : PLAT === 'darwin' ? EDITORS.map((n) => path.join(HOME, 'Library', 'Application Support', n, 'User'))
  : EDITORS.map((n) => path.join(HOME, '.config', n, 'User'));
const extStorage = (extId) => editorUserDirs.map((d) => path.join(d, 'globalStorage', extId));   // one group: the first editor that has the extension wins
const JETBRAINS_CACHE = PLAT === 'win32' ? path.join(LOCALAPPDATA, 'JetBrains') : PLAT === 'darwin' ? path.join(HOME, 'Library', 'Caches', 'JetBrains') : path.join(HOME, '.cache', 'JetBrains');
// JetBrains: <cache>/<IDE-version>/projects/<project>/matterhorn — every one that exists is its own root (computed at each refresh; a few readdirs)
function matterhornDirs() {
  const out = [];
  let ides = []; try { ides = fs.readdirSync(JETBRAINS_CACHE, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return out; }
  for (const ide of ides) {
    let projects = []; try { projects = fs.readdirSync(path.join(JETBRAINS_CACHE, ide, 'projects'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { continue; }
    for (const p of projects) { const d = path.join(JETBRAINS_CACHE, ide, 'projects', p, 'matterhorn'); if (isDir(d)) out.push(d); }
  }
  return out;
}
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
// Plan 9 B1 — Claude Desktop keeps Cowork (agent mode) sessions in the app's data folder, not in ~/.claude: <data>/local-agent-mode-sessions/<org>/<user>/<session>/
// holds .claude/projects/<slug>/*.jsonl (transcripts, the Claude Code format) and audit.jsonl (Anthropic's own cost per turn). Every edition that exists is its
// own root: Windows %APPDATA%\Claude (installer build), %LOCALAPPDATA%\Claude-Data\<package>\ (Microsoft Store build since 2026-10; the old %APPDATA%\Claude keeps a
// ".user-data-left.<package>" marker), %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude (older Store builds), %LOCALAPPDATA%\Claude-3p (BYO-provider
// edition); macOS ~/Library/Application Support/{Claude,Claude-3p}; Linux ~/.config/{Claude,Claude-3p}. Computed at each refresh (a readdir or two).
const COWORK_DIR = 'local-agent-mode-sessions';
const subdirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)); } catch { return []; } };
function coworkRoots() {
  const apps = PLAT === 'win32'
    ? [path.join(APPDATA, 'Claude'), path.join(LOCALAPPDATA, 'Claude-3p'), ...subdirs(path.join(LOCALAPPDATA, 'Claude-Data')),
       ...subdirs(path.join(LOCALAPPDATA, 'Packages')).filter((d) => /^Claude_[^\\/]+$/i.test(path.basename(d))).map((d) => path.join(d, 'LocalCache', 'Roaming', 'Claude'))]
    : PLAT === 'darwin' ? ['Claude', 'Claude-3p'].map((n) => path.join(HOME, 'Library', 'Application Support', n))
    : ['Claude', 'Claude-3p'].map((n) => path.join(HOME, '.config', n));
  return apps.map((d) => path.join(d, COWORK_DIR));
}
// groups: [[candidate, candidate…], …] — per group the FIRST existing directory is a root; a function computes groups at refresh time.
// include: the glob(s) of this tool's log files, relative to a root (Plan 9 review) — mirrored from the dashboard's connector patterns (src/js/05-connectors.js);
//   a file that matches none is neither listed nor served, whatever its extension; --root overrides do not bypass these globs.
// files: a single-file root — the root folder serves ONLY these basenames (copilot-vscode: the OTel outfile the variable names, nothing beside it).
const TASK_FILES = ['tasks/*/{ui_messages,task_metadata}.json'];   // Cline and its forks (Roo, Kilo): tasks/<taskId>/…
const OTEL_FILE = env('COPILOT_OTEL_FILE_EXPORTER_PATH') ? path.resolve(env('COPILOT_OTEL_FILE_EXPORTER_PATH')) : '';
const TABLE = [
  // local: ~/.claude/projects/**/*.jsonl (transcripts + subagents) and, under a Cowork root, each session's .claude/projects transcripts + audit.jsonl — never
  //   CLAUDE.md, memory/*.md, plans/, tasks/, todos/*.json, settings*.json or any other file the folder holds
  { id: 'local',       name: 'Claude Code / Desktop',           groups: () => [[env('CLAUDE_CONFIG_DIR') || path.join(HOME, '.claude')], ...coworkRoots().map((d) => [d])], include: ['projects/**/*.jsonl', '**/.claude/projects/**/*.jsonl', '**/audit.jsonl'] },
  // codex: only sessions/ and archived_sessions/ (each its own root) — the rest of ~/.codex (cache/, browser/, …) is tens of thousands of
  // unrelated files. With both present the two-root rule prefixes paths "sessions/…" / "archived_sessions/…"; with one, paths are relative
  // to it ("2026/09/16/rollout-*.jsonl") — the dashboard's Codex parser matches rollout-*.jsonl anywhere in the path, so both shapes work.
  { id: 'codex',       name: 'OpenAI Codex CLI',                groups: [[path.join(env('CODEX_HOME') || path.join(HOME, '.codex'), 'sessions')], [path.join(env('CODEX_HOME') || path.join(HOME, '.codex'), 'archived_sessions')]], include: ['**/rollout-*.jsonl'] },
  { id: 'copilot-cli', name: 'GitHub Copilot CLI (logs)',       groups: [[path.join(HOME, '.copilot')]], include: ['**/events.jsonl'] },
  { id: 'gemini-cli',  name: 'Gemini CLI',                      groups: [[env('GEMINI_CLI_HOME') || path.join(HOME, '.gemini')]], include: ['**/session-*.json'] },
  { id: 'continue',    name: 'Continue.dev',                    groups: [[path.join(HOME, '.continue')]], include: ['**/tokensGenerated.jsonl'] },
  { id: 'cline',       name: 'Cline (VS Code)',                 groups: [extStorage('saoudrizwan.claude-dev')], include: TASK_FILES },
  { id: 'roo',         name: 'Roo Code (VS Code)',              groups: [extStorage('rooveterinaryinc.roo-cline')], include: TASK_FILES },   // kilocode.kilo-code moved to its own tool (kilo, Plan 9 B5)
  { id: 'junie',       name: 'JetBrains AI Assistant / Junie',  groups: () => [[path.join(HOME, '.junie')], ...matterhornDirs().map((d) => [d])], include: ['**/*events.jsonl'] },
  { id: 'lmstudio',    name: 'LM Studio',                       groups: [[path.join(HOME, '.lmstudio', 'conversations'), path.join(HOME, '.cache', 'lm-studio', 'conversations')]], include: ['**/*.conversation.json'] },
  { id: 'ollama',      name: 'Ollama',                          groups: [[path.join(HOME, '.ai-usage')], [PLAT === 'win32' ? path.join(LOCALAPPDATA, 'Ollama') : PLAT === 'darwin' ? path.join(HOME, 'Library', 'Application Support', 'Ollama') : path.join(HOME, '.ollama')]], include: ['**/*usage*.jsonl', '**/db.sqlite'] },
  { id: 'jan',         name: 'Jan',                             groups: [[PLAT === 'win32' ? path.join(APPDATA, 'Jan', 'data') : PLAT === 'darwin' ? path.join(HOME, 'Library', 'Application Support', 'Jan', 'data') : path.join(HOME, '.local', 'share', 'Jan', 'data')]], include: ['**/messages.jsonl'] },
  // Plan 9 B5 — Wave 3 coding tools (paths per the research; none installed on the research machine). skipDirs: folders under the root that hold no logs.
  { id: 'opencode',    name: 'OpenCode',                        groups: [[env('OPENCODE_DATA_DIR'), env('OPENCODE_HOME'), path.join(XDG_DATA, 'opencode'), ...(PLAT === 'win32' ? [path.join(APPDATA, 'opencode')] : [])].filter(Boolean)], skipDirs: ['snapshot', 'bin', 'log', 'cache'], include: ['**/opencode*.db', 'storage/message/**/msg_*.json'] },
  { id: 'goose',       name: 'Goose',                           groups: [[PLAT === 'win32' ? path.join(APPDATA, 'Block', 'goose', 'sessions') : path.join(XDG_DATA, 'goose', 'sessions')]], include: ['**/sessions.db'] },
  { id: 'devin',       name: 'Devin CLI',                       groups: [[env('DEVIN_DATA_DIR'), PLAT === 'win32' ? path.join(APPDATA, 'devin', 'cli') : PLAT === 'darwin' ? path.join(HOME, 'Library', 'Application Support', 'devin', 'cli') : path.join(XDG_DATA, 'devin', 'cli')].filter(Boolean)], include: ['**/sessions.db'] },
  { id: 'kilo',        name: 'Kilo Code (VS Code)',             groups: [extStorage('kilocode.kilo-code')], include: TASK_FILES },
  { id: 'amp',         name: 'Amp',                             groups: [[env('AMP_DATA_DIR'), path.join(HOME, '.local', 'share', 'amp'), ...(PLAT === 'win32' ? [path.join(LOCALAPPDATA, 'amp')] : [])].filter(Boolean).map((d) => path.join(d, 'threads'))], include: ['**/*.json'] },
  // Plan 9 B6 — zed = the Zed threads folder (threads.db; its thread rows are zstd frames a browser cannot always decode — GET /api/file?…&decode=zstd decodes them here,
  //   see serveDecoded; `decode: 'zstd'` is what allows that for this tool). copilot-vscode = the folder of Copilot Chat's OTel outfile — a user-chosen path
  //   (github.copilot.chat.otel.outfile), so only COPILOT_OTEL_FILE_EXPORTER_PATH (the extension's own env override) or --root copilot-vscode=<folder> finds it;
  //   through the variable the root serves that ONE file (files:), through --root every .jsonl / .ndjson in the folder.
  { id: 'zed',         name: 'Zed (Agent Panel)',               groups: [[PLAT === 'win32' ? path.join(LOCALAPPDATA, 'Zed', 'threads') : PLAT === 'darwin' ? path.join(HOME, 'Library', 'Application Support', 'Zed', 'threads') : path.join(XDG_DATA, 'zed', 'threads')]], decode: 'zstd', include: ['**/threads.db'] },
  { id: 'copilot-vscode', name: 'GitHub Copilot Chat (VS Code OTel file)', groups: OTEL_FILE ? [[path.dirname(OTEL_FILE)]] : [], files: OTEL_FILE ? [path.basename(OTEL_FILE)] : undefined, include: ['**/*.jsonl', '**/*.ndjson'] },
  { id: 'aider',       name: 'Aider',                           groups: [], include: ['**/.aider.chat.history.md'] },   // per-repo files — --root <folder that holds your repos> only
  { id: 'tgwebui',     name: 'text-generation-webui',           groups: [], include: ['**/logs/{chat,instruct}/**/*.json'] },   // install folder — --root <install or user_data> only
];
const TOOL_BY_ID = new Map(TABLE.map((t) => [t.id, t]));
// glob → RegExp over a root-relative path (forward slashes): ** = any depth (**/ may match nothing), * = within one segment, ? = one char, {a,b} = either;
// case-insensitive — the file systems these folders live on mostly are, and the registry's patterns are /i too
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '{') { const j = glob.indexOf('}', i); re += '(?:' + glob.slice(i + 1, j).split(',').map(escapeRe).join('|') + ')'; i = j; }
    else re += escapeRe(ch);
  }
  return new RegExp('^' + re + '$', 'i');
}
for (const t of TABLE) t.includeRe = (t.include || []).map(globToRegExp);
const included = (t, rel) => !t.includeRe.length || t.includeRe.some((re) => re.test(rel));   // rel: root-relative, forward slashes, no root label

// ---- flags --------------------------------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { port: process.env.COLLECTOR_PORT || '11436', roots: new Map(), disabled: new Set(), html: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const eq = a.indexOf('=');
  const key = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a, inline = a.startsWith('--') && eq > 0 ? a.slice(eq + 1) : null;
  const val = () => { if (inline !== null) return inline; if (i + 1 >= argv.length) { console.error(`ai-usage-collector: ${key} needs a value`); process.exit(2); } return argv[++i]; };
  if (key === '--help' || key === '-h') { printHelp(); process.exit(0); }
  else if (key === '--port') opts.port = val();
  else if (key === '--html') opts.html = val();
  else if (key === '--root') { const v = val(); const j = v.indexOf('='); if (j <= 0) { console.error(`ai-usage-collector: --root expects <id>=<path>, got "${v}"`); process.exit(2); } const id = v.slice(0, j).trim(); if (!opts.roots.has(id)) opts.roots.set(id, []); opts.roots.get(id).push(path.resolve(v.slice(j + 1).trim())); }
  else if (/^--no-[a-z][a-z0-9-]*$/.test(key)) opts.disabled.add(key.slice(5));
  else { console.error(`ai-usage-collector: unknown option "${a}" (try --help)`); process.exit(2); }
}
function printHelp() {
  console.log(`ai-usage-collector v${VERSION} — serves this machine's AI log folders to ROSTUM (the AI Usage Dashboard) on 127.0.0.1
usage: node docs/tools/ai-usage-collector.mjs [--port <n>] [--root <id>=<path>]... [--no-<id>]... [--html <path>]
  --port <n>          listen port (env COLLECTOR_PORT; default 11436; 0 = any free port)
  --root <id>=<path>  use <path> for tool <id> instead of auto-discovery (repeatable; required for aider / tgwebui)
  --no-<id>           disable a tool
  --html <path>       dashboard file served at /  (default ../../AI Usage Dashboard.html relative to this script)
tool ids: ${TABLE.map((t) => t.id).join(', ')}`);
}

for (const id of [...opts.roots.keys(), ...opts.disabled]) if (!TOOL_BY_ID.has(id)) { console.error(`ai-usage-collector: unknown tool id "${id}" — known ids: ${TABLE.map((t) => t.id).join(', ')}`); process.exit(2); }
for (const [id, dirs] of opts.roots) for (const d of dirs) if (!isDir(d)) console.error(`ai-usage-collector: warning — --root ${id}=${d} is not a directory (listed as not found)`);

// ---- token --------------------------------------------------------------------------------------------------------------------------------
const TOKEN_DIR = path.join(HOME, '.ai-usage');
const TOKEN_FILE = path.join(TOKEN_DIR, 'collector.token');
function loadToken() {
  const read = () => { try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; } };
  let t = read();
  if (t) return { token: t, created: false };
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const fresh = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(TOKEN_FILE, fresh + '\n', { mode: 0o600, flag: 'wx' }); }   // wx: never clobber one another instance just wrote
  catch (e) { if (e.code !== 'EEXIST') throw e; t = read(); if (t) return { token: t, created: false }; throw e; }
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch { /* Windows: mode bits are not a thing — the user profile's ACL protects the file */ }
  return { token: fresh, created: true };
}
const { token: TOKEN, created: TOKEN_CREATED } = loadToken();
const TOKEN_BUF = Buffer.from(TOKEN);
const TOKEN_FILE_REAL = (() => { try { return fs.realpathSync.native(TOKEN_FILE); } catch { return TOKEN_FILE; } })();   // loadToken just made sure it exists
const isTokenFile = (p) => samePath(p, TOKEN_FILE) || samePath(p, TOKEN_FILE_REAL);   // never listed, never served (ollama's first root IS ~/.ai-usage)
function authorized(req) {   // the Authorization header only — never a query parameter (A0 #18)
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '');
  const given = Buffer.from(m ? m[1] : '');
  return given.length === TOKEN_BUF.length && crypto.timingSafeEqual(given, TOKEN_BUF);
}

// ---- what is listed and served (A0 #17) -----------------------------------------------------------------------------------------------------
// Allow-list by extension — the formats the dashboard's parsers read: .jsonl / .ndjson / .json logs and exports, .md (Aider history), .sqlite / .db
// (Ollama, LM Studio, OpenCode stores), .csv exports, .txt usage logs. Anything else under a root (keys, scripts, YAML / TOML configs,
// binaries) is neither listed nor served. The per-tool include globs (TABLE) narrow this further for every tool that has them.
const SERVE_EXT = new Set(['.jsonl', '.ndjson', '.json', '.md', '.sqlite', '.db', '.csv', '.txt']);
// Deny-list by file NAME (case-insensitive, checked first) — credential files that live under these very roots and would pass the extension check:
//   credential          ~/.claude/.credentials.json (Claude OAuth access + refresh tokens)
//   oauth               ~/.gemini/oauth_creds.json (Google OAuth tokens)
//   token / tokens      as a word on its own: token.json, access_token.json, collector.token — NOT tokensGenerated.jsonl (Continue's usage log)
//   secret, password, api_key / apikey   generic secret stores
//   .env / .env.*       API keys in environment files (~/.gemini/.env)
//   auth.json / *-auth.json / *_auth.json / *.auth.json   tool logins (~/.codex/auth.json holds the OpenAI key / tokens)
//   settings.json / settings.<anything>.json   Claude Code (settings.json, settings.local.json) and Gemini CLI settings may carry an env block with API keys
//   config.json / config.<anything>.json   provider configs can hold apiKey values; ~/.copilot/config.json holds the GitHub token
//   hosts.json / apps.json / keys.json / accounts.json   account and credential stores, including Copilot logins
//   mcp as a name part  MCP server definitions carry env blocks with keys: mcp.json, ~/.copilot/mcp-config.json, cline_mcp_settings.json, mcp_settings.json
//   .claude.json        Claude Code's per-user config (account, prompt history) — a copy lives in every Cowork session's .claude folder (Plan 9 B1)
//   cookies.sqlite / places.sqlite / key4.db / logins.json   browser cookies, browsing history, keys and saved logins — never usage logs
// The collector's own token file is refused separately (isTokenFile). No tool's usage log uses these names.
const DENY_NAME = /credential|oauth|(^|[^a-z])tokens?([^a-z]|$)|secret|password|api[-_]?key|^\.env(\.|$)|^config(?:\..+)?\.json$|(^|[-_.])auth\.json$|settings(\.[^.]+)?\.json$|(^|[-_.])mcp([-_.][^/]*)?\.json$|^\.claude\.json$|^(hosts\.json|apps\.json|keys\.json|accounts\.json|cookies\.sqlite|places\.sqlite|key4\.db|logins\.json)$/i;
const servable = (name) => !DENY_NAME.test(name) && SERVE_EXT.has(path.extname(name).toLowerCase());

// ---- roots + change-driven walk ------------------------------------------------------------------------------------------------------------
// Each found root is watched with fs.watch({ recursive: true }); an event marks the tool dirty (2 s debounce: the first event arms a timer,
// later ones in the window are ignored, so a stream of writes never postpones it) and the NEXT /api/status (or /api/list, /api/file of that
// tool) re-walks only dirty tools. Where recursive fs.watch is unavailable (an old kernel, a network share, the inotify limit) the tool
// falls back to the TTL: re-walk when the cache is older than TTL_MS (status says watch: 'polling'). A root set that changed (a folder
// created or removed after start) is re-walked and re-watched — that check is a few stat calls per status.
const SKIP_DIRS = new Set(['node_modules', '.git', 'checkpoints']);
// Under a Cowork root (…/local-agent-mode-sessions) every session folder also holds the files the task handled — outputs/, uploads/, uploads-tmp/,
// .project-cache/ (documents the user attached), session-env/, backups/ (.claude.json copies). Not logs: never walked, never served (B1 follow-up).
const COWORK_SKIP_DIRS = new Set(['outputs', 'uploads', 'uploads-tmp', '.project-cache', 'session-env', 'backups']);
const isCoworkRoot = (dir) => dir.split(/[\\/]/).includes(COWORK_DIR);
// toolSkip: a tool's own skipDirs (TABLE) — folders under its root that hold no logs (OpenCode's snapshot/ git object store, Plan 9 B5); walked by neither walkRoot nor resolveFile.
// All three sets compare case-insensitively (the page's walkers do too) — a CHECKPOINTS spelling must not pass what checkpoints does not.
const skipsDir = (rootDir, name, toolSkip) => { const n = name.toLowerCase(); return SKIP_DIRS.has(n) || (isCoworkRoot(rootDir) && COWORK_SKIP_DIRS.has(n)) || (!!toolSkip && toolSkip.includes(n)); };
const TTL_MS = 30000;       // polling fallback only
const DEBOUNCE_MS = 2000;
const STAT_BATCH = 64;      // stats per Promise.all (the thread pool overlaps them: ~4× faster than one at a time on Windows)
const YIELD_EVERY = 500;    // entries between explicit setImmediate yields, so /api/file streams stay responsive during a walk
const WALK_CAP = envInt('COLLECTOR_WALK_CAP', 20000);   // entries per tool, all roots together — the page's walkers stop at 20 000 too (test seam: COLLECTOR_WALK_CAP)
const WALK_DEPTH = 10;      // root = depth 0; files in depth-10 directories are still read
const state = new Map();   // id → { roots: [{ dir, label, files? }], candidates: [dir…], refused: [{ dir, reason }], found, files: [{ path, size, mtime }], bytes, newestMtime, scannedAt, walkMs, capped, walking: Promise|null, dirty, dirtyTimer, watch: 'fs'|'polling'|null, watchers: [FSWatcher], watchDirs: [dir…] }
for (const t of TABLE) state.set(t.id, { roots: [], candidates: [], refused: [], found: false, files: [], bytes: 0, newestMtime: null, scannedAt: null, walkMs: null, capped: false, walking: null, dirty: true, dirtyTimer: null, watch: null, watchers: [], watchDirs: [] });

// A root must be a tool's folder, never the profile itself: the user's home, any parent of it, or a drive root is refused (walking it would list the whole machine).
const HOME_REAL = (() => { try { return fs.realpathSync.native(HOME); } catch { return HOME; } })();
const realpathOr = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
function refusedRootReason(dir) {
  const real = realpathOr(dir);
  if (samePath(real, HOME_REAL)) return 'is the home folder';
  if (inside(HOME_REAL, real)) return 'is a parent of the home folder';
  if (samePath(path.parse(real).root, real)) return 'is a drive root';
  return null;
}
// the roots of a tool right now: --root overrides the table; every group contributes its first existing directory (a refused one is reported, never walked)
function resolveRoots(t) {
  const fromFlags = opts.roots.has(t.id);
  const groups = fromFlags ? opts.roots.get(t.id).map((d) => [d]) : (typeof t.groups === 'function' ? t.groups() : t.groups);
  const candidates = [], dirs = [], refused = [];
  for (const g of groups) { candidates.push(...g); const hit = g.find(isDir); if (hit && !dirs.includes(hit)) dirs.push(hit); }
  const kept = dirs.filter((dir) => { const reason = refusedRootReason(dir); if (reason) refused.push({ dir, reason }); return !reason; });
  // labels: a tool with several roots prefixes each path with the root's folder name (made unique: "matterhorn", "matterhorn~2", …); files: a single-file root (TABLE, not --root)
  const labels = new Map();
  const roots = kept.map((dir) => { const base = path.basename(dir) || dir; let label = base, n = 1; while ([...labels.values()].includes(label)) label = `${base}~${++n}`; labels.set(dir, label); return { dir, label, ...(t.files && !fromFlags ? { files: t.files } : {}) }; });
  return { roots, candidates, refused };
}

// one file entry for the listing, or null when it vanished mid-walk / is not this tool's log (the token file, the extension + name lists, the include globs)
async function fileEntry(t, root, rel, name, prefix) {
  const relFile = rel ? rel + '/' + name : name;
  if (SHORT_NAME.test(relFile) || isTokenFile(path.join(root.dir, relFile)) || !servable(name) || !included(t, relFile)) return null;   // resolveFile applies the same rules (deniedReason)
  const st = await fsp.lstat(path.join(root.dir, relFile)).catch(() => null);   // lstat: a symlink is never a log (resolveFile refuses it too)
  return st && st.isFile() ? { path: prefix + relFile, size: st.size, mtime: Math.round(st.mtimeMs) } : null;
}
// recursive walk of one root: regular files only, no symlinks, skip dirs by name; paths relative with forward slashes. Async and
// non-blocking: one readdir per directory, stats in parallel batches, an explicit yield every YIELD_EVERY entries. Stops at `limit` entries (capped: true).
async function walkRoot(t, root, prefix, limit) {
  const files = []; let visited = 0, sinceYield = 0, capped = false;
  const stack = [{ rel: '', depth: 0 }];
  while (stack.length && visited < limit) {
    const { rel, depth } = stack.pop();
    let ents; try { ents = await fsp.readdir(rel ? path.join(root.dir, rel) : root.dir, { withFileTypes: true }); } catch { continue; }   // vanished / unreadable dir: skipped, never fatal
    const names = [];
    for (const e of ents) {
      if (visited >= limit) { capped = true; break; }
      visited++;
      if (++sinceYield >= YIELD_EVERY) { sinceYield = 0; await new Promise((r) => setImmediate(r)); }
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (skipsDir(root.dir, e.name, t.skipDirs)) continue;
        if (depth >= WALK_DEPTH) { capped = true; continue; }
        stack.push({ rel: rel ? rel + '/' + e.name : e.name, depth: depth + 1 });
      } else if (e.isFile()) names.push(e.name);
    }
    for (let i = 0; i < names.length; i += STAT_BATCH) {
      const slice = names.slice(i, i + STAT_BATCH);
      const entries = await Promise.all(slice.map((n) => fileEntry(t, root, rel, n, prefix)));
      for (const f of entries) if (f) files.push(f);
    }
  }
  return { files, visited, capped: capped || visited >= limit || stack.length > 0 };
}
// a single-file root (copilot-vscode through COPILOT_OTEL_FILE_EXPORTER_PATH): the declared basenames only — nothing else in the folder is looked at
async function walkSingleFiles(t, root, prefix, limit) {
  const entries = await Promise.all(root.files.slice(0, limit).map((name) => fileEntry(t, root, '', name, prefix)));
  return { files: entries.filter(Boolean), visited: entries.length, capped: root.files.length >= limit };
}
const samePath = (a, b) => (PLAT === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// fs.watch per root. A tool is 'fs' when every root has a live recursive watcher, 'polling' when any could not be armed (or died), null when
// it has no roots. Re-armed only when the root set changes.
function closeWatchers(s) { for (const w of s.watchers) { try { w.close(); } catch { /* already closed */ } } s.watchers = []; s.watchDirs = []; }
function markDirty(t, s) {
  if (s.dirty || s.dirtyTimer) return;   // already pending / already dirty: nothing to add (and no log spam while a tool writes continuously)
  s.dirtyTimer = setTimeout(() => { s.dirtyTimer = null; s.dirty = true; console.log(`${hhmmss()} ${t.id}: change detected — re-walk on the next /api/status`); }, DEBOUNCE_MS);
  s.dirtyTimer.unref();
}
function armWatchers(t, s, roots) {
  const dirs = roots.map((r) => r.dir);
  if (s.watch !== null && dirs.join('\0') === s.watchDirs.join('\0')) return;   // same roots as last time: keep the watchers (and a 'polling' verdict)
  closeWatchers(s);
  s.watchDirs = dirs;
  let armed = 0;
  for (const dir of dirs) {
    try {
      const w = fs.watch(dir, { recursive: true, persistent: false }, () => markDirty(t, s));
      w.on('error', (e) => {   // the root vanished (Windows: EPERM) or the watcher died: this tool falls back to the TTL until its roots change
        try { w.close(); } catch { /* ignore */ }
        s.watchers = s.watchers.filter((x) => x !== w);
        if (s.watch !== 'polling') console.error(`ai-usage-collector: ${t.id}: watcher on ${dir} stopped (${e && e.message || e}) — falling back to a ${TTL_MS / 1000} s re-walk`);
        s.watch = 'polling'; s.dirty = true;
      });
      s.watchers.push(w); armed++;
    } catch (e) {
      console.error(`ai-usage-collector: ${t.id}: fs.watch unavailable for ${dir} (${e && e.message || e}) — falling back to a ${TTL_MS / 1000} s re-walk`);
    }
  }
  s.watch = dirs.length ? (armed === dirs.length ? 'fs' : 'polling') : null;
}
const rootsChanged = (t, s) => resolveRoots(t).roots.map((r) => r.dir).join('\0') !== s.roots.map((r) => r.dir).join('\0');

async function refreshTool(t) {
  const s = state.get(t.id);
  if (s.walking) return s.walking;
  // the "walk in flight" slot is cleared by a promise reaction (.finally — always asynchronous): a tool with NO roots has no await in its walk, so an
  // inline finally would run before the assignment and leave a resolved promise behind that ensureFresh / ensureWalkedOnce then return forever —
  // a tool folder created after startup was never discovered (found while writing the A0 #8 check)
  s.walking = walkTool(t, s).finally(() => { s.walking = null; });
  return s.walking;
}
async function walkTool(t, s) {
  // events that arrived before this point describe changes already on disk — this walk sees them, so the pending mark is dropped;
  // an event DURING the walk arms a fresh timer and the next status re-walks
  if (s.dirtyTimer) { clearTimeout(s.dirtyTimer); s.dirtyTimer = null; }
  s.dirty = false;
  const t0 = Date.now();
  if (opts.disabled.has(t.id)) { closeWatchers(s); Object.assign(s, { roots: [], candidates: [], refused: [], found: false, files: [], bytes: 0, newestMtime: null, scannedAt: Date.now(), walkMs: 0, capped: false, watch: null }); return; }
  const { roots, candidates, refused } = resolveRoots(t);
  reportRefused(t, s, refused);
  armWatchers(t, s, roots);
  const multi = roots.length > 1;
  let files = [], visited = 0, capped = false;
  for (const r of roots) {
    if (visited >= WALK_CAP) { capped = true; break; }
    const w = r.files ? await walkSingleFiles(t, r, multi ? r.label + '/' : '', WALK_CAP - visited) : await walkRoot(t, r, multi ? r.label + '/' : '', WALK_CAP - visited);
    files = files.concat(w.files); visited += w.visited; capped = capped || w.capped;
  }
  if (capped && !s.capped) console.log(`${hhmmss()} ${t.id}: walk capped (limit ${WALK_CAP} visited entries / depth ${WALK_DEPTH}) — part of ${roots.map((r) => r.dir).join(' + ')} is not listed`);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const bytes = files.reduce((n, f) => n + f.size, 0), newest = files.reduce((m, f) => Math.max(m, f.mtime), 0);
  Object.assign(s, { roots, candidates, refused, found: roots.length > 0, files, bytes, newestMtime: files.length ? newest : null, scannedAt: Date.now(), walkMs: Date.now() - t0, capped });
}
// a refused root is logged once per change of the refused set (not per walk)
function reportRefused(t, s, refused) {
  if (JSON.stringify(refused) === JSON.stringify(s.refused)) return;
  for (const r of refused) console.error(`ai-usage-collector: ${t.id}: root ${r.dir} refused — it ${r.reason} (a tool root must be the tool's own folder)`);
}
// re-walk when: forced, never walked, a walk is already in flight (join it), the root set changed, the tool is dirty, or — polling fallback only — the cache is older than the TTL
function ensureFresh(t, force) {
  const s = state.get(t.id);
  if (force || s.scannedAt === null) return refreshTool(t);
  if (s.walking) return s.walking;
  if (opts.disabled.has(t.id)) return Promise.resolve();
  if (rootsChanged(t, s) || s.dirty) return refreshTool(t);
  if (s.watch === 'polling' && Date.now() - s.scannedAt > TTL_MS) return refreshTool(t);
  return Promise.resolve();
}
const toolStatus = (t) => { const s = state.get(t.id); return { id: t.id, name: t.name, roots: s.roots.map((r) => r.dir), candidates: s.candidates, found: s.found, ...(opts.disabled.has(t.id) ? { disabled: true } : {}), ...(s.refused.length ? { refused: s.refused } : {}), files: s.files.length, bytes: s.bytes, newestMtime: s.newestMtime, scannedAt: s.scannedAt, walkMs: s.walkMs, watch: s.found ? s.watch : null, ...(s.capped ? { capped: true } : {}) }; };

// /api/file path → { abs, st } or { status, error }: relative, forward slashes, no "." / ".." segments, inside the root, a regular file, no symlink on the way,
// no 8.3 short-name segment, and this tool's own log file — judged on the segments as requested AND on the segments realpath gives back (recheckReal)
const NOT_FOUND = { status: 404, error: 'file not found' };   // the one answer for "exists but is not served" — identical to a missing file
const SHORT_NAME = /~\d/;                                      // an 8.3 short name (UPLOAD~1): another spelling of a folder the rules name by its long name
// R-04 (deferred): WALK_DEPTH limits listings, but /api/file does not enforce it.
async function resolveFile(t, relIn) {
  const parsed = requestedSegments(relIn);
  if (parsed.error) return parsed;
  const s = state.get(t.id);
  if (!s.found) return { status: 404, error: `${t.id}: no folder found on this machine` };
  const picked = rootFor(t, s, parsed.segs);
  if (picked.error) return picked;
  const { root, rest } = picked;
  if (rest.some((sg) => SHORT_NAME.test(sg))) return NOT_FOUND;
  const abs = path.resolve(root.dir, ...rest);
  if (!inside(abs, root.dir)) return { status: 400, error: 'path resolves outside the tool folder' };
  if (isTokenFile(abs) || deniedReason(t, root, rest)) return NOT_FOUND;   // the token file (ollama's first root is ~/.ai-usage, where it lives) and anything the per-tool rules exclude
  let st; try { st = await fsp.lstat(abs); } catch { return NOT_FOUND; }
  if (st.isSymbolicLink()) return { status: 400, error: 'symbolic links are not served' };
  if (!st.isFile()) return { status: 404, error: 'not a regular file' };
  return recheckReal(t, root, abs, st);
}
// the request's path → its segments, or a 400: relative, forward slashes, no "." / ".." segments
function requestedSegments(relIn) {
  if (typeof relIn !== 'string' || !relIn || relIn.length > 4096 || relIn.includes('\0')) return { status: 400, error: 'path must be a relative path inside the tool folder' };
  const rel = relIn.replace(/\\/g, '/');
  if (rel.startsWith('/') || path.win32.isAbsolute(rel) || path.posix.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return { status: 400, error: 'absolute paths are not allowed' };
  const segs = rel.split('/');
  if (segs.some((sg) => sg === '' || sg === '.' || sg === '..')) return { status: 400, error: 'path must not contain "." or ".." segments' };
  return { segs };
}
// which root the path addresses: with several roots the first segment is a root label
function rootFor(t, s, segs) {
  if (s.roots.length === 1) return { root: s.roots[0], rest: segs };
  const root = s.roots.find((x) => x.label === segs[0]);
  if (!root) return { status: 404, error: `${t.id} has ${s.roots.length} roots — the path must start with one of: ${s.roots.map((x) => x.label).join(', ')}` };
  if (segs.length === 1) return { status: 400, error: 'path names a root, not a file' };
  return { root, rest: segs.slice(1) };
}
// the per-tool rules a root-relative path must pass (the walk applies the same ones): no skipped folder on the way (a Cowork session's outputs/, uploads/, …),
// a single-file root serves its declared file only, the extension allow-list + name deny-list (A0 #17), and the tool's include globs. Returns the reason or null.
function deniedReason(t, root, segs) {
  if (segs.slice(0, -1).some((sg) => skipsDir(root.dir, sg, t.skipDirs))) return 'skipped folder';
  const name = segs[segs.length - 1];
  if (root.files && !(segs.length === 1 && root.files.some((f) => samePath(f, name)))) return 'not the declared file';
  if (!servable(name) || !included(t, segs.join('/'))) return 'not a usage-log file of this tool';
  return null;
}
// after realpath: the file must still be inside the (real) root, and the real segments must pass the same rules — an 8.3 short name, a case-folded spelling or a
// junction must not reach what the requested spelling could not (review 8.3)
async function recheckReal(t, root, abs, st) {
  try {
    const realAbs = fs.realpathSync.native(abs), realRoot = fs.realpathSync.native(root.dir);
    if (!inside(realAbs, realRoot)) return { status: 400, error: 'path resolves outside the tool folder (symbolic link)' };   // a junction / symlinked parent dir escaping the root
    const realSegs = path.relative(realRoot, realAbs).split(path.sep);
    if (isTokenFile(realAbs) || deniedReason(t, { ...root, dir: realRoot }, realSegs)) return NOT_FOUND;
  } catch { return NOT_FOUND; }
  // R-05 (deferred): lstat/realpath and the later file open still have a TOCTOU window.
  return { abs, st };
}
// /api/file: wait for the tool's FIRST walk (its roots are unknown before it) or for one in flight — never trigger a dirty re-walk. A dirty tool is
// re-walked by the next /api/status or /api/list; a file request meanwhile must stream now, not after a full walk of a large tree (review m5).
function ensureWalkedOnce(t) {
  const s = state.get(t.id);
  if (s.walking) return s.walking;
  if (s.scannedAt === null) return refreshTool(t);
  return Promise.resolve();
}
const inside = (abs, root) => { const r = path.relative(root, abs); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r); };

// ---- HTTP -----------------------------------------------------------------------------------------------------------------------------------
const HTML_PATH = opts.html ? path.resolve(opts.html) : path.resolve(SCRIPT_DIR, '..', '..', 'AI Usage Dashboard.html');
const README_PATH = path.resolve(SCRIPT_DIR, '..', '..', 'README.md');   // the repo README: the served page links README.md#automatic-mode relative to itself
const GUIDE_PATH = path.resolve(SCRIPT_DIR, '..', 'user-guide.html');   // docs/user-guide.html: the Help dialog's "Full user guide" link, relative to the page too (Plan 8)
const HOST_OK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;      // Host allow-list — a DNS name resolving to 127.0.0.1 (rebinding) gets 421
const CT = { '.json': 'application/json; charset=utf-8', '.jsonl': 'application/x-ndjson; charset=utf-8', '.ndjson': 'application/x-ndjson; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.html': 'text/html; charset=utf-8' };
const STARTED_AT = new Date().toISOString();
const hhmmss = () => new Date().toTimeString().slice(0, 8);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Last-Modified');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');              // the served page is never framed
  res.setHeader('X-Content-Type-Options', 'nosniff');    // a served log file is what its Content-Type says, never sniffed into HTML
}
// one line per request — path + the tool/path/refresh params only (never the token, never contents). Control characters in a logged value become
// "?" and a value is cut at 200 chars: an unauthenticated request must not be able to forge a log line (review m1).
const logSafe = (v) => String(v).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 200);
function logLine(req, url, status, bytes) {
  const q = ['tool', 'path', 'refresh', 'decode'].filter((k) => url.searchParams.has(k)).map((k) => `${k}=${logSafe(url.searchParams.get(k))}`).join('&');
  console.log(`${hhmmss()} ${logSafe(req.method)} ${logSafe(url.pathname)}${q ? '?' + q : ''} ${status} ${bytes}`);
}
function sendJson(res, status, obj) { const body = Buffer.from(JSON.stringify(obj)); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length }); res.end(body); return body.length; }
function sendText(res, status, text, type = 'text/plain; charset=utf-8') { const body = Buffer.from(text); res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length }); res.end(body); return body.length; }

// ---- Plan 9 B6: GET /api/file?…&decode=zstd (design 8) -----------------------------------------------------------------------------------------------------
// The page asks for it when its browser cannot decompress zstd (Zed's thread store). Only the value `zstd`, only for a tool whose TABLE row carries decode: 'zstd'
// (zed). A zstd frame → its bytes (bounded by ZSTD_MAX_OUT, byte-exact); Zed's SQLite store → one JSON line per `threads` row with the blob decoded (data_type 'json'),
// or an {error} line for a row that does not decode — node:sqlite (Node ≥ 22.13, unflagged) reads the table read-only, zlib.zstdDecompressSync (Node ≥ 22.15) decodes.
// Failures are JSON: 400 (not zstd / not a decode tool), 413 (too large to decode in memory: the file, one row, the decoded total or the row count), 415 (neither a
// frame nor a SQLite store, or a store whose `threads` is not a table), 422 (the frame does not decode), 501 (this Node lacks zstd or node:sqlite). The page counts
// any non-200 as one unreadable file and says so.
const ZSTD_MAX_IN = 256 * 1024 * 1024, ZSTD_MAX_OUT = 256 * 1024 * 1024;   // a file, a frame
const ZSTD_ROW_MAX = envInt('COLLECTOR_ZSTD_ROW_MAX', 64 * 1024 * 1024), ZSTD_ROWS_MAX = 10000;               // one thread row, the number of rows
const ZSTD_BUDGET = envInt('COLLECTOR_ZSTD_BUDGET', 256 * 1024 * 1024);     // the decoded output of a whole store (test seam: COLLECTOR_ZSTD_BUDGET)
const ZSTD_MAGIC = Buffer.from('28b52ffd', 'hex'), SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const httpError = (status, message) => Object.assign(new Error(message), { status });
const zstdErrorText = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 160);   // zlib's own one-liner ("Unknown frame descriptor") — never a path, never a stack
function zstdDecode(buf, maxOut = ZSTD_MAX_OUT) {
  if (typeof zlib.zstdDecompressSync !== 'function') throw httpError(501, 'this Node has no zstd in zlib — decode=zstd needs Node 22.15 or newer');
  return zlib.zstdDecompressSync(buf, { maxOutputLength: maxOut });
}
async function readHead(abs, n) {
  const fh = await fsp.open(abs, 'r');
  try { const { bytesRead, buffer } = await fh.read(Buffer.alloc(n), 0, n, 0); return buffer.subarray(0, bytesRead); } finally { await fh.close(); }
}
async function decodedBody(r) {
  const head = await readHead(r.abs, SQLITE_MAGIC.length);
  if (head.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) return { body: zstdDecode(await fsp.readFile(r.abs)), type: CT['.json'] };
  if (head.equals(SQLITE_MAGIC)) return { body: await decodeZedThreadsDb(r.abs), type: CT['.jsonl'] };
  throw httpError(415, 'not a zstd frame and not a SQLite store — nothing to decode');
}
async function serveDecoded(req, res, t, r, decode) {
  if (decode !== 'zstd') return sendJson(res, 400, { error: `decode=${logSafe(decode)} is not supported — zstd is the only decoding offered` });
  if (t.decode !== 'zstd') return sendJson(res, 400, { error: `decode=zstd is only available for zed files (${t.id} keeps no zstd data)` });
  if (r.st.size > ZSTD_MAX_IN) return sendJson(res, 413, { error: `file too large to decode in memory (${r.st.size} bytes; the limit is ${ZSTD_MAX_IN})` });
  let out;
  try { out = await decodedBody(r); }
  catch (e) { return sendJson(res, e.status || (e.code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 422), { error: e.status ? e.message : `zstd decode failed: ${zstdErrorText(e)}` }); }
  res.writeHead(200, { 'Content-Type': out.type, 'Content-Length': out.body.length, 'Last-Modified': r.st.mtime.toUTCString() });
  if (req.method === 'HEAD') { res.end(); return 0; }
  res.end(out.body); return out.body.length;
}
/** Zed's threads.db → JSON lines, one per `threads` row: { id, summary, updated_at, data_type: 'json', data } with the blob decoded (a 'json' row passes through), or
 *  { id, summary, updated_at, error } when its frame does not decode. Opened read-only through node:sqlite with trusted_schema OFF (no SQL functions from the schema)
 *  and query_only ON — no copy is made, nothing is written. `threads` must be a TABLE (a VIEW would run whatever SQL the store's author wrote): 415 otherwise.
 *  Rows are read one at a time against a decoded-output budget (ZSTD_BUDGET total, ZSTD_ROW_MAX per row, ZSTD_ROWS_MAX rows): 413 when exceeded. */
async function decodeZedThreadsDb(abs) {
  const sqlite = await loadNodeSqlite();
  if (!sqlite) throw httpError(501, 'this Node has no node:sqlite — decoding threads.db needs Node 22.13 or newer (the page reads the store itself when its browser decodes zstd)');
  const db = new sqlite.DatabaseSync(abs, { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema=OFF');
    db.exec('PRAGMA query_only=1');
    assertThreadsTable(db);
    return collectZedRows(db);
  } finally { db.close(); }
}
function assertThreadsTable(db) {
  const entry = db.prepare("SELECT type FROM sqlite_master WHERE name = 'threads'").get();
  if (!entry) throw httpError(415, 'no threads table — not a Zed thread store');
  if (entry.type !== 'table') throw httpError(415, `threads is a ${entry.type}, not a table — nothing to decode`);
}
function collectZedRows(db) {
  const lines = []; let total = 0;
  for (const row of db.prepare('SELECT id, summary, updated_at, data_type, data FROM threads').iterate()) {
    if (lines.length >= ZSTD_ROWS_MAX) throw httpError(413, `more than ${ZSTD_ROWS_MAX} thread rows — too many to decode in memory`);
    const line = JSON.stringify(decodeZedRow(row));
    total += Buffer.byteLength(line, 'utf8') + 1;   // include the NDJSON newline in the response-byte budget
    if (total > ZSTD_BUDGET) throw httpError(413, `decoded threads exceed ${ZSTD_BUDGET} bytes — too large to decode in memory`);
    lines.push(line);
  }
  return Buffer.from(lines.length ? lines.join('\n') + '\n' : '');
}
function decodeZedRow(row) {
  const head = { id: row.id, summary: row.summary, updated_at: row.updated_at };
  const type = String(row.data_type || '').toLowerCase(), cell = row.data instanceof Uint8Array ? Buffer.from(row.data) : Buffer.from(String(row.data ?? ''), 'utf8');
  if (type !== 'zstd') return { ...head, data_type: type || 'json', data: cell.toString('utf8') };
  try { return { ...head, data_type: 'json', data: zstdDecode(cell, ZSTD_ROW_MAX).toString('utf8') }; }
  catch (e) {
    if (e.status) throw e;
    if (e.code === 'ERR_BUFFER_TOO_LARGE') throw httpError(413, `a thread row decodes to more than ${ZSTD_ROW_MAX} bytes — too large to decode in memory`);
    return { ...head, error: `zstd decode failed: ${zstdErrorText(e)}` };   // one bad row — the rest of the store still lands
  }
}
let nodeSqlite;   // undefined = not probed yet · null = this Node has no node:sqlite · else the module
async function loadNodeSqlite() {
  if (nodeSqlite !== undefined) return nodeSqlite;
  const origEmit = process.emitWarning;   // Node 22.13–22.x prints an ExperimentalWarning for node:sqlite — not an error, not for the console
  process.emitWarning = (w, ...a) => { if (/SQLite/i.test(String((w && w.message) || w))) return; return origEmit.call(process, w, ...a); };
  try { const m = await import('node:sqlite'); nodeSqlite = typeof m.DatabaseSync === 'function' ? m : null; }
  catch { nodeSqlite = null; }   // ERR_UNKNOWN_BUILTIN_MODULE on Node < 22.5, or flagged on 22.5–22.12: the 501 above tells the user which Node is needed
  finally { process.emitWarning = origEmit; }
  return nodeSqlite;
}

async function handle(req, res, url) {
  const p = url.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return 0; }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
  if (p === '/' || p === '/index.html') {
    let html; try { html = await fsp.readFile(HTML_PATH); } catch { return sendText(res, 404, 'AI Usage Dashboard.html not found — pass --html <path> (or run the collector from the repo, docs/tools/). The startup banner on the terminal names the path it looked at.\n'); }   // no path in the body (review m7)
    res.writeHead(200, { 'Content-Type': CT['.html'], 'Content-Length': html.length });
    if (req.method === 'HEAD') { res.end(); return 0; }
    res.end(html); return html.length;
  }
  if (p === '/README.md') {   // the served page's docs link (README.md#automatic-mode) is relative to the page (review m8)
    let md; try { md = await fsp.readFile(README_PATH); } catch { return sendText(res, 404, 'README.md not found next to the collector script (it lives in the repo root).\n'); }
    res.writeHead(200, { 'Content-Type': CT['.md'], 'Content-Length': md.length });
    if (req.method === 'HEAD') { res.end(); return 0; }
    res.end(md); return md.length;
  }
  if (p === '/docs/user-guide.html') {   // Plan 8: the Help dialog's "Full user guide" link is relative to the page too — same rule as /README.md
    let doc; try { doc = await fsp.readFile(GUIDE_PATH); } catch { return sendText(res, 404, 'docs/user-guide.html not found next to the collector script (it lives in the repo\'s docs folder).\n'); }   // no path in the body (review m7)
    res.writeHead(200, { 'Content-Type': CT['.html'], 'Content-Length': doc.length });
    if (req.method === 'HEAD') { res.end(); return 0; }
    res.end(doc); return doc.length;
  }
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return 0; }   // the browser asks for it on the served page — no icon, no 404 in the console
  if (!p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found', hint: 'GET / (dashboard), /api/status, /api/list?tool=<id>, /api/file?tool=<id>&path=<rel>' });
  if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized', hint: 'send Authorization: Bearer <token> — the token is printed when the collector starts and stored in ~/.ai-usage/collector.token' });
  const refresh = url.searchParams.get('refresh') === '1';
  if (p === '/api/status') {
    await Promise.all(TABLE.map((t) => ensureFresh(t, refresh)));
    return sendJson(res, 200, { version: VERSION, home: HOME, os: PLAT, node: process.version, port: PORT_BOUND, startedAt: STARTED_AT, tools: TABLE.map(toolStatus) });
  }
  const t = TOOL_BY_ID.get(url.searchParams.get('tool') || '');
  if (p === '/api/list' || p === '/api/file') {
    if (!t) return sendJson(res, 404, { error: 'unknown tool', hint: 'tool ids: ' + TABLE.map((x) => x.id).join(', ') });
    await (p === '/api/file' ? ensureWalkedOnce(t) : ensureFresh(t, refresh));   // a file request never re-walks a dirty tool (review m5)
  }
  if (p === '/api/list') {
    const s = state.get(t.id);
    if (!s.found) return sendJson(res, 404, { error: opts.disabled.has(t.id) ? `${t.id} is disabled (--no-${t.id})` : `${t.id}: no folder found on this machine`, candidates: s.candidates });
    return sendJson(res, 200, { tool: t.id, name: t.name, root: s.roots[0].dir, roots: s.roots.map((r) => r.dir), scannedAt: s.scannedAt, files: s.files });
  }
  if (p === '/api/file') {
    const r = await resolveFile(t, url.searchParams.get('path'));
    if (r.error) return sendJson(res, r.status, { error: r.error });
    if (url.searchParams.has('decode')) return serveDecoded(req, res, t, r, url.searchParams.get('decode'));   // Plan 9 B6: the page asked for the zstd data decoded
    res.writeHead(200, { 'Content-Type': CT[path.extname(r.abs).toLowerCase()] || 'application/octet-stream', 'Content-Length': r.st.size, 'Last-Modified': r.st.mtime.toUTCString() });
    if (req.method === 'HEAD' || r.st.size === 0) { res.end(); return 0; }
    return new Promise((resolve) => {
      let sent = 0;
      const stream = fs.createReadStream(r.abs, { end: r.st.size - 1 });   // exactly the bytes Content-Length announced — a log growing while it streams must not break the keep-alive framing (A0 #8)
      stream.on('data', (c) => { sent += c.length; });
      stream.on('error', () => { res.destroy(); resolve(sent); });   // vanished mid-stream: the client sees a cut connection, never a wrong file
      stream.on('end', () => resolve(sent));
      res.on('close', () => { stream.destroy(); resolve(sent); });
      stream.pipe(res);
    });
  }
  return sendJson(res, 404, { error: 'not found', hint: '/api/status, /api/list?tool=<id>, /api/file?tool=<id>&path=<rel>' });
}

let PORT_BOUND = 0;
const server = http.createServer((req, res) => {
  try { handleRequest(req, res); }
  catch {
    req.resume();
    if (res.headersSent) { res.destroy(); return; }
    cors(res);
    const n = sendJson(res, 400, { error: 'bad request' });
    logLine(req, new URL('/bad-request', 'http://127.0.0.1'), 400, n);
  }
});
function handleRequest(req, res) {
  if (!/^\/(?!\/)/.test(req.url)) throw new Error('request target must be origin-form');
  const url = new URL(req.url, 'http://127.0.0.1');
  cors(res);
  if (!HOST_OK.test(String(req.headers.host || '').trim())) {   // review m7: DNS rebinding — a name that resolves to 127.0.0.1 is answered with 421 only
    const n = sendJson(res, 421, { error: 'misdirected request', hint: 'the collector answers only for Host 127.0.0.1, localhost or [::1] (with the port)' });
    logLine(req, url, 421, n); return;
  }
  handle(req, res, url)
    .then((bytes) => logLine(req, url, res.statusCode, bytes || 0))
    .catch((e) => { console.error(`ai-usage-collector: ${req.method} ${url.pathname} failed — ${e && e.message || e}`); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); else res.destroy(); logLine(req, url, res.statusCode || 500, 0); });
}
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`ai-usage-collector: port ${opts.port} is already in use — is another collector running? (pass --port <n> or COLLECTOR_PORT)`);
  else console.error('ai-usage-collector: ' + (e.message || e));
  process.exit(1);
});
const portNum = parseInt(opts.port, 10);
if (Number.isNaN(portNum) || portNum < 0 || portNum > 65535) { console.error(`ai-usage-collector: invalid port "${opts.port}"`); process.exit(2); }

// ---- banner ---------------------------------------------------------------------------------------------------------------------------------
// The port is bound first, then every tool is walked once (a request arriving meanwhile simply joins that walk), then the table prints
// with each tool's file count, size, watch mode and walk time — so "listening on" is the last line and everything above it is measured.
const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
server.listen(portNum, '127.0.0.1', async () => {
  PORT_BOUND = server.address().port;
  const base = `http://127.0.0.1:${PORT_BOUND}`;
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, Math.max(n, s.length));
  console.log(`ai-usage-collector v${VERSION} · ${PLAT} · home ${HOME}`);
  try { await Promise.all(TABLE.map((t) => refreshTool(t))); } catch (e) { console.error('ai-usage-collector: initial walk failed — ' + (e && e.message || e)); }
  for (const t of TABLE) {
    const s = state.get(t.id);
    if (opts.disabled.has(t.id)) { console.log(`  ${pad(t.id, 12)} ${pad(t.name, 32)} disabled (--no-${t.id})`); continue; }
    const refused = s.refused.map((r) => ` · refused ${r.dir} — it ${r.reason}`).join('');
    if (s.found) console.log(`  ${pad(t.id, 12)} ${pad(t.name, 32)} found      ${s.files.length} file${s.files.length === 1 ? '' : 's'}${s.capped ? ' (capped)' : ''} · ${fmtBytes(s.bytes)} · watch ${s.watch} · walk ${s.walkMs} ms · ${s.roots.map((r) => r.dir).join(' + ')}${refused}`);
    else console.log(`  ${pad(t.id, 12)} ${pad(t.name, 32)} not found  ${s.candidates.length ? '(looked in ' + s.candidates.join(', ') + ')' : `(no fixed folder — pass --root ${t.id}=<path>)`}${refused}`);
  }
  if ([...state.values()].some((s) => s.watch === 'polling')) console.log('  (watch polling = recursive fs.watch is unavailable there; that tool is re-walked when its cache is older than 30 s)');
  console.log(`Dashboard file: ${HTML_PATH}${fs.existsSync(HTML_PATH) ? '' : '  (MISSING — GET / will answer 404; pass --html <path>)'}`);
  console.log(`Token ${TOKEN_CREATED ? 'created' : 'read from'} ${TOKEN_FILE}`);
  console.log(`Token: ${TOKEN}`);
  console.log(`Open the dashboard: ${base}/?token=${TOKEN}`);
  console.log('  (or paste the token into the "Local collector" card of your file:// copy of the page)');
  console.log(`listening on ${base}`);
});
const shutdown = () => { for (const s of state.values()) closeWatchers(s); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
