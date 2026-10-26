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


/* =================================================================
 * Plan 9 B5 — Wave 3 coding tools: OpenCode, Goose, Devin CLI (SQLite stores read with readSqliteTable) and Amp (thread JSON). Same contract as the
 * parsers above. None of the four is installed on the research machine: shapes follow the research entries and the cited third-party parsers
 * (CodeBurn, agent-walker), so every field access is tolerant and a malformed row is COUNTED (badLines), never swallowed. A SQLite store's -wal
 * sidecar is never read (readSqliteTable) — rows still in the write-ahead log appear once the owning app checkpoints. Kilo Code (same task
 * files as Roo) reuses parseClineTasks under its own card. Lives here until the parts are renumbered (one file per vendor family — Plan 10).
 * ================================================================= */
/** Column accessor over a readSqliteTable result: has('name') / get(row, 'name') by lower-cased column name (null when the table lacks it). */
function sqliteColumns(table) {
  const idx = Object.fromEntries(table.columns.map((n, i) => [String(n).toLowerCase(), i]));
  return { has: (name) => idx[name] != null, get: (row, name) => { const i = idx[name]; return i == null ? null : row[i]; } };
}
/** readSqliteTable for a table that may be absent: null when sqlite_master has no such table; every other error (not a SQLite file, unsupported layout) propagates. */
function readOptionalSqliteTable(buf, name) {
  try { return readSqliteTable(buf, name); }
  catch (e) { if (/^table not found/.test(e.message || '')) return null; throw e; }
}
/** JSON text → object, or null when it is not valid JSON / not an object (the caller counts it). */
function parseJsonObject(text) {
  if (typeof text !== 'string') return null;   // a NULL or BLOB cell is not a JSON object either
  try { const o = JSON.parse(text); return o && typeof o === 'object' ? o : null; } catch { return null; }
}
const noTokens = (t) => !t.in && !t.out && !(t.cw || 0) && !(t.cr || 0);

/** OpenCode — opencode.db (≥ 1.2; opencode-<channel>.db for channel builds) plus the ≤ 1.1 legacy storage/message/<sessionID>/msg_*.json files kept
 *  beside it after the migration. Tables: 1.x `message`(id, session_id, time_created, data JSON) + `session`(id, directory); ≥ 2.0.3
 *  `session_message`(id, session_id, type, data JSON) + `session_v2`(id, directory) — whichever exist are read. An assistant message's data:
 *  modelID (v2: model.id), providerID (v2: model.providerID), path.cwd, time.created (epoch ms; else the row's time_created), tokens{input, output,
 *  reasoning, cache{read, write}}, cost. in = tokens.input (uncached), cr / cw = cache.read / write, out = tokens.output (reasoning ⊂ output per the
 *  AI SDK contract — never added on top). A local-runner providerID (ollama, lmstudio, …) → local:1. OpenCode's own `cost` (often 0) is summed into
 *  meta.extCost, informational only. Dedupe by message id — the migration keeps ids, so a legacy msg_*.json of a migrated message is a dupId, never a
 *  second row; sid = session id; project = path.cwd, else the session's directory. Rows without tokens (user / compaction rows, a message still
 *  streaming) are not malformed; data that is not a JSON object is counted (badLines). A .db without message tables throws (one unreadable file). */
const OPENCODE_DB = /(^|\/)opencode(-[^/]*)?\.db$/i;
const OPENCODE_LEGACY_MSG = /(^|\/)storage\/message\/[^/]+\/msg_[^/]*\.json$/i;
async function parseOpenCodeDb(files, onProgress, seen = new Set(), c) {
  const platform = (c && c.platform) || 'OpenCode';
  const ctx = { agg: makeAgg(), proj: makeProjAgg(platform), seen, platform, k: { msgs: 0, lines: 0, badLines: 0, extCost: 0, addedIds: [], dupIds: [] } };
  const list = files.filter(f => OPENCODE_DB.test(f.path) || OPENCODE_LEGACY_MSG.test(f.path));
  for (let fi = 0; fi < list.length; fi++) {
    const { path, file } = list[fi];
    if (OPENCODE_DB.test(path)) readOpenCodeDb(await file.arrayBuffer(), file.lastModified, ctx);
    else bookOpenCodeLegacyFile(await file.text(), file.lastModified, ctx);
    if (onProgress) onProgress(fi + 1, list.length);
  }
  const k = ctx.k;
  return { rows: ctx.agg.rows(), projects: ctx.proj.rows(), meta: { files: list.length, msgs: k.msgs, lines: k.lines, badLines: k.badLines, addedIds: k.addedIds, dupIds: k.dupIds, extCost: k.extCost } };
}
function bookOpenCodeLegacyFile(text, fallbackTs, ctx) {
  ctx.k.lines++;
  const o = parseJsonObject(text);
  if (!o) { ctx.k.badLines++; return; }
  bookOpenCodeMessage({ id: o.id, sid: o.sessionID != null ? String(o.sessionID) : '', data: o, dir: null }, fallbackTs, ctx);
}
/** Walks the message tables of one opencode.db (both layouts when present); the session tables give the directory fallback per session. */
function readOpenCodeDb(buf, fallbackTs, ctx) {
  const dirs = new Map();
  for (const name of ['session', 'session_v2']) {
    const t = readOptionalSqliteTable(buf, name); if (!t) continue;
    const col = sqliteColumns(t);
    for (const r of t.rows) dirs.set(String(col.get(r, 'id') ?? ''), col.get(r, 'directory'));
  }
  let tables = 0;
  for (const name of ['message', 'session_message']) {
    const t = readOptionalSqliteTable(buf, name); if (!t) continue;
    tables++;
    const col = sqliteColumns(t);
    for (const r of t.rows) {
      ctx.k.lines++;
      const data = parseJsonObject(col.get(r, 'data'));
      if (!data) { ctx.k.badLines++; continue; }
      const sid = String(col.get(r, 'session_id') ?? ''), created = +col.get(r, 'time_created');
      bookOpenCodeMessage({ id: col.get(r, 'id'), sid, data, dir: dirs.get(sid) }, Number.isFinite(created) && created > 0 ? created : fallbackTs, ctx);
    }
  }
  if (!tables) throw new Error('unsupported SQLite layout (no message / session_message table in this opencode.db)');
}
/** Books one OpenCode message (DB row or legacy JSON) — only those that carry a tokens object with some count. */
function bookOpenCodeMessage(m, fallbackTs, ctx) {
  const d = m.data, tok = d.tokens && typeof d.tokens === 'object' ? d.tokens : null;
  if (!tok) return;   // user / compaction rows and a reply still streaming carry no tokens
  const cache = tok.cache && typeof tok.cache === 'object' ? tok.cache : {};
  const t = { in: finTok(+tok.input || 0), out: finTok(+tok.output || 0), cr: finTok(+cache.read || 0), cw: finTok(+cache.write || 0), msgs: 1 };
  if (noTokens(t)) return;
  const created = d.time && Number.isFinite(+d.time.created) && +d.time.created > 0 ? +d.time.created : fallbackTs;
  const id = m.id != null ? String(m.id) : m.sid + ':' + created;
  if (ctx.seen.has(id)) { ctx.k.dupIds.push(id); return; }
  ctx.seen.add(id); ctx.k.addedIds.push(id);
  if (isLocalProvider((d.model && d.model.providerID) || d.providerID)) t.local = 1;
  const model = String((d.model && d.model.id) || d.modelID || 'unknown'), ts = new Date(created);
  ctx.agg.add(dayKey(ts), ctx.platform, model, t, m.sid || undefined, ts.getHours());
  ctx.proj.add(prettyProject((d.path && d.path.cwd) || m.dir), model, t);
  ctx.k.extCost += Number.isFinite(+d.cost) ? +d.cost : 0;
  ctx.k.msgs++;
}

/** Goose (CLI + Desktop) — sessions.db. Table sessions: one row per session with accumulated_input_tokens / accumulated_output_tokens (fallback
 *  input_tokens / output_tokens when the accumulated columns are NULL), provider_name, model_config (JSON; model_name), working_dir, created_at
 *  (SQLite CURRENT_TIMESTAMP text, UTC). Session-level only: no per-request rows, no cache split (cw / cr 0), no cost — the whole session lands on its
 *  created_at day and hour; msgs = the session's assistant rows in `messages` (1 when none are recorded). provider_name a local runner → local:1.
 *  Dedupe by session id (the same db under two paths); sid = session id; project = working_dir. A model_config that is not JSON is counted
 *  (badLines) and the session lands as "unknown"; a session with no tokens at all is skipped (empty, not malformed). */
async function parseGooseDb(files, onProgress, seen = new Set(), c) {
  const platform = (c && c.platform) || 'Goose';
  const ctx = { agg: makeAgg(), proj: makeProjAgg(platform), seen, platform, k: { msgs: 0, lines: 0, badLines: 0, addedIds: [], dupIds: [] } };
  const list = files.filter(f => /(^|\/)sessions\.db$/i.test(f.path));
  for (let fi = 0; fi < list.length; fi++) {
    const { file } = list[fi];
    const buf = await file.arrayBuffer();
    const sessions = readSqliteTable(buf, 'sessions'), col = sqliteColumns(sessions);
    if (!col.has('accumulated_input_tokens') && !col.has('input_tokens')) throw new Error('unsupported SQLite layout (sessions has no token columns)');
    Object.assign(ctx, { assistantRows: countGooseAssistantRows(buf), fallbackTs: file.lastModified });
    for (const r of sessions.rows) bookGooseSession(col, r, ctx);
    if (onProgress) onProgress(fi + 1, list.length);
  }
  const k = ctx.k;
  return { rows: ctx.agg.rows(), projects: ctx.proj.rows(), meta: { files: list.length, msgs: k.msgs, lines: k.lines, badLines: k.badLines, addedIds: k.addedIds, dupIds: k.dupIds } };
}
/** session id → number of assistant rows in `messages` (empty when the table is absent). */
function countGooseAssistantRows(buf) {
  const out = new Map();
  const t = readOptionalSqliteTable(buf, 'messages'); if (!t) return out;
  const col = sqliteColumns(t);
  for (const r of t.rows) {
    if (String(col.get(r, 'role') || '').toLowerCase() !== 'assistant') continue;
    const sid = String(col.get(r, 'session_id') ?? ''); out.set(sid, (out.get(sid) || 0) + 1);
  }
  return out;
}
function bookGooseSession(col, r, ctx) {
  ctx.k.lines++;
  const id = String(col.get(r, 'id') ?? '');
  const pick = (a, b) => { const v = col.get(r, a); return finTok(+(v != null ? v : col.get(r, b)) || 0); };
  const t = { in: pick('accumulated_input_tokens', 'input_tokens'), out: pick('accumulated_output_tokens', 'output_tokens'), msgs: ctx.assistantRows.get(id) || 1 };
  if (noTokens(t)) return;   // opened, nothing asked
  if (ctx.seen.has(id)) { ctx.k.dupIds.push(id); return; }
  ctx.seen.add(id); ctx.k.addedIds.push(id);
  if (isLocalProvider(col.get(r, 'provider_name'))) t.local = 1;
  const rawCfg = col.get(r, 'model_config'), cfg = parseJsonObject(rawCfg);
  if (rawCfg != null && !cfg) ctx.k.badLines++;
  const model = String((cfg && (cfg.model_name || cfg.model)) || 'unknown'), ts = sqliteTimestamp(col.get(r, 'created_at'), ctx.fallbackTs);
  ctx.agg.add(dayKey(ts), ctx.platform, model, t, id, ts.getHours());
  ctx.proj.add(prettyProject(col.get(r, 'working_dir')), model, t);
  ctx.k.msgs += t.msgs;
}

/** Devin CLI ("Devin for Terminal") — sessions.db. Table message_nodes: chat_message JSON per node {role, metadata{request_id, generation_model,
 *  created_at, metrics{input_tokens, cache_read_tokens, cache_creation_tokens[, output_tokens]}}, tool_calls[]} — third-party parsers place metrics
 *  under metadata, the research lists them at the top level: both are read. input_tokens excludes cache reads (additive). Devin's node metrics carry
 *  NO output count in current builds — out is booked only when an output_tokens field is present, so output understates. Retries are sibling nodes
 *  sharing request_id → one row per request (dedupe 'devin:<request_id>', else 'devin:node-<node_id>'). Model = metadata.generation_model, else the
 *  session's `model` column; time = metadata.created_at, else the node's created_at column; project = sessions.working_directory; sid = session id.
 *  sessions.metadata.total_acu_cost (ACUs — Devin's billing unit, not dollars) is summed into meta.acus, informational only. A chat_message or a
 *  sessions.metadata that is not JSON is counted (badLines); a node without metrics (a user turn) is skipped. */
async function parseDevinDb(files, onProgress, seen = new Set(), c) {
  const platform = (c && c.platform) || 'Devin CLI';
  const ctx = { agg: makeAgg(), proj: makeProjAgg(platform), seen, platform, k: { msgs: 0, lines: 0, badLines: 0, acus: 0, addedIds: [], dupIds: [] } };
  const list = files.filter(f => /(^|\/)sessions\.db$/i.test(f.path));
  for (let fi = 0; fi < list.length; fi++) {
    const { file } = list[fi];
    const buf = await file.arrayBuffer();
    Object.assign(ctx, { sessions: readDevinSessions(buf, ctx.k), fallbackTs: file.lastModified });
    const nodes = readSqliteTable(buf, 'message_nodes'), col = sqliteColumns(nodes);
    if (!col.has('chat_message')) throw new Error('unsupported SQLite layout (message_nodes has no chat_message column)');
    for (const r of nodes.rows) bookDevinNode(col, r, ctx);
    if (onProgress) onProgress(fi + 1, list.length);
  }
  const k = ctx.k;
  return { rows: ctx.agg.rows(), projects: ctx.proj.rows(), meta: { files: list.length, msgs: k.msgs, lines: k.lines, badLines: k.badLines, addedIds: k.addedIds, dupIds: k.dupIds, acus: k.acus } };
}
/** session id → { model, dir }; sums metadata.total_acu_cost into k.acus and counts a metadata cell that is not JSON. */
function readDevinSessions(buf, k) {
  const out = new Map();
  const t = readOptionalSqliteTable(buf, 'sessions'); if (!t) return out;
  const col = sqliteColumns(t);
  for (const r of t.rows) {
    const raw = col.get(r, 'metadata'), meta = parseJsonObject(raw);
    if (raw != null && !meta) k.badLines++;
    if (meta && Number.isFinite(+meta.total_acu_cost)) k.acus += +meta.total_acu_cost;
    out.set(String(col.get(r, 'id') ?? ''), { model: col.get(r, 'model'), dir: col.get(r, 'working_directory') });
  }
  return out;
}
function bookDevinNode(col, r, ctx) {
  ctx.k.lines++;
  const cm = parseJsonObject(col.get(r, 'chat_message'));
  if (!cm) { ctx.k.badLines++; return; }
  const meta = cm.metadata && typeof cm.metadata === 'object' ? cm.metadata : {};
  const metrics = [meta.metrics, cm.metrics].find(x => x && typeof x === 'object');
  if (!metrics) return;   // a user turn / a node without an LLM call
  const t = { in: finTok(+metrics.input_tokens || 0), cr: finTok(+metrics.cache_read_tokens || 0), cw: finTok(+metrics.cache_creation_tokens || 0), out: finTok(+metrics.output_tokens || 0), msgs: 1 };
  if (noTokens(t)) return;
  const id = 'devin:' + (meta.request_id != null ? String(meta.request_id) : 'node-' + String(col.get(r, 'node_id') ?? ctx.k.lines));
  if (ctx.seen.has(id)) { ctx.k.dupIds.push(id); return; }
  ctx.seen.add(id); ctx.k.addedIds.push(id);
  const sid = String(col.get(r, 'session_id') ?? ''), ses = ctx.sessions.get(sid) || {};
  const model = String(meta.generation_model || ses.model || 'unknown'), ts = sqliteTimestamp(meta.created_at ?? col.get(r, 'created_at'), ctx.fallbackTs);
  ctx.agg.add(dayKey(ts), ctx.platform, model, t, sid || undefined, ts.getHours());
  ctx.proj.add(prettyProject(ses.dir), model, t);
  ctx.k.msgs++;
}

/** Amp — <AMP_DATA_DIR>/threads/ *.json at any depth, one JSON document per thread (rewritten on every update; the T-<id>.json naming is unverified, so every
 *  .json under the pick is sniffed: an object with messages[] or usageLedger). Ledger path (preferred): usageLedger.events[] {id, timestamp (ISO or
 *  epoch ms), model, tokens{input, output, total}, toMessageId, credits} → in / out from tokens; cache from the billed message (messages[].messageId ==
 *  toMessageId) usage.cacheCreationInputTokens / cacheReadInputTokens (Anthropic-style, additive); a positive remainder of tokens.total after input +
 *  output + cache joins output (the CodeBurn rule — unverified on real files). Fallback (no ledger): assistant messages[].usage {inputTokens,
 *  outputTokens, cacheCreationInputTokens, cacheReadInputTokens} with the message's own model / timestamp ("unknown" / the file date when absent).
 *  `credits` is Amp's billing unit — summed into meta.credits, never converted to dollars (rows are priced at list prices). Dedupe '<threadId>:<event id>'
 *  (a repeated event in a rewritten file counts once); sid = thread id; no project (threads record no working directory). A file that is not JSON is
 *  counted (badLines); a JSON file that is not a thread (session.json) is counted in meta.skippedFiles, never an error. */
async function parseAmpThreads(files, onProgress, seen = new Set(), c) {
  const platform = (c && c.platform) || 'Amp';
  const ctx = { agg: makeAgg(), seen, platform, k: { msgs: 0, lines: 0, badLines: 0, credits: 0, skippedFiles: 0, addedIds: [], dupIds: [] } };
  const list = files.filter(f => /\.json$/i.test(f.path));
  for (let fi = 0; fi < list.length; fi++) {
    const { path, file } = list[fi];
    bookAmpThread(parseJsonObject(await file.text()), path.split('/').pop().replace(/\.json$/i, ''), file.lastModified, ctx);
    if (onProgress) onProgress(fi + 1, list.length);
  }
  const k = ctx.k;
  return { rows: ctx.agg.rows(), projects: [], meta: { files: list.length, msgs: k.msgs, lines: k.lines, badLines: k.badLines, addedIds: k.addedIds, dupIds: k.dupIds, credits: k.credits, skippedFiles: k.skippedFiles } };
}
function bookAmpThread(thread, fileStem, fallbackTs, ctx) {
  ctx.k.lines++;
  if (!thread) { ctx.k.badLines++; return; }
  const messages = Array.isArray(thread.messages) ? thread.messages : null;
  const events = thread.usageLedger && Array.isArray(thread.usageLedger.events) ? thread.usageLedger.events : null;
  if (!messages && !events) { ctx.k.skippedFiles++; return; }
  const tctx = { ...ctx, tid: String(thread.id || fileStem), fallbackTs };
  if (events) bookAmpLedger(events, messages || [], tctx); else bookAmpMessages(messages, tctx);
}
const ampUsage = (u) => u && typeof u === 'object' ? { in: finTok(+u.inputTokens || 0), out: finTok(+u.outputTokens || 0), cw: finTok(+u.cacheCreationInputTokens || 0), cr: finTok(+u.cacheReadInputTokens || 0) } : null;
const ampWhen = (v, fallback) => { const d = v != null ? new Date(v) : null; return d && !isNaN(d) ? d : new Date(fallback); };   // ISO text or epoch ms
/** One row per ledger event / message — booking = { t, model, ts }; returns false when the id was already counted. */
function bookAmpRow(ctx, id, booking) {
  if (ctx.seen.has(id)) { ctx.k.dupIds.push(id); return false; }
  ctx.seen.add(id); ctx.k.addedIds.push(id);
  const { t, model, ts } = booking;
  ctx.agg.add(dayKey(ts), ctx.platform, model, { ...t, msgs: 1 }, ctx.tid, ts.getHours());
  ctx.k.msgs++;
  return true;
}
function bookAmpLedger(events, messages, ctx) {
  const byId = new Map(messages.filter(m => m && m.messageId != null).map(m => [String(m.messageId), m]));
  for (let i = 0; i < events.length; i++) {
    const e = events[i], tok = e && e.tokens;
    if (!tok || typeof tok !== 'object') { ctx.k.badLines++; continue; }
    const linked = ampUsage((byId.get(String(e.toMessageId)) || {}).usage) || { cw: 0, cr: 0 };
    const t = { in: finTok(+tok.input || 0), out: finTok(+tok.output || 0), cw: linked.cw, cr: linked.cr };
    const unaccounted = finTok(+tok.total || 0) - t.in - t.out - t.cw - t.cr;
    if (unaccounted > 0) t.out += unaccounted;
    const added = bookAmpRow(ctx, ctx.tid + ':' + (e.id != null ? String(e.id) : 'event-' + i), { t, model: String(e.model || 'unknown'), ts: ampWhen(e.timestamp, ctx.fallbackTs) });
    if (added && Number.isFinite(+e.credits)) ctx.k.credits += +e.credits;
  }
}
function bookAmpMessages(messages, ctx) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || (m.role != null && m.role !== 'assistant')) continue;
    const t = ampUsage(m.usage);
    if (!t) continue;   // a reply without a usage block
    bookAmpRow(ctx, ctx.tid + ':' + (m.messageId != null ? String(m.messageId) : 'message-' + i), { t, model: String(m.model || 'unknown'), ts: ampWhen(m.timestamp, ctx.fallbackTs) });
  }
}
/* =================================================================
 * Plan 9 B6 — folder-log parsers B: Zed (threads.db — SQLite rows whose data cell is a zstd frame of the thread JSON) and GitHub Copilot Chat's OTel file
 * exporter (JSON lines of spans carrying gen_ai.usage.*). Same contract as the parsers above. Zed is not installed on the research machine (source-based:
 * CodeBurn's zed.md + Zed commit #31741); the OTel attribute names are confirmed by the VS Code docs, the line layout is not documented (both attribute forms
 * are accepted). Appended here like B5's parsers until the parts are renumbered (one file per vendor family — Plan 10).
 * ================================================================= */
/** Zed Agent Panel — threads/threads.db: table threads(id, summary, updated_at, data_type 'zstd' | 'json', data). The thread JSON (SerializedThread 0.1–0.3) carries
 *  model{provider, model}, messages[], request_token_usage{<user message id>: {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}},
 *  cumulative_token_usage (same shape, the whole thread) and initial_project_snapshot.worktree_snapshots[].worktree_path. One row per thread: cumulative_token_usage
 *  when present (request_token_usage does not cover every request), else the request map summed; msgs = assistant messages (else requests, else 1); day = the row's
 *  updated_at (no per-request time exists — approximate); sid = thread id; project = the first worktree; a local provider (ollama, lmstudio) → local:1. zstd rows are
 *  decoded in the page when DecompressionStream knows zstd; otherwise the file must come through the collector's decode=zstd (one JSON line per row — accepted here
 *  too), and a raw store read on a browser without zstd throws "needs the local collector on this browser" (one unreadable file, never zero rows). A row whose blob
 *  does not decode / parse is counted (badLines); a thread with no tokens is skipped; dedupe by thread id (the same store under two paths). */
async function parseZedThreads(files, onProgress, seen = new Set(), c) {
  const platform = (c && c.platform) || 'Zed';
  const ctx = { agg: makeAgg(), proj: makeProjAgg(platform), seen, platform, k: { msgs: 0, lines: 0, badLines: 0, addedIds: [], dupIds: [] } };
  const list = files.filter(f => /(^|\/)threads\.db$/i.test(f.path));
  for (let fi = 0; fi < list.length; fi++) {
    const { file } = list[fi];
    ctx.fallbackTs = file.lastModified;
    for (const row of await zedThreadRows(new Uint8Array(await file.arrayBuffer()))) bookZedRow(row, ctx);
    if (onProgress) onProgress(fi + 1, list.length);
  }
  const k = ctx.k;
  return { rows: ctx.agg.rows(), projects: ctx.proj.rows(), meta: { files: list.length, msgs: k.msgs, lines: k.lines, badLines: k.badLines, addedIds: k.addedIds, dupIds: k.dupIds } };
}
const isSqliteBytes = (u8) => u8.length >= 16 && new TextDecoder('latin1').decode(u8.subarray(0, 15)) === 'SQLite format 3';
/** The thread rows of one threads.db read — the raw SQLite store, or the collector's decoded JSON lines ({ id, summary, updated_at, data_type: 'json', data } |
 *  { id, …, error }) → [{ id, updated_at, thread: object | null }] (null = undecodable, counted by the caller). */
async function zedThreadRows(bytes) {
  if (isSqliteBytes(bytes)) {
    const t = readSqliteTable(bytes, 'threads'), col = sqliteColumns(t);
    return Promise.all(t.rows.map(async (r) => ({ id: col.get(r, 'id'), updated_at: col.get(r, 'updated_at'), thread: await decodeZedThread(col.get(r, 'data_type'), col.get(r, 'data')) })));
  }
  const rows = [];
  for (const line of new TextDecoder('utf-8').decode(bytes).split('\n')) {
    if (!line.trim()) continue;
    const o = parseJsonObject(line);
    rows.push({ id: o && o.id, updated_at: o && o.updated_at, thread: o && o.error == null && typeof o.data === 'string' ? parseJsonObject(o.data) : null });
  }
  return rows;
}
/** One data cell → the thread object, or null when it cannot be decoded (counted as one bad row). A zstd cell on a browser without zstd throws instead — the
 *  whole file is then one unreadable file whose reason names the collector. */
async function decodeZedThread(dataType, cell) {
  if (String(dataType || '').toLowerCase() !== 'zstd') return parseJsonObject(cell instanceof Uint8Array ? new TextDecoder('utf-8').decode(cell) : cell);
  if (!(cell instanceof Uint8Array)) return null;
  if (!hasZstdDecompression()) throw new Error('needs the local collector on this browser — Zed thread data is zstd-compressed and this browser cannot decompress zstd (the collector decodes it behind decode=zstd)');
  let plain;
  try { plain = await zstdDecompressBounded(cell); } catch { return null; }   // a corrupt or oversized frame is one bad row (counted), never a failed file
  return parseJsonObject(new TextDecoder('utf-8').decode(plain));
}
function bookZedRow(row, ctx) {
  ctx.k.lines++;
  const th = row.thread;
  if (!th) { ctx.k.badLines++; return; }
  const t = zedThreadTokens(th);
  if (!t) return;   // an empty thread (opened, nothing asked) — not malformed
  const id = String(row.id ?? th.id ?? '');
  if (ctx.seen.has(id)) { ctx.k.dupIds.push(id); return; }
  ctx.seen.add(id); ctx.k.addedIds.push(id);
  const model = th.model && typeof th.model === 'object' ? th.model : {};
  if (isLocalProvider(model.provider)) t.local = 1;
  const name = String(model.model || 'unknown'), ts = sqliteTimestamp(row.updated_at ?? th.updated_at, ctx.fallbackTs), worktree = zedWorktree(th);
  ctx.agg.add(dayKey(ts), ctx.platform, name, t, id, ts.getHours());
  if (worktree) ctx.proj.add(prettyProject(worktree), name, t);
  ctx.k.msgs += t.msgs;
}
const zedUsage = (u) => u && typeof u === 'object' ? { in: finTok(+u.input_tokens || 0), out: finTok(+u.output_tokens || 0), cw: finTok(+u.cache_creation_input_tokens || 0), cr: finTok(+u.cache_read_input_tokens || 0) } : null;
/** The thread's tokens: cumulative_token_usage, else the request_token_usage map summed; msgs = assistant messages, else requests, else 1. null when nothing to book. */
function zedThreadTokens(th) {
  const requests = th.request_token_usage && typeof th.request_token_usage === 'object' ? Object.values(th.request_token_usage).map(zedUsage).filter(Boolean) : [];
  const t = zedUsage(th.cumulative_token_usage) || requests.reduce((a, u) => ({ in: a.in + u.in, out: a.out + u.out, cw: a.cw + u.cw, cr: a.cr + u.cr }), { in: 0, out: 0, cw: 0, cr: 0 });
  if (noTokens(t)) return null;
  const replies = Array.isArray(th.messages) ? th.messages.filter(m => m && String(m.role).toLowerCase() === 'assistant').length : 0;
  t.msgs = replies || requests.length || 1;
  return t;
}
/** The thread's first worktree path (initial_project_snapshot.worktree_snapshots[].worktree_path | abs_path | path), else a top-level project / worktree string, else null. */
function zedWorktree(th) {
  const snap = th.initial_project_snapshot, list = snap && Array.isArray(snap.worktree_snapshots) ? snap.worktree_snapshots : [];
  const w = list.find(x => x && (x.worktree_path || x.abs_path || x.path));
  if (w) return String(w.worktree_path || w.abs_path || w.path);
  return typeof th.project === 'string' ? th.project : typeof th.worktree === 'string' ? th.worktree : null;
}

/** GitHub Copilot Chat (VS Code) — the OTel file exporter (github.copilot.chat.otel.enabled + exporterType "file" + outfile): JSON lines of spans / events / metrics.
 *  Each `chat` span (one per LLM call) carries gen_ai.request.model / gen_ai.response.model and gen_ai.usage.input_tokens, output_tokens, cache_read.input_tokens,
 *  cache_creation.input_tokens, reasoning.output_tokens. Attributes come as a map or as the OTLP {key, value:{intValue|stringValue}} array; a line may also be an
 *  OTLP batch (resourceSpans[].scopeSpans[].spans[]). Booked per span: in = input_tokens − cache_read (the exporter's input count is cache-inclusive per the
 *  agent-traces schema — source-based), cw = cache_creation, out = output_tokens (reasoning ⊂ output), model = response model, else request model, else 'copilot';
 *  day / hour from the start time (unix nanos, hrtime [s, ns], ISO or epoch), else the file date; sid = the session id attribute when present. Never a row:
 *  `invoke_agent` root spans (session totals — meta.sessionSpans), gen_ai.client.* / copilot_chat.* events (meta.skippedRecords — the span already carries the usage),
 *  metric lines (no usage attributes). Dedupe by span id (the exporter appends; a rewritten file repeats spans); platform GitHub Copilot (shared with the CLI card). */
const OTEL_USAGE = { in: 'gen_ai.usage.input_tokens', out: 'gen_ai.usage.output_tokens', cr: 'gen_ai.usage.cache_read.input_tokens', cw: 'gen_ai.usage.cache_creation.input_tokens' };
const OTEL_EVENT_NAME = /^(gen_ai\.client\.|copilot_chat\.)/;   // event / metric records that carry the span's own usage again
async function parseCopilotOtelJsonl(files, onProgress, seen = new Set(), c) {
  const platform = (c && c.platform) || 'GitHub Copilot';
  const ctx = { agg: makeAgg(), seen, platform, k: { msgs: 0, lines: 0, badLines: 0, sessionSpans: 0, skippedRecords: 0, addedIds: [], dupIds: [] } };
  const list = files.filter(f => /\.(jsonl|ndjson)$/i.test(f.path));
  for (let fi = 0; fi < list.length; fi++) {
    const { file } = list[fi];
    ctx.fallbackTs = file.lastModified;
    await eachJsonl(file, (o) => { for (const span of otelSpansOf(o)) bookOtelSpan(span, ctx); }, ctx.k);
    if (onProgress) onProgress(fi + 1, list.length);
  }
  const k = ctx.k;
  return { rows: ctx.agg.rows(), projects: [], meta: { files: list.length, msgs: k.msgs, lines: k.lines, badLines: k.badLines, addedIds: k.addedIds, dupIds: k.dupIds, sessionSpans: k.sessionSpans, skippedRecords: k.skippedRecords } };
}
/** The span-like records of one exporter line: the line itself, or every span of an OTLP batch (resourceSpans[].scopeSpans[].spans[]). */
function otelSpansOf(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return [];
  if (!Array.isArray(o.resourceSpans)) return [o];
  const out = [];
  for (const rs of o.resourceSpans) for (const ss of (rs && Array.isArray(rs.scopeSpans) ? rs.scopeSpans : [])) for (const s of (ss && Array.isArray(ss.spans) ? ss.spans : [])) if (s && typeof s === 'object') out.push(s);
  return out;
}
/** A span's attributes as a plain object — the SDK map form, or the OTLP [{key, value:{intValue|doubleValue|stringValue|boolValue}}] array. */
function otelAttrs(span) {
  const a = span.attributes;
  if (!Array.isArray(a)) return a && typeof a === 'object' ? a : {};
  const out = {};
  for (const kv of a) {
    if (!kv || typeof kv.key !== 'string') continue;
    const v = kv.value;
    out[kv.key] = v && typeof v === 'object' ? (v.intValue ?? v.doubleValue ?? v.stringValue ?? v.boolValue) : v;
  }
  return out;
}
const otelHasUsage = (attrs) => attrs[OTEL_USAGE.in] != null || attrs[OTEL_USAGE.out] != null;
const otelSpanId = (span) => span.spanId ?? span.span_id ?? (span.context && typeof span.context === 'object' ? span.context.spanId : undefined);
function bookOtelSpan(span, ctx) {
  const attrs = otelAttrs(span);
  if (!otelHasUsage(attrs)) return;   // a metric line, a span without usage
  const name = String(span.name || '');
  if (/^invoke_agent/.test(name)) { ctx.k.sessionSpans++; return; }   // the root span repeats the session's totals
  if (OTEL_EVENT_NAME.test(name)) { ctx.k.skippedRecords++; return; }
  const id = otelSpanId(span);
  if (id != null) { const key = String(id); if (ctx.seen.has(key)) { ctx.k.dupIds.push(key); return; } ctx.seen.add(key); ctx.k.addedIds.push(key); }
  const num = (k) => finTok(+attrs[k] || 0);
  const cr = num(OTEL_USAGE.cr), t = { in: Math.max(0, num(OTEL_USAGE.in) - cr), out: num(OTEL_USAGE.out), cr, cw: num(OTEL_USAGE.cw), msgs: 1 };
  const model = String(attrs['gen_ai.response.model'] || attrs['gen_ai.request.model'] || 'copilot'), ts = otelStart(span, ctx.fallbackTs);
  const sid = attrs['copilot_chat.session.id'] || attrs['gen_ai.conversation.id'];
  ctx.agg.add(dayKey(ts), ctx.platform, model, t, sid != null ? String(sid) : undefined, ts.getHours());
  ctx.k.msgs++;
}
/** A span's start → Date: startTimeUnixNano / timeUnixNano (digit string or number), startTime / timestamp / time as hrtime [s, ns], ISO text or epoch ms; else the file date. */
function otelStart(span, fallback) {
  const v = span.startTimeUnixNano ?? span.timeUnixNano ?? span.startTime ?? span.timestamp ?? span.time;
  if (Array.isArray(v) && Number.isFinite(+v[0])) return new Date(+v[0] * 1000 + Math.floor((+v[1] || 0) / 1e6));
  if ((typeof v === 'string' && /^\d{16,20}$/.test(v)) || (typeof v === 'number' && v > 1e15)) return new Date(Number(BigInt(String(v).split('.')[0]) / 1000000n));
  const d = v != null ? new Date(v) : null;
  return d && !isNaN(d) ? d : new Date(fallback);
}

