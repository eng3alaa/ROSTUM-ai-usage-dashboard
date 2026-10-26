/** Continue.dev — ~/.continue/dev_data/<ver>/tokensGenerated.jsonl: one event per model response
 *  {promptTokens, generatedTokens, model, provider, timestamp}. No ids → no dedupe (each event is one request). */
async function parseContinueDevData(files, onProgress) {
  const agg = makeAgg(); let msgs = 0; const k = { lines: 0, badLines: 0 };
  const list = files.filter(f => /(^|\/)tokensGenerated\.jsonl$/i.test(f.path));
  for (let fi = 0; fi < list.length; fi++) {
    const { file } = list[fi];
    await eachJsonl(file, (o) => {
      if (o.promptTokens == null && o.generatedTokens == null) return;
      const ts = o.timestamp ? new Date(o.timestamp) : null, okTs = ts && !isNaN(ts);
      const t = { in: finTok(+o.promptTokens || 0), out: finTok(+o.generatedTokens || 0), msgs: 1 };
      if (isLocalProvider(o.provider)) t.local = 1;   // Continue's provider id ('ollama', 'lmstudio', 'llama.cpp', …) → free local inference
      agg.add(dayKey(okTs ? ts : file.lastModified), 'Continue.dev', String(o.model || 'unknown'), t, undefined, okTs ? ts.getHours() : undefined);
      msgs++;
    }, k);
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: [], meta: { files: list.length, msgs, lines: k.lines, badLines: k.badLines, addedIds: [] } };
}

/** Cline / Roo Code / Kilo Code — <globalStorage>/tasks/<taskId>/ui_messages.json (whole-file JSON array). Entries with
 *  say:'api_req_started' carry a JSON string in `text` {tokensIn, tokensOut, cacheWrites, cacheReads, cost[, apiProtocol]};
 *  entries still in flight have no token fields and are skipped. Model per request = the task_metadata.json
 *  model_usage[] entry (append-on-change series {ts, model_id, model_provider_id, mode} on the same epoch-ms clock as
 *  ui_messages ts; Plan/Act switching appends) with the greatest ts <= request ts — first entry for requests before the
 *  first switch, last entry when the request has no ts. task_metadata.json is found in the same task dir (handed in via
 *  siblingFiles — the driver's connector.siblings list, or `files` itself for direct callers). The dir→metadata index is
 *  built once per siblingFiles ARRAY (WeakMap by identity), so the driver's per-file calls do not rebuild it.
 *  tokensIn semantics: the dashboard's `in` = UNCACHED input (Pricing charges in/cw/cr separately). Roo Code stores
 *  tokensIn INCLUSIVE of cache tokens (OpenAI-protocol rows always; both protocols since Roo PR #8954, 2025-10-31);
 *  Cline's Anthropic-protocol rows are exclusive (additive), its OpenAI-compatible handlers store inclusive
 *  prompt_tokens (apiProtocol 'openai', or absent with a non-Anthropic provider). Inclusive rows → in = tokensIn -
 *  cacheReads - cacheWrites, but only when tokensIn >= cr + cw (a row that is evidently exclusive keeps its real input).
 *  Platform = connector.platform ('Cline' | 'Roo Code' | 'Kilo Code' — Plan 9 B5: Kilo is a Roo fork under its own card / globalStorage root). Dedupe by taskId:ts.
 *  meta.extCost = sum of the extension's own cost estimates (informational only). */
const _clineMetaIndex = new WeakMap();   // siblingFiles array → Map(dir → task_metadata.json File)
async function parseClineTasks(files, onProgress, seen = new Set(), c, siblingFiles) {
  const platform = (c && c.platform) || 'Cline';
  const agg = makeAgg(); const addedIds = [], dupIds = []; let msgs = 0, lines = 0, badLines = 0, extCost = 0;
  const list = files.filter(f => /(^|\/)ui_messages\.json$/i.test(f.path));
  const src = Array.isArray(siblingFiles) ? siblingFiles : files;
  let metaByDir = _clineMetaIndex.get(src);
  if (!metaByDir) {
    metaByDir = new Map();
    for (const f of src) { const m = f.path.match(/^(.*\/)?task_metadata\.json$/i); if (m) metaByDir.set(m[1] || '', f.file); }
    _clineMetaIndex.set(src, metaByDir);
  }
  for (let fi = 0; fi < list.length; fi++) {
    const { path, file } = list[fi];
    const dir = path.slice(0, path.lastIndexOf('/') + 1);
    const taskId = dir.split('/').filter(Boolean).pop() || (path.replace(/\.json$/i, ''));
    let usage = [];   // task_metadata.json model_usage[], sorted by ts (entries without ts sort first = "from the start")
    const mf = metaByDir.get(dir);
    if (mf) { try { const mo = JSON.parse(await mf.text()); const mu = mo && mo.model_usage; if (Array.isArray(mu)) usage = mu.filter(u => u && u.model_id).map(u => ({ ts: Number.isFinite(+u.ts) ? +u.ts : -Infinity, model: String(u.model_id), provider: String(u.model_provider_id || '').toLowerCase() })).sort((x, y) => x.ts - y.ts); } catch { badLines++; } }   // a corrupt task_metadata.json is counted, not swallowed — the task's requests still land as "unknown" (A0 #15)
    const usageAt = (t) => {   // greatest ts <= t; first entry before the first switch; last entry when t is missing
      if (!usage.length) return null;
      if (t == null || Number.isNaN(t)) return usage[usage.length - 1];
      let u = usage[0]; for (const e of usage) { if (e.ts <= t) u = e; else break; } return u;
    };
    const isRoo = !!c && /^(roo|kilo)$/.test(c.id);   // Roo Code and its fork Kilo Code (Plan 9 B5) store tokensIn inclusive of cache on both protocols
    let arr; try { arr = JSON.parse(await file.text()); } catch { badLines++; continue; }
    if (!Array.isArray(arr)) { badLines++; continue; }
    lines++;
    for (const m of arr) {
      if (!m || m.say !== 'api_req_started' || typeof m.text !== 'string') continue;
      let info; try { info = JSON.parse(m.text); } catch { badLines++; continue; }   // a request record whose text is not JSON is counted (A0 #15)
      if (!info || (info.tokensIn == null && info.tokensOut == null)) continue;   // request still in flight when the file was written
      if (m.ts != null) { const id = taskId + ':' + m.ts; if (seen.has(id)) { dupIds.push(id); continue; } seen.add(id); addedIds.push(id); }
      const ts = m.ts != null ? new Date(+m.ts) : null, okTs = ts && !isNaN(ts);
      const u = usageAt(okTs ? +m.ts : null), model = u ? u.model : 'unknown';
      const cw = finTok(+info.cacheWrites || 0), cr = finTok(+info.cacheReads || 0);
      let tin = finTok(+info.tokensIn || 0);
      const inclusive = isRoo || info.apiProtocol === 'openai' || (info.apiProtocol == null && !(u && /^(anthropic|claude-code|bedrock|vertex)$/.test(u.provider)));
      if (inclusive && tin >= cr + cw) tin -= cr + cw;
      const t = { in: tin, out: finTok(+info.tokensOut || 0), cw, cr, msgs: 1 };
      if (u && isLocalProvider(u.provider)) t.local = 1;   // model_provider_id 'ollama' / 'lmstudio' … → free local inference
      agg.add(dayKey(okTs ? ts : file.lastModified), platform, model, t, taskId, okTs ? ts.getHours() : undefined);
      extCost += Number.isFinite(+info.cost) ? +info.cost : 0;
      msgs++;
    }
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: [], meta: { files: list.length, msgs, lines, badLines, addedIds, dupIds, extCost } };
}

