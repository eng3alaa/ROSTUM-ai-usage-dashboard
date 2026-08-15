import fs from 'node:fs';
import path from 'node:path';
import { openDashboard, OUT } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const sessText = fs.readFileSync(path.join(OUT, 'claude-logs', 'projects', '-D--proj1', 'sess-aaa.jsonl'), 'utf8');
    const r = await page.evaluate(async (text) => {
      const mk = () => ({ path: 'projects/-D--proj1/sess-aaa.jsonl', file: new File([text], 'sess-aaa.jsonl', { lastModified: 1754000000000 }) });
      const cache = new Map();                                  // injectable cache for tests
      const a = await parseClaudeLogsCached([mk()], null, cache);
      const b = await parseClaudeLogsCached([mk()], null, cache);
      const t = { in: 0, msgs: 0 };
      for (const row of b.rows) { t.in += row.in; t.msgs += row.msgs; }
      return { firstParsed: a.meta.parsedFiles, secondParsed: b.meta.parsedFiles, secondCached: b.meta.cachedFiles, ...t };
    }, sessText);
    ok('scan-cache: unchanged file parsed once, served from cache after',
      r.firstParsed === 1 && r.secondParsed === 0 && r.secondCached === 1, JSON.stringify(r));
    ok('scan-cache: cached result preserves exact totals', r.in === 110 && r.msgs === 2, JSON.stringify(r));
  } finally {
    await page.close();
  }
}
