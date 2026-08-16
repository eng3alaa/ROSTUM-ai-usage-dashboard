import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser, { tz: 'Asia/Riyadh', clockAt: '2026-08-16T09:00:00Z' });  // local Aug 16, 12:00
  try {
    const r = await page.evaluate(() => {
      const mk = (d, cost, tok = 100, msgs = 1, model = 'claude-sonnet-5', platform = 'Anthropic API', extra = {}) =>
        ({ d, platform, model, in: tok, cw: 0, cr: 0, out: 0, msgs, _cost: cost, ...extra });
      // Insights functions take rows + a costOf(row) fn so tests control cost exactly.
      const costOf = (r) => r._cost;
      // Aug 1..15 at $2/day (MTD = 30 over 15 days), today Aug 16 partial $1
      const rows = [];
      for (let i = 1; i <= 15; i++) rows.push(mk('2026-08-' + String(i).padStart(2, '0'), 2));
      rows.push(mk('2026-08-16', 1));
      const proj = Insights.projection(rows, costOf, '2026-08-16');
      // last 7 FULL days = Aug 9..15 = $2/day → remaining days after today: 31-16 = 15 → 31 + 15*2 = 61
      const wow = Insights.weekOverWeek(rows, costOf, '2026-08-16');   // ISO week Aug 10-16 (incl. today's $1) vs Aug 3-9
      const movers = Insights.topMovers([
        { project: 'A', cost: 10 }, { project: 'B', cost: 1 }, { project: 'C', cost: 5 },
      ], [
        { project: 'A', cost: 4 }, { project: 'B', cost: 3 }, { project: 'D', cost: 2 },
      ], 3);
      const eff = Insights.efficiency([
        ...Array.from({ length: 25 }, () => mk('2026-08-10', 0.5, 200, 1, 'm-many')),
        mk('2026-08-10', 9, 5000, 1, 'm-few'),
      ], costOf, 20);
      const cache = Insights.cacheSavings([
        { model: 'claude-sonnet-5', cr: 1_000_000, in: 0, cw: 0, out: 0 },   // sonnet-5: in $2/M, cr $0.2/M → saved 1.8
      ]);
      const hours = Insights.busiestHours([
        { hour: 9, msgs: 3 }, { hour: 9, msgs: 2 }, { hour: 21, msgs: 1 }, { msgs: 5 },  // last one lacks hour → ignored
      ]);
      return { proj, wow, movers, eff, cache, hours };
    });
    ok('insights: month-end projection = MTD + avg(last 7 full days) × remaining days',
      Math.abs(r.proj.mtd - 31) < 1e-9 && Math.abs(r.proj.projected - 61) < 1e-9 && r.proj.daysLeft === 15, JSON.stringify(r.proj));
    ok('insights: week-over-week compares ISO weeks (this 13 incl. partial today vs last 14 → -7%)',
      Math.abs(r.wow.thisWeek - 13) < 1e-9 && Math.abs(r.wow.lastWeek - 14) < 1e-9 && r.wow.pct === -7 && r.wow.thisStart === '2026-08-10', JSON.stringify(r.wow));
    ok('insights: top movers sorted by absolute change; ties resolve deterministically',
      r.movers.length === 3 && r.movers[0].project === 'A' && r.movers[0].delta === 6 && r.movers[1].project === 'C' && r.movers[1].delta === 5 &&
      Math.abs(r.movers[2].delta) === 2, JSON.stringify(r.movers));
    ok('insights: efficiency filters models under the message floor',
      r.eff.length === 1 && r.eff[0].model === 'm-many' && Math.abs(r.eff[0].costPerMsg - 0.5) < 1e-9 && r.eff[0].tokPerMsg === 200,
      JSON.stringify(r.eff));
    ok('insights: cache savings = cache-read tokens × (input price − cache-read price)',
      Math.abs(r.cache.saved - 1.8) < 1e-9 && r.cache.tokens === 1_000_000, JSON.stringify(r.cache));
    ok('insights: busiest hours histogram ignores rows without hour',
      r.hours.bins.length === 24 && r.hours.bins[9] === 5 && r.hours.bins[21] === 1 && r.hours.total === 6 && r.hours.peak === 9,
      JSON.stringify(r.hours));
  } finally {
    await page.close();
  }
}
