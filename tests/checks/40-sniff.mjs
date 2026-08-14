import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const kinds = await page.evaluate(() => {
      const anthUsageEmptyFirst = { data: [
        { starting_at: '2026-08-01T00:00:00Z', results: [] },
        { starting_at: '2026-08-02T00:00:00Z', results: [{ uncached_input_tokens: 5, output_tokens: 2, model: 'claude-sonnet-5' }] },
      ] };
      const anthCostEmptyFirst = { data: [
        { starting_at: '2026-08-01T00:00:00Z', results: [] },
        { starting_at: '2026-08-02T00:00:00Z', results: [{ amount: { value: '1.5', currency: 'USD' } }] },
      ] };
      const oaiCostEmptyFirst = { data: [
        { start_time: 1780000000, results: [] },
        { start_time: 1780086400, results: [{ amount: { value: 2.5, currency: 'usd' } }] },
      ] };
      const allEmpty = { data: [
        { starting_at: '2026-08-01T00:00:00Z', results: [] },
        { starting_at: '2026-08-02T00:00:00Z', results: [] },
      ] };
      return [
        sniffJSON(anthUsageEmptyFirst, 'a.json'),
        sniffJSON(anthCostEmptyFirst, 'b.json'),
        sniffJSON(oaiCostEmptyFirst, 'c.json'),
        sniffJSON(allEmpty, 'd.json'),
      ];
    });
    ok('sniff: anthropic usage w/ empty first bucket', kinds[0] === 'anthropic-usage', kinds[0]);
    ok('sniff: anthropic cost w/ empty first bucket', kinds[1] === 'anthropic-cost', kinds[1]);
    ok('sniff: openai COST w/ empty first bucket is NOT usage', kinds[2] === 'openai-cost', kinds[2]);
    ok('sniff: all-empty report is its own case', kinds[3] === 'empty-report', kinds[3]);
  } finally {
    await page.close();
  }
}
