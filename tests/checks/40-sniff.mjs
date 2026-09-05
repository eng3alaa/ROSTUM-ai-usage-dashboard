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
    ok('sniff: grok-export / deepseek-chat-export (file name or source gated; plain conversations.json → unknown) / meta-ai-export / perplexity-export (array + {threads}); ChatGPT wrapped needs mapping trees; {conversations:[]} is empty-export (must not replace an earlier ChatGPT import)',
      JSON.stringify(k2) === JSON.stringify(['grok-export', 'deepseek-chat-export', 'unknown', 'deepseek-chat-export', 'meta-ai-export', 'perplexity-export', 'perplexity-export', 'chatgpt-export-wrapped', 'empty-export', 'unknown']), JSON.stringify(k2));
    // {data:[…]} wrappers: a chat export's data[] is not a provider report — provider buckets carry results[] / start_time / starting_at; DeepSeek chat accepts create_time on messages or the conversation
    const k3 = await page.evaluate(() => {
      const dsChat = [{ id: 'c1', messages: [{ role: 'user', content: 'x', inserted_at: '2026-08-10T09:00:00Z' }] }];
      const dsCreate = [{ id: 'c2', create_time: 1786000000, model: 'deepseek-reasoner', messages: [{ role: 'user', content: 'x', create_time: 1786000000 }, { role: 'assistant', content: 'y' }] }];
      const dsConvTime = [{ id: 'c3', create_time: '2026-08-12T10:00:00Z', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] }];
      const px = [{ query: 'q', answer: 'a', created_at: '2026-08-10T09:00:00Z' }];
      return [sniffJSON({ data: dsChat }, 'deepseek-export.json'), sniffJSON({ data: px }, 'perplexity.json'), sniffJSON({ source: 'deepseek', data: dsCreate }, 'x.json'), sniffJSON(dsCreate, 'deepseek.json'), sniffJSON(dsConvTime, 'deepseek.json'),
        sniffJSON({ data: [{ starting_at: '2026-08-01T00:00:00Z', results: [] }] }, 'r.json'), sniffJSON({ data: [{ start_time: 1780000000, results: [] }] }, 'r.json'), sniffJSON({ data: [{ foo: 1 }] }, 'r.json'), sniffJSON({ data: dsChat }, 'conversations.json')];
    });
    ok('sniff: {data:[…]} routes DeepSeek chat (name/source-gated; create_time on messages or the conversation accepted) and Perplexity exports; real provider buckets still read empty-report; an unknown data[] stays unknown',
      JSON.stringify(k3) === JSON.stringify(['deepseek-chat-export', 'perplexity-export', 'deepseek-chat-export', 'deepseek-chat-export', 'deepseek-chat-export', 'empty-report', 'empty-report', 'unknown', 'unknown']), JSON.stringify(k3));
  } finally {
    await page.close();
  }
}
