import fs from 'node:fs';
import path from 'node:path';
import { openDashboard, OUT } from '../lib/harness.mjs';

// Plan 7 T2: the local collector card; T3: automatic mode (the status watch, per-tool re-scan on change, Re-scan routing, restore on init). window.fetch is stubbed INSIDE the page to serve /api/status, /api/list and /api/file from the
// existing fixture texts (Claude jsonl + Codex rollouts + Copilot CLI events); every request's Authorization header is recorded.
// Expected totals are the folder-scan numbers already asserted in 10-baseline (sess-aaa 110/25/50/220/2) and 87-folder-logs
// (codex abc 200/200/130/3, resumed 700/300/150/4, oss session local:1; copilot-cli 2150/100/900/500/5).
// Plan 7 review fixes (blocks "review …"): _viaCollector needs a LANDED read (M1); refreshAll leaves collector-fed handles to the tick (m2); a tool
// disconnected while collector-fed stays out until the collector is reconnected (m3); the restored watch ticks at once (m4 — the stub is installed
// with evaluateOnNewDocument before the (w7) reload); a non-JSON 2xx is "Unexpected response … is this the collector?" and no entry (m9).
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

    // one stub factory per page: serves the fixture tree for a given token, records every request { path, auth }. installStub is a plain function so the
    // (w7) reload can register it with evaluateOnNewDocument too (review m4: the restore-time tick must meet the stub, not the real 127.0.0.1)
    const installStub = () => {
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
          if (opts.html) return new Response('<!doctype html><title>Something else</title><p>not the collector</p>', { status: 200, headers: { 'Content-Type': 'text/html' } });   // review m9: a 2xx that is not JSON
          if (!u.pathname.startsWith('/api/')) return new Response('nope', { status: 404 });
          if (opts.reject401 || auth !== 'Bearer ' + opts.token) return json({ error: 'unauthorized' }, 401);
          if (u.pathname === '/api/status') return json({ version: '7', home: '/home/t', os: 'test', startedAt: 1, tools: Object.entries(meta).map(([id, m]) => {
            const files = fx[id], found = !!files;
            return { id, name: m.name, roots: m.roots, found, files: found ? Object.keys(files).length : 0, bytes: 0, newestMtime: found ? ((opts.mtime || {})[id] || 1755000000000) : 0, scannedAt: 1 };   // opts.mtime[id]: T3's watch checks read it live
          }) });
          if (u.pathname === '/api/list') {
            const id = u.searchParams.get('tool'), files = fx[id];
            if (!files) return json({ error: 'unknown tool' }, 404);
            return json({ tool: id, root: meta[id].roots[0], files: Object.entries(files).map(([p, text]) => ({ path: p, size: new TextEncoder().encode(text).length, mtime: (opts.mtime || {})[id] || 1755000000000 })) });
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
    };
    await page.evaluate(installStub);
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
          landed: Object.keys(Store.sources), entries: Object.keys(Store.connectors), lists: reqs.filter(r => /\/api\/list/.test(r.path)).length, files: reqs.filter(r => /\/api\/file/.test(r.path)).length, watch: !!App._pollTimers.collector };
      } finally { window.fetch = origFetch; }
    }, fx);
    ok('collector (b): 401 → err "Token rejected — copy the token the collector printed" (attention), status line says so, nothing lands, no tool entry, no /api/list or /api/file, no watch started',
      b.hasEntry && b.err === 'Token rejected — copy the token the collector printed' && b.status === 'warn' && /Token rejected/.test(b.statusText) && b.landed.length === 0 && JSON.stringify(b.entries) === JSON.stringify(['collector']) && b.lists === 0 && b.files === 0 && b.watch === false, JSON.stringify(b));

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
        return { hasEntry: true, entry: Store.connectors.collector, status: Store.connectorStatus(c), statusText: document.getElementById('collector-status').textContent, landed: Object.keys(Store.sources), watch: !!App._pollTimers.collector,
          persisted: !!(((JSON.parse(localStorage.getItem('aiusage:data') || '{}')).connectors || {}).collector),
          hub: [...document.querySelectorAll('#accounts-hub .hub-group[data-group="coding"] .acct')].map(x => x.dataset.connector)[0], actions: [...document.querySelectorAll('#accounts-hub .acct[data-connector="collector"] .acct-actions button')].map(b => b.textContent) };
      } finally { window.fetch = origFetch; }
    }, fx);
    ok('collector (c): fetch rejects → status "' + NOT_RUNNING + '", NO connector state (a stale entry is deleted, not persisted), nothing lands, card off (Connect only), still first in Coding, no watch',
      cc.hasEntry && cc.statusText === NOT_RUNNING && cc.entry === undefined && cc.status === 'off' && cc.landed.length === 0 && !cc.persisted && cc.hub === 'collector' && JSON.stringify(cc.actions) === JSON.stringify(['Connect']) && cc.watch === false, JSON.stringify(cc));

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
        const origTick = App._collectorTick; let ticks = 0; App._collectorTick = async function (cc) { ticks++; };   // T3: Refresh all = one status tick, never a full reconnect
        calls = 0; await App.refreshAll(); out.refreshCalls = calls; out.refreshTicks = ticks;                              // connected + token at hand → one tick
        calls = 0; ticks = 0; key.value = ''; await App.refreshAll(); out.refreshFromLS = ticks; out.refreshFromLSConnects = calls; out.refilled = key.value;   // input blank but remembered → still ticks (token restored into the input)
        App.connectCollector = orig; App._collectorTick = origTick;
        App.disconnectConnector('collector');
        out.after = { remembered: LS.get('key:collector', null), key: key.value, rem: rem.checked, entry: !!Store.connectors.collector, codexEntry: !!Store.connectors.codex, localEntry: !!Store.connectors.local,
          codexRows: ((Store.sources.codex || {}).rows || []).length, localRows: ((Store.sources.local || {}).rows || []).length, confirms, statusText: document.getElementById('collector-status').textContent,
          status: Store.connectorStatus(c), tableRows: document.querySelectorAll('#collector-tools tr').length };
        calls = 0; App.connectCollector = async function () { calls++; }; App._collectorTick = async function () { calls++; }; await App.refreshAll(); App.connectCollector = orig; App._collectorTick = origTick; out.refreshAfterDisconnect = calls;
        // sync with nothing at hand → the card is surfaced (modal), no network call
        calls = 0; App.connectCollector = async function () { calls++; }; App.syncConnector('collector'); App.connectCollector = orig;
        out.syncNoToken = { calls, modalOpen: document.getElementById('connector-modal').open, hosted: !!document.querySelector('#modal-body #src-collector') };
        App.closeConnectorModal();
        return out;
      } finally { window.fetch = origFetch; window.confirm = origConfirm; App.connectCollector = orig; if (App.stopCollectorWatch) App.stopCollectorWatch('collector'); }
    }, fx);
    ok('collector (d): token persisted ONLY with Remember (LS key:collector); syncConnector("collector") → connectCollector (full); refreshAll runs ONE _collectorTick while connected (never connectCollector) — from the input, or from the remembered token when the input is blank (input refilled)',
      d.hasEntry && d.remembered === 'tok-abc' && d.entry && d.codexEntry && d.syncCalls === 1 && d.refreshCalls === 0 && d.refreshTicks === 1 && d.refreshFromLS === 1 && d.refreshFromLSConnects === 0 && d.refilled === 'tok-abc', JSON.stringify(d));
    ok('collector (d): disconnect clears the token (input, Remember, LS) and the collector entry only — no confirm prompt, the tools keep their entries AND their rows, status back to "Not connected.", tools table emptied; refreshAll afterwards neither connects nor ticks; Sync with no token opens the card instead of fetching',
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

    // ================= Plan 7 T3: automatic mode — the status watch =================
    const clineFx = {
      'tasks/1786352400000/ui_messages.json': read('cline', 'tasks', '1786352400000', 'ui_messages.json'),
      'tasks/1786352400000/task_metadata.json': read('cline', 'tasks', '1786352400000', 'task_metadata.json'),
      'tasks/1786352500000/ui_messages.json': read('cline', 'tasks', '1786352500000', 'ui_messages.json'),
    };
    // (w1–w5) one page state: connect (watch starts) → codex's newestMtime moves → ONE tick re-scans codex only; unchanged → no scan; hidden tab → skipped;
    // 401 / network failure on a tick → err on the collector entry only (tools intact, watch alive), the next good tick clears it; a tool that newly appears is read
    const w = await page.evaluate(async (fx, cl) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.projectsBy = {}; Store.connectors = {};
      const c = connectorById('collector'); if (!c) return { hasEntry: false };
      const missing = ['startCollectorWatch', 'stopCollectorWatch', '_collectorTick', 'rescanViaCollector'].filter(n => typeof App[n] !== 'function');
      if (missing.length) return { hasEntry: true, missing };
      const origFetch = window.fetch, origScan = App.scanFiles, origLocal = App.scanLocalFiles;
      const opts = { token: 'tok-abc', mtime: {} };
      const reqs = window.__collectorStub(fx, opts);
      const scans = [], localScans = [];
      App.scanFiles = function (cc, files, o) { scans.push(cc.id); return origScan.call(this, cc, files, o); };
      App.scanLocalFiles = function (files, o) { localScans.push('local'); return origLocal.call(this, files, o); };
      const row = (re) => [...document.querySelectorAll('#collector-tools tbody tr')].find(tr => re.test(tr.children[0].textContent));
      const line = () => document.getElementById('collector-status').textContent;
      const reset = () => { scans.length = 0; localScans.length = 0; reqs.length = 0; };
      try {
        document.getElementById('collector-key').value = 'tok-abc'; document.getElementById('remember-collector').checked = false;
        await App.connectCollector(c);
        const out = { hasEntry: true, missing: [], timer: !!App._pollTimers.collector, every: c.pollEvery || 60000, statusAfterConnect: line(), scansAtConnect: scans.slice(), localAtConnect: localScans.slice() };
        const before = { codexSync: Store.connectors.codex.lastSync, localSync: Store.connectors.local.lastSync, copilotSync: Store.connectors['copilot-cli'].lastSync,
          codexRows: __sum(Store.sources.codex.rows), codexNewest: row(/Codex/).children[3].textContent };
        await new Promise(r => setTimeout(r, 5));
        reset(); opts.mtime.codex = 1756000000000;   // only codex moved
        const ret = await App._collectorTick(c);
        Object.assign(out, { ret, scans: scans.slice(), localScans: localScans.slice(), reqs: reqs.map(r => r.path), allBearer: reqs.length > 0 && reqs.every(r => r.auth === 'Bearer tok-abc'),
          labels: { collector: Store.connectors.collector.label, codex: Store.connectors.codex.label, local: Store.connectors.local.label }, err: Store.connectors.collector.err, status: Store.connectorStatus(c), statusText: line(),
          codexRows: __sum(Store.sources.codex.rows), codexRowsBefore: before.codexRows, codexMoved: Store.connectors.codex.lastSync > before.codexSync,
          localUntouched: Store.connectors.local.lastSync === before.localSync, copilotUntouched: Store.connectors['copilot-cli'].lastSync === before.copilotSync,
          codexNewestBefore: before.codexNewest, codexNewest: row(/Codex/).children[3].textContent, codexCell: row(/Codex/).children[2].textContent, timerStill: !!App._pollTimers.collector, tokenInDom: document.documentElement.outerHTML.includes('tok-abc') });
        // (w2) unchanged
        reset();
        await App._collectorTick(c);
        out.unchanged = { scans: scans.slice(), localScans: localScans.slice(), reqs: reqs.map(r => r.path), label: Store.connectors.collector.label, statusText: line() };
        // (w3) hidden tab
        reset(); opts.mtime.codex = 1757000000000;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        try { await App._collectorTick(c); } finally { delete document.hidden; }
        out.hidden = { scans: scans.slice(), reqs: reqs.map(r => r.path), restored: document.hidden === false, label: Store.connectors.collector.label };
        // (w4) failing ticks
        reset(); opts.reject401 = true;
        await App._collectorTick(c);
        out.e401 = { err: Store.connectors.collector.err, status: Store.connectorStatus(c), statusText: line(), timer: !!App._pollTimers.collector, codexRows: __sum(Store.sources.codex.rows),
          localRows: ((Store.sources.local || {}).rows || []).length, codexLabel: Store.connectors.codex.label, codexErr: Store.connectors.codex.err, scans: scans.slice(), reqs: reqs.map(r => r.path), tableRows: document.querySelectorAll('#collector-tools tbody tr').length };
        opts.reject401 = false; opts.down = true;
        await App._collectorTick(c);
        out.down = { err: Store.connectors.collector.err, status: Store.connectorStatus(c), entry: !!Store.connectors.collector, statusText: line(), codexRows: __sum(Store.sources.codex.rows), timer: !!App._pollTimers.collector };
        opts.down = false; reset();
        await App._collectorTick(c);   // good again: err cleared; codex moved during the outage → read now
        out.recovered = { err: Store.connectors.collector.err, status: Store.connectorStatus(c), statusText: line(), scans: scans.slice(), label: Store.connectors.collector.label };
        // (w5) a tool appears
        reset(); fx.cline = cl;
        await App._collectorTick(c);
        out.appeared = { scans: scans.slice(), localScans: localScans.slice(), cline: __sum(((Store.sources.cline || {}).rows) || []), clineLabel: (Store.connectors.cline || {}).label, collectorLabel: Store.connectors.collector.label,
          reqs: reqs.map(r => r.path), clineRescan: (document.getElementById('cline-rescan') || {}).hidden, clineStatus: (document.getElementById('cline-status') || {}).textContent, clineCell: row(/Cline/).children[2].textContent };
        return out;
      } finally { window.fetch = origFetch; App.scanFiles = origScan; App.scanLocalFiles = origLocal; delete document.hidden; if (App.stopCollectorWatch) App.stopCollectorWatch(c); }
    }, fx, clineFx);
    const mtimeOk = (p) => /^\/api\/file\?tool=codex&path=/.test(p);
    ok('watch (w1): connectCollector starts the watch (App._pollTimers.collector, pollEvery 60000) and the status line says "watching for changes every 60 s"; the connect itself scanned codex + copilot-cli (scanFiles) and local (scanLocalFiles)',
      w.hasEntry && !(w.missing || []).length && w.timer && w.every === 60000 && /watching for changes every 60 s/.test(w.statusAfterConnect) && JSON.stringify(w.scansAtConnect) === JSON.stringify(['codex', 'copilot-cli']) && JSON.stringify(w.localAtConnect) === JSON.stringify(['local']),
      JSON.stringify({ missing: w.missing, timer: w.timer, every: w.every, status: w.statusAfterConnect, scans: w.scansAtConnect, local: w.localAtConnect }));
    ok('watch (w1): codex\'s newestMtime moved → ONE _collectorTick: GET /api/status (no ?refresh), /api/list?tool=codex, its 4 files — scanFiles exactly once, for codex; scanLocalFiles never; local / copilot-cli entries untouched; codex rows unchanged, its entry re-synced; collector label "3 tools · 8 files", err null, line "checked … watching"; codex table row shows the new last change; token never in the DOM',
      w.hasEntry && w.ret === true && JSON.stringify(w.scans) === JSON.stringify(['codex']) && w.localScans.length === 0 && w.reqs[0] === '/api/status' && w.reqs.filter(p => /^\/api\/status/.test(p)).length === 1 && !w.reqs.some(p => /refresh/.test(p))
      && w.reqs.filter(p => /^\/api\/list/.test(p)).length === 1 && w.reqs.includes('/api/list?tool=codex') && w.reqs.filter(mtimeOk).length === 4 && w.reqs.length === 6 && w.allBearer
      && w.labels.collector === '3 tools · 8 files' && w.labels.codex === '4 files · via collector' && w.labels.local === '2 log files · via collector' && w.err === null && w.status === 'ok' && /Connected/.test(w.statusText) && /checked/.test(w.statusText) && /watching for changes every 60 s/.test(w.statusText)
      && eq(w.codexRows, w.codexRowsBefore) && w.codexMoved && w.localUntouched && w.copilotUntouched && w.codexNewest !== w.codexNewestBefore && w.codexCell === '4 files' && w.timerStill && !w.tokenInDom,
      JSON.stringify({ ret: w.ret, scans: w.scans, local: w.localScans, reqs: w.reqs, labels: w.labels, err: w.err, status: w.status, text: w.statusText, moved: w.codexMoved, untouched: [w.localUntouched, w.copilotUntouched], newest: [w.codexNewestBefore, w.codexNewest], cell: w.codexCell }));
    ok('watch (w2): unchanged status → the tick reads /api/status only — no list, no file, no scan; label kept, line re-stamped',
      w.hasEntry && w.unchanged && w.unchanged.scans.length === 0 && w.unchanged.localScans.length === 0 && JSON.stringify(w.unchanged.reqs) === JSON.stringify(['/api/status']) && w.unchanged.label === '3 tools · 8 files' && /checked/.test(w.unchanged.statusText), JSON.stringify(w.unchanged));
    ok('watch (w3): document.hidden → the tick is skipped entirely (no request, no scan, label kept)',
      w.hasEntry && w.hidden && w.hidden.scans.length === 0 && w.hidden.reqs.length === 0 && w.hidden.restored && w.hidden.label === '3 tools · 8 files', JSON.stringify(w.hidden));
    ok('watch (w4): a 401 tick → collector err "Token rejected …" (warn), line says so, the watch keeps running, no scan; the tools\' entries, rows and table stay; a network failure likewise keeps the entry ("Not running at …", warn); the next good tick clears the err (ok, "watching") and reads codex (moved during the outage)',
      w.hasEntry && w.e401 && w.e401.err === 'Token rejected — copy the token the collector printed' && w.e401.status === 'warn' && /Token rejected/.test(w.e401.statusText) && w.e401.timer && eq(w.e401.codexRows, w.codexRows) && w.e401.localRows > 0
      && w.e401.codexLabel === '4 files · via collector' && w.e401.codexErr === null && w.e401.scans.length === 0 && JSON.stringify(w.e401.reqs) === JSON.stringify(['/api/status']) && w.e401.tableRows === 5
      && w.down && /^Not running at http:\/\/127\.0\.0\.1:11436/.test(w.down.err || '') && w.down.status === 'warn' && w.down.entry && /Not running at/.test(w.down.statusText) && eq(w.down.codexRows, w.codexRows) && w.down.timer
      && w.recovered && w.recovered.err === null && w.recovered.status === 'ok' && /Connected/.test(w.recovered.statusText) && /watching for changes every 60 s/.test(w.recovered.statusText) && JSON.stringify(w.recovered.scans) === JSON.stringify(['codex']) && w.recovered.label === '3 tools · 8 files',
      JSON.stringify({ e401: w.e401, down: w.down, recovered: w.recovered }));
    ok('watch (w5): a tool that newly appears (cline: found flips true) is read on the next tick — scanFiles once, for cline; in=1700 cw=100 cr=900 out=380 msgs=2 (87-folder-logs), "2 files · via collector", its Re-scan button shown; collector label "4 tools · 11 files"; table cell "3 files"',
      w.hasEntry && w.appeared && JSON.stringify(w.appeared.scans) === JSON.stringify(['cline']) && w.appeared.localScans.length === 0 && is(w.appeared.cline, 1700, 100, 900, 380, 2) && w.appeared.clineLabel === '2 files · via collector'
      && w.appeared.collectorLabel === '4 tools · 11 files' && w.appeared.reqs.filter(p => /^\/api\/list/.test(p)).length === 1 && w.appeared.reqs.includes('/api/list?tool=cline') && w.appeared.reqs.filter(p => /^\/api\/file\?tool=cline/.test(p)).length === 3
      && w.appeared.clineRescan === false && /via collector/.test(w.appeared.clineStatus) && w.appeared.clineCell === '3 files', JSON.stringify(w.appeared));

    // (w6) Re-scan routing while connected, the real rescanViaCollector, hub Sync, disconnect (watch stopped, buttons revert, a later tick is a no-op)
    const w6 = await page.evaluate(async (fx) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.projectsBy = {}; Store.connectors = {};
      const c = connectorById('collector'); if (!c || typeof App.rescanViaCollector !== 'function' || typeof App._collectorTick !== 'function') return { hasEntry: false };
      const origFetch = window.fetch, origVia = App.rescanViaCollector, origFolder = App.rescanFolder, origScan = App.scanFiles, origLocal = App.scanLocalFiles;
      const opts = { token: 'tok-abc', mtime: {} };
      const reqs = window.__collectorStub(fx, opts);
      const via = [], folder = [], scans = [], localScans = [];
      const spyRoutes = () => { via.length = 0; folder.length = 0; App.rescanViaCollector = async function (id) { via.push(id); }; App.rescanFolder = async function (id) { folder.push(id); }; };
      const unspyRoutes = () => { App.rescanViaCollector = origVia; App.rescanFolder = origFolder; };
      const btn = (id) => (document.getElementById(id) || {}).hidden;
      try {
        document.getElementById('collector-key').value = 'tok-abc'; document.getElementById('remember-collector').checked = false;
        await App.connectCollector(c);
        const out = { hasEntry: true, buttons: { codex: btn('codex-rescan'), local: btn('rescan-local'), copilot: btn('copilot-cli-rescan'), cline: btn('cline-rescan') }, timer: !!App._pollTimers.collector };
        spyRoutes();
        document.getElementById('codex-rescan').click(); document.getElementById('rescan-local').click();
        await new Promise(r => setTimeout(r, 5));
        out.connected = { via: via.slice(), folder: folder.slice() };
        unspyRoutes();
        App.scanFiles = function (cc, files, o) { scans.push(cc.id); return origScan.call(this, cc, files, o); };
        App.scanLocalFiles = function (files, o) { localScans.push('local'); return origLocal.call(this, files, o); };
        reqs.length = 0;
        const ret = await App.rescanViaCollector('codex');
        out.real = { ret, scans: scans.slice(), localScans: localScans.slice(), reqs: reqs.map(r => r.path), codex: __sum(Store.sources.codex.rows), codexLabel: Store.connectors.codex.label, codexStatus: document.getElementById('codex-status').textContent,
          collectorLabel: Store.connectors.collector.label, collectorStatus: document.getElementById('collector-status').textContent, codexBtn: btn('codex-rescan'), timer: !!App._pollTimers.collector };
        App.scanFiles = origScan; App.scanLocalFiles = origLocal;
        spyRoutes();
        await App.syncConnector('codex');
        out.sync = { via: via.slice(), folder: folder.slice() };
        unspyRoutes();
        App.disconnectConnector('collector');
        out.after = { timer: !!App._pollTimers.collector, buttons: { codex: btn('codex-rescan'), local: btn('rescan-local'), copilot: btn('copilot-cli-rescan') }, codexEntry: !!Store.connectors.codex, codexRows: ((Store.sources.codex || {}).rows || []).length, entry: !!Store.connectors.collector };
        spyRoutes();
        document.getElementById('codex-rescan').click();
        await new Promise(r => setTimeout(r, 5));
        out.after.click = { via: via.slice(), folder: folder.slice() };
        unspyRoutes();
        App.scanFiles = function (cc, files, o) { scans.push(cc.id); return origScan.call(this, cc, files, o); };
        scans.length = 0; reqs.length = 0; opts.mtime.codex = 1758000000000;
        const tick = await App._collectorTick(c);
        out.after.tick = { ret: tick, scans: scans.slice(), reqs: reqs.map(r => r.path), entry: !!Store.connectors.collector, timer: !!App._pollTimers.collector, statusText: document.getElementById('collector-status').textContent };
        return out;
      } finally { window.fetch = origFetch; App.rescanViaCollector = origVia; App.rescanFolder = origFolder; App.scanFiles = origScan; App.scanLocalFiles = origLocal; if (App.stopCollectorWatch) App.stopCollectorWatch(c); }
    }, fx);
    ok('watch (w6): while the collector is connected every collector-fed tool card shows Re-scan (codex, copilot-cli, Claude Code; cline — not found — stays hidden) and the button calls App.rescanViaCollector(id) (codex; Claude Code\'s rescan() routes to "local"), never rescanFolder',
      w6.hasEntry && w6.buttons.codex === false && w6.buttons.local === false && w6.buttons.copilot === false && w6.buttons.cline === true && w6.timer && JSON.stringify(w6.connected.via) === JSON.stringify(['codex', 'local']) && w6.connected.folder.length === 0,
      JSON.stringify({ buttons: w6.buttons, connected: w6.connected }));
    ok('watch (w6): App.rescanViaCollector("codex") re-lists and scans codex only (1 list, no /api/status; scanFiles once, for codex; NO /api/file — the 4 unchanged files hit the ScanCache, the incremental proof), the codex card reads "via collector", the collector line/label follow ("3 tools · 8 files", "checked … watching"), the watch keeps running; hub Sync on codex routes to the collector too',
      w6.hasEntry && w6.real && w6.real.ret === true && JSON.stringify(w6.real.scans) === JSON.stringify(['codex']) && w6.real.localScans.length === 0 && !w6.real.reqs.some(p => /status/.test(p)) && JSON.stringify(w6.real.reqs.filter(p => /list/.test(p))) === JSON.stringify(['/api/list?tool=codex'])
      && w6.real.reqs.filter(p => /^\/api\/file\?/.test(p)).length === 0 && w6.real.reqs.length === 1 && w6.real.codex.msgs > 0 && w6.real.codexLabel === '4 files · via collector' && /via collector/.test(w6.real.codexStatus) && w6.real.collectorLabel === '3 tools · 8 files'
      && /checked/.test(w6.real.collectorStatus) && /watching for changes every 60 s/.test(w6.real.collectorStatus) && w6.real.codexBtn === false && w6.real.timer && JSON.stringify(w6.sync.via) === JSON.stringify(['codex']) && w6.sync.folder.length === 0,
      JSON.stringify({ real: w6.real, sync: w6.sync }));
    ok('watch (w6): disconnectConnector("collector") stops the watch (no timer), the tools keep their entries and rows, the Re-scan buttons revert to the folder-handle rule (no handle → hidden) and a click now calls rescanFolder; a later tick is a no-op (no request, no scan, no entry re-created, no timer)',
      w6.hasEntry && w6.after && w6.after.timer === false && !w6.after.entry && w6.after.buttons.codex === true && w6.after.buttons.local === true && w6.after.buttons.copilot === true && w6.after.codexEntry && w6.after.codexRows > 0
      && JSON.stringify(w6.after.click.folder) === JSON.stringify(['codex']) && w6.after.click.via.length === 0
      && w6.after.tick.ret === undefined && w6.after.tick.scans.length === 0 && w6.after.tick.reqs.length === 0 && !w6.after.tick.entry && !w6.after.tick.timer && w6.after.tick.statusText === 'Not connected.', JSON.stringify(w6.after));

    // ================= Plan 7 review fixes =================
    // (review M1) _viaCollector needs a LANDED read: a tool the collector found but could not read (ollama — ~/.ai-usage holds only the token file the collector itself
    // created; a tool whose list failed) keeps its own folder handle's Re-scan / Sync (rescanFolder / scanHandle), never hijacked to rescanViaCollector
    const r1 = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.projectsBy = {}; Store.connectors = {};
      const origVia = App.rescanViaCollector, origFolder = App.rescanFolder, origServer = App.connectServer, origHandle = App.scanHandle;
      const savedHandles = App._dirHandles, savedDir = App.dirHandle;
      const via = [], folder = [], server = [], handle = [];
      App.rescanViaCollector = async function (id) { via.push(id); }; App.rescanFolder = async function (id) { folder.push(id); }; App.connectServer = async function (c) { server.push(c.id); }; App.scanHandle = async function () { handle.push('local'); };
      try {
        Store.setConnector('collector', { label: '1 tool · 4 files', lastSync: Date.now(), err: null });
        const granted = () => ({ queryPermission: async () => 'granted', requestPermission: async () => 'granted' });
        App._collectorSnap = { codex: { files: 4, newestMtime: 1, matched: 4, landed: true, note: '4 files' }, ollama: { files: 1, newestMtime: 1, matched: 0, landed: false, note: 'found, nothing to read' },
          local: { files: 3, newestMtime: 1, matched: 0, landed: false, note: 'found, nothing to read' }, cline: { files: -1, newestMtime: -1, matched: 0, landed: false, note: 'error: x' } };
        App._dirHandles = { ollama: granted(), codex: granted(), cline: granted() }; App.dirHandle = granted();
        const out = { buttons: { ollama: !!document.getElementById('ollama-rescan'), codex: !!document.getElementById('codex-rescan') },
          via: { codex: App._viaCollector('codex'), ollama: App._viaCollector('ollama'), local: App._viaCollector('local'), cline: App._viaCollector('cline'), absent: App._viaCollector('roo') } };
        await App.syncConnector('ollama'); await App.syncConnector('codex'); await App.syncConnector('local'); await App.syncConnector('cline');
        document.getElementById('ollama-rescan').click(); document.getElementById('codex-rescan').click(); document.getElementById('cline-rescan').click();
        await new Promise(r => setTimeout(r, 5));
        out.routes = { via: via.slice(), folder: folder.slice(), server: server.slice(), handle: handle.slice() };
        delete Store.connectors.collector;
        out.viaOff = App._viaCollector('codex');
        return out;
      } finally { App.rescanViaCollector = origVia; App.rescanFolder = origFolder; App.connectServer = origServer; App.scanHandle = origHandle; App._dirHandles = savedHandles; App.dirHandle = savedDir; App._collectorSnap = {}; Store.connectors = {}; }
    });
    ok('review M1: _viaCollector(id) is true only for a tool whose collector read LANDED (codex) — false for ollama "found, nothing to read", local "found, nothing to read", cline "error: …" (retry sentinel), an absent tool, and once the collector entry is gone; so Sync / Re-scan on ollama, local and cline with a folder handle go to rescanFolder (+ connectServer for ollama) / scanHandle, and only codex goes to rescanViaCollector',
      r1.buttons.ollama && r1.buttons.codex && r1.via.codex === true && r1.via.ollama === false && r1.via.local === false && r1.via.cline === false && r1.via.absent === false && r1.viaOff === false
      && JSON.stringify(r1.routes.via) === JSON.stringify(['codex', 'codex']) && JSON.stringify(r1.routes.folder) === JSON.stringify(['ollama', 'cline', 'ollama', 'cline']) && JSON.stringify(r1.routes.server) === JSON.stringify(['ollama']) && JSON.stringify(r1.routes.handle) === JSON.stringify(['local']),
      JSON.stringify(r1));

    // (review m2) Refresh all leaves a collector-fed tool's folder handle alone — the collector tick re-reads what changed; a handle the collector does not feed is re-scanned as before
    const r2 = await page.evaluate(async () => {
      Store.sources = {}; Store.connectors = {};
      const origFolder = App.rescanFolder, origRescan = App.rescan, origTick = App._collectorTick, origServer = App.connectServer, origKey = App.connectKey;
      const savedHandles = App._dirHandles, savedDir = App.dirHandle;
      const folder = [], ticks = [], rescans = [];
      App.rescanFolder = async function (id) { folder.push(id); }; App.rescan = async function () { rescans.push('local'); }; App._collectorTick = async function (c) { ticks.push(c.id); }; App.connectServer = async function () {}; App.connectKey = async function () {};
      try {
        Store.setConnector('collector', { label: '2 tools · 6 files', lastSync: Date.now(), err: null });
        document.getElementById('collector-key').value = 'tok-abc';
        App._collectorSnap = { codex: { files: 4, newestMtime: 1, matched: 4, landed: true, note: '4 files' }, local: { files: 2, newestMtime: 1, matched: 2, landed: true, note: '2 files' }, ollama: { files: 1, newestMtime: 1, matched: 0, landed: false, note: 'found, nothing to read' } };
        App._dirHandles = { codex: {}, ollama: {}, cline: {} }; App.dirHandle = {};
        await App.refreshAll();
        return { folder: folder.slice(), ticks: ticks.slice(), rescans: rescans.slice() };
      } finally { App.rescanFolder = origFolder; App.rescan = origRescan; App._collectorTick = origTick; App.connectServer = origServer; App.connectKey = origKey; App._dirHandles = savedHandles; App.dirHandle = savedDir; App._collectorSnap = {}; Store.connectors = {}; document.getElementById('collector-key').value = ''; }
    });
    ok('review m2: refreshAll with handles for codex, ollama, cline + the Claude Code handle while the collector feeds codex and local → ONE collector tick, rescanFolder only for ollama (not landed) and cline (not the collector\'s), never for codex; rescan() (Claude Code) not called',
      JSON.stringify(r2.ticks) === JSON.stringify(['collector']) && JSON.stringify(r2.folder) === JSON.stringify(['ollama', 'cline']) && r2.rescans.length === 0, JSON.stringify(r2));

    // (review m9) something else answers 200 at the URL (HTML): not "Not running", not "Rejected" — an honest "is this the collector?" and no entry; on a tick the same text as the entry's err
    const r9 = await page.evaluate(async (fx) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.projectsBy = {}; Store.connectors = {};
      const c = connectorById('collector');
      const origFetch = window.fetch;
      const opts = { token: 'tok-abc', html: true };
      const reqs = window.__collectorStub(fx, opts);
      try {
        document.getElementById('collector-key').value = 'tok-abc'; document.getElementById('remember-collector').checked = false;
        Store.setConnector('collector', { label: 'stale entry', lastSync: Date.now(), err: null });
        const ret = await App.connectCollector(c);
        const out = { ret, statusText: document.getElementById('collector-status').textContent, entry: Store.connectors.collector, status: Store.connectorStatus(c), landed: Object.keys(Store.sources), watch: !!App._pollTimers.collector,
          lists: reqs.filter(r => /\/api\/list/.test(r.path)).length, persisted: !!(((JSON.parse(localStorage.getItem('aiusage:data') || '{}')).connectors || {}).collector) };
        opts.html = false;
        await App.connectCollector(c);   // a good connect, then the thing at the URL changes
        opts.html = true;
        await App._collectorTick(c);
        out.tick = { err: Store.connectors.collector.err, status: Store.connectorStatus(c), statusText: document.getElementById('collector-status').textContent, codexRows: ((Store.sources.codex || {}).rows || []).length, timer: !!App._pollTimers.collector };
        return out;
      } finally { window.fetch = origFetch; if (App.stopCollectorWatch) App.stopCollectorWatch(c); }
    }, fx);
    ok('review m9: a 200 that is not JSON → connectCollector: status line "Unexpected response from http://127.0.0.1:11436 — is this the collector?", NO entry (the stale one deleted, not persisted), off, nothing lands, no list, no watch; a tick meeting it → err "Unexpected response from … — is this the collector?" (warn, entry + the tools\' data kept, watch alive)',
      r9.ret === undefined && r9.statusText === 'Unexpected response from http://127.0.0.1:11436 — is this the collector?' && r9.entry === undefined && r9.status === 'off' && r9.landed.length === 0 && r9.lists === 0 && r9.watch === false && !r9.persisted
      && r9.tick && r9.tick.err === 'Unexpected response from http://127.0.0.1:11436 — is this the collector?' && r9.tick.status === 'warn' && /Unexpected response/.test(r9.tick.statusText) && r9.tick.codexRows > 0 && r9.tick.timer, JSON.stringify(r9));

    // (review m3) a tool disconnected while the collector feeds it leaves the snapshot AND stays out of the collector's reads (an otherwise unchanged tick would re-land it,
    // deleted data included) until Validate & connect on the collector card; the collector's label / line / table follow the disconnect at once
    const r3 = await page.evaluate(async (fx) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.projectsBy = {}; Store.connectors = {};
      const c = connectorById('collector');
      const origFetch = window.fetch, origConfirm = window.confirm, origScan = App.scanFiles;
      const opts = { token: 'tok-abc', mtime: {} };
      window.__collectorStub(fx, opts);
      const scans = []; App.scanFiles = function (cc, files, o) { scans.push(cc.id); return origScan.call(this, cc, files, o); };
      window.confirm = () => true;   // "Also delete codex's stored usage data?" → OK
      const cell = () => (([...document.querySelectorAll('#collector-tools tbody tr')].find(tr => /Codex/.test(tr.children[0].textContent)) || { children: [{}, {}, { textContent: null }] }).children[2].textContent);
      try {
        document.getElementById('collector-key').value = 'tok-abc'; document.getElementById('remember-collector').checked = false;
        await App.connectCollector(c);
        const before = { label: Store.connectors.collector.label, snap: Object.keys(App._collectorSnap).sort(), codexRows: Store.sources.codex.rows.length, lastSync: Store.connectors.collector.lastSync, cell: cell() };
        await new Promise(r => setTimeout(r, 5));
        App.disconnectConnector('codex');
        const after = { snap: Object.keys(App._collectorSnap).sort(), excluded: [...(App._collectorExcluded || [])], persisted: (Store.connectors.collector || {}).excluded, label: Store.connectors.collector.label, err: Store.connectors.collector.err,
          lastSync: Store.connectors.collector.lastSync, statusText: document.getElementById('collector-status').textContent, codexEntry: !!Store.connectors.codex, codexRows: ((Store.sources.codex || {}).rows || []).length, codexProjects: !!Store.projectsBy.codex,
          cell: cell(), via: App._viaCollector('codex'), timer: !!App._pollTimers.collector, rescanHidden: document.getElementById('codex-rescan').hidden, codexStatus: document.getElementById('codex-status').textContent };
        scans.length = 0; opts.mtime.codex = 1756000000000;   // codex changed on disk → the tick must NOT re-land it
        const tick = await App._collectorTick(c);
        const afterTick = { ret: tick, scans: scans.slice(), codexEntry: !!Store.connectors.codex, codexRows: ((Store.sources.codex || {}).rows || []).length, label: Store.connectors.collector.label, cell: cell(), snap: Object.keys(App._collectorSnap).sort(), excluded: [...(App._collectorExcluded || [])] };
        scans.length = 0;
        const re = await App.connectCollector(c);   // Validate & connect (hub Sync on the collector card is the same call): the exclusion is cleared, codex is read again
        const reconnected = { ret: re, scans: scans.slice().sort(), codexEntry: !!Store.connectors.codex, codexRows: ((Store.sources.codex || {}).rows || []).length, excluded: [...(App._collectorExcluded || [])], persisted: Store.connectors.collector.excluded, label: Store.connectors.collector.label, cell: cell() };
        return { before, after, afterTick, reconnected, note: [...document.querySelectorAll('#src-collector .note')].map(n => n.textContent).join(' ') };
      } finally { window.fetch = origFetch; window.confirm = origConfirm; App.scanFiles = origScan; if (App.stopCollectorWatch) App.stopCollectorWatch(c); }
    }, fx);
    ok('review m3: disconnect codex (delete its data) while collector-fed → codex leaves the snapshot (App._collectorExcluded has it; persisted as excluded on the collector entry), its entry / rows / project rows gone, Re-scan hidden, _viaCollector false; the collector label drops to "2 tools · 4 files" (line + table row "disconnected", lastSync / err untouched, watch alive); the card copy says "Disconnected tools stay out until you reconnect the collector"',
      r3.before.label === '3 tools · 8 files' && JSON.stringify(r3.before.snap) === JSON.stringify(['codex', 'continue', 'copilot-cli', 'local']) && r3.before.codexRows > 0 && r3.before.cell === '4 files'
      && JSON.stringify(r3.after.snap) === JSON.stringify(['continue', 'copilot-cli', 'local']) && JSON.stringify(r3.after.excluded) === JSON.stringify(['codex']) && JSON.stringify(r3.after.persisted) === JSON.stringify(['codex'])
      && r3.after.label === '2 tools · 4 files' && r3.after.err === null && r3.after.lastSync === r3.before.lastSync && /2 tools/.test(r3.after.statusText) && /4 files/.test(r3.after.statusText) && /1 disconnected/.test(r3.after.statusText) && /watching for changes/.test(r3.after.statusText)
      && !r3.after.codexEntry && r3.after.codexRows === 0 && !r3.after.codexProjects && r3.after.cell === 'disconnected' && r3.after.via === false && r3.after.timer && r3.after.rescanHidden === true && r3.after.codexStatus === 'Not connected.'
      && /Disconnected tools stay out until you reconnect the collector/.test(r3.note), JSON.stringify({ before: r3.before, after: r3.after, note: r3.note }));
    ok('review m3: a later tick with codex changed on disk does NOT re-land it (no scanFiles, no entry, no rows; label stays "2 tools · 4 files", row "disconnected"); Validate & connect on the collector clears the exclusion (in memory and on the entry) and reads codex again ("3 tools · 8 files", "4 files")',
      r3.afterTick.ret === true && r3.afterTick.scans.length === 0 && !r3.afterTick.codexEntry && r3.afterTick.codexRows === 0 && r3.afterTick.label === '2 tools · 4 files' && r3.afterTick.cell === 'disconnected' && JSON.stringify(r3.afterTick.snap) === JSON.stringify(['continue', 'copilot-cli', 'local']) && JSON.stringify(r3.afterTick.excluded) === JSON.stringify(['codex'])
      && r3.reconnected.ret === true && r3.reconnected.scans.includes('codex') && r3.reconnected.codexEntry && r3.reconnected.codexRows > 0 && r3.reconnected.excluded.length === 0 && JSON.stringify(r3.reconnected.persisted) === JSON.stringify([]) && r3.reconnected.label === '3 tools · 8 files' && r3.reconnected.cell === '4 files',
      JSON.stringify({ afterTick: r3.afterTick, reconnected: r3.reconnected }));

    // (w7) restore on init — review m4: a restored collector entry + a remembered token → the watch starts at init AND one tick runs at once (the stub is registered with
    // evaluateOnNewDocument so it is in place before the page's own scripts run), so the snapshot is populated right away and Sync on a collector-fed tool routes to the
    // collector instead of opening the folder picker for up to 60 s; without a token → Reconnect guidance, no watch, no tick
    await page.evaluate(() => {
      Store.sources = {}; Store.connectors = {}; Store.setConnector('collector', { label: '3 tools · 8 files', lastSync: Date.now() - 60000, err: null });
      LS.set('key:collector', 'tok-abc'); LS.set('url:collector', 'http://127.0.0.1:11436');
    });
    await page.evaluateOnNewDocument(installStub);
    await page.evaluateOnNewDocument((fx) => { window.__restoreReqs = window.__collectorStub(fx, { token: 'tok-abc' }); }, fx);
    await page.reload({ waitUntil: 'load' });
    let ticked = true;
    try { await page.waitForFunction(() => Object.keys(App._collectorSnap || {}).length >= 3 && /checked/.test(document.getElementById('collector-status').textContent), { timeout: 15000 }); } catch { ticked = false; }
    const w7 = await page.evaluate(async () => {
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));   // let the batched render run
      const origVia = App.rescanViaCollector, origFolder = App.rescanFolder, via = [], folder = [];
      App.rescanViaCollector = async function (id) { via.push(id); }; App.rescanFolder = async function (id) { folder.push(id); };
      try { await App.syncConnector('codex'); } finally { App.rescanViaCollector = origVia; App.rescanFolder = origFolder; }
      return { timer: !!(App._pollTimers && App._pollTimers.collector), entry: !!Store.connectors.collector, status: Store.connectorStatus(connectorById('collector')), statusText: document.getElementById('collector-status').textContent,
        key: document.getElementById('collector-key').value, rem: document.getElementById('remember-collector').checked, tokenInDom: document.documentElement.outerHTML.includes('tok-abc'),
        hubActions: [...document.querySelectorAll('#accounts-hub .acct[data-connector="collector"] .acct-actions button')].map(b => b.textContent),
        snap: Object.fromEntries(Object.entries(App._collectorSnap || {}).map(([k, v]) => [k, v.landed])), labels: { local: (Store.connectors.local || {}).label, codex: (Store.connectors.codex || {}).label, 'copilot-cli': (Store.connectors['copilot-cli'] || {}).label },
        codexRows: ((Store.sources.codex || {}).rows || []).length, reqs: (window.__restoreReqs || []).map(r => r.path), via: via.slice(), folder: folder.slice(), codexRescan: (document.getElementById('codex-rescan') || {}).hidden };
    });
    ok('watch (w7 · review m4): reload with a restored collector entry AND a remembered token → the watch is running right after init AND one tick ran at once (GET /api/status, 4 lists, then only the files the ScanCache does not hold): snapshot local / codex / copilot-cli landed, "via collector" labels, codex rows present, line "● Connected. 3 tools · 8 files · checked … · watching for changes every 60 s"; token restored into the input (Remember checked), never in the DOM; hub Manage / Sync / Disconnect; Sync on codex goes through the collector (no folder picker), its Re-scan shown',
      ticked && w7.timer && w7.entry && w7.status === 'ok' && /Connected/.test(w7.statusText) && /3 tools · 8 files/.test(w7.statusText) && /checked/.test(w7.statusText) && /watching for changes every 60 s/.test(w7.statusText) && w7.key === 'tok-abc' && w7.rem === true && !w7.tokenInDom
      && JSON.stringify(w7.hubActions) === JSON.stringify(['Manage', 'Sync', 'Disconnect']) && w7.snap.local === true && w7.snap.codex === true && w7.snap['copilot-cli'] === true
      && w7.labels.local === '2 log files · via collector' && w7.labels.codex === '4 files · via collector' && w7.labels['copilot-cli'] === '2 files · via collector' && w7.codexRows > 0
      && w7.reqs[0] === '/api/status' && w7.reqs.filter(p => /^\/api\/list/.test(p)).length === 4 && w7.reqs.filter(p => /^\/api\/file/.test(p)).length <= 8 && w7.reqs.filter(p => /^\/api\/file/.test(p)).every(p => /tool=(codex|local|copilot-cli)&/.test(p))   // the ScanCache (IDB) survives the reload: only files it does not hold are fetched
      && JSON.stringify(w7.via) === JSON.stringify(['codex']) && w7.folder.length === 0 && w7.codexRescan === false,
      `ticked=${ticked} ` + JSON.stringify(w7));
    await page.evaluate(() => { LS.del('key:collector'); });
    await page.reload({ waitUntil: 'load' });
    const w8 = await page.evaluate(async () => {
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
      const out = { timer: !!(App._pollTimers && App._pollTimers.collector), entry: !!Store.connectors.collector, statusText: document.getElementById('collector-status').textContent, key: document.getElementById('collector-key').value, reqs: (window.__restoreReqs || []).length };
      Store.connectors = {}; Store.persist();
      return out;
    });
    ok('watch (w8): reload with a restored entry but NO remembered token → no watch, no tick (no request), the card says "Reconnect: paste the collector token and click Validate & connect …" (the entry and the tools\' stored data stay)',
      !w8.timer && w8.entry && /^Reconnect: paste the collector token and click Validate & connect/.test(w8.statusText) && w8.key === '' && w8.reqs === 0, JSON.stringify(w8));

    ok('collector: no page errors during the collector checks', errors.length === 0, errors.join(' | '));
  } finally {
    await page.close();
  }
}
