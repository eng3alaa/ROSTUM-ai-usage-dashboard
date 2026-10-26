/* =================================================================
 * 4) Provider API payloads (fetched directly or imported as JSON files)
 * ================================================================= */
/** Anthropic bucket shape — Admin usage_report/messages AND the Enterprise Analytics usage_report (identical fields; the
 *  Analytics report also carries `requests`). `platform` = the row's platform: 'Anthropic API' (default, Admin card) or
 *  'Claude Enterprise (org)' (Analytics card) — never mixed, each card is its own source. */
function parseAnthropicUsage(payload, platform = 'Anthropic API') {
  const agg = makeAgg();
  const data = payload && payload.data;
  if (!Array.isArray(data)) throw new Error('Not an Anthropic usage report');
  for (const bucket of data) {
    const d = dayKeyUTC(bucket.starting_at || bucket.ending_at);
    for (const r of bucket.results || []) {
      const model = r.model || 'claude (all models)';
      let cw = 0;
      if (typeof r.cache_creation === 'object' && r.cache_creation) {
        cw = Object.values(r.cache_creation).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
      } else cw = r.cache_creation_input_tokens || 0;
      agg.add(d, platform, model, {
        in: finTok(r.uncached_input_tokens ?? r.input_tokens ?? 0),
        cw: finTok(cw), cr: finTok(r.cache_read_input_tokens || 0),
        out: finTok(r.output_tokens || 0),
        msgs: finTok(r.num_requests || r.request_count || r.requests || 0)
      });
    }
  }
  return { rows: agg.rows() };
}

/** Anthropic cost_report (Admin and Enterprise Analytics): `amount` is a DECIMAL STRING IN THE CURRENCY'S LOWEST UNITS
 *  (cents for USD) per the docs — "123.45" = $1.2345 — so string/number amounts are divided by 100. An OpenAI-style
 *  object amount { value, currency } is already in currency units and is taken as-is (the import router feeds both shapes here). */
function parseAnthropicCost(payload) {
  const billed = new Map();
  const data = payload && payload.data;
  if (!Array.isArray(data)) throw new Error('Not an Anthropic cost report');
  for (const bucket of data) {
    const d = dayKeyUTC(bucket.starting_at || bucket.ending_at);
    for (const r of bucket.results || []) {
      let amt = 0;
      if (r.amount && typeof r.amount === 'object') amt = parseFloat(r.amount.value) || 0;   // {value} → dollars as-is
      else amt = (parseFloat(r.amount) || 0) / 100;                                         // "cents" string / number → dollars
      billed.set(d, (billed.get(d) || 0) + finAmt(amt));
    }
  }
  return [...billed.entries()].map(([d, amount]) => ({ d, amount })).sort((a, b) => a.d < b.d ? -1 : 1);
}

function parseOpenAIUsage(payload) {
  const agg = makeAgg();
  const data = payload && payload.data;
  if (!Array.isArray(data)) throw new Error('Not an OpenAI usage report');
  for (const bucket of data) {
    const d = dayKeyUTC((bucket.start_time || bucket.end_time) * 1000);
    for (const r of bucket.results || []) {
      const model = r.model || 'openai (all models)';
      const cached = finTok(r.input_cached_tokens || 0);
      const cw = finTok(r.input_cache_write_tokens || 0);
      const inTotal = finTok(r.input_tokens || 0);
      agg.add(d, 'OpenAI API', model, {
        in: Math.max(0, inTotal - cached - cw),
        cr: cached, cw,
        out: finTok(r.output_tokens || 0),
        msgs: finTok(r.num_model_requests || 0)
      });
    }
  }
  return { rows: agg.rows() };
}

function parseOpenAICost(payload) {
  const billed = new Map();
  const data = payload && payload.data;
  if (!Array.isArray(data)) throw new Error('Not an OpenAI costs report');
  for (const bucket of data) {
    const d = dayKeyUTC((bucket.start_time || bucket.end_time) * 1000);
    for (const r of bucket.results || []) {
      const amt = finAmt(r.amount ? (parseFloat(r.amount.value) || 0) : 0);
      billed.set(d, (billed.get(d) || 0) + amt);
    }
  }
  return [...billed.entries()].map(([d, amount]) => ({ d, amount })).sort((a, b) => a.d < b.d ? -1 : 1);
}


/* ---------- Poe Usage API (Plan 9 B2): points_history items → rows per UTC day · bot, cost_usd → billed ---------- */
/** One Poe breakdown string → its token count, or null when the string carries none: '450 points (5290 tokens)' → 5290,
 *  '12 points (1,500 tokens)' → 1500, '900 points' (an image bot) → null. Tolerates thousands separators and 'token' / 'tokens'. */
function parsePoeTokenCount(str) {
  const m = /(\d[\d,]*)\s*tokens?\b/i.exec(String(str == null ? '' : str));
  return m ? finTok(parseInt(m[1].replace(/,/g, ''), 10)) : null;
}
/** Poe cost_breakdown_in_points → { in, cw, cr, out, parsed }. The documented example — Input '450 points (5290 tokens)', 'Cache write'
 *  '63 points (2921 tokens)', Output '7 points (15 tokens)', 'Cache discount' '-181 points (2366 tokens)', Total '339 points' — is additive in
 *  points (450 + 63 + 7 − 181 = 339): Input is priced on EVERY prompt token, the cache-write line is a 25 % surcharge on its written subset and
 *  the cache-discount line a 90 % refund on its cached subset, so in = Input − Cache write − Cache discount (the uncached remainder, the
 *  dashboard's convention) and cw / cr are those subsets. Accepts the object form or a flat 'Input: …, Output: …' string. `parsed` is false
 *  when no line carried a token count (image / video bots, unknown shapes) — the caller books tokens 0 and counts the item as unparsed. */
function parsePoeCostBreakdown(breakdown) {
  const lines = poeBreakdownLines(breakdown);
  const count = (re) => { const name = Object.keys(lines).find(n => re.test(n)); return name ? parsePoeTokenCount(lines[name]) : null; };
  const input = count(/^input$/i), out = count(/^output$/i), cw = count(/^cache\s*write$/i), cr = count(/^cache\s*(discount|read)$/i);
  const parsed = [input, out, cw, cr].some(v => v !== null);
  return { in: Math.max(0, (input || 0) - (cw || 0) - (cr || 0)), cw: cw || 0, cr: cr || 0, out: out || 0, parsed };
}
/** breakdown object → { line name: text }; the flat-string fallback 'Input: 450 points (5290 tokens), Output: 7 points (15 tokens)' splits on commas. */
function poeBreakdownLines(breakdown) {
  if (breakdown && typeof breakdown === 'object') return Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [String(k).trim(), String(v)]));
  const lines = {};
  for (const part of String(breakdown == null ? '' : breakdown).split(',')) { const m = /^\s*([^:]+):\s*(.+)$/.exec(part); if (m) lines[m[1].trim()] = m[2]; }
  return lines;
}
/** creation_time is documented as unix microseconds; seconds and milliseconds are told apart by magnitude so a unit change can never shift days. */
const poeCreationMs = (v) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) return NaN; return n > 1e14 ? n / 1000 : n > 1e11 ? n : n * 1000; };
/** points_history items (any number of pages, newest first) → { rows, billed, meta }: one row per UTC day · bot_name with the breakdown's
 *  tokens and msgs = 1 per query; cost_usd (a string) summed per day into billed; usage_type counts in meta.byType; items whose breakdown
 *  carried no token count in meta.unparsed; query_id de-duplicates across pages. */
function parsePoePointsHistory(items) {
  const agg = makeAgg(); const billed = new Map(); const byType = {}; const seen = new Set();
  let unparsed = 0, queries = 0;
  for (const it of items || []) {
    if (!it || typeof it !== 'object' || (it.query_id && seen.has(it.query_id))) continue;
    if (it.query_id) seen.add(it.query_id);
    const d = dayKeyUTC(poeCreationMs(it.creation_time)); if (!d) continue;
    const t = parsePoeCostBreakdown(it.cost_breakdown_in_points ?? it.cost_breakdown);
    if (!t.parsed) unparsed++;
    queries++;
    const type = String(it.usage_type || 'unknown'); byType[type] = (byType[type] || 0) + 1;
    agg.add(d, 'Poe', String(it.bot_name || 'poe'), { in: t.in, cw: t.cw, cr: t.cr, out: t.out, msgs: 1 });
    billed.set(d, (billed.get(d) || 0) + finAmt(parseFloat(it.cost_usd)));
  }
  return { rows: agg.rows(), billed: [...billed.entries()].map(([d, amount]) => ({ d, amount })).sort((a, b) => a.d < b.d ? -1 : 1), meta: { byType, unparsed, queries } };
}
/* ---------- DeepInfra /payment/usage (Plan 9 B3): months[].items → rows per booked day · model; total_cost (cents) → billed on the month's 1st ---------- */
/** item.pricing_type → the token field it fills, or null for non-token billing: only a type that says "token" (or is exactly input / output / prompt /
 *  completion) counts — 'image_output', 'time', 'audio_seconds' do not; then cache + write/creat → cw, any other cache → cr, input/prompt → in,
 *  output/completion → out. A bare 'tokens' type cannot tell input from output and is NOT guessed (counted as non-token). */
function deepInfraTokenField(pricingType) {
  const t = String(pricingType == null ? '' : pricingType).toLowerCase();
  if (!/token|^(input|output|prompt|completion)$/.test(t)) return null;
  if (/cache/.test(t)) return /writ|creat/.test(t) ? 'cw' : 'cr';
  if (/input|prompt/.test(t)) return 'in';
  if (/output|completion/.test(t)) return 'out';
  return null;
}
/** a month's period 'YYYY.MM' (DeepInfra's spelling; 'YYYY-MM' tolerated) or its interval.fr (ms) → the month's first UTC day; null when neither reads */
function deepInfraMonthDay(month) {
  const m = /^(\d{4})[.-](\d{2})$/.exec(String((month && month.period) || ''));
  if (m) return `${m[1]}-${m[2]}-01`;
  const d = month && month.interval ? dayKeyUTC(Number(month.interval.fr)) : null;
  return d ? d.slice(0, 7) + '-01' : null;
}
/** an item's own interval { fr, to } (ms) names a day when it spans at most one UTC day — otherwise the month's first day (monthly granularity) */
function deepInfraItemDay(item, monthDay) {
  const iv = item.interval || {};
  const fr = Number(iv.fr), to = Number(iv.to);
  if (Number.isFinite(fr) && Number.isFinite(to) && to > fr && to - fr <= 864e5) return dayKeyUTC(fr) || monthDay;
  return monthDay;
}
/** the model object of an item → its id; the spec shows `model {...}` without naming the fields, so the usual spellings are tried */
const deepInfraModelName = (m) => typeof m === 'string' ? m : String((m && (m.model_name || m.name || m.id || m.full_name)) || 'deepinfra');
/** { months: [{ period, interval, items: [{ model, units, rate, cost (cents), pricing_type, interval }], total_cost (cents), invoice_id }] } → { rows, billed, meta }.
 *  Token items → one row per booked day · model (msgs stay 0 — the API reports no request counts; rows are exact, est 0); non-token items (time, images) are
 *  counted, never booked as tokens; items with unreadable units are skipped and counted. billed = each month's total_cost (DeepInfra's own figure, cents → USD)
 *  on the month's first day. meta.granularity 'month' marks the rows as month totals booked on the 1st; meta.open counts NOT_FINAL (still-open) months. */
function parseDeepInfraUsage(payload) {
  const agg = makeAgg(); const billed = [];
  const meta = { granularity: 'month', months: 0, items: 0, nonToken: 0, rejected: 0, open: 0 };
  for (const month of (payload && Array.isArray(payload.months) ? payload.months : [])) {
    const monthDay = deepInfraMonthDay(month);
    if (!monthDay) { meta.rejected++; continue; }
    meta.months++;
    if (month.invoice_id === 'NOT_FINAL') meta.open++;
    const cents = Number(month.total_cost);
    if (Number.isFinite(cents)) billed.push({ d: monthDay, amount: cents / 100 });
    for (const it of (Array.isArray(month.items) ? month.items : [])) deepInfraAddItem(agg, it, monthDay, meta);
  }
  return { rows: agg.rows(), billed: billed.sort((a, b) => a.d < b.d ? -1 : 1), meta };
}
function deepInfraAddItem(agg, it, monthDay, meta) {
  if (!it || typeof it !== 'object') { meta.rejected++; return; }
  meta.items++;
  const field = deepInfraTokenField(it.pricing_type);
  if (!field) { meta.nonToken++; return; }
  const units = Number(it.units);
  if (!Number.isFinite(units) || units < 0) { meta.rejected++; return; }
  agg.add(deepInfraItemDay(it, monthDay), 'DeepInfra', deepInfraModelName(it.model), { [field]: units });
}

