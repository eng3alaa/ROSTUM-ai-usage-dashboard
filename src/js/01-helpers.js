'use strict';
/* =================================================================
 * ROSTUM - AI Usage & Cost Monitor — single-file local dashboard
 * Part 1: utilities, theme, pricing, state store
 * ================================================================= */

/* ---------- tiny DOM helpers (textContent only — no HTML injection) ---------- */
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const isSvg = ['svg','g','rect','path','line','text','circle','defs','clipPath','title'].includes(tag);
  const n = isSvg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') { n.setAttribute('class', v); }
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) n.style.setProperty(sk, sv); else n.style[sk] = sv;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') { n.addEventListener(k.slice(2), v); }
    else if (k === 'text') { n.textContent = v; }
    else n.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
};
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };

/* ---------- formatting ---------- */
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fmtCompact = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K';
  return Math.round(n).toLocaleString('en-US');
};
const fmtUSD = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return '$' + Math.round(n).toLocaleString('en-US');
  if (a >= 100) return '$' + n.toFixed(0);
  if (a >= 1) return '$' + n.toFixed(2);
  if (a === 0) return '$0';
  return '$' + n.toFixed(3);
};
const fmtMetric = (n, metric) => metric === 'cost' ? fmtUSD(n) : fmtCompact(n);
/* CSV cell: neutralize spreadsheet formula prefixes, then apply CSV quoting */
const csvCell = (s) => {
  let v = String(s);
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
};
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ---------- dates (local timezone) ---------- */
const dayKey = (dateish) => {
  const d = dateish instanceof Date ? dateish : new Date(dateish);
  if (isNaN(d)) return null;
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};
const todayKey = () => dayKey(new Date());
/* UTC variant — for provider day-buckets (which are UTC days), never for local timestamps */
const dayKeyUTC = (dateish) => {
  const d = dateish instanceof Date ? dateish : new Date(dateish);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
};
/* Every network request carries a timeout (A0 #25): a provider that never answers must not leave a card at "Fetching…" forever. */
const REQUEST_TIMEOUT_MS = 30000;
const requestTimeout = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);
/* Provider payload numbers are untrusted — reject Infinity/NaN/garbage before they reach totals */
const finTok = (v) => Number.isFinite(v) && v >= 0 ? v : 0;   // counts: finite and non-negative only
const finAmt = (v) => Number.isFinite(v) ? v : 0;              // money: finite, negatives allowed (credits)
const RE_DATEONLY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (key, n) => { const d = new Date(key + 'T12:00:00'); d.setDate(d.getDate() + n); return dayKey(d); };
const dayRange = (from, to) => { const out = []; let k = from; let guard = 0; while (k <= to && guard++ < 4000) { out.push(k); k = addDays(k, 1); } return out; };
/* Fold a day list into week/month buckets when it exceeds what the pixel width can show */
function bucketDays(days, maxCols = 160) {
  if (days.length <= maxCols) return { buckets: days.map(d => ({ key: d, days: [d], label: fmtDayShort(d) })), unit: 'day' };
  const unit = Math.ceil(days.length / 7) <= maxCols ? 'week' : 'month';
  const map = new Map();
  for (const d of days) {
    let k;
    if (unit === 'week') {
      const dt = new Date(d + 'T12:00:00');
      k = addDays(d, -((dt.getDay() + 6) % 7));         // Monday-start week
    } else k = d.slice(0, 7) + '-01';
    let b = map.get(k);
    if (!b) { b = { key: k, days: [] }; map.set(k, b); }
    b.days.push(d);
  }
  const buckets = [...map.values()];
  for (const b of buckets) {
    // label uses the first day actually IN range (b.days[0]), not the bucket key — the
    // key can fall before the requested range start (e.g. the Monday of a week that
    // begins mid-week relative to the range).
    b.label = unit === 'week'
      ? 'Week of ' + fmtDayShort(b.days[0])
      : new Date(b.days[0] + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  return { buckets, unit };
}
const fmtDayShort = (key) => { const d = new Date(key + 'T12:00:00'); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };

/* ---------- A0 #23: what a stored blob may contain. One bad row must not poison totals (NaN) or crash the page — rows / envelopes / entries
 * without the shape the app writes are dropped and counted; Store.load announces the count in a banner. ---------- */
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** A usage row: a day key, platform + model strings, finite non-negative counts (coerced; an absent count reads 0) — or null. */
function validUsageRow(r) {
  if (!isRecord(r) || !RE_DATEONLY.test(String(r.d)) || typeof r.platform !== 'string' || typeof r.model !== 'string') return null;
  const out = { ...r };
  for (const k of ['in', 'cw', 'cr', 'out', 'msgs']) { const v = r[k] == null ? 0 : +r[k]; if (!Number.isFinite(v) || v < 0) return null; out[k] = v; }
  return out;
}
function loadSources(src, dropped) {
  const out = {};
  for (const [id, s] of Object.entries(isRecord(src) ? src : {})) {
    if (!isRecord(s) || !Array.isArray(s.rows)) { dropped.other++; continue; }
    const rows = []; for (const r of s.rows) { const v = validUsageRow(r); if (v) rows.push(v); else dropped.rows++; }
    out[id] = { rows, meta: isRecord(s.meta) ? s.meta : {} };
  }
  return out;
}
function loadBilled(b, dropped) {
  const out = {};
  for (const [id, v] of Object.entries(isRecord(b) ? b : {})) {
    const env = Array.isArray(v) ? { rows: v, at: null, stale: false } : v;   // v1 arrays migrate to { rows, at, stale } envelopes
    if (!isRecord(env) || !Array.isArray(env.rows)) { dropped.other++; continue; }
    const rows = []; for (const r of env.rows) { if (isRecord(r) && RE_DATEONLY.test(String(r.d)) && Number.isFinite(+r.amount)) rows.push({ ...r, amount: +r.amount }); else dropped.billed++; }
    out[id] = { rows, at: Number.isFinite(+env.at) ? +env.at : null, stale: env.stale === true };
  }
  return out;
}
function loadProjectsBy(pb, dropped) {
  const out = {};
  for (const [id, list] of Object.entries(isRecord(pb) ? pb : {})) {
    if (!Array.isArray(list)) { dropped.other++; continue; }
    out[id] = list.filter(p => { const ok = isRecord(p) && typeof p.project === 'string'; if (!ok) dropped.other++; return ok; });
  }
  return out;
}
function loadConnectors(c, dropped) {
  const out = {};
  for (const [id, st] of Object.entries(isRecord(c) ? c : {})) { if (isRecord(st)) out[id] = st; else dropped.other++; }
  return out;
}
function reportDropped(d) {
  const n = d.rows + d.billed + d.other;
  if (!n) return;
  showStorageBanner('data-warning', `${n} stored item${n === 1 ? ' was' : 's were'} unreadable and dropped on load (${d.rows} usage row${d.rows === 1 ? '' : 's'}, ${d.billed} billed amount${d.billed === 1 ? '' : 's'}, ${d.other} other) — totals exclude them; export a CSV backup if the numbers look wrong.`);
}

/* ---------- persistent settings ---------- */
/** One role="alert" banner per id at the top of the page (created on first use, its text replaced after) — textContent only. */
function showStorageBanner(id, text) {
  let s = document.getElementById(id);
  if (!s) {
    const wrap = document.querySelector('.wrap') || document.body;
    s = el('div', { id, class: 'err storage-banner', role: 'alert' });
    wrap.insertBefore(s, wrap.firstChild);
  }
  s.textContent = text;
}
const LS = {
  get(k, fallback) { try { const v = localStorage.getItem('aiusage:' + k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) {
    try { localStorage.setItem('aiusage:' + k, JSON.stringify(v)); }
    catch (e) {
      console.warn('localStorage full?', e);
      // Dedicated banner — NOT #import-status, which handleImportFiles clears at the
      // end of every import (Task 13), which would wipe a mid-import quota warning.
      showStorageBanner('storage-warning', 'Warning: browser storage is full — new data may not persist. Export a CSV backup, or Clear stored data.');
    }
  },
  del(k) { try { localStorage.removeItem('aiusage:' + k); } catch {} }
};

/* ---------- VIEW — hide/unhide + collapse preferences (aiusage:view) ----------
 * { hiddenCards: [connectorId], collapsed: [sectionId], hiddenInsights: [insightKey], showLegacySources: bool }
 * Always reversible; connecting a hidden card auto-reveals it (Store.setConnector → onConnectorChange). */
const VIEW_DEFAULTS = () => ({ hiddenCards: [], collapsed: [], hiddenInsights: [], showLegacySources: false });
const View = {
  prefs: VIEW_DEFAULTS(),
  load() {
    const s = LS.get('view', null);
    this.prefs = { ...VIEW_DEFAULTS(), ...(s && typeof s === 'object' ? s : {}) };
    for (const k of ['hiddenCards', 'collapsed', 'hiddenInsights']) if (!Array.isArray(this.prefs[k])) this.prefs[k] = [];
  },
  save() { LS.set('view', this.prefs); },
  _has(list, id) { return this.prefs[list].includes(id); },
  _add(list, id) { if (!this._has(list, id)) { this.prefs[list].push(id); this.save(); } },
  _del(list, id) { const i = this.prefs[list].indexOf(id); if (i >= 0) { this.prefs[list].splice(i, 1); this.save(); } },
  isCardHidden(id) { return this._has('hiddenCards', id); },
  hideCard(id) { this._add('hiddenCards', id); },
  revealCard(id) { this._del('hiddenCards', id); },
  showAllCards() { if (this.prefs.hiddenCards.length) { this.prefs.hiddenCards = []; this.save(); } },
  isCollapsed(id) { return this._has('collapsed', id); },
  toggleCollapse(id) { if (this.isCollapsed(id)) this._del('collapsed', id); else this._add('collapsed', id); },
  isInsightHidden(key) { return this._has('hiddenInsights', key); },
  hideInsight(key) { this._add('hiddenInsights', key); },
  showAllInsights() { if (this.prefs.hiddenInsights.length) { this.prefs.hiddenInsights = []; this.save(); } },
  setLegacySources(on) { this.prefs.showLegacySources = !!on; this.save(); },
  onConnectorChange(id, prev, next) { if (prev === 'off' && next !== 'off' && this.isCardHidden(id)) this.revealCard(id); },
};

/* Plan 9 A2: the generated price rows name some vendors by a lowercase slug ('xai', 'together') and others by their display name ('xAI',
 * 'Perplexity') — the price list groups by the display name, so each slug maps to one. */
const PRICE_VENDOR_NAMES = {
  xai: 'xAI', openai: 'OpenAI', google: 'Google', together: 'Together AI', deepinfra: 'DeepInfra', sambanova: 'SambaNova',
  groq: 'Groq', cerebras: 'Cerebras', perplexity: 'Perplexity', fireworks: 'Fireworks AI', cursor: 'Cursor', fallback: 'Fallback',
};
/* the two price-list table shapes: the editable vendor rows and the constant platform overrides */
const PRICE_TABLE_COLUMNS = {
  editable: ['Model (match pattern)', 'Label', 'Input', 'Output', 'Cache write', 'Cache read', 'Verified', ''],
  overrides: ['Platform', 'Model (match pattern)', 'Label', 'Input', 'Output', 'Cache write', 'Cache read', 'Verified'],
};

/* Sections with a ▾/▸ toggle. head = element that IS (or contains) the .card-head/.section-title/.row-head; body = ids hidden when collapsed. */
const SECTIONS = [
  { id: 'insights',  label: 'Insights',        head: 'insights-head',  body: ['insights'] },
  { id: 'narrative', label: 'Narrative',       head: 'card-narrative', body: ['narrative'] },
  { id: 'daily',     label: 'Daily usage',     head: 'card-daily',     body: ['daily-body'] },
  { id: 'models',    label: 'By model',        head: 'card-models',    body: ['models-body'] },
  { id: 'share',     label: 'Platform share',  head: 'card-share',     body: ['share-body'] },
  { id: 'breakdown', label: 'Model breakdown', head: 'card-breakdown', body: ['breakdown-table'] },
  { id: 'projects',  label: 'Projects',        head: 'card-projects',  body: ['projects-table'] },
  { id: 'budgets',   label: 'Budgets',         head: 'card-budgets',   body: ['budget-editor'] },
  { id: 'pricing',   label: 'API price list',  head: 'pricing-title',  body: ['card-pricing'] },
  { id: 'sources',   label: 'Data sources',    head: 'sources-title',  body: ['sources'] },
];

/* ---------- theme ---------- */
function initTheme() {
  const saved = LS.get('theme', null); // null = auto
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  $('theme-toggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const sysDark = matchMedia('(prefers-color-scheme: dark)').matches;
    const next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark' : (sysDark ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', next);
    LS.set('theme', next);
    App.render();
  });
}

