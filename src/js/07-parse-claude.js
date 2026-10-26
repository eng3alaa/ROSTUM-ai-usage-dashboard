/* =================================================================
 * Part 2: parsers (local JSONL logs, chat exports, CSV, API payloads)
 *         + direct API fetchers with pagination
 * ================================================================= */

/* ---------- generic aggregation helper ---------- */
function makeAgg() {
  const map = new Map(); // day / platform / model [/ sid] [/ hour] -> bundle
  return {
    add(d, platform, model, t, sid, hour) {
      if (!d) return;
      const hk = (hour == null || Number.isNaN(hour)) ? '' : String(hour);
      const key = d + '\u0001' + platform + '\u0001' + model + '\u0001' + (sid || '') + '\u0001' + hk + '\u0001' + (t.local ? '1' : '');
      let b = map.get(key);
      if (!b) {
        b = { d, platform, model, in: 0, cw: 0, cr: 0, out: 0, msgs: 0, est: t.est ? 1 : 0 };
        if (sid) b.sid = sid;
        if (hk !== '') b.hour = hour;
        if (t.local) b.local = 1;   // free local inference through a coding tool (provider hint) — Pricing.cost → $0
        map.set(key, b);
      }
      b.in += t.in || 0; b.cw += t.cw || 0; b.cr += t.cr || 0; b.out += t.out || 0; b.msgs += t.msgs || 0;
      if (t.est) b.est = 1;
    },
    rows() { return [...map.values()]; }
  };
}

/* =================================================================
 * 1) Local Claude Code / Desktop logs (.claude folder → projects/*.jsonl)
 * ================================================================= */
async function* readLines(file) {
  const reader = file.stream().getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { yield buf.slice(0, i); buf = buf.slice(i + 1); }
  }
  buf += dec.decode();
  if (buf.trim()) yield buf;
}

// Plan 9 B1: outputs / uploads / .project-cache / session-env / backups are a Cowork session's own files (what the task wrote), never transcripts
const SKIP_DIRS = /^(todos|statsig|shell-snapshots|ide|plugins|skills|commands|hooks|downloads|cache|node_modules|\.git|outputs|uploads|uploads-tmp|\.project-cache|session-env|backups)$/i;
async function collectJsonlFromHandle(dirHandle, path = '', out = [], depth = 0) {
  // depth 10 reaches <Claude app folder>/local-agent-mode-sessions/<org>/<user>/<session>/.claude/projects/<slug>/<sid>/subagents/*.jsonl (Plan 9 B1)
  if (depth > 10 || out.length > 20000) return out;
  const dirs = [], files = [];
  for await (const [name, h] of dirHandle.entries()) {
    if (h.kind === 'directory') dirs.push([name, h]);
    else if (name.endsWith('.jsonl')) files.push([name, h]);
  }
  for (const [name, h] of files) {
    try { out.push({ path: path + name, file: await h.getFile() }); } catch { out.unreadable = (out.unreadable || 0) + 1; }   // locked / vanished file: counted (parseFolderCached folds it into badFiles), never fatal (A0 #13)
  }
  // if this level has a "projects" (or ".claude") dir, that's the target — don't crawl siblings
  const target = dirs.find(([n]) => /^projects$/i.test(n)) || dirs.find(([n]) => /^\.claude$/i.test(n));
  const toWalk = target ? [target] : dirs.filter(([n]) => !SKIP_DIRS.test(n));
  for (const [name, h] of toWalk) {
    await collectJsonlFromHandle(h, path + name + '/', out, depth + 1);
  }
  return out;
}

function prettyProject(raw) {
  if (!raw) return '(unknown project)';
  let s = String(raw).replace(/\\/g, '/');
  s = s.replace(/^[A-Za-z]:\/(Users|home)\/[^/]+\//i, '~/');
  s = s.replace(/^\/(Users|home)\/[^/]+\//i, '~/');
  return s.length > 60 ? '…' + s.slice(-59) : s;
}

/** Project×model bundles for the Projects table — the row shape parseClaudeLogs' projMap emits
 *  ({ project, model, in, cw, cr, out, msgs }) plus `platform` and `local: 1` when the request ran on a local
 *  provider (Pricing.cost honours both). Nested Maps (no separator bytes); parseFolderCached merges the rows of
 *  one connector across files. Used by the Codex / Gemini CLI / Copilot CLI / Junie parsers. */
function makeProjAgg(platform) {
  const byProj = new Map();   // project → Map(model → bundle)
  return {
    add(project, model, t) {
      let m = byProj.get(project); if (!m) { m = new Map(); byProj.set(project, m); }
      let b = m.get(model);
      if (!b) { b = { project, model, platform, in: 0, cw: 0, cr: 0, out: 0, msgs: 0 }; m.set(model, b); }
      b.in += t.in || 0; b.cw += t.cw || 0; b.cr += t.cr || 0; b.out += t.out || 0; b.msgs += t.msgs || 0;
      if (t.local) b.local = 1;
    },
    rows() { const out = []; for (const m of byProj.values()) out.push(...m.values()); return out; },
  };
}

/* ---------- Plan 9 B1: Claude Desktop Cowork ----------
 * Cowork (the desktop app's agent mode) keeps each session under <Claude app folder>/local-agent-mode-sessions/<org>/<user>/<session>/:
 * .claude/projects/<slug>/<sid>.jsonl (+ <sid>/subagents/agent-*.jsonl) are ordinary Claude Code transcripts — every line carries
 * entrypoint 'local-agent' and sessionId — and audit.jsonl is Anthropic's own record of the session: assistant mirror lines (request_id
 * instead of requestId) plus one `result` line per turn with total_cost_usd. Transcripts become rows; the audit becomes meta.cowork. */
const COWORK_AUDIT = /(^|\/)audit\.jsonl$/i;
const COWORK_PATH = /(^|\/)[^/]+\/\.claude\/projects\//i;   // a session folder in front of ".claude/projects/" — a ~/.claude or home-folder pick has none
const isCoworkLine = (obj) => obj.entrypoint === 'local-agent';
/** Cowork sessions run in a sandbox folder under local-agent-mode-sessions — one name for them all, not one truncated path per session. */
const coworkProject = (cwdOrSlug) => /local-agent-mode-sessions/i.test(String(cwdOrSlug || '')) ? 'Cowork (Claude Desktop)' : prettyProject(cwdOrSlug);

/** One assistant line's message.usage → token bundle: finite non-negative numbers only (A0 #14); cache_creation may arrive as a per-TTL object. */
function claudeUsageTokens(u) {
  let cw = u.cache_creation_input_tokens;
  if (cw == null && u.cache_creation && typeof u.cache_creation === 'object') {
    cw = Object.values(u.cache_creation).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
  }
  return { in: finTok(+u.input_tokens || 0), cw: finTok(+cw || 0), cr: finTok(+u.cache_read_input_tokens || 0), out: finTok(+u.output_tokens || 0), msgs: 1 };
}

/** The shared state of one parseClaudeLogs call: aggregation, line counters, message-id claims against `seen`, Cowork findings. */
function claudeParseContext(seen) {
  const agg = makeAgg(), projMap = new Map(), addedIds = [], dupIds = [];   // dupIds: ids skipped because `seen` already held them (parseFolderCached keeps them on the cache entry)
  const cowork = { sids: new Set(), reported: {}, results: 0, dupResults: 0, badResults: 0 };
  const ctx = { agg, cowork, msgs: 0, lines: 0, badLines: 0,
    /** → the parsed object, or null for a blank line (not malformed) or a malformed one (counted) */
    parseLine(line) {
      if (!line.trim()) return null;   // blank, whitespace-only, or CR-only (Windows CRLF logs) — not malformed
      ctx.lines++;
      if (line[0] !== '{') { ctx.badLines++; return null; }   // has content but isn't even JSON-object-shaped — malformed
      try { return JSON.parse(line); } catch { ctx.badLines++; return null; }
    },
    /** false when `seen` already holds the message (a streamed block, a copy of the file) */
    claimId(id) {
      if (id === ':') return true;
      if (seen.has(id)) { dupIds.push(id); return false; }
      seen.add(id); addedIds.push(id); return true;
    },
    addProject(project, model, t) {
      const pk = project + '\u0001' + model;
      let pb = projMap.get(pk);
      if (!pb) { pb = { project, model, in: 0, cw: 0, cr: 0, out: 0, msgs: 0 }; projMap.set(pk, pb); }
      pb.in += t.in; pb.cw += t.cw; pb.cr += t.cr; pb.out += t.out; pb.msgs += 1;
    },
    result(files) {   // keep project×model rows raw — cost is computed at render time with live prices
      const meta = { files, msgs: ctx.msgs, lines: ctx.lines, badLines: ctx.badLines, addedIds, dupIds };
      if (cowork.sids.size || cowork.results || cowork.dupResults || cowork.badResults) meta.cowork = { ...cowork, sids: [...cowork.sids] };
      return { rows: agg.rows(), projects: [...projMap.values()], meta };
    } };
  return ctx;
}

/** One transcript (Claude Code or Cowork) → rows. sid = the line's sessionId when present (a subagent transcript names its parent session —
 *  the session Cowork's audit prices), else the file basename (older logs). A Cowork transcript's sids are recorded for the audit comparison. */
async function parseClaudeTranscript(path, file, ctx) {
  const m = path.match(/(?:^|\/)projects\/([^/]+)\//);   // project dir name = segment after "projects/"
  const projectDir = m ? m[1] : null, baseSid = (path.split('/').pop() || '').replace(/\.jsonl$/i, '');
  const fileSids = new Set(); let projectCwd = null, cowork = COWORK_PATH.test(path);
  for await (const line of readLines(file)) {
    const obj = ctx.parseLine(line); if (!obj) continue;
    if (!projectCwd && obj.cwd) projectCwd = obj.cwd;
    if (isCoworkLine(obj)) cowork = true;
    if (obj.type !== 'assistant' || !obj.message || !obj.message.usage) continue;
    const model = obj.message.model || 'unknown';
    if (model === '<synthetic>') continue;
    if (!ctx.claimId((obj.message.id || '') + ':' + (obj.requestId || ''))) continue;
    const sid = typeof obj.sessionId === 'string' && obj.sessionId ? obj.sessionId : baseSid;
    const t = claudeUsageTokens(obj.message.usage), ts = obj.timestamp ? new Date(obj.timestamp) : null;
    ctx.agg.add(dayKey(ts || file.lastModified), 'Claude Code/Desktop', model, t, sid, ts && !isNaN(ts) ? ts.getHours() : undefined);
    ctx.addProject(cowork ? coworkProject(projectCwd || projectDir) : prettyProject(projectCwd || projectDir), model, t);
    fileSids.add(sid); ctx.msgs++;
  }
  if (cowork) fileSids.forEach(sid => ctx.cowork.sids.add(sid));
}

/** <session>/audit.jsonl — Anthropic's own record of a Cowork session. Only `result` lines are read (one per turn: uuid, session_id,
 *  total_cost_usd, timestamp) into ctx.cowork.reported[sid] = { usd, d: last day, days: { d: usd } } — NEVER rows (the audit's assistant
 *  lines mirror the transcript under request_id, so counting them would double every message) and never Store.billed (a flat plan is not a
 *  bill). A result written twice (same uuid) counts once; one without a session or a numeric cost is counted as bad and surfaced, never $0. */
async function parseCoworkAudit(file, ctx) {
  const seenResults = new Set(), findings = ctx.cowork;
  for await (const line of readLines(file)) {
    const obj = ctx.parseLine(line); if (!obj || obj.type !== 'result') continue;
    const sid = obj.session_id, usd = Number(obj.total_cost_usd);
    if (typeof sid !== 'string' || !sid || !Number.isFinite(usd) || usd < 0) { findings.badResults++; continue; }
    const key = typeof obj.uuid === 'string' && obj.uuid ? obj.uuid : sid + ':' + obj.timestamp + ':' + usd;
    if (seenResults.has(key)) { findings.dupResults++; continue; }
    seenResults.add(key); findings.results++;
    const ts = obj.timestamp ? new Date(obj.timestamp) : null, d = dayKey(ts && !isNaN(ts) ? ts : file.lastModified);
    const session = findings.reported[sid] || (findings.reported[sid] = { usd: 0, d: '', days: {} });
    session.usd += usd; session.days[d] = (session.days[d] || 0) + usd; if (d > session.d) session.d = d;
  }
}

/** files: [{path, file}] → aggregated usage. Transcripts (…/projects/… .jsonl) become rows; a Cowork session's audit.jsonl becomes
 *  meta.cowork (present only when a Cowork transcript or audit was read): { sids: [Cowork session ids seen in rows], reported: { sid: { usd,
 *  d, days } }, results, dupResults, badResults }. parseClaudeLogsCached turns it into Store.sources.local.meta.reported (coworkReported). */
async function parseClaudeLogs(files, onProgress, seen = new Set()) {
  const ctx = claudeParseContext(seen);
  const jsonl = files.filter(f => f.path.endsWith('.jsonl') && !/\/(todos|statsig)\//.test('/' + f.path));
  for (let fi = 0; fi < jsonl.length; fi++) {
    const { path, file } = jsonl[fi];
    if (COWORK_AUDIT.test(path)) await parseCoworkAudit(file, ctx); else await parseClaudeTranscript(path, file, ctx);
    if (onProgress) onProgress(fi + 1, jsonl.length);
  }
  return ctx.result(jsonl.length);
}

/** meta.cowork (merged over one scan) → Store.sources.local.meta.reported: Anthropic's figure per day and per session, plus the Cowork sessions
 *  that have rows but no audit record (missing — disclosed, never estimated into the figure). Pure; null when the scan saw no Cowork data. */
function coworkReported(cowork) {
  if (!cowork) return null;
  const sessions = cowork.reported || {}, days = {};
  for (const s of Object.values(sessions)) for (const [d, usd] of Object.entries(s.days || {})) days[d] = (days[d] || 0) + usd;
  const missingSids = (cowork.sids || []).filter(sid => !sessions[sid]).sort();
  return { days, sessions, missing: missingSids.length, missingSids, results: cowork.results || 0, dupResults: cowork.dupResults || 0, badResults: cowork.badResults || 0 };
}

