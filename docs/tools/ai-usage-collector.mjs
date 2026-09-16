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
 *           junie, lmstudio, ollama, jan, aider, tgwebui.
 *
 * Security — the token is the gate, not the origin:
 *   - 127.0.0.1 only. Every /api/* request must carry  Authorization: Bearer <token>  (or ?token=<token>) or it gets 401.
 *     The token lives in ~/.ai-usage/collector.token (32 random bytes, hex; created on first run, mode 0600 where the OS honours it).
 *     Without it any web page open in the browser could read the machine's AI transcripts through this port; origin checks are
 *     no substitute (a sandboxed iframe has a null origin, exactly like a file:// page).
 *   - Every response carries Access-Control-Allow-Origin: *, Access-Control-Allow-Headers: Authorization and
 *     Access-Control-Allow-Private-Network: true; OPTIONS → 204 — so a file:// page (Chrome's Private Network Access rules) and
 *     the collector-served page can both call it.
 *   - Read-only. Paths are validated to stay inside the tool's root: "..", absolute paths and symlinks are rejected (400). The
 *     recursive walk follows no symlinks and skips node_modules / .git / checkpoints. The token file itself is never listed or served.
 *   - One stdout line per request (method, path, status, bytes) — never file contents, never the token.
 *
 * API (JSON unless noted; the page applies each connector's own patterns / exclude / siblings — the collector never duplicates the registry):
 *   GET /api/status[?refresh=1]     { version, home, os, startedAt, tools: [{ id, name, roots, candidates, found, disabled?, files, bytes, newestMtime, scannedAt }] }
 *                                   counts come from a cached walk of every found root, refreshed at most every 30 s (refresh=1 forces one)
 *   GET /api/list?tool=<id>         { tool, name, root, roots, scannedAt, files: [{ path, size, mtime }] } — ALL regular files, paths relative,
 *                                   forward slashes; when a tool has more than one root each path is prefixed with that root's folder name
 *   GET /api/file?tool=<id>&path=<rel>   the file bytes, streamed, with Content-Length + Last-Modified (404 when missing)
 *   GET /                           the dashboard HTML (404 with a hint when the file is not where expected)
 * Node ≥ 20. No dependencies.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const VERSION = '7.0';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const NODE_MAJOR = parseInt(process.versions.node.split('.')[0], 10);
if (NODE_MAJOR < 20) { console.error(`ai-usage-collector: Node 20 or newer is required (this is ${process.version})`); process.exit(1); }

// ---- discovery table (per OS) --------------------------------------------------------------------------------------------------------------
const HOME = os.homedir();
const PLAT = process.platform;
const env = (k) => (process.env[k] || '').trim();
const APPDATA = env('APPDATA') || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = env('LOCALAPPDATA') || path.join(HOME, 'AppData', 'Local');
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
// groups: [[candidate, candidate…], …] — per group the FIRST existing directory is a root; a function computes groups at refresh time
const TABLE = [
  { id: 'local',       name: 'Claude Code / Desktop',           groups: [[env('CLAUDE_CONFIG_DIR') || path.join(HOME, '.claude')]] },
  { id: 'codex',       name: 'OpenAI Codex CLI',                groups: [[env('CODEX_HOME') || path.join(HOME, '.codex')]] },
  { id: 'copilot-cli', name: 'GitHub Copilot CLI (logs)',       groups: [[path.join(HOME, '.copilot')]] },
  { id: 'gemini-cli',  name: 'Gemini CLI',                      groups: [[env('GEMINI_CLI_HOME') || path.join(HOME, '.gemini')]] },
  { id: 'continue',    name: 'Continue.dev',                    groups: [[path.join(HOME, '.continue')]] },
  { id: 'cline',       name: 'Cline (VS Code)',                 groups: [extStorage('saoudrizwan.claude-dev')] },
  { id: 'roo',         name: 'Roo Code (VS Code)',              groups: [extStorage('rooveterinaryinc.roo-cline'), extStorage('kilocode.kilo-code')] },
  { id: 'junie',       name: 'JetBrains AI Assistant / Junie',  groups: () => [[path.join(HOME, '.junie')], ...matterhornDirs().map((d) => [d])] },
  { id: 'lmstudio',    name: 'LM Studio',                       groups: [[path.join(HOME, '.lmstudio', 'conversations'), path.join(HOME, '.cache', 'lm-studio', 'conversations')]] },
  { id: 'ollama',      name: 'Ollama',                          groups: [[path.join(HOME, '.ai-usage')], [PLAT === 'win32' ? path.join(LOCALAPPDATA, 'Ollama') : PLAT === 'darwin' ? path.join(HOME, 'Library', 'Application Support', 'Ollama') : path.join(HOME, '.ollama')]] },
  { id: 'jan',         name: 'Jan',                             groups: [[PLAT === 'win32' ? path.join(APPDATA, 'Jan', 'data') : PLAT === 'darwin' ? path.join(HOME, 'Library', 'Application Support', 'Jan', 'data') : path.join(HOME, '.local', 'share', 'Jan', 'data')]] },
  { id: 'aider',       name: 'Aider',                           groups: [] },   // per-repo files — --root <folder that holds your repos> only
  { id: 'tgwebui',     name: 'text-generation-webui',           groups: [] },   // install folder — --root <install or user_data> only
];
const TOOL_BY_ID = new Map(TABLE.map((t) => [t.id, t]));

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
  console.log(`ai-usage-collector v${VERSION} — serves this machine's AI log folders to the AI Usage Dashboard on 127.0.0.1
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
function authorized(req, url) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '');
  const given = Buffer.from(m ? m[1] : (url.searchParams.get('token') || ''));
  return given.length === TOKEN_BUF.length && crypto.timingSafeEqual(given, TOKEN_BUF);
}

// ---- roots + cached walk --------------------------------------------------------------------------------------------------------------------
const SKIP_DIRS = new Set(['node_modules', '.git', 'checkpoints']);
const CACHE_MS = 30000;
const state = new Map();   // id → { roots: [{ dir, label }], candidates: [dir…], found, files: [{ path, size, mtime }], bytes, newestMtime, scannedAt, walking: Promise|null }
for (const t of TABLE) state.set(t.id, { roots: [], candidates: [], found: false, files: [], bytes: 0, newestMtime: null, scannedAt: null, walking: null });

// the roots of a tool right now: --root overrides the table; every group contributes its first existing directory
function resolveRoots(t) {
  const groups = opts.roots.has(t.id) ? opts.roots.get(t.id).map((d) => [d]) : (typeof t.groups === 'function' ? t.groups() : t.groups);
  const candidates = [], dirs = [];
  for (const g of groups) { candidates.push(...g); const hit = g.find(isDir); if (hit && !dirs.includes(hit)) dirs.push(hit); }
  // labels: a tool with several roots prefixes each path with the root's folder name (made unique: "matterhorn", "matterhorn~2", …)
  const labels = new Map();
  const roots = dirs.map((dir) => { const base = path.basename(dir) || dir; let label = base, n = 1; while ([...labels.values()].includes(label)) label = `${base}~${++n}`; labels.set(dir, label); return { dir, label }; });
  return { roots, candidates };
}

// recursive walk of one root: regular files only, no symlinks, skip dirs by name; paths relative with forward slashes
async function walkRoot(dir, prefix) {
  const files = []; let bytes = 0, newest = 0;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(dir, rel) : dir;
    let ents; try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch { continue; }   // vanished / unreadable dir: skipped, never fatal
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(r); continue; }
      if (!e.isFile()) continue;
      const full = path.join(abs, e.name);
      if (samePath(full, TOKEN_FILE)) continue;   // the token file is never listed or served
      let st; try { st = await fsp.stat(full); } catch { continue; }
      const mtime = Math.round(st.mtimeMs);
      files.push({ path: prefix + r, size: st.size, mtime });
      bytes += st.size; if (mtime > newest) newest = mtime;
    }
  }
  return { files, bytes, newest };
}
const samePath = (a, b) => (PLAT === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

async function refreshTool(t) {
  const s = state.get(t.id);
  if (s.walking) return s.walking;
  s.walking = (async () => {
    try {
      if (opts.disabled.has(t.id)) { Object.assign(s, { roots: [], candidates: [], found: false, files: [], bytes: 0, newestMtime: null, scannedAt: Date.now() }); return; }
      const { roots, candidates } = resolveRoots(t);
      const multi = roots.length > 1;
      let files = [], bytes = 0, newest = 0;
      for (const r of roots) { const w = await walkRoot(r.dir, multi ? r.label + '/' : ''); files = files.concat(w.files); bytes += w.bytes; if (w.newest > newest) newest = w.newest; }
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      Object.assign(s, { roots, candidates, found: roots.length > 0, files, bytes, newestMtime: files.length ? newest : null, scannedAt: Date.now() });
    } finally { s.walking = null; }
  })();
  return s.walking;
}
const ensureFresh = (t, force) => { const s = state.get(t.id); return (force || s.scannedAt === null || Date.now() - s.scannedAt > CACHE_MS) ? refreshTool(t) : Promise.resolve(); };
const toolStatus = (t) => { const s = state.get(t.id); return { id: t.id, name: t.name, roots: s.roots.map((r) => r.dir), candidates: s.candidates, found: s.found, ...(opts.disabled.has(t.id) ? { disabled: true } : {}), files: s.files.length, bytes: s.bytes, newestMtime: s.newestMtime, scannedAt: s.scannedAt }; };

// /api/file path → { abs } or { status, error }: relative, forward slashes, no "." / ".." segments, inside the root, a regular file, no symlink on the way
async function resolveFile(t, relIn) {
  if (typeof relIn !== 'string' || !relIn || relIn.length > 4096 || relIn.includes('\0')) return { status: 400, error: 'path must be a relative path inside the tool folder' };
  const rel = relIn.replace(/\\/g, '/');
  if (rel.startsWith('/') || path.win32.isAbsolute(rel) || path.posix.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return { status: 400, error: 'absolute paths are not allowed' };
  const segs = rel.split('/');
  if (segs.some((sg) => sg === '' || sg === '.' || sg === '..')) return { status: 400, error: 'path must not contain "." or ".." segments' };
  const s = state.get(t.id);
  if (!s.found) return { status: 404, error: `${t.id}: no folder found on this machine` };
  let root, rest;
  if (s.roots.length > 1) { const r = s.roots.find((x) => x.label === segs[0]); if (!r) return { status: 404, error: `${t.id} has ${s.roots.length} roots — the path must start with one of: ${s.roots.map((x) => x.label).join(', ')}` }; root = r.dir; rest = segs.slice(1); if (!rest.length) return { status: 400, error: 'path names a root, not a file' }; }
  else { root = s.roots[0].dir; rest = segs; }
  const abs = path.resolve(root, ...rest);
  if (!inside(abs, root)) return { status: 400, error: 'path resolves outside the tool folder' };
  let st; try { st = await fsp.lstat(abs); } catch { return { status: 404, error: 'file not found' }; }
  if (st.isSymbolicLink()) return { status: 400, error: 'symbolic links are not served' };
  if (!st.isFile()) return { status: 404, error: 'not a regular file' };
  try { const [realAbs, realRoot] = await Promise.all([fsp.realpath(abs), fsp.realpath(root)]); if (!inside(realAbs, realRoot)) return { status: 400, error: 'path resolves outside the tool folder (symbolic link)' }; }   // a junction / symlinked parent dir escaping the root
  catch { return { status: 404, error: 'file not found' }; }
  return { abs, st };
}
const inside = (abs, root) => { const r = path.relative(root, abs); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r); };

// ---- HTTP -----------------------------------------------------------------------------------------------------------------------------------
const HTML_PATH = opts.html ? path.resolve(opts.html) : path.resolve(SCRIPT_DIR, '..', '..', 'AI Usage Dashboard.html');
const CT = { '.json': 'application/json; charset=utf-8', '.jsonl': 'application/x-ndjson; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.html': 'text/html; charset=utf-8' };
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
}
// one line per request — path + the tool/path/refresh params only (never the token, never contents)
function logLine(req, url, status, bytes) {
  const q = ['tool', 'path', 'refresh'].filter((k) => url.searchParams.has(k)).map((k) => `${k}=${url.searchParams.get(k)}`).join('&');
  console.log(`${hhmmss()} ${req.method} ${url.pathname}${q ? '?' + q : ''} ${status} ${bytes}`);
}
function sendJson(res, status, obj) { const body = Buffer.from(JSON.stringify(obj)); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length }); res.end(body); return body.length; }
function sendText(res, status, text, type = 'text/plain; charset=utf-8') { const body = Buffer.from(text); res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length }); res.end(body); return body.length; }

async function handle(req, res, url) {
  const p = url.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return 0; }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
  if (p === '/' || p === '/index.html') {
    let html; try { html = await fsp.readFile(HTML_PATH); } catch { return sendText(res, 404, `AI Usage Dashboard.html not found at ${HTML_PATH}\nRun the collector from the repo (docs/tools/) or pass --html <path to AI Usage Dashboard.html>.\n`); }
    res.writeHead(200, { 'Content-Type': CT['.html'], 'Content-Length': html.length });
    if (req.method === 'HEAD') { res.end(); return 0; }
    res.end(html); return html.length;
  }
  if (!p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found', hint: 'GET / (dashboard), /api/status, /api/list?tool=<id>, /api/file?tool=<id>&path=<rel>' });
  if (!authorized(req, url)) return sendJson(res, 401, { error: 'unauthorized', hint: 'send Authorization: Bearer <token> (or ?token=) — the token is printed when the collector starts and stored in ~/.ai-usage/collector.token' });
  const refresh = url.searchParams.get('refresh') === '1';
  if (p === '/api/status') {
    await Promise.all(TABLE.map((t) => ensureFresh(t, refresh)));
    return sendJson(res, 200, { version: VERSION, home: HOME, os: PLAT, node: process.version, port: PORT_BOUND, startedAt: STARTED_AT, tools: TABLE.map(toolStatus) });
  }
  const t = TOOL_BY_ID.get(url.searchParams.get('tool') || '');
  if (p === '/api/list' || p === '/api/file') {
    if (!t) return sendJson(res, 404, { error: 'unknown tool', hint: 'tool ids: ' + TABLE.map((x) => x.id).join(', ') });
    await ensureFresh(t, refresh);
  }
  if (p === '/api/list') {
    const s = state.get(t.id);
    if (!s.found) return sendJson(res, 404, { error: opts.disabled.has(t.id) ? `${t.id} is disabled (--no-${t.id})` : `${t.id}: no folder found on this machine`, candidates: s.candidates });
    return sendJson(res, 200, { tool: t.id, name: t.name, root: s.roots[0].dir, roots: s.roots.map((r) => r.dir), scannedAt: s.scannedAt, files: s.files });
  }
  if (p === '/api/file') {
    const r = await resolveFile(t, url.searchParams.get('path'));
    if (r.error) return sendJson(res, r.status, { error: r.error });
    res.writeHead(200, { 'Content-Type': CT[path.extname(r.abs).toLowerCase()] || 'application/octet-stream', 'Content-Length': r.st.size, 'Last-Modified': r.st.mtime.toUTCString() });
    if (req.method === 'HEAD') { res.end(); return 0; }
    return new Promise((resolve) => {
      let sent = 0;
      const stream = fs.createReadStream(r.abs);
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
  const url = new URL(req.url, 'http://127.0.0.1');
  cors(res);
  handle(req, res, url)
    .then((bytes) => logLine(req, url, res.statusCode, bytes || 0))
    .catch((e) => { console.error(`ai-usage-collector: ${req.method} ${url.pathname} failed — ${e && e.message || e}`); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); else res.destroy(); logLine(req, url, res.statusCode || 500, 0); });
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`ai-usage-collector: port ${opts.port} is already in use — is another collector running? (pass --port <n> or COLLECTOR_PORT)`);
  else console.error('ai-usage-collector: ' + (e.message || e));
  process.exit(1);
});
const portNum = parseInt(opts.port, 10);
if (Number.isNaN(portNum) || portNum < 0 || portNum > 65535) { console.error(`ai-usage-collector: invalid port "${opts.port}"`); process.exit(2); }

// ---- banner ---------------------------------------------------------------------------------------------------------------------------------
server.listen(portNum, '127.0.0.1', () => {
  PORT_BOUND = server.address().port;
  const base = `http://127.0.0.1:${PORT_BOUND}`;
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, Math.max(n, s.length));
  console.log(`ai-usage-collector v${VERSION} · ${PLAT} · home ${HOME}`);
  for (const t of TABLE) {
    if (opts.disabled.has(t.id)) { console.log(`  ${pad(t.id, 12)} ${pad(t.name, 32)} disabled (--no-${t.id})`); continue; }
    const { roots, candidates } = resolveRoots(t);
    if (roots.length) console.log(`  ${pad(t.id, 12)} ${pad(t.name, 32)} found      ${roots.map((r) => r.dir).join(' + ')}`);
    else console.log(`  ${pad(t.id, 12)} ${pad(t.name, 32)} not found  ${candidates.length ? '(looked in ' + candidates.join(', ') + ')' : `(no fixed folder — pass --root ${t.id}=<path>)`}`);
  }
  console.log(`Dashboard file: ${HTML_PATH}${fs.existsSync(HTML_PATH) ? '' : '  (MISSING — GET / will answer 404; pass --html <path>)'}`);
  console.log(`Token ${TOKEN_CREATED ? 'created' : 'read from'} ${TOKEN_FILE}`);
  console.log(`Token: ${TOKEN}`);
  console.log(`Open the dashboard: ${base}/?token=${TOKEN}`);
  console.log('  (or paste the token into the "Local collector" card of your file:// copy of the page)');
  console.log(`listening on ${base}`);
});
const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
