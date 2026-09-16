// v7 T1 — docs/tools/ai-usage-collector.mjs serves the AI tools' log folders to the dashboard on 127.0.0.1. A Node-level check
// (no page): tests/tools/collector.test.mjs starts the collector as a child process against a temp HOME seeded with the existing
// fixtures and exercises its API; each of its results is relayed as one ok(...) line. Runs alone too:  node tests/tools/collector.test.mjs
import { run as runCollectorTest } from '../tools/collector.test.mjs';

export async function run({ ok }) {
  const r = await runCollectorTest();
  for (const x of r.results) ok(x.name, x.pass, x.detail);
}
