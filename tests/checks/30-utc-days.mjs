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
  } finally {
    await page.close();
  }
}
