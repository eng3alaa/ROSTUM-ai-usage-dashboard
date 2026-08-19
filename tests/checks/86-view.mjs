import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    // ---- T1: hide / unhide account cards ----
    const hide = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      App._drill = null; App.filters.hiddenPlatforms = new Set();
      LS.del('view'); View.load();
      App._render();
      const before = document.querySelectorAll('#accounts-hub .acct').length;
      document.querySelector('#accounts-hub .acct[data-connector="openrouter"] .acct-hide').click();
      App._render();
      const after = document.querySelectorAll('#accounts-hub .acct').length;
      const gone = !document.querySelector('#accounts-hub .acct[data-connector="openrouter"]');
      const chip = document.querySelector('#hub-chips .hub-hidden-chip');
      const persisted = (LS.get('view', {}) || {}).hiddenCards;
      return { before, after, gone, chipText: chip && chip.textContent, persisted };
    });
    ok('view: ✕ hides an account card, chip counts it, preference persists',
      hide.after === hide.before - 1 && hide.gone && /^1 hidden — show$/.test(hide.chipText || '') &&
      Array.isArray(hide.persisted) && hide.persisted.length === 1 && hide.persisted[0] === 'openrouter', JSON.stringify(hide));

    const show = await page.evaluate(() => {
      document.querySelector('#hub-chips .hub-hidden-chip').click();
      App._render();
      return { back: !!document.querySelector('#accounts-hub .acct[data-connector="openrouter"]'),
        chip: !!document.querySelector('#hub-chips .hub-hidden-chip'), persisted: LS.get('view', {}).hiddenCards.length };
    });
    ok('view: "N hidden — show" chip restores every hidden card', show.back && !show.chip && show.persisted === 0, JSON.stringify(show));

    const reveal = await page.evaluate(() => {
      View.hideCard('openrouter'); App._render();
      const hiddenFirst = !document.querySelector('#accounts-hub .acct[data-connector="openrouter"]');
      Store.setConnector('openrouter', { label: 'my-key', lastSync: Date.now(), err: null });   // connect → auto-reveal
      App._render();
      return { hiddenFirst, back: !!document.querySelector('#accounts-hub .acct[data-connector="openrouter"]'), pref: View.isCardHidden('openrouter') };
    });
    ok('view: connecting a hidden card auto-reveals it', reveal.hiddenFirst && reveal.back && reveal.pref === false, JSON.stringify(reveal));

    // ---- T2: section collapse ----
    const col = await page.evaluate(() => {
      LS.del('view'); View.load(); App.applyCollapse();
      const heads = SECTIONS.map(s => !!document.querySelector(`.collapse-btn[data-section="${s.id}"]`));
      const btn = document.querySelector('.collapse-btn[data-section="narrative"]');
      btn.click();
      return { allHeads: heads.every(Boolean), n: heads.length,
        collapsedDisplay: getComputedStyle(document.getElementById('narrative')).display,
        pref: View.isCollapsed('narrative'), glyph: btn.textContent, expanded: btn.getAttribute('aria-expanded') };
    });
    ok('view: every major section header has a collapse toggle; collapsing hides the body and persists',
      col.allHeads && col.n >= 10 && col.collapsedDisplay === 'none' && col.pref === true && col.glyph === '▸' && col.expanded === 'false', JSON.stringify(col));
    await page.emulateMediaType('print');
    const printed = await page.evaluate(() => getComputedStyle(document.getElementById('narrative')).display);
    await page.emulateMediaType('screen');
    ok('view: print ignores collapse (collapsed body renders in print media)', printed !== 'none', printed);

    const { page: p2 } = await openDashboard(browser, { keepStorage: true });   // reload with the same localStorage
    try {
      const again = await p2.evaluate(async () => {
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { pref: View.isCollapsed('narrative'), display: getComputedStyle(document.getElementById('narrative')).display };
      });
      ok('view: collapse survives reload', again.pref && again.display === 'none', JSON.stringify(again));
    } finally { await p2.close(); }
    await page.evaluate(() => { LS.del('view'); View.load(); App.applyCollapse(); });   // leave page 1 expanded for the next blocks

    // ---- T3: insight hide ----
    const ins = await page.evaluate(() => {
      LS.del('view'); View.load(); App.applyCollapse(); App.applyInsightHides(); App._render();
      const card = document.querySelector('#insights .insight[data-insight="cache"]');
      card.querySelector('.insight-hide').click();
      const hidden = card.hidden;
      const chip = document.querySelector('#insights-chips .insights-hidden-chip');
      const pref = View.isInsightHidden('cache');
      const chipText = chip && chip.textContent;
      chip.click();
      return { hidden, chipText, pref, restored: card.hidden === false, chipGone: !document.querySelector('#insights-chips .insights-hidden-chip'), prefAfter: View.isInsightHidden('cache'),
        stillSeven: document.querySelectorAll('#insights .insight').length === 7 };
    });
    ok('view: insight ✕ hides one card; "show all" chip restores; DOM keeps all 7 cards',
      ins.hidden && /1 insight hidden — show all/.test(ins.chipText || '') && ins.pref && ins.restored && ins.chipGone && !ins.prefAfter && ins.stillSeven, JSON.stringify(ins));

    // ---- T4: legacy Data sources section ----
    const legacy = await page.evaluate(() => {
      LS.del('view'); View.load(); App.applyLegacySources();
      const offDisplay = getComputedStyle(document.getElementById('sources')).display;
      const titleOff = getComputedStyle(document.getElementById('sources-title')).display;
      const cb = document.getElementById('show-legacy-sources');
      cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
      const onDisplay = getComputedStyle(document.getElementById('sources')).display;
      const pref = LS.get('view', {}).showLegacySources;
      cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true }));
      return { offDisplay, titleOff, onDisplay, pref };
    });
    ok('view: legacy Data sources hidden by default; settings toggle shows and persists',
      legacy.offDisplay === 'none' && legacy.titleOff === 'none' && legacy.onDisplay !== 'none' && legacy.pref === true, JSON.stringify(legacy));
    const modalStill = await page.evaluate(async () => {
      App.openConnectorModal('anthropic');
      const dlg = document.getElementById('connector-modal');
      const inModal = !!dlg.querySelector('#src-anthropic') && getComputedStyle(dlg.querySelector('#src-anthropic')).display !== 'none';
      const closed = new Promise(r => dlg.addEventListener('close', r, { once: true })); dlg.close(); await closed;
      return { inModal, home: !!document.querySelector('#sources #src-anthropic') };
    });
    ok('view: connector modal still hosts source cards while the legacy section is hidden', modalStill.inModal && modalStill.home, JSON.stringify(modalStill));
    await page.evaluate(() => { LS.del('view'); View.load(); App.applyCollapse(); App.applyInsightHides(); App.applyLegacySources(); App._render(); });

    // ---- fix: auto-reveal only on the off→connected transition ----
    const autoReveal = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      App._drill = null; App.filters.hiddenPlatforms = new Set();
      LS.del('view'); View.load();
      Store.setConnector('openai', { label: 'k', lastSync: Date.now(), err: null });
      View.hideCard('openai');
      App._render();
      const hiddenBefore = !document.querySelector('#accounts-hub .acct[data-connector="openai"]');
      Store.setConnector('openai', { lastSync: Date.now() });   // ok -> ok: must NOT reveal
      App._render();
      const stillHidden = !document.querySelector('#accounts-hub .acct[data-connector="openai"]') && View.isCardHidden('openai');
      delete Store.connectors.openai;
      Store.setConnector('openai', { label: 'k', lastSync: Date.now(), err: null });   // off -> ok: must reveal
      App._render();
      const revealed = !!document.querySelector('#accounts-hub .acct[data-connector="openai"]') && !View.isCardHidden('openai');
      return { hiddenBefore, stillHidden, revealed };
    });
    ok('view: auto-reveal only on the off→connected transition', autoReveal.hiddenBefore && autoReveal.stillHidden && autoReveal.revealed, JSON.stringify(autoReveal));
  } finally {
    await page.close();
  }
}
