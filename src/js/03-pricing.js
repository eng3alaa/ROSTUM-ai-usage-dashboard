/** Canonical Claude id for PRICE MATCHING ONLY (rows/UI keep the vendor's id). Vendors spell the same model
 *  three ways: Copilot CLI dotted ('claude-opus-4.1'), Cursor family-last ('claude-4.1-opus', 'claude-3.5-sonnet'),
 *  Claude Code dated ('claude-opus-4-1-20250805'). Anthropic's own scheme is family-FIRST for 4+ ('claude-opus-4-1')
 *  and family-LAST for 3.x ('claude-3-5-sonnet'), which is how DEFAULT_PRICES is written — so: dots→hyphens,
 *  reorder to that scheme, strip a trailing -YYYYMMDD date and Cursor's '-thinking' suffix. Bedrock wraps the same id as
 *  'anthropic.<id>-v1:0' (with a us./eu./apac./global. cross-region prefix) and Vertex as '<id>@YYYYMMDD' — those wrappers
 *  come off first, or the end-anchored date strip never fires and Opus 4.1 prices as 'Claude (other)'. Non-Claude ids pass through. */
function normalizeModelId(model) {
  const m = String(model || '').toLowerCase();
  if (!m.includes('claude')) return m;
  return m.replace(/^(?:[a-z]+\.)?anthropic\./, '')   // Bedrock 'anthropic.' / 'us.anthropic.' / 'eu.anthropic.' / 'global.anthropic.' …
    .replace(/-v\d+:\d+$/, '')                        // Bedrock version tail '-v1:0'
    .replace(/@\d{8}$/, '')                           // Vertex date tail '@20250805'
    .replace(/\./g, '-')
    .replace(/claude-([4-9](?:-\d+)?)-(opus|sonnet|haiku)/, 'claude-$2-$1')      // 4+: family-last → family-first
    .replace(/claude-(opus|sonnet|haiku)-(3(?:-\d+)?)(?=$|-)/, 'claude-$2-$1')  // 3.x: family-first → family-last
    .replace(/-\d{8}$/, '')
    .replace(/-thinking$/, '');
}

/** A0 #23 — price rows a stored list may hold: pattern + label strings, finite in/out/cw/cr (coerced to numbers); anything else is dropped and announced. */
function validPriceRows(list) {
  const rows = []; let dropped = 0;
  for (const r of list) {
    const ok = isRecord(r) && typeof r.pat === 'string' && r.pat && typeof r.label === 'string' && ['in', 'out', 'cw', 'cr'].every(k => Number.isFinite(+r[k]));
    if (ok) rows.push({ ...r, in: +r.in, out: +r.out, cw: +r.cw, cr: +r.cr }); else dropped++;
  }
  if (dropped) showStorageBanner('prices-warning', `${dropped} stored price row${dropped === 1 ? ' was' : 's were'} unreadable and dropped on load — check the price list (Reset restores the built-in rows).`);
  return rows;
}

/* ---------- A0 #32: the user's price edits are stored as a DIFF over DEFAULT_PRICES, never as the whole list — so every generated row reaches an
 * existing user on the next load. LS 'prices' = { v: 2, edited: [rows whose pattern is a default's, carrying the user's values], added: [rows with a
 * pattern of their own, each with `after` = the pattern they followed when saved (null = top of the list)], removed: [default patterns the user
 * deleted] }. A legacy blob (an array = the whole list, pre-Plan 9) is migrated by diffing: its edited / added rows are kept, the defaults it lacks
 * are the NEW rows it never saw — never removals (a deliberate deletion cannot be told apart in that shape; delete again). Rows are identified by
 * pattern: editing a pattern turns a default into an added rule (and the default comes back as removed on the next save). ---------- */
const PRICE_FIELDS = ['pat', 'label', 'in', 'out', 'cw', 'cr'];
const stripPriceRow = (r) => Object.fromEntries(PRICE_FIELDS.map(k => [k, r[k]]));
const samePrice = (a, b) => PRICE_FIELDS.every(k => a[k] === b[k]);
function priceEditsFromList(rows, trackRemovals) {
  const byPat = new Map(DEFAULT_PRICES.map(r => [r.pat, r]));
  const edits = { v: 2, edited: [], added: [], removed: [] };
  let prev = null;
  for (const r of rows) {
    const d = byPat.get(r.pat);
    if (!d) edits.added.push({ ...stripPriceRow(r), after: prev });
    else if (!samePrice(r, d)) edits.edited.push(stripPriceRow(r));
    prev = r.pat;
  }
  if (trackRemovals) { const seen = new Set(rows.map(r => r.pat)); edits.removed = DEFAULT_PRICES.filter(d => !seen.has(d.pat)).map(d => d.pat); }
  return edits;
}
/** DEFAULT_PRICES with the edits applied: removed rows gone; edited rows carry the user's values and read c: 'user' with no verified date / source
 *  (that provenance belonged to the vendor's number); added rows sit right after their anchor (top for null; before the '.*' fallback when the anchor is gone). */
function applyPriceEdits(edits) {
  const removed = new Set(Array.isArray(edits.removed) ? edits.removed : []);
  const edited = new Map(validPriceRows(Array.isArray(edits.edited) ? edits.edited : []).map(r => [r.pat, r]));
  const rows = [];
  for (const d of DEFAULT_PRICES) { if (removed.has(d.pat)) continue; const e = edited.get(d.pat); rows.push(e ? { ...d, ...stripPriceRow(e), at: null, c: 'user', src: null } : { ...d }); }
  for (const a of validPriceRows(Array.isArray(edits.added) ? edits.added : [])) {
    const { after, ...row } = a;
    let at = Math.max(0, rows.length - 1);
    if (after === null) at = 0; else { const j = rows.findIndex(r => r.pat === after); if (j >= 0) at = j + 1; }
    rows.splice(at, 0, row);
  }
  return rows;
}

const Pricing = {
  rows: [],
  _cache: new Map(),
  load() {
    const saved = LS.get('prices', null);
    const legacy = Array.isArray(saved);   // the whole list (pre-Plan 9): migrated through the diff, then saved once in the edits shape
    this.rows = applyPriceEdits(legacy ? priceEditsFromList(validPriceRows(saved), false) : isRecord(saved) ? saved : {});
    this._cache.clear();
    if (legacy) this.save();
  },
  save() { LS.set('prices', priceEditsFromList(this.rows, true)); this._cache.clear(); },
  reset() { this.rows = JSON.parse(JSON.stringify(DEFAULT_PRICES)); this.save(); },
  /** Plan 6: the catch-all row — the one whose pattern is '.*' (a user may edit or reorder the list), else the last row (what resolve() falls back to). */
  fallbackRow() { return this.rows.find(r => r.pat === '.*') || this.rows[this.rows.length - 1] || null; },
  /** true when resolve(model, platform) lands on the fallback row, i.e. NO price row (and no override for that platform) knows this id — the price is a guess, and every surface says so. */
  isFallback(model, platform) { return this.resolve(model, platform).fallback === true; },
  _re: new Map(),   // pattern string → RegExp (patterns compile once per distinct string; an invalid pattern is matched literally)
  _first(rows, m, n) {   // first row whose pattern matches the lowercased id OR its canonical form
    for (const r of rows) {
      let re = this._re.get(r.pat);
      if (!re) { try { re = new RegExp(r.pat, 'i'); } catch { re = new RegExp(escRe(r.pat), 'i'); } this._re.set(r.pat, re); }
      if (re.test(m) || (n !== m && re.test(n))) return r;
    }
    return null;
  },
  /** Plan 9 resolution order: lowercase + normalizeModelId → a PRICE_OVERRIDES row for `platform` whose pattern matches the id AS SPELLED
   *  (the host's own price for that exact id is the most specific fact we have, so it beats a vendor retirement) → MODEL_ALIASES (retired
   *  id → successor; the result carries aliasOf = successor) → that platform's override for the successor → DEFAULT_PRICES (this.rows,
   *  the user-editable list) first match → the '.*' fallback. Returns a shallow COPY of the matched row — aliasOf / fallback are set on
   *  the copy, never on a row in this.rows — cached per model|platform (save()/load() clear the cache). */
  resolve(model, platform) {
    const raw = String(model || '').toLowerCase(), key = raw + '|' + (platform || '');
    if (this._cache.has(key)) return this._cache.get(key);
    let m = raw, n = normalizeModelId(raw), aliasOf = null;
    const overrides = platform ? PRICE_OVERRIDES.filter(o => o.platform === platform) : [];
    let hit = overrides.length ? this._first(overrides, m, n) : null;
    if (!hit) {
      const succ = Object.hasOwn(MODEL_ALIASES, m) ? MODEL_ALIASES[m] : Object.hasOwn(MODEL_ALIASES, n) ? MODEL_ALIASES[n] : null;
      if (succ) { aliasOf = succ; m = String(succ).toLowerCase(); n = normalizeModelId(m); }
      if (overrides.length) hit = this._first(overrides, m, n);
      if (!hit) hit = this._first(this.rows, m, n);
    }
    let fallback = false;
    if (!hit) { hit = this.rows[this.rows.length - 1] || { pat: '.*', in: 3, out: 15, cw: 3.75, cr: 0.3, label: 'Unknown model' }; fallback = true; }
    else if (hit === this.fallbackRow()) fallback = true;
    const out = Object.assign({}, hit);
    if (aliasOf) out.aliasOf = aliasOf;
    if (fallback) out.fallback = true;
    this._cache.set(key, out);
    return out;
  },
  /** cost in USD for a token bundle. Local runners (row.platform is a registered 'local'-category
   *  connector, e.g. LM Studio/Ollama) are ALWAYS $0 — gated by platform, never by model name, so a
   *  hosted model that happens to share a base name with an open-weight one (Mistral API, Groq
   *  Llama/Gemma, an OpenRouter route) is priced normally. A row may also carry local:1 — set by a
   *  coding-tool parser (Continue.dev / Cline / Aider / Codex) when the log's PROVIDER field names a
   *  local backend (see LOCAL_PROVIDER_IDS); the row keeps the tool's platform but is $0 too. */
  cost(model, t) {
    if (t && (t.local || (t.platform && LOCAL_PLATFORMS.has(t.platform)))) return 0;
    const p = this.resolve(model, t && t.platform);   // Plan 9: the row's platform selects a PRICE_OVERRIDES row when the host bills this id differently
    return (t.in * p.in + t.out * p.out + (t.cw || 0) * p.cw + (t.cr || 0) * p.cr) / 1e6;
  }
};

