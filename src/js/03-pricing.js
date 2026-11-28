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

/* prices: UI/repair/Undo; prices.bakN: immutable, verified raw backups.
 * v2: { v: 2, edited, added (with after), removed }.
 * prices.fix: applying -> applied/kept (no changes); applied -> undoing -> undone/unavailable.
 * Keep/edit, conflicts or unreadable state -> kept. Pending writes resume on load. */
const PRICE_UNDONE = 'Undo completed. Old built-in prices are in effect again. "Reset" in the price list switches to the current ones at any time.';
const priceSuccessor = pat => Object.hasOwn(PRICE_SUCCESSORS, pat) ? PRICE_SUCCESSORS[pat] : pat;
const priceAnchor = (pat, rows = DEFAULT_PRICES) => rows.some(r => r.pat === pat) ? pat : priceSuccessor(pat);
const PRICE_FIELDS = ['pat', 'label', 'in', 'out', 'cw', 'cr'];
const priceHistoryRow = a => Object.fromEntries(PRICE_FIELDS.map((k, i) => [k, a[i]]));
const priceRaw = key => { try { return localStorage.getItem('aiusage:' + key); } catch { return null; } };
const priceValue = raw => { try { return JSON.parse(raw); } catch { return null; } };
const priceBlob = v => Array.isArray(v) ? v.every(r => isRecord(r) && typeof r.pat === 'string') :
  isRecord(v) && v.v === 2 && ['edited', 'added', 'removed'].every(k => Array.isArray(v[k]));
// Show at most five entries per list.
const priceList = a => a.slice(0, 5).join('; ') + (a.length > 5 ? '; and ' + (a.length - 5) + ' more' : '');
function writePriceRaw(key, value) {
  try {
    localStorage.setItem('aiusage:' + key, value);
    if (priceRaw(key) !== value) throw new Error('Price storage verification failed');
  } catch (e) { Pricing._failed = true; throw e; }
}
function priceFix(raw = priceRaw('prices.fix')) {
  if (raw === null) return null;
  try {
    const f = JSON.parse(raw), pending = ['applying', 'applied', 'undoing'];
    const strings = a => Array.isArray(a) && a.every(s => typeof s === 'string');
    if (isRecord(f) && f.v === 1 && [...pending, 'undone', 'kept', 'unavailable'].includes(f.state) &&
      (!f.backup || /^prices\.bak[1-9]\d*$/.test(f.backup)) &&
      (!pending.includes(f.state) || (typeof f.result === 'string' && priceBlob(priceValue(f.result)) && strings(f.changed) && strings(f.kept) &&
        ['added', 'removed', 'outdated'].every(k => f[k] === undefined || strings(f[k]))))) return f;
  } catch { /* Unreadable history cannot grant Undo. */ }
  return priceRaw('prices.bak1') !== null || Object.keys(localStorage).some(k => /^aiusage:prices\.bak[1-9]\d*$/.test(k))
    ? { v: 1, state: 'kept' } : null;
}
function repairPriceEdits(saved, moved = []) {
  const defs = new Map(DEFAULT_PRICES.map(r => [r.pat, r]));
  const known = r => isRecord(r) && (defs.has(r.pat) && samePrice(r, defs.get(r.pat)) ||
    PRICE_HISTORY.some(a => PRICE_FIELDS.every((k, i) => r[k] === a[i])));
  const legacy = Array.isArray(saved), edited = legacy ? saved : Array.isArray(saved.edited) ? saved.edited : [];
  if (legacy && !validPriceRows(saved).length) return null;
  const added = !legacy && Array.isArray(saved.added) ? saved.added : [];
  const removed = legacy ? [] : Array.isArray(saved.removed) ? saved.removed : [];
  const e = { v: 2, edited: [], added: [], removed: removed.map(priceSuccessor) };
  if (!legacy && !edited.some(r => known(r) || isRecord(r) && !defs.has(r.pat)) && !added.some(known) &&
    !removed.some((p, i) => p !== e.removed[i])) return null;
  if (legacy) {
    let after = null, lost = false;
    for (const r of saved) {
      const [valid] = validPriceRows([r]);
      if (!valid) continue;
      if (!known(r)) {
        if (!defs.has(r.pat)) { e.added.push({ ...stripPriceRow(valid), after }); if (lost) moved.push(r.label); }
        else if (!samePrice(valid, defs.get(r.pat))) e.edited.push(stripPriceRow(valid));
      }
      const anchor = known(r) ? priceAnchor(r.pat) : r.pat;
      lost = known(r) && !defs.has(anchor);
      if (!lost) after = anchor;
    }
    // Infer deletions only from strong shipped-base matches.
    const seen = new Set(saved.filter(isRecord).map(r => priceSuccessor(r.pat)));
    let best = [], matches = 0;
    PRICE_HISTORY_LISTS.ids.forEach((id, i) => {
      const base = PRICE_HISTORY_LISTS.pats.filter(a => a[1] & (1 << i));
      const count = base.filter(([pat, mask, values]) => {
        const row = values ? priceHistoryRow([pat, ...values]) : defs.get(pat);
        return row && saved.some(r => isRecord(r) && samePrice(r, row));
      }).length;
      if (count > matches) { best = base; matches = count; }
    });
    if (matches && matches * 2 >= best.length) e.removed = best.map(a => priceSuccessor(a[0])).filter(p => defs.has(p) && !seen.has(p));
  } else {
    e.edited = validPriceRows(edited.filter(r => !known(r)));
    // Preserve custom order, including forward anchors.
    const tag = Symbol(), tagged = validPriceRows(added.map((r, i) => ({ ...r, [tag]: i })));
    let after = null, lost = false;
    for (const r of applyPriceEdits({ ...saved, added: tagged }, moved)) {
      if (r[tag] !== undefined) {
        if (known(added[r[tag]])) {
          const anchor = priceAnchor(r.pat); lost = !defs.has(anchor);
          if (!lost) after = anchor;
          continue;
        }
        if (lost) moved.push(r.label);
        e.added.push({ ...stripPriceRow(r), after });
      }
      after = r.pat; lost = false;
    }
  }
  const orphans = e.edited.filter(r => !defs.has(r.pat));
  e.edited = e.edited.filter(r => defs.has(r.pat) && !samePrice(r, defs.get(r.pat)));
  e.added = [...orphans.map((r, i) => ({ ...stripPriceRow(r), after: i ? orphans[i - 1].pat : null })), ...e.added];
  return e;
}
function priceRepairChanges(before, after) {
  const changed = [], added = [];
  const rates = r => r.in + '/' + r.out + ' (cache ' + r.cw + '/' + r.cr + ')';
  for (const d of DEFAULT_PRICES) {
    const r = before.find(r => r.pat === d.pat), n = after.find(r => r.pat === d.pat);
    if (!n) continue;
    if (!r) added.push(n.label);
    else if (['in', 'out', 'cw', 'cr'].some(k => r[k] !== n[k])) changed.push(n.label + ': ' + rates(r) + ' -> ' + rates(n));
  }
  const outdated = before.filter(r => !after.some(n => n.pat === r.pat)).map(r => r.label + ': ' + rates(r));
  return { changed, added, outdated };
}
/** A row's confidence pill: the generated c (high / medium / low / existing), 'user' for an edited or added row (no c at all = the editor's own row). */
const priceConfidence = (row) => row.c || 'user';
/** at: null on a bundled row = the Aug 2026 list's number, never re-verified (the generated block documents it that way). */
const PRICE_UNVERIFIED_TEXT = 'unverified since Aug 2026';
const PRICE_CONFIDENCE_TITLE = {
  high: 'Read from the vendor\'s pricing page on the verified date',
  medium: 'Read from a vendor page that lists the model indirectly (a deprecation or migration note)',
  low: 'Last known price — the vendor page no longer lists this model',
  existing: 'Carried over from the Aug 2026 list; not re-verified since',
  user: 'Your own edit or row — not a verified vendor list price',
};
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
/** Apply v2 edits; keep orphan edits and resolve custom anchors. */
function applyPriceEdits(edits, moved = []) {
  const removed = new Set((Array.isArray(edits.removed) ? edits.removed : []).map(priceSuccessor));
  const edited = new Map(validPriceRows(Array.isArray(edits.edited) ? edits.edited : []).map(r => [r.pat, r]));
  const rows = [];
  for (const d of DEFAULT_PRICES) { if (removed.has(d.pat)) continue; const e = edited.get(d.pat); rows.push(e ? { ...d, ...stripPriceRow(e), at: null, c: 'user', src: null } : { ...d }); }
  rows.unshift(...[...edited.values()].filter(r => !DEFAULT_PRICES.some(d => d.pat === r.pat)).map(r => ({ ...stripPriceRow(r), at: null, c: 'user', src: null })));
  for (const a of validPriceRows(Array.isArray(edits.added) ? edits.added : [])) {
    const { after, ...row } = a;
    let at = Math.max(0, rows.length - 1);
    if (after === null) at = 0; else { const j = rows.findIndex(r => r.pat === priceAnchor(after, rows)); if (j >= 0) at = j + 1; else if (after != null) moved.push(row.label); }
    rows.splice(at, 0, { ...row, at: null, c: 'user', src: null });
  }
  return rows;
}

const Pricing = {
  rows: [],
  _cache: new Map(),
  notice: null,
  _notice(text, undo = priceFix()?.state === 'applied') {
    if (this.notice?.text === text && this.notice?.undo === undo) return;
    this.notice = text ? { text, undo } : null;
    if (text) showStorageBanner('prices-repair', text);
    else document.getElementById('prices-repair')?.remove();
  },
  _prices(raw) { writePriceRaw('prices', raw); this._raw = raw; },
  _current() {
    if (priceRaw('prices') === this._raw && priceRaw('prices.fix') === this._state) return true;
    this.load();
    this._notice((this.notice?.text || 'Prices changed in another tab - reloaded.') + ' Price edit was not saved; make it again.', !!this.notice?.undo);
    return false;
  },
  _fix(state) { const raw = JSON.stringify(state); writePriceRaw('prices.fix', raw); this._state = raw; },
  _backup(raw) {
    for (let i = 1; ; i++) {
      const key = 'prices.bak' + i, backup = localStorage.getItem('aiusage:' + key);
      if (backup === raw) return key;
      if (backup === null) { writePriceRaw(key, raw); return key; }
    }
  },
  _undoBackup(fix) {
    const backup = priceRaw(fix.backup || 'prices.bak1');
    if (priceBlob(priceValue(backup))) return backup;
    this._fix({ v: 1, state: 'unavailable' });
    this._notice('Undo is unavailable: the price backup is missing or unreadable.');
    return null;
  },
  load() {
    let saved = null, fix, info = null;
    const moved = [];
    this._failed = false;
    try {
      let raw = priceRaw('prices'); this._raw = raw; this._state = priceRaw('prices.fix');
      saved = priceValue(raw); fix = priceFix(this._state);
      if (fix && priceValue(this._state)?.state !== fix.state) this._fix(fix);
      let retry = !fix;
      if (fix && ['applying', 'undoing'].includes(fix.state)) {
        const undo = fix.state === 'undoing';
        const backup = priceRaw(fix.backup || 'prices.bak1');
        if (raw === null || raw !== backup && raw !== fix.result) {
          fix = { ...fix, state: 'kept' }; this._fix(fix); retry = true;
        } else if (undo && this._undoBackup(fix) === null) { fix = priceFix(); info = this.notice.text; }
        else if (backup === null) { fix = { ...fix, state: 'kept' }; this._fix(fix); }
        else {
          raw = undo ? backup : fix.result; this._prices(raw);
          fix = { ...fix, state: undo ? 'undone' : !fix.quiet && (fix.changed.length || fix.added?.length || fix.outdated?.length) ? 'applied' : 'kept' }; this._fix(fix);
          saved = priceValue(raw); if (undo) info = PRICE_UNDONE;
        }
      }
      if (fix?.state === 'applied' && raw !== fix.result) {
        fix = { ...fix, state: 'kept' }; this._fix(fix); retry = true;
      }
      if (retry && (Array.isArray(saved) || isRecord(saved) && saved.v === 2)) {
        const e = repairPriceEdits(saved, moved);
        if (e) {
          const before = Array.isArray(saved) ? validPriceRows(saved) : applyPriceEdits(saved);
          const { changed, added, outdated } = priceRepairChanges(before, applyPriceEdits(e));
          const quiet = fix?.state === 'kept' || !changed.length && !added.length && !outdated.length;
          const kept = e.added.map(r => r.label + (moved.includes(r.label) ? ' (moved)' : ''));
          const removed = DEFAULT_PRICES.filter(r => e.removed.includes(r.pat)).map(r => r.label);
          const backup = this._backup(raw);
          fix = { v: 1, state: 'applying', changed, added, outdated, kept, removed, backup, quiet, result: JSON.stringify(e) }; this._fix(fix);
          this._prices(fix.result);
          fix = { ...fix, state: quiet ? 'kept' : 'applied' }; this._fix(fix);
          saved = e;
          if (quiet && kept.length) info = 'Kept custom rules: ' + priceList(kept) + '.';
        }
      }
      if (fix?.state === 'applied') {
        const parts = ['Stored prices repaired automatically. Input/output USD per million tokens.'];
        if (fix.changed.length) parts.push('Changed rows (' + fix.changed.length + '): ' + priceList(fix.changed) + '.');
        if (fix.added?.length) parts.push('Newly active rows (' + fix.added.length + '): ' + priceList(fix.added) + '.');
        if (fix.outdated?.length) parts.push('Outdated built-in rules removed (' + fix.outdated.length + '): ' + priceList(fix.outdated) + '.');
        if (fix.kept.length) parts.push('Kept custom rules (' + fix.kept.length + '): ' + priceList(fix.kept) + '.');
        if (fix.removed?.length) parts.push(fix.removed.length + ' built-in row' + (fix.removed.length === 1 ? ' stays' : 's stay') +
          ' removed: ' + priceList(fix.removed) + '. Reset restores them.');
        parts.push('Undo restores the previous stored prices.');
        this._notice(parts.join(' '), true);
      } else this._notice(info);
    } catch {
      saved = LS.get('prices', null);
      this._notice(!this._failed ? 'Price recovery could not read its backup. Current prices are loaded.' : priceRaw('prices') === fix?.result ?
        'The price repair is in effect but could not be recorded; it will be re-checked on reload.' :
        'Prices could not be repaired because storage is full/unavailable. Free storage and reload to finish recovery.');
    }
    this.rows = applyPriceEdits(Array.isArray(saved) ? priceEditsFromList(validPriceRows(saved), false) : isRecord(saved) ? saved : {}, moved);
    this._stampProvenance(); this._cache.clear(); this._loadedRows = this.rows.map(stripPriceRow);
    const orphans = isRecord(saved) ? validPriceRows(Array.isArray(saved.edited) ? saved.edited : []).filter(r => !DEFAULT_PRICES.some(d => d.pat === r.pat)) : [];
    if (!this._failed && !info && fix?.state !== 'applied' && moved.length) this._notice('Moved custom rules: ' + priceList(moved) + '.');
    if (!this._failed && !info && orphans.length) this._notice('Kept custom rules whose default patterns changed: ' + priceList(orphans.map(r => r.label)) + '.');
  },
  _discarded() { return JSON.stringify(this.rows.map(stripPriceRow)) === JSON.stringify(this._loadedRows) ? '' : ' Unsaved edits discarded.'; },
  keepRepair() {
    try {
      if (!this._current()) return false;
      const fix = priceFix();
      if (fix?.state !== 'applied') return false;
      const discarded = this._discarded();
      this._fix({ ...fix, state: 'kept' }); this.load(); this._notice('Kept stored prices.' + discarded); return true;
    } catch { this._notice('Prices could not be saved because storage is full/unavailable. Reload to retry.'); return false; }
  },
  undoRepair() {
    try {
      if (!this._current()) return false;
      const fix = priceFix();
      if (fix?.state !== 'applied') return false;
      if (this._raw !== fix.result) { this.load(); return false; }
      const backup = this._undoBackup(fix);
      if (backup === null) return false;
      const discarded = this._discarded();
      this._fix({ ...fix, state: 'undoing' });
      this._prices(backup);
      this._fix({ ...fix, state: 'undone' });
      this.load(); this._notice(PRICE_UNDONE + discarded); return true;
    } catch { this._notice('Undo could not finish because storage is full/unavailable. Reload to retry.'); return false; }
  },
  save() {
    let written = false;
    try {
      if (this._failed) {
        const rows = this.rows, baseline = this._loadedRows, previous = priceFix()?.state;
        if (previous !== 'applying' && !this._current()) return false;
        this.load();
        if (this._failed) {
          this.rows = rows; this._loadedRows = baseline; this._stampProvenance(); this._cache.clear();
          this._notice('Price edit was not saved: storage is full/unavailable; nothing was saved.'); return false;
        }
        const wanted = new Map(rows.map(r => [r.pat, rows.filter(x => x.pat === r.pat)])), prior = new Map(baseline.map(r => [r.pat, r]));
        this.rows = this.rows.filter(r => !prior.has(r.pat) || wanted.has(r.pat));
        let after = null;
        for (const r of rows) {
          if (!prior.has(r.pat) || !samePrice(r, prior.get(r.pat))) {
            const at = this.rows.findIndex(x => x.pat === r.pat);
            if (at >= 0) this.rows[at] = r; else {
              const anchor = this.rows.findIndex(x => x.pat === after);
              this.rows.splice(after === null ? 0 : anchor >= 0 ? anchor + 1 : Math.max(0, this.rows.length - 1), 0, r);
            }
          }
          if (this.rows.some(x => x.pat === r.pat)) after = r.pat;
        }
        this._stampProvenance(); this._cache.clear();
        if ((!previous || previous === 'applying' || previous === 'undoing') && priceFix()) {
          this._notice((this.notice?.text || 'Prices recovered.') + ' Price edit was not saved; make it again.', !!this.notice?.undo);
          return false;
        }
        // Keep existing editor inputs attached to the recovered row objects.
        this.rows = this.rows.map(r => Object.assign(wanted.get(r.pat)?.shift() || {}, r));
      }
      if (!this._current()) return false;
      const fix = priceFix();
      this._prices(JSON.stringify(priceEditsFromList(this.rows, true))); written = true;
      if (fix?.state === 'applied') this._fix({ ...fix, state: 'kept' });
      this._notice(null);
      this._stampProvenance(); this._cache.clear(); this._loadedRows = this.rows.map(stripPriceRow); return true;
    } catch {
      this._stampProvenance(); this._cache.clear();
      this._notice(written ? 'Price edit was saved, but recovery history could not be saved. Reload to retry.' :
        'Price edit was not saved: storage is full/unavailable; nothing was saved.'); return false;
    }
  },
  /** After an edit the in-memory rows carry the provenance a reload would give them: a row equal to its default keeps the vendor's verified
   *  date / confidence / source, an edited or added row reads c: 'user' with none (that provenance belonged to the vendor's number). */
  _stampProvenance() {
    const byPat = new Map(DEFAULT_PRICES.map(d => [d.pat, d]));
    for (const r of this.rows) {
      const d = byPat.get(r.pat);
      Object.assign(r, d && samePrice(r, d) ? { at: d.at, c: d.c, src: d.src } : { at: null, c: 'user', src: null });
    }
  },
  /** Plan 10 T3b: how many rows differ from the bundled set (edited + added + removed) — "N user edits" on the KPI footer and the CSV line. */
  editCount() { const e = priceEditsFromList(this.rows, true); return e.edited.length + e.added.length + e.removed.length; },
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
   *  the copy, never on a row in this.rows — cached per model|platform (save()/load() clear the cache). Plan 9 A2: the copy also says which
   *  rate won — source 'override' (+ overrideFor = the platform) when a PRICE_OVERRIDES row did, 'user' when the row is the user's own edit
   *  or addition, 'default' for a bundled row — so the UI can disclose it (an override makes an edit of the vendor row ineffective). */
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
    const fromOverride = !!hit && overrides.includes(hit);
    let fallback = false;
    if (!hit) { hit = this.rows[this.rows.length - 1] || { pat: '.*', in: 3, out: 15, cw: 3.75, cr: 0.3, label: 'Unknown model', c: 'existing' }; fallback = true; }
    else if (hit === this.fallbackRow()) fallback = true;
    const out = Object.assign({}, hit);
    if (aliasOf) out.aliasOf = aliasOf;
    if (fallback) out.fallback = true;
    if (fromOverride) out.overrideFor = platform;
    out.source = fromOverride ? 'override' : priceConfidence(hit) === 'user' ? 'user' : 'default';
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

