// Plan 11 T4a-1 - independently check which bundled price row wins (no browser, no network).
// Runs alone too:  node tests/tools/price-resolution.test.mjs
import { run as runPriceResolutionTest } from '../tools/price-resolution.test.mjs';

export async function run({ ok }) {
  const r = await runPriceResolutionTest();
  for (const x of r.results) ok(x.name, x.pass, x.detail);
}
