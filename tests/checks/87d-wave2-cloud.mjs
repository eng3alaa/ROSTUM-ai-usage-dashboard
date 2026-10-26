import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDashboard, OUT } from '../lib/harness.mjs';

const read = (...p) => fs.readFileSync(path.join(OUT, ...p), 'utf8');
// Reference SigV4 (node:crypto) for the unit check — independent of the page's WebCrypto implementation. Same canonicalization / HMAC
// chain as the AWS SigV4 test suite; note the suite's "get-vanilla" vector (Signature=5fa00fa3…) signs host;x-amz-date ONLY, while this
// signer (and the page's) always adds x-amz-content-sha256 — so that vector is not reproduced verbatim; the two PINNED constants below
// (recomputed independently by the plan reviewer with node:crypto — they match) are the reference for this implementation.
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();
function refSigV4({ method, url, headers, body, service, region, accessKeyId, secretAccessKey, sessionToken, now }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''), date = amzDate.slice(0, 8);
  const payloadHash = sha256(body || '');
  const all = {}; for (const [k, v] of Object.entries(headers)) all[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  all.host = u.host; all['x-amz-date'] = amzDate; all['x-amz-content-sha256'] = payloadHash;
  if (sessionToken) all['x-amz-security-token'] = sessionToken;
  const names = Object.keys(all).sort();
  const canonical = [method, u.pathname || '/', '', names.map(n => n + ':' + all[n] + '\n').join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  let k = hmac('AWS4' + secretAccessKey, date); k = hmac(k, region); k = hmac(k, service); k = hmac(k, 'aws4_request');
  return { amzDate, payloadHash, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(k, toSign).toString('hex')}` };
}

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    // ---- T10: cloud-token plumbing + Azure OpenAI (Monitor metrics + Cost Management) ----
    const azMetrics = read('wave2', 'azure', 'metrics.json'), azEast = read('wave2', 'azure', 'metrics-east.json'), azCost = read('wave2', 'azure', 'cost.json');
    const az = await page.evaluate(async (metricsText, eastText, costText) => {
      const c = connectorById('azure-openai');
      if (!c || typeof App.connectKey !== 'function' || typeof fetchAzureOpenAI !== 'function' || typeof cloudJSON !== 'function') return { missing: true };
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      App.ensureSourceCard(c);   // idempotent — init already rendered it (Task 2)
      const card = document.getElementById('src-azure-openai');
      const keyEl = document.getElementById('azure-openai-key'), resEl = document.getElementById('azure-openai-f-resources'), scopeEl = document.getElementById('azure-openai-f-scope');
      const ui = { card: !!card, note: card ? [...card.querySelectorAll('.session-only')].map(n => n.textContent) : [], placeholder: keyEl && keyEl.getAttribute('placeholder'), pwd: keyEl && keyEl.type,
        noRemember: card ? !card.querySelector('input[type="checkbox"]') : false, textarea: resEl && resEl.tagName, scopeInput: scopeEl && scopeEl.tagName,
        reg: { kind: c.kind, cat: c.category, so: c.sessionOnly === true, q: c.quality, fetch: c.fetch, platform: c.platform, srcIds: c.srcIds, statusEl: c.statusEl, fields: (c.fields || []).map(f => f.id) } };
      const calls = [];
      const origFetch = window.fetch;
      const stub = async (url, init = {}) => {   // west = the two-generation resource, east = the legacy-only resource (metrics-east.json)
        const u = String(url); const h = {}; for (const [k, v] of Object.entries(init.headers || {})) h[k.toLowerCase()] = String(v);
        calls.push({ url: u, method: init.method || 'GET', headers: h, body: init.body || null });
        if (u.includes('/providers/microsoft.insights/metrics')) return new Response(u.includes('/accounts/aoai-west/') ? metricsText : u.includes('/accounts/aoai-east/') ? eastText : JSON.stringify({ value: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (u.includes('/providers/Microsoft.CostManagement/query')) return new Response(costText, { status: 200, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ error: { code: 'NotFound', message: 'unexpected ' + u } }), { status: 404, headers: { 'content-type': 'application/json' } });
      };
      window.fetch = stub;
      // the Monitor timespan must start on a UTC midnight (today 00:00Z − 90 d) so P1D buckets are calendar UTC days; computed before AND after the call in case midnight rolls over meanwhile
      const midnightStart = (t) => { const n = new Date(t); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) - 90 * 864e5).toISOString().replace(/\.\d{3}Z$/, 'Z'); };
      const TWO_RES = '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/aoai-west\n\n/subscriptions/s1/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/aoai-east\n';
      let out;
      try {
        keyEl.value = 'eyJ-test-token-azure';
        resEl.value = TWO_RES;
        scopeEl.value = '/subscriptions/s1';
        const t0 = Date.now();
        await App.connectKey(c);
        const t1 = Date.now();
        const rows = (Store.sources['azure-openai'] || { rows: [] }).rows;
        const t = rows.reduce((a, r) => ({ in: a.in + r.in, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, out: 0, msgs: 0 });
        const st = Store.connectors['azure-openai'] || {};
        const happy = { ...t, n: rows.length, models: [...new Set(rows.map(r => r.model))].sort(), days: [...new Set(rows.map(r => r.d))].sort(), platforms: [...new Set(rows.map(r => r.platform))],
          est: rows.some(r => r.est), byKey: rows.map(r => r.d + '|' + r.model + '|' + r.in + '|' + r.out).sort(),
          billed: Store.billedRows('azure-openai'), billedStale: (Store.billed['azure-openai'] || {}).stale, status: Store.connectorStatus(c), label: st.label, err: st.err || null,
          statusText: document.getElementById('azure-openai-status').textContent, tsStartWant: [midnightStart(t0), midnightStart(t1)], t0, t1 };
        const metricsCalls = calls.filter(x => x.url.includes('/microsoft.insights/metrics')).map(x => { const p = new URL(x.url); return { host: p.host, path: p.pathname, auth: x.headers.authorization, method: x.method, q: Object.fromEntries(p.searchParams.entries()) }; });
        const costCalls = calls.filter(x => x.url.includes('/Microsoft.CostManagement/query')).map(x => { const p = new URL(x.url); return { host: p.host, path: p.pathname, auth: x.headers.authorization, method: x.method, ct: x.headers['content-type'], q: Object.fromEntries(p.searchParams.entries()), body: JSON.parse(x.body) }; });
        // nothing secret in storage: no key entry, and the token string appears in NO aiusage:* value (non-secret fields DO persist — resource ids / scope are not secrets)
        const lsKeys = Object.keys(localStorage).filter(k => k.startsWith('aiusage:'));
        const storage = { keyEntry: localStorage.getItem('aiusage:key:azure-openai'), tokenLeaked: lsKeys.some(k => String(localStorage.getItem(k)).includes('eyJ-test-token-azure')), scopeField: LS.get('field:azure-openai:scope', null) };
        // Cost Management rejected (Monitoring Reader without Cost Management Reader: 403 on the cost POST, metrics fine) → billed: null — tokens still land,
        // the previous 2-day envelope is kept and marked stale, the status line says "cost unavailable", NOT an error state (Bedrock's contract)
        window.fetch = async (url, init = {}) => { const u = String(url); if (u.includes('/Microsoft.CostManagement/query')) return new Response(JSON.stringify({ error: { code: 'AuthorizationFailed', message: "The client does not have authorization to perform action 'Microsoft.CostManagement/query/action' over scope '/subscriptions/s1'" } }), { status: 403, headers: { 'content-type': 'application/json' } }); return stub(url, init); };
        delete Store.sources['azure-openai'];   // so the 4 rows read back below prove THIS sync landed them (not the happy run's leftovers)
        await App.connectKey(c);
        const degraded = { err: (Store.connectors['azure-openai'] || {}).err || null, status: Store.connectorStatus(c), statusText: document.getElementById('azure-openai-status').textContent, rows: (Store.sources['azure-openai'] || { rows: [] }).rows.length,
          billedStale: (Store.billed['azure-openai'] || {}).stale, billedKept: Store.billedRows('azure-openai').map(b => b.d + '|' + b.amount) };
        // A0 #19: a Cost Management nextLink pointing off management.azure.com is refused — the bearer token never travels there; the cost half degrades like any cost failure, the Monitor rows land
        const evilCost = JSON.parse(costText); evilCost.properties.nextLink = 'https://management.azure.com.evil.example/subscriptions/s1/providers/Microsoft.CostManagement/query?skiptoken=x';
        calls.length = 0;
        window.fetch = async (url, init = {}) => { const u = String(url); if (u.includes('management.azure.com/subscriptions/s1/providers/Microsoft.CostManagement/query')) { calls.push({ url: u, method: 'POST', headers: {}, body: init.body || null }); return new Response(JSON.stringify(evilCost), { status: 200, headers: { 'content-type': 'application/json' } }); } return stub(url, init); };
        await App.connectKey(c);
        const hostCheck = { evilCalls: calls.filter(x => /evil\.example/.test(x.url)).length, costCalls: calls.filter(x => x.url.includes('/Microsoft.CostManagement/query')).length, err: (Store.connectors['azure-openai'] || {}).err || null, status: Store.connectorStatus(c),
          statusText: document.getElementById('azure-openai-status').textContent, billedStale: (Store.billed['azure-openai'] || {}).stale, rows: (Store.sources['azure-openai'] || { rows: [] }).rows.length };
        // expired token: 401 → the "mint a new one" message, attention state
        window.fetch = async () => new Response(JSON.stringify({ error: { code: 'ExpiredAuthenticationToken', message: 'The access token expiry UTC time is earlier than current UTC time.' } }), { status: 401, headers: { 'content-type': 'application/json' } });
        await App.connectKey(c);
        const expired = { err: (Store.connectors['azure-openai'] || {}).err || null, status: Store.connectorStatus(c), statusText: document.getElementById('azure-openai-status').textContent };
        // no resource ids → a clear message and NO network call
        let n0 = 0; window.fetch = async () => { n0++; return new Response('{}', { status: 200 }); };
        resEl.value = '   ';
        await App.connectKey(c);
        const noRes = { err: (Store.connectors['azure-openai'] || {}).err || null, calls: n0 };
        // SECURITY: the cost scope is concatenated into the management.azure.com URL — anything but /subscriptions/<id>[/resourceGroups/<rg>]
        // (a host suffix, a userinfo '@', a deeper path, a query/fragment) must be rejected BEFORE any network call (the bearer token would
        // otherwise travel to management.azure.com.evil.example) and must never be persisted (refreshAll would replay it after a reload)
        resEl.value = TWO_RES;
        const badScopes = ['.evil.example', '@evil.example/subscriptions/s1', '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.CostManagement', '/subscriptions/s1?api-version=2019-11-01', '/subscriptions/s1#x', 'subscriptions/s1', '/subscriptions/s1\\..\\..'];
        const badScope = [];
        for (const s of badScopes) {
          let n = 0; window.fetch = async () => { n++; return new Response('{}', { status: 200 }); };
          scopeEl.value = s;
          await App.connectKey(c);
          badScope.push({ s, calls: n, err: (Store.connectors['azure-openai'] || {}).err || null, status: Store.connectorStatus(c), statusText: document.getElementById('azure-openai-status').textContent, scopeLS: LS.get('field:azure-openai:scope', null) });
        }
        // a resource id carrying a query byte is not a resource id either (the strict form is /subscriptions/…/providers/Microsoft.CognitiveServices/accounts/<name>)
        let nBadRes = 0; window.fetch = async () => { nBadRes++; return new Response('{}', { status: 200 }); };
        scopeEl.value = '/subscriptions/s1'; resEl.value = '/subscriptions/s1?x=1/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/aoai-west';
        await App.connectKey(c);
        const badRes = { calls: nBadRes, err: (Store.connectors['azure-openai'] || {}).err || null, resLS: LS.get('field:azure-openai:resources', null) };
        // cost scope REMOVED → the fetcher has a billed path that is not configured now → billed: [] (truthful empty) replaces the previous
        // scope's envelope (never left "fresh" behind a status line that says "no cost scope"); no Cost Management call
        window.fetch = stub; calls.length = 0;
        resEl.value = TWO_RES; scopeEl.value = '';
        await App.connectKey(c);
        const noScope = { billed: Store.billedRows('azure-openai').length, stale: (Store.billed['azure-openai'] || {}).stale, rows: (Store.sources['azure-openai'] || { rows: [] }).rows.length,
          err: (Store.connectors['azure-openai'] || {}).err || null, status: Store.connectorStatus(c), statusText: document.getElementById('azure-openai-status').textContent,
          costCalls: calls.filter(x => x.url.includes('/Microsoft.CostManagement/query')).length, scopeLS: LS.get('field:azure-openai:scope', null) };
        out = { ui, happy, metricsCalls, costCalls, storage, expired, noRes, badScope, badRes, noScope, degraded, hostCheck };
      } finally {
        window.fetch = origFetch;
        keyEl.value = ''; resEl.value = ''; scopeEl.value = '';
        LS.del('field:azure-openai:resources'); LS.del('field:azure-openai:scope');
        Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.persist(); App._render();
      }
      return out;
    }, azMetrics, azEast, azCost);
    ok('azure: registry entry (cloud-token · sessionOnly · cloud group · exact · fetchAzureOpenAI · srcIds [azure-openai]) + card UI: one session-only note, keyHint placeholder, password input, no Remember box, textarea for resource ids',
      !az.missing && az.ui.card && az.ui.note.length === 1 && /kept in this tab only — never saved/.test(az.ui.note[0])
      && az.ui.placeholder === 'az account get-access-token --resource https://management.azure.com --query accessToken -o tsv' && az.ui.pwd === 'password' && az.ui.noRemember
      && az.ui.textarea === 'TEXTAREA' && az.ui.scopeInput === 'INPUT'
      && az.ui.reg.kind === 'cloud-token' && az.ui.reg.cat === 'cloud' && az.ui.reg.so && az.ui.reg.q === 'exact' && az.ui.reg.fetch === 'fetchAzureOpenAI' && az.ui.reg.platform === 'Azure OpenAI'
      && az.ui.reg.srcIds.join() === 'azure-openai' && az.ui.reg.statusEl === 'azure-openai-status' && az.ui.reg.fields.join() === 'resources,scope', JSON.stringify(az.ui || az));
    ok('azure (A0 #19): a Cost Management nextLink to management.azure.com.evil.example is refused before any request — 0 calls to that host, 1 cost call, the Monitor rows land (ok, no err), billed stays stale and the status line says the cost half is unavailable and names the refused host',
      !!az.hostCheck && az.hostCheck.evilCalls === 0 && az.hostCheck.costCalls === 1 && az.hostCheck.err === null && az.hostCheck.status === 'ok' && az.hostCheck.rows > 0 && az.hostCheck.billedStale === true
      && /cost unavailable/.test(az.hostCheck.statusText) && /management\.azure\.com/.test(az.hostCheck.statusText), JSON.stringify(az.hostCheck));
    // Expected (fixture comment in gen.mjs): west gpt-4o 08-10 1000/200 + east 150/0 (east's InputTokens 150 beats ITS OWN legacy 999) = 1150/200 ·
    // west gpt-4o 08-11 480/90 (newer wins over west's legacy 500/100) + east legacy 250/40 = 730/130 · gpt-4.1-mini 08-10 300/60 · azure-openai 08-12 0/7
    // → in = 1150+730+300+0 = 2180 · out = 200+130+60+7 = 397. A dedupe keyed by (day, model) across resources would read 930/357 instead.
    ok('azure: exact rows per model × UTC day — InputTokens/OutputTokens win over Processed/Generated for the same RESOURCE + model-day only (legacy tokens from a second resource are summed, not dropped: in=2180 out=397, 4 rows, 3 models), a point without total is no data, no metadata → azure-openai; billed per day from Cost Management (12.34, 1.66, stale:false); connected with label "2 resources"',
      !az.missing && az.happy.in === 2180 && az.happy.out === 397 && az.happy.msgs === 0 && az.happy.n === 4 && az.happy.models.join() === 'azure-openai,gpt-4.1-mini,gpt-4o'
      && az.happy.byKey.join(';') === '2026-08-10|gpt-4.1-mini|300|60;2026-08-10|gpt-4o|1150|200;2026-08-11|gpt-4o|730|130;2026-08-12|azure-openai|0|7'
      && az.happy.days.join() === '2026-08-10,2026-08-11,2026-08-12' && az.happy.platforms.join() === 'Azure OpenAI' && !az.happy.est
      && az.happy.billed.length === 2 && az.happy.billed[0].d === '2026-08-10' && Math.abs(az.happy.billed[0].amount - 12.34) < 1e-9 && az.happy.billed[1].d === '2026-08-11' && Math.abs(az.happy.billed[1].amount - 1.66) < 1e-9 && az.happy.billedStale === false
      && az.happy.status === 'ok' && az.happy.err === null && /^2 resources$/.test(az.happy.label || '') && /Connected/.test(az.happy.statusText) && /billed 2 days/.test(az.happy.statusText), JSON.stringify(az.happy));
    ok('azure: one Monitor GET per resource with Bearer auth + the documented query (api-version 2024-02-01, the 4 metric names, P1D, Total, ModelName filter, ISO timespan); one Cost Management POST to the scope (2025-03-01, ActualCost / Custom / Daily / PreTaxCost Sum / ServiceName In [Cognitive Services])',
      !az.missing && az.metricsCalls.length === 2 && az.metricsCalls.every(m => m.method === 'GET' && m.host === 'management.azure.com' && m.auth === 'Bearer eyJ-test-token-azure'
        && m.q['api-version'] === '2024-02-01' && m.q.metricnames === 'ProcessedPromptTokens,GeneratedTokens,InputTokens,OutputTokens' && m.q.interval === 'P1D' && m.q.aggregation === 'Total'
        && m.q['$filter'] === "ModelName eq '*'" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m.q.timespan))
      && az.metricsCalls.map(m => m.path).sort().join() === '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/aoai-east/providers/microsoft.insights/metrics,/subscriptions/s1/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/aoai-west/providers/microsoft.insights/metrics'
      && az.costCalls.length === 1 && (() => { const k = az.costCalls[0], b = k.body; return k.method === 'POST' && k.host === 'management.azure.com' && k.path === '/subscriptions/s1/providers/Microsoft.CostManagement/query'
        && k.q['api-version'] === '2025-03-01' && k.auth === 'Bearer eyJ-test-token-azure' && /application\/json/.test(k.ct || '') && b.type === 'ActualCost' && b.timeframe === 'Custom'
        && /^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test(b.timePeriod.from) && /^\d{4}-\d{2}-\d{2}T23:59:59Z$/.test(b.timePeriod.to) && b.dataset.granularity === 'Daily'
        && b.dataset.aggregation.totalCost.name === 'PreTaxCost' && b.dataset.aggregation.totalCost.function === 'Sum'
        && b.dataset.filter.dimensions.name === 'ServiceName' && b.dataset.filter.dimensions.operator === 'In' && b.dataset.filter.dimensions.values.join() === 'Cognitive Services'; })(),
      JSON.stringify({ m: az.metricsCalls, c: az.costCalls }));
    ok('azure: token never persisted (no aiusage:key:azure-openai; token in no aiusage:* value; the non-secret scope field persists); 401 → "token expired — mint a new one (az account get-access-token)" + attention; blank resource ids → clear error without a network call',
      !az.missing && az.storage.keyEntry === null && !az.storage.tokenLeaked && az.storage.scopeField === '/subscriptions/s1'
      && az.expired.err === 'token expired — mint a new one (az account get-access-token)' && az.expired.status === 'warn' && /token expired/.test(az.expired.statusText)
      && /resource id/i.test(az.noRes.err || '') && az.noRes.calls === 0, JSON.stringify({ storage: az.storage, expired: az.expired, noRes: az.noRes }));
    // Monitor buckets are anchored to the timespan START: a start at the sync time-of-day would stamp every P1D bucket with that hour and the
    // row with the previous UTC date; the page must start at today's UTC midnight − 90 d (the fixture's timeStamps are T00:00:00Z on that
    // premise) and the Cost Management timePeriod.from must be the same calendar day.
    ok('azure: Monitor timespan starts at a UTC midnight (today 00:00Z − 90 d) and ends at the sync time; the Cost Management timePeriod.from is that same day',
      !az.missing && az.metricsCalls.length === 2 && az.metricsCalls.every(m => { const [s, e] = String(m.q.timespan).split('/'); const eMs = Date.parse(e);
        return /T00:00:00Z$/.test(s) && az.happy.tsStartWant.includes(s) && eMs >= az.happy.t0 - 1000 && eMs <= az.happy.t1 + 1000; })
      && az.costCalls.length === 1 && az.happy.tsStartWant.some(s => s.slice(0, 10) + 'T00:00:00Z' === az.costCalls[0].body.timePeriod.from),
      JSON.stringify({ timespans: az.metricsCalls.map(m => m.q.timespan), want: az.happy.tsStartWant, from: az.costCalls.length && az.costCalls[0].body.timePeriod.from }));
    ok('azure SECURITY: a cost scope that is not /subscriptions/<id>[/resourceGroups/<rg>] (host suffix ".evil.example", "@evil.example/…", a deeper path, query, fragment, no leading slash, backslashes) is rejected with "Cost scope must be …" BEFORE any network call, warn state, and the last validated scope stays persisted (the bad value never reaches LS); a resource id with a query byte is rejected the same way',
      // connector err = the message's 80-char slice (existing hub contract); the status line carries the full message
      !az.missing && az.badScope.length === 7 && az.badScope.every(b => b.calls === 0 && /^Cost scope must be \/subscriptions\/<id> or \/subscriptions\/<id>\/resourceGroups\/<rg/.test(b.err || '') && b.status === 'warn'
        && /^Validation failed: Cost scope must be \/subscriptions\/<id> or \/subscriptions\/<id>\/resourceGroups\/<rg>$/.test(b.statusText) && b.scopeLS === '/subscriptions/s1')
      && az.badRes.calls === 0 && /resource id/i.test(az.badRes.err || '') && az.badRes.resLS !== null && !/\?/.test(az.badRes.resLS), JSON.stringify({ badScope: az.badScope, badRes: az.badRes }));
    ok('azure: cost scope removed → billed: [] (truthful empty) replaces the previous envelope (0 billed rows, stale:false, no Cost Management call), tokens still land (4 rows), status ok + "no cost scope", the scope LS entry is gone',
      !az.missing && az.noScope.billed === 0 && az.noScope.stale === false && az.noScope.costCalls === 0 && az.noScope.rows === 4 && az.noScope.err === null && az.noScope.status === 'ok'
      && /no cost scope/.test(az.noScope.statusText) && az.noScope.scopeLS === null, JSON.stringify(az.noScope));
    ok('azure: Cost Management failure (403 on the cost POST, metrics fine) degrades to billed: null — tokens still land (4 rows), the previous 2-day envelope is kept and marked stale:true, status ok (no error state) + "cost unavailable: HTTP 403 …" (the Bedrock contract: undefined = no billed path · null = failed → stale · [] = truthful empty · array = fresh)',
      !az.missing && az.degraded.rows === 4 && az.degraded.err === null && az.degraded.status === 'ok' && az.degraded.billedStale === true && az.degraded.billedKept.join(';') === '2026-08-10|12.34;2026-08-11|1.66'
      && /● Connected\./.test(az.degraded.statusText) && /cost unavailable: HTTP 403/.test(az.degraded.statusText) && !/billed \d+ day/.test(az.degraded.statusText), JSON.stringify(az.degraded));
    // ---- T11: Google Vertex AI (Monitoring token_count, paginated + BigQuery billing export) ----
    const vxP1 = read('wave2', 'vertex', 'timeseries-1.json'), vxP2 = read('wave2', 'vertex', 'timeseries-2.json'), vxBq = read('wave2', 'vertex', 'bigquery.json');
    const vx = await page.evaluate(async (p1, p2, bqText) => {
      const c = connectorById('vertex');
      if (!c || typeof App.connectKey !== 'function' || typeof fetchVertexAI !== 'function') return { missing: true };
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      App.ensureSourceCard(c);
      const card = document.getElementById('src-vertex');
      const keyEl = document.getElementById('vertex-key'), projEl = document.getElementById('vertex-f-project'), tblEl = document.getElementById('vertex-f-billingTable');
      const ui = { card: !!card, note: card ? card.querySelectorAll('.session-only').length : 0, placeholder: keyEl && keyEl.getAttribute('placeholder'), pwd: keyEl && keyEl.type, noRemember: card ? !card.querySelector('input[type="checkbox"]') : false,
        inputs: !!projEl && !!tblEl, reg: { kind: c.kind, cat: c.category, so: c.sessionOnly === true, q: c.quality, fetch: c.fetch, platform: c.platform, srcIds: c.srcIds, statusEl: c.statusEl, fields: (c.fields || []).map(f => f.id) } };
      const calls = [];
      const origFetch = window.fetch;
      window.fetch = async (url, init = {}) => {
        const u = String(url); const h = {}; for (const [k, v] of Object.entries(init.headers || {})) h[k.toLowerCase()] = String(v);
        calls.push({ url: u, method: init.method || 'GET', headers: h, body: init.body || null });
        if (u.startsWith('https://monitoring.googleapis.com/v3/projects/proj-a/timeSeries?')) { const p = new URL(u); return new Response(p.searchParams.get('pageToken') === 'p2' ? p2 : p1, { status: 200, headers: { 'content-type': 'application/json' } }); }
        if (u === 'https://bigquery.googleapis.com/bigquery/v2/projects/proj-a/queries') return new Response(bqText, { status: 200, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ error: { code: 404, message: 'unexpected ' + u, status: 'NOT_FOUND' } }), { status: 404, headers: { 'content-type': 'application/json' } });
      };
      let out;
      try {
        keyEl.value = 'ya29.test-token-vertex'; projEl.value = 'proj-a'; tblEl.value = 'proj-a.billing.gcp_billing_export_v1_ABC';
        await App.connectKey(c);
        const rows = (Store.sources.vertex || { rows: [] }).rows;
        const t = rows.reduce((a, r) => ({ in: a.in + r.in, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, out: 0, msgs: 0 });
        const st = Store.connectors.vertex || {};
        const happy = { ...t, n: rows.length, models: [...new Set(rows.map(r => r.model))].sort(), days: [...new Set(rows.map(r => r.d))].sort(), platforms: [...new Set(rows.map(r => r.platform))], est: rows.some(r => r.est),
          billed: Store.billedRows('vertex'), status: Store.connectorStatus(c), label: st.label, err: st.err || null, statusText: document.getElementById('vertex-status').textContent };
        const mon = calls.filter(x => x.url.includes('monitoring.googleapis.com')).map(x => { const p = new URL(x.url); return { method: x.method, auth: x.headers.authorization, path: p.pathname, filter: p.searchParams.get('filter'), start: p.searchParams.get('interval.startTime'), end: p.searchParams.get('interval.endTime'),
          period: p.searchParams.get('aggregation.alignmentPeriod'), aligner: p.searchParams.get('aggregation.perSeriesAligner'), reducer: p.searchParams.get('aggregation.crossSeriesReducer'), group: p.searchParams.getAll('aggregation.groupByFields'), pageToken: p.searchParams.get('pageToken') }; });
        const bq = calls.filter(x => x.url.includes('bigquery.googleapis.com')).map(x => ({ method: x.method, auth: x.headers.authorization, ct: x.headers['content-type'], body: JSON.parse(x.body) }));
        const lsKeys = Object.keys(localStorage).filter(k => k.startsWith('aiusage:'));
        const storage = { keyEntry: localStorage.getItem('aiusage:key:vertex'), tokenLeaked: lsKeys.some(k => String(localStorage.getItem(k)).includes('ya29.test-token-vertex')), project: LS.get('field:vertex:project', null) };
        // BigQuery rejected (monitoring.viewer without bigquery.jobUser: 403 on the query POST, Monitoring fine) → billed: null — tokens still land,
        // the previous 2-day envelope is kept and marked stale, the status line says "cost unavailable", NOT an error state (Bedrock's contract)
        window.fetch = async (url) => { const u = String(url); if (u.includes('bigquery.googleapis.com')) return new Response(JSON.stringify({ error: { code: 403, message: 'Access Denied: Project proj-a: User does not have bigquery.jobs.create permission in project proj-a.', status: 'PERMISSION_DENIED' } }), { status: 403, headers: { 'content-type': 'application/json' } }); const p = new URL(u); return new Response(p.searchParams.get('pageToken') === 'p2' ? p2 : p1, { status: 200, headers: { 'content-type': 'application/json' } }); };
        delete Store.sources.vertex;   // so the 4 rows read back below prove THIS sync landed them (not the happy run's leftovers)
        await App.connectKey(c);
        const degraded = { err: (Store.connectors.vertex || {}).err || null, status: Store.connectorStatus(c), statusText: document.getElementById('vertex-status').textContent, rows: (Store.sources.vertex || { rows: [] }).rows.length,
          billedStale: (Store.billed.vertex || {}).stale, billedKept: Store.billedRows('vertex').map(b => b.d + '|' + b.amount) };
        // 401 → token error; 403 → token rejected (role/expiry) — both attention
        window.fetch = async () => new Response(JSON.stringify({ error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } }), { status: 401, headers: { 'content-type': 'application/json' } });
        await App.connectKey(c);
        const expired = { err: (Store.connectors.vertex || {}).err || null, status: Store.connectorStatus(c) };
        window.fetch = async () => new Response(JSON.stringify({ error: { code: 403, message: 'Permission monitoring.timeSeries.list denied on project proj-a', status: 'PERMISSION_DENIED' } }), { status: 403, headers: { 'content-type': 'application/json' } });
        await App.connectKey(c);
        const denied = { err: (Store.connectors.vertex || {}).err || null, status: Store.connectorStatus(c) };
        // tokens-only when no billing table: no BigQuery call, detail says so
        window.fetch = async (url) => { const u = String(url); if (u.includes('bigquery')) throw new Error('must not query BigQuery without a table'); const p = new URL(u); return new Response(p.searchParams.get('pageToken') === 'p2' ? p2 : p1, { status: 200, headers: { 'content-type': 'application/json' } }); };
        tblEl.value = '';
        await App.connectKey(c);
        // billing table REMOVED after a run that billed 2 days → billed: [] (truthful empty) replaces that envelope; the table's LS entry goes away
        const noTable = { err: (Store.connectors.vertex || {}).err || null, status: Store.connectorStatus(c), statusText: document.getElementById('vertex-status').textContent, billed: Store.billedRows('vertex').length,
          stale: (Store.billed.vertex || {}).stale, tableLS: LS.get('field:vertex:billingTable', null), rows: (Store.sources.vertex || { rows: [] }).rows.length };
        out = { ui, happy, mon, bq, storage, expired, denied, noTable, degraded };
      } finally {
        window.fetch = origFetch;
        keyEl.value = ''; projEl.value = ''; tblEl.value = '';
        LS.del('field:vertex:project'); LS.del('field:vertex:billingTable');
        Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.persist(); App._render();
      }
      return out;
    }, vxP1, vxP2, vxBq);
    ok('vertex: registry entry (cloud-token · sessionOnly · cloud · exact · fetchVertexAI · platform Google Vertex AI) + card UI (session-only note, gcloud placeholder, password key, no Remember, project + billingTable inputs)',
      !vx.missing && vx.ui.card && vx.ui.note === 1 && vx.ui.placeholder === 'gcloud auth print-access-token' && vx.ui.pwd === 'password' && vx.ui.noRemember && vx.ui.inputs
      && vx.ui.reg.kind === 'cloud-token' && vx.ui.reg.cat === 'cloud' && vx.ui.reg.so && vx.ui.reg.q === 'exact' && vx.ui.reg.fetch === 'fetchVertexAI' && vx.ui.reg.platform === 'Google Vertex AI'
      && vx.ui.reg.srcIds.join() === 'vertex' && vx.ui.reg.statusEl === 'vertex-status' && vx.ui.reg.fields.join() === 'project,billingTable', JSON.stringify(vx.ui || vx));
    ok('vertex: exact rows per model × day across 2 Monitoring pages (in=9210 out=1250, 4 rows, 3 models incl. vertex-ai fallback, empty value ignored); billed per day from the BigQuery export (1.23, 2.5); label = project id',
      !vx.missing && vx.happy.in === 9210 && vx.happy.out === 1250 && vx.happy.msgs === 0 && vx.happy.n === 4 && vx.happy.models.join() === 'gemini-2.5-flash,gemini-2.5-pro,vertex-ai'
      && vx.happy.days.join() === '2026-08-10,2026-08-11' && vx.happy.platforms.join() === 'Google Vertex AI' && !vx.happy.est
      && vx.happy.billed.length === 2 && vx.happy.billed[0].d === '2026-08-10' && Math.abs(vx.happy.billed[0].amount - 1.23) < 1e-9 && vx.happy.billed[1].d === '2026-08-11' && Math.abs(vx.happy.billed[1].amount - 2.5) < 1e-9
      && vx.happy.status === 'ok' && vx.happy.err === null && vx.happy.label === 'proj-a' && /Connected/.test(vx.happy.statusText) && /billed 2 days/.test(vx.happy.statusText), JSON.stringify(vx.happy));
    ok('vertex: Monitoring GETs carry Bearer auth + the documented filter/aggregation (token_count, 86400s, ALIGN_SUM, REDUCE_SUM, 2 groupByFields), page 2 passes pageToken=p2; BigQuery POST runs the Vertex AI billing-export query with useLegacySql:false',
      !vx.missing && vx.mon.length === 2 && vx.mon.every(m => m.method === 'GET' && m.auth === 'Bearer ya29.test-token-vertex' && m.path === '/v3/projects/proj-a/timeSeries'
        && m.filter === 'metric.type="aiplatform.googleapis.com/publisher/online_serving/token_count"' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(m.start) && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(m.end)
        && m.period === '86400s' && m.aligner === 'ALIGN_SUM' && m.reducer === 'REDUCE_SUM' && m.group.join() === 'resource.labels.model_user_id,metric.labels.type')
      && vx.mon[0].pageToken === null && vx.mon[1].pageToken === 'p2'
      && vx.bq.length === 1 && vx.bq[0].method === 'POST' && vx.bq[0].auth === 'Bearer ya29.test-token-vertex' && /application\/json/.test(vx.bq[0].ct || '') && vx.bq[0].body.useLegacySql === false
      && /^SELECT DATE\(usage_start_time\) d, SUM\(cost\) c FROM `proj-a\.billing\.gcp_billing_export_v1_ABC` WHERE service\.description = 'Vertex AI' AND usage_start_time >= TIMESTAMP\('\d{4}-\d{2}-\d{2}'\) GROUP BY d ORDER BY d$/.test(vx.bq[0].body.query),
      JSON.stringify({ mon: vx.mon, bq: vx.bq }));
    ok('vertex: token never persisted (no key:vertex; token in no aiusage:* value; project field persists); 401 → "token expired — mint a new one (gcloud auth print-access-token)"; 403 → token rejected; billing table removed → tokens-only (4 rows), no BigQuery call, status says so, and billed: [] replaces the earlier 2-day envelope (0 rows, stale:false, table LS gone)',
      !vx.missing && vx.storage.keyEntry === null && !vx.storage.tokenLeaked && vx.storage.project === 'proj-a'
      && vx.expired.err === 'token expired — mint a new one (gcloud auth print-access-token)' && vx.expired.status === 'warn' && /token rejected \(403\)/.test(vx.denied.err || '') && vx.denied.status === 'warn'
      && vx.noTable.err === null && vx.noTable.status === 'ok' && /no billing table/.test(vx.noTable.statusText) && vx.noTable.rows === 4
      && vx.noTable.billed === 0 && vx.noTable.stale === false && vx.noTable.tableLS === null, JSON.stringify({ storage: vx.storage, expired: vx.expired, denied: vx.denied, noTable: vx.noTable }));
    ok('vertex: BigQuery failure (403 on the query POST, Monitoring fine) degrades to billed: null — tokens still land (4 rows), the previous 2-day envelope is kept and marked stale:true, status ok (no error state) + "cost unavailable: token rejected (403) …" (the Bedrock contract)',
      !vx.missing && vx.degraded.rows === 4 && vx.degraded.err === null && vx.degraded.status === 'ok' && vx.degraded.billedStale === true && vx.degraded.billedKept.join(';') === '2026-08-10|1.23;2026-08-11|2.5'
      && /● Connected\./.test(vx.degraded.statusText) && /cost unavailable: token rejected \(403\)/.test(vx.degraded.statusText) && !/billed \d+ day/.test(vx.degraded.statusText), JSON.stringify(vx.degraded));

    // ---- T12a: sigv4Sign — page-side WebCrypto signature must equal the node:crypto reference (and the pinned constant) for a fixed input ----
    const vec = { method: 'POST', url: 'https://monitoring.us-east-1.amazonaws.com/', headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'GraniteServiceVersion20100801.ListMetrics' },
      body: '{"Namespace":"AWS/Bedrock"}', region: 'us-east-1', service: 'monitoring', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', now: '2026-08-10T12:00:00Z' };
    const ref = refSigV4({ ...vec, now: new Date(vec.now) });
    const refSess = refSigV4({ ...vec, sessionToken: 'FwoGZXIvYXdzEBYaDSESSIONTOKEN', now: new Date(vec.now) });
    // pinned: computed once from the reference above — a silent change in either implementation fails here
    const PINNED = 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260810/us-east-1/monitoring/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-target, Signature=41b24c289c3ce57586339e02afc6a16dffa2024e8a5507b844bfd89c06924db5';
    const PINNED_SESS = 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260810/us-east-1/monitoring/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token;x-amz-target, Signature=7e4e730f84a0fefbc010a03fcff967d9388c84763822f2ab6e0e5d370409fe7d';
    const sv = await page.evaluate(async (v) => {
      if (typeof sigv4Sign !== 'function' || typeof sha256Hex !== 'function' || typeof hmacSha256 !== 'function') return { missing: true };
      const h = await sigv4Sign({ ...v, now: new Date(v.now) });
      const hs = await sigv4Sign({ ...v, sessionToken: 'FwoGZXIvYXdzEBYaDSESSIONTOKEN', now: new Date(v.now) });
      const empty = await sha256Hex('');
      const mac = [...await hmacSha256(new TextEncoder().encode('key'), 'The quick brown fox jumps over the lazy dog')].map(b => b.toString(16).padStart(2, '0')).join('');
      // guard: with crypto.subtle gone the helpers must throw the documented message, not a TypeError
      const realSubtle = Object.getOwnPropertyDescriptor(Crypto.prototype, 'subtle');
      let guardMsg = null;
      try { Object.defineProperty(Crypto.prototype, 'subtle', { get: () => undefined, configurable: true }); try { await sha256Hex('x'); } catch (e) { guardMsg = e.message; } }
      finally { Object.defineProperty(Crypto.prototype, 'subtle', realSubtle); }
      return { h, hs, empty, mac, guardMsg, secure: window.isSecureContext };
    }, vec);
    ok('sigv4: page signature equals the node:crypto reference AND the pinned vector (authorization, x-amz-date, payload hash); host / x-amz-date / x-amz-content-sha256 added, input headers kept; sha256("") and HMAC test vectors hold on file://',
      !sv.missing && sv.h.authorization === ref.authorization && ref.authorization === PINNED && sv.h['x-amz-date'] === '20260810T120000Z' && sv.h['x-amz-content-sha256'] === ref.payloadHash
      && sv.h['x-amz-content-sha256'] === 'fffa09e26f3b1322b37ab6ff1059c594cc4bc2915c9ae33123b182cf987bb246' && sv.h.host === 'monitoring.us-east-1.amazonaws.com'
      && sv.h['content-type'] === vec.headers['content-type'] && sv.h['x-amz-target'] === vec.headers['x-amz-target'] && !('x-amz-security-token' in sv.h)
      && sv.empty === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' && sv.mac === 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8' && sv.secure === true,
      JSON.stringify({ got: sv.h, want: ref, empty: sv.empty, mac: sv.mac }));
    ok('sigv4: session token travels as x-amz-security-token and is signed (reference + pinned agree); WebCrypto guard throws the documented message',
      !sv.missing && sv.hs['x-amz-security-token'] === 'FwoGZXIvYXdzEBYaDSESSIONTOKEN' && sv.hs.authorization === refSess.authorization && refSess.authorization === PINNED_SESS
      && /SignedHeaders=[^,]*x-amz-security-token/.test(sv.hs.authorization) && sv.hs.authorization !== sv.h.authorization
      && sv.guardMsg === 'WebCrypto unavailable — open the file over file:// or https', JSON.stringify({ got: sv.hs && sv.hs.authorization, want: refSess.authorization, guard: sv.guardMsg }));

    // ---- T12b: AWS Bedrock (CloudWatch ListMetrics paged + GetMetricData + Cost Explorer, all through sigv4Sign) ----
    const bdL1 = read('wave2', 'bedrock', 'list-metrics-1.json'), bdL2 = read('wave2', 'bedrock', 'list-metrics-2.json'), bdData = read('wave2', 'bedrock', 'get-metric-data.json'), bdCost = read('wave2', 'bedrock', 'cost.json');
    const bd = await page.evaluate(async (l1, l2, dataText, costText) => {
      const c = connectorById('bedrock');
      if (!c || typeof fetchBedrock !== 'function' || typeof App.connectKey !== 'function') return { missing: true };
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      App.ensureSourceCard(c);
      const card = document.getElementById('src-bedrock');
      const keyEl = document.getElementById('bedrock-key'), secEl = document.getElementById('bedrock-f-secret'), sesEl = document.getElementById('bedrock-f-session'), regEl = document.getElementById('bedrock-f-region');
      const ui = { card: !!card, note: card ? card.querySelectorAll('.session-only').length : 0, pwd: keyEl && keyEl.type, secretPwd: secEl && secEl.type, sessionPwd: sesEl && sesEl.type, regionInput: regEl && regEl.tagName, noRemember: card ? !card.querySelector('input[type="checkbox"]') : false,
        reg: { kind: c.kind, cat: c.category, so: c.sessionOnly === true, q: c.quality, fetch: c.fetch, platform: c.platform, srcIds: c.srcIds, statusEl: c.statusEl, fields: (c.fields || []).map(f => f.id + (f.secret ? '!' : '')), keyLabel: c.keyLabel, qn: c.qualityNote || '' },
        descHasCopy: card ? [...card.querySelectorAll('.desc')].some(e => /every auto-refresh tick/.test(e.textContent)) : false };
      const calls = [];
      const origFetch = window.fetch;
      const lower = (init) => { const h = {}; for (const [k, v] of Object.entries(init.headers || {})) h[k.toLowerCase()] = String(v); return h; };
      const json = (text, status = 200) => new Response(text, { status, headers: { 'content-type': 'application/x-amz-json-1.0' } });
      window.fetch = async (url, init = {}) => {
        const h = lower(init); const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ url: String(url), method: init.method || 'GET', headers: h, body });
        const t = h['x-amz-target'] || '';
        if (t.endsWith('.ListMetrics')) return json(body && body.NextToken === 'n2' ? l2 : l1);
        if (t.endsWith('.GetMetricData')) return json(dataText);
        if (t.endsWith('.GetCostAndUsage')) return json(costText);
        return json(JSON.stringify({ __type: 'UnknownOperationException', message: 'unexpected ' + t }), 400);
      };
      let out;
      try {
        keyEl.value = 'AKIDEXAMPLE'; secEl.value = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'; sesEl.value = ''; regEl.value = 'eu-west-1';
        await App.connectKey(c);
        const rows = (Store.sources.bedrock || { rows: [] }).rows;
        const t = rows.reduce((a, r) => ({ in: a.in + r.in, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, out: 0, msgs: 0 });
        const st = Store.connectors.bedrock || {};
        const happy = { ...t, n: rows.length, models: [...new Set(rows.map(r => r.model))].sort(), days: [...new Set(rows.map(r => r.d))].sort(), platforms: [...new Set(rows.map(r => r.platform))], est: rows.some(r => r.est),
          byKey: rows.map(r => r.d + '|' + r.model + '|' + r.in + '|' + r.out).sort(),
          billed: Store.billedRows('bedrock'), billedStale: (Store.billed.bedrock || {}).stale, status: Store.connectorStatus(c), label: st.label, err: st.err || null, statusText: document.getElementById('bedrock-status').textContent };
        const byTarget = (s) => calls.filter(x => (x.headers['x-amz-target'] || '').endsWith(s));
        const pick = (x) => ({ url: x.url, method: x.method, auth: x.headers.authorization, date: x.headers['x-amz-date'], ct: x.headers['content-type'], sha: x.headers['x-amz-content-sha256'], sess: x.headers['x-amz-security-token'] || null, target: x.headers['x-amz-target'], body: x.body });
        const sig = { lm: byTarget('.ListMetrics').map(pick), gmd: byTarget('.GetMetricData').map(pick), ce: byTarget('.GetCostAndUsage').map(pick), total: calls.length };
        const lsKeys = Object.keys(localStorage).filter(k => k.startsWith('aiusage:'));
        const storage = { keyEntry: localStorage.getItem('aiusage:key:bedrock'), leaked: lsKeys.some(k => /AKIDEXAMPLE|wJalrXUtnFEMI/.test(String(localStorage.getItem(k)))), region: LS.get('field:bedrock:region', null) };
        // Cost Explorer denied → tokens still land, status line says cost unavailable, NOT an error state
        window.fetch = async (url, init = {}) => { const h = lower(init); const body = init.body ? JSON.parse(init.body) : null; const t = h['x-amz-target'] || '';
          if (t.endsWith('.ListMetrics')) return json(body && body.NextToken === 'n2' ? l2 : l1); if (t.endsWith('.GetMetricData')) return json(dataText);
          return json(JSON.stringify({ __type: 'AccessDeniedException', Message: 'User: arn:aws:iam::123:user/ro is not authorized to perform: ce:GetCostAndUsage' }), 400); };
        await App.connectKey(c);
        const degraded = { err: (Store.connectors.bedrock || {}).err || null, status: Store.connectorStatus(c), statusText: document.getElementById('bedrock-status').textContent, rows: (Store.sources.bedrock || { rows: [] }).rows.length,
          billedStale: (Store.billed.bedrock || {}).stale, billedKept: Store.billedRows('bedrock').length };
        // CloudWatch rejects the signature/key (403) → attention with the AWS message
        window.fetch = async () => json(JSON.stringify({ __type: 'InvalidSignatureException', message: 'The request signature we calculated does not match the signature you provided.' }), 403);
        await App.connectKey(c);
        const denied = { err: (Store.connectors.bedrock || {}).err || null, status: Store.connectorStatus(c) };
        // blank secret → clear message, no network call
        let n0 = 0; window.fetch = async () => { n0++; return json('{}'); };
        secEl.value = '';
        await App.connectKey(c);
        const noSecret = { err: (Store.connectors.bedrock || {}).err || null, calls: n0 };
        out = { ui, happy, sig, storage, degraded, denied, noSecret };
      } finally {
        window.fetch = origFetch;
        keyEl.value = ''; secEl.value = ''; sesEl.value = ''; regEl.value = '';
        LS.del('field:bedrock:region');
        Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.persist(); App._render();
      }
      return out;
    }, bdL1, bdL2, bdData, bdCost);
    ok('bedrock: registry entry (cloud-token · sessionOnly · cloud · exact · fetchBedrock · platform AWS Bedrock · fields secret! session! region) + card UI (session-only note, password key/secret/session inputs, region input, no Remember)',
      !bd.missing && bd.ui.card && bd.ui.note === 1 && bd.ui.pwd === 'password' && bd.ui.secretPwd === 'password' && bd.ui.sessionPwd === 'password' && bd.ui.regionInput === 'INPUT' && bd.ui.noRemember
      && bd.ui.reg.kind === 'cloud-token' && bd.ui.reg.cat === 'cloud' && bd.ui.reg.so && bd.ui.reg.q === 'exact' && bd.ui.reg.fetch === 'fetchBedrock' && bd.ui.reg.platform === 'AWS Bedrock' && bd.ui.reg.keyLabel === 'Access key id'
      && bd.ui.reg.srcIds.join() === 'bedrock' && bd.ui.reg.statusEl === 'bedrock-status' && bd.ui.reg.fields.join() === 'secret!,session!,region', JSON.stringify(bd.ui || bd));
    ok('bedrock: exact rows per model × UTC day from GetMetricData (in=20400 out=2450, 3 rows, 2 models — duplicate and 2-dimension metrics dropped, stray Id ignored); billed per day from Cost Explorer (1.23, 0.77, 0); label names region + key tail',
      !bd.missing && bd.happy.in === 20400 && bd.happy.out === 2450 && bd.happy.msgs === 0 && bd.happy.n === 3 && bd.happy.models.join() === 'amazon.nova-pro-v1:0,anthropic.claude-sonnet-4-5'
      && bd.happy.days.join() === '2026-08-10,2026-08-11' && bd.happy.platforms.join() === 'AWS Bedrock' && !bd.happy.est
      && bd.happy.billed.length === 3 && bd.happy.billed.map(b => b.d).join() === '2026-08-10,2026-08-11,2026-08-12' && Math.abs(bd.happy.billed[0].amount - 1.23) < 1e-9 && Math.abs(bd.happy.billed[1].amount - 0.77) < 1e-9 && bd.happy.billed[2].amount === 0
      && bd.happy.status === 'ok' && bd.happy.err === null && bd.happy.label === 'eu-west-1 · key …MPLE' && /Connected/.test(bd.happy.statusText) && /2 models seen by CloudWatch/.test(bd.happy.statusText) && /billed 3 days/.test(bd.happy.statusText), JSON.stringify(bd.happy));
    // Wire format: JSON 1.0 GetMetricData Timestamps are epoch SECONDS — the fixture must carry them as such (out1 keeps one ISO string) and the
    // page must land each value on its UTC calendar day (1786320000 s = 2026-08-10, 1786406400 s = 2026-08-11), never on 1970-01-21.
    const bdRes = JSON.parse(bdData).MetricDataResults;
    const wireEpoch = bdRes.filter(r => r.Id !== 'out1').every(r => r.Timestamps.every(t => Number.isInteger(t) && t > 1e9 && t < 1e12)) && typeof bdRes.find(r => r.Id === 'out1').Timestamps[0] === 'string';
    ok('bedrock: GetMetricData Timestamps arrive as epoch seconds (JSON 1.0 wire format) and land on the UTC day — claude 08-10 12000/1500 · claude 08-11 8000/900 · nova 08-11 400/50 (ISO string in out1 parses too); nothing on 1970-01-21',
      !bd.missing && wireEpoch && bd.happy.byKey.join(';') === '2026-08-10|anthropic.claude-sonnet-4-5|12000|1500;2026-08-11|amazon.nova-pro-v1:0|400|50;2026-08-11|anthropic.claude-sonnet-4-5|8000|900'
      && !bd.happy.days.some(d => d.startsWith('1970')), JSON.stringify({ wireEpoch, byKey: bd.happy.byKey, days: bd.happy.days }));
    ok('bedrock: Cost Explorer failure returns billed: null → the previous billed envelope is marked stale (3 rows kept, stale:true) while tokens stay fresh; the happy run leaves it stale:false',
      !bd.missing && bd.happy.billedStale === false && bd.degraded.billedStale === true && bd.degraded.billedKept === 3, JSON.stringify({ happyStale: bd.happy.billedStale, degraded: bd.degraded }));
    ok('bedrock: card copy states Cost Explorer is billed per request (every Sync and every auto-refresh tick pays $0.01; turn auto-refresh off) — no "per sync" claim on the card or the status line; quality stays exact',
      !bd.missing && /Cost Explorer charges \$0\.01 per request — every Sync and every auto-refresh tick that re-fetches this card pays it; turn auto-refresh off if that matters\./.test(bd.ui.reg.qn)
      && !/per sync/.test(bd.ui.reg.qn) && !/per sync/.test(bd.happy.statusText) && /\$0\.01 per request/.test(bd.happy.statusText) && bd.ui.descHasCopy && bd.ui.reg.q === 'exact',
      JSON.stringify({ qn: bd.ui.reg.qn, descHasCopy: bd.ui.descHasCopy, statusText: bd.happy.statusText }));
    ok('bedrock: 4 signed POSTs — ListMetrics ×2 (NextToken n2 on the 2nd) + GetMetricData (4 queries, Period 86400, Stat Sum, ModelId dims, batch ≤ 500) on monitoring.eu-west-1 with x-amz-json-1.0, GetCostAndUsage on ce.us-east-1 with x-amz-json-1.1 (DAILY, UnblendedCost, SERVICE = Amazon Bedrock); Authorization "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/…" with the right service scope; no session-token header when blank',
      !bd.missing && bd.sig.total === 4 && bd.sig.lm.length === 2 && bd.sig.gmd.length === 1 && bd.sig.ce.length === 1
      && [...bd.sig.lm, ...bd.sig.gmd].every(x => x.url === 'https://monitoring.eu-west-1.amazonaws.com/' && x.method === 'POST' && x.ct === 'application/x-amz-json-1.0' && /^\d{8}T\d{6}Z$/.test(x.date || '') && /^[0-9a-f]{64}$/.test(x.sha || '') && x.sess === null
        && x.auth.startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/') && /\/eu-west-1\/monitoring\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/.test(x.auth))
      && bd.sig.lm[0].target === 'GraniteServiceVersion20100801.ListMetrics' && bd.sig.lm[0].body.Namespace === 'AWS/Bedrock' && bd.sig.lm[0].body.MetricName === 'InputTokenCount' && !('NextToken' in bd.sig.lm[0].body) && bd.sig.lm[1].body.NextToken === 'n2'
      && (() => { const b = bd.sig.gmd[0].body, q = b.MetricDataQueries; return bd.sig.gmd[0].target === 'GraniteServiceVersion20100801.GetMetricData' && Number.isInteger(b.StartTime) && Number.isInteger(b.EndTime) && b.EndTime > b.StartTime && b.EndTime - b.StartTime >= 90 * 86400
        && q.length === 4 && q.map(x => x.Id).join() === 'in0,out0,in1,out1' && q.every(x => x.MetricStat.Period === 86400 && x.MetricStat.Stat === 'Sum' && x.MetricStat.Metric.Namespace === 'AWS/Bedrock' && x.MetricStat.Metric.Dimensions.length === 1 && x.MetricStat.Metric.Dimensions[0].Name === 'ModelId')
        && q[0].MetricStat.Metric.MetricName === 'InputTokenCount' && q[1].MetricStat.Metric.MetricName === 'OutputTokenCount' && q[0].MetricStat.Metric.Dimensions[0].Value === 'anthropic.claude-sonnet-4-5' && q[2].MetricStat.Metric.Dimensions[0].Value === 'amazon.nova-pro-v1:0'; })()
      && (() => { const x = bd.sig.ce[0], b = x.body; return x.url === 'https://ce.us-east-1.amazonaws.com/' && x.method === 'POST' && x.ct === 'application/x-amz-json-1.1' && x.target === 'AWSInsightsIndexService.GetCostAndUsage'
        && x.auth.startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/') && /\/us-east-1\/ce\/aws4_request, SignedHeaders=/.test(x.auth) && x.sess === null
        && b.Granularity === 'DAILY' && b.Metrics.join() === 'UnblendedCost' && b.Filter.Dimensions.Key === 'SERVICE' && b.Filter.Dimensions.Values.join() === 'Amazon Bedrock' && /^\d{4}-\d{2}-\d{2}$/.test(b.TimePeriod.Start) && /^\d{4}-\d{2}-\d{2}$/.test(b.TimePeriod.End) && b.TimePeriod.End > b.TimePeriod.Start; })(),
      JSON.stringify(bd.sig));
    ok('bedrock: key id / secret never persisted (no key:bedrock; neither string in any aiusage:* value; region field persists); Cost Explorer denied → tokens still land + "cost unavailable" without an error state; CloudWatch 403 → attention; blank secret → clear error, no network call',
      !bd.missing && bd.storage.keyEntry === null && !bd.storage.leaked && bd.storage.region === 'eu-west-1'
      && bd.degraded.err === null && bd.degraded.status === 'ok' && /cost unavailable/.test(bd.degraded.statusText) && bd.degraded.rows === 3
      && /AWS returned 403/.test(bd.denied.err || '') && bd.denied.status === 'warn'
      && /secret access key/i.test(bd.noSecret.err || '') && bd.noSecret.calls === 0, JSON.stringify({ storage: bd.storage, degraded: bd.degraded, denied: bd.denied, noSecret: bd.noSecret }));
  } finally {
    await page.close();
  }
}
