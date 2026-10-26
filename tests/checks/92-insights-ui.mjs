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

    // Plan 9 A2: the breakdown also says WHICH rate priced a line — a retired id priced as its successor ("priced as grok-4.3"), a platform's own
    // PRICE_OVERRIDES rate ("SambaNova rate"), a user-edited row ("user price"); a plain vendor row carries no badge; "fallback price" is unchanged
    const which = await page.evaluate(() => {
      Store.sources = {}; LS.del('prices'); Pricing.load();
      App.filters.range = '30'; App._drill = null; App.filters.hiddenPlatforms = new Set();
      const r = (platform, model) => ({ d: '2026-08-10', platform, model, in: 1_000_000, cw: 0, cr: 0, out: 0, msgs: 1 });
      Store.setSource('csv', [r('xAI', 'grok-4'), r('SambaNova', 'minimax-m3'), r('MiniMax', 'minimax-m3'), r('Anthropic API', 'claude-sonnet-5'), r('OpenAI Codex CLI', 'gpt-6-astra')], {});
      Pricing.rows.find(x => x.pat === 'claude-sonnet-5').in = 3; Pricing.save();   // a user edit of a bundled row
      App._render();
      const out = {};
      for (const tr of document.querySelectorAll('#breakdown-table tbody tr:not(.total)')) {
        const name = tr.querySelector('td.name');
        const model = [...name.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
        out[model + '@' + tr.children[1].textContent] = [...name.querySelectorAll('.badge')].map(b => [b.className, b.textContent, b.title]);
      }
      LS.del('prices'); Pricing.load(); Store.sources = {};
      return out;
    });
    const only = (k, cls, text) => Array.isArray(which[k]) && which[k].length === 1 && which[k][0][0] === 'badge price-note ' + cls && which[k][0][1] === text && which[k][0][2].length > 20;
    ok('breakdown (A2): grok-4 on xAI carries "priced as grok-4.3" (.badge.price-note.alias-price with a title), minimax-m3 on SambaNova "SambaNova rate" (.override-price), the user-edited claude-sonnet-5 "user price" (.user-price)',
      only('grok-4@xAI', 'alias-price', 'priced as grok-4.3') && only('minimax-m3@SambaNova', 'override-price', 'SambaNova rate') && only('claude-sonnet-5@Anthropic API', 'user-price', 'user price'), JSON.stringify(which));
    ok('breakdown (A2): the same minimax-m3 on the MiniMax platform (vendor row, no override) carries no badge; gpt-6-astra keeps exactly the "fallback price" badge',
      Array.isArray(which['minimax-m3@MiniMax']) && which['minimax-m3@MiniMax'].length === 0 && Array.isArray(which['gpt-6-astra@OpenAI Codex CLI']) && which['gpt-6-astra@OpenAI Codex CLI'].length === 1 && which['gpt-6-astra@OpenAI Codex CLI'][0][1] === 'fallback price' && /fallback-price/.test(which['gpt-6-astra@OpenAI Codex CLI'][0][0]),
      JSON.stringify(which));
  } finally {
    await page.close();
  }
}
