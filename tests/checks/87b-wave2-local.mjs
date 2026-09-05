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
    // ---- T6 (4b): GPT4All validate-only local-server ----
    const g4 = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const c = connectorById('gpt4all'); if (!c) throw new Error('no gpt4all entry');
      const origFetch = fetchJSON, origProbe = probeServer;
      window.fetchJSON = async (url) => { const u = String(url); if (u === 'http://localhost:4891/v1/models') return { object: 'list', data: [{ id: 'Llama 3 8B Instruct', object: 'model' }, { id: 'Phi-3 Mini Instruct', object: 'model' }] }; throw new Error('unexpected ' + u); };
      await App.connectServer(c);
      const up = { label: (Store.connectors.gpt4all || {}).label, status: Store.connectorStatus(c), text: document.getElementById('gpt4all-status').textContent, url: LS.get('url:gpt4all', null) };
      // server off (the default): fetch fails AND the probe fails → off, "not running", no error state
      window.fetchJSON = async () => { throw new TypeError('Failed to fetch'); };
      window.probeServer = async () => false;
      await App.connectServer(c);
      const down = { has: !!Store.connectors.gpt4all, status: Store.connectorStatus(c), text: document.getElementById('gpt4all-status').textContent };
      window.fetchJSON = origFetch; window.probeServer = origProbe;
      App.renderHub();
      const card = document.getElementById('src-gpt4all');
      const out = { up, down, kind: c.kind, cat: c.category, platform: c.platform, quality: c.quality, badge: card && card.querySelector('.badge').textContent,
        card: !!card && !!document.getElementById('gpt4all-url') && !!document.getElementById('gpt4all-validate') && !document.getElementById('gpt4all-pick') && !document.getElementById('gpt4all-scan-status'),
        hub: !!document.querySelector('#accounts-hub .hub-group[data-group="local"] .acct[data-connector="gpt4all"]'),
        note: /validate-only/i.test(c.qualityNote) && /no usage history/i.test(c.qualityNote) && /Enable Local API Server/.test(c.qualityNote) && /off by default/i.test(c.qualityNote),
        localPlatform: LOCAL_PLATFORMS.has('GPT4All') };
      Store.sources = {}; Store.connectors = {}; Store.persist();
      return out;
    });
    ok('gpt4all: validate-only local-server card (no folder UI) — stubbed GET /v1/models → "2 models", connected; URL persisted; quality badge validate-only; Local runners group',
      g4.up.label === '2 models' && g4.up.status === 'ok' && /Connected/.test(g4.up.text) && /validate-only|no usage history/i.test(g4.up.text) && g4.up.url === 'http://localhost:4891'
      && g4.kind === 'local-server' && g4.cat === 'local' && g4.platform === 'GPT4All' && g4.quality === 'validate' && g4.badge === 'validate-only' && g4.card && g4.hub && g4.note && g4.localPlatform, JSON.stringify(g4));
    ok('gpt4all: server off (default) → off / "not running", no error state', !g4.down.has && g4.down.status === 'off' && /not running/i.test(g4.down.text), JSON.stringify(g4.down));

    // ---- T6 (4b): Jan — threads folder-log (estimated) + Local API Server validate ----
    const janA = read('wave2', 'jan', 'threads', 't1', 'messages.jsonl'), janB = read('wave2', 'jan', 'threads', 't2', 'messages.jsonl'), janT = read('wave2', 'jan', 'threads', 't1', 'thread.json');
    const jn = await page.evaluate(async (a, b, tj) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const c = connectorById('jan'); if (!c) throw new Error('no jan entry');
      const mk = () => [
        { path: 'threads/t1/messages.jsonl', file: new File([a], 'messages.jsonl') },
        { path: 'threads/t1/thread.json', file: new File([tj], 'thread.json') },
        { path: 'threads/t2/messages.jsonl', file: new File([b], 'messages.jsonl') },
      ];
      // parser directly: per-row shape
      const res = await parseJanThreads(mk(), null, new Set(), c);
      const t = res.rows.reduce((x, r) => ({ in: x.in + r.in, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, out: 0, msgs: 0 });
      const byModel = Object.fromEntries(res.rows.map(r => [r.model, r]));
      const exp = { 'llama3.2-3b-instruct': dayKey(new Date('2026-08-10T09:00:00.000Z')), 'qwen3-4b': dayKey(new Date(1786396200 * 1000)), jan: dayKey(new Date('2026-08-12T09:00:00.000Z')) };
      const daysOk = Object.entries(exp).every(([m, d]) => byModel[m] && byModel[m].d === d);
      // card copy before any scan (dual-driver card: server line + folder line)
      const pickText = document.getElementById('jan-pick').textContent, scanDefault = document.getElementById('jan-scan-status').textContent;
      // through the card: scanFiles routes messages.jsonl by pattern, lands rows under 'jan'
      await App.scanFiles(c, mk());
      const src = Store.sources.jan;
      const scanned = { in: src ? src.rows.reduce((x, r) => x + r.in, 0) : 0, label: (Store.connectors.jan || {}).label, status: Store.connectorStatus(c), text: document.getElementById('jan-scan-status').textContent,
        cost: src ? src.rows.map(r => Pricing.cost(r.model, r)) : null };
      // server half: stubbed GET /v1/models
      const origFetch = fetchJSON, origProbe = probeServer;
      window.fetchJSON = async (url) => { const u = String(url); if (u === 'http://127.0.0.1:1337/v1/models') return { object: 'list', data: [{ id: 'llama3.2-3b-instruct' }, { id: 'qwen3-4b' }, { id: 'gemma-3-4b-it' }] }; throw new Error('unexpected ' + u); };
      await App.connectServer(c);
      const server = { label: (Store.connectors.jan || {}).label, status: Store.connectorStatus(c), text: document.getElementById('jan-status').textContent };
      window.fetchJSON = origFetch; window.probeServer = origProbe;
      App.renderHub();
      const out = { ...t, files: res.meta.files, badLines: res.meta.badLines, rows: res.rows.length, models: [...new Set(res.rows.map(r => r.model))].sort(), platform: res.rows[0].platform,
        allEst: res.rows.every(r => r.est === 1), allHour: res.rows.every(r => r.hour != null), byModel: { llama: byModel['llama3.2-3b-instruct'], qwen: byModel['qwen3-4b'], jan: byModel.jan }, daysOk,
        pickText, scanDefault, scanned, server, kind: c.kind, cat: c.category, quality: c.quality, hint: c.hint, badge: document.querySelector('#src-jan .badge').textContent,
        card: !!document.getElementById('src-jan') && !!document.getElementById('jan-url') && !!document.getElementById('jan-validate') && !!document.getElementById('jan-pick') && !!document.getElementById('jan-scan-status'),
        hub: !!document.querySelector('#accounts-hub .hub-group[data-group="local"] .acct[data-connector="jan"]'),
        note: /^Estimated/.test(c.qualityNote) && /tokenCount/.test(c.qualityNote) && /messages\.jsonl/.test(c.qualityNote) && /est\./.test(c.qualityNote) };
      Store.sources = {}; Store.connectors = {}; Store.persist();
      return out;
    }, janA, janB, janT);
    ok('jan: threads/*/messages.jsonl → est. in=18 out=88 msgs=3 (tokenCount wins for output, both metadata shapes; input = previous user text); files=2 badLines=1; model from message.model.id / metadata.model / "jan"; day from created_at (ms) and created (s); hours present',
      jn.in === 18 && jn.out === 88 && jn.msgs === 3 && jn.files === 2 && jn.badLines === 1 && jn.rows === 3 && JSON.stringify(jn.models) === JSON.stringify(['jan', 'llama3.2-3b-instruct', 'qwen3-4b']) && jn.platform === 'Jan'
      && jn.allEst && jn.allHour && jn.daysOk && jn.byModel.llama.in === 10 && jn.byModel.llama.out === 30 && jn.byModel.qwen.in === 6 && jn.byModel.qwen.out === 13 && jn.byModel.jan.in === 2 && jn.byModel.jan.out === 45, JSON.stringify(jn));
    ok('jan: one dual-driver card (folder "Jan data" + server) — scanFiles lands 18 input tokens under jan (2 files, $0 rows), stubbed /v1/models → "3 models"; estimated badge; honest note; Local runners group',
      jn.kind === 'local-server' && jn.cat === 'local' && jn.quality === 'estimated' && jn.badge === 'estimated' && jn.card && jn.hub && jn.note && /messages\.jsonl/.test(jn.hint)
      && jn.pickText === 'Choose Jan data folder…' && jn.scanDefault === 'No Jan data folder chosen.'
      && jn.scanned.in === 18 && jn.scanned.label === '2 files' && jn.scanned.status === 'ok' && /Connected/.test(jn.scanned.text) && /3 messages/.test(jn.scanned.text) && /1 unreadable/.test(jn.scanned.text) && Array.isArray(jn.scanned.cost) && jn.scanned.cost.every(x => x === 0)
      && jn.server.label === '3 models · 2 files' && jn.server.status === 'ok' && /Connected/.test(jn.server.text) && /no usage history/i.test(jn.server.text), JSON.stringify(jn));

    // ---- T6 (4b): text-generation-webui — logs folder-log (estimated) + API validate (CORS-blocked from file:// without --listen) ----
    const tgA = read('wave2', 'tgwebui', 'user_data', 'logs', 'chat', 'Assistant', '20260810-09-12-33.json'), tgBad = read('wave2', 'tgwebui', 'user_data', 'logs', 'chat', 'Assistant', 'bad.json'),
      tgI = read('wave2', 'tgwebui', 'user_data', 'logs', 'instruct', '20260811-10-00-00.json'), tgS = read('wave2', 'tgwebui', 'user_data', 'logs', 'chat_state.json');
    const tg = await page.evaluate(async (a, bad, inst, st) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const c = connectorById('tgwebui'); if (!c) throw new Error('no tgwebui entry');
      const mk = () => [
        { path: 'user_data/logs/chat/Assistant/20260810-09-12-33.json', file: new File([a], '20260810-09-12-33.json') },
        { path: 'user_data/logs/chat/Assistant/bad.json', file: new File([bad], 'bad.json') },
        { path: 'user_data/logs/instruct/20260811-10-00-00.json', file: new File([inst], '20260811-10-00-00.json') },
        { path: 'user_data/logs/chat_state.json', file: new File([st], 'chat_state.json') },   // not matched by the pattern
      ];
      const res = await parseTgwebuiLogs(mk(), null, new Set(), c);
      const t = res.rows.reduce((x, r) => ({ in: x.in + r.in, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, out: 0, msgs: 0 });
      const rows = res.rows.slice().sort((x, y) => x.d < y.d ? -1 : 1).map(r => ({ d: r.d, hour: r.hour, model: r.model, in: r.in, out: r.out, msgs: r.msgs, est: r.est }));
      await App.scanFiles(c, mk());
      const src = Store.sources.tgwebui;
      const scanned = { in: src ? src.rows.reduce((x, r) => x + r.in, 0) : 0, label: (Store.connectors.tgwebui || {}).label, status: Store.connectorStatus(c), text: document.getElementById('tgwebui-scan-status').textContent, cost: src ? src.rows.map(r => Pricing.cost(r.model, r)) : null };
      // server half: running without --listen → fetch is CORS-blocked (TypeError) but the no-cors probe answers → attention + the --listen fix
      const origFetch = fetchJSON, origProbe = probeServer;
      window.fetchJSON = async () => { throw new TypeError('Failed to fetch'); };
      window.probeServer = async () => true;
      await App.connectServer(c);
      const cors = { err: (Store.connectors.tgwebui || {}).err, status: Store.connectorStatus(c), text: document.getElementById('tgwebui-status').textContent, label: (Store.connectors.tgwebui || {}).label };
      // started with --listen: GET /v1/models works
      window.fetchJSON = async (url) => { const u = String(url); if (u === 'http://127.0.0.1:5000/v1/models') return { object: 'list', data: [{ id: 'Qwen3-8B-Q4_K_M.gguf' }] }; throw new Error('unexpected ' + u); };
      await App.connectServer(c);
      const server = { label: (Store.connectors.tgwebui || {}).label, status: Store.connectorStatus(c), text: document.getElementById('tgwebui-status').textContent };
      window.fetchJSON = origFetch; window.probeServer = origProbe;
      App.renderHub();
      const out = { ...t, files: res.meta.files, badLines: res.meta.badLines, rows, platform: res.rows[0].platform, scanned, cors, server, kind: c.kind, cat: c.category, quality: c.quality, badge: document.querySelector('#src-tgwebui .badge').textContent,
        card: !!document.getElementById('src-tgwebui') && !!document.getElementById('tgwebui-url') && !!document.getElementById('tgwebui-validate') && !!document.getElementById('tgwebui-pick') && !!document.getElementById('tgwebui-scan-status'),
        hub: !!document.querySelector('#accounts-hub .hub-group[data-group="local"] .acct[data-connector="tgwebui"]'),
        note: /^Estimated/.test(c.qualityNote) && /no token counts/i.test(c.qualityNote) && /--listen/.test(c.corsHint) && /--public-api/.test(c.corsHint) && /file:\/\//.test(c.corsHint) };
      Store.sources = {}; Store.connectors = {}; Store.persist();
      return out;
    }, tgA, tgBad, tgI, tgS);
    ok('tgwebui: logs/chat + logs/instruct history JSON → est. in=16 out=65 msgs=3 in 2 rows (greeting pair skipped; local timestamps → days 08-10/08-11, hours 9/10; model_name or "text-generation-webui"); files=3 badLines=1',
      tg.in === 16 && tg.out === 65 && tg.msgs === 3 && tg.files === 3 && tg.badLines === 1 && tg.rows.length === 2 && tg.platform === 'text-generation-webui'
      && tg.rows[0].d === '2026-08-10' && tg.rows[0].hour === 9 && tg.rows[0].model === 'Qwen3-8B-Q4_K_M.gguf' && tg.rows[0].in === 14 && tg.rows[0].out === 50 && tg.rows[0].msgs === 2 && tg.rows[0].est === 1
      && tg.rows[1].d === '2026-08-11' && tg.rows[1].hour === 10 && tg.rows[1].model === 'text-generation-webui' && tg.rows[1].in === 2 && tg.rows[1].out === 15 && tg.rows[1].est === 1, JSON.stringify(tg));
    ok('tgwebui: dual-driver card — scanFiles lands 16 input tokens under tgwebui (3 files, $0 rows); CORS-blocked API → attention with the --listen / --public-api fix; with --listen → "1 models"; estimated badge; Local runners group',
      tg.kind === 'local-server' && tg.cat === 'local' && tg.quality === 'estimated' && tg.badge === 'estimated' && tg.card && tg.hub && tg.note
      && tg.scanned.in === 16 && tg.scanned.label === '3 files' && tg.scanned.status === 'ok' && /Connected/.test(tg.scanned.text) && /3 messages/.test(tg.scanned.text) && /1 unreadable/.test(tg.scanned.text) && tg.scanned.cost.every(x => x === 0)
      && /CORS/.test(tg.cors.err || '') && tg.cors.status === 'warn' && /--listen/.test(tg.cors.text) && /--public-api/.test(tg.cors.text) && /Blocked/.test(tg.cors.text) && tg.cors.label === '3 files'
      && tg.server.label === '1 models · 3 files' && tg.server.status === 'ok' && /Connected/.test(tg.server.text), JSON.stringify(tg));

    // ---- T6 (4b): pricing — the three new local platforms are $0 by platform (LOCAL_PLATFORMS), hosted rows untouched ----
    const pz = await page.evaluate(() => {
      Pricing.load();
      const big = { in: 1_000_000, out: 1_000_000, cw: 0, cr: 0 };
      return { gpt4all: Pricing.cost('Llama 3 8B Instruct', { ...big, platform: 'GPT4All' }), jan: Pricing.cost('llama3.2-3b-instruct', { ...big, platform: 'Jan' }), tg: Pricing.cost('Qwen3-8B-Q4_K_M.gguf', { ...big, platform: 'text-generation-webui' }),
        hosted: Pricing.cost('claude-sonnet-5', { ...big, platform: 'Anthropic API' }), locals: [...LOCAL_PLATFORMS].filter(p => ['GPT4All', 'Jan', 'text-generation-webui'].includes(p)).length, order: ['GPT4All', 'Jan', 'text-generation-webui'].every(p => PLATFORM_ORDER.includes(p)) };
    });
    ok('pricing: GPT4All / Jan / text-generation-webui rows cost $0 by platform (category local → LOCAL_PLATFORMS); PLATFORM_ORDER derives them; hosted rows still priced',
      pz.gpt4all === 0 && pz.jan === 0 && pz.tg === 0 && pz.hosted > 0 && pz.locals === 3 && pz.order, JSON.stringify(pz));

    // ---- T14 (4b): readSqliteTable + Ollama desktop db.sqlite (estimated) through the Ollama card ----
    const dbPath = path.join(OUT, 'wave2', 'ollama-app', 'db.sqlite');
    if (!fs.existsSync(dbPath)) {
      ok('ollama-db: readSqliteTable + parseOllamaFiles (fixture skipped)', true, 'node:sqlite unavailable — fixture skipped');
    } else {
      const dbBuf = fs.readFileSync(dbPath);
      const dbB64 = dbBuf.toString('base64'), pageSize = dbBuf.readUInt16BE(16) === 1 ? 65536 : dbBuf.readUInt16BE(16);
      const usageLog = read('usage-log', 'ollama-usage.jsonl');   // Plan 4a fixture: in=1060 out=370 msgs=3 (exact rows)
      const od = await page.evaluate(async (b64, logText) => {
        Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
        const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
        const t = readSqliteTable(bytes.buffer, 'messages');
        const col = (r, n) => r[t.columns.indexOf(n)];
        const byId = Object.fromEntries(t.rows.map(r => [col(r, 'id'), r]));
        let nope = '', garbage = '', worowid = '';
        try { readSqliteTable(bytes.buffer, 'nope'); } catch (e) { nope = e.message; }
        try { readSqliteTable(new TextEncoder().encode('this is not a database at all').buffer, 'messages'); } catch (e) { garbage = e.message; }
        try { readSqliteTable(bytes.buffer, 'kv'); } catch (e) { worowid = e.message; }
        const chats = readSqliteTable(bytes, 'chats');   // a Uint8Array is accepted too
        const c = connectorById('ollama');
        // parser directly
        const res = await parseOllamaFiles([{ path: 'db.sqlite', file: new File([bytes], 'db.sqlite') }], null, new Set(), c);
        const tot = res.rows.reduce((a, r) => ({ in: a.in + r.in, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, out: 0, msgs: 0 });
        const byModel = Object.fromEntries(res.rows.map(r => [r.model, { in: r.in, out: r.out, msgs: r.msgs, est: r.est, sid: r.sid, d: r.d, hour: r.hour, platform: r.platform, cost: Pricing.cost(r.model, r) }]));
        // dedupe: the same db handed in again under another path with the SAME seen set → nothing added twice
        const seen = new Set();
        await parseOllamaFiles([{ path: 'Ollama/db.sqlite', file: new File([bytes], 'db.sqlite') }], null, seen, c);
        const again = await parseOllamaFiles([{ path: 'backup/Ollama/db.sqlite', file: new File([bytes], 'db.sqlite') }], null, seen, c);
        // through the card: db.sqlite + usage-logger JSONL in ONE scan (dispatcher) → exact JSONL rows + estimated db rows under the ollama source
        await App.scanFiles(c, [{ path: 'Ollama/db.sqlite', file: new File([bytes], 'db.sqlite') }, { path: 'Ollama/ollama-usage.jsonl', file: new File([logText], 'ollama-usage.jsonl') }]);
        const src = Store.sources.ollama;
        const scanned = { n: src ? src.rows.length : 0, in: src ? src.rows.reduce((a, r) => a + r.in, 0) : 0, est: src ? src.rows.filter(r => r.est).length : 0, label: (Store.connectors.ollama || {}).label, status: Store.connectorStatus(c),
          text: document.getElementById('ollama-scan-status').textContent, pick: document.getElementById('ollama-pick').textContent };
        // a garbage db.sqlite is ONE unreadable file: the batch continues (parseFolderCached counts it as badFiles)
        await App.scanFiles(c, [{ path: 'db.sqlite', file: new File(['garbage, not sqlite'], 'db.sqlite') }, { path: 'ollama-usage.jsonl', file: new File([logText], 'ollama-usage.jsonl') }]);
        const bad = { text: document.getElementById('ollama-scan-status').textContent, in: Store.sources.ollama ? Store.sources.ollama.rows.reduce((a, r) => a + r.in, 0) : 0 };
        Store.sources = {}; Store.connectors = {}; Store.persist();
        return { columns: t.columns, n: t.rows.length, m2content: String(col(byId.m2, 'content')).length, m2thinking: String(col(byId.m2, 'thinking')).length, m2model: col(byId.m2, 'model_name'), m1cloud: col(byId.m1, 'model_cloud'), m1thinking: col(byId.m1, 'thinking'),
          nope, garbage, worowid, chats: chats.columns.join(',') + '|' + chats.rows.length + '|' + chats.rows[0][1],
          ...tot, rows: res.rows.length, files: res.meta.files, addedIds: res.meta.addedIds, byModel, expDays: { gemma: dayKey(new Date('2026-08-10T09:00:30Z')), ollama: dayKey(new Date(1786396260 * 1000)) }, againRows: again.rows.length, againIds: again.meta.addedIds.length,
          patterns: c.patterns.map(String), parser: c.parser, quality: c.quality, note: /^Exact for API traffic you log, estimated for desktop-app chats/.test(c.qualityNote) && /db\.sqlite/.test(c.qualityNote) && /keeps no usage history/.test(c.qualityNote) && /-wal/.test(c.qualityNote) && /est\./.test(c.qualityNote),
          paths: c.paths.some(p => /db\.sqlite/.test(p)), scanned, bad };
      }, dbB64, usageLog);
      ok('readSqliteTable: messages table → 4 rows with the CREATE TABLE column names; the 6000-char content (+400 thinking) comes back whole through an overflow page (page size ' + pageSize + ', max local ' + (pageSize - 35) + '); NULL/int cells typed; Uint8Array input ok',
        JSON.stringify(od.columns) === JSON.stringify(['id', 'chat_id', 'role', 'content', 'thinking', 'model_name', 'model_cloud', 'created_at', 'updated_at']) && od.n === 4 && od.m2content === 6000 && od.m2thinking === 400 && (pageSize - 35) < 6400
        && od.m2model === 'gemma3:4b' && od.m1cloud === 0 && od.m1thinking === null && od.chats === 'id,title,created_at|1|test chat', JSON.stringify({ columns: od.columns, n: od.n, m2: [od.m2content, od.m2thinking, od.m2model], m1: [od.m1cloud, od.m1thinking], chats: od.chats, pageSize }));
      ok('readSqliteTable: unknown table / not-a-database / WITHOUT ROWID → clear errors (unsupported SQLite layout for WITHOUT ROWID)',
        /table not found: nope/.test(od.nope) && /not a SQLite file/.test(od.garbage) && /unsupported SQLite layout/.test(od.worowid), JSON.stringify({ nope: od.nope, garbage: od.garbage, worowid: od.worowid }));
      ok('ollama-db: parseOllamaFiles([db.sqlite]) → 2 assistant rows, est:1, platform Ollama, $0: gemma3:4b in=estTok(40)=10 out=estTok(6000+400)=1600, "ollama" (NULL model_name) in=estTok(24)=6 out=estTok(100)=25 → in=16 out=1625 msgs=2; created_at ISO / unix-seconds text → days; dedupe ids ollama-db:<message id>',
        od.in === 16 && od.out === 1625 && od.msgs === 2 && od.rows === 2 && od.files === 1 && JSON.stringify(od.addedIds) === JSON.stringify(['ollama-db:m2', 'ollama-db:m4'])
        && od.byModel['gemma3:4b'] && od.byModel['gemma3:4b'].in === 10 && od.byModel['gemma3:4b'].out === 1600 && od.byModel['gemma3:4b'].est === 1 && od.byModel['gemma3:4b'].platform === 'Ollama' && od.byModel['gemma3:4b'].cost === 0 && od.byModel['gemma3:4b'].sid === 'ollama-db:c1' && od.byModel['gemma3:4b'].d === od.expDays.gemma && od.byModel['gemma3:4b'].hour != null
        && od.byModel.ollama && od.byModel.ollama.in === 6 && od.byModel.ollama.out === 25 && od.byModel.ollama.est === 1 && od.byModel.ollama.cost === 0 && od.byModel.ollama.d === od.expDays.ollama
        && od.againRows === 0 && od.againIds === 0, JSON.stringify({ tot: [od.in, od.out, od.msgs], rows: od.rows, byModel: od.byModel, expDays: od.expDays, addedIds: od.addedIds, again: [od.againRows, od.againIds] }));
      ok('ollama-db: the Ollama card reads db.sqlite AND usage-logger JSONL in one scan (patterns + parseOllamaFiles dispatcher): 2 files → in=1060 exact + 16 est, 2 est rows; a garbage db.sqlite is "1 file(s) unreadable" and the JSONL still lands; note leads with the mixed quality, paths name db.sqlite',
        od.patterns.length === 2 && od.patterns.some(p => /db\\\.sqlite/.test(p)) && od.parser === 'parseOllamaFiles' && od.quality === 'exact' && od.note && od.paths
        && od.scanned.label === '2 files' && od.scanned.status === 'ok' && od.scanned.in === 1076 && od.scanned.est === 2 && /Connected/.test(od.scanned.text) && /5 messages/.test(od.scanned.text) && /1 unreadable line/.test(od.scanned.text) && od.scanned.pick === 'Choose usage-log or Ollama data folder…'
        && /1 file\(s\) unreadable/.test(od.bad.text) && od.bad.in === 1060, JSON.stringify({ patterns: od.patterns, parser: od.parser, scanned: od.scanned, bad: od.bad }));
    }
  } finally {
    await page.close();
  }
}
