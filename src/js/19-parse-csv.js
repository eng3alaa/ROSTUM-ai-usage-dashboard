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
/* Cerebras Cloud Console → Analytics → Usage / Cached-Usage / Logs → Request Logs → "Download Report" CSV (Plan 9 B3). The column names are NOT documented
 * (research 2026-10-15: "sniff headers on import"), so this importer is source-based, not verified on a real file: it matches headers tolerantly — a
 * date/time column, a model column, input/prompt and output/completion token columns; optional cached (cache-hit) and fresh/uncached input columns (the
 * Cached-Usage report: fresh → in, cached → cr; with only a cached column, in = input − cached); optional requests column (else one request per row — the
 * Request Logs report is one row per request). Name-gated: the file name must contain "cerebras" (a date,model,input_tokens,output_tokens CSV without it is
 * the generic importer's), and a platform/provider column means a generic CSV whatever the name. Timestamps are UTC (the console says so) → UTC day.
 * Exact tokens (est 0), platform 'Cerebras'. `head` = header cells normalized to lowercase_with_underscores. */
const CEREBRAS_CSV_DATE = /date|time|^day$|period/, CEREBRAS_CSV_CACHED = /cached|cache_hit|cache_read/, CEREBRAS_CSV_FRESH = /fresh|uncached|non_cached|cache_miss/;
function isCerebrasUsageCSV(head, fileName) {
  if (!/cerebras/i.test(String(fileName || ''))) return false;
  const has = (re) => head.some(h => re.test(h));
  if (has(/^platform$|^provider$|^source$/)) return false;
  return has(CEREBRAS_CSV_DATE) && has(/^model/) && has(/input|prompt/) && has(/output|completion/);
}
function parseCerebrasUsageCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('Empty CSV');
  const head = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const find = (re, skip) => head.findIndex(h => re.test(h) && !(skip && skip.test(h)));
  const iDate = find(CEREBRAS_CSV_DATE), iModel = find(/^model/), iCached = find(CEREBRAS_CSV_CACHED), iFresh = find(CEREBRAS_CSV_FRESH),
        iIn = find(/input|prompt/, /cached|cache|fresh/), iOut = find(/output|completion/), iReq = find(/request|count|calls/);
  if (iDate < 0 || iModel < 0 || (iIn < 0 && iFresh < 0) || iOut < 0) throw new Error('Not a Cerebras usage CSV (needs date, model, input and output token columns)');
  const agg = makeAgg(); let n = 0, rejected = 0;
  const num = (c, i) => { if (i < 0) return 0; const raw = String(c[i] ?? '').trim(); if (!raw) return 0; const v = Number(raw.replace(/[,\s]/g, '')); if (Number.isFinite(v) && v >= 0) return v; rejected++; return 0; };
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r]; const raw = String(c[iDate] || '').trim(); const d = RE_DATEONLY.test(raw) ? raw : dayKeyUTC(raw);
    if (!d) { rejected++; continue; }
    const cached = num(c, iCached);
    const inTok = iFresh >= 0 ? num(c, iFresh) : Math.max(0, num(c, iIn) - cached);
    agg.add(d, 'Cerebras', String(c[iModel] || '').trim() || 'cerebras', { in: inTok, cr: cached, out: num(c, iOut), msgs: iReq >= 0 ? num(c, iReq) : 1 });
    n++;
  }
  return { rows: agg.rows(), meta: { rows: n, rejected, cachedColumn: iCached >= 0 } };
}/* Alibaba Cloud Model Studio bill CSV (Plan 9 B4) — console → Expenses and Costs → Bill Details → Billing Month → Product Name: Model Studio → Export Bill CSV.
 * The English docs do not publish the column schema (research 2026-10-15; the JP / ID pages give the Instance ID rule), so this importer is source-based, not
 * verified on a real export: it matches headers tolerantly and parses the semicolon-delimited Instance ID whose order is billingType;workspaceId;model;tokenType;
 * channel — the MODEL is the 3rd field (the llm-… 2nd field is the workspace id), the token type the 4th (input → in, output → out, cache types → cr / cw;
 * anything else is a dollars-only line), the channel the 5th (kept in meta). Usage × the Usage Unit (thousand / million are scaled) is exact tokens; the amount
 * column (Pretax Amount, else Payment Amount, else the first amount that is not gross / discount / coupon) is the billed cost per bill day. Day = Billing Time /
 * Usage Start / Service Period as printed (the bill's own day), else the Billing Cycle month's 1st (counted in meta.cycleDays). Lines of other products (a bill
 * exported without the product filter) are skipped and counted. Platform 'Alibaba Model Studio', est 0, msgs 0 (bills carry no request counts). */
const ALIBABA_BILL_DATE = /billing_time|usage_start|start_time|service_period|billing_date|^date$|^time$/, ALIBABA_BILL_CYCLE = /billing_cycle|billing_month|^cycle$/;
const ALIBABA_BILL_AMOUNT = /amount|^cost$|^fee$/, ALIBABA_BILL_NOT_BILLED = /gross|discount|coupon|voucher|round|outstanding/;
const ALIBABA_PRODUCT = /model.?studio|bailian|dashscope/i;
/** `head` = header cells normalized to lowercase_with_underscores: an Instance ID, a Usage and an amount column, and no platform / token columns (those are generic CSVs) */
function isAlibabaBillCSV(head) {
  const has = (re) => head.some(h => re.test(h));
  return has(/^instance_id$/) && has(/^usage$|^usage_quantity$|^quantity$/) && has(ALIBABA_BILL_AMOUNT) && !has(/^platform$|^provider$|^source$|token/);
}
/** header row → column indexes (−1 when absent); throws when the Instance ID, Usage or amount column is missing */
function alibabaBillColumns(headerRow) {
  const head = headerRow.map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const find = (re, skip) => head.findIndex(h => re.test(h) && !(skip && skip.test(h)));
  const col = { id: find(/^instance_id$/), usage: find(/^usage$|^usage_quantity$|^quantity$/), unit: find(/usage_unit|^unit$/), date: find(ALIBABA_BILL_DATE), cycle: find(ALIBABA_BILL_CYCLE),
    product: find(/^product_name$|^product_code$|^product$/), currency: find(/currency/), amount: find(/^pretax_amount$/) };
  if (col.amount < 0) col.amount = find(/^payment_amount$/);
  if (col.amount < 0) col.amount = find(ALIBABA_BILL_AMOUNT, ALIBABA_BILL_NOT_BILLED);
  if (col.id < 0 || col.usage < 0 || col.amount < 0) throw new Error('Not a Model Studio bill CSV (needs Instance ID, Usage and an amount column)');
  col.amountName = head[col.amount];
  return col;
}
/** the Usage Unit → multiplier: tokens as-is; thousand / K → ×1,000; million / M → ×1,000,000 */
function alibabaUnitScale(unit) {
  const u = String(unit || '').trim().toLowerCase();
  if (/^(k|thousand|1,?000)\b|千/.test(u)) return 1000;
  if (/^(m|million|1,?000,?000)\b|百万/.test(u)) return 1e6;
  return 1;
}
/** the 4th Instance ID field → the token bucket, or null for a dollars-only line (deployment, image, …) */
function alibabaTokenBucket(tokenType) {
  const t = String(tokenType || '').toLowerCase();
  if (/cache/.test(t)) return /creat|write|stor/.test(t) ? 'cw' : 'cr';
  if (/input|prompt/.test(t)) return 'in';
  if (/output|completion/.test(t)) return 'out';
  return null;
}
/** the bill's own day: the date column as printed (YYYY-MM-DD… or an ISO stamp), else the Billing Cycle month's 1st (meta.cycleDays++), else '' */
function alibabaBillDay(c, col, meta) {
  const raw = col.date >= 0 ? String(c[col.date] || '').trim() : '';
  if (RE_DATEONLY.test(raw.slice(0, 10))) return raw.slice(0, 10);
  const iso = raw ? dayKeyUTC(raw) : null;
  if (iso) return iso;
  const cycle = col.cycle >= 0 ? String(c[col.cycle] || '').trim() : '';
  if (/^\d{4}-\d{2}$/.test(cycle)) { meta.cycleDays++; return cycle + '-01'; }
  return '';
}
/** Usage × unit scale; a non-numeric or negative usage is rejected (counted) and books 0 tokens — the line's amount still counts */
function alibabaUsage(c, col, meta) {
  const raw = String(c[col.usage] ?? '').trim().replace(/[,\s]/g, '');
  const v = Number(raw);
  if (!raw || !Number.isFinite(v) || v < 0) { meta.rejected++; return 0; }
  return Math.round(v * alibabaUnitScale(col.unit >= 0 ? c[col.unit] : ''));
}
/** one bill line: product filter → day → amount into the day's billed total → tokens from the Instance ID + Usage */
function alibabaBillLine(c, col, acc) {
  const { agg, billed, channels, meta } = acc;
  if (col.product >= 0 && !ALIBABA_PRODUCT.test(String(c[col.product] || ''))) { meta.otherProducts++; return; }
  const d = alibabaBillDay(c, col, meta);
  if (!d) { meta.rejected++; return; }
  const [, , model = '', tokenType = '', channel = ''] = String(c[col.id] || '').split(';').map(s => s.trim());
  if (tokenType) meta.tokenTypes[tokenType] = (meta.tokenTypes[tokenType] || 0) + 1;
  if (channel) channels.add(channel);
  if (col.currency >= 0 && !meta.currency) meta.currency = String(c[col.currency] || '').trim();
  const amount = Number(String(c[col.amount] ?? '').replace(/[,\s]/g, ''));
  if (Number.isFinite(amount)) billed.set(d, (billed.get(d) || 0) + amount);
  meta.rows++;
  const bucket = alibabaTokenBucket(tokenType);
  if (!bucket) { meta.nonToken++; return; }
  agg.add(d, 'Alibaba Model Studio', model || 'unknown', { [bucket]: alibabaUsage(c, col, meta), msgs: 0 });
}
function parseAlibabaBillCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('Empty CSV');
  const col = alibabaBillColumns(rows[0]);
  const acc = { agg: makeAgg(), billed: new Map(), channels: new Set(), meta: { rows: 0, rejected: 0, nonToken: 0, otherProducts: 0, cycleDays: 0, tokenTypes: {}, amountColumn: col.amountName, currency: '' } };
  for (let r = 1; r < rows.length; r++) alibabaBillLine(rows[r], col, acc);
  const billed = [...acc.billed.entries()].map(([d, amount]) => ({ d, amount: finAmt(amount) })).sort((a, b) => a.d < b.d ? -1 : 1);
  return { rows: acc.agg.rows(), billed, meta: { ...acc.meta, channels: [...acc.channels].sort() } };
}



