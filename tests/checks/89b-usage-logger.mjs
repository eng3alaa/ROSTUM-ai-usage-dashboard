// v5 T5 — docs/tools/ollama-usage-logger.mjs is stream-safe. A Node-level check (no page): tests/tools/usage-logger.test.mjs
// starts the logger as a child process in front of a fake upstream and reads back the JSONL it appends; each of its results is
// relayed as one ok(...) line. Runs alone too:  node tests/tools/usage-logger.test.mjs
import { run as runLoggerTest } from '../tools/usage-logger.test.mjs';

export async function run({ ok }) {
  const r = await runLoggerTest();
  for (const x of r.results) ok(x.name, x.pass, x.detail);
}
