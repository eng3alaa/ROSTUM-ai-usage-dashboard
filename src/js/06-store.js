const Store = {
  sources: {},       // srcId -> { rows: [], meta: {} }
  billed: {},        // srcId -> {rows: [{d, amount}], at, stale} envelope (v1 arrays migrate on load)
  projects: [],      // [{name, msgs, in, cw, cr, out, cost}] from local logs
  projectsBy: {},    // connectorId → [{project, model, in, cw, cr, out, msgs, platform, local?}] from folder-log scans (Codex cwd, Gemini CLI project hash, Copilot CLI cwd, Junie project dir)
  connectors: {},    // connectorId -> { label, lastSync, err }
  _frozen: false,    // A0 #16: true when a corrupt blob could not be backed up — persist() then leaves it alone (the banner says so)
  load() {
    const saved = this._readSaved();
    if (isRecord(saved)) {   // every part shape-checked (A0 #23); v1 billed arrays migrate to envelopes inside loadBilled
      const dropped = { rows: 0, billed: 0, other: 0 };
      this.sources = loadSources(saved.sources, dropped);
      this.billed = loadBilled(saved.billed, dropped);
      this.projects = Array.isArray(saved.projects) ? saved.projects.filter(isRecord) : [];
      this.projectsBy = loadProjectsBy(saved.projectsBy, dropped);
      this.connectors = loadConnectors(saved.connectors, dropped);
      reportDropped(dropped);
    }
    // migrate ONLY a genuine pre-v2 blob (no `connectors` key at all — v2's persist() always
    // writes the key, even as {}). Running this unconditionally on every load would resurrect
    // a keep-data disconnect (connectors[id] deleted, sources kept) as 'stored data'/ok again.
    if (isRecord(saved) && !('connectors' in saved)) this.migrateConnectors();
  },
  /** The persisted blob, parsed — or null when there is none. A blob that no longer parses is quarantined (A0 #16): kept byte-for-byte under
   *  'data.corrupt' so nothing is lost, announced in a banner, and this load starts empty; persist() then writes a fresh blob beside it. */
  _readSaved() {
    let raw = null;
    try { raw = localStorage.getItem('aiusage:data'); }
    catch (e) { showStorageBanner('data-warning', 'Browser storage is not readable (' + (e.message || e) + ') — nothing is loaded or saved in this tab.'); return null; }
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { this._quarantine(raw); return null; }
  },
  _quarantine(raw) {
    let kept = true;
    try { localStorage.setItem('aiusage:data.corrupt', raw); } catch { kept = false; this._frozen = true; }
    showStorageBanner('data-warning', 'Stored usage data could not be read (corrupt JSON) and was not loaded. '
      + (kept ? 'The raw blob is kept under the browser-storage key aiusage:data.corrupt — copy it out (DevTools → Application → Local Storage) before you clear data; syncing again starts a fresh store.'
        : 'It could not be backed up either (storage full), so nothing is saved in this tab until storage is freed — the blob stays as it is.'));
  },
  // v1.1-shaped stores (data present, no per-connector state entry) synthesize a labeled
  // connected card instead of reading as truly disconnected forever.
  migrateConnectors() {
    let migrated = false;
    for (const c of CONNECTORS) {
      if (this.connectors[c.id]) continue;
      let hasRows = false, maxUpdated = 0;
      for (const sid of c.srcIds) {
        const s = this.sources[sid];
        if (s && s.rows && s.rows.length) {
          hasRows = true;
          if (s.meta && s.meta.updated && s.meta.updated > maxUpdated) maxUpdated = s.meta.updated;
        }
      }
      if (hasRows) { this.connectors[c.id] = { label: 'stored data', lastSync: maxUpdated || Date.now(), err: null }; migrated = true; }
    }
    if (migrated) this.persist();
  },
  setConnector(id, patch) {
    const prev = this.connectorStatus(connectorById(id) || { id, srcIds: [] });   // status BEFORE the patch
    this.connectors[id] = { ...(this.connectors[id] || {}), ...patch }; this.persist();
    const next = this.connectorStatus(connectorById(id) || { id, srcIds: [] });
    View.onConnectorChange(id, prev, next);   // reveal only on an off→connected/attention transition, not every sync
  },
  connectorStatus(c) {
    // export-file cards never get a connector entry: their data arrives through Imports, so status = rows present under any of their srcIds
    if (c.kind === 'export-file') return c.srcIds.some(sid => ((((this.sources[sid] || {}).rows) || []).length) > 0) ? 'ok' : 'off';
    // status is driven by the connector's own state entry, not data presence — every
    // connect path (fetch, folder scan, import) writes this entry, so a connector with
    // leftover data but no state (e.g. a keep-data disconnect) reads as truly 'off'.
    const st = this.connectors[c.id];
    if (!st || (!st.lastSync && !st.err && !st.label)) return 'off';
    if (st.err) return 'warn';
    if (st.lastSync && Date.now() - st.lastSync > 7 * 864e5) return 'warn';
    return 'ok';
  },
  billedRows(id) {
    const v = this.billed[id];
    if (!v) return [];
    return Array.isArray(v) ? v : (v.rows || []);
  },
  setBilled(id, rows) {                    // rows: array (fresh), []: truthful empty, null: fetch failed → stale
    if (rows) this.billed[id] = { rows, at: Date.now(), stale: false };
    else if (this.billed[id]) this.billed[id] = { rows: this.billedRows(id), at: (this.billed[id].at ?? null), stale: true };
    this.persist();
  },
  persist() {
    if (this._frozen) return;   // A0 #16: never overwrite a corrupt blob that has no backup
    try { LS.set('data', { sources: this.sources, billed: this.billed, projects: this.projects, projectsBy: this.projectsBy, connectors: this.connectors }); }
    catch (e) { console.warn('persist failed', e); }
  },
  compactRows(rows, opts) {
    // Compact by AGE regardless of sid: rows older than 90 days (sid-bearing Claude logs AND sid-less hour-granular
    // parsers — Takeout, Continue.dev, usage-logger JSONL, Cursor CSV) merge into day/platform/model[/local] buckets
    // (hour dropped). `sids` is only emitted when at least one merged row carried a sid (allRows dedupe contract).
    // opts.perSid (merge-by-sid sources — Meta AI threads, Perplexity files, Copilot activity CSVs — where one file replaces only
    // itself on re-import): buckets are per day/platform/model[/local]/sid and keep the scalar sid instead of folding across sids
    // into a sids list, so the per-file "replaces only itself" filter never takes other files' old rows with it.
    const perSid = !!(opts && opts.perSid);
    const cutoff = addDays(todayKey(), -90);
    const keep = [], merge = new Map();
    for (const r of rows) {
      if (!r.d || r.d >= cutoff) { keep.push(r); continue; }
      const k = r.d + '\u0001' + r.platform + '\u0001' + r.model + '\u0001' + (r.local ? '1' : '') + (perSid ? '\u0001' + (r.sid || '') : '');
      let b = merge.get(k);
      if (!b) { b = { d: r.d, platform: r.platform, model: r.model, in: 0, cw: 0, cr: 0, out: 0, msgs: 0 }; if (r.est) b.est = 1; if (r.local) b.local = 1; if (perSid && r.sid) b.sid = r.sid; merge.set(k, b); }
      b.in += r.in || 0; b.cw += r.cw || 0; b.cr += r.cr || 0; b.out += r.out || 0; b.msgs += r.msgs || 0;
      if (r.est) b.est = 1;
      const sids = r.sid ? [r.sid] : (Array.isArray(r.sids) ? r.sids : null);
      if (sids && !(perSid && r.sid)) { if (!b.sids) b.sids = []; for (const sd of sids) if (!b.sids.includes(sd)) b.sids.push(sd); }   // perSid: the scalar sid is the bucket's identity (a legacy cross-sid sids list still folds)
    }
    return keep.concat([...merge.values()]);
  },
  setSource(id, rows, meta, opts) { this.sources[id] = { rows: this.compactRows(rows, opts), meta: { ...meta, updated: Date.now() } }; this.persist(); },
  clearAll() { this.sources = {}; this.billed = {}; this.projects = []; this.projectsBy = {}; this.connectors = {}; LS.del('data'); },
  allRows() {
    const localSids = new Set();
    for (const r of ((this.sources.local || {}).rows || [])) {
      if (r.sid) localSids.add(r.sid);
      if (Array.isArray(r.sids)) r.sids.forEach(s => localSids.add(s));
    }
    return Object.entries(this.sources).flatMap(([id, s]) => {
      let rows = s.rows || [];
      if (id === 'local-import' && localSids.size) {
        rows = rows.filter(r => !((r.sid && localSids.has(r.sid)) || (Array.isArray(r.sids) && r.sids.some(sd => localSids.has(sd)))));
      }
      return rows;
    });
  },
  platforms() {
    const set = new Set(this.allRows().map(r => r.platform));
    return PLATFORM_ORDER.filter(p => set.has(p)).concat([...set].filter(p => !PLATFORM_ORDER.includes(p)));
  },
  dateSpan() {
    let min = null, max = null;
    for (const r of this.allRows()) { if (!min || r.d < min) min = r.d; if (!max || r.d > max) max = r.d; }
    return { min, max };
  }
};

/* ---------- fixed color slots (color follows the entity, never rank) ---------- */
const SLOT_VARS = ['--s1','--s2','--s3','--s4','--s5','--s6','--s7','--s8','--s9','--s10','--s11','--s12'];
const ColorMap = {
  maps: { platform: {}, model: {} },
  load() { this.maps = LS.get('colormap', null) || { platform: {}, model: {} }; },
  save() { LS.set('colormap', this.maps); },
  slotFor(kind, name, orderedCandidates) {
    const map = this.maps[kind];
    // -1 is the "no free slot" overflow sentinel, not a real assignment — entities persisted
    // with it (e.g. from before the palette widened past 8 slots) must be free to re-assign.
    if (map[name] != null && map[name] !== -1) return map[name];
    // release first: an entry whose entity no longer has data (not among the current candidates) or that only holds the
    // overflow sentinel gives its slot back — otherwise 12 platforms ever seen in this browser profile would fold every
    // later one into 'Other' forever, even as the only platform on the page. save() below persists the cleaned map.
    const keep = new Set(orderedCandidates);
    for (const k of Object.keys(map)) if (!keep.has(k) || map[k] === -1) delete map[k];
    // assign next free slot, seeding in the given deterministic order
    const used = new Set(Object.values(map));
    for (const cand of orderedCandidates) {
      if (map[cand] != null && map[cand] !== -1) continue;
      let s = 0; while (used.has(s) && s < SLOT_VARS.length) s++;
      if (s >= SLOT_VARS.length) { map[cand] = -1; } else { map[cand] = s; used.add(s); }
    }
    this.save();
    return map[name] != null ? map[name] : -1;
  },
  colorOf(kind, name, orderedCandidates) {
    const slot = this.slotFor(kind, name, orderedCandidates);
    const styles = getComputedStyle(document.documentElement);
    if (slot === -1 || slot == null) return styles.getPropertyValue('--other').trim() || '#a9a79f';
    return styles.getPropertyValue(SLOT_VARS[slot]).trim();
  }
};
