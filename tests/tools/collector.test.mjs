// Node-level test for docs/tools/ai-usage-collector.mjs — no browser. The suite runs it from tests/checks/89c-collector.mjs;
// alone:  node tests/tools/collector.test.mjs
// A temp HOME under tests/fixtures/out/collector-home-<pid>/ is seeded by COPYING the existing fixtures into the tools' standard
// folders (.claude/projects, .codex/sessions + one rollout copied into .codex/archived_sessions, .copilot/session-state) plus decoys
// the walk must skip or never list (node_modules, checkpoints, ~/.codex/cache + config.toml — codex roots are sessions/ and
// archived_sessions/ only) and a 2 MB file under ~/.gemini for the streaming-during-walk check; the collector runs as a child
// process with HOME / USERPROFILE / APPDATA / LOCALAPPDATA all pointing at that dir and COLLECTOR_PORT=0 (the bound port is parsed
// from its "listening on" line). Asserts: token gate (401), CORS/PNA on every answer (OPTIONS 204), /api/status discovery + the
// change-driven walk (fs.watch per root → a plain /api/status counts a new file within 5 s; a clean tool is never re-walked;
// ?refresh=1 forces one), /api/list relative forward-slash paths (multi-root prefixes), /api/file byte-exact streaming — also while
// a forced walk is in flight — traversal guard (400), 404s, GET / serves the dashboard, the request log never carries the token,
// the startup banner (per-tool counts + watch mode), --no-<id> / --root (single and multi-root).
// Windows-safe: 127.0.0.1 only, every wait ≤ 10 s (35 s only on a platform without recursive fs.watch), every child is killed in
// finally, the temp HOME is deleted afterwards.
import http from 'node:http';
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
    const banner = a.out.slice(0, a.out.indexOf('listening on'));
    add('collector: the startup banner lists per-tool file counts, the watch mode and the walk time (codex: "5 files", "watch fs|polling", "walk N ms") before "listening on"',
      /^\s*codex\b[^\n]*\b5 files\b[^\n]*\bwatch (fs|polling)\b[^\n]*\bwalk \d+ ms\b/m.test(banner) && /^\s*local\b[^\n]*\b2 files\b/m.test(banner), banner.replace(/\s+/g, ' ').slice(0, 1200));
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
    add('collector: GET / → 200 text/html serving AI Usage Dashboard.html (contains "<title>AI Usage")',
      page.status === 200 && /^text\/html/i.test(page.headers['content-type'] || '') && page.body.toString('utf8').includes('<title>AI Usage'),
      `status ${page.status} ct=${page.headers['content-type']} ${page.body.length} bytes`);

    // ---------------------------------------------------------------- change-driven walk (fs.watch per root; polling fallback) ----------------------------------------------------------------
    const before = tool('codex');
    const added = path.join(HOME, '.codex', 'sessions', '2026', '09', '16');
    fs.mkdirSync(added, { recursive: true });
    fs.writeFileSync(path.join(added, 'rollout-2026-09-16T10-00-00-new.jsonl'), '{"type":"session_meta"}\n');
    const t0 = Date.now(), deadline = t0 + (before.watch === 'polling' ? 35000 : 5000);   // fs.watch: ≤ 5 s; a platform without recursive watch falls back to the 30 s TTL
    let seen = null, polls = 0;
    while (Date.now() < deadline) { polls++; const s = toolOf(asJson(await API('/api/status')), 'codex'); if (s.files === 6) { seen = s; break; } await sleep(200); }
    const afterList = asJson(await API('/api/list?tool=codex')) || {};
    add('collector: change-driven walk — a rollout added under ~/.codex/sessions is counted by a plain /api/status (no refresh) within 5 s under watch=fs (within the 30 s TTL under watch=polling): files 5 → 6, newer newestMtime + scannedAt, and /api/list lists it',
      seen !== null && seen.newestMtime > before.newestMtime && seen.scannedAt > before.scannedAt && ['fs', 'polling'].includes(seen.watch) && seen.watch === before.watch
        && (afterList.files || []).some((f) => f.path === 'sessions/2026/09/16/rollout-2026-09-16T10-00-00-new.jsonl'),
      `watch=${before.watch} seen=${JSON.stringify(seen)} after ${Date.now() - t0} ms / ${polls} polls · before=${JSON.stringify({ files: before.files, newestMtime: before.newestMtime, scannedAt: before.scannedAt })} · list=${(afterList.files || []).length}`);

    const c1 = asJson(await API('/api/status')) || {};
    await sleep(1000);
    const c2 = asJson(await API('/api/status')) || {};
    const same = (id) => toolOf(c1, id).scannedAt === toolOf(c2, id).scannedAt && toolOf(c1, id).walkMs === toolOf(c2, id).walkMs && typeof toolOf(c1, id).scannedAt === 'number' && typeof toolOf(c1, id).walkMs === 'number';
    add('collector: a clean tool is not re-walked — two plain /api/status calls 1 s apart return the same scannedAt and walkMs for codex, local and copilot-cli',
      ['codex', 'local', 'copilot-cli'].every(same), JSON.stringify({ c1: toolOf(c1, 'codex'), c2: toolOf(c2, 'codex') }).slice(0, 600));

    const wantBig = fs.readFileSync(path.join(HOME, '.gemini', ...BIG_FILE.split('/')));
    const [rs, rf] = await Promise.all([API('/api/status?refresh=1'), API('/api/file?tool=gemini-cli&path=' + encodeURIComponent(BIG_FILE))]);
    const rsCodex = toolOf(asJson(rs), 'codex');
    add('collector: /api/file streams a 2 MB file byte-exact while a forced ?refresh=1 walk of every tool is in flight (both fired at once); the forced status re-walks (new scannedAt)',
      wantBig.length >= 2 * 1024 * 1024 && rs.status === 200 && rf.status === 200 && rf.body.equals(wantBig) && +rf.headers['content-length'] === wantBig.length && rsCodex.files === 6 && rsCodex.scannedAt > toolOf(c2, 'codex').scannedAt,
      `status ${rs.status}/${rf.status} · ${rf.body.length}/${wantBig.length} bytes · codex ${JSON.stringify(rsCodex).slice(0, 300)}`);

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
    // --root aider=~/.codex walks the WHOLE folder (5 rollouts + 1 archived + cache/junk.txt + config.toml = 8; checkpoints skipped) + ~/.copilot (2) = 10
    add('collector: two --root aider=… folders → one tool with two roots: paths are prefixed with the root folder name (".codex/…", ".copilot/…"), 10 files, and /api/file resolves the prefixed path byte-exact',
      t2('aider').found === true && (t2('aider').roots || []).length === 2 && t2('aider').files === 10 && p2.length === 10 && p2.every((p) => /^\.(codex|copilot)\//.test(p)) && p2.includes('.copilot/' + COPILOT_FILE) && p2.includes('.codex/cache/junk.txt') && f2.status === 200 && f2.body.equals(want2),
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
