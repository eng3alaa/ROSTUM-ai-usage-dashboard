import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    // pure-function checks: no Store involved, so no isolation reset needed here.
    const b = await page.evaluate(() => {
      const wide = bucketDays(dayRange('2020-01-01', '2026-08-01'));   // ~2400 days
      const mid = bucketDays(dayRange('2026-01-01', '2026-08-01'));    // ~213 days
      const small = bucketDays(dayRange('2026-08-01', '2026-08-14'));  // 14 days
      return {
        wideUnit: wide.unit, wideN: wide.buckets.length,
        midUnit: mid.unit, midN: mid.buckets.length,
        smallUnit: small.unit, smallN: small.buckets.length,
      };
    });
    ok('bucket: 6.5y range folds to months ≤160 cols', b.wideUnit === 'month' && b.wideN <= 160, JSON.stringify(b));
    ok('bucket: 7-month range folds to weeks ≤160 cols', b.midUnit === 'week' && b.midN <= 160, JSON.stringify(b));
    ok('bucket: short range stays daily', b.smallUnit === 'day' && b.smallN === 14, JSON.stringify(b));

    // DOM-level: seed 400 days of data, select All, count hit-bands
    const seed = { sources: { csv: { rows: [], meta: {} } }, billed: {}, projects: [] };
    let d = '2025-07-01';
    for (let i = 0; i < 400; i++) {
      seed.sources.csv.rows.push({ d, platform: 'Gemini', model: 'gemini-3', in: 10, cw: 0, cr: 0, out: 5, msgs: 1 });
      const dt = new Date(d + 'T12:00:00'); dt.setDate(dt.getDate() + 1); d = dt.toISOString().slice(0, 10);
    }
    // seeded via openDashboard's seedData (writes localStorage, then reloads) — do NOT reset
    // Store/localStorage afterward, that would wipe the seed we just relied on.
    const { page: p2 } = await openDashboard(browser, { seedData: seed });
    try {
      const nBands = await p2.evaluate(async () => {
        // "All" preset button: HTML uses data-range="all" (not data-days) — fall back to
        // textContent match if that ever changes.
        const btn = document.querySelector('#range-presets button[data-range="all"]')
          || [...document.querySelectorAll('#range-presets button')].find(b => b.textContent.trim() === 'All');
        btn?.click();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return document.querySelectorAll('#daily-chart .colband').length;
      });
      ok('bucket: 400-day All view renders ≤160 hit-bands', nBands > 0 && nBands <= 160, nBands);
    } finally {
      await p2.close();
    }
  } finally {
    await page.close();
  }
}
