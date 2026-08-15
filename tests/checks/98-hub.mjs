import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const hub = await page.evaluate(async () => {
      // initial App.init() render is RAF-batched (see App.render()); let it settle before reading DOM
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const cards = [...document.querySelectorAll('#accounts-hub .acct')];
      return {
        n: cards.length,
        ids: cards.map(c => c.dataset.connector),
        dots: cards.map(c => c.querySelector('.dot')?.className || ''),
        allOff: cards.every(c => c.querySelector('.dot')?.classList.contains('off')),
      };
    });
    ok('hub: 7 account cards render from the registry', hub.n === 7 &&
      ['local','anthropic','openai','gemini','copilot','openrouter','imports'].every(id => hub.ids.includes(id)),
      JSON.stringify(hub.ids));
    ok('hub: all cards start disconnected (gray dot)', hub.allOff, JSON.stringify(hub.dots));

    const state = await page.evaluate(() => {
      Store.setConnector('openrouter', { label: 'my-key', lastSync: Date.now() });
      Store.setSource('openrouter', [{ d: dayKey(new Date()), platform: 'OpenRouter', model: 'deepseek-v4', in: 500, cw: 0, cr: 0, out: 200, msgs: 3 }], {});
      App.renderHub();
      const card = document.querySelector('#accounts-hub .acct[data-connector="openrouter"]');
      return {
        dot: card.querySelector('.dot').className,
        label: card.querySelector('.acct-label').textContent,
        stats: card.querySelector('.acct-stats').textContent,
      };
    });
    ok('hub: connected card shows green dot + label + 30d stats',
      /\bok\b/.test(state.dot) && /my-key/.test(state.label) && /700|0\.0/.test(state.stats),
      JSON.stringify(state));

    const stale = await page.evaluate(() => {
      Store.setConnector('openrouter', { label: 'my-key', lastSync: Date.now() - 8 * 864e5 });
      App.renderHub();
      return document.querySelector('#accounts-hub .acct[data-connector="openrouter"] .dot').className;
    });
    ok('hub: data older than 7 days turns the dot amber', /\bwarn\b/.test(stale), stale);

    const modal = await page.evaluate(() => {
      document.querySelector('#accounts-hub .acct[data-connector="anthropic"] .acct-manage').click();
      const dlg = document.getElementById('connector-modal');
      const containsCard = !!dlg.querySelector('#src-anthropic');
      const isOpen = dlg.open;
      dlg.querySelector('.modal-close').click();
      const restored = !dlg.querySelector('#src-anthropic') && !!document.querySelector('#sources #src-anthropic');
      return { isOpen, containsCard, restored };
    });
    ok('hub: Manage opens the modal hosting the real source card, close restores it',
      modal.isOpen && modal.containsCard && modal.restored, JSON.stringify(modal));
  } finally {
    await page.close();
  }
}
