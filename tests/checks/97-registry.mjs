import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const reg = await page.evaluate(() => ({
      isArray: Array.isArray(CONNECTORS),
      ids: CONNECTORS.map(c => c.id),
      platforms: CONNECTORS.map(c => c.platform).filter(Boolean),
      order: PLATFORM_ORDER,
      everyHasCard: CONNECTORS.every(c => !c.statusEl || !!document.getElementById(c.statusEl)),
    }));
    ok('registry: CONNECTORS table exists with the 7 connectors',
      reg.isArray && ['local','anthropic','openai','gemini','copilot','openrouter','imports']
        .every(id => reg.ids.includes(id)), JSON.stringify(reg.ids));
    ok('registry: PLATFORM_ORDER is derived from the registry',
      reg.platforms.every(p => reg.order.includes(p)) && reg.order[reg.order.length - 1] === 'Other',
      JSON.stringify(reg.order));
    ok('registry: every connector statusEl resolves to a live element', reg.everyHasCard, '');

    // 4b T1: link-only entries — honest cards with no data path (reason + vendor links; quality none; never connected)
    const lo = await page.evaluate(() => {
      const L = CONNECTORS.filter(c => c.kind === 'link-only');
      return { ids: L.map(c => c.id), platforms: L.map(c => c.platform),
        every: L.every(c => c.quality === 'none' && typeof c.reason === 'string' && c.reason.length > 20 && !!(c.links && c.links.usage)
          && Array.isArray(c.srcIds) && c.srcIds.length === 0 && c.statusEl === c.id + '-status' && !!document.getElementById(c.statusEl)
          && /^no data/i.test(c.qualityNote || '') && !!c.category) };
    });
    ok('registry: link-only entries (amazonq, replicate, windsurf) carry quality none, a reason, a vendor usage link, no srcIds, "No data" copy first, and a live status element',
      ['amazonq', 'replicate', 'windsurf'].every(id => lo.ids.includes(id)) && lo.every &&
      ['Amazon Q / Kiro', 'Replicate', 'Windsurf'].every(p => lo.platforms.includes(p)), JSON.stringify(lo));
    // subtitle + clear-data must iterate the registry, not hardcoded lists
    const wiring = await page.evaluate(() => {
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      Store.setSource('openrouter', [{ d: '2026-08-10', platform: 'OpenRouter', model: 'deepseek-v4', in: 5, cw: 0, cr: 0, out: 5, msgs: 1 }], {});
      App.renderSubtitle();
      const sub = document.getElementById('last-updated').textContent;
      return { sub };
    });
    ok('registry: subtitle names a NEW platform without hand-edits', /OpenRouter/.test(wiring.sub), wiring.sub);

    // refreshAll must fire every key-bearing connector's registered fetcher (globalThis[c.fetch]), including
    // the fetchOpenAIAll (capital AI) casing that name-derivation from the id would miss.
    const refresh = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      let anthropicCalls = 0, openaiCalls = 0;
      window.fetchAnthropicAll = async () => { anthropicCalls++; return { rows: [], billed: [] }; };
      window.fetchOpenAIAll = async () => { openaiCalls++; return { rows: [], billed: [] }; };
      LS.set('key:anthropic', 'k');
      LS.set('key:openai', 'k');
      document.getElementById('anthropic-key').value = 'k';
      document.getElementById('openai-key').value = 'k';
      await App.refreshAll();
      return { anthropicCalls, openaiCalls };
    });
    ok('registry: refreshAll fires every key-bearing connector (incl. fetchOpenAI casing)',
      refresh.anthropicCalls === 1 && refresh.openaiCalls === 1, JSON.stringify(refresh));

    // Plan 9 A0b (review #27): the five former legacy cards are ordinary fetch:-contract entries — the same registry shape as every other key card;
    // the fetchMethod dispatch, the five App.fetchX drivers and App._landLegacyRows are gone
    const a0b = await page.evaluate(() => {
      const ids = ['anthropic', 'openai', 'gemini', 'copilot', 'openrouter'];
      const shape = ids.map(id => { const c = connectorById(id) || {}; return { id,
        fetch: typeof c.fetch === 'string' && typeof globalThis[c.fetch] === 'function', noFetchMethod: !('fetchMethod' in c),
        keyLS: c.keyLS === 'key:' + id, keyLabel: typeof c.keyLabel === 'string' && c.keyLabel.length > 0,
        statusEl: c.statusEl === id + '-status' && !!document.getElementById(c.statusEl), srcIds: JSON.stringify(c.srcIds) === JSON.stringify([id]) }; });
      return { shape, every: shape.every(s => Object.entries(s).every(([k, v]) => k === 'id' || v === true)),
        gone: ['fetchMethod', '_landLegacyRows', 'fetchAnthropic', 'fetchOpenAI', 'fetchGemini', 'fetchCopilot', 'fetchOpenrouter'].filter(k => typeof App[k] !== 'undefined'),
        anyFetchMethod: CONNECTORS.filter(c => 'fetchMethod' in c).map(c => c.id) };
    });
    ok('registry (A0b #27): anthropic / openai / gemini / copilot / openrouter are fetch:-contract entries (fetch names a global function, keyLS key:<id>, keyLabel, statusEl <id>-status, srcIds [id]); no entry carries fetchMethod',
      a0b.every && a0b.anyFetchMethod.length === 0, JSON.stringify({ shape: a0b.shape, anyFetchMethod: a0b.anyFetchMethod }));
    ok('registry (A0b #27): App.fetchMethod, App._landLegacyRows and the five App.fetchX drivers no longer exist', a0b.gone.length === 0, JSON.stringify(a0b.gone));

    const compacted = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      const rows = [];
      for (let i = 0; i < 12; i++) rows.push({ d: '2025-01-05', platform: 'Claude Code/Desktop', model: 'claude-sonnet-5', in: 10, cw: 0, cr: 0, out: 5, msgs: 1, sid: 'sess-' + i });
      rows.push({ d: dayKey(new Date()), platform: 'Claude Code/Desktop', model: 'claude-sonnet-5', in: 1, cw: 0, cr: 0, out: 1, msgs: 1, sid: 'sess-new' });
      Store.setSource('local', rows, {});
      const local = Store.sources.local.rows;
      const old = local.filter(r => r.d === '2025-01-05');
      const recent = local.filter(r => r.sid === 'sess-new');
      const t = old.reduce((a, r) => ({ in: a.in + r.in, msgs: a.msgs + r.msgs }), { in: 0, msgs: 0 });
      return { oldCount: old.length, oldHasSid: old.some(r => r.sid), recentHasSid: recent.length === 1 && !!recent[0].sid, in: t.in, msgs: t.msgs };
    });
    ok('compaction: rows older than 90d merge across sessions, totals exact',
      compacted.oldCount === 1 && !compacted.oldHasSid && compacted.in === 120 && compacted.msgs === 12,
      JSON.stringify(compacted));
    ok('compaction: recent rows keep their sid (dedupe still works)', compacted.recentHasSid, JSON.stringify(compacted));
    // ---- Plan 4b: Wave 2 price rows (first matching pattern wins — fast/mini and reasoner rows precede their family rows) ----
    const pr = await page.evaluate(() => {
      Pricing.load();   // fresh page → DEFAULT_PRICES (harness cleared aiusage:*)
      const L = (m) => Pricing.resolve(m).label;
      const M = { in: 1e6, out: 1e6, cw: 0, cr: 1e6 };   // 1M of each billed field
      return {
        grok4: L('grok-4-0709'), grok: L('grok'), grokMini: L('grok-3-mini'), grokFast: L('grok-4-fast-non-reasoning'),
        dsReason: L('deepseek-reasoner'), dsR1: L('deepseek-r1-distill-llama'), dsChat: L('deepseek-chat'), dsOr: L('deepseek/deepseek-v4'),
        sonar: L('sonar-pro'), pplx: L('perplexity'), meta: L('meta-ai'), copilot: L('copilot'), chatgpt: L('auto'), gpt4o: L('chatgpt-4o-latest'), unknown: L('zzz-never-heard-of-it'),
        // costs: grok-4 → retired alias of grok-4.3 (Plan 9, verified 2026-10-15) = 1.25 + 2.5 + 0.2 = 3.95 · DeepSeek chat = 0.27 + 1.10 + 0.07 = 1.44 · Meta AI = 0 · Sonar = 1 + 1 + 0 = 2
        grokCost: Pricing.cost('grok-4', M), dsCost: Pricing.cost('deepseek-chat', M), metaCost: Pricing.cost('meta-ai', M), sonarCost: Pricing.cost('sonar', M),
        lastIsFallback: DEFAULT_PRICES[DEFAULT_PRICES.length - 1].pat === '.*',
      };
    });
    // Plan 9 (verified rows, 2026-10-15): grok-4 / grok-4-0709 / grok-4-fast-* are retired aliases of grok-4.3 ($1.25/$2.50, cr 0.20); grok-3-mini and sonar-pro have their own rows.
    ok('pricing (4b, Plan 9 rows): Grok 4 → grok-4.3 alias / Grok 3 Mini / DeepSeek Reasoner / DeepSeek chat / Sonar Pro + Perplexity Sonar / Meta AI rows resolve (first-match order right; ^copilot$ joins the ChatGPT row; fallback still last)',
      pr.grok4 === 'Grok 4.3' && pr.grok === 'Grok 4 (xAI list)' && pr.grokMini === 'Grok 3 Mini' && pr.grokFast === 'Grok 4.3'
      && pr.dsReason === 'DeepSeek Reasoner' && pr.dsR1 === 'DeepSeek Reasoner' && pr.dsChat === 'DeepSeek chat (V3 list)' && pr.dsOr === 'DeepSeek chat (V3 list)'
      && pr.sonar === 'Sonar Pro' && pr.pplx === 'Perplexity Sonar' && pr.meta === 'Meta AI (consumer, no API price)' && /ChatGPT/.test(pr.copilot) && pr.copilot === pr.chatgpt && pr.gpt4o === 'GPT-4o' && pr.unknown === 'Unknown model'
      && Math.abs(pr.grokCost - 3.95) < 1e-9 && Math.abs(pr.dsCost - 1.44) < 1e-9 && pr.metaCost === 0 && Math.abs(pr.sonarCost - 2) < 1e-9 && pr.lastIsFallback, JSON.stringify(pr));

    // Bedrock / Vertex spellings of the same Anthropic models: 'anthropic.' + id + '-v1:0' (Bedrock; us./eu./global. prefixes are the
    // cross-region inference profiles) and id + '@YYYYMMDD' (Vertex). The vendor tails hid the trailing date from normalizeModelId, so
    // Opus 4.1 fell through to 'Claude (other)' ($3/$15) instead of Opus 4 / 4.1 ($15/$75). Bedrock's DeepSeek-R1 is 'deepseek.r1-v1:0'.
    const vend = await page.evaluate(() => {
      const L = (m) => Pricing.resolve(m).label;
      const M = { in: 1e6, out: 1e6, cw: 0, cr: 1e6 };
      return {
        br41: L('anthropic.claude-opus-4-1-20250805-v1:0'), brUs4: L('us.anthropic.claude-opus-4-20250514-v1:0'), vx41: L('claude-opus-4-1@20250805'),
        brGlobal45: L('global.anthropic.claude-opus-4-5-20251101-v1:0'), brEuSonnet: L('eu.anthropic.claude-sonnet-4-5-20250929-v1:0'), vxHaiku: L('claude-haiku-4-5@20251001'),
        cc41: L('claude-opus-4-1-20250805'), bare4: L('claude-opus-4'), dsR1: L('deepseek.r1-v1:0'),
        // Opus 4 / 4.1 at 1M in + 1M out + 1M cache-read = 15 + 75 + 1.5 = 91.5
        br41Cost: Pricing.cost('anthropic.claude-opus-4-1-20250805-v1:0', M),
        norm: [normalizeModelId('anthropic.claude-opus-4-1-20250805-v1:0'), normalizeModelId('us.anthropic.claude-opus-4-20250514-v1:0'), normalizeModelId('claude-opus-4-1@20250805')],
      };
    });
    ok('pricing: Bedrock/Vertex ids price like the bare Anthropic id — anthropic.claude-opus-4-1-…-v1:0 / us.anthropic.claude-opus-4-…-v1:0 / claude-opus-4-1@20250805 → Opus 4 / 4.1 ($15/$75 = 91.5 at 1M each); global./eu. profiles and Vertex Haiku hit their rows; deepseek.r1-v1:0 → Reasoner',
      vend.br41 === 'Claude Opus 4 / 4.1' && vend.brUs4 === 'Claude Opus 4 / 4.1' && vend.vx41 === 'Claude Opus 4 / 4.1' && vend.cc41 === 'Claude Opus 4 / 4.1' && vend.bare4 === 'Claude Opus 4 / 4.1'
      && vend.brGlobal45 === 'Claude Opus 5 / 4.5+' && vend.brEuSonnet === 'Claude Sonnet 4.x / 3.x' && vend.vxHaiku === 'Claude Haiku 4.5' && vend.dsR1 === 'DeepSeek Reasoner'
      && Math.abs(vend.br41Cost - 91.5) < 1e-9 && JSON.stringify(vend.norm) === JSON.stringify(['claude-opus-4-1', 'claude-opus-4', 'claude-opus-4-1']), JSON.stringify(vend));

    // ---- Plan 4b: registry invariants for EVERY Wave 2 entry (everything that is not a Wave 1 id) ----
    const WAVE1_IDS = ['local', 'anthropic', 'openai', 'gemini', 'copilot', 'openrouter', 'codex', 'gemini-cli', 'copilot-cli', 'continue', 'cline', 'roo', 'aider', 'junie', 'lmstudio', 'ollama', 'imports'];
    const WAVE2_PLATFORMS = ['LocalAI', 'vLLM', 'llama.cpp', 'GPT4All', 'Jan', 'text-generation-webui',
      'Fireworks AI', 'DeepSeek API', 'Mistral', 'Cohere', 'Together AI', 'Groq', 'Hugging Face', 'xAI API', 'Perplexity API', 'Replicate',
      'Azure OpenAI', 'Google Vertex AI', 'AWS Bedrock',
      'Claude Enterprise (org)', 'ChatGPT', 'Claude.ai', 'Grok', 'Microsoft Copilot', 'Perplexity', 'Meta AI', 'DeepSeek chat',
      'Amazon Q / Kiro', 'Windsurf'];
    const LOCAL_W2 = ['LocalAI', 'vLLM', 'llama.cpp', 'GPT4All', 'Jan', 'text-generation-webui'];
    const inv = await page.evaluate((wave1, wave2, localW2) => {
      const groups = HUB_GROUPS.map(g => g.id);
      const imports = connectorById('imports');
      const w2 = CONNECTORS.filter(c => !wave1.includes(c.id));
      const DATA_KINDS = ['folder-log', 'local-server', 'api-key', 'admin-key', 'cloud-token'];
      const problems = [];
      const ids = CONNECTORS.map(c => c.id);
      if (new Set(ids).size !== ids.length) problems.push('duplicate id: ' + ids.filter((x, i) => ids.indexOf(x) !== i).join(','));
      const plats = CONNECTORS.map(c => c.platform).filter(Boolean);
      const dupPlat = plats.filter((p, i) => plats.indexOf(p) !== i && p !== 'GitHub Copilot');
      if (dupPlat.length) problems.push('duplicate platform: ' + dupPlat.join(','));
      for (const p of wave2) if (!plats.includes(p)) problems.push('missing platform: ' + p);
      for (const c of w2) {
        const pre = c.id + ': ';
        if (!['exact', 'estimated', 'validate', 'none'].includes(c.quality)) problems.push(pre + 'quality=' + c.quality);
        if (!(typeof c.qualityNote === 'string' && c.qualityNote.length >= 80)) problems.push(pre + 'qualityNote < 80 chars');
        if (!(c.links && (c.links.get || c.links.docs))) problems.push(pre + 'no links.get/docs');
        if (!groups.includes(c.category)) problems.push(pre + 'category=' + c.category);
        if (c.statusEl !== c.id + '-status') problems.push(pre + 'statusEl=' + c.statusEl);
        if (!document.getElementById(c.statusEl)) problems.push(pre + 'statusEl not in DOM');
        if (DATA_KINDS.includes(c.kind) && !(Array.isArray(c.srcIds) && c.srcIds.includes(c.id))) problems.push(pre + 'srcIds lacks own id');
        if (c.kind === 'export-file' && !(Array.isArray(c.srcIds) && c.srcIds.length && c.srcIds.every(s => imports.srcIds.includes(s)))) problems.push(pre + 'export-file srcIds not a subset of imports.srcIds');
        if (c.kind === 'link-only' && !(typeof c.reason === 'string' && c.reason.length > 20)) problems.push(pre + 'link-only without reason');
        if (c.kind === 'link-only' && c.quality !== 'none') problems.push(pre + 'link-only quality must be none');
        if (c.kind === 'cloud-token' && c.sessionOnly !== true) problems.push(pre + 'cloud-token not sessionOnly');
        if (c.fetch && typeof globalThis[c.fetch] !== 'function') problems.push(pre + 'fetch fn missing: ' + c.fetch);
        if (c.parser && typeof globalThis[c.parser] !== 'function') problems.push(pre + 'parser fn missing: ' + c.parser);
        if (c.validate && typeof globalThis[c.validate] !== 'function') problems.push(pre + 'validate fn missing: ' + c.validate);
        if (c.poll && typeof globalThis[c.poll] !== 'function') problems.push(pre + 'poll fn missing: ' + c.poll);
        if (!c.platform && c.kind !== 'collector') problems.push(pre + 'no platform');   // v7: the collector owns no rows — platform null by design (its tools land under their own connectors)
        if (!c.brand || !c.mark || !c.name) problems.push(pre + 'brand/mark/name missing');
        try { Store.connectorStatus(c); } catch (e) { problems.push(pre + 'connectorStatus threw'); }
      }
      for (const s of ['grok-export', 'deepseek-chat-export', 'meta-ai-export', 'perplexity-export', 'copilot-activity-csv']) if (!imports.srcIds.includes(s)) problems.push('imports.srcIds lacks ' + s);
      for (const p of localW2) if (Pricing.cost('any-model', { platform: p, in: 1e6, out: 1e6, cw: 0, cr: 0 }) !== 0) problems.push('local platform not $0: ' + p);
      const byGroup = Object.fromEntries(groups.map(g => [g, CONNECTORS.filter(c => c.category === g).length]));
      return { n: CONNECTORS.length, w2: w2.length, problems, byGroup, orderHasAll: plats.every(p => PLATFORM_ORDER.includes(p)) };
    }, WAVE1_IDS, WAVE2_PLATFORMS, LOCAL_W2);
    ok('registry (4b): every Wave 2 entry satisfies the invariants — quality ∈ exact|estimated|validate|none, qualityNote ≥ 80 chars, links.get|docs, category ∈ HUB_GROUPS, statusEl = id+"-status" and in the DOM, data kinds list their own id in srcIds, export-file srcIds ⊂ imports.srcIds, link-only has reason + quality none, cloud-token sessionOnly, fetch/parser/validate/poll names resolve; ids unique; platforms unique except GitHub Copilot; all 29 Wave 2 platforms present; local runners $0',
      inv.problems.length === 0 && inv.w2 >= 29 && inv.n >= 46 && inv.orderHasAll, JSON.stringify(inv));
    ok('registry (4b): all five hub groups are non-empty', Object.values(inv.byGroup).every(n => n > 0), JSON.stringify(inv.byGroup));

    // ---- Plan 9 B2: generic OpenAI-compatible card + Poe — fetch:-contract key cards with the required shape and hub placement ----
    const b2 = await page.evaluate(() => {
      const oc = connectorById('openai-compatible') || {}, po = connectorById('poe') || {};
      return {
        oc: { kind: oc.kind, cat: oc.category, quality: oc.quality, keyOptional: oc.keyOptional === true, fetch: typeof globalThis[oc.fetch] === 'function', keyLS: oc.keyLS, srcIds: JSON.stringify(oc.srcIds), statusEl: oc.statusEl === 'openai-compatible-status' && !!document.getElementById(oc.statusEl),
          fields: JSON.stringify((oc.fields || []).map(f => [f.id, !!(f.secret || f.type === 'password')])), platform: oc.platform, sessionOnly: !!oc.sessionOnly, docs: !!(oc.links && oc.links.docs) },
        po: { kind: po.kind, cat: po.category, quality: po.quality, fetch: typeof globalThis[po.fetch] === 'function', keyLS: po.keyLS, srcIds: JSON.stringify(po.srcIds), statusEl: po.statusEl === 'poe-status' && !!document.getElementById(po.statusEl), platform: po.platform, noFields: !po.fields,
          get: !!(po.links && po.links.get && /poe\.com\/api\/keys/.test(po.links.get)), docs: !!(po.links && po.links.docs), parser: typeof globalThis.parsePoeCostBreakdown === 'function' },
        inOrder: PLATFORM_ORDER.includes('Poe') && PLATFORM_ORDER.includes(oc.platform || '') };
    });
    ok('registry (B2): openai-compatible is an api-key entry in API vendors — quality validate, one non-secret field "base", keyOptional, not sessionOnly, fetch fn registered, keyLS key:openai-compatible, srcIds [own id], statusEl in the DOM, docs link',
      b2.oc.kind === 'api-key' && b2.oc.cat === 'api' && b2.oc.quality === 'validate' && b2.oc.keyOptional && b2.oc.fetch && b2.oc.keyLS === 'key:openai-compatible' && b2.oc.srcIds === JSON.stringify(['openai-compatible']) && b2.oc.statusEl && b2.oc.fields === JSON.stringify([['base', false]]) && !!b2.oc.platform && !b2.oc.sessionOnly && b2.oc.docs, JSON.stringify(b2.oc));
    ok('registry (B2): poe is an api-key entry in Chat apps — quality exact, no extra fields, fetch fn + parsePoeCostBreakdown registered, keyLS key:poe, srcIds [poe], statusEl in the DOM, get link poe.com/api/keys + docs; both platforms in PLATFORM_ORDER',
      b2.po.kind === 'api-key' && b2.po.cat === 'chat' && b2.po.quality === 'exact' && b2.po.fetch && b2.po.parser && b2.po.keyLS === 'key:poe' && b2.po.srcIds === JSON.stringify(['poe']) && b2.po.statusEl && b2.po.platform === 'Poe' && b2.po.noFields && b2.po.get && b2.po.docs && b2.inOrder, JSON.stringify(b2));

    // ---- Plan 9 B3: API cards batch 1 — DeepInfra (gated usage), Moonshot / Kimi, Cerebras (+ usage CSV), Nebius, Meta Model API, Novita: fetch:-contract key cards in API vendors ----
    const b3 = await page.evaluate(() => {
      const want = { deepinfra: ['DeepInfra', 'exact', 'fetchDeepInfra'], moonshot: ['Moonshot API', 'validate', 'fetchMoonshot'], cerebras: ['Cerebras', 'validate', 'fetchCerebras'],
        nebius: ['Nebius Token Factory', 'validate', 'fetchNebius'], 'meta-api': ['Meta Model API', 'validate', 'fetchMetaModelApi'], novita: ['Novita AI', 'validate', 'fetchNovita'] };
      const bad = [];
      for (const [id, [platform, quality, fetchName]] of Object.entries(want)) {
        const c = connectorById(id);
        if (!c) { bad.push(id + ': missing'); continue; }
        if (c.platform !== platform) bad.push(id + ': platform ' + c.platform);
        if (c.kind !== 'api-key' || c.category !== 'api' || c.quality !== quality) bad.push(id + ': kind/category/quality');
        if (c.fetch !== fetchName || typeof globalThis[c.fetch] !== 'function') bad.push(id + ': fetch ' + c.fetch);
        if (c.keyLS !== 'key:' + id || !c.keyLabel || !c.keyHint) bad.push(id + ': key copy');
        if (c.statusEl !== id + '-status' || !document.getElementById(c.statusEl) || !document.getElementById('src-' + id)) bad.push(id + ': statusEl / card');
        if (!Array.isArray(c.srcIds) || c.srcIds[0] !== id) bad.push(id + ': srcIds');
        if (!c.links || !c.links.get || !c.links.usage || !c.links.docs) bad.push(id + ': links');
        if (!Array.isArray(c.paths) || !c.paths.length) bad.push(id + ': paths');
        if (c.fields || c.sessionOnly || c.keyOptional) bad.push(id + ': unexpected fields / sessionOnly / keyOptional');
        if (!(typeof c.qualityNote === 'string' && c.qualityNote.length >= 80)) bad.push(id + ': qualityNote');
      }
      const di = connectorById('deepinfra') || {}, ce = connectorById('cerebras') || {}, nv = connectorById('novita') || {};
      return { bad,
        diNote: /^exact \(gated\)/i.test(di.qualityNote || '') && /validate-only/i.test(di.qualityNote || '') && /month/i.test(di.qualityNote || '') && /not verified/i.test(di.qualityNote || ''),
        ceSrcIds: JSON.stringify(ce.srcIds), ceNote: /Download Report/.test(ce.qualityNote || '') && /"cerebras"/.test(ce.qualityNote || '') && /not verified/i.test(ce.qualityNote || ''),
        nvNote: /collector/i.test(nv.qualityNote || '') && /403/.test(nv.qualityNote || ''),
        honest: ['moonshot', 'cerebras', 'nebius', 'meta-api', 'novita'].every(id => /^validate-only/i.test((connectorById(id) || {}).qualityNote || '')),
        importsNoCerebras: !connectorById('imports').srcIds.includes('cerebras-usage-csv'),
        fns: typeof globalThis.isCerebrasUsageCSV === 'function' && typeof globalThis.parseCerebrasUsageCSV === 'function' && typeof globalThis.parseDeepInfraUsage === 'function',
        inOrder: Object.values(want).every(([p]) => PLATFORM_ORDER.includes(p)) };
    });
    ok('registry (B3): deepinfra / moonshot / cerebras / nebius / meta-api / novita are api-key entries in API vendors — platform, quality (exact only for DeepInfra), fetch fn registered, keyLS key:<id>, own srcId first, statusEl + card in the DOM, get/usage/docs links, paths, no fields / sessionOnly / keyOptional; all six platforms in PLATFORM_ORDER',
      b3.bad.length === 0 && b3.inOrder, JSON.stringify(b3));
    ok('registry (B3): honesty copy — DeepInfra opens "Exact (gated)" and names the validate-only downgrade, monthly granularity and "not verified"; the other five open "Validate-only"; Cerebras srcIds [cerebras, cerebras-usage-csv] (the CSV lands under the card, not under Imports) and its copy names Download Report + the "cerebras" name gate; Novita names the collector proxy and the 403; CSV sniff / parser + parseDeepInfraUsage exist',
      b3.diNote && b3.honest && b3.ceSrcIds === JSON.stringify(['cerebras', 'cerebras-usage-csv']) && b3.ceNote && b3.nvNote && b3.importsNoCerebras && b3.fns, JSON.stringify(b3));
    // ---- Plan 9 B4: Alibaba Model Studio / Z.ai / MiniMax (api-key, API vendors), the 16 link-only cards, the amazonq / mistral copy corrections, Lambda excluded ----
    const b4 = await page.evaluate(() => {
      const want = { 'alibaba-modelstudio': ['Alibaba Model Studio', 'fetchAlibabaModelStudio', ['alibaba-modelstudio', 'alibaba-bill-csv'], [['base', false]]], zai: ['Z.ai API', 'fetchZai', ['zai'], []], minimax: ['MiniMax', 'fetchMiniMax', ['minimax'], [['groupId', false], ['planKey', true]]] };
      const bad = [];
      for (const [id, [platform, fetchName, srcIds, fields]] of Object.entries(want)) {
        const c = connectorById(id);
        if (!c) { bad.push(id + ': missing'); continue; }
        if (c.platform !== platform || c.kind !== 'api-key' || c.category !== 'api' || c.quality !== 'validate') bad.push(id + ': platform/kind/category/quality');
        if (c.fetch !== fetchName || typeof globalThis[c.fetch] !== 'function') bad.push(id + ': fetch ' + c.fetch);
        if (c.keyLS !== 'key:' + id || !c.keyLabel || !c.keyHint || c.sessionOnly || c.keyOptional) bad.push(id + ': key copy');
        if (c.statusEl !== id + '-status' || !document.getElementById(c.statusEl) || !document.getElementById('src-' + id)) bad.push(id + ': statusEl / card');
        if (JSON.stringify(c.srcIds) !== JSON.stringify(srcIds)) bad.push(id + ': srcIds ' + JSON.stringify(c.srcIds));
        if (JSON.stringify((c.fields || []).map(f => [f.id, !!(f.secret || f.type === 'password')])) !== JSON.stringify(fields)) bad.push(id + ': fields ' + JSON.stringify(c.fields));
        if (!c.links || !c.links.get || !c.links.usage || !c.links.docs || !Array.isArray(c.paths) || !c.paths.length) bad.push(id + ': links / paths');
        if (!/^validate-only/i.test(c.qualityNote || '')) bad.push(id + ': copy must open Validate-only');
      }
      const note = (id) => (connectorById(id) || {}).qualityNote || '';
      const LINK_ONLY = { api: ['sambanova', 'nvidia-nim', 'baseten'], coding: ['v0', 'tabnine', 'augment', 'gemini-code-assist', 'lovable', 'bolt', 'replit'], chat: ['qwen-chat', 'kimi-chat', 'zai-chat', 'youcom', 'notebooklm', 'm365-copilot'] };
      const loBad = [];
      for (const [cat, ids] of Object.entries(LINK_ONLY)) for (const id of ids) {
        const c = connectorById(id);
        if (!c) { loBad.push(id + ': missing'); continue; }
        if (c.kind !== 'link-only' || c.category !== cat || c.quality !== 'none') loBad.push(id + ': kind/category/quality');
        if (!(typeof c.reason === 'string' && c.reason.length > 40 && /^no /i.test(c.reason))) loBad.push(id + ': reason');
        if (c.fetch || c.parser || c.validate || c.poll || c.keyLS || (c.srcIds || []).length) loBad.push(id + ': must not fetch / own rows');
        if (!c.links || !c.links.usage || !(c.links.get || c.links.docs)) loBad.push(id + ': links');
        if (!/^no data/i.test(c.qualityNote || '') || c.qualityNote.length < 80) loBad.push(id + ': copy');
        if (!c.platform || !document.getElementById(id + '-status') || !document.getElementById('src-' + id)) loBad.push(id + ': platform / status element / card');
      }
      const v0 = connectorById('v0') || {}, aq = connectorById('amazonq') || {};
      // hub: every card renders (≈80 entries) and the search box still filters by name
      App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load(); App._hubQuery = ''; App._render();
      const rendered = document.querySelectorAll('#accounts-hub .acct').length;
      App._hubQuery = 'z.ai'; App._render();
      const zaiCards = [...document.querySelectorAll('#accounts-hub .acct')].map(c => c.dataset.connector).sort();
      App._hubQuery = ''; document.getElementById('hub-search').value = ''; App._render();
      return { bad, loBad, linkOnlyTotal: CONNECTORS.filter(c => c.kind === 'link-only').length, n: CONNECTORS.length, rendered, zaiCards,
        experimental: /experimental/i.test(note('zai')) && /never in rows/i.test(note('zai')) && /experimental/i.test(note('minimax')) && /never in rows/i.test(note('minimax')),
        alibaba: /Export Bill CSV/.test(note('alibaba-modelstudio')) && /3rd field/.test(note('alibaba-modelstudio')) && /not verified/i.test(note('alibaba-modelstudio')) && /aliyuncs\.com/.test(note('alibaba-modelstudio')),
        importsNoAlibaba: !connectorById('imports').srcIds.includes('alibaba-bill-csv'), fns: typeof globalThis.isAlibabaBillCSV === 'function' && typeof globalThis.parseAlibabaBillCSV === 'function',
        v0Collector: /collector/i.test(v0.reason || '') && /Access-Control|CORS/i.test(v0.reason || ''),
        amazonq: /chat-history-<hash>\.json/.test(note('amazonq')) && /no model, no tokens, no cost/i.test(note('amazonq')) && /text only/i.test(aq.reason || '') && (aq.paths || []).some(p => /\.aws\\amazonq\\history/.test(p)),
        mistral: /Re-checked 2026-10-15/.test(note('mistral')) && /Enterprise-only/.test(note('mistral')) && /lechat/.test(note('mistral')) && /CORS-blocked/.test(note('mistral')),
        noLambda: !CONNECTORS.some(c => /lambda/i.test(c.id) || /lambda/i.test(c.platform || '') || /lambda/i.test(c.name || '')),
        inOrder: ['Alibaba Model Studio', 'Z.ai API', 'MiniMax', 'v0', 'Microsoft 365 Copilot', 'SambaNova Cloud', 'Qwen Chat'].every(p => PLATFORM_ORDER.includes(p)) };
    });
    ok('registry (B4): alibaba-modelstudio / zai / minimax are api-key entries in API vendors — quality validate, fetch fn registered, keyLS key:<id>, statusEl + card in the DOM, get/usage/docs links, paths, not sessionOnly / keyOptional; Alibaba srcIds [alibaba-modelstudio, alibaba-bill-csv] with one plain "base" field; Z.ai no fields; MiniMax fields groupId (plain) + planKey (secret); copy opens "Validate-only"; platforms in PLATFORM_ORDER',
      b4.bad.length === 0 && b4.inOrder, JSON.stringify({ bad: b4.bad, inOrder: b4.inOrder }));
    ok('registry (B4): honesty copy — Z.ai and MiniMax name the EXPERIMENTAL quota and say it is never in rows / billed / totals; Alibaba names Export Bill CSV, the 3rd-field model rule, "not verified" and the *.aliyuncs.com host rule; alibaba-bill-csv lands under the card, not under Imports; the bill sniff / parser exist',
      b4.experimental && b4.alibaba && b4.importsNoAlibaba && b4.fns, JSON.stringify(b4));
    ok('registry (B4): the 16 link-only cards — sambanova / nvidia-nim / baseten (API vendors), v0 / tabnine / augment / gemini-code-assist / lovable / bolt / replit (Coding tools), qwen-chat / kimi-chat / zai-chat / youcom / notebooklm / m365-copilot (Chat apps) — kind link-only, quality none, a "No …" reason, no fetch / parser / keyLS / srcIds, a vendor usage link + get or docs, "No data" copy ≥ 80 chars, a live status element and card; 19 link-only entries in all; v0\'s reason names the CORS block and the collector proxy',
      b4.loBad.length === 0 && b4.linkOnlyTotal === 19 && b4.v0Collector, JSON.stringify({ loBad: b4.loBad, total: b4.linkOnlyTotal, v0: b4.v0Collector }));
    ok('registry (B4): corrected copy — amazonq names the IDE\'s %USERPROFILE%\\.aws\\amazonq\\history\\chat-history-<hash>.json (no model, no tokens, no cost; "text only" in the reason) and lists the path; mistral records the 2026-10-15 re-check (Admin API still Enterprise-only, Le Chat analytics endpoints, CORS-blocked); no Lambda card exists (sunset 2025-09-25, recorded as excluded)',
      b4.amazonq && b4.mistral && b4.noLambda, JSON.stringify({ amazonq: b4.amazonq, mistral: b4.mistral, noLambda: b4.noLambda }));
    ok('hub (B4): every registry card still renders at 74 entries (rendered = CONNECTORS.length ≥ 70; ≈85 after B5/B6) and a name search for "z.ai" narrows the hub to the two Z.ai cards',
      b4.rendered === b4.n && b4.n >= 70 && JSON.stringify(b4.zaiCards) === JSON.stringify(['zai', 'zai-chat']), JSON.stringify({ rendered: b4.rendered, n: b4.n, zaiCards: b4.zaiCards }));
  } finally {
    await page.close();
  }
}
