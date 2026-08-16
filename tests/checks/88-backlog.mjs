import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    // item 2: first week bucket label clamps to range start
    const lbl = await page.evaluate(() => {
      const b = bucketDays(dayRange('2025-10-01', '2026-03-31'));
      // F4: the rendered x-axis tick labels must use the same range-clamped first day, not
      // the raw bucket key (which for the first week can be a Monday BEFORE the range start).
      App._drill = null; App.filters.hiddenPlatforms = new Set();
      Store.sources = {};
      Store.setSource('csv', dayRange('2025-10-01', '2026-03-31').map(d => ({ d, platform: 'Gemini', model: 'g', in: 10, cw: 0, cr: 0, out: 5, msgs: 1 })), {});
      App.filters.range = 'custom'; App.filters.from = '2025-10-01'; App.filters.to = '2026-03-31'; App._render();
      const tickTexts = [...document.querySelectorAll('#daily-chart svg text.axis-t')].map(t => t.textContent);
      return { first: b.buckets[0].key, firstDay: b.buckets[0].days[0], label: b.buckets[0].label, tickTexts };
    });
    ok('backlog-2: first week bucket carries a range-clamped label', lbl.firstDay === '2025-10-01' && lbl.label && lbl.label.includes('Oct 1') && !lbl.tickTexts.includes('Sep 29'), JSON.stringify(lbl));
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

    // F1: drill-down must apply to insights + narrative coherently, not just KPIs/daily —
    // otherwise movers compares a drilled "current" window against an undrilled "previous"
    // window and invents a false mover, and projection/WoW blend in the hidden platform.
    const drillIns = await page.evaluate(() => {
      LS.del('hiddenPlatforms'); App.filters.hiddenPlatforms = new Set(); App._drill = null;
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const today = todayKey(), prior = addDays(today, -10);
      const rows = [
        { d: today, platform: 'Gemini', model: 'g', in: 1_000_000, cw: 0, cr: 0, out: 0, msgs: 5 },
        { d: today, platform: 'OpenRouter', model: 'o', in: 2_000_000, cw: 0, cr: 0, out: 0, msgs: 5 },
        { d: prior, platform: 'Gemini', model: 'g', in: 1_000_000, cw: 0, cr: 0, out: 0, msgs: 5 },
        { d: prior, platform: 'OpenRouter', model: 'o', in: 2_000_000, cw: 0, cr: 0, out: 0, msgs: 5 },
      ];
      Store.setSource('csv', rows, {});
      App.filters.range = '7';   // 'prior' (today-10) must land in the PREVIOUS equal-length window, not the current one
      App.drillDown(connectorById('openrouter'));
      App._render();
      const orRows = rows.filter(r => r.platform === 'OpenRouter');
      const costOf = (r) => Pricing.cost(r.model, r);
      const expected = Insights.projection(orRows, costOf, todayKey());
      return {
        moversText: document.getElementById('ins-movers').textContent,
        projText: document.getElementById('ins-projection-value').textContent,
        expectedProjText: fmtUSD(expected.projected),
      };
    });
    ok('backlog-10b: drill-down applies to insights + narrative coherently',
      !drillIns.moversText.includes('Gemini') && drillIns.projText === drillIns.expectedProjText, JSON.stringify(drillIns));
    await page.evaluate(() => { App._drill = null; });   // isolation: don't leak drill state into later checks in this file

    // F3: hovering the delegated hit layer should visually highlight the band under the
    // pointer, even though the bands themselves no longer receive pointer events directly.
    const active = await page.evaluate(() => {
      App._drill = null; App.filters.hiddenPlatforms = new Set();
      Store.sources = {}; Store.setSource('csv', Array.from({ length: 30 }, (_, i) => ({ d: addDays('2026-07-01', i), platform: 'Gemini', model: 'g', in: 10, cw: 0, cr: 0, out: 5, msgs: 1 })), {});
      App.filters.range = 'custom'; App.filters.from = '2026-07-01'; App.filters.to = '2026-07-30'; App._render();
      const svg = document.querySelector('#daily-chart svg');
      const hit = svg.querySelector('.hitlayer');
      const hitX = +hit.getAttribute('x'), hitW = +hit.getAttribute('width');
      const bands = [...svg.querySelectorAll('.colband')];
      const band = hitW / bands.length;
      const r = svg.getBoundingClientRect();   // svg width/height attrs == viewBox units 1:1 to client px (no CSS scaling on screen)
      const clientX = r.left + hitX + band * 3 + band / 2;
      const clientY = r.top + 20;
      hit.dispatchEvent(new PointerEvent('pointermove', { clientX, clientY, bubbles: true }));
      const activeBands = bands.filter(b => b.classList.contains('active'));
      return { count: activeBands.length, idx: activeBands.length ? bands.indexOf(activeBands[0]) : -1 };
    });
    ok('backlog-3b: hovered band highlighted via active class', active.count === 1 && active.idx === 3, JSON.stringify(active));

    // F5: entities persisted with the old 8-slot overflow sentinel (-1, "Other" gray) from
    // before the palette widened to 12 slots must re-assign into a real slot, not stay gray.
    const legacy = await page.evaluate(() => {
      ColorMap.maps = { platform: { Legacy: -1 }, model: {} };
      const c = ColorMap.colorOf('platform', 'Legacy', ['Legacy']);
      const otherHex = getComputedStyle(document.documentElement).getPropertyValue('--other').trim();
      return { c, otherHex };
    });
    ok('backlog-13b: legacy -1 slots re-assign after palette widening', legacy.c !== legacy.otherHex, JSON.stringify(legacy));
  } finally {
    await page.close();
  }
}
