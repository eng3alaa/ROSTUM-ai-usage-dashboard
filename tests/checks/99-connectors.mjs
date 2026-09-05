import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const gem = await page.evaluate(async () => {
      window.fetchJSON = async (url) => {
        if (String(url).includes('generativelanguage')) return { models: [{ name: 'models/gemini-3.5-flash' }, { name: 'models/gemini-3-pro' }] };
        throw new Error('unexpected url ' + url);
      };
      document.getElementById('gemini-key').value = 'AIza-test';
      await App.fetchGemini();
      const st = Store.connectors.gemini;
      return { label: st && st.label, status: Store.connectorStatus(connectorById('gemini')), statusText: document.getElementById('gemini-status').textContent };
    });
    ok('gemini: key validates via models list, connector goes green',
      /2 models/.test(gem.label) && gem.status === 'ok' && /Connected/.test(gem.statusText), JSON.stringify(gem));

    const gemBad = await page.evaluate(async () => {
      window.fetchJSON = async () => { throw new Error('HTTP 400 — API key not valid'); };
      await App.fetchGemini();
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
      await App.fetchCopilot();
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
        throw new Error('HTTP 404');
      };
      await App.fetchCopilot();
      return { label: Store.connectors.copilot.label, err: Store.connectors.copilot.err || null,
        statusText: document.getElementById('copilot-status').textContent };
    });
    ok('copilot: usage endpoint missing degrades to validated-only, no error state',
      cpNoUsage.label === 'alaa-dev' && cpNoUsage.err === null && /no usage data|validated/i.test(cpNoUsage.statusText),
      JSON.stringify(cpNoUsage));

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
      await App.fetchOpenrouter();
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
      await App.fetchOpenrouter();
      return { err: Store.connectors.openrouter.err || null, hasSrc: !!Store.sources.openrouter,
        statusText: document.getElementById('openrouter-status').textContent };
    });
    ok('openrouter: activity denied degrades to credits-only, no error state',
      orNoActivity.err === null && !orNoActivity.hasSrc && /credits/i.test(orNoActivity.statusText),
      JSON.stringify(orNoActivity));
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
}
