// Node-level test for docs/tools/ai-usage-collector.mjs — no browser. The suite runs it from tests/checks/89c-collector.mjs;
// alone:  node tests/tools/collector.test.mjs
// A temp HOME under tests/fixtures/out/collector-home-<pid>/ is seeded by COPYING the existing fixtures into the tools' standard
// folders (.claude/projects, .codex/sessions, .copilot/session-state) plus a node_modules decoy the walk must skip; the collector
// runs as a child process with HOME / USERPROFILE / APPDATA / LOCALAPPDATA all pointing at that dir and COLLECTOR_PORT=0 (the bound
// port is parsed from its "listening on" line). Asserts: token gate (401), CORS/PNA on every answer (OPTIONS 204), /api/status
// discovery + cached walk (?refresh=1), /api/list relative forward-slash paths, /api/file byte-exact streaming, traversal guard
// (400), 404s, GET / serves the dashboard, the request log never carries the token, --no-<id> / --root (single and multi-root).
// Windows-safe: 127.0.0.1 only, every wait ≤ 10 s, every child is killed in finally, the temp HOME is deleted afterwards.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(import.meta.dirname, '..', '..');
const COLLECTOR = path.join(ROOT, 'docs', 'tools', 'ai-usage-collector.mjs');
const OUT_DIR = path.join(ROOT, 'tests', 'fixtures', 'out');
const HOME = path.join(OUT_DIR, `collector-home-${process.pid}`);
const CODEX_FILE = 'sessions/2026/08/10/rollout-2026-08-10T09-00-00-abc.jsonl';
const COPILOT_FILE = 'session-state/sess-1/events.jsonl';
const CODEX_PATHS = [
  'sessions/2026/08/10/rollout-2026-08-10T09-00-00-abc.jsonl',
  'sessions/2026/08/11/rollout-2026-08-11T08-00-00-abc-resumed.jsonl',
  'sessions/2026/08/12/rollout-2026-08-12T09-00-00-oss.jsonl',
  'sessions/2026/08/12/rollout-2026-08-12T10-00-00-named.jsonl',
];

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
const asJson = (r) => { try { return JSON.parse(r.body.toString('utf8')); } catch { return null; } };
const isJsonCT = (r) => /^application\/json/i.test(r.headers['content-type'] || '');
const corsOk = (r) => r.headers['access-control-allow-origin'] === '*'
  && /authorization/i.test(r.headers['access-control-allow-headers'] || '')
  && String(r.headers['access-control-allow-private-network']).toLowerCase() === 'true';

// spawn the collector against the temp HOME; resolves once its "listening on http://127.0.0.1:<port>" line is out (or it exits / 10 s pass)
async function start(args) {
  const env = { ...process.env, HOME, USERPROFILE: HOME, APPDATA: HOME, LOCALAPPDATA: HOME, COLLECTOR_PORT: '0' };
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

function seedHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.cpSync(path.join(OUT_DIR, 'claude-logs', 'projects'), path.join(HOME, '.claude', 'projects'), { recursive: true });
  fs.cpSync(path.join(OUT_DIR, 'codex', 'sessions'), path.join(HOME, '.codex', 'sessions'), { recursive: true });
  fs.cpSync(path.join(OUT_DIR, 'copilot', 'session-state'), path.join(HOME, '.copilot', 'session-state'), { recursive: true });
  fs.mkdirSync(path.join(HOME, '.claude', 'node_modules', 'pkg'), { recursive: true });   // the walk must skip node_modules / .git / checkpoints
  fs.writeFileSync(path.join(HOME, '.claude', 'node_modules', 'pkg', 'skipped.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(HOME, '.codex', 'sessions', 'checkpoints'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.codex', 'sessions', 'checkpoints', 'skipped.jsonl'), '{}\n');
}

export async function run() {
  const results = [];
  const add = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail) });
  const summary = () => ({ pass: results.every((r) => r.pass), detail: results.filter((r) => !r.pass).map((r) => r.name + ': ' + r.detail).join(' | '), results });
  if (!fs.existsSync(path.join(OUT_DIR, 'codex', 'sessions'))) { const { generate } = await import('../fixtures/gen.mjs'); await generate(); }   // standalone run before the suite ever generated fixtures
  seedHome();
  let a = null, b = null;
  try {
    // ---------------------------------------------------------------- default discovery ----------------------------------------------------------------
    a = await start([]);
    const tokenFile = path.join(HOME, '.ai-usage', 'collector.token');
    const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
    const urlTok = (/\?token=([0-9a-f]+)/.exec(a.out) || [])[1] || '';
    add('collector: starts, prints "listening on http://127.0.0.1:<port>" and the ready URL; ~/.ai-usage/collector.token holds the same 64-hex token',
      a.port > 0 && /^[0-9a-f]{64}$/.test(token) && urlTok === token && a.out.includes(`http://127.0.0.1:${a.port}/?token=${token}`), a.io());
    if (!a.port) return summary();
    const auth = { authorization: 'Bearer ' + token };
    const API = (p, opts) => request(a.port, 'GET', p, opts === false ? {} : { ...auth, ...(opts || {}) });

    const noTok = await API('/api/status', false);
    const badTok = await request(a.port, 'GET', '/api/status', { authorization: 'Bearer ' + 'f'.repeat(64) });
    const qTok = await request(a.port, 'GET', '/api/status?token=' + token);
    add('collector: /api/* without a token → 401 JSON (with CORS headers); a wrong token → 401; ?token= works like the Bearer header',
      noTok.status === 401 && isJsonCT(noTok) && asJson(noTok) && asJson(noTok).error && corsOk(noTok) && badTok.status === 401 && qTok.status === 200,
      `no token ${noTok.status} ${noTok.body.toString().slice(0, 200)} · wrong ${badTok.status} · ?token= ${qTok.status}`);

    const st = await API('/api/status');
    const sj = asJson(st) || {};
    const tool = (id) => (sj.tools || []).find((t) => t.id === id) || {};
    const found = (id, n) => tool(id).found === true && tool(id).files === n && Array.isArray(tool(id).roots) && tool(id).roots.length === 1 && typeof tool(id).bytes === 'number' && tool(id).bytes > 0 && typeof tool(id).newestMtime === 'number' && typeof tool(id).scannedAt === 'number';
    add('collector: /api/status → local (2 files), codex (4), copilot-cli (2) found under the temp HOME — node_modules / checkpoints skipped — cline not found; version/home/os/startedAt present',
      st.status === 200 && isJsonCT(st) && found('local', 2) && found('codex', 4) && found('copilot-cli', 2) && tool('cline').found === false && tool('cline').files === 0
        && path.resolve(tool('local').roots[0]) === path.join(HOME, '.claude') && path.resolve(tool('codex').roots[0]) === path.join(HOME, '.codex')
        && typeof sj.version === 'string' && path.resolve(sj.home || '') === HOME && typeof sj.os === 'string' && !Number.isNaN(Date.parse(sj.startedAt)),
      st.body.toString().slice(0, 1500));
    const ids = (sj.tools || []).map((t) => t.id);
    add('collector: status names every registry folder connector by its id (local, codex, copilot-cli, gemini-cli, continue, cline, roo, junie, lmstudio, ollama, jan) plus aider / tgwebui as --root-only',
      ['local', 'codex', 'copilot-cli', 'gemini-cli', 'continue', 'cline', 'roo', 'junie', 'lmstudio', 'ollama', 'jan', 'aider', 'tgwebui'].every((id) => ids.includes(id)), ids.join(','));

    const ls = await API('/api/list?tool=codex');
    const lj = asJson(ls) || {};
    const files = lj.files || [];
    const paths = files.map((f) => f.path).sort();
    const sizesOk = files.every((f) => { const st2 = fs.statSync(path.join(HOME, '.codex', ...f.path.split('/'))); return f.size === st2.size && Math.abs(f.mtime - st2.mtimeMs) < 2; });
    add('collector: /api/list?tool=codex → the 4 rollouts as forward-slash paths relative to ~/.codex with size + mtime (no backslashes, no absolute paths)',
      ls.status === 200 && lj.tool === 'codex' && path.resolve(lj.root || '') === path.join(HOME, '.codex') && JSON.stringify(paths) === JSON.stringify(CODEX_PATHS) && sizesOk && !files.some((f) => f.path.includes('\\') || path.isAbsolute(f.path)),
      ls.body.toString().slice(0, 800));

    const want = fs.readFileSync(path.join(HOME, '.codex', ...CODEX_FILE.split('/')));
    const ff = await API('/api/file?tool=codex&path=' + encodeURIComponent(CODEX_FILE));
    add('collector: /api/file streams the rollout byte-exact with Content-Length + Last-Modified',
      ff.status === 200 && ff.body.equals(want) && +ff.headers['content-length'] === want.length && !Number.isNaN(Date.parse(ff.headers['last-modified'] || '')) && corsOk(ff),
      `status ${ff.status} · ${ff.body.length}/${want.length} bytes · cl=${ff.headers['content-length']} lm=${ff.headers['last-modified']}`);

    const trav = await API('/api/file?tool=codex&path=' + encodeURIComponent('../.ai-usage/collector.token'));
    const abs = await API('/api/file?tool=codex&path=' + encodeURIComponent(tokenFile));
    const slash = await API('/api/file?tool=codex&path=' + encodeURIComponent('/etc/passwd'));
    const inner = await API('/api/file?tool=codex&path=' + encodeURIComponent('sessions/../../.ai-usage/collector.token'));
    const bs = await API('/api/file?tool=codex&path=' + encodeURIComponent('sessions\\..\\..\\.ai-usage\\collector.token'));
    const all400 = [trav, abs, slash, inner, bs].every((r) => r.status === 400 && isJsonCT(r) && !r.body.includes(token));
    add('collector: traversal guard — "../x", an absolute path, "/x", "a/../../x" and a backslash variant → 400 JSON, and the token file never leaks',
      all400, [trav, abs, slash, inner, bs].map((r) => r.status).join(','));
    const missing = await API('/api/file?tool=codex&path=' + encodeURIComponent('sessions/2026/08/10/nope.jsonl'));
    const unknownTool = await API('/api/list?tool=nope');
    const notFoundTool = await API('/api/list?tool=cline');
    const dirReq = await API('/api/file?tool=codex&path=sessions');
    add('collector: a missing file → 404 JSON; an unknown tool id → 404; a tool whose folder does not exist → 404; a directory path → 404',
      missing.status === 404 && isJsonCT(missing) && unknownTool.status === 404 && notFoundTool.status === 404 && dirReq.status === 404,
      [missing, unknownTool, notFoundTool, dirReq].map((r) => r.status).join(','));

    const opt = await request(a.port, 'OPTIONS', '/api/status', { origin: 'null', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization', 'access-control-request-private-network': 'true' });
    add('collector: OPTIONS → 204 with Access-Control-Allow-Origin: *, Allow-Headers: Authorization, Allow-Private-Network: true (no token needed)',
      opt.status === 204 && corsOk(opt) && corsOk(st), `status ${opt.status} · ${JSON.stringify(opt.headers)}`);

    const page = await request(a.port, 'GET', '/');
    add('collector: GET / → 200 text/html serving AI Usage Dashboard.html (contains "<title>AI Usage")',
      page.status === 200 && /^text\/html/i.test(page.headers['content-type'] || '') && page.body.toString('utf8').includes('<title>AI Usage'),
      `status ${page.status} ct=${page.headers['content-type']} ${page.body.length} bytes`);

    const added = path.join(HOME, '.codex', 'sessions', '2026', '09', '16');
    fs.mkdirSync(added, { recursive: true });
    fs.writeFileSync(path.join(added, 'rollout-2026-09-16T10-00-00-new.jsonl'), '{"type":"session_meta"}\n');
    const cached = asJson(await API('/api/status')) || {};
    const fresh = asJson(await API('/api/status?refresh=1')) || {};
    const freshList = asJson(await API('/api/list?tool=codex')) || {};
    const cCount = ((cached.tools || []).find((t) => t.id === 'codex') || {}).files, fCount = ((fresh.tools || []).find((t) => t.id === 'codex') || {}).files;
    add('collector: cached walk — a rollout added under ~/.codex is not counted by the next plain /api/status (within 30 s) but is after ?refresh=1 (4 → 5), and /api/list then lists it',
      cCount === 4 && fCount === 5 && (freshList.files || []).some((f) => f.path === 'sessions/2026/09/16/rollout-2026-09-16T10-00-00-new.jsonl'),
      `cached=${cCount} refreshed=${fCount} list=${(freshList.files || []).length}`);

    await sleep(150);   // the last log line is written after the response ends
    const logLines = a.out.split('\n').filter((l) => /\b(GET|OPTIONS) \//.test(l));
    add('collector: one stdout line per request (method, path, status, bytes) and no log line carries the token or file contents',
      logLines.length >= 18 && logLines.some((l) => /GET \/api\/status[^\n]* 200 \d+/.test(l)) && logLines.some((l) => /GET \/api\/file[^\n]* 200 \d+/.test(l)) && logLines.some((l) => /OPTIONS \/api\/status 204/.test(l))
        && !logLines.some((l) => l.includes(token)) && !a.out.includes('session_meta'),
      `${logLines.length} log lines · ${logLines.slice(0, 6).join(' | ')}`);
    await a.stop();

    // ---------------------------------------------------------------- flags: --no-<id>, --root (single + multi-root) ----------------------------------------------------------------
    b = await start(['--no-codex', '--root', `cline=${path.join(HOME, '.claude')}`, '--root', `aider=${path.join(HOME, '.codex')}`, '--root', `aider=${path.join(HOME, '.copilot')}`]);
    add('collector: starts with --no-codex and --root flags', b.port > 0, b.io());
    if (!b.port) return summary();
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
    add('collector: two --root aider=… folders → one tool with two roots: paths are prefixed with the root folder name (".codex/…", ".copilot/…"), 7 files, and /api/file resolves the prefixed path byte-exact',
      t2('aider').found === true && (t2('aider').roots || []).length === 2 && t2('aider').files === 7 && p2.length === 7 && p2.every((p) => /^\.(codex|copilot)\//.test(p)) && p2.includes('.copilot/' + COPILOT_FILE) && f2.status === 200 && f2.body.equals(want2),
      `roots=${JSON.stringify(t2('aider').roots)} files=${t2('aider').files} paths=${p2.join(',')} file=${f2.status}`);
    return summary();
  } catch (e) {
    add('collector: test threw', false, (e && e.stack || String(e)) + ' · ' + (a ? a.io() : '') + (b ? ' · ' + b.io() : ''));
    return summary();
  } finally {
    if (a) await a.stop();
    if (b) await b.stop();
    for (let i = 0; i < 5; i++) { try { fs.rmSync(HOME, { recursive: true, force: true }); break; } catch { await sleep(200); } }   // Windows: a just-killed child may still hold a handle for a moment
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const r = await run();
  for (const x of r.results) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass ? '' : '  — ' + x.detail}`);
  process.exit(r.pass ? 0 : 1);
}
