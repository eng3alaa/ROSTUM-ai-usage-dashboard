/** Gemini CLI — ~/.gemini/tmp/<hash>/chats/session-*.json (whole-file JSON). messages[] of type 'gemini' carry
 *  tokens {input, output, cached, thoughts, tool, total} (input includes cached; thoughts bill as output) — or,
 *  defensively, usageMetadata {promptTokenCount, candidatesTokenCount, cachedContentTokenCount, thoughtsTokenCount}.
 *  Dedupe by sessionId:messageId. */
async function parseGeminiCliSessions(files, onProgress, seen = new Set()) {
  const agg = makeAgg(); const proj = makeProjAgg('Gemini CLI'); const addedIds = [], dupIds = []; let msgs = 0, lines = 0, badLines = 0;
  const list = files.filter(f => /(^|\/)session-[^/]*\.json$/i.test(f.path));
  for (let fi = 0; fi < list.length; fi++) {
    const { path, file } = list[fi];
    let obj; try { obj = JSON.parse(await file.text()); } catch { badLines++; continue; }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.messages)) { badLines++; continue; }
    lines++;
    const sid = String(obj.sessionId || (path.split('/').pop() || '').replace(/\.json$/i, ''));
    // Projects table: Gemini CLI does not record the working directory — sessions live under tmp/<project_hash>/chats/, so the
    // hash folder stands in for the project (a cwd-like field is honoured if a future CLI version writes one).
    const hm = path.match(/(?:^|\/)tmp\/([^/]+)\/chats\//i);
    const cwd = obj.cwd || obj.projectRoot || obj.workspaceRoot || null;
    const hash = (obj.projectHash != null && String(obj.projectHash)) || (hm ? hm[1] : null);
    const projName = cwd ? prettyProject(String(cwd)) : hash ? '~/.gemini/tmp/' + hash : prettyProject(null);
    for (const m of obj.messages) {
      if (!m || m.type === 'user') continue;
      const um = m.usageMetadata;
      const t0 = m.tokens || (um ? { input: um.promptTokenCount, output: um.candidatesTokenCount, cached: um.cachedContentTokenCount, thoughts: um.thoughtsTokenCount, tool: um.toolUsePromptTokenCount } : null);
      if (!t0) continue;
      if (m.id != null) { const id = sid + ':' + m.id; if (seen.has(id)) { dupIds.push(id); continue; } seen.add(id); addedIds.push(id); }
      const input = finTok(+t0.input || 0), cached = finTok(+t0.cached || 0), output = finTok(+t0.output || 0), thoughts = finTok(+t0.thoughts || 0), tool = finTok(+t0.tool || 0);   // tool = toolUsePromptTokenCount: billed (uncached) input for built-in tools, not part of promptTokenCount
      const ts = m.timestamp ? new Date(m.timestamp) : null, okTs = ts && !isNaN(ts);
      const model = String(m.model || obj.model || 'gemini');
      const t = { in: Math.max(0, input - cached) + tool, cr: cached, out: output + thoughts, msgs: 1 };
      agg.add(dayKey(okTs ? ts : file.lastModified), 'Gemini CLI', model, t, sid, okTs ? ts.getHours() : undefined);
      proj.add(projName, model, t);
      msgs++;
    }
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: proj.rows(), meta: { files: list.length, msgs, lines, badLines, addedIds, dupIds } };
}

