// Plan 10 Task 1 — docs/tools/price-check.mjs compares the price spec (docs/superpowers/specs/2026-10-15-price-rows.json) with the vendors'
// pricing pages. A Node-level check (no page, no network): tests/tools/price-check.test.mjs serves stub pricing pages on 127.0.0.1 and
// exercises the extractor, every status, the coverage maths, the exit-code rule, the markdown and the CLI; each of its results is relayed
// as one ok(...) line. The live comparison is NOT part of the suite — .github/workflows/price-check.yml runs it weekly on its own.
// Runs alone too:  node tests/tools/price-check.test.mjs
import { run as runPriceCheckTest } from '../tools/price-check.test.mjs';

export async function run({ ok }) {
  const r = await runPriceCheckTest();
  for (const x of r.results) ok(x.name, x.pass, x.detail);
}
