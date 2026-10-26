import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const gem = await page.evaluate(async () => {
      let seen = null;
      window.__origFetchJSON = window.__origFetchJSON || window.fetchJSON;   // the real fetchJSON, for the timeout check below (every block after this one stubs it)
      window.fetchJSON = async (url, headers) => {
        seen = { url: String(url), headers: headers || {} };
        if (String(url).includes('generativelanguage')) return { models: [{ name: 'models/gemini-3.5-flash' }, { name: 'models/gemini-3-pro' }] };
        throw new Error('unexpected url ' + url);
      };
      document.getElementById('gemini-key').value = 'AIza-test';
      await App.connectKey(connectorById('gemini'));
      const st = Store.connectors.gemini;
      return { label: st && st.label, status: Store.connectorStatus(connectorById('gemini')), statusText: document.getElementById('gemini-status').textContent, seen };
    });
    ok('gemini: key validates via models list, connector goes green',
      /2 models/.test(gem.label) && gem.status === 'ok' && /Connected/.test(gem.statusText), JSON.stringify(gem));
    ok('gemini (A0 #20): the key travels in the x-goog-api-key header, never in the URL (?key= leaks into history / logs)',
      !!gem.seen && !/key=/.test(gem.seen.url) && gem.seen.headers['x-goog-api-key'] === 'AIza-test', JSON.stringify(gem.seen));
    // A0 #25: every request path carries a timeout signal (30 s) — fetchJSON, cloudJSON, the collector API and RemoteFile (headers phase)
    const timeouts = await page.evaluate(async () => {
      const origFetch = window.fetch, stubJSON = window.fetchJSON, seen = [];
      window.fetchJSON = window.__origFetchJSON;
      window.fetch = async (url, init = {}) => { seen.push({ url: String(url), signal: init.signal instanceof AbortSignal, aborted: init.signal ? init.signal.aborted : null }); return new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } }); };
      try {
        await fetchJSON('https://example.test/a', {});
        await cloudJSON('https://example.test/b', { method: 'POST', body: '{}' }, {});
        await App._collectorApi('http://127.0.0.1:1', 'tok')('/api/status');
        await new RemoteFile('http://127.0.0.1:1', 'tok', 'codex', { path: 'x.jsonl', size: 8, mtime: 1 }).text();
      } finally { window.fetch = origFetch; window.fetchJSON = stubJSON; }
      return { seen, ms: typeof REQUEST_TIMEOUT_MS !== 'undefined' ? REQUEST_TIMEOUT_MS : null };
    });
    ok('timeouts (A0 #25): fetchJSON, cloudJSON, _collectorApi and RemoteFile all pass an AbortSignal (not yet aborted) to fetch; REQUEST_TIMEOUT_MS is 30000',
      timeouts.seen.length === 4 && timeouts.seen.every(s => s.signal && s.aborted === false) && timeouts.ms === 30000, JSON.stringify(timeouts));

    const gemBad = await page.evaluate(async () => {
      window.fetchJSON = async () => { throw new Error('HTTP 400 — API key not valid'); };
      await App.connectKey(connectorById('gemini'));
      return { err: Store.connectors.gemini.err, status: Store.connectorStatus(connectorById('gemini')) };
    });
    ok('gemini: invalid key surfaces error + amber', /key not valid/i.test(gemBad.err) && gemBad.status === 'warn', JSON.stringify(gemBad));

    const cp = await page.evaluate(async () => {
      window.fetchJSON = async (url) => {
        const u = String(url);
        if (u.endsWith('/user')) return { login: 'alaa-dev' };
        if (u.includes('/settings/billing/usage')) return { usageItems: [
          { date: '2026-08-10', product: 'copilot', sku: 'copilot_premium_request', quantity: 14, netAmount: 0.56 },
          { date: '2026-08-11', product: 'copilot', sku: 'copilot_premium_request', quantity: 6, netAmount: 0.24 },
          { date: '2026-08-11', product: 'actions', sku: 'runner', quantity: 99, netAmount: 9.99 },
        ] };
        throw new Error('unexpected ' + u);
      };
      document.getElementById('copilot-key').value = 'github_pat_test';
      await App.connectKey(connectorById('copilot'));
      const rows = Store.sources.copilot.rows;
      return { label: Store.connectors.copilot.label, n: rows.length,
        msgs: rows.reduce((a, r) => a + r.msgs, 0),
        billed: Store.billedRows('copilot').reduce((a, b) => a + b.amount, 0),
        platforms: [...new Set(rows.map(r => r.platform))] };
    });
    ok('copilot: PAT validates, only copilot items land, actions ignored',
      cp.label === 'alaa-dev' && cp.n === 2 && cp.msgs === 20 && Math.abs(cp.billed - 0.8) < 1e-9 &&
      cp.platforms.length === 1 && cp.platforms[0] === 'GitHub Copilot', JSON.stringify(cp));

    const cpNoUsage = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      window.fetchJSON = async (url) => {
        if (String(url).endsWith('/user')) return { login: 'alaa-dev' };
        throw Object.assign(new Error('HTTP 404 — Not Found'), { status: 404 });   // fetchJSON's contract: the HTTP status rides on the error
      };
      await App.connectKey(connectorById('copilot'));
      return { label: Store.connectors.copilot.label, err: Store.connectors.copilot.err || null,
        statusText: document.getElementById('copilot-status').textContent };
    });
    ok('copilot: usage endpoint missing (404) degrades to validated-only, no error state',
      cpNoUsage.label === 'alaa-dev' && cpNoUsage.err === null && /no usage data|validated/i.test(cpNoUsage.statusText),
      JSON.stringify(cpNoUsage));
    // A0 #4: only 404 means "endpoint not available" — a 403 / 5xx / network failure on the usage endpoint is the card's error, never "no usage data"
    const cpDenied = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      window.fetchJSON = async (url) => {
        if (String(url).endsWith('/user')) return { login: 'alaa-dev' };
        throw Object.assign(new Error('HTTP 403 — Resource not accessible by personal access token'), { status: 403 });
      };
      await App.connectKey(connectorById('copilot'));
      return { err: (Store.connectors.copilot || {}).err || null, status: Store.connectorStatus(connectorById('copilot')), statusText: document.getElementById('copilot-status').textContent, hasSrc: !!Store.sources.copilot };
    });
    ok('copilot (A0 #4): a 403 on the usage endpoint is reported as the card\'s error (warn, "HTTP 403 …"), not read as "no usage data"; nothing lands',
      /HTTP 403/.test(cpDenied.err || '') && cpDenied.status === 'warn' && /HTTP 403/.test(cpDenied.statusText) && !cpDenied.hasSrc, JSON.stringify(cpDenied));
    // A0 #5: a sync whose usage endpoint answers with ZERO Copilot items replaces the stored rows and billed ([] = truthful empty); a 404 afterwards leaves the rows and marks billed stale
    const cpEmpty = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      const items = [{ date: '2026-08-10', product: 'copilot', sku: 'copilot_premium_request', quantity: 14, netAmount: 0.56 }];
      let usage = { usageItems: items };
      window.fetchJSON = async (url) => {
        if (String(url).endsWith('/user')) return { login: 'alaa-dev' };
        if (usage === null) throw Object.assign(new Error('HTTP 404 — Not Found'), { status: 404 });
        return usage;
      };
      await App.connectKey(connectorById('copilot'));
      const first = { rows: Store.sources.copilot.rows.length, billed: Store.billedRows('copilot').length };
      usage = { usageItems: [] };
      await App.connectKey(connectorById('copilot'));
      const empty = { rows: ((Store.sources.copilot || {}).rows || []).length, billed: Store.billedRows('copilot').length, stale: (Store.billed.copilot || {}).stale, text: document.getElementById('copilot-status').textContent };
      usage = { usageItems: items };
      await App.connectKey(connectorById('copilot'));
      usage = null;
      await App.connectKey(connectorById('copilot'));
      const gone = { rows: ((Store.sources.copilot || {}).rows || []).length, billed: Store.billedRows('copilot').length, stale: (Store.billed.copilot || {}).stale, err: Store.connectors.copilot.err || null };
      return { first, empty, gone };
    });
    ok('copilot (A0 #5): zero usage items → the old rows are replaced (0 rows) and billed is a fresh truthful empty (0 days, not stale); a later 404 keeps the rows and marks billed stale, no error',
      cpEmpty.first.rows === 1 && cpEmpty.first.billed === 1 && cpEmpty.empty.rows === 0 && cpEmpty.empty.billed === 0 && cpEmpty.empty.stale === false && /no Copilot usage/.test(cpEmpty.empty.text)
      && cpEmpty.gone.rows === 1 && cpEmpty.gone.billed === 1 && cpEmpty.gone.stale === true && cpEmpty.gone.err === null, JSON.stringify(cpEmpty));
    // A0 #24: day keys never read "undefined-undefined-01"; the login is URL-encoded in the usage path
    const cpDays = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      let usageUrl = null;
      window.fetchJSON = async (url) => {
        const u = String(url); if (u.endsWith('/user')) return { login: 'name with/slash' };
        usageUrl = u;
        return { usageItems: [{ year: 2026, month: 8, product: 'copilot', sku: 'copilot_premium_request', quantity: 3, netAmount: 0.12 }, { product: 'copilot', sku: 'copilot_premium_request', quantity: 9, netAmount: 0.36 }] };
      };
      await App.connectKey(connectorById('copilot'));
      return { days: Store.sources.copilot.rows.map(r => r.d), msgs: Store.sources.copilot.rows.reduce((a, r) => a + r.msgs, 0), usageUrl };
    });
    ok('copilot (A0 #24): an item with year/month but no date lands on the 1st of that month, an item with neither is skipped (no "undefined-undefined-01" row); the login is URL-encoded in the usage path',
      JSON.stringify(cpDays.days) === JSON.stringify(['2026-08-01']) && cpDays.msgs === 3 && /\/users\/name%20with%2Fslash\//.test(cpDays.usageUrl || ''), JSON.stringify(cpDays));

    const or = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      window.fetchJSON = async (url) => {
        const u = String(url);
        if (u.endsWith('/api/v1/key')) return { data: { label: 'rostum-key', usage: 12.5, limit: null } };
        if (u.endsWith('/api/v1/credits')) return { data: { total_credits: 50, total_usage: 12.5 } };
        if (u.endsWith('/api/v1/activity')) return { data: [
          { date: '2026-08-10', model: 'deepseek/deepseek-v4', usage: 0.42, requests: 12, prompt_tokens: 90000, completion_tokens: 12000 },
          { date: '2026-08-11', model: 'x-ai/grok-5', usage: 1.1, requests: 4, prompt_tokens: 30000, completion_tokens: 9000 },
        ] };
        throw new Error('unexpected ' + u);
      };
      document.getElementById('openrouter-key').value = 'sk-or-test';
      await App.connectKey(connectorById('openrouter'));
      const rows = Store.sources.openrouter.rows;
      return { label: Store.connectors.openrouter.label, n: rows.length,
        in: rows.reduce((a, r) => a + r.in, 0), out: rows.reduce((a, r) => a + r.out, 0),
        billed: Store.billedRows('openrouter').reduce((a, b) => a + b.amount, 0),
        statusText: document.getElementById('openrouter-status').textContent };
    });
    ok('openrouter: key label + daily activity rows + billed per day + credits note',
      or.label === 'rostum-key' && or.n === 2 && or.in === 120000 && or.out === 21000 &&
      Math.abs(or.billed - 1.52) < 1e-9 && /37\.50|credits/i.test(or.statusText), JSON.stringify(or));

    const orNoActivity = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      window.fetchJSON = async (url) => {
        const u = String(url);
        if (u.endsWith('/api/v1/key')) return { data: { label: 'rostum-key' } };
        if (u.endsWith('/api/v1/credits')) return { data: { total_credits: 50, total_usage: 12.5 } };
        throw new Error('HTTP 403 — activity requires provisioning key');
      };
      await App.connectKey(connectorById('openrouter'));
      return { err: Store.connectors.openrouter.err || null, hasSrc: !!Store.sources.openrouter,
        statusText: document.getElementById('openrouter-status').textContent };
    });
    ok('openrouter (A0 #4): a 403 on activity is the card\'s error (warn, "HTTP 403 …") — never read as "activity not available"; nothing lands',
      /HTTP 403/.test(orNoActivity.err || '') && !orNoActivity.hasSrc && /HTTP 403/.test(orNoActivity.statusText),
      JSON.stringify(orNoActivity));
    const orNotAvail = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      window.fetchJSON = async (url) => {
        const u = String(url);
        if (u.endsWith('/api/v1/key')) return { data: { label: 'rostum-key' } };
        if (u.endsWith('/api/v1/credits')) return { data: { total_credits: 50, total_usage: 12.5 } };
        throw Object.assign(new Error('HTTP 404 — Not Found'), { status: 404 });
      };
      await App.connectKey(connectorById('openrouter'));
      return { err: Store.connectors.openrouter.err || null, hasSrc: !!Store.sources.openrouter, statusText: document.getElementById('openrouter-status').textContent };
    });
    ok('openrouter (A0 #4): a 404 on activity (endpoint not available for this key type) degrades to credits-only with no error state',
      orNotAvail.err === null && !orNotAvail.hasSrc && /credits/i.test(orNotAvail.statusText) && /not available/i.test(orNotAvail.statusText), JSON.stringify(orNotAvail));
    // A0 #5: an activity answer with zero rows is a truthful empty — it replaces the stored rows and billed
    const orEmpty = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      let activity = { data: [{ date: '2026-08-10', model: 'x-ai/grok-5', usage: 0.42, requests: 12, prompt_tokens: 90000, completion_tokens: 12000 }] };
      window.fetchJSON = async (url) => {
        const u = String(url);
        if (u.endsWith('/api/v1/key')) return { data: { label: 'rostum-key' } };
        if (u.endsWith('/api/v1/credits')) return { data: { total_credits: 50, total_usage: 12.5 } };
        return activity;
      };
      await App.connectKey(connectorById('openrouter'));
      const first = { rows: Store.sources.openrouter.rows.length, billed: Store.billedRows('openrouter').length };
      activity = { data: [] };
      await App.connectKey(connectorById('openrouter'));
      return { first, rows: ((Store.sources.openrouter || {}).rows || []).length, billed: Store.billedRows('openrouter').length, stale: (Store.billed.openrouter || {}).stale, err: Store.connectors.openrouter.err || null };
    });
    ok('openrouter (A0 #5): an activity answer with zero rows replaces the stored rows (0) and billed ([] fresh, not stale) — never keeps the old rows marked fresh',
      orEmpty.first.rows === 1 && orEmpty.first.billed === 1 && orEmpty.rows === 0 && orEmpty.billed === 0 && orEmpty.stale === false && orEmpty.err === null, JSON.stringify(orEmpty));
    // A0 #6: an error on the Anthropic / OpenAI admin cards re-renders — the hub dot turns amber instead of staying as it was
    const legacyErr = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      App._render();
      const dot = (id) => (document.querySelector('#accounts-hub .acct[data-connector="' + id + '"] .dot') || {}).className || '';
      const before = { anthropic: dot('anthropic'), openai: dot('openai') };
      const origA = window.fetchAnthropicAll, origO = window.fetchOpenAIAll;
      window.fetchAnthropicAll = async () => { throw new Error('HTTP 401 — invalid x-api-key'); };
      window.fetchOpenAIAll = async () => { throw new Error('HTTP 401 — Incorrect API key'); };
      document.getElementById('anthropic-key').value = 'sk-ant-admin-x'; document.getElementById('openai-key').value = 'sk-admin-x';
      await App.connectKey(connectorById('anthropic')); await App.connectKey(connectorById('openai'));
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));   // App.render() is rAF-batched
      const after = { anthropic: dot('anthropic'), openai: dot('openai'), errA: Store.connectors.anthropic.err, errO: Store.connectors.openai.err };
      window.fetchAnthropicAll = origA; window.fetchOpenAIAll = origO;
      document.getElementById('anthropic-key').value = ''; document.getElementById('openai-key').value = '';
      Store.connectors = {}; Store.persist(); App._render();
      return { before, after };
    });
    ok('legacy cards (A0 #6): a failed Anthropic / OpenAI fetch re-renders the hub — both dots read warn after the error (off before)',
      /\boff\b/.test(legacyErr.before.anthropic) && /\boff\b/.test(legacyErr.before.openai) && /\bwarn\b/.test(legacyErr.after.anthropic) && /\bwarn\b/.test(legacyErr.after.openai), JSON.stringify(legacyErr));
    // Plan 9 A0b (#27): the former legacy OpenAI card runs through connectKey like every key card — rows + billed land (label "Admin key · last 4"),
    // a cost failure keeps the rows and marks billed stale (status line says so), [] replaces the rows and clears billed (fresh), a 403 is the card's
    // error (warn, the key is NOT persisted despite Remember), and the card's days select still sets the window (90 → 30)
    const oa = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      const c = connectorById('openai'), key = document.getElementById('openai-key'), rem = document.getElementById('remember-openai'), days = document.getElementById('openai-days');
      LS.del('key:openai'); key.value = 'sk-admin-test'; rem.checked = true; days.value = '90';
      const t = Math.floor(Date.UTC(2026, 7, 10) / 1000);
      let usage = { data: [{ start_time: t, results: [{ model: 'gpt-5.4', input_tokens: 100, input_cached_tokens: 10, output_tokens: 40, num_model_requests: 3 }] }], has_more: false };
      let costs = { data: [{ start_time: t, results: [{ amount: { value: '1.25', currency: 'usd' } }] }], has_more: false };
      const starts = [];
      window.fetchJSON = async (url) => {
        const u = new URL(String(url));
        if (u.pathname.endsWith('/organization/usage/completions')) { starts.push(+u.searchParams.get('start_time')); if (usage instanceof Error) throw usage; return usage; }
        if (u.pathname.endsWith('/organization/costs')) { if (costs instanceof Error) throw costs; return costs; }
        throw new Error('unexpected ' + u);
      };
      const daysBack = () => Math.round((Date.now() / 1000 - starts[starts.length - 1]) / 86400);
      const snap = () => ({ rows: ((Store.sources.openai || {}).rows || []).length, billed: Store.billedRows('openai').length, stale: (Store.billed.openai || {}).stale ?? null,
        err: (Store.connectors.openai || {}).err || null, status: Store.connectorStatus(c), text: document.getElementById('openai-status').textContent, key: LS.get('key:openai', null) });
      await App.connectKey(c);
      const first = { ...snap(), in: Store.sources.openai.rows[0].in, cr: Store.sources.openai.rows[0].cr, amount: Store.billedRows('openai')[0].amount, label: Store.connectors.openai.label, days: daysBack() };
      costs = Object.assign(new Error('HTTP 403 — costs need api.usage.read'), { status: 403 });
      await App.connectKey(c);
      const soft = snap();
      usage = { data: [], has_more: false }; costs = { data: [], has_more: false };
      await App.connectKey(c);
      const empty = snap();
      LS.del('key:openai'); usage = Object.assign(new Error('HTTP 403 — Insufficient permissions'), { status: 403 });
      await App.connectKey(c);
      const denied = snap();
      days.value = '30'; usage = { data: [], has_more: false };
      await App.connectKey(c);
      const window30 = daysBack();
      window.fetchJSON = window.__origFetchJSON; LS.del('key:openai'); key.value = ''; rem.checked = false; days.value = '90';
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.persist(); App._render();
      return { first, soft, empty, denied, window30 };
    });
    ok('openai (A0b #27): connectKey lands 1 row (in=90 cr=10) + billed 1.25 (fresh, status ok, "1 usage rows + billed costs", label "Admin key · last 4: test", key remembered, 90-day window)',
      oa.first.rows === 1 && oa.first.in === 90 && oa.first.cr === 10 && oa.first.billed === 1 && oa.first.amount === 1.25 && oa.first.stale === false && oa.first.status === 'ok'
      && /Connected/.test(oa.first.text) && /1 usage rows \+ billed costs/.test(oa.first.text) && oa.first.label === 'Admin key · last 4: test' && oa.first.key === 'sk-admin-test' && oa.first.days === 90, JSON.stringify(oa.first));
    ok('openai (A0b #27): a failed costs report keeps the rows and the old billed day but marks it stale, no error, the status line says "cost report unavailable"; a [] usage + [] costs answer replaces the rows (0) and clears billed (fresh)',
      oa.soft.rows === 1 && oa.soft.billed === 1 && oa.soft.stale === true && oa.soft.err === null && oa.soft.status === 'ok' && /cost report unavailable/.test(oa.soft.text)
      && oa.empty.rows === 0 && oa.empty.billed === 0 && oa.empty.stale === false && oa.empty.err === null, JSON.stringify({ soft: oa.soft, empty: oa.empty }));
    ok('openai (A0b #27): a 403 on the usage report is the card\'s error (warn, "HTTP 403" in the entry and on the line), nothing lands, the key is not persisted; the days select drives the window (30)',
      /HTTP 403/.test(oa.denied.err || '') && oa.denied.status === 'warn' && /HTTP 403/.test(oa.denied.text) && oa.denied.rows === 0 && oa.denied.key === null && oa.window30 === 30, JSON.stringify({ denied: oa.denied, window30: oa.window30 }));
    // A0 #11: Remember persists a key only after the fetch accepted it — a rejected key is never written (refreshAll would replay it after a reload)
    const rememberLate = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      const out = {};
      // (a) legacy card (Gemini): Remember checked, validation fails → nothing stored; then succeeds → stored
      const gk = document.getElementById('gemini-key'), grem = document.getElementById('remember-gemini');
      LS.del('key:gemini'); gk.value = 'AIza-bad'; grem.checked = true;
      window.fetchJSON = async () => { throw Object.assign(new Error('HTTP 400 — API key not valid'), { status: 400 }); };
      await App.connectKey(connectorById('gemini')); out.geminiAfterFail = LS.get('key:gemini', null);
      window.fetchJSON = async () => ({ models: [{ name: 'models/gemini-3-pro' }] });
      gk.value = 'AIza-good'; await App.connectKey(connectorById('gemini')); out.geminiAfterOk = LS.get('key:gemini', null);
      LS.del('key:gemini'); gk.value = ''; grem.checked = false;
      // (b) the generic key driver (connectKey): same rule
      const c = CONNECTORS.find(x => x.fetch && !x.sessionOnly && x.keyLS);
      const ki = document.getElementById(c.id + '-key'), rem = document.getElementById('remember-' + c.id), orig = globalThis[c.fetch];
      LS.del(c.keyLS); ki.value = 'k-bad'; rem.checked = true;
      window[c.fetch] = async () => { throw new Error('HTTP 401 — bad key'); };
      await App.connectKey(c); out.keyAfterFail = LS.get(c.keyLS, null);
      window[c.fetch] = async () => ({ label: 'stub', detail: '' });
      ki.value = 'k-good'; await App.connectKey(c); out.keyAfterOk = LS.get(c.keyLS, null);
      window[c.fetch] = orig; LS.del(c.keyLS); ki.value = ''; rem.checked = false;
      // (c) the collector (connectCollector): a 401 never persists the token; a good status does
      const cc = connectorById('collector'), ck = document.getElementById('collector-key'), crem = document.getElementById('remember-collector');
      const origFetch = window.fetch;
      let reject = true;
      window.fetch = async () => new Response(JSON.stringify(reject ? { error: 'unauthorized' } : { version: '7', tools: [] }), { status: reject ? 401 : 200, headers: { 'Content-Type': 'application/json' } });
      LS.del('key:collector'); ck.value = 'tok-bad'; crem.checked = true;
      await App.connectCollector(cc); out.collectorAfterFail = LS.get('key:collector', null);
      reject = false; ck.value = 'tok-good'; await App.connectCollector(cc); out.collectorAfterOk = LS.get('key:collector', null);
      App.stopCollectorWatch(cc); window.fetch = origFetch; LS.del('key:collector'); LS.del('url:collector'); ck.value = ''; crem.checked = false;
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.persist(); App._render();
      return out;
    });
    ok('remember (A0 #11): a rejected key is never persisted (Gemini legacy card, the generic key driver, the collector token) — only the key the fetch accepted is written to LS',
      rememberLate.geminiAfterFail === null && rememberLate.geminiAfterOk === 'AIza-good' && rememberLate.keyAfterFail === null && rememberLate.keyAfterOk === 'k-good'
      && rememberLate.collectorAfterFail === null && rememberLate.collectorAfterOk === 'tok-good', JSON.stringify(rememberLate));
    // 4b T1: link-only entries never fetch, never get connector state, never prompt (refreshAll / sync / disconnect are no-ops)
    const lo = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const ids = ['amazonq', 'replicate', 'windsurf'];
      const missing = ids.filter(id => !connectorById(id));
      if (missing.length) return { missing };
      const origFetch = window.fetch, origConfirm = window.confirm;
      let fetches = 0, confirms = 0;
      window.fetch = async () => { fetches++; throw new TypeError('Failed to fetch'); };
      window.confirm = () => { confirms++; return true; };
      try {
        await App.refreshAll();
        const sync = ids.map(id => App.syncConnector(id));
        for (const id of ids) App.disconnectConnector(id);
        return { fetches, confirms, syncUndefined: sync.every(r => r === undefined), noState: ids.every(id => Store.connectors[id] === undefined),
          statuses: ids.map(id => Store.connectorStatus(connectorById(id))), texts: ids.map(id => document.getElementById(id + '-status').textContent) };
      } finally { window.fetch = origFetch; window.confirm = origConfirm; }
    });
    ok('link-only: refreshAll / syncConnector / disconnectConnector never fetch, never create connector state, never prompt; status stays off and the card says "No data path"',
      !lo.missing && lo.fetches === 0 && lo.confirms === 0 && lo.syncUndefined && lo.noState && lo.statuses.every(s => s === 'off') && lo.texts.every(t => /no data path/i.test(t)), JSON.stringify(lo));
    // ---- Plan 4b: refreshAll covers key-driver kinds (connectKey → globalThis[c.fetch]) ----
    const ra = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      const remembered = CONNECTORS.find(c => c.fetch && !c.sessionOnly && c.keyLS);   // a Wave 2 api-key / admin-key entry that can remember its key
      const session = CONNECTORS.find(c => c.fetch && c.sessionOnly);                  // a cloud-token entry (never persists)
      const calls = {}, orig = {};
      for (const c of [remembered, session]) { orig[c.id] = globalThis[c.fetch]; window[c.fetch] = async () => { calls[c.id] = (calls[c.id] || 0) + 1; return { label: 'stub', detail: '' }; }; }
      const setFields = (c, v) => (c.fields || []).forEach(f => { const e = document.getElementById(c.id + '-f-' + f.id); if (e) e.value = v; });
      // (a) remembered key + the input still holds it → fetch called once
      LS.set(remembered.keyLS, 'k-remembered'); const ki = document.getElementById(remembered.id + '-key'); ki.value = 'k-remembered'; setFields(remembered, 'x');
      // (b) sessionOnly with an EMPTY input → never called (nothing remembered, nothing to re-fetch)
      const si = document.getElementById(session.id + '-key'); si.value = ''; setFields(session, '');
      await App.refreshAll();
      const sessKey = session.keyLS || ('key:' + session.id);
      const out = { remembered: remembered.id, session: session.id, a: calls[remembered.id] || 0, bEmpty: calls[session.id] || 0, sessionLS: LS.get(sessKey, null) };
      // (c) sessionOnly with a value still in the input → re-fetched ("session-only" = while this page is open), still nothing persisted
      si.value = 'tok-live'; setFields(session, 'x');
      await App.refreshAll();
      out.bLive = calls[session.id] || 0;
      out.sessionLSAfter = LS.get(sessKey, null);
      out.secretFieldLS = (session.fields || []).filter(f => f.secret).map(f => LS.get('field:' + session.id + ':' + f.id, null)).every(v => v === null);
      // cleanup
      for (const c of [remembered, session]) window[c.fetch] = orig[c.id];
      LS.del(remembered.keyLS); ki.value = ''; si.value = ''; setFields(remembered, ''); setFields(session, '');
      for (const c of [remembered, session]) (c.fields || []).forEach(f => LS.del('field:' + c.id + ':' + f.id));
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.persist();
      return out;
    });
    ok('refreshAll (4b): remembered key → its fetch fn runs once; sessionOnly + empty input → not called; sessionOnly + live input → called; session key/secret fields never persisted',
      ra.a === 1 && ra.bEmpty === 0 && ra.bLive === 1 && ra.sessionLS === null && ra.sessionLSAfter === null && ra.secretFieldLS, JSON.stringify(ra));
  } finally {
    await page.close();
  }

  // Plan 9 A0b (#27): a data blob stored BEFORE the refactor (the five ids: rows under sources, billed envelopes, connector entries) must load unchanged —
  // the same per-id totals, fresh billed, status ok, green hub dots and "Connected (stored data)" lines
  const hourAgo = Date.now() - 3600e3;
  const row = (platform, model, d, x) => ({ d, platform, model, in: x, cw: 0, cr: Math.floor(x / 10), out: Math.floor(x / 2), msgs: 1 + (x % 3) });
  const env = (d, amount) => ({ rows: [{ d, amount }], at: hourAgo, stale: false });
  const ent = (label) => ({ label, lastSync: hourAgo, err: null });
  const blob = { sources: {
      anthropic: { rows: [row('Anthropic API', 'claude-sonnet-5', '2026-08-10', 1000), row('Anthropic API', 'claude-opus-5', '2026-08-11', 250)], meta: { days: 90, updated: hourAgo } },
      openai: { rows: [row('OpenAI API', 'gpt-5.4', '2026-08-10', 700)], meta: { days: 90, updated: hourAgo } },
      copilot: { rows: [{ d: '2026-08-10', platform: 'GitHub Copilot', model: 'copilot_premium_request', in: 0, cw: 0, cr: 0, out: 0, msgs: 14, est: 1 }], meta: { updated: hourAgo } },
      openrouter: { rows: [row('OpenRouter', 'deepseek/deepseek-v4', '2026-08-11', 90000)], meta: { updated: hourAgo } } },
    billed: { anthropic: env('2026-08-10', 3.5), openai: env('2026-08-10', 1.25), copilot: env('2026-08-10', 0.56), openrouter: env('2026-08-11', 0.42) },
    projects: [],
    connectors: { anthropic: ent('Admin key ·  last 4: test'), openai: ent('Admin key ·  last 4: test'), gemini: ent('2 models available'), copilot: ent('alaa-dev'), openrouter: ent('rostum-key') } };
  const ids = ['anthropic', 'openai', 'gemini', 'copilot', 'openrouter'];
  const sumOf = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const want = Object.fromEntries(ids.map(id => { const rows = (blob.sources[id] || {}).rows || []; return [id, { in: sumOf(rows, 'in'), out: sumOf(rows, 'out'), msgs: sumOf(rows, 'msgs'), billed: sumOf(((blob.billed[id] || {}).rows || []), 'amount') }]; }));
  const { page: p2 } = await openDashboard(browser, { seedData: blob });
  let stored;
  try {
    stored = await p2.evaluate((ids) => {
      const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
      const dot = (id) => (document.querySelector('#accounts-hub .acct[data-connector="' + id + '"] .dot') || {}).className || '';
      return Object.fromEntries(ids.map(id => { const rows = ((Store.sources[id] || {}).rows || []); return [id, { in: sum(rows, 'in'), out: sum(rows, 'out'), msgs: sum(rows, 'msgs'),
        billed: sum(Store.billedRows(id), 'amount'), stale: (Store.billed[id] || {}).stale ?? null, status: Store.connectorStatus(connectorById(id)), dot: dot(id),
        text: document.getElementById(id + '-status').textContent, label: (Store.connectors[id] || {}).label || null }]; }));
    }, ids);
  } finally {
    await p2.close();
  }
  ok('stored data (A0b #27): a pre-refactor blob for the five cards renders the same totals (in / out / msgs / billed per id), billed fresh, status ok, green hub dots, "Connected (stored data)" lines, labels kept',
    !!stored && ids.every(id => stored[id].in === want[id].in && stored[id].out === want[id].out && stored[id].msgs === want[id].msgs && Math.abs(stored[id].billed - want[id].billed) < 1e-9
      && stored[id].status === 'ok' && /\bok\b/.test(stored[id].dot) && /Connected/.test(stored[id].text) && stored[id].label === blob.connectors[id].label)
    && ['anthropic', 'openai', 'copilot', 'openrouter'].every(id => stored[id].stale === false) && stored.gemini.stale === null, JSON.stringify({ stored, want }));
}
