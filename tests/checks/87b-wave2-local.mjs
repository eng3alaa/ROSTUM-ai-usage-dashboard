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

    // ---- T5a: parsePrometheus ----
    const promText = read('wave2', 'prometheus-sample.txt');
    const pp = await page.evaluate((text) => {
      const p = parsePrometheus(text);
      return { n: p.length, names: p.map(m => m.name), v0: p[0] && p[0].value, l0: p[0] && p[0].labels.model_name, l1: p[1] && p[1].labels.model_name, v1: p[1] && p[1].value,
        plain: p[2] && p[2].value, emptyLabels: p[3] && Object.keys(p[3].labels).length, inf: !!p[4] && p[4].value === Infinity, noComments: p.every(m => m.name[0] !== '#') };
    }, promText);
    ok('parsePrometheus: HELP/TYPE/comment lines skipped, exponent values, escaped label values (\\" and \\\\), empty {} labels, +Inf, trailing timestamp + bad lines dropped',
      pp.n === 5 && pp.v0 === 1500000 && pp.l0 === 'meta-llama/Llama-3.1-8B-Instruct' && pp.l1 === 'quoted "name" \\ back' && pp.v1 === 42 && pp.plain === 7 && pp.emptyLabels === 0 && pp.inf && pp.noComments
      && JSON.stringify(pp.names) === JSON.stringify(['vllm:prompt_tokens_total', 'vllm:prompt_tokens_total', 'plain_gauge', 'empty_labels', 'weird_value']), JSON.stringify(pp));

    // ---- T5b: vLLM metrics-poll driver (validate → startPoll; deltas → today's rows; restart → baseline reset; hidden tab skips; stop/disconnect) ----
    const vA = read('wave2', 'vllm-metrics-a.txt'), vB = read('wave2', 'vllm-metrics-b.txt'), vC = read('wave2', 'vllm-metrics-c.txt'), vD = read('wave2', 'vllm-metrics-d.txt');
    const vl = await page.evaluate(async ({ A, B, C, D }) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      LS.del('poll:vllm');
      const c = connectorById('vllm');
      const origFetch = window.fetch;
      let metrics = A; const calls = [];
      window.fetch = async (url, init) => {
        const u = String(url); calls.push(u);
        if (u.endsWith('/metrics')) return new Response(metrics, { status: 200, headers: { 'content-type': 'text/plain; version=0.0.4' } });
        if (u.endsWith('/v1/models')) return new Response(JSON.stringify({ object: 'list', data: [{ id: 'meta-llama/Llama-3.1-8B-Instruct' }, { id: 'Qwen/Qwen3-8B' }] }), { status: 200 });
        throw new TypeError('Failed to fetch');
      };
      const LLAMA = 'meta-llama/Llama-3.1-8B-Instruct';
      const today = todayKey(), hour = new Date().getHours();
      const rowsOf = () => ((Store.sources.vllm || {}).rows || []);
      const sum = (f, model) => rowsOf().filter(r => !model || r.model === model).reduce((a, r) => a + (r[f] || 0), 0);
      const snap = (tag) => ({ tag, n: rowsOf().length, in: sum('in'), out: sum('out'), cr: sum('cr'), msgs: sum('msgs'), qwen: rowsOf().filter(r => r.model === 'Qwen/Qwen3-8B').length,
        baseIn: (((LS.get('poll:vllm', null) || {}).counters || {})[LLAMA] || {}).in, label: (Store.connectors.vllm || {}).label || '', status: Store.connectorStatus(c), timer: !!App._pollTimers.vllm });
      // validate (A) → startPoll → first tick (A again): baseline seeded, nothing counted yet
      await App.connectServer(c);
      const s0 = snap('A');
      const status0 = document.getElementById('vllm-status').textContent;
      // counters grew (B): exactly the deltas land in today's rows, this hour, under platform vLLM
      metrics = B; await App._pollTick(c);
      const s1 = snap('B');
      const row = rowsOf().find(r => r.model === LLAMA);
      const rowShape = row ? { d: row.d, hour: row.hour, platform: row.platform, est: !!row.est, cost: Pricing.cost(row.model, row), todayHour: row.d === todayKey() && (row.hour === hour || row.hour === new Date().getHours()) } : null;
      // server restart (C): every counter lower than the baseline → nothing negative, nothing added, baseline = the new values
      metrics = C; await App._pollTick(c);
      const s2 = snap('C');
      // growth after the restart (D): counted from the reset baseline
      metrics = D; await App._pollTick(c);
      const s3 = snap('D');
      // a hidden tab skips the tick entirely (no fetch, baseline untouched)
      const callsBefore = calls.length;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      metrics = A; await App._pollTick(c);
      delete document.hidden;   // back to the prototype getter
      const hiddenSkip = { fetched: calls.length - callsBefore, baseIn: (((LS.get('poll:vllm', null) || {}).counters || {})[LLAMA] || {}).in, n: rowsOf().length };
      // stopPoll clears the timer; startPoll restarts it (idempotent); disconnect stops the loop and forgets the baseline (rows kept: confirm → Cancel)
      metrics = D;
      App.stopPoll(c);
      const stopped = !App._pollTimers.vllm;
      await App.startPoll(c);
      const restarted = !!App._pollTimers.vllm;
      const s4 = snap('restart');   // D vs D baseline → no change
      const origConfirm = window.confirm; window.confirm = () => false;
      App.disconnectConnector('vllm');
      window.confirm = origConfirm;
      const afterDisc = { timer: !!App._pollTimers.vllm, base: LS.get('poll:vllm', null), has: !!Store.connectors.vllm, rows: rowsOf().length, text: document.getElementById('vllm-status').textContent };
      window.fetch = origFetch;
      Store.sources = {}; Store.connectors = {}; Store.persist();
      return { calls: calls.slice(0, 3), s0, status0, s1, rowShape, s2, s3, hiddenSkip, stopped, restarted, s4, afterDisc,
        kind: c.kind, cat: c.category, quality: c.quality, poll: c.poll, every: c.pollEvery, base: c.baseUrl, srcIds: c.srcIds, statusEl: c.statusEl,
        card: !!document.getElementById('src-vllm') && !!document.getElementById('vllm-url') && !!document.getElementById('vllm-validate') && !document.getElementById('vllm-pick') && /polled every 60 s/.test(document.getElementById('src-vllm').textContent),
        hub: !!document.querySelector('#accounts-hub .hub-group[data-group="local"] .acct[data-connector="vllm"]'),
        note: /while this page is open/i.test(c.qualityNote) && /restart/i.test(c.qualityNote) && /\$0/.test(c.qualityNote) && /--allowed-origins/.test(c.corsHint) };
    }, { A: vA, B: vB, C: vC, D: vD });
    ok('vllm: validate parses /metrics ("2 models"), starts the poll, first tick seeds the baseline (in=1000, no rows); grown counters → today/this-hour row with exactly the deltas (in=600 out=150 cr=30 msgs=2; no Qwen row); platform vLLM, $0, not est',
      vl.calls[0] === 'http://localhost:8000/metrics' && vl.calls[1] === 'http://localhost:8000/metrics' && /Connected/.test(vl.status0) && /2 models/.test(vl.status0)
      && vl.s0.n === 0 && vl.s0.baseIn === 1000 && vl.s0.timer && vl.s0.status === 'ok' && vl.s0.label === '2 models · counts while this page is open'
      && vl.s1.in === 600 && vl.s1.out === 150 && vl.s1.cr === 30 && vl.s1.msgs === 2 && vl.s1.qwen === 0 && vl.s1.baseIn === 1600
      && vl.rowShape && vl.rowShape.platform === 'vLLM' && vl.rowShape.todayHour && !vl.rowShape.est && vl.rowShape.cost === 0, JSON.stringify({ calls: vl.calls, s0: vl.s0, status0: vl.status0, s1: vl.s1, rowShape: vl.rowShape }));
    ok('vllm: counter reset (restart) → no negative rows, nothing added, baseline = new values (in=120); growth after the reset counts from there (totals in=700 out=180 cr=30 msgs=3); hidden tab → tick skipped (no fetch, baseline untouched)',
      vl.s2.in === 600 && vl.s2.out === 150 && vl.s2.cr === 30 && vl.s2.msgs === 2 && vl.s2.baseIn === 120
      && vl.s3.in === 700 && vl.s3.out === 180 && vl.s3.cr === 30 && vl.s3.msgs === 3 && vl.s3.baseIn === 220 && vl.s3.n >= 1 && vl.s3.n <= 2
      && vl.hiddenSkip.fetched === 0 && vl.hiddenSkip.baseIn === 220 && vl.hiddenSkip.n === vl.s3.n, JSON.stringify({ s2: vl.s2, s3: vl.s3, hiddenSkip: vl.hiddenSkip }));
    ok('vllm: stopPoll clears the timer, startPoll restarts it (no double count); disconnect stops the poll + deletes LS poll:vllm (rows kept on Cancel); registry = local-server/local/exact, poll pollVllm every 60000 ms, card note + hub card in Local group, honest note + CORS hint',
      vl.stopped && vl.restarted && vl.s4.in === 700 && vl.s4.msgs === 3 && !vl.afterDisc.timer && vl.afterDisc.base === null && !vl.afterDisc.has && vl.afterDisc.rows === vl.s3.n && /Not connected/.test(vl.afterDisc.text)
      && vl.kind === 'local-server' && vl.cat === 'local' && vl.quality === 'exact' && vl.poll === 'pollVllm' && vl.every === 60000 && vl.base === 'http://localhost:8000'
      && JSON.stringify(vl.srcIds) === JSON.stringify(['vllm']) && vl.statusEl === 'vllm-status' && vl.card && vl.hub && vl.note, JSON.stringify({ stopped: vl.stopped, restarted: vl.restarted, s4: vl.s4, afterDisc: vl.afterDisc, card: vl.card, hub: vl.hub, note: vl.note }));

    // ---- T5c: llama.cpp — counters without a model label (model from /props), validate via /props, metrics off → honest detail + answered error ----
    const lcText = read('wave2', 'llamacpp-metrics.txt');
    const lc = await page.evaluate(async (text) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; LS.del('poll:llamacpp');
      const c = connectorById('llamacpp');
      const origFetch = window.fetch;
      let metricsOn = true;
      window.fetch = async (url, init) => {
        const u = String(url);
        if (u.endsWith('/metrics')) return metricsOn ? new Response(text, { status: 200, headers: { 'content-type': 'text/plain; version=0.0.4' } }) : new Response('', { status: 404 });
        if (u.endsWith('/props')) return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 4096 }, total_slots: 1, model_path: '/models/Qwen3-8B-Q4_K_M.gguf', chat_template: '' }), { status: 200 });
        if (u.endsWith('/health')) return new Response('{"status":"ok"}', { status: 200 });
        throw new TypeError('Failed to fetch');
      };
      const p = await pollLlamaCpp('http://localhost:8080');
      await App.connectServer(c);
      const on = { counters: p.counters, label: (Store.connectors.llamacpp || {}).label || '', status: Store.connectorStatus(c), text: document.getElementById('llamacpp-status').textContent,
        baseIn: ((((LS.get('poll:llamacpp', null) || {}).counters || {})['Qwen3-8B-Q4_K_M']) || {}).in, timer: !!App._pollTimers.llamacpp };
      // --metrics off (404): validate still passes on /props, the detail says how to enable it; the poller throws an `answered` error (no CORS guess); no baseline
      App.stopPoll(c); LS.del('poll:llamacpp'); Store.connectors = {};
      metricsOn = false;
      let pollErr = null; try { await pollLlamaCpp('http://localhost:8080'); } catch (e) { pollErr = { msg: e.message, answered: !!e.answered }; }
      await App.connectServer(c);
      const off = { label: (Store.connectors.llamacpp || {}).label || '', status: Store.connectorStatus(c), text: document.getElementById('llamacpp-status').textContent, base: LS.get('poll:llamacpp', null), pollErr };
      App.stopPoll(c);
      window.fetch = origFetch;
      Store.sources = {}; Store.connectors = {}; Store.persist();
      return { on, off, kind: c.kind, cat: c.category, quality: c.quality, poll: c.poll, base: c.baseUrl, srcIds: c.srcIds, statusEl: c.statusEl,
        card: !!document.getElementById('src-llamacpp') && !!document.getElementById('llamacpp-url') && !!document.getElementById('llamacpp-validate') && !document.getElementById('llamacpp-pick'),
        cors: /--tools/.test(c.corsHint) && /--agent/.test(c.corsHint) && /--mcp-servers/.test(c.corsHint) && /localhost origins/.test(c.corsHint),
        note: /--metrics/.test(c.qualityNote) && /while this page is open/i.test(c.qualityNote) && /\/props/.test(c.qualityNote) && /\$0/.test(c.qualityNote) };
    }, lcText);
    ok('llamacpp: /metrics counters (no model label) land under the /props model_path basename (Qwen3-8B-Q4_K_M in=4321 out=876); validate labels the model, starts the poll, baseline seeded',
      JSON.stringify(lc.on.counters) === JSON.stringify({ 'Qwen3-8B-Q4_K_M': { in: 4321, out: 876 } }) && lc.on.label === 'Qwen3-8B-Q4_K_M · counts while this page is open' && lc.on.status === 'ok'
      && /Connected/.test(lc.on.text) && /Qwen3-8B-Q4_K_M/.test(lc.on.text) && lc.on.baseIn === 4321 && lc.on.timer, JSON.stringify(lc.on));
    ok('llamacpp: --metrics off → validate still ok via /props, detail says "--metrics", no baseline; pollLlamaCpp throws an answered "--metrics" error; registry local-server/local/exact poll pollLlamaCpp @8080; CORS hint names --tools/--agent/--mcp-servers; honest note',
      lc.off.status === 'ok' && /--metrics/.test(lc.off.text) && lc.off.base === null && lc.off.pollErr && lc.off.pollErr.answered && /--metrics/.test(lc.off.pollErr.msg)
      && lc.kind === 'local-server' && lc.cat === 'local' && lc.quality === 'exact' && lc.poll === 'pollLlamaCpp' && lc.base === 'http://localhost:8080' && JSON.stringify(lc.srcIds) === JSON.stringify(['llamacpp']) && lc.statusEl === 'llamacpp-status'
      && lc.card && lc.cors && lc.note, JSON.stringify({ off: lc.off, cors: lc.cors, note: lc.note, card: lc.card }));
  } finally {
    await page.close();
  }
}
