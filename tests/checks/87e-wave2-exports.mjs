import fs from 'node:fs';
import path from 'node:path';
import { openDashboard, OUT } from '../lib/harness.mjs';

const read = (...p) => fs.readFileSync(path.join(OUT, ...p), 'utf8');
const b64 = (...p) => fs.readFileSync(path.join(OUT, ...p)).toString('base64');   // binary fixtures cross into the page as base64 → Uint8Array → File
const near = (a, b) => Math.abs(a - b) < 1e-9;

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    // ---- T8a: readZipEntries round-trip (stored + deflate-raw + unsupported method + not-a-zip) ----
    const zr = await page.evaluate(async (b) => {
      const file = new File([Uint8Array.from(atob(b), ch => ch.charCodeAt(0))], 'mini.zip', { type: 'application/zip' });
      const entries = await readZipEntries(file);
      const out = { names: entries.map(e => e.name), sizes: entries.map(e => e.size), t0: await entries[0].text(), t1len: (await entries[1].text()).length, b1len: (await entries[1].bytes()).length, b1first: (await entries[1].bytes())[0] };
      try { await entries[2].bytes(); out.err = null; } catch (e) { out.err = e.message; }
      try { await readZipEntries(new File(['this is not a zip archive at all, just forty-odd bytes of text'], 'x.zip')); out.notZip = null; } catch (e) { out.notZip = e.message; }
      return out;
    }, b64('wave2', 'zip', 'mini.zip'));
    ok('zip: central-directory reader lists entries, inflates deflate-raw (3000 chars, first byte "a"=97) and reads stored text; unsupported method throws the documented error; non-ZIP throws',
      JSON.stringify(zr.names) === JSON.stringify(['hello.txt', 'data/long.txt', 'weird.bin']) && JSON.stringify(zr.sizes) === JSON.stringify([9, 3000, 1]) && zr.t0 === 'hello zip'
      && zr.t1len === 3000 && zr.b1len === 3000 && zr.b1first === 97 && /unsupported method/.test(zr.err || '') && /Not a ZIP/.test(zr.notZip || ''), JSON.stringify(zr));

    // ---- T8b: DeepSeek API — balance validate (direct fetcher + key driver), monthly usage ZIP (exact), month merge, loose CSVs, header sniffs, ZIP fallbacks ----
    const ds = await page.evaluate(async (zJul, zAug, amountAugCsv, costAugCsv, zMini, zGpt) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const c = connectorById('deepseek');
      const toFile = (b, name) => new File([Uint8Array.from(atob(b), ch => ch.charCodeAt(0))], name, { type: 'application/zip' });
      const sum = (rows) => rows.reduce((a, r) => ({ in: a.in + r.in, cr: a.cr + r.cr, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, cr: 0, out: 0, msgs: 0 });
      const src = () => Store.sources['deepseek-usage-zip'];
      const billedSum = () => Store.billedRows('deepseek-usage-zip').reduce((a, b) => a + b.amount, 0);
      const note = () => document.getElementById('import-status').textContent;
      // (1) balance fetcher, direct: Bearer header, string numbers + currency kept in the label; is_available:false is said
      const origFetch = fetchJSON;
      let seen = null;
      window.fetchJSON = async (url, headers) => { seen = { url: String(url), auth: headers && headers.Authorization }; return { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.30', granted_balance: '0.00', topped_up_balance: '12.30' }] }; };
      try {
        const bal = await fetchDeepSeekBalance('sk-test', {}, { days: 90 });
        // (2) through the key driver (Task 2): key input → connectKey → connector label + ok status
        App.ensureSourceCard(c);
        document.getElementById('deepseek-key').value = 'sk-test';
        await App.connectKey(c);
        const viaDriver = { label: (Store.connectors.deepseek || {}).label, status: Store.connectorStatus(c), text: document.getElementById('deepseek-status').textContent };
        window.fetchJSON = async () => ({ is_available: false, balance_infos: [] });
        const empty = await fetchDeepSeekBalance('sk-test', {}, { days: 90 });
        window.fetchJSON = origFetch;
        Store.connectors = {}; document.getElementById('deepseek-key').value = '';
        // (3) July ZIP through the Imports drop zone → rows under deepseek-usage-zip (platform DeepSeek API), billed from the cost CSV, deepseek card connected
        await App.handleImportFiles([toFile(zJul, 'usage-2026-07.zip')]);
        const jul = { t: sum(src().rows), buckets: src().rows.length, platforms: [...new Set(src().rows.map(r => r.platform))], models: [...new Set(src().rows.map(r => r.model))].sort(),
          billed: Store.billedRows('deepseek-usage-zip'), meta: src().meta, note: note(), status: Store.connectorStatus(c), label: (Store.connectors.deepseek || {}).label || '', est: src().rows.some(r => r.est) };
        // (4) August ZIP → merges by (day, model) / day — July is kept
        await App.handleImportFiles([toFile(zAug, 'usage-2026-08.zip')]);
        const aug = { t: sum(src().rows), buckets: src().rows.length, billedDays: Store.billedRows('deepseek-usage-zip').map(b => b.d), billedSum: billedSum(), metaRows: src().meta.rows, metaFiles: src().meta.files };
        // (5) the same August CSVs dropped loose → same keys replace, nothing doubles; the generic csv source is untouched
        await App.handleImportFiles([new File([amountAugCsv], 'amount-2026-08.csv', { type: 'text/csv' }), new File([costAugCsv], 'cost-2026-08.csv', { type: 'text/csv' })]);
        const loose = { t: sum(src().rows), buckets: src().rows.length, billedSum: billedSum(), notes: (note().match(/DeepSeek API usage export/g) || []).length, genericUntouched: !Store.sources.csv, metaRows: src().meta.rows, metaFiles: src().meta.files };
        // (6) header sniffs + the wide / priced shapes
        const head = (s) => (parseCSV(s.split(/\r?\n/, 1)[0])[0] || []).map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
        const wide = 'date,model,input_tokens,cache_hit_tokens,output_tokens,requests\n2026-08-12,deepseek-chat,1000,400,100,5\n';   // input is the total → uncached = 1000 − 400 = 600
        const wideRes = parseDeepSeekAmountCSV(wide);
        const priced = parseDeepSeekAmountCSV('utc_date,model,api_key_name,type,price,amount\n20260812,deepseek-chat,k,output_tokens,0.0000011,1000\n20260812,deepseek-chat,k,request_count,,4\n');   // 0.0000011 × 1000 = 0.0011
        const sniff = { wide: isDeepSeekAmountCSV(head(wide), 'x.csv'), generic: isDeepSeekAmountCSV(['date', 'platform', 'model', 'input_tokens', 'output_tokens'], 'x.csv'),
          genericCost: isDeepSeekCostCSV(['date', 'platform', 'model', 'cost_usd'], 'x.csv'), cursor: isDeepSeekAmountCSV(['date', 'kind', 'model', 'max_mode', 'input_w_cache_write', 'input_w_o_cache_write', 'cache_read', 'output_tokens', 'total_tokens'], 'usage-events.csv'),
          byName: isDeepSeekCostCSV(['utc_date', 'model', 'api_key_name', 'currency', 'cost'], 'cost-2026-07.csv'),
          wideT: sum(wideRes.rows), wideShape: wideRes.meta.shape, priced: priced.billed, pricedT: sum(priced.rows), pricedShape: priced.meta.shape };
        // (7) a ZIP with nothing we know → honest note, nothing imported, imports card stays off
        Store.sources = {}; Store.connectors = {}; Store.billed = {};
        await App.handleImportFiles([toFile(zMini, 'mini.zip')]);
        const none = { note: note(), imports: Store.connectors.imports === undefined, sources: Object.keys(Store.sources).length };
        // (8) a ChatGPT export ZIP as downloaded (conversations.json inside) → the ChatGPT branch; user.json / chat.html are skipped quietly
        await App.handleImportFiles([toFile(zGpt, 'chatgpt-export.zip')]);
        const gpt = { t: Store.sources.chatgpt ? sum(Store.sources.chatgpt.rows) : null, model: Store.sources.chatgpt && Store.sources.chatgpt.rows[0].model, note: note(), imports: !!Store.connectors.imports };
        const reg = { kind: c.kind, fetch: c.fetch, cat: c.category, platform: c.platform, srcIds: c.srcIds, quality: c.quality, keyLS: c.keyLS,
          copy: /Export monthly data/.test(c.qualityNote) && /balance/i.test(c.qualityNote) && /validate-only/i.test(c.qualityNote) && /merge/i.test(c.qualityNote),
          statusEl: !!document.getElementById('deepseek-status'), accept: document.getElementById('import-files').getAttribute('accept'), inHub: !!document.querySelector('#accounts-hub .acct[data-connector="deepseek"]') };
        return { bal, seen, viaDriver, empty, jul, aug, loose, sniff, none, gpt, reg };
      } finally {
        window.fetchJSON = origFetch;
        Store.sources = {}; Store.connectors = {}; Store.billed = {}; Store.persist(); App._render();
      }
    }, b64('wave2', 'deepseek', 'usage-2026-07.zip'), b64('wave2', 'deepseek', 'usage-2026-08.zip'), read('wave2', 'deepseek', 'amount-2026-08.csv'), read('wave2', 'deepseek', 'cost-2026-08.csv'), b64('wave2', 'zip', 'mini.zip'), b64('wave2', 'zip', 'chatgpt-export.zip'));
    ok('deepseek: balance fetcher → label "balance 12.30 USD" (string numbers kept), Bearer auth on api.deepseek.com/user/balance, detail says no usage history; key driver lands the label + ok; is_available:false reads "no balance"',
      ds.bal.label === 'balance 12.30 USD' && /total 12.30/.test(ds.bal.detail) && /no usage history/i.test(ds.bal.detail) && /api\.deepseek\.com\/user\/balance/.test(ds.seen.url) && ds.seen.auth === 'Bearer sk-test'
      && /balance 12.30 USD/.test(ds.viaDriver.label || '') && ds.viaDriver.status === 'ok' && /Connected/.test(ds.viaDriver.text) && ds.empty.label === 'no balance' && /not available/i.test(ds.empty.detail), JSON.stringify({ bal: ds.bal, seen: ds.seen, viaDriver: ds.viaDriver, empty: ds.empty }));
    ok('deepseek: July usage ZIP → exact rows under deepseek-usage-zip (in=103500 cr=50000 out=28000 msgs=14; 3 day/model buckets; platform DeepSeek API; not est), billed from cost CSV (07-10 0.05, 07-11 0.021, USD), 2 values rejected, card connected via the export',
      ds.jul.t.in === 103500 && ds.jul.t.cr === 50000 && ds.jul.t.out === 28000 && ds.jul.t.msgs === 14 && ds.jul.buckets === 3 && JSON.stringify(ds.jul.platforms) === JSON.stringify(['DeepSeek API'])
      && JSON.stringify(ds.jul.models) === JSON.stringify(['deepseek-chat', 'deepseek-reasoner']) && !ds.jul.est && ds.jul.billed.length === 2 && ds.jul.billed[0].d === '2026-07-10' && near(ds.jul.billed[0].amount, 0.05) && ds.jul.billed[1].d === '2026-07-11' && near(ds.jul.billed[1].amount, 0.021)
      && ds.jul.meta.rejected === 2 && ds.jul.meta.files === 2 && ds.jul.meta.currency === 'USD' && /DeepSeek API usage export — 10 rows \(exact tokens/.test(ds.jul.note) && /billed amounts from the cost CSV in USD/.test(ds.jul.note)
      && ds.jul.status === 'ok' && /usage export/.test(ds.jul.label), JSON.stringify({ t: ds.jul.t, buckets: ds.jul.buckets, billed: ds.jul.billed, meta: ds.jul.meta, note: ds.jul.note, status: ds.jul.status, label: ds.jul.label }));
    ok('deepseek: a second month merges by day/model and by day (in=104500 cr=50200 out=28300 msgs=17; 4 buckets; 3 billed days, 0.0716) — July is kept; the same CSVs dropped loose replace their keys (nothing doubles) and leave the generic csv source alone',
      ds.aug.t.in === 104500 && ds.aug.t.cr === 50200 && ds.aug.t.out === 28300 && ds.aug.t.msgs === 17 && ds.aug.buckets === 4 && JSON.stringify(ds.aug.billedDays) === JSON.stringify(['2026-07-10', '2026-07-11', '2026-08-10']) && near(ds.aug.billedSum, 0.0716)
      && ds.loose.t.in === 104500 && ds.loose.t.msgs === 17 && ds.loose.buckets === 4 && near(ds.loose.billedSum, 0.0716) && ds.loose.notes === 2 && ds.loose.genericUntouched, JSON.stringify({ aug: ds.aug, loose: ds.loose }));
    ok('deepseek (A0 #9): meta.rows / meta.files describe the stored months, not the number of imports — July (10 rows, 2 files) + August → rows add up (files 4); re-dropping August as a loose amount CSV replaces that month\'s counts (rows unchanged, files 2 + 1 = 3) instead of inflating them',
      ds.jul.meta.rows === 10 && ds.jul.meta.files === 2 && ds.aug.metaRows > 10 && ds.aug.metaFiles === 4 && ds.loose.metaRows === ds.aug.metaRows && ds.loose.metaFiles === 3,
      JSON.stringify({ jul: { rows: ds.jul.meta.rows, files: ds.jul.meta.files }, aug: { rows: ds.aug.metaRows, files: ds.aug.metaFiles }, loose: { rows: ds.loose.metaRows, files: ds.loose.metaFiles } }));
    ok('deepseek: header sniff takes the wide shape (cache-hit column) and the cost-*.csv name, refuses generic / Cursor headers; wide: in=600 (1000−400) cr=400 out=100 msgs=5; long shape with a price column derives billed 0.0011',
      ds.sniff.wide && !ds.sniff.generic && !ds.sniff.genericCost && !ds.sniff.cursor && ds.sniff.byName && ds.sniff.wideT.in === 600 && ds.sniff.wideT.cr === 400 && ds.sniff.wideT.out === 100 && ds.sniff.wideT.msgs === 5 && ds.sniff.wideShape === 'wide'
      && ds.sniff.priced.length === 1 && ds.sniff.priced[0].d === '2026-08-12' && near(ds.sniff.priced[0].amount, 0.0011) && ds.sniff.pricedT.out === 1000 && ds.sniff.pricedT.msgs === 4 && ds.sniff.pricedShape === 'long', JSON.stringify(ds.sniff));
    ok('zip routing: an unrecognized ZIP → "ZIP — no recognized files (3 entries)", nothing imported, imports card off; a ChatGPT export ZIP routes conversations.json to the ChatGPT branch (in=10 out=20 msgs=1, gpt-5.4), extras skipped quietly',
      /ZIP — no recognized files \(3 entries\)/.test(ds.none.note) && ds.none.imports && ds.none.sources === 0
      && ds.gpt.t && ds.gpt.t.in === 10 && ds.gpt.t.out === 20 && ds.gpt.t.msgs === 1 && ds.gpt.model === 'gpt-5.4' && /chatgpt-export\.zip\/conversations\.json: ChatGPT export — 1 conversations/.test(ds.gpt.note) && !/user\.json/.test(ds.gpt.note) && ds.gpt.imports, JSON.stringify({ none: ds.none, gpt: ds.gpt }));
    ok('deepseek: registry entry is an api-key card (fetch fetchDeepSeekBalance, keyLS key:deepseek) in API vendors with srcIds [deepseek, deepseek-usage-zip], quality exact, copy states export-first / balance validate-only / months merge; Imports accepts .zip',
      ds.reg.kind === 'api-key' && ds.reg.fetch === 'fetchDeepSeekBalance' && ds.reg.keyLS === 'key:deepseek' && ds.reg.cat === 'api' && ds.reg.platform === 'DeepSeek API' && JSON.stringify(ds.reg.srcIds) === JSON.stringify(['deepseek', 'deepseek-usage-zip'])
      && ds.reg.quality === 'exact' && ds.reg.copy && ds.reg.statusEl && ds.reg.inHub && /\.zip/.test(ds.reg.accept || ''), JSON.stringify(ds.reg));
    // ---- fix set: newer export layout (start_time_iso / end_time_iso, no utc_date) + landDeepSeek connector semantics ----
    const ds2 = await page.evaluate(async (zSep, zJul, zGpt) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const c = connectorById('deepseek');
      const toFile = (b, name) => new File([Uint8Array.from(atob(b), ch => ch.charCodeAt(0))], name, { type: 'application/zip' });
      const sum = (rows) => rows.reduce((a, r) => ({ in: a.in + r.in, cr: a.cr + r.cr, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, cr: 0, out: 0, msgs: 0 });
      const src = () => Store.sources['deepseek-usage-zip'];
      const note = () => document.getElementById('import-status').textContent;
      try {
        // (1) newer layout: both sniffers take start_time_iso as the date column (the cost file by header alone — wallet_type / currency — under any name); generic cost CSVs and a cost-*.csv with token columns are refused
        const head = (s) => (parseCSV(s.split(/\r?\n/, 1)[0])[0] || []).map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
        const sniff = { amount: isDeepSeekAmountCSV(head('start_time_iso,end_time_iso,model,api_key_name,type,amount\n'), 'x.csv'), cost: isDeepSeekCostCSV(head('start_time_iso,end_time_iso,model,api_key_name,wallet_type,currency,cost\n'), 'x.csv'),
          genericA: isDeepSeekCostCSV(['date', 'provider', 'model', 'in', 'out', 'cost'], 'x.csv'), genericB: isDeepSeekCostCSV(['date', 'model', 'cost_usd'], 'x.csv'), genericC: isDeepSeekCostCSV(['date', 'model', 'prompt_tokens', 'completion_tokens', 'cost'], 'cost-2026-08.csv') };
        await App.handleImportFiles([toFile(zSep, 'usage-2026-09.zip')]);
        const sep = src() ? { t: sum(src().rows), days: [...new Set(src().rows.map(r => r.d))].sort(), billed: Store.billedRows('deepseek-usage-zip'), meta: src().meta, note: note() } : { none: note() };   // guarded: an unrecognized ZIP must not abort the later checks
        // (2) a key-connected card whose last balance check is 8 days old reads "needs attention"; a usage import is a sync of this card → ok again, the keyed label kept
        Store.setConnector('deepseek', { label: 'balance 12.30 USD', lastSync: Date.now() - 8 * 864e5 });
        const before = Store.connectorStatus(c);
        await App.handleImportFiles([toFile(zJul, 'usage-2026-07.zip')]);
        const after = { status: Store.connectorStatus(c), label: Store.connectors.deepseek.label, fresh: Date.now() - Store.connectors.deepseek.lastSync < 60e3 };
        // (3) the Imports card: a DeepSeek-only import leaves it off (the rows live under the deepseek card's srcIds); a mixed batch counts only the ChatGPT ZIP, the note still lists the DeepSeek file
        Store.sources = {}; Store.billed = {}; Store.connectors = {};
        await App.handleImportFiles([toFile(zJul, 'usage-2026-07.zip')]);
        const only = { imports: Store.connectors.imports === undefined, deepseek: Store.connectorStatus(c), note: note() };
        await App.handleImportFiles([toFile(zGpt, 'chatgpt-export.zip'), toFile(zSep, 'usage-2026-09.zip')]);
        const mixed = { label: (Store.connectors.imports || {}).label, note: note() };
        return { sniff, sep, before, after, only, mixed };
      } finally {
        Store.sources = {}; Store.connectors = {}; Store.billed = {}; Store.persist(); App._render();
      }
    }, b64('wave2', 'deepseek', 'usage-2026-09.zip'), b64('wave2', 'deepseek', 'usage-2026-07.zip'), b64('wave2', 'zip', 'chatgpt-export.zip'));
    ok('deepseek: newer export layout (start_time_iso / end_time_iso, no utc_date) — both sniffers take start_time_iso as the date column (cost by header alone: wallet_type / currency), generic cost CSVs and a cost-*.csv with token columns are refused; September ZIP → in=2300 cr=500 out=1600 msgs=5 on UTC days 09-01/09-02 (end_time_iso ignored), billed 0.0012 + 0.0031 USD',
      ds2.sniff.amount && ds2.sniff.cost && !ds2.sniff.genericA && !ds2.sniff.genericB && !ds2.sniff.genericC && !!ds2.sep.t && ds2.sep.t.in === 2300 && ds2.sep.t.cr === 500 && ds2.sep.t.out === 1600 && ds2.sep.t.msgs === 5 && JSON.stringify(ds2.sep.days) === JSON.stringify(['2026-09-01', '2026-09-02'])
      && ds2.sep.billed.length === 2 && ds2.sep.billed[0].d === '2026-09-01' && near(ds2.sep.billed[0].amount, 0.0012) && ds2.sep.billed[1].d === '2026-09-02' && near(ds2.sep.billed[1].amount, 0.0031) && ds2.sep.meta.rows === 7 && ds2.sep.meta.rejected === 0 && ds2.sep.meta.currency === 'USD'
      && /usage-2026-09\.zip \(1 amount \+ 1 cost CSV\): DeepSeek API usage export — 7 rows/.test(ds2.sep.note), JSON.stringify({ sniff: ds2.sniff, sep: ds2.sep }));
    ok('deepseek: a usage import is a sync of the deepseek card — a key-connected card 8 days past its balance check reads warn, then ok with its keyed label kept and lastSync fresh; a DeepSeek-only import leaves the Imports card off (rows live under the deepseek card) and a mixed batch counts only the ChatGPT ZIP ("1 file(s) imported") while the note still lists the DeepSeek file',
      ds2.before === 'warn' && ds2.after.status === 'ok' && ds2.after.label === 'balance 12.30 USD' && ds2.after.fresh && ds2.only.imports && ds2.only.deepseek === 'ok' && /DeepSeek API usage export/.test(ds2.only.note)
      && ds2.mixed.label === '1 file(s) imported' && /ChatGPT export — 1 conversations/.test(ds2.mixed.note) && /usage-2026-09\.zip \(1 amount \+ 1 cost CSV\): DeepSeek API usage export/.test(ds2.mixed.note), JSON.stringify({ before: ds2.before, after: ds2.after, only: ds2.only, mixed: ds2.mixed }));
    // ---- T13: chat-export parsers (Grok, DeepSeek chat, Meta AI, Perplexity, Microsoft Copilot CSV) + Imports routing + export-file hub cards ----
    const grokTxt = read('wave2', 'grok', 'grok-export.json'), dscTxt = read('wave2', 'deepseek', 'deepseek-conversations.json'), metaTxt = read('wave2', 'meta-ai', 'message_1.json'),
          pxTxt = read('wave2', 'perplexity', 'threads.json'), cpCsv = read('wave2', 'mscopilot', 'copilot-activity.csv');
    const ex = await page.evaluate(async (grokTxt, dscTxt, metaTxt, pxTxt, cpCsv, pxZipB64) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const sum = (rows) => rows.reduce((a, r) => ({ in: a.in + r.in, out: a.out + r.out, msgs: a.msgs + r.msgs, est: a.est && r.est === 1 }), { in: 0, out: 0, msgs: 0, est: true });
      const H = (iso) => new Date(iso).getHours();
      const hours = (rows) => [...new Set(rows.map(r => r.hour))].sort((a, b) => a - b);
      const expH = (...isos) => [...new Set(isos.map(H))].sort((a, b) => a - b);
      // parsers, direct
      const g = parseGrokExport(JSON.parse(grokTxt));
      const d = parseDeepSeekChatExport(JSON.parse(dscTxt));
      const m = parseMetaAiExport(JSON.parse(metaTxt), 'message_1.json');
      const p = parsePerplexityExport(JSON.parse(pxTxt), 'threads.json');
      const head = (parseCSV(cpCsv.split(/\r?\n/, 1)[0])[0] || []).map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
      const cpDetect = { yes: isCopilotActivityCSV(head), generic: isCopilotActivityCSV(['date', 'platform', 'model', 'input_tokens', 'output_tokens', 'requests']), cursor: isCursorUsageCSV(head), deepseek: isDeepSeekAmountCSV(head, 'copilot-activity.csv') };
      const cp = parseCopilotActivityCSV(cpCsv, 'copilot-activity.csv');
      const kinds = [sniffJSON(JSON.parse(grokTxt), 'grok-export.json'), sniffJSON(JSON.parse(dscTxt), 'deepseek-conversations.json'), sniffJSON(JSON.parse(dscTxt), 'conversations.json'), sniffJSON(JSON.parse(metaTxt), 'message_1.json'), sniffJSON(JSON.parse(pxTxt), 'threads.json')];
      // Imports routing: four loose files + the Perplexity ZIP (JSON inside) in one batch
      const toFile = (b, name) => new File([Uint8Array.from(atob(b), ch => ch.charCodeAt(0))], name, { type: 'application/zip' });
      await App.handleImportFiles([
        new File([grokTxt], 'grok-export.json', { type: 'application/json' }), new File([dscTxt], 'deepseek-conversations.json', { type: 'application/json' }),
        new File([metaTxt], 'message_1.json', { type: 'application/json' }), new File([cpCsv], 'copilot-activity.csv', { type: 'text/csv' }), toFile(pxZipB64, 'perplexity-export.zip')]);
      const note = document.getElementById('import-status').textContent;
      const srcs = ['grok-export', 'deepseek-chat-export', 'meta-ai-export', 'perplexity-export', 'copilot-activity-csv'].map(id => Store.sources[id] ? sum(Store.sources[id].rows).msgs : null);
      const pxSid = Store.sources['perplexity-export'].rows[0].sid;
      // Meta AI threads: a second thread file merges (3 + 1 = 4 replies); re-importing the first replaces only its own thread (still 4, 2 threads)
      const meta2 = JSON.parse(metaTxt); meta2.thread_path = 'inbox/metaai_456'; meta2.messages = meta2.messages.slice(0, 3);   // undated (skipped) + one reply + its prompt → 1 reply
      await App.handleImportFiles([new File([JSON.stringify(meta2)], 'message_2.json', { type: 'application/json' })]);
      const metaAfterSecond = sum(Store.sources['meta-ai-export'].rows).msgs;
      await App.handleImportFiles([new File([metaTxt], 'message_1.json', { type: 'application/json' })]);
      const metaAfterReimport = { msgs: sum(Store.sources['meta-ai-export'].rows).msgs, threads: Store.sources['meta-ai-export'].meta.threads };
      App.renderHub();
      const hub = ['grok', 'deepseek-chat', 'meta-ai', 'perplexity', 'mscopilot'].map(id => (document.querySelector(`#accounts-hub .acct[data-connector="${id}"] .dot`) || {}).className || 'missing');
      const imports = connectorById('imports').srcIds, order = PLATFORM_ORDER, badge = document.querySelector('#src-import .badge').textContent;
      Store.sources = {}; Store.connectors = {}; Store.billed = {}; Store.persist(); App._render();
      return { g: { ...sum(g.rows), meta: g.meta, hours: hours(g.rows), expHours: expH('2026-08-10T09:00:05.000Z', '2026-08-10T21:30:05.000Z', '2026-08-11T08:00:00.000Z'), plat: g.rows[0].platform, model: g.rows[0].model },
        d: { ...sum(d.rows), meta: d.meta, models: [...new Set(d.rows.map(r => r.model))].sort(), plat: d.rows[0].platform, c3: d.rows.filter(r => r.d === dayKey(new Date('2026-08-12T10:00:00.000Z'))).map(r => [r.model, r.in, r.out, r.msgs, r.hour]), h3: H('2026-08-12T10:00:00.000Z') },
        m: { ...sum(m.rows), meta: m.meta, plat: m.rows[0].platform, model: m.rows[0].model, sid: m.rows[0].sid },
        p: { ...sum(p.rows), meta: p.meta, plat: p.rows[0].platform, model: p.rows[0].model },
        cp: { ...sum(cp.rows), meta: cp.meta, hours: hours(cp.rows), h1: H('2026-08-10T09:00:00Z'), h3: H('2026-08-11T08:00:00Z'), plat: cp.rows[0].platform, model: cp.rows[0].model }, cpDetect,
        kinds, note, srcs, pxSid, metaAfterSecond, metaAfterReimport, hub, imports, order, badge };
    }, grokTxt, dscTxt, metaTxt, pxTxt, cpCsv, b64('wave2', 'perplexity', 'perplexity-export.zip'));
    ok('grok: export parsed (est. in=17 out=25 msgs=4; 3 conversations; 1 undated reply skipped; $numberLong / ISO / conversation-time fallbacks; hours kept) as platform Grok, model grok',
      ex.g.in === 17 && ex.g.out === 25 && ex.g.msgs === 4 && ex.g.est && ex.g.meta.convs === 3 && ex.g.meta.skipped === 1 && JSON.stringify(ex.g.hours) === JSON.stringify(ex.g.expHours) && ex.g.plat === 'Grok' && ex.g.model === 'grok', JSON.stringify(ex.g));
    ok('deepseek chat: export parsed (est. in=19 out=27 msgs=4; 3 conversations; 1 undated skipped; epoch-seconds + content[] + create_time handled; model per message, else the conversation\'s, else deepseek-chat — c3 lands on the conversation\'s create_time as deepseek-reasoner 3/4) as platform "DeepSeek chat"',
      ex.d.in === 19 && ex.d.out === 27 && ex.d.msgs === 4 && ex.d.est && ex.d.meta.convs === 3 && ex.d.meta.skipped === 1 && JSON.stringify(ex.d.models) === JSON.stringify(['deepseek-chat', 'deepseek-reasoner']) && ex.d.plat === 'DeepSeek chat'
      && JSON.stringify(ex.d.c3) === JSON.stringify([['deepseek-reasoner', 3, 4, 1, ex.d.h3]]), JSON.stringify(ex.d));
    ok('meta ai: DYI thread parsed newest-first → ascending (est. in=15 out=26 msgs=3; 1 undated skipped; sid = thread_path) as platform "Meta AI", model meta-ai',
      ex.m.in === 15 && ex.m.out === 26 && ex.m.msgs === 3 && ex.m.est && ex.m.meta.skipped === 1 && ex.m.plat === 'Meta AI' && ex.m.model === 'meta-ai' && ex.m.sid === 'inbox/metaai_123', JSON.stringify(ex.m));
    ok('perplexity: thread array parsed with tolerant field names (est. in=16 out=23 msgs=3 of 4 threads; 1 undated skipped; ISO / epoch-ms / date-only) as platform Perplexity, model perplexity',
      ex.p.in === 16 && ex.p.out === 23 && ex.p.msgs === 3 && ex.p.est && ex.p.meta.threads === 4 && ex.p.meta.skipped === 1 && ex.p.plat === 'Perplexity' && ex.p.model === 'perplexity', JSON.stringify(ex.p));
    ok('ms copilot: activity CSV detected (generic / Cursor / DeepSeek headers are not) and parsed (est. in=16 out=23 msgs=3; 1 unparseable date skipped; ISO and M/D/YYYY H:MM PM → hour 21; apps listed) as platform "Microsoft Copilot", model copilot',
      ex.cpDetect.yes && !ex.cpDetect.generic && !ex.cpDetect.cursor && !ex.cpDetect.deepseek && ex.cp.in === 16 && ex.cp.out === 23 && ex.cp.msgs === 3 && ex.cp.est && ex.cp.meta.skipped === 1
      && ex.cp.hours.includes(21) && ex.cp.hours.includes(ex.cp.h1) && ex.cp.hours.includes(ex.cp.h3) && JSON.stringify(ex.cp.meta.apps) === JSON.stringify(['Copilot app', 'Copilot in Edge']) && ex.cp.plat === 'Microsoft Copilot' && ex.cp.model === 'copilot', JSON.stringify({ cp: ex.cp, cpDetect: ex.cpDetect }));
    ok('sniff: grok-export / deepseek-chat-export (name-gated: conversations.json → unknown) / meta-ai-export / perplexity-export',
      JSON.stringify(ex.kinds) === JSON.stringify(['grok-export', 'deepseek-chat-export', 'unknown', 'meta-ai-export', 'perplexity-export']), JSON.stringify(ex.kinds));
    ok('imports: one batch routes all five formats (incl. Perplexity JSON inside its ZIP, sid = archive/entry) to their own sources; Meta AI threads merge and a re-imported thread replaces only itself; export-file hub cards turn green; srcIds/PLATFORM_ORDER/badge list them (ChatGPT once)',
      JSON.stringify(ex.srcs) === JSON.stringify([4, 4, 3, 3, 3]) && ex.pxSid === 'perplexity-export.zip/threads.json' && ex.metaAfterSecond === 4 && ex.metaAfterReimport.msgs === 4 && ex.metaAfterReimport.threads === 2
      && /Grok export — 3 conversations, 4 replies/.test(ex.note) && /DeepSeek chat export — 3 conversations, 4 replies/.test(ex.note) && /Meta AI thread — 3 replies/.test(ex.note) && /Microsoft Copilot activity CSV — 3 prompts/.test(ex.note) && /Perplexity export — 3 threads/.test(ex.note)
      && ex.hub.every(cls => /\bok\b/.test(cls)) && ['grok-export', 'deepseek-chat-export', 'meta-ai-export', 'perplexity-export', 'copilot-activity-csv'].every(id => ex.imports.includes(id))
      && ['Grok', 'Microsoft Copilot', 'Perplexity', 'Meta AI', 'DeepSeek chat', 'ChatGPT', 'Claude.ai'].every(pl => ex.order.includes(pl)) && ex.order.filter(pl => pl === 'ChatGPT').length === 1 && ex.order[ex.order.length - 1] === 'Other'
      && /Grok/.test(ex.badge) && /Perplexity/.test(ex.badge) && /Takeout/.test(ex.badge) && /Cursor/.test(ex.badge), JSON.stringify({ srcs: ex.srcs, pxSid: ex.pxSid, metaAfterSecond: ex.metaAfterSecond, metaAfterReimport: ex.metaAfterReimport, hub: ex.hub, note: ex.note, imports: ex.imports, order: ex.order, badge: ex.badge }));
    // ---- A0 #7: ChatGPT / Claude.ai exports skip + count undated replies (never booked as today) ----
    const und = await page.evaluate(() => {
      const gpt = parseChatGPTExport([{ current_node: 'a2', mapping: {   // no conversation create_time either
        r: { id: 'r', parent: null, children: ['u1'], message: null },
        u1: { id: 'u1', parent: 'r', children: ['a1'], message: { author: { role: 'user' }, content: { parts: ['x'.repeat(40)] } } },
        a1: { id: 'a1', parent: 'u1', children: ['u2'], message: { author: { role: 'assistant' }, metadata: { model_slug: 'gpt-5.4' }, content: { parts: ['y'.repeat(80)] } } },   // undated → skipped
        u2: { id: 'u2', parent: 'a1', children: ['a2'], message: { author: { role: 'user' }, create_time: 1786352400, content: { parts: ['z'.repeat(20)] } } },
        a2: { id: 'a2', parent: 'u2', children: [], message: { author: { role: 'assistant' }, create_time: 1786352460, metadata: { model_slug: 'gpt-5.4' }, content: { parts: ['w'.repeat(8)] } } },
      } }]);
      const cl = parseClaudeAiExport([{ chat_messages: [   // no conversation created_at either
        { sender: 'human', text: 'x'.repeat(40) }, { sender: 'assistant', text: 'y'.repeat(80) },
        { sender: 'human', text: 'z'.repeat(20), created_at: '2026-08-10T09:00:00Z' }, { sender: 'assistant', text: 'w'.repeat(8), created_at: '2026-08-10T09:01:00Z' },
      ] }], 'claude-sonnet-5');
      const today = todayKey();
      return { gpt: { msgs: gpt.meta.msgs, skipped: gpt.meta.skipped, days: gpt.rows.map(r => r.d), out: gpt.rows.reduce((a, r) => a + r.out, 0), today: gpt.rows.some(r => r.d === today) },
        cl: { msgs: cl.meta.msgs, skipped: cl.meta.skipped, days: cl.rows.map(r => r.d), out: cl.rows.reduce((a, r) => a + r.out, 0), today: cl.rows.some(r => r.d === today) } };
    });
    ok('chat exports (A0 #7): an undated ChatGPT reply in an undated conversation is skipped and counted (msgs 1, skipped 1, out 2 from the dated reply only, no row on today); the Claude.ai export does the same (msgs 1, skipped 1, day 2026-08-10)',
      und.gpt.msgs === 1 && und.gpt.skipped === 1 && und.gpt.out === 2 && !und.gpt.today && und.gpt.days.length === 1
      && und.cl.msgs === 1 && und.cl.skipped === 1 && und.cl.out === 2 && !und.cl.today && JSON.stringify(und.cl.days) === JSON.stringify(['2026-08-10']), JSON.stringify(und));

    // ---- fix set: merge-by-sid sources vs compactRows. Rows older than 90 days used to fold ACROSS sids into one day/platform/model bucket with a
    //      sids[] list; the per-file "replaces only itself" filters then dropped that bucket on re-import (it listed the re-imported sid) and the
    //      other threads'/files' old rows vanished. These sources compact per (day, platform, model, sid) — scalar sid kept, hour dropped, est kept.
    const ps = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const sum = (rows) => rows.reduce((a, r) => ({ in: a.in + r.in, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, out: 0, msgs: 0 });
      const day = addDays(todayKey(), -120);                                                   // 120 days old → past the 90-day compaction cutoff
      const at = (hhmm) => new Date(day + 'T' + hhmm + ':00');                                 // local wall-clock → exportTimestamp's dayKey = day
      const ms = (hhmm) => at(hhmm).getTime(), iso = (hhmm) => at(hhmm).toISOString();
      const json = (o, name) => new File([JSON.stringify(o)], name, { type: 'application/json' });
      const csv = (s, name) => new File([s], name, { type: 'text/csv' });
      const rowsOf = (id) => (Store.sources[id] || {}).rows || [];
      const shape = (rows) => rows.map(r => [r.sid, r.in, r.out, r.msgs, r.hour, r.est, r.sids]).sort((a, b) => (a[0] < b[0] ? -1 : 1));   // undefined → null in JSON
      const bySid = (id, sid) => shape(rowsOf(id).filter(r => r.sid === sid || (Array.isArray(r.sids) && r.sids.includes(sid))));
      // Meta AI (estTok = chars/4): thread A = 40→80 (in 10, out 20) + 20→8 (in 5, out 2) = in 15 out 22 msgs 2 · thread B = 4→5 (in 1, out 1) + 12→16 (in 3, out 4) = in 4 out 5 msgs 2 · same day, different hours
      const thread = (path, msgs) => ({ participants: [{ name: 'Alaa' }, { name: 'Meta AI' }], title: 'Meta AI', thread_path: path, messages: msgs });
      const metaA = thread('inbox/metaai_A', [
        { sender_name: 'Meta AI', timestamp_ms: ms('21:30'), content: 'w'.repeat(8) }, { sender_name: 'Alaa', timestamp_ms: ms('21:29'), content: 'z'.repeat(20) },
        { sender_name: 'Meta AI', timestamp_ms: ms('09:01'), content: 'y'.repeat(80) }, { sender_name: 'Alaa', timestamp_ms: ms('09:00'), content: 'x'.repeat(40) } ]);
      const metaB = thread('inbox/metaai_B', [
        { sender_name: 'Meta AI', timestamp_ms: ms('10:01'), content: 'y'.repeat(16) }, { sender_name: 'Alaa', timestamp_ms: ms('10:00'), content: 'x'.repeat(12) },
        { sender_name: 'Meta AI', timestamp_ms: ms('08:01'), content: 'ok!!!' }, { sender_name: 'Alaa', timestamp_ms: ms('08:00'), content: 'abcd' } ]);
      await App.handleImportFiles([json(metaA, 'message_1.json')]);
      await App.handleImportFiles([json(metaB, 'message_2.json')]);
      const metaBoth = { t: sum(rowsOf('meta-ai-export')), threads: Store.sources['meta-ai-export'].meta.threads, rows: shape(rowsOf('meta-ai-export')) };
      await App.handleImportFiles([json(metaA, 'message_1.json')]);                            // re-import thread A → replaces only itself; B must stay
      const metaRe = { t: sum(rowsOf('meta-ai-export')), threads: Store.sources['meta-ai-export'].meta.threads, a: bySid('meta-ai-export', 'inbox/metaai_A'), b: bySid('meta-ai-export', 'inbox/metaai_B') };
      // Perplexity: file A = 40→80 + 20→8 = in 15 out 22 msgs 2 · file B = abcd→ok!!! = in 1 out 1 msgs 1 → in 16 out 23 msgs 3
      const pxA = [{ query: 'x'.repeat(40), answer: 'y'.repeat(80), created_at: iso('09:00') }, { query: 'z'.repeat(20), answer: 'w'.repeat(8), created_at: iso('21:30') }];
      const pxB = [{ query: 'abcd', answer: 'ok!!!', created_at: iso('08:00') }];
      await App.handleImportFiles([json(pxA, 'threads-a.json')]); await App.handleImportFiles([json(pxB, 'threads-b.json')]); await App.handleImportFiles([json(pxA, 'threads-a.json')]);
      const px = { t: sum(rowsOf('perplexity-export')), files: Store.sources['perplexity-export'].meta.files, b: bySid('perplexity-export', 'threads-b.json') };
      // Microsoft Copilot activity CSV: file A (Copilot app) = 40→80 + 20→8 = in 15 out 22 msgs 2 · file B (Copilot in Edge) = abcd→ok!!! = in 1 out 1 msgs 1 → in 16 out 23 msgs 3
      const head = 'Date,App,Prompt,Response\n';
      const cpA = head + iso('09:00') + ',Copilot app,' + 'x'.repeat(40) + ',' + 'y'.repeat(80) + '\n' + iso('21:30') + ',Copilot app,' + 'z'.repeat(20) + ',' + 'w'.repeat(8) + '\n';
      const cpB = head + iso('08:00') + ',Copilot in Edge,abcd,ok!!!\n';
      await App.handleImportFiles([csv(cpA, 'copilot-app.csv')]); await App.handleImportFiles([csv(cpB, 'copilot-edge.csv')]); await App.handleImportFiles([csv(cpA, 'copilot-app.csv')]);
      const cp = { t: sum(rowsOf('copilot-activity-csv')), files: Store.sources['copilot-activity-csv'].meta.files, b: bySid('copilot-activity-csv', 'copilot-edge.csv') };
      Store.sources = {}; Store.connectors = {}; Store.billed = {}; Store.persist(); App._render();
      return { metaBoth, metaRe, px, cp };
    });
    ok('meta ai + compaction: two 120-day-old threads land as one compacted row PER THREAD (scalar sid kept, hour dropped, est kept, no sids list) — A in=15 out=22 msgs=2, B in=4 out=5 msgs=2; 2 threads',
      ps.metaBoth.t.in === 19 && ps.metaBoth.t.out === 27 && ps.metaBoth.t.msgs === 4 && ps.metaBoth.threads === 2
      && JSON.stringify(ps.metaBoth.rows) === JSON.stringify([['inbox/metaai_A', 15, 22, 2, null, 1, null], ['inbox/metaai_B', 4, 5, 2, null, 1, null]]), JSON.stringify(ps.metaBoth));
    ok('meta ai + compaction: re-importing 120-day-old thread A replaces only itself — thread B\'s rows are kept (still in=19 out=27 msgs=4, 2 threads; B in=4 out=5 msgs=2; A one row in=15 out=22 msgs=2)',
      ps.metaRe.t.in === 19 && ps.metaRe.t.out === 27 && ps.metaRe.t.msgs === 4 && ps.metaRe.threads === 2
      && JSON.stringify(ps.metaRe.a) === JSON.stringify([['inbox/metaai_A', 15, 22, 2, null, 1, null]]) && JSON.stringify(ps.metaRe.b) === JSON.stringify([['inbox/metaai_B', 4, 5, 2, null, 1, null]]), JSON.stringify(ps.metaRe));
    ok('perplexity / ms copilot + compaction: re-importing 120-day-old file A keeps file B — Perplexity in=16 out=23 msgs=3, 2 files, B row in=1 out=1 msgs=1; Copilot activity in=16 out=23 msgs=3, 2 files, B row in=1 out=1 msgs=1',
      ps.px.t.in === 16 && ps.px.t.out === 23 && ps.px.t.msgs === 3 && ps.px.files === 2 && JSON.stringify(ps.px.b) === JSON.stringify([['threads-b.json', 1, 1, 1, null, 1, null]])
      && ps.cp.t.in === 16 && ps.cp.t.out === 23 && ps.cp.t.msgs === 3 && ps.cp.files === 2 && JSON.stringify(ps.cp.b) === JSON.stringify([['copilot-edge.csv', 1, 1, 1, null, 1, null]]), JSON.stringify({ px: ps.px, cp: ps.cp }));
    // ---- v5 T8: big chat exports parse off the main thread — parseInWorker kinds grok / deepseek-chat / meta-ai / perplexity / copilot-csv (+ 'sniff'); App._workerThreshold routes Imports ----
    const wk = await page.evaluate(async (grokTxt, dscTxt, metaTxt, pxTxt, cpCsv, pxZipB64) => {
      const J = JSON.stringify;
      const timed = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('hang: the worker never answered')), 8000))]);
      const settle = async (p) => { try { return { ok: true, v: await timed(p) }; } catch (e) { return { ok: false, err: String((e && e.message) || e) }; } };
      // parity: each kind in the worker equals the inline parser on the same fixture (rows, meta, est flags, sid)
      const parity = {};
      for (const [kind, inline, args] of [
        ['grok', () => parseGrokExport(JSON.parse(grokTxt)), [grokTxt]],
        ['deepseek-chat', () => parseDeepSeekChatExport(JSON.parse(dscTxt)), [dscTxt]],
        ['meta-ai', () => parseMetaAiExport(JSON.parse(metaTxt), 'message_1.json'), [metaTxt, null, 'message_1.json']],
        ['perplexity', () => parsePerplexityExport(JSON.parse(pxTxt), 'threads.json'), [pxTxt, null, 'threads.json']],
        ['copilot-csv', () => parseCopilotActivityCSV(cpCsv, 'copilot-activity.csv'), [cpCsv, null, 'copilot-activity.csv']],
      ]) {
        const r = await settle(parseInWorker(kind, ...args));
        parity[kind] = r.ok ? (J(r.v) === J(inline()) && r.v.rows.length > 0 ? 'same' : 'differs: ' + J(r.v).slice(0, 200)) : 'rejected: ' + r.err;
      }
      // errors surface as rejections carrying the worker's message (never a hang): unknown kind, malformed JSON, a CSV the parser refuses
      const errs = { badKind: await settle(parseInWorker('nope', '{}')), badJson: await settle(parseInWorker('grok', '{not json')), badCsv: await settle(parseInWorker('copilot-csv', 'a,b\n1,2\n', null, 'x.csv')) };
      // 'sniff': the worker parses the JSON, runs sniffJSON (file-name / source-mark gate for DeepSeek chat) and parses a chat export in the same trip; other shapes come back kind-only
      const report = J({ data: [{ starting_at: '2026-08-01T00:00:00Z', results: [{ model: 'm', input_tokens: 10, output_tokens: 5 }] }] });
      const sniff = { ds: await settle(parseInWorker('sniff', dscTxt, null, 'deepseek-conversations.json')), dsUnnamed: await settle(parseInWorker('sniff', dscTxt, null, 'conversations.json')), report: await settle(parseInWorker('sniff', report, null, 'usage.json')) };
      const sniffOk = { ds: sniff.ds.ok && sniff.ds.v.kind === 'deepseek-chat-export' && J(sniff.ds.v.res) === J(parseDeepSeekChatExport(JSON.parse(dscTxt))), dsUnnamed: sniff.dsUnnamed.ok && sniff.dsUnnamed.v.kind === 'unknown' && sniff.dsUnnamed.v.res === null, report: sniff.report.ok && sniff.report.v.kind === 'anthropic-usage' && sniff.report.v.res === null };
      // routing: threshold 0 → every Imports file goes through the worker (Worker constructions counted), landing rows/meta identical to the inline run (default threshold → no worker)
      const files = () => [new File([grokTxt], 'grok-export.json', { type: 'application/json' }), new File([dscTxt], 'deepseek-conversations.json', { type: 'application/json' }),
        new File([metaTxt], 'message_1.json', { type: 'application/json' }), new File([pxTxt], 'threads.json', { type: 'application/json' }), new File([cpCsv], 'copilot-activity.csv', { type: 'text/csv' }),
        new File([Uint8Array.from(atob(pxZipB64), ch => ch.charCodeAt(0))], 'perplexity-export.zip', { type: 'application/zip' }), new File([report], 'usage.json', { type: 'application/json' })];
      const ids = ['grok-export', 'deepseek-chat-export', 'meta-ai-export', 'perplexity-export', 'copilot-activity-csv', 'anthropic'];
      const snap = () => ids.map(id => Store.sources[id] ? { rows: Store.sources[id].rows, meta: { ...Store.sources[id].meta, updated: undefined } } : null);   // setSource stamps meta.updated = Date.now() — not part of the parse result
      const reset = () => { Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; };
      const RealWorker = window.Worker; let workers = 0; window.Worker = function (u, o) { workers++; return new RealWorker(u, o); };
      const defaultThreshold = App._workerThreshold;
      let viaWorker = null, inline = null, workersVia = -1, workersInline = -1, note = '', reimport = null;
      try {
        reset(); App._workerThreshold = 0;
        await App.handleImportFiles(files());
        note = document.getElementById('import-status').textContent; viaWorker = snap();
        await App.handleImportFiles([new File([metaTxt], 'message_1.json', { type: 'application/json' })]);   // the same thread again → replaces only itself (perSid filter runs on the main thread after the worker)
        reimport = { msgs: Store.sources['meta-ai-export'].rows.reduce((a, r) => a + r.msgs, 0), threads: Store.sources['meta-ai-export'].meta.threads };
        workersVia = workers; workers = 0;
        App._workerThreshold = defaultThreshold; reset();
        await App.handleImportFiles(files());
        inline = snap(); workersInline = workers;
      } finally { App._workerThreshold = defaultThreshold; window.Worker = RealWorker; }
      Store.sources = {}; Store.connectors = {}; Store.billed = {}; Store.persist(); App._render();
      return { parity, errs, sniffOk, defaultThreshold, workersVia, workersInline, same: J(viaWorker) === J(inline), rows: ids.map((id, i) => [id, viaWorker && viaWorker[i] ? viaWorker[i].rows.length : null]), note, reimport };
    }, grokTxt, dscTxt, metaTxt, pxTxt, cpCsv, b64('wave2', 'perplexity', 'perplexity-export.zip'));
    ok('worker parity: parseInWorker grok / deepseek-chat / meta-ai / perplexity / copilot-csv equal the inline parsers on the fixtures (rows + meta + sid)',
      Object.values(wk.parity).every(v => v === 'same') && Object.keys(wk.parity).length === 5, JSON.stringify(wk.parity));
    ok('worker errors reject with the message (no hang): unknown kind, malformed JSON, a refused CSV',
      !wk.errs.badKind.ok && /unknown parse kind: nope/.test(wk.errs.badKind.err) && !wk.errs.badJson.ok && /JSON|token/i.test(wk.errs.badJson.err) && !wk.errs.badCsv.ok && /Not a Copilot activity CSV/.test(wk.errs.badCsv.err), JSON.stringify(wk.errs));
    ok("worker 'sniff': parses + sniffs + parses a chat export in one trip ({kind, res}); the DeepSeek name gate holds in the worker (conversations.json → unknown, res null); a provider report comes back kind-only",
      wk.sniffOk.ds && wk.sniffOk.dsUnnamed && wk.sniffOk.report, JSON.stringify(wk.sniffOk));
    ok('App._workerThreshold defaults to 8 MB; at 0 every Imports file (5 loose + 2 ZIP entries incl. the skipped account.json + report sniff + re-import = 9 worker runs) parses in the worker with rows/meta identical to the inline run (0 workers); the re-imported Meta AI thread still replaces only itself',
      wk.defaultThreshold === 8 * 1024 * 1024 && wk.workersVia === 9 && wk.workersInline === 0 && wk.same && JSON.stringify(wk.rows.map(r => r[1] != null && r[1] > 0)) === JSON.stringify([true, true, true, true, true, true])
      && wk.reimport && wk.reimport.msgs === 3 && wk.reimport.threads === 1 && /Grok export — 3 conversations, 4 replies/.test(wk.note) && /Anthropic usage report — 1 rows/.test(wk.note), JSON.stringify({ d: wk.defaultThreshold, via: wk.workersVia, inl: wk.workersInline, same: wk.same, rows: wk.rows, reimport: wk.reimport, note: wk.note }));
  } finally {
    await page.close();
  }
}
