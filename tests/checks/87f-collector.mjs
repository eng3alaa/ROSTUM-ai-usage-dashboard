import fs from 'node:fs';
import path from 'node:path';
import { openDashboard, OUT } from '../lib/harness.mjs';

// Plan 7 T2: the local collector card. window.fetch is stubbed INSIDE the page to serve /api/status, /api/list and /api/file from the
// existing fixture texts (Claude jsonl + Codex rollouts + Copilot CLI events); every request's Authorization header is recorded.
// Expected totals are the folder-scan numbers already asserted in 10-baseline (sess-aaa 110/25/50/220/2) and 87-folder-logs
// (codex abc 200/200/130/3, resumed 700/300/150/4, oss session local:1; copilot-cli 2150/100/900/500/5).
const read = (...p) => fs.readFileSync(path.join(OUT, ...p), 'utf8');
const BASE = 'http://127.0.0.1:11436';
const NOT_RUNNING = 'Not running at http://127.0.0.1:11436 — start it with: node docs/tools/ai-usage-collector.mjs';

export async function run({ browser, ok }) {
  const { page, errors } = await openDashboard(browser);
  try {
    const fx = {
      local: {
        'projects/-D--proj1/sess-aaa.jsonl': read('claude-logs', 'projects', '-D--proj1', 'sess-aaa.jsonl'),
        'projects/-D--proj2/sess-hours.jsonl': read('claude-logs', 'projects', '-D--proj2', 'sess-hours.jsonl'),
        'todos/agent-1.jsonl': '{"type":"assistant","message":{"usage":{"input_tokens":999},"model":"x","id":"m"}}\n',   // excluded dir — never read
        'settings.json': '{}',                                                                                            // not a pattern match
      },
      codex: {
        'sessions/2026/08/10/rollout-2026-08-10T09-00-00-abc.jsonl': read('codex', 'sessions', '2026', '08', '10', 'rollout-2026-08-10T09-00-00-abc.jsonl'),
        'sessions/2026/08/11/rollout-2026-08-11T08-00-00-abc-resumed.jsonl': read('codex', 'sessions', '2026', '08', '11', 'rollout-2026-08-11T08-00-00-abc-resumed.jsonl'),
        'sessions/2026/08/12/rollout-2026-08-12T09-00-00-oss.jsonl': read('codex', 'sessions', '2026', '08', '12', 'rollout-2026-08-12T09-00-00-oss.jsonl'),
        'sessions/2026/08/12/rollout-2026-08-12T10-00-00-named.jsonl': read('codex', 'sessions', '2026', '08', '12', 'rollout-2026-08-12T10-00-00-named.jsonl'),
        'config.toml': 'model = "x"\n',
      },
      'copilot-cli': {
        'session-state/sess-1/events.jsonl': read('copilot', 'session-state', 'sess-1', 'events.jsonl'),
        'session-state/sess-2/events.jsonl': read('copilot', 'session-state', 'sess-2', 'events.jsonl'),
        'config.json': '{}',
      },
      continue: { 'README.md': '# nothing to read here\n' },   // found, but no tokensGenerated.jsonl → "found, nothing to read"
      // cline: absent → reported as not found
    };

    // one stub factory per page: serves the fixture tree for a given token, records every request { path, auth }
    await page.evaluate(() => {
      window.__collectorStub = (fx, opts = {}) => {
        const reqs = [];
        const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
        const meta = { local: { name: 'Claude Code / Desktop', roots: ['/home/t/.claude'] }, codex: { name: 'OpenAI Codex CLI', roots: ['/home/t/.codex'] },
          'copilot-cli': { name: 'GitHub Copilot CLI', roots: ['/home/t/.copilot'] }, continue: { name: 'Continue.dev', roots: ['/home/t/.continue'] },
          cline: { name: 'Cline', roots: ['/home/t/.vscode/globalStorage/saoudrizwan.claude-dev'] } };
        window.fetch = async (url, init) => {
          const u = new URL(String(url));
          const h = init && init.headers;
          const auth = h ? (typeof h.get === 'function' ? h.get('Authorization') : (h.Authorization || h.authorization || null)) : null;
          reqs.push({ path: u.pathname + u.search, auth, origin: u.origin });
          if (opts.down) throw new TypeError('Failed to fetch');
          if (!u.pathname.startsWith('/api/')) return new Response('nope', { status: 404 });
          if (opts.reject401 || auth !== 'Bearer ' + opts.token) return json({ error: 'unauthorized' }, 401);
          if (u.pathname === '/api/status') return json({ version: '7', home: '/home/t', os: 'test', startedAt: 1, tools: Object.entries(meta).map(([id, m]) => {
            const files = fx[id], found = !!files;
            return { id, name: m.name, roots: m.roots, found, files: found ? Object.keys(files).length : 0, bytes: 0, newestMtime: found ? 1755000000000 : 0, scannedAt: 1 };
          }) });
          if (u.pathname === '/api/list') {
            const id = u.searchParams.get('tool'), files = fx[id];
            if (!files) return json({ error: 'unknown tool' }, 404);
            return json({ tool: id, root: meta[id].roots[0], files: Object.entries(files).map(([p, text]) => ({ path: p, size: new TextEncoder().encode(text).length, mtime: 1755000000000 })) });
          }
          if (u.pathname === '/api/file') {
            const id = u.searchParams.get('tool'), p = u.searchParams.get('path');
            const text = fx[id] && fx[id][p];
            if (text == null) return new Response('missing', { status: 404, statusText: 'Not Found' });
            return new Response(text, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
          }
          return new Response('nope', { status: 404 });
        };
        return reqs;
      };
      window.__sum = (rows) => rows.reduce((a, r) => ({ in: a.in + (r.in || 0), cw: a.cw + (r.cw || 0), cr: a.cr + (r.cr || 0), out: a.out + (r.out || 0), msgs: a.msgs + (r.msgs || 0) }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });
    });
    const eq = (a, b) => !!a && !!b && a.in === b.in && a.cw === b.cw && a.cr === b.cr && a.out === b.out && a.msgs === b.msgs;
    const is = (t, i, cw, cr, o, m) => !!t && t.in === i && t.cw === cw && t.cr === cr && t.out === o && t.msgs === m;

    // ---- registry + card ----
    const reg = await page.evaluate(() => {
      const c = connectorById('collector');
      if (!c) return { hasEntry: false };
      const key = document.getElementById('collector-key'), rem = document.getElementById('remember-collector'), url = document.getElementById('collector-url');
      return { hasEntry: true, first: CONNECTORS[0].id, kind: c.kind, platform: c.platform, category: c.category, name: c.name, baseUrl: c.baseUrl, keyLS: c.keyLS, keyLabel: c.keyLabel, keyHint: c.keyHint,
        quality: c.quality, noteLen: (c.qualityNote || '').length, noteOk: /token/i.test(c.qualityNote || '') && /never leaves|nothing leaves|stays on this machine/i.test(c.qualityNote || '') && /own browser storage|separate/i.test(c.qualityNote || ''),
        paths: c.paths, docs: c.links && c.links.docs, srcIds: c.srcIds, statusEl: c.statusEl,
        dom: { key: !!key && key.type === 'password' && key.autocomplete === 'off', rem: !!rem && rem.type === 'checkbox', url: url && url.value, validate: !!document.getElementById('collector-validate'),
          status: (document.getElementById('collector-status') || {}).textContent, table: !!document.getElementById('collector-tools') && document.getElementById('collector-tools').tagName === 'TABLE',
          card: !!document.getElementById('src-collector') && document.getElementById('src-collector').classList.contains('generic') && document.getElementById('src-collector').hidden === true },
        hubFirst: (() => { Store.connectors = {}; App.renderHub(); return [...document.querySelectorAll('#accounts-hub .hub-group[data-group="coding"] .acct')].map(x => x.dataset.connector)[0]; })(),
        hubActions: [...document.querySelectorAll('#accounts-hub .acct[data-connector="collector"] .acct-actions button')].map(b => b.textContent),
        hubStats: (document.querySelector('#accounts-hub .acct[data-connector="collector"] .acct-stats') || {}).textContent };
    });
    ok('collector: registry entry — id collector, kind collector, platform null, coding, "Local collector (automatic)", baseUrl 127.0.0.1:11436, keyLS key:collector, "Collector token" + printed-by hint, exact, honest note (token-gated, data stays on the machine, separate storage), paths (command + token file), links.docs README anchor, srcIds [], FIRST registry entry',
      reg.hasEntry && reg.first === 'collector' && reg.kind === 'collector' && reg.platform === null && reg.category === 'coding' && reg.name === 'Local collector (automatic)' && reg.baseUrl === BASE
      && reg.keyLS === 'key:collector' && reg.keyLabel === 'Collector token' && reg.keyHint === 'printed by: node docs/tools/ai-usage-collector.mjs' && reg.quality === 'exact' && reg.noteLen >= 80 && reg.noteOk
      && Array.isArray(reg.paths) && reg.paths.some(p => /ai-usage-collector\.mjs/.test(p)) && reg.paths.some(p => /collector\.token/.test(p)) && reg.docs === 'README.md#automatic-mode'
      && Array.isArray(reg.srcIds) && reg.srcIds.length === 0 && reg.statusEl === 'collector-status', JSON.stringify(reg));
    ok('collector: ensureSourceCard renders the card at init — #collector-url (base URL), #collector-key (password, autocomplete off) + #remember-collector, #collector-validate, #collector-status "Not connected.", empty <table id="collector-tools">; hidden generic card; hub: first Coding card, Connect only while off, empty stats line',
      reg.hasEntry && reg.dom && reg.dom.key && reg.dom.rem && reg.dom.url === BASE && reg.dom.validate && reg.dom.status === 'Not connected.' && reg.dom.table && reg.dom.card
      && reg.hubFirst === 'collector' && JSON.stringify(reg.hubActions) === JSON.stringify(['Connect']) && reg.hubStats === '', JSON.stringify(reg.dom) + ' hub=' + JSON.stringify({ first: reg.hubFirst, actions: reg.hubActions, stats: reg.hubStats }));

    // ---- (a) connect: tools land under their own connectors, via collector ----
    const a = await page.evaluate(async (fx) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.projectsBy = {}; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const c = connectorById('collector'); if (!c) return { hasEntry: false };
      const origFetch = window.fetch;
      const reqs = window.__collectorStub(fx, { token: 'tok-abc' });
      try {
        const key = document.getElementById('collector-key'), rem = document.getElementById('remember-collector');
        key.value = 'tok-abc'; rem.checked = false;
        const ret = await App.connectCollector(c);
        const src = (id) => ((Store.sources[id] || {}).rows) || [];
        const meta = (id) => (Store.sources[id] || {}).meta || {};
        const oss = src('codex').filter(r => r.sid === 'rollout-2026-08-12T09-00-00-oss');
        const out = { hasEntry: true, ret,
          local: __sum(src('local')), localAaa: __sum(src('local').filter(r => r.sid === 'sess-aaa')), localFiles: meta('local').files, projects: (Store.projects || []).length,
          codex: __sum(src('codex')), codexAbc: __sum(src('codex').filter(r => r.sid === 'rollout-2026-08-10T09-00-00-abc')), codexResumed: __sum(src('codex').filter(r => r.sid === 'rollout-2026-08-11T08-00-00-abc-resumed')),
          codexOssLocal: oss.length > 0 && oss.every(r => r.local === 1), codexFiles: meta('codex').files, codexProjects: (Store.projectsBy.codex || []).length,
          copilot: __sum(src('copilot-cli')), copilotFiles: meta('copilot-cli').files,
          labels: Object.fromEntries(['local', 'codex', 'copilot-cli', 'continue', 'cline', 'collector'].map(id => [id, Store.connectors[id] ? Store.connectors[id].label : null])),
          errs: Object.fromEntries(['local', 'codex', 'copilot-cli', 'collector'].map(id => [id, Store.connectors[id] ? Store.connectors[id].err : undefined])),
          status: Store.connectorStatus(c), statusText: document.getElementById('collector-status').textContent, statusGen: document.getElementById('collector-status').dataset.gen || '',
          localStatus: document.getElementById('local-status').textContent, codexStatus: (document.getElementById('codex-status') || {}).textContent,
          tableRows: [...document.querySelectorAll('#collector-tools tbody tr')].map(tr => [...tr.children].map(td => td.textContent)),
          tableHead: [...document.querySelectorAll('#collector-tools thead th')].map(th => th.textContent),
          reqs: reqs.map(r => r.path), allBearer: reqs.length > 0 && reqs.every(r => r.auth === 'Bearer tok-abc' && r.origin === 'http://127.0.0.1:11436'),
          remembered: LS.get('key:collector', null), url: LS.get('url:collector', null), tokenInDom: document.documentElement.outerHTML.includes('tok-abc'),
        };
        App.renderHub();
        out.hub = [...document.querySelectorAll('#accounts-hub .hub-group[data-group="coding"] .acct')].map(x => x.dataset.connector);
        out.hubActions = [...document.querySelectorAll('#accounts-hub .acct[data-connector="collector"] .acct-actions button')].map(b => b.textContent);
        out.hubLabel = document.querySelector('#accounts-hub .acct[data-connector="collector"] .acct-label').textContent;
        out.hubStats = document.querySelector('#accounts-hub .acct[data-connector="collector"] .acct-stats').textContent;
        out.cardShown = document.getElementById('src-collector').hidden === false && document.getElementById('src-codex').hidden === false;
        // folder-scan cross-check: the same texts as File objects through the folder path → identical totals for every file (oss/named included)
        const asFiles = (id) => Object.entries(fx[id]).map(([p, text]) => ({ path: p, file: new File([text], p.split('/').pop(), { lastModified: 1755000000000 }) }));
        out.refCodex = __sum((await parseFolderCached(connectorById('codex'), asFiles('codex'), null, new Map())).rows);
        out.refLocal = __sum((await parseClaudeLogsCached(asFiles('local'), null, new Map())).rows);
        out.refCopilot = __sum((await parseFolderCached(connectorById('copilot-cli'), asFiles('copilot-cli'), null, new Map())).rows);
        return out;
      } finally { window.fetch = origFetch; }
    }, fx);
    ok('collector (a): Claude Code lands under local through scanLocalFiles — sess-aaa 110/25/50/220/2 (10-baseline), 5 msgs over 2 log files (todos/ excluded), projects filled, totals equal a direct folder scan',
      a.hasEntry && a.ret === true && is(a.localAaa, 110, 25, 50, 220, 2) && a.local.msgs === 5 && a.localFiles === 2 && a.projects > 0 && eq(a.local, a.refLocal), JSON.stringify({ local: a.local, aaa: a.localAaa, files: a.localFiles, ref: a.refLocal, projects: a.projects }));
    ok('collector (a): Codex lands under codex through scanFiles — abc 200/200/130/3 + resumed 700/300/150/4 (87-folder-logs), oss session local:1, 4 rollouts (config.toml ignored), project rows stored, totals equal a direct folder scan',
      a.hasEntry && is(a.codexAbc, 200, 0, 200, 130, 3) && is(a.codexResumed, 700, 0, 300, 150, 4) && a.codexOssLocal && a.codexFiles === 4 && a.codexProjects > 0 && eq(a.codex, a.refCodex), JSON.stringify({ codex: a.codex, abc: a.codexAbc, resumed: a.codexResumed, oss: a.codexOssLocal, files: a.codexFiles, ref: a.refCodex }));
    ok('collector (a): Copilot CLI lands under copilot-cli — in=2150 cw=100 cr=900 out=500 msgs=5 (87-folder-logs), 2 event files (config.json ignored), totals equal a direct folder scan',
      a.hasEntry && is(a.copilot, 2150, 100, 900, 500, 5) && a.copilotFiles === 2 && eq(a.copilot, a.refCopilot), JSON.stringify({ copilot: a.copilot, files: a.copilotFiles, ref: a.refCopilot }));
    ok('collector (a): tool entries read "N files · via collector" (local: "2 log files · via collector"; codex "4 files · via collector"; copilot-cli "2 files · via collector"), no errs; continue / cline get NO entry; collector entry "3 tools · 8 files", ok, status line names 3 tools + "found, nothing to read"',
      a.hasEntry && a.labels.local === '2 log files · via collector' && a.labels.codex === '4 files · via collector' && a.labels['copilot-cli'] === '2 files · via collector' && a.labels.continue === null && a.labels.cline === null
      && a.labels.collector === '3 tools · 8 files' && a.errs.local === null && a.errs.codex === null && a.errs['copilot-cli'] === null && a.errs.collector === null && a.status === 'ok' && a.statusGen === ''
      && /Connected/.test(a.statusText) && /3 tools/.test(a.statusText) && /8 files/.test(a.statusText) && /found, nothing to read/.test(a.statusText) && /via collector/.test(a.localStatus) && /via collector/.test(a.codexStatus),
      JSON.stringify({ labels: a.labels, errs: a.errs, status: a.status, statusText: a.statusText, localStatus: a.localStatus, codexStatus: a.codexStatus }));
    ok('collector (a): #collector-tools lists every reported tool (tool · root · files · last change): continue "found, nothing to read", cline "not found", codex "4 files"; header row present',
      a.hasEntry && a.tableHead.length === 4 && a.tableRows.length === 5 && a.tableRows.every(r => r.length === 4)
      && a.tableRows.some(r => /Continue/.test(r[0]) && r[2] === 'found, nothing to read' && /\.continue/.test(r[1]))
      && a.tableRows.some(r => /Cline/.test(r[0]) && r[2] === 'not found')
      && a.tableRows.some(r => /Codex/.test(r[0]) && r[2] === '4 files' && /\.codex/.test(r[1]) && r[3].length > 0), JSON.stringify({ head: a.tableHead, rows: a.tableRows }));
    ok('collector (a): every /api request went to the card\'s base URL with "Authorization: Bearer <token>" — 1 status, 4 lists (local, codex, copilot-cli, continue — never cline), 8 files; the token is never in the DOM, never in a URL; nothing remembered without the opt-in; URL persisted',
      a.hasEntry && a.allBearer && a.reqs.filter(p => p === '/api/status').length === 1 && a.reqs.filter(p => /^\/api\/list\?tool=/.test(p)).length === 4 && !a.reqs.some(p => /tool=cline/.test(p))
      && a.reqs.filter(p => /^\/api\/file\?/.test(p)).length === 8 && !a.reqs.some(p => /tok-abc/.test(p)) && !a.tokenInDom && a.remembered === null && a.url === BASE, JSON.stringify({ reqs: a.reqs, allBearer: a.allBearer, remembered: a.remembered, tokenInDom: a.tokenInDom }));
    ok('collector (a): hub — collector card first in the Coding group (connected), Manage / Sync / Disconnect, label "3 tools · 8 files", stats line stays empty (platform null); the collector card and the codex card are revealed',
      a.hasEntry && a.hub[0] === 'collector' && JSON.stringify(a.hubActions) === JSON.stringify(['Manage', 'Sync', 'Disconnect']) && a.hubLabel === '3 tools · 8 files' && a.hubStats === '' && a.cardShown, JSON.stringify({ hub: a.hub, actions: a.hubActions, label: a.hubLabel, stats: a.hubStats, shown: a.cardShown }));

    // ---- (b) 401 ----
    const b = await page.evaluate(async (fx) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.projectsBy = {}; Store.connectors = {};
      const c = connectorById('collector'); if (!c) return { hasEntry: false };
      const origFetch = window.fetch;
      const reqs = window.__collectorStub(fx, { token: 'tok-abc', reject401: true });
      try {
        document.getElementById('collector-key').value = 'tok-wrong';
        await App.connectCollector(c);
        return { hasEntry: true, err: (Store.connectors.collector || {}).err || null, status: Store.connectorStatus(c), statusText: document.getElementById('collector-status').textContent,
          landed: Object.keys(Store.sources), entries: Object.keys(Store.connectors), lists: reqs.filter(r => /\/api\/list/.test(r.path)).length, files: reqs.filter(r => /\/api\/file/.test(r.path)).length };
      } finally { window.fetch = origFetch; }
    }, fx);
    ok('collector (b): 401 → err "Token rejected — copy the token the collector printed" (attention), status line says so, nothing lands, no tool entry, no /api/list or /api/file',
      b.hasEntry && b.err === 'Token rejected — copy the token the collector printed' && b.status === 'warn' && /Token rejected/.test(b.statusText) && b.landed.length === 0 && JSON.stringify(b.entries) === JSON.stringify(['collector']) && b.lists === 0 && b.files === 0, JSON.stringify(b));

    // ---- (c) network failure ----
    const cc = await page.evaluate(async (fx) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.projectsBy = {}; Store.connectors = {};
      const c = connectorById('collector'); if (!c) return { hasEntry: false };
      const origFetch = window.fetch;
      window.__collectorStub(fx, { token: 'tok-abc', down: true });
      try {
        document.getElementById('collector-key').value = 'tok-abc';
        Store.setConnector('collector', { label: 'stale entry', lastSync: Date.now(), err: null });   // a previous session's entry must not survive "not running" (connectServer's rule)
        await App.connectCollector(c);
        App.renderHub();
        return { hasEntry: true, entry: Store.connectors.collector, status: Store.connectorStatus(c), statusText: document.getElementById('collector-status').textContent, landed: Object.keys(Store.sources),
          persisted: !!(((JSON.parse(localStorage.getItem('aiusage:data') || '{}')).connectors || {}).collector),
          hub: [...document.querySelectorAll('#accounts-hub .hub-group[data-group="coding"] .acct')].map(x => x.dataset.connector)[0], actions: [...document.querySelectorAll('#accounts-hub .acct[data-connector="collector"] .acct-actions button')].map(b => b.textContent) };
      } finally { window.fetch = origFetch; }
    }, fx);
    ok('collector (c): fetch rejects → status "' + NOT_RUNNING + '", NO connector state (a stale entry is deleted, not persisted), nothing lands, card off (Connect only), still first in Coding',
      cc.hasEntry && cc.statusText === NOT_RUNNING && cc.entry === undefined && cc.status === 'off' && cc.landed.length === 0 && !cc.persisted && cc.hub === 'collector' && JSON.stringify(cc.actions) === JSON.stringify(['Connect']), JSON.stringify(cc));

    // ---- (d) Remember opt-in · sync / refreshAll routing · disconnect keeps the tools ----
    const d = await page.evaluate(async (fx) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.projectsBy = {}; Store.connectors = {};
      const c = connectorById('collector'); if (!c) return { hasEntry: false };
      const origFetch = window.fetch, origConfirm = window.confirm, orig = App.connectCollector;
      let confirms = 0; window.confirm = () => { confirms++; return true; };
      window.__collectorStub(fx, { token: 'tok-abc' });
      try {
        const key = document.getElementById('collector-key'), rem = document.getElementById('remember-collector');
        key.value = 'tok-abc'; rem.checked = true;
        await App.connectCollector(c);
        const out = { hasEntry: true, remembered: LS.get('key:collector', null), entry: !!Store.connectors.collector, codexEntry: !!Store.connectors.codex };
        let calls = 0; App.connectCollector = async function (cc) { calls++; return orig.call(this, cc); };
        await App.syncConnector('collector'); out.syncCalls = calls;
        calls = 0; await App.refreshAll(); out.refreshCalls = calls;                              // connected + token at hand → re-run once
        calls = 0; key.value = ''; await App.refreshAll(); out.refreshFromLS = calls; out.refilled = key.value;   // input blank but remembered → still re-run (token restored into the input)
        App.connectCollector = orig;
        App.disconnectConnector('collector');
        out.after = { remembered: LS.get('key:collector', null), key: key.value, rem: rem.checked, entry: !!Store.connectors.collector, codexEntry: !!Store.connectors.codex, localEntry: !!Store.connectors.local,
          codexRows: ((Store.sources.codex || {}).rows || []).length, localRows: ((Store.sources.local || {}).rows || []).length, confirms, statusText: document.getElementById('collector-status').textContent,
          status: Store.connectorStatus(c), tableRows: document.querySelectorAll('#collector-tools tr').length };
        calls = 0; App.connectCollector = async function () { calls++; }; await App.refreshAll(); App.connectCollector = orig; out.refreshAfterDisconnect = calls;
        // sync with nothing at hand → the card is surfaced (modal), no network call
        calls = 0; App.connectCollector = async function () { calls++; }; App.syncConnector('collector'); App.connectCollector = orig;
        out.syncNoToken = { calls, modalOpen: document.getElementById('connector-modal').open, hosted: !!document.querySelector('#modal-body #src-collector') };
        App.closeConnectorModal();
        return out;
      } finally { window.fetch = origFetch; window.confirm = origConfirm; App.connectCollector = orig; }
    }, fx);
    ok('collector (d): token persisted ONLY with Remember (LS key:collector); syncConnector("collector") → connectCollector; refreshAll re-runs it while connected — from the input, or from the remembered token when the input is blank (input refilled)',
      d.hasEntry && d.remembered === 'tok-abc' && d.entry && d.codexEntry && d.syncCalls === 1 && d.refreshCalls === 1 && d.refreshFromLS === 1 && d.refilled === 'tok-abc', JSON.stringify(d));
    ok('collector (d): disconnect clears the token (input, Remember, LS) and the collector entry only — no confirm prompt, the tools keep their entries AND their rows, status back to "Not connected.", tools table emptied; refreshAll afterwards never calls the collector; Sync with no token opens the card instead of fetching',
      d.hasEntry && d.after && d.after.remembered === null && d.after.key === '' && d.after.rem === false && !d.after.entry && d.after.codexEntry && d.after.localEntry && d.after.codexRows > 0 && d.after.localRows > 0
      && d.after.confirms === 0 && d.after.statusText === 'Not connected.' && d.after.status === 'off' && d.after.tableRows === 0 && d.refreshAfterDisconnect === 0
      && d.syncNoToken.calls === 0 && d.syncNoToken.modalOpen === true && d.syncNoToken.hosted, JSON.stringify(d.after) + ' ' + JSON.stringify({ refreshAfter: d.refreshAfterDisconnect, syncNoToken: d.syncNoToken }));

    // ---- (e) ?token= pre-fill ----
    const e = await page.evaluate(() => {
      const key = document.getElementById('collector-key'); if (key) key.value = '';
      Store.connectors = {};
      history.replaceState(null, '', '?token=abc123');
      const before = location.search;
      const fn = typeof App._prefillCollectorToken === 'function';
      const took = fn ? App._prefillCollectorToken() : null;
      const again = fn ? App._prefillCollectorToken() : null;
      return { before, fn, took, value: key && key.value, search: location.search, hrefHasToken: /token/.test(location.href), again, valueAfter: key && key.value, entry: !!Store.connectors.collector, remembered: LS.get('key:collector', null) };
    });
    ok('collector (e): ?token=abc123 in the page URL → App._prefillCollectorToken() fills #collector-key once, strips the param from the address bar (history.replaceState), connects nothing, remembers nothing; a second call takes nothing and keeps the input',
      e.before === '?token=abc123' && e.fn && e.took === true && e.value === 'abc123' && e.search === '' && !e.hrefHasToken && e.again === false && e.valueAfter === 'abc123' && !e.entry && e.remembered === null, JSON.stringify(e));

    // ---- (f) RemoteFile unit ----
    const f = await page.evaluate(async () => {
      if (typeof RemoteFile !== 'function') return { defined: false };
      const origFetch = window.fetch;
      let fetches = 0; const seen = [];
      const chunks = ['{"a":1}\n', '{"b":', '2}\n', 'tail'];
      window.fetch = async (url, init) => {
        fetches++; seen.push({ url: String(url), auth: init && init.headers && (typeof init.headers.get === 'function' ? init.headers.get('Authorization') : init.headers.Authorization) });
        const u = new URL(String(url));
        if (u.searchParams.get('path') === 'missing.jsonl') return new Response('no', { status: 404, statusText: 'Not Found' });
        const enc = new TextEncoder(); let i = 0;
        return new Response(new ReadableStream({ pull(ctrl) { if (i < chunks.length) ctrl.enqueue(enc.encode(chunks[i++])); else ctrl.close(); } }), { status: 200 });
      };
      try {
        const rf = new RemoteFile('http://127.0.0.1:11436', 'tok-f', 'codex', { path: 'sessions/2026/08/10/rollout-x.jsonl', size: 123, mtime: 1755000000000 });
        const fields = { name: rf.name, size: rf.size, lastModified: rf.lastModified, rel: rf.webkitRelativePath };
        const fetchesAfterCtor = fetches;
        const s = rf.stream(); const isStream = s instanceof ReadableStream;
        await new Promise(r => setTimeout(r, 20));
        const fetchesAfterStream = fetches;
        const reader = s.getReader(); const got = [];
        for (;;) { const { done, value } = await reader.read(); if (done) break; got.push(new TextDecoder().decode(value)); }
        const fetchesAfterRead = fetches;
        const text = await rf.text();
        const ab = await rf.arrayBuffer();
        const lines = []; for await (const l of readLines(rf)) lines.push(l);
        let err = null; try { await new RemoteFile('http://127.0.0.1:11436', 'tok-f', 'codex', { path: 'missing.jsonl', size: 1, mtime: 1 }).stream().getReader().read(); } catch (e2) { err = e2.message || String(e2); }
        let errText = null; try { await new RemoteFile('http://127.0.0.1:11436', 'tok-f', 'codex', { path: 'missing.jsonl', size: 1, mtime: 1 }).text(); } catch (e3) { errText = e3.message || String(e3); }
        return { defined: true, fields, fetchesAfterCtor, isStream, fetchesAfterStream, fetchesAfterRead, chunks: got.length, joined: got.join(''), expected: chunks.join(''), text, abLen: ab.byteLength, lines, err, errText,
          urls: seen.map(x => x.url), auths: seen.map(x => x.auth) };
      } finally { window.fetch = origFetch; }
    });
    ok('RemoteFile (f): name = basename, size, lastModified = mtime, webkitRelativePath = rel path; stream() is a ReadableStream that fetches lazily (0 fetches after the constructor AND after stream() — the first read starts it) and delivers the exact bytes chunk by chunk; text() / arrayBuffer() / readLines() work over it',
      f.defined && f.fields.name === 'rollout-x.jsonl' && f.fields.size === 123 && f.fields.lastModified === 1755000000000 && f.fields.rel === 'sessions/2026/08/10/rollout-x.jsonl'
      && f.fetchesAfterCtor === 0 && f.isStream && f.fetchesAfterStream === 0 && f.fetchesAfterRead === 1 && f.chunks >= 2 && f.joined === f.expected && f.text === f.expected && f.abLen === new TextEncoder().encode(f.expected).length
      && JSON.stringify(f.lines) === JSON.stringify(['{"a":1}', '{"b":2}', 'tail']), JSON.stringify(f));
    ok('RemoteFile (f): GET <base>/api/file?tool=<id>&path=<rel> with "Authorization: Bearer <token>" only (token never in the URL); an HTTP error rejects the stream read and text() with the status message ("HTTP 404 …")',
      f.defined && f.urls.every(u => u.startsWith('http://127.0.0.1:11436/api/file?tool=codex&path=') && !/tok-f/.test(u)) && f.auths.every(a2 => a2 === 'Bearer tok-f') && /404/.test(f.err || '') && /404/.test(f.errText || ''), JSON.stringify({ urls: f.urls, auths: f.auths, err: f.err, errText: f.errText }));

    // ---- matcher: the collector reuses the registry's own patterns / exclude / siblings ----
    const m = await page.evaluate(() => {
      if (typeof matchConnectorFiles !== 'function') return { defined: false };
      const paths = (c, list) => matchConnectorFiles(c, list.map(p => ({ path: p, size: 1, mtime: 1 }))).map(e => e.path);
      return { defined: true,
        cline: paths(connectorById('cline'), ['tasks/1/ui_messages.json', 'tasks/1/task_metadata.json', 'tasks/1/api_conversation_history.json', 'checkpoints/x/ui_messages.json', 'node_modules/a/ui_messages.json']),
        copilot: paths(connectorById('copilot-cli'), ['session-state/s1/events.jsonl', '.junie/s/events.jsonl', 'logs/app.log']),
        local: paths(connectorById('local'), ['projects/-D--p/sess.jsonl', 'todos/t.jsonl', 'statsig/s.jsonl', 'shell-snapshots/x.jsonl', 'history.jsonl', 'settings.json']),
        codex: paths(connectorById('codex'), ['sessions/2026/08/10/rollout-a.jsonl', 'archived_sessions/2026/08/10/rollout-b.jsonl', 'sessions/2026/08/10/notes.jsonl', '.git/rollout-c.jsonl']) };
    });
    ok('matchConnectorFiles: patterns ∪ siblings (Cline ui_messages + task_metadata), exclude (Copilot CLI drops .junie/), the generic skip dirs (checkpoints/, node_modules/, .git/) and the Claude walker\'s skip dirs (todos/, statsig/, shell-snapshots/) — pure, over a flat listing',
      m.defined && JSON.stringify(m.cline) === JSON.stringify(['tasks/1/ui_messages.json', 'tasks/1/task_metadata.json']) && JSON.stringify(m.copilot) === JSON.stringify(['session-state/s1/events.jsonl'])
      && JSON.stringify(m.local) === JSON.stringify(['projects/-D--p/sess.jsonl', 'history.jsonl']) && JSON.stringify(m.codex) === JSON.stringify(['sessions/2026/08/10/rollout-a.jsonl', 'archived_sessions/2026/08/10/rollout-b.jsonl']), JSON.stringify(m));

    // ---- scanLocalFiles: the classic-chooser handler and the collector share one landing path ----
    const sl = await page.evaluate(async (text) => {
      if (typeof App.scanLocalFiles !== 'function') return { defined: false };
      Store.sources = {}; Store.projects = []; Store.connectors = {};
      const files = () => [{ path: 'projects/-D--proj1/sess-aaa.jsonl', file: new File([text], 'sess-aaa.jsonl', { lastModified: 1755000000000 }) }];
      const plain = await App.scanLocalFiles(files());
      const out = { defined: true, plain, label: Store.connectors.local.label, statusText: document.getElementById('local-status').textContent, msgs: __sum(Store.sources.local.rows).msgs, projects: Store.projects.length };
      const viaC = await App.scanLocalFiles(files(), { fromCollector: true });
      out.viaC = viaC; out.labelC = Store.connectors.local.label; out.statusC = document.getElementById('local-status').textContent;
      const empty = await App.scanLocalFiles([]);
      out.empty = empty;
      Store.sources = {}; Store.projects = []; Store.connectors = {}; Store.persist(); App._render();
      return out;
    }, fx.local['projects/-D--proj1/sess-aaa.jsonl']);
    ok('App.scanLocalFiles: extracted from the #folder-fallback handler — lands rows + projects under local (sess-aaa: 2 msgs, 2 project×model rows), label "1 log files" / status "Loaded … one-time load"; with { fromCollector: true } the label reads "1 log files · via collector" and the status says so; an empty list is a no-op',
      sl.defined && sl.plain === true && sl.label === '1 log files' && /Loaded/.test(sl.statusText) && /one-time load/.test(sl.statusText) && sl.msgs === 2 && sl.projects === 2
      && sl.viaC === true && sl.labelC === '1 log files · via collector' && /via collector/.test(sl.statusC) && !/one-time load/.test(sl.statusC) && sl.empty === undefined, JSON.stringify(sl));

    ok('collector: no page errors during the collector checks', errors.length === 0, errors.join(' | '));
  } finally {
    await page.close();
  }
}
