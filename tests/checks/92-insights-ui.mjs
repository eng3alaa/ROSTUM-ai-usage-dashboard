import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser, { clockAt: '2026-08-16T09:00:00Z' });
  try {
    const ui = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const rows = [];
      for (let i = 1; i <= 15; i++) rows.push({ d: '2026-08-' + String(i).padStart(2, '0'), platform: 'Anthropic API', model: 'claude-sonnet-5', in: 1_000_000, cw: 0, cr: 500_000, out: 0, msgs: 30, hour: 10 });
      Store.setSource('anthropic', rows, {});
      App.filters.range = '30';
      App._render();
      const row = document.getElementById('insights');
      const q = (id) => document.getElementById(id);
      return {
        exists: !!row,
        cards: [...row.querySelectorAll('.insight')].map(c => c.dataset.insight),
        projText: q('ins-projection-value').textContent,
        heatCells: q('ins-heatmap').querySelectorAll('rect.hm').length,
        heatHasFill: [...q('ins-heatmap').querySelectorAll('rect.hm')].some(r => r.getAttribute('fill') && r.getAttribute('fill') !== 'none'),
        hoursBars: q('ins-hours').querySelectorAll('rect.hb').length,
        cacheText: q('ins-cache-value').textContent,
        wowText: q('ins-wow').textContent,
        effRows: q('ins-efficiency').querySelectorAll('tr').length,
      };
    });
    ok('insights-ui: row renders all seven cards', ui.exists &&
      ['projection','heatmap','efficiency','cache','hours','wow','movers'].every(k => ui.cards.includes(k)), JSON.stringify(ui.cards));
    ok('insights-ui: projection shows a dollar figure', /\$\d/.test(ui.projText), ui.projText);
    ok('insights-ui: heatmap draws 13 weeks × 7 days with filled cells', ui.heatCells === 91 && ui.heatHasFill, JSON.stringify([ui.heatCells, ui.heatHasFill]));
    ok('insights-ui: hours histogram draws 24 bars', ui.hoursBars === 24, ui.hoursBars);
    ok('insights-ui: cache savings shows a dollar figure', /\$\d/.test(ui.cacheText), ui.cacheText);
    ok('insights-ui: WoW chips render', /%/.test(ui.wowText), ui.wowText);
    ok('insights-ui: efficiency table has header + at least one model row', ui.effRows >= 2, ui.effRows);

    const empty = await page.evaluate(() => {
      Store.sources = {}; App._render();
      return { hoursNote: document.getElementById('ins-hours').textContent, cards: document.querySelectorAll('#insights .insight').length };
    });
    ok('insights-ui: empty data degrades to notes, not errors', empty.cards === 7 && /no timestamped|no data/i.test(empty.hoursNote), JSON.stringify(empty));
  } finally {
    await page.close();
  }
}
