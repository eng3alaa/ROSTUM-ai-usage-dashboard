import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);

  try {
    const winner = await page.evaluate(async () => {
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      const delayed = (ms, rows) => new Promise((r) => setTimeout(() =>
        r({ usage: { rows }, cost: [] }), ms));
      const mkRow = (tag) => [{ d: '2026-08-12', platform: 'Anthropic API', model: tag, in: 1, cw: 0, cr: 0, out: 1, msgs: 1 }];
      document.getElementById('anthropic-key').value = 'sk-ant-admin-test';
      // OLD request resolves LAST (slow), NEW resolves first — new must win.
      let call = 0;
      window.fetchAnthropicAll = async () => (++call === 1 ? delayed(300, mkRow('OLD')) : delayed(10, mkRow('NEW')));
      const p1 = App.fetchAnthropic();
      const p2 = App.fetchAnthropic();
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
        return { usage: { rows: mkRow('NEW2') }, cost: [] };
      };
      const p1 = App.fetchAnthropic();
      const p2 = App.fetchAnthropic();
      await Promise.allSettled([p1, p2]);
      await new Promise((r) => setTimeout(r, 400));   // let the late rejection land
      return {
        status: document.getElementById('anthropic-status').textContent,
        model: Store.sources.anthropic.rows[0].model,
      };
    });
    ok('race: stale failed fetch cannot overwrite newer status',
      !staleFail.status.includes('Fetch failed') && staleFail.model === 'NEW2',
      JSON.stringify(staleFail));
  } finally {
    await page.close();
  }
}
