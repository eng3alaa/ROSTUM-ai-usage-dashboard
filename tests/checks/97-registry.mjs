import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const reg = await page.evaluate(() => ({
      isArray: Array.isArray(CONNECTORS),
      ids: CONNECTORS.map(c => c.id),
      platforms: CONNECTORS.map(c => c.platform).filter(Boolean),
      order: PLATFORM_ORDER,
      everyHasCard: CONNECTORS.every(c => !c.statusEl || !!document.getElementById(c.statusEl)),
    }));
    ok('registry: CONNECTORS table exists with the 7 connectors',
      reg.isArray && ['local','anthropic','openai','gemini','copilot','openrouter','imports']
        .every(id => reg.ids.includes(id)), JSON.stringify(reg.ids));
    ok('registry: PLATFORM_ORDER is derived from the registry',
      reg.platforms.every(p => reg.order.includes(p)) && reg.order[reg.order.length - 1] === 'Other',
      JSON.stringify(reg.order));
    ok('registry: every connector statusEl resolves to a live element', reg.everyHasCard, '');

    // subtitle + clear-data must iterate the registry, not hardcoded lists
    const wiring = await page.evaluate(() => {
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      Store.setSource('openrouter', [{ d: '2026-08-10', platform: 'OpenRouter', model: 'deepseek-v4', in: 5, cw: 0, cr: 0, out: 5, msgs: 1 }], {});
      App.renderSubtitle();
      const sub = document.getElementById('last-updated').textContent;
      return { sub };
    });
    ok('registry: subtitle names a NEW platform without hand-edits', /OpenRouter/.test(wiring.sub), wiring.sub);

    // refreshAll must fire every key-bearing connector's real fetch method, including
    // the fetchOpenAI (capital AI) casing that name-derivation from the id would miss.
    const refresh = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      let anthropicCalls = 0, openaiCalls = 0;
      window.fetchAnthropicAll = async () => { anthropicCalls++; return { usage: { rows: [] }, cost: [] }; };
      window.fetchOpenAIAll = async () => { openaiCalls++; return { usage: { rows: [] }, cost: [] }; };
      LS.set('key:anthropic', 'k');
      LS.set('key:openai', 'k');
      document.getElementById('anthropic-key').value = 'k';
      document.getElementById('openai-key').value = 'k';
      await App.refreshAll();
      return { anthropicCalls, openaiCalls };
    });
    ok('registry: refreshAll fires every key-bearing connector (incl. fetchOpenAI casing)',
      refresh.anthropicCalls === 1 && refresh.openaiCalls === 1, JSON.stringify(refresh));
  } finally {
    await page.close();
  }
}
