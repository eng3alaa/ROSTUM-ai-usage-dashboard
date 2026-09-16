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

    // Plan 6 (v6-unpriced): breakdown rows whose model no price row matches carry a "fallback price" badge; local rows never do
    const badge = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      App.filters.range = '30'; App._drill = null; App.filters.hiddenPlatforms = new Set();
      const r = (platform, model, extra = {}) => ({ d: '2026-08-10', platform, model, in: 1000, cw: 0, cr: 0, out: 0, msgs: 1, ...extra });
      Store.setSource('codex', [r('OpenAI Codex CLI', 'gpt-6-astra'), r('Cline', 'weird-local-model', { local: 1 })], {});
      Store.setSource('anthropic', [r('Anthropic API', 'claude-sonnet-5')], {});
      Store.setSource('ollama', [r('Ollama', 'llama-mystery')], {});
      App._render();
      const out = {};
      for (const tr of document.querySelectorAll('#breakdown-table tbody tr:not(.total)')) {
        const name = tr.querySelector('td.name'); const b = name.querySelector('.badge.fallback-price');
        out[[...name.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()] = b ? b.title : false;
      }
      Store.sources = {};
      return out;
    });
    ok('breakdown: "fallback price" badge on gpt-6-astra (with the add-a-row hint), none on claude-sonnet-5',
      /No price row matches this model/.test(badge['gpt-6-astra']) && /API price list/.test(badge['gpt-6-astra']) && badge['claude-sonnet-5'] === false, JSON.stringify(badge));
    ok('breakdown: local rows are never flagged (Ollama platform row; Cline row with local:1)',
      badge['llama-mystery'] === false && badge['weird-local-model'] === false, JSON.stringify(badge));
  } finally {
    await page.close();
  }
}
