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
