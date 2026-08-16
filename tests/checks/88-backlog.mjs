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

    // item 15: cached scan reports lines/badLines
    const meta = await page.evaluate(async () => {
      const bad = '{"type":"assistant","message":{"usage":{"input_tokens":1,"output_tokens":1},"model":"m","id":"z1"},"requestId":"z1","timestamp":"2026-08-10T10:00:00Z"}\nnot json\n';
      const res = await parseClaudeLogsCached([{ path: 'projects/-p/s.jsonl', file: new File([bad], 's.jsonl') }], null, new Map());
      return { lines: res.meta.lines, badLines: res.meta.badLines };
    });
    ok('backlog-15: cached scan preserves lines/badLines diagnostics', meta.lines === 2 && meta.badLines === 1, JSON.stringify(meta));
    // item 16: ScanCache prunes signatures not seen in the latest scan
    const evict = await page.evaluate(async () => {
      const cache = new Map();
      const f1 = { path: 'projects/-p/a.jsonl', file: new File(['{"type":"assistant","message":{"usage":{"input_tokens":1,"output_tokens":1},"model":"m","id":"a1"},"requestId":"a1","timestamp":"2026-08-10T10:00:00Z"}'], 'a.jsonl', { lastModified: 1 }) };
      const f2 = { path: 'projects/-p/b.jsonl', file: new File(['{"type":"assistant","message":{"usage":{"input_tokens":1,"output_tokens":1},"model":"m","id":"b1"},"requestId":"b1","timestamp":"2026-08-10T10:00:00Z"}'], 'b.jsonl', { lastModified: 1 }) };
      await parseClaudeLogsCached([f1, f2], null, cache);
      const before = cache.size;
      await parseClaudeLogsCached([f1], null, cache);   // b vanished
      return { before, after: cache.size };
    });
    ok('backlog-16: cache prunes entries for files absent from the latest scan', evict.before === 2 && evict.after === 1, JSON.stringify(evict));
    // item 18: v1.1-shaped store (no connectors) migrates to connected cards
    const mig = await page.evaluate(() => {
      Store.sources = {}; Store.connectors = {};
      Store.sources.anthropic = { rows: [{ d: todayKey(), platform: 'Anthropic API', model: 'm', in: 1, cw: 0, cr: 0, out: 1, msgs: 1 }], meta: { updated: Date.now() - 1000 } };
      Store.migrateConnectors();
      return { st: Store.connectorStatus(connectorById('anthropic')), label: (Store.connectors.anthropic || {}).label };
    });
    ok('backlog-18: sources without connector state migrate to a labeled connected card', mig.st === 'ok' && /stored data/i.test(mig.label), JSON.stringify(mig));
    // item 14: connected new-platform source cards are revealed in Data sources
    const reveal = await page.evaluate(() => {
      Store.setConnector('openrouter', { label: 'k', lastSync: Date.now() });
      App._render();
      return document.getElementById('src-openrouter').hidden === false;
    });
    ok('backlog-14: connected OpenRouter card is visible in Data sources', reveal, '');
    // item 4: large import parse runs off the main thread (worker path exists and returns identical rows)
    const wk = await page.evaluate(async () => {
      const conv = [{ current_node: 'B', mapping: { root: { id: 'root', parent: null, children: ['u'] }, u: { id: 'u', parent: 'root', children: ['B'], message: { author: { role: 'user' }, create_time: 1, content: { content_type: 'text', parts: ['hi'] } } }, B: { id: 'B', parent: 'u', children: [], message: { author: { role: 'assistant' }, create_time: 2, metadata: { model_slug: 'gpt-5.4' }, content: { content_type: 'text', parts: ['x'.repeat(400)] } } } } }];
      const direct = parseChatGPTExport(conv);
      const viaWorker = await parseInWorker('chatgpt', JSON.stringify(conv));
      return { same: JSON.stringify(direct.rows) === JSON.stringify(viaWorker.rows), msgs: viaWorker.meta.msgs };
    });
    ok('backlog-4: worker parse returns identical rows for chat exports', wk.same && wk.msgs === 1, JSON.stringify(wk));
  } finally {
    await page.close();
  }
}
