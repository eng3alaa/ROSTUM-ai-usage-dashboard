import fs from 'node:fs';
import path from 'node:path';
import { openDashboard, OUT } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    // item 2: first week bucket label clamps to range start
    const lbl = await page.evaluate(() => {
      const b = bucketDays(dayRange('2025-10-01', '2026-03-31'));
      // F4: the rendered x-axis tick labels must use the same range-clamped first day, not
      // the raw bucket key (which for the first week can be a Monday BEFORE the range start).
      App._drill = null; App.filters.hiddenPlatforms = new Set();
      Store.sources = {};
      Store.setSource('csv', dayRange('2025-10-01', '2026-03-31').map(d => ({ d, platform: 'Gemini', model: 'g', in: 10, cw: 0, cr: 0, out: 5, msgs: 1 })), {});
      App.filters.range = 'custom'; App.filters.from = '2025-10-01'; App.filters.to = '2026-03-31'; App._render();
      const tickTexts = [...document.querySelectorAll('#daily-chart svg text.axis-t')].map(t => t.textContent);
      return { first: b.buckets[0].key, firstDay: b.buckets[0].days[0], label: b.buckets[0].label, tickTexts };
    });
    ok('backlog-2: first week bucket carries a range-clamped label', lbl.firstDay === '2025-10-01' && lbl.label && lbl.label.includes('Oct 1') && !lbl.tickTexts.includes('Sep 29'), JSON.stringify(lbl));
    // item 3: delegated pointer handler — one listener on the SVG, no per-band listeners
    const del = await page.evaluate(() => {
      Store.sources = {}; Store.setSource('csv', Array.from({ length: 30 }, (_, i) => ({ d: addDays('2026-07-01', i), platform: 'Gemini', model: 'g', in: 10, cw: 0, cr: 0, out: 5, msgs: 1 })), {});
      App.filters.range = 'custom'; App.filters.from = '2026-07-01'; App.filters.to = '2026-07-30'; App._render();
      const svg = document.querySelector('#daily-chart svg');
      const bands = svg.querySelectorAll('.colband');
      // per-band listeners were removed: bands are plain rects (no tabindex), the SVG has one hit layer
      return { bands: bands.length, svgHasHit: !!svg.querySelector('.hitlayer'), anyBandTab: [...bands].some(b => b.hasAttribute('tabindex')) };
    });
    ok('backlog-3: chart uses one delegated hit layer, not per-band listeners', del.svgHasHit && !del.anyBandTab && del.bands === 30, JSON.stringify(del));
    // item 13: 9th platform gets a distinct visible slot, not the "Other" gray
    const col = await page.evaluate(() => {
      ColorMap.maps = { platform: {}, model: {} };
      const cands = ['A','B','C','D','E','F','G','H','I'];
      const colors = cands.map(p => ColorMap.colorOf('platform', p, cands));
      return { unique: new Set(colors).size, otherHex: getComputedStyle(document.documentElement).getPropertyValue('--other').trim(), last: colors[8] };
    });
    ok('backlog-13: 9+ platforms still get distinct colors (palette widened)', col.unique === 9 && col.last !== col.otherHex, JSON.stringify(col));
    // item 10: drill-down does not leak into persisted chip state
    const leak = await page.evaluate(() => {
      LS.del('hiddenPlatforms'); App.filters.hiddenPlatforms = new Set();
      Store.sources = {}; Store.setSource('openrouter', [{ d: todayKey(), platform: 'OpenRouter', model: 'x', in: 5, cw: 0, cr: 0, out: 5, msgs: 1 }], {});
      Store.setSource('csv', [{ d: todayKey(), platform: 'Gemini', model: 'y', in: 7, cw: 0, cr: 0, out: 7, msgs: 1 }], {});
      App._render();
      App.drillDown(connectorById('openrouter'));
      const afterDrill = LS.get('hiddenPlatforms', null);
      // now click an unrelated chip (Gemini) — must persist ONLY the user's chip state, not the drill set
      const chip = [...document.querySelectorAll('#platform-chips .chip')].find(c => c.textContent.includes('Gemini'));
      chip && chip.click();
      const afterChip = LS.get('hiddenPlatforms', null);
      return { afterDrill, afterChip };
    });
    ok('backlog-10: drill-down is ephemeral; chip click persists only user chip state', leak.afterDrill === null && Array.isArray(leak.afterChip) && leak.afterChip.length === 1 && leak.afterChip[0] === 'Gemini', JSON.stringify(leak));

    // F1: drill-down must apply to insights + narrative coherently, not just KPIs/daily —
    // otherwise movers compares a drilled "current" window against an undrilled "previous"
    // window and invents a false mover, and projection/WoW blend in the hidden platform.
    const drillIns = await page.evaluate(() => {
      LS.del('hiddenPlatforms'); App.filters.hiddenPlatforms = new Set(); App._drill = null;
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const today = todayKey(), prior = addDays(today, -10);
      const rows = [
        { d: today, platform: 'Gemini', model: 'g', in: 1_000_000, cw: 0, cr: 0, out: 0, msgs: 5 },
        { d: today, platform: 'OpenRouter', model: 'o', in: 2_000_000, cw: 0, cr: 0, out: 0, msgs: 5 },
        { d: prior, platform: 'Gemini', model: 'g', in: 1_000_000, cw: 0, cr: 0, out: 0, msgs: 5 },
        { d: prior, platform: 'OpenRouter', model: 'o', in: 2_000_000, cw: 0, cr: 0, out: 0, msgs: 5 },
      ];
      Store.setSource('csv', rows, {});
      App.filters.range = '7';   // 'prior' (today-10) must land in the PREVIOUS equal-length window, not the current one
      App.drillDown(connectorById('openrouter'));
      App._render();
      const orRows = rows.filter(r => r.platform === 'OpenRouter');
      const costOf = (r) => Pricing.cost(r.model, r);
      const expected = Insights.projection(orRows, costOf, todayKey());
      return {
        moversText: document.getElementById('ins-movers').textContent,
        projText: document.getElementById('ins-projection-value').textContent,
        expectedProjText: fmtUSD(expected.projected),
      };
    });
    ok('backlog-10b: drill-down applies to insights + narrative coherently',
      !drillIns.moversText.includes('Gemini') && drillIns.projText === drillIns.expectedProjText, JSON.stringify(drillIns));
    await page.evaluate(() => { App._drill = null; });   // isolation: don't leak drill state into later checks in this file

    // F3: hovering the delegated hit layer should visually highlight the band under the
    // pointer, even though the bands themselves no longer receive pointer events directly.
    const active = await page.evaluate(() => {
      App._drill = null; App.filters.hiddenPlatforms = new Set();
      Store.sources = {}; Store.setSource('csv', Array.from({ length: 30 }, (_, i) => ({ d: addDays('2026-07-01', i), platform: 'Gemini', model: 'g', in: 10, cw: 0, cr: 0, out: 5, msgs: 1 })), {});
      App.filters.range = 'custom'; App.filters.from = '2026-07-01'; App.filters.to = '2026-07-30'; App._render();
      const svg = document.querySelector('#daily-chart svg');
      const hit = svg.querySelector('.hitlayer');
      const hitX = +hit.getAttribute('x'), hitW = +hit.getAttribute('width');
      const bands = [...svg.querySelectorAll('.colband')];
      const band = hitW / bands.length;
      const r = svg.getBoundingClientRect();   // svg width/height attrs == viewBox units 1:1 to client px (no CSS scaling on screen)
      const clientX = r.left + hitX + band * 3 + band / 2;
      const clientY = r.top + 20;
      hit.dispatchEvent(new PointerEvent('pointermove', { clientX, clientY, bubbles: true }));
      const activeBands = bands.filter(b => b.classList.contains('active'));
      return { count: activeBands.length, idx: activeBands.length ? bands.indexOf(activeBands[0]) : -1 };
    });
    ok('backlog-3b: hovered band highlighted via active class', active.count === 1 && active.idx === 3, JSON.stringify(active));

    // F5: entities persisted with the old 8-slot overflow sentinel (-1, "Other" gray) from
    // before the palette widened to 12 slots must re-assign into a real slot, not stay gray.
    const legacy = await page.evaluate(() => {
      ColorMap.maps = { platform: { Legacy: -1 }, model: {} };
      const c = ColorMap.colorOf('platform', 'Legacy', ['Legacy']);
      const otherHex = getComputedStyle(document.documentElement).getPropertyValue('--other').trim();
      return { c, otherHex };
    });
    ok('backlog-13b: legacy -1 slots re-assign after palette widening', legacy.c !== legacy.otherHex, JSON.stringify(legacy));

    // item 15: cached scan reports lines/badLines
    const meta = await page.evaluate(async () => {
      const bad = '{"type":"assistant","message":{"usage":{"input_tokens":1,"output_tokens":1},"model":"m","id":"z1"},"requestId":"z1","timestamp":"2026-08-10T10:00:00Z"}\nnot json\n';
      const res = await parseClaudeLogsCached([{ path: 'projects/-p/s.jsonl', file: new File([bad], 's.jsonl') }], null, new Map());
      return { lines: res.meta.lines, badLines: res.meta.badLines };
    });
    ok('backlog-15: cached scan preserves lines/badLines diagnostics', meta.lines === 2 && meta.badLines === 1, JSON.stringify(meta));
    // item 16: ScanCache prunes signatures not seen in the latest scan
    const evict = await page.evaluate(async () => {
      const cache = new Map();
      const f1 = { path: 'projects/-p/a.jsonl', file: new File(['{"type":"assistant","message":{"usage":{"input_tokens":1,"output_tokens":1},"model":"m","id":"a1"},"requestId":"a1","timestamp":"2026-08-10T10:00:00Z"}'], 'a.jsonl', { lastModified: 1 }) };
      const f2 = { path: 'projects/-p/b.jsonl', file: new File(['{"type":"assistant","message":{"usage":{"input_tokens":1,"output_tokens":1},"model":"m","id":"b1"},"requestId":"b1","timestamp":"2026-08-10T10:00:00Z"}'], 'b.jsonl', { lastModified: 1 }) };
      await parseClaudeLogsCached([f1, f2], null, cache);
      const before = cache.size;
      await parseClaudeLogsCached([f1], null, cache);   // b vanished
      return { before, after: cache.size };
    });
    ok('backlog-16: cache prunes entries for files absent from the latest scan', evict.before === 2 && evict.after === 1, JSON.stringify(evict));
    // item 18: v1.1-shaped store (no connectors) migrates to connected cards
    const mig = await page.evaluate(() => {
      Store.sources = {}; Store.connectors = {};
      Store.sources.anthropic = { rows: [{ d: todayKey(), platform: 'Anthropic API', model: 'm', in: 1, cw: 0, cr: 0, out: 1, msgs: 1 }], meta: { updated: Date.now() - 1000 } };
      Store.migrateConnectors();
      return { st: Store.connectorStatus(connectorById('anthropic')), label: (Store.connectors.anthropic || {}).label };
    });
    ok('backlog-18: sources without connector state migrate to a labeled connected card', mig.st === 'ok' && /stored data/i.test(mig.label), JSON.stringify(mig));
    // item 14: connected new-platform source cards are revealed in Data sources
    const reveal = await page.evaluate(() => {
      Store.setConnector('openrouter', { label: 'k', lastSync: Date.now() });
      App._render();
      return document.getElementById('src-openrouter').hidden === false;
    });
    ok('backlog-14: connected OpenRouter card is visible in Data sources', reveal, '');
    // item 4: large import parse runs off the main thread (worker path exists and returns identical rows)
    const wk = await page.evaluate(async () => {
      const conv = [{ current_node: 'B', mapping: { root: { id: 'root', parent: null, children: ['u'] }, u: { id: 'u', parent: 'root', children: ['B'], message: { author: { role: 'user' }, create_time: 1, content: { content_type: 'text', parts: ['hi'] } } }, B: { id: 'B', parent: 'u', children: [], message: { author: { role: 'assistant' }, create_time: 2, metadata: { model_slug: 'gpt-5.4' }, content: { content_type: 'text', parts: ['x'.repeat(400)] } } } } }];
      const direct = parseChatGPTExport(conv);
      const viaWorker = await parseInWorker('chatgpt', JSON.stringify(conv));
      return { same: JSON.stringify(direct.rows) === JSON.stringify(viaWorker.rows), msgs: viaWorker.meta.msgs };
    });
    ok('backlog-4: worker parse returns identical rows for chat exports', wk.same && wk.msgs === 1, JSON.stringify(wk));

    // item 9 residual: a stale bail must not blank a NEWER in-flight fetch's own placeholder
    const dbl = await page.evaluate(async () => {
      Store.sources = {}; Store.connectors = {};
      let n = 0;
      window.fetchAnthropicAll = async () => { const me = ++n; await new Promise(r => setTimeout(r, me === 1 ? 50 : 400)); return { usage: { rows: [{ d: todayKey(), platform: 'Anthropic API', model: 'm' + me, in: 1, cw: 0, cr: 0, out: 1, msgs: 1 }] }, cost: [] }; };
      document.getElementById('anthropic-key').value = 'sk-ant-admin-x';
      const p1 = App.fetchAnthropic(); const p2 = App.fetchAnthropic();
      await new Promise(r => setTimeout(r, 120));   // p1 (stale) has resolved & bailed; p2 still in flight
      const mid = document.getElementById('anthropic-status').textContent;
      await Promise.allSettled([p1, p2]);
      return { mid, final: document.getElementById('anthropic-status').textContent, model: Store.sources.anthropic.rows[0].model };
    });
    ok('backlog-9: stale bail does not blank a newer in-flight placeholder', /Fetching/.test(dbl.mid) && /Connected/.test(dbl.final) && dbl.model === 'm2', JSON.stringify(dbl));

    // F1: a keep-data disconnect must not be undone by re-migration on the next load()
    const keepReload = await page.evaluate(() => {
      Store.sources = {}; Store.connectors = {};
      Store.setSource('openai', [{ d: todayKey(), platform: 'OpenAI API', model: 'm', in: 1, cw: 0, cr: 0, out: 1, msgs: 1 }], {});
      Store.setConnector('openai', { label: 'k', lastSync: Date.now() });
      const origConfirm = window.confirm;
      window.confirm = () => false;   // keep data
      App.disconnectConnector('openai');
      window.confirm = origConfirm;
      Store.load();   // simulate reload
      return { st: Store.connectorStatus(connectorById('openai')), has: 'openai' in Store.connectors };
    });
    ok('backlog-18b: keep-data disconnect survives reload (no re-migration)', keepReload.st === 'off' && !keepReload.has, JSON.stringify(keepReload));

    // F2: the reveal rule must not hide a src card while it's open inside the connector modal
    const modalReveal = await page.evaluate(async () => {
      delete Store.connectors.gemini;
      App.openConnectorModal('gemini');
      App._render();
      const hiddenInModal = document.getElementById('src-gemini').hidden;
      App.closeConnectorModal();
      await new Promise(r => document.getElementById('connector-modal').addEventListener('close', r, { once: true }));
      return { hiddenInModal };
    });
    ok('backlog-14b: reveal rule does not hide the card open in the modal', modalReveal.hiddenInModal === false, JSON.stringify(modalReveal));

    // F3: blank/whitespace/CR-only lines (Windows CRLF logs) are not malformed
    const crlf = await page.evaluate(async () => {
      const text = '{"type":"assistant","message":{"usage":{"input_tokens":1,"output_tokens":1},"model":"m","id":"z1"},"requestId":"z1","timestamp":"2026-08-10T10:00:00Z"}\r\n\r\n   \n';
      const res = await parseClaudeLogs([{ path: 'projects/-p/s.jsonl', file: new File([text], 's.jsonl') }], null);
      return { lines: res.meta.lines, badLines: res.meta.badLines, msgs: res.meta.msgs };
    });
    ok('scan: blank/whitespace/CR-only lines are not malformed', crlf.badLines === 0 && crlf.lines === 1 && crlf.msgs === 1, JSON.stringify(crlf));

    // Pricing.resolve normalizes vendor-native Claude ids (Copilot CLI dotted, Cursor family-last, Claude Code dated)
    // before matching DEFAULT_PRICES; rows/UI keep the vendor id, only pricing resolution normalizes.
    const norm = await page.evaluate(() => {
      LS.del('prices'); Pricing.load();
      const ids = ['claude-opus-4.1', 'claude-haiku-4.5', 'claude-sonnet-4.5', 'claude-4.1-opus', 'claude-4-opus', 'claude-4.5-sonnet', 'claude-3.5-sonnet',
        'claude-opus-4-1-20250805', 'claude-opus-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-sonnet-3.5', 'claude-4-opus-thinking',
        'claude-opus-4-5', 'claude-sonnet-4-5-20250929', 'anthropic/claude-opus-4.1', 'gpt-5.4', 'gemini-2.5-pro'];
      const out = {};
      for (const id of ids) out[id] = Pricing.resolve(id).label;
      out._noRawCacheLeak = Pricing.resolve('CLAUDE-OPUS-4.1').label;
      return out;
    });
    const OPUS4 = 'Claude Opus 4 / 4.1', SON = 'Claude Sonnet 4.x / 3.x';
    ok('pricing-norm: Copilot CLI dotted ids resolve to family rows (opus-4.1 / haiku-4.5 / sonnet-4.5)',
      norm['claude-opus-4.1'] === OPUS4 && norm['claude-haiku-4.5'] === 'Claude Haiku 4.5' && norm['claude-sonnet-4.5'] === SON, JSON.stringify(norm));
    ok('pricing-norm: Cursor family-last ids resolve (4.1-opus / 4-opus / 4.5-sonnet / 3.5-sonnet / 4-opus-thinking)',
      norm['claude-4.1-opus'] === OPUS4 && norm['claude-4-opus'] === OPUS4 && norm['claude-4.5-sonnet'] === SON && norm['claude-3.5-sonnet'] === SON && norm['claude-4-opus-thinking'] === OPUS4, JSON.stringify(norm));
    ok('pricing-norm: Claude Code dated ids resolve (opus-4-1-20250805 / opus-4-20250514) and 3.x dated ids keep matching',
      norm['claude-opus-4-1-20250805'] === OPUS4 && norm['claude-opus-4-20250514'] === OPUS4 && norm['claude-3-5-sonnet-20241022'] === SON && norm['claude-3-5-haiku-20241022'] === 'Claude Haiku 3.5', JSON.stringify(norm));
    ok('pricing-norm: unchanged — opus-4-5 stays Opus 5/4.5+, sonnet-4-5 dated stays Sonnet, OpenRouter prefix ok, gpt-5.4 / gemini-2.5-pro untouched, family-first 3.5 canonicalizes',
      norm['claude-opus-4-5'] === 'Claude Opus 5 / 4.5+' && norm['claude-sonnet-4-5-20250929'] === SON && norm['anthropic/claude-opus-4.1'] === OPUS4 && norm['gpt-5.4'] === 'GPT-5.4' && norm['gemini-2.5-pro'] === 'Gemini 2.5 Pro' && norm['claude-sonnet-3.5'] === SON && norm._noRawCacheLeak === OPUS4, JSON.stringify(norm));
    const hint = await page.evaluate(() => document.querySelector('#pricing-title .hint').textContent);
    ok('pricing-norm: price editor hint says patterns match the normalized id', /normali[sz]ed/i.test(hint) && /date/i.test(hint), hint);

    // v5 T1: the Imports dropzone sniffs every .jsonl by CONTENT — a non-Claude file (Codex rollout / Copilot CLI events /
    // Continue / Junie / usage-logger) is routed to its registered folder-log parser under THAT connector's srcId through the
    // same landing path a folder scan uses (rows, filesLabel / label / lastSync, src card revealed, hub reads connected);
    // Claude-shaped files keep the local-import path; an unrecognized .jsonl gets an honest note and touches no source.
    // Routed files never count toward the Imports card's own "N file(s) imported" label — their rows live under the other connector.
    const sniff = await page.evaluate(() => ({
      codex: sniffJsonlKind({ timestamp: 't', type: 'session_meta', payload: { id: 'x' } }, 'x.jsonl'),
      codex2: sniffJsonlKind({ timestamp: 't', type: 'event_msg', payload: { type: 'token_count' } }, 'x.jsonl'),
      copilot: sniffJsonlKind({ id: 'e1', type: 'session.start', data: {} }, 'events.jsonl'),
      copilot2: sniffJsonlKind({ id: 'e2', type: 'assistant.usage', data: { model: 'm' } }, 'x.jsonl'),
      cont: sniffJsonlKind({ eventName: 'tokensGenerated', model: 'm', promptTokens: 1, generatedTokens: 2 }, 'x.jsonl'),
      junie: sniffJsonlKind({ timestamp: 't', event: { type: 'LlmResponseEvent', inputTokens: 1 } }, 'x.jsonl'),
      junie2: sniffJsonlKind({ timestamp: 't', event: { type: 'AgentStartedEvent' } }, 'x.jsonl'),
      logger: sniffJsonlKind({ ts: 't', model: 'm', prompt_eval_count: 1, eval_count: 2 }, 'x.jsonl'),
      logger2: sniffJsonlKind({ ts: 't', platform: 'Ollama', model: 'm', in: 1, out: 2, msgs: 1 }, 'x.jsonl'),
      claude: sniffJsonlKind({ type: 'assistant', message: { usage: { input_tokens: 1 } } }, 'x.jsonl'),
      claude2: sniffJsonlKind({ type: 'user', message: { role: 'user' } }, 'x.jsonl'),
      claude3: sniffJsonlKind({ type: 'summary', summary: 's' }, 'x.jsonl'),
      claude4: sniffJsonlKind({ parentUuid: null, type: 'progress', uuid: 'u' }, 'x.jsonl'),
      unknown: sniffJsonlKind({ hello: 1 }, 'x.jsonl'),
      nul: sniffJsonlKind(null, 'x.jsonl'),
    }));
    ok('imports-sniff: sniffJsonlKind classifies Codex / Copilot CLI / Continue / Junie (nested event; non-LLM event too) / usage-logger (native + Ollama counters) / Claude (assistant, user, summary, envelope) / unknown',
      sniff.codex === 'codex' && sniff.codex2 === 'codex' && sniff.copilot === 'copilot-cli' && sniff.copilot2 === 'copilot-cli' && sniff.cont === 'continue' && sniff.junie === 'junie' && sniff.junie2 === 'junie'
      && sniff.logger === 'ollama' && sniff.logger2 === 'ollama' && sniff.claude === 'claude' && sniff.claude2 === 'claude' && sniff.claude3 === 'claude' && sniff.claude4 === 'claude'
      && sniff.unknown === 'unknown' && sniff.nul === 'unknown', JSON.stringify(sniff));
    const codexText = fs.readFileSync(path.join(OUT, 'codex', 'sessions', '2026', '08', '10', 'rollout-2026-08-10T09-00-00-abc.jsonl'), 'utf8');
    const cpA = fs.readFileSync(path.join(OUT, 'copilot', 'session-state', 'sess-1', 'events.jsonl'), 'utf8');
    const cpB = fs.readFileSync(path.join(OUT, 'copilot', 'session-state', 'sess-2', 'events.jsonl'), 'utf8');
    const logText = fs.readFileSync(path.join(OUT, 'usage-log', 'ollama-usage.jsonl'), 'utf8');
    const claudeText = fs.readFileSync(path.join(OUT, 'claude-logs', 'projects', '-D--proj1', 'sess-aaa.jsonl'), 'utf8');
    const routed = await page.evaluate(async (codex, a, b, log, claude) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.projectsBy = {}; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set();
      const sum = (rows) => rows.reduce((t, r) => ({ in: t.in + (r.in || 0), cw: t.cw + (r.cw || 0), cr: t.cr + (r.cr || 0), out: t.out + (r.out || 0), msgs: t.msgs + (r.msgs || 0) }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });
      const rows = (id) => ((Store.sources[id] || {}).rows || []);
      const out = {};
      // (a) four foreign .jsonl — one Codex rollout, two Copilot CLI events files that share their on-disk name, one usage-logger file — and no Claude file: prior local-import rows stay
      Store.setSource('local-import', [{ d: todayKey(), platform: 'Claude Code/Desktop', model: 'claude-sonnet-5', in: 100, cw: 0, cr: 0, out: 50, msgs: 1, sid: 'prior-sess' }], {});
      await App.handleImportFiles([new File([codex], 'rollout-2026-08-10T09-00-00-abc.jsonl'), new File([a], 'events.jsonl'), new File([b], 'events.jsonl'), new File([log], 'ollama-usage.jsonl')]);
      out.codex = sum(rows('codex')); out.copilot = sum(rows('copilot-cli')); out.ollama = sum(rows('ollama'));
      out.codexModels = [...new Set(rows('codex').map(r => r.model))]; out.copilotPlatforms = [...new Set(rows('copilot-cli').map(r => r.platform))];
      out.prior = { rows: rows('local-import').length, in: (rows('local-import')[0] || {}).in };
      out.imports = Store.connectors.imports === undefined ? 'unset' : 'set';
      out.labels = { codex: (Store.connectors.codex || {}).filesLabel, copilot: (Store.connectors['copilot-cli'] || {}).filesLabel, ollama: (Store.connectors.ollama || {}).filesLabel };
      out.status = { codex: Store.connectorStatus(connectorById('codex')), copilot: Store.connectorStatus(connectorById('copilot-cli')), ollama: Store.connectorStatus(connectorById('ollama')) };
      App._render();
      const hubCodex = document.querySelector('#accounts-hub .acct[data-connector="codex"]');
      out.hubDot = hubCodex ? !!hubCodex.querySelector('.dot.ok') : null; out.hubAria = hubCodex ? hubCodex.getAttribute('aria-label') : null;
      out.cardShown = document.getElementById('src-codex').hidden === false;
      out.cardStatus = document.getElementById('codex-status').textContent;
      out.note = document.getElementById('import-status').textContent;
      out.projects = (Store.projectsBy.codex || []).length;
      // (b) a Claude session dropped together with a Codex rollout: the Claude file lands under local-import (today's path — replaces the prior rows), the Codex file is routed; only the Claude file counts as an Imports-card import
      await App.handleImportFiles([new File([claude], 'sess-aaa.jsonl'), new File([codex], 'rollout-2026-08-10T09-00-00-abc.jsonl')]);
      out.claude = sum(rows('local-import')); out.codexAgain = sum(rows('codex'));
      out.importsLabel = (Store.connectors.imports || {}).label; out.noteB = document.getElementById('import-status').textContent;
      // (c) an unrecognized .jsonl: honest note, no source created, Imports card not connected
      Store.sources = {}; Store.connectors = {};
      await App.handleImportFiles([new File(['{"hello":1}\n{"world":2}\n'], 'mystery.jsonl')]);
      out.unknownNote = document.getElementById('import-status').textContent; out.unknownSources = Object.keys(Store.sources); out.unknownImports = Store.connectors.imports === undefined ? 'unset' : 'set';
      Store.sources = {}; Store.connectors = {}; Store.projectsBy = {}; Store.persist(); App._render();
      return out;
    }, codexText, cpA, cpB, logText, claudeText);
    ok('imports-route: Codex rollout + two Copilot CLI events files + a usage-logger file dropped on Imports land under codex / copilot-cli / ollama with the folder-scan totals (codex in=200 cr=200 out=130 msgs=3 gpt-5.4-codex; copilot-cli in=2150 cw=100 cr=900 out=500 msgs=5; ollama in=1060 out=370 msgs=3), prior local-import rows intact, Imports card untouched',
      routed.codex.in === 200 && routed.codex.cr === 200 && routed.codex.out === 130 && routed.codex.msgs === 3 && routed.codexModels.length === 1 && routed.codexModels[0] === 'gpt-5.4-codex'
      && routed.copilot.in === 2150 && routed.copilot.cw === 100 && routed.copilot.cr === 900 && routed.copilot.out === 500 && routed.copilot.msgs === 5 && routed.copilotPlatforms.length === 1 && routed.copilotPlatforms[0] === 'GitHub Copilot'
      && routed.ollama.in === 1060 && routed.ollama.out === 370 && routed.ollama.msgs === 3
      && routed.prior.rows === 1 && routed.prior.in === 100 && routed.imports === 'unset', JSON.stringify(routed));
    ok('imports-route: routed connectors read connected — filesLabel "1 file" / "2 files" / "1 file", status ok, hub dot ok + aria "connected", src card revealed with its Connected line, Codex project rows stored — and the Imports note names each tool ("N file(s) routed to <name> (see its card)")',
      routed.labels.codex === '1 file' && routed.labels.copilot === '2 files' && routed.labels.ollama === '1 file' && routed.status.codex === 'ok' && routed.status.copilot === 'ok' && routed.status.ollama === 'ok'
      && routed.hubDot === true && /: connected$/.test(routed.hubAria) && routed.cardShown && /Connected/.test(routed.cardStatus) && routed.projects === 1
      && /1 file routed to OpenAI Codex CLI \(see its card\)/.test(routed.note) && /2 files routed to GitHub Copilot CLI \(logs\) \(see its card\)/.test(routed.note) && /1 file routed to Ollama \(see its card\)/.test(routed.note), JSON.stringify(routed));
    ok('imports-route: a Claude session in the same drop keeps the local-import path (in=110 msgs=2) while the Codex file is routed again; only the Claude file counts ("1 file(s) imported"); an unrecognized .jsonl → "format not recognized", no source, Imports not connected',
      routed.claude.in === 110 && routed.claude.msgs === 2 && routed.codexAgain.in === 200 && routed.codexAgain.msgs === 3 && routed.importsLabel === '1 file(s) imported' && /1 \.jsonl file/.test(routed.noteB) && /routed to OpenAI Codex CLI/.test(routed.noteB)
      && /mystery\.jsonl: format not recognized/.test(routed.unknownNote) && routed.unknownSources.length === 0 && routed.unknownImports === 'unset', JSON.stringify(routed));
  } finally {
    await page.close();
  }
}
