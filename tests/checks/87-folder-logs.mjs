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
    ok('gemini-cli: session JSON → in=1825 (incl. 25 tool-use prompt tokens) cr=1700 out=470 msgs=3 (dup id + token-less message skipped); malformed file counted as badLines',
      gc.in === 1825 && gc.cr === 1700 && gc.out === 470 && gc.msgs === 3 && gc.files === 2 && gc.badLines === 1 && JSON.stringify(gc.models) === JSON.stringify(['gemini-3-flash', 'gemini-3-pro'])
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

    // ---- T11b: tokensIn semantics (inclusive vs exclusive) + per-request model attribution from model_usage[] ----
    const rooA = read('roo', 'tasks', '1786352600000', 'ui_messages.json'), rooM = read('roo', 'tasks', '1786352600000', 'task_metadata.json');
    const clC = read('cline', 'tasks', '1786352700000', 'ui_messages.json'), clCM = read('cline', 'tasks', '1786352700000', 'task_metadata.json');
    const cl2 = await page.evaluate(async (a, m, b, bm) => {
      const mk = () => [
        { path: 'tasks/1786352600000/ui_messages.json', file: new File([a], 'ui_messages.json', { lastModified: Date.parse('2026-08-12T12:00:00.000Z') }) },
        { path: 'tasks/1786352600000/task_metadata.json', file: new File([m], 'task_metadata.json') },
        { path: 'tasks/1786352700000/ui_messages.json', file: new File([b], 'ui_messages.json') },
        { path: 'tasks/1786352700000/task_metadata.json', file: new File([bm], 'task_metadata.json') },
      ];
      const roo = await parseFolderCached(connectorById('roo'), mk(), null, new Map());
      const cline = await parseFolderCached(connectorById('cline'), mk(), null, new Map());
      const H = (iso) => new Date(iso).getHours();
      const pick = (rows, sid, hour) => rows.filter(x => x.sid === sid && (hour == null ? x.hour == null : x.hour === hour)).map(x => [x.d, x.model, x.in, x.cw, x.cr, x.out, x.msgs]);
      return {
        rooOpus: pick(roo.rows, '1786352600000', H('2026-08-10T09:00:05.000Z')),
        rooSonnet10: pick(roo.rows, '1786352600000', H('2026-08-10T10:00:05.000Z')),
        rooSonnet11: pick(roo.rows, '1786352600000', H('2026-08-10T11:00:00.000Z')),
        rooNoTs: pick(roo.rows, '1786352600000', null),
        rooCl: pick(roo.rows, '1786352700000', H('2026-08-11T09:00:05.000Z')),
        clineCl: pick(cline.rows, '1786352700000', H('2026-08-11T09:00:05.000Z')),
        clineOpus: pick(cline.rows, '1786352600000', H('2026-08-10T09:00:05.000Z')),
        n: roo.rows.length, msgs: roo.meta.msgs,
      };
    }, rooA, rooM, clC, clCM);
    const J = JSON.stringify;
    ok('cline/roo: model per request = model_usage entry with greatest ts <= request ts (sorted; first entry before any switch; last entry when ts missing)',
      J(cl2.rooOpus.map(r => r[1])) === J(['claude-opus-4.1']) && J(cl2.rooSonnet10.map(r => r[1])) === J(['claude-sonnet-4.5']) && J(cl2.rooSonnet11.map(r => r[1])) === J(['claude-sonnet-4.5'])
      && J(cl2.rooNoTs.map(r => [r[0], r[1]])) === J([['2026-08-12', 'claude-sonnet-4.5']]) && cl2.n === 5 && cl2.msgs === 5, J(cl2));
    ok('roo: tokensIn is INCLUSIVE of cache → in = tokensIn - cacheReads - cacheWrites (openai proto 50000/45000 → in=5000 cr=45000; no-proto 2000/200/300 → in=1500); evidently-exclusive row (100 < 900) keeps in=100',
      J(cl2.rooOpus) === J([['2026-08-10', 'claude-opus-4.1', 5000, 0, 45000, 100, 1]]) && J(cl2.rooSonnet10) === J([['2026-08-10', 'claude-sonnet-4.5', 1500, 200, 300, 50, 1]])
      && J(cl2.rooSonnet11) === J([['2026-08-10', 'claude-sonnet-4.5', 100, 0, 900, 10, 1]]) && J(cl2.rooCl) === J([['2026-08-11', 'claude-sonnet-4.5', 500, 100, 400, 20, 1]]), J(cl2));
    ok('cline: anthropic-provider rows stay additive (1000/100/400 → in=1000); apiProtocol openai rows subtract (→ in=5000)',
      J(cl2.clineCl) === J([['2026-08-11', 'claude-sonnet-4.5', 1000, 100, 400, 20, 1]]) && J(cl2.clineOpus) === J([['2026-08-10', 'claude-opus-4.1', 5000, 0, 45000, 100, 1]]), J(cl2));

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

    // ---- T12b: free local inference THROUGH coding tools — row-level local:1 from the provider hint → Pricing.cost = $0 ----
    // The row keeps its own platform (Continue.dev / Cline / Aider / OpenAI Codex CLI — none is a 'local' connector), so the
    // platform gate alone would price qwen3:14b at the "Unknown model" $3/$15 fallback. Hosted rows in the same files stay priced.
    const clLA = read('cline', 'tasks', '1786352800000', 'ui_messages.json'), clLM = read('cline', 'tasks', '1786352800000', 'task_metadata.json');
    const aiLocal = read('aider', 'local', '.aider.chat.history.md');
    const cxOss = read('codex', 'sessions', '2026', '08', '12', 'rollout-2026-08-12T09-00-00-oss.jsonl'), cxNamed = read('codex', 'sessions', '2026', '08', '12', 'rollout-2026-08-12T10-00-00-named.jsonl');
    const lc = await page.evaluate(async (ctText, clA, clM, aiText, cxA, cxB) => {
      Pricing.load();
      const cost = (r) => Pricing.cost(r.model, r);
      const ct = await parseContinueDevData([{ path: 'dev_data/0.2.0/tokensGenerated.jsonl', file: new File([ctText], 'tokensGenerated.jsonl') }], null, new Set(), connectorById('continue'));
      const ctLocal = ct.rows.filter(r => r.model === 'qwen3:14b'), ctHosted = ct.rows.filter(r => r.model === 'claude-sonnet-4.5');
      const mk = () => [{ path: 'tasks/1786352800000/ui_messages.json', file: new File([clA], 'ui_messages.json') }, { path: 'tasks/1786352800000/task_metadata.json', file: new File([clM], 'task_metadata.json') }];
      const cl = await parseFolderCached(connectorById('cline'), mk(), null, new Map());
      const ai = await parseAiderHistory([{ path: 'local/.aider.chat.history.md', file: new File([aiText], '.aider.chat.history.md') }], null, new Set(), connectorById('aider'));
      const cx = await parseCodexRollouts([
        { path: 'sessions/2026/08/12/rollout-2026-08-12T09-00-00-oss.jsonl', file: new File([cxA], 'rollout-2026-08-12T09-00-00-oss.jsonl') },
        { path: 'sessions/2026/08/12/rollout-2026-08-12T10-00-00-named.jsonl', file: new File([cxB], 'rollout-2026-08-12T10-00-00-named.jsonl') },
      ], null, new Set(), connectorById('codex'));
      const cxOss = cx.rows.filter(r => r.sid === 'rollout-2026-08-12T09-00-00-oss'), cxNamed = cx.rows.filter(r => r.sid === 'rollout-2026-08-12T10-00-00-named');
      return {
        ctLocalN: ctLocal.length, ctLocalFlag: ctLocal.every(r => r.local === 1), ctLocalCost: ctLocal.reduce((a, r) => a + cost(r), 0), ctLocalPlatform: ctLocal[0] && ctLocal[0].platform,
        ctHostedN: ctHosted.length, ctHostedFlag: ctHosted.some(r => r.local), ctHostedCost: ctHosted.reduce((a, r) => a + cost(r), 0),
        clN: cl.rows.length, clFlag: cl.rows.every(r => r.local === 1), clCost: cl.rows.reduce((a, r) => a + cost(r), 0), clModel: cl.rows[0] && cl.rows[0].model, clPlatform: cl.rows[0] && cl.rows[0].platform, clIn: cl.rows.reduce((a, r) => a + r.in, 0),
        aiN: ai.rows.length, aiFlag: ai.rows.every(r => r.local === 1), aiCost: ai.rows.reduce((a, r) => a + cost(r), 0), aiModel: ai.rows[0] && ai.rows[0].model, aiEst: ai.rows.every(r => r.est === 1),
        cxOssN: cxOss.length, cxOssFlag: cxOss.every(r => r.local === 1), cxOssCost: cxOss.reduce((a, r) => a + cost(r), 0), cxOssModel: cxOss[0] && cxOss[0].model,
        cxNamedN: cxNamed.length, cxNamedFlag: cxNamed.some(r => r.local), cxNamedCost: cxNamed.reduce((a, r) => a + cost(r), 0),
        directLocal: Pricing.cost('qwen3:14b', { in: 1_000_000, out: 1_000_000, cw: 0, cr: 0, platform: 'Continue.dev', local: 1 }),
        directHosted: Pricing.cost('qwen3:14b', { in: 1_000_000, out: 1_000_000, cw: 0, cr: 0, platform: 'Continue.dev' }),
      };
    }, ctA, clLA, clLM, aiLocal, cxOss, cxNamed);
    ok('continue: {model:qwen3:14b, provider:ollama} row carries local:1 and Pricing.cost = $0 (platform stays Continue.dev); the anthropic-provider claude-sonnet-4.5 rows carry no flag and still cost > 0',
      lc.ctLocalN === 1 && lc.ctLocalFlag && lc.ctLocalCost === 0 && lc.ctLocalPlatform === 'Continue.dev' && lc.ctHostedN >= 1 && !lc.ctHostedFlag && lc.ctHostedCost > 0, JSON.stringify(lc));
    ok('cline: task_metadata model_usage[].model_provider_id "ollama" → row local:1, $0 (qwen3:14b in=400 under platform Cline)',
      lc.clN === 1 && lc.clFlag && lc.clCost === 0 && lc.clModel === 'qwen3:14b' && lc.clPlatform === 'Cline' && lc.clIn === 400, JSON.stringify(lc));
    ok('aider: "ollama_chat/qwen3" model prefix → row local:1, $0 (still est:1; model string kept verbatim)',
      lc.aiN === 1 && lc.aiFlag && lc.aiCost === 0 && lc.aiModel === 'ollama_chat/qwen3' && lc.aiEst, JSON.stringify(lc));
    ok('codex: session_meta.payload.model_provider "ollama" → rows local:1, $0; a gpt-oss:20b session WITHOUT that field is NOT flagged (model name alone never means local) and is priced',
      lc.cxOssN === 1 && lc.cxOssFlag && lc.cxOssCost === 0 && lc.cxOssModel === 'gpt-oss:20b' && lc.cxNamedN === 1 && !lc.cxNamedFlag && lc.cxNamedCost > 0, JSON.stringify(lc));
    ok('pricing: Pricing.cost honours a row-level local:1 in addition to the platform gate (same model/platform without the flag is priced)',
      lc.directLocal === 0 && lc.directHosted > 0, JSON.stringify({ directLocal: lc.directLocal, directHosted: lc.directHosted }));

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
    ok('ollama: CORS-blocked → attention (err names CORS; status = "something answered … could not read it — most likely Ollama … (CORS)" + the OLLAMA_ORIGINS fix); unreachable → off ("not running")',
      /CORS/.test(ol.cors.err || '') && ol.cors.status === 'warn' && /OLLAMA_ORIGINS/.test(ol.cors.text) && /Something answered at http:\/\/localhost:11434 but this page could not read it/.test(ol.cors.text) && /most likely Ollama blocking the origin \(CORS\)/.test(ol.cors.text) && !/Ollama is running but blocked/.test(ol.cors.text) && !ol.down.has && ol.down.status === 'off' && /not running/i.test(ol.down.text), JSON.stringify({ cors: ol.cors, down: ol.down }));
    ok('ollama: one card = local-server validate + usage-logger folder (exact, honest note); logger rows land under the ollama source',
      ol.kind === 'local-server' && ol.cat === 'local' && ol.quality === 'exact' && ol.card && ol.note && ol.logged === 1060, JSON.stringify(ol));

    // ---- T15b: Ollama dual driver (server validate + usage-log folder) — separate gen slots, separate status lines, no delete while the folder owns the entry ----
    const dual = await page.evaluate(async (text) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const c = connectorById('ollama');
      const origFetch = fetchJSON, origProbe = probeServer, origValidate = validateOllama, origParse = parseFolderCached;
      const files = () => [{ path: 'ollama-usage.jsonl', file: new File([text], 'ollama-usage.jsonl') }];
      const st = () => (document.getElementById('ollama-status') || {}).textContent || '';
      const scanSt = () => (document.getElementById('ollama-scan-status') || {}).textContent || '';
      const out = {};
      // (1) hidden + folder-connected, then the server is unreachable → the folder still owns the entry: stays connected, stays hidden, rows intact
      await App.scanFiles(c, files());
      View.hideCard('ollama');
      window.fetchJSON = async () => { throw new TypeError('Failed to fetch'); };
      window.probeServer = async () => false;
      await App.connectServer(c);
      out.down = { has: !!Store.connectors.ollama, status: Store.connectorStatus(c), hidden: View.isCardHidden('ollama'), label: (Store.connectors.ollama || {}).label || '', err: (Store.connectors.ollama || {}).err || null,
        rows: Store.sources.ollama ? Store.sources.ollama.rows.reduce((a, r) => a + r.in, 0) : 0, text: st(), scanText: scanSt() };
      await App.scanFiles(c, files());   // a later re-scan must NOT read as a fresh off→ok connection (no auto-reveal)
      out.rescan = { hidden: View.isCardHidden('ollama'), status: Store.connectorStatus(c), label: (Store.connectors.ollama || {}).label || '' };
      // (2) concurrent: slow validator + fast scan → both outcomes land (label carries both halves, neither status line blank)
      Store.sources = {}; Store.connectors = {}; LS.del('view'); View.load();
      window.fetchJSON = origFetch; window.probeServer = origProbe;
      window.validateOllama = async () => { await new Promise(r => setTimeout(r, 120)); return { label: '3 models installed', detail: '3 models installed · 1 loaded now' }; };
      await Promise.all([App.connectServer(c), App.scanFiles(c, files())]);
      out.slowServer = { label: (Store.connectors.ollama || {}).label || '', status: Store.connectorStatus(c), text: st(), scanText: scanSt() };
      // reverse order: fast validator + slow scan
      Store.sources = {}; Store.connectors = {};
      window.validateOllama = async () => ({ label: '3 models installed', detail: '3 models installed · 1 loaded now' });
      window.parseFolderCached = async (...a) => { await new Promise(r => setTimeout(r, 120)); return origParse(...a); };
      await Promise.all([App.connectServer(c), App.scanFiles(c, files())]);
      out.slowScan = { label: (Store.connectors.ollama || {}).label || '', status: Store.connectorStatus(c), text: st(), scanText: scanSt(), rows: Store.sources.ollama ? Store.sources.ollama.rows.reduce((a, r) => a + r.in, 0) : 0 };
      // (3) unchanged: nothing else owns the entry + unreachable → deleted, off
      Store.sources = {}; Store.connectors = {};
      window.parseFolderCached = origParse; window.validateOllama = origValidate;
      window.fetchJSON = async () => { throw new TypeError('Failed to fetch'); };
      window.probeServer = async () => false;
      await App.connectServer(c);
      out.bare = { has: !!Store.connectors.ollama, status: Store.connectorStatus(c), text: st() };
      window.fetchJSON = origFetch; window.probeServer = origProbe;
      Store.sources = {}; Store.connectors = {}; Store.persist(); LS.del('view'); View.load();
      return out;
    }, logText);
    ok('ollama dual: server unreachable while the usage-log folder is connected → entry kept (folder label, no err), hidden card stays hidden, rows intact, status says "still connected"; a later re-scan does not auto-reveal',
      dual.down.has && dual.down.status === 'ok' && dual.down.hidden === true && /1 file/.test(dual.down.label) && dual.down.err === null && dual.down.rows === 1060
        && /not running/i.test(dual.down.text) && /still connected/i.test(dual.down.text) && /1 file/.test(dual.down.scanText)
        && dual.rescan.hidden === true && dual.rescan.status === 'ok' && /1 file/.test(dual.rescan.label), JSON.stringify({ down: dual.down, rescan: dual.rescan }));
    ok('ollama dual: connectServer and scanFiles run concurrently (either order) → both outcomes land: label = server half + file count, both status lines non-blank',
      /3 models installed/.test(dual.slowServer.label) && /1 file/.test(dual.slowServer.label) && dual.slowServer.status === 'ok' && /Connected/.test(dual.slowServer.text) && /1 file/.test(dual.slowServer.scanText)
        && /3 models installed/.test(dual.slowScan.label) && /1 file/.test(dual.slowScan.label) && dual.slowScan.status === 'ok' && /Connected/.test(dual.slowScan.text) && /1 file/.test(dual.slowScan.scanText) && dual.slowScan.rows === 1060,
      JSON.stringify({ slowServer: dual.slowServer, slowScan: dual.slowScan }));
    ok('ollama dual: no folder attached + unreachable → entry deleted, off, "not running" (unchanged)',
      !dual.bare.has && dual.bare.status === 'off' && /not running/i.test(dual.bare.text), JSON.stringify(dual.bare));

    // ---- T16: exports (Gemini Takeout + Cursor CSV) ----
    const takeout = read('takeout', 'MyActivity.json'), cursorCsv = read('cursor', 'usage-events.csv');
    const ex = await page.evaluate(async (tk, cs) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const kind = sniffJSON(JSON.parse(tk), 'MyActivity.json');
      const g = parseGeminiTakeout(JSON.parse(tk));
      const gt = g.rows.reduce((a, r) => ({ in: a.in + r.in, out: a.out + r.out, msgs: a.msgs + r.msgs, est: a.est && r.est === 1 }), { in: 0, out: 0, msgs: 0, est: true });
      const head = parseCSV(cs.split(/\r?\n/, 1)[0])[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
      const isCursor = isCursorUsageCSV(head), isGenericHead = isCursorUsageCSV(['date', 'platform', 'model', 'input_tokens', 'output_tokens']);
      const cu = parseCursorUsageCSV(cs);
      const ct = cu.rows.reduce((a, r) => ({ in: a.in + r.in, cw: a.cw + r.cw, cr: a.cr + r.cr, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });
      // no Total Tokens column → additive reading, nothing to reconcile against (unreconciled stays 0)
      const cuNoTotal = parseCursorUsageCSV('Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens\n2026-08-12T09:00:00.000Z,Included,gpt-5.4,No,300,700,20,40\n');
      const ctNoTotal = { in: cuNoTotal.rows[0].in, cw: cuNoTotal.rows[0].cw, cr: cuNoTotal.rows[0].cr, out: cuNoTotal.rows[0].out, unrec: cuNoTotal.meta.unreconciled };
      await App.handleImportFiles([new File([tk], 'MyActivity.json', { type: 'application/json' }), new File([cs], 'usage-events.csv', { type: 'text/csv' })]);
      const notes = document.getElementById('import-status').textContent;
      const out = { kind, gt, gPlat: g.rows[0].platform, gSkipped: g.meta.skipped, gHourOk: g.rows.some(r => r.hour === new Date('2026-08-10T21:30:00.000Z').getHours()),
        isCursor, isGenericHead, ct, ctNoTotal, cPlat: cu.rows[0].platform, cRejected: cu.meta.rejected, cUnrec: cu.meta.unreconciled, cBilled: cu.billed.length,
        srcT: !!Store.sources['gemini-takeout'], srcC: !!Store.sources['cursor-csv'], genericCsvUntouched: !Store.sources.csv, notes,
        badge: document.querySelector('#src-import .badge').textContent, imports: connectorById('imports').srcIds, order: PLATFORM_ORDER };
      Store.sources = {}; Store.connectors = {}; Store.persist();
      return out;
    }, takeout, cursorCsv);
    ok('takeout: MyActivity.json sniffed as gemini-takeout and parsed (est. in=16 out=23 msgs=3; 2 records skipped; hour kept) as platform "Gemini app"',
      ex.kind === 'gemini-takeout' && ex.gt.in === 16 && ex.gt.out === 23 && ex.gt.msgs === 3 && ex.gt.est && ex.gPlat === 'Gemini app' && ex.gSkipped === 2 && ex.gHourOk, JSON.stringify(ex.gt));
    ok('cursor: usage-events CSV detected (generic CSV header is NOT) and parsed with the four ADDITIVE token columns reconciled against Total Tokens (in=36666 cw=39521 cr=301106 out=28804 msgs=5; 1 rejected cell; 1 unreconciled row; legacy superset row still read; no cost column)',
      ex.isCursor && !ex.isGenericHead && ex.ct.in === 36666 && ex.ct.cw === 39521 && ex.ct.cr === 301106 && ex.ct.out === 28804 && ex.ct.msgs === 5 && ex.cPlat === 'Cursor' && ex.cRejected === 1 && ex.cUnrec === 1 && ex.cBilled === 0,
      JSON.stringify({ ct: ex.ct, rejected: ex.cRejected, unreconciled: ex.cUnrec }));
    ok('cursor: no Total Tokens column → additive reading (in=700 cw=300 cr=20 out=40), unreconciled=0; import note surfaces the unreconciled count',
      ex.ctNoTotal.in === 700 && ex.ctNoTotal.cw === 300 && ex.ctNoTotal.cr === 20 && ex.ctNoTotal.out === 40 && ex.ctNoTotal.unrec === 0 && /1 row did not reconcile with Total Tokens/.test(ex.notes),
      JSON.stringify({ ctNoTotal: ex.ctNoTotal, notes: ex.notes }));
    ok('imports: drop zone routes both formats to their own sources (generic csv untouched); badge + srcIds + PLATFORM_ORDER list them',
      ex.srcT && ex.srcC && ex.genericCsvUntouched && /Gemini Takeout/.test(ex.notes) && /Cursor/.test(ex.notes) && /Takeout/.test(ex.badge) && /Cursor/.test(ex.badge)
      && ex.imports.includes('gemini-takeout') && ex.imports.includes('cursor-csv') && ex.order.includes('Gemini app') && ex.order.includes('Cursor'), JSON.stringify({ notes: ex.notes, badge: ex.badge, imports: ex.imports }));

    // rescanFolder: a stored handle whose permission is DENIED must not fall through to the folder
    // picker — show a status line about the permission and stop; the picker opens only with NO stored handle.
    const denied = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const origPick = App.pickFolderFor, origScan = App.scanFolder;
      let picks = 0, scans = 0; App.pickFolderFor = async () => { picks++; }; App.scanFolder = async () => { scans++; };
      App._dirHandles.aider = { queryPermission: async () => 'prompt', requestPermission: async () => 'denied' };
      await App.rescanFolder('aider');
      const status = (App._scanStatusEl('aider') || {}).textContent || '';
      const out = { picks, scans, status };
      delete App._dirHandles.aider;
      await App.rescanFolder('aider');   // no stored handle → picker IS the right path
      out.picksNoHandle = picks;
      App.pickFolderFor = origPick; App.scanFolder = origScan;
      return out;
    });
    ok('rescanFolder: denied permission on a stored handle → no picker, no scan, status mentions the permission (picker only when no handle is stored)',
      denied.picks === 0 && denied.scans === 0 && /permission/i.test(denied.status) && /Pick folder|Choose/i.test(denied.status) && denied.picksNoHandle === 1, JSON.stringify(denied));

    // ---- copy corrections: card notes must state data quality honestly ----
    const copy = await page.evaluate(() => {
      const n = (id) => (connectorById(id) || {}).qualityNote || '';
      return { ollama: n('ollama'), lmstudio: n('lmstudio'), copilotCli: n('copilot-cli'), geminiCli: n('gemini-cli') };
    });
    ok('copy: Ollama / LM Studio notes say $0 on your hardware and never point at the removed "Local open-weight" price row',
      /\$0/.test(copy.ollama) && /\$0/.test(copy.lmstudio) && !/Local open-weight/i.test(copy.ollama) && !/Local open-weight/i.test(copy.lmstudio) && /hosted-equivalent/i.test(copy.ollama) && /hosted-equivalent/i.test(copy.lmstudio),
      JSON.stringify(copy));
    ok('copy: Copilot CLI note states the $ is the API list-price equivalent of a flat-rate plan, not GitHub\'s bill',
      /flat-rate plan/.test(copy.copilotCli) && /list-price equivalent/.test(copy.copilotCli) && /not what GitHub charges you/.test(copy.copilotCli), copy.copilotCli);
    ok('copy: Gemini CLI note says a re-scan only counts sessions still on disk (no "import regularly" as if history accumulated)',
      /still on disk/.test(copy.geminiCli) && /retention|keep copies/i.test(copy.geminiCli) && !/import regularly/.test(copy.geminiCli), copy.geminiCli);

    // ---- generic local-server CORS diagnosis (no corsHint on the connector) must not over-claim either ----
    const genericCors = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const tmp = { id: 'tmp-srv', platform: 'TmpSrv', name: 'Temp server', category: 'local', kind: 'local-server', statusEl: 'tmp-srv-status', brand: '#888888', mark: 'Ts', srcIds: ['tmp-srv'],
        baseUrl: 'http://localhost:9999', validate: 'validateTmpSrv', quality: 'none', qualityNote: 'temp', paths: [], links: {} };
      CONNECTORS.push(tmp); App.ensureSourceCard(tmp);
      const origProbe = probeServer;
      window.validateTmpSrv = async () => { throw new TypeError('Failed to fetch'); };
      window.probeServer = async () => true;
      await App.connectServer(tmp);
      const out = { err: (Store.connectors['tmp-srv'] || {}).err || '', text: document.getElementById('tmp-srv-status').textContent };
      window.probeServer = origProbe; delete window.validateTmpSrv;
      CONNECTORS.splice(CONNECTORS.indexOf(tmp), 1); document.getElementById('src-tmp-srv').remove();
      delete Store.connectors['tmp-srv']; Store.persist(); LS.del('url:tmp-srv');
      return out;
    });
    ok('local-server generic CORS text: "Something answered at <base> but this page could not read it — most likely <name> blocking the origin (CORS)", err names CORS',
      /Something answered at http:\/\/localhost:9999 but this page could not read it/.test(genericCors.text) && /most likely Temp server blocking the origin \(CORS\)/.test(genericCors.text)
      && !/is running at/.test(genericCors.text) && /CORS/.test(genericCors.err), JSON.stringify(genericCors));

    // ---- disconnect / clear-all during an in-flight folder scan: the scan must bail, not resurrect the connector ----
    const race = await page.evaluate(async (text) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const c = connectorById('aider');
      const origParse = parseFolderCached, origConfirm = window.confirm;
      const files = () => [{ path: 'proj/.aider.chat.history.md', file: new File([text], '.aider.chat.history.md') }];
      const out = {};
      // (a) disconnect + delete data mid-scan
      await App.scanFiles(c, files());   // connected first
      out.before = { src: !!Store.sources.aider, conn: !!Store.connectors.aider };
      window.parseFolderCached = async (...a) => { await new Promise(r => setTimeout(r, 150)); return origParse(...a); };
      const p = App.scanFiles(c, files());
      await new Promise(r => setTimeout(r, 20));
      window.confirm = () => true;   // OK = delete the data too
      App.disconnectConnector('aider');
      await p;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      out.afterDisconnect = { src: !!Store.sources.aider, conn: !!Store.connectors.aider, status: Store.connectorStatus(c), text: (App._scanStatusEl('aider') || {}).textContent || '' };
      // (b) clear-all mid-scan
      window.parseFolderCached = origParse;
      await App.scanFiles(c, files());
      window.parseFolderCached = async (...a) => { await new Promise(r => setTimeout(r, 150)); return origParse(...a); };
      const p2 = App.scanFiles(c, files());
      await new Promise(r => setTimeout(r, 20));
      document.getElementById('clear-data').click();   // confirm() still stubbed → OK
      await p2;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      out.afterClear = { src: !!Store.sources.aider, conn: !!Store.connectors.aider, status: Store.connectorStatus(c) };
      window.parseFolderCached = origParse; window.confirm = origConfirm;
      Store.sources = {}; Store.connectors = {}; Store.persist(); LS.del('view'); View.load();
      return out;
    }, read('aider', 'proj', '.aider.chat.history.md'));
    ok('scan race: Disconnect (delete data) during an in-flight folder scan → the scan bails: no source, no connector entry, card off, no "Connected" status',
      race.before.src && race.before.conn && !race.afterDisconnect.src && !race.afterDisconnect.conn && race.afterDisconnect.status === 'off' && !/Connected/.test(race.afterDisconnect.text), JSON.stringify(race));
    ok('scan race: Clear-all during an in-flight folder scan → the scan bails: no source, no connector entry',
      !race.afterClear.src && !race.afterClear.conn && race.afterClear.status === 'off', JSON.stringify(race.afterClear));
  } finally {
    await page.close();
  }
}
