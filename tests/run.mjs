import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './lib/harness.mjs';
import { generate } from './fixtures/gen.mjs';

const results = [];
const ok = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail: String(detail) });

await generate();
const browser = await launch();
const dir = path.join(import.meta.dirname, 'checks');
fs.mkdirSync(dir, { recursive: true });
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()) {
  const mod = await import(pathToFileURL(path.join(dir, f)).href);
  await mod.run({ browser, ok });
}
await browser.close();

let fails = 0;
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.pass ? '  — ' + r.detail : ''}`);
  if (!r.pass) fails++;
}
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
