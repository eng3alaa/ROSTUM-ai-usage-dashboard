import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser, { clockAt: '2026-08-16T09:00:00Z' });
  try {
    const t = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const rows = [];
      for (let i = 1; i <= 15; i++) {
        rows.push({ d: '2026-08-' + String(i).padStart(2, '0'), platform: 'Anthropic API', model: 'claude-sonnet-5', in: 100000, cw: 0, cr: 0, out: 20000, msgs: 10 });
        rows.push({ d: '2026-08-' + String(i).padStart(2, '0'), platform: 'OpenRouter', model: 'deepseek/deepseek-v4', in: 5000, cw: 0, cr: 0, out: 1000, msgs: 2 });
      }
      Store.setSource('anthropic', rows.filter(r => r.platform === 'Anthropic API'), {});
      Store.setSource('openrouter', rows.filter(r => r.platform === 'OpenRouter'), {});
      App.filters.range = '30'; App._render();
      const txt = document.getElementById('narrative').textContent;
      Store.sources = {}; App._render();
      const emptyTxt = document.getElementById('narrative').textContent;
      return { txt, emptyTxt };
    });
    ok('narrative: mentions totals, top model, top platform, projection', /\$\d/.test(t.txt) && /claude-sonnet-5/.test(t.txt) && /Anthropic API/.test(t.txt) && /project/i.test(t.txt), t.txt.slice(0, 200));
    ok('narrative: empty range degrades to a single honest sentence', /not enough data/i.test(t.emptyTxt), t.emptyTxt);

    const zero = await page.evaluate(() => {
      Pricing.rows.unshift({ pat: '^freebie$', label: 'Free', in: 0, out: 0, cw: 0, cr: 0 });
      Pricing._cache.clear();
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      Store.setSource('anthropic', [{ model: 'freebie', platform: 'X', in: 100, out: 10, cw: 0, cr: 0, msgs: 1, d: todayKey() }], {});
      App.filters.range = '30'; App._render();
      const txt = document.getElementById('narrative').textContent;
      Pricing.rows.shift(); Pricing._cache.clear();
      return { txt };
    });
    ok('narrative: zero-cost range never prints NaN', !/NaN/.test(zero.txt), zero.txt);
  } finally {
    await page.close();
  }
}
