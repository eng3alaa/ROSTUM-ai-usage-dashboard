import fs from 'node:fs';
import path from 'node:path';
import { openDashboard, OUT } from '../lib/harness.mjs';

const read = (...p) => fs.readFileSync(path.join(OUT, ...p), 'utf8');

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    // ---- T10: cloud-token plumbing + Azure OpenAI (Monitor metrics + Cost Management) ----
    const azMetrics = read('wave2', 'azure', 'metrics.json'), azCost = read('wave2', 'azure', 'cost.json');
    const az = await page.evaluate(async (metricsText, costText) => {
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
      window.fetch = async (url, init = {}) => {
        const u = String(url); const h = {}; for (const [k, v] of Object.entries(init.headers || {})) h[k.toLowerCase()] = String(v);
        calls.push({ url: u, method: init.method || 'GET', headers: h, body: init.body || null });
        if (u.includes('/providers/microsoft.insights/metrics')) return new Response(u.includes('/accounts/aoai-west/') ? metricsText : JSON.stringify({ value: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (u.includes('/providers/Microsoft.CostManagement/query')) return new Response(costText, { status: 200, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ error: { code: 'NotFound', message: 'unexpected ' + u } }), { status: 404, headers: { 'content-type': 'application/json' } });
      };
      let out;
      try {
        keyEl.value = 'eyJ-test-token-azure';
        resEl.value = '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/aoai-west\n\n/subscriptions/s1/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/aoai-east\n';
        scopeEl.value = '/subscriptions/s1';
        await App.connectKey(c);
        const rows = (Store.sources['azure-openai'] || { rows: [] }).rows;
        const t = rows.reduce((a, r) => ({ in: a.in + r.in, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, out: 0, msgs: 0 });
        const st = Store.connectors['azure-openai'] || {};
        const happy = { ...t, n: rows.length, models: [...new Set(rows.map(r => r.model))].sort(), days: [...new Set(rows.map(r => r.d))].sort(), platforms: [...new Set(rows.map(r => r.platform))],
          est: rows.some(r => r.est), billed: Store.billedRows('azure-openai'), status: Store.connectorStatus(c), label: st.label, err: st.err || null,
          statusText: document.getElementById('azure-openai-status').textContent };
        const metricsCalls = calls.filter(x => x.url.includes('/microsoft.insights/metrics')).map(x => { const p = new URL(x.url); return { host: p.host, path: p.pathname, auth: x.headers.authorization, method: x.method, q: Object.fromEntries(p.searchParams.entries()) }; });
        const costCalls = calls.filter(x => x.url.includes('/Microsoft.CostManagement/query')).map(x => { const p = new URL(x.url); return { host: p.host, path: p.pathname, auth: x.headers.authorization, method: x.method, ct: x.headers['content-type'], q: Object.fromEntries(p.searchParams.entries()), body: JSON.parse(x.body) }; });
        // nothing secret in storage: no key entry, and the token string appears in NO aiusage:* value (non-secret fields DO persist — resource ids / scope are not secrets)
        const lsKeys = Object.keys(localStorage).filter(k => k.startsWith('aiusage:'));
        const storage = { keyEntry: localStorage.getItem('aiusage:key:azure-openai'), tokenLeaked: lsKeys.some(k => String(localStorage.getItem(k)).includes('eyJ-test-token-azure')), scopeField: LS.get('field:azure-openai:scope', null) };
        // expired token: 401 → the "mint a new one" message, attention state
        window.fetch = async () => new Response(JSON.stringify({ error: { code: 'ExpiredAuthenticationToken', message: 'The access token expiry UTC time is earlier than current UTC time.' } }), { status: 401, headers: { 'content-type': 'application/json' } });
        await App.connectKey(c);
        const expired = { err: (Store.connectors['azure-openai'] || {}).err || null, status: Store.connectorStatus(c), statusText: document.getElementById('azure-openai-status').textContent };
        // no resource ids → a clear message and NO network call
        let n0 = 0; window.fetch = async () => { n0++; return new Response('{}', { status: 200 }); };
        resEl.value = '   ';
        await App.connectKey(c);
        const noRes = { err: (Store.connectors['azure-openai'] || {}).err || null, calls: n0 };
        out = { ui, happy, metricsCalls, costCalls, storage, expired, noRes };
      } finally {
        window.fetch = origFetch;
        keyEl.value = ''; resEl.value = ''; scopeEl.value = '';
        LS.del('field:azure-openai:resources'); LS.del('field:azure-openai:scope');
        Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.persist(); App._render();
      }
      return out;
    }, azMetrics, azCost);
    ok('azure: registry entry (cloud-token · sessionOnly · cloud group · exact · fetchAzureOpenAI · srcIds [azure-openai]) + card UI: one session-only note, keyHint placeholder, password input, no Remember box, textarea for resource ids',
      !az.missing && az.ui.card && az.ui.note.length === 1 && /kept in this tab only — never saved/.test(az.ui.note[0])
      && az.ui.placeholder === 'az account get-access-token --resource https://management.azure.com --query accessToken -o tsv' && az.ui.pwd === 'password' && az.ui.noRemember
      && az.ui.textarea === 'TEXTAREA' && az.ui.scopeInput === 'INPUT'
      && az.ui.reg.kind === 'cloud-token' && az.ui.reg.cat === 'cloud' && az.ui.reg.so && az.ui.reg.q === 'exact' && az.ui.reg.fetch === 'fetchAzureOpenAI' && az.ui.reg.platform === 'Azure OpenAI'
      && az.ui.reg.srcIds.join() === 'azure-openai' && az.ui.reg.statusEl === 'azure-openai-status' && az.ui.reg.fields.join() === 'resources,scope', JSON.stringify(az.ui || az));
    ok('azure: exact rows per model × UTC day — InputTokens/OutputTokens win over Processed/Generated for the same model-day, a point without total is no data, no metadata → azure-openai (in=1780 out=357, 4 rows, 3 models); billed per day from Cost Management (12.34, 1.66); connected with label "2 resources"',
      !az.missing && az.happy.in === 1780 && az.happy.out === 357 && az.happy.msgs === 0 && az.happy.n === 4 && az.happy.models.join() === 'azure-openai,gpt-4.1-mini,gpt-4o'
      && az.happy.days.join() === '2026-08-10,2026-08-11,2026-08-12' && az.happy.platforms.join() === 'Azure OpenAI' && !az.happy.est
      && az.happy.billed.length === 2 && az.happy.billed[0].d === '2026-08-10' && Math.abs(az.happy.billed[0].amount - 12.34) < 1e-9 && az.happy.billed[1].d === '2026-08-11' && Math.abs(az.happy.billed[1].amount - 1.66) < 1e-9
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
  } finally {
    await page.close();
  }
}
