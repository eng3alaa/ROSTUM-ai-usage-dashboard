import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const btn = await page.evaluate(() => !!document.getElementById('print-report'));
    ok('print: Print report button exists', btn, '');
    await page.emulateMediaType('print');
    const pr = await page.evaluate(() => {
      const vis = (id) => { const e = document.getElementById(id); return e ? getComputedStyle(e).display !== 'none' : null; };
      return { hub: vis('accounts-hub'), filter: getComputedStyle(document.querySelector('.filterbar')).display, sources: vis('sources'), kpis: vis('kpis'), insights: vis('insights'), narrative: vis('card-narrative'), header: !!document.getElementById('report-meta') && vis('report-meta') };
    });
    ok('print: hub, filter bar, sources hidden; KPIs/insights/narrative/report header shown',
      pr.hub === false && pr.filter === 'none' && pr.sources === false && pr.kpis === true && pr.insights === true && pr.narrative === true && pr.header === true, JSON.stringify(pr));
    await page.emulateMediaType('screen');
    const meta = await page.evaluate(() => { App.printReport(true); return document.getElementById('report-meta').textContent; });
    ok('print: report header carries range + generated date', /Generated/.test(meta) && /\d{4}/.test(meta), meta);
  } finally {
    await page.close();
  }
}
