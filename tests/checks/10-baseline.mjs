import fs from 'node:fs';
import path from 'node:path';
import { openDashboard, OUT } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page, errors } = await openDashboard(browser);
  try {
    ok('baseline: page loads without console errors', errors.length === 0, errors.join(' | '));

    const globals = await page.evaluate(() => [
      typeof parseClaudeLogs, typeof parseChatGPTExport, typeof parseGenericCSV,
      typeof parseAnthropicUsage, typeof parseOpenAIUsage, typeof sniffJSON,
      typeof dayKey, typeof makeAgg,
    ]);
    ok('baseline: parser globals callable from page.evaluate', globals.every((t) => t === 'function'), globals.join(','));

    // Exact token math + in-scan dedupe on the synthetic session log
    const sessText = fs.readFileSync(path.join(OUT, 'claude-logs', 'projects', '-D--proj1', 'sess-aaa.jsonl'), 'utf8');
    const agg = await page.evaluate(async (text) => {
      const file = new File([text], 'sess-aaa.jsonl');
      const res = await parseClaudeLogs([{ path: 'projects/-D--proj1/sess-aaa.jsonl', file }], null);
      const t = { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 };
      for (const r of res.rows) { t.in += r.in; t.cw += r.cw; t.cr += r.cr; t.out += r.out; t.msgs += r.msgs; }
      return { ...t, projects: res.projects.length };
    }, sessText);
    ok('baseline: exact totals + dedupe (in=110 cw=25 cr=50 out=220 msgs=2)',
      agg.in === 110 && agg.cw === 25 && agg.cr === 50 && agg.out === 220 && agg.msgs === 2,
      JSON.stringify(agg));

    // Pricing math: claude-sonnet-5 = $2/M in, $10/M out, $2.5/M cw, $0.2/M cr
    const cost = await page.evaluate(() => {
      Pricing.load();
      return Pricing.cost('claude-sonnet-5', { in: 1_000_000, out: 1_000_000, cw: 1_000_000, cr: 1_000_000 });
    });
    ok('baseline: pricing math sonnet-5 = $14.70/M-each', Math.abs(cost - 14.7) < 1e-9, cost);

    // Import sniffing still recognizes chat exports
    const kinds = await page.evaluate(() => [
      sniffJSON([{ mapping: {} }], 'conversations.json'),
      sniffJSON([{ chat_messages: [] }], 'conversations.json'),
    ]);
    ok('baseline: sniff chat exports', kinds[0] === 'chatgpt-export' && kinds[1] === 'claudeai-export', kinds.join(','));

    const hourText = fs.readFileSync(path.join(OUT, 'claude-logs', 'projects', '-D--proj2', 'sess-hours.jsonl'), 'utf8');
    const hours = await page.evaluate(async (text) => {
      const res = await parseClaudeLogs([{ path: 'projects/-D--proj2/sess-hours.jsonl', file: new File([text], 'sess-hours.jsonl') }], null);
      const h = new Map();
      for (const r of res.rows) h.set(r.hour, (h.get(r.hour) || 0) + r.msgs);
      const expA = new Date('2026-08-12T06:15:00.000Z').getHours(), expB = new Date('2026-08-12T20:05:00.000Z').getHours();
      return { got: [...h.entries()].sort(), expA, expB };
    }, hourText);
    ok('baseline: local rows carry hour buckets (2 msgs early, 1 late)',
      hours.got.length === 2 && hours.got.some(([hh, n]) => hh === hours.expA && n === 2) && hours.got.some(([hh, n]) => hh === hours.expB && n === 1),
      JSON.stringify(hours));
  } finally {
    await page.close();
  }
}
