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

    // ---- T7: Fireworks AI (exact tokens + billed USD via the key driver) ----
    const fwServerless = JSON.parse(read('wave2', 'fireworks', 'billingUsage-serverless.json'));
    const fwDedicated = JSON.parse(read('wave2', 'fireworks', 'billingUsage-dedicated.json'));
    const fwSummary = JSON.parse(read('wave2', 'fireworks', 'billing-summary.json'));
    const fw = await page.evaluate(async (serverless, dedicated, summary) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const c = connectorById('fireworks');
      if (typeof fetchFireworks !== 'function' || !c || !document.getElementById('fireworks-key') || !document.getElementById('fireworks-f-account')) return { missing: true };
      const realFetch = window.fetch;
      const resp = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
      let calls = [], failSummary = false;
      // stub = a Fireworks server that answers EVERY window with the whole fixture — the fetcher's half-open window guard must count each bucket exactly once
      window.fetch = async (url, init) => {
        const u = new URL(String(url));
        calls.push({ url: u.toString(), auth: init && init.headers && init.headers.Authorization });
        if (!u.pathname.startsWith('/v1/accounts/my-team/')) return resp({ error: { message: 'unexpected ' + u.pathname } }, 404);
        if (u.pathname.endsWith('/billingUsage')) return resp(u.searchParams.get('usageType') === 'DEDICATED_DEPLOYMENT' ? dedicated : serverless);
        if (u.pathname.endsWith('/billing/summary')) return failSummary ? resp({ error: { message: 'boom' } }, 500) : resp(summary);
        return resp({}, 404);
      };
      // 1) direct fetcher call: rows, billed, URL/header discipline
      const res = await fetchFireworks('fw_test', { account: 'my-team' }, { days: 90 });
      const t = res.rows.reduce((a, r) => ({ in: a.in + r.in, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, out: 0, msgs: 0 });
      const dayA = serverless.serverlessCosts[0].startTime.slice(0, 10), dayB = serverless.serverlessCosts[3].startTime.slice(0, 10);
      const llamaA = res.rows.find(r => r.d === dayA && r.model === 'llama-v3p3-70b-instruct');
      const bu = calls.filter(x => x.url.includes('/billingUsage')), sm = calls.filter(x => x.url.includes('/billing/summary'));
      const winOk = calls.every(x => { const u = new URL(x.url); const s = Date.parse(u.searchParams.get('startTime')), e = Date.parse(u.searchParams.get('endTime')); return e > s && e - s <= 31 * 864e5; });
      const direct = { ...t, n: res.rows.length, platforms: [...new Set(res.rows.map(r => r.platform))], models: res.rows.map(r => r.model).sort(), est: res.rows.some(r => r.est),
        llamaA: llamaA && { in: llamaA.in, out: llamaA.out }, days: [...new Set(res.rows.map(r => r.d))].sort(), dayA, dayB,
        billed: res.billed.map(b => [b.d, b.amount]), billedTotal: res.billed.reduce((a, b) => a + b.amount, 0), label: res.label, detail: res.detail, accel: res.meta && res.meta.acceleratorSeconds,
        nUsage: bu.length, nServerless: bu.filter(x => x.url.includes('usageType=SERVERLESS')).length, nDedicated: bu.filter(x => x.url.includes('usageType=DEDICATED_DEPLOYMENT')).length, nSummary: sm.length,
        groupBy: bu.every(x => { const u = new URL(x.url); return u.searchParams.get('groupBy') === (u.searchParams.get('usageType') === 'SERVERLESS' ? 'model_name' : 'deployment_name'); }), daily: sm.every(x => new URL(x.url).searchParams.get('granularity') === 'DAILY'),
        auth: calls.every(x => x.auth === 'Bearer fw_test'), host: calls.every(x => x.url.startsWith('https://api.fireworks.ai/v1/accounts/my-team/')), winOk };
      const noAccount = await fetchFireworks('fw_test', {}, { days: 90 }).then(() => 'resolved', e => e.message);
      // 2) through the key driver: rows + billed stored under 'fireworks', connector labeled
      calls = [];
      document.getElementById('fireworks-key').value = 'fw_test';
      document.getElementById('fireworks-f-account').value = 'my-team';
      await App.connectKey(c);
      const st = Store.connectors.fireworks || {};
      const rows = (Store.sources.fireworks || {}).rows || [];
      const driver = { status: Store.connectorStatus(c), label: st.label || null, err: st.err || null, text: document.getElementById('fireworks-status').textContent,
        in: rows.reduce((a, r) => a + r.in, 0), out: rows.reduce((a, r) => a + r.out, 0), billedTotal: Store.billedRows('fireworks').reduce((a, b) => a + b.amount, 0), calls: calls.length };
      // 3) summary endpoint fails → tokens still land, no error state, no stale dollars invented
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; failSummary = true;
      await App.connectKey(c);
      const st2 = Store.connectors.fireworks || {};
      const soft = { status: Store.connectorStatus(c), err: st2.err || null, rows: ((Store.sources.fireworks || {}).rows || []).length, billed: Store.billedRows('fireworks').length, text: document.getElementById('fireworks-status').textContent };
      window.fetch = realFetch;
      document.getElementById('fireworks-key').value = ''; document.getElementById('fireworks-f-account').value = '';
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.persist(); App._render();
      return { direct, noAccount, driver, soft, kind: c.kind, cat: c.category, quality: c.quality, fields: JSON.stringify(c.fields), card: !!document.getElementById('src-fireworks') };
    }, fwServerless, fwDedicated, fwSummary);
    ok('fireworks: documented billingUsage shape (serverlessCosts[].group.model_name, string tokens) → exact rows (in=17800 out=4430 msgs=0, 3 day·model rows, "abc" rejected, out-of-window rows dropped); dedicatedCosts (acceleratorSeconds, no tokens) → no row, meta.acceleratorSeconds=7200; billing/summary usageBuckets[].lineItems[].totalCost{units,nanos} → billed 6.46 over 2 days (period-total lineItems not counted)',
      !fw.missing && fw.direct.in === 17800 && fw.direct.out === 4430 && fw.direct.msgs === 0 && fw.direct.n === 3 && !fw.direct.est && fw.direct.accel === 7200
      && fw.direct.platforms.length === 1 && fw.direct.platforms[0] === 'Fireworks AI' && JSON.stringify(fw.direct.models) === JSON.stringify(['llama-v3p3-70b-instruct', 'llama-v3p3-70b-instruct', 'qwen3-235b-a22b'])
      && fw.direct.llamaA && fw.direct.llamaA.in === 12000 && fw.direct.llamaA.out === 3410 && JSON.stringify(fw.direct.days) === JSON.stringify([fw.direct.dayB, fw.direct.dayA].sort())
      && fw.direct.billed.length === 2 && Math.abs(fw.direct.billedTotal - 6.46) < 1e-9 && Math.abs((fw.direct.billed.find(b => b[0] === fw.direct.dayA) || [0, 0])[1] - 6.34) < 1e-9, JSON.stringify(fw.direct || fw));
    ok('fireworks: 31-day windows × 2 usage types + daily summary per window (3+3+3 calls for 90 days), groupBy=model_name (SERVERLESS) / deployment_name (DEDICATED_DEPLOYMENT), Bearer auth, account in the path; status line reports dedicated accelerator-hours; missing account id is a clear error',
      !fw.missing && fw.direct.nUsage === 6 && fw.direct.nServerless === 3 && fw.direct.nDedicated === 3 && fw.direct.nSummary === 3 && fw.direct.groupBy && fw.direct.daily && fw.direct.auth && fw.direct.host && fw.direct.winOk
      && /account id/i.test(fw.noAccount) && /^account my-team/.test(fw.direct.label) && /3 day·model rows/.test(fw.direct.detail) && /2 billed days/.test(fw.direct.detail) && /dedicated 2\.0 accelerator-h/.test(fw.direct.detail), JSON.stringify({ d: fw.direct, noAccount: fw.noAccount }));
    ok('fireworks: key driver stores rows + billed under fireworks (label names the account); summary failure degrades to tokens-only without an error state; registry = api-key · api · exact · account field',
      !fw.missing && fw.driver.status === 'ok' && fw.driver.err === null && /account my-team/.test(fw.driver.label) && /Connected/.test(fw.driver.text) && fw.driver.in === 17800 && fw.driver.out === 4430 && Math.abs(fw.driver.billedTotal - 6.46) < 1e-9 && fw.driver.calls === 9
      && fw.soft.status === 'ok' && fw.soft.err === null && fw.soft.rows === 3 && fw.soft.billed === 0 && /billing summary unavailable/.test(fw.soft.text)
      && fw.kind === 'api-key' && fw.cat === 'api' && fw.quality === 'exact' && fw.card && fw.fields === JSON.stringify([{ id: 'account', label: 'Account id', placeholder: 'e.g. my-team' }]), JSON.stringify({ driver: fw.driver, soft: fw.soft, kind: fw.kind, cat: fw.cat, quality: fw.quality, fields: fw.fields, card: fw.card }));

    // ---- T9a: parseAnthropicCost cents fix + parseAnthropicUsage platform parameter ----
    const cents = await page.evaluate(() => {
      const cost = parseAnthropicCost({ data: [
        { starting_at: '2026-08-02T00:00:00Z', results: [{ amount: '123.45', currency: 'USD' }, { amount: 250, currency: 'USD' }] },   // string + number = lowest units (cents) → 1.2345 + 2.5 = 3.7345
        { starting_at: '2026-08-03T00:00:00Z', results: [{ amount: { value: '42', currency: 'USD' } }] },                            // OpenAI-style object → already dollars → 42
      ] });
      const payload = { data: [{ starting_at: '2026-08-14T00:00:00Z', results: [{ model: 'claude-sonnet-4-5', uncached_input_tokens: 10, cache_read_input_tokens: 4, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 1 }, output_tokens: 7, requests: 3 }] }] };
      const dflt = parseAnthropicUsage(payload).rows[0], ent = parseAnthropicUsage(payload, 'Claude Enterprise (org)').rows[0];
      return { cost, dflt: { platform: dflt.platform, in: dflt.in, cr: dflt.cr, cw: dflt.cw, out: dflt.out, msgs: dflt.msgs }, entPlatform: ent.platform };
    });
    ok('parseAnthropicCost: string/number amounts are cents → /100 (123.45 + 250 → 3.7345); object {value} amounts unchanged (42)',
      cents.cost.length === 2 && cents.cost[0].d === '2026-08-02' && Math.abs(cents.cost[0].amount - 3.7345) < 1e-9 && cents.cost[1].d === '2026-08-03' && cents.cost[1].amount === 42, JSON.stringify(cents.cost));
    ok('parseAnthropicUsage: platform defaults to Anthropic API, explicit platform is used, Analytics `requests` counts as msgs (in=10 cr=4 cw=3 out=7 msgs=3)',
      cents.dflt.platform === 'Anthropic API' && cents.entPlatform === 'Claude Enterprise (org)' && cents.dflt.in === 10 && cents.dflt.cr === 4 && cents.dflt.cw === 3 && cents.dflt.out === 7 && cents.dflt.msgs === 3, JSON.stringify(cents));

    // ---- T9b: Claude Enterprise connector (windows + pagination + headers + floor) and the Anthropic Admin card through the same parsers ----
    const ceUsage = JSON.parse(read('wave2', 'claude-enterprise', 'usage_report.json'));
    const ceCost = JSON.parse(read('wave2', 'claude-enterprise', 'cost_report.json'));
    const ce = await page.evaluate(async (usageFx, costFx) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const c = connectorById('claude-enterprise');
      if (typeof fetchClaudeEnterprise !== 'function' || !c || !document.getElementById('claude-enterprise-key')) return { missing: true };
      const realFetch = window.fetch;
      const resp = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
      let calls = [];
      // stub = a server: returns the fixture buckets whose starting_at falls in [starting_at, ending_at) of the request; when a window holds
      // more than one bucket the first page carries only the first bucket with has_more/next_page='p2' and page=p2 returns the rest
      const pick = (fx, u) => { const s = u.searchParams.get('starting_at'), e = u.searchParams.get('ending_at'); return fx.data.filter(b => b.starting_at >= s && b.starting_at < e); };
      const serve = (fx, u) => {
        const list = pick(fx, u), page = u.searchParams.get('page');
        if (!page) return list.length > 1 ? { data: [list[0]], has_more: true, next_page: 'p2' } : { data: list, has_more: false, next_page: null };
        return { data: list.slice(1), has_more: false, next_page: null };
      };
      window.fetch = async (url, init) => {
        const u = new URL(String(url)); const h = (init && init.headers) || {};
        calls.push({ url: u.toString(), path: u.pathname, key: h['x-api-key'], ver: h['anthropic-version'], browser: h['anthropic-dangerous-direct-browser-access'], page: u.searchParams.get('page'),
          s: u.searchParams.get('starting_at'), e: u.searchParams.get('ending_at'), gb: u.searchParams.getAll('group_by[]'), bw: u.searchParams.get('bucket_width'), lim: u.searchParams.get('limit') });
        if (u.pathname === '/v1/organizations/analytics/usage_report') return resp(serve(usageFx, u));
        if (u.pathname === '/v1/organizations/analytics/cost_report') return resp(serve(costFx, u));
        if (u.pathname === '/v1/organizations/usage_report/messages') return resp({ data: [{ starting_at: usageFx.data[2].starting_at, results: [{ model: 'claude-sonnet-4-5', uncached_input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }] }], has_more: false, next_page: null });
        if (u.pathname === '/v1/organizations/cost_report') return resp({ data: [{ starting_at: usageFx.data[2].starting_at, results: [{ amount: '4200', currency: 'USD', cost_type: 'tokens' }] }], has_more: false, next_page: null });
        return resp({ error: { message: 'unexpected ' + u.pathname } }, 404);
      };
      // 1) direct fetcher
      const res = await fetchClaudeEnterprise('sk-ant-api03-test', {}, { days: 90 });
      const t = res.rows.reduce((a, r) => ({ in: a.in + r.in, cr: a.cr + r.cr, cw: a.cw + r.cw, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, cr: 0, cw: 0, out: 0, msgs: 0 });
      const us = calls.filter(x => x.path.endsWith('/analytics/usage_report')), cs = calls.filter(x => x.path.endsWith('/analytics/cost_report'));
      const dayA = usageFx.data[2].starting_at.slice(0, 10);
      const direct = { ...t, n: res.rows.length, platforms: [...new Set(res.rows.map(r => r.platform))], models: [...new Set(res.rows.map(r => r.model))].sort(), billed: res.billed.map(b => [b.d, b.amount]),
        billedTotal: res.billed.reduce((a, b) => a + b.amount, 0), billedA: (res.billed.find(b => b.d === dayA) || {}).amount, label: res.label, detail: res.detail,
        nUsage: us.length, nCost: cs.length, paged: us.filter(x => x.page === 'p2').length + cs.filter(x => x.page === 'p2').length,
        headers: calls.every(x => x.key === 'sk-ant-api03-test' && x.ver === '2023-06-01' && x.browser === 'true'),
        params: calls.every(x => x.gb.length === 1 && x.gb[0] === 'model' && x.bw === '1d' && x.lim === '31'),
        windows: calls.every(x => { const s = Date.parse(x.s), e = Date.parse(x.e); return e > s && e - s <= 31 * 864e5 && /T00:00:00Z$/.test(x.s) && /T00:00:00Z$/.test(x.e); }),
        floorOk: calls.every(x => x.s >= '2026-01-01T00:00:00Z') };
      // 2) the floor: asking for far more history clamps starting_at to 2026-01-01 (the API refuses earlier dates)
      calls = [];
      await fetchClaudeEnterprise('sk-ant-api03-test', {}, { days: 5000 });
      const floor = { min: calls.map(x => x.s).sort()[0], allAfter: calls.every(x => x.s >= '2026-01-01T00:00:00Z') };
      // 3) through the key driver
      calls = [];
      document.getElementById('claude-enterprise-key').value = 'sk-ant-api03-test';
      await App.connectKey(c);
      const st = Store.connectors['claude-enterprise'] || {};
      const rows = (Store.sources['claude-enterprise'] || {}).rows || [];
      const driver = { status: Store.connectorStatus(c), label: st.label || null, err: st.err || null, text: document.getElementById('claude-enterprise-status').textContent,
        in: rows.reduce((a, r) => a + r.in, 0), msgs: rows.reduce((a, r) => a + r.msgs, 0), platforms: [...new Set(rows.map(r => r.platform))], billedTotal: Store.billedRows('claude-enterprise').reduce((a, b) => a + b.amount, 0) };
      // 4) the existing Anthropic Admin card still yields 'Anthropic API' rows, and its cost_report '4200' (cents) lands as $42
      document.getElementById('anthropic-key').value = 'sk-ant-admin-test';
      await App.connectKey(connectorById('anthropic'));
      const arows = (Store.sources.anthropic || {}).rows || [];
      const admin = { platforms: [...new Set(arows.map(r => r.platform))], in: arows.reduce((a, r) => a + r.in, 0), billed: Store.billedRows('anthropic').map(b => b.amount), text: document.getElementById('anthropic-status').textContent };
      window.fetch = realFetch;
      document.getElementById('claude-enterprise-key').value = ''; document.getElementById('anthropic-key').value = '';
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.persist(); App._render();
      return { direct, floor, driver, admin, kind: c.kind, cat: c.category, quality: c.quality, platform: c.platform, note: /Enterprise/.test(c.qualityNote || '') && /not Pro, Max or Team/i.test(c.qualityNote || '') && /2026-01-01/.test(c.qualityNote || ''), card: !!document.getElementById('src-claude-enterprise') };
    }, ceUsage, ceCost);
    ok('claude-enterprise: usage_report + cost_report in 31-day windows with pagination → in=3300 cw=200 cr=500 out=1850 msgs=35 (3 rows, platform Claude Enterprise (org)); billed 2.30 total / 1.845 on day A (cents→USD)',
      !ce.missing && ce.direct.in === 3300 && ce.direct.cw === 200 && ce.direct.cr === 500 && ce.direct.out === 1850 && ce.direct.msgs === 35 && ce.direct.n === 3
      && ce.direct.platforms.length === 1 && ce.direct.platforms[0] === 'Claude Enterprise (org)' && JSON.stringify(ce.direct.models) === JSON.stringify(['claude-opus-4-1', 'claude-sonnet-4-5'])
      && ce.direct.billed.length === 3 && Math.abs(ce.direct.billedTotal - 2.30) < 1e-9 && Math.abs(ce.direct.billedA - 1.845) < 1e-9 && /Analytics key · last 4: test/.test(ce.direct.label) && /3 usage rows \+ billed costs/.test(ce.direct.detail), JSON.stringify(ce.direct || ce));
    ok('claude-enterprise: 3 windows + 1 paginated page per report (4+4 calls), x-api-key + anthropic-version + browser-access headers, group_by[]=model/1d/31, UTC-midnight bounds, starting_at floor 2026-01-01',
      !ce.missing && ce.direct.nUsage === 4 && ce.direct.nCost === 4 && ce.direct.paged === 2 && ce.direct.headers && ce.direct.params && ce.direct.windows && ce.direct.floorOk
      && ce.floor.min === '2026-01-01T00:00:00Z' && ce.floor.allAfter, JSON.stringify({ d: ce.direct, floor: ce.floor }));
    ok('claude-enterprise: key driver stores rows + billed under claude-enterprise (admin-key · chat · exact; Enterprise-only copy); Anthropic Admin card still yields Anthropic API rows and cost "4200" → $42',
      !ce.missing && ce.driver.status === 'ok' && ce.driver.err === null && /Analytics key/.test(ce.driver.label) && /Connected/.test(ce.driver.text) && ce.driver.in === 3300 && ce.driver.msgs === 35 && ce.driver.platforms.length === 1 && ce.driver.platforms[0] === 'Claude Enterprise (org)' && Math.abs(ce.driver.billedTotal - 2.30) < 1e-9
      && ce.admin.platforms.length === 1 && ce.admin.platforms[0] === 'Anthropic API' && ce.admin.in === 5 && ce.admin.billed.length === 1 && ce.admin.billed[0] === 42 && /Connected/.test(ce.admin.text)
      && ce.kind === 'admin-key' && ce.cat === 'chat' && ce.quality === 'exact' && ce.platform === 'Claude Enterprise (org)' && ce.note && ce.card, JSON.stringify({ driver: ce.driver, admin: ce.admin, kind: ce.kind, cat: ce.cat, quality: ce.quality, note: ce.note, card: ce.card }));
  } finally {
    await page.close();
  }
}
