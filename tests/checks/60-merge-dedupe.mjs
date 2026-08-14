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
  } finally {
    await page.close();
  }
}
