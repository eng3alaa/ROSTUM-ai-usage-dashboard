/** LM Studio — *.conversation.json (whole-file JSON). For each message take versions[currentlySelected]; assistant
 *  versions are 'multiStep' (steps[] contentBlocks, each with genInfo.stats) or 'singleStep' (genInfo on the version).
 *  in = stats.promptTokensCount, out = stats.predictedTokensCount, model = genInfo.identifier (the short load id, e.g. 'llama-4-8b';
 *  the row is $0 by platform, not by model name) || indexedModelIdentifier (publisher-prefixed / .gguf path — display fallback only).
 *  Day = createdAt (ms) or the file's lastModified; no per-message timestamps → no hour. */
async function parseLmStudioConversations(files, onProgress) {
  const agg = makeAgg(); let msgs = 0, lines = 0, badLines = 0;
  const list = files.filter(f => /\.conversation\.json$/i.test(f.path));
  for (let fi = 0; fi < list.length; fi++) {
    const { path, file } = list[fi];
    let obj; try { obj = JSON.parse(await file.text()); } catch { badLines++; continue; }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.messages)) { badLines++; continue; }
    lines++;
    const created = obj.createdAt ?? obj.created_at;
    const day = dayKey(typeof created === 'number' && created > 0 ? new Date(created) : file.lastModified);
    const sid = (path.split('/').pop() || '').replace(/\.conversation\.json$/i, '');
    for (const m of obj.messages) {
      if (!m) continue;
      const vs = Array.isArray(m.versions) ? m.versions : [m];
      const v = vs[Math.min(Math.max(0, +m.currentlySelected || 0), vs.length - 1)];
      if (!v || v.role !== 'assistant') continue;
      const blocks = Array.isArray(v.steps) ? v.steps : [v];
      for (const b of blocks) {
        const gi = b && b.genInfo, st = gi && gi.stats;
        if (!st) continue;
        agg.add(day, 'LM Studio', String(gi.identifier || gi.indexedModelIdentifier || 'lm-studio'),
          { in: finTok(+st.promptTokensCount || 0), out: finTok(+st.predictedTokensCount || 0), msgs: 1 }, sid);
        msgs++;
      }
    }
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: [], meta: { files: list.length, msgs, lines, badLines, addedIds: [] } };
}

/** Jan — <data folder>/threads/<thread_id>/messages.jsonl: one JSON message per line { id, thread_id, role, content, created_at|created
 *  (ms, or unix seconds in older builds), model?{id}, metadata?{ tokenCount | tokenSpeed{tokenCount}, model? } }. content is
 *  [{type:'text', text:{value}}] (or text as a string, or a plain string). Output = metadata tokenCount when present (Jan writes only
 *  the OUTPUT count), else estTok(text); input = estTok(previous user message in the thread) — always estimated → est:1 on every row.
 *  Model: message.model.id → metadata.model → metadata.assistant.model → 'jan'. sid = 'jan:<thread_id>' (folder name). */
async function parseJanThreads(files, onProgress, seen = new Set(), c) {
  const agg = makeAgg(); let msgs = 0; const k = { lines: 0, badLines: 0 };
  const list = files.filter(f => /(^|\/)messages\.jsonl$/i.test(f.path));
  const textOf = (content) => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(p => { if (!p) return ''; if (typeof p === 'string') return p; if (typeof p.text === 'string') return p.text; if (p.text && typeof p.text.value === 'string') return p.text.value; return ''; }).join('\n');
  };
  const idOf = (v) => (v && typeof v === 'object') ? (typeof v.id === 'string' ? v.id : '') : (typeof v === 'string' ? v : '');
  const when = (m, fallback) => {
    let v = m.created_at ?? m.created ?? m.updated_at ?? m.updated;
    if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) v = +v;
    if (typeof v === 'number' && v > 0) return new Date(v < 1e12 ? v * 1000 : v);   // unix seconds vs milliseconds
    if (typeof v === 'string') { const d = new Date(v); if (!isNaN(d)) return d; }
    return new Date(fallback);
  };
  for (let fi = 0; fi < list.length; fi++) {
    const { path, file } = list[fi];
    const sid = 'jan:' + (path.split('/').slice(-2, -1)[0] || path);
    let lastUser = '';
    await eachJsonl(file, (m) => {
      const role = String(m.role || '').toLowerCase();
      const text = textOf(m.content);
      if (role === 'user') { lastUser = text; return; }
      if (role !== 'assistant') return;
      const md = m.metadata && typeof m.metadata === 'object' ? m.metadata : {};
      const tc = md.tokenCount ?? (md.tokenSpeed && typeof md.tokenSpeed === 'object' ? md.tokenSpeed.tokenCount : undefined);
      const out = tc != null && tc !== '' && Number.isFinite(+tc) && +tc >= 0 ? +tc : estTok(text.length);
      const model = idOf(m.model) || idOf(md.model) || idOf(md.assistant && md.assistant.model) || 'jan';
      const ts = when(m, file.lastModified);
      agg.add(dayKey(ts), (c && c.platform) || 'Jan', model, { in: estTok(lastUser.length), out, msgs: 1, est: 1 }, sid, ts.getHours());
      msgs++;
    }, k);
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: [], meta: { files: list.length, msgs, lines: k.lines, badLines: k.badLines, addedIds: [] } };
}

/** text-generation-webui — user_data/logs/chat/<character>/<id>.json and logs/instruct/<id>.json (whole-file JSON):
 *  { internal: [[user, assistant], …], visible, metadata: { 'user_<i>': {timestamp}, 'assistant_<i>': {timestamp, model_name, versions?} } }.
 *  No token counts → in = estTok(user), out = estTok(assistant) per pair, est:1; model = metadata['assistant_i'].model_name || the platform
 *  name; timestamps are LOCAL time strings ('YYYY-MM-DD HH:MM:SS') → parsed as local. The '<|BEGIN-VISIBLE-CHAT|>' greeting pair is
 *  not a generation and is skipped; only the current text of a regenerated turn counts (versions[] ignored). */
async function parseTgwebuiLogs(files, onProgress, seen = new Set(), c) {
  const agg = makeAgg(); let msgs = 0, lines = 0, badLines = 0;
  const list = files.filter(f => /(^|\/)logs\/(chat|instruct)\/.*\.json$/i.test(f.path));
  const parseTs = (s) => { if (typeof s !== 'string') return null; const d = new Date(s.trim().replace(' ', 'T')); return isNaN(d) ? null : d; };
  for (let fi = 0; fi < list.length; fi++) {
    const { path, file } = list[fi];
    let obj; try { obj = JSON.parse(await file.text()); } catch { badLines++; continue; }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.internal)) { badLines++; continue; }
    lines++;
    const md = obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : {};
    const sid = 'tgwebui:' + path.replace(/\.json$/i, '');
    obj.internal.forEach((pair, i) => {
      if (!Array.isArray(pair)) return;
      const user = typeof pair[0] === 'string' ? pair[0] : '', reply = typeof pair[1] === 'string' ? pair[1] : '';
      if (user === '<|BEGIN-VISIBLE-CHAT|>') return;
      const am = md['assistant_' + i] || {}, um = md['user_' + i] || {};
      const ts = parseTs(am.timestamp) || parseTs(um.timestamp);
      agg.add(dayKey(ts || file.lastModified), (c && c.platform) || 'text-generation-webui', String(am.model_name || 'text-generation-webui'),
        { in: estTok(user.length), out: estTok(reply.length), msgs: 1, est: 1 }, sid, ts ? ts.getHours() : undefined);
      msgs++;
    });
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: [], meta: { files: list.length, msgs, lines, badLines, addedIds: [] } };
}

