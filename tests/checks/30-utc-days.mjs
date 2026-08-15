import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser, { tz: 'America/New_York' });   // UTC-4/-5
  try {
    const days = await page.evaluate(() => {
      const anth = parseAnthropicUsage({ data: [{ starting_at: '2026-08-14T00:00:00Z',
        results: [{ model: 'claude-sonnet-5', uncached_input_tokens: 1, output_tokens: 1, num_requests: 1 }] }] });
      const oai = parseOpenAIUsage({ data: [{ start_time: 1786665600,   // 2026-08-14T00:00:00Z
        results: [{ model: 'gpt-5.4', input_tokens: 1, output_tokens: 1, num_model_requests: 1 }] }] });
      const csv = parseGenericCSV('date,platform,model,input_tokens\n2026-08-14,Gemini,gemini-3,5\n');
      return [anth.rows[0].d, oai.rows[0].d, csv.rows[0].d];
    });
    ok('utc: Anthropic bucket keeps its UTC calendar day', days[0] === '2026-08-14', days[0]);
    ok('utc: OpenAI bucket keeps its UTC calendar day', days[1] === '2026-08-14', days[1]);
    ok('utc: date-only CSV strings pass through literally', days[2] === '2026-08-14', days[2]);

    // Fix B: provider parsers must reject non-finite numbers (Infinity in a token/amount field
    // must not silently propagate into totals).
    const guards = await page.evaluate(() => {
      const anth = parseAnthropicUsage({ data: [{ starting_at: '2026-08-14T00:00:00Z',
        results: [{ model: 'claude-sonnet-5', uncached_input_tokens: Infinity, output_tokens: 5, num_requests: 1 }] }] });
      const oai = parseOpenAIUsage({ data: [{ start_time: 1786665600,   // 2026-08-14T00:00:00Z
        results: [{ model: 'gpt-5.4', input_tokens: Infinity, output_tokens: 5, num_model_requests: 1 }] }] });
      const anthCost = parseAnthropicCost({ data: [{ starting_at: '2026-08-14T00:00:00Z',
        results: [{ amount: { value: Infinity } }] }] });
      const oaiCost = parseOpenAICost({ data: [{ start_time: 1786665600,
        results: [{ amount: { value: Infinity } }] }] });
      return {
        anth: { in: anth.rows[0].in, out: anth.rows[0].out },
        oai: { in: oai.rows[0].in, out: oai.rows[0].out },
        anthCostTotal: anthCost.reduce((a, b) => a + b.amount, 0),
        oaiCostTotal: oaiCost.reduce((a, b) => a + b.amount, 0),
      };
    });
    ok('utc: provider usage parsers reject non-finite token counts',
      guards.anth.in === 0 && guards.anth.out === 5 && guards.oai.in === 0 && guards.oai.out === 5,
      JSON.stringify(guards));
    ok('utc: provider cost parsers reject non-finite amounts',
      guards.anthCostTotal === 0 && guards.oaiCostTotal === 0,
      JSON.stringify(guards));
  } finally {
    await page.close();
  }

  // Fix A: window() upper bound must cover UTC-keyed rows. In UTC-negative timezones during
  // the local evening, a row keyed "tomorrow UTC" must still fall inside the default window.
  const { page: page2 } = await openDashboard(browser, { tz: 'America/New_York', clockAt: '2026-08-15T01:30:00Z' });
  try {
    await page2.evaluate(() => {
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      Store.setSource('anthropic', [{ d: '2026-08-15', platform: 'Anthropic API', model: 'claude-sonnet-5', in: 7, cw: 0, cr: 0, out: 3, msgs: 1 }], {});
      localStorage.setItem('aiusage:range', JSON.stringify('30'));
    });
    await page2.reload({ waitUntil: 'load' });
    const count = await page2.evaluate(() => App.rowsIn(App.window()).length);
    ok('utc: tonight-UTC provider row visible in default window', count === 1, count);
  } finally {
    await page2.close();
  }
}
