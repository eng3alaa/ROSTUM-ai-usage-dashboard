import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const cells = await page.evaluate(() => [
      csvCell('=HYPERLINK("http://evil")'), csvCell('+1'), csvCell('-2'), csvCell('@x'),
      csvCell('\tx'), csvCell('normal'), csvCell('has,comma'), csvCell('has"quote'),
    ]);
    ok('csv: formula prefixes neutralized',
      cells[0] === '"\'=HYPERLINK(""http://evil"")"' && cells[1] === "'+1" && cells[2] === "'-2" &&
      cells[3] === "'@x" && cells[4] === "'\tx",
      JSON.stringify(cells));
    ok('csv: normal quoting intact',
      cells[5] === 'normal' && cells[6] === '"has,comma"' && cells[7] === '"has""quote"',
      JSON.stringify(cells));

    const { readFixture } = await import('../lib/harness.mjs');
    const csv = readFixture('generic-badnums.csv');
    const parsed = await page.evaluate((text) => {
      const res = parseGenericCSV(text);
      const t = { in: 0, out: 0 };
      for (const r of res.rows) { t.in += r.in; t.out += r.out; }
      return { ...t, billed: res.billed.reduce((a, b) => a + b.amount, 0) };
    }, csv);
    ok('csv: non-finite and garbage numbers rejected, negatives rejected for tokens',
      parsed.in === 100 && parsed.out === 110,          // 1e309→0, 12junk→0, -40→0; out: 0+50+60
      JSON.stringify(parsed));
    ok('csv: cost column allows negative (credits), rejects garbage',
      Math.abs(parsed.billed - 0.25) < 1e-9,            // 0.5 + 0 (abc) + (-0.25)
      JSON.stringify(parsed));

    const rejectedMeta = await page.evaluate((text) => parseGenericCSV(text).meta.rejected, csv);
    ok('csv: meta.rejected counts the 4 bad values (1e309, 12junk, abc, -40) — -0.25 is a valid credit',
      rejectedMeta === 4, rejectedMeta);

    const importNote = await page.evaluate(async (text) => {
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      await App.handleImportFiles([new File([text], 'badnums.csv', { type: 'text/csv' })]);
      return document.getElementById('import-status').textContent;
    }, csv);
    ok('csv: import status surfaces rejected-value count', importNote.includes('rejected'), importNote);

    // generic CSVs with a cost column are the generic importer's: the DeepSeek cost sniff needs positive evidence (a cost-*.csv name or an export header:
    // utc_date / api_key_name / currency / start_time_iso / wallet_type) and never claims a header with a token alias (in / out / input / output / prompt_tokens / completion_tokens / cache_read …)
    const generic = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const a = 'date,provider,model,in,out,cost\n2026-08-10,OpenAI,gpt-5.4,100,50,0.25\n', b = 'date,model,cost_usd\n2026-08-11,claude-sonnet-5,1.5\n';
      const head = (s) => (parseCSV(s.split(/\r?\n/, 1)[0])[0] || []).map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
      const sniff = [isDeepSeekCostCSV(head(a), 'usage.csv'), isDeepSeekCostCSV(head(b), 'spend.csv'), isDeepSeekCostCSV(['date', 'model', 'prompt_tokens', 'completion_tokens', 'cost'], 'cost-2026-08.csv'), isDeepSeekAmountCSV(head(a), 'usage.csv')];
      await App.handleImportFiles([new File([a], 'usage.csv', { type: 'text/csv' }), new File([b], 'spend.csv', { type: 'text/csv' })]);
      const csv = Store.sources.csv;
      const out = { sniff, rows: csv ? csv.rows.map(r => [r.d, r.platform, r.model, r.in, r.out]).sort() : null, billed: Store.billedRows('csv').map(x => [x.d, x.amount]), ds: !!Store.sources['deepseek-usage-zip'], dsBilled: Store.billedRows('deepseek-usage-zip').length,
        dsConn: Store.connectors.deepseek === undefined, imports: (Store.connectors.imports || {}).label, note: document.getElementById('import-status').textContent };
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.persist();
      return out;
    });
    ok('csv: generic cost CSVs (date,provider,model,in,out,cost · date,model,cost_usd; a cost-*.csv with token columns) are not DeepSeek cost files — both land under the generic csv source (OpenAI/gpt-5.4 100/50 + Other/claude-sonnet-5; billed 0.25 + 1.5), nothing under deepseek-usage-zip, no deepseek connector, "2 file(s) imported"',
      JSON.stringify(generic.sniff) === JSON.stringify([false, false, false, false]) && JSON.stringify(generic.rows) === JSON.stringify([['2026-08-10', 'OpenAI', 'gpt-5.4', 100, 50], ['2026-08-11', 'Other', 'claude-sonnet-5', 0, 0]])
      && JSON.stringify(generic.billed) === JSON.stringify([['2026-08-10', 0.25], ['2026-08-11', 1.5]]) && !generic.ds && generic.dsBilled === 0 && generic.dsConn && generic.imports === '2 file(s) imported' && (generic.note.match(/imported 1 CSV rows/g) || []).length === 2, JSON.stringify(generic));
  } finally {
    await page.close();
  }
}
