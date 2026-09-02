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
        const aug = { t: sum(src().rows), buckets: src().rows.length, billedDays: Store.billedRows('deepseek-usage-zip').map(b => b.d), billedSum: billedSum() };
        // (5) the same August CSVs dropped loose → same keys replace, nothing doubles; the generic csv source is untouched
        await App.handleImportFiles([new File([amountAugCsv], 'amount-2026-08.csv', { type: 'text/csv' }), new File([costAugCsv], 'cost-2026-08.csv', { type: 'text/csv' })]);
        const loose = { t: sum(src().rows), buckets: src().rows.length, billedSum: billedSum(), notes: (note().match(/DeepSeek API usage export/g) || []).length, genericUntouched: !Store.sources.csv };
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
    ok('deepseek: header sniff takes the wide shape (cache-hit column) and the cost-*.csv name, refuses generic / Cursor headers; wide: in=600 (1000−400) cr=400 out=100 msgs=5; long shape with a price column derives billed 0.0011',
      ds.sniff.wide && !ds.sniff.generic && !ds.sniff.genericCost && !ds.sniff.cursor && ds.sniff.byName && ds.sniff.wideT.in === 600 && ds.sniff.wideT.cr === 400 && ds.sniff.wideT.out === 100 && ds.sniff.wideT.msgs === 5 && ds.sniff.wideShape === 'wide'
      && ds.sniff.priced.length === 1 && ds.sniff.priced[0].d === '2026-08-12' && near(ds.sniff.priced[0].amount, 0.0011) && ds.sniff.pricedT.out === 1000 && ds.sniff.pricedT.msgs === 4 && ds.sniff.pricedShape === 'long', JSON.stringify(ds.sniff));
    ok('zip routing: an unrecognized ZIP → "ZIP — no recognized files (3 entries)", nothing imported, imports card off; a ChatGPT export ZIP routes conversations.json to the ChatGPT branch (in=10 out=20 msgs=1, gpt-5.4), extras skipped quietly',
      /ZIP — no recognized files \(3 entries\)/.test(ds.none.note) && ds.none.imports && ds.none.sources === 0
      && ds.gpt.t && ds.gpt.t.in === 10 && ds.gpt.t.out === 20 && ds.gpt.t.msgs === 1 && ds.gpt.model === 'gpt-5.4' && /chatgpt-export\.zip\/conversations\.json: ChatGPT export — 1 conversations/.test(ds.gpt.note) && !/user\.json/.test(ds.gpt.note) && ds.gpt.imports, JSON.stringify({ none: ds.none, gpt: ds.gpt }));
    ok('deepseek: registry entry is an api-key card (fetch fetchDeepSeekBalance, keyLS key:deepseek) in API vendors with srcIds [deepseek, deepseek-usage-zip], quality exact, copy states export-first / balance validate-only / months merge; Imports accepts .zip',
      ds.reg.kind === 'api-key' && ds.reg.fetch === 'fetchDeepSeekBalance' && ds.reg.keyLS === 'key:deepseek' && ds.reg.cat === 'api' && ds.reg.platform === 'DeepSeek API' && JSON.stringify(ds.reg.srcIds) === JSON.stringify(['deepseek', 'deepseek-usage-zip'])
      && ds.reg.quality === 'exact' && ds.reg.copy && ds.reg.statusEl && ds.reg.inHub && /\.zip/.test(ds.reg.accept || ''), JSON.stringify(ds.reg));
  } finally {
    await page.close();
  }
}
