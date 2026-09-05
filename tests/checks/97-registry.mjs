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

    // refreshAll must fire every key-bearing connector's real fetch method, including
    // the fetchOpenAI (capital AI) casing that name-derivation from the id would miss.
    const refresh = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      let anthropicCalls = 0, openaiCalls = 0;
      window.fetchAnthropicAll = async () => { anthropicCalls++; return { usage: { rows: [] }, cost: [] }; };
      window.fetchOpenAIAll = async () => { openaiCalls++; return { usage: { rows: [] }, cost: [] }; };
      LS.set('key:anthropic', 'k');
      LS.set('key:openai', 'k');
      document.getElementById('anthropic-key').value = 'k';
      document.getElementById('openai-key').value = 'k';
      await App.refreshAll();
      return { anthropicCalls, openaiCalls };
    });
    ok('registry: refreshAll fires every key-bearing connector (incl. fetchOpenAI casing)',
      refresh.anthropicCalls === 1 && refresh.openaiCalls === 1, JSON.stringify(refresh));

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
        // costs: Grok 4 = 3 + 15 + 0.75 = 18.75 · DeepSeek chat = 0.27 + 1.10 + 0.07 = 1.44 · Meta AI = 0 · Sonar = 1 + 1 + 0 = 2
        grokCost: Pricing.cost('grok-4', M), dsCost: Pricing.cost('deepseek-chat', M), metaCost: Pricing.cost('meta-ai', M), sonarCost: Pricing.cost('sonar', M),
        lastIsFallback: DEFAULT_PRICES[DEFAULT_PRICES.length - 1].pat === '.*',
      };
    });
    ok('pricing (4b): Grok 4 / Grok fast-mini / DeepSeek Reasoner / DeepSeek chat / Perplexity Sonar / Meta AI rows resolve (first-match order right; ^copilot$ joins the ChatGPT row; fallback still last)',
      pr.grok4 === 'Grok 4 (xAI list)' && pr.grok === 'Grok 4 (xAI list)' && pr.grokMini === 'Grok fast/mini' && pr.grokFast === 'Grok fast/mini'
      && pr.dsReason === 'DeepSeek Reasoner' && pr.dsR1 === 'DeepSeek Reasoner' && pr.dsChat === 'DeepSeek chat (V3 list)' && pr.dsOr === 'DeepSeek chat (V3 list)'
      && pr.sonar === 'Perplexity Sonar' && pr.pplx === 'Perplexity Sonar' && pr.meta === 'Meta AI (consumer, no API price)' && /ChatGPT/.test(pr.copilot) && pr.copilot === pr.chatgpt && pr.gpt4o === 'GPT-4o' && pr.unknown === 'Unknown model'
      && Math.abs(pr.grokCost - 18.75) < 1e-9 && Math.abs(pr.dsCost - 1.44) < 1e-9 && pr.metaCost === 0 && Math.abs(pr.sonarCost - 2) < 1e-9 && pr.lastIsFallback, JSON.stringify(pr));

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
        if (!c.platform) problems.push(pre + 'no platform');
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
  } finally {
    await page.close();
  }
}
