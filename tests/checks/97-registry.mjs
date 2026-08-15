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

    const compacted = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      const rows = [];
      for (let i = 0; i < 12; i++) rows.push({ d: '2025-01-05', platform: 'Claude Code/Desktop', model: 'claude-sonnet-5', in: 10, cw: 0, cr: 0, out: 5, msgs: 1, sid: 'sess-' + i });
      rows.push({ d: dayKey(new Date()), platform: 'Claude Code/Desktop', model: 'claude-sonnet-5', in: 1, cw: 0, cr: 0, out: 1, msgs: 1, sid: 'sess-new' });
      Store.setSource('local', rows, {});
      const local = Store.sources.local.rows;
      const old = local.filter(r => r.d === '2025-01-05');
      const recent = local.filter(r => r.sid === 'sess-new');
      const t = old.reduce((a, r) => ({ in: a.in + r.in, msgs: a.msgs + r.msgs }), { in: 0, msgs: 0 });
      return { oldCount: old.length, oldHasSid: old.some(r => r.sid), recentHasSid: recent.length === 1 && !!recent[0].sid, in: t.in, msgs: t.msgs };
    });
    ok('compaction: rows older than 90d merge across sessions, totals exact',
      compacted.oldCount === 1 && !compacted.oldHasSid && compacted.in === 120 && compacted.msgs === 12,
      JSON.stringify(compacted));
    ok('compaction: recent rows keep their sid (dedupe still works)', compacted.recentHasSid, JSON.stringify(compacted));
  } finally {
    await page.close();
  }
}
