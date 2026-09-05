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
    // Plan 4b T13: chat-export kinds; a {conversations:[…]} that is not a ChatGPT mapping tree is NOT routed to the ChatGPT parser
    const k2 = await page.evaluate(() => {
      const grok = { conversations: [{ conversation: { title: 't' }, responses: [{ message: 'hi', sender: 'human' }] }] };
      const dsChat = [{ id: 'c1', messages: [{ role: 'user', content: 'x', inserted_at: '2026-08-10T09:00:00Z' }] }];
      const meta = { participants: [{ name: 'Me' }, { name: 'Meta AI' }], messages: [{ sender_name: 'Meta AI', timestamp_ms: 1, content: 'hey' }] };
      const px = [{ query: 'q', answer: 'a', created_at: '2026-08-10T09:00:00Z' }];
      return [sniffJSON(grok, 'grok.json'), sniffJSON(dsChat, 'deepseek-conversations.json'), sniffJSON(dsChat, 'conversations.json'), sniffJSON({ source: 'deepseek', conversations: dsChat }, 'x.json'),
        sniffJSON(meta, 'message_1.json'), sniffJSON(px, 'threads.json'), sniffJSON({ threads: px }, 'export.json'),
        sniffJSON({ conversations: [{ mapping: {} }] }, 'c.json'), sniffJSON({ conversations: [] }, 'c.json'), sniffJSON({ conversations: [{ messages: [{ role: 'user', created_at: 1 }] }] }, 'c.json')];
    });
    ok('sniff: grok-export / deepseek-chat-export (file name or source gated; plain conversations.json → unknown) / meta-ai-export / perplexity-export (array + {threads}); ChatGPT wrapped needs mapping trees',
      JSON.stringify(k2) === JSON.stringify(['grok-export', 'deepseek-chat-export', 'unknown', 'deepseek-chat-export', 'meta-ai-export', 'perplexity-export', 'perplexity-export', 'chatgpt-export-wrapped', 'chatgpt-export-wrapped', 'unknown']), JSON.stringify(k2));
  } finally {
    await page.close();
  }
}
