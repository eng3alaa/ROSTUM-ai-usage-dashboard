import fs from 'node:fs';
import path from 'node:path';
import { openDashboard, OUT } from '../lib/harness.mjs';

const read = (...p) => fs.readFileSync(path.join(OUT, ...p), 'utf8');   // Tasks 7 and 9 append blocks that read wave2/ fixtures through this helper

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    // ---- T2 (a): key UI + happy path + Remember opt-in + bad key, through the real Groq entry (validate-only) ----
    const kd = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const c = connectorById('groq');
      if (!c) throw new Error('no groq entry in CONNECTORS');
      const keyEl = document.getElementById('groq-key'), rem = document.getElementById('remember-groq');
      const ui = { src: !!document.getElementById('src-groq'), keyType: keyEl && keyEl.type, keyAuto: keyEl && keyEl.getAttribute('autocomplete'), keyPh: keyEl && keyEl.placeholder,
        rem: !!rem, btn: !!document.getElementById('groq-validate'), status: !!document.getElementById('groq-status'), badge: document.querySelector('#src-groq .badge').textContent,
        kind: c.kind, keyLS: c.keyLS, srcIds: c.srcIds, quality: c.quality, hiddenAtStart: document.getElementById('src-groq').hidden,
        note: /validate-only/i.test(c.qualityNote) && /no usage or spend API/i.test(c.qualityNote) };
      const calls = [];
      const origFetch = window.fetch;
      window.fetch = async (url, init) => {
        calls.push({ url: String(url), auth: init && init.headers && init.headers.Authorization });
        if (String(url) === 'https://api.groq.com/openai/v1/models') return new Response(JSON.stringify({ object: 'list', data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'openai/gpt-oss-120b' }, { id: 'whisper-large-v3' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      };
      try {
        keyEl.value = 'gsk_test_1234'; rem.checked = false;
        await App.connectKey(c);
        const st = Store.connectors.groq;
        const okState = { label: st && st.label, err: st && st.err, status: Store.connectorStatus(c), text: document.getElementById('groq-status').textContent,
          hasSrc: !!Store.sources.groq, notRemembered: LS.get('key:groq', null), leak: document.documentElement.outerHTML.includes('gsk_test_1234'),
          calls: calls.length, url: calls[0] && calls[0].url, auth: calls[0] && calls[0].auth };
        App.renderHub();
        const hub = document.querySelector('#accounts-hub .acct[data-connector="groq"]');
        const hubState = { dot: hub.querySelector('.dot').className, label: hub.querySelector('.acct-label').textContent, sync: !!hub.querySelector('.acct-sync-btn'),
          group: hub.closest('.hub-group').dataset.group, srcShown: !document.getElementById('src-groq').hidden };
        // Remember opt-in → key persists; unchecking forgets it
        rem.checked = true;
        await App.connectKey(c);
        const remembered = LS.get('key:groq', null);
        rem.checked = false; rem.dispatchEvent(new Event('change', { bubbles: true }));
        const forgotten = LS.get('key:groq', null);
        // bad key → attention + message, state keeps the entry (warn, not off)
        window.fetch = async () => new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
        await App.connectKey(c);
        const bad = { err: Store.connectors.groq.err, status: Store.connectorStatus(c), text: document.getElementById('groq-status').textContent };
        // empty key → message only, no network, no state change
        const before = calls.length; keyEl.value = '';
        await App.connectKey(c);
        const empty = { calls: calls.length - before, text: document.getElementById('groq-status').textContent };
        return { ui, okState, hubState, remembered, forgotten, bad, empty };
      } finally { window.fetch = origFetch; }
    });
    ok('key driver: Groq card renders from the registry (password input, autocomplete off, gsk_ hint, Remember, Validate, status, validate-only badge, hidden until connected; honest note)',
      kd.ui.src && kd.ui.keyType === 'password' && kd.ui.keyAuto === 'off' && /gsk_/.test(kd.ui.keyPh) && kd.ui.rem && kd.ui.btn && kd.ui.status && kd.ui.badge === 'validate-only' &&
      kd.ui.kind === 'api-key' && kd.ui.keyLS === 'key:groq' && JSON.stringify(kd.ui.srcIds) === JSON.stringify(['groq']) && kd.ui.quality === 'validate' && kd.ui.hiddenAtStart && kd.ui.note, JSON.stringify(kd.ui));
    ok('key driver: connectKey validates with Bearer GET /openai/v1/models (3 models → label "3 models"), connector ok, hub card green in API vendors + Sync, key never in DOM text, not remembered unless opted in; Remember persists, unchecking forgets',
      kd.okState.calls === 1 && kd.okState.url === 'https://api.groq.com/openai/v1/models' && kd.okState.auth === 'Bearer gsk_test_1234' && kd.okState.label === '3 models' && kd.okState.err === null &&
      kd.okState.status === 'ok' && /Connected/.test(kd.okState.text) && /3 models/.test(kd.okState.text) && !kd.okState.hasSrc && kd.okState.notRemembered === null && !kd.okState.leak &&
      /\bok\b/.test(kd.hubState.dot) && kd.hubState.label === '3 models' && kd.hubState.sync && kd.hubState.group === 'api' && kd.hubState.srcShown &&
      kd.remembered === 'gsk_test_1234' && kd.forgotten === null, JSON.stringify({ okState: kd.okState, hubState: kd.hubState, remembered: kd.remembered, forgotten: kd.forgotten }));
    ok('key driver: invalid key → warn + "HTTP 401 — Invalid API Key"; empty key → prompt text, no network call',
      /HTTP 401/.test(kd.bad.err) && /Invalid API Key/.test(kd.bad.err) && kd.bad.status === 'warn' && /Validation failed/.test(kd.bad.text) && kd.empty.calls === 0 && /Paste/.test(kd.empty.text), JSON.stringify({ bad: kd.bad, empty: kd.empty }));

    // ---- T2 (b): rows/billed/meta/opts pass-through, superseded generation, sessionOnly + fields, refreshAll, disconnect ----
    const kd2 = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const c = connectorById('groq');
      const origFetchGroq = window.fetchGroq;
      const saved = { fields: c.fields, sessionOnly: c.sessionOnly };   // test-local patch of the real entry (restored in finally)
      const today = dayKey(new Date());
      try {
        // (a) rows + billed + meta from the fetcher land under c.id; fields ({}) and opts.days (90) are passed through
        let seen = null;
        window.fetchGroq = async (key, fields, opts) => { seen = { key, fields, days: opts && opts.days }; return { label: 'k-' + key.slice(-4), detail: 'test detail',
          // in = 1000 + 500 = 1500 · out = 250 + 125 = 375 · msgs = 4 + 2 = 6 · billed = 1.25
          rows: [{ d: today, platform: 'Groq', model: 'llama-3.3-70b-versatile', in: 1000, cw: 0, cr: 0, out: 250, msgs: 4 }, { d: today, platform: 'Groq', model: 'openai/gpt-oss-120b', in: 500, cw: 0, cr: 0, out: 125, msgs: 2 }],
          billed: [{ d: today, amount: 1.25 }], meta: { note: 'from-test' } }; };
        document.getElementById('groq-key').value = 'gsk_rows_9999';
        await App.connectKey(c);
        const rows = Store.sources.groq.rows;
        const t = rows.reduce((a, r) => ({ in: a.in + r.in, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, out: 0, msgs: 0 });
        const a = { label: Store.connectors.groq.label, ...t, billed: Store.billedRows('groq').reduce((s, b) => s + b.amount, 0), metaNote: Store.sources.groq.meta.note,
          days: seen.days, fields: JSON.stringify(seen.fields), key: seen.key, text: document.getElementById('groq-status').textContent };
        // (b) superseded generation: a slow first call resolving after a newer one must not commit, and must not blank the newer status line
        let release;
        window.fetchGroq = () => new Promise(res => { release = res; });
        const p1 = App.connectKey(c);                                 // slow (gen N)
        window.fetchGroq = async () => ({ label: 'fast', detail: 'fast detail' });
        await App.connectKey(c);                                      // fast (gen N+1) finishes first
        release({ label: 'SLOW', detail: 'slow detail', rows: [{ d: today, platform: 'Groq', model: 'stale', in: 1, cw: 0, cr: 0, out: 1, msgs: 1 }] });
        await p1;
        const b = { label: Store.connectors.groq.label, text: document.getElementById('groq-status').textContent, rowsIn: Store.sources.groq.rows.reduce((s, r) => s + r.in, 0) };
        // (c) sessionOnly + extra fields: patch the entry and re-render its card
        LS.del('key:groq');
        c.fields = [{ id: 'region', label: 'Region', placeholder: 'us-east-1' }, { id: 'secret', label: 'Secret', type: 'password', secret: true }, { id: 'notes', label: 'Notes', type: 'textarea' }];
        c.sessionOnly = true;
        document.getElementById('src-groq').remove(); App.ensureSourceCard(c);
        const fUI = { region: !!document.getElementById('groq-f-region'), regionType: document.getElementById('groq-f-region').type, secretType: document.getElementById('groq-f-secret').type,
          notesTag: document.getElementById('groq-f-notes').tagName, noRemember: !document.getElementById('remember-groq'), note: /session only/i.test(document.getElementById('src-groq').textContent) };
        document.getElementById('groq-key').value = 'tok_session_1111';
        document.getElementById('groq-f-region').value = 'us-east-1';
        document.getElementById('groq-f-secret').value = 's3cr3t';
        document.getElementById('groq-f-notes').value = 'n';
        window.fetchGroq = async (key, fields) => { seen = { key, fields }; return { label: 'ok', detail: '' }; };
        await App.connectKey(c);
        const cPersist = { keyLS: LS.get('key:groq', null), region: LS.get('field:groq:region', null), secret: LS.get('field:groq:secret', null), notes: LS.get('field:groq:notes', null),
          fields: JSON.stringify(seen.fields), key: seen.key, leak: document.documentElement.outerHTML.includes('tok_session_1111') || document.documentElement.outerHTML.includes('s3cr3t') };
        // refreshAll: a sessionOnly card re-fetches while its input still holds a token; with the input cleared it does nothing
        let calls = 0; window.fetchGroq = async () => { calls++; return { label: 'ok', detail: '' }; };
        await App.refreshAll(); const refreshWithValue = calls;
        document.getElementById('groq-key').value = '';
        await App.refreshAll(); const refreshEmpty = calls;
        // (d) disconnect clears the key, every field input + its LS value, the connector state and (OK) the data
        document.getElementById('groq-key').value = 'tok_session_1111';
        const origConfirm = window.confirm; window.confirm = () => true;
        App.disconnectConnector('groq');
        window.confirm = origConfirm;
        const d = { key: document.getElementById('groq-key').value, region: document.getElementById('groq-f-region').value, regionLS: LS.get('field:groq:region', null),
          st: Store.connectors.groq === undefined, src: Store.sources.groq === undefined, text: document.getElementById('groq-status').textContent };
        return { a, b, fUI, cPersist, refreshWithValue, refreshEmpty, d };
      } finally {
        window.fetchGroq = origFetchGroq;
        if (saved.fields === undefined) delete c.fields; else c.fields = saved.fields;
        if (saved.sessionOnly === undefined) delete c.sessionOnly; else c.sessionOnly = saved.sessionOnly;
        const card = document.getElementById('src-groq'); if (card) card.remove(); App.ensureSourceCard(c);
        LS.del('key:groq'); LS.del('field:groq:region'); LS.del('field:groq:secret'); LS.del('field:groq:notes');
        Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.persist(); App._render();
      }
    });
    ok('key driver: fetcher rows/billed/meta land under the connector id (in=1500 out=375 msgs=6 billed=1.25, meta kept), label from the fetcher, fields {} + opts.days 90 passed through',
      kd2.a.label === 'k-9999' && kd2.a.in === 1500 && kd2.a.out === 375 && kd2.a.msgs === 6 && Math.abs(kd2.a.billed - 1.25) < 1e-9 && kd2.a.metaNote === 'from-test' &&
      kd2.a.days === 90 && kd2.a.fields === '{}' && kd2.a.key === 'gsk_rows_9999' && /test detail/.test(kd2.a.text), JSON.stringify(kd2.a));
    ok('key driver: a superseded (slower, older) connect commits nothing and leaves the newer status line intact',
      kd2.b.label === 'fast' && /Connected/.test(kd2.b.text) && /fast detail/.test(kd2.b.text) && kd2.b.rowsIn === 1500, JSON.stringify(kd2.b));
    ok('key driver: sessionOnly + fields — inputs <id>-f-<field> (text / password / textarea), no Remember box, "session only" note; key + secret never persisted, non-secret field persisted, values reach the fetcher, nothing leaks into DOM text; refreshAll re-fetches only while the token input holds a value',
      kd2.fUI.region && kd2.fUI.regionType === 'text' && kd2.fUI.secretType === 'password' && kd2.fUI.notesTag === 'TEXTAREA' && kd2.fUI.noRemember && kd2.fUI.note &&
      kd2.cPersist.keyLS === null && kd2.cPersist.region === 'us-east-1' && kd2.cPersist.secret === null && kd2.cPersist.notes === 'n' && !kd2.cPersist.leak &&
      kd2.cPersist.fields === JSON.stringify({ region: 'us-east-1', secret: 's3cr3t', notes: 'n' }) && kd2.cPersist.key === 'tok_session_1111' &&
      kd2.refreshWithValue === 1 && kd2.refreshEmpty === 1, JSON.stringify({ fUI: kd2.fUI, cPersist: kd2.cPersist, refreshWithValue: kd2.refreshWithValue, refreshEmpty: kd2.refreshEmpty }));
    ok('key driver: disconnect clears the key input, every field input + stored field value, the connector state and the data; status reads "Not connected."',
      kd2.d.key === '' && kd2.d.region === '' && kd2.d.regionLS === null && kd2.d.st && kd2.d.src && kd2.d.text === 'Not connected.', JSON.stringify(kd2.d));

    // ---- T2 (c): registry invariant for every key-driver entry (Task 3's six vendors inherit this automatically) ----
    const inv = await page.evaluate(() => {
      const K = CONNECTORS.filter(c => c.fetch);
      return { ids: K.map(c => c.id), every: K.every(c => /^(api-key|admin-key|cloud-token)$/.test(c.kind) && c.keyLS === 'key:' + c.id && c.statusEl === c.id + '-status'
        && !!document.getElementById(c.statusEl) && c.srcIds.includes(c.id) && typeof globalThis[c.fetch] === 'function' && typeof c.keyLabel === 'string'
        && /^(exact|validate|estimated)$/.test(c.quality) && typeof c.qualityNote === 'string' && c.qualityNote.length > 80 && !!document.getElementById(c.id + '-key')
        && !!document.getElementById(c.id + '-validate') && (c.sessionOnly ? !document.getElementById('remember-' + c.id) : !!document.getElementById('remember-' + c.id))
        && (c.fields || []).every(f => !!document.getElementById(c.id + '-f-' + f.id))) };
    });
    ok('key driver: every `fetch` entry is a key kind with keyLS key:<id>, statusEl <id>-status, its own srcId, a registered global fetcher, keyLabel, quality copy, and the key UI (+fields; Remember unless sessionOnly)',
      inv.ids.includes('groq') && inv.every, JSON.stringify(inv));
    // ---- T3: validate-only vendors (Mistral, Cohere, Together, Hugging Face, xAI, Perplexity API) through the key driver ----
    const vend = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const ids = ['mistral', 'cohere', 'together', 'huggingface', 'xai', 'perplexity-api'];
      const missing = ids.filter(id => !connectorById(id) || !document.getElementById(id + '-key'));
      if (missing.length) return { missing };
      const realFetch = window.fetch;
      const resp = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
      // [id, key, routes: [urlSubstring, method, body]]
      const cases = [
        { id: 'mistral', key: 'mk-test', routes: [['https://api.mistral.ai/v1/models', 'GET', { object: 'list', data: [{ id: 'mistral-large-latest' }, { id: 'codestral-latest' }, { id: 'ministral-8b-latest' }] }]] },
        { id: 'cohere', key: 'co-test', routes: [['https://api.cohere.com/v1/check-api-key', 'POST', { valid: true, organization_id: 'org-12345678', owner_id: 'u1' }], ['https://api.cohere.com/v2/models', 'GET', { models: [{ name: 'command-a-03-2025' }, { name: 'embed-v4.0' }] }]] },
        { id: 'together', key: 'tg-test', routes: [['https://api.together.xyz/v1/models', 'GET', [{ id: 'meta-llama/Llama-4-Maverick' }, { id: 'Qwen/Qwen3-235B' }, { id: 'deepseek-ai/DeepSeek-V4' }, { id: 'mistralai/Mixtral-8x22B' }]]] },
        { id: 'huggingface', key: 'hf_test', routes: [['https://huggingface.co/api/whoami-v2', 'GET', { type: 'user', name: 'alaa', fullname: 'Alaa S.', isPro: true, orgs: [{ name: 'acme' }, { name: 'rostum' }] }]] },
        { id: 'xai', key: 'xai-test', routes: [['https://api.x.ai/v1/api-key', 'GET', { name: 'dashboard-key', team_id: 'team_8f1c2d3e4a5b', api_key_id: 'k1', api_key_blocked: false, api_key_disabled: false, team_blocked: false, acls: ['api-key:model:*'] }], ['https://api.x.ai/v1/models', 'GET', { object: 'list', data: [{ id: 'grok-4' }, { id: 'grok-3-mini' }] }]] },
        { id: 'perplexity-api', key: 'pplx-test', routes: [['https://api.perplexity.ai/v1/models', 'GET', { object: 'list', data: [{ id: 'sonar' }, { id: 'sonar-pro' }, { id: 'sonar-reasoning-pro' }] }]] },
      ];
      const out = {};
      for (const k of cases) {
        const c = connectorById(k.id);
        const calls = [];
        window.fetch = async (url, init) => {
          const u = String(url), m = ((init && init.method) || 'GET').toUpperCase();
          calls.push({ u, m, auth: init && init.headers && (init.headers.Authorization || init.headers.authorization) });
          const r = k.routes.find(([pre, meth]) => u.startsWith(pre) && meth === m);
          return r ? resp(r[2]) : resp({ error: { message: 'unexpected ' + m + ' ' + u } }, 404);
        };
        document.getElementById(k.id + '-key').value = k.key;
        await App.connectKey(c);
        const st = Store.connectors[k.id] || {};
        out[k.id] = { label: st.label || null, err: st.err || null, status: Store.connectorStatus(c), text: document.getElementById(k.id + '-status').textContent,
          calls, rows: !!Store.sources[k.id], billed: Store.billedRows(k.id).length };
      }
      // rejected key → attention carrying the server's message (fetchJSON surfaces error.message)
      window.fetch = async () => resp({ error: { message: 'Unauthorized: invalid API key' } }, 401);
      document.getElementById('mistral-key').value = 'bad-key';
      await App.connectKey(connectorById('mistral'));
      out.bad = { err: Store.connectors.mistral && Store.connectors.mistral.err, status: Store.connectorStatus(connectorById('mistral')), text: document.getElementById('mistral-status').textContent };
      // Cohere answers HTTP 200 with valid:false → must still be an error state
      window.fetch = async (url) => String(url).includes('check-api-key') ? resp({ valid: false }) : resp({ models: [] });
      document.getElementById('cohere-key').value = 'bad-key';
      await App.connectKey(connectorById('cohere'));
      out.cohereInvalid = { err: Store.connectors.cohere && Store.connectors.cohere.err, status: Store.connectorStatus(connectorById('cohere')) };
      window.fetch = realFetch;
      for (const id of ids) document.getElementById(id + '-key').value = '';
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.persist(); App._render();
      return out;
    });
    const every = (v, f) => !v.missing && Object.keys(v).filter(k => !/^(bad|cohereInvalid)$/.test(k)).every(id => f(v[id], id));
    ok('validate-only vendors: six api-key entries validate via stubbed fetch (Bearer auth, documented URLs) → honest labels, status ok, no rows/billed',
      every(vend, (r) => r.status === 'ok' && r.err === null && /Connected/.test(r.text) && !r.rows && r.billed === 0)
      && /^3 models available$/.test(vend.mistral.label) && vend.mistral.calls.length === 1 && vend.mistral.calls[0].u === 'https://api.mistral.ai/v1/models' && vend.mistral.calls[0].auth === 'Bearer mk-test'
      && /^valid key · 2 models$/.test(vend.cohere.label) && vend.cohere.calls.length === 2 && vend.cohere.calls[0].m === 'POST' && vend.cohere.calls[0].u === 'https://api.cohere.com/v1/check-api-key' && vend.cohere.calls[1].u === 'https://api.cohere.com/v2/models' && vend.cohere.calls.every(x => x.auth === 'Bearer co-test') && /org-1234/.test(vend.cohere.text)
      && /^4 models available$/.test(vend.together.label) && vend.together.calls.length === 1 && vend.together.calls[0].u === 'https://api.together.xyz/v1/models' && vend.together.calls[0].auth === 'Bearer tg-test'
      && /^alaa · PRO · 2 orgs$/.test(vend.huggingface.label) && /acme, rostum/.test(vend.huggingface.text) && vend.huggingface.calls.length === 1 && vend.huggingface.calls[0].u === 'https://huggingface.co/api/whoami-v2' && vend.huggingface.calls[0].auth === 'Bearer hf_test'
      && /^dashboard-key · team team_8f1/.test(vend.xai.label) && /2 models/.test(vend.xai.text) && vend.xai.calls.length === 2 && vend.xai.calls[0].u === 'https://api.x.ai/v1/api-key' && vend.xai.calls[1].u === 'https://api.x.ai/v1/models' && vend.xai.calls.every(x => x.auth === 'Bearer xai-test')
      && vend['perplexity-api'].label === 'reachable — Sonar keys cannot be verified without a paid request' && /does NOT prove the key is valid/.test(vend['perplexity-api'].text) && vend['perplexity-api'].calls.length === 1 && vend['perplexity-api'].calls[0].u === 'https://api.perplexity.ai/v1/models',
      JSON.stringify(vend));
    ok('validate-only vendors: HTTP 401 → attention with the server message; Cohere valid:false → attention despite HTTP 200',
      !vend.missing && /401/.test(vend.bad.err || '') && /invalid API key/i.test(vend.bad.err || '') && vend.bad.status === 'warn' && /failed|HTTP 401/i.test(vend.bad.text)
      && /not valid/i.test(vend.cohereInvalid.err || '') && vend.cohereInvalid.status === 'warn', JSON.stringify({ bad: vend.bad, cohereInvalid: vend.cohereInvalid, missing: vend.missing }));

    const vinv = await page.evaluate(() => {
      const want = { mistral: 'Mistral', cohere: 'Cohere', together: 'Together AI', huggingface: 'Hugging Face', xai: 'xAI API', 'perplexity-api': 'Perplexity API' };
      const bad = [];
      for (const [id, platform] of Object.entries(want)) {
        const c = connectorById(id);
        if (!c) { bad.push(id + ': missing'); continue; }
        if (c.platform !== platform) bad.push(id + ': platform ' + c.platform);
        if (c.kind !== 'api-key' || c.category !== 'api' || c.quality !== 'validate') bad.push(id + ': kind/category/quality');
        if (c.statusEl !== id + '-status' || !document.getElementById(c.statusEl)) bad.push(id + ': statusEl');
        if (!Array.isArray(c.srcIds) || !c.srcIds.includes(id)) bad.push(id + ': srcIds');
        if (typeof globalThis[c.fetch] !== 'function') bad.push(id + ': fetch ' + c.fetch);
        if (c.keyLS !== 'key:' + id || !c.keyLabel || !c.keyHint) bad.push(id + ': key copy');
        if (!/^validate-only/i.test(c.qualityNote || '') || !/(no usage|no .*endpoint|console|dashboard)/i.test(c.qualityNote || '')) bad.push(id + ': qualityNote honesty');
        if (!c.links || !c.links.usage || !c.links.docs) bad.push(id + ': links');
        if (!Array.isArray(c.paths) || !c.paths.length) bad.push(id + ': paths');
        if (!document.getElementById('src-' + id)) bad.push(id + ': generic card');
      }
      const px = connectorById('perplexity-api');
      if (px && !/cannot verify your key/i.test(px.qualityNote || '')) bad.push('perplexity-api: note must say the key cannot be verified');
      const groq = CONNECTORS.find(c => c.platform === 'Groq');
      if (!groq || groq.kind !== 'api-key' || groq.quality !== 'validate') bad.push('groq (Task 2) missing or not validate-only');
      return { bad, inOrder: Object.values(want).every(p => PLATFORM_ORDER.includes(p)) };
    });
    ok('validate-only vendors: registry invariants (api-key · api · validate · fetch fn · srcIds self · statusEl + card · honest notes/links; Groq from Task 2 present; PLATFORM_ORDER derived)',
      vinv.bad.length === 0 && vinv.inOrder, JSON.stringify(vinv));

  } finally {
    await page.close();
  }
}
