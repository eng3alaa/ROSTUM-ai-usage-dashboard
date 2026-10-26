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

const SKIP_DIRS = /^(todos|statsig|shell-snapshots|ide|plugins|skills|commands|hooks|downloads|cache|node_modules|\.git)$/i;
async function collectJsonlFromHandle(dirHandle, path = '', out = [], depth = 0) {
  if (depth > 6) return out;
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

/** files: [{path, file}] → aggregated usage */
async function parseClaudeLogs(files, onProgress, seen = new Set()) {
  const agg = makeAgg();
  const addedIds = [], dupIds = [];   // dupIds: ids skipped because `seen` already held them (parseFolderCached keeps them on the cache entry)
  const projMap = new Map(); // project\0model -> bundle
  let msgs = 0, lines = 0, badLines = 0;
  const jsonl = files.filter(f => f.path.endsWith('.jsonl') && !/\/(todos|statsig)\//.test('/' + f.path));
  for (let fi = 0; fi < jsonl.length; fi++) {
    const { path, file } = jsonl[fi];
    // project dir name = segment after "projects/"
    const m = path.match(/(?:^|\/)projects\/([^/]+)\//);
    let projectDir = m ? m[1] : null;
    let projectCwd = null;
    const sid = (path.split('/').pop() || '').replace(/\.jsonl$/i, '');   // session UUID = file basename
    for await (const line of readLines(file)) {
      if (!line.trim()) continue;   // blank, whitespace-only, or CR-only (Windows CRLF logs) — not malformed
      lines++;
      if (line[0] !== '{') { badLines++; continue; }   // has content but isn't even JSON-object-shaped — malformed
      let obj; try { obj = JSON.parse(line); } catch { badLines++; continue; }
      if (!projectCwd && obj.cwd) projectCwd = obj.cwd;
      if (obj.type !== 'assistant' || !obj.message || !obj.message.usage) continue;
      const u = obj.message.usage;
      const model = obj.message.model || 'unknown';
      if (model === '<synthetic>') continue;
      const id = (obj.message.id || '') + ':' + (obj.requestId || '');
      if (id !== ':' && seen.has(id)) { dupIds.push(id); continue; }
      if (id !== ':') { seen.add(id); addedIds.push(id); }
      let cw = u.cache_creation_input_tokens;
      if (cw == null && u.cache_creation && typeof u.cache_creation === 'object') {
        cw = Object.values(u.cache_creation).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
      }
      const t = { in: finTok(+u.input_tokens || 0), cw: finTok(+cw || 0), cr: finTok(+u.cache_read_input_tokens || 0), out: finTok(+u.output_tokens || 0), msgs: 1 };   // finite non-negative numbers only — a string count would concatenate (A0 #14)
      const ts = obj.timestamp ? new Date(obj.timestamp) : null;
      const d = dayKey(ts || file.lastModified);
      const hour = ts && !isNaN(ts) ? ts.getHours() : undefined;
      agg.add(d, 'Claude Code/Desktop', model, t, sid, hour);
      msgs++;
      const projName = prettyProject(projectCwd || projectDir);
      const pk = projName + '\u0001' + model;
      let pb = projMap.get(pk);
      if (!pb) { pb = { project: projName, model, in: 0, cw: 0, cr: 0, out: 0, msgs: 0 }; projMap.set(pk, pb); }
      pb.in += t.in; pb.cw += t.cw; pb.cr += t.cr; pb.out += t.out; pb.msgs += 1;
    }
    if (onProgress) onProgress(fi + 1, jsonl.length);
  }
  // keep project×model rows raw — cost is computed at render time with live prices
  const projects = [...projMap.values()];
  return { rows: agg.rows(), projects, meta: { files: jsonl.length, msgs, lines, badLines, addedIds, dupIds } };
}

