import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const res = await page.evaluate(() => {
      // user asks once; assistant answered (A, t=100, 4000 chars), user hit regenerate → B (t=200, 400 chars).
      // Active branch = root -> user -> B. Node A is a dead branch and must NOT be counted.
      const conv = {
        create_time: 100, current_node: 'B',
        mapping: {
          root: { id: 'root', parent: null, children: ['u1'], message: null },
          u1:   { id: 'u1', parent: 'root', children: ['A', 'B'],
                  message: { author: { role: 'user' }, create_time: 50, content: { content_type: 'text', parts: ['hi'.repeat(20)] } } },
          A:    { id: 'A', parent: 'u1', children: [],
                  message: { author: { role: 'assistant' }, create_time: 100, metadata: { model_slug: 'gpt-5.4' }, content: { content_type: 'text', parts: ['x'.repeat(4000)] } } },
          B:    { id: 'B', parent: 'u1', children: [],
                  message: { author: { role: 'assistant' }, create_time: 200, metadata: { model_slug: 'gpt-5.4' }, content: { content_type: 'text', parts: ['y'.repeat(400)] } } },
        },
      };
      const out = parseChatGPTExport([conv]);
      const t = { msgs: out.meta.msgs, out: 0 };
      for (const r of out.rows) t.out += r.out;
      return t;
    });
    // active branch only: 1 assistant reply, out = estTok(400) = 100
    ok('chatgpt: dead branches not counted', res.msgs === 1 && res.out === 100, JSON.stringify(res));
  } finally {
    await page.close();
  }
}
