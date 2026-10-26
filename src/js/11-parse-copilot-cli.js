/** GitHub Copilot CLI — ~/.copilot/session-state/<sid>/events.jsonl. Per-request `assistant.usage` events
 *  (data.model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens; camelCase or snake_case) are the
 *  source of truth; `session.shutdown` data.modelMetrics is used ONLY when a file has NO assistant.usage lines
 *  at all (older CLIs / crashed sessions), as one row per model with msgs = requests.count. Dedupe by sid:eventId
 *  — `sawUsage` counts every assistant.usage line seen BEFORE the dedupe check, so a file whose events are all
 *  already-seen duplicates (same session under two paths) still counts as "had usage" and skips the shutdown
 *  fallback, instead of re-adding the session's totals a second time. */
async function parseCopilotCliEvents(files, onProgress, seen = new Set()) {
  const agg = makeAgg(); const proj = makeProjAgg('GitHub Copilot'); const addedIds = [], dupIds = []; let msgs = 0; const k = { lines: 0, badLines: 0 };
  const list = files.filter(f => /(^|\/)events\.jsonl$/i.test(f.path));
  const num = (o, a, b) => finTok(+(o[a] ?? o[b] ?? 0) || 0);
  for (let fi = 0; fi < list.length; fi++) {
    const { path, file } = list[fi];
    const parts = path.split('/'); const sid = parts.length > 1 ? parts[parts.length - 2] : (path.replace(/\.jsonl$/i, ''));
    let sawUsage = 0, cwd = null; const shutdowns = [];   // cwd from session.start (data.context.cwd per the chronicle docs; flat data.cwd / gitRoot / repository accepted) → Projects table
    await eachJsonl(file, (o) => {
      const d = o.data || o.payload || o;
      const type = String(o.type || o.event || '');
      if (type === 'session.start') { const ctx = (d.context && typeof d.context === 'object') ? d.context : d; const w = ctx.cwd || ctx.workingDirectory || ctx.gitRoot || ctx.repository; if (w) cwd = String(w); return; }
      if (type === 'assistant.usage') {
        sawUsage++;
        if (o.id != null) { const id = sid + ':' + o.id; if (seen.has(id)) { dupIds.push(id); return; } seen.add(id); addedIds.push(id); }
        const ts = o.timestamp ? new Date(o.timestamp) : null, okTs = ts && !isNaN(ts);
        const model = String(d.model || 'copilot');
        const t = { in: num(d, 'inputTokens', 'input_tokens'), out: num(d, 'outputTokens', 'output_tokens'), cr: num(d, 'cacheReadTokens', 'cache_read_tokens'), cw: num(d, 'cacheWriteTokens', 'cache_write_tokens'), msgs: 1 };
        agg.add(dayKey(okTs ? ts : file.lastModified), 'GitHub Copilot', model, t, sid, okTs ? ts.getHours() : undefined);
        proj.add(prettyProject(cwd), model, t);
        msgs++;
      } else if (type === 'session.shutdown' && d.modelMetrics && typeof d.modelMetrics === 'object') {
        shutdowns.push({ ts: o.timestamp, metrics: d.modelMetrics });
      }
    }, k);
    if (!sawUsage) for (const s of shutdowns) {
      const ts = s.ts ? new Date(s.ts) : null, okTs = ts && !isNaN(ts);
      for (const [model, m] of Object.entries(s.metrics)) {
        const u = (m && m.usage) || {}, n = finTok(+((m && m.requests && m.requests.count) ?? 1) || 0) || 1;
        const t = { in: num(u, 'inputTokens', 'input_tokens'), out: num(u, 'outputTokens', 'output_tokens'), cr: num(u, 'cacheReadTokens', 'cache_read_tokens'), cw: num(u, 'cacheWriteTokens', 'cache_write_tokens'), msgs: n };
        agg.add(dayKey(okTs ? ts : file.lastModified), 'GitHub Copilot', model, t, sid, okTs ? ts.getHours() : undefined);
        proj.add(prettyProject(cwd), model, t);
        msgs += n;
      }
    }
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: proj.rows(), meta: { files: list.length, msgs, lines: k.lines, badLines: k.badLines, addedIds, dupIds } };
}

