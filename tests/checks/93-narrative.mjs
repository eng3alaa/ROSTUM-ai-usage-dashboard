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

    // I3: a total budget sentence is computed from ALL rows (Budgets.status ignores drill/
    // chip scope), so when the narrative itself is scoped to one platform, the sentence
    // must say so — otherwise it silently mixes a whole-account number into a filtered view.
    const scoped = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      Store.setSource('anthropic', [{ d: '2026-08-10', platform: 'Anthropic API', model: 'claude-sonnet-5', in: 1_000_000, cw: 0, cr: 0, out: 0, msgs: 1 }], {});
      Budgets.set('total', 100);
      App.filters.range = '30'; App._drill = null; App.filters.hiddenPlatforms = new Set();
      App._render();
      const undrilled = document.getElementById('narrative').textContent;
      App._drill = 'Anthropic API'; App._render();
      const drilled = document.getElementById('narrative').textContent;
      App._drill = null; App._render();
      Budgets.set('total', null);
      return { undrilled, drilled };
    });
    ok('narrative: budget sentence qualifies scope when filtered',
      /across all platforms/i.test(scoped.drilled) && !/across all platforms/i.test(scoped.undrilled), JSON.stringify(scoped));

    // Plan 6 (v6-unpriced): the list-price sentence must disclose the share that is only a fallback-row guess
    const unp = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      App.filters.range = '30'; App._drill = null; App.filters.hiddenPlatforms = new Set();
      Store.setSource('anthropic', [{ d: '2026-08-10', platform: 'Anthropic API', model: 'claude-sonnet-5', in: 1_000_000, cw: 0, cr: 0, out: 0, msgs: 1 }], {});   // $2
      Store.setSource('codex', [{ d: '2026-08-10', platform: 'OpenAI Codex CLI', model: 'gpt-6-astra', in: 1_000_000, cw: 0, cr: 0, out: 0, msgs: 1 }], {});         // $3 at the fallback row
      App._render();
      const withUn = document.getElementById('narrative').textContent;
      delete Store.sources.codex;
      Store.setSource('ollama', [{ d: '2026-08-10', platform: 'Ollama', model: 'llama-mystery', in: 1_000_000, cw: 0, cr: 0, out: 0, msgs: 1 }], {});   // local: $0, not a guess
      App._render();
      const without = document.getElementById('narrative').textContent;
      Store.sources = {};
      return { withUn, without };
    });
    ok('narrative: list-price sentence discloses the fallback-guessed share',
      /worth about \$5\.00 at API list prices — \$3\.00 of that is guessed at the fallback rate for 1 unpriced model\./.test(unp.withUn), unp.withUn);
    ok('narrative: no fallback qualifier without unpriced rows (a local unknown model is $0, not a guess)',
      /worth about \$2\.00 at API list prices\./.test(unp.without) && !/guessed/.test(unp.without), unp.without);
  } finally {
    await page.close();
  }
}
