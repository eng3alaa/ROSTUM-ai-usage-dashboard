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
  } finally {
    await page.close();
  }
}
