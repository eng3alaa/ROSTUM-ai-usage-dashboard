import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  // Seed old-format billed data to prove migration
  const seed = {
    sources: { anthropic: { rows: [{ d: '2026-08-10', platform: 'Anthropic API', model: 'claude-sonnet-5', in: 10, cw: 0, cr: 0, out: 5, msgs: 1 }], meta: {} } },
    billed: { anthropic: [{ d: '2026-08-10', amount: 3.5 }] },   // v1 array format
    projects: [],
  };
  const { page } = await openDashboard(browser, { seedData: seed });
  try {
    const migrated = await page.evaluate(() => {
      const env = Store.billed.anthropic;
      return { isEnv: !!env && !Array.isArray(env) && Array.isArray(env.rows), rows: Store.billedRows('anthropic').length };
    });
    ok('billed: old array format migrates to envelope', migrated.isEnv && migrated.rows === 1, JSON.stringify(migrated));

    const staleFlow = await page.evaluate(async () => {
      // fetch succeeds for usage but cost fetch FAILS → old billed must be kept but marked stale
      window.fetchAnthropicAll = async () => ({ rows: [{ d: '2026-08-11', platform: 'Anthropic API', model: 'claude-sonnet-5', in: 1, cw: 0, cr: 0, out: 1, msgs: 1 }], billed: null });
      document.getElementById('anthropic-key').value = 'sk-ant-admin-test';
      await App.connectKey(connectorById('anthropic'));
      const env1 = Store.billed.anthropic;
      // now cost fetch returns a genuinely EMPTY window → billed becomes empty rows, not stale
      window.fetchAnthropicAll = async () => ({ rows: [], billed: [] });
      await App.connectKey(connectorById('anthropic'));
      const env2 = Store.billed.anthropic;
      return { stale1: env1.stale, rows1: env1.rows.length, stale2: env2.stale, rows2: env2.rows.length };
    });
    ok('billed: failed cost fetch keeps old rows but marks stale', staleFlow.stale1 === true && staleFlow.rows1 === 1, JSON.stringify(staleFlow));
    ok('billed: empty cost fetch clears rows and is not stale', staleFlow.stale2 === false && staleFlow.rows2 === 0, JSON.stringify(staleFlow));
  } finally {
    await page.close();
  }
}
