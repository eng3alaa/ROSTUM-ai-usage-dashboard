/** Aider — .aider.chat.history.md. Lines: '# aider chat started at YYYY-MM-DD HH:MM:SS' (session day),
 *  '> Main model: <name> with <fmt> edit format' (current aider; plain '> Model:' from older versions also
 *  matches), '> Tokens: 8.2k sent[, 2.1k cache write][, 8k cache hit], 578 received. Cost: …'. reModel requires
 *  "model:" to start the line (after '>'/whitespace, with an optional "Main " prefix) so '> Weak model:' /
 *  '> Editor model:' lines never match and never override the row's model. k-rounded → est:1. `lines` = Tokens
 *  lines seen, `badLines` = Tokens lines that did not parse. No hour (session start only). */
async function parseAiderHistory(files, onProgress) {
  const agg = makeAgg(); let msgs = 0, lines = 0, badLines = 0;
  const list = files.filter(f => /(^|\/)\.aider\.chat\.history\.md$/i.test(f.path));
  const reStart = /^#\s*aider chat started at\s+(\d{4}-\d{2}-\d{2})/i;
  const reModel = /^>?\s*(?:Main )?model:\s*(\S+)/i;
  const reTok = /Tokens:\s*([\d.,]+k?)\s*sent(?:,\s*([\d.,]+k?)\s*cache write)?(?:,\s*([\d.,]+k?)\s*cache hit)?,\s*([\d.,]+k?)\s*received/i;
  const num = (s) => { if (!s) return 0; const k = /k$/i.test(s); const v = parseFloat(s.replace(/,/g, '')); return Number.isFinite(v) ? Math.round(k ? v * 1000 : v) : NaN; };
  for (let fi = 0; fi < list.length; fi++) {
    const { file } = list[fi];
    let day = dayKey(file.lastModified), model = 'aider';
    for (const line of (await file.text()).split(/\r?\n/)) {
      let m;
      if ((m = reStart.exec(line))) { day = m[1]; continue; }
      if ((m = reModel.exec(line))) { model = m[1]; continue; }
      if (!/Tokens:/.test(line)) continue;
      lines++;
      m = reTok.exec(line);
      if (!m) { badLines++; continue; }
      const sent = num(m[1]), cw = num(m[2]), cr = num(m[3]), out = num(m[4]);
      if ([sent, cw, cr, out].some(Number.isNaN)) { badLines++; continue; }
      const t = { in: Math.max(0, sent - cw - cr), cw, cr, out, msgs: 1, est: 1 };
      if (model.includes('/') && isLocalProvider(model.split('/')[0])) t.local = 1;   // LiteLLM provider prefix: ollama_chat/, ollama/, lm_studio/ … → free local inference
      agg.add(day, 'Aider', model, t);
      msgs++;
    }
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: [], meta: { files: list.length, msgs, lines, badLines, addedIds: [] } };
}

/** JetBrains Junie — *-events.jsonl / events.jsonl. Each line {timestamp, event:{type,…}} (or flat). LlmResponseEvent
 *  records carry inputTokens/outputTokens/cacheTokens (+cost, model) — nesting varies by version, so the token object
 *  is looked up at event, event.answer, event.usage, event.response, event.tokenUsage, event.statistics. */
async function parseJunieEvents(files, onProgress) {
  const agg = makeAgg(); const proj = makeProjAgg('JetBrains Junie'); let msgs = 0; const k = { lines: 0, badLines: 0 };
  const list = files.filter(f => /(^|\/)[^/]*events\.jsonl$/i.test(f.path));
  const pick = (o, ...keys) => { for (const key of keys) if (o && o[key] != null) return finTok(+o[key] || 0); return 0; };
  for (let fi = 0; fi < list.length; fi++) {
    const { path, file } = list[fi];
    const sid = (path.split('/').pop() || '').replace(/\.jsonl$/i, '');
    // Projects table: IDE layout …/projects/<project>/matterhorn/.matterhorn/events/… → <project> (JetBrains' ".<hash>" cache suffix stripped);
    // a project-path-like field on any event (Junie CLI sessions) is honoured; otherwise '(unknown project)'.
    const pm = path.match(/(?:^|\/)([^/]+)\/matterhorn\/\.matterhorn\//i);
    let projName = pm ? pm[1].replace(/\.[0-9a-f]{6,}$/i, '') : null;
    await eachJsonl(file, (o) => {
      const ev = o.event && typeof o.event === 'object' ? o.event : o;
      if (!projName) { const w = ev.projectPath || ev.projectDir || ev.cwd || ev.workingDirectory || o.projectPath; if (w) projName = prettyProject(String(w)); }
      const type = String(ev.type || ev.eventType || o.type || '');
      if (!/LlmResponse/i.test(type)) return;
      const src = [ev, ev.answer, ev.usage, ev.response, ev.tokenUsage, ev.statistics].find(x => x && typeof x === 'object' && (x.inputTokens != null || x.input_tokens != null));
      if (!src) return;
      const model = String(ev.model || ev.modelName || (ev.answer && (ev.answer.model || ev.answer.modelName)) || src.model || 'junie');
      const tsRaw = o.timestamp || ev.timestamp || o.time; const ts = tsRaw ? new Date(tsRaw) : null, okTs = ts && !isNaN(ts);
      const t = { in: pick(src, 'inputTokens', 'input_tokens'), out: pick(src, 'outputTokens', 'output_tokens'), cr: pick(src, 'cacheTokens', 'cacheInputTokens', 'cache_read_tokens'), cw: pick(src, 'cacheCreateInputTokens', 'cacheCreationTokens', 'cache_write_tokens'), msgs: 1 };
      agg.add(dayKey(okTs ? ts : file.lastModified), 'JetBrains Junie', model, t, sid, okTs ? ts.getHours() : undefined);
      proj.add(projName || prettyProject(null), model, t);
      msgs++;
    }, k);
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: proj.rows(), meta: { files: list.length, msgs, lines: k.lines, badLines: k.badLines, addedIds: [] } };
}

