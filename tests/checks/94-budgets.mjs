import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser, { clockAt: '2026-08-16T09:00:00Z' });
  try {
    const b = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      // $2/day Aug 1-16 → MTD 32; pace 2/day; 15 days left → projected 62
      const rows = []; for (let i = 1; i <= 16; i++) rows.push({ d: '2026-08-' + String(i).padStart(2, '0'), platform: 'Anthropic API', model: 'claude-sonnet-5', in: 1_000_000, cw: 0, cr: 0, out: 0, msgs: 1 });
      Store.setSource('anthropic', rows, {});
      Budgets.set('total', 40);            // 32/40 = 80% → approaching, projected 62 → overrun
      Budgets.set('Anthropic API', 100);   // 32% fine
      App._render();
      const st = Budgets.status();
      const banners = [...document.querySelectorAll('#alerts .alert')].map(a => a.dataset.kind);
      return { totalPct: st.total.pct, platPct: st.byPlatform['Anthropic API'].pct, projOver: st.total.projected > st.total.limit, banners };
    });
    ok('budgets: status math (32/40 = 80%; platform 32%)', b.totalPct === 80 && b.platPct === 32 && b.projOver, JSON.stringify(b));
    ok('budgets: 80% approaching + projected-overrun banners shown', b.banners.includes('approach:total') && b.banners.includes('overrun:total'), JSON.stringify(b.banners));

    const d = await page.evaluate(async () => {
      document.querySelector('#alerts .alert[data-kind="approach:total"] .alert-dismiss').click();
      App._render();
      const after = [...document.querySelectorAll('#alerts .alert')].map(a => a.dataset.kind);
      const persisted = LS.get('dismissedAlerts', {});
      return { after, key: Object.keys(persisted)[0] };
    });
    ok('budgets: dismissal removes banner and persists per month', !d.after.includes('approach:total') && /^approach:total:2026-08$/.test(d.key), JSON.stringify(d));

    const card = await page.evaluate(() => {
      App.renderHub();
      const c = document.querySelector('#accounts-hub .acct[data-connector="anthropic"] .budget-bar');
      return { has: !!c, w: c && c.querySelector('.fill').style.width };
    });
    ok('budgets: hub card shows a progress bar when a platform budget exists', card.has && /32%/.test(card.w), JSON.stringify(card));

    const ex = await page.evaluate(() => {
      Budgets.set('total', 30);           // 32/30 → exceeded (107%)
      App._render();
      return [...document.querySelectorAll('#alerts .alert')].map(a => a.dataset.kind);
    });
    ok('budgets: exceeded banner replaces approaching', ex.includes('exceed:total') && !ex.includes('approach:total'), JSON.stringify(ex));

    // I2: exceed must gate on spent >= limit, not a rounded pct >= 100 — 99.6% of budget
    // is NOT over. Monkeypatch Budgets.status so the boundary is exact, independent of
    // the token/pricing pipeline that produces `spent`.
    const gate = await page.evaluate(() => {
      const origStatus = Budgets.status;
      LS.set('dismissedAlerts', {});
      Budgets.status = () => ({ total: { spent: 99.6, limit: 100, pct: Math.round(99.6 / 100 * 100), projected: 150 }, byPlatform: {} });
      const under = Budgets.alerts().map(a => a.kind);
      Budgets.status = () => ({ total: { spent: 100.0, limit: 100, pct: 100, projected: 100 }, byPlatform: {} });
      const atLimit = Budgets.alerts().map(a => a.kind);
      Budgets.status = origStatus;
      return { under, atLimit };
    });
    ok('budgets: exceed only when spent >= limit (99.6% is not over)',
      gate.under.includes('approach:total') && gate.under.includes('overrun:total') && !gate.under.includes('exceed:total') &&
      gate.atLimit.includes('exceed:total'),
      JSON.stringify(gate));

    // Same falsehood, other surfaces: status().pct must floor so the narrative gate,
    // hub bar class, and editor note agree with the spent >= limit alert gate.
    const floorPct = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      // 99.6% of a $100 budget: 49.8M input tokens of sonnet-5 at $2/M = $99.60
      Store.setSource('anthropic', [{ d: todayKey(), platform: 'Anthropic API', model: 'claude-sonnet-5', in: 49_800_000, cw: 0, cr: 0, out: 0, msgs: 1 }], {});
      Budgets.set('total', 100);
      const st = Budgets.status();
      App._render();
      return { pct: st.total.pct, narrative: document.getElementById('narrative').textContent };
    });
    ok('budgets: status pct floors (99.6% reads 99, narrative says "used" not "over")',
      floorPct.pct === 99 && /have used 99%/.test(floorPct.narrative) && !/are over/.test(floorPct.narrative),
      JSON.stringify(floorPct));

    // The editor footer says "Platforms appear here once connected, budgeted, or once they have data" — that must hold for
    // import-only platforms (Cursor / Gemini app / ChatGPT / Claude.ai have NO CONNECTORS entry, so the connector loop never
    // reaches them) and for a platform shared by two connectors (GitHub Copilot: PAT card + CLI logs) when only the second is connected.
    const editorRows = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; Budgets.limits = {}; LS.del('budgets');
      const plats = () => [...document.querySelectorAll('#budget-editor .budget-row')].map(r => r.dataset.platform);
      Store.setSource('cursor-csv', [{ d: todayKey(), platform: 'Cursor', model: 'gpt-5.4', in: 10, cw: 0, cr: 0, out: 5, msgs: 1 }], {});
      App.renderBudgets();
      const cursor = plats();
      Store.sources = {};
      Store.setConnector('copilot-cli', { label: '2 files', lastSync: Date.now() });   // only the SECOND GitHub Copilot connector is connected
      App.renderBudgets();
      const copilot = plats();
      Store.connectors = {};
      Budgets.set('Gemini app', 20);   // budgeted import-only platform, no data, no connector
      App.renderBudgets();
      const budgeted = plats();
      Budgets.limits = {}; LS.del('budgets'); Store.persist();
      return { cursor, copilot, budgeted };
    });
    ok('budgets editor: rows for platform "Cursor" present with no connector → a Cursor row (once)',
      editorRows.cursor.filter(p => p === 'Cursor').length === 1 && editorRows.cursor[0] === 'total', JSON.stringify(editorRows.cursor));
    ok('budgets editor: only copilot-cli connected → a "GitHub Copilot" row (once); budgeted "Gemini app" (no data, no connector) → a row',
      editorRows.copilot.filter(p => p === 'GitHub Copilot').length === 1 && editorRows.budgeted.filter(p => p === 'Gemini app').length === 1 && !editorRows.budgeted.includes('GitHub Copilot'), JSON.stringify({ copilot: editorRows.copilot, budgeted: editorRows.budgeted }));

    const inf = await page.evaluate(() => {
      Budgets.set('total', '1e400');
      return Budgets.limits.total === undefined && !('total' in Budgets.limits);
    });
    ok('budgets: non-finite input is rejected, not stored as Infinity', inf, String(inf));

    // Plan 6 (v6-unpriced): model ids no price row matches are priced at the '.*' fallback row — the dashboard must SAY so
    // (never guess silently). Local rows are $0 by platform / local:1 and are never "guessed".
    const un = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; Budgets.limits = {}; LS.del('budgets'); LS.set('dismissedAlerts', {});
      App._drill = null; App.filters.hiddenPlatforms = new Set();
      Store.setSource('codex', [
        { d: todayKey(), platform: 'OpenAI Codex CLI', model: 'gpt-6-astra', in: 1_000_000, cw: 0, cr: 0, out: 100_000, msgs: 5730 },   // $3 + $1.50 at the fallback row
        { d: todayKey(), platform: 'OpenAI Codex CLI', model: 'codex-auto-review', in: 100_000, cw: 0, cr: 0, out: 0, msgs: 3 },         // $0.30
      ], {});
      Store.setSource('anthropic', [{ d: todayKey(), platform: 'Anthropic API', model: 'claude-3-haiku-20240307', in: 8_000_000, cw: 0, cr: 0, out: 0, msgs: 1 }], {});   // priced: $2
      Store.setSource('ollama', [{ d: todayKey(), platform: 'Ollama', model: 'llama-mystery', in: 1_000_000, cw: 0, cr: 0, out: 0, msgs: 9 }], {});               // local: $0, never flagged
      App._render();
      const list = App.unpricedModels(Store.allRows());
      const a = document.querySelector('#alerts .alert[data-kind="unpriced"]');
      const total = [...document.querySelectorAll('#breakdown-table tr.total td')].pop();
      return {
        isFb: [Pricing.isFallback('gpt-6-astra'), Pricing.isFallback('claude-sonnet-5'), Pricing.isFallback('llama-mystery')],
        list: list.map(u => [u.model, u.platforms.join('|'), u.msgs, u.tokens, +u.cost.toFixed(2)]),
        text: a ? a.textContent : null, level: a && a.className,
        buttons: a ? [...a.querySelectorAll('button')].map(b => b.textContent) : [],
        total: total && total.textContent,
      };
    });
    ok('unpriced: Pricing.isFallback is true only for ids no price row matches',
      un.isFb[0] === true && un.isFb[1] === false && un.isFb[2] === true, JSON.stringify(un.isFb));
    ok('unpriced: App.unpricedModels lists fallback-priced non-local models by cost desc (local Ollama row excluded)',
      JSON.stringify(un.list) === JSON.stringify([['gpt-6-astra', 'OpenAI Codex CLI', 5730, 1_100_000, 4.5], ['codex-auto-review', 'OpenAI Codex CLI', 3, 100_000, 0.3]]), JSON.stringify(un.list));
    ok('unpriced: alert banner names the models, the fallback prices and the price list, with Set prices + Dismiss',
      !!un.text && /2 models are priced at the fallback rate \(\$3 in \/ \$15 out per M\): gpt-6-astra \(5,730 msgs, \$4\.50\), codex-auto-review \(3 msgs, \$0\.300\) — set their prices in the API price list\./.test(un.text) && /serious/.test(un.level) && un.buttons.join() === 'Set prices,Dismiss',
      JSON.stringify([un.text, un.level, un.buttons]));
    ok('unpriced: totals unchanged — the fallback price is still applied (breakdown total $6.80)', un.total === '$6.80', String(un.total));
    ok('unpriced (Plan 10 T3b): a second sentence discloses the models priced from an unverified or user-edited row — claude-3-haiku-20240307 is an Aug-2026 row carried over unverified (c: existing), with its count, message count and cost',
      /API price list\. 1 model is priced from an unverified or user-edited row, so its cost is an estimate: claude-3-haiku-20240307 \(unverified since Aug 2026, 1 msg, \$2\.00\)\./.test(un.text || ''), String(un.text));

    const fbRow = await page.evaluate(() => {
      const fb = Pricing.rows.find(r => r.pat === '.*'); const was = fb.in; fb.in = 4; Pricing.save();
      App._render();
      const t = document.querySelector('#alerts .alert[data-kind="unpriced"]').textContent;
      fb.in = was; Pricing.save(); App._render();
      return t;
    });
    ok('unpriced: the fallback prices in the banner are read from the ".*" row, not hard-coded',
      /\(\$4 in \/ \$15 out per M\)/.test(fbRow) && /gpt-6-astra \(5,730 msgs, \$5\.50\)/.test(fbRow), fbRow);

    const cap = await page.evaluate(() => {
      Store.setSource('csv', ['u1', 'u2', 'u3', 'u4', 'u5'].map(m => ({ d: todayKey(), platform: 'Gemini', model: m, in: 1000, cw: 0, cr: 0, out: 0, msgs: 1 })), {});
      App._render();
      const t = document.querySelector('#alerts .alert[data-kind="unpriced"]').textContent;
      delete Store.sources.csv; App._render();
      return t;
    });
    ok('unpriced: the model list is capped at 5 with "+N more"',
      /7 models are priced/.test(cap) && /codex-auto-review \(3 msgs, \$0\.300\), u1 \(1 msg, \$0\.003\), u2 \(1 msg, \$0\.003\), u3 \(1 msg, \$0\.003\), \+2 more — set their prices/.test(cap) && !/u4|u5/.test(cap), cap);

    const dis = await page.evaluate(() => {
      document.querySelector('#alerts .alert[data-kind="unpriced"] .alert-dismiss').click();
      App._render();
      const gone = !document.querySelector('#alerts .alert[data-kind="unpriced"]');
      const keys = Object.keys(LS.get('dismissedAlerts', {}));
      // a NEW unknown model re-raises the notice: the dismissal is for the SET of names, not forever
      Store.setSource('codex2', [{ d: todayKey(), platform: 'OpenAI Codex CLI', model: 'codex', in: 1000, cw: 0, cr: 0, out: 0, msgs: 1 }], {});
      App._render();
      const back = document.querySelector('#alerts .alert[data-kind="unpriced"]');
      return { gone, keys, back: back ? back.textContent : null };
    });
    ok('unpriced: Dismiss hides the notice and persists it for the SET of model names',
      dis.gone && dis.keys.length === 1 && dis.keys[0] === 'unpriced:codex-auto-review,gpt-6-astra', JSON.stringify(dis));
    ok('unpriced: a new unknown model re-raises the notice', !!dis.back && /3 models are priced/.test(dis.back) && /codex \(1 msg, \$0\.003\)/.test(dis.back), String(dis.back));

    const sp = await page.evaluate(() => {
      View._add('collapsed', 'pricing'); App.applyCollapse();
      const before = document.getElementById('card-pricing').classList.contains('sec-collapsed');
      const orig = Element.prototype.scrollIntoView; let scrolledTo = null;
      Element.prototype.scrollIntoView = function () { scrolledTo = this.id; };
      try { [...document.querySelectorAll('#alerts .alert[data-kind="unpriced"] button')].find(b => b.textContent === 'Set prices').click(); }
      finally { Element.prototype.scrollIntoView = orig; }
      const after = document.getElementById('card-pricing').classList.contains('sec-collapsed');
      LS.set('dismissedAlerts', {}); Store.sources = {};
      return { before, after, collapsed: View.isCollapsed('pricing'), scrolledTo };
    });
    ok('unpriced: "Set prices" expands a collapsed price list and scrolls to it', sp.before && !sp.after && !sp.collapsed && sp.scrolledTo === 'pricing-title', JSON.stringify(sp));

    // Plan 10 T3b: with no fallback-priced model at all the notice still discloses the estimates — a user-edited row and a low-confidence bundled
    // row are named with their reason; the level is info (not serious), the dismissal key is estimates:<sorted set>; a high-confidence verified row raises nothing
    const est = await page.evaluate(() => {
      LS.set('dismissedAlerts', {}); Store.sources = {}; LS.del('prices'); Pricing.load();
      Store.setSource('csv', [
        { d: todayKey(), platform: 'Anthropic API', model: 'claude-3-haiku-20240307', in: 8_000_000, cw: 0, cr: 0, out: 0, msgs: 1 },   // c: existing → unverified since Aug 2026
        { d: todayKey(), platform: 'xAI', model: 'grok-4.3', in: 1_000_000, cw: 0, cr: 0, out: 0, msgs: 2 },                   // c: high, verified → not listed
        { d: todayKey(), platform: 'Cursor', model: 'composer-1', in: 1_000_000, cw: 0, cr: 0, out: 0, msgs: 3 },               // c: low → low confidence
      ], {});
      Pricing.rows.find(x => x.pat === '^grok-4\\.5').in = 1; Pricing.save();
      Store.setSource('csv2', [{ d: todayKey(), platform: 'xAI', model: 'grok-4.5', in: 1_000_000, cw: 0, cr: 0, out: 0, msgs: 4 }], {});   // user-edited row → user price
      App._render();
      const a = document.querySelector('#alerts .alert[data-kind="unpriced"]');
      const out = { text: a && a.textContent, cls: a && a.className, buttons: a ? [...a.querySelectorAll('button')].map(b => b.textContent) : [] };
      if (a) a.querySelector('.alert-dismiss').click();
      out.keys = Object.keys(LS.get('dismissedAlerts', {}));
      App._render(); out.gone = !document.querySelector('#alerts .alert[data-kind="unpriced"]');
      LS.set('dismissedAlerts', {}); Store.sources = {}; LS.del('prices'); Pricing.load(); App._render();
      return out;
    });
    ok('unpriced (T3b): estimates alone — "3 models are priced from an unverified or user-edited row, so their cost is an estimate: claude-3-haiku-20240307 (unverified since Aug 2026, 1 msg, $2.00), composer-1 (low confidence, 3 msgs, $1.25), grok-4.5 (user price, 4 msgs, $1.00)." — no fallback sentence, level info, Set prices + Dismiss, key estimates:<set>, dismissal hides it; the verified grok-4.3 row is not listed',
      !!est.text && !/fallback rate/.test(est.text) && /^⚠ 3 models are priced from an unverified or user-edited row, so their cost is an estimate: claude-3-haiku-20240307 \(unverified since Aug 2026, 1 msg, \$2\.00\), composer-1 \(low confidence, 3 msgs, \$1\.25\), grok-4\.5 \(user price, 4 msgs, \$1\.00\)\./.test(est.text)
      && /\binfo\b/.test(est.cls) && !/serious/.test(est.cls) && est.buttons.join() === 'Set prices,Dismiss' && est.keys.join() === 'estimates:claude-3-haiku-20240307,composer-1,grok-4.5' && est.gone, JSON.stringify(est));
  } finally {
    await page.close();
  }
}
