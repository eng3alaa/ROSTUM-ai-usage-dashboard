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

