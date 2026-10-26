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

    // ---- Plan 9 B2: generic OpenAI-compatible card — validate (GET {base}/v1/models) + fingerprint OpenRouter / LiteLLM / vLLM / plain ----
    const oc = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const c = connectorById('openai-compatible');
      if (typeof fetchOpenAICompatible !== 'function' || !c || !document.getElementById('openai-compatible-key') || !document.getElementById('openai-compatible-f-base')) return { missing: true };
      const reg = { kind: c.kind, cat: c.category, quality: c.quality, keyOptional: c.keyOptional === true, platform: c.platform, fields: (c.fields || []).map(f => f.id), secretBase: !!(c.fields || []).find(f => f.id === 'base' && (f.secret || f.type === 'password')),
        note: /OpenRouter/.test(c.qualityNote) && /LiteLLM/.test(c.qualityNote) && /vLLM/.test(c.qualityNote) && /CORS/.test(c.qualityNote) && /^validate-only/i.test(c.qualityNote), badge: document.querySelector('#src-openai-compatible .badge').textContent };
      const realFetch = window.fetch;
      const text = (body, status = 200, type = 'text/plain') => new Response(body, { status, headers: { 'content-type': type } });
      const json = (body, status = 200) => text(JSON.stringify(body), status, 'application/json');
      let calls = [], server = {};
      // stub: one virtual server per attempt — server[path] answers that path (a function of the URL and the Authorization header), everything else is 404
      window.fetch = async (url, init) => {
        const u = new URL(String(url)); const auth = init && init.headers && init.headers.Authorization;
        calls.push({ url: u.toString(), path: u.pathname, auth: auth || null, signal: !!(init && init.signal) });
        const h = server[u.pathname]; return h ? h(u, auth) : json({ error: { message: 'no route' } }, 404);
      };
      const models = (n) => json({ object: 'list', data: Array.from({ length: n }, (_, i) => ({ id: 'model-' + i, object: 'model' })) });
      const attempt = (base, key) => fetchOpenAICompatible(key, { base }, { days: 90 }).then(r => ({ ok: true, r }), e => ({ ok: false, err: e.message }));
      // 1) bad base URLs are refused before any request
      const bad = {};
      for (const b of ['', 'not a url', 'ftp://host/v1', 'http://api.example.com/v1', 'https://user:pw@api.example.com', 'https://api.example.com/v1?x=1']) { calls = []; const a = await attempt(b, 'k'); bad[b || '(empty)'] = { ok: a.ok, calls: calls.length, err: a.err }; }
      // 2) plain server with a key: /v1 stripped once, Bearer sent, the three fingerprints answered 404 → validate-only, rows null
      server = { '/v1/models': (u, auth) => auth === 'Bearer sk-plain' ? models(3) : json({ error: { message: 'bad key' } }, 401) };
      calls = []; const plain = await attempt('https://api.example.com/v1/', 'sk-plain');
      const plainCalls = calls.map(x => x.path);
      // 3) open server, no key (keyOptional): 200 without a key is tolerated and said so
      server = { '/v1/models': () => models(2) };
      calls = []; const open = await attempt('http://localhost:1234', '');
      const openAuth = calls.map(x => x.auth);
      // 4) OpenRouter: {base}/v1/key → spend; today's usage_daily lands as a billed day, no token rows
      server = { '/api/v1/models': () => models(5), '/api/v1/key': (u, auth) => auth === 'Bearer sk-or-1' ? json({ data: { label: 'sk-or-v1-abc', usage: 12.5, usage_daily: 1.25, limit: 100, limit_remaining: 87.5 } }) : json({}, 401) };
      calls = []; const or = await attempt('https://openrouter.ai/api/v1', 'sk-or-1');
      const orCalls = calls.map(x => x.path);
      // 5) LiteLLM: {base}/key/info (key only in the header, never ?key=) → spend
      server = { '/v1/models': () => models(4), '/key/info': (u, auth) => auth === 'Bearer sk-lite' && !u.searchParams.has('key') ? json({ key: 'sk-lite', info: { token: 'hashed', spend: 3.5, max_budget: 10, models: [] } }) : json({}, 401) };
      calls = []; const lite = await attempt('http://localhost:4000', 'sk-lite');
      const liteKeyInUrl = calls.some(x => /key=/.test(x.url));
      // 6) vLLM: {base}/metrics answers with vllm: counters → named, pointed at the vLLM card, rows null
      server = { '/v1/models': () => models(1), '/metrics': () => text('# HELP vllm:prompt_tokens_total x\nvllm:prompt_tokens_total{model_name="Qwen/Qwen3-8B"} 1200\nvllm:generation_tokens_total{model_name="Qwen/Qwen3-8B"} 300\n') };
      calls = []; const vl = await attempt('http://127.0.0.1:8000', '');
      // 7) a fingerprint error other than 404/401 is surfaced in the detail, the validation still stands
      server = { '/v1/models': () => models(3), '/v1/key': () => json({ error: { message: 'upstream down' } }, 503) };
      calls = []; const errSurf = await attempt('https://api.example.com', 'sk-x');
      // 8) a rejected key → the error is the card's (HTTP 401)
      server = { '/v1/models': () => json({ error: { message: 'Incorrect API key' } }, 401) };
      calls = []; const rejected = await attempt('https://api.example.com/v1', 'sk-bad');
      // 9) through the key driver: the base URL (non-secret) persists, the key follows Remember; an open server connects with an empty key
      server = { '/v1/models': () => models(2) };
      document.getElementById('openai-compatible-f-base').value = 'http://localhost:1234/v1'; document.getElementById('openai-compatible-key').value = '';
      const rem = document.getElementById('remember-openai-compatible'); if (rem) rem.checked = false;
      calls = []; await App.connectKey(c);
      const st = Store.connectors['openai-compatible'] || {};
      App.renderHub();
      const hub = document.querySelector('#accounts-hub .acct[data-connector="openai-compatible"]');
      const driver = { status: Store.connectorStatus(c), label: st.label || null, err: st.err || null, text: document.getElementById('openai-compatible-status').textContent, calls: calls.length,
        base: LS.get('field:openai-compatible:base', null), key: LS.get('key:openai-compatible', null), hasSrc: !!Store.sources['openai-compatible'], group: hub && hub.closest('.hub-group').dataset.group };
      // a rejected key through the driver → warn, message kept, nothing remembered
      server = { '/v1/models': () => json({ error: { message: 'Incorrect API key' } }, 401) };
      document.getElementById('openai-compatible-key').value = 'sk-bad'; if (rem) rem.checked = true;
      await App.connectKey(c);
      const driverBad = { status: Store.connectorStatus(c), err: (Store.connectors['openai-compatible'] || {}).err, key: LS.get('key:openai-compatible', null), text: document.getElementById('openai-compatible-status').textContent };
      window.fetch = realFetch;
      if (rem) rem.checked = false; document.getElementById('openai-compatible-key').value = ''; document.getElementById('openai-compatible-f-base').value = ''; LS.del('field:openai-compatible:base'); LS.del('key:openai-compatible');
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.persist(); App._render();
      return { reg, bad, plain, plainCalls, open, openAuth, or, orCalls, lite, liteKeyInUrl, vl, errSurf, rejected, driver, driverBad, today: dayKeyUTC(new Date()) };
    });
    ok('openai-compatible (B2): registry entry — api-key · API vendors · validate-only badge · fields [base] (not secret) · key optional · copy names the OpenRouter / LiteLLM / vLLM fingerprints and the per-host CORS caveat',
      !oc.missing && oc.reg.kind === 'api-key' && oc.reg.cat === 'api' && oc.reg.quality === 'validate' && oc.reg.badge === 'validate-only' && oc.reg.keyOptional && JSON.stringify(oc.reg.fields) === JSON.stringify(['base']) && !oc.reg.secretBase && oc.reg.note, JSON.stringify(oc.reg || oc));
    ok('openai-compatible (B2): base URL rules — empty, non-URL, ftp, http on a non-local host, credentials in the URL and a query string are refused before any request',
      !oc.missing && Object.values(oc.bad).every(b => !b.ok && b.calls === 0 && /base URL/i.test(b.err)), JSON.stringify(oc.bad));
    ok('openai-compatible (B2): plain server — GET {base}/v1/models with Bearer (trailing /v1 stripped once, never /v1/v1), fingerprints /v1/key, /key/info, /metrics all 404 → "3 models", rows null, no billed path, detail "validated — this server exposes no usage endpoint"',
      !oc.missing && oc.plain.ok && oc.plain.r.rows === null && oc.plain.r.billed === undefined && /3 models/.test(oc.plain.r.label) && /validated — this server exposes no usage endpoint/.test(oc.plain.r.detail)
      && JSON.stringify(oc.plainCalls) === JSON.stringify(['/v1/models', '/v1/key', '/key/info', '/metrics']) && oc.plain.r.meta && oc.plain.r.meta.backend === 'plain', JSON.stringify({ plain: oc.plain, calls: oc.plainCalls }));
    ok('openai-compatible (B2): open server (no key) — 200 without a key is accepted, no Authorization header sent, the detail says so',
      !oc.missing && oc.open.ok && oc.openAuth.every(a => a === null) && /2 models/.test(oc.open.r.label) && /without a key/i.test(oc.open.r.detail) && oc.open.r.rows === null, JSON.stringify({ open: oc.open, auth: oc.openAuth }));
    ok('openai-compatible (B2): OpenRouter fingerprint — {base}/v1/key → label names OpenRouter, $12.50 spent in the detail, usage_daily 1.25 → one billed day (today, UTC), rows null',
      !oc.missing && oc.or.ok && /OpenRouter/.test(oc.or.r.label) && /12\.50/.test(oc.or.r.detail) && oc.or.r.rows === null && Array.isArray(oc.or.r.billed) && oc.or.r.billed.length === 1 && oc.or.r.billed[0].d === oc.today && oc.or.r.billed[0].amount === 1.25
      && oc.orCalls.includes('/api/v1/key') && oc.or.r.meta.backend === 'openrouter', JSON.stringify({ or: oc.or, calls: oc.orCalls, today: oc.today }));
    ok('openai-compatible (B2): LiteLLM fingerprint — {base}/key/info with the key in the Authorization header only (never ?key=) → label names LiteLLM, $3.50 spent of the $10 budget, rows null, no billed path',
      !oc.missing && oc.lite.ok && /LiteLLM/.test(oc.lite.r.label) && /3\.50/.test(oc.lite.r.detail) && /\$10/.test(oc.lite.r.detail) && !oc.liteKeyInUrl && oc.lite.r.rows === null && oc.lite.r.billed === undefined && oc.lite.r.meta.backend === 'litellm', JSON.stringify({ lite: oc.lite, keyInUrl: oc.liteKeyInUrl }));
    ok('openai-compatible (B2): vLLM fingerprint — {base}/metrics with vllm: counters → label names vLLM, detail points at the vLLM card (no poll from this card), rows null',
      !oc.missing && oc.vl.ok && /vLLM/.test(oc.vl.r.label) && /vLLM card/.test(oc.vl.r.detail) && oc.vl.r.rows === null && oc.vl.r.meta.backend === 'vllm', JSON.stringify(oc.vl));
    ok('openai-compatible (B2): a fingerprint failure other than 404/401 (503 on /v1/key) is surfaced in the detail, never swallowed — the model-list validation still stands; a 401 on /v1/models is the card\'s error',
      !oc.missing && oc.errSurf.ok && /\/v1\/key/.test(oc.errSurf.r.detail) && /HTTP 503/.test(oc.errSurf.r.detail) && /upstream down/.test(oc.errSurf.r.detail) && oc.errSurf.r.meta.backend === 'plain'
      && !oc.rejected.ok && /HTTP 401/.test(oc.rejected.err) && /Incorrect API key/.test(oc.rejected.err), JSON.stringify({ errSurf: oc.errSurf, rejected: oc.rejected }));
    ok('openai-compatible (B2): key driver — an open server connects with an empty key (keyOptional), the base URL persists as a plain field (LS field:openai-compatible:base), no key remembered, no rows stored, hub group API vendors; a rejected key → warn + HTTP 401, not remembered',
      !oc.missing && oc.driver.status === 'ok' && oc.driver.err === null && /2 models/.test(oc.driver.label) && /Connected/.test(oc.driver.text) && oc.driver.calls >= 1 && oc.driver.base === 'http://localhost:1234/v1' && oc.driver.key === null && !oc.driver.hasSrc && oc.driver.group === 'api'
      && oc.driverBad.status === 'warn' && /HTTP 401/.test(oc.driverBad.err) && oc.driverBad.key === null && /Validation failed/.test(oc.driverBad.text), JSON.stringify({ driver: oc.driver, bad: oc.driverBad }));

    // ---- Plan 9 B2: Poe — points_history paged by starting_after → exact tokens per bot (cost_breakdown strings), cost_usd → billed, current_balance in the label ----
    const poe = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const c = connectorById('poe');
      if (typeof fetchPoe !== 'function' || typeof parsePoeCostBreakdown !== 'function' || !c || !document.getElementById('poe-key')) return { missing: true };
      const reg = { kind: c.kind, cat: c.category, quality: c.quality, platform: c.platform, badge: document.querySelector('#src-poe .badge').textContent,
        note: /^exact/i.test(c.qualityNote) && /cost_breakdown/i.test(c.qualityNote) && /unverified/i.test(c.qualityNote) && /'Chat'/.test(c.qualityNote) && /30 days/.test(c.qualityNote) };
      // parser unit cases: the documented example breakdown (Input counts every prompt token; Cache write / Cache discount are its cached subsets), a flat string, garbage
      const bd = { Input: '450 points (5290 tokens)', 'Cache write': '63 points (2921 tokens)', Output: '7 points (15 tokens)', 'Cache discount': '-181 points (2366 tokens)', Total: '339 points' };
      const parser = { doc: parsePoeCostBreakdown(bd), plain: parsePoeCostBreakdown({ Input: '12 points (1,500 tokens)', Output: '3 points (40 tokens)', Total: '15 points' }),
        str: parsePoeCostBreakdown('Input: 450 points (5290 tokens), Output: 7 points (15 tokens)'), junk: parsePoeCostBreakdown({ Total: '339 points' }), none: parsePoeCostBreakdown(null) };
      // fixture: two pages (newest first), day A = 2026-10-20, day B = 2026-10-19 (creation_time in unix MICROseconds)
      const us = (iso) => Date.parse(iso) * 1000;
      const page1 = { has_more: true, length: 2, data: [
        { creation_time: us('2026-10-20T14:00:00Z'), bot_name: 'Claude-Sonnet-4.5', query_id: 'q1', usage_type: 'API', api_key_name: 'main', cost_points: 339, cost_usd: '0.0339', cost_breakdown_in_points: bd },
        { creation_time: us('2026-10-20T09:30:00Z'), bot_name: 'GPT-5', query_id: 'q2', usage_type: 'Chat', chat_name: 'ideas', cost_points: 120, cost_usd: '0.0120', cost_breakdown_in_points: { Input: '100 points (2000 tokens)', Output: '20 points (400 tokens)', Total: '120 points' } } ] };
      const page2 = { has_more: false, length: 2, data: [
        { creation_time: us('2026-10-19T22:10:00Z'), bot_name: 'Claude-Sonnet-4.5', query_id: 'q3', usage_type: 'Chat', chat_name: 'ideas', cost_points: 50, cost_usd: '0.0050', cost_breakdown_in_points: { Input: '40 points (800 tokens)', Output: '10 points (120 tokens)', Total: '50 points' } },
        { creation_time: us('2026-10-19T08:00:00Z'), bot_name: 'Imagen-4', query_id: 'q4', usage_type: 'API', api_key_name: 'main', cost_points: 900, cost_usd: '0.0900', cost_breakdown_in_points: { 'Image generation': '900 points', Total: '900 points' } } ] };
      const realFetch = window.fetch;
      const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      let calls = [], mode = 'ok';
      window.fetch = async (url, init) => {
        const u = new URL(String(url)); const auth = init && init.headers && init.headers.Authorization;
        calls.push({ url: u.toString(), path: u.pathname, after: u.searchParams.get('starting_after'), limit: u.searchParams.get('limit'), auth: auth || null, signal: !!(init && init.signal) });
        if (u.host !== 'api.poe.com') return json({ error: 'wrong host' }, 404);
        if (mode === '401') return json({ error: { message: 'Invalid API key' } }, 401);
        if (mode === '429') return json({ error: { message: 'Rate limit exceeded' } }, 429);
        if (auth !== 'Bearer poe-test') return json({ error: { message: 'Invalid API key' } }, 401);
        if (u.pathname === '/usage/current_balance') return json({ current_point_balance: 1234567 });
        if (u.pathname === '/usage/points_history') return json(u.searchParams.get('starting_after') === 'q2' ? page2 : u.searchParams.get('starting_after') ? { has_more: false, length: 0, data: [] } : page1);
        return json({}, 404);
      };
      const direct = await fetchPoe('poe-test', {}, { days: 90 });
      const hist = calls.filter(x => x.path === '/usage/points_history');
      const row = (d, m) => direct.rows.find(r => r.d === d && r.model === m);
      const pick = (r) => r && { in: r.in, cw: r.cw, cr: r.cr, out: r.out, msgs: r.msgs, est: r.est };
      const d1 = { label: direct.label, detail: direct.detail, n: direct.rows.length, platforms: [...new Set(direct.rows.map(r => r.platform))],
        sonnetA: pick(row('2026-10-20', 'Claude-Sonnet-4.5')), gptA: pick(row('2026-10-20', 'GPT-5')), sonnetB: pick(row('2026-10-19', 'Claude-Sonnet-4.5')), imagenB: pick(row('2026-10-19', 'Imagen-4')),
        billed: direct.billed.map(b => [b.d, Math.round(b.amount * 1e6) / 1e6]), meta: direct.meta, paging: hist.map(x => [x.after, x.limit]), auth: calls.every(x => x.auth === 'Bearer poe-test'), signals: calls.every(x => x.signal), balanceCalled: calls.some(x => x.path === '/usage/current_balance') };
      // key rejected (401) and rate limit (429) are the card's errors
      mode = '401'; const rej = await fetchPoe('poe-test', {}, { days: 90 }).then(() => 'resolved', e => e.message);
      mode = '429'; const limited = await fetchPoe('poe-test', {}, { days: 90 }).then(() => 'resolved', e => e.message);
      mode = 'ok';
      // through the key driver: rows + billed under 'poe', platform Poe, hub group Chat apps
      calls = [];
      document.getElementById('poe-key').value = 'poe-test'; const rem = document.getElementById('remember-poe'); if (rem) rem.checked = false;
      await App.connectKey(c);
      const st = Store.connectors.poe || {}; const rows = (Store.sources.poe || {}).rows || [];
      App.renderHub();
      const hub = document.querySelector('#accounts-hub .acct[data-connector="poe"]');
      const driver = { status: Store.connectorStatus(c), label: st.label || null, err: st.err || null, text: document.getElementById('poe-status').textContent, n: rows.length,
        in: rows.reduce((a, r) => a + r.in, 0), out: rows.reduce((a, r) => a + r.out, 0), msgs: rows.reduce((a, r) => a + r.msgs, 0), platforms: [...new Set(rows.map(r => r.platform))],
        billedTotal: Math.round(Store.billedRows('poe').reduce((a, b) => a + b.amount, 0) * 1e6) / 1e6, byType: (Store.sources.poe || {}).meta && Store.sources.poe.meta.byType, group: hub && hub.closest('.hub-group').dataset.group, leak: document.documentElement.outerHTML.includes('poe-test') };
      window.fetch = realFetch;
      document.getElementById('poe-key').value = ''; LS.del('key:poe');
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.persist(); App._render();
      return { reg, parser, d1, rej, limited, driver };
    });
    ok('poe (B2): registry entry — api-key · Chat apps · exact badge · platform Poe · copy says tokens come from the cost_breakdown strings, 30 days retention, and that usage_type \'Chat\' for subscription turns is unverified',
      !poe.missing && poe.reg.kind === 'api-key' && poe.reg.cat === 'chat' && poe.reg.quality === 'exact' && poe.reg.badge === 'exact' && poe.reg.platform === 'Poe' && poe.reg.note, JSON.stringify(poe.reg || poe));
    ok('poe (B2): parsePoeCostBreakdown — documented example → in 3 (5290 − 2921 cache write − 2366 cache discount), cw 2921, cr 2366, out 15, parsed; "1,500 tokens" → 1500; flat string form parsed; Total-only / null → tokens 0, parsed false',
      !poe.missing && JSON.stringify(poe.parser.doc) === JSON.stringify({ in: 3, cw: 2921, cr: 2366, out: 15, parsed: true }) && JSON.stringify(poe.parser.plain) === JSON.stringify({ in: 1500, cw: 0, cr: 0, out: 40, parsed: true })
      && JSON.stringify(poe.parser.str) === JSON.stringify({ in: 5290, cw: 0, cr: 0, out: 15, parsed: true }) && poe.parser.junk.parsed === false && poe.parser.junk.in === 0 && poe.parser.none.parsed === false, JSON.stringify(poe.parser));
    ok('poe (B2): points_history paged by starting_after (limit 100; page 2 asks after q2; stops at has_more false) → 4 day·bot rows, platform Poe, exact: Sonnet day A in 3 / cw 2921 / cr 2366 / out 15 / 1 query, GPT-5 2000/400, Sonnet day B 800/120, Imagen-4 unparsed → tokens 0 + 1 query; billed per day 0.095 / 0.0459; label "Poe · balance 1,234,567 points"; meta byType API 2 / Chat 2, unparsed 1',
      !poe.missing && poe.d1.n === 4 && poe.d1.platforms.length === 1 && poe.d1.platforms[0] === 'Poe' && JSON.stringify(poe.d1.sonnetA) === JSON.stringify({ in: 3, cw: 2921, cr: 2366, out: 15, msgs: 1, est: 0 })
      && JSON.stringify(poe.d1.gptA) === JSON.stringify({ in: 2000, cw: 0, cr: 0, out: 400, msgs: 1, est: 0 }) && JSON.stringify(poe.d1.sonnetB) === JSON.stringify({ in: 800, cw: 0, cr: 0, out: 120, msgs: 1, est: 0 }) && JSON.stringify(poe.d1.imagenB) === JSON.stringify({ in: 0, cw: 0, cr: 0, out: 0, msgs: 1, est: 0 })
      && JSON.stringify(poe.d1.billed) === JSON.stringify([['2026-10-19', 0.095], ['2026-10-20', 0.0459]]) && poe.d1.label === 'Poe · balance 1,234,567 points' && JSON.stringify(poe.d1.paging) === JSON.stringify([[null, '100'], ['q2', '100']])
      && poe.d1.meta.byType.API === 2 && poe.d1.meta.byType.Chat === 2 && poe.d1.meta.unparsed === 1 && poe.d1.meta.queries === 4 && poe.d1.auth && poe.d1.signals && poe.d1.balanceCalled && /4 queries/.test(poe.d1.detail) && /1 breakdown/.test(poe.d1.detail), JSON.stringify(poe.d1));
    ok('poe (B2): 401 → "HTTP 401 — Invalid API key" (key rejected); 429 → "HTTP 429 — Rate limit exceeded" surfaced, never retried silently',
      !poe.missing && /HTTP 401/.test(poe.rej) && /Invalid API key/.test(poe.rej) && /HTTP 429/.test(poe.limited) && /Rate limit exceeded/.test(poe.limited), JSON.stringify({ rej: poe.rej, limited: poe.limited }));
    ok('poe (B2): key driver stores rows (in 2803 / out 535 / 4 queries, platform Poe) + billed $0.1409 under poe, label with the balance, meta.byType kept, hub group Chat apps, key never in the DOM',
      !poe.missing && poe.driver.status === 'ok' && poe.driver.err === null && /balance 1,234,567 points/.test(poe.driver.label) && /Connected/.test(poe.driver.text) && poe.driver.n === 4 && poe.driver.in === 2803 && poe.driver.out === 535 && poe.driver.msgs === 4
      && poe.driver.platforms.length === 1 && poe.driver.platforms[0] === 'Poe' && poe.driver.billedTotal === 0.1409 && poe.driver.byType && poe.driver.byType.API === 2 && poe.driver.group === 'chat' && !poe.driver.leak, JSON.stringify(poe.driver));

    // ---- Plan 9 B3: DeepInfra — exact (gated): GET /v1/me validates, GET /payment/usage gives month·model items in cents; 401/403 there → validate-only downgrade ----
    const di = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const c = connectorById('deepinfra');
      if (typeof fetchDeepInfra !== 'function' || typeof parseDeepInfraUsage !== 'function' || !c || !document.getElementById('deepinfra-key')) return { missing: true };
      const reg = { kind: c.kind, cat: c.category, quality: c.quality, platform: c.platform, badge: document.querySelector('#src-deepinfra .badge').textContent,
        note: /^exact \(gated\)/i.test(c.qualityNote) && /401 or 403/.test(c.qualityNote) && /validate-only/i.test(c.qualityNote) && /cents/.test(c.qualityNote) && /first day/i.test(c.qualityNote) };
      // fixture after the OpenAPI shape: months[].items { model{...}, units, rate, cost (cents), pricing_type, interval {fr,to} ms }, total_cost (cents), invoice_id
      const m = (y, mo) => Date.UTC(y, mo - 1, 1), sep = { fr: m(2026, 9), to: m(2026, 10) }, oct = { fr: m(2026, 10), to: m(2026, 11) }, oct5 = { fr: Date.UTC(2026, 9, 5), to: Date.UTC(2026, 9, 6) };
      const usage = { initial_month: '2026.09', months: [
        { period: '2026.09', interval: sep, total_cost: 1250, invoice_id: 'in_0001', items: [
          { model: { model_name: 'meta-llama/Llama-3.3-70B-Instruct' }, units: 1000000, rate: 0.000023, cost: 23, pricing_type: 'input_tokens', interval: sep },
          { model: { model_name: 'meta-llama/Llama-3.3-70B-Instruct' }, units: 200000, rate: 0.00004, cost: 8, pricing_type: 'output_tokens', interval: sep },
          { model: { model_name: 'black-forest-labs/FLUX-1-schnell' }, units: 300, rate: 0.5, cost: 150, pricing_type: 'image_output', interval: sep },   // non-token billing → no row, dollars via total_cost only
          { model: { model_name: 'deepseek-ai/DeepSeek-V3' }, units: 'abc', rate: 0.00005, cost: 0, pricing_type: 'input_tokens', interval: sep } ] },        // unreadable units → skipped + counted
        { period: '2026.10', interval: oct, total_cost: 305, invoice_id: 'NOT_FINAL', items: [
          { model: { model_name: 'Qwen/Qwen3-235B-A22B' }, units: 50000, rate: 0.00002, cost: 1, pricing_type: 'input_tokens', interval: oct5 },          // a one-day interval → that day
          { model: { model_name: 'Qwen/Qwen3-235B-A22B' }, units: 10000, rate: 0.00006, cost: 1, pricing_type: 'output_tokens', interval: oct5 },
          { model: { model_name: 'Qwen/Qwen3-235B-A22B' }, units: 4000, rate: 0.000002, cost: 1, pricing_type: 'cache_read_tokens', interval: oct } ] } ] };
      const parsed = parseDeepInfraUsage(usage);
      const realFetch = window.fetch;
      const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      let calls = [], usageMode = 'ok', meMode = 'ok';
      window.fetch = async (url, init) => {
        const u = new URL(String(url)); const auth = init && init.headers && init.headers.Authorization;
        calls.push({ path: u.pathname, from: u.searchParams.get('from'), to: u.searchParams.get('to'), auth: auth || null, signal: !!(init && init.signal) });
        if (u.host !== 'api.deepinfra.com') return json({ error: 'wrong host' }, 404);
        if (u.pathname === '/v1/me') return meMode === '401' ? json({ detail: 'Invalid token' }, 401) : json({ uid: 'u1', email: 'dev@example.com', display_name: 'Alaa', is_team_account: false });
        if (u.pathname === '/payment/usage') return usageMode === 'ok' ? json(usage) : usageMode === '403' ? json({ detail: 'Not authenticated' }, 403) : json({ error: { message: 'upstream down' } }, 503);
        return json({}, 404);
      };
      const direct = await fetchDeepInfra('di-test', {}, { days: 90 });
      const month = (ms) => dayKeyUTC(ms).slice(0, 7);
      const d1 = { label: direct.label, detail: direct.detail, rows: direct.rows.length, billed: direct.billed, meta: direct.meta, calls: calls.map(x => x.path), params: calls.find(x => x.path === '/payment/usage'),
        expFrom: month(Date.now() - 90 * 864e5), expTo: month(Date.now()), auth: calls.every(x => x.auth === 'Bearer di-test'), signals: calls.every(x => x.signal) };
      // gated: 403 on /payment/usage → validate-only, not an error; 503 → surfaced, rows null, billed null (stale); 401 on /v1/me → the card's error
      usageMode = '403'; const refused = await fetchDeepInfra('di-test', {}, { days: 90 });
      usageMode = '503'; const failed = await fetchDeepInfra('di-test', {}, { days: 90 });
      usageMode = 'ok'; meMode = '401'; const rejected = await fetchDeepInfra('di-bad', {}, { days: 90 }).then(() => 'resolved', e => e.message);
      meMode = 'ok';
      // key driver: rows + billed + meta.granularity under deepinfra; then the refused key through the driver keeps the card connected as validate-only with no rows
      document.getElementById('deepinfra-key').value = 'di-test'; const rem = document.getElementById('remember-deepinfra'); if (rem) rem.checked = false;
      await App.connectKey(c);
      const st = Store.connectors.deepinfra || {}; const rows = (Store.sources.deepinfra || {}).rows || [];
      App.renderHub();
      const hub = document.querySelector('#accounts-hub .acct[data-connector="deepinfra"]');
      const driver = { status: Store.connectorStatus(c), label: st.label || null, err: st.err || null, text: document.getElementById('deepinfra-status').textContent, n: rows.length,
        in: rows.reduce((a, r) => a + r.in, 0), out: rows.reduce((a, r) => a + r.out, 0), cr: rows.reduce((a, r) => a + r.cr, 0), est: rows.some(r => r.est), platforms: [...new Set(rows.map(r => r.platform))],
        granularity: (Store.sources.deepinfra || {}).meta && Store.sources.deepinfra.meta.granularity, billedTotal: Math.round(Store.billedRows('deepinfra').reduce((a, b) => a + b.amount, 0) * 100) / 100, group: hub && hub.closest('.hub-group').dataset.group };
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; usageMode = '403';
      await App.connectKey(c);
      const gated = { status: Store.connectorStatus(c), label: (Store.connectors.deepinfra || {}).label || null, err: (Store.connectors.deepinfra || {}).err || null, text: document.getElementById('deepinfra-status').textContent, src: !!Store.sources.deepinfra, billed: Store.billed.deepinfra === undefined };
      usageMode = 'ok'; meMode = '401'; if (rem) rem.checked = true;
      await App.connectKey(c);
      const bad = { status: Store.connectorStatus(c), err: (Store.connectors.deepinfra || {}).err, key: LS.get('key:deepinfra', null), text: document.getElementById('deepinfra-status').textContent };
      window.fetch = realFetch;
      if (rem) rem.checked = false; document.getElementById('deepinfra-key').value = ''; LS.del('key:deepinfra');
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.persist(); App._render();
      return { reg, parsed: { rows: parsed.rows.map(r => [r.d, r.model, r.in, r.cw, r.cr, r.out, r.msgs, r.est]).sort(), billed: parsed.billed, meta: parsed.meta }, d1, refused, failed, rejected, driver, gated, bad };
    });
    ok('deepinfra (B3): registry entry — api-key · API vendors · exact badge · platform DeepInfra · copy opens "Exact (gated)", names the 401/403 downgrade to validate-only, cents and the first-day booking',
      !di.missing && di.reg.kind === 'api-key' && di.reg.cat === 'api' && di.reg.quality === 'exact' && di.reg.badge === 'exact' && di.reg.platform === 'DeepInfra' && di.reg.note, JSON.stringify(di.reg || di));
    ok('deepinfra (B3): parseDeepInfraUsage — month items booked on the month\'s 1st (Llama 1,000,000 in / 200,000 out on 2026-09-01; Qwen cache_read 4,000 on 2026-10-01), a one-day interval on its own day (Qwen 50,000 / 10,000 on 2026-10-05), msgs 0, exact; image item counted as non-token (1), "abc" units rejected (1); billed = total_cost cents → 12.50 / 3.05 on the 1st; meta.granularity month, 2 months, 1 open (NOT_FINAL)',
      !di.missing && JSON.stringify(di.parsed.rows) === JSON.stringify([['2026-09-01', 'meta-llama/Llama-3.3-70B-Instruct', 1000000, 0, 0, 200000, 0, 0], ['2026-10-01', 'Qwen/Qwen3-235B-A22B', 0, 0, 4000, 0, 0, 0], ['2026-10-05', 'Qwen/Qwen3-235B-A22B', 50000, 0, 0, 10000, 0, 0]])
      && JSON.stringify(di.parsed.billed) === JSON.stringify([{ d: '2026-09-01', amount: 12.5 }, { d: '2026-10-01', amount: 3.05 }])
      && di.parsed.meta.granularity === 'month' && di.parsed.meta.months === 2 && di.parsed.meta.open === 1 && di.parsed.meta.nonToken === 1 && di.parsed.meta.rejected === 1 && di.parsed.meta.items === 7, JSON.stringify(di.parsed));
    ok('deepinfra (B3): fetcher — GET /v1/me then GET /payment/usage?from=<month of today−90d>&to=<this month> with Bearer + timeout signal; label names the account and $15.55 over 2 months; detail says monthly granularity; rows 3, billed 2 days, meta.granularity month',
      !di.missing && JSON.stringify(di.d1.calls) === JSON.stringify(['/v1/me', '/payment/usage']) && di.d1.params.from === di.d1.expFrom && di.d1.params.to === di.d1.expTo && di.d1.auth && di.d1.signals
      && /^DeepInfra · Alaa · \$15\.55 over 2 months$/.test(di.d1.label) && /monthly granularity/i.test(di.d1.detail) && di.d1.rows === 3 && di.d1.billed.length === 2 && di.d1.meta.granularity === 'month' && di.d1.meta.days === 90, JSON.stringify(di.d1));
    ok('deepinfra (B3): gate — 403 on /payment/usage → validate-only label, the reason (HTTP 403 — Not authenticated) in the detail, rows null, no billed path, meta.gated refused (not an error); 503 → surfaced in the detail, rows null, billed null; 401 on /v1/me → "HTTP 401" error',
      !di.missing && /validate-only/.test(di.refused.label) && /HTTP 403/.test(di.refused.detail) && /Not authenticated/.test(di.refused.detail) && /validate-only/.test(di.refused.detail) && di.refused.rows === null && di.refused.billed === undefined && di.refused.meta.gated === 'refused'
      && /validate-only/.test(di.failed.label) && /HTTP 503/.test(di.failed.detail) && /upstream down/.test(di.failed.detail) && di.failed.rows === null && di.failed.billed === null && di.failed.meta.gated === 'failed'
      && /HTTP 401/.test(di.rejected), JSON.stringify({ refused: di.refused, failed: di.failed, rejected: di.rejected }));
    ok('deepinfra (B3): key driver — rows (in 1,050,000 / out 210,000 / cr 4,000, platform DeepInfra, exact) + billed $15.55 + meta.granularity month stored under deepinfra, hub group API vendors, status line says monthly granularity; refused key → still connected (ok) as validate-only with the reason, no rows and no billed envelope; 401 → warn + HTTP 401, key not remembered',
      !di.missing && di.driver.status === 'ok' && di.driver.err === null && /\$15\.55/.test(di.driver.label) && /Connected/.test(di.driver.text) && /monthly granularity/i.test(di.driver.text) && di.driver.n === 3 && di.driver.in === 1050000 && di.driver.out === 210000 && di.driver.cr === 4000 && !di.driver.est
      && di.driver.platforms.length === 1 && di.driver.platforms[0] === 'DeepInfra' && di.driver.granularity === 'month' && di.driver.billedTotal === 15.55 && di.driver.group === 'api'
      && di.gated.status === 'ok' && di.gated.err === null && /validate-only/.test(di.gated.label) && /HTTP 403/.test(di.gated.text) && /Connected/.test(di.gated.text) && !di.gated.src && di.gated.billed
      && di.bad.status === 'warn' && /HTTP 401/.test(di.bad.err) && di.bad.key === null && /Validation failed/.test(di.bad.text), JSON.stringify({ driver: di.driver, gated: di.gated, bad: di.bad }));

    // ---- Plan 9 B3: Moonshot / Kimi (balance), Cerebras, Nebius (+ legacy host), Meta Model API (validate), Novita (/v3/user balance) through the key driver ----
    const b3 = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      const ids = ['moonshot', 'cerebras', 'nebius', 'meta-api', 'novita'];
      const missing = ids.filter(id => !connectorById(id) || !document.getElementById(id + '-key') || typeof globalThis[connectorById(id).fetch] !== 'function');
      if (missing.length) return { missing };
      const realFetch = window.fetch;
      const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      const cases = [
        { id: 'moonshot', key: 'sk-moon', url: 'https://api.moonshot.ai/v1/users/me/balance', body: { code: 0, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 }, scode: '0x0', status: true } },
        { id: 'cerebras', key: 'csk-test', url: 'https://api.cerebras.ai/v1/models', body: { object: 'list', data: [{ id: 'llama3.1-8b', object: 'model', owned_by: 'Meta' }, { id: 'llama-3.3-70b' }, { id: 'qwen-3-235b-a22b-instruct-2507' }] } },
        { id: 'nebius', key: 'nb-test', url: 'https://api.tokenfactory.nebius.com/v1/models', body: { object: 'list', data: [{ id: 'meta-llama/Llama-3.3-70B-Instruct' }, { id: 'Qwen/Qwen3-235B-A22B' }] } },
        { id: 'meta-api', key: 'LLM|12345|abc', url: 'https://api.meta.ai/v1/models', body: { data: [{ id: 'Llama-4-Maverick-17B-128E-Instruct-FP8' }, { id: 'Llama-4-Scout-17B-16E-Instruct-FP8' }, { id: 'Llama-3.3-70B-Instruct' }, { id: 'Llama-3.3-8B-Instruct' }] } },
        { id: 'novita', key: 'nv-test', url: 'https://api.novita.ai/v3/user', body: { credit_balance: 123456 } },
      ];
      const out = {};
      let calls = [];
      const route = (k) => async (url, init) => {
        const u = String(url), auth = init && init.headers && (init.headers.Authorization || init.headers.authorization);
        calls.push({ u, auth: auth || null, signal: !!(init && init.signal) });
        return u === k.url && auth === 'Bearer ' + k.key ? json(k.body) : json({ error: { message: 'unexpected ' + u } }, u === k.url ? 401 : 404);
      };
      for (const k of cases) {
        const c = connectorById(k.id); calls = []; window.fetch = route(k);
        document.getElementById(k.id + '-key').value = k.key; const rem = document.getElementById('remember-' + k.id); if (rem) rem.checked = false;
        await App.connectKey(c);
        const st = Store.connectors[k.id] || {};
        out[k.id] = { label: st.label || null, err: st.err || null, status: Store.connectorStatus(c), text: document.getElementById(k.id + '-status').textContent, calls, rows: !!Store.sources[k.id], billed: Store.billedRows(k.id).length, key: LS.get('key:' + k.id, null) };
      }
      // honest refusals: Moonshot HTTP 200 with status false; Novita 403 (its "bogus key" answer); Meta 401 { error: { code, type } } → type in the message; Cerebras 401 through the driver with Remember → not remembered
      window.fetch = async () => json({ code: 401, status: false, scode: '0x0001', message: 'auth failed' });
      const moonshotRefused = await fetchMoonshot('sk-bad').then(() => 'resolved', e => e.message);
      window.fetch = async () => json({ message: 'forbidden' }, 403);
      const novitaRefused = await fetchNovita('nv-bad').then(() => 'resolved', e => e.message);
      window.fetch = async () => json({ error: { code: 'invalid_api_key', type: 'authentication_error' } }, 401);
      const metaRefused = await fetchMetaModelApi('bad').then(() => 'resolved', e => e.message);
      window.fetch = async () => json({ error: { message: 'Wrong API Key' } }, 401);
      document.getElementById('cerebras-key').value = 'csk-bad'; const remC = document.getElementById('remember-cerebras'); if (remC) remC.checked = true;
      await App.connectKey(connectorById('cerebras'));
      const cerebrasBad = { status: Store.connectorStatus(connectorById('cerebras')), err: (Store.connectors.cerebras || {}).err, key: LS.get('key:cerebras', null), text: document.getElementById('cerebras-status').textContent };
      if (remC) remC.checked = false;
      // Nebius legacy host: the Token Factory host fails with 503 → api.studio.nebius.com is tried and named; a 401 on the primary host is final (no legacy call); both failing → one message naming both
      const nebiusModels = { data: [{ id: 'meta-llama/Llama-3.3-70B-Instruct' }] };
      calls = []; window.fetch = async (url, init) => { const u = String(url); calls.push({ u }); return u.startsWith('https://api.studio.nebius.com/') ? json(nebiusModels) : json({ error: { message: 'maintenance' } }, 503); };
      const nebiusLegacy = await fetchNebius('nb-test').then(r => ({ ok: true, label: r.label, detail: r.detail, calls: calls.map(x => x.u) }), e => ({ ok: false, err: e.message }));
      calls = []; window.fetch = async (url) => { calls.push({ u: String(url) }); return json({ error: { message: 'Unauthorized' } }, 401); };
      const nebius401 = await fetchNebius('nb-bad').then(() => 'resolved', e => ({ err: e.message, calls: calls.length }));
      window.fetch = async (url) => json({ error: { message: String(url).includes('studio') ? 'legacy down' : 'primary down' } }, 503);
      const nebiusBoth = await fetchNebius('nb-test').then(() => 'resolved', e => e.message);
      // Novita without the balance field: still a validated key, said so
      window.fetch = async () => json({ uid: 'x' });
      const novitaNoBalance = await fetchNovita('nv-test');
      window.fetch = realFetch;
      for (const id of ids) { document.getElementById(id + '-key').value = ''; LS.del('key:' + id); }
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.persist(); App._render();
      return { out, moonshotRefused, novitaRefused, metaRefused, cerebrasBad, nebiusLegacy, nebius401, nebiusBoth, novitaNoBalance };
    });
    const b3ok = (id) => !b3.missing && b3.out[id].status === 'ok' && b3.out[id].err === null && /Connected/.test(b3.out[id].text) && !b3.out[id].rows && b3.out[id].billed === 0 && b3.out[id].key === null && b3.out[id].calls.length === 1 && b3.out[id].calls[0].signal;
    ok('B3 validate cards: Moonshot — GET api.moonshot.ai/v1/users/me/balance (Bearer) → label "Moonshot · balance $49.59 available", detail names cash / voucher and says no per-day usage; Cerebras — GET api.cerebras.ai/v1/models → "3 models", detail points at the Analytics CSV Download Report; no rows, no billed, nothing remembered',
      b3ok('moonshot') && b3.out.moonshot.label === 'Moonshot · balance $49.59 available' && /cash \$3\.00/.test(b3.out.moonshot.text) && /voucher \$46\.59/.test(b3.out.moonshot.text) && /no per-day usage/i.test(b3.out.moonshot.text) && b3.out.moonshot.calls[0].u === 'https://api.moonshot.ai/v1/users/me/balance' && b3.out.moonshot.calls[0].auth === 'Bearer sk-moon'
      && b3ok('cerebras') && b3.out.cerebras.label === '3 models' && /Download Report/.test(b3.out.cerebras.text) && /Imports/.test(b3.out.cerebras.text) && b3.out.cerebras.calls[0].u === 'https://api.cerebras.ai/v1/models' && b3.out.cerebras.calls[0].auth === 'Bearer csk-test',
      JSON.stringify({ moonshot: b3.out && b3.out.moonshot, cerebras: b3.out && b3.out.cerebras, missing: b3.missing }));
    ok('B3 validate cards: Nebius — GET api.tokenfactory.nebius.com/v1/models → "2 models", detail says console-only; Meta Model API — GET api.meta.ai/v1/models → "4 models", detail says dashboard-only; Novita — GET api.novita.ai/v3/user → "Novita · balance $12.35" (credit_balance ÷ 10000), detail names the collector proxy for billing',
      b3ok('nebius') && b3.out.nebius.label === '2 models' && /console/i.test(b3.out.nebius.text) && b3.out.nebius.calls[0].u === 'https://api.tokenfactory.nebius.com/v1/models' && b3.out.nebius.calls[0].auth === 'Bearer nb-test'
      && b3ok('meta-api') && b3.out['meta-api'].label === '4 models' && /dashboard/i.test(b3.out['meta-api'].text) && b3.out['meta-api'].calls[0].u === 'https://api.meta.ai/v1/models' && b3.out['meta-api'].calls[0].auth === 'Bearer LLM|12345|abc'
      && b3ok('novita') && b3.out.novita.label === 'Novita · balance $12.35' && /collector/i.test(b3.out.novita.text) && b3.out.novita.calls[0].u === 'https://api.novita.ai/v3/user' && b3.out.novita.calls[0].auth === 'Bearer nv-test',
      JSON.stringify({ nebius: b3.out && b3.out.nebius, meta: b3.out && b3.out['meta-api'], novita: b3.out && b3.out.novita, missing: b3.missing }));
    ok('B3 refusals: Moonshot HTTP 200 with status false → error naming code 401 / scode / message; Novita 403 → "HTTP 403"; Meta 401 → "HTTP 401 — authentication_error"; Cerebras 401 through the driver → warn + "Wrong API Key", key not remembered despite Remember; Novita without credit_balance → "key accepted" label',
      !b3.missing && /code 401/.test(b3.moonshotRefused) && /0x0001/.test(b3.moonshotRefused) && /auth failed/.test(b3.moonshotRefused) && /HTTP 403/.test(b3.novitaRefused) && /HTTP 401 — authentication_error/.test(b3.metaRefused)
      && b3.cerebrasBad.status === 'warn' && /HTTP 401/.test(b3.cerebrasBad.err) && /Wrong API Key/.test(b3.cerebrasBad.err) && b3.cerebrasBad.key === null && /Validation failed/.test(b3.cerebrasBad.text)
      && b3.novitaNoBalance.label === 'Novita · key accepted' && /no credit_balance/.test(b3.novitaNoBalance.detail), JSON.stringify({ m: b3.moonshotRefused, n: b3.novitaRefused, me: b3.metaRefused, c: b3.cerebrasBad, nb: b3.novitaNoBalance }));
    ok('B3 Nebius hosts: primary 503 → legacy api.studio.nebius.com tried (2 calls) and named in the label ("1 models · legacy host"); primary 401 → final, no legacy call; both failing → one error naming both hosts',
      !b3.missing && b3.nebiusLegacy.ok && b3.nebiusLegacy.label === '1 models · legacy host' && /api\.studio\.nebius\.com/.test(b3.nebiusLegacy.detail) && JSON.stringify(b3.nebiusLegacy.calls) === JSON.stringify(['https://api.tokenfactory.nebius.com/v1/models', 'https://api.studio.nebius.com/v1/models'])
      && /HTTP 401/.test(b3.nebius401.err) && b3.nebius401.calls === 1 && /primary down/.test(b3.nebiusBoth) && /legacy down/.test(b3.nebiusBoth) && /api\.studio\.nebius\.com/.test(b3.nebiusBoth), JSON.stringify({ legacy: b3.nebiusLegacy, r401: b3.nebius401, both: b3.nebiusBoth }));
  } finally {
    await page.close();
  }
}
