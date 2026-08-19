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

    const junk = await page.evaluate(async () => {
      const real = { path: 'projects/-D--p/sess-f.jsonl', file: new File(
        [JSON.stringify({ type: 'assistant', timestamp: '2026-08-10T09:00:00.000Z', cwd: 'D:\\p', requestId: 'r1',
          message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 20 } } })],
        'sess-f.jsonl', { lastModified: 1754000000000 }) };
      const junkFile = { path: '.DS_Store', file: new File(['junk'], '.DS_Store', { lastModified: 1754000000000 }) };
      const todosFile = { path: 'todos/sess-x.jsonl', file: new File(
        [JSON.stringify({ type: 'assistant', timestamp: '2026-08-10T09:00:00.000Z', cwd: 'D:\\p', requestId: 'r9',
          message: { id: 'm9', model: 'claude-sonnet-5', usage: { input_tokens: 5, output_tokens: 5 } } })],
        'sess-x.jsonl', { lastModified: 1754000000000 }) };
      const cache = new Map();
      const res = await parseClaudeLogsCached([real, junkFile, todosFile], null, cache);
      return { files: res.meta.files, parsedFiles: res.meta.parsedFiles, cacheSize: cache.size };
    });
    ok('scan-cache: junk and excluded-dir files filtered before counting/caching',
      junk.files === 1 && junk.parsedFiles === 1 && junk.cacheSize === 1, JSON.stringify(junk));

    // Claude Code replays messages across forked session files — the SAME message
    // (id+requestId) can legitimately appear in two different .jsonl files. The
    // top-level parseClaudeLogs dedupes via a Set spanning ALL files; the cached
    // wrapper must preserve that cross-file span, not reset it per file.
    const dup = await page.evaluate(async () => {
      const mkFileA = () => ({ path: 'projects/-D--proj2/sess-a.jsonl', file: new File(
        [JSON.stringify({ type: 'assistant', timestamp: '2026-08-12T09:00:00.000Z', cwd: 'D:\\proj2', requestId: 'rX',
          message: { id: 'mX', model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 200 } } })],
        'sess-a.jsonl', { lastModified: 1754000001000 }) });
      const mkFileB = () => ({ path: 'projects/-D--proj2/sess-b.jsonl', file: new File(
        [[
          JSON.stringify({ type: 'assistant', timestamp: '2026-08-12T09:00:05.000Z', cwd: 'D:\\proj2', requestId: 'rX',
            message: { id: 'mX', model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 200 } } }),
          JSON.stringify({ type: 'assistant', timestamp: '2026-08-12T09:05:00.000Z', cwd: 'D:\\proj2', requestId: 'rY',
            message: { id: 'mY', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 20 } } }),
        ].join('\n')],
        'sess-b.jsonl', { lastModified: 1754000002000 }) });
      const sumOf = (rows) => rows.reduce((t, r) => ({ in: t.in + (r.in || 0), out: t.out + (r.out || 0), msgs: t.msgs + (r.msgs || 0) }),
        { in: 0, out: 0, msgs: 0 });

      const direct = await parseClaudeLogs([mkFileB(), mkFileA()], null);
      const directTotals = sumOf(direct.rows);

      const cache = new Map();
      const c1 = await parseClaudeLogsCached([mkFileB(), mkFileA()], null, cache);
      const c1Totals = sumOf(c1.rows);
      const c2 = await parseClaudeLogsCached([mkFileB(), mkFileA()], null, cache);   // same cache, second pass
      const c2Totals = sumOf(c2.rows);

      return { directTotals, c1Totals, c2Totals };
    });
    ok('scan-cache: cross-file duplicate messages deduped through the cache',
      dup.c1Totals.in === dup.directTotals.in && dup.c1Totals.out === dup.directTotals.out && dup.c1Totals.msgs === dup.directTotals.msgs &&
      dup.c2Totals.in === dup.c1Totals.in && dup.c2Totals.out === dup.c1Totals.out && dup.c2Totals.msgs === dup.c1Totals.msgs,
      JSON.stringify(dup));

    // I6: ScanCache moved to a 'scan:v3:' key prefix. A pre-existing 'scan:'-prefixed entry
    // from before the schema change (no per-hour cache-key granularity) must miss, not be
    // served stale, under the new prefix.
    const v3 = await page.evaluate(async () => {
      await IDB.set('scan:legacy-sig', { rows: [], projects: [], msgs: 0, ids: [] });
      const got = await ScanCache.get('legacy-sig');
      await IDB.del('scan:legacy-sig');
      return { got };
    });
    ok('scan-cache: v3 key prefix invalidates pre-hour entries', v3.got == null, JSON.stringify(v3));

    // v4: several parsers changed OUTPUT for unchanged bytes (Roo/Cline inclusive tokensIn + per-request model, local:1 flags,
    // Gemini CLI tool tokens) → the key prefix is bumped again. A 'scan:v3:' entry must (a) MISS under ScanCache.get, (b) be
    // re-parsed (not served) by parseFolderCached, and (c) be DELETED by prune so IDB keeps no dead entries — while an entry
    // under the CURRENT prefix with the same signature survives the prune.
    const usageLog = fs.readFileSync(path.join(OUT, 'usage-log', 'ollama-usage.jsonl'), 'utf8');
    const v4 = await page.evaluate(async (text) => {
      const tmp = { id: 'tmp-v4', platform: 'TmpV4', parser: 'parseUsageLoggerJsonl', patterns: [/\.jsonl$/i] };
      const file = new File([text], 'ollama-usage.jsonl', { lastModified: 1754000000000 });
      const files = () => [{ path: 'logs/ollama-usage.jsonl', file }];
      const sig = 'tmp-v4\u0001logs/ollama-usage.jsonl\u0001' + file.size + '\u00011754000000000';   // exactly what parseFolderCached computes
      const stale = { rows: [{ d: '2026-01-01', platform: 'TmpV4', model: 'stale', in: 1, cw: 0, cr: 0, out: 1, msgs: 1 }], projects: [], msgs: 1, ids: [] };
      await IDB.set('scan:v3:' + sig, stale);
      const getMiss = (await ScanCache.get(sig)) == null;                       // (a) v3 entry not served under the current prefix
      const res = await parseFolderCached(tmp, files(), null, ScanCache);      // (b) parser runs; (c) prune sweeps the v3 key
      const keys = await IDB.keys('scan:');
      const cur = keys.filter(k => k.endsWith(sig));
      const out = { getMiss, parsed: res.meta.parsedFiles, cached: res.meta.cachedFiles, msgs: res.meta.msgs, v3Gone: !keys.includes('scan:v3:' + sig),
        curKeys: cur, curKept: cur.length === 1 && !cur[0].startsWith('scan:v3:') };
      // and prune alone (the public sweep) with the current key in `keep`: v3 twin deleted, current twin kept
      await IDB.set('scan:v3:' + sig, stale);
      await ScanCache.prune(new Set([sig]), 'tmp-v4\u0001');
      const keys2 = await IDB.keys('scan:');
      out.pruneV3Gone = !keys2.includes('scan:v3:' + sig); out.pruneCurKept = cur.length === 1 && keys2.includes(cur[0]);
      for (const k of keys2) if (k.endsWith(sig)) await IDB.del(k);   // cleanup
      return out;
    }, usageLog);
    ok('scan-cache: v4 prefix — a v3 entry misses, is re-parsed (parsedFiles=1, cachedFiles=0) and swept from IDB; the current-prefix twin is kept',
      v4.getMiss && v4.parsed === 1 && v4.cached === 0 && v4.msgs === 3 && v4.v3Gone && v4.curKept && v4.pruneV3Gone && v4.pruneCurKept, JSON.stringify(v4));

    // Cline/Roo: the model comes from the SIBLING task_metadata.json, so a changed sibling must invalidate the
    // cached ui_messages.json rows (signature = main file + same-dir sibling size/lastModified), while an
    // unchanged pair is still a cache hit.
    const clA = fs.readFileSync(path.join(OUT, 'cline', 'tasks', '1786352400000', 'ui_messages.json'), 'utf8');
    const clM = fs.readFileSync(path.join(OUT, 'cline', 'tasks', '1786352400000', 'task_metadata.json'), 'utf8');
    const sib = await page.evaluate(async (a, m) => {
      const c = connectorById('cline');
      const ui = () => ({ path: 'tasks/1786352400000/ui_messages.json', file: new File([a], 'ui_messages.json', { lastModified: 1754000000000 }) });
      const meta = (txt, lm) => ({ path: 'tasks/1786352400000/task_metadata.json', file: new File([txt], 'task_metadata.json', { lastModified: lm }) });
      const m2 = m.replace('claude-sonnet-4.5', 'claude-opus-4.1-changed');   // different content → different size
      const cache = new Map();
      const r1 = await parseFolderCached(c, [ui(), meta(m, 1754000000000)], null, cache);
      const r2 = await parseFolderCached(c, [ui(), meta(m, 1754000000000)], null, cache);        // unchanged pair → hit
      const r3 = await parseFolderCached(c, [ui(), meta(m2, 1754000000001)], null, cache);       // sibling changed → miss, new model
      const r4 = await parseFolderCached(c, [ui(), meta(m2, 1754000000001)], null, cache);       // and cached again
      return { p1: r1.meta.parsedFiles, c2: r2.meta.cachedFiles, p2: r2.meta.parsedFiles, p3: r3.meta.parsedFiles, c4: r4.meta.cachedFiles,
        m1: r1.rows[0] && r1.rows[0].model, m3: r3.rows[0] && r3.rows[0].model, m4: r4.rows[0] && r4.rows[0].model, files: r3.meta.files };
    }, clA, clM);
    ok('scan-cache: cline sibling task_metadata.json change invalidates the cached ui_messages rows (miss → new model); unchanged pair still hits',
      sib.p1 === 1 && sib.c2 === 1 && sib.p2 === 0 && sib.p3 === 1 && sib.c4 === 1 && sib.m1 === 'claude-sonnet-4.5' && sib.m3 === 'claude-opus-4.1-changed' && sib.m4 === 'claude-opus-4.1-changed' && sib.files === 1,
      JSON.stringify(sib));
  } finally {
    await page.close();
  }
}
