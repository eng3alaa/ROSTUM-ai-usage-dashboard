import { openDashboard } from '../lib/harness.mjs';

const ORDER = ['coding', 'chat', 'local', 'api', 'cloud'];

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const grp = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load(); App._hubQuery = '';
      App._render();
      const groups = [...document.querySelectorAll('#accounts-hub .hub-group')].map(g => g.dataset.group);
      const labels = [...document.querySelectorAll('#accounts-hub .hub-group h3')].map(h => h.textContent);
      const inGroup = (id) => document.querySelector(`#accounts-hub .acct[data-connector="${id}"]`).closest('.hub-group').dataset.group;
      return { groups, labels, local: inGroup('local'), copilot: inGroup('copilot'), anthropic: inGroup('anthropic'), imports: inGroup('imports'),
        every: CONNECTORS.every(c => !!c.category), n: document.querySelectorAll('#accounts-hub .acct').length, total: CONNECTORS.length };
    });
    ok('hub-groups: every registry entry has a category; cards render inside groups in spec order; empty groups omitted',
      grp.every && grp.n === grp.total && grp.local === 'coding' && grp.copilot === 'coding' && grp.anthropic === 'api' && grp.imports === 'chat' &&
      JSON.stringify(grp.groups) === JSON.stringify(ORDER.filter(g => grp.groups.includes(g))) &&
      grp.labels.includes('Coding tools') && grp.labels.includes('API vendors') && grp.labels.includes('Chat apps'), JSON.stringify(grp));

    const order = await page.evaluate(() => {
      Store.setConnector('openrouter', { label: 'k', lastSync: Date.now(), err: null });   // ok
      Store.setConnector('gemini', { err: 'bad key' });                                    // warn
      App._render();
      return { ids: [...document.querySelectorAll('#accounts-hub .hub-group[data-group="api"] .acct')].map(c => c.dataset.connector) };
    });
    ok('hub-groups: connected → attention → disconnected, then registry order',
      order.ids[0] === 'openrouter' && order.ids[1] === 'gemini' && order.ids.indexOf('anthropic') < order.ids.indexOf('openai'), JSON.stringify(order));

    const search = await page.evaluate(() => {
      Store.connectors = {}; App._render();
      const total = document.querySelectorAll('#accounts-hub .acct').length;
      const box = document.getElementById('hub-search');
      const ruleOk = box.hidden === !(total > 12);
      App._hubQuery = 'openrouter'; App.renderHub();
      const filtered = [...document.querySelectorAll('#accounts-hub .acct')].map(c => c.dataset.connector);
      const stillShown = box.hidden === !(total > 12);   // the rule counts un-hidden cards, not the query result
      App._hubQuery = ''; App.renderHub();
      return { total, ruleOk, filtered, stillShown, restored: document.querySelectorAll('#accounts-hub .acct').length };
    });
    ok('hub-groups: search box appears only when >12 cards are visible; query filters by name without hiding the box',
      search.ruleOk && search.stillShown && search.filtered.length === 1 && search.filtered[0] === 'openrouter' && search.restored === search.total, JSON.stringify(search));

    const gcol = await page.evaluate(() => {
      document.querySelector('#accounts-hub .hub-group[data-group="api"] .collapse-btn').click();
      const body = document.querySelector('#accounts-hub .hub-group[data-group="api"] .hub-group-body');
      const display = getComputedStyle(body).display;
      const pref = View.isCollapsed('hub:api');
      View.toggleCollapse('hub:api'); App.renderHub();
      return { display, pref, back: getComputedStyle(document.querySelector('#accounts-hub .hub-group[data-group="api"] .hub-group-body')).display };
    });
    ok('hub-groups: group header toggle collapses the group and persists in the View store', gcol.display === 'none' && gcol.pref === true && gcol.back !== 'none', JSON.stringify(gcol));

    const budgetRows = await page.evaluate(() => {
      Store.sources = {}; Store.connectors = {}; Budgets.limits = {}; LS.del('budgets');
      App.renderBudgets();
      const empty = document.querySelectorAll('#budget-editor .budget-row').length;
      Store.setConnector('openrouter', { label: 'k', lastSync: Date.now(), err: null });
      App.renderBudgets();
      const one = document.querySelectorAll('#budget-editor .budget-row').length;
      Store.connectors = {};
      return { empty, one };
    });
    ok('hub-groups: budget editor lists Total + only platforms that are connected, budgeted, or have data', budgetRows.empty === 1 && budgetRows.one === 2, JSON.stringify(budgetRows));
  } finally {
    await page.close();
  }
}
