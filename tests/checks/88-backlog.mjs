import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    // item 2: first week bucket label clamps to range start
    const lbl = await page.evaluate(() => {
      const b = bucketDays(dayRange('2025-10-01', '2026-03-31'));
      return { first: b.buckets[0].key, firstDay: b.buckets[0].days[0], label: b.buckets[0].label };
    });
    ok('backlog-2: first week bucket carries a range-clamped label', lbl.firstDay === '2025-10-01' && lbl.label && lbl.label.includes('Oct 1'), JSON.stringify(lbl));
    // item 3: delegated pointer handler — one listener on the SVG, no per-band listeners
    const del = await page.evaluate(() => {
      Store.sources = {}; Store.setSource('csv', Array.from({ length: 30 }, (_, i) => ({ d: addDays('2026-07-01', i), platform: 'Gemini', model: 'g', in: 10, cw: 0, cr: 0, out: 5, msgs: 1 })), {});
      App.filters.range = 'custom'; App.filters.from = '2026-07-01'; App.filters.to = '2026-07-30'; App._render();
      const svg = document.querySelector('#daily-chart svg');
      const bands = svg.querySelectorAll('.colband');
      // per-band listeners were removed: bands are plain rects (no tabindex), the SVG has one hit layer
      return { bands: bands.length, svgHasHit: !!svg.querySelector('.hitlayer'), anyBandTab: [...bands].some(b => b.hasAttribute('tabindex')) };
    });
    ok('backlog-3: chart uses one delegated hit layer, not per-band listeners', del.svgHasHit && !del.anyBandTab && del.bands === 30, JSON.stringify(del));
    // item 13: 9th platform gets a distinct visible slot, not the "Other" gray
    const col = await page.evaluate(() => {
      ColorMap.maps = { platform: {}, model: {} };
      const cands = ['A','B','C','D','E','F','G','H','I'];
      const colors = cands.map(p => ColorMap.colorOf('platform', p, cands));
      return { unique: new Set(colors).size, otherHex: getComputedStyle(document.documentElement).getPropertyValue('--other').trim(), last: colors[8] };
    });
    ok('backlog-13: 9+ platforms still get distinct colors (palette widened)', col.unique === 9 && col.last !== col.otherHex, JSON.stringify(col));
    // item 10: drill-down does not leak into persisted chip state
    const leak = await page.evaluate(() => {
      LS.del('hiddenPlatforms'); App.filters.hiddenPlatforms = new Set();
      Store.sources = {}; Store.setSource('openrouter', [{ d: todayKey(), platform: 'OpenRouter', model: 'x', in: 5, cw: 0, cr: 0, out: 5, msgs: 1 }], {});
      Store.setSource('csv', [{ d: todayKey(), platform: 'Gemini', model: 'y', in: 7, cw: 0, cr: 0, out: 7, msgs: 1 }], {});
      App._render();
      App.drillDown(connectorById('openrouter'));
      const afterDrill = LS.get('hiddenPlatforms', null);
      // now click an unrelated chip (Gemini) — must persist ONLY the user's chip state, not the drill set
      const chip = [...document.querySelectorAll('#platform-chips .chip')].find(c => c.textContent.includes('Gemini'));
      chip && chip.click();
      const afterChip = LS.get('hiddenPlatforms', null);
      return { afterDrill, afterChip };
    });
    ok('backlog-10: drill-down is ephemeral; chip click persists only user chip state', leak.afterDrill === null && Array.isArray(leak.afterChip) && leak.afterChip.length === 1 && leak.afterChip[0] === 'Gemini', JSON.stringify(leak));
  } finally {
    await page.close();
  }
}
