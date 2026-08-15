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
  } finally {
    await page.close();
  }
}
