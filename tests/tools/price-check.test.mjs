// Node-level test for docs/tools/price-check.mjs (Plan 10 Task 1 — price-list freshness) — no browser, no network. The suite runs it from
// tests/checks/89f-price-check.mjs; alone:  node tests/tools/price-check.test.mjs
// A stub http server on 127.0.0.1 (port 0) serves fake pricing pages — an HTML table (with a <script> price that must be ignored and a
// longer id that shares the prefix of a shorter one), prose "$2.00 / 1M tokens", prose "2.00 per million", "USD 3.00", a page that names
// the id but has no figure near it, a JS-only page with no figure at all, a 500 — plus one URL on a closed port. An in-memory rows fixture
// (one source_url: null row, one override) points at them; checkRows() runs with the stub; every status, the drift detail (both numbers),
// the report shape, the coverage maths, one fetch per distinct URL, the User-Agent, exitCodeFor() and renderMarkdown() are asserted.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRows, classifyRow, exitCodeFor, extractRates, renderMarkdown } from '../../docs/tools/price-check.mjs';

const CLI = path.join(import.meta.dirname, '..', '..', 'docs', 'tools', 'price-check.mjs');

/** run the CLI as a child (killed after 30 s) → { status, signal, stdout, stderr } */
const runCli = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill(), 30000);
  child.on('exit', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
});

const PAGES = {
  '/table': `<html><head><title>Stub pricing</title><style>td { color: red; } /* $999 */</style></head><body>
    <script>var teaser = "$999 per 1M";</script>
    <p>New: test-model-a now supports a 1M context. Fine-tuning from $25.00 per 1M training tokens and $3.00 per 1M inference tokens.
    ${'Read the announcement for the full details of the launch. '.repeat(4)}</p>
    <h1>Model pricing</h1>
    <table>
      <tr><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th></tr>
      <tr><td>test-model-a-mini</td><td>$0.10</td><td>$0.025</td><td>$0.40</td></tr>
      <tr><td>test-model-a</td><td>$2.00</td><td>$0.50</td><td>$8.00</td></tr>
      <tr><td>test-model-b</td><td>$1.00</td><td>$0.25</td><td>$4.00</td></tr>
    </table></body></html>`,
  '/prose': `<html><body><p>Test Prose Model costs $2.00 / 1M input tokens and $8.00 / 1M output tokens.</p>
    <p>The test-usd model is priced at USD 3.00 per million input tokens and USD 9.00 per million output tokens.</p></body></html>`,
  '/million': `<html><body><h2>test-million</h2><p>Input: 2.00 per million tokens. Output: 6.00 per million tokens.</p></body></html>`,
  '/nonum': `<html><body><h2>test-nonum</h2><p>${'Contact sales for pricing. '.repeat(20)}</p><p>Enterprise seat: $500 per month.</p></body></html>`,
  '/jsonly': `<html><body><div id="app">test-jsonly</div><script>window.__DATA__ = { price: 1.5 };</script></body></html>`,
  '/single': `<html><body><p>test-single runs at $0.25 per 1M tokens on our fastest hardware.</p></body></html>`,
};

function startStub() {
  const hits = {}; const agents = new Set();
  const server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    agents.add(req.headers['user-agent'] || '');
    if (req.url === '/err500') { res.writeHead(500, { 'content-type': 'text/plain' }); return res.end('boom'); }
    const html = PAGES[req.url];
    if (!html) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, agents, base: `http://127.0.0.1:${server.address().port}` })));
}

/** a port that nothing listens on: bind, read the number, close */
const closedPort = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

const row = (vendor, label, ids, inP, outP, source_url) => ({ vendor, label, ids, pat: ids[0] || label, in: inP, out: outP, cw: 0, cr: 0, unit_note: 'USD per 1M', source_url, verified_on: '2026-10-15', confidence: 'high', notes: '' });

function fixture(base, closed) {
  const rows = [
    row('StubA', 'Test Model A', ['test-model-a'], 2, 8, base + '/table'),
    row('StubA', 'Test Model B', ['test-model-b'], 1.25, 5, base + '/table'),
    row('StubA', 'Test Model A mini', ['test-model-a-mini'], 0.1, 0.4, base + '/table'),
    row('StubA', 'Test Retired', ['test-retired'], 1, 1, base + '/table'),
    row('StubA', 'Test No Source', ['test-nosource'], 1, 2, null),
    row('StubB', 'Test Prose Model', ['test-prose'], 2, 8, base + '/prose'),
    row('StubB', 'Test USD', ['test-usd'], 3, 9, base + '/prose'),
    row('StubB', 'Test Million', ['test-million'], 2, 6, base + '/million'),
    row('StubC', 'Test No Number', ['test-nonum'], 1, 2, base + '/nonum'),
    row('StubC', 'Test JS only', ['test-jsonly'], 1.5, 1.5, base + '/jsonly'),
    row('StubC', 'Test Single Figure', ['test-single'], 0.25, 0.69, base + '/single'),
    row('StubD', 'Test 500', ['test-500'], 1, 2, base + '/err500'),
    row('StubD', 'Test Closed', ['test-closed'], 1, 2, `http://127.0.0.1:${closed}/pricing`),
  ];
  const overrides = [{ ...row('ignored', 'Test Model A (StubCloud)', ['test-model-a'], 2, 8, base + '/table'), platform: 'StubCloud' }];
  delete overrides[0].vendor;
  return { rows, overrides };
}

const STATUS_KEYS = ['match', 'drift', 'id_missing', 'page_unreachable', 'unknown', 'no_source'];
const ROW_KEYS = ['vendor', 'label', 'ids', 'source_url', 'status', 'ours', 'page', 'detail'];
const sameKeys = (o, keys) => !!o && typeof o === 'object' && Object.keys(o).sort().join() === [...keys].sort().join();

export async function run() {
  const results = [];
  const add = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail) });
  const summary = () => ({ pass: results.every((r) => r.pass), detail: results.filter((r) => !r.pass).map((r) => r.name + ': ' + r.detail).join(' | '), results });
  const stub = await startStub();
  try {
    const rates = extractRates(PAGES['/table']);
    add('price-check: extractRates strips <script>/<style> (no $999) and lists the teaser + table figures in page order with their text offsets',
      Array.isArray(rates.figures) && !rates.figures.some((f) => f.value === 999) && rates.figures.map((f) => f.value).join(',') === '25,3,0.1,0.025,0.4,2,0.5,8,1,0.25,4'
        && rates.figures.every((f, i, a) => Number.isInteger(f.index) && (i === 0 || f.index > a[i - 1].index)) && typeof rates.text === 'string' && !rates.text.includes('<td>'),
      JSON.stringify(rates.figures).slice(0, 400));
    const cls = classifyRow(row('StubA', 'Test Model A', ['test-model-a'], 2, 8, 'x'), rates.text);
    add('price-check: classifyRow finds the id with a token boundary ("test-model-a" is not matched inside "test-model-a-mini") and prefers the anchor that matches (the table row) over the teaser whose figures drift',
      cls.status === 'match' && cls.page && cls.page.in === 2 && cls.page.out === 8, JSON.stringify(cls));

    const { rows, overrides } = fixture(stub.base, await closedPort());
    const report = await checkRows(rows, overrides, { fetchImpl: globalThis.fetch });
    const by = (label) => report.rows.find((r) => r.label === label) || {};
    const st = (label) => by(label).status;
    add('price-check: report shape {checked_on, summary:{six counts, coverage:{overall:{compared,total,pct}, byVendor}}, rows:[{vendor,label,ids,source_url,status,ours,page,detail}]}',
      /^\d{4}-\d{2}-\d{2}/.test(report.checked_on) && sameKeys(report.summary, [...STATUS_KEYS, 'coverage']) && sameKeys(report.summary.coverage, ['overall', 'byVendor'])
        && sameKeys(report.summary.coverage.overall, ['compared', 'total', 'pct']) && report.rows.length === 14 && report.rows.every((r) => sameKeys(r, ROW_KEYS) && sameKeys(r.ours, ['in', 'out'])),
      JSON.stringify({ checked_on: report.checked_on, summary: report.summary, keys: report.rows.map((r) => Object.keys(r).join('+'))[0] }).slice(0, 600));
    add('price-check: table page → match (a, a-mini), drift (b), id-missing (retired); the override is checked too and carries its platform as vendor',
      st('Test Model A') === 'match' && st('Test Model A mini') === 'match' && st('Test Model B') === 'drift' && st('Test Retired') === 'id-missing'
        && st('Test Model A (StubCloud)') === 'match' && by('Test Model A (StubCloud)').vendor === 'StubCloud',
      report.rows.filter((r) => r.vendor === 'StubA' || r.vendor === 'StubCloud').map((r) => `${r.label}=${r.status}`).join(' '));
    const d = by('Test Model B');
    add('price-check: the drift row carries both numbers — page {in:1,out:4} vs ours {in:1.25,out:5} — and names them in detail',
      d.page && d.page.in === 1 && d.page.out === 4 && d.ours.in === 1.25 && d.ours.out === 5 && /1(\.00)?\b.*4(\.00)?\b/.test(d.detail) && /1\.25.*\b5\b/.test(d.detail), JSON.stringify(d));
    add('price-check: prose "$2.00 / 1M" (found by label when no id is on the page), "USD 3.00 per million" and "2.00 per million" (no $) all → match',
      st('Test Prose Model') === 'match' && st('Test USD') === 'match' && st('Test Million') === 'match',
      report.rows.filter((r) => r.vendor === 'StubB').map((r) => `${r.label}=${r.status}:${r.detail}`).join(' | '));
    add('price-check: id found but no figure within the window → unknown (page: null); a page with no figure at all → unknown "no prices in static HTML (JS-rendered?)"; one lone figure for a two-price row → unknown, not drift',
      st('Test No Number') === 'unknown' && by('Test No Number').page === null && st('Test JS only') === 'unknown' && by('Test JS only').detail === 'no prices in static HTML (JS-rendered?)'
        && st('Test Single Figure') === 'unknown' && /only one figure.*0\.25/.test(by('Test Single Figure').detail),
      report.rows.filter((r) => r.vendor === 'StubC').map((r) => `${r.label}=${r.status}:${r.detail}`).join(' | '));
    add('price-check: HTTP 500 and a closed port → page-unreachable with the error in detail (nothing thrown)',
      st('Test 500') === 'page-unreachable' && /500/.test(by('Test 500').detail) && st('Test Closed') === 'page-unreachable' && /ECONNREFUSED|fetch failed/i.test(by('Test Closed').detail),
      report.rows.filter((r) => r.vendor === 'StubD').map((r) => `${r.label}=${r.status}:${r.detail}`).join(' | '));
    add('price-check: source_url null → no-source (informational), page null', st('Test No Source') === 'no-source' && by('Test No Source').page === null, JSON.stringify(by('Test No Source')));
    const s = report.summary;
    add('price-check: summary counts match=6 drift=1 id_missing=1 page_unreachable=2 unknown=3 no_source=1',
      s.match === 6 && s.drift === 1 && s.id_missing === 1 && s.page_unreachable === 2 && s.unknown === 3 && s.no_source === 1, JSON.stringify(s));
    const cov = s.coverage;
    add('price-check: coverage = (match + drift) / rows with a source: overall 7/13 = 53.8 %; per vendor StubA 3/4, StubB 3/3, StubC 0/3, StubD 0/2, StubCloud 1/1; no entry for a vendor without sources',
      cov.overall.compared === 7 && cov.overall.total === 13 && cov.overall.pct === 53.8
        && JSON.stringify(cov.byVendor) === JSON.stringify({ StubA: { compared: 3, total: 4, pct: 75 }, StubB: { compared: 3, total: 3, pct: 100 }, StubC: { compared: 0, total: 3, pct: 0 }, StubD: { compared: 0, total: 2, pct: 0 }, StubCloud: { compared: 1, total: 1, pct: 100 } }),
      JSON.stringify(cov));
    add('price-check: one fetch per distinct URL (4 rows share /table → 1 hit; /prose 1; 7 pages in all) with User-Agent "ROSTUM price-check"',
      stub.hits['/table'] === 1 && stub.hits['/prose'] === 1 && Object.values(stub.hits).reduce((a, b) => a + b, 0) === 7 && [...stub.agents].every((a) => a === 'ROSTUM price-check'),
      JSON.stringify({ hits: stub.hits, agents: [...stub.agents] }));
    const withSummary = (patch) => ({ ...report, summary: { ...s, ...patch, coverage: { ...cov, overall: { ...cov.overall, ...(patch.coverage || {}) } } } });
    add('price-check: exitCodeFor → 1 on drift>0; 1 on coverage<70 with no drift; 0 when drift=0 and coverage ≥ 70',
      exitCodeFor(report) === 1 && exitCodeFor(withSummary({ drift: 0, coverage: { pct: 69.9 } })) === 1 && exitCodeFor(withSummary({ drift: 0, coverage: { pct: 70 } })) === 0,
      `report=${exitCodeFor(report)} lowcov=${exitCodeFor(withSummary({ drift: 0, coverage: { pct: 69.9 } }))} ok=${exitCodeFor(withSummary({ drift: 0, coverage: { pct: 70 } }))}`);
    const md = renderMarkdown(report);
    add('price-check: renderMarkdown has the summary table, the per-vendor coverage, one line per non-match row (drift line with both numbers) and no line for match rows',
      /\| match \| 6 \|/.test(md) && /StubA \| 3 \| 4 \| 75/.test(md) && /drift.*Test Model B.*1(\.00)?.*4(\.00)?.*1\.25.*\b5\b/.test(md) && /id-missing.*Test Retired/.test(md)
        && /page-unreachable.*Test Closed/.test(md) && /no-source.*Test No Source/.test(md) && !/Test Model A mini/.test(md),
      md.slice(0, 1200));
    const specFile = path.join(os.tmpdir(), `price-check-rows-${process.pid}.json`), jsonOut = path.join(os.tmpdir(), `price-check-report-${process.pid}.json`);
    fs.writeFileSync(specFile, JSON.stringify({ generated: '2026-10-15', rows, overrides, retired_aliases: [] }));
    try {
      const t0 = Date.now();
      const cli = await runCli(['--rows', specFile, '--json', jsonOut]);   // async: the stub in THIS process must keep answering while the child runs
      const written = fs.existsSync(jsonOut) ? JSON.parse(fs.readFileSync(jsonOut, 'utf8')) : null;
      add('price-check: CLI --rows <json> --json <out> prints the markdown report, writes the JSON report, exits 1 (drift + coverage below the floor) and does so within 10 s',
        cli.status === 1 && /^# ROSTUM price check/.test(cli.stdout) && /`drift` StubA · Test Model B/.test(cli.stdout) && written && written.summary.drift === 1 && written.rows.length === 14 && Date.now() - t0 < 10000,
        `status=${cli.status} signal=${cli.signal} ms=${Date.now() - t0} stderr=${cli.stderr.slice(0, 300)} stdout=${cli.stdout.slice(0, 200)}`);
    } finally {
      for (const f of [specFile, jsonOut]) fs.rmSync(f, { force: true });
    }
    return summary();
  } catch (e) {
    add('price-check: test threw', false, e && e.stack || String(e));
    return summary();
  } finally {
    await new Promise((r) => stub.server.close(r));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const r = await run();
  for (const x of r.results) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass ? '' : '  — ' + x.detail}`);
  console.log(`\n${r.results.filter((x) => x.pass).length}/${r.results.length} checks passed`);
  process.exitCode = r.pass ? 0 : 1;   // not process.exit(): on Node 25 / Windows an immediate exit while the stub's keep-alive sockets close trips a libuv assertion
}
