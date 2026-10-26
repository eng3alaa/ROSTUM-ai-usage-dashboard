#!/usr/bin/env node
/**
 * price-check.mjs — zero-dependency Node tool (Node ≥ 20) that re-fetches every vendor pricing page named in the price spec
 * (docs/superpowers/specs/2026-10-15-price-rows.json) and reports, per row, whether the page still says what we have. It never
 * changes data: a human reads the report, edits the JSON and re-runs tests/tools/sync-prices.mjs.
 *
 * Run:      node docs/tools/price-check.mjs [--rows <json>] [--json <out>] [--quiet]
 *           --rows <json>   another spec file of the same shape ({rows, overrides}); default: the spec above
 *           --json <out>    also write the full report as JSON
 *           --quiet         print only the one-line summary instead of the markdown report
 *           Exit 1 when any row drifted OR overall coverage is below 70 %, else 0.
 *
 * One generic extractor, no per-vendor scrapers: the page's static HTML is reduced to text (scripts, styles, tags stripped), every
 * USD-per-1M-looking figure is located ("$2.00", "USD 3.00", "2.00 per million", "2.00 / 1M"), then each row's ids (token-bounded,
 * case-insensitive) and finally its label are looked up; the figures within a bounded window after the hit are compared with the
 * row's `in` and `out` (±0.005). Statuses:
 *   match             both numbers found after an anchor
 *   drift             anchor found with figures, but not both of ours  → detail "page says X / Y, we have A / B"
 *   id-missing        neither an id nor the label is on the page (retired? renamed?)
 *   page-unreachable  fetch error or non-2xx (the error is the detail)
 *   unknown           anchor found but no parseable figure near it — or the page has no figure at all (JS-rendered)
 *   no-source         the row has source_url: null (informational — not counted in coverage)
 * Coverage = (match + drift) / rows that have a source, overall and per vendor (an override's platform is its vendor).
 *
 * Fetching: global fetch, 20 s timeout per page, 3 pages at a time, User-Agent "ROSTUM price-check", one fetch per distinct URL.
 * A fetch failure is a row status, never an exception.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROWS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'superpowers', 'specs', '2026-10-15-price-rows.json');
const USER_AGENT = 'ROSTUM price-check';
const TIMEOUT_MS = 20000;
const CONCURRENCY = 3;
const WINDOW_CHARS = 200;        // text after an anchor that may hold its prices (one table row or one prose sentence)
const TOLERANCE = 0.005;
const COVERAGE_FLOOR_PCT = 70;
const NO_FIGURES_DETAIL = 'no prices in static HTML (JS-rendered?)';
const STATUS_ORDER = ['drift', 'id-missing', 'unknown', 'page-unreachable', 'no-source'];

// ------------------------------------------------------------------ page text ------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);

/** static HTML → one line of plain text (scripts, styles, comments and tags gone; whitespace collapsed) */
export function htmlToText(html) {
  const stripped = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

// a money figure: "$2.00", "US$ 2", "USD 3.00", "3.00 USD", "2.00 per million", "2.00 / 1M", "2 per 1,000,000 tokens"
const NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const FIGURE_RE = new RegExp([
  String.raw`(?:US\$|\$|USD)\s*(${NUMBER})`,
  String.raw`(${NUMBER})\s*USD\b`,
  String.raw`(${NUMBER})\s*(?:per|\/)\s*(?:1\s*M\b|million|1,000,000|MTok)`,
].join('|'), 'gi');

const toNumber = (s) => Number(s.replace(/,/g, ''));

/** every money figure in `text`, in order, with its offset and a little surrounding text */
export function findFigures(text) {
  const figures = [];
  for (const m of text.matchAll(FIGURE_RE)) {
    const raw = m[1] ?? m[2] ?? m[3];
    const value = toNumber(raw);
    if (!Number.isFinite(value)) continue;
    figures.push({ value, index: m.index, context: text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20) });
  }
  return figures;
}

/** html → { text, figures } (the page text and every money figure in it) */
export function extractRates(html) {
  const text = htmlToText(html);
  return { text, figures: findFigures(text) };
}

// ------------------------------------------------------------------ per-row classification ------------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** offsets just after every token-bounded, case-insensitive occurrence of `needle` (an id is not matched inside a longer id) */
export function anchorsFor(text, needle) {
  if (!needle) return [];
  const re = new RegExp(String.raw`(?<![\w.\-/])${escapeRe(needle)}(?![\w.\-/])`, 'gi');
  return [...text.matchAll(re)].map((m) => m.index + m[0].length);
}

const near = (a, b) => Math.abs(a - b) <= TOLERANCE;
const figuresAfter = (figures, at) => figures.filter((f) => f.index >= at && f.index < at + WINDOW_CHARS);
const fmt = (n) => (n == null ? '?' : `$${n}`);

/** the page's in/out guess: the figure equal to ours when there is one, else the first figure (input) / the largest (output) */
function pageRates(values, row) {
  const pick = (ours, fallback) => values.find((v) => near(v, ours)) ?? fallback;
  return { in: pick(row.in, values[0]), out: pick(row.out, Math.max(...values)) };
}

function compareAt(row, found) {
  const values = found.map((f) => f.value);
  const page = pageRates(values, row);
  const seen = values.map(fmt).join(' ');
  if (near(page.in, row.in) && near(page.out, row.out)) return { status: 'match', page, detail: `figures seen: ${seen}` };
  if (values.length < 2) return { status: 'unknown', page: null, detail: `only one figure (${seen}) near the id — cannot tell input from output` };
  return { status: 'drift', page, detail: `page says ${fmt(page.in)} / ${fmt(page.out)} (figures seen: ${seen}), we have ${fmt(row.in)} / ${fmt(row.out)}` };
}

const RANK = { match: 0, drift: 1, unknown: 2 };
const bestOf = (verdicts) => verdicts.sort((a, b) => RANK[a.status] - RANK[b.status])[0];

/** one row against one page's text → { status, page, detail } (figures may be passed in when the page is shared by many rows);
 *  an id may occur several times (teaser, nav, table) — the verdict is the best one: a match anywhere beats a drift, a drift beats unknown */
export function classifyRow(row, pageText, figures = findFigures(pageText)) {
  if (figures.length === 0) return { status: 'unknown', page: null, detail: NO_FIGURES_DETAIL };
  const anchors = [...(row.ids || []), row.label].flatMap((needle) => anchorsFor(pageText, needle));
  if (anchors.length === 0) return { status: 'id-missing', page: null, detail: 'neither an id nor the label is on the page (retired? renamed?)' };
  const verdicts = anchors.map((at) => figuresAfter(figures, at)).filter((found) => found.length).map((found) => compareAt(row, found));
  return bestOf(verdicts) || { status: 'unknown', page: null, detail: `id found but no price figure within ${WINDOW_CHARS} chars of it` };
}

// ------------------------------------------------------------------ fetching ------------------------------------------------------------------

const errorText = (e) => (e && e.cause && e.cause.code) ? `${e.message} (${e.cause.code})` : (e && e.message) || String(e);

/** one page → { html } or { error } — never throws */
export async function fetchPage(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { error: `HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}` };
    return { html: await res.text() };
  } catch (e) {
    return { error: errorText(e) };
  }
}

/** run fn over items, at most `limit` at a time, keeping order */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function fetchPages(urls, fetchImpl, concurrency) {
  const pages = await mapLimit(urls, concurrency, (url) => fetchPage(url, fetchImpl));
  return new Map(urls.map((url, i) => [url, pages[i].error ? pages[i] : { ...pages[i], ...extractRates(pages[i].html) }]));
}

// ------------------------------------------------------------------ the report ------------------------------------------------------------------

const asEntry = (row, vendor) => ({ vendor, label: row.label, ids: row.ids || [], source_url: row.source_url || null, ours: { in: row.in, out: row.out } });

function rowResult(entry, page) {
  if (!entry.source_url) return { ...entry, status: 'no-source', page: null, detail: 'no source_url in the spec' };
  if (page.error) return { ...entry, status: 'page-unreachable', page: null, detail: page.error };
  return { ...entry, ...classifyRow({ ids: entry.ids, label: entry.label, ...entry.ours }, page.text, page.figures) };
}

const pct = (compared, total) => (total ? Math.round((1000 * compared) / total) / 10 : 0);

function coverageOf(rows) {
  const sourced = rows.filter((r) => r.status !== 'no-source');
  const tally = (list) => { const compared = list.filter((r) => r.status === 'match' || r.status === 'drift').length; return { compared, total: list.length, pct: pct(compared, list.length) }; };
  const byVendor = {};
  for (const vendor of [...new Set(sourced.map((r) => r.vendor))]) byVendor[vendor] = tally(sourced.filter((r) => r.vendor === vendor));
  return { overall: tally(sourced), byVendor };
}

function summarize(rows) {
  const count = (status) => rows.filter((r) => r.status === status).length;
  return { match: count('match'), drift: count('drift'), id_missing: count('id-missing'), page_unreachable: count('page-unreachable'), unknown: count('unknown'), no_source: count('no-source'), coverage: coverageOf(rows) };
}

/** rows + overrides (an override's platform is its vendor) → the report; opts: { fetchImpl, concurrency } */
export async function checkRows(rows, overrides = [], { fetchImpl = globalThis.fetch, concurrency = CONCURRENCY } = {}) {
  const entries = rows.map((r) => asEntry(r, r.vendor)).concat(overrides.map((o) => asEntry(o, o.platform)));
  const urls = [...new Set(entries.map((e) => e.source_url).filter(Boolean))];
  const pages = await fetchPages(urls, fetchImpl, concurrency);
  const results = entries.map((e) => rowResult(e, pages.get(e.source_url)));
  return { checked_on: new Date().toISOString().slice(0, 10), summary: summarize(results), rows: results };
}

/** 1 when any row drifted or overall coverage is under the floor, else 0 */
export function exitCodeFor(report) {
  const { drift, coverage } = report.summary;
  return drift > 0 || coverage.overall.pct < COVERAGE_FLOOR_PCT ? 1 : 0;
}

// ------------------------------------------------------------------ rendering ------------------------------------------------------------------

const summaryLine = (report) => {
  const s = report.summary, c = s.coverage.overall;
  return `price-check ${report.checked_on}: match ${s.match} · drift ${s.drift} · id-missing ${s.id_missing} · page-unreachable ${s.page_unreachable} · unknown ${s.unknown} · no-source ${s.no_source} · coverage ${c.compared}/${c.total} (${c.pct} %, floor ${COVERAGE_FLOOR_PCT} %)`;
};

const rowLine = (r) => `- \`${r.status}\` ${r.vendor} · ${r.label}${r.ids.length ? ` (${r.ids.join(', ')})` : ''} — ${r.detail}${r.source_url ? ` — ${r.source_url}` : ''}`;

export function renderMarkdown(report) {
  const s = report.summary, c = s.coverage;
  const out = [`# ROSTUM price check — ${report.checked_on}`, '', '| status | rows |', '|---|---|'];
  for (const [k, v] of Object.entries(s)) if (k !== 'coverage') out.push(`| ${k.replace('_', '-')} | ${v} |`);
  out.push('', `Coverage (match + drift over rows with a source): ${c.overall.compared}/${c.overall.total} = ${c.overall.pct} % (floor ${COVERAGE_FLOOR_PCT} %)`, '');
  out.push('## Coverage by vendor', '', '| vendor | compared | total | pct |', '|---|---|---|---|');
  for (const [vendor, t] of Object.entries(c.byVendor).sort((a, b) => a[1].pct - b[1].pct || a[0].localeCompare(b[0]))) out.push(`| ${vendor} | ${t.compared} | ${t.total} | ${t.pct} |`);
  out.push('', '## Rows needing attention', '');
  const attention = report.rows.filter((r) => r.status !== 'match').sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  out.push(...(attention.length ? attention.map(rowLine) : ['(none — every sourced row matches)']));
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { rows: DEFAULT_ROWS, json: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rows') opts.rows = argv[++i];
    else if (argv[i] === '--json') opts.json = argv[++i];
    else if (argv[i] === '--quiet') opts.quiet = true;
    else throw new Error(`unknown argument ${argv[i]} — usage: price-check.mjs [--rows <json>] [--json <out>] [--quiet]`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const spec = JSON.parse(fs.readFileSync(opts.rows, 'utf8'));
  const report = await checkRows(spec.rows, spec.overrides || []);
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(opts.quiet ? summaryLine(report) + '\n' : renderMarkdown(report));
  process.exitCode = exitCodeFor(report);   // let stdout drain and the fetch sockets close; process.exit() here trips a libuv assertion on Node 25 / Windows
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) await main();
