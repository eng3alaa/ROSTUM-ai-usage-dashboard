import fs from 'node:fs';
import path from 'node:path';
import { openDashboard, OUT } from '../lib/harness.mjs';

const read = (...p) => fs.readFileSync(path.join(OUT, ...p), 'utf8');

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    // ---- T4: LocalAI history through the connectServer rows extension ----
    // fetch is stubbed (not fetchJSON): validateLocalAI reads the HTTP status itself (503 = stats disabled) and probeServer uses fetch too.
    const localaiText = read('wave2', 'localai-usage.json');
    const la = await page.evaluate(async (text) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const c = connectorById('localai');
      const origFetch = window.fetch;
      const calls = [];
      window.fetch = async (url, init) => { calls.push(String(url)); return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } }); };
      // earlier syncs: a day OLDER than the fresh payload (kept — LocalAI's ring buffer forgets it on restart) and a day the payload covers (replaced, never doubled)
      Store.setSource('localai', [
        { d: '2026-08-01', platform: 'LocalAI', model: 'llama-3.2-3b', in: 7, cw: 0, cr: 0, out: 3, msgs: 1 },
        { d: '2026-08-10', platform: 'LocalAI', model: 'llama-3.2-3b', in: 99999, cw: 0, cr: 0, out: 99999, msgs: 99 },
      ], {});
      await App.connectServer(c);
      App._render();
      const rows = (Store.sources.localai || {}).rows || [];
      const sum = (f, pred) => rows.filter(pred || (() => true)).reduce((a, r) => a + (r[f] || 0), 0);
      const st = Store.connectors.localai || {};
      // expected: 4 fresh rows (in 1720 / out 415 / msgs 7) + the kept 2026-08-01 row (in 7 / out 3 / msgs 1) = 5 rows, in 1727, out 418, msgs 8
      const okState = { calls, label: st.label, status: Store.connectorStatus(c), text: document.getElementById('localai-status').textContent, url: LS.get('url:localai', null),
        n: rows.length, in: sum('in'), out: sum('out'), msgs: sum('msgs'), est: rows.some(r => r.est),
        old: sum('in', r => r.d === '2026-08-01'), aug10llama: sum('in', r => r.d === '2026-08-10' && r.model === 'llama-3.2-3b'),
        aug11qwen: { in: sum('in', r => r.d === '2026-08-11' && r.model === 'qwen3-8b'), out: sum('out', r => r.d === '2026-08-11' && r.model === 'qwen3-8b') },
        platforms: [...new Set(rows.map(r => r.platform))], cost: rows.reduce((a, r) => a + Pricing.cost(r.model, r), 0),
        cardShown: document.getElementById('src-localai').hidden === false,
        hub: !!document.querySelector('#accounts-hub .hub-group[data-group="local"] .acct[data-connector="localai"]') };
      // 503 = stats disabled: the server ANSWERED, so this is not a CORS guess — the card shows LocalAI's own message; stored rows stay
      window.fetch = async () => new Response('{"error":"usage stats are disabled"}', { status: 503 });
      await App.connectServer(c);
      const disabled = { err: (Store.connectors.localai || {}).err || null, status: Store.connectorStatus(c), text: document.getElementById('localai-status').textContent, rowsKept: ((Store.sources.localai || {}).rows || []).length };
      // CORS-blocked: the validator's fetch throws TypeError, the no-cors probe (also fetch) succeeds → attention + the LocalAI CORS fix
      window.fetch = async (url, init) => { if (init && init.mode === 'no-cors') return new Response('', { status: 200 }); throw new TypeError('Failed to fetch'); };
      await App.connectServer(c);
      const cors = { err: (Store.connectors.localai || {}).err || null, status: Store.connectorStatus(c), text: document.getElementById('localai-status').textContent };
      // not running: every fetch fails → off (not an error state); the stored rows are kept
      window.fetch = async () => { throw new TypeError('Failed to fetch'); };
      await App.connectServer(c);
      const down = { has: !!Store.connectors.localai, status: Store.connectorStatus(c), text: document.getElementById('localai-status').textContent, rowsKept: ((Store.sources.localai || {}).rows || []).length };
      window.fetch = origFetch;
      Store.sources = {}; Store.connectors = {}; Store.persist();
      return { okState, disabled, cors, down, kind: c.kind, cat: c.category, quality: c.quality, srcIds: c.srcIds, statusEl: c.statusEl, base: c.baseUrl, hasPoll: !!c.poll,
        card: !!document.getElementById('src-localai') && !!document.getElementById('localai-url') && !!document.getElementById('localai-validate') && !document.getElementById('localai-pick'),
        note: /--disable-stats/.test(c.qualityNote) && /restart/i.test(c.qualityNote) && /--auth/.test(c.qualityNote) && /\$0/.test(c.qualityNote) && /cors-allow-origins/.test(c.corsHint) };
    }, localaiText);
    ok('localai: /api/usage?period=all → exact rows under the localai source (5 rows: in=1727 out=418 msgs=8; fresh day replaced, older day kept, garbage count → 0); label "history: 4 buckets"; URL persisted',
      la.okState.calls[0] === 'http://localhost:8080/api/usage?period=all' && la.okState.label === 'history: 4 buckets' && la.okState.status === 'ok'
      && /Connected/.test(la.okState.text) && /4 usage buckets/.test(la.okState.text) && /1,720 in \/ 415 out/.test(la.okState.text) && /2 models/.test(la.okState.text) && /1 older row kept/.test(la.okState.text)
      && la.okState.url === 'http://localhost:8080' && la.okState.n === 5 && la.okState.in === 1727 && la.okState.out === 418 && la.okState.msgs === 8 && !la.okState.est
      && la.okState.old === 7 && la.okState.aug10llama === 1200 && la.okState.aug11qwen.in === 0 && la.okState.aug11qwen.out === 5, JSON.stringify(la.okState));
    ok('localai: registry = local-server / local / exact, srcIds [localai], no folder half, no poll; rows are LocalAI platform priced $0; card + hub card in the Local group; honest note (ring buffer, --auth, --disable-stats, CORS hint)',
      la.kind === 'local-server' && la.cat === 'local' && la.quality === 'exact' && JSON.stringify(la.srcIds) === JSON.stringify(['localai']) && la.statusEl === 'localai-status' && la.base === 'http://localhost:8080' && !la.hasPoll
      && la.card && la.note && la.okState.platforms.length === 1 && la.okState.platforms[0] === 'LocalAI' && la.okState.cost === 0 && la.okState.cardShown && la.okState.hub, JSON.stringify(la));
    ok('localai: 503 → "Server answered … --disable-stats" (attention, not CORS, rows kept); CORS-blocked → attention with the LocalAI CORS fix; unreachable → off, rows kept',
      /503/.test(la.disabled.err || '') && /disable-stats/.test(la.disabled.err || '') && la.disabled.status === 'warn' && /Server answered:/.test(la.disabled.text) && !/CORS/.test(la.disabled.text) && la.disabled.rowsKept === 5
      && /CORS/.test(la.cors.err || '') && la.cors.status === 'warn' && /cors-allow-origins/.test(la.cors.text)
      && !la.down.has && la.down.status === 'off' && /not running/i.test(la.down.text) && la.down.rowsKept === 5, JSON.stringify({ disabled: la.disabled, cors: la.cors, down: la.down }));
  } finally {
    await page.close();
  }
}
