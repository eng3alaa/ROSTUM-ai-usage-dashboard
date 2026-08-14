# v1.1 Defect Fixes + Permanent Test Rig — Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 11 of the 13 verified defects from the 2026-08-15 code reviews in `AI Usage Dashboard.html` (plus the carried-in unverified-note fixes), each proven by a permanent headless test rig. The remaining two — #5 connector registry and #7 incremental scan cache — are architectural and open Plan 2, where they are built once as part of the connector rework instead of twice.

**Architecture:** The dashboard is ONE self-contained HTML file (`AI Usage Dashboard.html`, ~2285 lines) at the repo root; all fixes are in-place edits to it. A new `tests/` directory holds a Node + puppeteer-core rig that drives the installed Chrome against the `file://` page and calls the dashboard's global functions directly via `page.evaluate`. The v1 rig was ephemeral (temp dir, now deleted) — Task 1–2 rebuild equivalent baseline coverage permanently.

**Tech Stack:** Plain HTML/JS/SVG (no framework, no build). Tests: Node ≥ 20 (installed: v25), `puppeteer-core` driving installed Chrome (`C:/Program Files/Google/Chrome/Application/chrome.exe`) — no browser download.

**Specs & context for the engineer:**
- Spec: `docs/superpowers/specs/2026-08-15-ai-accounts-rich-dashboard-design.md` (section "v1 defects folded into v2" lists the 13 defects; this plan implements all of them).
- Reviews: `docs/superpowers/reviews/2026-08-15-v1-code-review.md` and `...-codex-second-opinion.md`.
- ⚠️ The HTML file currently contains literal NUL (0x00) bytes (used as string separators), so `grep`/`rg` treat it as binary. Use `grep -an`, `rg -a`, or the Read tool. Task 7 removes them.
- All dashboard functions (`parseClaudeLogs`, `sniffJSON`, `Store`, `App`, …) are top-level in a classic `<script>`, so they are callable as bare identifiers inside `page.evaluate` (function declarations land on `window`; `const`/`let` bindings like `dayKey`, `LS`, `Pricing` live in the global lexical scope — same callability, NOT `window` properties).
- Every task ends with a commit. Do not batch commits across tasks.
- **Standing amendment (from Task 2 quality review):** in every check file, wrap the body between `openDashboard(...)` and the end in `try { ... } finally { await page.close(); }` so a throwing assertion still closes its page and later checks keep their diagnostics. The reference code blocks below predate this note — apply the pattern when writing each file. Task 3 additionally retrofits it into `tests/checks/10-baseline.mjs`.

## File structure

```
AI Usage Dashboard.html          # the app — all fixes edit this file in place
tests/
  package.json                   # private, type:module, dep: puppeteer-core
  run.mjs                        # runner: generates fixtures, loads every tests/checks/*.mjs
  lib/harness.mjs                # browser launch + page open + console-error capture
  fixtures/gen.mjs               # writes synthetic fixtures to tests/fixtures/out/
  fixtures/out/                  # generated — gitignored
  checks/10-baseline.mjs         # smoke + parser baseline (recreates v1 coverage)
  checks/20-csv-guards.mjs       # Tasks 3–4
  checks/30-utc-days.mjs         # Task 5
  checks/40-sniff.mjs            # Task 6
  checks/50-billed-staleness.mjs # Task 7
  checks/60-merge-dedupe.mjs     # Tasks 8–9
  checks/70-chatgpt-branches.mjs # Task 10
  checks/80-race.mjs             # Task 11
  checks/90-bucketing.mjs        # Task 12
  checks/95-ui-misc.mjs          # Tasks 13–15
.gitignore
```

Edits to the HTML are expressed as exact old/new code (never line numbers — they shift task to task). Each old block below is unique in the file.

---

### Task 0: Git init + initial commit

**Files:** Create: `.gitignore`

- [ ] **Step 1: Initialize the repo** (skip `git init` if `.git/` already exists)

```bash
cd "D:/Code/rostum" && git init -b main
```

- [ ] **Step 2: Create `.gitignore`** with exactly:

```gitignore
node_modules/
tests/fixtures/out/
tests/artifacts/
```

- [ ] **Step 3: Commit the current state**

```bash
git add -A && git commit -m "chore: import v1 dashboard, specs, reviews"
```

Expected: one commit containing `AI Usage Dashboard.html`, `docs/**`, `.gitignore`.

---

### Task 1: Test rig skeleton

**Files:** Create: `tests/package.json`, `tests/lib/harness.mjs`, `tests/run.mjs`, `tests/fixtures/gen.mjs`

- [ ] **Step 1: Write `tests/package.json`**

```json
{
  "name": "ai-dashboard-tests",
  "private": true,
  "type": "module",
  "dependencies": { "puppeteer-core": "^24.0.0" }
}
```

- [ ] **Step 2: Write `tests/lib/harness.mjs`**

```js
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const DASH = path.join(ROOT, 'AI Usage Dashboard.html');
export const OUT = path.join(import.meta.dirname, '..', 'fixtures', 'out');

export function findBrowser() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('No Chrome/Edge found - set CHROME_PATH');
}

export async function launch() {
  return puppeteer.launch({ executablePath: findBrowser(), headless: true });
}

/** Open the dashboard in a fresh page. opts: {tz, seedData} */
export async function openDashboard(browser, opts = {}) {
  const page = await browser.newPage();
  if (opts.tz) await page.emulateTimezone(opts.tz);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const url = pathToFileURL(DASH).href;
  await page.goto(url, { waitUntil: 'load' });
  if (opts.seedData) {
    await page.evaluate((data) => localStorage.setItem('aiusage:data', JSON.stringify(data)), opts.seedData);
    await page.reload({ waitUntil: 'load' });
  }
  return { page, errors };
}

export function readFixture(name) {
  return fs.readFileSync(path.join(OUT, name), 'utf8');
}
```

- [ ] **Step 3: Write `tests/fixtures/gen.mjs`** (fixture bodies are added by later tasks; start with the Claude-log fixtures used by the baseline)

```js
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, 'out');

const jl = (o) => JSON.stringify(o);

export async function generate() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'claude-logs', 'projects', '-D--proj1'), { recursive: true });

  // Session aaa: 3 assistant lines, line 2 is a DUPLICATE of line 1 (same message id + requestId).
  // Expected after dedupe: in=110, cw=25, cr=50, out=220, msgs=2.
  const sess = [
    jl({ type: 'assistant', timestamp: '2026-08-10T09:00:00.000Z', cwd: 'D:\\proj1', requestId: 'r1',
         message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 25 } } }),
    jl({ type: 'assistant', timestamp: '2026-08-10T09:00:05.000Z', cwd: 'D:\\proj1', requestId: 'r1',
         message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 25 } } }),
    jl({ type: 'assistant', timestamp: '2026-08-11T10:00:00.000Z', cwd: 'D:\\proj1', requestId: 'r2',
         message: { id: 'm2', model: 'claude-fable-5', usage: { input_tokens: 10, output_tokens: 20 } } }),
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'claude-logs', 'projects', '-D--proj1', 'sess-aaa.jsonl'), sess);
}

if (process.argv[1] === import.meta.filename) await generate();
```

- [ ] **Step 4: Write `tests/run.mjs`**

```js
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
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    try {
      await mod.run({ browser, ok });
    } catch (err) {
      ok(f + ': threw', false, err && err.message || String(err));
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
```

- [ ] **Step 5: Install and run (expect 0 checks, exit 0)**

```bash
cd "D:/Code/rostum" && npm install --prefix tests && node tests/run.mjs
```

Expected output ends with: `0/0 checks passed`

- [ ] **Step 6: Commit**

```bash
git add tests .gitignore && git commit -m "test: add headless puppeteer-core rig skeleton"
```

---

### Task 2: Baseline checks (recreate v1 coverage)

**Files:** Create: `tests/checks/10-baseline.mjs`

- [ ] **Step 1: Write the baseline checks**

```js
import fs from 'node:fs';
import path from 'node:path';
import { openDashboard, OUT } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page, errors } = await openDashboard(browser);

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

  await page.close();
}
```

- [ ] **Step 2: Run — all 5 must pass**

```bash
node tests/run.mjs
```

Expected: `5/5 checks passed`, exit 0.

- [ ] **Step 3: Commit**

```bash
git add tests/checks/10-baseline.mjs && git commit -m "test: baseline coverage (load, parsers, dedupe, pricing, sniff)"
```

---

### Task 3: Fix CSV formula injection (defect #6)

**Files:** Modify: `AI Usage Dashboard.html`, Create: `tests/checks/20-csv-guards.mjs`

- [ ] **Step 1: Write the failing check** — create `tests/checks/20-csv-guards.mjs`:

```js
import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);

  const cells = await page.evaluate(() => [
    csvCell('=HYPERLINK("http://evil")'), csvCell('+1'), csvCell('-2'), csvCell('@x'),
    csvCell('\tx'), csvCell('normal'), csvCell('has,comma'), csvCell('has"quote'),
  ]);
  ok('csv: formula prefixes neutralized',
    cells[0] === `'=HYPERLINK("http://evil")` && cells[1] === "'+1" && cells[2] === "'-2" &&
    cells[3] === "'@x" && cells[4] === "'\tx",
    JSON.stringify(cells));
  ok('csv: normal quoting intact',
    cells[5] === 'normal' && cells[6] === '"has,comma"' && cells[7] === '"has""quote"',
    JSON.stringify(cells));

  await page.close();
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
node tests/run.mjs
```

Expected: the two new checks FAIL (`csvCell is not defined`); baseline still passes.

- [ ] **Step 3: Implement.** In `AI Usage Dashboard.html`, add a top-level `csvCell` helper. Find this exact code:

```js
const fmtMetric = (n, metric) => metric === 'cost' ? fmtUSD(n) : fmtCompact(n);
```

Replace with:

```js
const fmtMetric = (n, metric) => metric === 'cost' ? fmtUSD(n) : fmtCompact(n);
/* CSV cell: neutralize spreadsheet formula prefixes, then apply CSV quoting */
const csvCell = (s) => {
  let v = String(s);
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
};
```

Then in `exportCSV()`, find:

```js
    for (const r of rows) {
      const cell = (s) => /[",\n]/.test(String(s)) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s);
      lines.push([r.d, cell(r.platform), cell(r.model), r.in || 0, r.cw || 0, r.cr || 0, r.out || 0, r.msgs || 0, r.est ? 1 : 0, Pricing.cost(r.model, r).toFixed(4)].join(','));
    }
```

Replace with:

```js
    for (const r of rows) {
      lines.push([r.d, csvCell(r.platform), csvCell(r.model), r.in || 0, r.cw || 0, r.cr || 0, r.out || 0, r.msgs || 0, r.est ? 1 : 0, Pricing.cost(r.model, r).toFixed(4)].join(','));
    }
```

- [ ] **Step 4: Run to verify it passes**

```bash
node tests/run.mjs
```

Expected: `7/7 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix: neutralize spreadsheet formula prefixes in CSV export (review #6)"
```

---

### Task 4: Fix CSV numeric validation (defect #13)

**Files:** Modify: `AI Usage Dashboard.html`, Modify: `tests/checks/20-csv-guards.mjs`, Modify: `tests/fixtures/gen.mjs`

- [ ] **Step 1: Add the bad-numbers fixture.** In `tests/fixtures/gen.mjs`, add at the end of `generate()` (before the closing brace):

```js
  fs.writeFileSync(path.join(OUT, 'generic-badnums.csv'),
    'date,platform,model,input_tokens,output_tokens,cost\n' +
    '2026-08-10,Gemini,gemini-3.5-flash,100,1e309,0.5\n' +      // Infinity output
    '2026-08-10,Gemini,gemini-3.5-flash,12junk,50,abc\n' +      // garbage number, garbage cost
    '2026-08-11,Gemini,gemini-3.5-flash,-40,60,-0.25\n');       // negative tokens (reject), negative cost (allow: credit)
```

- [ ] **Step 2: Write the failing check.** Append to the `run` function in `tests/checks/20-csv-guards.mjs` (before `await page.close();`):

```js
  const { readFixture } = await import('../lib/harness.mjs');
  const csv = readFixture('generic-badnums.csv');
  const parsed = await page.evaluate((text) => {
    const res = parseGenericCSV(text);
    const t = { in: 0, out: 0 };
    for (const r of res.rows) { t.in += r.in; t.out += r.out; }
    return { ...t, billed: res.billed.reduce((a, b) => a + b.amount, 0) };
  }, csv);
  ok('csv: non-finite and garbage numbers rejected, negatives rejected for tokens',
    parsed.in === 100 && parsed.out === 110,          // 1e309→0, 12junk→0, -40→0; out: 0+50+60
    JSON.stringify(parsed));
  ok('csv: cost column allows negative (credits), rejects garbage',
    Math.abs(parsed.billed - 0.25) < 1e-9,            // 0.5 + 0 (abc) + (-0.25)
    JSON.stringify(parsed));
```

- [ ] **Step 3: Run to verify the new checks fail** (`1e309` currently becomes `Infinity`; `-40` is accepted):

```bash
node tests/run.mjs
```

- [ ] **Step 4: Implement.** In `parseGenericCSV`, find:

```js
    const num = (i) => i >= 0 ? (parseFloat(String(c[i]).replace(/[,$]/g, '')) || 0) : 0;
    agg.add(d, platform, model, { in: num(iIn), out: num(iOut), cr: num(iCr), cw: num(iCw), msgs: iMsgs >= 0 ? num(iMsgs) : 1 });
    if (iCost >= 0 && c[iCost] !== '') billed.set(d, (billed.get(d) || 0) + num(iCost));
```

Replace with:

```js
    const num = (i) => {                       // counts: finite and non-negative only
      if (i < 0) return 0;
      const v = Number(String(c[i]).replace(/[,$\s]/g, ''));
      return Number.isFinite(v) && v >= 0 ? v : 0;
    };
    const numSigned = (i) => {                 // money: finite, negatives allowed (credits)
      if (i < 0) return 0;
      const v = Number(String(c[i]).replace(/[,$\s]/g, ''));
      return Number.isFinite(v) ? v : 0;
    };
    agg.add(d, platform, model, { in: num(iIn), out: num(iOut), cr: num(iCr), cw: num(iCw), msgs: iMsgs >= 0 ? num(iMsgs) : 1 });
    if (iCost >= 0 && c[iCost] !== '') billed.set(d, (billed.get(d) || 0) + numSigned(iCost));
```

- [ ] **Step 5: Run to verify all pass** — `node tests/run.mjs` → `9/9 checks passed`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "fix: validate CSV numbers - reject non-finite/garbage/negative counts (review #13)"
```

---

### Task 5: Fix UTC day-bucket shift (defect #9)

**Files:** Modify: `AI Usage Dashboard.html`, Create: `tests/checks/30-utc-days.mjs`

- [ ] **Step 1: Write the failing check** — create `tests/checks/30-utc-days.mjs`. It opens the page with a UTC-negative timezone so the bug manifests deterministically:

```js
import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser, { tz: 'America/New_York' });   // UTC-4/-5

  const days = await page.evaluate(() => {
    const anth = parseAnthropicUsage({ data: [{ starting_at: '2026-08-14T00:00:00Z',
      results: [{ model: 'claude-sonnet-5', uncached_input_tokens: 1, output_tokens: 1, num_requests: 1 }] }] });
    const oai = parseOpenAIUsage({ data: [{ start_time: 1786752000,   // 2026-08-14T00:00:00Z
      results: [{ model: 'gpt-5.4', input_tokens: 1, output_tokens: 1, num_model_requests: 1 }] }] });
    const csv = parseGenericCSV('date,platform,model,input_tokens\n2026-08-14,Gemini,gemini-3,5\n');
    return [anth.rows[0].d, oai.rows[0].d, csv.rows[0].d];
  });
  ok('utc: Anthropic bucket keeps its UTC calendar day', days[0] === '2026-08-14', days[0]);
  ok('utc: OpenAI bucket keeps its UTC calendar day', days[1] === '2026-08-14', days[1]);
  ok('utc: date-only CSV strings pass through literally', days[2] === '2026-08-14', days[2]);

  await page.close();
}
```

- [ ] **Step 2: Run to verify all three fail** (each returns `2026-08-13` in New York time): `node tests/run.mjs`

- [ ] **Step 3: Implement.** (a) Add a UTC helper. Find:

```js
const todayKey = () => dayKey(new Date());
```

Replace with:

```js
const todayKey = () => dayKey(new Date());
/* UTC variant — for provider day-buckets (which are UTC days), never for local timestamps */
const dayKeyUTC = (dateish) => {
  const d = dateish instanceof Date ? dateish : new Date(dateish);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
};
const RE_DATEONLY = /^\d{4}-\d{2}-\d{2}$/;
```

(b) In `parseAnthropicUsage`, replace `const d = dayKey(bucket.starting_at || bucket.ending_at);` with `const d = dayKeyUTC(bucket.starting_at || bucket.ending_at);`

(c) In `parseAnthropicCost`, same replacement: `dayKey(` → `dayKeyUTC(` on its `bucket.starting_at || bucket.ending_at` line.

(d) In `parseOpenAIUsage`, replace `const d = dayKey((bucket.start_time || bucket.end_time) * 1000);` with `const d = dayKeyUTC((bucket.start_time || bucket.end_time) * 1000);`

(e) In `parseOpenAICost`, same replacement as (d).

(f) In `parseGenericCSV`, find:

```js
    const c = rows[r];
    const d = dayKey(c[iDate]);
```

Replace with:

```js
    const c = rows[r];
    const rawDate = String(c[iDate] || '').trim();
    const d = RE_DATEONLY.test(rawDate) ? rawDate : dayKey(rawDate);
```

- [ ] **Step 4: Run to verify all pass** — `node tests/run.mjs` → `12/12 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix: UTC day extraction for provider buckets and date-only CSV strings (review #9)"
```

---

### Task 6: Fix sniffJSON first-bucket bug (defect #2)

**Files:** Modify: `AI Usage Dashboard.html`, Create: `tests/checks/40-sniff.mjs`

- [ ] **Step 1: Write the failing check** — create `tests/checks/40-sniff.mjs`:

```js
import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);

  const kinds = await page.evaluate(() => {
    const anthUsageEmptyFirst = { data: [
      { starting_at: '2026-08-01T00:00:00Z', results: [] },
      { starting_at: '2026-08-02T00:00:00Z', results: [{ uncached_input_tokens: 5, output_tokens: 2, model: 'claude-sonnet-5' }] },
    ] };
    const anthCostEmptyFirst = { data: [
      { starting_at: '2026-08-01T00:00:00Z', results: [] },
      { starting_at: '2026-08-02T00:00:00Z', results: [{ amount: { value: '1.5', currency: 'USD' } }] },
    ] };
    const oaiCostEmptyFirst = { data: [
      { start_time: 1780000000, results: [] },
      { start_time: 1780086400, results: [{ amount: { value: 2.5, currency: 'usd' } }] },
    ] };
    const allEmpty = { data: [
      { starting_at: '2026-08-01T00:00:00Z', results: [] },
      { starting_at: '2026-08-02T00:00:00Z', results: [] },
    ] };
    return [
      sniffJSON(anthUsageEmptyFirst, 'a.json'),
      sniffJSON(anthCostEmptyFirst, 'b.json'),
      sniffJSON(oaiCostEmptyFirst, 'c.json'),
      sniffJSON(allEmpty, 'd.json'),
    ];
  });
  ok('sniff: anthropic usage w/ empty first bucket', kinds[0] === 'anthropic-usage', kinds[0]);
  ok('sniff: anthropic cost w/ empty first bucket', kinds[1] === 'anthropic-cost', kinds[1]);
  ok('sniff: openai COST w/ empty first bucket is NOT usage', kinds[2] === 'openai-cost', kinds[2]);
  ok('sniff: all-empty report is its own case', kinds[3] === 'empty-report', kinds[3]);

  await page.close();
}
```

- [ ] **Step 2: Run to verify the 4 new checks fail**: `node tests/run.mjs`

- [ ] **Step 3: Implement.** Replace the whole `sniffJSON` function. Find:

```js
function sniffJSON(obj, fileName) {
  if (obj && Array.isArray(obj.data) && obj.data.length) {
    const b = obj.data[0];
    const r = (b.results && b.results[0]) || {};
    const isUnixBucket = typeof b.start_time === 'number';
    if ('amount' in r) return isUnixBucket ? 'openai-cost' : 'anthropic-cost';
    if ('input_cached_tokens' in r || isUnixBucket) return 'openai-usage';
    if ('uncached_input_tokens' in r || 'cache_read_input_tokens' in r || 'output_tokens' in r) return 'anthropic-usage';
  }
```

Replace with:

```js
function sniffJSON(obj, fileName) {
  if (obj && Array.isArray(obj.data) && obj.data.length) {
    // find the first bucket that actually has results — providers emit empty buckets for zero-usage days
    const withResult = obj.data.find(b => b && Array.isArray(b.results) && b.results.length);
    const isUnixBucket = obj.data.some(b => b && typeof b.start_time === 'number');
    if (!withResult) return 'empty-report';
    const r = withResult.results[0];
    if ('amount' in r) return isUnixBucket ? 'openai-cost' : 'anthropic-cost';
    if ('input_cached_tokens' in r || isUnixBucket) return 'openai-usage';
    if ('uncached_input_tokens' in r || 'cache_read_input_tokens' in r || 'output_tokens' in r) return 'anthropic-usage';
  }
```

Then teach the import router about the new kind. In `handleImportFiles`, find:

```js
        } else {
          notes.push(`${f.name}: format not recognized`);
        }
```

Replace with:

```js
        } else if (kind === 'empty-report') {
          notes.push(`${f.name}: recognized usage/cost report, but every day in it is empty — nothing to import`);
        } else {
          notes.push(`${f.name}: format not recognized`);
        }
```

- [ ] **Step 4: Run to verify all pass** — `node tests/run.mjs` → `16/16 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix: sniff imports on first non-empty bucket; empty reports get own case (review #2)"
```

---

### Task 7: Billed-data staleness envelope (defect #10 / Codex #2)

**Files:** Modify: `AI Usage Dashboard.html`, Create: `tests/checks/50-billed-staleness.mjs`

Billed data changes shape from `Store.billed[src] = [{d, amount}]` to an **envelope** `{ rows: [{d, amount}], at: epochMs|null, stale: bool }`. Old persisted arrays are migrated on load.

- [ ] **Step 1: Write the failing check** — create `tests/checks/50-billed-staleness.mjs`:

```js
import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  // Seed old-format billed data to prove migration
  const seed = {
    sources: { anthropic: { rows: [{ d: '2026-08-10', platform: 'Anthropic API', model: 'claude-sonnet-5', in: 10, cw: 0, cr: 0, out: 5, msgs: 1 }], meta: {} } },
    billed: { anthropic: [{ d: '2026-08-10', amount: 3.5 }] },   // v1 array format
    projects: [],
  };
  const { page } = await openDashboard(browser, { seedData: seed });

  const migrated = await page.evaluate(() => {
    const env = Store.billed.anthropic;
    return { isEnv: !!env && !Array.isArray(env) && Array.isArray(env.rows), rows: Store.billedRows('anthropic').length };
  });
  ok('billed: old array format migrates to envelope', migrated.isEnv && migrated.rows === 1, JSON.stringify(migrated));

  const staleFlow = await page.evaluate(async () => {
    // fetch succeeds for usage but cost fetch FAILS → old billed must be kept but marked stale
    window.fetchAnthropicAll = async () => ({ usage: { rows: [{ d: '2026-08-11', platform: 'Anthropic API', model: 'claude-sonnet-5', in: 1, cw: 0, cr: 0, out: 1, msgs: 1 }] }, cost: null });
    document.getElementById('anthropic-key').value = 'sk-ant-admin-test';
    await App.fetchAnthropic();
    const env1 = Store.billed.anthropic;
    // now cost fetch returns a genuinely EMPTY window → billed becomes empty rows, not stale
    window.fetchAnthropicAll = async () => ({ usage: { rows: [] }, cost: [] });
    await App.fetchAnthropic();
    const env2 = Store.billed.anthropic;
    return { stale1: env1.stale, rows1: env1.rows.length, stale2: env2.stale, rows2: env2.rows.length };
  });
  ok('billed: failed cost fetch keeps old rows but marks stale', staleFlow.stale1 === true && staleFlow.rows1 === 1, JSON.stringify(staleFlow));
  ok('billed: empty cost fetch clears rows and is not stale', staleFlow.stale2 === false && staleFlow.rows2 === 0, JSON.stringify(staleFlow));

  await page.close();
}
```

- [ ] **Step 2: Run to verify the new checks fail** (`Store.billedRows is not a function`): `node tests/run.mjs`

- [ ] **Step 3: Implement.** (a) In `Store`, find:

```js
  load() {
    const saved = LS.get('data', null);
    if (saved) { this.sources = saved.sources || {}; this.billed = saved.billed || {}; this.projects = saved.projects || []; }
  },
```

Replace with:

```js
  load() {
    const saved = LS.get('data', null);
    if (saved) { this.sources = saved.sources || {}; this.billed = saved.billed || {}; this.projects = saved.projects || []; }
    // migrate v1 billed arrays to {rows, at, stale} envelopes
    for (const [k, v] of Object.entries(this.billed)) {
      if (Array.isArray(v)) this.billed[k] = { rows: v, at: null, stale: false };
    }
  },
  billedRows(id) {
    const v = this.billed[id];
    if (!v) return [];
    return Array.isArray(v) ? v : (v.rows || []);
  },
  setBilled(id, rows) {                    // rows: array (fresh), []: truthful empty, null: fetch failed → stale
    if (rows) this.billed[id] = { rows, at: Date.now(), stale: false };
    else if (this.billed[id]) this.billed[id] = { rows: this.billedRows(id), at: (this.billed[id].at ?? null), stale: true };
    this.persist();
  },
```

(b) In `fetchAnthropic`, find:

```js
      Store.setSource('anthropic', usage.rows, { days });
      if (cost && cost.length) { Store.billed.anthropic = cost; Store.persist(); }
```

Replace with:

```js
      Store.setSource('anthropic', usage.rows, { days });
      Store.setBilled('anthropic', cost);
```

(c) In `fetchOpenAI`, find:

```js
      Store.setSource('openai', usage.rows, { days });
      if (cost && cost.length) { Store.billed.openai = cost; Store.persist(); }
```

Replace with:

```js
      Store.setSource('openai', usage.rows, { days });
      Store.setBilled('openai', cost);
```

(d) In `handleImportFiles`, replace `Store.billed.anthropic = parseAnthropicCost(obj); Store.persist();` with `Store.setBilled('anthropic', parseAnthropicCost(obj));` and `Store.billed.openai = parseOpenAICost(obj); Store.persist();` with `Store.setBilled('openai', parseOpenAICost(obj));`

(e) KPI rendering. Find:

```js
    // actual billed
    let billed = 0, any = false;
    for (const list of Object.values(Store.billed)) {
      for (const b of list || []) if (b.d >= win.from && b.d <= win.to) { billed += b.amount; any = true; }
    }
    $('kpi-billed').textContent = any ? fmtUSD(billed) : '—';
    $('kpi-billed-note').textContent = any ? 'as reported by provider cost APIs' : 'Connect Anthropic/OpenAI admin keys';
```

Replace with:

```js
    // actual billed
    let billed = 0, any = false, anyStale = false;
    for (const id of Object.keys(Store.billed)) {
      const env = Store.billed[id];
      if (env && !Array.isArray(env) && env.stale) anyStale = true;
      for (const b of Store.billedRows(id)) if (b.d >= win.from && b.d <= win.to) { billed += b.amount; any = true; }
    }
    $('kpi-billed').textContent = any ? fmtUSD(billed) : '—';
    $('kpi-billed-note').textContent = any
      ? (anyStale ? '⚠ includes stale data — a cost fetch failed; re-sync to refresh' : 'as reported by provider cost APIs')
      : 'Connect Anthropic/OpenAI admin keys';
```

(f) CSV billed import writes an envelope too. In `handleImportFiles`, find:

```js
          if (res.billed && res.billed.length) { Store.billed.csv = (Store.billed.csv || []).concat(res.billed); Store.persist(); }
```

Replace with:

```js
          if (res.billed && res.billed.length) {
            const bm = new Map(Store.billedRows('csv').map(b => [b.d, b]));
            for (const b of res.billed) bm.set(b.d, b);           // re-import replaces same-day amounts
            Store.setBilled('csv', [...bm.values()].sort((a, b2) => a.d < b2.d ? -1 : 1));
          }
```

(Note: this also pre-fixes the billed half of Task 8's CSV merge — Task 8 handles the usage rows half.)

- [ ] **Step 4: Run to verify all pass** — `node tests/run.mjs` → `19/19 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix: billed-data envelope with staleness - failed cost fetch no longer masquerades as current (Codex #2)"
```

---

### Task 8: Fix CSV re-import double-counting (defect #1)

**Files:** Modify: `AI Usage Dashboard.html`, Create: `tests/checks/60-merge-dedupe.mjs`

- [ ] **Step 1: Write the failing check** — create `tests/checks/60-merge-dedupe.mjs`:

```js
import { openDashboard } from '../lib/harness.mjs';

const CSV = 'date,platform,model,input_tokens,output_tokens,cost\n' +
            '2026-08-10,Gemini,gemini-3.5-flash,100,50,1.0\n' +
            '2026-08-11,Gemini,gemini-3.5-flash,200,80,2.0\n';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);

  const totals = await page.evaluate(async (csvText) => {
    const mkFile = () => new File([csvText], 'gemini-usage.csv', { type: 'text/csv' });
    await App.handleImportFiles([mkFile()]);
    await App.handleImportFiles([mkFile()]);        // drop the SAME file again
    const rows = Store.sources.csv.rows;
    const t = { in: 0, out: 0, n: rows.length };
    for (const r of rows) { t.in += r.in; t.out += r.out; }
    t.billed = Store.billedRows('csv').reduce((a, b) => a + b.amount, 0);
    return t;
  }, CSV);
  ok('merge: re-dropping the same CSV does not double usage',
    totals.n === 2 && totals.in === 300 && totals.out === 130, JSON.stringify(totals));
  ok('merge: re-dropping the same CSV does not double billed', Math.abs(totals.billed - 3.0) < 1e-9, totals.billed);

  await page.close();
}
```

- [ ] **Step 2: Run to verify both fail** (v1 concats: 4 rows, in=600, billed=6): `node tests/run.mjs`

- [ ] **Step 3: Implement.** In `handleImportFiles`, find:

```js
        if (f.name.endsWith('.csv')) {
          const res = parseGenericCSV(await f.text());
          Store.setSource('csv', (Store.sources.csv ? Store.sources.csv.rows : []).concat(res.rows), res.meta);
```

Replace with:

```js
        if (f.name.endsWith('.csv')) {
          const res = parseGenericCSV(await f.text());
          // merge by (day, platform, model): re-imports replace matching rows instead of duplicating
          const keyOf = (r) => r.d + '\u0001' + r.platform + '\u0001' + r.model;
          const merged = new Map((Store.sources.csv ? Store.sources.csv.rows : []).map(r => [keyOf(r), r]));
          for (const r of res.rows) merged.set(keyOf(r), r);
          Store.setSource('csv', [...merged.values()], res.meta);
```

(The billed half was already converted to day-keyed replacement in Task 7 step 3f.) Also update the note line just below from `imported ${res.meta.rows} CSV rows` to `imported ${res.meta.rows} CSV rows (merged by day/platform/model)`.

- [ ] **Step 4: Run to verify all pass** — `node tests/run.mjs` → `21/21 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix: CSV re-imports merge by day/platform/model instead of double-counting (review #1)"
```

---

### Task 9: Fix local/local-import double-counting + project persistence (defects #3, #10) and remove NUL separators

**Files:** Modify: `AI Usage Dashboard.html`, Modify: `tests/checks/60-merge-dedupe.mjs`

Approach: every row parsed from a `.jsonl` gets a `sid` (session id = file basename, which is the session UUID). `Store.allRows()` drops `local-import` rows whose `sid` also exists in the folder-scanned `local` source. This also replaces the literal NUL (0x00) separator bytes in `makeAgg`/`parseClaudeLogs` with `'\u0001'` escapes (part of the NUL cleanup; the rest is Task 15).

- [ ] **Step 1: Write the failing check.** Append inside `run` in `tests/checks/60-merge-dedupe.mjs` (before `await page.close();`):

```js
  const fs2 = await import('node:fs');
  const path2 = await import('node:path');
  const { OUT } = await import('../lib/harness.mjs');
  const sessText = fs2.readFileSync(path2.join(OUT, 'claude-logs', 'projects', '-D--proj1', 'sess-aaa.jsonl'), 'utf8');
  const dd = await page.evaluate(async (text) => {
    localStorage.removeItem('aiusage:data');
    Store.sources = {}; Store.billed = {}; Store.projects = [];
    // 1) same session arrives via the dropzone...
    await App.handleImportFiles([new File([text], 'sess-aaa.jsonl')]);
    // 2) ...and via the folder scan
    const res = await parseClaudeLogs([{ path: 'projects/-D--proj1/sess-aaa.jsonl', file: new File([text], 'sess-aaa.jsonl') }], null);
    Store.projects = res.projects;
    Store.setSource('local', res.rows, res.meta);
    const t = { in: 0, msgs: 0 };
    for (const r of Store.allRows()) { t.in += r.in; t.msgs += r.msgs; }
    t.persistedProjects = (JSON.parse(localStorage.getItem('aiusage:data')).projects || []).length;
    return t;
  }, sessText);
  ok('dedupe: same session via folder + dropzone counted once', dd.in === 110 && dd.msgs === 2, JSON.stringify(dd));
  ok('dedupe: projects persisted to localStorage', dd.persistedProjects > 0, dd.persistedProjects);
```

- [ ] **Step 2: Run — first new check fails** (v1 double-counts: in=220, msgs=4): `node tests/run.mjs`

- [ ] **Step 3: Implement.** (a) Replace the ENTIRE `makeAgg` function. Locate it by its unique first line `function makeAgg() {` — do not try to exact-match its body: the current body contains literal NUL (0x00) separator bytes that render invisibly. The new function (note the visible \u0001 escapes and the new optional `sid` parameter):

```js
function makeAgg() {
  const map = new Map(); // day / platform / model [/ sid] -> bundle
  return {
    add(d, platform, model, t, sid) {
      if (!d) return;
      const key = d + '\u0001' + platform + '\u0001' + model + '\u0001' + (sid || '');
      let b = map.get(key);
      if (!b) { b = { d, platform, model, in: 0, cw: 0, cr: 0, out: 0, msgs: 0, est: t.est ? 1 : 0 }; if (sid) b.sid = sid; map.set(key, b); }
      b.in += t.in || 0; b.cw += t.cw || 0; b.cr += t.cr || 0; b.out += t.out || 0; b.msgs += t.msgs || 0;
      if (t.est) b.est = 1;
    },
    rows() { return [...map.values()]; }
  };
}
```

(b) In `parseClaudeLogs`, find:

```js
    const m = path.match(/(?:^|\/)projects\/([^/]+)\//);
    let projectDir = m ? m[1] : null;
    let projectCwd = null;
```

Replace with:

```js
    const m = path.match(/(?:^|\/)projects\/([^/]+)\//);
    let projectDir = m ? m[1] : null;
    let projectCwd = null;
    const sid = (path.split('/').pop() || '').replace(/\.jsonl$/i, '');   // session UUID = file basename
```

Then find `agg.add(d, 'Claude Code/Desktop', model, t);` and replace with `agg.add(d, 'Claude Code/Desktop', model, t, sid);`

Also in `parseClaudeLogs`, the project-key statement contains an invisible literal NUL separator. Locate it by the unique prefix `const pk = projName` and replace the whole statement so it reads (visible escape):

```js
      const pk = projName + '\u0001' + model;
```

(c) Cross-source dedupe in `Store`. Find:

```js
  allRows() { return Object.values(this.sources).flatMap(s => s.rows || []); },
```

Replace with:

```js
  allRows() {
    const localSids = new Set(((this.sources.local || {}).rows || []).map(r => r.sid).filter(Boolean));
    return Object.entries(this.sources).flatMap(([id, s]) => {
      let rows = s.rows || [];
      if (id === 'local-import' && localSids.size) rows = rows.filter(r => !r.sid || !localSids.has(r.sid));
      return rows;
    });
  },
```

(d) Project persistence. In `handleImportFiles`, find:

```js
        const res = await parseClaudeLogs(jsonlFiles, null);
        Store.setSource('local-import', res.rows, res.meta);
        if (res.projects.length && !Store.projects.length) Store.projects = res.projects;
```

Replace with:

```js
        const res = await parseClaudeLogs(jsonlFiles, null);
        if (res.projects.length && !Store.sources.local) Store.projects = res.projects;   // folder scan wins; assign BEFORE persist
        Store.setSource('local-import', res.rows, res.meta);
```

- [ ] **Step 4: Run to verify all pass** — `node tests/run.mjs` → `23/23 checks passed`. Baseline totals check must STILL pass (rows now carry `sid`, totals unchanged).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix: session-id dedupe across local sources; persist imported projects; NUL->U+0001 separators (reviews #3, #10)"
```

---

### Task 10: Fix ChatGPT branch inflation (Codex #4)

**Files:** Modify: `AI Usage Dashboard.html`, Create: `tests/checks/70-chatgpt-branches.mjs`

- [ ] **Step 1: Write the failing check** — create `tests/checks/70-chatgpt-branches.mjs`:

```js
import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);

  const res = await page.evaluate(() => {
    // user asks once; assistant answered (A, t=100, 4000 chars), user hit regenerate → B (t=200, 400 chars).
    // Active branch = root -> user -> B. Node A is a dead branch and must NOT be counted.
    const conv = {
      create_time: 100, current_node: 'B',
      mapping: {
        root: { id: 'root', parent: null, children: ['u1'], message: null },
        u1:   { id: 'u1', parent: 'root', children: ['A', 'B'],
                message: { author: { role: 'user' }, create_time: 50, content: { content_type: 'text', parts: ['hi'.repeat(20)] } } },
        A:    { id: 'A', parent: 'u1', children: [],
                message: { author: { role: 'assistant' }, create_time: 100, metadata: { model_slug: 'gpt-5.4' }, content: { content_type: 'text', parts: ['x'.repeat(4000)] } } },
        B:    { id: 'B', parent: 'u1', children: [],
                message: { author: { role: 'assistant' }, create_time: 200, metadata: { model_slug: 'gpt-5.4' }, content: { content_type: 'text', parts: ['y'.repeat(400)] } } },
      },
    };
    const out = parseChatGPTExport([conv]);
    const t = { msgs: out.meta.msgs, out: 0 };
    for (const r of out.rows) t.out += r.out;
    return t;
  });
  // active branch only: 1 assistant reply, out = estTok(400) = 100
  ok('chatgpt: dead branches not counted', res.msgs === 1 && res.out === 100, JSON.stringify(res));

  await page.close();
}
```

- [ ] **Step 2: Run to verify it fails** (v1 counts both A and B: msgs=2, out=1100): `node tests/run.mjs`

- [ ] **Step 3: Implement.** In `parseChatGPTExport`, find:

```js
    const nodes = Object.values(conv.mapping)
      .map(n => n && n.message).filter(Boolean)
      .filter(m => m.author && (m.author.role === 'user' || m.author.role === 'assistant'))
      .sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
```

Replace with:

```js
    // Follow only the ACTIVE branch: walk the parent chain up from current_node.
    // Regenerated/edited siblings live in mapping too and must not be counted.
    const mapping = conv.mapping;
    let leafId = conv.current_node && mapping[conv.current_node] ? conv.current_node : null;
    if (!leafId) {   // fallback: leaf = node holding the latest message timestamp
      let bestT = -1;
      for (const [id, n] of Object.entries(mapping)) {
        const t = (n && n.message && n.message.create_time) || 0;
        if (t > bestT) { bestT = t; leafId = id; }
      }
    }
    const chain = [];
    let guard = 0;
    for (let id = leafId; id && mapping[id] && guard++ < 100000; id = mapping[id].parent) {
      const msg = mapping[id].message;
      if (msg && msg.author && (msg.author.role === 'user' || msg.author.role === 'assistant')) chain.push(msg);
    }
    const nodes = chain.reverse();
```

- [ ] **Step 4: Run to verify all pass** — `node tests/run.mjs` → `24/24 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix: count only the active ChatGPT conversation branch (Codex #4)"
```

---

### Task 11: Fix out-of-order refresh commits (Codex #7)

**Files:** Modify: `AI Usage Dashboard.html`, Create: `tests/checks/80-race.mjs`

- [ ] **Step 1: Write the failing check** — create `tests/checks/80-race.mjs`:

```js
import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);

  const winner = await page.evaluate(async () => {
    const delayed = (ms, rows) => new Promise((r) => setTimeout(() =>
      r({ usage: { rows }, cost: [] }), ms));
    const mkRow = (tag) => [{ d: '2026-08-12', platform: 'Anthropic API', model: tag, in: 1, cw: 0, cr: 0, out: 1, msgs: 1 }];
    document.getElementById('anthropic-key').value = 'sk-ant-admin-test';
    // OLD request resolves LAST (slow), NEW resolves first — new must win.
    let call = 0;
    window.fetchAnthropicAll = async () => (++call === 1 ? delayed(300, mkRow('OLD')) : delayed(10, mkRow('NEW')));
    const p1 = App.fetchAnthropic();
    const p2 = App.fetchAnthropic();
    await Promise.allSettled([p1, p2]);
    return Store.sources.anthropic.rows[0].model;
  });
  ok('race: superseded fetch cannot overwrite newer result', winner === 'NEW', winner);

  await page.close();
}
```

- [ ] **Step 2: Run to verify it fails** (v1: the slow OLD response lands last and wins): `node tests/run.mjs`

- [ ] **Step 3: Implement.** (a) Add generation counters to `App`. Find:

```js
  async fetchAnthropic() {
    const key = $('anthropic-key').value.trim();
    const status = $('anthropic-status');
```

Replace with:

```js
  _gen: { local: 0, anthropic: 0, openai: 0 },

  async fetchAnthropic() {
    const gen = ++this._gen.anthropic;
    const key = $('anthropic-key').value.trim();
    const status = $('anthropic-status');
```

Inside `fetchAnthropic`, find:

```js
      const { usage, cost } = await fetchAnthropicAll(key, days);
      Store.setSource('anthropic', usage.rows, { days });
```

Replace with:

```js
      const { usage, cost } = await fetchAnthropicAll(key, days);
      if (gen !== this._gen.anthropic) return;   // superseded by a newer fetch
      Store.setSource('anthropic', usage.rows, { days });
```

(b) Same pattern in `fetchOpenAI`: add `const gen = ++this._gen.openai;` as its first line, and insert `if (gen !== this._gen.openai) return;` immediately after its `const { usage, cost } = await fetchOpenAIAll(key, days);` line.

(c) Same for the folder scan. In `scanHandle`, find:

```js
      const res = await parseClaudeLogs(files, (done) => { prog.value = done; });
      Store.projects = res.projects;
```

Replace with:

```js
      const gen = ++this._gen.local;
      const res = await parseClaudeLogs(files, (done) => { prog.value = done; });
      if (gen !== this._gen.local) return;   // superseded by a newer scan
      Store.projects = res.projects;
```

(d) `refreshAll` awaits everything. Find:

```js
  refreshAll() {
    if (this.dirHandle) this.rescan();
    if (LS.get('key:anthropic', null) && $('anthropic-key').value) this.fetchAnthropic();
    if (LS.get('key:openai', null) && $('openai-key').value) this.fetchOpenAI();
    this.render();
  },
```

Replace with:

```js
  async refreshAll() {
    const jobs = [];
    if (this.dirHandle) jobs.push(this.rescan());
    if (LS.get('key:anthropic', null) && $('anthropic-key').value) jobs.push(this.fetchAnthropic());
    if (LS.get('key:openai', null) && $('openai-key').value) jobs.push(this.fetchOpenAI());
    await Promise.allSettled(jobs);
    this.render();
  },
```

- [ ] **Step 4: Run to verify all pass** — `node tests/run.mjs` → `25/25 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix: per-source generation counters - stale responses can no longer overwrite newer data (Codex #7)"
```

---

### Task 12: Chart bucketing for wide date ranges (defect #4)

**Files:** Modify: `AI Usage Dashboard.html`, Create: `tests/checks/90-bucketing.mjs`

- [ ] **Step 1: Write the failing check** — create `tests/checks/90-bucketing.mjs`:

```js
import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);

  const b = await page.evaluate(() => {
    const wide = bucketDays(dayRange('2020-01-01', '2026-08-01'));   // ~2400 days
    const mid = bucketDays(dayRange('2026-01-01', '2026-08-01'));    // ~213 days
    const small = bucketDays(dayRange('2026-08-01', '2026-08-14'));  // 14 days
    return {
      wideUnit: wide.unit, wideN: wide.buckets.length,
      midUnit: mid.unit, midN: mid.buckets.length,
      smallUnit: small.unit, smallN: small.buckets.length,
    };
  });
  ok('bucket: 6.5y range folds to months ≤160 cols', b.wideUnit === 'month' && b.wideN <= 160, JSON.stringify(b));
  ok('bucket: 7-month range folds to weeks ≤160 cols', b.midUnit === 'week' && b.midN <= 160, JSON.stringify(b));
  ok('bucket: short range stays daily', b.smallUnit === 'day' && b.smallN === 14, JSON.stringify(b));

  // DOM-level: seed 400 days of data, select All, count hit-bands
  const seed = { sources: { csv: { rows: [], meta: {} } }, billed: {}, projects: [] };
  let d = '2025-07-01';
  for (let i = 0; i < 400; i++) {
    seed.sources.csv.rows.push({ d, platform: 'Gemini', model: 'gemini-3', in: 10, cw: 0, cr: 0, out: 5, msgs: 1 });
    const dt = new Date(d + 'T12:00:00'); dt.setDate(dt.getDate() + 1); d = dt.toISOString().slice(0, 10);
  }
  const { page: p2 } = await openDashboard(browser, { seedData: seed });
  const nBands = await p2.evaluate(async () => {
    document.querySelector('#range-presets button[data-days="all"]')?.click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return document.querySelectorAll('#daily-chart .colband').length;
  });
  ok('bucket: 400-day All view renders ≤160 hit-bands', nBands > 0 && nBands <= 160, nBands);
  await p2.close();

  await page.close();
}
```

*Note:* if the "All" preset button has no `data-days="all"` attribute, check the HTML — the presets are buttons inside `#range-presets`; click the one whose text is `All` instead:
`[...document.querySelectorAll('#range-presets button')].find(b => b.textContent.trim() === 'All')?.click()`.

- [ ] **Step 2: Run to verify the new checks fail** (`bucketDays is not defined`): `node tests/run.mjs`

- [ ] **Step 3: Implement.** (a) Add `bucketDays` right after the `dayRange` helper. Find:

```js
const dayRange = (from, to) => { const out = []; let k = from; let guard = 0; while (k <= to && guard++ < 4000) { out.push(k); k = addDays(k, 1); } return out; };
```

Replace with:

```js
const dayRange = (from, to) => { const out = []; let k = from; let guard = 0; while (k <= to && guard++ < 4000) { out.push(k); k = addDays(k, 1); } return out; };
/* Fold a day list into week/month buckets when it exceeds what the pixel width can show */
function bucketDays(days, maxCols = 160) {
  if (days.length <= maxCols) return { buckets: days.map(d => ({ key: d, days: [d] })), unit: 'day' };
  const unit = Math.ceil(days.length / 7) <= maxCols ? 'week' : 'month';
  const map = new Map();
  for (const d of days) {
    let k;
    if (unit === 'week') {
      const dt = new Date(d + 'T12:00:00');
      k = addDays(d, -((dt.getDay() + 6) % 7));         // Monday-start week
    } else k = d.slice(0, 7) + '-01';
    let b = map.get(k);
    if (!b) { b = { key: k, days: [] }; map.set(k, b); }
    b.days.push(d);
  }
  return { buckets: [...map.values()], unit };
}
```

(b) Apply bucketing inside `renderStackedColumns`. Find:

```js
function renderStackedColumns(container, { days, series, metric }) {
  clear(container);
```

Replace with:

```js
function renderStackedColumns(container, { days, series, metric }) {
  const { buckets, unit } = bucketDays(days);
  if (unit !== 'day') {
    const idx = new Map(days.map((d, i) => [d, i]));
    series = series.map(s => ({ ...s, values: buckets.map(b => b.days.reduce((a, d) => a + (s.values[idx.get(d)] || 0), 0)) }));
    days = buckets.map(b => b.key);
  }
  clear(container);
```

(c) Make the tooltip title honest about bucket width. In `renderStackedColumns`, find:

```js
    Tooltip.show(clientX, clientY, new Date(days[i] + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
```

Replace with:

```js
    const ttTitle = unit === 'week' ? 'Week of ' + fmtDayShort(days[i])
      : unit === 'month' ? new Date(days[i] + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : new Date(days[i] + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    Tooltip.show(clientX, clientY, ttTitle,
```

(d) Update the chart hint. In the HTML, `#daily-hint` exists; no change needed — but the aria label per band should reflect the unit. Find:

```js
      'aria-label': `${d}: ${fmtMetric(totals[i] || 0, metric)} total`
```

Replace with:

```js
      'aria-label': `${unit === 'day' ? d : (unit === 'week' ? 'week of ' + d : d.slice(0, 7))}: ${fmtMetric(totals[i] || 0, metric)} total`
```

- [ ] **Step 4: Run to verify all pass** — `node tests/run.mjs` → `29/29 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix: bucket wide date ranges into weeks/months - bounded DOM, readable bars (review #4)"
```

---

### Task 13: Import parse feedback + large-file warning (defect #8)

**Files:** Modify: `AI Usage Dashboard.html`, Create: `tests/checks/95-ui-misc.mjs`

- [ ] **Step 1: Write the failing check** — create `tests/checks/95-ui-misc.mjs`:

```js
import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);

  // A per-file "Parsing…" status must appear before heavy work; we detect it by
  // instrumenting appendChild on the status node before importing.
  const sawParsing = await page.evaluate(async () => {
    const status = document.getElementById('import-status');
    const texts = [];
    const orig = status.appendChild.bind(status);
    status.appendChild = (n) => { texts.push(n.textContent); return orig(n); };
    const csv = 'date,platform,model,input_tokens\n2026-08-10,Gemini,gemini-3,5\n';
    await App.handleImportFiles([new File([csv], 'tiny.csv', { type: 'text/csv' })]);
    status.appendChild = orig;
    return texts.some(t => /Parsing tiny\.csv/.test(t));
  });
  ok('import: shows per-file Parsing status before work', sawParsing, '');

  await page.close();
}
```

- [ ] **Step 2: Run to verify it fails**: `node tests/run.mjs`

- [ ] **Step 3: Implement.** In `handleImportFiles`, find:

```js
    for (const f of files) {
      try {
        if (f.name.endsWith('.jsonl')) { jsonlFiles.push({ path: f.name, file: f }); continue; }
```

Replace with:

```js
    for (const f of files) {
      try {
        status.appendChild(el('div', { text: `Parsing ${f.name}…` }));
        if (f.size > 200 * 1024 * 1024) status.appendChild(el('div', { text: `${f.name} is ${Math.round(f.size / 1048576)} MB — this may take a minute; the tab may briefly freeze.` }));
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));   // paint before blocking parse
        if (f.name.endsWith('.jsonl')) { jsonlFiles.push({ path: f.name, file: f }); continue; }
```

And so the interim "Parsing…" lines don't linger, find:

```js
    for (const n of notes) status.appendChild(el('div', { text: n }));
    this.render();
```

Replace with:

```js
    clear(status);
    for (const n of notes) status.appendChild(el('div', { text: n }));
    this.render();
```

- [ ] **Step 4: Run to verify all pass** — `node tests/run.mjs` → `30/30 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix: per-file parsing status + large-import warning before blocking parse (review #8)"
```

---

### Task 14: Keep API keys out of the DOM (unverified-note fix, spec "carried in")

**Files:** Modify: `AI Usage Dashboard.html`, Modify: `tests/checks/95-ui-misc.mjs`

The PowerShell fallback commands currently interpolate the typed key into on-page `<pre>` text. Replace with `Read-Host` so the command prompts for the key when run — the key never appears in the DOM or shell history.

- [ ] **Step 1: Write the failing check.** Append inside `run` in `tests/checks/95-ui-misc.mjs` (before `await page.close();`):

```js
  const keyLeak = await page.evaluate(() => {
    const SECRET = 'sk-ant-admin-SECRETSECRET';
    const inp = document.getElementById('anthropic-key');
    inp.value = SECRET;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('keyup', { bubbles: true }));
    return document.documentElement.outerHTML.includes('SECRETSECRET') ||
           document.getElementById('anthropic-cmd').textContent.includes('SECRETSECRET');
  });
  ok('security: typed key never appears in DOM text', keyLeak === false, '');
```

- [ ] **Step 2: Run to verify it fails** (v1 mirrors the key into `#anthropic-cmd`): `node tests/run.mjs`

*(If it unexpectedly passes, search the file for the code that updates `anthropic-cmd`/`openai-cmd` on input — the wiring may only fire on specific events; adapt the dispatched event to match, then confirm it fails before fixing.)*

- [ ] **Step 3: Implement.** (a) In `anthropicPSCommand`, find:

```js
function anthropicPSCommand(key, days) {
  const k = key || 'PASTE_YOUR_ADMIN_KEY';
  return `$k = "${k}"
```

Replace with:

```js
function anthropicPSCommand(_key, days) {
  return `$k = Read-Host "Paste your Anthropic Admin key"
```

(b) In `openaiPSCommand`, find:

```js
function openaiPSCommand(key, days) {
  const k = key || 'PASTE_YOUR_ADMIN_KEY';
  return `$k = "${k}"
```

Replace with:

```js
function openaiPSCommand(_key, days) {
  return `$k = Read-Host "Paste your OpenAI Admin key"
```

(c) Stop passing (and reacting to) the key. Find:

```js
  updatePSCommands() {
    $('anthropic-cmd').textContent = anthropicPSCommand($('anthropic-key').value.trim(), parseInt($('anthropic-days').value, 10));
    $('openai-cmd').textContent = openaiPSCommand($('openai-key').value.trim(), parseInt($('openai-days').value, 10));
  },
```

Replace with:

```js
  updatePSCommands() {
    $('anthropic-cmd').textContent = anthropicPSCommand(null, parseInt($('anthropic-days').value, 10));
    $('openai-cmd').textContent = openaiPSCommand(null, parseInt($('openai-days').value, 10));
  },
```

And find:

```js
    for (const id of ['anthropic-key', 'anthropic-days', 'openai-key', 'openai-days']) $(id).addEventListener('input', () => this.updatePSCommands());
```

Replace with:

```js
    for (const id of ['anthropic-days', 'openai-days']) $(id).addEventListener('input', () => this.updatePSCommands());
```

- [ ] **Step 4: Run to verify all pass** — `node tests/run.mjs` → `31/31 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "security: PowerShell fallback prompts for key via Read-Host - key never rendered into DOM"
```

---

### Task 15: Surface localStorage quota failures + NUL sweep (unverified-note fixes)

**Files:** Modify: `AI Usage Dashboard.html`, Modify: `tests/checks/95-ui-misc.mjs`

- [ ] **Step 1: Write the failing checks.** Append inside `run` in `tests/checks/95-ui-misc.mjs` (before `await page.close();`):

```js
  const quotaSurfaced = await page.evaluate(() => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
    try { LS.set('probe', { x: 1 }); } finally { Storage.prototype.setItem = orig; }
    return document.body.textContent.includes('storage is full');
  });
  ok('storage: quota failure surfaces in the UI', quotaSurfaced, '');
```

And add a Node-side byte scan at the very end of the file (after the closing brace of `run`):

```js
export async function postRun({ ok }) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const html = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'AI Usage Dashboard.html'));
  ok('hygiene: no NUL bytes remain in the HTML file', !html.includes(0), '');
}
```

Then wire `postRun` into `tests/run.mjs`: find `await mod.run({ browser, ok });` and replace with:

```js
  await mod.run({ browser, ok });
  if (mod.postRun) await mod.postRun({ ok });
```

- [ ] **Step 2: Run to verify both fail** (no quota banner; NUL bytes still present in the pricing/other sections if any remain): `node tests/run.mjs`

*(If the NUL check passes already — Task 9 removed them all — that is fine; keep the check as a regression guard and continue.)*

- [ ] **Step 3: Implement quota surfacing.** Find:

```js
  set(k, v) { try { localStorage.setItem('aiusage:' + k, JSON.stringify(v)); } catch (e) { console.warn('localStorage full?', e); } },
```

Replace with:

```js
  set(k, v) {
    try { localStorage.setItem('aiusage:' + k, JSON.stringify(v)); }
    catch (e) {
      console.warn('localStorage full?', e);
      const s = document.getElementById('import-status');
      if (s && !s.textContent.includes('storage is full')) {
        s.appendChild(el('div', { class: 'err', text: 'Warning: browser storage is full — new data may not persist. Export a CSV backup, or Clear stored data.' }));
      }
    }
  },
```

Then sweep any remaining literal NUL bytes: run `node -e "const fs=require('fs');const b=fs.readFileSync('AI Usage Dashboard.html');console.log([...b].map((v,i)=>v===0?i:null).filter(v=>v!==null))"` — for each offset found, Read that region and replace the byte with the appropriate visible escape (`\u0001` separator or remove it). After Task 9 the expected remaining count is 0–2 (a comment near `makeAgg` was already rewritten; check the `renderShareBar`/`seriesFor` key-join sites).

- [ ] **Step 4: Run to verify all pass** — `node tests/run.mjs` → `33/33 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix: surface storage-quota failures in UI; remove remaining NUL bytes"
```

---

### Task 16: Full verification + theme screenshots + wrap-up

**Files:** Modify: `docs/superpowers/reviews/2026-08-15-v1-code-review.md` (status column only)

- [ ] **Step 1: Full suite, twice** (second run proves fixture regeneration is deterministic)

```bash
node tests/run.mjs && node tests/run.mjs
```

Expected: `33/33 checks passed` both times, exit 0.

- [ ] **Step 2: Theme smoke screenshots.** Run this one-off script (do not commit it):

```bash
node -e "
import('./tests/lib/harness.mjs').then(async ({ launch, openDashboard }) => {
  const fs = await import('node:fs');
  fs.mkdirSync('tests/artifacts', { recursive: true });
  const b = await launch();
  for (const theme of ['light', 'dark']) {
    const { page, errors } = await openDashboard(b);
    await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); App.render(); }, theme);
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: 'tests/artifacts/' + theme + '.png', fullPage: true });
    if (errors.length) { console.error(theme, errors); process.exit(1); }
    await page.close();
  }
  await b.close();
  console.log('screenshots ok');
});
"
```

Expected: `screenshots ok`; visually inspect `tests/artifacts/light.png` and `dark.png` — cards, chart, KPIs render in both themes with no unstyled regions.

- [ ] **Step 3: Verify the file is still self-contained and reasonably sized**

```bash
node -e "const s=require('fs').statSync('AI Usage Dashboard.html');console.log(s.size,'bytes');process.exit(s.size>300*1024?1:0)"
```

Expected: ~112–125 KB, exit 0.

- [ ] **Step 4: Mark defects fixed in the review doc.** In `docs/superpowers/reviews/2026-08-15-v1-code-review.md`, append at the very end:

```markdown

## Status — 2026-08-15 (post Plan 1)

All 13 verified defects fixed in v1.1 (commits in this repo, one per fix), each with a regression check in `tests/checks/`. Suite: 33 checks green.
```

- [ ] **Step 5: Final commit**

```bash
git add -A && git commit -m "docs: mark review defects fixed; theme smoke artifacts ignored"
```

---

## Self-review notes (already applied)

1. **Spec coverage:** All 13 defects in the spec's "v1 defects folded into v2" section map to Tasks 3–12 (defects 1–4, 6, 8–13) plus Tasks 14–15 (the two "carried in" unverified notes: key-in-DOM, quota surfacing, NUL bytes, project persistence in Task 9). Defect #5 (connector registry) and #7 (incremental scan cache) are **deliberately deferred to Plan 2** — the registry IS Plan 2's core, and the incremental cache belongs with the connector rework so it is built once, not twice. Plan 2 must open with both.
2. **Check-count arithmetic** assumes each task's counts add up exactly as listed; if an engineer adds an extra assertion, the trailing expected totals shift — treat "all checks pass, exit 0" as the real gate, the numbers as guidance.
3. **The dashboard HTML contains invisible NUL bytes until Task 9/15** — never try to exact-match code blocks that span the `makeAgg`/`parseClaudeLogs` key lines; the plan's old-code blocks deliberately avoid them.
4. **`window()` / `rowsIn()`** referenced in `exportCSV` are existing v1 App methods — no task defines them because no task changes them.

