/** Generic folder walker: collects files whose relative path matches any RegExp in `patterns`
 *  (depth ≤ 8, ≤ 20 000 files, skips VCS/dependency/checkpoint dirs). Used by every folder-log
 *  connector; the Claude scanner keeps its own projects-aware walker (collectJsonlFromHandle). */
const GENERIC_SKIP_DIRS = /^(node_modules|\.git|checkpoints|\.venv|venv|__pycache__)$/i;
async function collectFilesFromHandle(dirHandle, patterns, path = '', out = [], depth = 0) {
  if (depth > 8 || out.length > 20000) return out;
  const dirs = [];
  for await (const [name, h] of dirHandle.entries()) {
    if (h.kind === 'directory') { if (!GENERIC_SKIP_DIRS.test(name)) dirs.push([name, h]); }
    else if (patterns.some(re => re.test(path + name))) { try { out.push({ path: path + name, file: await h.getFile() }); } catch { out.unreadable = (out.unreadable || 0) + 1; } }   // locked/vanished file: counted, never fatal
  }
  for (const [name, h] of dirs) await collectFilesFromHandle(h, patterns, path + name + '/', out, depth + 1);
  return out;
}

/** v7: which files of a connector this page reads, from a FLAT listing of relative paths (forward slashes) — the collector's /api/list, or any
 *  pre-walked tree. Same rules as the walkers + parseFolderCached: patterns ∪ siblings select, `exclude` (tested against '/' + path) drops,
 *  and a skip-dir segment anywhere on the path drops (GENERIC_SKIP_DIRS; the Claude Code entry uses its own walker's SKIP_DIRS). Pure —
 *  entries come back unchanged ({ path, size, mtime, … }) so the caller can wrap them (RemoteFile) or count them. */
function matchConnectorFiles(c, entries) {
  const pats = (c.patterns || []).concat(c.siblings || []);
  const skip = c.kind === 'folder' ? SKIP_DIRS : GENERIC_SKIP_DIRS;
  return (entries || []).filter(e => e && typeof e.path === 'string' && pats.some(re => re.test(e.path))
    && !(c.exclude && c.exclude.test('/' + e.path)) && !e.path.split('/').slice(0, -1).some(seg => skip.test(seg)));
}

/** v7: page-side shim over the collector's GET <base>/api/file?tool=<id>&path=<rel> — exactly the File members the parsers and the ScanCache
 *  signature use (name, size, lastModified, webkitRelativePath, stream(), text(), arrayBuffer()), so a collector-fed scan IS a folder scan:
 *  same parser, same cache keys (path + size + lastModified → unchanged files stay cache hits). Nothing is fetched until a reader asks:
 *  stream() is a ReadableStream (highWaterMark 0) whose first pull opens the request and then pumps the response body chunk by chunk —
 *  readLines never holds a whole log in memory. An HTTP error rejects with its status ("HTTP 404 Not Found reading <path> …"), which
 *  parseFolderCached counts as one unreadable file and moves on. The token travels in the Authorization header only — never in the URL. */
class RemoteFile {
  constructor(base, token, tool, entry) {
    const rel = String(entry.path);
    this.name = rel.split('/').pop();
    this.size = +entry.size || 0;
    this.lastModified = +entry.mtime || 0;
    this.webkitRelativePath = rel;
    this.tool = tool;
    this._url = String(base).replace(/\/+$/, '') + '/api/file?tool=' + encodeURIComponent(tool) + '&path=' + encodeURIComponent(rel);
    this._headers = { Authorization: 'Bearer ' + token };
  }
  async _open() {
    // the timeout covers the connect + headers only: once the answer streams, a long parse pulling the body chunk by chunk must not be aborted (A0 #25)
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException(`the collector did not answer within ${REQUEST_TIMEOUT_MS / 1000} s`, 'TimeoutError')), REQUEST_TIMEOUT_MS);
    let r;
    try { r = await fetch(this._url, { headers: this._headers, signal: ctrl.signal }); } finally { clearTimeout(timer); }
    if (!r.ok) throw new Error(`HTTP ${r.status}${r.statusText ? ' ' + r.statusText : ''} reading ${this.webkitRelativePath} from the collector`);
    return r;
  }
  stream() {
    const self = this;
    let reader = null;
    return new ReadableStream({
      async pull(ctrl) {
        if (!reader) {
          const r = await self._open();
          if (!r.body) { ctrl.enqueue(new Uint8Array(await r.arrayBuffer())); ctrl.close(); return; }   // a body-less Response (some stubs / opaque answers): one chunk
          reader = r.body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) ctrl.close(); else ctrl.enqueue(value);
      },
      cancel(reason) { return reader ? reader.cancel(reason) : undefined; },
    }, { highWaterMark: 0 });
  }
  async text() { return (await this._open()).text(); }
  async arrayBuffer() { return (await this._open()).arrayBuffer(); }
}

/** Generic incremental scan: per-file aggregates cached by (connectorId, path, size, lastModified).
 *  connector.patterns select the files the parser owns; connector.siblings are collected too and
 *  handed to the parser as `siblingFiles` — computed ONCE per scan, sibling files only, never parsed on their own; connector.exclude drops paths.
 *  connector.parser names a global `async function parseX(files, onProgress, seen, connector, siblingFiles)`
 *  returning { rows, projects, meta: { files, msgs, lines, badLines, addedIds?, dupIds? } } (parseClaudeLogs' shape).
 *  cache: Map (tests) or the IDB-backed ScanCache (app). Files are processed in sorted-path order with a
 *  `runningSeen` set spanning the whole scan, so cross-file duplicates stay deduped even though each file
 *  is parsed/cached separately (parsers that emit addedIds opt in; id-less parsers never collide).
 *  Deduping parsers also report meta.dupIds: ids they SKIPPED because `seen` already held them (claimed by an earlier file).
 *  Those are kept on the entry (dupOnly: true when the file added nothing of its own) and make it a MISS whenever one of
 *  them is no longer claimed by a preceding file (the claimant vanished or now sorts later): a duplicate-only file (the same
 *  session logged twice, a copy, a rotated log) would otherwise be cached as empty forever and hide its usage once the
 *  original is gone. dupIds are capped at DUP_IDS_CAP per entry — a capped entry is flagged dupTruncated and is an UNCONDITIONAL miss (a
 *  partial list cannot prove every skipped id is still claimed). SCAN_CACHE_VER v6 re-parses the entries written before dupIds existed.
 *  Pruning is scoped to THIS connector's signature prefix — one connector's scan never evicts another's; opts.noPrune skips it (a
 *  drop-sourced scan sees only the dropped files — sweeping the prefix would evict the folder scan's entries). */
const DUP_IDS_CAP = 5000;   // dupIds kept per cache entry — beyond it the entry is dupTruncated (always a miss) rather than an unbounded IDB record
async function parseFolderCached(connector, files, onProgress, cache, opts = {}) {
  const parser = globalThis[connector.parser];
  if (typeof parser !== 'function') throw new Error('No parser registered: ' + connector.parser);
  const pats = connector.patterns || [/./];
  const keep = (f) => !(connector.exclude && connector.exclude.test('/' + f.path));
  const sibPats = connector.siblings || [];
  const main = files.filter(f => keep(f) && pats.some(re => re.test(f.path))).sort((a, b) => a.path < b.path ? -1 : 1);
  const siblingFiles = sibPats.length ? files.filter(f => keep(f) && sibPats.some(re => re.test(f.path))) : [];   // one filter per scan — handed to every per-file parser call by reference
  // siblings feed the parser's output for the main file in the SAME directory (Cline: task_metadata.json → model), so their
  // size+lastModified join that file's signature — an edited sibling is a cache miss even when the main file is untouched
  const sibSig = new Map();   // dir → 'size\u0001lastModified' per sibling, path-sorted so the string is stable across scans
  for (const s of [...siblingFiles].sort((a, b) => a.path < b.path ? -1 : 1)) { const dir = s.path.slice(0, s.path.lastIndexOf('/') + 1); sibSig.set(dir, (sibSig.get(dir) || '') + '\u0001' + s.file.size + '\u0001' + s.file.lastModified); }
  const rows = [], projects = [];
  let msgs = 0, parsedFiles = 0, cachedFiles = 0, done = 0, lines = 0, badLines = 0, badFiles = 0, cowork = null;
  const runningSeen = new Set();
  const seen = new Set();   // signatures present in THIS scan — stale entries for absent files get pruned below
  const prefix = connector.id + '\u0001';
  for (const f of main) {
    const sig = prefix + f.path + '\u0001' + f.file.size + '\u0001' + f.file.lastModified + (sibSig.get(f.path.slice(0, f.path.lastIndexOf('/') + 1)) || '');
    seen.add(sig);
    let entry = cache ? await cache.get(sig) : null;
    // an entry without `ids`, or whose ids collide with what's already been counted this scan, is a miss (re-parse); so is one
    // whose dupIds (skipped as duplicates when it was parsed) are no longer ALL claimed by an earlier file of this scan, or were truncated (DUP_IDS_CAP)
    const isMiss = !entry || !entry.ids || entry.dupTruncated === true || entry.ids.some(id => runningSeen.has(id)) || (Array.isArray(entry.dupIds) && entry.dupIds.some(id => !runningSeen.has(id)));
    if (isMiss) {
      let res;
      // one unreadable file (Chrome throws NotReadableError when an FSA file changed after getFile() — a CLI
      // appending to its live session log mid-scan) or one throwing parser must NEVER abort the batch:
      // count it, don't cache it, move on. Surfaced as meta.badFiles → "N file(s) unreadable" in the status line.
      try { res = await parser([f], null, runningSeen, connector, siblingFiles); }
      catch (e) { badFiles++; done++; if (onProgress) onProgress(done, main.length); continue; }
      entry = { rows: res.rows, projects: res.projects || [], msgs: res.meta.msgs || 0, ids: res.meta.addedIds || [], lines: res.meta.lines || 0, badLines: res.meta.badLines || 0 };
      if (res.meta.cowork) entry.cowork = res.meta.cowork;   // Plan 9 B1: a Cowork transcript's session ids / an audit's reported figures travel with the file's entry
      // ids this file skipped as duplicates of an EARLIER file (an in-file repeat is the file's own id, not another file's)
      const own = new Set(entry.ids), dupIds = [...new Set(res.meta.dupIds || [])].filter(id => !own.has(id));
      if (dupIds.length) { entry.dupIds = dupIds.slice(0, DUP_IDS_CAP); if (dupIds.length > DUP_IDS_CAP) entry.dupTruncated = true; if (!entry.ids.length) entry.dupOnly = true; }   // capped: a truncated list cannot prove every skipped id is still claimed → dupTruncated = unconditional miss
      if (cache) await cache.set(sig, entry);
      parsedFiles++;
    } else {
      entry.ids.forEach(id => runningSeen.add(id));
      cachedFiles++;
    }
    rows.push(...entry.rows); projects.push(...entry.projects); msgs += entry.msgs;
    lines += entry.lines ?? 0; badLines += entry.badLines ?? 0;   // pre-fix entries lack these — 0, not NaN
    if (entry.cowork) cowork = mergeCoworkMeta(cowork, entry.cowork);
    done++; if (onProgress) onProgress(done, main.length);
  }
  if (cache && !opts.noPrune) {   // noPrune: a drop-sourced scan — its entries join the cache, the folder scan's entries stay for the next re-scan
    if (typeof cache.prune === 'function') await cache.prune(seen, prefix);
    else if (typeof cache.keys === 'function') for (const k of [...cache.keys()]) if (k.startsWith(prefix) && !seen.has(k)) cache.delete(k);
  }
  // merge project rows across files (same shape as parseClaudeLogs' projMap)
  const pm = new Map();
  for (const p of projects) {
    const k = p.project + '\u0001' + p.model;
    let b = pm.get(k);
    if (!b) { b = { ...p }; pm.set(k, b); } else { b.in += p.in; b.cw += p.cw; b.cr += p.cr; b.out += p.out; b.msgs += p.msgs; }
  }
  // badFiles also folds in the walker's getFile() failures (collectFilesFromHandle tags the list with .unreadable);
  // skipped = files handed in that matched neither patterns nor siblings (not this connector's — never an error)
  return { rows, projects: [...pm.values()], meta: { files: main.length, msgs, parsedFiles, cachedFiles, lines, badLines,
    badFiles: badFiles + (files.unreadable || 0), skipped: Math.max(0, files.length - main.length - siblingFiles.length), ...(cowork ? { cowork } : {}) } };
}
/** Plan 9 B1: folds one file's meta.cowork (parseClaudeLogs) into the scan's — session ids union; a session's reported figure comes from the
 *  LAST file (path order) that carried it (two audit files for one session would be a copy, never two halves); the counters add up. */
function mergeCoworkMeta(acc, part) {
  const out = acc || { sids: [], reported: {}, results: 0, dupResults: 0, badResults: 0 };
  for (const sid of part.sids || []) if (!out.sids.includes(sid)) out.sids.push(sid);
  Object.assign(out.reported, part.reported || {});
  out.results += part.results || 0; out.dupResults += part.dupResults || 0; out.badResults += part.badResults || 0;
  return out;
}
/** Claude-logs wrapper kept for its callers and the 96/88 checks: identical behavior, now routed through
 *  the generic driver (signature gains the 'local' prefix → one-time re-parse of existing caches). Plan 9 B1: the merged meta.cowork becomes
 *  meta.reported — Anthropic's own Cowork figure per day / session and the sessions without an audit record (coworkReported). */
async function parseClaudeLogsCached(files, onProgress, cache) {
  const res = await parseFolderCached(connectorById('local'), files, onProgress, cache);
  const reported = coworkReported(res.meta.cowork);
  delete res.meta.cowork;
  if (reported) res.meta.reported = reported;
  return res;
}

/** Shared JSONL walker for folder-log parsers: counts non-blank lines, counts (and skips) lines that
 *  aren't JSON objects, hands each parsed object to onObj. Blank/CR-only lines are not malformed. */
async function eachJsonl(file, onObj, k) {
  for await (const line of readLines(file)) {
    if (!line.trim()) continue;
    k.lines++;
    if (line.trimStart()[0] !== '{') { k.badLines++; continue; }
    let o; try { o = JSON.parse(line); } catch { k.badLines++; continue; }
    onObj(o);
  }
}

/** Universal usage-log JSONL (written by docs/tools/ollama-usage-logger.mjs, or by anything you script):
 *  one object per request — { ts|timestamp, platform?, model?, in|input_tokens|prompt_eval_count|prompt_tokens,
 *  out|output_tokens|eval_count|completion_tokens, cw?, cr?, msgs? }. Missing platform → connector.platform. */
async function parseUsageLoggerJsonl(files, onProgress, seen = new Set(), c) {
  const agg = makeAgg(); let msgs = 0; const k = { lines: 0, badLines: 0 };
  const list = files.filter(f => /\.jsonl$/i.test(f.path));
  const pick = (o, ...keys) => { for (const key of keys) if (o[key] != null) return finTok(+o[key] || 0); return 0; };
  for (let fi = 0; fi < list.length; fi++) {
    const { file } = list[fi];
    await eachJsonl(file, (o) => {
      const tin = pick(o, 'in', 'input_tokens', 'prompt_eval_count', 'prompt_tokens'), tout = pick(o, 'out', 'output_tokens', 'eval_count', 'completion_tokens');
      if (!tin && !tout) return;
      const ts = (o.ts || o.timestamp) ? new Date(o.ts || o.timestamp) : null;
      const okTs = ts && !isNaN(ts);
      agg.add(dayKey(okTs ? ts : file.lastModified), String(o.platform || (c && c.platform) || 'Other'), String(o.model || 'unknown'),
        { in: tin, out: tout, cw: pick(o, 'cw', 'cache_write_tokens'), cr: pick(o, 'cr', 'cache_read_tokens'), msgs: o.msgs != null ? finTok(+o.msgs || 0) : 1 }, undefined, okTs ? ts.getHours() : undefined);
      msgs++;
    }, k);
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: [], meta: { files: list.length, msgs, lines: k.lines, badLines: k.badLines, addedIds: [] } };
}

