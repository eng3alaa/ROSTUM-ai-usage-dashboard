import fs from 'node:fs';
import path from 'node:path';
import { openDashboard, OUT } from '../lib/harness.mjs';

const read = (...p) => fs.readFileSync(path.join(OUT, ...p), 'utf8');
const sum = (rows) => rows.reduce((a, r) => ({ in: a.in + (r.in || 0), cw: a.cw + (r.cw || 0), cr: a.cr + (r.cr || 0), out: a.out + (r.out || 0), msgs: a.msgs + (r.msgs || 0) }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    // ---- T6: generic folder-log driver ----
    const logText = read('usage-log', 'ollama-usage.jsonl');
    const drv = await page.evaluate(async (text) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const tmp = { id: 'tmp-log', platform: 'TmpLog', name: 'Temp log', category: 'local', kind: 'folder-log', statusEl: 'tmp-log-status', brand: '#888888', mark: 'Tm', srcIds: ['tmp-log'],
        patterns: [/\.jsonl$/i], parser: 'parseUsageLoggerJsonl', hint: 'usage JSONL', quality: 'exact', qualityNote: 'temp', paths: ['x'], links: {} };
      const tmp2 = { ...tmp, id: 'tmp-log2', statusEl: 'tmp-log2-status', srcIds: ['tmp-log2'], platform: 'TmpLog2' };
      CONNECTORS.push(tmp, tmp2);
      App.ensureSourceCard(tmp); App.ensureSourceCard(tmp2);
      const cardOk = !!document.getElementById('src-tmp-log') && !!document.getElementById('tmp-log-status') && !!document.getElementById('tmp-log-pick')
        && !!document.getElementById('tmp-log-fallback') && /exact/i.test(document.querySelector('#src-tmp-log .badge').textContent) && document.getElementById('src-tmp-log').hidden === true;
      const mk = () => [
        { path: 'logs/ollama-usage.jsonl', file: new File([text], 'ollama-usage.jsonl', { lastModified: 1754000000000 }) },
        { path: 'logs/readme.txt', file: new File(['x'], 'readme.txt', { lastModified: 1754000000000 }) },   // not matched by patterns
      ];
      await App.scanFiles(tmp, mk());
      const rows = Store.sources['tmp-log'].rows;
      const t = rows.reduce((a, r) => ({ in: a.in + r.in, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, out: 0, msgs: 0 });
      const st = Store.connectors['tmp-log'];
      const status = Store.connectorStatus(tmp);   // capture BEFORE the cleanup below deletes the connector state
      const statusText = document.getElementById('tmp-log-status').textContent;
      App.renderHub();
      const hubCard = !!document.querySelector('#accounts-hub .acct[data-connector="tmp-log"]');
      // cache: same connector hits; a DIFFERENT connector with the same paths must NOT hit; pruning is per connector
      const cache = new Map();
      const a = await parseFolderCached(tmp, mk(), null, cache);
      const b = await parseFolderCached(tmp, mk(), null, cache);
      const c2 = await parseFolderCached(tmp2, mk(), null, cache);
      const sigs = [...cache.keys()];
      await parseFolderCached(tmp2, [], null, cache);   // tmp2 sees no files → prunes ONLY tmp2 entries
      const afterPrune = { tmp: sigs.length && [...cache.keys()].filter(k => k.startsWith('tmp-log\u0001')).length, tmp2: [...cache.keys()].filter(k => k.startsWith('tmp-log2\u0001')).length };
      // cleanup
      CONNECTORS.splice(CONNECTORS.indexOf(tmp), 2);
      document.getElementById('src-tmp-log').remove(); document.getElementById('src-tmp-log2').remove();
      delete Store.sources['tmp-log']; delete Store.connectors['tmp-log']; Store.persist(); App._render();
      return { cardOk, ...t, platform: rows[0] && rows[0].platform, label: st && st.label, status, statusText, hubCard,
        files: a.meta.files, aParsed: a.meta.parsedFiles, bCached: b.meta.cachedFiles, c2Parsed: c2.meta.parsedFiles, sigs, afterPrune };
    }, logText);
    ok('folder-log: generic card + scanFiles land rows under the connector (in=1060 out=370 msgs=3; platform from rows; connected status)',
      drv.cardOk && drv.in === 1060 && drv.out === 370 && drv.msgs === 3 && drv.platform === 'Ollama' && /^1 file$/.test(drv.label || '') && drv.status === 'ok'
      && /Connected/.test(drv.statusText) && /1 unreadable/.test(drv.statusText) && drv.hubCard, JSON.stringify(drv));
    ok('folder-log: cache is keyed per connector (same connector hits, other connector misses) and pruning is connector-scoped',
      drv.files === 1 && drv.aParsed === 1 && drv.bCached === 1 && drv.c2Parsed === 1 && drv.sigs.length === 2 && drv.sigs.every(k => /^tmp-log2?\u0001/.test(k))
      && drv.afterPrune.tmp === 1 && drv.afterPrune.tmp2 === 0, JSON.stringify({ sigs: drv.sigs, afterPrune: drv.afterPrune }));

    // ---- T6 follow-up: one unreadable file (Chrome NotReadableError on a live log, or a throwing parser) must not abort the batch ----
    const bad = await page.evaluate(async (text) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const tmp = { id: 'tmp-bad', platform: 'TmpBad', name: 'Temp bad', category: 'local', kind: 'folder-log', statusEl: 'tmp-bad-status', brand: '#888888', mark: 'Tb', srcIds: ['tmp-bad'],
        patterns: [/\.jsonl$/i], parser: 'parseUsageLoggerJsonl', hint: 'usage JSONL', quality: 'exact', qualityNote: 'temp', paths: [], links: {} };
      CONNECTORS.push(tmp); App.ensureSourceCard(tmp);
      const mk = () => {
        const good = new File([text], 'good.jsonl', { lastModified: 1754000000000 });
        const broken = new File([text], 'live.jsonl', { lastModified: 1754000000001 });
        const boom = () => { throw new DOMException('The requested file could not be read', 'NotReadableError'); };
        broken.stream = boom; broken.text = boom; broken.arrayBuffer = boom;   // what Chrome does when an FSA file changed after getFile()
        return [
          { path: 'logs/good.jsonl', file: good },
          { path: 'logs/live.jsonl', file: broken },
          { path: 'logs/readme.txt', file: new File(['x'], 'readme.txt', { lastModified: 1754000000000 }) },   // not matched → skipped
        ];
      };
      let threw = null, res = null;
      try { res = await parseFolderCached(tmp, mk(), null, new Map()); } catch (e) { threw = e.message || String(e); }
      const t = res ? res.rows.reduce((a, r) => ({ in: a.in + r.in, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, out: 0, msgs: 0 }) : null;
      await App.scanFiles(tmp, mk());
      const status = Store.connectorStatus(tmp);
      const statusText = document.getElementById('tmp-bad-status').textContent;
      const stored = Store.sources['tmp-bad'] ? Store.sources['tmp-bad'].rows.reduce((a, r) => a + r.in, 0) : -1;
      // cleanup
      CONNECTORS.splice(CONNECTORS.indexOf(tmp), 1);
      document.getElementById('src-tmp-bad').remove();
      delete Store.sources['tmp-bad']; delete Store.connectors['tmp-bad']; Store.persist(); App._render();
      return { threw, t, meta: res && res.meta, status, statusText, stored };
    }, logText);
    ok('folder-log: one unreadable file does not abort the batch',
      bad.threw === null && !!bad.t && bad.t.in === 1060 && bad.t.out === 370 && bad.t.msgs === 3 && bad.meta.badFiles === 1 && bad.meta.files === 2 && bad.meta.skipped === 1
      && bad.status === 'ok' && /Connected/.test(bad.statusText) && /1 file\(s\) unreadable/.test(bad.statusText) && bad.stored === 1060, JSON.stringify(bad));

    // ---- T7: OpenAI Codex CLI ----
    const codexText = read('codex', 'sessions', '2026', '08', '10', 'rollout-2026-08-10T09-00-00-abc.jsonl');
    const cx = await page.evaluate(async (text) => {
      const c = connectorById('codex');
      const res = await parseCodexRollouts([{ path: 'sessions/2026/08/10/rollout-2026-08-10T09-00-00-abc.jsonl', file: new File([text], 'rollout-2026-08-10T09-00-00-abc.jsonl') }], null, new Set(), c);
      const t = res.rows.reduce((a, r) => ({ in: a.in + r.in, cr: a.cr + r.cr, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, cr: 0, out: 0, msgs: 0 });
      const hours = [...new Set(res.rows.map(r => r.hour))].sort((a, b) => a - b);
      const expHours = [...new Set([new Date('2026-08-10T09:01:00.000Z').getHours(), new Date('2026-08-10T21:10:00.000Z').getHours()])].sort((a, b) => a - b);
      App.renderHub();
      return { ...t, badLines: res.meta.badLines, lines: res.meta.lines, models: [...new Set(res.rows.map(r => r.model))], platforms: [...new Set(res.rows.map(r => r.platform))], hours, expHours,
        sid: res.rows[0] && res.rows[0].sid, card: !!document.getElementById('src-codex'), cat: c && c.category, kind: c && c.kind, quality: c && c.quality,
        hub: !!document.querySelector('#accounts-hub .hub-group[data-group="coding"] .acct[data-connector="codex"]') };
    }, codexText);
    ok('codex: delta-of-cumulative token_count → in=200 cr=200 out=130 msgs=3; duplicate snapshot + info:null skipped; 1 bad line; hours + sid kept',
      cx.in === 200 && cx.cr === 200 && cx.out === 130 && cx.msgs === 3 && cx.badLines === 1 && cx.lines === 8 && cx.models.length === 1 && cx.models[0] === 'gpt-5.4-codex'
      && cx.platforms.length === 1 && cx.platforms[0] === 'OpenAI Codex CLI' && JSON.stringify(cx.hours) === JSON.stringify(cx.expHours) && cx.sid === 'rollout-2026-08-10T09-00-00-abc', JSON.stringify(cx));
    ok('codex: registry entry is a folder-log coding tool with an exact-quality generic card in the Coding group', cx.card && cx.cat === 'coding' && cx.kind === 'folder-log' && cx.quality === 'exact' && cx.hub, JSON.stringify(cx));

    // ---- T7 follow-up: the same rollout filename (contains the session UUID) appearing under both sessions/ and archived_sessions/ must count once ----
    const cxDupe = await page.evaluate(async (text) => {
      const c = connectorById('codex');
      const files = [
        { path: 'sessions/2026/08/10/rollout-2026-08-10T09-00-00-abc.jsonl', file: new File([text], 'rollout-2026-08-10T09-00-00-abc.jsonl') },
        { path: 'archived_sessions/2026/08/10/rollout-2026-08-10T09-00-00-abc.jsonl', file: new File([text], 'rollout-2026-08-10T09-00-00-abc.jsonl') },
      ];
      const res = await parseFolderCached(c, files, null, new Map());
      return res.rows.reduce((a, r) => ({ in: a.in + r.in, cr: a.cr + r.cr, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, cr: 0, out: 0, msgs: 0 });
    }, codexText);
    ok('codex: same rollout filename under sessions/ and archived_sessions/ is counted once (whole-file sid dedupe) — in=200 cr=200 out=130 msgs=3, not doubled',
      cxDupe.in === 200 && cxDupe.cr === 200 && cxDupe.out === 130 && cxDupe.msgs === 3, JSON.stringify(cxDupe));

    // ---- T8: Gemini CLI ----
    const gemA = read('gemini', 'tmp', 'abc123', 'chats', 'session-2026-08-10T09-00-aaaa.json'), gemB = read('gemini', 'tmp', 'abc123', 'chats', 'session-bad.json');
    const gc = await page.evaluate(async (a, b) => {
      const c = connectorById('gemini-cli');
      const res = await parseGeminiCliSessions([
        { path: 'tmp/abc123/chats/session-2026-08-10T09-00-aaaa.json', file: new File([a], 'session-2026-08-10T09-00-aaaa.json') },
        { path: 'tmp/abc123/chats/session-bad.json', file: new File([b], 'session-bad.json') }], null, new Set(), c);
      const t = res.rows.reduce((x, r) => ({ in: x.in + r.in, cr: x.cr + r.cr, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, cr: 0, out: 0, msgs: 0 });
      return { ...t, files: res.meta.files, badLines: res.meta.badLines, models: [...new Set(res.rows.map(r => r.model))].sort(), platform: res.rows[0].platform,
        hourOk: res.rows.some(r => r.hour === new Date('2026-08-10T09:00:05.000Z').getHours()), sid: res.rows[0].sid, ids: res.meta.addedIds.length, kind: c.kind, cat: c.category, card: !!document.getElementById('src-gemini-cli') };
    }, gemA, gemB);
    ok('gemini-cli: session JSON → in=1800 cr=1700 out=470 msgs=3 (dup id + token-less message skipped); malformed file counted as badLines',
      gc.in === 1800 && gc.cr === 1700 && gc.out === 470 && gc.msgs === 3 && gc.files === 2 && gc.badLines === 1 && JSON.stringify(gc.models) === JSON.stringify(['gemini-3-flash', 'gemini-3-pro'])
      && gc.platform === 'Gemini CLI' && gc.hourOk && gc.sid === 'aaaa' && gc.ids === 3 && gc.kind === 'folder-log' && gc.cat === 'coding' && gc.card, JSON.stringify(gc));

    // ---- T9: GitHub Copilot CLI ----
    const cp1 = read('copilot', 'session-state', 'sess-1', 'events.jsonl'), cp2 = read('copilot', 'session-state', 'sess-2', 'events.jsonl');
    const cpc = await page.evaluate(async (a, b) => {
      const c = connectorById('copilot-cli');
      const files = [{ path: 'session-state/sess-1/events.jsonl', file: new File([a], 'events.jsonl') }, { path: 'session-state/sess-2/events.jsonl', file: new File([b], 'events.jsonl') }];
      const res = await parseCopilotCliEvents(files, null, new Set(), c);
      const t = res.rows.reduce((x, r) => ({ in: x.in + r.in, cw: x.cw + r.cw, cr: x.cr + r.cr, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });
      // both copilot connectors share the platform: hub stats must come from each card's OWN source rows
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      Store.setSource('copilot-cli', res.rows.map(r => ({ ...r, d: dayKey(new Date()) })), {});
      Store.setConnector('copilot-cli', { label: '2 files', lastSync: Date.now(), err: null });
      Store.setSource('copilot', [{ d: dayKey(new Date()), platform: 'GitHub Copilot', model: 'copilot_premium_request', in: 0, cw: 0, cr: 0, out: 0, msgs: 7, est: 1 }], {});
      Store.setConnector('copilot', { label: 'alaa-dev', lastSync: Date.now(), err: null });
      App.renderHub();
      const cliStats = document.querySelector('#accounts-hub .acct[data-connector="copilot-cli"] .acct-stats').textContent;
      const patStats = document.querySelector('#accounts-hub .acct[data-connector="copilot"] .acct-stats').textContent;
      const chips = [...document.querySelectorAll('#platform-chips .chip')].filter(ch => /GitHub Copilot/.test(ch.textContent)).length;
      Store.sources = {}; Store.connectors = {}; Store.persist();
      return { ...t, badLines: res.meta.badLines, platform: c.platform, samePlatform: c.platform === connectorById('copilot').platform, sids: [...new Set(res.rows.map(r => r.sid))].sort(),
        cliStats, patStats, chipsBefore: chips, kind: c.kind, cat: c.category, card: !!document.getElementById('src-copilot-cli') };
    }, cp1, cp2);
    ok('copilot-cli: assistant.usage rows (dup id skipped, shutdown not double-counted) + shutdown-only fallback → in=2150 cw=100 cr=900 out=500 msgs=5; 1 bad line',
      cpc.in === 2150 && cpc.cw === 100 && cpc.cr === 900 && cpc.out === 500 && cpc.msgs === 5 && cpc.badLines === 1 && JSON.stringify(cpc.sids) === JSON.stringify(['sess-1', 'sess-2']), JSON.stringify(cpc));
    ok('copilot-cli: separate registry entry on the shared "GitHub Copilot" platform; hub cards show their own source stats',
      cpc.platform === 'GitHub Copilot' && cpc.samePlatform && cpc.kind === 'folder-log' && cpc.cat === 'coding' && cpc.card && /tokens/.test(cpc.cliStats) && cpc.cliStats !== cpc.patStats, JSON.stringify({ cli: cpc.cliStats, pat: cpc.patStats }));

    // ---- T9 follow-up: the same session events.jsonl appearing under two paths must not double-count via the session.shutdown fallback ----
    const cpDupe = await page.evaluate(async (a) => {
      const c = connectorById('copilot-cli');
      const files = [
        { path: 'session-state/sess-1/events.jsonl', file: new File([a], 'events.jsonl') },
        { path: 'backup/sess-1/events.jsonl', file: new File([a], 'events.jsonl') },   // same session dir name + content → every assistant.usage id already seen
      ];
      const res = await parseFolderCached(c, files, null, new Map());
      return res.rows.reduce((x, r) => ({ in: x.in + r.in, cw: x.cw + r.cw, cr: x.cr + r.cr, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });
    }, cp1);
    ok('copilot-cli: a fully-deduped repeat of the same session file must not fall back to session.shutdown (no double count) — totals equal the single-file totals',
      cpDupe.in === 2100 && cpDupe.cw === 100 && cpDupe.cr === 900 && cpDupe.out === 490 && cpDupe.msgs === 3, JSON.stringify(cpDupe));

    // ---- T10: Continue.dev ----
    const ctA = read('continue', 'dev_data', '0.2.0', 'tokensGenerated.jsonl'), ctB = read('continue', 'dev_data', '0.2.0', 'chatInteraction.jsonl');
    const ct = await page.evaluate(async (a, b) => {
      const c = connectorById('continue');
      const files = [{ path: 'dev_data/0.2.0/tokensGenerated.jsonl', file: new File([a], 'tokensGenerated.jsonl') }, { path: 'dev_data/0.2.0/chatInteraction.jsonl', file: new File([b], 'chatInteraction.jsonl') }];
      const direct = await parseContinueDevData(files, null, new Set(), c);
      const viaDriver = await parseFolderCached(c, files, null, new Map());   // pattern filter must drop chatInteraction.jsonl
      const t = direct.rows.reduce((x, r) => ({ in: x.in + r.in, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, out: 0, msgs: 0 });
      return { ...t, badLines: direct.meta.badLines, files: direct.meta.files, driverFiles: viaDriver.meta.files, models: [...new Set(direct.rows.map(r => r.model))].sort(), platform: direct.rows[0].platform,
        hourOk: direct.rows.some(r => r.hour === new Date('2026-08-11T21:00:00.000Z').getHours()), kind: c.kind, cat: c.category, card: !!document.getElementById('src-continue') };
    }, ctA, ctB);
    ok('continue: tokensGenerated.jsonl → in=2500 out=280 msgs=3 (1 truncated line); other dev_data files ignored by the pattern',
      ct.in === 2500 && ct.out === 280 && ct.msgs === 3 && ct.badLines === 1 && ct.files === 1 && ct.driverFiles === 1 && JSON.stringify(ct.models) === JSON.stringify(['claude-sonnet-4.5', 'qwen3:14b'])
      && ct.platform === 'Continue.dev' && ct.hourOk && ct.kind === 'folder-log' && ct.cat === 'coding' && ct.card, JSON.stringify(ct));

    // ---- T11: Cline + Roo Code ----
    const clA = read('cline', 'tasks', '1786352400000', 'ui_messages.json'), clM = read('cline', 'tasks', '1786352400000', 'task_metadata.json'), clB = read('cline', 'tasks', '1786352500000', 'ui_messages.json');
    const cl = await page.evaluate(async (a, m, b) => {
      const mk = () => [
        { path: 'tasks/1786352400000/ui_messages.json', file: new File([a], 'ui_messages.json') },
        { path: 'tasks/1786352400000/task_metadata.json', file: new File([m], 'task_metadata.json') },
        { path: 'tasks/1786352500000/ui_messages.json', file: new File([b], 'ui_messages.json') },
      ];
      const cline = connectorById('cline'), roo = connectorById('roo');
      const r1 = await parseFolderCached(cline, mk(), null, new Map());   // through the driver: siblings must reach the parser
      const r2 = await parseFolderCached(roo, mk(), null, new Map());
      const t = r1.rows.reduce((x, r) => ({ in: x.in + r.in, cw: x.cw + r.cw, cr: x.cr + r.cr, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });
      const direct = await parseClineTasks(mk().slice(0, 2), null, new Set(), cline, mk());
      return { ...t, files: r1.meta.files, badLines: r1.meta.badLines, model: r1.rows[0].model, p1: r1.rows[0].platform, p2: r2.rows[0].platform, sameParser: cline.parser === roo.parser && cline.parser === 'parseClineTasks',
        extCost: direct.meta.extCost, sid: r1.rows[0].sid, hourOk: r1.rows.some(r => r.hour === new Date('2026-08-10T21:03:20.000Z').getHours()),
        cards: !!document.getElementById('src-cline') && !!document.getElementById('src-roo'), cats: cline.category === 'coding' && roo.category === 'coding' };
    }, clA, clM, clB);
    ok('cline/roo: api_req_started tokens → in=1700 out=380 cw=100 cr=900 msgs=2 (dup + in-flight skipped); model from task_metadata; malformed task = badLines',
      cl.in === 1700 && cl.out === 380 && cl.cw === 100 && cl.cr === 900 && cl.msgs === 2 && cl.files === 2 && cl.badLines === 1 && cl.model === 'claude-sonnet-4.5' && Math.abs(cl.extCost - 0.016) < 1e-9
      && cl.sid === '1786352400000' && cl.hourOk, JSON.stringify(cl));
    ok('cline/roo: one shared parser, two entries with their own platform strings and cards', cl.sameParser && cl.p1 === 'Cline' && cl.p2 === 'Roo Code' && cl.cards && cl.cats, JSON.stringify(cl));

    // ---- T12: Aider ----
    const aiderText = read('aider', 'proj', '.aider.chat.history.md');
    const ai = await page.evaluate(async (text) => {
      const c = connectorById('aider');
      const res = await parseAiderHistory([{ path: 'proj/.aider.chat.history.md', file: new File([text], '.aider.chat.history.md') }], null, new Set(), c);
      const t = res.rows.reduce((x, r) => ({ in: x.in + r.in, cw: x.cw + r.cw, cr: x.cr + r.cr, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });
      const byModel = Object.fromEntries(res.rows.map(r => [r.model, r.d]));
      const models = [...new Set(res.rows.map(r => r.model))].sort();
      return { ...t, badLines: res.meta.badLines, lines: res.meta.lines, allEst: res.rows.every(r => r.est === 1), noHour: res.rows.every(r => r.hour == null), byModel, models, platform: res.rows[0].platform,
        quality: c.quality, kind: c.kind, cat: c.category, card: !!document.getElementById('src-aider'), badge: document.querySelector('#src-aider .badge').textContent };
    }, aiderText);
    ok('aider: "Tokens:" lines → est. in=10600 cw=2100 cr=8000 out=1828 msgs=3; k-rounding honored; unparseable line = badLines; per-session model + day; no hour',
      ai.in === 10600 && ai.cw === 2100 && ai.cr === 8000 && ai.out === 1828 && ai.msgs === 3 && ai.badLines === 1 && ai.lines === 4 && ai.allEst && ai.noHour
      && ai.byModel['gpt-5.4'] === '2026-08-10' && ai.byModel['claude-sonnet-4.5'] === '2026-08-11' && ai.platform === 'Aider', JSON.stringify(ai));
    ok('aider: "Main model:" line is recognized (not just "Model:"); "Weak model:" never overrides the row model — models are exactly [claude-sonnet-4.5, gpt-5.4], never "aider" or "gpt-5-mini"',
      JSON.stringify(ai.models) === JSON.stringify(['claude-sonnet-4.5', 'gpt-5.4']), JSON.stringify(ai));
    ok('aider: card is honest — estimated badge, folder-log coding tool', ai.quality === 'estimated' && /estimated/i.test(ai.badge) && ai.kind === 'folder-log' && ai.cat === 'coding' && ai.card, JSON.stringify(ai));

    // ---- T13: JetBrains Junie ----
    const junieText = read('junie', '.matterhorn', 'events', 'ISSUE-1 task-1-events.jsonl');
    const ju = await page.evaluate(async (text) => {
      const c = connectorById('junie');
      const res = await parseJunieEvents([{ path: '.matterhorn/events/ISSUE-1 task-1-events.jsonl', file: new File([text], 'ISSUE-1 task-1-events.jsonl') }], null, new Set(), c);
      const t = res.rows.reduce((x, r) => ({ in: x.in + r.in, cr: x.cr + r.cr, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, cr: 0, out: 0, msgs: 0 });
      const matched = c.patterns.some(re => re.test('.matterhorn/events/ISSUE-1 task-1-events.jsonl')) && c.patterns.some(re => re.test('sessions/abc/events.jsonl'));
      return { ...t, badLines: res.meta.badLines, models: [...new Set(res.rows.map(r => r.model))].sort(), platform: res.rows[0].platform, hourOk: res.rows.some(r => r.hour === new Date('2026-08-10T21:00:00.000Z').getHours()),
        matched, quality: c.quality, kind: c.kind, cat: c.category, card: !!document.getElementById('src-junie'), noteOk: /AI Assistant chat/.test(c.qualityNote) };
    }, junieText);
    ok('junie: LlmResponseEvent records → in=2700 cr=600 out=360 msgs=3 (tolerant nesting); truncated line = badLines; both IDE and CLI file names match',
      ju.in === 2700 && ju.cr === 600 && ju.out === 360 && ju.msgs === 3 && ju.badLines === 1 && JSON.stringify(ju.models) === JSON.stringify(['claude-sonnet-4.5', 'gpt-5.4']) && ju.platform === 'JetBrains Junie' && ju.hourOk && ju.matched, JSON.stringify(ju));
    ok('junie: card is honest about coverage (estimated; Junie runs only)', ju.quality === 'estimated' && ju.noteOk && ju.kind === 'folder-log' && ju.cat === 'coding' && ju.card, JSON.stringify(ju));

    // ---- T14: LM Studio ----
    const lmA = read('lmstudio', 'conversations', '1723', 'chat.conversation.json'), lmB = read('lmstudio', 'conversations', '1723', 'bad.conversation.json');
    const lm = await page.evaluate(async (a, b) => {
      App.renderHub();   // hub query below needs a fresh synchronous render (App.render() is rAF-batched)
      const c = connectorById('lmstudio');
      const res = await parseLmStudioConversations([{ path: 'conversations/1723/chat.conversation.json', file: new File([a], 'chat.conversation.json') }, { path: 'conversations/1723/bad.conversation.json', file: new File([b], 'bad.conversation.json') }], null, new Set(), c);
      const t = res.rows.reduce((x, r) => ({ in: x.in + r.in, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, out: 0, msgs: 0 });
      // honesty: the $0 price is PLATFORM-gated (a row's own platform is a registered 'local' connector), not a model-name regex —
      // a hosted model that happens to share a base name with an open-weight one (Mistral API, Groq Llama/Gemma, OpenRouter) must still be priced.
      Pricing.load();
      return { ...t, files: res.meta.files, badLines: res.meta.badLines, models: [...new Set(res.rows.map(r => r.model))].sort(), platform: res.rows[0].platform, days: [...new Set(res.rows.map(r => r.d))], expDay: dayKey(new Date('2026-08-10T09:00:00.000Z')),
        kind: c.kind, cat: c.category, card: !!document.getElementById('src-lmstudio'), hub: !!document.querySelector('#accounts-hub .hub-group[data-group="local"] .acct[data-connector="lmstudio"]'),
        localCost: Pricing.cost('llama-3.3-70b', { in: 1_000_000, out: 1_000_000, cw: 0, cr: 0, platform: 'LM Studio' }),
        hostedStillPriced: Pricing.cost('claude-sonnet-5', { in: 1_000_000, out: 0, cw: 0, cr: 0 }),
        mistralApiHosted: Pricing.cost('mistral-large-latest', { in: 1_000_000, out: 1_000_000 }),
        openrouterMistralHosted: Pricing.cost('mistralai/mistral-large', { in: 1_000_000, out: 1_000_000 }),
        groqLlamaHosted: Pricing.cost('llama-3.3-70b-versatile', { in: 1_000_000, out: 1_000_000 }) };
    }, lmA, lmB);
    ok('lmstudio: genInfo.stats per selected assistant version → in=1970 out=350 msgs=3; regenerated sibling ignored; malformed file = badLines; day from createdAt',
      lm.in === 1970 && lm.out === 350 && lm.msgs === 3 && lm.files === 2 && lm.badLines === 1 && JSON.stringify(lm.models) === JSON.stringify(['llama-4-8b', 'qwen3-14b']) && lm.platform === 'LM Studio'
      && lm.days.length === 1 && lm.days[0] === lm.expDay, JSON.stringify(lm));
    ok('lmstudio: registry entry is a Local-runner folder-log card', lm.kind === 'folder-log' && lm.cat === 'local' && lm.card && lm.hub, JSON.stringify(lm));
    ok('pricing: $0 is platform-gated (row.platform is a registered "local" connector) — a local-runner row prices at $0, but a hosted model with the same base name (Mistral API, Groq, OpenRouter) is NOT zero-priced',
      lm.localCost === 0 && lm.hostedStillPriced > 0 && lm.mistralApiHosted > 0 && lm.openrouterMistralHosted > 0 && lm.groqLlamaHosted > 0,
      JSON.stringify({ localCost: lm.localCost, hostedStillPriced: lm.hostedStillPriced, mistralApiHosted: lm.mistralApiHosted, openrouterMistralHosted: lm.openrouterMistralHosted, groqLlamaHosted: lm.groqLlamaHosted }));

    // ---- T15: Ollama local-server ----
    const ol = await page.evaluate(async (text) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const c = connectorById('ollama');
      const origFetch = fetchJSON, origProbe = probeServer;
      window.fetchJSON = async (url) => {
        const u = String(url);
        if (u.endsWith('/api/tags')) return { models: [{ name: 'llama4:8b' }, { name: 'qwen3:14b' }] };
        if (u.endsWith('/api/ps')) return { models: [{ name: 'llama4:8b' }] };
        throw new Error('unexpected ' + u);
      };
      await App.connectServer(c);
      const okState = { label: Store.connectors.ollama && Store.connectors.ollama.label, status: Store.connectorStatus(c), text: document.getElementById('ollama-status').textContent, url: LS.get('url:ollama', null) };
      // server up but CORS-blocked: fetch throws TypeError, the no-cors probe succeeds
      window.fetchJSON = async () => { throw new TypeError('Failed to fetch'); };
      window.probeServer = async () => true;
      await App.connectServer(c);
      const cors = { err: Store.connectors.ollama && Store.connectors.ollama.err, status: Store.connectorStatus(c), text: document.getElementById('ollama-status').textContent };
      // server down: the probe fails too → off (not an error state)
      window.probeServer = async () => false;
      await App.connectServer(c);
      const down = { has: !!Store.connectors.ollama, status: Store.connectorStatus(c), text: document.getElementById('ollama-status').textContent };
      window.fetchJSON = origFetch; window.probeServer = origProbe;
      // the same card also reads usage-logger JSONL through the folder-log path
      await App.scanFiles(c, [{ path: 'ollama-usage.jsonl', file: new File([text], 'ollama-usage.jsonl') }]);
      const logged = Store.sources.ollama && Store.sources.ollama.rows.reduce((a, r) => a + r.in, 0);
      Store.sources = {}; Store.connectors = {}; Store.persist();
      return { okState, cors, down, logged, kind: c.kind, cat: c.category, quality: c.quality, card: !!document.getElementById('src-ollama') && !!document.getElementById('ollama-url') && !!document.getElementById('ollama-validate') && !!document.getElementById('ollama-pick'),
        note: /no usage history|keeps no usage history/i.test(c.qualityNote) && /db\.sqlite/.test(c.qualityNote) };
    }, logText);
    ok('ollama: validates via stubbed /api/tags + /api/ps (label = models installed, detail = loaded now); URL persisted',
      /2 models installed/.test(ol.okState.label || '') && ol.okState.status === 'ok' && /1 loaded/.test(ol.okState.text) && ol.okState.url === 'http://localhost:11434', JSON.stringify(ol.okState));
    ok('ollama: CORS-blocked → attention with the OLLAMA_ORIGINS fix; unreachable → off ("not running")',
      /OLLAMA_ORIGINS/.test(ol.cors.err || '') && ol.cors.status === 'warn' && /OLLAMA_ORIGINS/.test(ol.cors.text) && !ol.down.has && ol.down.status === 'off' && /not running/i.test(ol.down.text), JSON.stringify({ cors: ol.cors, down: ol.down }));
    ok('ollama: one card = local-server validate + usage-logger folder (exact, honest note); logger rows land under the ollama source',
      ol.kind === 'local-server' && ol.cat === 'local' && ol.quality === 'exact' && ol.card && ol.note && ol.logged === 1060, JSON.stringify(ol));
  } finally {
    await page.close();
  }
}
