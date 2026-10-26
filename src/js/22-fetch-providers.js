/* ---------- Fireworks AI: exact tokens (billingUsage) + billed USD (billing/summary) with a regular key ---------- */
/** fields.account = Fireworks account id (app.fireworks.ai). `days` back from today in ≤31-day half-open windows [s, e); two
 *  passes (SERVERLESS → serverlessCosts[] grouped by model_name; DEDICATED_DEPLOYMENT → dedicatedCosts[] grouped by deployment_name — the documented gatewayAccountUsage wrapper); token fields are JSON strings; day = row start (UTC); model = group.model_name / group.deployment_name
 *  without the accounts/<acct>/models/ (serverless) or accounts/<acct>/deployments/ (dedicated) prefix. Dedicated rows carry acceleratorSeconds and no token fields → no day·model row, only meta.acceleratorSeconds and the status line. A row is counted only if its start falls inside the window that requested it,
 *  so padded or cached responses never double count. Summary = documented DAILY shape usageBuckets[].lineItems[].totalCost { units, nanos } (top-level lineItems are period totals, not counted); its failure → billed null (tokens still land). */
async function fetchFireworks(key, fields, opts) {
  const account = String((fields && fields.account) || '').trim();
  if (!account) throw new Error('Enter your Fireworks account id (app.fireworks.ai → Settings → Account; it is also the first path segment in the console URL)');
  if (!/^[A-Za-z0-9_-]+$/.test(account)) throw new Error('Account id may only contain letters, digits, - and _');
  const days = (opts && opts.days) || 90;
  const h = { 'Authorization': 'Bearer ' + key };
  const base = 'https://api.fireworks.ai/v1/accounts/' + encodeURIComponent(account);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const dayMs = 864e5, endAll = new Date();
  const startAll = new Date(Date.UTC(endAll.getUTCFullYear(), endAll.getUTCMonth(), endAll.getUTCDate()) - days * dayMs);
  const windows = [];
  for (let s = startAll.getTime(); s < endAll.getTime();) { const e = Math.min(s + 31 * dayMs, endAll.getTime()); windows.push([new Date(s), new Date(e)]); s = e; }
  const inWin = (t, s, e) => { const ms = Date.parse(t); return Number.isFinite(ms) && ms >= s.getTime() && ms < e.getTime(); };
  const modelOf = (b) => { const dims = b.group || b.dimensions || {}; const raw = dims.model_name || dims.deployment_name || dims.modelName || b.model_name || b.modelName || b.model || 'fireworks (all models)'; return String(raw).replace(/^accounts\/[^/]+\/(models|deployments)\//, ''); };   // serverless 'accounts/fireworks/models/<m>' and dedicated 'accounts/<acct>/deployments/<dep>' both lose their resource prefix
  const agg = makeAgg();
  let accelSec = 0;   // dedicated deployments are metered in accelerator-seconds (GPU time), not tokens — surfaced in meta + the status line
  for (const usageType of ['SERVERLESS', 'DEDICATED_DEPLOYMENT']) {
    for (const [s, e] of windows) {
      const url = new URL(base + '/billingUsage');
      url.searchParams.set('startTime', iso(s)); url.searchParams.set('endTime', iso(e));
      url.searchParams.set('usageType', usageType); url.searchParams.set('groupBy', usageType === 'SERVERLESS' ? 'model_name' : 'deployment_name'); url.searchParams.set('timezone', 'UTC');   // docs: serverless dimensions include model_name, dedicated ones deployment_name
      const j = await fetchJSON(url, h);
      const list = j[usageType === 'SERVERLESS' ? 'serverlessCosts' : 'dedicatedCosts'];   // documented wrapper (gatewayAccountUsage) keyed by usage type — never the other pass's array, so nothing is counted twice; older / flat keys tolerated
      for (const b of (Array.isArray(list) ? list : (j.usageBuckets || j.buckets || j.data || []))) {
        const t = b.startTime || b.start_time || b.bucketStart;
        if (!inWin(t, s, e)) continue;
        if (b.promptTokens == null && b.completionTokens == null) { accelSec += finTok(+b.acceleratorSeconds || 0); continue; }   // dedicated / training rows: no token counts in the export — their dollars come from the summary
        agg.add(dayKeyUTC(t), 'Fireworks AI', modelOf(b), { in: finTok(+b.promptTokens || 0), out: finTok(+b.completionTokens || 0), msgs: finTok(+(b.requests ?? b.numRequests ?? b.requestCount) || 0) });
      }
    }
  }
  let billed = null;
  try {
    const bm = new Map();
    for (const [s, e] of windows) {
      const url = new URL(base + '/billing/summary');
      url.searchParams.set('granularity', 'DAILY'); url.searchParams.set('startTime', iso(s)); url.searchParams.set('endTime', iso(e));
      const j = await fetchJSON(url, h);
      // documented DAILY shape: top-level usageBuckets[] { startTime, endTime, lineItems[] { series, category, totalCost: { currencyCode, units, nanos } } } — the top-level lineItems are period totals and are NOT counted;
      // tolerated: lineItems[].usageBuckets[] and flat buckets that carry their own cost / amount
      const money = (raw) => raw && typeof raw === 'object' ? (raw.units != null || raw.nanos != null ? (+raw.units || 0) + (+raw.nanos || 0) / 1e9 : parseFloat(raw.value ?? raw.amount)) : parseFloat(raw);   // google.type.Money { units (int64 string), nanos (int32) } or a plain number / numeric string
      const buckets = Array.isArray(j.usageBuckets) ? j.usageBuckets : (Array.isArray(j.lineItems) ? j.lineItems : Array.isArray(j.items) ? j.items : []).flatMap(it => it.usageBuckets || it.buckets || []);
      for (const b of buckets) {
        const t = b.startTime || b.start_time || b.bucketStart;
        if (!inWin(t, s, e)) continue;
        const d = dayKeyUTC(t);
        for (const it of (Array.isArray(b.lineItems) ? b.lineItems : [b])) bm.set(d, (bm.get(d) || 0) + finAmt(money(it.totalCost ?? it.cost ?? it.amount ?? it.total)));
      }
    }
    billed = [...bm.entries()].map(([d, amount]) => ({ d, amount })).sort((a, b) => a.d < b.d ? -1 : 1);
  } catch (e) { console.warn('fireworks billing summary failed', e); }
  const rows = agg.rows();
  return { label: `account ${account} · last 4: ${key.slice(-4)}`, rows, billed,
    detail: `${rows.length} day·model rows${billed ? ` · ${billed.length} billed day${billed.length === 1 ? '' : 's'}` : ' · billing summary unavailable (tokens only)'}${accelSec ? ` · dedicated ${(accelSec / 3600).toFixed(1)} accelerator-h (GPU time, no token counts)` : ''} · last ${days} days in ${windows.length} windows`,
    meta: { days, account, windows: windows.length, acceleratorSeconds: accelSec } };
}

/** DeepSeek API — GET /user/balance: validate + remaining balance only (no usage history exists on the API; history comes
 *  from the monthly usage ZIP through Imports). Numbers are strings; the currency may be CNY — both are shown as reported. */
async function fetchDeepSeekBalance(key, fields, opts) {
  const j = await fetchJSON('https://api.deepseek.com/user/balance', { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' });
  const infos = Array.isArray(j && j.balance_infos) ? j.balance_infos : [];
  const money = (v) => { const n = Number(v); return Number.isFinite(n) ? n.toFixed(2) : String(v == null ? '?' : v); };
  const label = infos.length ? `balance ${money(infos[0].total_balance)} ${infos[0].currency || ''}`.trim() : (j && j.is_available === false ? 'no balance' : 'validated');
  const detail = (infos.length ? infos.map(b => `${b.currency || '?'}: total ${money(b.total_balance)} (granted ${money(b.granted_balance)}, topped up ${money(b.topped_up_balance)})`).join(' · ') : 'key accepted')
    + (j && j.is_available === false ? ' · account not available for API calls (balance exhausted?)' : '')
    + ' · no usage history on this endpoint — drop the monthly usage ZIP (platform.deepseek.com/usage → Export monthly data) on Imports for exact tokens and billed amounts';
  return { label, detail };
}

/* ---------- cloud-token fetchers (Azure / Vertex / Bedrock): pasted CLI token or IAM key, session-only, one fetcher per platform ---------- */
/** Cloud REST call for the cloud-token fetchers: JSON in → JSON out. 401 → auth.expired (the platform's "mint a new token" message,
 *  verbatim), 403 → auth.denied (+ the server's own reason when it gives one), any other non-2xx → 'HTTP <status> — <server message>'.
 *  The bearer token / SigV4 signature travels only inside this request — nothing is logged or stored. */
async function cloudJSON(url, init = {}, auth = {}) {
  const res = await fetch(url, { ...init, signal: requestTimeout() });
  if (res.ok) return res.status === 204 ? {} : res.json();
  let detail = '';
  try {
    const j = await res.json();
    detail = String((j && j.error && (typeof j.error === 'string' ? j.error : (j.error.message || j.error.code || j.error.type))) || (j && (j.message || j.Message || j.__type || j.error_description)) || '').slice(0, 140);
  } catch {}
  if (res.status === 401 && auth.expired) throw new Error(auth.expired);
  if (res.status === 403 && auth.denied) throw new Error(auth.denied + (detail ? ` (${detail})` : ''));
  throw new Error(`HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
}

/** A0 #19 — a Cost Management nextLink is followed with the bearer token, so it must stay on management.azure.com; anything else is refused and
 *  the cost half reads "cost unavailable: …" with this message (the Monitor rows still land). */
function assertAzureHost(link) {
  let host = ''; try { host = new URL(link).host.toLowerCase(); } catch { /* not a URL: refused below */ }
  if (host !== 'management.azure.com') throw new Error('Cost Management nextLink points at ' + (host || 'an invalid URL') + ', not management.azure.com — refused');
  return link;
}

/** Azure OpenAI (Microsoft Foundry) — cloud-token fetcher. token: Entra access token (az account get-access-token --resource
 *  https://management.azure.com), fields: { resources: one Cognitive Services resource id per line, scope?: '/subscriptions/<id>' or a
 *  resource group }, opts: { days }. (1) per resource: Azure Monitor metrics → exact tokens per ModelName × UTC day. Azure exposes two
 *  metric generations — ProcessedPromptTokens/GeneratedTokens and the newer InputTokens/OutputTokens — which overlap on some deployments,
 *  so per resource × model-day and per field the newer metric wins when it has a data point (total > 0), else the older one; never both;
 *  resources are then summed. The Monitor timespan starts at today's UTC midnight − days so the P1D buckets are calendar UTC days. Request
 *  counts are not pulled → msgs 0. (2) when scope is given: Cost Management query → billed PreTaxCost per UsageDate (yyyymmdd) for
 *  ServiceName 'Cognitive Services' (all Cognitive Services in the scope — narrow the scope to the resource group that holds only
 *  Azure OpenAI if you also run Speech/Vision there). Resource ids and the scope are validated BEFORE any call — both are concatenated into
 *  the management.azure.com URL. Without a scope billed is [] (truthful empty); a Cost Management failure AFTER the metrics landed (no Cost Management Reader, throttling) degrades to billed: null — connectKey marks the stored envelope stale, tokens still land, the status line says "cost unavailable" (the Bedrock contract, never an error state for the cost half alone). 401 → 'token expired — mint a new one (az account get-access-token)'. */
async function fetchAzureOpenAI(token, fields, opts = {}) {
  const days = Math.min(Math.max(1, opts.days || 90), 90);   // Azure Monitor keeps 93 days of platform metrics
  const resources = String(fields.resources || '').split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
  if (!resources.length) throw new Error('Enter at least one Cognitive Services resource id (Azure portal → the Azure OpenAI resource → Properties → Resource ID)');
  for (const r of resources) if (!/^\/subscriptions\/[^/?#\\]+\/resourceGroups\/[^/?#\\]+\/providers\/Microsoft\.CognitiveServices\/accounts\/[^/?#\\]+$/i.test(r)) throw new Error('Not a Cognitive Services resource id: ' + r.slice(0, 60));   // SECURITY: concatenated into the management.azure.com URL — no query/fragment/backslash bytes
  const scope = String(fields.scope || '').trim().replace(/\/+$/, '');
  if (scope && !/^\/subscriptions\/[^/?#\\]+(\/resourceGroups\/[^/?#\\]+)?$/i.test(scope)) throw new Error('Cost scope must be /subscriptions/<id> or /subscriptions/<id>/resourceGroups/<rg>');   // SECURITY: the scope is concatenated into the management.azure.com URL — a host suffix ('.evil.example'), userinfo ('@…'), a deeper path or a query would send the bearer token elsewhere; rejected before any network call
  const auth = { expired: 'token expired — mint a new one (az account get-access-token)', denied: 'HTTP 403 — this identity lacks Monitoring Reader / Cost Management Reader on that resource or scope' };
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const now = new Date(), endMs = now.getTime(), startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - days * 864e5;   // start on a UTC midnight: Monitor anchors P1D buckets to the timespan START, so a start at the sync time-of-day would stamp every bucket with that hour (and the row with the previous UTC date)
  // per (resource, day, model): the older metric pair and the newer pair are kept apart PER RESOURCE, merged below (key = JSON of [resourceId, day, model] — no separator bytes); keyed by (day, model) alone, one resource's InputTokens would drop another resource's ProcessedPromptTokens for the same model-day
  const older = new Map(), newer = new Map();
  const bump = (map, key, field, v) => { let b = map.get(key); if (!b) { b = { in: null, out: null }; map.set(key, b); } b[field] = (b[field] || 0) + v; };
  const FIELD = { processedprompttokens: ['in', older], generatedtokens: ['out', older], inputtokens: ['in', newer], outputtokens: ['out', newer] };
  for (const rid of resources) {
    const url = `https://management.azure.com${rid}/providers/microsoft.insights/metrics?api-version=2024-02-01&metricnames=ProcessedPromptTokens,GeneratedTokens,InputTokens,OutputTokens&timespan=${encodeURIComponent(iso(startMs) + '/' + iso(endMs))}&interval=P1D&aggregation=Total&$filter=${encodeURIComponent("ModelName eq '*'")}`;
    const j = await cloudJSON(url, { headers }, auth);
    for (const m of (j && j.value) || []) {
      const spec = FIELD[String((m.name && m.name.value) || '').toLowerCase()];
      if (!spec) continue;
      for (const ts of m.timeseries || []) {
        const md = (ts.metadatavalues || []).find(x => x && x.name && /^modelname$/i.test(String(x.name.value)));
        const model = (md && md.value) || 'azure-openai';
        for (const p of ts.data || []) {
          if (!p || typeof p.total !== 'number' || !(p.total > 0)) continue;   // Azure omits `total` when there is no data for that day
          const d = dayKeyUTC(p.timeStamp); if (!d) continue;
          bump(spec[1], JSON.stringify([rid, d, model]), spec[0], finTok(p.total));
        }
      }
    }
  }
  const agg = makeAgg();
  for (const key of new Set([...older.keys(), ...newer.keys()])) {
    const [, d, model] = JSON.parse(key);   // the resource id only keys the dedupe — rows sum across resources per (day, model)
    const o = older.get(key) || {}, n = newer.get(key) || {};
    const tin = n.in != null ? n.in : (o.in || 0), tout = n.out != null ? n.out : (o.out || 0);   // newer metric wins per field when it has data
    if (!tin && !tout) continue;
    agg.add(d, 'Azure OpenAI', model, { in: tin, out: tout, msgs: 0 });
  }
  const rows = agg.rows();
  let billed = [], costNote = '';   // [] = truthful empty when no scope is configured → connectKey stores it (a previous scope's envelope must not stay "fresh" behind "no cost scope") · null = the Cost Management query failed → connectKey marks the stored envelope stale, the metric rows above still land (never silently "fresh")
  if (scope) try {   // the cost half only: a failure here degrades to billed: null (catch below) — the Monitor rows are already in `rows`
    const body = { type: 'ActualCost', timeframe: 'Custom', timePeriod: { from: dayKeyUTC(startMs) + 'T00:00:00Z', to: dayKeyUTC(endMs) + 'T23:59:59Z' },
      dataset: { granularity: 'Daily', aggregation: { totalCost: { name: 'PreTaxCost', function: 'Sum' } },
        filter: { dimensions: { name: 'ServiceName', operator: 'In', values: ['Cognitive Services'] } } } };
    const byDay = new Map();
    let url = `https://management.azure.com${scope}/providers/Microsoft.CostManagement/query?api-version=2025-03-01`, pages = 0;
    while (url && pages++ < 20) {   // nextLink pages carry the same POST body
      const j = await cloudJSON(url, { method: 'POST', headers, body: JSON.stringify(body) }, auth);
      const props = (j && j.properties) || {};
      const cols = (props.columns || []).map(c => String(c.name || '').toLowerCase());
      const iCost = cols.indexOf('pretaxcost'), iDate = cols.indexOf('usagedate');
      if (iCost < 0 || iDate < 0) throw new Error('Cost Management returned no PreTaxCost / UsageDate columns');
      for (const r of props.rows || []) {
        const raw = String(r[iDate] ?? '');   // yyyymmdd number (20260810) — or an ISO string on some API versions
        const d = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : dayKeyUTC(raw);
        if (!d) continue;
        byDay.set(d, (byDay.get(d) || 0) + finAmt(parseFloat(r[iCost])));
      }
      url = props.nextLink ? assertAzureHost(props.nextLink) : null;   // the bearer token follows nextLink — only to management.azure.com (A0 #19)
    }
    billed = [...byDay.entries()].map(([d, amount]) => ({ d, amount })).sort((a, b) => a.d < b.d ? -1 : 1);
  } catch (e) { billed = null; costNote = ' · cost unavailable: ' + (e.message || String(e)).slice(0, 80); }   // tokens-only sync: reported in the status line, not an error state
  const nModels = new Set(rows.map(r => r.model)).size;
  return { label: `${resources.length} resource${resources.length === 1 ? '' : 's'}`,
    detail: `${rows.length} usage rows · ${nModels} model${nModels === 1 ? '' : 's'} · last ${days} days` + (scope ? (billed ? ` · billed ${billed.length} day${billed.length === 1 ? '' : 's'} from Cost Management` : costNote) : ' · no cost scope — add one for billed dollars'),
    rows, billed, meta: { days, resources: resources.length } };
}

/** Google Vertex AI — cloud-token fetcher. token: OAuth access token (gcloud auth print-access-token), fields: { project, billingTable? },
 *  opts: { days }. (1) Cloud Monitoring timeSeries.list for aiplatform.googleapis.com/publisher/online_serving/token_count, aligned to
 *  86400 s (ALIGN_SUM), summed across series (REDUCE_SUM), grouped by model_user_id and the metric's `type` label (input | output) →
 *  exact tokens per publisher model. Monitoring anchors alignment windows to interval.endTime (= the sync time), so each point is the 24 h
 *  ending then, attributed to the UTC date of (window end − 1 s). Request counts are not pulled → msgs 0. (2) when billingTable is given:
 *  BigQuery jobs.query against the Cloud Billing export (service.description 'Vertex AI') → billed per usage day; there is no Cloud Billing
 *  REST endpoint for incurred cost, the export is the only path; without a table billed is [] (truthful empty); a BigQuery failure AFTER the Monitoring rows landed (no bigquery.jobUser, a query timeout) degrades to billed: null — connectKey marks the stored envelope stale, tokens still land, the status line says "cost unavailable" (the Bedrock contract). 401 → 'token expired — mint a new one (gcloud auth print-access-token)';
 *  403 → token rejected (expired or missing roles). API keys are not accepted by either API. */
async function fetchVertexAI(token, fields, opts = {}) {
  const days = Math.max(1, opts.days || 90);
  const project = String(fields.project || '').trim();
  if (!/^[a-z0-9][a-z0-9\-:.]{4,}$/i.test(project)) throw new Error('Enter the GCP project id (e.g. my-project-123)');
  const table = String(fields.billingTable || '').trim();
  if (table && !/^[\w\-]+\.[\w\-]+\.[\w\-]+$/.test(table)) throw new Error('Billing table must look like project.dataset.table (letters, digits, _ and - only)');   // also keeps the SQL below injection-free
  const auth = { expired: 'token expired — mint a new one (gcloud auth print-access-token)', denied: 'token rejected (403) — expired, or missing roles/monitoring.viewer (bigquery.jobUser for cost); mint a new one' };
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const endMs = Date.now(), startMs = endMs - days * 864e5;
  const agg = makeAgg();
  let pageToken = null, pages = 0;
  do {
    const q = new URLSearchParams();
    q.set('filter', 'metric.type="aiplatform.googleapis.com/publisher/online_serving/token_count"');
    q.set('interval.startTime', new Date(startMs).toISOString());
    q.set('interval.endTime', new Date(endMs).toISOString());
    q.set('aggregation.alignmentPeriod', '86400s');
    q.set('aggregation.perSeriesAligner', 'ALIGN_SUM');
    q.set('aggregation.crossSeriesReducer', 'REDUCE_SUM');
    q.append('aggregation.groupByFields', 'resource.labels.model_user_id');
    q.append('aggregation.groupByFields', 'metric.labels.type');
    if (pageToken) q.set('pageToken', pageToken);
    const j = await cloudJSON(`https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(project)}/timeSeries?${q}`, { headers }, auth);
    for (const s of (j && j.timeSeries) || []) {
      const type = String((((s.metric || {}).labels) || {}).type || '').toLowerCase();
      const field = type === 'input' ? 'in' : type === 'output' ? 'out' : null;
      if (!field) continue;   // any other label value is not a token bucket this row model can place
      const model = (((s.resource || {}).labels) || {}).model_user_id || 'vertex-ai';
      for (const p of s.points || []) {
        const v = (p && p.value) || {};
        const n = finTok(Number(v.int64Value ?? v.doubleValue ?? 0));
        if (!n) continue;
        const end = Date.parse(((p.interval || {}).endTime) || '');
        if (!Number.isFinite(end)) continue;
        agg.add(dayKeyUTC(end - 1000), 'Google Vertex AI', model, { [field]: n, msgs: 0 });
      }
    }
    pageToken = (j && j.nextPageToken) || null;
  } while (pageToken && ++pages < 50);
  const rows = agg.rows();
  let billed = [], costNote = '';   // [] = truthful empty when no billing table is configured → connectKey stores it (a previous table's envelope must not stay "fresh" behind "no billing table") · null = the BigQuery query failed → connectKey marks the stored envelope stale, the Monitoring rows above still land (never silently "fresh")
  if (table) try {   // the cost half only: a failure here degrades to billed: null (catch below) — the Monitoring rows are already in `rows`
    const body = { query: "SELECT DATE(usage_start_time) d, SUM(cost) c FROM `" + table + "` WHERE service.description = 'Vertex AI' AND usage_start_time >= TIMESTAMP('" + dayKeyUTC(startMs) + "') GROUP BY d ORDER BY d", useLegacySql: false, timeoutMs: 30000, maxResults: 1000 };
    const j = await cloudJSON(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(project)}/queries`, { method: 'POST', headers, body: JSON.stringify(body) }, auth);
    if (j && j.jobComplete === false) throw new Error('BigQuery did not finish within 30 s — sync again');
    billed = ((j && j.rows) || []).map(r => { const f = r.f || []; return { d: String((f[0] || {}).v || ''), amount: finAmt(parseFloat((f[1] || {}).v)) }; })
      .filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.d)).sort((a, b) => a.d < b.d ? -1 : 1);
  } catch (e) { billed = null; costNote = ' · cost unavailable: ' + (e.message || String(e)).slice(0, 80); }   // tokens-only sync: reported in the status line, not an error state
  const nModels = new Set(rows.map(r => r.model)).size;
  return { label: project,
    detail: `${rows.length} usage rows · ${nModels} model${nModels === 1 ? '' : 's'} · last ${days} days` + (table ? (billed ? ` · billed ${billed.length} day${billed.length === 1 ? '' : 's'} from the billing export` : costNote) : ' · no billing table — add the BigQuery export table for billed dollars'),
    rows, billed, meta: { days, project } };
}

/* ---------- AWS Signature V4 with WebCrypto (used by the Bedrock cloud-token fetcher; no SDK) ---------- */
const WEBCRYPTO_MSG = 'WebCrypto unavailable — open the file over file:// or https';
/** SHA-256 hex of a string or byte array. */
async function sha256Hex(data) {
  if (!(globalThis.crypto && globalThis.crypto.subtle)) throw new Error(WEBCRYPTO_MSG);
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const h = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
/** HMAC-SHA256(keyBytes, data) → Uint8Array (data: string or bytes). */
async function hmacSha256(keyBytes, data) {
  if (!(globalThis.crypto && globalThis.crypto.subtle)) throw new Error(WEBCRYPTO_MSG);
  const key = await globalThis.crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, typeof data === 'string' ? new TextEncoder().encode(data) : data);
  return new Uint8Array(sig);
}
/** RFC 3986 percent-encoding (encodeURIComponent + the five characters it leaves alone). */
const awsEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
/** AWS SigV4. Returns the headers to send: the input headers (caller's casing) + host, x-amz-date, x-amz-content-sha256, optional
 *  x-amz-security-token, authorization. Canonical request: method · canonical URI (the URL parser already percent-encodes each path
 *  segment once; AWS wants non-S3 paths encoded twice, so each segment is encoded once more — for the '/' root path CloudWatch and
 *  Cost Explorer use this is a no-op) · canonical query (RFC 3986, sorted by key then value) · canonical headers (lower-cased names,
 *  sorted; values trimmed with inner whitespace collapsed) · signed-header list · SHA-256 of the body (or of the empty string).
 *  String to sign: 'AWS4-HMAC-SHA256' / amzDate / date/region/service/aws4_request / hash(canonical). Signing key: HMAC chain from
 *  'AWS4' + secret over date → region → service → 'aws4_request'. Same algorithm as the AWS SigV4 test suite (whose get-vanilla vector
 *  omits x-amz-content-sha256 — this signer always includes it; the pinned vectors in 87d-wave2-cloud are the reference). */
async function sigv4Sign({ method = 'POST', url, headers = {}, body = '', service, region, accessKeyId, secretAccessKey, sessionToken, now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20260810T120000Z
  const date = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body || '');
  const canon = {};
  for (const [k, v] of Object.entries(headers)) canon[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  canon.host = u.host; canon['x-amz-date'] = amzDate; canon['x-amz-content-sha256'] = payloadHash;
  if (sessionToken) canon['x-amz-security-token'] = sessionToken;
  const names = Object.keys(canon).sort();
  const signedHeaders = names.join(';');
  const canonicalUri = u.pathname.split('/').map(awsEncode).join('/') || '/';
  const canonicalQuery = [...u.searchParams.entries()].map(([k, v]) => [awsEncode(k), awsEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([k, v]) => k + '=' + v).join('&');
  const canonicalRequest = [method.toUpperCase(), canonicalUri, canonicalQuery, names.map(n => n + ':' + canon[n] + '\n').join(''), signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  let k = await hmacSha256(new TextEncoder().encode('AWS4' + secretAccessKey), date);
  k = await hmacSha256(k, region); k = await hmacSha256(k, service); k = await hmacSha256(k, 'aws4_request');
  const signature = [...await hmacSha256(k, stringToSign)].map(b => b.toString(16).padStart(2, '0')).join('');
  const out = { ...headers, host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };   // fetch drops the forbidden `host` header itself; it is listed because it is signed
  if (sessionToken) out['x-amz-security-token'] = sessionToken;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

/** AWS Bedrock — cloud-token fetcher. key: access key id; fields: { secret, session?, region }; opts: { days }. Every request is SigV4-signed
 *  in-page (sigv4Sign) — key, secret and session token are used for these requests only, never stored. (1) CloudWatch ListMetrics
 *  (AWS/Bedrock · InputTokenCount · dimension ModelId only) → the model ids that reported in the last two weeks (an idle model's older
 *  days are therefore not pulled); (2) CloudWatch GetMetricData: InputTokenCount + OutputTokenCount, Sum, Period 86400 from a UTC
 *  midnight (≤ 500 queries per call, NextToken paged) → exact tokens per model × UTC day, msgs 0 (request counts not pulled);
 *  (3) Cost Explorer GetCostAndUsage (served from us-east-1 only; $0.01 per request; ~24 h lag), DAILY UnblendedCost filtered to
 *  SERVICE 'Amazon Bedrock' → billed per day (zero days included). A Cost Explorer failure (e.g. no ce:GetCostAndUsage) degrades to
 *  tokens-only (billed: null → connectKey marks the stored billed envelope stale) and is reported in the status line; CloudWatch failures
 *  are errors (403 → the AWS rejection message). */
async function fetchBedrock(key, fields, opts = {}) {
  const days = Math.max(1, opts.days || 90);
  const accessKeyId = String(key || '').trim(), secretAccessKey = String(fields.secret || '').trim(), sessionToken = String(fields.session || '').trim() || undefined;
  const region = (String(fields.region || '').trim() || 'us-east-1').toLowerCase();
  if (!secretAccessKey) throw new Error('Enter the secret access key (use a read-only IAM user: cloudwatch:GetMetricData, cloudwatch:ListMetrics, ce:GetCostAndUsage)');
  if (!/^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d$/.test(region)) throw new Error('Region must look like us-east-1');
  const auth = { denied: 'AWS returned 403 — bad key/secret/session token or region, or the IAM user lacks the read-only policy' };
  const call = async (host, service, svcRegion, target, contentType, body) => {
    const url = `https://${host}/`;
    const headers = await sigv4Sign({ method: 'POST', url, headers: { 'Content-Type': contentType, 'X-Amz-Target': target }, body, service, region: svcRegion, accessKeyId, secretAccessKey, sessionToken, now: new Date() });
    return cloudJSON(url, { method: 'POST', headers, body }, auth);
  };
  const cw = (target, body) => call(`monitoring.${region}.amazonaws.com`, 'monitoring', region, 'GraniteServiceVersion20100801.' + target, 'application/x-amz-json-1.0', JSON.stringify(body));
  // (1) model ids — only metrics whose dimension set is exactly [ModelId]; other sets (ModelId+ImageSize …) are separate metrics GetMetricData would not match
  const models = []; let next = null, guard = 0;
  do {
    const j = await cw('ListMetrics', { Namespace: 'AWS/Bedrock', MetricName: 'InputTokenCount', ...(next ? { NextToken: next } : {}) });
    for (const m of (j && j.Metrics) || []) {
      const dims = m.Dimensions || [];
      if (dims.length === 1 && dims[0].Name === 'ModelId' && dims[0].Value && !models.includes(dims[0].Value)) models.push(dims[0].Value);
    }
    next = (j && j.NextToken) || null;
  } while (next && ++guard < 20);
  // (2) exact tokens per model × UTC day — StartTime on a UTC midnight so the 86400-s periods are calendar days
  const agg = makeAgg();
  const now = new Date(), nowSec = Math.floor(now.getTime() / 1000);
  const startSec = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000) - days * 86400;
  for (let i = 0; i < models.length; i += 250) {   // 2 queries per model → ≤ 500 MetricDataQueries per call (the API limit)
    const batch = models.slice(i, i + 250), queries = [];
    batch.forEach((m, k) => {
      for (const [pfx, metric] of [['in', 'InputTokenCount'], ['out', 'OutputTokenCount']])
        queries.push({ Id: pfx + (i + k), MetricStat: { Metric: { Namespace: 'AWS/Bedrock', MetricName: metric, Dimensions: [{ Name: 'ModelId', Value: m }] }, Period: 86400, Stat: 'Sum' }, ReturnData: true });
    });
    let token = null, pages = 0;
    do {
      const j = await cw('GetMetricData', { StartTime: startSec, EndTime: nowSec, MetricDataQueries: queries, ScanBy: 'TimestampAscending', ...(token ? { NextToken: token } : {}) });
      for (const r of (j && j.MetricDataResults) || []) {
        const mm = /^(in|out)(\d+)$/.exec(r.Id || ''); if (!mm) continue;
        const model = models[+mm[2]]; if (!model) continue;
        const ts = r.Timestamps || [], vs = r.Values || [];
        for (let k = 0; k < ts.length; k++) {
          const v = finTok(Number(vs[k])); if (!v) continue;
          const t = ts[k]; const d = dayKeyUTC(typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : t); if (!d) continue;   // JSON 1.0 returns epoch SECONDS (< 1e12 → ×1000; ms and ISO strings also accepted)
          agg.add(d, 'AWS Bedrock', model, { [mm[1]]: v, msgs: 0 });
        }
      }
      token = (j && j.NextToken) || null;
    } while (token && ++pages < 50);
  }
  const rows = agg.rows();
  // (3) billed per day — Cost Explorer is served from us-east-1 only; failure degrades to tokens-only
  let billed = null, costNote = '';   // array = fresh · null = Cost Explorer failed → connectKey marks the stored billed envelope stale (never silently "fresh")
  try {
    const start = dayKeyUTC(startSec * 1000), end = dayKeyUTC(now.getTime() + 864e5);   // End is exclusive → tomorrow
    const byDay = new Map(); let tok = null, pages = 0;
    do {
      const j = await call('ce.us-east-1.amazonaws.com', 'ce', 'us-east-1', 'AWSInsightsIndexService.GetCostAndUsage', 'application/x-amz-json-1.1',
        JSON.stringify({ TimePeriod: { Start: start, End: end }, Granularity: 'DAILY', Metrics: ['UnblendedCost'], Filter: { Dimensions: { Key: 'SERVICE', Values: ['Amazon Bedrock'] } }, ...(tok ? { NextPageToken: tok } : {}) }));
      for (const r of (j && j.ResultsByTime) || []) {
        const d = String(((r.TimePeriod || {}).Start) || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
        byDay.set(d, (byDay.get(d) || 0) + finAmt(parseFloat((((r.Total || {}).UnblendedCost) || {}).Amount)));
      }
      tok = (j && j.NextPageToken) || null;
    } while (tok && ++pages < 20);
    billed = [...byDay.entries()].map(([d, amount]) => ({ d, amount })).sort((a, b) => a.d < b.d ? -1 : 1);
  } catch (e) { billed = null; costNote = ' · cost unavailable: ' + (e.message || String(e)).slice(0, 80); }
  return { label: `${region} · key …${accessKeyId.slice(-4)}`,
    detail: `${models.length} model${models.length === 1 ? '' : 's'} seen by CloudWatch (last 2 weeks) · ${rows.length} usage rows · last ${days} days` + (billed ? ` · billed ${billed.length} day${billed.length === 1 ? '' : 's'} from Cost Explorer ($0.01 per request)` : costNote),
    rows, billed, meta: { days, region, models: models.length } };
}

/** GitHub Copilot — PAT; key-driver fetcher (App.connectKey). /user validates (the login is the label); the billing usage endpoint feeds rows + billed.
 *  rows / billed are null when GitHub has no usage endpoint for this account (404 — stored rows untouched, a stored billed envelope goes stale) and []
 *  when it answered with no Copilot items (a truthful empty); any other failure is the card's error (A0 #4, #5). */
async function fetchCopilotAll(token) {
  const h = { 'Authorization': 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28', 'Accept': 'application/vnd.github+json' };
  const user = await fetchJSON('https://api.github.com/user', h);
  const usage = await fetchJSONOrNotFound('https://api.github.com/users/' + encodeURIComponent(user.login) + '/settings/billing/usage?year=' + new Date().getUTCFullYear(), h);
  if (usage === null) return { label: user.login, detail: 'validated — GitHub exposes no usage data for this account', rows: null, billed: null };
  const agg2 = makeAgg(); const billed = new Map();
  for (const it of usage.usageItems || usage.usage_items || []) {
    if (!String(it.product || '').toLowerCase().includes('copilot')) continue;
    const d = copilotItemDay(it); if (!d) continue;
    agg2.add(d, 'GitHub Copilot', it.sku || 'copilot', { msgs: finTok(it.quantity), est: 1 });
    billed.set(d, (billed.get(d) || 0) + finAmt(it.netAmount ?? it.net_amount ?? 0));
  }
  const rows = agg2.rows();
  return { label: user.login, rows, billed: [...billed.entries()].map(([d, amount]) => ({ d, amount })),
    detail: rows.length ? `${rows.length} usage rows (premium requests) + billed costs` : 'validated — no Copilot usage in the billing data' };
}
/** YYYY-MM-DD of a GitHub billing usage item: its date, else the 1st of its year/month; null when it carries neither (never 'undefined-undefined-01', A0 #24). */
function copilotItemDay(it) {
  const d = String(it.date || '').slice(0, 10);
  if (RE_DATEONLY.test(d)) return d;
  if (Number.isInteger(+it.year) && it.year != null && Number.isInteger(+it.month) && it.month != null) return it.year + '-' + String(it.month).padStart(2, '0') + '-01';
  return null;
}

/** OpenRouter — API key; key-driver fetcher (App.connectKey). /key validates (its label is the card label); /credits and /activity may be missing for
 *  a key type (404 → null: stored rows untouched, a stored billed envelope goes stale); rows / billed are [] when activity answered with no days
 *  (a truthful empty). Any other failure is the card's error (A0 #4, #5). The credits left ride in the detail. */
async function fetchOpenRouterAll(key) {
  const h = { 'Authorization': 'Bearer ' + key };
  const info = await fetchJSON('https://openrouter.ai/api/v1/key', h);
  const credits = await fetchJSONOrNotFound('https://openrouter.ai/api/v1/credits', h);
  const act = await fetchJSONOrNotFound('https://openrouter.ai/api/v1/activity', h);
  const label = (info.data && info.data.label) || 'OpenRouter key';
  const creditsNote = credits && credits.data ? ` · ${fmtUSD((credits.data.total_credits || 0) - (credits.data.total_usage || 0))} credits left` : '';
  if (act === null) return { label, detail: `validated${creditsNote} — daily activity not available for this key type`, rows: null, billed: null };
  const agg2 = makeAgg(); const bm = new Map();
  for (const a of act.data || []) {
    const d = String(a.date || '').slice(0, 10);
    agg2.add(d, 'OpenRouter', a.model || 'openrouter', { in: finTok(a.prompt_tokens), out: finTok(a.completion_tokens), msgs: finTok(a.requests) });
    bm.set(d, (bm.get(d) || 0) + finAmt(a.usage || 0));
  }
  const rows = agg2.rows();
  return { label, detail: `${rows.length} daily activity rows${creditsNote}`, rows, billed: [...bm.entries()].map(([d, amount]) => ({ d, amount })) };
}

/** Status-line detail the Anthropic and OpenAI Admin fetchers share: the usage row count, "+ billed costs" when the cost report returned days,
 *  "cost report unavailable" when it failed (billed null → connectKey marks the stored envelope stale). */
function adminUsageDetail(rows, billed) {
  return `${rows.length} usage rows${billed === null ? ' · cost report unavailable' : billed.length ? ' + billed costs' : ''}`;
}
/** Anthropic Admin key — key-driver fetcher (App.connectKey): usage_report/messages in daily buckets grouped by model + cost_report, each paginated
 *  via has_more/next_page over opts.days (the card's days select). A cost_report failure degrades to billed: null — the usage rows still land and
 *  the status line says "cost report unavailable". Any usage failure is the card's error. */
async function fetchAnthropicAll(key, fields, opts) {
  const days = (opts && opts.days) || 90;
  const start = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10) + 'T00:00:00Z';
  const headers = {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  const merged = { data: [] };
  let page = null;
  for (let i = 0; i < 40; i++) {
    const url = new URL('https://api.anthropic.com/v1/organizations/usage_report/messages');
    url.searchParams.set('starting_at', start);
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.append('group_by[]', 'model');
    url.searchParams.set('limit', '31');
    if (page) url.searchParams.set('page', page);
    const j = await fetchJSON(url, headers);
    merged.data.push(...(j.data || []));
    if (!j.has_more || !j.next_page) break;
    page = j.next_page;
  }
  let cost = null;
  try {
    const cmerged = { data: [] };
    let cpage = null;
    for (let i = 0; i < 40; i++) {
      const curl = new URL('https://api.anthropic.com/v1/organizations/cost_report');
      curl.searchParams.set('starting_at', start);
      curl.searchParams.set('bucket_width', '1d');
      curl.searchParams.set('limit', '31');
      if (cpage) curl.searchParams.set('page', cpage);
      const j = await fetchJSON(curl, headers);
      cmerged.data.push(...(j.data || []));
      if (!j.has_more || !j.next_page) break;
      cpage = j.next_page;
    }
    cost = parseAnthropicCost(cmerged);
  } catch (e) { console.warn('anthropic cost report failed', e); }
  const rows = parseAnthropicUsage(merged).rows;
  return { rows, billed: cost, detail: adminUsageDetail(rows, cost), meta: { days } };
}

/* ---------- Claude Enterprise Analytics API (Enterprise orgs; Analytics key, scope read:analytics) ---------- */
/** Key-driver fetcher: usage_report + cost_report under /v1/organizations/analytics/, daily buckets grouped by model, fetched in
 *  ≤31-day half-open windows [starting_at, ending_at) aligned to UTC midnight (today included), each window paginated via
 *  has_more/next_page. starting_at is clamped to 2026-01-01T00:00:00Z (the API refuses earlier dates). Same headers as the
 *  Anthropic Admin card. Rows carry platform 'Claude Enterprise (org)'; cost amounts are cents (parseAnthropicCost divides). */
async function fetchClaudeEnterprise(key, fields, opts) {
  const days = (opts && opts.days) || 90;
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
  const dayMs = 864e5, now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const floor = Date.parse('2026-01-01T00:00:00Z');
  const startAll = Math.max(todayUTC - days * dayMs, floor);
  const endAll = todayUTC + dayMs;   // through the end of today (UTC)
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10) + 'T00:00:00Z';
  const windows = [];
  for (let s = startAll; s < endAll;) { const e = Math.min(s + 31 * dayMs, endAll); windows.push([s, e]); s = e; }
  const pull = async (report) => {
    const merged = { data: [] };
    for (const [s, e] of windows) {
      let page = null;
      for (let i = 0; i < 40; i++) {
        const url = new URL('https://api.anthropic.com/v1/organizations/analytics/' + report);
        url.searchParams.set('starting_at', iso(s)); url.searchParams.set('ending_at', iso(e));
        url.searchParams.set('bucket_width', '1d');
        url.searchParams.append('group_by[]', 'model');
        url.searchParams.set('limit', '31');
        if (page) url.searchParams.set('page', page);
        const j = await fetchJSON(url, headers);
        merged.data.push(...(j.data || []));
        if (!j.has_more || !j.next_page) break;
        page = j.next_page;
      }
    }
    return merged;
  };
  const usage = parseAnthropicUsage(await pull('usage_report'), 'Claude Enterprise (org)');
  let billed = null;
  try { billed = parseAnthropicCost(await pull('cost_report')); } catch (e) { console.warn('claude enterprise cost report failed', e); }
  const since = iso(startAll).slice(0, 10);
  return { label: 'Analytics key · last 4: ' + key.slice(-4), rows: usage.rows, billed,
    detail: `${usage.rows.length} usage rows${billed ? (billed.length ? ' + billed costs' : ' · no cost rows (seat-based plan, or no usage-based charges yet)') : ' · cost report unavailable'} · since ${since} in ${windows.length} window${windows.length === 1 ? '' : 's'}`,
    meta: { days, since, windows: windows.length } };
}

/** OpenAI Admin key — key-driver fetcher (App.connectKey): /v1/organization/usage/completions in daily buckets grouped by model + /v1/organization/costs,
 *  each paginated via has_more/next_page over opts.days (the card's days select). A costs failure degrades to billed: null — the usage rows still land
 *  and the status line says "cost report unavailable". Any usage failure is the card's error. */
async function fetchOpenAIAll(key, fields, opts) {
  const days = (opts && opts.days) || 90;
  const start = Math.floor(Date.now() / 1000) - days * 86400;
  const headers = { 'Authorization': 'Bearer ' + key };
  const merged = { data: [] };
  let page = null;
  for (let i = 0; i < 40; i++) {
    const url = new URL('https://api.openai.com/v1/organization/usage/completions');
    url.searchParams.set('start_time', String(start));
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.set('group_by', 'model');
    url.searchParams.set('limit', '31');
    if (page) url.searchParams.set('page', page);
    const j = await fetchJSON(url, headers);
    merged.data.push(...(j.data || []));
    if (!j.has_more || !j.next_page) break;
    page = j.next_page;
  }
  let cost = null;
  try {
    const cmerged = { data: [] };
    let cpage = null;
    for (let i = 0; i < 40; i++) {
      const curl = new URL('https://api.openai.com/v1/organization/costs');
      curl.searchParams.set('start_time', String(start));
      curl.searchParams.set('bucket_width', '1d');
      curl.searchParams.set('limit', '180');
      if (cpage) curl.searchParams.set('page', cpage);
      const j = await fetchJSON(curl, headers);
      cmerged.data.push(...(j.data || []));
      if (!j.has_more || !j.next_page) break;
      cpage = j.next_page;
    }
    cost = parseOpenAICost(cmerged);
  } catch (e) { console.warn('openai costs failed', e); }
  const rows = parseOpenAIUsage(merged).rows;
  return { rows, billed: cost, detail: adminUsageDetail(rows, cost), meta: { days } };
}

/* ---------- PowerShell fallback commands ---------- */
function anthropicPSCommand(_key, days) {
  return `$k = Read-Host "Paste your Anthropic Admin key"
$h = @{ "x-api-key" = $k; "anthropic-version" = "2023-06-01" }
$s = (Get-Date).AddDays(-${days}).ToUniversalTime().ToString("yyyy-MM-ddT00:00:00Z")
$all = @(); $page = $null
do {
  $u = "https://api.anthropic.com/v1/organizations/usage_report/messages?starting_at=$s&bucket_width=1d&group_by[]=model&limit=31"
  if ($page) { $u += "&page=$page" }
  $r = Invoke-RestMethod -Uri $u -Headers $h
  $all += $r.data; $page = $r.next_page
} while ($r.has_more)
@{ data = $all } | ConvertTo-Json -Depth 12 | Out-File "$env:USERPROFILE\\Desktop\\anthropic-usage.json" -Encoding utf8
Write-Host "Saved to Desktop\\anthropic-usage.json"`;
}
function openaiPSCommand(_key, days) {
  return `$k = Read-Host "Paste your OpenAI Admin key"
$h = @{ "Authorization" = "Bearer $k" }
$s = [DateTimeOffset]::UtcNow.AddDays(-${days}).ToUnixTimeSeconds()
$all = @(); $page = $null
do {
  $u = "https://api.openai.com/v1/organization/usage/completions?start_time=$s&bucket_width=1d&group_by=model&limit=31"
  if ($page) { $u += "&page=$page" }
  $r = Invoke-RestMethod -Uri $u -Headers $h
  $all += $r.data; $page = $r.next_page
} while ($r.has_more)
@{ data = $all } | ConvertTo-Json -Depth 12 | Out-File "$env:USERPROFILE\\Desktop\\openai-usage.json" -Encoding utf8
Write-Host "Saved to Desktop\\openai-usage.json"`;
}

