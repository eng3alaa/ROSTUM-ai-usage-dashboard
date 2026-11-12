// Node-level test for docs/tools/ai-usage-collector.mjs — no browser. The suite runs it from tests/checks/89c-collector.mjs;
// alone:  node tests/tools/collector.test.mjs
// A temp HOME under tests/fixtures/out/collector-home-<pid>/ is seeded by COPYING the existing fixtures into the tools' standard
// folders (.claude/projects, .codex/sessions + one rollout copied into .codex/archived_sessions, .copilot/session-state) plus decoys
// the walk must skip or never list (node_modules, checkpoints, ~/.codex/cache + config.toml — codex roots are sessions/ and
// archived_sessions/ only) and a 2 MB file under ~/.gemini for the streaming-during-walk check; the collector runs as a child
// process with HOME / USERPROFILE / APPDATA / LOCALAPPDATA all pointing at that dir and COLLECTOR_PORT=0 (the bound port is parsed
// from its "listening on" line). Asserts: token gate (401), CORS/PNA on every answer (OPTIONS 204), /api/status discovery + the
// change-driven walk (fs.watch per root → a plain /api/status counts a new file within 8 s; a clean tool is never re-walked;
// ?refresh=1 forces one), /api/list relative forward-slash paths (multi-root prefixes), /api/file byte-exact streaming — also while
// a forced walk is in flight — traversal guard (400), 404s, GET / serves the dashboard, the request log never carries the token,
// the startup banner (per-tool counts + watch mode), --no-<id> / --root (single and multi-root).
// Plan 7 review fixes: the token file is never served even through ollama (whose root is ~/.ai-usage) (M2); query values are sanitised in the
// request log (m1); /api/file never triggers a dirty re-walk (m5); hardening headers, Host allow-list → 421, a 404 for / that names no path (m7);
// GET /README.md served (m8). Plan 8: GET /docs/user-guide.html served (the Help dialog's "Full user guide" link is relative to the page too).
// Plan 9 integration review (collector half): per-tool include globs (only a tool's own log files are listed or served — CLAUDE.md, memory/*.md,
// settings.local.json, MCP configs never), single-file roots (copilot-vscode serves ONLY the OTel outfile; a root that is HOME is refused), the
// post-realpath re-check + `~1` short-name rejection (8.3 names, case folding), decode=zstd table-only + output budget (COLLECTOR_ZSTD_BUDGET test
// seam → 413/415), the per-tool walk cap (COLLECTOR_WALK_CAP test seam → capped: true).
// Windows-safe: 127.0.0.1 only, every wait ≤ 10 s (35 s only on a platform without recursive fs.watch), every child is killed in
// finally, the temp HOME is deleted afterwards.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(import.meta.dirname, '..', '..');
const COLLECTOR = path.join(ROOT, 'docs', 'tools', 'ai-usage-collector.mjs');
const OUT_DIR = path.join(ROOT, 'tests', 'fixtures', 'out');
const HOME = path.join(OUT_DIR, `collector-home-${process.pid}`);
const HOME_DEFAULT = HOME;
const CODEX_FILE = 'sessions/2026/08/10/rollout-2026-08-10T09-00-00-abc.jsonl';
const CODEX_ARCHIVED = 'archived_sessions/rollout-2026-08-10T09-00-00-abc.jsonl';   // Codex's archived_sessions/ is flat: rollout-*.jsonl directly inside
const COPILOT_FILE = 'session-state/sess-1/events.jsonl';
const BIG_FILE = 'tmp/abc123/chats/session-big-2mb.json';   // under ~/.gemini (seedReviewFixtures — the Node test only): the only gemini-cli file, ≥ 2 MB, named like a Gemini session so the include glob lists it
const TOUCHED_FILE = 'tmp/abc123/chats/session-touched.json';   // the second gemini-cli file, written mid-test (review m5)
const CKPT_ROLLOUT = 'sessions/checkpoints/rollout-2026-01-01T00-00-00-ckpt.jsonl';   // a rollout-named file inside a skipped folder: never listed — and the CHECKPOINTS spelling must not reach it either (8.3 / case re-check)
const EXT_STORAGE = (id) => path.join('Code', 'User', 'globalStorage', id);   // the VS Code extension globalStorage layout under APPDATA (= HOME here)
const CODEX_PATHS = [
  'archived_sessions/rollout-2026-08-10T09-00-00-abc.jsonl',
  'sessions/2026/08/10/rollout-2026-08-10T09-00-00-abc.jsonl',
  'sessions/2026/08/11/rollout-2026-08-11T08-00-00-abc-resumed.jsonl',
  'sessions/2026/08/12/rollout-2026-08-12T09-00-00-oss.jsonl',
  'sessions/2026/08/12/rollout-2026-08-12T10-00-00-named.jsonl',
];

const TTL_MS = 30000;   // the collector's polling-fallback TTL (review m5 waits it out where fs.watch is unavailable)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const request = (port, method, p, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    res.on('error', reject);
  });
  req.on('error', reject);
  req.setTimeout(10000, () => req.destroy(new Error('timeout ' + method + ' ' + p)));
  req.end();
});
// a raw HTTP/1.1 GET over a bare socket (Connection: close): the whole answer is read until the server closes, so bytes written PAST the declared
// Content-Length are seen (an http client parser would cut the body at Content-Length and hide them). onFirstData runs with the socket paused.
const rawGet = (port, p, headers, onFirstData) => new Promise((resolve, reject) => {
  const s = net.connect({ host: '127.0.0.1', port });
  const chunks = []; let first = true;
  s.on('connect', () => s.write(`GET ${p} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n${Object.entries(headers).map(([k, v]) => k + ': ' + v + '\r\n').join('')}\r\n`));
  s.on('data', (c) => { chunks.push(c); if (first) { first = false; s.pause(); onFirstData().then(() => s.resume(), reject); } });
  s.on('end', () => { const buf = Buffer.concat(chunks); const i = buf.indexOf('\r\n\r\n'); resolve({ head: buf.subarray(0, i).toString('latin1'), body: buf.subarray(i + 4) }); });
  s.on('error', reject);
  s.setTimeout(30000, () => s.destroy(new Error('timeout raw GET ' + p)));
});
const rawBadRequest = (port) => new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  let response = '';
  socket.setEncoding('utf8');
  socket.setTimeout(10000, () => socket.destroy(new Error('malformed request timeout')));
  socket.once('connect', () => socket.end('GET // HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\n\r\n'));
  socket.on('data', (chunk) => { response += chunk; });
  socket.once('end', () => resolve(response));
  socket.once('error', reject);
});
const asJson = (r) => { try { return JSON.parse(r.body.toString('utf8')); } catch { return null; } };
const isJsonCT = (r) => /^application\/json/i.test(r.headers['content-type'] || '');
const corsOk = (r) => r.headers['access-control-allow-origin'] === '*'
  && /authorization/i.test(r.headers['access-control-allow-headers'] || '')
  && String(r.headers['access-control-allow-private-network']).toLowerCase() === 'true';

// spawn the collector against a temp HOME (default: this test's); resolves once its "listening on http://127.0.0.1:<port>" line is out (or it exits / 10 s pass).
// Exported for tests/checks/89c-collector.mjs's end-to-end block (real collector + real page), which seeds its own HOME the same way.
export async function start(args, home = HOME, extraEnv = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, COLLECTOR_PORT: '0', ...extraEnv };   // extraEnv: per-instance variables (B6: COPILOT_OTEL_FILE_EXPORTER_PATH)
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME']) delete env[k];   // a developer's own overrides must not leak into the child
  const h = { child: null, port: 0, out: '', err: '', exited: null };
  h.child = spawn(process.execPath, [COLLECTOR, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  h.child.stdout.on('data', (d) => { h.out += d; });
  h.child.stderr.on('data', (d) => { h.err += d; });
  h.child.on('exit', (code, signal) => { h.exited = { code, signal }; });
  const deadline = Date.now() + 10000;
  while (!h.port && Date.now() < deadline && !h.exited) {
    const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(h.out);
    if (m) h.port = +m[1]; else await sleep(50);
  }
  h.io = () => `stdout=${h.out.trim().replace(/\s+/g, ' ').slice(0, 1500)} · stderr=${h.err.trim().replace(/\s+/g, ' ').slice(0, 800)} · exit=${JSON.stringify(h.exited)}`;
  h.stop = async () => { if (h.child && h.exited === null) { h.child.kill(); await Promise.race([new Promise((r) => h.child.once('exit', r)), sleep(5000)]); } };
  return h;
}

export function seedHome(HOME = HOME_DEFAULT) {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.cpSync(path.join(OUT_DIR, 'claude-logs', 'projects'), path.join(HOME, '.claude', 'projects'), { recursive: true });
  fs.cpSync(path.join(OUT_DIR, 'codex', 'sessions'), path.join(HOME, '.codex', 'sessions'), { recursive: true });
  fs.cpSync(path.join(OUT_DIR, 'copilot', 'session-state'), path.join(HOME, '.copilot', 'session-state'), { recursive: true });
  fs.mkdirSync(path.join(HOME, '.claude', 'node_modules', 'pkg'), { recursive: true });   // the walk must skip node_modules / .git / checkpoints
  fs.writeFileSync(path.join(HOME, '.claude', 'node_modules', 'pkg', 'skipped.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(HOME, '.codex', 'sessions', 'checkpoints'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.codex', 'sessions', 'checkpoints', 'skipped.jsonl'), '{}\n');
  // codex: archived_sessions/ is a second root (flat rollout-*.jsonl); cache/ + config.toml live in ~/.codex but under no root → never listed
  fs.mkdirSync(path.join(HOME, '.codex', 'archived_sessions'), { recursive: true });
  fs.copyFileSync(path.join(HOME, '.codex', ...CODEX_FILE.split('/')), path.join(HOME, '.codex', ...CODEX_ARCHIVED.split('/')));
  fs.mkdirSync(path.join(HOME, '.codex', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.codex', 'cache', 'junk.txt'), 'not a session\n');
  fs.writeFileSync(path.join(HOME, '.codex', 'config.toml'), 'model = "gpt-5-codex"\n');
  // gemini-cli: a .jsonl that is NOT a session file — passes the extension allow-list, fails the tool's include glob (**/session-*.json): found, nothing listed
  fs.mkdirSync(path.join(HOME, '.gemini', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.gemini', 'tmp', 'not-a-session.jsonl'), '{"i":1}\n');
  // A0 #17: credential files that really live under these roots, plus a file outside the extension allow-list — never listed, never served
  fs.writeFileSync(path.join(HOME, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-SECRET-FIXTURE","refreshToken":"sk-ant-ort01-SECRET-FIXTURE"}}\n');
  fs.writeFileSync(path.join(HOME, '.claude', 'settings.json'), '{"env":{"ANTHROPIC_API_KEY":"sk-ant-api03-SECRET-FIXTURE"}}\n');
  fs.writeFileSync(path.join(HOME, '.gemini', 'oauth_creds.json'), '{"access_token":"ya29.SECRET-FIXTURE","refresh_token":"1//SECRET-FIXTURE"}\n');
  fs.writeFileSync(path.join(HOME, '.gemini', 'settings.json'), '{"selectedAuthType":"gemini-api-key"}\n');
  fs.writeFileSync(path.join(HOME, '.gemini', '.env'), 'GEMINI_API_KEY=AIza-SECRET-FIXTURE\n');
  fs.writeFileSync(path.join(HOME, '.codex', 'sessions', 'notes.yaml'), 'not: a log\n');
  // Plan 9 review: files under the roots that pass the extension allow-list but are not that tool's logs — the per-tool include globs (and the wider
  // deny-list: settings.*.json, mcp*.json) keep them out of the listing and off /api/file
  fs.writeFileSync(path.join(HOME, '.claude', 'CLAUDE.md'), '# user instructions FIXTURE-PRIVATE\n');
  fs.mkdirSync(path.join(HOME, '.claude', 'projects', '-D--proj1', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.claude', 'projects', '-D--proj1', 'memory', 'notes.md'), 'memory FIXTURE-PRIVATE\n');
  fs.writeFileSync(path.join(HOME, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash(rm:*)"]}}\n');
  fs.writeFileSync(path.join(HOME, '.copilot', 'mcp-config.json'), '{"mcpServers":{"x":{"env":{"TOKEN":"FIXTURE-PRIVATE"}}}}\n');
  fs.writeFileSync(path.join(HOME, '.codex', ...CKPT_ROLLOUT.split('/')), '{"type":"session_meta"}\n');
}

// Plan 9 B5 — the Wave 3 coding tools' standard folders, seeded from the out/wave3 fixtures (gen.mjs). Kept out of seedHome because 89c's
// end-to-end block asserts the found-tool count of seedHome alone. Windows layout (the suite runs on win32; APPDATA = LOCALAPPDATA = HOME here):
//   opencode  ~/.local/share/opencode/opencode.db + storage/message/<sid>/msg_*.json (legacy JSON) — snapshot/ is OpenCode's git object store (never walked)
//   goose     <APPDATA>/Block/goose/sessions/sessions.db · devin <APPDATA>/devin/cli/sessions.db · kilo <APPDATA>/Code/User/globalStorage/kilocode.kilo-code
//   amp       ~/.local/share/amp/threads/*.json — the root is threads/ itself, so history.jsonl (prompt text) and session.json beside it are never listed
export function seedWave3(HOME = HOME_DEFAULT) {
  const W3 = path.join(OUT_DIR, 'wave3');
  fs.cpSync(path.join(W3, 'opencode'), path.join(HOME, '.local', 'share', 'opencode'), { recursive: true });
  fs.mkdirSync(path.join(HOME, '.local', 'share', 'opencode', 'snapshot', 'prj_1', 'objects', 'ab'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.local', 'share', 'opencode', 'snapshot', 'prj_1', 'objects', 'ab', 'cdef.json'), '{"not":"a log"}\n');
  fs.cpSync(path.join(W3, 'goose', 'sessions'), path.join(HOME, 'Block', 'goose', 'sessions'), { recursive: true });
  fs.cpSync(path.join(W3, 'devin', 'cli'), path.join(HOME, 'devin', 'cli'), { recursive: true });
  fs.cpSync(path.join(W3, 'kilo', 'tasks'), path.join(HOME, 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks'), { recursive: true });
  fs.cpSync(path.join(W3, 'amp'), path.join(HOME, '.local', 'share', 'amp'), { recursive: true });
}
// Plan 9 B6 — Zed's threads folder (Windows layout: %LOCALAPPDATA%\Zed\threads — LOCALAPPDATA = HOME here) with threads.db (zstd blobs), a plain zstd frame named
// thread-fixture.json and a corrupt frame; the GitHub Copilot Chat OTel outfile under <HOME>/copilot-otel — the collector learns that folder from
// COPILOT_OTEL_FILE_EXPORTER_PATH (start()'s extraEnv), as the outfile has no fixed location.
export const OTEL_FILE = 'copilot-chat.jsonl';
export function seedB6(HOME = HOME_DEFAULT) {
  fs.cpSync(path.join(OUT_DIR, 'b6', 'zed', 'threads'), path.join(HOME, 'Zed', 'threads'), { recursive: true });
  fs.cpSync(path.join(OUT_DIR, 'b6', 'copilot-otel'), path.join(HOME, 'copilot-otel'), { recursive: true });
}
// Plan 9 review — Node-test-only seeding (89c's end-to-end block seeds seedHome alone and asserts what the page then sees): gemini-cli's ≥ 2 MB session-named
// file for the streaming checks; cline + roo with their task fixtures AND an MCP settings file each (never listed); copilot-vscode siblings beside the OTel
// outfile (a .jsonl that would pass the include glob but is not THE file, and a secret .json); the OTel outfile spelled straight under HOME for the root-refusal run.
export function seedReviewFixtures(HOME = HOME_DEFAULT) {
  const lines = []; let size = 0;
  for (let i = 0; size < 2 * 1024 * 1024; i++) { const l = JSON.stringify({ i, pad: 'x'.repeat(200 + (i % 37)) }) + '\n'; lines.push(l); size += l.length; }
  fs.mkdirSync(path.dirname(path.join(HOME, '.gemini', ...BIG_FILE.split('/'))), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.gemini', ...BIG_FILE.split('/')), lines.join(''));
  const cline = path.join(HOME, EXT_STORAGE('saoudrizwan.claude-dev')), roo = path.join(HOME, EXT_STORAGE('rooveterinaryinc.roo-cline'));
  fs.cpSync(path.join(OUT_DIR, 'cline', 'tasks'), path.join(cline, 'tasks'), { recursive: true });
  fs.cpSync(path.join(OUT_DIR, 'roo', 'tasks'), path.join(roo, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(cline, 'settings'), { recursive: true });
  fs.writeFileSync(path.join(cline, 'settings', 'cline_mcp_settings.json'), '{"mcpServers":{"x":{"env":{"API_KEY":"FIXTURE-PRIVATE"}}}}\n');
  fs.mkdirSync(path.join(roo, 'settings'), { recursive: true });
  fs.writeFileSync(path.join(roo, 'settings', 'mcp_settings.json'), '{"mcpServers":{}}\n');
  fs.writeFileSync(path.join(HOME, 'copilot-otel', 'other.jsonl'), '{"not":"the outfile"}\n');
  fs.writeFileSync(path.join(HOME, 'copilot-otel', 'secret.json'), '{"FIXTURE-PRIVATE":1}\n');
  fs.writeFileSync(path.join(HOME, 'copilot.jsonl'), '{"resourceSpans":[]}\n');
}
// Plan 9 review (decode=zstd budget) — two --root zed folders: zed-view/threads.db where `threads` is a VIEW (→ 415) and zed-big/threads.db whose three rows
// each decode to 1 MB (→ 413 under COLLECTOR_ZSTD_BUDGET=1500000). Built with node:sqlite + zlib zstd; when this Node lacks either, both folders get a copy
// of the fixture store instead and false comes back — the collector (same Node) then answers 501 for them, which the caller asserts instead.
async function seedZedDecoys(HOME) {
  const dirs = { view: path.join(HOME, 'zed-view'), big: path.join(HOME, 'zed-big') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const sqlite = await import('node:sqlite').catch(() => null);
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function' || typeof zlib.zstdCompressSync !== 'function') {
    for (const d of Object.values(dirs)) fs.copyFileSync(path.join(OUT_DIR, 'b6', 'zed', 'threads', 'threads.db'), path.join(d, 'threads.db'));
    return false;
  }
  const cols = '(id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL, data_type TEXT NOT NULL, data BLOB NOT NULL)';
  const build = (dir, ddl, fill) => { const db = new sqlite.DatabaseSync(path.join(dir, 'threads.db')); db.exec('PRAGMA journal_mode=DELETE'); db.exec(ddl); fill(db); db.close(); };
  build(dirs.view, `CREATE TABLE real_threads${cols}; CREATE VIEW threads AS SELECT * FROM real_threads`, (db) => db.prepare('INSERT INTO real_threads VALUES (?, ?, ?, ?, ?)').run('v1', 'via view', '2026-01-01T00:00:00Z', 'json', '{}'));
  build(dirs.big, `CREATE TABLE threads${cols}`, (db) => { const ins = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)'); const frame = zlib.zstdCompressSync(Buffer.alloc(1024 * 1024, 0x20)); for (const id of ['b1', 'b2', 'b3']) ins.run(id, 'big', '2026-01-01T00:00:00Z', 'zstd', frame); });
  return true;
}

// T2 fixtures stay out of seedHome(), whose browser integration contract is three tools / nine files.
async function checkT2(add, token, skip) {
  const source = fs.readFileSync(COLLECTOR, 'utf8');
  const declaration = (name) => {
    const line = source.split('\n').find((s) => s.startsWith('const ' + name + ' = '));
    if (!line) throw new Error('missing collector declaration: ' + name);
    return line;
  };
  const limits = vm.runInNewContext(declaration('env') + '\n' + declaration('envInt')
    + '\n[envInt("COLLECTOR_WALK_CAP", 20000), envInt("COLLECTOR_ZSTD_BUDGET", 268435456), envInt("COLLECTOR_ZSTD_ROW_MAX", 67108864), envInt("LOW", 20000), envInt("BAD", 20000)]',
    { process: { env: { COLLECTOR_WALK_CAP: '20001', COLLECTOR_ZSTD_BUDGET: '268435457', COLLECTOR_ZSTD_ROW_MAX: '67108865', LOW: '3', BAD: '0' } } });
  add('collector (T2): environment limits can only lower defaults',
    JSON.stringify(limits) === '[20000,268435456,67108864,3,20000]', JSON.stringify(limits));
  const denyNames = ['hosts.json', 'apps.json', 'keys.json', 'accounts.json', 'places.sqlite', 'config.local.json', 'config.local.extra.json',
    'mcp.json', 'mcp-config.json', 'mcp_settings.json', 'cline_mcp_settings.json'];
  const denyName = vm.runInNewContext(declaration('DENY_NAME') + '\nDENY_NAME');
  const logNames = ['ui_messages.json', 'task_metadata.json', 'tokensGenerated.jsonl', '.aider.chat.history.md', 'threads.db', 'events.jsonl',
    'session-x.json', 'x.conversation.json', 'usage.jsonl', 'db.sqlite', 'messages.jsonl', 'opencode.db', 'sessions.db', 'T-x.json',
    'msg_01HZmcpQ7x.json', 'msg_mcpQ7x.json'];
  add('collector (T2): DENY_NAME independently rejects sensitive basenames and keeps log names',
    denyNames.every((name) => denyName.test(name) && denyName.test(name.toUpperCase())) && logNames.every((name) => !denyName.test(name)),
    JSON.stringify({ missed: denyNames.filter((name) => !denyName.test(name)), deniedLogs: logNames.filter((name) => denyName.test(name)) }));
  const base = path.join(HOME, 't2');
  const put = (rel, data = '{}\n') => { const file = path.join(base, ...rel.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
  const history = '.aider.chat.history.md', deep10 = Array(10).fill('d').join('/'), deep12 = deep10 + '/d/d';
  put('aider/' + history, '# root\n');
  put('aider/' + deep10 + '/' + history, '# depth 10\n');
  put('aider/' + deep12 + '/' + history, '# depth 12\n');
  put('aider/UPLOAD~1/' + history, '# short name\n');
  for (const rel of ['logs/chat/root.json', 'logs/instruct/nested/session.json', 'root.json', 'notes.md', 'logs/other/session.json']) put('tgwebui/' + rel);
  for (const name of [...denyNames, 'ui_messages.json']) put('amp/' + name);
  for (const name of ['ui_messages.json', 'task_metadata.json', 'api_conversation_history.json']) put('cline/tasks/t1/' + name);
  for (let i = 0; i < 4; i++) { put('nonmatching/file-' + i + '.txt'); fs.mkdirSync(path.join(base, 'directories', 'dir-' + i), { recursive: true }); }
  for (const root of ['first', 'second']) { put(root + '/a.txt'); put(root + '/b.txt'); put(root + '/c.json'); }
  for (const [dir, file] of [['frame', 'thread-fixture.json'], ['corrupt', 'thread-corrupt.json']])
    put('zed/' + dir + '/threads.db', fs.readFileSync(path.join(OUT_DIR, 'b6', 'zed', 'threads', file)));
  const sqlite = await import('node:sqlite').catch(() => null);
  const hasSqlite = typeof sqlite?.DatabaseSync === 'function', hasZstd = typeof zlib.zstdDecompressSync === 'function';
  const canCompress = typeof zlib.zstdCompressSync === 'function';
  const makeDb = (dir, fill) => {
    const file = path.join(base, 'zed', dir, 'threads.db'); fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!hasSqlite) { fs.copyFileSync(path.join(OUT_DIR, 'b6', 'zed', 'threads', 'threads.db'), file); return; }
    const db = new sqlite.DatabaseSync(file);
    try {
      db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT, updated_at TEXT, data_type TEXT, data BLOB); BEGIN');
      const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)');
      fill((id, type, data) => insert.run(id, '', '', type, data));
      db.exec('COMMIT');
    } finally { db.close(); }
  };
  makeDb('rows', (insert) => { for (let i = 0; i < 10001; i++) insert(String(i), 'json', '{}'); });
  makeDb('row', (insert) => insert('r', 'zstd', canCompress ? zlib.zstdCompressSync(Buffer.alloc(1025, 0x61)) : Buffer.from('28b52ffd', 'hex')));
  makeDb('unicode', (insert) => insert('u', 'json', '\u00e9'.repeat(600)));
  const codexRoot = path.join(base, 'codex', 'sessions'), linkedRollout = 'rollout-review.jsonl';
  put('codex/sessions/checkpoints/' + linkedRollout);
  put('codex/sessions/' + linkedRollout);
  put('outside/' + linkedRollout);
  for (const [name, target] of [['link', path.join(codexRoot, 'checkpoints')], ['outside-link', path.join(base, 'outside')]])
    fs.symlinkSync(target, path.join(codexRoot, name), process.platform === 'win32' ? 'junction' : 'dir');
  let child;
  try {
    const roots = ['aider', 'tgwebui', 'amp', 'cline', 'zed'].flatMap((id) => ['--root', id + '=' + path.join(base, id)]);
    child = await start([...roots, '--root', 'codex=' + codexRoot], HOME, { COLLECTOR_ZSTD_ROW_MAX: '1024' });
    add('collector (T2): isolated fixture server starts', child.port > 0, child.io());
    if (!child.port) return;
    const api = (p) => request(child.port, 'GET', p, { authorization: 'Bearer ' + token });
    const file = (tool, rel, decode = '') => api('/api/file?tool=' + tool + '&path=' + encodeURIComponent(rel) + decode);
    const list = async (tool) => {
      const response = await api('/api/list?tool=' + tool);
      if (response.status !== 200) throw new Error('list ' + tool + ': ' + response.status);
      return asJson(response).files.map((f) => f.path).sort();
    };
    const status = asJson(await api('/api/status'));
    const codexControl = await file('codex', linkedRollout);
    add('collector (R-07): an ordinary rollout under the junction-test root is served', codexControl.status === 200, String(codexControl.status));
    for (const [name, expected, error] of [['link', 404, 'file not found'], ['outside-link', 400, 'path resolves outside the tool folder (symbolic link)']]) {
      const response = await file('codex', name + '/' + linkedRollout);
      add('collector (R-07): post-realpath re-check rejects ' + name,
        fs.lstatSync(path.join(codexRoot, name, linkedRollout)).isFile() && response.status === expected && asJson(response)?.error === error,
        response.status + ' ' + response.body.toString());
    }
    const aider = await list('aider');
    add('collector (T2): depth 10 is readable and depth 12 is not descended',
      JSON.stringify(aider) === JSON.stringify([history, deep10 + '/' + history].sort()) && status.tools.find((t) => t.id === 'aider').capped === true,
      JSON.stringify(aider));
    const short = await file('aider', 'UPLOAD~1/' + history);
    add('collector (T2): UPLOAD~1 is absent from listings and refused by file requests',
      aider.includes(history) && !aider.some((p) => p.includes('UPLOAD~1')) && short.status === 404, JSON.stringify({ aider, status: short.status }));
    const tgPaths = await list('tgwebui'), tgGood = ['logs/chat/root.json', 'logs/instruct/nested/session.json'];
    const tgYes = await Promise.all(tgGood.map((p) => file('tgwebui', p)));
    const tgNo = await Promise.all(['root.json', 'notes.md', 'logs/other/session.json'].map((p) => file('tgwebui', p)));
    add('collector (T2): tgwebui serves only chat and instruct JSON logs',
      JSON.stringify(tgPaths) === JSON.stringify(tgGood) && tgYes.every((r) => r.status === 200) && tgNo.every((r) => r.status === 404), JSON.stringify(tgPaths));
    const taskPaths = await list('cline'), conversation = await file('cline', 'tasks/t1/api_conversation_history.json'), ui = await file('cline', 'tasks/t1/ui_messages.json');
    add('collector (T2): Cline omits conversation history and still serves ui_messages',
      JSON.stringify(taskPaths) === '["tasks/t1/task_metadata.json","tasks/t1/ui_messages.json"]' && conversation.status === 404 && ui.status === 200, JSON.stringify(taskPaths));
    const denied = await Promise.all(denyNames.map((name) => file('amp', name))), allowed = await file('amp', 'ui_messages.json'), amp = await list('amp');
    add('collector (T2): sensitive filenames return 404 under a served root',
      denied.every((r) => r.status === 404) && allowed.status === 200 && JSON.stringify(amp) === '["ui_messages.json"]', JSON.stringify(denied.map((r) => r.status)));
    const frame = await file('zed', 'frame/threads.db', '&decode=zstd'), corrupt = await file('zed', 'corrupt/threads.db', '&decode=zstd');
    add(hasZstd ? 'collector (T2): raw threads.db frame decodes byte-exact' : 'collector (T2): raw frame returns 501 without zstd',
      hasZstd ? frame.status === 200 && frame.body.equals(fs.readFileSync(path.join(OUT_DIR, 'b6', 'zed', 'thread-fixture.plain.json'))) : frame.status === 501, String(frame.status));
    add(hasZstd ? 'collector (T2): corrupt threads.db frame returns 422 and server survives' : 'collector (T2): corrupt frame returns 501 without zstd and server survives',
      corrupt.status === (hasZstd ? 422 : 501) && (await api('/api/status')).status === 200 && child.exited === null, String(corrupt.status));
    const rows = await file('zed', 'rows/threads.db', '&decode=zstd'), row = await file('zed', 'row/threads.db', '&decode=zstd');
    add(hasSqlite ? 'collector (T2): 10001 thread rows return 413' : 'collector (T2): row-count fixture returns 501 without SQLite',
      hasSqlite ? rows.status === 413 && /10000 thread rows/.test(asJson(rows)?.error || '') : rows.status === 501, rows.body.toString().slice(0, 200));
    add(hasSqlite && canCompress && hasZstd ? 'collector (T2): a row over the lowered per-row cap returns 413' : 'collector (T2): per-row fixture returns 501 without SQLite or zstd',
      hasSqlite && canCompress && hasZstd ? row.status === 413 && /1024 bytes/.test(asJson(row)?.error || '') : row.status === 501, row.body.toString().slice(0, 200));
    await child.stop();
    child = await start(['--root', 'aider=' + path.join(base, 'nonmatching'), '--root', 'tgwebui=' + path.join(base, 'directories'),
      '--root', 'amp=' + path.join(base, 'first'), '--root', 'amp=' + path.join(base, 'second'), '--root', 'zed=' + path.join(base, 'zed')],
      HOME, { COLLECTOR_WALK_CAP: '3', COLLECTOR_ZSTD_BUDGET: '1000' });
    add('collector (T2): lowered-limit fixture server starts', child.port > 0, child.io());
    if (!child.port) return;
    const capped = asJson(await api('/api/status'));
    for (const [id, kind] of [['aider', 'nonmatching files'], ['tgwebui', 'directories']]) {
      const tool = capped.tools.find((t) => t.id === id), paths = await list(id);
      add('collector (T2): walk cap counts ' + kind,
        tool.found === true && tool.capped === true && tool.files === 0 && paths.length === 0, JSON.stringify(tool));
    }
    const shared = capped.tools.find((t) => t.id === 'amp'), sharedPaths = await list('amp');
    add('collector (T2): visited-entry budget is shared across roots',
      shared.capped === true && shared.files === 1 && JSON.stringify(sharedPaths) === '["first/c.json"]', JSON.stringify(sharedPaths));
    const unicode = await file('zed', 'unicode/threads.db', '&decode=zstd');
    add(hasSqlite ? 'collector (T2): total decode budget counts UTF-8 bytes' : 'collector (T2): UTF-8 fixture returns 501 without SQLite',
      hasSqlite ? unicode.status === 413 && /1000 bytes/.test(asJson(unicode)?.error || '') : unicode.status === 501, unicode.body.toString().slice(0, 200));
    const shortHomeTest = 'collector (R-01): short HOME is refused like long HOME';
    if (process.platform !== 'win32') skip(shortHomeTest, 'Windows 8.3 names require win32');
    else {
      const lookup = spawnSync('cmd.exe', ['/d', '/c', 'for %I in ("' + HOME + '") do @echo %~sI'],
        { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 10000 });
      if (lookup.error || lookup.status !== 0 || !lookup.stdout.trim()) throw new Error('short HOME lookup failed: ' + (lookup.error || lookup.stderr));
      const shortHome = lookup.stdout.trim();
      if (path.resolve(shortHome).toLowerCase() === path.resolve(HOME).toLowerCase()) skip(shortHomeTest, 'temp HOME has no distinct 8.3 spelling on this volume');
      else {
        if (fs.realpathSync.native(shortHome).toLowerCase() !== fs.realpathSync.native(HOME).toLowerCase()) throw new Error('short HOME does not resolve to temp HOME');
        await child.stop();
        child = await start(['--root', 'amp=' + HOME, '--root', 'amp=' + shortHome], HOME, { COLLECTOR_WALK_CAP: '3' });
        add('collector (R-01): short HOME fixture server starts', child.port > 0, child.io());
        if (!child.port) return;
        const ampHome = asJson(await api('/api/status')).tools.find((tool) => tool.id === 'amp');
        const refused = ampHome.refused || [], homeList = await api('/api/list?tool=amp');
        add(shortHomeTest, ampHome.found === false && ampHome.files === 0 && ampHome.roots.length === 0 && homeList.status === 404
          && refused.length === 2 && [HOME, shortHome].every((dir) => refused.some((r) => r.dir === dir && r.reason === 'is the home folder')),
          JSON.stringify({ ampHome, list: homeList.status }));
      }
    }
  } finally { if (child) await child.stop(); }
}

export async function run() {
  const results = [], skipped = [];
  const add = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail) });
  const skip = (name, reason) => { skipped.push({ name, reason }); console.log(`SKIP  ${name}  — ${reason}`); };
  const summary = () => ({ pass: results.every((r) => r.pass), detail: results.filter((r) => !r.pass).map((r) => r.name + ': ' + r.detail).join(' | '), results, skipped });
  if (!fs.existsSync(path.join(OUT_DIR, 'codex', 'sessions'))) { const { generate } = await import('../fixtures/gen.mjs'); await generate(); }   // standalone run before the suite ever generated fixtures
  seedHome();
  seedWave3();
  seedB6();
  seedReviewFixtures();
  const zedDecoys = await seedZedDecoys(HOME);
  let a = null, b = null, c = null;
  const HOME_CW = path.join(OUT_DIR, `collector-cowork-${process.pid}`);   // B1 block: its own HOME (APPDATA / LOCALAPPDATA point at it too — see start())
  try {
    // ---------------------------------------------------------------- default discovery ----------------------------------------------------------------
    a = await start([], HOME, { COPILOT_OTEL_FILE_EXPORTER_PATH: path.join(HOME, 'copilot-otel', OTEL_FILE) });
    const tokenFile = path.join(HOME, '.ai-usage', 'collector.token');
    const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
    const urlTok = (/\?token=([0-9a-f]+)/.exec(a.out) || [])[1] || '';
    add('collector: starts, prints "listening on http://127.0.0.1:<port>" and the ready URL; ~/.ai-usage/collector.token holds the same 64-hex token',
      a.port > 0 && /^[0-9a-f]{64}$/.test(token) && urlTok === token && a.out.includes(`http://127.0.0.1:${a.port}/?token=${token}`), a.io());
    if (!a.port) return summary();
    const banner = a.out.slice(0, a.out.indexOf('listening on'));
    add('collector: the startup banner lists per-tool file counts, the watch mode and the walk time (codex: "5 files", "watch fs|polling", "walk N ms") before "listening on"',
      /^\s*codex\b[^\n]*\b5 files\b[^\n]*\bwatch (fs|polling)\b[^\n]*\bwalk \d+ ms\b/m.test(banner) && /^\s*local\b[^\n]*\b2 files\b/m.test(banner), banner.replace(/\s+/g, ' ').slice(0, 1200));
    const auth = { authorization: 'Bearer ' + token };
    const API = (p, opts) => request(a.port, 'GET', p, opts === false ? {} : { ...auth, ...(opts || {}) });

    const badRequest = await rawBadRequest(a.port).catch((e) => String(e));
    const afterBad = await API('/api/status').catch((e) => ({ status: e.code || e.message }));
    add('collector (T2): malformed request returns 400 JSON and the same server survives',
      /^HTTP\/1\.1 400\b/.test(badRequest) && badRequest.includes('{"error":"bad request"}')
        && a.exited === null && afterBad.status === 200,
      JSON.stringify({ badRequest, next: afterBad.status, exited: a.exited }));
    for (const target of ['//127.0.0.1/api/status', 'http://127.0.0.1/api/status']) {
      const response = await rawGet(a.port, target, auth, async () => {});
      const after = await API('/api/status');
      add('collector (R-03): non-origin request target is refused: ' + target,
        /^HTTP\/1\.1 400\b/.test(response.head) && response.body.toString() === '{"error":"bad request"}'
          && after.status === 200 && a.exited === null,
        JSON.stringify({ head: response.head, body: response.body.toString(), next: after.status, exited: a.exited }));
    }
    const noTok = await API('/api/status', false);
    const badTok = await request(a.port, 'GET', '/api/status', { authorization: 'Bearer ' + 'f'.repeat(64) });
    const qTok = await request(a.port, 'GET', '/api/status?token=' + token);
    add('collector: /api/* without a token → 401 JSON (with CORS headers); a wrong token → 401; ?token= on /api/* → 401 too — the token is accepted in the Authorization header only (A0 #18: a URL token leaks into history / logs; the page sends the header)',
      noTok.status === 401 && isJsonCT(noTok) && asJson(noTok) && asJson(noTok).error && corsOk(noTok) && badTok.status === 401 && qTok.status === 401 && !/\?token=/.test(asJson(noTok).hint || ''),
      `no token ${noTok.status} ${noTok.body.toString().slice(0, 200)} · wrong ${badTok.status} · ?token= ${qTok.status}`);
    // review m1: the request log echoes tool / path / refresh — an unauthenticated request must not be able to forge a log line through them
    await API('/api/file?tool=codex&path=' + encodeURIComponent('\nINJECTED 200 0\n'), false);
    await sleep(150);
    const injLines = a.out.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.includes('INJECTED'));
    add('collector (review m1): control characters in a logged query value become "?" — an unauthenticated GET with path=%0AINJECTED%20200%200%0A yields ONE stdout line "GET /api/file?tool=codex&path=?INJECTED 200 0? 401 <bytes>" (no forged line, no raw newline before the status)',
      injLines.length === 1 && /^\d\d:\d\d:\d\d GET \/api\/file\?tool=codex&path=\?INJECTED 200 0\? 401 \d+$/.test(injLines[0]) && !a.out.split('\n').some((l) => /^INJECTED/.test(l)),
      JSON.stringify(injLines));

    const st = await API('/api/status');
    const sj = asJson(st) || {};
    const toolOf = (j, id) => ((j || {}).tools || []).find((t) => t.id === id) || {};
    const tool = (id) => toolOf(sj, id);
    const found = (id, n, nRoots = 1) => tool(id).found === true && tool(id).files === n && Array.isArray(tool(id).roots) && tool(id).roots.length === nRoots && typeof tool(id).bytes === 'number' && tool(id).bytes > 0 && typeof tool(id).newestMtime === 'number' && typeof tool(id).scannedAt === 'number';
    add('collector: /api/status → local (2 files — CLAUDE.md, projects/…/memory/notes.md, settings.local.json beside them never counted), codex (5), copilot-cli (2 — mcp-config.json never counted), gemini-cli (1: the session-*.json; tmp/not-a-session.jsonl never counted), cline (7 task files; settings/cline_mcp_settings.json never counted) found under the temp HOME — node_modules / checkpoints skipped; version/home/os/startedAt present',
      st.status === 200 && isJsonCT(st) && found('local', 2) && found('codex', 5, 2) && found('copilot-cli', 2) && found('gemini-cli', 1) && found('cline', 7)
        && path.resolve(tool('local').roots[0]) === path.join(HOME, '.claude')
        && typeof sj.version === 'string' && path.resolve(sj.home || '') === HOME && typeof sj.os === 'string' && !Number.isNaN(Date.parse(sj.startedAt)),
      st.body.toString().slice(0, 1500));
    const codexRoots = (tool('codex').roots || []).map((r) => path.resolve(r));
    const watchOk = (id) => ['fs', 'polling'].includes(tool(id).watch) && typeof tool(id).walkMs === 'number' && tool(id).walkMs >= 0;
    add('collector: codex roots are exactly ~/.codex/sessions + ~/.codex/archived_sessions (no other ~/.codex subfolder — cache/, config.toml never counted); every found tool reports watch ∈ {fs, polling} and a numeric walkMs',
      codexRoots.length === 2 && codexRoots.includes(path.join(HOME, '.codex', 'sessions')) && codexRoots.includes(path.join(HOME, '.codex', 'archived_sessions')) && codexRoots.every((r) => /[\\/](sessions|archived_sessions)$/.test(r))
        && ['local', 'codex', 'copilot-cli', 'gemini-cli'].every(watchOk),
      JSON.stringify({ codex: tool('codex'), local: { watch: tool('local').watch, walkMs: tool('local').walkMs } }).slice(0, 800));
    const ids = (sj.tools || []).map((t) => t.id);
    add('collector: status names every registry folder connector by its id (local, codex, copilot-cli, gemini-cli, continue, cline, roo, junie, lmstudio, ollama, jan + Plan 9 B5 opencode, goose, devin, kilo, amp + Plan 9 B6 zed, copilot-vscode) plus aider / tgwebui as --root-only',
      ['local', 'codex', 'copilot-cli', 'gemini-cli', 'continue', 'cline', 'roo', 'junie', 'lmstudio', 'ollama', 'jan', 'opencode', 'goose', 'devin', 'kilo', 'amp', 'zed', 'copilot-vscode', 'aider', 'tgwebui'].every((id) => ids.includes(id)), ids.join(','));
    // ---------------------------------------------------------------- Plan 9 B5: Wave 3 coding tools (seedWave3) ----------------------------------------------------------------
    const w3 = (id) => tool(id);
    const w3Roots = (id) => (w3(id).roots || []).map((r) => path.resolve(r));
    add('collector (B5): /api/status → opencode (3 files: opencode.db + the two legacy msg_*.json; snapshot/ git objects never walked), goose (1), devin (1), kilo (4 — two tasks) and amp (3 threads; history.jsonl / session.json beside threads/ never listed) found under their standard roots; roo found under its OWN root rooveterinaryinc.roo-cline with 2 task files (kilocode.kilo-code is kilo\'s root now, not roo\'s; roo\'s settings/mcp_settings.json never counted)',
      found('opencode', 3) && w3Roots('opencode')[0] === path.join(HOME, '.local', 'share', 'opencode')
        && found('goose', 1) && w3Roots('goose')[0] === path.join(HOME, 'Block', 'goose', 'sessions')
        && found('devin', 1) && w3Roots('devin')[0] === path.join(HOME, 'devin', 'cli')
        && found('kilo', 4) && w3Roots('kilo')[0] === path.join(HOME, 'Code', 'User', 'globalStorage', 'kilocode.kilo-code')
        && found('amp', 3) && w3Roots('amp')[0] === path.join(HOME, '.local', 'share', 'amp', 'threads')
        && found('roo', 2) && w3Roots('roo')[0] === path.join(HOME, EXT_STORAGE('rooveterinaryinc.roo-cline')),
      JSON.stringify(['opencode', 'goose', 'devin', 'kilo', 'amp', 'roo'].map((id) => [id, w3(id).found, w3(id).files, w3(id).roots])));
    const w3List = async (id) => ((asJson(await API('/api/list?tool=' + id)) || {}).files || []).map((f) => f.path).sort();
    const ocPaths = await w3List('opencode'), ampPaths = await w3List('amp'), kiloPaths = await w3List('kilo'), gooseList = await w3List('goose'), devinList = await w3List('devin');
    add('collector (B5): /api/list → opencode ["opencode.db", "storage/message/ses_s1/msg_a1.json", …] (.db passes the extension allow-list; nothing under snapshot/), goose ["sessions.db"], devin ["sessions.db"], kilo tasks/<id>/{ui_messages,task_metadata}.json, amp ["T-abc.json","T-bad.json","T-nol.json"] — no history.jsonl, no session.json',
      JSON.stringify(ocPaths) === JSON.stringify(['opencode.db', 'storage/message/ses_s1/msg_a1.json', 'storage/message/ses_s2/msg_a7.json']) && JSON.stringify(gooseList) === '["sessions.db"]' && JSON.stringify(devinList) === '["sessions.db"]'
        && kiloPaths.length === 4 && kiloPaths.every((p) => /^tasks\/1786353[01]00000\/(ui_messages|task_metadata)\.json$/.test(p))
        && JSON.stringify(ampPaths) === JSON.stringify(['T-abc.json', 'T-bad.json', 'T-nol.json']),
      JSON.stringify({ ocPaths, gooseList, devinList, kiloPaths, ampPaths }));
    const gooseWant = fs.readFileSync(path.join(HOME, 'Block', 'goose', 'sessions', 'sessions.db'));
    const gooseGet = await API('/api/file?tool=goose&path=sessions.db');
    const snapGet = await API('/api/file?tool=opencode&path=' + encodeURIComponent('snapshot/prj_1/objects/ab/cdef.json'));
    const histGet = await API('/api/file?tool=amp&path=history.jsonl');
    add('collector (B5): /api/file streams a SQLite store byte-exact (goose sessions.db, binary, SQLite header intact); a file under opencode\'s snapshot/ and amp\'s history.jsonl (outside the threads/ root) answer 404',
      gooseGet.status === 200 && gooseGet.body.equals(gooseWant) && gooseWant.subarray(0, 15).toString('latin1') === 'SQLite format 3' && snapGet.status === 404 && histGet.status === 404,
      `goose ${gooseGet.status} ${gooseGet.body.length}/${gooseWant.length} bytes · snapshot ${snapGet.status} · history ${histGet.status}`);

    // ---------------------------------------------------------------- Plan 9 B6: Zed (decode=zstd) + GitHub Copilot Chat OTel outfile (seedB6) ----------------------------------------------------------------
    const zedRoot = path.join(HOME, 'Zed', 'threads');
    add('collector (B6): /api/status → zed found under %LOCALAPPDATA%\\Zed\\threads (1 file: threads.db — the thread-fixture.json / thread-corrupt.json frames beside it are not Zed log files, so the include glob keeps them out) and copilot-vscode found under the folder of COPILOT_OTEL_FILE_EXPORTER_PATH (1 file) — the OTel outfile has no fixed location, so the env var (or --root) is the only discovery',
      found('zed', 1) && path.resolve(w3Roots('zed')[0]) === zedRoot && found('copilot-vscode', 1) && path.resolve(w3Roots('copilot-vscode')[0]) === path.join(HOME, 'copilot-otel'),
      JSON.stringify(['zed', 'copilot-vscode'].map((id) => [id, w3(id).found, w3(id).files, w3(id).roots, w3(id).candidates])));
    const zedList = await w3List('zed'), otelList = await w3List('copilot-vscode');
    const otelOther = await API('/api/file?tool=copilot-vscode&path=other.jsonl'), otelSecret = await API('/api/file?tool=copilot-vscode&path=secret.json');
    add('collector (review, single-file root): /api/list → zed ["threads.db"] only; copilot-vscode ["copilot-chat.jsonl"] only — its root is the folder of COPILOT_OTEL_FILE_EXPORTER_PATH but ONLY that file is listed or served: the siblings other.jsonl (would pass the include glob) and secret.json answer 404 "file not found"',
      JSON.stringify(zedList) === '["threads.db"]' && JSON.stringify(otelList) === JSON.stringify([OTEL_FILE]) && otelOther.status === 404 && /file not found/.test(otelOther.body.toString()) && otelSecret.status === 404 && !otelSecret.body.includes('FIXTURE-PRIVATE'),
      JSON.stringify({ zedList, otelList, other: otelOther.status, secret: otelSecret.status }));
    const rawFrame = await API('/api/file?tool=zed&path=thread-fixture.json');
    const decodedFrame = await API('/api/file?tool=zed&path=thread-fixture.json&decode=zstd');
    const corrupt = await API('/api/file?tool=zed&path=thread-corrupt.json&decode=zstd');
    add('collector (review, include globs): the zstd frames beside threads.db (thread-fixture.json, thread-corrupt.json — .json passes the extension allow-list) are not Zed log files: GET /api/file answers 404 JSON for them with and without decode=zstd (these filenames fail the include glob; a raw frame named threads.db is tested separately)',
      rawFrame.status === 404 && decodedFrame.status === 404 && corrupt.status === 404 && [rawFrame, decodedFrame, corrupt].every(isJsonCT),
      [rawFrame, decodedFrame, corrupt].map((r) => r.status).join(','));
    const otherTool = await API('/api/file?tool=codex&path=' + encodeURIComponent(CODEX_FILE) + '&decode=zstd');
    const otherCodec = await API('/api/file?tool=zed&path=threads.db&decode=gzip');
    add('collector (B6): decode=zstd on a non-Zed tool (codex) → 400 JSON "only for zed"; decode=gzip → 400 JSON (the only accepted value is zstd)',
      otherTool.status === 400 && isJsonCT(otherTool) && /zed/i.test((asJson(otherTool) || {}).error || '') && otherCodec.status === 400 && isJsonCT(otherCodec) && /zstd/.test((asJson(otherCodec) || {}).error || ''),
      `codex ${otherTool.status} ${otherTool.body.toString().slice(0, 120)} · gzip ${otherCodec.status} ${otherCodec.body.toString().slice(0, 120)}`);
    // threads.db: the Zed store is SQLite with one zstd frame per thread row — decode=zstd there means "every row decoded", answered as JSON lines (the page parses them like the
    // raw store). The collector needs node:sqlite for it (Node ≥ 22.13); where this Node lacks it the documented answer is 501 with the Node hint — asserted as such, never skipped.
    const sqliteHere = await import('node:sqlite').then((m) => typeof m.DatabaseSync === 'function').catch(() => false);
    const dbWant = fs.readFileSync(path.join(zedRoot, 'threads.db'));
    const dbRaw = await API('/api/file?tool=zed&path=threads.db');
    const dbDecoded = await API('/api/file?tool=zed&path=threads.db&decode=zstd');
    const expectLines = fs.readFileSync(path.join(OUT_DIR, 'b6', 'zed', 'decoded-threads.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const gotLines = dbDecoded.status === 200 ? dbDecoded.body.toString('utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }) : [];
    const sameRow = (g, e) => !!g && g.id === e.id && g.summary === e.summary && String(g.updated_at) === String(e.updated_at) && (e.error ? typeof g.error === 'string' && /zstd/i.test(g.error) && g.data === undefined : g.data_type === 'json' && JSON.stringify(JSON.parse(g.data)) === JSON.stringify(JSON.parse(e.data)));
    add(sqliteHere
      ? 'collector (B6): /api/file?tool=zed&path=threads.db streams the SQLite store byte-exact; …&decode=zstd (node:sqlite present in this Node) answers one JSON line per thread row — t1 / t2 / t3 / t5 with data_type "json" and the decoded thread JSON (t3 was plain json already), t4 as an {error} line naming zstd (no data) — matching tests/fixtures/out/b6/zed/decoded-threads.jsonl; ndjson content type'
      : 'collector (B6): /api/file?tool=zed&path=threads.db streams the SQLite store byte-exact; …&decode=zstd on it answers 501 JSON naming node:sqlite / Node 22.13 (this Node has no node:sqlite — the documented answer, asserted, not skipped)',
      dbRaw.status === 200 && dbRaw.body.equals(dbWant) && (sqliteHere
        ? dbDecoded.status === 200 && /ndjson/i.test(dbDecoded.headers['content-type'] || '') && gotLines.length === expectLines.length && expectLines.every((e, i) => sameRow(gotLines[i], e))
        : dbDecoded.status === 501 && isJsonCT(dbDecoded) && /node:sqlite/.test((asJson(dbDecoded) || {}).error || '') && /22\.13/.test(dbDecoded.body.toString())),
      `raw ${dbRaw.status} ${dbRaw.body.length}/${dbWant.length} · decoded ${dbDecoded.status} ct=${dbDecoded.headers['content-type']} lines=${gotLines.length}/${expectLines.length} ${dbDecoded.body.toString().slice(0, 200)}`);
    await sleep(150);
    const decodeLog = a.out.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => /decode=/.test(l));
    add('collector (B6): the request log echoes decode=zstd beside tool / path (sanitised like them) — one line per decode request, never the body, never the token (the banner\'s ready URL is the only place the token is printed)',
      decodeLog.some((l) => /GET \/api\/file\?tool=zed&path=threads\.db&decode=zstd (200|501) \d+$/.test(l)) && decodeLog.length >= 5 && decodeLog.every((l) => !l.includes(token) && !/"data"|SQLite format/.test(l)), decodeLog.join(' | ').slice(0, 400));

    const ls = await API('/api/list?tool=codex');
    const lj = asJson(ls) || {};
    const files = lj.files || [];
    const paths = files.map((f) => f.path).sort();
    const sizesOk = files.every((f) => { const st2 = fs.statSync(path.join(HOME, '.codex', ...f.path.split('/'))); return f.size === st2.size && Math.abs(f.mtime - st2.mtimeMs) < 2; });
    add('collector: /api/list?tool=codex → the 4 rollouts as "sessions/…" plus the archived one as "archived_sessions/…" (root-folder prefixes, forward slashes, relative) with size + mtime; root = the sessions dir, roots = both',
      ls.status === 200 && lj.tool === 'codex' && path.resolve(lj.root || '') === path.join(HOME, '.codex', 'sessions') && (lj.roots || []).length === 2 && JSON.stringify(paths) === JSON.stringify(CODEX_PATHS) && sizesOk && !files.some((f) => f.path.includes('\\') || path.isAbsolute(f.path)),
      ls.body.toString().slice(0, 800));

    const want = fs.readFileSync(path.join(HOME, '.codex', ...CODEX_FILE.split('/')));
    const ff = await API('/api/file?tool=codex&path=' + encodeURIComponent(CODEX_FILE));
    const fa = await API('/api/file?tool=codex&path=' + encodeURIComponent(CODEX_ARCHIVED));
    add('collector: /api/file streams the rollout byte-exact with Content-Length + Last-Modified — the "sessions/…" and the "archived_sessions/…" path alike',
      ff.status === 200 && ff.body.equals(want) && +ff.headers['content-length'] === want.length && !Number.isNaN(Date.parse(ff.headers['last-modified'] || '')) && corsOk(ff) && fa.status === 200 && fa.body.equals(want),
      `status ${ff.status} · ${ff.body.length}/${want.length} bytes · cl=${ff.headers['content-length']} lm=${ff.headers['last-modified']} · archived ${fa.status} ${fa.body.length}`);
    // review M2: ollama's first root IS ~/.ai-usage (the token dir the collector creates itself), so a plain relative path reaches the token file
    const tokViaOllama = await API('/api/file?tool=ollama&path=collector.token');
    const tokViaOllamaUpper = await API('/api/file?tool=ollama&path=COLLECTOR.TOKEN');
    const ollamaList = asJson(await API('/api/list?tool=ollama')) || {};
    add('collector (review M2): the token file is never served — GET /api/file?tool=ollama&path=collector.token → 404 JSON without the token (ollama is found with root ~/.ai-usage; the upper-case spelling answers 404 too), and /api/list?tool=ollama does not list it',
      tool('ollama').found === true && (tool('ollama').roots || []).some((r) => /\.ai-usage$/.test(r)) && tokViaOllama.status === 404 && isJsonCT(tokViaOllama) && !tokViaOllama.body.includes(token)
        && tokViaOllamaUpper.status === 404 && !tokViaOllamaUpper.body.includes(token) && !(ollamaList.files || []).some((f) => /collector\.token$/i.test(f.path)),
      `status ${tokViaOllama.status}/${tokViaOllamaUpper.status} · body ${tokViaOllama.body.toString().slice(0, 120)} · ollama found=${tool('ollama').found} roots=${JSON.stringify(tool('ollama').roots)} list=${JSON.stringify((ollamaList.files || []).map((f) => f.path))}`);

    // A0 #17: an extension allow-list (.jsonl .json .md .sqlite .db .csv .txt) and a credential-name deny-list apply to the listing AND to /api/file.
    // Plan 9 review: so do the per-tool include globs — a file that passes both lists but is not that tool's log (CLAUDE.md, memory/notes.md, a non-session
    // .jsonl under ~/.gemini) answers exactly like a missing file; settings.local.json and the MCP settings files are also on the wider deny-list.
    const listOf = async (id) => ((asJson(await API('/api/list?tool=' + id)) || {}).files || []).map((f) => f.path);
    const lsLocal = await listOf('local'), lsGem = await listOf('gemini-cli'), lsCodex = await listOf('codex'), lsCop = await listOf('copilot-cli'), lsCline = await listOf('cline'), lsRoo = await listOf('roo');
    const ROOT_OF = { local: '.claude', 'gemini-cli': '.gemini', codex: '.codex', 'copilot-cli': '.copilot', cline: EXT_STORAGE('saoudrizwan.claude-dev'), roo: EXT_STORAGE('rooveterinaryinc.roo-cline') };
    const deniedFiles = [['local', '.credentials.json'], ['local', 'settings.json'], ['gemini-cli', 'oauth_creds.json'], ['gemini-cli', 'settings.json'], ['gemini-cli', '.env'], ['codex', 'sessions/notes.yaml'],
      ['local', 'CLAUDE.md'], ['local', 'projects/-D--proj1/memory/notes.md'], ['local', 'settings.local.json'], ['gemini-cli', 'tmp/not-a-session.jsonl'], ['copilot-cli', 'mcp-config.json'], ['cline', 'settings/cline_mcp_settings.json'], ['roo', 'settings/mcp_settings.json']];
    const missingRef = await API('/api/file?tool=local&path=' + encodeURIComponent('projects/-D--proj1/nope.jsonl'));
    const denied = await Promise.all(deniedFiles.map(async ([t, p]) => { const r = await API(`/api/file?tool=${t}&path=${encodeURIComponent(p)}`); return [t + ':' + p, r.status, r.body.toString()]; }));
    add('collector (A0 #17 + review allow-list): credential-named files under the roots (~/.claude/.credentials.json + settings.json, ~/.gemini/oauth_creds.json + settings.json + .env), a file outside the extension allow-list (sessions/notes.yaml), and files that pass both lists but are not the tool\'s logs (~/.claude/CLAUDE.md, projects/…/memory/notes.md, settings.local.json, ~/.gemini/tmp/not-a-session.jsonl, ~/.copilot/mcp-config.json, cline settings/cline_mcp_settings.json, roo settings/mcp_settings.json) are neither listed nor served — the 404 body is byte-identical to a missing file\'s; the logs beside them still are (local 2, gemini 1, codex 5, copilot-cli 2, cline 7 tasks/*/{ui_messages,task_metadata}.json, roo 2)',
      deniedFiles.every(([t, p]) => fs.existsSync(path.join(HOME, ...ROOT_OF[t].split('/'), ...p.split('/'))))
        && !lsLocal.some((p) => /credentials|settings|\.md$/.test(p)) && lsLocal.length === 2 && !lsGem.some((p) => /oauth|settings|\.env|not-a-session/.test(p)) && lsGem.length === 1 && !lsCodex.some((p) => /\.yaml$/.test(p)) && lsCodex.length === 5
        && !lsCop.some((p) => /mcp/.test(p)) && lsCop.length === 2 && lsCline.length === 7 && lsCline.every((p) => /^tasks\/\d+\/(ui_messages|task_metadata)\.json$/.test(p)) && lsRoo.length === 2 && lsRoo.every((p) => /^tasks\/\d+\/(ui_messages|task_metadata)\.json$/.test(p))
        && missingRef.status === 404 && denied.every(([, s, body]) => s === 404 && body === missingRef.body.toString()),
      JSON.stringify({ denied: denied.map(([k, s]) => k + '=' + s), local: lsLocal, gem: lsGem, cop: lsCop, cline: lsCline, roo: lsRoo, codexYaml: lsCodex.filter((p) => /yaml/.test(p)) }));
    const trav = await API('/api/file?tool=codex&path=' + encodeURIComponent('../.ai-usage/collector.token'));
    const abs = await API('/api/file?tool=codex&path=' + encodeURIComponent(tokenFile));
    const slash = await API('/api/file?tool=codex&path=' + encodeURIComponent('/etc/passwd'));
    const inner = await API('/api/file?tool=codex&path=' + encodeURIComponent('sessions/../../.ai-usage/collector.token'));
    const bs = await API('/api/file?tool=codex&path=' + encodeURIComponent('sessions\\..\\..\\.ai-usage\\collector.token'));
    const sibling = await API('/api/file?tool=codex&path=' + encodeURIComponent('cache/junk.txt'));   // inside ~/.codex but under no root
    const all400 = [trav, abs, slash, inner, bs].every((r) => r.status === 400 && isJsonCT(r) && !r.body.includes(token));
    add('collector: traversal guard — "../x", an absolute path, "/x", "a/../../x" and a backslash variant → 400 JSON, the token file never leaks, and a ~/.codex file outside sessions/ + archived_sessions/ is not served',
      all400 && sibling.status === 404 && !sibling.body.includes('not a session'), [trav, abs, slash, inner, bs, sibling].map((r) => r.status).join(','));
    // Case-insensitive skipped-folder matching is checked before realpath; a legitimate case variant still lands on Windows.
    // checkT2's existing UPLOAD~1 directory and valid history filename isolate the short-name rule.
    const caseSkip = await API('/api/file?tool=codex&path=' + encodeURIComponent(CKPT_ROLLOUT.replace('checkpoints', 'CHECKPOINTS')));
    const caseFile = await API('/api/file?tool=codex&path=' + encodeURIComponent('sessions/' + CODEX_FILE.slice('sessions/'.length).toUpperCase()));
    add('collector (review case folding): CHECKPOINTS is refused and a real rollout case variant streams on Windows',
      caseSkip.status === 404 && /file not found/.test(caseSkip.body.toString()) && !caseSkip.body.includes('session_meta')
        && (process.platform === 'win32' ? caseFile.status === 200 && caseFile.body.equals(want) : caseFile.status === 404),
      [caseSkip, caseFile].map((r) => r.status).join(',') + ' · ' + caseSkip.body.toString().slice(0, 80));
    const missing = await API('/api/file?tool=codex&path=' + encodeURIComponent('sessions/2026/08/10/nope.jsonl'));
    const unknownTool = await API('/api/list?tool=nope');
    const notFoundTool = await API('/api/list?tool=lmstudio');
    const dirReq = await API('/api/file?tool=codex&path=' + encodeURIComponent('sessions/2026'));
    const rootReq = await API('/api/file?tool=codex&path=sessions');
    add('collector: a missing file → 404 JSON; an unknown tool id → 404; a tool whose folder does not exist → 404; a directory path → 404; a path that only names a root → 400',
      missing.status === 404 && isJsonCT(missing) && unknownTool.status === 404 && notFoundTool.status === 404 && dirReq.status === 404 && rootReq.status === 400,
      [missing, unknownTool, notFoundTool, dirReq, rootReq].map((r) => r.status).join(','));

    const opt = await request(a.port, 'OPTIONS', '/api/status', { origin: 'null', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization', 'access-control-request-private-network': 'true' });
    add('collector: OPTIONS → 204 with Access-Control-Allow-Origin: *, Allow-Headers: Authorization, Allow-Private-Network: true (no token needed)',
      opt.status === 204 && corsOk(opt) && corsOk(st), `status ${opt.status} · ${JSON.stringify(opt.headers)}`);

    const page = await request(a.port, 'GET', '/');
    add('collector: GET / → 200 text/html serving AI Usage Dashboard.html (contains "<title>ROSTUM - AI Usage")',
      page.status === 200 && /^text\/html/i.test(page.headers['content-type'] || '') && page.body.toString('utf8').includes('<title>ROSTUM - AI Usage'),
      `status ${page.status} ct=${page.headers['content-type']} ${page.body.length} bytes`);
    // review m7: hardening headers on every answer; Host allow-list (DNS rebinding: a name resolving to 127.0.0.1 must reach neither the API nor the page)
    const hardened = (r) => r.headers['x-frame-options'] === 'DENY' && r.headers['x-content-type-options'] === 'nosniff';
    const evil = await request(a.port, 'GET', '/api/status', { ...auth, host: 'evil.test' });
    const evilPort = await request(a.port, 'GET', '/', { host: 'evil.test:' + a.port });
    const evilOpt = await request(a.port, 'OPTIONS', '/api/status', { host: '127.0.0.1.evil.test' });
    const hostLh = await request(a.port, 'GET', '/', { host: 'localhost:' + a.port });
    const hostV6 = await request(a.port, 'GET', '/', { host: '[::1]:' + a.port });
    const hostBare = await request(a.port, 'GET', '/', { host: '127.0.0.1' });
    add('collector (review m7): every response carries X-Frame-Options: DENY and X-Content-Type-Options: nosniff (status, 401, GET /, /api/file, OPTIONS); a Host outside 127.0.0.1 / localhost / [::1] (with or without :port) → 421 JSON even with a valid token (GET, OPTIONS and GET / alike); those three hosts are accepted',
      [st, noTok, page, ff, opt].every(hardened) && evil.status === 421 && isJsonCT(evil) && hardened(evil) && !evil.body.includes(token) && evilPort.status === 421 && evilOpt.status === 421
        && hostLh.status === 200 && hostV6.status === 200 && hostBare.status === 200,
      `headers=${JSON.stringify([st, noTok, page, ff, opt].map((r) => [r.headers['x-frame-options'], r.headers['x-content-type-options']]))} · evil ${evil.status} ${evil.body.toString().slice(0, 100)} · evil:port ${evilPort.status} · OPTIONS ${evilOpt.status} · localhost ${hostLh.status} · [::1] ${hostV6.status} · bare ${hostBare.status}`);
    // review m8: the registry's docs link (README.md#automatic-mode) is relative to the page, so the served page needs the README served too
    const readme = await request(a.port, 'GET', '/README.md');
    add('collector (review m8): GET /README.md → 200 text/markdown serving the repo README (the served page\'s "Where the numbers come from" link README.md#automatic-mode resolves), no token needed, hardened headers, Content-Length set',
      readme.status === 200 && /^text\/markdown/i.test(readme.headers['content-type'] || '') && readme.body.toString('utf8').includes('automatic-mode') && +readme.headers['content-length'] === readme.body.length && hardened(readme),
      `status ${readme.status} ct=${readme.headers['content-type']} ${readme.body.length} bytes`);
    // Plan 8: the Help dialog's "Full user guide" link (docs/user-guide.html) is relative to the page too — served like /README.md, no token, hardened headers
    const guide = await request(a.port, 'GET', '/docs/user-guide.html');
    add('collector (Plan 8): GET /docs/user-guide.html → 200 text/html serving the repo\'s HTML user guide (contains "AI Usage Monitor Guide"), no token needed, hardened headers, Content-Length set',
      guide.status === 200 && /^text\/html/i.test(guide.headers['content-type'] || '') && guide.body.toString('utf8').includes('AI Usage Monitor Guide') && +guide.headers['content-length'] === guide.body.length && hardened(guide),
      `status ${guide.status} ct=${guide.headers['content-type']} ${guide.body.length} bytes`);

    // ---------------------------------------------------------------- change-driven walk (fs.watch per root; polling fallback) ----------------------------------------------------------------
    const before = tool('codex');
    const added = path.join(HOME, '.codex', 'sessions', '2026', '09', '16');
    fs.mkdirSync(added, { recursive: true });
    fs.writeFileSync(path.join(added, 'rollout-2026-09-16T10-00-00-new.jsonl'), '{"type":"session_meta"}\n');
    const t0 = Date.now(), deadline = t0 + (before.watch === 'polling' ? 35000 : 8000);   // fs.watch: ≤ 8 s (the E2E's wait); a platform without recursive watch falls back to the 30 s TTL
    let seen = null, polls = 0;
    while (Date.now() < deadline) { polls++; const s = toolOf(asJson(await API('/api/status')), 'codex'); if (s.files === 6) { seen = s; break; } await sleep(200); }
    const afterList = asJson(await API('/api/list?tool=codex')) || {};
    add('collector: change-driven walk — a rollout added under ~/.codex/sessions is counted by a plain /api/status (no refresh) within 8 s under watch=fs (within the 30 s TTL under watch=polling): files 5 → 6, newer newestMtime + scannedAt, and /api/list lists it',
      seen !== null && seen.newestMtime > before.newestMtime && seen.scannedAt > before.scannedAt && ['fs', 'polling'].includes(seen.watch) && seen.watch === before.watch
        && (afterList.files || []).some((f) => f.path === 'sessions/2026/09/16/rollout-2026-09-16T10-00-00-new.jsonl'),
      `watch=${before.watch} seen=${JSON.stringify(seen)} after ${Date.now() - t0} ms / ${polls} polls · before=${JSON.stringify({ files: before.files, newestMtime: before.newestMtime, scannedAt: before.scannedAt })} · list=${(afterList.files || []).length}`);

    const c1 = asJson(await API('/api/status')) || {};
    await sleep(1000);
    const c2 = asJson(await API('/api/status')) || {};
    const same = (id) => toolOf(c1, id).scannedAt === toolOf(c2, id).scannedAt && toolOf(c1, id).walkMs === toolOf(c2, id).walkMs && typeof toolOf(c1, id).scannedAt === 'number' && typeof toolOf(c1, id).walkMs === 'number';
    add('collector: a clean tool is not re-walked — two plain /api/status calls 1 s apart return the same scannedAt and walkMs for codex, local and copilot-cli',
      ['codex', 'local', 'copilot-cli'].every(same), JSON.stringify({ c1: toolOf(c1, 'codex'), c2: toolOf(c2, 'codex') }).slice(0, 600));

    // review m5: /api/file waits for the first walk (or one in flight) only — a dirty tool is re-walked by the next /api/status, never by a file request
    const gem0 = toolOf(c2, 'gemini-cli');
    const mark = a.out.length;   // only a "change detected" line logged AFTER the touch counts (a freshly seeded root fires one spurious event ~2 s after start)
    fs.writeFileSync(path.join(HOME, '.gemini', ...TOUCHED_FILE.split('/')), '{"touched":1}\n');
    if (gem0.watch === 'polling') await sleep(Math.max(0, TTL_MS + 1500 - (Date.now() - gem0.scannedAt)));   // no watcher there: the tool is stale once its cache is older than the TTL
    else { const dl = Date.now() + 8000; while (Date.now() < dl && !/gemini-cli: change detected/.test(a.out.slice(mark))) await sleep(100); }
    const dirtySeen = gem0.watch === 'polling' || /gemini-cli: change detected/.test(a.out.slice(mark));
    const bigBytes = fs.readFileSync(path.join(HOME, '.gemini', ...BIG_FILE.split('/')));
    const tFile0 = Date.now();
    const dirtyFile = await API('/api/file?tool=gemini-cli&path=' + encodeURIComponent(BIG_FILE));
    const tFile1 = Date.now();
    await sleep(100);
    const tStatus = Date.now();
    const gem1 = toolOf(asJson(await API('/api/status')), 'gemini-cli');
    add('collector (review m5): a dirty tool (a file touched under ~/.gemini: watcher fired / TTL elapsed) is NOT re-walked by GET /api/file — the 2 MB file streams byte-exact (200) and the re-walk happens on the NEXT /api/status (scannedAt later than that request was sent, never inside the file request window; files 1 → 2)',
      dirtySeen && dirtyFile.status === 200 && dirtyFile.body.equals(bigBytes) && typeof gem1.scannedAt === 'number' && gem1.scannedAt >= tStatus && !(gem1.scannedAt >= tFile0 && gem1.scannedAt <= tFile1) && gem1.files === 2,
      `watch=${gem0.watch} dirtySeen=${dirtySeen} file ${dirtyFile.status} ${dirtyFile.body.length} bytes · window [${tFile0}, ${tFile1}] · status sent ${tStatus} · gemini ${JSON.stringify(gem1)}`);

    const wantBig = fs.readFileSync(path.join(HOME, '.gemini', ...BIG_FILE.split('/')));
    const [rs, rf] = await Promise.all([API('/api/status?refresh=1'), API('/api/file?tool=gemini-cli&path=' + encodeURIComponent(BIG_FILE))]);
    const rsCodex = toolOf(asJson(rs), 'codex');
    add('collector: /api/file streams a 2 MB file byte-exact while a forced ?refresh=1 walk of every tool is in flight (both fired at once); the forced status re-walks (new scannedAt)',
      wantBig.length >= 2 * 1024 * 1024 && rs.status === 200 && rf.status === 200 && rf.body.equals(wantBig) && +rf.headers['content-length'] === wantBig.length && rsCodex.files === 6 && rsCodex.scannedAt > toolOf(c2, 'codex').scannedAt,
      `status ${rs.status}/${rf.status} · ${rf.body.length}/${wantBig.length} bytes · codex ${JSON.stringify(rsCodex).slice(0, 300)}`);

    // A0 #8: /api/file streams exactly Content-Length bytes — a log that grows while it streams (a CLI appending to its live session) must not break the framing.
    // ~/.continue appears now (not in seedHome: 89c's end-to-end block counts the found tools); a 12 MB file named like Continue's log (the include glob's file), read
    // with the client paused after the first chunk so the server cannot have reached its tail, then 1 MB appended, then the rest read: the body must stop at the size the request saw.
    const GROW_FILE = 'dev_data/0.2.0/tokensGenerated.jsonl';
    const growPath = path.join(HOME, '.continue', ...GROW_FILE.split('/'));
    fs.mkdirSync(path.dirname(growPath), { recursive: true });
    fs.writeFileSync(growPath, Buffer.alloc(12 * 1024 * 1024, 0x61));
    const contFound = toolOf(asJson(await API('/api/status')), 'continue');   // the new root is picked up by a status walk (a file request never re-walks)
    add('collector: a tool folder created after startup (~/.continue) is discovered by the next plain /api/status — found, 1 file (refreshTool no longer leaves a resolved walking promise behind for a root-less tool)',
      contFound.found === true && contFound.files === 1, JSON.stringify(contFound));
    const growLen = fs.statSync(growPath).size;
    const grown = await rawGet(a.port, '/api/file?tool=continue&path=' + encodeURIComponent(GROW_FILE), auth, async () => { fs.appendFileSync(growPath, Buffer.alloc(1024 * 1024, 0x41)); await sleep(300); });
    const growCL = +((/content-length:\s*(\d+)/i.exec(grown.head) || [])[1] || 0);
    add('collector (A0 #8): a 12 MB file appended with 1 MB while its GET streams (client paused after the first chunk) arrives with body length === Content-Length === the size at request time (end: size − 1), status 200',
      /^HTTP\/1\.1 200/.test(grown.head) && growCL === growLen && grown.body.length === growLen && fs.statSync(growPath).size === growLen + 1024 * 1024,
      `head ${grown.head.split('\r\n')[0]} · content-length ${growCL} · body ${grown.body.length} · size at request ${growLen} · body head ${grown.body.subarray(0, 100).toString('latin1')}`);

    await sleep(150);   // the last log line is written after the response ends
    const logLines = a.out.split('\n').filter((l) => /\b(GET|OPTIONS) \//.test(l));
    add('collector: one stdout line per request (method, path, status, bytes) and no log line carries the token or file contents',
      logLines.length >= 18 && logLines.some((l) => /GET \/api\/status[^\n]* 200 \d+/.test(l)) && logLines.some((l) => /GET \/api\/file[^\n]* 200 \d+/.test(l)) && logLines.some((l) => /OPTIONS \/api\/status 204/.test(l))
        && !logLines.some((l) => l.includes(token)) && !a.out.includes('session_meta'),
      `${logLines.length} log lines · ${logLines.slice(0, 6).join(' | ')}`);
    await a.stop();

    // ---------------------------------------------------------------- flags: --no-<id>, --root (single + multi-root) ----------------------------------------------------------------
    // Plan 9 review additions to this run: --root cline=<the kilo fixture folder> (4 task files — the include glob applies to a --root folder too), two --root zed
    // folders holding the decode=zstd decoys (seedZedDecoys) under COLLECTOR_ZSTD_BUDGET=1500000, and COPILOT_OTEL_FILE_EXPORTER_PATH=<HOME>/copilot.jsonl whose folder IS the home — refused
    for (const dir of ['.codex', '.copilot']) {
      fs.writeFileSync(path.join(HOME, dir, '.aider.chat.history.md'), '# aider history\n');
      fs.writeFileSync(path.join(HOME, dir, 'beside.json'), '{}\n');
      fs.writeFileSync(path.join(HOME, dir, 'beside.md'), '# unrelated\n');
    }
    const kiloDir = path.join(HOME, EXT_STORAGE('kilocode.kilo-code'));
    b = await start(['--no-codex', '--root', `cline=${kiloDir}`, '--root', `aider=${path.join(HOME, '.codex')}`, '--root', `aider=${path.join(HOME, '.copilot')}`, '--root', `zed=${path.join(HOME, 'zed-view')}`, '--root', `zed=${path.join(HOME, 'zed-big')}`, '--html', path.join(HOME, 'missing-dashboard.html')],
      HOME, { COPILOT_OTEL_FILE_EXPORTER_PATH: path.join(HOME, 'copilot.jsonl'), COLLECTOR_ZSTD_BUDGET: '1500000' });
    add('collector: starts with --no-codex and --root flags', b.port > 0, b.io());
    if (!b.port) return summary();
    // review m7: the 404 for a missing dashboard file must not disclose the absolute path (the banner on the terminal still names it)
    const root404 = await request(b.port, 'GET', '/');
    const body404 = root404.body.toString('utf8');
    add('collector (review m7): --html <missing file> → GET / answers 404 "AI Usage Dashboard.html not found — pass --html <path>" naming neither the path nor a drive letter (the startup banner on the terminal still says MISSING with the path)',
      root404.status === 404 && /AI Usage Dashboard\.html not found — pass --html <path>/.test(body404) && !body404.includes(HOME) && !/[A-Za-z]:[\/]/.test(body404) && !/missing-dashboard/.test(body404) && /MISSING/.test(b.out) && b.out.includes('missing-dashboard.html'),
      `status ${root404.status} · body ${body404.slice(0, 200)}`);
    const tok2 = fs.readFileSync(tokenFile, 'utf8').trim();
    const B = (p) => request(b.port, 'GET', p, { authorization: 'Bearer ' + tok2 });
    const s2 = asJson(await B('/api/status')) || {};
    const t2 = (id) => (s2.tools || []).find((t) => t.id === id) || {};
    add('collector: --no-codex → codex listed as disabled / not found; --root cline=<the kilo folder> → cline found with that root and its 4 tasks/*/{ui_messages,task_metadata}.json (the include glob applies to a --root folder too); the token file is reused across runs',
      t2('codex').found === false && t2('codex').disabled === true && t2('cline').found === true && t2('cline').files === 4 && path.resolve((t2('cline').roots || [''])[0]) === kiloDir && tok2 === token,
      JSON.stringify({ codex: t2('codex'), cline: t2('cline') }).slice(0, 600));
    const cvs = t2('copilot-vscode');
    const cvsList = await B('/api/list?tool=copilot-vscode');
    add('collector (review, root refusal): COPILOT_OTEL_FILE_EXPORTER_PATH=<HOME>/copilot.jsonl would make the user\'s home folder a root — refused: copilot-vscode not found, status carries refused [{dir, reason}] naming the home folder, the banner line says "refused", /api/list → 404, nothing listed',
      cvs.found === false && cvs.files === 0 && Array.isArray(cvs.refused) && cvs.refused.length === 1 && path.resolve(cvs.refused[0].dir) === HOME && /home/i.test(cvs.refused[0].reason) && cvsList.status === 404
        && /^\s*copilot-vscode\b[^\n]*not found[^\n]*refused/m.test(b.out.slice(0, b.out.indexOf('listening on'))),
      JSON.stringify(cvs) + ' · list ' + cvsList.status + ' · ' + b.out.split('\n').filter((l) => /copilot-vscode/.test(l)).join(' | ').slice(0, 300));
    const errOf = (r) => (asJson(r) || {}).error || '';
    const zedView = await B('/api/file?tool=zed&path=' + encodeURIComponent('zed-view/threads.db') + '&decode=zstd');
    const zedBig = await B('/api/file?tool=zed&path=' + encodeURIComponent('zed-big/threads.db') + '&decode=zstd');
    const zedBigRaw = await B('/api/file?tool=zed&path=' + encodeURIComponent('zed-big/threads.db'));
    const zedAfter = await B('/api/status');
    add(zedDecoys
      ? 'collector (review, decode=zstd): two --root zed folders — zed-view/threads.db where `threads` is a VIEW → 415 JSON ("not a table"); zed-big/threads.db (three rows decoding to 1 MB each) under COLLECTOR_ZSTD_BUDGET=1500000 → 413 JSON naming the budget, no crash; the raw store still streams (200) and the collector keeps answering'
      : 'collector (review, decode=zstd): this Node lacks node:sqlite or zlib zstd — the VIEW / budget stores cannot be built here, so both --root zed folders hold the fixture store and decode=zstd answers 501 for each (asserted, not skipped; CI\'s Node 22 builds and checks the 415 / 413 answers)',
      (zedDecoys ? zedView.status === 415 && isJsonCT(zedView) && /table/i.test(errOf(zedView)) && zedBig.status === 413 && isJsonCT(zedBig) && /1500000/.test(errOf(zedBig))
        : zedView.status === 501 && zedBig.status === 501) && zedBigRaw.status === 200 && zedAfter.status === 200 && b.exited === null,
      `view ${zedView.status} ${errOf(zedView).slice(0, 100)} · big ${zedBig.status} ${errOf(zedBig).slice(0, 100)} · raw ${zedBigRaw.status} · status ${zedAfter.status} · exit=${JSON.stringify(b.exited)}`);
    const l2 = asJson(await B('/api/list?tool=aider')) || {};
    const p2 = (l2.files || []).map((f) => f.path).sort();
    const want2 = fs.readFileSync(path.join(HOME, '.copilot', '.aider.chat.history.md'));
    const f2 = await B('/api/file?tool=aider&path=.copilot%2F.aider.chat.history.md');
    const aiderDecoys = await Promise.all(['.codex/beside.json', '.codex/beside.md', '.copilot/beside.json', '.copilot/beside.md']
      .map((p) => B('/api/file?tool=aider&path=' + encodeURIComponent(p))));
    add('collector (T2): aider multi-root lists only histories and refuses neighboring JSON/Markdown',
      t2('aider').found === true && (t2('aider').roots || []).length === 2 && t2('aider').files === 2
        && JSON.stringify(p2) === JSON.stringify(['.codex/.aider.chat.history.md', '.copilot/.aider.chat.history.md'])
        && f2.status === 200 && f2.body.equals(want2) && aiderDecoys.every((r) => r.status === 404),
      JSON.stringify({ p2, file: f2.status, decoys: aiderDecoys.map((r) => r.status) }));
    await b.stop();

    await checkT2(add, token, skip);

    // ---------------------------------------------------------------- Plan 9 B1: Cowork — a second `local` root under the Claude app folder ----------------------------------------------------------------
    // ~/.claude/projects (the Claude Code fixture) + <APPDATA>/Claude/local-agent-mode-sessions (the Cowork fixture) → one tool, two roots, paths prefixed
    // ".claude/…" and "local-agent-mode-sessions/…"; audit.jsonl is listed (.jsonl passes the allow-list); the session's .claude/.credentials.json never is.
    fs.rmSync(HOME_CW, { recursive: true, force: true });
    fs.cpSync(path.join(OUT_DIR, 'claude-logs', 'projects'), path.join(HOME_CW, '.claude', 'projects'), { recursive: true });
    fs.cpSync(path.join(OUT_DIR, 'cowork', 'local-agent-mode-sessions'), path.join(HOME_CW, 'Claude', 'local-agent-mode-sessions'), { recursive: true });
    // a Cowork session's outputs/ uploads/ (+ uploads-tmp/ .project-cache/ session-env/ backups/) hold the files the task handled, not logs: never listed, never served
    const cwSessionA = path.join(HOME_CW, 'Claude', 'local-agent-mode-sessions', '0f0f0f0f-0000-4000-8000-000000000001', '0f0f0f0f-0000-4000-8000-000000000002', 'local_aaaa0001-0000-4000-8000-000000000001');
    fs.mkdirSync(path.join(cwSessionA, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(cwSessionA, 'uploads', 'report.csv'), 'name,salary\nFIXTURE-PRIVATE,1\n');
    c = await start([], HOME_CW);
    add('collector (B1): starts against a HOME that holds both ~/.claude and <APPDATA>/Claude/local-agent-mode-sessions', c.port > 0, c.io());
    if (!c.port) return summary();
    const tok3 = fs.readFileSync(path.join(HOME_CW, '.ai-usage', 'collector.token'), 'utf8').trim();
    const C = (p) => request(c.port, 'GET', p, { authorization: 'Bearer ' + tok3 });
    const s3 = asJson(await C('/api/status')) || {};
    const loc = (s3.tools || []).find((t) => t.id === 'local') || {};
    const locRoots = (loc.roots || []).map((r) => path.resolve(r));
    const cwRoot = path.join(HOME_CW, 'Claude', 'local-agent-mode-sessions');
    add('collector (B1): /api/status → local found with TWO roots — ~/.claude then <Claude app folder>/local-agent-mode-sessions — 6 files (2 Claude Code + 3 Cowork transcripts + audit.jsonl; the task\'s outputs/ uploads/ files and .credentials.json never counted); the candidates name the Cowork folder; the banner names both roots',
      loc.found === true && locRoots.length === 2 && locRoots[0] === path.join(HOME_CW, '.claude') && locRoots[1] === cwRoot && loc.files === 6 && (loc.candidates || []).map((x) => path.resolve(x)).includes(cwRoot)
        && /^\s*local\b[^\n]*\b6 files\b[^\n]*\+/m.test(c.out.slice(0, c.out.indexOf('listening on'))),
      JSON.stringify(loc).slice(0, 800) + ' · banner: ' + c.out.slice(0, c.out.indexOf('listening on')).replace(/\s+/g, ' ').slice(0, 400));
    const l3 = asJson(await C('/api/list?tool=local')) || {};
    const p3 = (l3.files || []).map((f) => f.path).sort();
    const cwTranscript = p3.find((p) => /^local-agent-mode-sessions\/[^/]+\/[^/]+\/local_aaaa[^/]+\/\.claude\/projects\/[^/]+\/aaaa0001-0000-4000-8000-00000000000a\.jsonl$/.test(p));
    const cwAudit = p3.find((p) => /^local-agent-mode-sessions\/[^/]+\/[^/]+\/local_aaaa[^/]+\/audit\.jsonl$/.test(p));
    add('collector (B1): /api/list?tool=local → roots = both; paths prefixed ".claude/…" (2) and "local-agent-mode-sessions/…" (4) including the Cowork transcript, its subagents/agent-*.jsonl and audit.jsonl; no credential file',
      (l3.roots || []).length === 2 && p3.length === 6 && p3.filter((p) => p.startsWith('.claude/')).length === 2 && p3.filter((p) => p.startsWith('local-agent-mode-sessions/')).length === 4
        && !!cwTranscript && !!cwAudit && p3.some((p) => /\/subagents\/agent-a0001\.jsonl$/.test(p)) && !p3.some((p) => /credentials/i.test(p)),
      p3.join(','));
    // trust gap (B1 follow-up): under a local-agent-mode-sessions root the per-session outputs/ uploads/ uploads-tmp/ .project-cache/ session-env/ backups/
    // are the files a Cowork task handled — a token holder must get neither a listing nor the bytes, whatever the extension; ~/.claude keeps its rules
    const cwSession = cwAudit ? cwAudit.replace(/audit\.jsonl$/, '') : 'local-agent-mode-sessions/x/y/local_z/';
    const outputsGet = await C('/api/file?tool=local&path=' + encodeURIComponent(cwSession + 'outputs/notes.jsonl'));
    const uploadsGet = await C('/api/file?tool=local&path=' + encodeURIComponent(cwSession + 'uploads/report.csv'));
    const shortUpload = await C('/api/file?tool=local&path=' + encodeURIComponent(cwSession + 'UPLOAD~1/notes.jsonl'));   // review 8.3: the short-name spelling of uploads-tmp
    add('collector (B1 trust): a Cowork session\'s outputs/notes.jsonl and uploads/report.csv are neither listed by /api/list nor served by /api/file (404 JSON "file not found", like a missing file, although both exist on disk and pass the extension allow-list); the 8.3 spelling UPLOAD~1/notes.jsonl → 404 too',
      !p3.some((p) => /\/(outputs|uploads)\//.test(p)) && fs.existsSync(path.join(HOME_CW, 'Claude', ...(cwSession + 'outputs/notes.jsonl').split('/'))) && fs.existsSync(path.join(HOME_CW, 'Claude', ...(cwSession + 'uploads/report.csv').split('/')))
        && outputsGet.status === 404 && isJsonCT(outputsGet) && /file not found/.test(outputsGet.body.toString()) && uploadsGet.status === 404 && isJsonCT(uploadsGet) && /file not found/.test(uploadsGet.body.toString()) && !uploadsGet.body.includes('FIXTURE-PRIVATE') && shortUpload.status === 404,
      `list has outputs/uploads: ${p3.filter((p) => /\/(outputs|uploads)\//.test(p)).join(',') || 'none'} · outputs ${outputsGet.status} ${outputsGet.body.toString().slice(0, 80)} · uploads ${uploadsGet.status} ${uploadsGet.body.toString().slice(0, 80)} · UPLOAD~1 ${shortUpload.status}`);
    const wantAudit = cwAudit ? fs.readFileSync(path.join(HOME_CW, 'Claude', ...cwAudit.split('/'))) : Buffer.alloc(0);
    const fAudit = await C('/api/file?tool=local&path=' + encodeURIComponent(cwAudit || 'none'));
    add('collector (B1): /api/file resolves the "local-agent-mode-sessions/…/audit.jsonl" path through the second root byte-exact',
      !!cwAudit && fAudit.status === 200 && wantAudit.length > 0 && fAudit.body.equals(wantAudit), `status ${fAudit.status} · ${fAudit.body.length}/${wantAudit.length} bytes`);
    return summary();
  } catch (e) {
    add('collector: test threw', false, (e && e.stack || String(e)) + ' · ' + [a, b, c].filter(Boolean).map((h) => h.io()).join(' · '));
    return summary();
  } finally {
    for (const h of [a, b, c]) if (h) await h.stop();
    for (let i = 0; i < 5; i++) { try { fs.rmSync(HOME, { recursive: true, force: true }); fs.rmSync(HOME_CW, { recursive: true, force: true }); break; } catch { await sleep(200); } }   // Windows: a just-killed child may still hold a handle for a moment
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const r = await run();
  for (const x of r.results) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass ? '' : '  — ' + x.detail}`);
  process.exit(r.pass ? 0 : 1);
}
