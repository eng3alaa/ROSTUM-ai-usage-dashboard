import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);

  try {
    const winner = await page.evaluate(async () => {
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      const delayed = (ms, rows) => new Promise((r) => setTimeout(() =>
        r({ rows, billed: [] }), ms));
      const mkRow = (tag) => [{ d: '2026-08-12', platform: 'Anthropic API', model: tag, in: 1, cw: 0, cr: 0, out: 1, msgs: 1 }];
      document.getElementById('anthropic-key').value = 'sk-ant-admin-test';
      // OLD request resolves LAST (slow), NEW resolves first — new must win.
      let call = 0;
      window.fetchAnthropicAll = async () => (++call === 1 ? delayed(300, mkRow('OLD')) : delayed(10, mkRow('NEW')));
      const p1 = App.connectKey(connectorById('anthropic'));
      const p2 = App.connectKey(connectorById('anthropic'));
      await Promise.allSettled([p1, p2]);
      return Store.sources.anthropic.rows[0].model;
    });
    ok('race: superseded fetch cannot overwrite newer result', winner === 'NEW', winner);

    const staleFail = await page.evaluate(async () => {
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      const mkRow = (tag) => [{ d: '2026-08-12', platform: 'Anthropic API', model: tag, in: 1, cw: 0, cr: 0, out: 1, msgs: 1 }];
      document.getElementById('anthropic-key').value = 'sk-ant-admin-test';
      // OLD request REJECTS last (slow failure), NEW resolves successfully first — the stale
      // failure must not clobber the newer successful status/UI.
      let call = 0;
      window.fetchAnthropicAll = async () => {
        if (++call === 1) {
          await new Promise((r) => setTimeout(r, 300));
          throw new Error('simulated network failure');
        }
        await new Promise((r) => setTimeout(r, 10));
        return { rows: mkRow('NEW2'), billed: [] };
      };
      const p1 = App.connectKey(connectorById('anthropic'));
      const p2 = App.connectKey(connectorById('anthropic'));
      await Promise.allSettled([p1, p2]);
      await new Promise((r) => setTimeout(r, 400));   // let the late rejection land
      return {
        status: document.getElementById('anthropic-status').textContent,
        model: Store.sources.anthropic.rows[0].model,
      };
    });
    ok('race: stale failed fetch cannot overwrite newer status',
      !/failed/i.test(staleFail.status) && staleFail.model === 'NEW2',
      JSON.stringify(staleFail));

    // cost stubs use the REAL Anthropic cost_report shape: amount is a decimal string in CENTS ('4200' → $42) — proves the cents→dollars fix (object {value} amounts stay dollars)
    const importRace = await page.evaluate(async () => {
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      window.fetchAnthropicAll = () => new Promise((_, reject) =>
        setTimeout(() => reject(new Error('simulated slow network failure')), 200));
      document.getElementById('anthropic-key').value = 'sk-ant-admin-test';
      const p = App.connectKey(connectorById('anthropic'));
      await new Promise((r) => setTimeout(r, 10));
      await App.handleImportFiles([new File([JSON.stringify({
        data: [{ starting_at: '2026-08-02T00:00:00Z', results: [{ amount: '4200', currency: 'USD' }] }]
      })], 'cost.json')]);
      await Promise.allSettled([p]);
      await new Promise((r) => setTimeout(r, 300));   // let the late in-flight fetch settle
      const env = Store.billed.anthropic;
      return {
        stale: env ? env.stale : null,
        amount: (Store.billedRows('anthropic')[0] || {}).amount,
        status: document.getElementById('anthropic-status').textContent,
      };
    });
    ok('race: import during in-flight fetch stays fresh',
      importRace.stale === false && importRace.amount === 42 && !/failed/i.test(importRace.status),
      JSON.stringify(importRace));

    const softFail = await page.evaluate(async () => {
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = {} && []; Store.connectors = {};
      // import writes fresh billed data...
      await App.handleImportFiles([new File([JSON.stringify({ data: [{ starting_at: '2026-08-02T00:00:00Z', results: [{ amount: '4200', currency: 'USD' }] }] })], 'cost.json')]);
      // ...then an ALREADY-IN-FLIGHT fetch resolves with usage OK but cost=null (soft fail)
      window.fetchAnthropicAll = async () => { await new Promise(r => setTimeout(r, 150)); return { rows: [{ d: '2026-08-11', platform: 'Anthropic API', model: 'claude-sonnet-5', in: 1, cw: 0, cr: 0, out: 1, msgs: 1 }], billed: null }; };
      document.getElementById('anthropic-key').value = 'sk-ant-admin-test';
      const p = App.connectKey(connectorById('anthropic'));
      await new Promise(r => setTimeout(r, 10));
      App._gen.anthropic++;                                   // simulate a superseding action (import path bumps this)
      await Promise.allSettled([p]);
      const env = Store.billed.anthropic;
      return { stale: env.stale, amount: Store.billedRows('anthropic')[0].amount, statusText: document.getElementById('anthropic-status').textContent };
    });
    ok('race: soft-fail (cost=null) superseded fetch cannot stale-mark fresh import', softFail.stale === false && softFail.amount === 42, JSON.stringify(softFail));
    ok('race: superseded fetch does not leave status stuck at Fetching', !/Fetching/.test(softFail.statusText), softFail.statusText);
  } finally {
    await page.close();
  }
}
