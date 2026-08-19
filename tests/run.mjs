import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './lib/harness.mjs';
import { generate } from './fixtures/gen.mjs';

const results = [];
const ok = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail: String(detail) });

await generate();
const browser = await launch();
try {
  const dir = path.join(import.meta.dirname, 'checks');
  fs.mkdirSync(dir, { recursive: true });
  // ONLY=87,94 node tests/run.mjs → run just the check files whose name contains one of the tokens (dev loop; the gate is the full suite)
  const only = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && (!only.length || only.some((t) => f.includes(t)))).sort()) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    try {
      await mod.run({ browser, ok });
    } catch (err) {
      ok(f + ': threw', false, err && err.message || String(err));
    } finally {
      if (mod.postRun) { try { await mod.postRun({ ok }); } catch (e2) { ok(f + ': postRun threw', false, String(e2)); } }
    }
  }
} finally {
  await browser.close();
}

let fails = 0;
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.pass ? '  — ' + r.detail : ''}`);
  if (!r.pass) fails++;
}
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
