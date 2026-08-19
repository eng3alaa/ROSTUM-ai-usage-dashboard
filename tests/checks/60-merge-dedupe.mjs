import { openDashboard } from '../lib/harness.mjs';

const CSV = 'date,platform,model,input_tokens,output_tokens,cost\n' +
            '2026-08-10,Gemini,gemini-3.5-flash,100,50,1.0\n' +
            '2026-08-11,Gemini,gemini-3.5-flash,200,80,2.0\n';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const totals = await page.evaluate(async (csvText) => {
      // fresh-origin storage is shared across pages in the same browser; earlier checks
      // (50-billed-staleness) already touched Store, so reset before importing.
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      const mkFile = () => new File([csvText], 'gemini-usage.csv', { type: 'text/csv' });
      await App.handleImportFiles([mkFile()]);
      await App.handleImportFiles([mkFile()]);        // drop the SAME file again
      const rows = Store.sources.csv.rows;
      const t = { in: 0, out: 0, n: rows.length };
      for (const r of rows) { t.in += r.in; t.out += r.out; }
      t.billed = Store.billedRows('csv').reduce((a, b) => a + b.amount, 0);
      return t;
    }, CSV);
    ok('merge: re-dropping the same CSV does not double usage',
      totals.n === 2 && totals.in === 300 && totals.out === 130, JSON.stringify(totals));
    ok('merge: re-dropping the same CSV does not double billed', Math.abs(totals.billed - 3.0) < 1e-9, totals.billed);

    const fs2 = await import('node:fs');
    const path2 = await import('node:path');
    const { OUT } = await import('../lib/harness.mjs');
    const sessText = fs2.readFileSync(path2.join(OUT, 'claude-logs', 'projects', '-D--proj1', 'sess-aaa.jsonl'), 'utf8');
    const dd = await page.evaluate(async (text) => {
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      // 1) same session arrives via the dropzone...
      await App.handleImportFiles([new File([text], 'sess-aaa.jsonl')]);
      // 2) ...and via the folder scan
      const res = await parseClaudeLogs([{ path: 'projects/-D--proj1/sess-aaa.jsonl', file: new File([text], 'sess-aaa.jsonl') }], null);
      Store.projects = res.projects;
      Store.setSource('local', res.rows, res.meta);
      const t = { in: 0, msgs: 0 };
      for (const r of Store.allRows()) { t.in += r.in; t.msgs += r.msgs; }
      t.persistedProjects = (JSON.parse(localStorage.getItem('aiusage:data')).projects || []).length;
      return t;
    }, sessText);
    ok('dedupe: same session via folder + dropzone counted once', dd.in === 110 && dd.msgs === 2, JSON.stringify(dd));
    ok('dedupe: projects persisted to localStorage', dd.persistedProjects > 0, dd.persistedProjects);

    // Aged-date variant: compaction (rows older than 90d) strips the per-row sid and
    // merges into a bundle — that bundle must carry a `sids` list so local/local-import
    // dedupe still works after compaction, not just for recent uncompacted rows.
    const aged = await page.evaluate(async () => {
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      const agedDay = addDays(todayKey(), -200);
      const row = { d: agedDay, platform: 'Claude Code/Desktop', model: 'claude-sonnet-5', in: 100, cw: 25, cr: 50, out: 200, msgs: 1, sid: 'sess-aged-xyz' };
      Store.setSource('local', [row], {});
      Store.setSource('local-import', [{ ...row }], {});
      const all = Store.allRows();
      const t = { in: 0, msgs: 0, n: all.length };
      for (const r of all) { t.in += r.in; t.msgs += r.msgs; }
      return t;
    });
    ok('dedupe: aged compacted rows still dedupe across local sources',
      aged.n === 1 && aged.in === 100 && aged.msgs === 1, JSON.stringify(aged));

    // Compaction must PRESERVE the row-level local:1 flag (free local inference through a coding tool) and must not
    // merge a local row into a hosted row of the same day/platform/model — otherwise a $0 row would be priced after 90 days
    // (or a hosted row zero-priced). Also: makeAgg keys on the flag the same way.
    const loc = await page.evaluate(async () => {
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      const agedDay = addDays(todayKey(), -200);
      const base = { d: agedDay, platform: 'Continue.dev', model: 'qwen3:14b', in: 100, cw: 0, cr: 0, out: 20, msgs: 1 };
      const rows = Store.compactRows([
        { ...base, sid: 's1', local: 1 }, { ...base, sid: 's2', local: 1 },   // two local rows → one merged local bundle
        { ...base, sid: 's3' },                                              // hosted row, same day/platform/model → separate bundle
      ]);
      const localB = rows.filter(r => r.local === 1), hostedB = rows.filter(r => !r.local);
      Pricing.load();
      const agg = makeAgg();
      agg.add(agedDay, 'Continue.dev', 'qwen3:14b', { in: 10, out: 1, msgs: 1, local: 1 });
      agg.add(agedDay, 'Continue.dev', 'qwen3:14b', { in: 10, out: 1, msgs: 1 });
      agg.add(agedDay, 'Continue.dev', 'qwen3:14b', { in: 10, out: 1, msgs: 1, local: 1 });
      const ar = agg.rows();
      return { n: rows.length, localN: localB.length, localIn: localB.reduce((a, r) => a + r.in, 0), localMsgs: localB.reduce((a, r) => a + r.msgs, 0), localSids: localB[0] && localB[0].sids,
        hostedN: hostedB.length, hostedIn: hostedB.reduce((a, r) => a + r.in, 0), localCost: localB.reduce((a, r) => a + Pricing.cost(r.model, r), 0), hostedCost: hostedB.reduce((a, r) => a + Pricing.cost(r.model, r), 0),
        aggN: ar.length, aggLocal: ar.filter(r => r.local === 1).map(r => [r.in, r.msgs]), aggHosted: ar.filter(r => !r.local).map(r => [r.in, r.msgs]) };
    });
    ok('compactRows: local:1 survives compaction and is part of the merge key (2 local + 1 hosted aged rows → 1 local bundle in=200 msgs=2 sids=[s1,s2] at $0, 1 hosted bundle in=100 priced)',
      loc.n === 2 && loc.localN === 1 && loc.localIn === 200 && loc.localMsgs === 2 && JSON.stringify(loc.localSids) === JSON.stringify(['s1', 's2']) && loc.hostedN === 1 && loc.hostedIn === 100 && loc.localCost === 0 && loc.hostedCost > 0, JSON.stringify(loc));
    ok('makeAgg: local:1 is in the bundle key and copied onto the bundle (2 local adds → one local bundle in=20; 1 hosted add → separate bundle in=10)',
      loc.aggN === 2 && JSON.stringify(loc.aggLocal) === JSON.stringify([[20, 2]]) && JSON.stringify(loc.aggHosted) === JSON.stringify([[10, 1]]), JSON.stringify(loc));
  } finally {
    await page.close();
  }
}
