import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './lib/harness.mjs';
import { generate } from './fixtures/gen.mjs';

const results = [];
const ok = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail: String(detail) });
const skip = (name, reason) => results.push({ name, skip: true, detail: String(reason) });
let unmatchedOnly = false;

await generate();
const browser = await launch();
try {
  const dir = path.join(import.meta.dirname, 'checks');
  fs.mkdirSync(dir, { recursive: true });
  // ONLY=87,94 node tests/run.mjs → run just the check files whose name contains one of the tokens (dev loop; the gate is the full suite)
  const only = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && (!only.length || only.some((t) => f.includes(t)))).sort();
  const unmatchedTokens = only.filter((t) => !files.some((f) => f.includes(t)));
  unmatchedOnly = only.length > 0 && files.length === 0;
  if (unmatchedTokens.length) console.error(`Warning: ONLY tokens matched no check files: ${unmatchedTokens.join(', ')}`);
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    try {
      await mod.run({ browser, ok, skip });
    } catch (err) {
      ok(f + ': threw', false, err && err.message || String(err));
    } finally {
      if (mod.postRun) { try { await mod.postRun({ ok, skip }); } catch (e2) { ok(f + ': postRun threw', false, String(e2)); } }
    }
  }
} finally {
  await browser.close();
}

let fails = 0, skips = 0;
for (const r of results) {
  if (r.skip) {
    console.log(`SKIP  ${r.name}  — ${r.detail}`);
    skips++;
    continue;
  }
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.pass ? '  — ' + r.detail : ''}`);
  if (!r.pass) fails++;
}
console.log(`\n${results.length - fails - skips}/${results.length - skips} checks passed, ${skips} skipped`);
if (!results.length) {
  console.error(unmatchedOnly ? `ONLY=${process.env.ONLY} matched no check files; no checks produced a result.` : 'No checks produced a result (ok or skip).');
} else if (results.length - skips === 0) {
  console.error('No checks produced a pass/fail result; all checks were skipped.');
}
process.exit(fails || results.length - skips === 0 ? 1 : 0);
