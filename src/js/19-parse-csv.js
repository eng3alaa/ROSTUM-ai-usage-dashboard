/* =================================================================
 * 3) Generic CSV  (date, platform, model, input_tokens, output_tokens,
 *                  [cache_read_tokens], [cache_write_tokens], [cost_usd])
 * ================================================================= */
function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(c => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(c => c !== '')) rows.push(row);
  return rows;
}

function parseGenericCSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) throw new Error('Empty CSV');
  const head = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const idx = (names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  const iDate = idx(['date', 'day', 'timestamp']);
  const iPlat = idx(['platform', 'provider', 'source']);
  const iModel = idx(['model', 'model_id', 'model_name']);
  const iIn = idx(['input_tokens', 'input', 'prompt_tokens', 'in']);
  const iOut = idx(['output_tokens', 'output', 'completion_tokens', 'out']);
  const iCr = idx(['cache_read_tokens', 'cached_tokens', 'cache_read']);
  const iCw = idx(['cache_write_tokens', 'cache_creation_tokens', 'cache_write']);
  const iCost = idx(['cost_usd', 'cost', 'amount_usd', 'spend']);
  const iMsgs = idx(['messages', 'requests', 'count']);
  if (iDate < 0 || (iIn < 0 && iOut < 0 && iCost < 0)) throw new Error('CSV needs at least: date + input_tokens/output_tokens (or cost_usd)');
  const agg = makeAgg();
  const billed = new Map();
  let rejected = 0;   // non-empty cells coerced to 0 because they were non-finite/garbage/negative
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r];
    const rawDate = String(c[iDate] || '').trim();
    const d = RE_DATEONLY.test(rawDate) ? rawDate : dayKey(rawDate);
    if (!d) continue;
    const model = iModel >= 0 && c[iModel] ? c[iModel].trim() : 'unknown';
    let platform = iPlat >= 0 && c[iPlat] ? c[iPlat].trim() : '';
    if (!platform) platform = /gemini/i.test(model) ? 'Gemini' : 'Other';
    const num = (i) => {                       // counts: finite and non-negative only
      if (i < 0) return 0;
      const raw = String(c[i]);
      if (raw.trim() === '') return 0;
      const v = Number(raw.replace(/[,$\s]/g, ''));
      if (Number.isFinite(v) && v >= 0) return v;
      rejected++;
      return 0;
    };
    const numSigned = (i) => {                 // money: finite, negatives allowed (credits)
      if (i < 0) return 0;
      const raw = String(c[i]);
      if (raw.trim() === '') return 0;
      const v = Number(raw.replace(/[,$\s]/g, ''));
      if (Number.isFinite(v)) return v;
      rejected++;
      return 0;
    };
    agg.add(d, platform, model, { in: num(iIn), out: num(iOut), cr: num(iCr), cw: num(iCw), msgs: iMsgs >= 0 ? num(iMsgs) : 1 });
    if (iCost >= 0 && c[iCost] !== '') billed.set(d, (billed.get(d) || 0) + numSigned(iCost));
  }
  return { rows: agg.rows(), billed: [...billed.entries()].map(([d, amount]) => ({ d, amount })), meta: { rows: rows.length - 1, rejected } };
}

/* Cursor dashboard "usage events" CSV (individual users: cursor.com/dashboard → Usage → Export CSV). Header cells as
 * reported by users: Date, Kind, Model, Max Mode, Input (w/ Cache Write), Input (w/o Cache Write), Cache Read,
 * Output Tokens, Total Tokens[, Cost][, User]. Not officially documented → detected + parsed defensively.
 * Verified on real exports: the four token columns are ADDITIVE — "Input (w/ Cache Write)" = cache-write tokens,
 * "Input (w/o Cache Write)" = plain input, Cache Read, Output — and Total Tokens = their sum. Each row is reconciled against
 * Total Tokens: additive first; else the legacy superset reading (w/ − w/o = cache write); else counted in meta.unreconciled
 * (additive reading kept). No Total Tokens column → additive, nothing to reconcile against.
 * `head` = header cells normalized to lowercase_with_underscores. */
function isCursorUsageCSV(head) {
  return head.includes('kind') && head.includes('model') && head.some(h => /^input/.test(h)) && head.some(h => /^output/.test(h)) && (head.includes('max_mode') || head.some(h => /^cache_read/.test(h)));
}
function parseCursorUsageCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('Empty CSV');
  const head = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const find = (re) => head.findIndex(h => re.test(h));
  const iDate = find(/^(date|timestamp|time)$/), iModel = find(/^model$/), iInCw = find(/^input_w_cache_write/), iInNoCw = find(/^input_w_o_cache_write/),
        iIn = find(/^input(_tokens)?$/), iCr = find(/^cache_read/), iOut = find(/^output(_tokens)?$/), iTotal = find(/^total(_tokens)?$/), iCost = find(/^cost/);
  if (iDate < 0 || iModel < 0) throw new Error('Not a Cursor usage-events CSV (needs Date + Model columns)');
  const agg = makeAgg(); const billed = new Map(); let n = 0, rejected = 0, unreconciled = 0;
  const num = (c, i) => { if (i < 0) return 0; const raw = String(c[i] ?? '').trim(); if (!raw) return 0; const v = Number(raw.replace(/[,$\s]/g, '')); if (Number.isFinite(v) && v >= 0) return v; rejected++; return 0; };
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r]; const raw = String(c[iDate] || '').trim();
    const ts = new Date(raw); const d = RE_DATEONLY.test(raw) ? raw : dayKey(ts);
    if (!d) { rejected++; continue; }
    const model = String(c[iModel] || '').trim() || 'cursor';
    const inTok = iInNoCw >= 0 ? num(c, iInNoCw) : num(c, iIn); let cw = 0;
    const cr = num(c, iCr), out = num(c, iOut);
    if (iInCw >= 0 && iInNoCw >= 0) {
      const wCw = num(c, iInCw);   // additive columns (verified on real exports): w/ = cache-write tokens, w/o = plain input
      cw = wCw;
      if (iTotal >= 0) {
        const total = num(c, iTotal);
        if (wCw + inTok + cr + out === total) { /* additive — the confirmed shape */ }
        else if (wCw >= inTok && inTok + (wCw - inTok) + cr + out === total) cw = wCw - inTok;   // legacy superset reading: w/ − w/o = cache write
        else unreconciled++;   // neither reading sums to Total Tokens — keep additive, surface the count
      }
    }
    const hour = !RE_DATEONLY.test(raw) && !isNaN(ts) ? ts.getHours() : undefined;
    agg.add(d, 'Cursor', model, { in: inTok, cw, cr, out, msgs: 1 }, undefined, hour);
    n++;
    if (iCost >= 0 && String(c[iCost] ?? '').trim() !== '') { const v = Number(String(c[iCost]).replace(/[,$\s]/g, '')); if (Number.isFinite(v)) billed.set(d, (billed.get(d) || 0) + v); }
  }
  // splitInput: both "Input (w/ Cache Write)" and "Input (w/o Cache Write)" present (the four-additive-column shape); hasTotal: a Total Tokens column to reconcile against
  return { rows: agg.rows(), billed: [...billed.entries()].map(([d, amount]) => ({ d, amount })), meta: { rows: n, rejected, unreconciled, splitInput: iInCw >= 0 && iInNoCw >= 0, hasTotal: iTotal >= 0 } };
}

/* DeepSeek API monthly usage export (platform.deepseek.com/usage → Export monthly data → ZIP: amount-YYYY-MM.csv + cost-YYYY-MM.csv).
 * The layout is documented only by community parsers (github.com/shajanjp/deepseek-usage, deepseek-usage.xyz) and has changed once
 * (utc_date YYYY-MM-DD → YYYYMMDD, then start_time_iso / end_time_iso in place of utc_date — the day is the UTC day of start_time_iso, end_time_iso is
 * ignored), so both files are sniffed by header. The cost file is claimed on positive evidence only (the cost-*.csv name, or a header the export writes:
 * utc_date / api_key_name / currency / start_time_iso / wallet_type) and never when a token alias is present — date,model,cost CSVs are the generic importer's. Two shapes are accepted:
 *   long (seen in the wild): utc_date, model, api_key_name, type, [price,] amount — type ∈ input_cache_miss_tokens | input_cache_hit_tokens |
 *        output_tokens | request_count; one row per (day, model, key, type). miss → in, hit → cr, output → out, request_count → msgs.
 *        A price column is read as a PER-UNIT price (price × amount; the community reading) and only used when no cost CSV is present.
 *   wide: date, model, input/prompt…, cache-hit…, output/completion…, [requests]. ASSUMPTION: the input column is the TOTAL prompt
 *        tokens and cache-hit a subset → uncached in = input − hit (clamped at 0); a …miss… column, when present, is uncached directly.
 * `head` = header cells normalized to lowercase_with_underscores. Days are UTC days (the export's own granularity). */
function isDeepSeekAmountCSV(head, fileName) {
  const has = (re) => head.some(h => re.test(h));
  if (!has(/date|^day$|^start_time/) || !has(/^model/)) return false;   // utc_date (older layout) or start_time_iso (newer)
  if (has(/^type$/) && has(/^amount$/)) return true;                                   // long shape
  return has(/input|prompt/) && has(/output|completion/) && (has(/cache.*hit|hit/) || /(^|\/)amount-[^/]*\.csv$/i.test(String(fileName || '')));   // wide: a cache-hit column (or the export's file name) keeps generic CSVs out
}
function isDeepSeekCostCSV(head, fileName) {
  const has = (re) => head.some(h => re.test(h));
  // a token/usage column of any spelling (generic aliases in / out / input / output / prompt_tokens / completion_tokens / cache_read, Cursor, the amount file's type) means "not a cost file"
  if (has(/^(in|out)$|input|output|prompt|completion|cache|token|platform|provider|^type$/)) return false;
  if (!has(/date|^day$|^start_time/) || !has(/cost|spend|bill|^total/)) return false;
  return /(^|\/)cost-[^/]*\.csv$/i.test(String(fileName || '')) || has(/^utc_date$|^api_key_name$|^currency$|^start_time_iso$|^wallet_type$/);   // positive evidence only
}
const deepSeekDay = (raw) => { const s = String(raw || '').trim(); if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8); if (RE_DATEONLY.test(s)) return s; return dayKeyUTC(s); };
function parseDeepSeekAmountCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('Empty CSV');
  const head = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const find = (re) => head.findIndex(h => re.test(h));
  const iDate = find(/date|^day$|^start_time/), iModel = find(/^model/), iType = find(/^type$/), iAmount = find(/^amount$/), iPrice = find(/^price/),
        iMiss = find(/miss/), iIn = iMiss >= 0 ? iMiss : find(/input|prompt/), iHit = find(/cache.*hit|hit/), iOut = find(/output|completion/), iReq = find(/request|count|calls/);
  if (iDate < 0 || iModel < 0) throw new Error('Not a DeepSeek usage CSV (needs date + model columns)');
  const long = iType >= 0 && iAmount >= 0;
  const agg = makeAgg(); const billed = new Map(); let n = 0, rejected = 0;
  const num = (c, i) => { if (i < 0) return 0; const raw = String(c[i] ?? '').trim(); if (!raw) return 0; const v = Number(raw.replace(/[,\s]/g, '')); if (Number.isFinite(v) && v >= 0) return v; rejected++; return 0; };
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r]; const d = deepSeekDay(c[iDate]); if (!d) { rejected++; continue; }
    const model = String(c[iModel] || '').trim() || 'deepseek';
    if (long) {
      const type = String(c[iType] || '').trim().toLowerCase(), amt = num(c, iAmount), t = { in: 0, cr: 0, out: 0, msgs: 0 };
      if (/miss/.test(type)) t.in = amt; else if (/hit/.test(type)) t.cr = amt; else if (/output|completion/.test(type)) t.out = amt; else if (/request|count/.test(type)) t.msgs = amt; else if (/input|prompt/.test(type)) t.in = amt;
      else continue;   // an unknown type (a future reasoning_tokens row?) is skipped, not an error
      agg.add(d, 'DeepSeek API', model, t);
      if (iPrice >= 0 && !t.msgs) { const p = Number(String(c[iPrice] ?? '').trim()); if (Number.isFinite(p) && p >= 0 && amt) billed.set(d, (billed.get(d) || 0) + p * amt); }
      n++;
    } else {
      const hit = num(c, iHit), inRaw = num(c, iIn);
      agg.add(d, 'DeepSeek API', model, { in: iMiss >= 0 ? inRaw : Math.max(0, inRaw - hit), cr: hit, out: num(c, iOut), msgs: iReq >= 0 ? num(c, iReq) : 1 });
      n++;
    }
  }
  return { rows: agg.rows(), billed: [...billed.entries()].map(([d, amount]) => ({ d, amount })).sort((a, b) => a.d < b.d ? -1 : 1), meta: { rows: n, rejected, hasPrice: iPrice >= 0, shape: long ? 'long' : 'wide' } };
}
function parseDeepSeekCostCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('Empty CSV');
  const head = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const find = (re) => head.findIndex(h => re.test(h));
  const iDate = find(/date|^day$|^start_time/), iCost = find(/cost|spend|bill|^total/), iCur = find(/currency/);
  if (iDate < 0 || iCost < 0) throw new Error('Not a DeepSeek cost CSV (needs date + cost columns)');
  const billed = new Map(); let n = 0, rejected = 0, currency = '';
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r]; const d = deepSeekDay(c[iDate]); if (!d) { rejected++; continue; }
    const raw = String(c[iCost] ?? '').trim(); if (raw === '') continue;
    const v = Number(raw.replace(/[,\s$¥]/g, '')); if (!Number.isFinite(v)) { rejected++; continue; }   // money: negatives allowed (credits)
    billed.set(d, (billed.get(d) || 0) + v); n++;
    if (iCur >= 0 && !currency && c[iCur]) currency = String(c[iCur]).trim();
  }
  return { billed: [...billed.entries()].map(([d, amount]) => ({ d, amount })).sort((a, b) => a.d < b.d ? -1 : 1), meta: { rows: n, rejected, currency } };
}
/** The whole monthly ZIP (entries from readZipEntries): every .csv entry is classified by name or header; rows from all amount
 *  files are re-aggregated (two amount files may share a day/model); billed = the cost CSVs (the vendor's own figure) when present,
 *  else price × amount from the amount file, else none. meta.files === 0 ⇒ "this is not a DeepSeek usage ZIP". */
async function parseDeepSeekUsageZip(entries) {
  const norm = (cells) => cells.map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const rowsAll = [], priceBilled = new Map(), costBilled = new Map(); let n = 0, rejected = 0, amountFiles = 0, costFiles = 0, currency = '';
  for (const e of entries) {
    if (!/\.csv$/i.test(e.name) || e.size > 50 * 1024 * 1024) continue;
    const text = await e.text();
    const head = norm(parseCSV(text.split(/\r?\n/, 1)[0])[0] || []);
    if (isDeepSeekAmountCSV(head, e.name)) { const r = parseDeepSeekAmountCSV(text); rowsAll.push(...r.rows); for (const b of r.billed) priceBilled.set(b.d, (priceBilled.get(b.d) || 0) + b.amount); n += r.meta.rows; rejected += r.meta.rejected; amountFiles++; }
    else if (isDeepSeekCostCSV(head, e.name)) { const r = parseDeepSeekCostCSV(text); for (const b of r.billed) costBilled.set(b.d, (costBilled.get(b.d) || 0) + b.amount); rejected += r.meta.rejected; costFiles++; if (r.meta.currency && !currency) currency = r.meta.currency; }
  }
  const agg = makeAgg(); for (const r of rowsAll) agg.add(r.d, r.platform, r.model, r);
  const billedMap = costFiles ? costBilled : priceBilled;
  return { rows: agg.rows(), billed: [...billedMap.entries()].map(([d, amount]) => ({ d, amount })).sort((a, b) => a.d < b.d ? -1 : 1),
    meta: { rows: n, rejected, files: amountFiles + costFiles, amountFiles, costFiles, currency, billedFrom: costFiles ? 'cost CSV' : (priceBilled.size ? 'price column' : 'none') } };
}

/** A0 #9 — per-month bookkeeping behind Store.sources['deepseek-usage-zip'].meta: each import replaces the { rows, files } of the month(s) its
 *  rows cover, so meta.rows / meta.files (the sums) describe the stored months and never inflate when a month is imported again. */
function deepSeekMonthCounts(prevMeta, res) {
  const months = { ...((prevMeta || {}).months || {}) };
  months[[...new Set(res.rows.map(r => r.d.slice(0, 7)))].sort().join(',')] = { rows: res.meta.rows, files: res.meta.files };
  const sum = (k) => Object.values(months).reduce((a, m) => a + (m[k] || 0), 0);
  return { months, rows: sum('rows'), files: sum('files') };
}

/* Microsoft Copilot (consumer) activity-history CSV — account.microsoft.com/privacy → Copilot → Export all activity history. Columns are
 * not documented (prompts + responses with timestamps, an app/surface column on some exports) → matched tolerantly: a date/time column,
 * a prompt/query/request/user column, a response/answer/copilot/bot column, optional app/surface/product; a CSV with any token column is
 * NOT this format. Dates: ISO or 'M/D/YYYY H:MM[ AM|PM]' (local); unparseable → skipped and counted. Estimated tokens (prompt = input,
 * response = output), platform 'Microsoft Copilot', model 'copilot'; rows carry sid = file name (exports per surface merge). */
function isCopilotActivityCSV(head) {
  const has = (re) => head.some(h => re.test(h));
  return has(/date|time/) && has(/prompt|query|request|user/) && has(/response|answer|copilot|bot/) && !has(/token/);
}
function parseCopilotActivityCSV(text, fileName) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('Empty CSV');
  const head = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const find = (re) => head.findIndex(h => re.test(h));
  const iDate = find(/date|time/), iPrompt = find(/prompt|query|request|user/), iResp = find(/response|answer|copilot|bot/), iApp = find(/app|surface|product/);
  if (iDate < 0 || iPrompt < 0 || iResp < 0) throw new Error('Not a Copilot activity CSV (needs date + prompt + response columns)');
  const agg = makeAgg(); let n = 0, skipped = 0; const apps = new Set();
  const sid = String(fileName || 'copilot-activity');
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r];
    const ts = exportTimestamp(String(c[iDate] || '').trim());
    if (!ts) { skipped++; continue; }
    if (iApp >= 0 && c[iApp]) apps.add(String(c[iApp]).trim());
    agg.add(ts.d, 'Microsoft Copilot', 'copilot', { in: estTok(String(c[iPrompt] || '').length), out: estTok(String(c[iResp] || '').length), msgs: 1, est: 1 }, sid, ts.hour);
    n++;
  }
  return { rows: agg.rows(), meta: { rows: n, skipped, apps: [...apps], sid } };
}

