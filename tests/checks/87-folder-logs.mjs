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
  } finally {
    await page.close();
  }
}
