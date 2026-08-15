import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    // A per-file "Parsing…" status must appear before heavy work; we detect it by
    // instrumenting appendChild on the status node before importing.
    const sawParsing = await page.evaluate(async () => {
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      const status = document.getElementById('import-status');
      const texts = [];
      const orig = status.appendChild.bind(status);
      status.appendChild = (n) => { texts.push(n.textContent); return orig(n); };
      const csv = 'date,platform,model,input_tokens\n2026-08-10,Gemini,gemini-3,5\n';
      await App.handleImportFiles([new File([csv], 'tiny.csv', { type: 'text/csv' })]);
      status.appendChild = orig;
      return texts.some(t => /Parsing tiny\.csv/.test(t));
    });
    ok('import: shows per-file Parsing status before work', sawParsing, '');
  } finally {
    await page.close();
  }
}
