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
      const total = document.querySelectorAll('#accounts-hub .acct').length;   // every registry card (17 in 4a, ~46 in 4b) → box shown
      const boxShownBefore = !box.hidden;
      box.value = 'e'; box.dispatchEvent(new Event('input', { bubbles: true }));
      const matched = [...document.querySelectorAll('#accounts-hub .acct')].map(c => c.dataset.connector);
      // hide cards (matching ones first) until exactly 12 are un-hidden → box hides → query must be dropped
      const toHide = [...matched, ...CONNECTORS.map(c => c.id).filter(id => !matched.includes(id))].slice(0, total - 12);
      for (const id of toHide) View.hideCard(id);
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
      return { total, registry: CONNECTORS.length, boxShownBefore, matched: matched.length, afterHide, noMatch, drills, autocomplete, restored: document.querySelectorAll('#accounts-hub .acct').length };
    });
    ok('hub: hiding cards down to ≤12 while a query is typed hides the box AND drops the query (all un-hidden cards render, no stale filter)',
      hubSearch.total === hubSearch.registry && hubSearch.total > 12 && hubSearch.boxShownBefore && hubSearch.matched > 0 && hubSearch.matched < hubSearch.total &&
      hubSearch.afterHide.boxHidden && hubSearch.afterHide.unhidden === 12 && hubSearch.afterHide.n === 12 && hubSearch.afterHide.q === '' && hubSearch.afterHide.boxValue === '' && !hubSearch.afterHide.nomatch,
      JSON.stringify(hubSearch));
    ok('hub: a query matching nothing renders a "No accounts match" note carrying the query text (box stays visible; autocomplete off)',
      hubSearch.noMatch.n === 0 && /No accounts match/.test(hubSearch.noMatch.note || '') && /zzz/.test(hubSearch.noMatch.note || '') && !hubSearch.noMatch.boxHidden &&
      hubSearch.autocomplete === 'off' && hubSearch.restored === hubSearch.total, JSON.stringify(hubSearch.noMatch));
    ok('hub: Enter on a card action button does not fire the card drill-down (Enter on the card itself still does)', hubSearch.drills === 1, JSON.stringify({ drills: hubSearch.drills }));
    // 4b T1: link-only cards — off dot, reason as the label, Details + vendor usage link only (no Connect/Sync/Disconnect),
    // Details opens the modal hosting the generic source card (reason + links), ✕ hides / chip restores, sync is a no-op
    const lo = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load(); App._hubQuery = ''; document.getElementById('hub-search').value = '';
      App._render();
      const c = connectorById('replicate');
      const card = document.querySelector('#accounts-hub .acct[data-connector="replicate"]');
      const btns = [...card.querySelectorAll('.acct-actions button')].map(b => b.textContent);
      const usage = card.querySelector('.acct-actions a');
      const ui = { dot: card.querySelector('.dot').className, label: card.querySelector('.acct-label').textContent, btns, sync: !!card.querySelector('.acct-sync-btn'),
        usageHref: usage && usage.getAttribute('href'), usageRel: usage && usage.getAttribute('rel'), group: card.closest('.hub-group').dataset.group, cls: card.className,
        aria: card.getAttribute('aria-label'), reasonOnCard: card.querySelector('.acct-label').textContent === c.reason, hide: !!card.querySelector('.acct-hide'),
        groups: { amazonq: document.querySelector('#accounts-hub .acct[data-connector="amazonq"]').closest('.hub-group').dataset.group,
                  windsurf: document.querySelector('#accounts-hub .acct[data-connector="windsurf"]').closest('.hub-group').dataset.group } };
      // Details → modal hosts the generic source card with the reason + links; close → card goes home hidden (it is never connected)
      const dlg = document.getElementById('connector-modal');
      card.querySelector('.acct-manage').click();
      const src = dlg.querySelector('#src-replicate');
      const modal = { open: dlg.open, has: !!src, reason: !!src && src.textContent.includes(c.reason), usageLink: !!src && !!src.querySelector('a[href="' + c.links.usage + '"]'),
        statusText: document.getElementById('replicate-status').textContent, badge: src && src.querySelector('.badge').textContent };
      const closed = new Promise(r => dlg.addEventListener('close', r, { once: true }));
      dlg.close(); await closed;
      const home = document.querySelector('#sources #src-replicate');
      const after = { home: !!home, hidden: !!home && home.hidden, status: Store.connectorStatus(c), noState: Store.connectors.replicate === undefined };
      // ✕ hides the card; the "N hidden — show" chip restores it
      card.querySelector('.acct-hide').click(); App._render();
      const gone = !document.querySelector('#accounts-hub .acct[data-connector="replicate"]');
      const chip = document.querySelector('#hub-chips .hub-hidden-chip');
      const chipText = chip && chip.textContent;
      if (chip) chip.click(); App._render();
      const back = !!document.querySelector('#accounts-hub .acct[data-connector="replicate"]');
      // sync is a no-op for link-only (unreachable from the UI; guard the API): returns undefined, opens nothing, creates no state
      const r = App.syncConnector('replicate');
      const syncNoop = r === undefined && !dlg.open && Store.connectors.replicate === undefined;
      return { ui, modal, after, gone, chipText, back, syncNoop };
    });
    ok('link-only: card shows off dot, reason as label, Details + vendor usage link only (no Connect/Sync/Disconnect); Amazon Q + Windsurf in Coding tools, Replicate in API vendors',
      /\boff\b/.test(lo.ui.dot) && lo.ui.reasonOnCard && JSON.stringify(lo.ui.btns) === JSON.stringify(['Details']) && !lo.ui.sync && lo.ui.hide &&
      lo.ui.usageHref === 'https://replicate.com/account/billing' && lo.ui.usageRel === 'noopener' && /link-only/.test(lo.ui.cls) && /no data path/.test(lo.ui.aria) &&
      lo.ui.group === 'api' && lo.ui.groups.amazonq === 'coding' && lo.ui.groups.windsurf === 'coding', JSON.stringify(lo.ui));
    ok('link-only: Details opens the modal hosting the generic card (no-data badge, reason, usage link, "No data path" status); close hides it again; sync is a no-op',
      lo.modal.open && lo.modal.has && lo.modal.reason && lo.modal.usageLink && /no data path/i.test(lo.modal.statusText) && lo.modal.badge === 'no data' &&
      lo.after.home && lo.after.hidden && lo.after.status === 'off' && lo.after.noState && lo.syncNoop, JSON.stringify({ modal: lo.modal, after: lo.after, syncNoop: lo.syncNoop }));
    ok('link-only: ✕ hides the card and the hidden chip restores it', lo.gone && /^1 hidden — show$/.test(lo.chipText || '') && lo.back, JSON.stringify({ gone: lo.gone, chipText: lo.chipText, back: lo.back }));
    // Plan 4b T13: export-file cards — Manage + "Import file…" (opens the Imports modal), no Sync / Disconnect (the data belongs to Imports);
    // status follows the source rows (no connector entry is ever written); the card's own generic card stays revealed after Manage closes.
    const exp = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load(); App._hubQuery = '';
      App._render();
      const c = connectorById('grok');
      const card = () => document.querySelector('#accounts-hub .acct[data-connector="grok"]');
      const btns = () => [...card().querySelectorAll('.acct-actions button')].map(b => b.textContent);
      const dlg = document.getElementById('connector-modal');
      const before = { status: Store.connectorStatus(c), dot: card().querySelector('.dot').className, btns: btns(), label: card().querySelector('.acct-label').textContent,
        group: !!document.querySelector('#accounts-hub .hub-group[data-group="chat"] .acct[data-connector="grok"]'), srcHidden: document.getElementById('src-grok').hidden, statusText: document.getElementById('grok-status').textContent };
      card().querySelector('.acct-import-btn').click();
      const opened = { open: dlg.open, hostsImports: !!dlg.querySelector('#src-import'), title: document.getElementById('modal-title').textContent, hint: document.getElementById('import-status').textContent };
      let closed = new Promise(r => dlg.addEventListener('close', r, { once: true })); dlg.close(); await closed;
      Store.setSource('grok-export', [{ d: dayKey(new Date()), platform: 'Grok', model: 'grok', in: 100, cw: 0, cr: 0, out: 50, msgs: 2, est: 1 }], { msgs: 2 });
      App._render();
      const after = { status: Store.connectorStatus(c), dot: card().querySelector('.dot').className, btns: btns(), label: card().querySelector('.acct-label').textContent, sync: card().querySelector('.acct-sync').textContent,
        stats: card().querySelector('.acct-stats').textContent, noEntry: Store.connectors.grok === undefined, srcRevealed: !document.getElementById('src-grok').hidden, statusText: document.getElementById('grok-status').textContent };
      card().querySelector('.acct-manage').click();
      const manage = { open: dlg.open, hostsOwn: !!dlg.querySelector('#src-grok'), importBtn: !!dlg.querySelector('#grok-import'), badge: (dlg.querySelector('#src-grok .badge') || {}).textContent };
      closed = new Promise(r => dlg.addEventListener('close', r, { once: true })); dlg.close(); await closed;
      const afterManage = { srcStillRevealed: !document.getElementById('src-grok').hidden };
      App.syncConnector('grok');   // export-file: no network, no error — opens Imports
      const sync = { open: dlg.open, hostsImports: !!dlg.querySelector('#src-import') };
      closed = new Promise(r => dlg.addEventListener('close', r, { once: true })); dlg.close(); await closed;
      const kinds = CONNECTORS.filter(x => x.kind === 'export-file').map(x => [x.id, x.platform, x.category, x.quality, x.srcIds.join('|')]);
      const copyOk = CONNECTORS.filter(x => x.kind === 'export-file').every(x => /^Estimated/.test(x.qualityNote) && /export/i.test(x.qualityNote) && !!x.links && !!x.paths && !!x.hint && document.getElementById(x.statusEl));
      Store.sources = {}; Store.persist(); App._render();
      return { before, opened, after, manage, afterManage, sync, kinds, copyOk };
    });
    ok('hub: export-file card starts off (gray, "No export imported yet", Manage + Import file… only, in Chat apps, source card hidden); Import file… opens the Imports modal with a hint naming the platform',
      exp.before.status === 'off' && /\boff\b/.test(exp.before.dot) && JSON.stringify(exp.before.btns) === JSON.stringify(['Manage', 'Import file…']) && exp.before.label === 'No export imported yet' && exp.before.group && exp.before.srcHidden && /No export imported yet/.test(exp.before.statusText)
      && exp.opened.open && exp.opened.hostsImports && exp.opened.title === 'Imports' && /Grok/.test(exp.opened.hint), JSON.stringify({ before: exp.before, opened: exp.opened }));
    ok('hub: rows under the card\'s srcId → ok (green, "from your data export", Imported <time>, 30d stats) with NO connector entry, still no Sync/Disconnect; source card revealed with "Imported … 2 messages" and stays revealed after Manage closes; Sync routes to Imports',
      exp.after.status === 'ok' && /\bok\b/.test(exp.after.dot) && JSON.stringify(exp.after.btns) === JSON.stringify(['Manage', 'Import file…']) && exp.after.label === 'from your data export' && /^Imported /.test(exp.after.sync) && /150/.test(exp.after.stats) && exp.after.noEntry
      && exp.after.srcRevealed && /Imported/.test(exp.after.statusText) && /2 messages/.test(exp.after.statusText) && exp.manage.open && exp.manage.hostsOwn && exp.manage.importBtn && /estimated/.test(exp.manage.badge || '') && exp.afterManage.srcStillRevealed
      && exp.sync.open && exp.sync.hostsImports, JSON.stringify({ after: exp.after, manage: exp.manage, afterManage: exp.afterManage, sync: exp.sync }));
    ok('hub: the seven export-file cards (ChatGPT, Claude.ai, Grok, Microsoft Copilot, Perplexity, Meta AI, DeepSeek chat) are chat / estimated, copy is quality-first and export-based, each has links, paths, hint and a live status element',
      JSON.stringify(exp.kinds) === JSON.stringify([['chatgpt-app', 'ChatGPT', 'chat', 'estimated', 'chatgpt'], ['claudeai-app', 'Claude.ai', 'chat', 'estimated', 'claudeai'], ['grok', 'Grok', 'chat', 'estimated', 'grok-export'], ['mscopilot', 'Microsoft Copilot', 'chat', 'estimated', 'copilot-activity-csv'],
        ['perplexity', 'Perplexity', 'chat', 'estimated', 'perplexity-export'], ['meta-ai', 'Meta AI', 'chat', 'estimated', 'meta-ai-export'], ['deepseek-chat', 'DeepSeek chat', 'chat', 'estimated', 'deepseek-chat-export']]) && exp.copyOk, JSON.stringify(exp.kinds));
    // fix (modal): the in-modal "Import file…" of an export-file card switches the modal to Imports — the export card goes home first
    // (re-hidden while off), the Imports card is hosted alone, and close leaves #modal-body empty (no orphan, no stacked cards)
    const stack = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load(); App._hubQuery = '';
      App._render();
      const dlg = document.getElementById('connector-modal'), body = document.getElementById('modal-body');
      document.querySelector('#accounts-hub .acct[data-connector="grok"] .acct-manage').click();
      const manage = { open: dlg.open, hostsGrok: !!dlg.querySelector('#src-grok'), n: body.children.length };
      document.getElementById('grok-import').click();   // in-modal Import file… → openImportsFor → openConnectorModal('imports') while the dialog is open
      const switched = { open: dlg.open, hostsImports: !!dlg.querySelector('#src-import'), hostsGrok: !!dlg.querySelector('#src-grok'), n: body.children.length, title: document.getElementById('modal-title').textContent,
        grokHome: !!document.querySelector('#sources #src-grok'), grokHidden: !!document.getElementById('src-grok').hidden };
      const closed = new Promise(r => dlg.addEventListener('close', r, { once: true })); dlg.close(); await closed;
      const after = { open: dlg.open, n: body.children.length, importHome: !!document.querySelector('#sources #src-import'), grokHome: !!document.querySelector('#sources #src-grok') };
      return { manage, switched, after };
    });
    ok('hub: in-modal "Import file…" on an export-file card swaps the modal to Imports (export card home + hidden, one card hosted, dialog stays open); close sends Imports home and leaves #modal-body empty',
      stack.manage.open && stack.manage.hostsGrok && stack.manage.n === 1 && stack.switched.open && stack.switched.hostsImports && !stack.switched.hostsGrok && stack.switched.n === 1 && stack.switched.title === 'Imports'
      && stack.switched.grokHome && stack.switched.grokHidden && !stack.after.open && stack.after.n === 0 && stack.after.importHome && stack.after.grokHome, JSON.stringify(stack));
    // fix (status line): an entry that appears without a connectKey / scan run in this page (restored from storage on reload; DeepSeek connected
    // by its usage ZIP alone) reveals the source card as connected — its own status line must not keep saying "Not connected."
    const restored = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load(); App._hubQuery = '';
      App._render();
      const g = document.getElementById('groq-status'), d = document.getElementById('deepseek-status');
      const before = { groq: g.textContent, deepseek: d.textContent, groqHidden: document.getElementById('src-groq').hidden };
      const at = (() => { const d = new Date(Date.now() - 2 * 864e5); d.setHours(9, 5, 0, 0); return d.getTime(); })();   // two days ago, 9:05 local — inside connectorStatus's 7-day 'ok' window whenever the suite runs (a fixed date went 'warn' after 7 days)
      const synced = new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });   // the status line's own format
      Store.connectors.groq = { label: 'API key · last 4: abcd', lastSync: at, err: null };   // restored entry: no fetch ran in this page
      Store.setConnector('deepseek', { label: 'usage export (no key)', lastSync: at });      // the landDeepSeek path (ZIP-only, no key)
      App._render();
      const after = { groq: g.textContent, deepseek: d.textContent, groqHidden: document.getElementById('src-groq').hidden, groqOk: !!g.querySelector('.ok'), deepseekOk: !!d.querySelector('.ok'),
        groqDot: document.querySelector('#accounts-hub .acct[data-connector="groq"] .dot').className };
      // dataset.gen guard: a line an in-flight fetch owns is never rewritten
      Store.connectors.openrouter = { label: 'k', lastSync: at, err: null };
      const o = document.getElementById('openrouter-status'); o.textContent = 'Not connected.'; o.dataset.gen = '7';
      App._render();
      const guarded = o.textContent; o.dataset.gen = '';
      Store.connectors = {}; Store.persist(); App._render();
      return { before, after, guarded, synced };
    });
    ok('hub: a key-driver card revealed by a restored entry (no connectKey run) gets a state-derived status line ("● Connected (stored data) · synced <time>"); DeepSeek via its usage ZIP reads "usage export imported — key optional"; an in-flight line (dataset.gen) is left alone',
      restored.before.groq === 'Not connected.' && restored.before.groqHidden && !restored.after.groqHidden && /\bok\b/.test(restored.after.groqDot) && restored.after.groqOk && restored.after.deepseekOk
      && restored.after.groq === '● Connected (stored data) · synced ' + restored.synced && /usage export imported — key optional/.test(restored.after.deepseek) && !/Not connected/.test(restored.after.deepseek)
      && restored.guarded === 'Not connected.', JSON.stringify(restored));
    // ---- Plan 4b: the hub at ~46 cards ----
    const big = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load(); App._hubQuery = '';
      App._render();
      const total = CONNECTORS.length;
      const box = document.getElementById('hub-search');
      const groups = [...document.querySelectorAll('#accounts-hub .hub-group')].map(g => g.dataset.group);
      const counts = Object.fromEntries(groups.map(g => [g, document.querySelectorAll(`#accounts-hub .hub-group[data-group="${g}"] .acct`).length]));
      // perf: average of 5 synchronous renderHub() calls with every card present
      let t = 0; for (let i = 0; i < 5; i++) { const a = performance.now(); App.renderHub(); t += performance.now() - a; }
      const avgMs = t / 5;
      // hidden chip counts: hide 3 cards → "3 hidden — show"; the chip is a <button>, so Enter = click → all restored (App.render is rAF-batched)
      const ids = CONNECTORS.slice(-3).map(c => c.id);
      ids.forEach(id => View.hideCard(id)); App.renderHub();
      const chip = document.querySelector('#hub-chips .hub-hidden-chip');
      const chipText = chip ? chip.textContent : null;
      const nAfterHide = document.querySelectorAll('#accounts-hub .acct').length;
      chip.focus(); chip.click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const nAfterShow = document.querySelectorAll('#accounts-hub .acct').length;
      const chipGone = !document.querySelector('#hub-chips .hub-hidden-chip');
      // keyboard: every card is a focusable button (tabindex=0, role=button); Enter on a data card drills into its platform
      const cards = [...document.querySelectorAll('#accounts-hub .acct')];
      const focusable = cards.length === total && cards.every(c => c.tabIndex === 0 && c.getAttribute('role') === 'button');
      const dataCard = CONNECTORS.find(c => c.platform && c.kind !== 'link-only' && c.kind !== 'export-file' && c.kind !== 'files');
      const el2 = document.querySelector(`#accounts-hub .acct[data-connector="${dataCard.id}"]`);
      el2.focus(); el2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const drilled = App._drill === dataCard.platform;
      App._drill = null; App._render();
      return { total, boxShown: !box.hidden, groups, counts, avgMs, chipText, nAfterHide, nAfterShow, chipGone, focusable, drilled };
    });
    ok('hub (4b): ~46 registry cards → search box visible; groups render in spec order and all five are non-empty',
      big.total >= 46 && big.boxShown && JSON.stringify(big.groups) === JSON.stringify(['coding', 'chat', 'local', 'api', 'cloud']) && Object.values(big.counts).every(n => n > 0), JSON.stringify(big));
    ok('hub (4b): renderHub() averages under 60 ms with every card present (5 runs)', big.avgMs < 60, big.avgMs.toFixed(1) + ' ms');
    ok('hub (4b): hidden chip counts ("3 hidden — show"); Enter/click on the chip restores every card; all cards are keyboard-focusable buttons and Enter drills into a data card\'s platform',
      big.chipText === '3 hidden — show' && big.nAfterHide === big.total - 3 && big.nAfterShow === big.total && big.chipGone && big.focusable && big.drilled, JSON.stringify(big));

    // ---- Plan 4b: budgets editor lists Wave 2 platforms once data exists (registry-derived, once per platform) ----
    const bud = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = []; Budgets.limits = {}; LS.del('budgets');
      const fw = CONNECTORS.find(c => c.platform === 'Fireworks AI'), la = CONNECTORS.find(c => c.platform === 'LocalAI');
      App.renderBudgets();
      const before = [...document.querySelectorAll('#budget-editor .budget-row')].map(r => r.dataset.platform);
      Store.setSource(fw.id, [{ d: dayKey(new Date()), platform: 'Fireworks AI', model: 'accounts/fireworks/models/llama-v3p1-70b-instruct', in: 1000, cw: 0, cr: 0, out: 100, msgs: 1 }], {});
      Store.setSource(la.id, [{ d: dayKey(new Date()), platform: 'LocalAI', model: 'qwen3', in: 1000, cw: 0, cr: 0, out: 100, msgs: 1 }], {});
      App.renderBudgets();
      const after = [...document.querySelectorAll('#budget-editor .budget-row')].map(r => r.dataset.platform);
      Store.sources = {}; Store.persist(); App.renderBudgets();
      return { before, after, fwOnce: after.filter(p => p === 'Fireworks AI').length, laOnce: after.filter(p => p === 'LocalAI').length };
    });
    ok('budgets (4b): the editor lists a Wave 2 platform once data exists (Fireworks AI, LocalAI) — once per platform, and not before',
      !bud.before.includes('Fireworks AI') && !bud.before.includes('LocalAI') && bud.fwOnce === 1 && bud.laOnce === 1, JSON.stringify(bud));
    // v5 T6: keyboard focus survives hub re-renders (today it lands on <body>): ✕ hide → the next visible card in DOM order (the previous
    // one when the hidden card was last; the "N hidden — show" chip when none is left); a group collapse toggle → that group's toggle
    // again (re-queried after the re-render); the hidden chip → the first restored card in DOM order; modal close → the Manage button
    // of the card that opened it, re-queried by data-connector after a render while the modal was open replaced the hub's nodes.
    const focus = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load(); App._hubQuery = ''; document.getElementById('hub-search').value = '';
      App._render();
      const settle = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const cards = () => [...document.querySelectorAll('#accounts-hub .acct')];
      const active = () => { const a = document.activeElement; const g = a && a.closest && a.closest('.hub-group'); return { tag: a ? a.tagName : null, cls: a ? String(a.className) : null, id: a && a.dataset ? a.dataset.connector : undefined, card: a && a.closest ? ((a.closest('.acct') || {}).dataset || {}).connector : undefined, group: g ? g.dataset.group : undefined, expanded: a ? a.getAttribute('aria-expanded') : null }; };
      const all = cards().map(c => c.dataset.connector);
      // (a) ✕ on the first card → the card that followed it (now first); on the last card → the previous one; on the only card → the chip
      let btn = cards()[0].querySelector('.acct-hide'); btn.focus(); btn.click(); await settle();
      const hideFirst = { expect: all[1], got: active() };
      const prev = cards()[cards().length - 2].dataset.connector;
      btn = cards()[cards().length - 1].querySelector('.acct-hide'); btn.focus(); btn.click(); await settle();
      const hideLast = { expect: prev, got: active() };
      for (const id of cards().slice(1).map(c => c.dataset.connector)) View.hideCard(id);
      App._render();
      const nOnly = cards().length;
      btn = cards()[0].querySelector('.acct-hide'); btn.focus(); btn.click(); await settle();
      const hideOnly = { nBefore: nOnly, n: cards().length, chipText: (document.querySelector('#hub-chips .hub-hidden-chip') || {}).textContent, got: active() };
      // (c) hidden chip → the first restored card in DOM order (two cards hidden out of order; neither is the first card)
      View.showAllCards(); App._render();
      View.hideCard(all[4]); View.hideCard(all[2]); App._render();
      let chip = document.querySelector('#hub-chips .hub-hidden-chip'); chip.focus(); chip.click(); await settle();
      const restore = { expect: all[2], n: cards().length, got: active() };
      // (b) group collapse toggle → the same group's (re-rendered) toggle, collapsed then expanded again
      let tg = document.querySelector('#accounts-hub .hub-group[data-group="chat"] .collapse-btn'); tg.focus(); tg.click(); await settle();
      const collapse = { got: active(), fresh: document.activeElement !== tg, collapsed: View.isCollapsed('hub:chat') };
      tg = document.querySelector('#accounts-hub .hub-group[data-group="chat"] .collapse-btn'); tg.focus(); tg.click(); await settle();
      const expand = { got: active(), fresh: document.activeElement !== tg, collapsed: View.isCollapsed('hub:chat') };
      // (d) modal close → the opener card's Manage button, re-queried after a render while the modal was open replaced the hub nodes
      const dlg = document.getElementById('connector-modal');
      let m = document.querySelector('#accounts-hub .acct[data-connector="anthropic"] .acct-manage'); m.focus(); m.click();
      App._render();   // e.g. a connectKey / sync while the dialog is open — the button that opened it is detached now
      let closed = new Promise(r => dlg.addEventListener('close', r, { once: true })); dlg.close(); await closed; await settle();
      const modal = { open: dlg.open, got: active(), fresh: document.activeElement !== m, text: (document.activeElement && document.activeElement.textContent || '').slice(0, 40) };
      // (d') an export-file card's "Import file…" opens the Imports modal — close returns to THAT card's Manage button, not to the Imports card
      let ib = document.querySelector('#accounts-hub .acct[data-connector="grok"] .acct-import-btn'); ib.focus(); ib.click();
      const importsOpen = { open: dlg.open, hostsImports: !!dlg.querySelector('#src-import') };
      App._render();
      closed = new Promise(r => dlg.addEventListener('close', r, { once: true })); dlg.close(); await closed; await settle();
      const importClose = { got: active() };
      // (d'') the opener card was hidden while the modal was open → nothing to focus, nothing thrown (focus stays on <body>)
      let err = null;
      try {
        m = document.querySelector('#accounts-hub .acct[data-connector="anthropic"] .acct-manage'); m.focus(); m.click();
        View.hideCard('anthropic'); App._render();
        closed = new Promise(r => dlg.addEventListener('close', r, { once: true })); dlg.close(); await closed; await settle();
      } catch (e) { err = String(e); }
      const gone = { err, got: active() };
      View.showAllCards(); App._render();
      return { all: all.length, hideFirst, hideLast, hideOnly, restore, collapse, expand, modal, importsOpen, importClose, gone };
    });
    const isCard = (g, id) => g.tag === 'DIV' && /\bacct\b/.test(g.cls) && g.id === id;
    ok('focus (v5 T6): ✕ hide moves keyboard focus to the next visible card (previous when it was the last card; the hidden chip when none is left)',
      focus.all > 5 && isCard(focus.hideFirst.got, focus.hideFirst.expect) && isCard(focus.hideLast.got, focus.hideLast.expect)
      && focus.hideOnly.nBefore === 1 && focus.hideOnly.n === 0 && /hub-hidden-chip/.test(focus.hideOnly.got.cls || '') && /hidden — show/.test(focus.hideOnly.chipText || ''),
      JSON.stringify({ hideFirst: focus.hideFirst, hideLast: focus.hideLast, hideOnly: focus.hideOnly }));
    ok('focus (v5 T6): the hidden chip restore focuses the first restored card in DOM order; a group collapse / expand toggle keeps focus on that group\'s (re-rendered) toggle',
      focus.restore.n === focus.all && isCard(focus.restore.got, focus.restore.expect)
      && /collapse-btn/.test(focus.collapse.got.cls || '') && focus.collapse.got.group === 'chat' && focus.collapse.got.expanded === 'false' && focus.collapse.fresh && focus.collapse.collapsed
      && /collapse-btn/.test(focus.expand.got.cls || '') && focus.expand.got.group === 'chat' && focus.expand.got.expanded === 'true' && focus.expand.fresh && !focus.expand.collapsed,
      JSON.stringify({ restore: focus.restore, collapse: focus.collapse, expand: focus.expand }));
    ok('focus (v5 T6): modal close returns focus to the opener card\'s Manage button (re-queried after a render while open); Import file… → Imports modal → close returns to the export-file card; a hidden opener throws nothing',
      !focus.modal.open && /acct-manage/.test(focus.modal.got.cls || '') && focus.modal.got.card === 'anthropic' && focus.modal.fresh && focus.modal.text === 'Connect'
      && focus.importsOpen.open && focus.importsOpen.hostsImports && /acct-manage/.test(focus.importClose.got.cls || '') && focus.importClose.got.card === 'grok'
      && focus.gone.err === null && focus.gone.got.tag === 'BODY',
      JSON.stringify({ modal: focus.modal, importsOpen: focus.importsOpen, importClose: focus.importClose, gone: focus.gone }));
    // Plan 5 review m3: the hidden chip's restore focus skips cards inside a collapsed group (display:none cannot take focus — the old pick
    // landed on <body>): the first restored card that is visible, else the first visible card in the hub
    const chipFocus = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load(); App._hubQuery = ''; document.getElementById('hub-search').value = '';
      App._render();
      const settle = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const idsIn = (g) => [...document.querySelectorAll('#accounts-hub .hub-group[data-group="' + g + '"] .acct')].map(c => c.dataset.connector);
      const vis = () => [...document.querySelectorAll('#accounts-hub .acct')].filter(c => !c.closest('.sec-collapsed'));
      const active = () => { const a = document.activeElement; return { tag: a ? a.tagName : null, id: a && a.dataset ? a.dataset.connector : undefined, isCard: !!(a && a.classList && a.classList.contains('acct')), collapsed: !!(a && a.closest && a.closest('.sec-collapsed')) }; };
      const coding = idsIn('coding'), chat = idsIn('chat');
      // (a) the only hidden card lives in the coding group (first in DOM order), which is collapsed → the first VISIBLE card in the hub
      View.hideCard(coding[0]); View.toggleCollapse('hub:coding'); App._render();
      let chip = document.querySelector('#hub-chips .hub-hidden-chip'); chip.focus(); chip.click(); await settle();
      const onlyCollapsed = { got: active(), expect: vis().length ? vis()[0].dataset.connector : null, codingCollapsed: View.isCollapsed('hub:coding'), chipGone: !document.querySelector('#hub-chips .hub-hidden-chip') };
      // (b) two cards restored — one in the collapsed coding group (earlier in DOM order), one visible in chat → the visible restored one
      View.hideCard(coding[1]); View.hideCard(chat[1]); App._render();
      chip = document.querySelector('#hub-chips .hub-hidden-chip'); chip.focus(); chip.click(); await settle();
      const mixed = { got: active(), expect: chat[1] };
      View.toggleCollapse('hub:coding'); View.showAllCards(); App._render();
      return { onlyCollapsed, mixed, expanded: !View.isCollapsed('hub:coding') };
    });
    ok('focus (review m3): the hidden chip restore never lands on <body> — a restored card inside a collapsed group is skipped: the visible restored card when there is one, else the first visible card in the hub',
      chipFocus.onlyCollapsed.got.isCard && !chipFocus.onlyCollapsed.got.collapsed && chipFocus.onlyCollapsed.got.id === chipFocus.onlyCollapsed.expect && chipFocus.onlyCollapsed.codingCollapsed && chipFocus.onlyCollapsed.chipGone
      && chipFocus.mixed.got.isCard && !chipFocus.mixed.got.collapsed && chipFocus.mixed.got.id === chipFocus.mixed.expect && chipFocus.expanded, JSON.stringify(chipFocus));
  } finally {
    await page.close();
  }
}
