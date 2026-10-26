/* ---------- direct fetchers (may be blocked by CORS → caller shows fallback) ---------- */
/** JSON GET. A non-2xx answer throws Error('HTTP <status>[ — <server message>]') with .status set, so callers can tell 404 (not available) from
 *  everything else (a real error for the card). */
async function fetchJSON(url, headers) {
  const res = await fetch(url, { headers, signal: requestTimeout() });
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j.error && (j.error.message || j.error.type)) || ''; } catch { /* no JSON body: no detail */ }
    const e = new Error(`HTTP ${res.status}${detail ? ' — ' + detail : ''}`); e.status = res.status; throw e;
  }
  return res.json();
}
/** GET an endpoint an account may lack: the JSON, or null on 404 (not available). Any other failure (403, 5xx, network) propagates to the card (A0 #4). */
async function fetchJSONOrNotFound(url, headers) {
  try { return await fetchJSON(url, headers); } catch (e) { if (e.status === 404) return null; throw e; }
}
/** Opaque reachability probe: resolves true if SOMETHING answers at url (even without CORS headers), false if
 *  the connection fails. Lets connectServer tell "running but CORS-blocked" from "not running". */
async function probeServer(url) {
  try { await fetch(url + '/', { mode: 'no-cors', cache: 'no-store' }); return true; } catch { return false; }
}
/** Ollama live validate: /api/tags (installed) + /api/ps (loaded). No usage history exists on the server. */
async function validateOllama(base) {
  const tags = await fetchJSON(base + '/api/tags', {});
  let ps = null; try { ps = await fetchJSON(base + '/api/ps', {}); } catch {}
  const n = Array.isArray(tags && tags.models) ? tags.models.length : 0;
  const loaded = ps && Array.isArray(ps.models) ? ps.models.length : 0;
  return { label: `${n} models installed`, detail: `${n} models installed · ${loaded} loaded now · no usage history on the server (usage-logger JSONL — exact — and the desktop app's db.sqlite — estimated — are read from the folder below)` };
}

/** LocalAI history: GET /api/usage?period=week → { usage: [{ bucket, model, prompt_tokens, completion_tokens, total_tokens, request_count }], totals, viewer }.
 *  Buckets are the server's own labels with no zone attached — period=week/month 'YYYY-MM-DD' days, period=day 'YYYY-MM-DD HH:00', period=all
 *  'YYYY-MM' calendar MONTHS (SQLite strftime / Postgres to_char / the in-memory store's Go time.Format, all on the server's clock) — so the
 *  date part is read literally (never new Date(local string), which would shift a day by the browser's zone) and period=all is never turned
 *  into rows (a month's total would land on the 1st): it is read best-effort for the "history since …" totals in the label/detail only.
 *  Exact tokens + request counts per day. 503 = --disable-stats (the server answered → e.answered, not a CORS guess).
 *  Merge with earlier syncs (Store.sources.localai) so daily history accumulates while the user keeps syncing: days OLDER than the payload's
 *  first day are kept (the no-auth ring buffer forgets them on restart), days strictly AFTER it are replaced (never doubled), and on the first
 *  day itself each model keeps the LARGER of stored vs fresh (a wrapped ring buffer reports a partial first day; a stored model missing from
 *  the payload stays). An empty payload keeps everything. */
async function validateLocalAI(base) {
  const res = await fetch(base + '/api/usage?period=week', { cache: 'no-store' });
  if (res.status === 503) { const e = new Error('LocalAI answered 503 on /api/usage: usage stats are disabled (--disable-stats) — restart LocalAI without that flag, then validate again.'); e.answered = true; throw e; }
  if (!res.ok) { const e = new Error(`HTTP ${res.status} on /api/usage — not a LocalAI v4.4+ server? (llama.cpp and other servers also default to port 8080)`); e.answered = true; throw e; }
  const j = await res.json();
  const list = Array.isArray(j && j.usage) ? j.usage : [];
  // epoch seconds/ms → UTC day; strings → their literal date part ('2026-08-10', '2026-08-10 01:00', '2026-08-10T00:00:00Z'); 'YYYY-MM' months and garbage → null
  const bucketDay = (b) => { if (typeof b === 'number') return dayKeyUTC(b < 1e12 ? b * 1000 : b); const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(b == null ? '' : b)); return m ? m[1] : null; };
  const agg = makeAgg(); const models = new Set(); const days = new Set(); let tin = 0, tout = 0, nb = 0, minDay = null;
  for (const u of list) {
    if (!u || typeof u !== 'object') continue;
    const d = bucketDay(u.bucket); if (!d) continue;
    const model = String(u.model || 'unknown');
    const t = { in: finTok(+u.prompt_tokens || 0), out: finTok(+u.completion_tokens || 0), msgs: finTok(+u.request_count || 0) };
    agg.add(d, 'LocalAI', model, t); models.add(model); days.add(d); nb++; tin += t.in; tout += t.out;
    if (!minDay || d < minDay) minDay = d;
  }
  const existing = ((Store.sources.localai || {}).rows || []);
  const fresh = agg.rows();
  let rows = existing, kept = existing, firstKept = 0;
  if (minDay) {
    kept = existing.filter(r => r.d < minDay);
    const size = (r) => (r.in || 0) + (r.out || 0) + (r.msgs || 0);
    const freshFirst = new Map(fresh.filter(r => r.d === minDay).map(r => [r.model, r]));
    const first = [];
    for (const r of existing) {
      if (r.d !== minDay) continue;
      const f = freshFirst.get(r.model);
      if (f && size(f) >= size(r)) continue;                     // the fresh count is complete (or equal): it replaces the stored row
      first.push(r); firstKept++; freshFirst.delete(r.model);    // stored row is larger (ring buffer wrapped) or its model is gone from the payload
    }
    rows = kept.concat(first, [...freshFirst.values()], fresh.filter(r => r.d !== minDay));
  }
  // period=all: totals only — "history since <first month>"; its month buckets are never day rows, and a failure here is not a validate failure
  let allOk = false, since = null, allTok = 0, allMsgs = 0;
  try {
    const r2 = await fetch(base + '/api/usage?period=all', { cache: 'no-store' });
    if (r2.ok) {
      const j2 = await r2.json(); allOk = true;
      const months = (Array.isArray(j2 && j2.usage) ? j2.usage : []).map(u => (/^\d{4}-\d{2}/.exec(String(u && u.bucket != null ? u.bucket : '')) || [])[0]).filter(Boolean);
      const tt = (j2 && j2.totals) || {};
      since = months.length ? months.reduce((a, b) => (b < a ? b : a)) : null;
      allTok = finTok(+tt.total_tokens || 0) || finTok(+tt.prompt_tokens || 0) + finTok(+tt.completion_tokens || 0);
      allMsgs = finTok(+tt.request_count || 0);
    }
  } catch (e) { allOk = false; since = null; }
  const nm = models.size, pl = (n) => (n === 1 ? '' : 's');
  return { label: since ? `history since ${since}: ${fmtInt(allTok)} tokens` : `last 7 days: ${fmtInt(tin + tout)} tokens`,
    detail: `${nb} daily bucket${pl(nb)} over the last 7 days (period=week) · ${fmtInt(tin)} in / ${fmtInt(tout)} out tokens · ${nm} model${pl(nm)}`
      + (since ? ` · history since ${since}: ${fmtInt(allTok)} tokens / ${fmtInt(allMsgs)} request${pl(allMsgs)} (period=all totals; its month buckets are not turned into rows)` : allOk ? ' · period=all: no history yet' : ' · period=all totals unavailable')
      + (kept.length ? ` · ${kept.length} older row${pl(kept.length)} kept from earlier syncs` : '')
      + (firstKept ? ` · earliest day ${minDay}: ${firstKept} stored row${pl(firstKept)} kept over a smaller or missing fresh count (ring buffer wrapped?)` : ''),
    rows, meta: { buckets: nb, period: 'week', days: days.size, msgs: fresh.reduce((a, r) => a + r.msgs, 0), since } };
}

/** Groq validate-only: GET /openai/v1/models with the key (api.groq.com allows browser origins). Groq has no usage or spend API —
 *  usage lives in the console, so this fetcher returns no rows; the key driver stores the model count as the card label. */
async function fetchGroq(key) {
  const j = await fetchJSON('https://api.groq.com/openai/v1/models', { 'Authorization': 'Bearer ' + key });
  const n = Array.isArray(j && j.data) ? j.data.length : 0;
  return { label: `${n} models`, detail: `${n} models available to this key · no usage or spend API — usage and billing are in the Groq console (see the links)` };
}

/** Gemini (Google AI Studio) — validate-only key-driver fetcher: GET /v1beta/models with the key in the x-goog-api-key header, never ?key= (URLs land
 *  in history / logs — A0 #20). Google's API has no usage-history endpoint — the Cloud Billing CSV through Imports is the history path. */
async function fetchGeminiModels(key) {
  const j = await fetchJSON('https://generativelanguage.googleapis.com/v1beta/models', { 'x-goog-api-key': key });
  const n = (j.models || []).length;
  return { label: n + ' models available', detail: `${n} models · usage history comes from billing CSV imports` };
}

/* ---------- Wave 2 validate-only vendors — key-driver fetchers: async (key, fields, opts) → { label, detail } (no rows: nothing to read) ---------- */
/** Model-list length in any of the shapes these vendors return: bare array (Together), {data:[…]} (OpenAI-style: Mistral, xAI, Perplexity), {models:[…]} (Cohere v2). */
const countModels = (j) => Array.isArray(j) ? j.length : Array.isArray(j && j.data) ? j.data.length : Array.isArray(j && j.models) ? j.models.length : 0;
/** Mistral La Plateforme — standard keys have no usage/billing endpoint; GET /v1/models proves the key works. */
async function fetchMistral(key) {
  const j = await fetchJSON('https://api.mistral.ai/v1/models', { 'Authorization': 'Bearer ' + key });
  const n = countModels(j);
  return { label: `${n} models available`, detail: `key valid · ${n} models · Mistral has no usage or spend API for standard keys — see the console for spend (the Enterprise Admin API is CORS-blocked from this page)` };
}
/** Cohere — POST /v1/check-api-key (valid + organization), then GET /v2/models for a count. No usage endpoint exists. */
async function fetchCohere(key) {
  const h = { 'Authorization': 'Bearer ' + key };
  const res = await fetch('https://api.cohere.com/v1/check-api-key', { method: 'POST', headers: h });
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j && (j.message || (j.error && j.error.message))) || ''; } catch {}
    throw new Error(`HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
  }
  const chk = await res.json();
  if (chk && chk.valid === false) throw new Error('Cohere reports this key as not valid');
  let n = 0;
  try { n = countModels(await fetchJSON('https://api.cohere.com/v2/models', h)); } catch (e) { console.warn('cohere models unavailable', e); }
  const org = chk && chk.organization_id ? ' · org ' + String(chk.organization_id).slice(0, 12) : '';
  return { label: `valid key · ${n} models`, detail: `key valid${org} · ${n} models · usage is per-response metadata + dashboard.cohere.com/billing only (no usage API)` };
}
/** Together AI — GET /v1/models (bare array). No usage, credits or billing endpoint is documented. */
async function fetchTogether(key) {
  const j = await fetchJSON('https://api.together.xyz/v1/models', { 'Authorization': 'Bearer ' + key });
  const n = countModels(j);
  return { label: `${n} models available`, detail: `key valid · ${n} models · Together exposes no usage, credits or billing endpoint — spend lives in the console billing / cost-analytics pages` };
}
/** Hugging Face — GET /api/whoami-v2: account, plan (isPro), orgs. Inference spend is settings-UI only. */
async function fetchHuggingFace(key) {
  const j = await fetchJSON('https://huggingface.co/api/whoami-v2', { 'Authorization': 'Bearer ' + key });
  const who = String(j.name || j.fullname || 'hf user');
  const orgs = Array.isArray(j.orgs) ? j.orgs.map(o => o && (o.name || o.fullname)).filter(Boolean).map(String) : [];
  const plan = j.isPro ? 'PRO' : (j.type === 'org' ? 'org' : 'free');
  const orgLabel = orgs.length ? ` · ${orgs.length} org${orgs.length === 1 ? '' : 's'}` : '';
  return { label: `${who} · ${plan}${orgLabel}`,
    detail: `token valid for ${who} (${plan})${orgs.length ? ' · orgs: ' + orgs.join(', ') : ''} · inference spend and monthly credits are visible only at huggingface.co/settings/inference-providers/overview (no usage API)` };
}
/** xAI — regular key: GET /v1/api-key (name, team, blocked/disabled flags) + GET /v1/models. Usage needs the CORS-blocked Management API. */
async function fetchXai(key) {
  const h = { 'Authorization': 'Bearer ' + key };
  const j = await fetchJSON('https://api.x.ai/v1/api-key', h);
  if (j.api_key_disabled || j.api_key_blocked || j.team_blocked) throw new Error('xAI reports this key as ' + (j.api_key_disabled ? 'disabled' : j.api_key_blocked ? 'blocked' : 'on a blocked team'));
  let n = 0;
  try { n = countModels(await fetchJSON('https://api.x.ai/v1/models', h)); } catch (e) { console.warn('xai models unavailable', e); }
  const team = j.team_id ? ' · team ' + String(j.team_id).slice(0, 8) : '';
  return { label: `${j.name || 'xAI key'}${team}`,
    detail: `key "${j.name || 'unnamed'}" valid${team} · ${n} models · usage and spend need the Management API (management-api.x.ai), which sends no CORS headers — use the console Usage Explorer` };
}
/** Perplexity API — GET /v1/models is unauthenticated: proves reachability, NOT the key (only a paid completion would). No usage endpoint. */
async function fetchPerplexityApi(key) {
  const j = await fetchJSON('https://api.perplexity.ai/v1/models', { 'Authorization': 'Bearer ' + key });
  const n = countModels(j);
  return { label: 'reachable — Sonar keys cannot be verified without a paid request',
    detail: `api.perplexity.ai reachable · ${n} models listed · GET /v1/models needs no auth, so this does NOT prove the key is valid (only a paid completion would) · usage and spend are in the API console Billing tab (no usage API)` };
}

/* ---------- metrics-poll helpers (vLLM / llama.cpp: Prometheus counters diffed by App._pollTick) ---------- */
/** Prometheus text exposition → [{ name, labels: {…}, value }]. '#' (HELP/TYPE/comment) and blank lines are skipped; label values are
 *  unescaped (\" \\ \n); values may be exponent floats, +Inf/-Inf/NaN; an optional trailing timestamp is ignored; unparseable lines are dropped. */
function parsePrometheus(text) {
  const out = [];
  const line = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+(-?\d+))?\s*$/;
  const label = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
  for (const raw of String(text || '').split('\n')) {
    const s = raw.trim();
    if (!s || s[0] === '#') continue;
    const m = line.exec(s);
    if (!m) continue;
    const labels = {};
    if (m[2]) { let lm; label.lastIndex = 0; while ((lm = label.exec(m[2]))) labels[lm[1]] = lm[2].replace(/\\(["\\n])/g, (_, ch) => ch === 'n' ? '\n' : ch); }
    const v = m[3] === '+Inf' ? Infinity : m[3] === '-Inf' ? -Infinity : m[3] === 'NaN' ? NaN : Number(m[3]);
    if (m[3] !== 'NaN' && Number.isNaN(v)) continue;
    out.push({ name: m[1], labels, value: v });
  }
  return out;
}
/** vLLM metrics-poll: GET base + '/metrics' (Prometheus, on by default). Cumulative process-lifetime counters per model_name label:
 *  vllm:prompt_tokens_total − vllm:prompt_tokens_cached_total (in = uncached input; prompt_tokens_total includes the cache hits), vllm:generation_tokens_total (out), vllm:prompt_tokens_cached_total (cr), vllm:request_success_total
 *  (msgs, summed over finished_reason). An HTTP error is the server's own answer → e.answered (connectServer shows it, no CORS guess). */
async function pollVllm(base) {
  const res = await fetch(base + '/metrics', { cache: 'no-store' });
  if (!res.ok) { const e = new Error(`HTTP ${res.status} on /metrics — is this vLLM? (vllm serve exposes /metrics by default)`); e.answered = true; throw e; }
  const FIELD = { 'vllm:prompt_tokens_total': 'in', 'vllm:generation_tokens_total': 'out', 'vllm:prompt_tokens_cached_total': 'cr', 'vllm:request_success_total': 'msgs' };
  const counters = {};
  for (const m of parsePrometheus(await res.text())) {
    const f = FIELD[m.name]; if (!f) continue;
    const model = String(m.labels.model_name || 'vllm');
    const s = counters[model] || (counters[model] = { in: 0, out: 0, cr: 0, msgs: 0 });
    s[f] += finTok(m.value);
  }
  for (const s of Object.values(counters)) s.in = Math.max(0, s.in - s.cr);   // prompt_tokens_total counts EVERY prompt token, prefix-cache hits included → in = uncached input (dashboard convention), cr = the cached share
  const n = Object.keys(counters).length;
  return { counters, label: `${n} model${n === 1 ? '' : 's'}` };
}
/** vLLM validate = one successful /metrics parse ('<n> models' from the model_name labels; a fresh server has no counters until its first
 *  request → fall back to GET /v1/models for the count). No history exists on the server — the poll loop (startPoll) is the history. */
async function validateVllm(base) {
  const p = await pollVllm(base);
  let n = Object.keys(p.counters).length;
  if (!n) { try { const j = await fetchJSON(base + '/v1/models', {}); n = Array.isArray(j && j.data) ? j.data.length : 0; } catch {} }
  return { label: `${n} model${n === 1 ? '' : 's'}`, detail: `${n} model${n === 1 ? '' : 's'} served · counting tokens from /metrics while this page is open (no history on the server)` };
}
/** llama-server model name: GET /props → model_alias or model_path basename without .gguf; null when /props is unavailable. */
async function llamaCppModelName(base) {
  try {
    const p = await fetchJSON(base + '/props', {});
    const mp = p && (p.model_alias || p.model_path || (p.default_generation_settings && p.default_generation_settings.model));
    if (mp) return String(mp).split(/[\\/]/).pop().replace(/\.gguf$/i, '') || null;
  } catch {}
  return null;
}
/** llama.cpp metrics-poll: GET base + '/metrics' (needs --metrics / LLAMA_ARG_ENDPOINT_METRICS=1): llamacpp:prompt_tokens_total (in),
 *  llamacpp:tokens_predicted_total (out). No request counter (msgs stay 0). Single-model mode has no model label → the model comes from
 *  GET /props ('llama.cpp' when that is unavailable); router mode's `model` label is used when present. */
async function pollLlamaCpp(base) {
  const res = await fetch(base + '/metrics', { cache: 'no-store' });
  if (!res.ok) { const e = new Error(`HTTP ${res.status} on /metrics — start llama-server with --metrics (LLAMA_ARG_ENDPOINT_METRICS=1)`); e.answered = true; throw e; }
  const FIELD = { 'llamacpp:prompt_tokens_total': 'in', 'llamacpp:tokens_predicted_total': 'out' };
  const hits = parsePrometheus(await res.text()).filter(m => FIELD[m.name]);
  const fallback = hits.some(m => !m.labels.model) ? (await llamaCppModelName(base)) || 'llama.cpp' : null;
  const counters = {};
  for (const m of hits) {
    const model = String(m.labels.model || fallback);
    const s = counters[model] || (counters[model] = { in: 0, out: 0 });
    s[FIELD[m.name]] += finTok(m.value);
  }
  const models = Object.keys(counters);
  return { counters, label: models.length ? models.join(', ') : 'no counters yet' };
}
/** llama.cpp validate: GET /props (model name; on by default) or GET /health; then ONE /metrics read so the card can say whether tokens will be
 *  counted (--metrics off → honest detail, validation still passes). No history on the server — the poll loop is the history. */
async function validateLlamaCpp(base) {
  const model = await llamaCppModelName(base);
  if (!model) await fetchJSON(base + '/health', {});   // neither /props nor /health → throws → connectServer's CORS / not-running handling
  let metricsNote, pollable = true;
  try { const p = await pollLlamaCpp(base); metricsNote = `counting tokens from /metrics while this page is open (${p.label})`; }
  catch (e) { metricsNote = `${e.message || e} — tokens are NOT counted until then`; pollable = false; }   // --metrics off: connectServer starts no poll (every tick would fail the same way)
  return { label: model || 'llama-server', detail: `${model ? 'model ' + model : 'llama-server healthy'} · ${metricsNote} · no history on the server`, pollable };
}

/** GPT4All live validate: GET /v1/models on the app's Local API Server (off by default; CORS * when on). No history endpoint. */
async function validateGpt4All(base) {
  const j = await fetchJSON(base + '/v1/models', {});
  const n = Array.isArray(j && j.data) ? j.data.length : 0;
  return { label: `${n} models`, detail: `${n} models listed · validate-only: no usage history on the server and the app's .chat files carry no token counts` };
}
/** Jan live validate: GET /v1/models on the Local API Server (CORS on by default; an optional API key is NOT sent). No history endpoint —
 *  thread history comes from the data folder (parseJanThreads). */
async function validateJan(base) {
  const j = await fetchJSON(base + '/v1/models', {});
  const n = Array.isArray(j && j.data) ? j.data.length : 0;
  return { label: `${n} models`, detail: `${n} models listed · no usage history on the server — thread history (estimated) is read from the Jan data folder below` };
}
/** text-generation-webui live validate: GET /v1/models on the --api server (CORS-blocked from file:// unless --listen / --public-api).
 *  No history endpoint (/v1/billing/usage is a stub) — history comes from user_data/logs (parseTgwebuiLogs). */
async function validateTgwebui(base) {
  const j = await fetchJSON(base + '/v1/models', {});
  const n = Array.isArray(j && j.data) ? j.data.length : 0;
  return { label: `${n} models`, detail: `${n} models listed · no usage history on the server — chat/instruct logs (estimated) are read from the user_data folder below` };
}

