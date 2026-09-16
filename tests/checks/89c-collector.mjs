// v7 T1 + T4a — docs/tools/ai-usage-collector.mjs serves the AI tools' log folders to the dashboard on 127.0.0.1. A Node-level check
// (no page): tests/tools/collector.test.mjs starts the collector as a child process against a temp HOME seeded with the existing
// fixtures and exercises its API — discovery (codex = sessions/ + archived_sessions/ only), the change-driven walk (fs.watch per root,
// dirty-only re-walk, polling fallback), streaming during a walk; each of its results is relayed as one ok(...) line.
// Runs alone too:  node tests/tools/collector.test.mjs
//
// v7 T4b — end to end, nothing stubbed: a REAL collector (same seeding helper, its own temp HOME, port 0) and the REAL page in headless
// Chrome. (a) the file:// dashboard (openDashboard) connects to http://127.0.0.1:<port> — CORS + Chrome's Private Network Access for
// file:// → loopback proven in a real browser (a PNA block is recorded verbatim and retried ONLY for this block in a browser launched
// with the PNA features disabled — the assertions never weaken); local + codex + copilot-cli totals equal the folder-scan numbers of
// 10-baseline / 87-folder-logs and a direct parse of the same texts. (b) the collector-served page (GET /?token=…) pre-fills the token,
// strips it from the address bar, defaults the card's URL to its own origin, and connects on a real click of Validate & connect.
// (c) a rollout written under the temp HOME is picked up by ONE App._collectorTick on the file:// page: codex alone is re-read (+1 file,
// +1 session, +40 in / +7 out), local / copilot-cli untouched. Collector killed and the temp HOME deleted in finally.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { run as runCollectorTest, seedHome, start } from '../tools/collector.test.mjs';
import { openDashboard, findBrowser, OUT } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const r = await runCollectorTest();
  for (const x of r.results) ok(x.name, x.pass, x.detail);
  await runE2E({ browser, ok });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (port, p, token) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { authorization: 'Bearer ' + token } }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
  });
  req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('timeout ' + p))); req.end();
});
const NEW_ROLLOUT = 'sessions/2026/09/16/rollout-2026-09-16T10-00-00-e2e.jsonl';
const NEW_ROLLOUT_TEXT = [
  { timestamp: '2026-09-16T10:00:00.000Z', type: 'session_meta', payload: { id: 'e2e1', cwd: 'D:\\proj1', cli_version: '0.60.0', originator: 'codex_cli_rs' } },
  { timestamp: '2026-09-16T10:00:01.000Z', type: 'turn_context', payload: { cwd: 'D:\\proj1', model: 'gpt-5.4-codex', approval_policy: 'on-request' } },
  { timestamp: '2026-09-16T10:01:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 40, cached_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0, total_tokens: 47 }, last_token_usage: { input_tokens: 40, cached_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0, total_tokens: 47 } } } },
].map((o) => JSON.stringify(o)).join('\n') + '\n';

// runs in the page after a connect (puppeteer serializes it — page globals only): totals per source + labels + the collector card, and a direct parse of the
// same texts as File objects (the folder path)
async function snapshot(fx) {
  const c = connectorById('collector');
  const sum = (rows) => rows.reduce((a, r) => ({ in: a.in + (r.in || 0), cw: a.cw + (r.cw || 0), cr: a.cr + (r.cr || 0), out: a.out + (r.out || 0), msgs: a.msgs + (r.msgs || 0) }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });
  const src = (id) => ((Store.sources[id] || {}).rows) || [];
  const meta = (id) => (Store.sources[id] || {}).meta || {};
  const label = (id) => Store.connectors[id] ? Store.connectors[id].label : null;
  const oss = src('codex').filter(r => r.sid === 'rollout-2026-08-12T09-00-00-oss');
  const out = { protocol: location.protocol, origin: location.origin,
    local: sum(src('local')), localAaa: sum(src('local').filter(r => r.sid === 'sess-aaa')), localFiles: meta('local').files, projects: (Store.projects || []).length,
    codex: sum(src('codex')), codexAbc: sum(src('codex').filter(r => r.sid === 'rollout-2026-08-10T09-00-00-abc')), codexResumed: sum(src('codex').filter(r => r.sid === 'rollout-2026-08-11T08-00-00-abc-resumed')),
    codexOssLocal: oss.length > 0 && oss.every(r => r.local === 1), codexFiles: meta('codex').files, codexProjects: (Store.projectsBy.codex || []).length,
    copilot: sum(src('copilot-cli')), copilotFiles: meta('copilot-cli').files,
    labels: { local: label('local'), codex: label('codex'), 'copilot-cli': label('copilot-cli'), 'gemini-cli': label('gemini-cli'), collector: label('collector') },
    collectorErr: Store.connectors.collector ? Store.connectors.collector.err : undefined, status: c ? Store.connectorStatus(c) : null,
    statusText: (document.getElementById('collector-status') || {}).textContent, localStatus: (document.getElementById('local-status') || {}).textContent,
    tableRows: [...document.querySelectorAll('#collector-tools tbody tr')].map(tr => [...tr.children].map(td => td.textContent)),
    watch: !!App._pollTimers.collector, remembered: LS.get('key:collector', null), urlStored: LS.get('url:collector', null),
    tokenInDom: document.documentElement.outerHTML.includes(document.getElementById('collector-key').value) };
  if (fx) {   // folder-scan cross-check: the same texts as File objects through the folder parsers → identical totals
    const asFiles = (id) => Object.entries(fx[id]).map(([p, text]) => ({ path: p, file: new File([text], p.split('/').pop(), { lastModified: 1755000000000 }) }));
    out.refLocal = sum((await parseClaudeLogsCached(asFiles('local'), null, new Map())).rows);
    out.refCodex = sum((await parseFolderCached(connectorById('codex'), asFiles('codex'), null, new Map())).rows);
    out.refCopilot = sum((await parseFolderCached(connectorById('copilot-cli'), asFiles('copilot-cli'), null, new Map())).rows);
  }
  return out;
}

async function runE2E({ browser, ok }) {
  const HOME = path.join(OUT, `collector-e2e-home-${process.pid}`);
  const read = (...p) => fs.readFileSync(path.join(OUT, ...p), 'utf8');
  const codexText = (day, f) => read('codex', 'sessions', '2026', '08', day, f);
  const fx = {
    local: { 'projects/-D--proj1/sess-aaa.jsonl': read('claude-logs', 'projects', '-D--proj1', 'sess-aaa.jsonl'), 'projects/-D--proj2/sess-hours.jsonl': read('claude-logs', 'projects', '-D--proj2', 'sess-hours.jsonl') },
    codex: {   // the seeded tree: 4 rollouts under sessions/ + the abc one copied to archived_sessions/ (counted once — whole-file sid dedupe, 87-folder-logs)
      'sessions/2026/08/10/rollout-2026-08-10T09-00-00-abc.jsonl': codexText('10', 'rollout-2026-08-10T09-00-00-abc.jsonl'),
      'sessions/2026/08/11/rollout-2026-08-11T08-00-00-abc-resumed.jsonl': codexText('11', 'rollout-2026-08-11T08-00-00-abc-resumed.jsonl'),
      'sessions/2026/08/12/rollout-2026-08-12T09-00-00-oss.jsonl': codexText('12', 'rollout-2026-08-12T09-00-00-oss.jsonl'),
      'sessions/2026/08/12/rollout-2026-08-12T10-00-00-named.jsonl': codexText('12', 'rollout-2026-08-12T10-00-00-named.jsonl'),
      'archived_sessions/rollout-2026-08-10T09-00-00-abc.jsonl': codexText('10', 'rollout-2026-08-10T09-00-00-abc.jsonl') },
    'copilot-cli': { 'session-state/sess-1/events.jsonl': read('copilot', 'session-state', 'sess-1', 'events.jsonl'), 'session-state/sess-2/events.jsonl': read('copilot', 'session-state', 'sess-2', 'events.jsonl') },
  };
  const is = (t, i, cw, cr, o, m) => !!t && t.in === i && t.cw === cw && t.cr === cr && t.out === o && t.msgs === m;
  const eq = (a, b) => !!a && !!b && a.in === b.in && a.cw === b.cw && a.cr === b.cr && a.out === b.out && a.msgs === b.msgs;
  const landedOk = (s) => !!s && is(s.localAaa, 110, 25, 50, 220, 2) && s.local.msgs === 5 && s.localFiles === 2 && s.projects > 0 && eq(s.local, s.refLocal)
    && is(s.codexAbc, 200, 0, 200, 130, 3) && is(s.codexResumed, 700, 0, 300, 150, 4) && s.codexOssLocal && s.codexFiles === 5 && s.codexProjects > 0 && eq(s.codex, s.refCodex)
    && is(s.copilot, 2150, 100, 900, 500, 5) && s.copilotFiles === 2 && eq(s.copilot, s.refCopilot)
    && s.labels.local === '2 log files · via collector' && s.labels.codex === '5 files · via collector' && s.labels['copilot-cli'] === '2 files · via collector' && s.labels['gemini-cli'] === null
    && s.labels.collector === '3 tools · 9 files' && s.collectorErr === null && s.status === 'ok' && /Connected/.test(s.statusText) && /3 tools/.test(s.statusText) && /9 files/.test(s.statusText) && /2 found, nothing to read/.test(s.statusText)
    && /via collector/.test(s.localStatus) && s.tableRows.some(r => /Gemini CLI/.test(r[0]) && r[2] === 'found, nothing to read') && s.tableRows.some(r => /Ollama/.test(r[0]) && r[2] === 'found, nothing to read' && /.ai-usage/.test(r[1])) && s.tableRows.some(r => /Codex/.test(r[0]) && r[2] === '5 files' && /archived_sessions/.test(r[1]))
    && s.watch && s.remembered === null && !s.tokenInDom;
  const brief = (s) => JSON.stringify(s && { protocol: s.protocol, local: s.local, aaa: s.localAaa, refLocal: s.refLocal, localFiles: s.localFiles, codex: s.codex, abc: s.codexAbc, resumed: s.codexResumed, refCodex: s.refCodex, codexFiles: s.codexFiles, oss: s.codexOssLocal,
    copilot: s.copilot, copilotFiles: s.copilotFiles, labels: s.labels, err: s.collectorErr, status: s.status, text: s.statusText, watch: s.watch, remembered: s.remembered, tokenInDom: s.tokenInDom, rows: s.tableRows });

  seedHome(HOME);
  let col = null, page = null, page2 = null, alt = null;
  const closeQuietly = async (p) => { if (p) { try { await p.close(); } catch { /* already closed */ } } };
  try {
    col = await start([], HOME);
    const token = (/^Token: ([0-9a-f]{64})$/m.exec(col.out) || [])[1] || '';
    const port = col.port;
    ok('collector e2e: a real collector starts against its own temp HOME (COLLECTOR_PORT=0) — port and 64-hex token parsed from its stdout, the ready URL carries both',
      port > 0 && /^[0-9a-f]{64}$/.test(token) && col.out.includes(`http://127.0.0.1:${port}/?token=${token}`), col.io());
    if (!port || !token) return;
    const base = `http://127.0.0.1:${port}`;

    // ---- (a) the file:// dashboard talks to 127.0.0.1 over HTTP: CORS + Private Network Access in a real Chrome ----
    const connectFileDashboard = async (br) => {
      const { page: pg, errors } = await openDashboard(br);
      const failed = [];
      pg.on('requestfailed', (rq) => failed.push(rq.url() + ' — ' + ((rq.failure() || {}).errorText || '?')));
      const ret = await pg.evaluate(async (base, token) => {
        const c = connectorById('collector');
        document.getElementById('collector-url').value = base;
        document.getElementById('collector-key').value = token;
        document.getElementById('remember-collector').checked = false;
        return App.connectCollector(c);
      }, base, token);
      const snap = await pg.evaluate(snapshot, fx);
      return { pg, errors, failed, ret, snap };
    };
    let a = await connectFileDashboard(browser);
    page = a.pg;
    let pna = 'no flag needed';
    if (a.ret !== true) {   // a PNA / CORS block shows as a failed fetch → "Not running at …": record it verbatim, retry once with the PNA features off (this block only)
      pna = `default launch FAILED (status "${a.snap.statusText}" · requestfailed: ${a.failed.join(' | ') || 'none'} · console/page errors: ${a.errors.join(' | ') || 'none'}) → retried with --disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults`;
      await closeQuietly(page); page = null;
      alt = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ['--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults'] });
      a = await connectFileDashboard(alt);
      page = a.pg;
    }
    ok(`collector e2e (a): the file:// page connects to the REAL collector at 127.0.0.1 (CORS + Private Network Access — ${pna}): local sess-aaa 110/25/50/220/2 over 2 log files, codex abc 200/200/130/3 + resumed 700/300/150/4 over 5 files (archived copy deduped), copilot-cli 2150/100/900/500/5 over 2 files — each equal to a direct folder parse of the same texts; "via collector" labels, collector "3 tools · 9 files", gemini-cli + ollama (~/.ai-usage holds only the token file) "found, nothing to read", watch running, token neither remembered nor in the DOM, no page errors`,
      a.ret === true && a.snap.protocol === 'file:' && landedOk(a.snap) && a.errors.length === 0 && a.failed.length === 0,
      `ret=${a.ret} pna=${pna} errors=${JSON.stringify(a.errors)} failed=${JSON.stringify(a.failed)} snap=${brief(a.snap)}`);

    // ---- (b) the collector-served page: /?token=… pre-fills, strips the URL, defaults the card's URL to its own origin, connects on a real click ----
    page2 = await browser.newPage();
    const errs2 = [];
    page2.on('pageerror', (e) => errs2.push(String(e)));
    page2.on('console', (m) => { if (m.type() === 'error') errs2.push(m.text()); });
    const notFound = []; page2.on('response', (rs) => { if (rs.status() >= 400) notFound.push(rs.status() + ' ' + rs.url()); });
    await page2.goto(`${base}/?token=${token}`, { waitUntil: 'load' });
    const pre = await page2.evaluate(() => ({ key: document.getElementById('collector-key').value, url: document.getElementById('collector-url').value, search: location.search, href: location.href, origin: location.origin,
      title: document.title, connectors: Object.keys(Store.connectors), remembered: LS.get('key:collector', null), dataBlob: !!localStorage.getItem('aiusage:data'), hidden: document.hidden,
      hubConnect: !!document.querySelector('#accounts-hub .acct[data-connector="collector"] .acct-manage') }));
    ok('collector e2e (b): GET /?token=<token> serves the dashboard (title "AI Usage…") at the collector\'s origin — the token input is pre-filled, location.search is stripped (href = <base>/), the card\'s Collector URL defaults to that origin, nothing connected or remembered yet — its browser storage is its own (no data blob, no connectors while the file:// page is connected), no 4xx response',
      pre.key === token && pre.search === '' && pre.href === base + '/' && pre.origin === base && pre.url === base && /^AI Usage/.test(pre.title) && pre.connectors.length === 0 && pre.remembered === null && !pre.dataBlob && notFound.length === 0,
      JSON.stringify({ ...pre, key: pre.key === token ? '<token>' : pre.key, responses4xx: notFound }));
    if (pre.hubConnect) await page2.click('#accounts-hub .acct[data-connector="collector"] .acct-manage');   // the hub's Connect → the card in the modal
    else await page2.evaluate(() => App.openConnectorModal('collector'));
    await page2.click('#collector-validate');   // a real click on Validate & connect — nothing typed, nothing pasted
    await page2.waitForFunction(() => { const s = document.getElementById('collector-status'); return !!s && !s.dataset.gen && /Connected|Not running|Rejected|Needs attention|Paste/.test(s.textContent); }, { timeout: 60000 });
    const b = await page2.evaluate(snapshot, fx);
    await page2.evaluate(() => App.closeConnectorModal());
    ok('collector e2e (b): one real click on Validate & connect on the collector-served page lands the same sources — local / codex / copilot-cli totals as (a), "via collector" labels, "3 tools · 9 files", watch running, token not remembered (no opt-in), no page errors',
      b.protocol === 'http:' && b.origin === base && landedOk(b) && errs2.length === 0,
      `hubConnect=${pre.hubConnect} errors=${JSON.stringify(errs2)} responses4xx=${JSON.stringify(notFound)} snap=${brief(b)}`);

    // ---- (c) a new rollout on disk → one _collectorTick on the file:// page re-reads codex only ----
    await page.bringToFront();   // page2 made it a hidden tab — and a hidden tab skips its tick (87f w3); bring it back before the real one
    const before = await page.evaluate(snapshot, null);
    const abs = path.join(HOME, '.codex', ...NEW_ROLLOUT.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, NEW_ROLLOUT_TEXT);
    const st0 = await getJson(port, '/api/status', token);
    const watchMode = ((st0.tools || []).find((t) => t.id === 'codex') || {}).watch;
    const t0 = Date.now(), deadline = t0 + (watchMode === 'polling' ? 35000 : 8000);
    let seen = null, polls = 0;
    while (Date.now() < deadline) { polls++; const s = ((await getJson(port, '/api/status', token)).tools || []).find((t) => t.id === 'codex') || {}; if (s.files === 6) { seen = s; break; } await sleep(200); }
    const c = await page.evaluate(async () => {
      const cc = connectorById('collector');
      App.stopCollectorWatch(cc);   // the 60 s timer must not race the explicit tick below (a tick that succeeds outside the watch resumes it)
      const origScan = App.scanFiles, origLocal = App.scanLocalFiles, scans = [], localScans = [];
      App.scanFiles = function (conn, files, o) { scans.push(conn.id); return origScan.call(this, conn, files, o); };
      App.scanLocalFiles = function (files, o) { localScans.push('local'); return origLocal.call(this, files, o); };
      const syncBefore = { local: Store.connectors.local.lastSync, copilot: Store.connectors['copilot-cli'].lastSync, codex: Store.connectors.codex.lastSync };
      await new Promise(r => setTimeout(r, 5));
      let ret;
      try { ret = await App._collectorTick(cc); } finally { App.scanFiles = origScan; App.scanLocalFiles = origLocal; }
      const rows = (Store.sources.codex || {}).rows || [];
      const e2e = rows.filter(r => r.sid === 'rollout-2026-09-16T10-00-00-e2e');
      return { ret, hidden: document.hidden, scans, localScans, codexLabel: Store.connectors.codex.label, codexFiles: Store.sources.codex.meta.files, collectorLabel: Store.connectors.collector.label,
        e2e: e2e.reduce((a, r) => ({ in: a.in + (r.in || 0), out: a.out + (r.out || 0), msgs: a.msgs + (r.msgs || 0), n: a.n + 1 }), { in: 0, out: 0, msgs: 0, n: 0 }),
        codexMoved: Store.connectors.codex.lastSync > syncBefore.codex, localUntouched: Store.connectors.local.lastSync === syncBefore.local, copilotUntouched: Store.connectors['copilot-cli'].lastSync === syncBefore.copilot,
        codexCell: ([...document.querySelectorAll('#collector-tools tbody tr')].find(tr => /Codex/.test(tr.children[0].textContent)) || { children: [{}, {}, {}] }).children[2].textContent,
        watchAgain: !!App._pollTimers.collector, statusText: document.getElementById('collector-status').textContent };
    });
    const after = await page.evaluate(snapshot, null);
    ok('collector e2e (c): a rollout written under the temp HOME (fs.watch → the collector counts 6 codex files within 8 s; 35 s under watch=polling) → ONE App._collectorTick re-reads codex only (scanFiles once, for codex; scanLocalFiles never): "6 files · via collector", meta.files 6, the new session lands (+1 file, +1 msg, +40 in / +7 out; local + copilot-cli totals untouched), collector "3 tools · 10 files", table cell "6 files", the watch resumes',
      seen !== null && c.ret === true && JSON.stringify(c.scans) === JSON.stringify(['codex']) && c.localScans.length === 0 && c.codexLabel === '6 files · via collector' && c.codexFiles === 6 && c.collectorLabel === '3 tools · 10 files'
      && c.e2e.n === 1 && c.e2e.in === 40 && c.e2e.out === 7 && c.e2e.msgs === 1 && after.codex.in === before.codex.in + 40 && after.codex.out === before.codex.out + 7 && after.codex.msgs === before.codex.msgs + 1
      && eq(after.local, before.local) && eq(after.copilot, before.copilot) && c.codexMoved && c.localUntouched && c.copilotUntouched && c.codexCell === '6 files' && c.watchAgain && /Connected/.test(c.statusText) && /watching for changes every 60 s/.test(c.statusText),
      `watch=${watchMode} seen=${JSON.stringify(seen)} after ${Date.now() - t0} ms / ${polls} polls · tick=${JSON.stringify(c)} · before=${JSON.stringify(before.codex)} after=${JSON.stringify(after.codex)}`);
  } catch (e) {
    ok('collector e2e: threw', false, (e && e.stack || String(e)) + (col ? ' · ' + col.io() : ''));
  } finally {
    await closeQuietly(page); await closeQuietly(page2);
    if (alt) { try { await alt.close(); } catch { /* ignore */ } }
    if (col) await col.stop();
    for (let i = 0; i < 5; i++) { try { fs.rmSync(HOME, { recursive: true, force: true }); break; } catch { await sleep(200); } }   // Windows: a just-killed child may still hold a handle for a moment
  }
}
