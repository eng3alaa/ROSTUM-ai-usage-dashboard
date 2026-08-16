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

    const inf = await page.evaluate(() => {
      Budgets.set('total', '1e400');
      return Budgets.limits.total === undefined && !('total' in Budgets.limits);
    });
    ok('budgets: non-finite input is rejected, not stored as Infinity', inf, String(inf));
  } finally {
    await page.close();
  }
}
