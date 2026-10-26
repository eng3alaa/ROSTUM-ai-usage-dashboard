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
// Windows-safe: 127.0.0.1 only, every wait ≤ 10 s (35 s only on a platform without recursive fs.watch), every child is killed in
// finally, the temp HOME is deleted afterwards.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(import.meta.dirname, '..', '..');
const COLLECTOR = path.join(ROOT, 'docs', 'tools', 'ai-usage-collector.mjs');
const OUT_DIR = path.join(ROOT, 'tests', 'fixtures', 'out');
const HOME = path.join(OUT_DIR, `collector-home-${process.pid}`);
const HOME_DEFAULT = HOME;
const CODEX_FILE = 'sessions/2026/08/10/rollout-2026-08-10T09-00-00-abc.jsonl';
const CODEX_ARCHIVED = 'archived_sessions/rollout-2026-08-10T09-00-00-abc.jsonl';   // Codex's archived_sessions/ is flat: rollout-*.jsonl directly inside
const COPILOT_FILE = 'session-state/sess-1/events.jsonl';
const BIG_FILE = 'tmp/big-2mb.jsonl';   // under ~/.gemini — the only file of that tool, ≥ 2 MB
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
const asJson = (r) => { try { return JSON.parse(r.body.toString('utf8')); } catch { return null; } };
const isJsonCT = (r) => /^application\/json/i.test(r.headers['content-type'] || '');
const corsOk = (r) => r.headers['access-control-allow-origin'] === '*'
  && /authorization/i.test(r.headers['access-control-allow-headers'] || '')
  && String(r.headers['access-control-allow-private-network']).toLowerCase() === 'true';

// spawn the collector against a temp HOME (default: this test's); resolves once its "listening on http://127.0.0.1:<port>" line is out (or it exits / 10 s pass).
// Exported for tests/checks/89c-collector.mjs's end-to-end block (real collector + real page), which seeds its own HOME the same way.
export async function start(args, home = HOME) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, COLLECTOR_PORT: '0' };
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
  // gemini-cli: one ≥ 2 MB file (deterministic JSON lines) for the streaming-while-walking check
  const lines = []; let size = 0;
  for (let i = 0; size < 2 * 1024 * 1024; i++) { const l = JSON.stringify({ i, pad: 'x'.repeat(200 + (i % 37)) }) + '\n'; lines.push(l); size += l.length; }
  fs.mkdirSync(path.join(HOME, '.gemini', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.gemini', ...BIG_FILE.split('/')), lines.join(''));
  // A0 #17: credential files that really live under these roots, plus a file outside the extension allow-list — never listed, never served
  fs.writeFileSync(path.join(HOME, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-SECRET-FIXTURE","refreshToken":"sk-ant-ort01-SECRET-FIXTURE"}}\n');
  fs.writeFileSync(path.join(HOME, '.claude', 'settings.json'), '{"env":{"ANTHROPIC_API_KEY":"sk-ant-api03-SECRET-FIXTURE"}}\n');
  fs.writeFileSync(path.join(HOME, '.gemini', 'oauth_creds.json'), '{"access_token":"ya29.SECRET-FIXTURE","refresh_token":"1//SECRET-FIXTURE"}\n');
  fs.writeFileSync(path.join(HOME, '.gemini', 'settings.json'), '{"selectedAuthType":"gemini-api-key"}\n');
  fs.writeFileSync(path.join(HOME, '.gemini', '.env'), 'GEMINI_API_KEY=AIza-SECRET-FIXTURE\n');
  fs.writeFileSync(path.join(HOME, '.codex', 'sessions', 'notes.yaml'), 'not: a log\n');
}

export async function run() {
  const results = [];
  const add = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail) });
  const summary = () => ({ pass: results.every((r) => r.pass), detail: results.filter((r) => !r.pass).map((r) => r.name + ': ' + r.detail).join(' | '), results });
  if (!fs.existsSync(path.join(OUT_DIR, 'codex', 'sessions'))) { const { generate } = await import('../fixtures/gen.mjs'); await generate(); }   // standalone run before the suite ever generated fixtures
  seedHome();
  let a = null, b = null, c = null;
  const HOME_CW = path.join(OUT_DIR, `collector-cowork-${process.pid}`);   // B1 block: its own HOME (APPDATA / LOCALAPPDATA point at it too — see start())
  try {
    // ---------------------------------------------------------------- default discovery ----------------------------------------------------------------
    a = await start([]);
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
    add('collector: /api/status → local (2 files), codex (5), copilot-cli (2), gemini-cli (1) found under the temp HOME — node_modules / checkpoints skipped — cline not found; version/home/os/startedAt present',
      st.status === 200 && isJsonCT(st) && found('local', 2) && found('codex', 5, 2) && found('copilot-cli', 2) && found('gemini-cli', 1) && tool('cline').found === false && tool('cline').files === 0
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
    add('collector: status names every registry folder connector by its id (local, codex, copilot-cli, gemini-cli, continue, cline, roo, junie, lmstudio, ollama, jan) plus aider / tgwebui as --root-only',
      ['local', 'codex', 'copilot-cli', 'gemini-cli', 'continue', 'cline', 'roo', 'junie', 'lmstudio', 'ollama', 'jan', 'aider', 'tgwebui'].every((id) => ids.includes(id)), ids.join(','));

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

    // A0 #17: an extension allow-list (.jsonl .json .md .sqlite .db .csv .txt) and a credential-name deny-list apply to the listing AND to /api/file
    const lsLocal = (asJson(await API('/api/list?tool=local')) || {}).files || [], lsGem = (asJson(await API('/api/list?tool=gemini-cli')) || {}).files || [], lsCodex = (asJson(await API('/api/list?tool=codex')) || {}).files || [];
    const deniedFiles = [['local', '.credentials.json'], ['local', 'settings.json'], ['gemini-cli', 'oauth_creds.json'], ['gemini-cli', 'settings.json'], ['gemini-cli', '.env'], ['codex', 'sessions/notes.yaml']];
    const denied = await Promise.all(deniedFiles.map(async ([t, p]) => [t + ':' + p, (await API(`/api/file?tool=${t}&path=${encodeURIComponent(p)}`)).status]));
    add('collector (A0 #17): credential-named files that exist under the roots (~/.claude/.credentials.json + settings.json, ~/.gemini/oauth_creds.json + settings.json + .env) and a file outside the extension allow-list (sessions/notes.yaml) are neither listed by /api/list nor served by /api/file (404) — the .jsonl logs beside them still are',
      deniedFiles.every(([, p]) => fs.existsSync(path.join(HOME, { local: '.claude', 'gemini-cli': '.gemini', codex: '.codex' }[deniedFiles.find(([, q]) => q === p)[0]], ...p.split('/'))))
        && !lsLocal.some((f) => /credentials|settings/.test(f.path)) && lsLocal.length === 2 && !lsGem.some((f) => /oauth|settings|\.env/.test(f.path)) && lsGem.length === 1 && !lsCodex.some((f) => /\.yaml$/.test(f.path)) && lsCodex.length === 5
        && denied.every(([, s]) => s === 404),
      JSON.stringify({ denied, local: lsLocal.map((f) => f.path), gem: lsGem.map((f) => f.path), codexYaml: lsCodex.filter((f) => /yaml/.test(f.path)).map((f) => f.path) }));
    const trav = await API('/api/file?tool=codex&path=' + encodeURIComponent('../.ai-usage/collector.token'));
    const abs = await API('/api/file?tool=codex&path=' + encodeURIComponent(tokenFile));
    const slash = await API('/api/file?tool=codex&path=' + encodeURIComponent('/etc/passwd'));
    const inner = await API('/api/file?tool=codex&path=' + encodeURIComponent('sessions/../../.ai-usage/collector.token'));
    const bs = await API('/api/file?tool=codex&path=' + encodeURIComponent('sessions\\..\\..\\.ai-usage\\collector.token'));
    const sibling = await API('/api/file?tool=codex&path=' + encodeURIComponent('cache/junk.txt'));   // inside ~/.codex but under no root
    const all400 = [trav, abs, slash, inner, bs].every((r) => r.status === 400 && isJsonCT(r) && !r.body.includes(token));
    add('collector: traversal guard — "../x", an absolute path, "/x", "a/../../x" and a backslash variant → 400 JSON, the token file never leaks, and a ~/.codex file outside sessions/ + archived_sessions/ is not served',
      all400 && sibling.status === 404 && !sibling.body.includes('not a session'), [trav, abs, slash, inner, bs, sibling].map((r) => r.status).join(','));
    const missing = await API('/api/file?tool=codex&path=' + encodeURIComponent('sessions/2026/08/10/nope.jsonl'));
    const unknownTool = await API('/api/list?tool=nope');
    const notFoundTool = await API('/api/list?tool=cline');
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
    fs.writeFileSync(path.join(HOME, '.gemini', 'tmp', 'touched.jsonl'), '{"touched":1}\n');
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
    // ~/.continue appears now (not in seedHome: 89c's end-to-end block counts the found tools); a 12 MB file, read with the client paused after the first chunk
    // so the server cannot have reached its tail, then 1 MB appended, then the rest read: the body must stop at the size the request saw.
    const growDir = path.join(HOME, '.continue'), growPath = path.join(growDir, 'grow.txt');
    fs.mkdirSync(growDir, { recursive: true });
    fs.writeFileSync(growPath, Buffer.alloc(12 * 1024 * 1024, 0x61));
    const contFound = toolOf(asJson(await API('/api/status')), 'continue');   // the new root is picked up by a status walk (a file request never re-walks)
    add('collector: a tool folder created after startup (~/.continue) is discovered by the next plain /api/status — found, 1 file (refreshTool no longer leaves a resolved walking promise behind for a root-less tool)',
      contFound.found === true && contFound.files === 1, JSON.stringify(contFound));
    const growLen = fs.statSync(growPath).size;
    const grown = await rawGet(a.port, '/api/file?tool=continue&path=grow.txt', auth, async () => { fs.appendFileSync(growPath, Buffer.alloc(1024 * 1024, 0x41)); await sleep(300); });
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
    b = await start(['--no-codex', '--root', `cline=${path.join(HOME, '.claude')}`, '--root', `aider=${path.join(HOME, '.codex')}`, '--root', `aider=${path.join(HOME, '.copilot')}`, '--html', path.join(HOME, 'missing-dashboard.html')]);
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
    add('collector: --no-codex → codex listed as disabled / not found; --root cline=<dir> → cline found with that root and 2 files; the token file is reused across runs',
      t2('codex').found === false && t2('codex').disabled === true && t2('cline').found === true && t2('cline').files === 2 && path.resolve((t2('cline').roots || [''])[0]) === path.join(HOME, '.claude') && tok2 === token,
      JSON.stringify({ codex: t2('codex'), cline: t2('cline') }).slice(0, 600));
    const l2 = asJson(await B('/api/list?tool=aider')) || {};
    const p2 = (l2.files || []).map((f) => f.path).sort();
    const want2 = fs.readFileSync(path.join(HOME, '.copilot', ...COPILOT_FILE.split('/')));
    const f2 = await B('/api/file?tool=aider&path=' + encodeURIComponent('.copilot/' + COPILOT_FILE));
    // --root aider=~/.codex walks the WHOLE folder (5 rollouts + 1 archived + cache/junk.txt = 7; checkpoints skipped; config.toml and sessions/notes.yaml are outside the extension allow-list — A0 #17) + ~/.copilot (2) = 9
    add('collector: two --root aider=… folders → one tool with two roots: paths are prefixed with the root folder name (".codex/…", ".copilot/…"), 9 files (config.toml / notes.yaml never listed), and /api/file resolves the prefixed path byte-exact',
      t2('aider').found === true && (t2('aider').roots || []).length === 2 && t2('aider').files === 9 && p2.length === 9 && p2.every((p) => /^\.(codex|copilot)\//.test(p)) && p2.includes('.copilot/' + COPILOT_FILE) && p2.includes('.codex/cache/junk.txt') && !p2.some((p) => /\.(toml|yaml)$/.test(p)) && f2.status === 200 && f2.body.equals(want2),
      `roots=${JSON.stringify(t2('aider').roots)} files=${t2('aider').files} paths=${p2.join(',')} file=${f2.status}`);
    await b.stop();

    // ---------------------------------------------------------------- Plan 9 B1: Cowork — a second `local` root under the Claude app folder ----------------------------------------------------------------
    // ~/.claude/projects (the Claude Code fixture) + <APPDATA>/Claude/local-agent-mode-sessions (the Cowork fixture) → one tool, two roots, paths prefixed
    // ".claude/…" and "local-agent-mode-sessions/…"; audit.jsonl is listed (.jsonl passes the allow-list); the session's .claude/.credentials.json never is.
    fs.rmSync(HOME_CW, { recursive: true, force: true });
    fs.cpSync(path.join(OUT_DIR, 'claude-logs', 'projects'), path.join(HOME_CW, '.claude', 'projects'), { recursive: true });
    fs.cpSync(path.join(OUT_DIR, 'cowork', 'local-agent-mode-sessions'), path.join(HOME_CW, 'Claude', 'local-agent-mode-sessions'), { recursive: true });
    c = await start([], HOME_CW);
    add('collector (B1): starts against a HOME that holds both ~/.claude and <APPDATA>/Claude/local-agent-mode-sessions', c.port > 0, c.io());
    if (!c.port) return summary();
    const tok3 = fs.readFileSync(path.join(HOME_CW, '.ai-usage', 'collector.token'), 'utf8').trim();
    const C = (p) => request(c.port, 'GET', p, { authorization: 'Bearer ' + tok3 });
    const s3 = asJson(await C('/api/status')) || {};
    const loc = (s3.tools || []).find((t) => t.id === 'local') || {};
    const locRoots = (loc.roots || []).map((r) => path.resolve(r));
    const cwRoot = path.join(HOME_CW, 'Claude', 'local-agent-mode-sessions');
    add('collector (B1): /api/status → local found with TWO roots — ~/.claude then <Claude app folder>/local-agent-mode-sessions — 7 files (2 Claude Code + 3 Cowork transcripts + audit.jsonl + the task\'s outputs/notes.jsonl; .credentials.json never counted); the candidates name the Cowork folder; the banner says "2 roots" for local',
      loc.found === true && locRoots.length === 2 && locRoots[0] === path.join(HOME_CW, '.claude') && locRoots[1] === cwRoot && loc.files === 7 && (loc.candidates || []).map((x) => path.resolve(x)).includes(cwRoot)
        && /^\s*local\b[^\n]*\b7 files\b[^\n]*\+/m.test(c.out.slice(0, c.out.indexOf('listening on'))),
      JSON.stringify(loc).slice(0, 800) + ' · banner: ' + c.out.slice(0, c.out.indexOf('listening on')).replace(/\s+/g, ' ').slice(0, 400));
    const l3 = asJson(await C('/api/list?tool=local')) || {};
    const p3 = (l3.files || []).map((f) => f.path).sort();
    const cwTranscript = p3.find((p) => /^local-agent-mode-sessions\/[^/]+\/[^/]+\/local_aaaa[^/]+\/\.claude\/projects\/[^/]+\/aaaa0001-0000-4000-8000-00000000000a\.jsonl$/.test(p));
    const cwAudit = p3.find((p) => /^local-agent-mode-sessions\/[^/]+\/[^/]+\/local_aaaa[^/]+\/audit\.jsonl$/.test(p));
    add('collector (B1): /api/list?tool=local → roots = both; paths prefixed ".claude/…" (2) and "local-agent-mode-sessions/…" (5) including the Cowork transcript, its subagents/agent-*.jsonl and audit.jsonl; no credential file',
      (l3.roots || []).length === 2 && p3.length === 7 && p3.filter((p) => p.startsWith('.claude/')).length === 2 && p3.filter((p) => p.startsWith('local-agent-mode-sessions/')).length === 5
        && !!cwTranscript && !!cwAudit && p3.some((p) => /\/subagents\/agent-a0001\.jsonl$/.test(p)) && !p3.some((p) => /credentials/i.test(p)),
      p3.join(','));
    const wantAudit = cwAudit ? fs.readFileSync(path.join(HOME_CW, 'Claude', ...cwAudit.split('/'))) : Buffer.alloc(0);
    const fAudit = await C('/api/file?tool=local&path=' + encodeURIComponent(cwAudit || 'none'));
    add('collector (B1): /api/file resolves the "local-agent-mode-sessions/…/audit.jsonl" path through the second root byte-exact',
      !!cwAudit && fAudit.status === 200 && wantAudit.length > 0 && fAudit.body.equals(wantAudit), `status ${fAudit.status} · ${fAudit.body.length}/${wantAudit.length} bytes`);
    return summary();
  } catch (e) {
    add('collector: test threw', false, (e && e.stack || String(e)) + ' · ' + (a ? a.io() : '') + (b ? ' · ' + b.io() : '') + (c ? ' · ' + c.io() : ''));
    return summary();
  } finally {
    if (a) await a.stop();
    if (b) await b.stop();
    if (c) await c.stop();
    for (let i = 0; i < 5; i++) { try { fs.rmSync(HOME, { recursive: true, force: true }); fs.rmSync(HOME_CW, { recursive: true, force: true }); break; } catch { await sleep(200); } }   // Windows: a just-killed child may still hold a handle for a moment
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const r = await run();
  for (const x of r.results) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass ? '' : '  — ' + x.detail}`);
  process.exit(r.pass ? 0 : 1);
}
