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
  } finally {
    await page.close();
  }
}
