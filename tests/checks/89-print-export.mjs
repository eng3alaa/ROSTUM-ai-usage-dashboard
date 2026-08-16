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

    // F2: the daily chart svg carries a FIXED pixel `width` attribute, sized to the
    // container at the moment of the last JS render. Printing (Ctrl+P / window.print())
    // doesn't trigger a re-render — it just applies the print stylesheet to whatever is
    // already in the DOM. A chart rendered on a normal wide screen keeps its wide SVG
    // width baked in, so if the print layout (or a narrower window) shrinks the card
    // afterward, the stale SVG overflows/clips unless CSS constrains it independent of JS.
    const origVp = page.viewport();
    try {
      await page.emulateMediaType('screen');
      await page.setViewport({ width: 1280, height: 900 });
      await page.evaluate(() => {
        Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
        Store.setSource('csv', Array.from({ length: 30 }, (_, i) => ({ d: addDays('2026-07-01', i), platform: 'Gemini', model: 'g', in: 10, cw: 0, cr: 0, out: 5, msgs: 1 })), {});
        App.filters.range = '30'; App._render();
      });
      // now shrink + switch to print WITHOUT re-rendering — the SVG's width attribute is stale
      await page.setViewport({ width: 720, height: 900 });
      await page.emulateMediaType('print');
      const fit = await page.evaluate(() => {
        const svg = document.querySelector('#daily-chart svg');
        const box = document.getElementById('daily-chart');
        return { svgW: svg.getBoundingClientRect().width, boxW: box.getBoundingClientRect().width };
      });
      ok('print: daily chart svg fits its container width (no clipping) at print time', fit.svgW <= fit.boxW + 1, JSON.stringify(fit));
    } finally {
      await page.emulateMediaType('screen');
      await page.setViewport(origVp);
    }
  } finally {
    await page.close();
  }
}
