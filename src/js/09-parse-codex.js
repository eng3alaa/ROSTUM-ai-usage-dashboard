/* =================================================================
 * Folder-log parsers (Wave 1). Contract: async (files, onProgress, seen, connector, siblingFiles)
 *   → { rows, projects, meta: { files, msgs, lines, badLines, addedIds } }   (parseClaudeLogs' shape)
 * Whole-file JSON formats count files as `lines` and unparseable files as `badLines`.
 * ================================================================= */
/** OpenAI Codex CLI — ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. token_count events carry info.last_token_usage (THIS turn's
 *  usage — booked as-is whenever present) and info.total_token_usage (CUMULATIVE per session — the fallback when last_token_usage
 *  is absent: deltas between consecutive snapshots; an identical snapshot = a re-emitted event → skipped; a counter that goes
 *  backwards = new session/reset → counted from zero). cached_input_tokens ⊂ input_tokens, reasoning_output_tokens ⊂ output_tokens.
 *  Model = latest turn_context/session_meta model. Dedupe is WHOLE-FILE by sid (the rollout filename, which embeds the session
 *  UUID): the same rollout can appear under both sessions/ and archived_sessions/, and re-parsing it would double every row. */
async function parseCodexRollouts(files, onProgress, seen = new Set()) {
  const agg = makeAgg(); const proj = makeProjAgg('OpenAI Codex CLI'); const addedIds = [], dupIds = []; let msgs = 0; const k = { lines: 0, badLines: 0 };
  const tokUsage = (u) => u && typeof u === 'object' ? { in: finTok(+u.input_tokens || 0), cr: finTok(+u.cached_input_tokens || 0), out: finTok(+u.output_tokens || 0) } : null;   // a TokenUsage object → finite counts; null/absent → null
  const list = files.filter(f => /(^|\/)rollout-[^/]*\.jsonl$/i.test(f.path));
  for (let fi = 0; fi < list.length; fi++) {
    const { path, file } = list[fi];
    const sid = (path.split('/').pop() || '').replace(/\.jsonl$/i, '');
    if (seen.has(sid)) { dupIds.push(sid); if (onProgress) onProgress(fi + 1, list.length); continue; }   // same rollout re-appearing under sessions/ vs archived_sessions/ — whole file already counted
    seen.add(sid); addedIds.push(sid);
    let model = 'codex', prev = null, local = 0, cwd = null;   // cwd = session_meta / turn_context payload.cwd (latest wins) → Projects table (prettyProject, same as Claude Code)
    await eachJsonl(file, (o) => {
      const p = o.payload || {};
      if (o.type === 'session_meta' && p.model_provider != null) local = (isLocalProvider(p.model_provider) || /^oss$/i.test(String(p.model_provider).trim())) ? 1 : 0;   // built-in OSS provider ids ('ollama' / 'lmstudio'; 'oss' in older builds) — the model name alone never decides
      if (o.type === 'session_meta' || o.type === 'turn_context') { if (p.model) model = String(p.model); if (p.cwd) cwd = String(p.cwd); return; }
      if (o.type !== 'event_msg' || p.type !== 'token_count' || !p.info) return;
      // Codex's TokenUsageInfo carries BOTH total_token_usage (cumulative for the session) and last_token_usage (this turn only). Per event:
      // last_token_usage present → book it as-is (exact per turn, independent of the previous snapshot — so a RESUMED session, whose first
      // cumulative snapshot already includes everything an earlier rollout file counted, books just its own turn instead of a giant delta);
      // absent/null → delta of total_token_usage against the latest cumulative snapshot (older rollouts). Either way `prev` tracks the latest
      // cumulative so a later cumulative-only event still diffs correctly. cached_input_tokens ⊂ input_tokens (Responses API
      // input_tokens_details.cached_tokens) and reasoning_output_tokens ⊂ output_tokens (output_tokens_details.reasoning_tokens — Codex's own
      // total_tokens = input + output with no reasoning add-on), so output is booked once and reasoning is never added on top.
      const tu = tokUsage(p.info.total_token_usage), lu = tokUsage(p.info.last_token_usage);
      if (!tu && !lu) return;   // rate-limit-only event (info without usage)
      if (tu && prev && tu.in === prev.in && tu.cr === prev.cr && tu.out === prev.out) return;   // cumulative unchanged → Codex re-emitted the same snapshot (rate-limit refresh / heartbeat): nothing new, even though last_token_usage is repeated too
      let d;
      if (lu) { d = lu; prev = tu || { in: (prev ? prev.in : 0) + lu.in, cr: (prev ? prev.cr : 0) + lu.cr, out: (prev ? prev.out : 0) + lu.out }; }
      else {
        const base = prev && tu.in >= prev.in && tu.out >= prev.out ? prev : { in: 0, cr: 0, out: 0 };   // counter went backwards = reset → counted from zero
        d = { in: tu.in - base.in, cr: Math.max(0, tu.cr - base.cr), out: tu.out - base.out };
        prev = tu;
      }
      if (d.in <= 0 && d.out <= 0) return;   // no new usage (empty turn / duplicate line)
      const ts = o.timestamp ? new Date(o.timestamp) : null, okTs = ts && !isNaN(ts);
      const t = { in: Math.max(0, d.in - d.cr), cr: d.cr, out: Math.max(0, d.out), msgs: 1 };
      if (local) t.local = 1;
      agg.add(dayKey(okTs ? ts : file.lastModified), 'OpenAI Codex CLI', model, t, sid, okTs ? ts.getHours() : undefined);
      proj.add(prettyProject(cwd), model, t);
      msgs++;
    }, k);
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: proj.rows(), meta: { files: list.length, msgs, lines: k.lines, badLines: k.badLines, addedIds, dupIds } };
}

