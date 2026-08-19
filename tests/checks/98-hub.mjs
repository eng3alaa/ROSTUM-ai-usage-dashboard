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
        total: CONNECTORS.length,
        ids: cards.map(c => c.dataset.connector),
        dots: cards.map(c => c.querySelector('.dot')?.className || ''),
        allOff: cards.every(c => c.querySelector('.dot')?.classList.contains('off')),
      };
    });
    ok('hub: every registry card renders (baseline 7 ids present)', hub.n === hub.total &&
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

    const modal = await page.evaluate(async () => {
      document.querySelector('#accounts-hub .acct[data-connector="anthropic"] .acct-manage').click();
      const dlg = document.getElementById('connector-modal');
      const containsCard = !!dlg.querySelector('#src-anthropic');
      const isOpen = dlg.open;
      // dialog's 'close' event is fired via a QUEUED task (not synchronous with .close()) —
      // wait for the real event rather than guessing at a delay.
      const closed = new Promise(r => dlg.addEventListener('close', r, { once: true }));
      dlg.querySelector('.modal-close').click();
      await closed;
      const restored = !dlg.querySelector('#src-anthropic') && !!document.querySelector('#sources #src-anthropic');
      return { isOpen, containsCard, restored };
    });
    ok('hub: Manage opens the modal hosting the real source card, close restores it',
      modal.isOpen && modal.containsCard && modal.restored, JSON.stringify(modal));

    const brand = await page.evaluate(() => {
      const mark = document.querySelector('#accounts-hub .acct[data-connector="anthropic"] .mark');
      return { markBg: getComputedStyle(mark).backgroundColor };
    });
    ok('hub: brand accent custom property actually applies', brand.markBg === 'rgb(212, 162, 127)', JSON.stringify(brand));

    const escapeClose = await page.evaluate(async () => {
      // real repro: native dialog close() (the path Escape takes), NOT closeConnectorModal()
      const dlg = document.getElementById('connector-modal');
      App.openConnectorModal('anthropic');
      let closed = new Promise(r => dlg.addEventListener('close', r, { once: true }));
      dlg.close();
      await closed;
      const afterFirst = !!document.querySelector('#sources #src-anthropic');
      App.openConnectorModal('anthropic');
      closed = new Promise(r => dlg.addEventListener('close', r, { once: true }));
      dlg.close();
      await closed;
      const afterSecond = !!document.querySelector('#sources #src-anthropic');
      return { afterFirst, afterSecond };
    });
    ok('hub: Escape-close returns the card home (no orphan)',
      escapeClose.afterFirst && escapeClose.afterSecond, JSON.stringify(escapeClose));

    const drill = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      Store.setSource('openrouter', [{ d: dayKey(new Date()), platform: 'OpenRouter', model: 'x', in: 5, cw: 0, cr: 0, out: 5, msgs: 1 }], {});
      Store.setSource('csv', [{ d: dayKey(new Date()), platform: 'Gemini', model: 'y', in: 7, cw: 0, cr: 0, out: 7, msgs: 1 }], {});
      App.render();
      document.querySelector('#accounts-hub .acct[data-connector="openrouter"]').click();
      const rows = App.rowsIn(App.window());
      return { n: rows.length, all: rows.every(r => r.platform === 'OpenRouter') };
    });
    ok('hub: card click drills down to that platform only', drill.n === 1 && drill.all, JSON.stringify(drill));

    const undrill = await page.evaluate(() => {
      document.querySelector('#accounts-hub .acct[data-connector="openrouter"]').click();   // second click = undo
      return App.rowsIn(App.window()).length;
    });
    ok('hub: second click restores all platforms', undrill === 2, undrill);

    // I3(a): a connector with data but no state entry (e.g. state deleted by a
    // keep-data disconnect) must read as truly 'off', not fall back to 'ok' via
    // the data-freshness heuristic.
    const disconnectKeep = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      Store.setConnector('openrouter', { label: 'my-key', lastSync: Date.now() });
      Store.setSource('openrouter', [{ d: dayKey(new Date()), platform: 'OpenRouter', model: 'x', in: 500, cw: 0, cr: 0, out: 200, msgs: 3 }], {});
      window.confirm = () => false;   // Cancel = keep the data
      App.disconnectConnector('openrouter');   // its own render() is RAF-batched — wait for it to flush
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const card = document.querySelector('#accounts-hub .acct[data-connector="openrouter"]');
      return {
        dot: card.querySelector('.dot').className,
        manageText: card.querySelector('.acct-manage').textContent,
        stats: card.querySelector('.acct-stats').textContent,
        hasSource: !!Store.sources.openrouter,
      };
    });
    ok('hub: disconnect keep-data shows truly disconnected card',
      /\boff\b/.test(disconnectKeep.dot) && disconnectKeep.manageText === 'Connect' &&
      disconnectKeep.stats.length > 0 && disconnectKeep.hasSource,
      JSON.stringify(disconnectKeep));

    // I3(b): disconnecting 'local' with delete-data must clear Store.projects and
    // release the folder handle (memory + IDB) so a later refreshAll() can't silently
    // rescan the old folder and resurrect the deleted rows.
    const disconnectLocalDelete = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {};
      Store.projects = [{ project: 'proj1', model: 'claude-sonnet-5', msgs: 1, in: 1, cw: 0, cr: 0, out: 1 }];
      Store.setConnector('local', { label: '1 session', lastSync: Date.now() });
      Store.setSource('local', [{ d: dayKey(new Date()), platform: 'Claude Code/Desktop', model: 'claude-sonnet-5', in: 10, cw: 0, cr: 0, out: 10, msgs: 1, sid: 's1' }], {});
      // simulate an actively-held folder handle whose rescan() would resurrect data
      App.dirHandle = { queryPermission: async () => 'granted', requestPermission: async () => 'granted' };
      const origScanHandle = App.scanHandle;
      App.scanHandle = async () => {
        Store.setSource('local', [{ d: dayKey(new Date()), platform: 'Claude Code/Desktop', model: 'claude-sonnet-5', in: 999, cw: 0, cr: 0, out: 999, msgs: 1, sid: 's-resurrected' }], {});
      };
      window.confirm = () => true;   // OK = delete
      App.disconnectConnector('local');
      const dirHandleAfter = App.dirHandle;
      const projectsAfterDisconnect = Store.projects.length;
      await App.refreshAll();
      App.scanHandle = origScanHandle;
      return { dirHandleAfter, projectsAfterDisconnect, sourcesLocalAfterRefresh: !!Store.sources.local };
    });
    ok('hub: local delete-data clears projects and cannot resurrect',
      disconnectLocalDelete.dirHandleAfter === null && disconnectLocalDelete.projectsAfterDisconnect === 0 &&
      !disconnectLocalDelete.sourcesLocalAfterRefresh,
      JSON.stringify(disconnectLocalDelete));

    // I4: syncing a key-bearing connector with no usable key anywhere (not in the
    // input, not remembered in LS) must surface the connect modal instead of
    // silently calling the fetch method (which would just no-op or hit the network).
    const syncNoKey = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      LS.del('key:openrouter');
      const inp = document.getElementById('openrouter-key'); if (inp) inp.value = '';
      const dlg = document.getElementById('connector-modal');
      App.syncConnector('openrouter');
      const isOpen = dlg.open;
      dlg.close();
      return { isOpen };
    });
    ok('hub: sync without key opens the connect modal', syncNoKey.isOpen === true, JSON.stringify(syncNoKey));

    // I5: the accounts-hub 30d card stats must be independent of the global date
    // filter — a custom range in the past shouldn't blank out a card that has
    // genuinely-recent data.
    const filterIndep = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      Store.setConnector('openrouter', { label: 'my-key', lastSync: Date.now() });
      Store.setSource('openrouter', [{ d: dayKey(new Date()), platform: 'OpenRouter', model: 'x', in: 500, cw: 0, cr: 0, out: 200, msgs: 3 }], {});
      App.filters.range = 'custom';
      App.filters.from = '2020-01-01';
      App.filters.to = '2020-01-31';
      App.renderHub();   // synchronous — App.render() is RAF-batched and would read a stale DOM
      const card = document.querySelector('#accounts-hub .acct[data-connector="openrouter"]');
      const stats = card.querySelector('.acct-stats').textContent;
      App.filters.range = '30'; App.filters.from = null; App.filters.to = null;   // restore defaults
      return { stats };
    });
    ok('hub: card stats independent of the global date filter',
      /700|0\.0/.test(filterIndep.stats), JSON.stringify(filterIndep));

    // M8: an import batch that never actually lands anything (every file unparseable /
    // unrecognized / errored) must not fake a connected imports card.
    const failedImport = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      App.renderHub();
      const badFile = new File(['not valid json {{{'], 'bad.json', { type: 'application/json' });
      await App.handleImportFiles([badFile]);
      App.renderHub();
      const card = document.querySelector('#accounts-hub .acct[data-connector="imports"]');
      return {
        connectorsImports: Store.connectors.imports,
        dot: card.querySelector('.dot').className,
      };
    });
    ok('hub: failed import does not fake a connected imports card',
      failedImport.connectorsImports === undefined && /\boff\b/.test(failedImport.dot),
      JSON.stringify(failedImport));

    // hub search defects: (a) hiding cards while a query is typed hides the box (≤12 rule) —
    // the query must then be dropped, not silently keep filtering; (b) a query that matches
    // nothing renders an honest note (textContent) instead of a blank hub; (c) Enter on a
    // card's action button must not ALSO fire the card's drill-down.
    const hubSearch = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load(); App._hubQuery = '';
      App._render();
      const box = document.getElementById('hub-search');
      const total = document.querySelectorAll('#accounts-hub .acct').length;   // 17 registry cards → box shown
      const boxShownBefore = !box.hidden;
      box.value = 'e'; box.dispatchEvent(new Event('input', { bubbles: true }));
      const matched = [...document.querySelectorAll('#accounts-hub .acct')].map(c => c.dataset.connector);
      // hide 5 of the matching cards → 12 un-hidden → box hides → query must be dropped
      for (const id of matched.slice(0, 5)) View.hideCard(id);
      App._render();
      const afterHide = { boxHidden: box.hidden, boxValue: box.value, q: App._hubQuery, n: document.querySelectorAll('#accounts-hub .acct').length,
        unhidden: CONNECTORS.filter(c => !View.isCardHidden(c.id)).length, nomatch: !!document.querySelector('#accounts-hub .hub-nomatch') };
      // (b) restore all, query that matches nothing → note carries the query text
      View.showAllCards(); App._render();
      box.value = 'zzz'; box.dispatchEvent(new Event('input', { bubbles: true }));
      const note = document.querySelector('#accounts-hub .hub-nomatch');
      const noMatch = { n: document.querySelectorAll('#accounts-hub .acct').length, note: note ? note.textContent : null, boxHidden: box.hidden };
      box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true }));
      // (c) Enter on an action button
      const orig = App.drillDown; let drills = 0; App.drillDown = () => { drills++; };
      const btn = document.querySelector('#accounts-hub .acct[data-connector="anthropic"] .acct-manage');
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const card = document.querySelector('#accounts-hub .acct[data-connector="anthropic"]');
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));   // control: Enter on the card itself still drills
      App.drillDown = orig;
      const autocomplete = box.getAttribute('autocomplete');
      return { total, boxShownBefore, matched: matched.length, afterHide, noMatch, drills, autocomplete, restored: document.querySelectorAll('#accounts-hub .acct').length };
    });
    ok('hub: hiding cards down to ≤12 while a query is typed hides the box AND drops the query (all un-hidden cards render, no stale filter)',
      hubSearch.total === 17 && hubSearch.boxShownBefore && hubSearch.matched > 5 && hubSearch.matched < 17 &&
      hubSearch.afterHide.boxHidden && hubSearch.afterHide.unhidden === 12 && hubSearch.afterHide.n === 12 && hubSearch.afterHide.q === '' && hubSearch.afterHide.boxValue === '' && !hubSearch.afterHide.nomatch,
      JSON.stringify(hubSearch));
    ok('hub: a query matching nothing renders a "No accounts match" note carrying the query text (box stays visible; autocomplete off)',
      hubSearch.noMatch.n === 0 && /No accounts match/.test(hubSearch.noMatch.note || '') && /zzz/.test(hubSearch.noMatch.note || '') && !hubSearch.noMatch.boxHidden &&
      hubSearch.autocomplete === 'off' && hubSearch.restored === 17, JSON.stringify(hubSearch.noMatch));
    ok('hub: Enter on a card action button does not fire the card drill-down (Enter on the card itself still does)', hubSearch.drills === 1, JSON.stringify({ drills: hubSearch.drills }));
  } finally {
    await page.close();
  }
}
