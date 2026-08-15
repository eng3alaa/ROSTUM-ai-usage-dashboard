import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const gem = await page.evaluate(async () => {
      window.fetchJSON = async (url) => {
        if (String(url).includes('generativelanguage')) return { models: [{ name: 'models/gemini-3.5-flash' }, { name: 'models/gemini-3-pro' }] };
        throw new Error('unexpected url ' + url);
      };
      document.getElementById('gemini-key').value = 'AIza-test';
      await App.fetchGemini();
      const st = Store.connectors.gemini;
      return { label: st && st.label, status: Store.connectorStatus(connectorById('gemini')), statusText: document.getElementById('gemini-status').textContent };
    });
    ok('gemini: key validates via models list, connector goes green',
      /2 models/.test(gem.label) && gem.status === 'ok' && /Connected/.test(gem.statusText), JSON.stringify(gem));

    const gemBad = await page.evaluate(async () => {
      window.fetchJSON = async () => { throw new Error('HTTP 400 — API key not valid'); };
      await App.fetchGemini();
      return { err: Store.connectors.gemini.err, status: Store.connectorStatus(connectorById('gemini')) };
    });
    ok('gemini: invalid key surfaces error + amber', /key not valid/i.test(gemBad.err) && gemBad.status === 'warn', JSON.stringify(gemBad));

    const cp = await page.evaluate(async () => {
      window.fetchJSON = async (url) => {
        const u = String(url);
        if (u.endsWith('/user')) return { login: 'alaa-dev' };
        if (u.includes('/settings/billing/usage')) return { usageItems: [
          { date: '2026-08-10', product: 'copilot', sku: 'copilot_premium_request', quantity: 14, netAmount: 0.56 },
          { date: '2026-08-11', product: 'copilot', sku: 'copilot_premium_request', quantity: 6, netAmount: 0.24 },
          { date: '2026-08-11', product: 'actions', sku: 'runner', quantity: 99, netAmount: 9.99 },
        ] };
        throw new Error('unexpected ' + u);
      };
      document.getElementById('copilot-key').value = 'github_pat_test';
      await App.fetchCopilot();
      const rows = Store.sources.copilot.rows;
      return { label: Store.connectors.copilot.label, n: rows.length,
        msgs: rows.reduce((a, r) => a + r.msgs, 0),
        billed: Store.billedRows('copilot').reduce((a, b) => a + b.amount, 0),
        platforms: [...new Set(rows.map(r => r.platform))] };
    });
    ok('copilot: PAT validates, only copilot items land, actions ignored',
      cp.label === 'alaa-dev' && cp.n === 2 && cp.msgs === 20 && Math.abs(cp.billed - 0.8) < 1e-9 &&
      cp.platforms.length === 1 && cp.platforms[0] === 'GitHub Copilot', JSON.stringify(cp));

    const cpNoUsage = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      window.fetchJSON = async (url) => {
        if (String(url).endsWith('/user')) return { login: 'alaa-dev' };
        throw new Error('HTTP 404');
      };
      await App.fetchCopilot();
      return { label: Store.connectors.copilot.label, err: Store.connectors.copilot.err || null,
        statusText: document.getElementById('copilot-status').textContent };
    });
    ok('copilot: usage endpoint missing degrades to validated-only, no error state',
      cpNoUsage.label === 'alaa-dev' && cpNoUsage.err === null && /no usage data|validated/i.test(cpNoUsage.statusText),
      JSON.stringify(cpNoUsage));
  } finally {
    await page.close();
  }
}
