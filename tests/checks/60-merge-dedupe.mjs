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

    // Cursor usage-events CSV: a re-import REPLACES rows (one export = the full window), so it must replace the billed
    // envelope too — a second export WITHOUT a Cost column must leave a truthful empty billed set (not stale dollars
    // behind rows that no longer exist), and the import note must say whether the export carried a cost column.
    const cursorRe = await page.evaluate(async () => {
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const head = 'Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens';
      const withCost = head + ',Cost\n2026-08-10T09:00:00.000Z,Usage-based,gpt-5.4,No,100,500,0,80,680,1.25\n';
      const noCost = head + '\n2026-08-12T09:00:00.000Z,Included,gpt-5.4,No,100,500,0,80,680\n';
      await App.handleImportFiles([new File([withCost], 'usage-events.csv', { type: 'text/csv' })]);
      const first = { billed: Store.billedRows('cursor-csv').map(b => [b.d, b.amount]), note: document.getElementById('import-status').textContent };
      await App.handleImportFiles([new File([noCost], 'usage-events (1).csv', { type: 'text/csv' })]);
      const env = Store.billed['cursor-csv'];
      const second = { billed: Store.billedRows('cursor-csv').map(b => [b.d, b.amount]), stale: env ? env.stale : null, days: Store.sources['cursor-csv'].rows.map(r => r.d), note: document.getElementById('import-status').textContent };
      Store.sources = {}; Store.billed = {}; Store.persist();
      return { first, second };
    });
    ok('cursor re-import: first export with a Cost column → billed [2026-08-10, 1.25]; note says "+ cost column"',
      JSON.stringify(cursorRe.first.billed) === JSON.stringify([['2026-08-10', 1.25]]) && /\+ cost column/.test(cursorRe.first.note), JSON.stringify(cursorRe.first));
    ok('cursor re-import: second export WITHOUT a Cost column replaces rows AND billed (billed empty, fresh not stale, rows = [2026-08-12]); note says "no cost column"',
      cursorRe.second.billed.length === 0 && cursorRe.second.stale === false && JSON.stringify(cursorRe.second.days) === JSON.stringify(['2026-08-12']) && /no cost column/.test(cursorRe.second.note), JSON.stringify(cursorRe.second));

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

    // Compaction must be by AGE, not by the presence of a sid: sid-less hour-granular parsers (Gemini Takeout, Continue.dev,
    // usage-logger JSONL, Cursor CSV) emit up to 24 rows/day/model — past 90 days they must merge into one day/platform/model
    // bucket (hour dropped, no sids array emitted), while recent sid-less hour rows stay untouched.
    const age = await page.evaluate(async () => {
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      const agedDay = addDays(todayKey(), -200), recentDay = addDays(todayKey(), -5);
      const base = { platform: 'Gemini', model: 'gemini-2.5-pro', cw: 0, cr: 0, msgs: 1 };
      Store.setSource('gemini-takeout', [
        { ...base, d: agedDay, hour: 9, in: 100, out: 10, est: 1 },
        { ...base, d: agedDay, hour: 17, in: 200, out: 20, est: 1 },
        { ...base, d: recentDay, hour: 8, in: 5, out: 1, est: 1 },
      ], {});
      const rows = Store.sources['gemini-takeout'].rows;
      const old = rows.filter(r => r.d === agedDay), rec = rows.filter(r => r.d === recentDay);
      return { n: rows.length, oldN: old.length, old: old[0], recN: rec.length, rec: rec[0] };
    });
    ok('compactRows: sid-less hour rows older than 90d merge into one day/platform/model bucket (in=300 out=30 msgs=2, hour dropped, est kept, no sids array)',
      age.n === 2 && age.oldN === 1 && age.old.in === 300 && age.old.out === 30 && age.old.msgs === 2 && age.old.hour === undefined && age.old.est === 1 && !('sids' in age.old) && !('sid' in age.old),
      JSON.stringify(age));
    ok('compactRows: a recent sid-less hour row is kept as-is (hour=8, in=5)',
      age.recN === 1 && age.rec.hour === 8 && age.rec.in === 5 && age.rec.est === 1, JSON.stringify(age.rec));
    // Merge-by-sid sources (Meta AI threads, Perplexity files, Copilot activity CSVs: one file replaces only itself on re-import) compact
    // per (day, platform, model, sid) — { perSid: true } keeps a scalar sid on each bucket (hour dropped, est kept, no sids list) so the
    // per-file replace filter stays exact; the default (no opts) still folds across sids into one bucket with a sids list (Claude logs etc.).
    const ps = await page.evaluate(async () => {
      const agedDay = addDays(todayKey(), -200), recentDay = addDays(todayKey(), -5);
      const base = { d: agedDay, platform: 'Meta AI', model: 'meta-ai', cw: 0, cr: 0, est: 1 };
      const input = [
        { ...base, sid: 'inbox/a', hour: 9, in: 10, out: 20, msgs: 1 }, { ...base, sid: 'inbox/a', hour: 21, in: 5, out: 2, msgs: 1 },   // a: in 15 out 22 msgs 2
        { ...base, sid: 'inbox/b', hour: 8, in: 1, out: 1, msgs: 1 }, { ...base, sid: 'inbox/b', hour: 10, in: 3, out: 4, msgs: 1 },     // b: in 4 out 5 msgs 2
        { ...base, d: recentDay, sid: 'inbox/a', hour: 7, in: 2, out: 3, msgs: 1 },                                                     // recent → untouched
      ];
      const shape = (rows) => rows.map(r => [r.d === agedDay ? 'aged' : 'recent', r.sid, r.in, r.out, r.msgs, r.hour, r.est, r.sids]).sort((a, b) => (String(a) < String(b) ? -1 : 1));   // undefined → null in JSON
      const per = shape(Store.compactRows(input, { perSid: true })), def = shape(Store.compactRows(input));
      Store.setSource('meta-ai-export', input, {}, { perSid: true });
      const via = shape(Store.sources['meta-ai-export'].rows);
      Store.sources = {}; Store.persist();
      return { per, def, via };
    });
    ok('compactRows perSid: two sids on one aged day stay two rows with tokens summed per sid, scalar sid kept, hour dropped, est kept, no sids list; the recent row is untouched; setSource(id, rows, meta, { perSid: true }) passes it through',
      JSON.stringify(ps.per) === JSON.stringify([['aged', 'inbox/a', 15, 22, 2, null, 1, null], ['aged', 'inbox/b', 4, 5, 2, null, 1, null], ['recent', 'inbox/a', 2, 3, 1, 7, 1, null]]) && JSON.stringify(ps.via) === JSON.stringify(ps.per), JSON.stringify({ per: ps.per, via: ps.via }));
    ok('compactRows default (no opts) is unchanged: the same aged rows fold across sids into ONE bucket (in=19 out=27 msgs=4, sids [inbox/a, inbox/b], no scalar sid, no hour); the recent row is untouched',
      JSON.stringify(ps.def) === JSON.stringify([['aged', null, 19, 27, 4, null, 1, ['inbox/a', 'inbox/b']], ['recent', 'inbox/a', 2, 3, 1, 7, 1, null]]), JSON.stringify(ps.def));
  } finally {
    await page.close();
  }
}
