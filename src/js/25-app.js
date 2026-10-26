/* =================================================================
 * Part 4: application — filters, aggregation, KPIs, tables, wiring
 * ================================================================= */

/* ---------- tiny IndexedDB store (persists the folder handle) ---------- */
const IDB = {
  open() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open('aiusage', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  },
  async set(k, v) { try { const db = await this.open(); return new Promise((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = res; }); } catch {} },
  async get(k) { try { const db = await this.open(); return new Promise((res) => { const rq = db.transaction('kv').objectStore('kv').get(k); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); }); } catch { return null; } },
  async del(k) { try { const db = await this.open(); const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(k); } catch {} },
  async keys(prefix) { try { const db = await this.open(); return new Promise((res) => { const rq = db.transaction('kv').objectStore('kv').getAllKeys(); rq.onsuccess = () => res((rq.result || []).filter(k => typeof k === 'string' && k.startsWith(prefix))); rq.onerror = () => res([]); }); } catch { return []; } }
};

const App = {
  filters: {
    range: LS.get('range', '30'), from: LS.get('from', null), to: LS.get('to', null),
    hiddenPlatforms: new Set(LS.get('hiddenPlatforms', [])),
    metric: LS.get('metric', 'cost'),
    group: LS.get('group', 'platform')
  },
  views: {}, // cardId -> 'chart' | 'table'
  hiddenDaily: new Set(),
  hiddenShare: new Set(),
  dirHandle: null,
  _dirHandles: {},   // connectorId → FileSystemDirectoryHandle for folder-log connectors (IDB 'dir:<id>')
  _renderQueued: false,
  _drill: null,   // ephemeral platform drill-down (from an accounts-hub card click) — never persisted, never touches filters.hiddenPlatforms
  _hubQuery: '',   // hub search box text (never persisted)

  window() {
    const t = todayKey();
    // provider rows are keyed by UTC calendar day; in UTC-negative zones during the local
    // evening, "today" in UTC can already be one day ahead of local "today" — the upper
    // bound must cover whichever calendar is further along, or freshest data disappears.
    const tMax = (() => { const u = dayKeyUTC(new Date()); return u > t ? u : t; })();
    const span = Store.dateSpan();
    const f = this.filters;
    if (f.range === 'custom' && f.from && f.to) return { from: f.from, to: f.to };
    if (f.range === 'mtd') return { from: t.slice(0, 8) + '01', to: tMax };
    if (f.range === 'all') return { from: span.min || addDays(t, -29), to: span.max && span.max > tMax ? span.max : tMax };
    const n = parseInt(f.range, 10) || 30;
    return { from: addDays(t, -(n - 1)), to: tMax };
  },

  rowsIn(win) {
    const d = this._drill;
    return Store.allRows().filter(r => r.d >= win.from && r.d <= win.to && (d != null ? r.platform === d : !this.filters.hiddenPlatforms.has(r.platform)));
  },

  // platform-filtered rows with NO date-window bound — for insights/narrative sections
  // that intentionally look past the current date filter ("this month", "last 13 weeks").
  // Drilling overrides the chip-hidden set (so drilling into a hidden platform still shows
  // it) rather than ANDing with it — mirrors rowsIn().
  visibleRows() {
    const d = this._drill;
    return Store.allRows().filter(r => d != null ? r.platform === d : !this.filters.hiddenPlatforms.has(r.platform));
  },

  metricOf(r) {
    if (this.filters.metric === 'cost') return Pricing.cost(r.model, r);
    return (r.in || 0) + (r.cw || 0) + (r.cr || 0) + (r.out || 0);
  },

  /* ---------- master render ---------- */
  render() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => { this._renderQueued = false; this._render(); });
  },
  /** Run `pick` once the current rAF-batched render has committed (two frames: render() queues one, the re-query happens the next)
   *  and focus the element it returns — keeps keyboard focus off <body> when a hub re-render replaces the node that had it (✕ hide,
   *  group toggle, hidden chip, modal close). Never throws: a missing / detached / display:none pick just leaves focus where it is. */
  _focusAfterRender(pick) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try { const n = pick(); if (n && n.isConnected && typeof n.focus === 'function') n.focus(); } catch (e) { /* the target is gone — nothing to focus */ }
    }));
  },

  _render() {
    const win = this.window();
    const rows = this.rowsIn(win);
    const days = dayRange(win.from, win.to);
    const metric = this.filters.metric;
    const hasEst = rows.some(r => r.est);

    this.renderAlerts();
    this.renderChips();
    this.renderKPIs(win, rows, days);
    this.renderInsights(win, rows);
    this.renderNarrative(win, rows);
    this.renderHub();
    this.renderBudgets();
    this.renderDaily(days, rows, metric, hasEst);
    this.renderModels(rows, metric);
    this.renderShare(rows, metric);
    this.renderBreakdown(rows, hasEst);
    this.renderProjects(win);
    this.renderCoworkReported(win);
    this.renderSubtitle(rows);
    this.refreshPricingOnDataChange();
  },

  renderSubtitle(rows) {
    const span = Store.dateSpan();
    const srcNames = [];
    for (const c of CONNECTORS) {
      if (c.srcIds.some(id => Store.sources[id])) srcNames.push(c.name);
    }
    $('last-updated').textContent = srcNames.length
      ? `Data ${span.min || '—'} → ${span.max || '—'} · sources: ${srcNames.join(', ')} · rendered ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
      : 'No data yet — connect an account above.';
  },

  /* ---------- budgets & alerts ---------- */
  renderAlerts() {
    const box = clear($('alerts'));
    const all = Budgets.alerts();
    const un = this.unpricedAlert(); if (un) all.unshift(un);   // Plan 6: first — it qualifies the spend numbers the budget alerts are built on
    const MAX = 4;
    for (const a of all.slice(0, MAX)) {
      const n = el('div', { class: 'alert ' + a.level, 'data-kind': a.kind, role: 'status' },
        el('span', { text: (a.level === 'critical' ? '⛔ ' : '⚠ ') + a.msg }),
        a.kind === 'unpriced' ? el('button', { class: 'btn small alert-action', text: 'Set prices', onclick: () => this.showPricing() }) : null,
        el('button', { class: 'btn small alert-dismiss', text: 'Dismiss', onclick: () => { if (a.key) Budgets.dismissKey(a.key); else Budgets.dismiss(a.kind); this.render(); } }));
      box.appendChild(n);
    }
    if (all.length > MAX) box.appendChild(el('div', { class: 'note', text: `+${all.length - MAX} more — see Budgets` }));
  },
  /* ---------- Plan 6: unpriced models — models the price list does not know are priced at the fallback row; say so, never guess silently.
   *            Plan 10 T3b: the same notice also names the models whose price is only an estimate (a user-edited row, an unverified bundled row). ---------- */
  /** rows → one entry per model id { model, why, platforms: [..], msgs, tokens, cost } sorted by cost desc; tag(r) returns a reason string to
   *  include the row or null to skip it. Local rows (platform in LOCAL_PLATFORMS, or local:1 from a coding-tool parser) are $0 by rule and are
   *  never "guessed", so they are skipped. Totals and KPIs are NOT changed — this only names what was guessed or estimated. */
  _modelTotals(rows, tag) {
    const by = new Map();
    for (const r of rows) {
      if (r.local || LOCAL_PLATFORMS.has(r.platform)) continue;
      const why = tag(r); if (!why) continue;
      const m = String(r.model || '');
      let e = by.get(m);
      if (!e) { e = { model: m, why, platforms: [], msgs: 0, tokens: 0, cost: 0 }; by.set(m, e); }
      if (!e.platforms.includes(r.platform)) e.platforms.push(r.platform);
      e.msgs += r.msgs || 0; e.tokens += (r.in || 0) + (r.cw || 0) + (r.cr || 0) + (r.out || 0); e.cost += Pricing.cost(r.model, r);
    }
    return [...by.values()].sort((a, b) => b.cost - a.cost);
  },
  /** Rows whose model id resolves to the fallback ('.*') row (the fallback price still applies; this only names what was guessed). */
  unpricedModels(rows) { return this._modelTotals(rows, r => Pricing.isFallback(r.model, r.platform) ? 'fallback' : null); },
  /** Rows priced by a row the user edited or added, or by a bundled row that is not a verified list price (confidence low / existing). */
  estimatedPriceModels(rows) { return this._modelTotals(rows, r => this._estimateReason(Pricing.resolve(r.model, r.platform))); },
  _estimateReason(p) {
    if (p.fallback) return null;   // the first sentence has it
    if (p.source === 'user') return 'user price';
    if (p.c === 'existing') return PRICE_UNVERIFIED_TEXT;
    if (p.c === 'low') return 'low confidence';
    return null;
  },
  /** The #alerts notice, over ALL stored rows (like Budgets.alerts — it is about the price list vs the data you have, not the date window):
   *  first the fallback-priced models (serious), then the estimates. Dismissal keys on the sorted SET of model names — 'unpriced:<a,b,c>'
   *  when anything is fallback-priced, else 'estimates:<a,b,c>' (info level) — so a new model re-raises it. Text reaches the DOM via textContent. */
  unpricedAlert() {
    const rows = Store.allRows();
    const guessed = this.unpricedModels(rows), estimated = this.estimatedPriceModels(rows);
    if (!guessed.length && !estimated.length) return null;
    const names = (list) => list.map(u => u.model).sort().join(',');
    const key = guessed.length ? 'unpriced:' + names(guessed) : 'estimates:' + names(estimated);
    if (LS.get('dismissedAlerts', {})[key]) return null;
    const msg = [guessed.length ? this._guessedSentence(guessed) : '', estimated.length ? this._estimatedSentence(estimated) : ''].filter(Boolean).join(' ');
    return { kind: 'unpriced', key, msg, level: guessed.length ? 'serious' : 'info', models: guessed };
  },
  _namedModels(list, detail) {
    const MAXN = 5;
    const shown = list.slice(0, MAXN).map(u => `${u.model || '(no model id)'} (${detail(u)}${fmtCompact(u.msgs)} msg${u.msgs === 1 ? '' : 's'}, ${fmtUSD(u.cost)})`);
    return shown.join(', ') + (list.length > MAXN ? `, +${list.length - MAXN} more` : '');
  },
  /** the fallback prices are read from the fallback row, never hard-coded */
  _guessedSentence(list) {
    const fb = Pricing.fallbackRow() || { in: 0, out: 0 }, n = list.length;
    return `${n} model${n === 1 ? ' is' : 's are'} priced at the fallback rate ($${+fb.in || 0} in / $${+fb.out || 0} out per M): ${this._namedModels(list, () => '')} — set their prices in the API price list.`;
  },
  _estimatedSentence(list) {
    const n = list.length;
    return `${n} model${n === 1 ? ' is' : 's are'} priced from an unverified or user-edited row, so ${n === 1 ? 'its' : 'their'} cost is an estimate: ${this._namedModels(list, u => u.why + ', ')}.`;
  },
  /** "Set prices" — expand the price list section if it is collapsed and bring it into view. */
  showPricing() {
    View._del('collapsed', 'pricing'); this.applyCollapse();
    const head = $('pricing-title'); if (head) head.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  renderBudgets() {
    const box = clear($('budget-editor'));
    const st = Budgets.status();
    const rowFor = (key, label) => {
      const s = key === 'total' ? st.total : st.byPlatform[key];
      const inp = el('input', { type: 'number', min: '0', step: '1', placeholder: 'no limit', value: Budgets.limits[key] != null ? String(Budgets.limits[key]) : '' });
      inp.addEventListener('change', () => { Budgets.set(key, inp.value === '' ? null : +inp.value); this.render(); });
      const bar = el('div', { class: 'budget-bar' + (s ? (s.pct >= 100 ? ' over' : s.pct >= 80 ? ' warn' : '') : '') }, el('div', { class: 'fill', style: { width: (s ? Math.min(100, s.pct) : 0) + '%' } }));
      const note = el('div', { class: 'note', text: s ? `${fmtUSD(s.spent)} of ${fmtUSD(s.limit)} (${s.pct}%) · projected ${fmtUSD(s.projected)}` : 'no limit set' });
      return el('div', { class: 'budget-row', 'data-platform': key }, el('div', { text: label }), inp, el('div', {}, bar, note));
    };
    box.appendChild(rowFor('total', 'Total (all platforms)'));
    // the registry is large now — list Total + platforms you actually use (connected, budgeted, or with data), once per platform
    const emitted = new Set(), hasData = new Set(Store.allRows().map(r => r.platform));
    const wanted = (p) => Budgets.limits[p] != null || hasData.has(p);
    for (const c of CONNECTORS) {
      if (!c.platform || emitted.has(c.platform)) continue;
      // a platform shared by two connectors (GitHub Copilot: PAT card + CLI logs) counts as connected when EITHER is — an
      // 'off' first connector must not swallow the platform, so only an EMITTED platform is skipped, not a seen one
      if (!wanted(c.platform) && Store.connectorStatus(c) === 'off') continue;
      emitted.add(c.platform);
      box.appendChild(rowFor(c.platform, CONNECTORS.find(x => x.platform === c.platform).name));   // label = the platform's first card, whichever connector triggered the row
    }
    // import-only platforms (Cursor / Gemini app / ChatGPT / Claude.ai) have no connector entry — list any platform with data
    // or a budget that the loop above did not reach, so the note below is true
    for (const p of [...Store.platforms(), ...Object.keys(Budgets.limits)]) {
      if (p === 'total' || emitted.has(p) || !wanted(p)) continue;
      emitted.add(p);
      box.appendChild(rowFor(p, p));
    }
    box.appendChild(el('div', { class: 'note', text: 'Platforms appear here once connected, budgeted, or once they have data.' }));
  },

  /* ---------- print report ---------- */
  printReport(dryRun) {
    const win = this.window();
    const m = $('report-meta');
    m.hidden = false;
    const hidden = this.filters.hiddenPlatforms;
    const scope = this._drill ? ' · scope: ' + this._drill : hidden.size ? ' · hidden: ' + [...hidden].join(', ') : ' · all platforms';
    m.textContent = `AI usage report · ${fmtDayShort(win.from)} – ${fmtDayShort(win.to)} · Generated ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })} · API-equivalent costs are estimates at list prices${scope}`;
    if (!dryRun) { window.print(); }
  },

  /* ---------- insights ---------- */
  renderInsights(win, rows) {
    const today = todayKey();
    const costOf = (r) => Pricing.cost(r.model, r);
    const allRows = this.visibleRows();   // insights that need "this month"/"13 weeks" ignore the date filter, respect platform chips + drill
    // 1) projection
    const p = Insights.projection(allRows, costOf, today);
    $('ins-projection-value').textContent = fmtUSD(p.projected);
    $('ins-projection-note').textContent = `${fmtUSD(p.mtd)} so far · ${fmtUSD(p.avgDaily)}/day pace · ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'} left`;
    // 2) heatmap
    const metric = this.filters.metric;
    const hm = Insights.heatmap(allRows, (r) => this.metricOf(r), today, 13);
    renderHeatmap($('ins-heatmap'), hm, metric);
    // 3) WoW
    const w = Insights.weekOverWeek(allRows, costOf, today);
    const wowBox = clear($('ins-wow'));
    const chip = (label, cur, prev, fmt) => {
      const pct = prev > 0 ? Math.round(((cur - prev) / prev) * 100) : (cur > 0 ? 100 : 0);
      const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : '';
      return el('span', { class: 'wow-chip ' + cls, text: `${label} ${fmt(cur)} (${pct > 0 ? '+' : ''}${pct}%)` });
    };
    wowBox.appendChild(chip('cost', w.thisWeek, w.lastWeek, fmtUSD));
    wowBox.appendChild(chip('tokens', w.thisTok, w.lastTok, fmtCompact));
    wowBox.appendChild(chip('msgs', w.thisMsgs, w.lastMsgs, fmtCompact));
    // 4) cache savings (window rows)
    const cs = Insights.cacheSavings(rows);
    $('ins-cache-value').textContent = fmtUSD(cs.saved);
    $('ins-cache-note').textContent = cs.tokens ? `${fmtCompact(cs.tokens)} cache-read tokens vs. full input price` : 'no cache reads in range';
    // 5) hours
    const hb = Insights.busiestHours(rows);
    const hoursBox = clear($('ins-hours'));
    if (!hb.total) hoursBox.appendChild(el('div', { class: 'note', text: 'No timestamped events in range (local Claude logs carry hours; API buckets do not).' }));
    else { renderHourBars(hoursBox, hb); hoursBox.appendChild(el('div', { class: 'note', text: `peak ${hb.peak}:00 · ${fmtCompact(hb.total)} msgs with timestamps (hour detail kept 90 days)` })); }   // Store.compactRows drops the hour on rows older than 90 days
    // 6) efficiency
    const eff = Insights.efficiency(rows, costOf, 20);
    const effBox = clear($('ins-efficiency'));
    if (!eff.length) effBox.appendChild(el('div', { class: 'note', text: 'No model has 20+ messages in range yet.' }));
    else {
      const tbl = el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: 'model' }), el('th', { class: 'num', text: 'msgs' }), el('th', { class: 'num', text: '$/msg' }), el('th', { class: 'num', text: 'tok/msg' }))));
      const tb = el('tbody');
      for (const e of eff.slice(0, 6)) tb.appendChild(el('tr', {}, el('td', { text: e.model }), el('td', { class: 'num', text: fmtCompact(e.msgs) }), el('td', { class: 'num', text: fmtUSD(e.costPerMsg) }), el('td', { class: 'num', text: fmtCompact(e.tokPerMsg) })));
      tbl.appendChild(tb); effBox.appendChild(tbl);
    }
    // 7) movers — window vs previous equal-length window, by project (local rows only carry projects via Store.projects; use platform as the "project" surrogate when no projects)
    const len = dayRange(win.from, win.to).length;
    const prevWin = { from: addDays(win.from, -len), to: addDays(win.from, -1) };
    const grp = (rs) => { const m = new Map(); for (const r of rs) m.set(r.platform, (m.get(r.platform) || 0) + costOf(r)); return [...m.entries()].map(([project, cost]) => ({ project, cost })); };
    const currRows = rows, prevRows = this.visibleRows().filter(r => r.d >= prevWin.from && r.d <= prevWin.to);
    const mv = Insights.topMovers(grp(currRows), grp(prevRows), 5);
    const mvBox = clear($('ins-movers'));
    if (!mv.length) mvBox.appendChild(el('div', { class: 'note', text: 'No data in range yet.' }));
    else for (const m of mv) mvBox.appendChild(el('div', { class: 'note', text: `${m.project}: ${m.delta >= 0 ? '+' : '−'}${fmtUSD(Math.abs(m.delta))} (${fmtUSD(m.prev)} → ${fmtUSD(m.curr)})` }));
  },

  renderNarrative(win, rows) {
    const box = clear($('narrative'));
    $('narrative-range').textContent = `${fmtDayShort(win.from)} – ${fmtDayShort(win.to)}`;
    if (!rows.length) { box.appendChild(el('p', { text: 'Not enough data in this range to summarize yet.' })); return; }
    const costOf = (r) => Pricing.cost(r.model, r);
    let cost = 0, tok = 0, msgs = 0; const byModel = new Map(), byPlat = new Map(), byDay = new Map();
    for (const r of rows) {
      const c = costOf(r), tk = (r.in||0)+(r.cw||0)+(r.cr||0)+(r.out||0);
      cost += c; tok += tk; msgs += r.msgs || 0;
      byModel.set(r.model, (byModel.get(r.model) || 0) + c); byPlat.set(r.platform, (byPlat.get(r.platform) || 0) + c); byDay.set(r.d, (byDay.get(r.d) || 0) + c);
    }
    const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    const tm = top(byModel), tp = top(byPlat), td = top(byDay);
    const p = Insights.projection(this.visibleRows(), costOf, todayKey());
    const w = Insights.weekOverWeek(this.visibleRows(), costOf, todayKey());
    const S = [];
    // Plan 6: disclose the share of that figure that is only a guess (models no price row matches, priced at the fallback row)
    const un = this.unpricedModels(rows), unCost = un.reduce((s, u) => s + u.cost, 0);
    S.push(`You used ${fmtCompact(tok)} tokens across ${fmtCompact(msgs)} messages, worth about ${fmtUSD(cost)} at API list prices${unCost > 0 ? ` — ${fmtUSD(unCost)} of that is guessed at the fallback rate for ${un.length} unpriced model${un.length === 1 ? '' : 's'}` : ''}.`);
    if (tm && cost > 0) S.push(`${tm[0]} was the biggest line item at ${fmtUSD(tm[1])} (${Math.round(tm[1] / cost * 100)}% of spend)${tp ? `, and ${tp[0]} was the top platform` : ''}.`);
    if (td) S.push(`Your busiest day was ${fmtDayShort(td[0])} at ${fmtUSD(td[1])}.`);
    if (w.lastWeek > 0 || w.thisWeek > 0) S.push(`This week to date is ${w.pct === 0 ? 'flat' : (w.pct > 0 ? 'up ' : 'down ') + Math.abs(w.pct) + '%'} versus the same days last week.`);
    S.push(`At the current pace this month projects to ${fmtUSD(p.projected)} (${fmtUSD(p.mtd)} so far, ${p.daysLeft} days left).`);
    const b = typeof Budgets !== 'undefined' && Budgets.status ? Budgets.status() : null;
    if (b && b.total) {
      // Budgets.status() always totals ALL rows regardless of drill/chip scope — when the
      // narrative itself is filtered, say so, or the sentence silently mixes an account-wide
      // number into what reads as a platform-scoped summary.
      const scope = (this._drill || this.filters.hiddenPlatforms.size) ? ' (across all platforms)' : '';
      S.push(b.total.pct >= 100 ? `You are over your ${fmtUSD(b.total.limit)} monthly budget${scope}.` : `You have used ${b.total.pct}% of your ${fmtUSD(b.total.limit)} monthly budget${scope}.`);
    }
    for (const s of S) box.appendChild(el('p', { text: s }));
  },

  /* ---------- collapsible sections ---------- */
  wireCollapsibles() {
    for (const s of SECTIONS) {
      const host = $(s.head); if (!host) continue;
      const head = host.matches('.card-head, .section-title, .row-head') ? host : host.querySelector('.card-head, .section-title, .row-head');
      if (!head || head.querySelector('.collapse-btn')) continue;
      const btn = el('button', { class: 'collapse-btn', type: 'button', 'data-section': s.id, 'aria-label': 'Collapse ' + s.label, 'aria-controls': s.body.join(' ') });
      btn.addEventListener('click', () => { View.toggleCollapse(s.id); this.applyCollapse(); this.render(); });   // re-render: charts measure a hidden (0-width) container otherwise
      head.insertBefore(btn, head.firstChild);
    }
    this.applyCollapse();
  },
  applyCollapse() {
    for (const s of SECTIONS) {
      const on = View.isCollapsed(s.id);
      const btn = document.querySelector(`.collapse-btn[data-section="${s.id}"]`);
      if (btn) { btn.textContent = on ? '▸' : '▾'; btn.setAttribute('aria-expanded', String(!on)); btn.title = (on ? 'Expand ' : 'Collapse ') + s.label; btn.setAttribute('aria-label', btn.title); }
      for (const id of s.body) { const b = $(id); if (b) b.classList.toggle('sec-collapsed', on); }
    }
  },
  wireInsightHides() {
    for (const card of document.querySelectorAll('#insights .insight')) {
      if (card.querySelector('.insight-hide')) continue;
      const key = card.dataset.insight;
      card.appendChild(el('button', { class: 'insight-hide', type: 'button', text: '✕', title: 'Hide this insight', 'aria-label': 'Hide insight: ' + key,
        onclick: () => { View.hideInsight(key); this.applyInsightHides(); } }));
    }
    this.applyInsightHides();
  },
  applyInsightHides() {
    let n = 0;
    for (const card of document.querySelectorAll('#insights .insight')) { const h = View.isInsightHidden(card.dataset.insight); card.hidden = h; if (h) n++; }
    const chips = clear($('insights-chips'));
    if (n) chips.appendChild(el('button', { class: 'chip insights-hidden-chip', type: 'button', text: `${n} insight${n === 1 ? '' : 's'} hidden — show all`,
      onclick: () => { View.showAllInsights(); this.applyInsightHides(); } }));
  },
  wireLegacyToggle() {
    const cb = $('show-legacy-sources');
    cb.addEventListener('change', () => { View.setLegacySources(cb.checked); this.applyLegacySources(); });
    this.applyLegacySources();
  },
  applyLegacySources() {
    const on = !!View.prefs.showLegacySources;
    $('show-legacy-sources').checked = on;
    $('sources').classList.toggle('legacy-off', !on);
    $('sources-title').classList.toggle('legacy-off', !on);
  },

  /* ---------- accounts hub ---------- */
  hubCard(c, allRows, win30, bst) {
    const st = Store.connectors[c.id] || {};
    const status = Store.connectorStatus(c);
    // export-file: no entry → the "synced" line comes from the newest source meta (Store.setSource stamps meta.updated on import)
    const expAt = c.kind === 'export-file' ? Math.max(0, ...c.srcIds.map(sid => ((Store.sources[sid] || {}).meta || {}).updated || 0)) : 0;
    let rows;
    // membership by SOURCE (not platform) for imports, null-platform connectors, and any connector
    // that shares its platform with another (e.g. GitHub Copilot billing vs. Copilot CLI logs) —
    // otherwise both cards would show the same aggregate. Set built once from the card's own rows.
    const shared = CONNECTORS.some(x => x !== c && x.platform && x.platform === c.platform);
    if (c.srcIds.includes('csv') || !c.platform || shared) {
      const own = new Set(c.srcIds.flatMap(sid => (Store.sources[sid]?.rows) || []));
      rows = allRows.filter(r => own.has(r) && r.d >= win30.from && r.d <= win30.to);
    } else {
      rows = allRows.filter(r => r.platform === c.platform && r.d >= win30.from && r.d <= win30.to);
    }
    let tok = 0, cost = 0;
    for (const r of rows) { tok += (r.in||0)+(r.cw||0)+(r.cr||0)+(r.out||0); cost += Pricing.cost(r.model, r); }
    const linkOnly = c.kind === 'link-only';   // honest card: no data path → no Connect/Sync/Disconnect, never "connected"; reason + vendor usage link instead
    const L = c.links || {};
    const card = el('div', { class: 'acct' + (linkOnly ? ' link-only' : ''), 'data-connector': c.id, style: { '--acct-brand': c.brand }, tabindex: 0, role: 'button',
      'aria-label': `${c.name}: ${linkOnly ? 'no data path' : status === 'ok' ? 'connected' : status === 'warn' ? 'needs attention' : 'not connected'}` },
      el('div', { class: 'acct-head' },
        el('span', { class: 'mark', text: c.mark }),
        el('span', { class: 'acct-name', text: c.name }),
        c.quality ? el('span', { class: 'badge q-' + c.quality, text: QUALITY_LABEL[c.quality] || c.quality, title: c.qualityNote || '' }) : null,
        el('span', { class: 'dot ' + status }),
        el('button', { class: 'acct-hide', type: 'button', text: '✕', title: 'Hide this card', 'aria-label': 'Hide ' + c.name,
          onclick: (e) => { e.stopPropagation(); const next = this._hubNeighbour(e.currentTarget.closest('.acct')); View.hideCard(c.id); this.render();
            this._focusAfterRender(() => (next && document.querySelector(`#accounts-hub .acct[data-connector="${next}"]`)) || document.querySelector('#hub-chips .hub-hidden-chip')); }, onkeydown: (e) => e.stopPropagation() })),
      el('div', { class: 'acct-label', text: linkOnly ? (c.reason || 'No data path') : st.err ? ('⚠ ' + st.err) : (st.label || (c.kind === 'export-file' ? (status === 'off' ? 'No export imported yet' : 'from your data export') : status === 'off' ? 'Not connected' : '')) }),
      el('div', { class: 'acct-sync', text: st.lastSync ? ('Synced ' + new Date(st.lastSync).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
        : expAt ? ('Imported ' + new Date(expAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) : '' }),
      el('div', { class: 'acct-stats', text: rows.length ? `${fmtCompact(tok)} tokens · ${fmtUSD(cost)} (30d)` : '' }),
      (c.platform && Budgets.limits[c.platform]) ? (() => { const s = bst.byPlatform[c.platform]; return el('div', { class: 'budget-bar' + (s.pct >= 100 ? ' over' : s.pct >= 80 ? ' warn' : ''), title: `${fmtUSD(s.spent)} of ${fmtUSD(s.limit)} this month` }, el('div', { class: 'fill', style: { width: Math.min(100, s.pct) + '%' } })); })() : null,
      linkOnly
        ? el('div', { class: 'acct-actions' },
            el('button', { class: 'btn small acct-manage', text: 'Details', onclick: (e) => { e.stopPropagation(); this.openConnectorModal(c.id); } }),
            L.usage ? el('a', { class: 'btn small acct-usage-link', href: L.usage, target: '_blank', rel: 'noopener', text: 'Vendor usage page ↗', onclick: (e) => e.stopPropagation() }) : null)
        : c.kind === 'export-file'
        // export-file: no credential and nothing to disconnect — Manage (this card's copy) + Import file… (the Imports drop zone); the data belongs to Imports
        ? el('div', { class: 'acct-actions' },
            el('button', { class: 'btn small acct-manage', text: 'Manage', onclick: (e) => { e.stopPropagation(); this.openConnectorModal(c.id); } }),
            el('button', { class: 'btn small acct-import-btn', text: 'Import file…', onclick: (e) => { e.stopPropagation(); this.openImportsFor(c); } }))
        : el('div', { class: 'acct-actions' },
            el('button', { class: 'btn small acct-manage', text: status === 'off' ? 'Connect' : 'Manage', onclick: (e) => { e.stopPropagation(); this.openConnectorModal(c.id); } }),
            status !== 'off' && c.id !== 'imports' ? el('button', { class: 'btn small acct-sync-btn', text: 'Sync', onclick: (e) => { e.stopPropagation(); this.syncConnector(c.id); } }) : null,
            status !== 'off' ? el('button', { class: 'btn small', text: 'Disconnect', onclick: (e) => { e.stopPropagation(); this.disconnectConnector(c.id); } }) : null));
    // a link-only card never has rows, so there is nothing to drill into — click / Enter open its Details instead
    card.addEventListener('click', () => linkOnly ? this.openConnectorModal(c.id) : this.drillDown(c));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !(e.target && e.target.closest && e.target.closest('button,a,input'))) (linkOnly ? this.openConnectorModal(c.id) : this.drillDown(c)); });   // Enter on Manage/Sync/Disconnect is the button's own click, not a drill-down
    return card;
  },
  /** id of the card keyboard focus moves to when `card` leaves the hub: the next visible card in DOM order, else the previous one, else
   *  null (→ the "N hidden — show" chip). Cards inside a collapsed group are skipped — display:none cannot take focus. */
  _hubNeighbour(card) {
    const vis = [...document.querySelectorAll('#accounts-hub .acct')].filter(c => !c.closest('.sec-collapsed'));
    const i = vis.indexOf(card);
    const n = i < 0 ? null : (vis[i + 1] || vis[i - 1] || null);
    return n ? n.dataset.connector : null;
  },
  renderHub() {
    const hub = $('accounts-hub');
    clear(hub);
    // filter-independent bound — the card stats are always "last 30 real days", not
    // whatever the global date filter (which may be a custom past range) happens to be.
    const t2 = todayKey();
    const u2 = dayKeyUTC(new Date());
    const win30 = { from: addDays(t2, -29), to: u2 > t2 ? u2 : t2 };
    const allRows = Store.allRows();   // computed once — avoid O(connectors × N) rebuilds
    const bst = Budgets.status();      // computed once — avoid O(connectors) status rebuilds
    const visible = CONNECTORS.filter(c => !View.isCardHidden(c.id));
    const hiddenN = CONNECTORS.length - visible.length;
    const box = $('hub-search');
    box.hidden = visible.length <= 12;   // rule is on un-hidden cards, NOT on the query result — the box must not vanish while typing
    if (box.hidden && (this._hubQuery || box.value)) { this._hubQuery = ''; box.value = ''; }   // a hidden box must not keep filtering — drop the query with it
    const q = box.hidden ? '' : (this._hubQuery || '').trim().toLowerCase();
    const chips = clear($('hub-chips'));
    if (hiddenN) chips.appendChild(el('button', { class: 'chip hub-hidden-chip', type: 'button', text: `${hiddenN} hidden — show`, title: 'Show hidden account cards',
      onclick: () => { const was = new Set(View.prefs.hiddenCards); View.showAllCards(); this.render();
        // a restored card inside a collapsed group cannot take focus (display:none) → the first VISIBLE restored card, else the first visible card
        this._focusAfterRender(() => { const vis = [...document.querySelectorAll('#accounts-hub .acct')].filter(c => !c.closest('.sec-collapsed')); return vis.find(c => was.has(c.dataset.connector)) || vis[0] || null; }); } }));
    const rank = { ok: 0, warn: 1, off: 2 };
    for (const g of HUB_GROUPS) {
      const members = visible.filter(c => (c.category || 'api') === g.id && (!q || c.name.toLowerCase().includes(q)));
      if (!members.length) continue;
      const stat = new Map(members.map(c => [c.id, Store.connectorStatus(c)]));
      members.sort((a, b) => (rank[stat.get(a.id)] - rank[stat.get(b.id)]) || (CONNECTORS.indexOf(a) - CONNECTORS.indexOf(b)));
      const collapsed = View.isCollapsed('hub:' + g.id);
      const body = el('div', { class: 'hub-group-body' + (collapsed ? ' sec-collapsed' : '') });
      for (const c of members) body.appendChild(this.hubCard(c, allRows, win30, bst));
      const nConn = members.filter(c => stat.get(c.id) !== 'off').length;
      hub.appendChild(el('section', { class: 'hub-group', 'data-group': g.id, 'aria-label': g.label },
        el('div', { class: 'hub-group-head' },
          el('button', { class: 'collapse-btn', type: 'button', text: collapsed ? '▸' : '▾', 'aria-expanded': String(!collapsed), title: (collapsed ? 'Expand ' : 'Collapse ') + g.label,
            onclick: () => { View.toggleCollapse('hub:' + g.id); this.renderHub(); this._focusAfterRender(() => document.querySelector(`#accounts-hub .hub-group[data-group="${g.id}"] .collapse-btn`)); } }),
          el('h3', { text: g.label }),
          el('span', { class: 'hint', text: `${nConn} of ${members.length} connected` })),
        body));
    }
    if (q && !hub.firstElementChild) hub.appendChild(el('p', { class: 'hub-nomatch', text: `No accounts match "${(this._hubQuery || '').trim()}"` }));
    // reveal Data-sources cards for newly-connected platforms that start hidden in the HTML
    // (consistent with _restoreModalCard's re-hide-if-unconnected rule on modal close) — but
    // never touch a card that's currently open INSIDE the connector modal: any render while
    // the user is mid-edit (resize, timer, etc.) would otherwise blank it out from under them.
    for (const c of CONNECTORS) {
      if (c.kind === 'export-file') {   // no entry ever exists: reveal by data presence + refresh the card's status line from the rows
        const src = $('src-' + c.id), s = $(c.id + '-status'), status = Store.connectorStatus(c);
        if (src && src.parentNode !== $('modal-body')) src.hidden = status === 'off';
        if (s) {
          const n = c.srcIds.flatMap(sid => ((Store.sources[sid] || {}).rows) || []).reduce((a, r) => a + (r.msgs || 0), 0);
          s.textContent = '';
          if (status === 'off') s.textContent = 'No export imported yet.';
          else { s.appendChild(el('span', { class: 'ok', text: '● Imported. ' })); s.appendChild(document.createTextNode(`${fmtInt(n)} message${n === 1 ? '' : 's'} from your data export (via Imports).`)); }
        }
        continue;
      }
      const src = $('src-' + c.id);
      this._syncStatusLine(c);   // an entry without a connectKey / scan in this page (reload, DeepSeek ZIP) must not leave "Not connected." under a green dot
      if (!src || (!/^(gemini|copilot|openrouter)$/.test(c.id) && !src.classList.contains('generic'))) continue;   // generic = every ensureSourceCard kind (folder-log, local-server, link-only, key driver)
      if (src.parentNode !== $('modal-body')) src.hidden = !Store.connectors[c.id];
    }
  },

  /** Export-file cards: their data comes through the Imports card — open it (modal), say which export is expected, focus the drop zone. */
  openImportsFor(c) {
    this.openConnectorModal('imports');
    if (c) this._modalOpener = c.id;   // the export-file card launched it — focus goes back there on close, not to the Imports card
    const st = $('import-status');
    if (st && c) { clear(st); st.appendChild(el('div', { text: `Drop your ${c.platform || c.name} export here — ${c.hint || 'see the card for how to get it'}.` })); }
    const dz = $('dropzone'); if (dz) dz.focus();
  },
  openConnectorModal(id) {
    const c = connectorById(id);
    this._modalOpener = id;   // keyboard focus returns to this card's Manage button on close (re-queried — a render while open replaces the hub's nodes)
    const dlg = $('connector-modal');
    $('modal-title').textContent = c.name;
    $('modal-mark').textContent = c.mark;
    $('modal-mark').style.background = c.brand;
    const src = document.getElementById('src-' + (id === 'imports' ? 'import' : id));
    // switching cards while the dialog is open (an export-file card's in-modal "Import file…" → Imports): send the hosted card home
    // first (same restore + re-hide rule as close) so cards never stack in #modal-body — a stacked card was orphaned on close
    if (dlg.open && !(src && src.parentNode === $('modal-body'))) this._restoreModalCard();
    if (src) {
      if (src.parentNode !== $('modal-body')) this._modalHome = src.parentNode;   // guard against a corrupted home
      src.hidden = false;
      $('modal-body').appendChild(src);
    }
    if (!dlg.open) dlg.showModal();   // already open → the dialog just swaps content (showModal() again is invalid on an open dialog)
  },
  closeConnectorModal() { $('connector-modal').close(); },   // 'close' event (fires for Close-button AND Escape) does the restore
  /* ---------- Plan 8: Help dialog — static markup in the HTML; opened by the toolbar button or the `?` key, closed by Close / Esc / a click on the
   *  backdrop; the dialog's own 'close' event (every path) returns focus to #help-btn the way _focusModalOpener does for the hub ---------- */
  openHelp() { const d = $('help-modal'); if (!d.open) d.showModal(); },
  closeHelp() { const d = $('help-modal'); if (d.open) d.close(); },
  toggleHelp() { if ($('help-modal').open) this.closeHelp(); else this.openHelp(); },
  /** The `?` shortcut: never while typing (input / textarea / select / contenteditable) and never with a modifier — the key then keeps its own meaning. */
  _helpKey(e) {
    if (e.key !== '?' || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
    const t = e.target;
    if (t && t.nodeType === 1 && (t.closest('input, textarea, select') || t.isContentEditable)) return;
    e.preventDefault(); this.toggleHelp();
  },
  /** Copy the collector command — clipboard API only: without it (or when it refuses) the button simply stays "Copy"; on success it reads "Copied" for 1.5 s. */
  _copyHelpCommand() {
    const btn = $('help-copy');
    let p = null; try { if (navigator.clipboard && navigator.clipboard.writeText) p = navigator.clipboard.writeText($('help-cmd').textContent); } catch (err) { p = null; }
    if (!p || typeof p.then !== 'function') return;
    p.then(() => { btn.textContent = 'Copied'; clearTimeout(this._helpCopyTimer); this._helpCopyTimer = setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }, () => {});
  },
  _restoreModalCard() {
    if (!this._modalHome) return;
    for (const src of [...$('modal-body').children]) {   // EVERY hosted card goes home, not just the first — nothing is ever left orphaned in the dialog
      this._modalHome.appendChild(src);
      const cid = src.id.slice(4), cc = connectorById(cid);
      const connected = cc && cc.kind === 'export-file' ? Store.connectorStatus(cc) !== 'off' : !!Store.connectors[cid];   // export-file cards have no entry — data presence decides
      if ((/^src-(gemini|copilot|openrouter)$/.test(src.id) || src.classList.contains('generic')) && !connected) src.hidden = true;
    }
  },
  /** After the dialog closes: keyboard focus returns to the Manage / Connect / Details button of the card that opened it — re-queried by
   *  data-connector, because a render while the modal was open (connectKey, sync, resize) replaced the hub's nodes and the browser's own
   *  focus restore then lands on <body>; the card itself when its button is gone; nothing when the card is gone too (hidden / filtered). */
  _focusModalOpener() {
    const id = this._modalOpener;
    if (!id) return;
    this._focusAfterRender(() => document.querySelector(`#accounts-hub .acct[data-connector="${id}"] .acct-manage`) || document.querySelector(`#accounts-hub .acct[data-connector="${id}"]`));
  },
  /** Initial text of a card's status line — the single source of truth for EVERY card, the static ones included: shared by ensureSourceCard,
   *  _setInitialStatus (disconnectConnector, Clear stored data) and _syncStatusLine, so a reset never blanks a line: link-only cards keep their
   *  permanent "no data path" sentence, export-file cards wait for an export, the Imports drop zone starts empty, dual-driver folder lines
   *  (scan = true) name the folder they wait for, the static Claude Code card gets its tip line as a node-factory result (a fresh
   *  DocumentFragment: text + <code>%USERPROFILE%\.claude</code> + text — the path keeps its <code>), every other card reads "Not connected.". */
  initialStatusText(c, scan) {
    if (scan) return 'No ' + (c.folderLabel || 'usage-log') + ' folder chosen.';
    if (c.kind === 'link-only') return 'No data path — nothing to connect here; use the links below.';
    if (c.kind === 'export-file') return 'No export imported yet.';
    if (c.kind === 'files') return '';
    if (c.id === 'local') {
      const f = document.createDocumentFragment();
      f.appendChild(document.createTextNode('Not connected. Tip: in the folder picker, type '));
      f.appendChild(el('code', { text: '%USERPROFILE%\\.claude' }));
      f.appendChild(document.createTextNode(' in the address bar.'));
      return f;
    }
    return 'Not connected.';
  },
  /** Reset a card's status line to its initial text — a string → textContent, a node-factory result (the Claude Code tip) → the nodes appended
   *  to the cleared element — and release any in-flight placeholder (dataset.gen): the one write path disconnectConnector, Clear stored data
   *  and ensureSourceCard (node = the element being built) share. scan = true targets a dual-driver card's '<id>-scan-status' folder line
   *  (it carries no gen: the folder driver never holds one). Returns the element (null when the card has no such line). */
  _setInitialStatus(c, scan, node) {
    const s = node || (scan ? $(c.id + '-scan-status') : $(c.statusEl));
    if (!s) return null;
    const t = this.initialStatusText(c, scan);
    s.textContent = '';
    if (typeof t === 'string') s.textContent = t; else s.appendChild(t);
    if (!scan) s.dataset.gen = '';
    return s;
  },
  /** A card whose entry exists while its status line still reads its initial text (entry restored from storage on reload; DeepSeek
   *  connected by its usage ZIP alone — no connectKey / scan wrote the line in this page) is revealed as connected by renderHub, so derive the
   *  line from the entry instead of contradicting the green dot. dataset.gen guard: an in-flight fetch / validation owns its line.
   *  "Still initial" = textContent equality with initialStatusText(c) (a node-factory result compares by its fragment's text), and only the
   *  plain "Not connected." placeholder is ever derived — a card whose own initial line says more keeps it (the Claude Code tip with its
   *  <code> path stays until restoreHandle / a scan writes the line; the Imports log starts empty and is no connection state). Never for a
   *  dual-driver card's SERVER line while the entry has no serverLabel — a folder-only scan (or its reload) connects the folder half only,
   *  and '<id>-scan-status' already says so; rewriting '<id>-status' would claim a server nobody validated. */
  _syncStatusLine(c) {
    const s = $(c.statusEl), st = Store.connectors[c.id];
    if (!s || !st || s.dataset.gen) return;
    const init = this.initialStatusText(c), initText = typeof init === 'string' ? init : init.textContent;
    if (s.textContent !== initText || initText !== 'Not connected.') return;   // a driver already wrote the line, or the card's own initial line says more than the placeholder
    if (c.baseUrl && c.patterns && !st.serverLabel) return;       // dual-driver card, folder-only entry: '<id>-status' is the SERVER line — leave it "Not connected."
    s.textContent = '';
    if (st.err) { s.appendChild(el('span', { class: 'err', text: 'Needs attention: ' })); s.appendChild(document.createTextNode(st.err)); return; }
    const when = st.lastSync ? ' · synced ' + new Date(st.lastSync).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    if (c.id === 'deepseek' && /^usage export/.test(st.label || '')) {   // landDeepSeek's entry: the monthly ZIP connects the card, a key only validates
      s.appendChild(el('span', { class: 'ok', text: '● Connected. ' })); s.appendChild(document.createTextNode('usage export imported — key optional' + when));
      return;
    }
    s.appendChild(el('span', { class: 'ok', text: '● Connected' })); s.appendChild(document.createTextNode(' (stored data)' + when));
  },
  syncConnector(id) {
    if (id === 'local') return this.rescan();
    const c = connectorById(id);
    if (c && c.kind === 'folder-log') return this._viaCollector(id) ? this.rescanViaCollector(id) : this.rescanFolder(id);   // v7: a collector-fed tool re-reads through the collector, not the handle / picker
    if (c && c.kind === 'export-file') return this.openImportsFor(c);   // nothing to sync — the export is re-dropped by hand
    if (c && c.kind === 'local-server') { const jobs = [this.connectServer(c)]; if (this._viaCollector(id)) jobs.push(this.rescanViaCollector(id)); else if (this._dirHandles[id]) jobs.push(this.rescanFolder(id)); return Promise.all(jobs); }
    if (c && c.kind === 'link-only') return;   // honest card: nothing to sync
    if (c && c.keyLS) {
      const inp = document.getElementById(id + '-key');
      const hasKey = (inp && inp.value.trim()) || LS.get(c.keyLS, null);
      if (!hasKey) { this.openConnectorModal(id); return; }   // no key anywhere — surface the card, not a silent no-op/network call
      if (inp && !inp.value.trim()) { const saved = LS.get(c.keyLS, null); if (saved) inp.value = saved; }
    }
    if (c && c.kind === 'collector') return this.connectCollector(c);   // v7 (the keyLS block above surfaced the card when no token exists anywhere and pre-filled a remembered one)
    if (c && c.fetch) return this.connectKey(c);   // key driver — every key card (the keyLS block above already opened the modal when no key exists anywhere and pre-filled a remembered key)
  },
  disconnectConnector(id) {
    const c = connectorById(id);
    if (c.kind === 'link-only') return;   // never connected, nothing stored — no prompt, no state change
    if (c.keyLS) LS.del(c.keyLS);
    const keyInput = document.getElementById(id + '-key'); if (keyInput) keyInput.value = '';
    for (const f of c.fields || []) { LS.del('field:' + id + ':' + f.id); const fe = $(id + '-f-' + f.id); if (fe) fe.value = ''; }   // key-driver extra fields: stored values + inputs
    if (c.fetch || c.kind === 'collector') { const rem = $('remember-' + id); if (rem) rem.checked = false; }
    delete Store.connectors[id];
    // an in-flight scan / fetch / server validation for this connector must NOT commit after the disconnect and resurrect it
    this._gen[id] = (this._gen[id] || 0) + 1; this._gen[id + ':server'] = (this._gen[id + ':server'] || 0) + 1;
    if (id === 'local') { IDB.del('claudeDir'); this.dirHandle = null; $('rescan-local').hidden = true; }
    // every status line back to its initial text — the plain "Not connected." or the Claude Code tip with its <code> path — and it must survive
    // an in-flight fetch/validation that bails on the gen bump: those clear the status only while status.dataset.gen is still theirs, so
    // _setInitialStatus resets it here (the scan-status line carries no gen)
    this._setInitialStatus(c);
    if (c.kind === 'folder-log' || c.kind === 'local-server') {
      if (c.poll) { this.stopPoll(c); LS.del('poll:' + id); }   // metrics-poll: stop the loop and forget the counter baseline (a reconnect starts from the current counters)
      delete this._dirHandles[id]; IDB.del('dir:' + id);   // unconditional: a handle may be persisted in IDB without being restored into memory (denied permission, early disconnect)
      const rs = $(id + '-rescan'); if (rs) rs.hidden = true;
      this._setInitialStatus(c, true);   // dual-driver cards: reset the folder line too (same noun as ensureSourceCard)
    }
    if (c.kind === 'collector') {   // v7: the collector owns no rows — only its token (input / Remember / LS, cleared above), its entry and its tools table go; the tools keep their entries AND their data (no prompt)
      this.stopCollectorWatch(c);   // T3: automatic mode ends with the entry (a tick never re-creates it; an in-flight tick commits nothing)
      const fed = Object.keys(this._collectorSnap); this._collectorSnap = {}; this._collectorSummary = []; this._collectorExcluded = new Set();   // the exclusion list went with the entry (review m3)
      for (const tid of fed) { const rs = $(tid + '-rescan'); if (rs) rs.hidden = !this._dirHandles[tid]; }   // the tools' Re-scan buttons back to the folder-handle rule
      if (fed.includes('local')) $('rescan-local').hidden = !this.dirHandle;
      this._renderCollectorTools($('collector-tools'), []);
      Store.persist(); this.render(); return;
    }
    if (Store.connectors.collector && this._collectorReadable(c)) {   // v7 (review m3): disconnected while the collector feeds it → out of the collector's snapshot AND its reads (an otherwise
      delete this._collectorSnap[id]; this._collectorExcluded.add(id);   // unchanged tick would re-land it, deleted data included) until Validate & connect on the collector card; persisted on its entry
      const cc = connectorById('collector');
      if (this._collectorSummary.length) {   // a walk happened on this page: the collector's label / line / table follow now (quiet: nothing was checked)
        const summary = this._collectorSummary.map(x => ({ ...x })), row = summary.find(x => x.id === id); if (row) row.files = 'disconnected';
        this._collectorCommit(cc, { ...this._collectorSnap }, summary, { quiet: true });
      } else Store.setConnector(cc.id, { excluded: [...this._collectorExcluded] });   // restored entry, no walk yet (or none that landed): just remember the exclusion
    }
    if (confirm(`Also delete ${c.name}'s stored usage data? OK = delete, Cancel = keep the data.`)) {
      for (const sid of c.srcIds) delete Store.sources[sid];
      for (const sid of c.srcIds) delete Store.billed[sid];
      if (id === 'local') Store.projects = [];
      delete Store.projectsBy[id];   // folder-log project rows are data — go with the data, stay on keep-data
    }
    Store.persist();
    this.render();
  },

  drillDown(c) {
    // ephemeral view filter, layered on top of the persisted chip state — never touches
    // filters.hiddenPlatforms, so it never leaks into localStorage.
    if (!c.platform) { this._drill = null; this.render(); return; }   // imports → show everything
    this._drill = this._drill === c.platform ? null : c.platform;
    View._del('collapsed', 'daily'); this.applyCollapse();   // never drill onto a bare collapsed header
    this.render();
    $('card-daily').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  /* ---------- platform chips ---------- */
  /** platforms with data split by palette slot: 'slotted' keep their own color; 'folded' (no free slot, ColorMap -1) draw as
   *  ONE gray 'Other' in the chips, the share bar and its legend/table, and the daily stacked series (seriesFor, 'By platform').
   *  A real 'Other' platform (generic CSV rows) joins the fold when one exists, so no view shows two entries named Other. */
  foldPlatforms(platforms, candidates) {
    const slotted = [], folded = [];
    for (const p of platforms) (ColorMap.slotFor('platform', p, candidates) === -1 ? folded : slotted).push(p);
    if (folded.length && slotted.includes('Other')) { slotted.splice(slotted.indexOf('Other'), 1); folded.push('Other'); }
    return { slotted, folded, otherColor: getComputedStyle(document.documentElement).getPropertyValue('--other').trim() };
  },
  renderChips() {
    const box = $('platform-chips');
    clear(box);
    if (this._drill) {
      const pill = el('button', { class: 'chip drill-pill', type: 'button', title: 'Clear drill-down' },
        el('span', { text: `drilled: ${this._drill} — clear` }));
      pill.addEventListener('click', () => { this._drill = null; this.render(); });
      box.appendChild(pill);
    }
    const platforms = Store.platforms();
    const candidates = platforms;
    const { slotted, folded, otherColor } = this.foldPlatforms(platforms, candidates);
    const toggle = (names, hide) => {
      for (const p of names) hide ? this.filters.hiddenPlatforms.add(p) : this.filters.hiddenPlatforms.delete(p);
      LS.set('hiddenPlatforms', [...this.filters.hiddenPlatforms]);
      this.render();
    };
    for (const p of slotted) {
      const color = ColorMap.colorOf('platform', p, candidates);
      const chip = el('button', { class: 'chip', 'aria-pressed': this.filters.hiddenPlatforms.has(p) ? 'false' : 'true' },
        el('span', { class: 'sw', style: { background: color } }),
        el('span', { text: p })
      );
      chip.addEventListener('click', () => toggle([p], !this.filters.hiddenPlatforms.has(p)));
      box.appendChild(chip);
    }
    if (folded.length) {   // overflow platforms: one chip toggles them together; its title names them
      const allHidden = folded.every(p => this.filters.hiddenPlatforms.has(p));
      const chip = el('button', { class: 'chip', 'aria-pressed': allHidden ? 'false' : 'true', title: 'Other: ' + folded.join(', ') },
        el('span', { class: 'sw', style: { background: otherColor } }),
        el('span', { text: 'Other' })
      );
      chip.addEventListener('click', () => toggle(folded, !allHidden));
      box.appendChild(chip);
    }
  },

  /* ---------- KPIs ---------- */
  renderKPIs(win, rows, days) {
    const metricTotals = { cost: 0, tok: 0, out: 0, msgs: 0 };
    const byDayCost = new Map(), byDayTok = new Map(), byDayOut = new Map(), byDayMsgs = new Map();
    for (const r of rows) {
      const c = Pricing.cost(r.model, r);
      const tk = (r.in || 0) + (r.cw || 0) + (r.cr || 0) + (r.out || 0);
      metricTotals.cost += c; metricTotals.tok += tk; metricTotals.out += r.out || 0; metricTotals.msgs += r.msgs || 0;
      byDayCost.set(r.d, (byDayCost.get(r.d) || 0) + c);
      byDayTok.set(r.d, (byDayTok.get(r.d) || 0) + tk);
      byDayOut.set(r.d, (byDayOut.get(r.d) || 0) + (r.out || 0));
      byDayMsgs.set(r.d, (byDayMsgs.get(r.d) || 0) + (r.msgs || 0));
    }
    $('kpi-cost').textContent = fmtUSD(metricTotals.cost);
    $('kpi-tokens').textContent = fmtCompact(metricTotals.tok);
    $('kpi-output').textContent = fmtCompact(metricTotals.out);
    $('kpi-msgs').textContent = fmtCompact(metricTotals.msgs);
    $('kpi-foot').textContent = 'Costs are API-equivalent at the currently loaded list prices — ' + this.priceSetLine();

    // deltas vs previous window of equal length
    const len = days.length;
    const prevWin = { from: addDays(win.from, -len), to: addDays(win.from, -1) };
    const prevRows = this.rowsIn(prevWin);
    let pCost = 0, pTok = 0, pOut = 0, pMsgs = 0;
    for (const r of prevRows) {
      pCost += Pricing.cost(r.model, r);
      pTok += (r.in || 0) + (r.cw || 0) + (r.cr || 0) + (r.out || 0);
      pOut += r.out || 0; pMsgs += r.msgs || 0;
    }
    const setDelta = (id, cur, prev, moralize) => {
      const n = $(id); clear(n); n.className = 'delta';
      if (!prev || this.filters.range === 'all') return;
      const pct = ((cur - prev) / prev) * 100;
      if (!isFinite(pct)) return;
      const up = pct >= 0;
      if (moralize) n.classList.add(up ? 'up-bad' : 'down-good');
      n.appendChild(el('span', { text: `${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}% vs previous ${len}d` }));
    };
    setDelta('kpi-cost-delta', metricTotals.cost, pCost, true);
    setDelta('kpi-tokens-delta', metricTotals.tok, pTok, false);
    setDelta('kpi-output-delta', metricTotals.out, pOut, false);
    setDelta('kpi-msgs-delta', metricTotals.msgs, pMsgs, false);

    // sparklines — 12 buckets over the window
    const spark = (byDay) => {
      const vals = days.map(d => byDay.get(d) || 0);
      if (vals.length <= 12) return vals;
      const out = []; const chunk = vals.length / 12;
      for (let i = 0; i < 12; i++) {
        const s = Math.floor(i * chunk), e = Math.floor((i + 1) * chunk);
        out.push(vals.slice(s, Math.max(e, s + 1)).reduce((a, b) => a + b, 0));
      }
      return out;
    };
    renderSparkline($('spark-cost'), spark(byDayCost));
    renderSparkline($('spark-tokens'), spark(byDayTok));
    renderSparkline($('spark-output'), spark(byDayOut));
    renderSparkline($('spark-msgs'), spark(byDayMsgs));

    // actual billed
    let billed = 0, any = false, anyStale = false;
    for (const id of Object.keys(Store.billed)) {
      const env = Store.billed[id];
      if (env && !Array.isArray(env) && env.stale) anyStale = true;
      for (const b of Store.billedRows(id)) if (b.d >= win.from && b.d <= win.to) { billed += b.amount; any = true; }
    }
    $('kpi-billed').textContent = any ? fmtUSD(billed) : '—';
    $('kpi-billed-note').textContent = any
      ? (anyStale ? '⚠ includes stale data — a cost fetch failed; re-sync to refresh' : 'as reported by provider cost APIs')
      : 'Connect Anthropic/OpenAI admin keys';
  },

  /* ---------- daily stacked chart ---------- */
  seriesFor(rows, days, groupKind) {
    // deterministic candidate order for color slots: canonical for platforms, by all-time total for models
    let names, candidates, foldSet = null;
    if (groupKind === 'platform') {
      candidates = Store.platforms();
      names = candidates.filter(p => rows.some(r => r.platform === p));
      foldSet = new Set(this.foldPlatforms(candidates, candidates).folded);   // the SAME fold as renderChips / renderShare — a real 'Other' platform joins it, never collides with it
    } else {
      const totals = new Map();
      for (const r of Store.allRows()) totals.set(r.model, (totals.get(r.model) || 0) + this.metricOf(r));
      candidates = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
      const present = new Set(rows.map(r => r.model));
      names = candidates.filter(m => present.has(m));
    }
    const series = [];
    const other = { name: groupKind === 'platform' ? 'Other' : 'Other models', color: '', values: days.map(() => 0), isOther: true };
    const idx = new Map(days.map((d, i) => [d, i]));
    const byName = new Map();
    for (const name of names) {
      const fold = foldSet ? foldSet.has(name) : ColorMap.slotFor(groupKind, name, candidates) === -1;
      const s = { name, color: ColorMap.colorOf(groupKind, name, candidates), values: days.map(() => 0), fold };
      byName.set(name, s);
      if (!s.fold) series.push(s);
    }
    for (const r of rows) {
      const name = groupKind === 'platform' ? r.platform : r.model;
      const s = byName.get(name);
      const i = idx.get(r.d);
      if (i == null) continue;
      const v = this.metricOf(r);
      if (!s || s.fold) other.values[i] += v;
      else s.values[i] += v;
    }
    if (other.values.some(v => v > 0)) {
      other.color = getComputedStyle(document.documentElement).getPropertyValue('--other').trim();
      series.push(other);
    }
    return series;
  },

  renderDaily(days, rows, metric, hasEst) {
    const series = this.seriesFor(rows, days, this.filters.group).filter(s => !this.hiddenDaily.has(s.name));
    const box = $('daily-chart');
    $('daily-title').textContent = metric === 'cost' ? 'Daily API-equivalent cost' : 'Daily tokens';
    $('daily-hint').textContent = (this.filters.group === 'platform' ? 'stacked by platform' : 'stacked by model') + (hasEst ? ' · includes estimates' : '');
    if (!rows.length) { clear(box); box.appendChild(this.emptyNode()); clear($('daily-legend')); this.fillDailyTable(days, [], metric); return; }
    renderStackedColumns(box, { days, series, metric });
    const allSeries = this.seriesFor(rows, days, this.filters.group);
    renderLegend($('daily-legend'), allSeries, this.hiddenDaily, (name) => {
      this.hiddenDaily.has(name) ? this.hiddenDaily.delete(name) : this.hiddenDaily.add(name);
      this.render();
    });
    this.fillDailyTable(days, allSeries, metric);
  },

  fillDailyTable(days, series, metric) {
    const wrap = $('daily-table');
    clear(wrap);
    const thead = el('thead', {}, el('tr', {},
      el('th', { text: 'Day' }),
      ...series.map(s => el('th', { text: s.name })),
      el('th', { text: 'Total' })));
    const tbody = el('tbody');
    days.forEach((d, i) => {
      const total = series.reduce((a, s) => a + (s.values[i] || 0), 0);
      if (!total) return;
      tbody.appendChild(el('tr', {},
        el('td', { text: d }),
        ...series.map(s => el('td', { text: s.values[i] ? fmtMetric(s.values[i], metric) : '·' })),
        el('td', { text: fmtMetric(total, metric) })));
    });
    wrap.appendChild(el('table', { class: 'data' }, thead, tbody));
  },

  /* ---------- models chart ---------- */
  renderModels(rows, metric) {
    const totals = new Map();
    const extras = new Map();
    for (const r of rows) {
      totals.set(r.model, (totals.get(r.model) || 0) + this.metricOf(r));
      let x = extras.get(r.model);
      if (!x) { x = { tok: 0, msgs: 0, cost: 0 }; extras.set(r.model, x); }
      x.tok += (r.in || 0) + (r.cw || 0) + (r.cr || 0) + (r.out || 0);
      x.msgs += r.msgs || 0;
      x.cost += Pricing.cost(r.model, r);
    }
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 10);
    const restSum = sorted.slice(10).reduce((a, e) => a + e[1], 0);
    const styles = getComputedStyle(document.documentElement);
    const c1 = styles.getPropertyValue('--s1').trim();
    const items = top.map(([name, value]) => ({
      name, value,
      extra: [
        { name: 'tokens', value: fmtCompact(extras.get(name).tok) },
        { name: 'requests', value: fmtCompact(extras.get(name).msgs) },
        { name: metric === 'cost' ? 'tokens total' : 'API-equivalent cost', value: metric === 'cost' ? fmtCompact(extras.get(name).tok) : fmtUSD(extras.get(name).cost) }
      ]
    }));
    if (restSum > 0) items.push({ name: `Other (${sorted.length - 10})`, value: restSum });
    const box = $('models-chart');
    if (!items.length) { clear(box); box.appendChild(this.emptyNode()); clear($('models-table')); return; }
    renderHBars(box, { items, metric, color: c1 });
    // table twin
    const wrap = $('models-table');
    clear(wrap);
    const tbody = el('tbody');
    for (const [name, value] of sorted) {
      const x = extras.get(name);
      tbody.appendChild(el('tr', {},
        el('td', { class: 'name', text: name }),
        el('td', { text: fmtCompact(x.tok) }),
        el('td', { text: fmtCompact(x.msgs) }),
        el('td', { text: fmtUSD(x.cost) })));
    }
    wrap.appendChild(el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, el('th', { text: 'Model' }), el('th', { text: 'Tokens' }), el('th', { text: 'Requests' }), el('th', { text: 'Cost (API-equiv.)' }))),
      tbody));
  },

  /* ---------- platform share ---------- */
  renderShare(rows, metric) {
    const candidates = Store.platforms();
    const totals = new Map();
    for (const r of rows) totals.set(r.platform, (totals.get(r.platform) || 0) + this.metricOf(r));
    const { slotted, folded, otherColor } = this.foldPlatforms(candidates.filter(p => totals.get(p) > 0), candidates);
    const entries = slotted.map(p => ({ name: p, value: totals.get(p), color: ColorMap.colorOf('platform', p, candidates) }));
    if (folded.length) entries.push({ name: 'Other', value: folded.reduce((a, p) => a + totals.get(p), 0), color: otherColor });   // overflow platforms → one wedge
    const items = entries.filter(it => !this.hiddenShare.has(it.name));
    const box = $('share-chart');
    $('share-hint').textContent = metric === 'cost' ? 'of API-equivalent cost' : 'of tokens';
    if (!items.length) { clear(box); box.appendChild(this.emptyNode()); clear($('share-legend')); clear($('share-table')); return; }
    renderShareBar(box, { items, metric });
    const allItems = entries.map(it => ({ name: it.name, color: it.color }));
    renderLegend($('share-legend'), allItems, this.hiddenShare, (name) => {
      this.hiddenShare.has(name) ? this.hiddenShare.delete(name) : this.hiddenShare.add(name);
      this.render();
    });
    // table twin
    const total = items.reduce((a, b) => a + b.value, 0);
    const wrap = $('share-table');
    clear(wrap);
    const tbody = el('tbody');
    for (const it of items) {
      tbody.appendChild(el('tr', {},
        el('td', {}, el('span', { class: 'swdot', style: { background: it.color } }), document.createTextNode(it.name)),
        el('td', { text: fmtMetric(it.value, metric) }),
        el('td', { text: (100 * it.value / total).toFixed(1) + '%' })));
    }
    wrap.appendChild(el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, el('th', { text: 'Platform' }), el('th', { text: metric === 'cost' ? 'Cost' : 'Tokens' }), el('th', { text: 'Share' }))),
      tbody));
  },

  /* ---------- breakdown table ---------- */
  /** Plan 6 + Plan 9 A2: which rate priced this line — the fallback row, a retired id's successor, a platform's own PRICE_OVERRIDES rate, a
   *  user-edited row. Local-only lines ($0 by rule) carry none. */
  priceBadges(b) {
    if (!b.priced) return [];
    const p = Pricing.resolve(b.model, b.platform), out = [];
    if (p.fallback) out.push(el('span', { class: 'badge fallback-price', text: 'fallback price', title: 'No price row matches this model — priced at the Unknown-model row; add a row in the API price list' }));
    if (p.aliasOf) out.push(el('span', { class: 'badge price-note alias-price', text: 'priced as ' + p.aliasOf, title: `${b.model} is retired — the vendor routes and bills it as ${p.aliasOf}, so that row prices it` }));
    if (p.overrideFor) out.push(el('span', { class: 'badge price-note override-price', text: p.overrideFor + ' rate', title: `${p.overrideFor} bills this model at its own rate (${p.label}) — the vendor row in the price list does not apply to this data` }));
    if (p.source === 'user') out.push(el('span', { class: 'badge price-note user-price', text: 'user price', title: 'Priced by a row you edited or added in the API price list — not a verified vendor list price' }));
    return out;
  },
  renderBreakdown(rows, hasEst) {
    const map = new Map();
    const candidates = Store.platforms();
    for (const r of rows) {
      const k = r.platform + ' ' + r.model;
      let b = map.get(k);
      if (!b) { b = { platform: r.platform, model: r.model, in: 0, cw: 0, cr: 0, out: 0, msgs: 0, est: 0, cost: 0, priced: 0 }; map.set(k, b); }
      b.in += r.in || 0; b.cw += r.cw || 0; b.cr += r.cr || 0; b.out += r.out || 0; b.msgs += r.msgs || 0;
      b.cost += Pricing.cost(r.model, r);   // per ROW: a local:1 row ($0) and a hosted row of the same platform/model share a line without repricing each other
      if (!(r.local || LOCAL_PLATFORMS.has(r.platform))) b.priced = 1;   // Plan 6: at least one row on this line is actually priced (local rows are $0 by rule, never a guess)
      if (r.est) b.est = 1;
    }
    const list = [...map.values()].sort((a, b) => b.cost - a.cost);
    const wrap = $('breakdown-table');
    clear(wrap);
    if (!list.length) { wrap.appendChild(this.emptyNode()); return; }
    const tbody = el('tbody');
    const tot = { in: 0, cw: 0, cr: 0, out: 0, msgs: 0, cost: 0 };
    for (const b of list) {
      tot.in += b.in; tot.cw += b.cw; tot.cr += b.cr; tot.out += b.out; tot.msgs += b.msgs; tot.cost += b.cost;
      tbody.appendChild(el('tr', {},
        el('td', { class: 'name' },
          el('span', { class: 'swdot', style: { background: ColorMap.colorOf('platform', b.platform, candidates) } }),
          document.createTextNode(b.model + (b.est ? ' (est.)' : '')),
          ...this.priceBadges(b)),
        el('td', { text: b.platform }),
        el('td', { text: fmtCompact(b.in) }),
        el('td', { text: fmtCompact(b.cw) }),
        el('td', { text: fmtCompact(b.cr) }),
        el('td', { text: fmtCompact(b.out) }),
        el('td', { text: fmtCompact(b.in + b.cw + b.cr + b.out) }),
        el('td', { text: fmtCompact(b.msgs) }),
        el('td', { text: fmtUSD(b.cost) })));
    }
    tbody.appendChild(el('tr', { class: 'total' },
      el('td', { text: 'Total' + (hasEst ? ' (incl. est.)' : '') }), el('td', { text: '' }),
      el('td', { text: fmtCompact(tot.in) }), el('td', { text: fmtCompact(tot.cw) }),
      el('td', { text: fmtCompact(tot.cr) }), el('td', { text: fmtCompact(tot.out) }),
      el('td', { text: fmtCompact(tot.in + tot.cw + tot.cr + tot.out) }),
      el('td', { text: fmtCompact(tot.msgs) }), el('td', { text: fmtUSD(tot.cost) })));
    wrap.appendChild(el('table', { class: 'data' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Model' }), el('th', { text: 'Platform' }),
        el('th', { text: 'Input' }), el('th', { text: 'Cache write' }), el('th', { text: 'Cache read' }),
        el('th', { text: 'Output' }), el('th', { text: 'Total' }), el('th', { text: 'Msgs' }),
        el('th', { text: 'Cost (API-equiv.)' }))),
      tbody));
  },

  /* ---------- projects table (local logs only, all-time) ---------- */
  renderProjects() {
    const wrap = $('projects-table');
    clear(wrap);
    // Claude Code rows (Store.projects, from the .claude scan) + folder-log rows (Store.projectsBy[connectorId]: Codex cwd, Gemini CLI
    // project-hash folder, Copilot CLI cwd, Junie project dir) — same row shape, merged by project name below, so the same repo used
    // from several tools is ONE row (the Models column lists every model seen). Pricing.cost honours each row's platform / local flag.
    const raw = (Store.projects || []).concat(Object.values(Store.projectsBy || {}).flat());
    $('projects-hint').textContent = (raw.length ? 'all time, ' : '') + 'from Claude Code, Codex, Gemini CLI, Copilot CLI and Junie logs';
    if (!raw.length) { wrap.appendChild(el('div', { class: 'empty', text: 'Connect a local log folder (Claude Code, Codex CLI, Gemini CLI, Copilot CLI or JetBrains Junie) to see per-project usage.' })); return; }
    const byProj = new Map();
    for (const pb of raw) {
      let p = byProj.get(pb.project);
      if (!p) { p = { name: pb.project, msgs: 0, tok: 0, cost: 0, models: new Set() }; byProj.set(pb.project, p); }
      p.msgs += pb.msgs; p.tok += pb.in + pb.cw + pb.cr + pb.out;
      p.cost += Pricing.cost(pb.model, pb);
      p.models.add(pb.model);
    }
    const list = [...byProj.values()].sort((a, b) => b.cost - a.cost).slice(0, 40);
    const maxCost = Math.max(...list.map(p => p.cost), 0) || 1;
    const styles = getComputedStyle(document.documentElement);
    const seq = styles.getPropertyValue('--seq-250').trim();
    const tbody = el('tbody');
    for (const p of list) {
      const barCell = el('td', { style: { width: '130px' } });
      const track = el('div', { style: { height: '8px', borderRadius: '2px 4px 4px 2px', width: Math.max(2, 100 * p.cost / maxCost) + '%', background: seq } });
      barCell.appendChild(track);
      tbody.appendChild(el('tr', {},
        el('td', { class: 'name', title: p.name, text: p.name }),
        el('td', { text: [...p.models].map(m => m.replace(/^claude-/, '')).slice(0, 3).join(', ') + (p.models.size > 3 ? '…' : '') }),
        el('td', { text: fmtCompact(p.msgs) }),
        el('td', { text: fmtCompact(p.tok) }),
        el('td', { text: fmtUSD(p.cost) }),
        barCell));
    }
    wrap.appendChild(el('table', { class: 'data' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'Project' }), el('th', { text: 'Models' }), el('th', { text: 'Msgs' }),
        el('th', { text: 'Tokens' }), el('th', { text: 'Cost (API-equiv.)' }), el('th', { text: '' }))),
      tbody));
  },

  emptyNode() {
    const n = el('div', { class: 'empty' });
    n.appendChild(document.createTextNode('No data in this range yet — '));
    const a = el('a', { text: 'connect an account' });
    a.addEventListener('click', () => this.openConnectorModal('local'));
    n.appendChild(a);
    n.appendChild(document.createTextNode('.'));
    return n;
  },

  /* =================== SOURCES =================== */
  async scanHandle(handle) {
    const status = $('local-status'), prog = $('scan-progress');
    const gen = ++this._gen.local;
    try {
      status.textContent = 'Reading folder…';
      const files = await collectJsonlFromHandle(handle);
      if (!files.length) { status.textContent = 'No .jsonl session logs found in that folder. Pick your .claude folder (it contains a "projects" subfolder) or, for Cowork, the Claude app folder (it contains "local-agent-mode-sessions").'; return; }
      prog.hidden = false; prog.value = 0; prog.max = files.length;
      document.querySelectorAll('.card').forEach(c => c.classList.add('stale'));
      const res = await parseClaudeLogsCached(files, (done) => { prog.value = done; }, ScanCache);
      if (gen !== this._gen.local) return;   // superseded by a newer scan
      Store.projects = res.projects;
      Store.setSource('local', res.rows, res.meta);
      Store.setConnector('local', { label: res.meta.files + ' log files', lastSync: Date.now(), err: null });
      $('rescan-local').hidden = false;
      status.textContent = '';
      status.appendChild(el('span', { class: 'ok', text: '● Connected. ' }));
      status.appendChild(document.createTextNode(`${res.meta.files} log files · ${fmtInt(res.meta.msgs)} messages · scanned ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` + this._unreadableNote(res.meta)));
      this.render();
    } catch (e) {
      if (gen !== this._gen.local) return;   // superseded by a newer scan
      this._localScanFailed(status, e);
    } finally {
      prog.hidden = true;
      document.querySelectorAll('.card').forEach(c => c.classList.remove('stale'));
    }
  },

  /** Claude Code landing path shared by the classic folder chooser (#folder-fallback) and the collector (v7): files = [{ path, file }] →
   *  parseClaudeLogsCached → Store.projects + Store.setSource('local') + the connector entry ('N log files', + ' · via collector' when
   *  opts.fromCollector). Own gen slot (_gen.local, shared with scanHandle): a disconnect / clear-data / newer scan while parsing means this
   *  call commits nothing. Returns true when rows landed; an empty list is a no-op. */
  async scanLocalFiles(files, opts = {}) {
    if (!files || !files.length) return;
    const status = $('local-status'), prog = $('scan-progress');
    const gen = ++this._gen.local;
    prog.hidden = false; prog.value = 0; prog.max = 1;
    status.textContent = 'Scanning…';
    try {
      const res = await parseClaudeLogsCached(files, (d, t) => { prog.max = t; prog.value = d; }, ScanCache);
      if (gen !== this._gen.local) return;   // superseded (disconnect, Clear stored data, a newer scan)
      Store.projects = res.projects;
      Store.setSource('local', res.rows, res.meta);
      Store.setConnector('local', { label: res.meta.files + ' log files' + (opts.fromCollector ? ' · via collector' : ''), lastSync: Date.now(), err: null });
      if (opts.fromCollector) $('rescan-local').hidden = false;   // v7 T3: Re-scan goes through the collector while it is connected (rescan() routes it)
      status.textContent = '';
      status.appendChild(el('span', { class: 'ok', text: '● Loaded. ' }));
      status.appendChild(document.createTextNode(`${res.meta.files} log files · ${fmtInt(res.meta.msgs)} messages` + this._unreadableNote(res.meta) + (opts.fromCollector ? ' · via collector' : ' (one-time load — pick again to refresh)')));
      this.render();
      return true;
    } catch (err) {
      if (gen !== this._gen.local) return;
      this._localScanFailed(status, err);
    } finally { prog.hidden = true; }
  },
  /** A0 #13 — a failed Claude Code scan is attention on the card (err on the entry, like scanFiles' scanErr), not a status line alone. */
  _localScanFailed(status, e) {
    const msg = (e && e.message) || String(e);
    Store.setConnector('local', { err: msg.slice(0, 80) });
    status.textContent = '';
    status.appendChild(el('span', { class: 'err', text: 'Scan failed: ' }));
    status.appendChild(document.createTextNode(msg));
    this.render();
  },
  _unreadableNote(meta) { return meta.badFiles ? ` · ${fmtInt(meta.badFiles)} file(s) unreadable` : ''; },
  /** Plan 9 B1 — the Claude Code card's Cowork line: Anthropic's own figure (the sessions' audit.jsonl total_cost_usd) next to OUR list-price
   *  estimate, both over the SAME Cowork sessions — those with rows in the window — and the window's days only; Cowork sessions whose rows
   *  have no audit record are disclosed, never guessed into the figure. Hidden when the window holds no Cowork session. Never Actual billed. */
  renderCoworkReported(win) {
    const node = $('local-reported'); if (!node) return;
    const src = Store.sources.local, rep = src && src.meta && src.meta.reported;
    const cmp = rep ? this._coworkCompare(rep, src.rows || [], win) : null;
    node.hidden = !cmp || !(cmp.audited + cmp.missing);
    node.textContent = node.hidden ? '' : this._coworkSentence(cmp, rep);
  },
  /** → { audited, missing, reported, estimate } over the local rows inside `win`: a row counts when every session it carries has an audit
   *  record (a compacted day bucket may hold several); a Cowork session without one is counted as missing. */
  _coworkCompare(rep, rows, win) {
    const sessions = rep.sessions || {}, missingSids = Array.isArray(rep.missingSids) ? rep.missingSids : [];   // a stored meta is data, not a contract
    const audited = new Set(), missing = new Set(); let estimate = 0;
    for (const r of rows) {
      if (r.d < win.from || r.d > win.to) continue;
      const sids = r.sid ? [r.sid] : (Array.isArray(r.sids) ? r.sids : []);
      if (!sids.length) continue;
      if (sids.every(s => sessions[s])) { sids.forEach(s => audited.add(s)); estimate += Pricing.cost(r.model, r); }
      else sids.filter(s => missingSids.includes(s)).forEach(s => missing.add(s));
    }
    let reported = 0;
    for (const s of audited) for (const [d, usd] of Object.entries(sessions[s].days || {})) if (d >= win.from && d <= win.to) reported += +usd || 0;
    return { audited: audited.size, missing: missing.size, reported, estimate };
  },
  _coworkSentence(cmp, rep) {
    const count = (k, word) => `${fmtInt(k)} ${word}${k === 1 ? '' : 's'}`, have = (k) => (k === 1 ? 'has' : 'have');
    let sentence = cmp.audited
      ? `Anthropic's own figure for Cowork: ${fmtUSD(cmp.reported)} — our list-price estimate for the same ${count(cmp.audited, 'session')}: ${fmtUSD(cmp.estimate)}`
      : `Anthropic's own figure for Cowork is unavailable here — our list-price estimate stands alone`;
    if (cmp.missing) sentence += ` · ${count(cmp.missing, 'session')} ${have(cmp.missing)} no audit record`;
    if (rep.badResults) sentence += ` · ${count(rep.badResults, 'audit result')} unreadable`;
    return sentence + ' (from each session\u2019s audit.jsonl; a flat plan is not a bill — never counted as billed)';
  },
  /* =================== generic folder-log / local-server connectors =================== */
  /** Renders the hidden source card for a registry entry (statusEl target + Manage-modal body). Idempotent. */
  ensureSourceCard(c) {
    if (document.getElementById('src-' + c.id)) return;
    const q = c.quality || 'none';
    const kids = [
      el('div', { class: 'card-head' }, el('h2', { text: c.name }), el('span', { class: 'badge q-' + q, text: QUALITY_LABEL[q] || q })),
      el('div', { class: 'desc', text: c.qualityNote || '' }),
    ];
    if (c.kind === 'link-only' && c.reason) kids.push(el('div', { class: 'note reason', text: 'Why there is no data path: ' + c.reason }));
    if (c.paths && c.paths.length) {
      const p = el('div', { class: 'note' }, c.kind === 'collector' ? 'How to run it: ' : (c.kind === 'link-only' || c.kind === 'export-file' || c.fetch) ? 'Where to look: ' : 'Where the files live: ');
      c.paths.forEach((s, i) => { if (i) p.appendChild(document.createTextNode(' · ')); p.appendChild(el('code', { text: s })); });
      kids.push(p);
    }
    // key-driver cards (api-key / admin-key / cloud-token entries with `fetch`): key input '<id>-key' + optional extra `fields` ('<id>-f-<field>')
    // + Remember opt-in ('remember-<id>', absent for sessionOnly). Saved values are restored through the .value PROPERTY, never the value
    // attribute, so a key never appears in outerHTML (95-ui-misc's key-leak rule).
    // v7 collector card: the base URL row comes first; the token row below is the shared key UI (password input, Remember opt-in) with
    // Validate & connect routed to connectCollector instead of connectKey
    if (c.kind === 'collector') kids.push(el('div', { class: 'row' },
      el('label', { class: 'field', for: c.id + '-url', text: 'Collector URL' }),
      el('input', { type: 'text', id: c.id + '-url', value: LS.get('url:' + c.id, null) || c.baseUrl, 'aria-label': c.name + ' URL', spellcheck: 'false' })));
    if (c.fetch || c.kind === 'collector') {
      const keyEl = el('input', { type: 'password', id: c.id + '-key', placeholder: c.keyHint || '', autocomplete: 'off', spellcheck: 'false', 'aria-label': c.keyLabel || (c.name + ' key') });
      if (!c.sessionOnly) { const savedKey = LS.get(c.keyLS, null); if (savedKey) keyEl.value = savedKey; }   // sessionOnly: nothing is ever saved, so nothing to restore
      kids.push(el('div', { class: 'row' },
        el('label', { class: 'field', for: c.id + '-key', text: c.keyLabel || 'Key' }),
        keyEl,
        el('button', { class: 'btn primary', id: c.id + '-validate', text: 'Validate & connect', onclick: () => c.kind === 'collector' ? this.connectCollector(c) : this.connectKey(c) })));
      for (const f of c.fields || []) {
        const fid = c.id + '-f-' + f.id, lsKey = 'field:' + c.id + ':' + f.id;
        const inp = f.type === 'textarea'
          ? el('textarea', { id: fid, rows: '3', placeholder: f.placeholder || '', spellcheck: 'false', autocomplete: 'off', 'aria-label': f.label })
          : el('input', { type: fieldIsSecret(f) ? 'password' : 'text', id: fid, placeholder: f.placeholder || '', spellcheck: 'false', autocomplete: 'off', 'aria-label': f.label });
        const savedField = (fieldIsSecret(f) && c.sessionOnly) ? null : LS.get(lsKey, null);   // secrets of a sessionOnly card are never stored — never restored either
        if (savedField) inp.value = savedField;
        kids.push(el('div', { class: 'row' }, el('label', { class: 'field', for: fid, text: f.label }), inp));
      }
      if (c.sessionOnly) {
        // ONE element with class `session-only` per card: Task 2's check asserts /session only/i on the card text, Tasks 10–12 assert exactly one
        // `.session-only` whose text contains "kept in this tab only — never saved" — this single line satisfies all of them (Task 10 adds nothing here)
        kids.push(el('div', { class: 'note session-only', text: 'Session only: the token (and any secret field) is kept in this tab only — never saved. Paste a fresh one when it expires or after a reload (the input hint shows the CLI command).' }));
      } else {
        const cb = el('input', { type: 'checkbox', id: 'remember-' + c.id });
        cb.checked = !!LS.get(c.keyLS, null);
        cb.addEventListener('change', () => {
          const k = $(c.id + '-key');
          if (!cb.checked) { LS.del(c.keyLS); for (const f of c.fields || []) if (fieldIsSecret(f)) LS.del('field:' + c.id + ':' + f.id); }
          else if (k && k.value.trim()) {
            LS.set(c.keyLS, k.value.trim());
            for (const f of c.fields || []) { if (!fieldIsSecret(f)) continue; const fe = $(c.id + '-f-' + f.id); if (fe && fe.value.trim()) LS.set('field:' + c.id + ':' + f.id, fe.value.trim()); }
          }
        });
        kids.push(el('div', { class: 'row' }, el('label', { class: 'inline' }, cb, c.kind === 'collector' ? ' Remember token on this computer' : ' Remember key on this computer')));
      }
    }
    // dual-driver cards (server validate + usage-log folder) get TWO status lines: '<id>-status' for the server (right under the
    // URL row) and '<id>-scan-status' for the folder scan — the drivers run concurrently (syncConnector / refreshAll) and must never
    // blank or overwrite each other's line. Single-driver cards keep the one '<id>-status' at the bottom.
    const dual = !!(c.baseUrl && c.patterns);
    const statusEl = this._setInitialStatus(c, false, el('div', { class: 'status', id: c.id + '-status' }));   // through the initial-status contract (string or node-factory result)
    if (c.kind === 'export-file') {
      kids.push(el('div', { class: 'row' }, el('button', { class: 'btn primary', id: c.id + '-import', text: 'Import file…', onclick: () => this.openImportsFor(c) })));
      kids.push(el('div', { class: 'note', text: 'Looking for: ' + (c.hint || 'your data export') + '. Files are read in your browser only; the rows land under Imports and show on this card.' }));
    }
    if (c.baseUrl && c.kind !== 'collector') {   // the collector card rendered its URL row above (no server-validate button)
      kids.push(el('div', { class: 'row' },
        el('input', { type: 'text', id: c.id + '-url', value: LS.get('url:' + c.id, null) || c.baseUrl, 'aria-label': c.name + ' server URL', spellcheck: 'false' }),
        el('button', { class: 'btn primary', id: c.id + '-validate', text: 'Validate & connect', onclick: () => this.connectServer(c) })));
      if (c.poll) kids.push(el('div', { class: 'note', text: `Counts while this page is open: /metrics is polled every ${Math.round((c.pollEvery || 60000) / 1000)} s and the counter differences land in today's rows (current hour). Polling starts on Validate & connect, Sync or Refresh — never on page load — and stops when the tab closes. While the tab is hidden no tick runs, but the counters keep growing on the server: the first tick after you return books the whole hidden period into that hour. A server restart resets the counters (nothing goes negative).` }));
      if (dual) kids.push(statusEl);
    }
    if (c.patterns) {
      const fb = el('input', { type: 'file', id: c.id + '-fallback', webkitdirectory: '', multiple: '', hidden: '' });
      fb.addEventListener('change', (e) => { const files = [...e.target.files].map(f => ({ path: f.webkitRelativePath || f.name, file: f })); e.target.value = ''; if (files.length) this.scanFiles(c, files); });
      kids.push(el('div', { class: 'row' },
        el('button', { class: 'btn' + (c.baseUrl ? '' : ' primary'), id: c.id + '-pick', text: c.baseUrl ? 'Choose ' + (c.folderLabel || 'usage-log') + ' folder…' : 'Choose folder…', onclick: () => this.pickFolderFor(c) }),
        el('button', { class: 'btn rescan', id: c.id + '-rescan', text: 'Re-scan', hidden: '', onclick: () => this._viaCollector(c.id) ? this.rescanViaCollector(c.id) : this.rescanFolder(c.id) }),   // v7 T3: through the collector while it feeds this tool
        el('progress', { id: c.id + '-progress', max: '100', value: '0', hidden: '' }),
        fb));
      const link = el('a', { href: '#', text: 'use the classic folder chooser' });
      link.addEventListener('click', (e) => { e.preventDefault(); fb.click(); });
      kids.push(el('div', { class: 'note' }, 'Files are read in your browser only. Looking for: ' + (c.hint || 'log files') + '. If the folder picker does not open, ', link, ' instead.'));
      if (dual) kids.push(this._setInitialStatus(c, true, el('div', { class: 'status', id: c.id + '-scan-status' })));
    }
    if (!dual) kids.push(statusEl);
    if (c.kind === 'collector') kids.push(   // v7: what the collector does, in one line, then the tools table connectCollector fills (tool · root · files · last change)
      el('div', { class: 'note', text: 'Files are read through the collector on this machine only (127.0.0.1): the token is sent to the URL above and nowhere else, and every tool it finds connects under its own card with "via collector". Run it with: node docs/tools/ai-usage-collector.mjs — it prints the token. Disconnected tools stay out until you reconnect the collector (Validate & connect reads every found tool again).' }),
      el('table', { id: 'collector-tools', class: 'collector-tools' }));
    const L = c.links || {}, ln = [];
    if (L.get) ln.push(el('a', { href: L.get, target: '_blank', rel: 'noopener', text: 'Get it' }));
    if (L.docs) ln.push(el('a', { href: L.docs, target: '_blank', rel: 'noopener', text: 'Where the numbers come from' }));
    if (L.usage) ln.push(el('a', { href: L.usage, target: '_blank', rel: 'noopener', text: 'Vendor usage page' }));
    if (ln.length) { const row = el('div', { class: 'note links' }); ln.forEach((a, i) => { if (i) row.appendChild(document.createTextNode(' · ')); row.appendChild(a); }); kids.push(row); }
    const card = el('div', { class: 'card src generic', id: 'src-' + c.id, hidden: '' }, ...kids);
    $('sources').appendChild(card);   // NOT insertBefore($('src-import')): that card may be living inside the connector modal at the time → insertBefore would throw
  },
  /** Status line the folder-scan driver owns: '<id>-scan-status' on dual-driver cards (server + folder), else the card's '<id>-status'. */
  _scanStatusEl(id) { return $(id + '-scan-status') || $(id + '-status'); },
  /** Hub label for a connector entry: dual-driver cards keep each half separately (serverLabel / filesLabel) and show both — either
   *  driver may finish last without wiping the other's half. Single-driver cards only ever set one half, so the label is unchanged. */
  _dualLabel(id, patch) {
    const st = { ...(Store.connectors[id] || {}), ...patch };
    return [st.serverLabel, st.filesLabel].filter(Boolean).join(' · ');
  },
  /** Data-based ownership for dual-driver cards: the folder half is genuinely connected only when a scan landed rows AND the
   *  connector entry carries its filesLabel. A directory handle alone (stored before any scan succeeds) never counts. */
  _folderOwns(id) {
    const st = Store.connectors[id], src = Store.sources[id];
    return !!(st && st.filesLabel && src && Array.isArray(src.rows) && src.rows.length);
  },
  /** Single scan entry point for folder-log connectors (folder pick, classic chooser, tests, Imports drop). files: [{path, file}];
   *  opts.fromDrop: the files came from the Imports dropzone — no ScanCache prune (a drop is a scan of just those files: it REPLACES the
   *  connector's rows like a re-scan does — merging would double count against a later re-scan). opts.fromCollector (v7): the files came through the
   *  local collector (RemoteFile shims) — the entry's filesLabel and the status line end in ' · via collector'. Returns true when the rows were replaced. */
  async scanFiles(c, files, opts = {}) {
    const status = this._scanStatusEl(c.id), prog = $(c.id + '-progress');
    const gen = this._gen[c.id] = (this._gen[c.id] || 0) + 1;   // scan slot only — connectServer has its own (c.id + ':server'), so the two never supersede each other
    try {
      if (!files.length) { status.textContent = `No matching files found in that folder — expected ${c.hint || 'log files'}.`; return; }
      if (prog) { prog.hidden = false; prog.value = 0; prog.max = files.length; }
      document.querySelectorAll('.card').forEach(x => x.classList.add('stale'));
      const res = await parseFolderCached(c, files, (done, total) => { if (prog) { prog.max = total; prog.value = done; } }, ScanCache, { noPrune: !!opts.fromDrop });
      if (gen !== this._gen[c.id]) return;   // superseded by a newer scan of this connector
      if (!res.meta.files) { status.textContent = `No matching files found — expected ${c.hint || 'log files'}.`; return; }
      // every matched file unreadable (B6: a zstd store this browser cannot decode, a locked DB) = a failed scan with the first reason — never "Connected · 0 messages" over kept rows
      if (!res.meta.parsedFiles && !res.meta.cachedFiles) throw new Error(`${res.meta.files} file(s) unreadable${res.meta.badFileReason ? ' — ' + res.meta.badFileReason : ''}`);
      if (res.projects && res.projects.length) Store.projectsBy[c.id] = res.projects; else delete Store.projectsBy[c.id];   // Projects table rows (persisted by setSource's persist below); a re-scan that finds none clears the stale set
      Store.setSource(c.id, res.rows, { files: res.meta.files, msgs: res.meta.msgs, lines: res.meta.lines, badLines: res.meta.badLines });
      const filesLabel = `${res.meta.files} file${res.meta.files === 1 ? '' : 's'}` + (opts.fromCollector ? ' · via collector' : '');
      // per-half errors (dual-driver cards): this driver owns scanErr, connectServer owns serverErr; hub err = serverErr || scanErr
      // merged from the previous entry, so a CORS-blocked server keeps its hint even when the folder scan settles last
      Store.setConnector(c.id, { filesLabel, label: this._dualLabel(c.id, { filesLabel }), lastSync: Date.now(), scanErr: null, err: (Store.connectors[c.id] || {}).serverErr || null });
      const rs = $(c.id + '-rescan'); if (rs) rs.hidden = !(this._dirHandles[c.id] || opts.fromCollector);   // v7 T3: a collector-fed tool shows Re-scan too (routed to the collector while it is connected)
      status.textContent = '';
      status.appendChild(el('span', { class: 'ok', text: '● Connected. ' }));
      const nf = res.meta.files, nm = res.meta.msgs;
      status.appendChild(document.createTextNode(`${nf} file${nf === 1 ? '' : 's'} · ${fmtInt(nm)} message${nm === 1 ? '' : 's'} · scanned ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
        + (res.meta.badLines ? ` · ${fmtInt(res.meta.badLines)} unreadable line(s) skipped` : '')
        + (res.meta.badFiles ? ` · ${fmtInt(res.meta.badFiles)} file(s) unreadable` : '')
        + (opts.fromCollector ? ' · via collector' : '')));
      this.render();
      return true;   // rows / filesLabel replaced (the Imports note reads this)
    } catch (e) {
      if (gen !== this._gen[c.id]) return;
      const scanErr = (e.message || String(e)).slice(0, 80);
      Store.setConnector(c.id, { scanErr, err: (Store.connectors[c.id] || {}).serverErr || scanErr });
      status.textContent = '';
      status.appendChild(el('span', { class: 'err', text: 'Scan failed: ' }));
      status.appendChild(document.createTextNode(e.message || String(e)));
      this.render();
    } finally {
      if (prog) prog.hidden = true;
      document.querySelectorAll('.card').forEach(x => x.classList.remove('stale'));
    }
  },
  async scanFolder(c, handle) {
    const status = this._scanStatusEl(c.id);
    if (status) status.textContent = 'Reading folder…';
    let files;
    try { files = await collectFilesFromHandle(handle, (c.patterns || []).concat(c.siblings || [])); }
    catch (e) { if (status) status.textContent = 'Could not read that folder: ' + (e.message || e); return; }
    return this.scanFiles(c, files);
  },
  async pickFolderFor(c) {
    if (!window.showDirectoryPicker) { const fb = $(c.id + '-fallback'); if (fb) fb.click(); return; }
    try {
      const handle = await showDirectoryPicker({ id: 'dir-' + c.id, mode: 'read' });
      this._dirHandles[c.id] = handle;
      IDB.set('dir:' + c.id, handle);
      await this.scanFolder(c, handle);
    } catch (e) { if (e && e.name !== 'AbortError') console.warn(e); }
  },
  async rescanFolder(id) {
    const c = connectorById(id); if (!c) return;
    const h = this._dirHandles[id];
    if (h) {
      // a stored handle owns this path: a denied re-grant is a message, NOT a silent fall-through to the picker
      const status = this._scanStatusEl(id);
      try {
        let perm = await h.queryPermission({ mode: 'read' });
        if (perm !== 'granted') perm = await h.requestPermission({ mode: 'read' });
        if (perm === 'granted') { await this.scanFolder(c, h); return; }
        if (status) status.textContent = 'Permission denied — click Choose folder… to pick the folder again.';
      } catch (e) { console.warn(e); if (status) status.textContent = 'Could not re-check folder access: ' + (e.message || e) + ' — click Choose folder… to pick the folder again.'; }
      return;
    }
    return this.pickFolderFor(c);   // nothing stored → the picker is the only way in
  },
  async restoreFolderHandles() {
    for (const c of CONNECTORS) {
      if (!c.patterns || c.kind === 'folder') continue;   // 'local' keeps its own restoreHandle()
      try {
        const handle = await IDB.get('dir:' + c.id);
        if (!handle) continue;
        this._dirHandles[c.id] = handle;
        const rs = $(c.id + '-rescan'); if (rs) rs.hidden = false;
        const perm = await handle.queryPermission({ mode: 'read' });
        if (perm === 'granted') this.scanFolder(c, handle);
        else {
          const s = this._scanStatusEl(c.id);
          if (s) s.textContent = Store.sources[c.id]
            ? `Showing saved data (${fmtInt(((Store.sources[c.id] || {}).meta || {}).msgs || 0)} messages). Click Re-scan to refresh from disk.`
            : 'Folder remembered — click Re-scan to grant access and load.';
        }
      } catch (e) { console.warn(e); }
    }
  },
  /** local-server driver: validate via the registry's `validate` fn; distinguish CORS-blocked (attention + fix) from not running (off). */
  async connectServer(c) {
    const status = $(c.id + '-status');   // server line only — the folder scan writes '<id>-scan-status' (see _scanStatusEl); neither driver touches the other's line
    const slot = c.id + ':server';        // own generation slot: a concurrent scanFiles (syncConnector / refreshAll) must not supersede this validation, nor vice versa
    const gen = this._gen[slot] = (this._gen[slot] || 0) + 1;
    const urlEl = $(c.id + '-url');
    const base = ((urlEl && urlEl.value.trim()) || c.baseUrl).replace(/\/+$/, '');
    LS.set('url:' + c.id, base);
    status.textContent = 'Checking ' + base + '…'; status.dataset.gen = String(gen);
    try {
      const fn = globalThis[c.validate];
      if (typeof fn !== 'function') throw new Error('No validator registered: ' + c.validate);
      const res = await fn(base);
      if (gen !== this._gen[slot]) { if (status.dataset.gen === String(gen)) status.textContent = ''; return; }   // superseded — only clear the placeholder if it's still ours
      // 4b: history-capable validators (LocalAI /api/usage) hand back rows (+ optional billed) — stored under c.id like scanFiles / connectKey do
      if (Array.isArray(res.rows)) Store.setSource(c.id, res.rows, res.meta || {});
      if (Array.isArray(res.billed)) Store.setBilled(c.id, res.billed);
      // per-half errors: this driver owns serverErr, scanFiles owns scanErr; the hub's err = serverErr || scanErr (merged from the
      // previous entry) so whichever half settles last never wipes the other half's message (CORS hint vs. a working usage-log folder)
      Store.setConnector(c.id, { serverLabel: res.label, label: this._dualLabel(c.id, { serverLabel: res.label }), lastSync: Date.now(), serverErr: null, err: (Store.connectors[c.id] || {}).scanErr || null });
      status.textContent = ''; status.dataset.gen = '';
      status.appendChild(el('span', { class: 'ok', text: '● Connected. ' }));
      status.appendChild(document.createTextNode(res.detail || ''));
      // 4b metrics-poll: (re)start the /metrics loop (the first tick seeds or diffs the counter baseline) — unless the validator already found the counters
      // unavailable (res.pollable === false: llama.cpp without --metrics — its detail says how to enable them; a running loop stops). A fetch failure
      // inside a tick is _pollTick's own attention state; a tick that THROWS surfaces through the catch below instead of being swallowed (A0 #3)
      if (c.poll) { if (res.pollable === false) this.stopPoll(c); else await this.startPoll(c); }
      this.render();
    } catch (e) {
      if (gen !== this._gen[slot]) { if (status.dataset.gen === String(gen)) status.textContent = ''; return; }
      // 4b: a validator that got a real HTTP answer marks its error `answered` (LocalAI 503 = stats disabled; llama.cpp 404 = --metrics off) —
      // that is the server's own message, not a CORS guess: skip the reachability probe and show it verbatim below
      const up = e && e.answered ? false : await probeServer(base).catch(() => false);
      if (gen !== this._gen[slot]) { if (status.dataset.gen === String(gen)) status.textContent = ''; return; }
      status.textContent = ''; status.dataset.gen = '';
      if (c.poll) this.stopPoll(c);   // metrics-poll: the validate failed (not running / CORS / answered error) → stop the loop, else a stray tick re-creates the entry deleted below (off→ok auto-reveals a hidden card)
      if (e && e.answered) {
        const serverErr = String(e.message || e).slice(0, 80);
        Store.setConnector(c.id, { serverErr, err: serverErr, serverLabel: null, label: this._dualLabel(c.id, { serverLabel: null }) });   // attention, server half
        status.appendChild(el('span', { class: 'err', text: 'Server answered: ' }));
        status.appendChild(document.createTextNode(e.message || String(e)));
      } else if (up) {
        // the probe only proves SOMETHING answered at base (any HTTP server, a proxy, another app on the port) — a CORS block by
        // this server is the likely reason the validator failed, not a certainty: say so, keep the fix instruction
        const name = c.name || 'the server';
        const msg = c.corsHint ? c.corsHint.replace(/\{base\}/g, base)
          : `Something answered at ${base} but this page could not read it — most likely ${name} blocking the origin (CORS). Allow this page's origin on the server, then validate again.`;
        const serverErr = `Could not read ${name} at ${base} — likely CORS (see card)`.slice(0, 80);
        Store.setConnector(c.id, { serverErr, err: serverErr, serverLabel: null, label: this._dualLabel(c.id, { serverLabel: null }) });   // server half's error wins the hub line
        status.appendChild(el('span', { class: 'err', text: 'Blocked: ' }));
        status.appendChild(document.createTextNode(msg + (e && e.message && !/Failed to fetch/i.test(e.message) ? ` (${e.message})` : '')));
      } else if (this._folderOwns(c.id)) {
        // unreachable, but the usage-log folder half is GENUINELY connected (a scan landed rows and its filesLabel is on the entry): keep it
        // CONNECTED on the folder half only. Deleting here would flip the card to "Not connected" while its rows still count, and the
        // next scan would re-create the entry off→ok — which View.onConnectorChange reads as a fresh connection and would auto-reveal
        // a hidden card. A bare directory handle is NOT ownership: pickFolderFor/restoreFolderHandles store _dirHandles before any scan
        // succeeds (0 matching files, denied permission) — fabricating an entry from it would be exactly that false off→ok flip.
        const filesLabel = Store.connectors[c.id].filesLabel;
        Store.setConnector(c.id, { serverLabel: null, filesLabel, label: filesLabel, serverErr: null, err: Store.connectors[c.id].scanErr || null });   // not running ≠ error: only the scan half may still carry one
        status.textContent = `Server not running at ${base} — usage log still connected. Start the server and validate again for the live check.`;
      } else {
        // unreachable = not running → truly off, not an error state
        delete Store.connectors[c.id]; Store.persist();
        status.textContent = `Not running at ${base} — start it and validate again.`;
      }
      this.render();
    }
  },

  /* =================== generic key driver (api-key / admin-key / cloud-token entries with `fetch`) =================== */
  /** How far back a key card fetches: its '<id>-days' select when the card has one (the Anthropic / OpenAI Admin cards), else 90 days. */
  _daysToFetch(c) {
    const sel = $(c.id + '-days');
    const n = sel ? parseInt(sel.value, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 90;
  },
  /** One code path for every key-bearing card: reads '<id>-key' (+ extra `fields` '<id>-f-<field>'), honors the Remember opt-in
   *  (never for sessionOnly), calls globalThis[c.fetch](key, fields, { days }) (_daysToFetch) → { label, detail, rows?, billed?, meta? } and stores
   *  rows → Store.setSource(c.id), billed → Store.setBilled(c.id) (undefined = fetcher has no billed path, envelope untouched · null = billed fetch
   *  failed → stale envelope · array = fresh, [] = truthful empty — a fetcher WITH a billed path returns [] when it is not configured now), then the
   *  connector entry; extra field values persist (LS 'field:<id>:<field>') only after the fetcher accepted them. Own gen slot
   *  this._gen[c.id]: a superseded call (newer connect, disconnect, clear-data) commits nothing and clears only its own placeholder —
   *  the gen-slot rule (status.dataset.gen). */
  async connectKey(c) {
    const status = $(c.id + '-status');
    const gen = this._gen[c.id] = (this._gen[c.id] || 0) + 1;
    const keyEl = $(c.id + '-key');
    const key = keyEl ? keyEl.value.trim() : '';
    if (!key && !c.keyOptional) { status.textContent = `Paste ${c.keyLabel ? 'your ' + c.keyLabel : 'a key'} first${c.keyHint ? ' (' + c.keyHint + ')' : ''}.`; return; }
    const fields = {};
    for (const f of c.fields || []) { const fe = $(c.id + '-f-' + f.id); fields[f.id] = fe ? fe.value.trim() : ''; }
    const rem = $('remember-' + c.id);
    const remember = !c.sessionOnly && !!(rem && rem.checked);   // honoured below, once the fetcher accepted the key (A0 #11)
    status.textContent = 'Validating…'; status.dataset.gen = String(gen);
    try {
      const fn = globalThis[c.fetch];
      if (typeof fn !== 'function') throw new Error('No fetcher registered: ' + c.fetch);
      const res = (await fn(key, fields, { days: this._daysToFetch(c) })) || {};
      if (gen !== this._gen[c.id]) { if (status.dataset.gen === String(gen)) status.textContent = ''; return; }   // superseded — only clear the placeholder if it's still ours
      if (remember) LS.set(c.keyLS, key);   // a rejected key is never remembered — refreshAll would replay it after a reload (A0 #11)
      if (Array.isArray(res.rows)) Store.setSource(c.id, res.rows, res.meta || {});
      if (res.billed !== undefined) Store.setBilled(c.id, res.billed);                               // contract: undefined = no billed path (untouched) · null = billed fetch failed → Store.setBilled(null) marks the stored envelope stale · array = fresh ([] = truthful empty)
      for (const f of c.fields || []) {   // field values persist only once the fetcher accepted them — a rejected value (bad cost scope / resource id) is never remembered, so refreshAll cannot replay it after a reload
        const lsKey = 'field:' + c.id + ':' + f.id;
        if (fieldIsSecret(f)) { if (remember && fields[f.id]) LS.set(lsKey, fields[f.id]); }          // secrets follow the key's Remember rule; sessionOnly never persists them
        else if (fields[f.id]) LS.set(lsKey, fields[f.id]); else LS.del(lsKey);                        // non-secret values (region, subscription id, …) persist for convenience; a blanked field forgets its stored value
      }
      Store.setConnector(c.id, { label: res.label || ((c.keyLabel || 'key') + ' · last 4: ' + key.slice(-4)), lastSync: Date.now(), err: null });
      status.textContent = ''; status.dataset.gen = '';
      status.appendChild(el('span', { class: 'ok', text: '● Connected. ' }));
      status.appendChild(document.createTextNode((res.detail ? res.detail + ' · ' : '') + 'updated ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })));
      this.render();
    } catch (e) {
      if (gen !== this._gen[c.id]) { if (status.dataset.gen === String(gen)) status.textContent = ''; return; }   // superseded — only clear the placeholder if it's still ours
      Store.setConnector(c.id, { err: (e.message || String(e)).slice(0, 80) });
      status.textContent = ''; status.dataset.gen = '';
      const fallback = document.querySelector('#src-' + c.id + ' details.fallback');   // the Anthropic / OpenAI Admin cards carry a PowerShell fallback — a failed fetch opens it
      if (fallback) fallback.open = true;
      status.appendChild(el('span', { class: 'err', text: 'Validation failed: ' }));
      status.appendChild(document.createTextNode((e.message || String(e)) + (fallback ? ' — if this is a CORS/network block, use the PowerShell fallback below.' : '')));
      this.render();
    }
  },

  /* =================== v7: local collector (automatic folder sources) =================== */
  /** Connects to the collector (docs/tools/ai-usage-collector.mjs) and lands every tool it found through the SAME path a folder pick uses:
   *  GET /api/status → _collectorWalk (full): for each found tool whose id is a registered folder connector (kind folder / folder-log, or a local-server
   *  entry with patterns) _collectorScanTool — GET /api/list, the connector's own patterns / exclude / siblings (matchConnectorFiles), RemoteFile shims, then
   *  scanFiles(connector, files, { fromCollector: true }) — scanLocalFiles for Claude Code — so rows, project rows, cache signatures and the
   *  tool's card are exactly a folder pick's ('N files · via collector'). The collector owns no rows (platform null, srcIds []): its own entry is
   *  'N tools · M files' and its card lists tool · root · files · last change. Token: the card's '<id>-key' (Remember opt-in like every key
   *  card; a ?token= in the page URL pre-fills it once — _prefillCollectorToken); sent as 'Authorization: Bearer' to the card's base URL only,
   *  never written into the DOM or a URL. Honest errors: unreachable → "Not running at <base> — start it with: …" and NO entry (connectServer's
   *  unreachable rule — a stale entry is deleted); 401 → "Token rejected — copy the token the collector printed" (attention); a found tool
   *  with zero matching files is listed as "found, nothing to read" and gets no entry. Own gen slot this._gen[c.id]: a superseded call
   *  (disconnect, clear-data, a newer connect) commits nothing and clears only its own placeholder (the gen-slot rule). Stops a running watch for its
   *  duration and starts it again on success (automatic mode, T3) — a failed connect leaves no watch. */
  async connectCollector(c) {
    const status = $(c.id + '-status');
    const gen = this._gen[c.id] = (this._gen[c.id] || 0) + 1;
    const urlEl = $(c.id + '-url');
    const base = ((urlEl && urlEl.value.trim()) || c.baseUrl).replace(/\/+$/, '');
    const keyEl = $(c.id + '-key');
    const token = keyEl ? keyEl.value.trim() : '';
    if (!token) { status.textContent = `Paste the ${c.keyLabel || 'token'} first (${c.keyHint || 'see the card'}).`; return; }
    LS.set('url:' + c.id, base);
    const rem = $('remember-' + c.id);   // Remember opt-in — honoured once the collector accepted the token (A0 #11)
    this.stopCollectorWatch(c);   // no tick runs beside a connect (an in-flight one commits nothing); a successful connect starts the watch again
    status.textContent = 'Checking ' + base + '…'; status.dataset.gen = String(gen);
    const superseded = () => { if (gen !== this._gen[c.id]) { if (status.dataset.gen === String(gen)) status.textContent = ''; return true; } return false; };
    const api = this._collectorApi(base, token);
    let st;
    try { st = await api('/api/status'); }
    catch (e) {
      if (superseded()) return;
      status.textContent = ''; status.dataset.gen = '';
      if (e && e.notJson) {   // a 2xx that is not JSON: something else answers at that URL (review m9) — like "not running": no entry (a stale one goes too)
        delete Store.connectors[c.id]; Store.persist();
        status.textContent = this._collectorErrText(e, base);
      } else if (e && e.status) {   // a real HTTP answer (401 / 5xx): attention, the entry carries the collector's own message
        const err = String(e.message || e).slice(0, 80);
        Store.setConnector(c.id, { err });
        status.appendChild(el('span', { class: 'err', text: 'Rejected: ' }));
        status.appendChild(document.createTextNode(e.message || String(e)));
      } else {   // network failure = not running → truly off: no entry at all (a stale one goes too); the tools' own data is untouched
        delete Store.connectors[c.id]; Store.persist();
        status.textContent = `Not running at ${base} — start it with: node docs/tools/ai-usage-collector.mjs`;
      }
      this.render();
      return;
    }
    if (superseded()) return;
    this._collectorExcluded = new Set();   // Validate & connect reads every found tool again — a tool disconnected earlier is back in (review m3)
    const walked = await this._collectorWalk(c, st, { api, base, token, full: true, stale: superseded });
    if (!walked) return;   // superseded mid-walk: its own placeholder is already cleared, nothing committed
    if (rem && rem.checked) LS.set(c.keyLS, token);   // the only write of the token to storage — and only for a token the collector accepted (A0 #11)
    this.startCollectorWatch(c);   // automatic mode from here on (no immediate tick — everything was just read)
    this._collectorCommit(c, walked.snap, walked.summary);
    return true;
  },
  /** The collector card's tools table (tool · root · files · last change) — textContent only; an empty list clears it. */
  _renderCollectorTools(table, rows) {
    if (!table) return;
    clear(table);
    if (!rows || !rows.length) return;
    table.appendChild(el('thead', {}, el('tr', {}, el('th', { text: 'Tool' }), el('th', { text: 'Root' }), el('th', { text: 'Files' }), el('th', { text: 'Last change' }))));
    const tbody = el('tbody');
    for (const r of rows) tbody.appendChild(el('tr', {}, el('td', { text: r.name }), el('td', { text: r.root }), el('td', { text: r.files }), el('td', { text: r.newest })));
    table.appendChild(tbody);
  },
  /** v7: a ?token=<t> in the page URL (the collector prints http://127.0.0.1:11436/?token=… and serves this page there) pre-fills the collector
   *  card's token input ONCE and is removed from the address bar (history.replaceState) so it is never bookmarked, shared or shown; nothing
   *  connects by itself — Validate & connect (or Sync) stays the user's click, and nothing is remembered without the opt-in. Returns true when a
   *  token was taken from the URL. Called from init. */
  _prefillCollectorToken() {
    let tok = null;
    try {
      const u = new URL(location.href);
      tok = u.searchParams.get('token');
      if (tok !== null) { u.searchParams.delete('token'); history.replaceState(null, '', u.href); }
    } catch {}
    if (!tok) return false;
    const inp = $('collector-key'); if (inp) inp.value = tok;
    if (/^https?:$/.test(location.protocol)) { const u = $('collector-url'); if (u) u.value = location.origin; }   // a ?token= on an http(s) page = the collector served this page: its origin IS the collector (also on --port <n>, where the registry default would miss)
    return true;
  },
  /* =================== v7 T3: automatic mode — the collector's status watch =================== */
  _collectorSnap: {},      // toolId → { files, newestMtime, matched, landed, note } from the last /api/status walk: the change detector (files / newestMtime) AND the
                           // "this tool is the collector's" test (_viaCollector → Re-scan routing, landed only). Only found tools this page can read are in it. Never persisted.
  _collectorSummary: [],   // the tools-table rows of the last walk ({ id, name, root, files, newest }) — rescanViaCollector updates one row in place
  _collectorExcluded: new Set(),   // tool ids disconnected while the collector fed them (review m3): out of every walk until Validate & connect on the collector card
                                   // (connectCollector clears it); mirrored as `excluded` on the collector entry so a reload honours it (_restoreCollectorWatch reads it back)
  /** GET <base><path> with the bearer token → JSON. 401 → Error('Token rejected — …', status 401); any other non-2xx → Error(status). The one request
   *  path of connectCollector, _collectorTick and rescanViaCollector: the token travels as a header to the card's base URL only. */
  _collectorApi(base, token) {
    return async (path) => {
      const r = await fetch(base + path, { headers: { Authorization: 'Bearer ' + token }, signal: requestTimeout() });
      if (r.status === 401) { const e = new Error('Token rejected — copy the token the collector printed'); e.status = 401; throw e; }
      if (!r.ok) { const e = new Error(`Collector answered HTTP ${r.status} for ${path}`); e.status = r.status; throw e; }
      try { return await r.json(); }
      catch { const e = new Error('unexpected response (not JSON)'); e.status = r.status; e.notJson = true; throw e; }   // a 2xx that is not JSON: something else answers at that URL (review m9) — never mistaken for "not running"
    };
  },
  /** Token + base URL as the watch reads them: the card's input, else the remembered token (refreshAll's rule — never from nothing); the URL input, else the stored URL, else the registry default. */
  _collectorCreds(c) {
    const keyEl = $(c.id + '-key'), urlEl = $(c.id + '-url');
    return { token: (keyEl && keyEl.value.trim()) || LS.get(c.keyLS, null) || '', base: ((urlEl && urlEl.value.trim()) || LS.get('url:' + c.id, null) || c.baseUrl).replace(/\/+$/, '') };
  },
  _collectorEverySec(c) { return Math.round((c.pollEvery || 60000) / 1000); },
  /** True while the collector is connected and its last read of this tool LANDED rows: the tool's Re-scan (card button, hub Sync, Claude Code's rescan()) goes
   *  through the collector instead of the folder handle / picker. A tool the collector found but could not read ('found, nothing to read' — guaranteed for ollama,
   *  whose ~/.ai-usage root the collector itself creates for the token; a failed list; a scan that failed) keeps its own handle / picker (review M1). Off again the
   *  moment the collector is disconnected (snapshot cleared), the tool is disconnected (excluded) or it vanished from the collector's status. */
  _viaCollector(id) { const s = this._collectorSnap[id]; return !!(Store.connectors.collector && s && s.landed); },
  /** A tool the collector can feed on this page: a registered folder-reading connector (patterns) — folder (Claude Code), folder-log or a dual-driver local-server. */
  _collectorReadable(conn) { return !!(conn && conn.patterns && (conn.kind === 'folder' || conn.kind === 'folder-log' || conn.kind === 'local-server')); },
  /** The collector's error text for a failed request: a 2xx that is not JSON (something else answers at that URL), a real HTTP answer (401 / 5xx: its own message),
   *  else a network failure = not running. */
  _collectorErrText(e, base) {
    if (e && e.notJson) return `Unexpected response from ${base} — is this the collector?`;
    if (e && e.status) return String(e.message || e).slice(0, 80);
    return `Not running at ${base} — start it with: node docs/tools/ai-usage-collector.mjs`;
  },
  /** Reads ONE tool through the collector — exactly the path a folder pick takes: GET /api/list → the connector's own patterns / exclude / siblings
   *  (matchConnectorFiles) → RemoteFile shims → scanFiles(conn, files, { fromCollector: true }) (scanLocalFiles for Claude Code), so rows, project rows,
   *  cache signatures and the tool's card are a folder pick's. o = { api, base, token, stale }; status = the collector's line for the "Reading …" placeholder.
   *  Returns { matched, landed, note, retry? } — note is the tools-table cell ('4 files' · 'found, nothing to read' · 'error: …' (retry) · '… scan failed,
   *  see the tool's card'); null when o.stale() flipped mid-way (a disconnect / newer connect / stopped watch: nothing committed). */
  async _collectorScanTool(conn, o, status) {
    if (status) status.textContent = `Reading ${conn.name} through the collector…`;
    let files;
    try {
      const list = await o.api('/api/list?tool=' + encodeURIComponent(conn.id));
      const decode = remoteDecodeFor(conn);   // B6: Zed's zstd store is decoded by the collector when this browser cannot (design 8)
      files = matchConnectorFiles(conn, Array.isArray(list && list.files) ? list.files : []).map(f => ({ path: f.path, file: new RemoteFile(o.base, o.token, conn.id, f, decode) }));
    } catch (e) { if (o.stale()) return null; return { matched: 0, landed: false, retry: true, note: 'error: ' + String(e.message || e).slice(0, 60) }; }
    if (o.stale()) return null;
    if (!files.length) return { matched: 0, landed: false, note: 'found, nothing to read' };
    const landed = conn.id === 'local' ? await this.scanLocalFiles(files, { fromCollector: true }) : await this.scanFiles(conn, files, { fromCollector: true });
    if (o.stale()) return null;
    const n = files.length, plural = `${n} file${n === 1 ? '' : 's'}`;
    if (landed !== true) return { matched: n, landed: false, note: plural + " — scan failed, see the tool's card" };   // the tool's own status line carries the reason; not counted as read
    return { matched: n, landed: true, note: plural };
  },
  /** Walks a /api/status answer into { snap, summary }: one table row per reported tool; every found tool this page can read (a registered folder
   *  connector with patterns) is read through _collectorScanTool when o.full (a connect) or when its files / newestMtime differ from the snapshot (a
   *  tick: unchanged tools are carried over and NOT touched — no list, no read; a tool that newly appears is read; one reported not found leaves the
   *  snapshot — its data and card stay, its Re-scan reverts to the folder rule). A failed list / read is kept as the collector's with a sentinel that
   *  never matches, so the next tick tries again. Returns null when o.stale() flipped mid-walk (the caller commits nothing). */
  async _collectorWalk(c, st, o) {
    const status = $(c.id + '-status');
    const summary = [], snap = {};
    for (const t of (Array.isArray(st && st.tools) ? st.tools : [])) {
      if (!t || typeof t.id !== 'string') continue;
      const conn = connectorById(t.id);
      const readable = this._collectorReadable(conn);
      const row = { id: t.id, name: (conn && conn.name) || String(t.name || t.id), root: Array.isArray(t.roots) ? t.roots.map(String).join(' · ') : '', files: '',
        newest: t.newestMtime ? new Date(t.newestMtime).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '' };
      summary.push(row);
      if (!t.found) { row.files = 'not found'; continue; }
      if (this._collectorExcluded.has(t.id)) { row.files = 'disconnected'; continue; }   // disconnected on this page while the collector fed it: out until Validate & connect (review m3)
      if (!readable) { row.files = 'found — no reader on this page'; continue; }
      const cur = { files: +t.files || 0, newestMtime: +t.newestMtime || 0 }, prev = o.full ? null : this._collectorSnap[t.id];
      if (prev && prev.files === cur.files && prev.newestMtime === cur.newestMtime) { snap[t.id] = prev; row.files = prev.note; continue; }   // unchanged since the last status
      const r = await this._collectorScanTool(conn, o, status);
      if (!r) return null;
      row.files = r.note;
      snap[t.id] = r.retry ? { files: -1, newestMtime: -1, matched: 0, landed: false, note: r.note } : { files: cur.files, newestMtime: cur.newestMtime, matched: r.matched, landed: r.landed, note: r.note };
    }
    return { snap, summary };
  },
  /** Commits a walk (connect, tick or single-tool re-scan): snapshot + table rows, the entry ('N tools · M files' over the tools that landed, err cleared),
   *  the status line ('● Connected. N tools · M files [· Z found, nothing to read] · checked <time>' + ' · watching for changes every N s' while the watch
   *  runs), the tools table, one render. */
  _collectorCommit(c, snap, summary, o = {}) {
    for (const tid of Object.keys(this._collectorSnap)) if (!snap[tid]) { const rs = $(tid === 'local' ? 'rescan-local' : tid + '-rescan'); if (rs) rs.hidden = !(tid === 'local' ? this.dirHandle : this._dirHandles[tid]); }   // a tool that left the collector's status: its Re-scan back to the folder-handle rule
    this._collectorSnap = snap; this._collectorSummary = summary;
    let nTools = 0, nFiles = 0;
    for (const s of Object.values(snap)) if (s.landed) { nTools++; nFiles += s.matched; }
    const zero = summary.filter(r => r.files === 'found, nothing to read').length, outN = summary.filter(r => r.files === 'disconnected').length;
    const label = `${nTools} tool${nTools === 1 ? '' : 's'} · ${nFiles} file${nFiles === 1 ? '' : 's'}`;
    const prev = Store.connectors[c.id] || {};
    // o.quiet (a tool disconnected on this page, review m3): nothing was checked — label, table and exclusion follow, lastSync / err stay, an error line stays
    Store.setConnector(c.id, o.quiet ? { label, excluded: [...this._collectorExcluded] } : { label, lastSync: Date.now(), err: null, excluded: [...this._collectorExcluded] });
    const status = $(c.id + '-status');
    if (status && !(o.quiet && prev.err)) {
      const at = o.quiet && prev.lastSync ? new Date(prev.lastSync) : new Date();
      status.textContent = ''; status.dataset.gen = '';
      status.appendChild(el('span', { class: 'ok', text: '● Connected. ' }));
      status.appendChild(document.createTextNode(label + (zero ? ` · ${zero} found, nothing to read` : '') + (outN ? ` · ${outN} disconnected` : '') + ` · checked ${at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
        + (this._pollTimers[c.id] ? ` · watching for changes every ${this._collectorEverySec(c)} s` : '')));
    }
    this._renderCollectorTools($('collector-tools'), summary);
    this.render();
  },
  /** Automatic mode: GET /api/status every c.pollEvery ms (default 60 s) — the collector's CACHED walk, never ?refresh=1 (a forced re-walk of a large log
   *  tree every minute is not the point) — and re-read only the tools whose files / newestMtime changed (_collectorTick). Started by connectCollector after
   *  a successful connect (no immediate tick: everything was just read) and by init for a restored entry with a remembered token; a restart keeps the
   *  snapshot. The timer lives in _pollTimers next to the metrics polls, so Clear stored data stops it with them. */
  startCollectorWatch(c) {
    if (!c || c.kind !== 'collector') return;
    if (this._pollTimers[c.id]) clearInterval(this._pollTimers[c.id]);
    this._pollTimers[c.id] = setInterval(() => { this._collectorTick(c); }, c.pollEvery || 60000);
  },
  /** Stops the watch (disconnect, a new connect, Clear stored data) and bumps the tick generation so an in-flight tick commits nothing. Takes an entry or an id. */
  stopCollectorWatch(c) {
    const id = typeof c === 'string' ? c : c.id;
    if (this._pollTimers[id]) { clearInterval(this._pollTimers[id]); delete this._pollTimers[id]; }
    this._gen[id + ':poll'] = (this._gen[id + ':poll'] || 0) + 1;
  },
  /** One watch tick (also Refresh all's collector job). Skipped while the tab is hidden (no request — the collector's status is cached, the next visible
   *  tick sees the same changes) and once the entry is gone (disconnect / Clear stored data: a tick never re-creates it). Otherwise GET /api/status with
   *  the token at hand (input, else remembered — a restored entry without one waits for Reconnect), then _collectorWalk with change detection: only the
   *  tools whose files / newestMtime moved (or that newly appear) are re-read, incrementally (unchanged files hit the ScanCache); unchanged tools are not
   *  touched. A failing request (not running / 401 / 5xx) sets the entry's err (attention) and leaves the tools' entries and data alone — the next good
   *  tick clears it. Bails on a stale generation (stopCollectorWatch / disconnect / a newer connect) like _pollTick. A tick that succeeds outside the
   *  watch (Refresh all once a token was pasted after a token-less restore) resumes it. Returns true when it committed. */
  async _collectorTick(c) {
    if (document.hidden) return;
    if (!Store.connectors[c.id]) return;
    const slot = c.id + ':poll';
    const gen = this._gen[slot] = this._gen[slot] || 0;   // read, don't bump — stopCollectorWatch / disconnect bump it to invalidate in-flight ticks
    const { token, base } = this._collectorCreds(c);
    if (!token) return;
    const status = $(c.id + '-status'), api = this._collectorApi(base, token);
    const stale = () => gen !== this._gen[slot] || !Store.connectors[c.id];
    let st;
    try { st = await api('/api/status'); }
    catch (e) {
      if (stale()) return;
      const err = this._collectorErrText(e, base);
      Store.setConnector(c.id, { err });   // attention; the entry, the tools' entries and their data stay — the next good tick clears it
      if (status && !status.dataset.gen) {
        status.textContent = '';
        status.appendChild(el('span', { class: 'err', text: 'Needs attention: ' }));
        status.appendChild(document.createTextNode(err + (this._pollTimers[c.id] ? ` · trying again in ${this._collectorEverySec(c)} s` : '')));
      }
      this.render();
      return;
    }
    if (stale()) return;
    const walked = await this._collectorWalk(c, st, { api, base, token, full: false, stale });
    if (!walked) return;
    if (!this._pollTimers[c.id]) this.startCollectorWatch(c);
    this._collectorCommit(c, walked.snap, walked.summary);
    return true;
  },
  /** Re-reads ONE tool through the collector — its card's Re-scan button, hub Sync and Claude Code's rescan() land here while _viaCollector(id): re-list +
   *  scan through _collectorScanTool (the connect path), then the collector's snapshot, table row and label follow. Falls back to the folder rule
   *  (rescanFolder / rescan) when the collector no longer has the tool. Returns true when rows landed. */
  async rescanViaCollector(id) {
    const conn = connectorById(id), c = connectorById('collector');
    if (!conn || !c) return;
    if (!this._viaCollector(id)) return id === 'local' ? this.rescan() : this.rescanFolder(id);
    const { token, base } = this._collectorCreds(c);
    const s = this._scanStatusEl(id);
    if (!token) { if (s) s.textContent = 'Paste the collector token on its card and click Validate & connect first.'; return; }
    const slot = c.id + ':poll', gen = this._gen[slot] = this._gen[slot] || 0;
    const stale = () => gen !== this._gen[slot] || !Store.connectors[c.id];
    const r = await this._collectorScanTool(conn, { api: this._collectorApi(base, token), base, token, stale }, $(c.id + '-status'));
    if (!r) return;
    if (!r.landed && s) {   // scanFiles wrote the tool's line when it ran; the two cases that never reach it say why here
      if (r.retry) s.textContent = `Could not list ${conn.name} through the collector — ${r.note.replace(/^error: /, '')}`;
      else if (!r.matched) s.textContent = `No matching files found through the collector — expected ${conn.hint || 'log files'}.`;
    }
    const snap = { ...this._collectorSnap }, summary = this._collectorSummary.map(x => ({ ...x }));
    const prev = snap[id] || { files: 0, newestMtime: 0 };
    snap[id] = r.retry ? { files: -1, newestMtime: -1, matched: 0, landed: false, note: r.note } : { files: prev.files, newestMtime: prev.newestMtime, matched: r.matched, landed: r.landed, note: r.note };
    const row = summary.find(x => x.id === id); if (row) row.files = r.note;
    this._collectorCommit(c, snap, summary);
    return r.landed === true ? true : undefined;
  },
  /** init: a restored collector entry resumes the watch by itself when a token is remembered — the tools' cards show their stored data until the first
   *  tick (pollEvery) reads what changed (the snapshot starts empty, so every found tool counts as changed once, incrementally). No remembered token →
   *  the card says Reconnect (the entry and the tools' data stay; Validate & connect resumes). Writes the line before the first render, so
   *  _syncStatusLine (initial text only) leaves it; an entry restored with an err keeps that line's "Needs attention" until a good tick. */
  _restoreCollectorWatch() {
    for (const c of CONNECTORS) {
      if (c.kind !== 'collector' || !Store.connectors[c.id]) continue;
      const st = Store.connectors[c.id], s = $(c.id + '-status');
      this._collectorExcluded = new Set(Array.isArray(st.excluded) ? st.excluded.filter(x => typeof x === 'string') : []);   // tools disconnected while collector-fed stay out across a reload (review m3)
      const when = st.lastSync ? new Date(st.lastSync).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      if (!LS.get(c.keyLS, null)) { if (s) s.textContent = `Reconnect: paste the collector token and click Validate & connect to resume watching${when ? ' — stored data from ' + when + ' is shown' : ''}.`; continue; }
      this.startCollectorWatch(c);
      if (s && !st.err) {
        s.textContent = '';
        s.appendChild(el('span', { class: 'ok', text: '● Connected' }));
        s.appendChild(document.createTextNode(` (stored data${when ? ' · synced ' + when : ''}) · watching for changes every ${this._collectorEverySec(c)} s`));
      }
      this._collectorTick(c);   // review m4: read what changed NOW (idempotent; skipped in a hidden tab) — otherwise the snapshot stays empty for a full interval and a collector-fed tool's Sync would open the folder picker meanwhile
    }
  },
  /* =================== metrics-poll driver (vLLM / llama.cpp: cumulative /metrics counters → today's rows) =================== */
  _pollTimers: {},   // connectorId → setInterval handle. Never persisted: a fresh page starts no poll until Validate / Sync / Refresh (no auto-fetch on load). v7 T3: the collector's status watch lives here too (the Clear stored data loop stops it with the polls); it alone resumes on load — from a restored entry + a remembered token (_restoreCollectorWatch)
  /** Start (or restart) polling for a local-server entry that names a `poll` fn. Called by connectServer after a successful validate; idempotent.
   *  The first tick runs now: it seeds the baseline (nothing counted yet) or counts what accrued since the stored baseline. */
  startPoll(c) {
    if (!c || !c.poll) return;
    this.stopPoll(c);
    this._pollTimers[c.id] = setInterval(() => { this._pollTick(c); }, c.pollEvery || 60000);
    return this._pollTick(c);
  },
  /** Stop polling (disconnect, clear-data, restart). Bumps the poll generation so an in-flight tick cannot commit afterwards. */
  stopPoll(c) {
    const id = typeof c === 'string' ? c : c.id;
    if (this._pollTimers[id]) { clearInterval(this._pollTimers[id]); delete this._pollTimers[id]; }
    this._gen[id + ':poll'] = (this._gen[id + ':poll'] || 0) + 1;
  },
  /** One poll. Reads the cumulative counters, diffs them against the LS baseline ('poll:<id>' = { base, counters, at }; a snapshot from another base URL counts as none), merges the positive deltas
   *  into TODAY's rows (this hour) under c.id, then stores the new baseline. A counter LOWER than its baseline = server restart → that field
   *  restarts from the current value (never negative; tokens between the restart and this tick are lost — the card says so). Skipped while the
   *  tab is hidden (no fetch, no baseline write) — the server's counters keep growing meanwhile, so the first tick after the tab is visible again books the whole hidden period into that hour (the card says so); a failed fetch (server gone, metrics off)
   *  keeps the last good state and tries again next tick. Hub label: '<serverLabel> · counts while this page is open'. */
  async _pollTick(c) {
    if (document.hidden) return;
    if (!Store.connectors[c.id]) return;   // entry deleted (disconnect / "not running" re-validate): a tick must never re-create it from nothing
    const fn = globalThis[c.poll];
    if (typeof fn !== 'function') return;
    const slot = c.id + ':poll';
    const gen = this._gen[slot] = this._gen[slot] || 0;   // read, don't bump — stopPoll / disconnect bump it to invalidate in-flight ticks
    const base = (LS.get('url:' + c.id, null) || c.baseUrl).replace(/\/+$/, '');
    let res;
    try { res = await fn(base); }
    catch (e) {
      if (gen !== this._gen[slot] || !Store.connectors[c.id]) return;
      this._pollFailed(c, e);   // a dead server / metrics off is attention on the card, never a green dot; the next good tick clears it (A0 #2)
      return;
    }
    if (gen !== this._gen[slot] || !Store.connectors[c.id]) return;   // stopped / disconnected (or the entry deleted) while the fetch was in flight
    const FIELDS = ['in', 'out', 'cw', 'cr', 'msgs'];
    const cur = {};
    for (const [model, cnt] of Object.entries((res && res.counters) || {})) { cur[model] = {}; for (const f of FIELDS) cur[model][f] = finTok(+(cnt && cnt[f]) || 0); }
    const key = 'poll:' + c.id, prev = LS.get(key, null);
    const d = todayKey(), hour = new Date().getHours();
    const rows = ((Store.sources[c.id] || {}).rows || []).slice();
    let merged = false;
    if (prev && prev.counters && prev.base === base) {   // a snapshot taken at another server URL is NOT a baseline: seed only, or its lifetime counters would be booked as usage
      for (const [model, now] of Object.entries(cur)) {
        const was = prev.counters[model] || {};
        const delta = {}; let any = false;
        for (const f of FIELDS) { const b = finTok(+was[f] || 0); delta[f] = now[f] >= b ? now[f] - b : 0; if (delta[f] > 0) any = true; }
        if (!any) continue;
        let row = rows.find(r => r.d === d && r.hour === hour && r.platform === c.platform && r.model === model);
        if (!row) { row = { d, hour, platform: c.platform, model, in: 0, cw: 0, cr: 0, out: 0, msgs: 0 }; rows.push(row); }
        for (const f of FIELDS) row[f] += delta[f];
        merged = true;
      }
    }
    LS.set(key, { base, counters: cur, at: Date.now() });
    if (merged) { const meta = (Store.sources[c.id] || {}).meta || {}; Store.setSource(c.id, rows, { ...meta, polls: (meta.polls || 0) + 1, lastPoll: Date.now() }); }
    const st = Store.connectors[c.id] || {};
    Store.setConnector(c.id, { label: [st.serverLabel, 'counts while this page is open'].filter(Boolean).join(' · '), lastSync: Date.now(), serverErr: null, err: st.scanErr || null });
    if (st.serverErr) this._pollRecovered(c);   // the previous tick had failed: the line says so no more
    if (merged || st.serverErr) this.render();
  },
  /** A0 #2 — a failed poll (server gone, --metrics off): serverErr on the entry (attention, the per-half rule scanFiles / connectServer use) + the
   *  status line unless a validation owns it (dataset.gen). The timer keeps running; the next good tick clears it through _pollRecovered. */
  _pollFailed(c, e) {
    const msg = String((e && e.message) || e);
    const serverErr = ('Poll failed: ' + msg).slice(0, 80);
    Store.setConnector(c.id, { serverErr, err: serverErr });
    const status = $(c.id + '-status');
    if (status && !status.dataset.gen) {
      status.textContent = '';
      status.appendChild(el('span', { class: 'err', text: 'Needs attention: ' }));
      status.appendChild(document.createTextNode(`${msg} — trying again in ${Math.round((c.pollEvery || 60000) / 1000)} s`));
    }
    this.render();
  },
  _pollRecovered(c) {
    const status = $(c.id + '-status');
    if (!status || status.dataset.gen) return;
    status.textContent = '';
    status.appendChild(el('span', { class: 'ok', text: '● Connected. ' }));
    status.appendChild(document.createTextNode('polling again — counts from /metrics resume this hour'));
  },

  async pickFolder() {
    if (!window.showDirectoryPicker) { $('folder-fallback').click(); return; }
    try {
      const handle = await showDirectoryPicker({ id: 'claude-logs', mode: 'read' });
      this.dirHandle = handle;
      IDB.set('claudeDir', handle);
      await this.scanHandle(handle);
    } catch (e) { if (e && e.name !== 'AbortError') console.warn(e); }
  },

  async rescan() {
    if (this._viaCollector('local')) return this.rescanViaCollector('local');   // v7 T3: the collector feeds this card — Re-scan / Sync go through it, not the handle or the picker
    if (!this.dirHandle) return this.pickFolder();   // nothing stored → the picker is the only way in
    // a stored handle owns this path: a denied re-grant is a message, NOT a silent fall-through to the picker (rescanFolder's rule, A0 #1)
    const status = $('local-status');
    try {
      let perm = await this.dirHandle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') perm = await this.dirHandle.requestPermission({ mode: 'read' });
      if (perm === 'granted') { await this.scanHandle(this.dirHandle); return; }
      status.textContent = 'Permission denied — click Choose .claude folder… to pick the folder again.';
    } catch (e) { status.textContent = 'Could not re-check folder access: ' + (e.message || e) + ' — click Choose .claude folder… to pick the folder again.'; }
  },

  async restoreHandle() {
    try {
      const handle = await IDB.get('claudeDir');
      if (!handle) return;
      this.dirHandle = handle;
      $('rescan-local').hidden = false;
      const perm = await handle.queryPermission({ mode: 'read' });
      if (perm === 'granted') this.scanHandle(handle);
      else {
        const s = $('local-status');
        if (Store.sources.local) {
          s.textContent = `Showing saved data (${fmtInt(Store.sources.local.meta.msgs || 0)} messages). Click Re-scan to refresh from disk.`;
        } else s.textContent = 'Folder remembered — click Re-scan to grant access and load.';
      }
    } catch (e) { console.warn(e); }
  },

  _gen: { local: 0, anthropic: 0, openai: 0, gemini: 0, copilot: 0, openrouter: 0 },
  _workerThreshold: 8 * 1024 * 1024,   // bytes — an Imports file above this parses in parseInWorker (JSON via 'sniff' in _readJsonFor, Copilot activity CSV via 'copilot-csv'); checks set 0 to force the worker path

  /** One JSON document's text → { obj, pre } for _importJson. Small files (≤ App._workerThreshold) parse here. Big ones go to parseInWorker('sniff'):
   *  the worker parses, sniffs and — for a chat export — parses the export too, so only { kind, res } crosses back and the main thread never parses
   *  the document; any other shape (provider report, Takeout, empty, unknown) comes back kind-only and is parsed here as before (rare at that size).
   *  Throws like JSON.parse for malformed text from either path. */
  async _readJsonFor(text, f) {
    if (f.size > App._workerThreshold) {
      const pre = await parseInWorker('sniff', text, $('assumed-claude-model').value, f.name);
      if (pre.res) return { obj: null, pre };
    }
    return { obj: JSON.parse(text), pre: null };
  },

  /** One parsed JSON document → its import branch. `f` = { name, size } (a File, or a ZIP-entry wrapper — name then reads
   *  "archive.zip/entry.json"). Pushes its own note. Returns the number of imports (0 = recognized but nothing landed, e.g. an
   *  all-empty report) or null when the shape is not recognized (the caller words that: loose file vs. ZIP entry). */
  async _importJson(obj, f, notes, pre) {
    const kind = pre ? pre.kind : sniffJSON(obj, f.name);   // pre = { kind, res } from parseInWorker('sniff') via _readJsonFor: the document was parsed + sniffed in the worker (obj is null then) and the branch lands res
    let imported = 0;
    if (kind === 'chatgpt-export' || kind === 'chatgpt-export-wrapped') {
      // big exports (> App._workerThreshold) arrive pre-parsed from the worker (_readJsonFor) so the tab doesn't freeze; small ones parse inline — worker startup isn't worth it for them
      const res = pre ? pre.res : parseChatGPTExport(kind === 'chatgpt-export' ? obj : obj.conversations);
      Store.setSource('chatgpt', res.rows, res.meta);
      notes.push(`${f.name}: ChatGPT export — ${res.meta.convs} conversations, ${fmtInt(res.meta.msgs)} replies (estimated tokens${undatedNote(res.meta)})`);
      imported++;
    } else if (kind === 'claudeai-export') {
      const res = pre ? pre.res : parseClaudeAiExport(obj, $('assumed-claude-model').value);
      Store.setSource('claudeai', res.rows, res.meta);
      notes.push(`${f.name}: Claude.ai export — ${res.meta.convs} conversations, ${fmtInt(res.meta.msgs)} replies (estimated tokens${undatedNote(res.meta)})`);
      imported++;
    } else if (kind === 'gemini-takeout') {
      const res = parseGeminiTakeout(obj);
      Store.setSource('gemini-takeout', res.rows, res.meta);
      notes.push(`${f.name}: Gemini Takeout — ${fmtInt(res.meta.msgs)} prompts (estimated tokens${res.meta.skipped ? `; ${res.meta.skipped} non-Gemini/undated record(s) skipped` : ''})`);
      imported++;
    } else if (kind === 'grok-export') {
      const res = pre ? pre.res : parseGrokExport(obj);
      Store.setSource('grok-export', res.rows, res.meta);   // one export = the whole history → re-import replaces
      notes.push(`${f.name}: Grok export — ${res.meta.convs} conversations, ${fmtInt(res.meta.msgs)} replies (estimated tokens; input = the preceding prompt only${res.meta.skipped ? `; ${res.meta.skipped} undated repl${res.meta.skipped === 1 ? 'y' : 'ies'} skipped` : ''})`);
      imported++;
    } else if (kind === 'deepseek-chat-export') {
      const res = pre ? pre.res : parseDeepSeekChatExport(obj);
      Store.setSource('deepseek-chat-export', res.rows, res.meta);   // one archive = the whole history → re-import replaces
      notes.push(`${f.name}: DeepSeek chat export — ${res.meta.convs} conversations, ${fmtInt(res.meta.msgs)} replies (estimated tokens${res.meta.skipped ? `; ${res.meta.skipped} undated repl${res.meta.skipped === 1 ? 'y' : 'ies'} skipped` : ''})`);
      imported++;
    } else if (kind === 'meta-ai-export') {
      const res = pre ? pre.res : parseMetaAiExport(obj, f.name);
      // Download-your-information splits threads into message_N.json files: rows carry the thread as sid, so a file replaces only its own thread
      const keep = ((Store.sources['meta-ai-export'] || {}).rows || []).filter(r => r.sid !== res.meta.sid && !(Array.isArray(r.sids) && r.sids.includes(res.meta.sid)));
      const all = keep.concat(res.rows);
      Store.setSource('meta-ai-export', all, { msgs: all.reduce((a, r) => a + (r.msgs || 0), 0), threads: new Set(all.flatMap(r => r.sid ? [r.sid] : (r.sids || []))).size }, { perSid: true });   // compaction keeps one bucket per thread (scalar sid) so the filter above stays exact
      notes.push(`${f.name}: Meta AI thread — ${fmtInt(res.meta.msgs)} replies (estimated tokens${res.meta.skipped ? `; ${res.meta.skipped} undated skipped` : ''}; threads merge, the same thread re-imported replaces itself)`);
      imported++;
    } else if (kind === 'perplexity-export') {
      const res = pre ? pre.res : parsePerplexityExport(obj, f.name);
      const keep = ((Store.sources['perplexity-export'] || {}).rows || []).filter(r => r.sid !== res.meta.sid && !(Array.isArray(r.sids) && r.sids.includes(res.meta.sid)));
      const all = keep.concat(res.rows);
      Store.setSource('perplexity-export', all, { msgs: all.reduce((a, r) => a + (r.msgs || 0), 0), files: new Set(all.flatMap(r => r.sid ? [r.sid] : (r.sids || []))).size }, { perSid: true });   // compaction keeps one bucket per file (scalar sid) so the filter above stays exact
      notes.push(`${f.name}: Perplexity export — ${fmtInt(res.meta.msgs)} threads (estimated tokens${res.meta.skipped ? `; ${res.meta.skipped} undated skipped` : ''}; files merge, the same file re-imported replaces itself)`);
      imported++;
    } else if (kind === 'mistral-vibe-export') {   // Plan 9 B6
      const res = pre ? pre.res : parseMistralVibeExport(obj);
      Store.setSource('mistral-vibe-export', res.rows, res.meta);   // one export = the whole account → re-import replaces
      notes.push(`${f.name}: Mistral Vibe export — ${res.meta.convs} conversations, ${fmtInt(res.meta.msgs)} replies (estimated tokens; model per conversation; input = the preceding prompt only${undatedNote(res.meta)})`);
      imported++;
    } else if (kind === 'cody-export') {   // Plan 9 B6
      const res = pre ? pre.res : parseCodyExport(obj);
      Store.setSource('cody-export', res.rows, res.meta);   // History > Export is the whole history → re-import replaces
      notes.push(`${f.name}: Sourcegraph Cody export — ${res.meta.chats} chats, ${fmtInt(res.meta.msgs)} replies (estimated tokens; the export names no model per turn${undatedNote(res.meta)})`);
      imported++;
    } else if (kind === 'characterai-export') {   // Plan 9 B6
      const res = pre ? pre.res : parseCharacterAiExport(obj, f.name);
      this._landPerFileExport('characterai-export', res);
      notes.push(`${f.name}: Character.ai export — ${fmtInt(res.meta.msgs)} replies (estimated tokens; no model${undatedNote(res.meta)}; message files merge, the same file re-imported replaces itself)`);
      imported++;
    } else if (kind === 'anthropic-usage') {
      const res = parseAnthropicUsage(obj);
      this._gen.anthropic++;   // an import supersedes any in-flight fetch — it must not overwrite this
      Store.setSource('anthropic', res.rows, {});
      notes.push(`${f.name}: Anthropic usage report — ${res.rows.length} rows`);
      imported++;
    } else if (kind === 'anthropic-cost') {
      this._gen.anthropic++;   // an import supersedes any in-flight fetch — it must not overwrite this
      Store.setBilled('anthropic', parseAnthropicCost(obj));
      notes.push(`${f.name}: Anthropic billed costs imported`);
      imported++;
    } else if (kind === 'openai-usage') {
      const res = parseOpenAIUsage(obj);
      this._gen.openai++;   // an import supersedes any in-flight fetch — it must not overwrite this
      Store.setSource('openai', res.rows, {});
      notes.push(`${f.name}: OpenAI usage report — ${res.rows.length} rows`);
      imported++;
    } else if (kind === 'openai-cost') {
      this._gen.openai++;   // an import supersedes any in-flight fetch — it must not overwrite this
      Store.setBilled('openai', parseOpenAICost(obj));
      notes.push(`${f.name}: OpenAI billed costs imported`);
      imported++;
    } else if (kind === 'empty-report') {
      notes.push(`${f.name}: recognized usage/cost report, but every day in it is empty — nothing to import`);
    } else if (kind === 'empty-export') {
      notes.push(`${f.name}: empty export — nothing to import`);
    } else {
      return null;
    }
    return imported;
  },

  /** Plan 9 B6 — lands a per-file export whose rows carry sid = file name (Character.ai's message files): the same file re-imported replaces only itself, other
   *  files merge; meta.msgs / meta.files are recomputed over everything stored. (Meta AI, Perplexity and the Copilot activity CSV keep their inline copies of this rule.) */
  _landPerFileExport(srcId, res) {
    const keep = ((Store.sources[srcId] || {}).rows || []).filter(r => r.sid !== res.meta.sid && !(Array.isArray(r.sids) && r.sids.includes(res.meta.sid)));
    const all = keep.concat(res.rows);
    Store.setSource(srcId, all, { msgs: all.reduce((a, r) => a + (r.msgs || 0), 0), files: new Set(all.flatMap(r => r.sid ? [r.sid] : (r.sids || []))).size }, { perSid: true });   // compaction keeps one bucket per file (scalar sid) so the filter above stays exact
  },
  /** A0 #10 — billed days of a generic CSV import: the days the import covers take its cost column, or are REMOVED when it has none (the Cursor
   *  rule: stale dollars must not survive behind replaced rows); days outside the import keep theirs. A CSV that never carried costs creates no envelope. */
  _landGenericCsvBilled(res) {
    if (!Store.billed.csv && !res.billed.length) return;
    const days = new Set(res.rows.map(r => r.d));
    const bm = new Map(Store.billedRows('csv').filter(b => !days.has(b.d)).map(b => [b.d, b]));
    for (const b of res.billed) bm.set(b.d, b);
    Store.setBilled('csv', [...bm.values()].sort((a, b) => a.d < b.d ? -1 : 1));
  },
  /** Plan 9 B3 — Cerebras Analytics CSV (sniffed by header + "cerebras" in the name): exact rows land under the cerebras card's srcId 'cerebras-usage-csv'
   *  (platform Cerebras), merged by (day, model) so re-imports and overlapping reports never double; no billed path (the Cost tab has no export — dollars are
   *  priced from the list). Like the DeepSeek export, the import is a sync of the cerebras card (lastSync moves, a keyed label is kept) and is not counted as an
   *  Imports-card import. A report with no dated rows touches nothing and says so. */
  _landCerebrasCsv(res, fileName, notes) {
    const tail = res.meta.rejected ? ` — ${res.meta.rejected} value(s) rejected (non-numeric, negative or undated)` : '';
    if (!res.rows.length) { notes.push(`${fileName}: Cerebras usage CSV — no rows (nothing imported)${tail}`); return; }
    const keyOf = (r) => r.d + '\u0001' + r.model;
    const merged = new Map((((Store.sources['cerebras-usage-csv'] || {}).rows) || []).map(r => [keyOf(r), r]));
    for (const r of res.rows) merged.set(keyOf(r), r);
    Store.setSource('cerebras-usage-csv', [...merged.values()], { buckets: merged.size, rows: res.meta.rows, rejected: res.meta.rejected, cachedColumn: res.meta.cachedColumn });
    Store.setConnector('cerebras', { label: (Store.connectors.cerebras || {}).label || 'usage CSV (no key)', lastSync: Date.now() });
    notes.push(`${fileName}: Cerebras usage CSV — ${fmtInt(res.meta.rows)} rows (exact tokens${res.meta.cachedColumn ? ', cached input as cache reads' : ''}; re-imports merge by day/model; dollars priced from the list — the Cost tab has no export)${tail}`);
  },
  /** Plan 9 B4 — Alibaba Cloud Model Studio bill CSV (sniffed by header: Instance ID + Usage + an amount column): exact token rows land under the
   *  alibaba-modelstudio card's srcId 'alibaba-bill-csv' (platform Alibaba Model Studio) merged by (day, model); the bill's amounts land as billed dollars per day
   *  under the same srcId, a same-day re-import replacing that day (a bill is re-exported whole, never appended). Like the Cerebras import it is a sync of the
   *  card (lastSync moves, a keyed label is kept) and not an Imports-card import; a bill with no usable line touches nothing and says so. */
  _landAlibabaBillCsv(res, fileName, notes) {
    const m = res.meta, tail = this._alibabaBillTail(m);
    if (!res.rows.length && !res.billed.length) { notes.push(`${fileName}: Model Studio bill CSV — no usable lines (nothing imported)${tail}`); return; }
    const keyOf = (r) => r.d + '\u0001' + r.model;
    const merged = new Map((((Store.sources['alibaba-bill-csv'] || {}).rows) || []).map(r => [keyOf(r), r]));
    for (const r of res.rows) merged.set(keyOf(r), r);
    if (merged.size) Store.setSource('alibaba-bill-csv', [...merged.values()], { buckets: merged.size, ...m });
    const bm = new Map(Store.billedRows('alibaba-bill-csv').map(b => [b.d, b]));
    for (const b of res.billed) bm.set(b.d, b);
    Store.setBilled('alibaba-bill-csv', [...bm.values()].sort((a, b) => a.d < b.d ? -1 : 1));
    Store.setConnector('alibaba-modelstudio', { label: (Store.connectors['alibaba-modelstudio'] || {}).label || 'bill CSV (no key)', lastSync: Date.now() });
    const pl = (n) => (n === 1 ? '' : 's'), total = res.billed.reduce((a, b) => a + b.amount, 0);
    notes.push(`${fileName}: Model Studio bill CSV — ${fmtInt(m.rows)} lines → ${res.rows.length} day·model row${pl(res.rows.length)} (exact tokens from the Instance ID) + ${fmtUSD(total)} billed over ${res.billed.length} day${pl(res.billed.length)} (${m.amountColumn}${m.currency ? ', ' + m.currency : ''}); re-imports merge by day/model and replace a day's amount${tail}`);
  },
  /** the bill importer's housekeeping counts, as one trailing clause (or '') */
  _alibabaBillTail(m) {
    const parts = [];
    if (m.rejected) parts.push(`${m.rejected} value(s) rejected (non-numeric, negative or undated)`);
    if (m.nonToken) parts.push(`${m.nonToken} dollars-only line(s) (no token type in the Instance ID)`);
    if (m.otherProducts) parts.push(`${m.otherProducts} line(s) of other products skipped`);
    if (m.cycleDays) parts.push(`${m.cycleDays} undated line(s) booked on the billing month's 1st`);
    return parts.length ? ' — ' + parts.join('; ') : '';
  },
  async handleImportFiles(files) {
    const status = $('import-status');
    clear(status);
    const notes = [];
    const jsonlFiles = [];
    let imported = 0;   // count of successful import branches — only these justify a connected 'imports' card
    const expBefore = CONNECTORS.filter(c => c.kind === 'export-file').map(c => [c, Store.connectorStatus(c)]);   // export-file cards have no entry (no setConnector → no onConnectorChange): apply the off→connected auto-reveal rule below
    // DeepSeek API usage export (monthly ZIP, or its loose amount-/cost- CSVs): every month is a separate export, so rows MERGE by
    // (day, model) and billed by day — importing August never deletes July. Rows live under the deepseek connector's srcId
    // 'deepseek-usage-zip' (platform 'DeepSeek API'), not under Imports; the deepseek card reads connected through the export alone — so the
    // file is listed in the Imports notes but never counted in the Imports card's "N file(s) imported" (that count is what connects that card).
    const landDeepSeek = (res, label) => {
      const keyOf = (r) => JSON.stringify([r.d, r.model]);
      const prev = Store.sources['deepseek-usage-zip'] || { rows: [], meta: {} };
      if (res.rows.length) {
        const merged = new Map(prev.rows.map(r => [keyOf(r), r]));
        for (const r of res.rows) merged.set(keyOf(r), r);
        Store.setSource('deepseek-usage-zip', [...merged.values()], { buckets: merged.size, ...deepSeekMonthCounts(prev.meta, res), rejected: res.meta.rejected, currency: res.meta.currency || (prev.meta || {}).currency || '' });   // rows / files summed over the stored months (A0 #9)
      }
      if (res.billed.length) {
        const bm = new Map(Store.billedRows('deepseek-usage-zip').map(b => [b.d, b]));
        for (const b of res.billed) bm.set(b.d, b);   // same-day re-import replaces
        Store.setBilled('deepseek-usage-zip', [...bm.values()].sort((a, b2) => a.d < b2.d ? -1 : 1));
      }
      // a sync of the deepseek card: lastSync moves on every import (a keyed card must not read "needs attention" 7 days after its last balance check); a keyed label and any key error are kept
      Store.setConnector('deepseek', { label: (Store.connectors.deepseek || {}).label || 'usage export (no key)', lastSync: Date.now() });
      const what = res.rows.length ? `${fmtInt(res.meta.rows)} rows (exact tokens; months merge by day/model)` : 'no token rows';
      const money = res.billed.length ? ` + billed amounts from the ${res.meta.billedFrom || 'cost CSV'}${res.meta.currency ? ' in ' + res.meta.currency + (res.meta.currency !== 'USD' ? ' (shown as-is in the $ fields)' : '') : ''}`
        : (res.rows.length ? ' — no cost file: drop the month\'s cost-*.csv too for billed amounts' : '');
      notes.push(`${label}: DeepSeek API usage export — ${what}${money}` + (res.meta.rejected ? ` — ${res.meta.rejected} value(s) rejected (non-numeric, negative or undated)` : ''));
      // no imported++ — not an Imports-card import (see above)
    };
    for (const f of files) {
      try {
        status.appendChild(el('div', { text: `Parsing ${f.name}…` }));
        if (f.size > 200 * 1024 * 1024) status.appendChild(el('div', { text: `${f.name} is ${Math.round(f.size / 1048576)} MB — this may take a minute; the tab may briefly freeze.` }));
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));   // paint before blocking parse
        if (f.name.endsWith('.jsonl')) { jsonlFiles.push({ path: f.name, file: f }); continue; }
        if (/\.zip$/i.test(f.name)) {
          // ZIP archives, read in-page (no library): DeepSeek's monthly usage export (amount-*.csv + cost-*.csv) and chat-app exports
          // as downloaded (ChatGPT / Claude.ai conversations.json, Perplexity thread JSON, a DeepSeek chat archive). Entries we do not
          // know (user.json, chat.html, …) are skipped quietly; an archive with nothing we know gets one honest note.
          const entries = await readZipEntries(f);
          let handled = 0;
          const ds = await parseDeepSeekUsageZip(entries);
          if (ds.meta.files) { landDeepSeek(ds, `${f.name} (${ds.meta.amountFiles} amount + ${ds.meta.costFiles} cost CSV)`); handled++; }
          for (const e of entries) {
            if (!/\.json$/i.test(e.name) || e.size > 200 * 1024 * 1024) continue;
            if (/(^|\/)shared_conversations\.json$/i.test(e.name)) continue;   // ChatGPT's shared-links file has conversations.json's shape and would replace it
            const ef = { name: f.name + '/' + e.name, size: e.size };
            let doc; try { doc = await this._readJsonFor(await e.text(), ef); } catch (err) { notes.push(`${f.name}/${e.name}: failed — ${err.message || err}`); continue; }
            const r = await this._importJson(doc.obj, ef, notes, doc.pre);
            if (r === null) continue;
            handled++; imported += r;
          }
          if (!handled) notes.push(`${f.name}: ZIP — no recognized files (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'})`);
          continue;
        }
        if (f.name.endsWith('.csv')) {
          const csvText = await f.text();
          const headCells = (parseCSV(csvText.split(/\r?\n/, 1)[0])[0] || []).map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
          if (isCursorUsageCSV(headCells)) {
            const res = parseCursorUsageCSV(csvText);
            // Each export is the date window picked on cursor.com/dashboard → Usage → Export CSV, so a re-import replaces ONLY the days the
            // export covers — [min d, max d] of its parsed rows — and keeps every stored day outside that window (importing August never
            // deletes July). Billed likewise: the window's billed days are replaced by the new Cost column, or REMOVED when the export has
            // no Cost column (a truthful empty for that window — stale dollars must not survive behind replaced rows); days outside the window
            // keep their amounts. An export with zero parsed rows (every date unreadable) touches nothing and says so.
            const how = res.meta.splitInput ? ` from the four additive columns${res.meta.hasTotal ? ', reconciled with Total Tokens' : ''}` : '';   // Input / Cache Read / Output only → plain "exact tokens"
            const tail = (res.meta.rejected ? ` — ${res.meta.rejected} value(s) rejected (non-numeric, negative or undated)` : '')
              + (res.meta.unreconciled ? ` — ${res.meta.unreconciled} row${res.meta.unreconciled === 1 ? '' : 's'} did not reconcile with Total Tokens (additive reading kept)` : '');
            if (!res.rows.length) { notes.push(`${f.name}: Cursor usage-events CSV — no rows (nothing imported, nothing replaced)${tail}`); continue; }
            let from = res.rows[0].d, to = from;
            for (const r of res.rows) { if (r.d < from) from = r.d; if (r.d > to) to = r.d; }
            const inWindow = (d) => d >= from && d <= to;
            const prevRows = ((Store.sources['cursor-csv'] || {}).rows || []), keptRows = prevRows.filter(r => !inWindow(r.d));
            const prevBilled = Store.billedRows('cursor-csv'), keptBilled = prevBilled.filter(b => !inWindow(b.d));
            const all = keptRows.concat(res.rows);
            Store.setSource('cursor-csv', all, { ...res.meta, rows: all.reduce((a, r) => a + (r.msgs || 0), 0) });   // meta.rows = events stored across every window; the rest describes this export
            Store.setBilled('cursor-csv', keptBilled.concat(res.billed).sort((a, b2) => a.d < b2.d ? -1 : 1));   // always an array — [] is a truthful empty
            const replaced = prevRows.reduce((a, r) => a + (inWindow(r.d) ? (r.msgs || 0) : 0), 0), dropped = prevBilled.length - keptBilled.length;
            notes.push(`${f.name}: Cursor usage-events CSV — ${res.meta.rows} events, ${from === to ? from : from + ' → ' + to} (exact tokens${how}${res.billed.length ? ' + cost column' : '; no cost column in this export'}) — a re-import replaces the days the export covers`
              + (replaced || dropped ? ` (${replaced} stored event${replaced === 1 ? '' : 's'} replaced` + (!res.billed.length && dropped ? `; ${dropped} billed day${dropped === 1 ? '' : 's'} in this window removed — no cost column` : '') + ')' : '')
              + tail);
            imported++;
            continue;
          }
          if (isDeepSeekAmountCSV(headCells, f.name)) {
            const r = parseDeepSeekAmountCSV(csvText);
            landDeepSeek({ rows: r.rows, billed: r.billed, meta: { ...r.meta, files: 1, billedFrom: r.billed.length ? 'price column' : 'none' } }, f.name);
            continue;
          }
          if (isDeepSeekCostCSV(headCells, f.name)) {
            const r = parseDeepSeekCostCSV(csvText);
            landDeepSeek({ rows: [], billed: r.billed, meta: { ...r.meta, files: 1, billedFrom: 'cost CSV' } }, f.name);
            continue;
          }
          if (isCopilotActivityCSV(headCells)) {
            const res = f.size > App._workerThreshold ? await parseInWorker('copilot-csv', csvText, null, f.name) : parseCopilotActivityCSV(csvText, f.name);   // a big activity export parses in the worker (same result)
            const keep = ((Store.sources['copilot-activity-csv'] || {}).rows || []).filter(r => r.sid !== res.meta.sid && !(Array.isArray(r.sids) && r.sids.includes(res.meta.sid)));   // one export per surface → files merge by name
            const all = keep.concat(res.rows);
            Store.setSource('copilot-activity-csv', all, { msgs: all.reduce((a, r) => a + (r.msgs || 0), 0), files: new Set(all.flatMap(r => r.sid ? [r.sid] : (r.sids || []))).size, apps: res.meta.apps }, { perSid: true });   // compaction keeps one bucket per file (scalar sid) so the filter above stays exact
            notes.push(`${f.name}: Microsoft Copilot activity CSV — ${fmtInt(res.meta.rows)} prompts (estimated tokens from prompt/response text${res.meta.apps.length ? '; ' + res.meta.apps.join(', ') : ''}${res.meta.skipped ? `; ${res.meta.skipped} row(s) with unreadable dates skipped` : ''})`);
            imported++;
            continue;
          }
          if (isAlibabaBillCSV(headCells)) { this._landAlibabaBillCsv(parseAlibabaBillCSV(csvText), f.name, notes); continue; }   // Plan 9 B4: lands under the alibaba-modelstudio card (tokens + billed), not under Imports
          if (isCerebrasUsageCSV(headCells, f.name)) { this._landCerebrasCsv(parseCerebrasUsageCSV(csvText), f.name, notes); continue; }   // Plan 9 B3: lands under the cerebras card, not under Imports
          const res = parseGenericCSV(csvText);
          // merge by (day, platform, model): re-imports replace matching rows instead of duplicating
          const keyOf = (r) => r.d + '\u0001' + r.platform + '\u0001' + r.model;
          const merged = new Map((Store.sources.csv ? Store.sources.csv.rows : []).map(r => [keyOf(r), r]));
          for (const r of res.rows) merged.set(keyOf(r), r);
          Store.setSource('csv', [...merged.values()], res.meta);
          this._landGenericCsvBilled(res);
          notes.push(`${f.name}: imported ${res.meta.rows} CSV rows (merged by day/platform/model)`
            + (res.meta.rejected ? ` — ${res.meta.rejected} value(s) rejected (non-numeric or negative)` : ''));
          imported++;
          continue;
        }
        const doc = await this._readJsonFor(await f.text(), f);
        const r = await this._importJson(doc.obj, f, notes, doc.pre);
        if (r === null) notes.push(`${f.name}: format not recognized`); else imported += r;
      } catch (e) {
        notes.push(`${f.name}: failed — ${e.message || e}`);
      }
    }
    if (jsonlFiles.length) {
      // Every .jsonl is sniffed by CONTENT (sniffJsonlFile): a Codex rollout / Copilot CLI events / Continue / Junie / usage-logger file is
      // routed to its registered folder-log parser under THAT connector's srcId through scanFiles — the very path a folder pick takes — so
      // rows, filesLabel / label / lastSync, the src card and the hub card land exactly as after a folder scan (a drop IS a scan of just
      // those files: like a re-scan it replaces that connector's rows; scanFiles writes its status to the connector's own card, so the note
      // here points there). Only Claude-shaped files take the local-import path below; an unrecognized .jsonl gets an honest note and
      // touches no source. Routed files never count toward this card's "N file(s) imported" — their rows live under the other connector.
      const groups = new Map();   // kind → [{ path, file }]
      for (const jf of jsonlFiles) { const kind = await sniffJsonlFile(jf.file, jf.path); if (!groups.has(kind)) groups.set(kind, []); groups.get(kind).push(jf); }
      for (const [kind, list] of groups) {
        if (kind === 'claude') continue;
        const c = JSONL_ROUTE[kind] ? connectorById(JSONL_ROUTE[kind].id) : null;
        if (!c) { for (const jf of list) notes.push(`${jf.path}: format not recognized`); continue; }
        const n = list.length, what = `${n} file${n === 1 ? '' : 's'} routed to ${c.name}`;
        const prevLabel = (Store.connectors[c.id] || {}).filesLabel || null;   // what the card showed before this drop (a folder scan or an earlier drop)
        try {
          // every dropped file gets its own synthetic directory (drop-<i>/…): the patterns still match, and a parser that derives the session id
          // from the parent directory (Copilot CLI events.jsonl — every session's file has the same name) sees distinct sids, so two dropped
          // files with the same event ids both count instead of the second deduping away against the first
          const replaced = await this.scanFiles(c, list.map((jf, i) => ({ path: `drop-${i}/${jsonlRoutePath(c, kind, jf.path)}`, file: jf.file })), { fromDrop: true });
          const err = (Store.connectors[c.id] || {}).scanErr;
          if (err) notes.push(`${what} (see its card) — scan failed: ${err}`);
          else if (replaced && prevLabel) notes.push(`${what} — this replaced the ${prevLabel} previously scanned for that card; re-scan its folder to restore`);   // honest: a drop replaces, it does not merge
          else notes.push(`${what} (see its card)`);
        } catch (e) { notes.push(`${what} — failed: ${e.message || e}`); }
      }
      const claudeFiles = groups.get('claude') || [];
      if (claudeFiles.length) {
        try {
          const res = await parseClaudeLogs(claudeFiles, null);
          if (res.meta.msgs === 0) {
            // Claude-shaped lines but no assistant usage (a summary-only / progress-only session) — do NOT replace prior local-import rows
            // with an empty set and do NOT count it as an import
            notes.push(`No Claude Code messages found in ${claudeFiles.length} .jsonl file${claudeFiles.length === 1 ? '' : 's'} — Claude Code-shaped lines, but no assistant usage`);
          } else {
            if (res.projects.length && !Store.sources.local) Store.projects = res.projects;   // folder scan wins; assign BEFORE persist
            Store.setSource('local-import', res.rows, res.meta);
            notes.push(`${claudeFiles.length} .jsonl file${claudeFiles.length === 1 ? '' : 's'}: ${fmtInt(res.meta.msgs)} messages imported`);
            imported++;
          }
        } catch (e) { notes.push(`.jsonl import failed — ${e.message || e}`); }
      }
    }
    clear(status);
    for (const n of notes) status.appendChild(el('div', { text: n }));
    // only a real success justifies showing the imports card as connected — a batch that
    // was entirely unparseable/unrecognized/failed must not fake a connected state.
    if (imported > 0) Store.setConnector('imports', { label: imported + ' file(s) imported', lastSync: Date.now() });
    for (const [c, prev] of expBefore) View.onConnectorChange(c.id, prev, Store.connectorStatus(c));   // a card hidden with ✕ comes back once its export lands (same rule as a key / folder connect)
    this.render();
  },

  /** Plan 10 T3b: "prices: bundled set of <PRICES_VERIFIED_ON>[, N user edits]" — the KPI footer and the CSV export's first line. */
  priceSetLine() {
    const n = Pricing.editCount();
    return `prices: bundled set of ${PRICES_VERIFIED_ON}${n ? `, ${n} user edit${n === 1 ? '' : 's'}` : ''}`;
  },
  /** The export text: a '#' provenance line (price set + the list-price caveat), the column header, one line per row in the window (date asc). */
  csvExportText(win) {
    const rows = this.rowsIn(win).slice().sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
    const lines = [`# ROSTUM export · ${this.priceSetLine()} · costs are API-equivalent at the currently loaded list prices; historical price changes are not applied`,
      'date,platform,model,input_tokens,cache_write_tokens,cache_read_tokens,output_tokens,messages,estimated,cost_usd_api_equiv'];
    for (const r of rows) {
      lines.push([r.d, csvCell(r.platform), csvCell(r.model), r.in || 0, r.cw || 0, r.cr || 0, r.out || 0, r.msgs || 0, r.est ? 1 : 0, Pricing.cost(r.model, r).toFixed(4)].join(','));
    }
    return lines.join('\n');
  },
  exportCSV() {
    const win = this.window();
    const blob = new Blob([this.csvExportText(win)], { type: 'text/csv' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `ai-usage-${win.from}-to-${win.to}.csv` });
    document.body.appendChild(a); a.click(); a.remove();
  },

  /* =================== pricing UI (Plan 9 A2) =================== */
  /** The list grouped by vendor (<details>, open only where the user's data lands or an override beats a row; rows of a closed group are built on
   *  first open), the read-only Platform overrides group last, the verified banner above. Re-run by the editor (add / delete / reset) and by
   *  refreshPricingOnDataChange() — never under an edit in progress. */
  renderPricing() {
    this.renderPriceBanner();
    const matches = this.priceMatches(Store.allRows());
    const host = clear($('pricing-groups'));
    for (const g of this.priceGroups(matches)) host.appendChild(this.renderPriceGroup(g, matches));
    host.appendChild(this.renderPriceGroup(this.overrideGroup(matches), matches));
    this._priceDataSig = this._priceDataSignature();
  },
  /** "Prices verified <date> — N days ago." (amber past 90 days) + the list-price sentence; the clock is Date.now() (the harness shims it). */
  renderPriceBanner() {
    const days = Math.max(0, Math.floor((Date.now() - Date.parse(PRICES_VERIFIED_ON + 'T00:00:00Z')) / 86400000));
    const b = $('prices-verified');
    b.textContent = `Prices verified ${PRICES_VERIFIED_ON} — ${days} day${days === 1 ? '' : 's'} ago. Costs are API-equivalent at the currently loaded list prices; historical price changes are not applied.`;
    b.classList.toggle('stale', days > 90);
  },
  _priceDataSignature() { const keys = new Set(); for (const r of Store.allRows()) keys.add(r.platform + '|' + r.model); return [...keys].sort().join('\n'); },
  /** the matched marks and counts follow the stored data — re-render only when the set of platform|model pairs changed */
  refreshPricingOnDataChange() { if (this._priceDataSignature() !== this._priceDataSig) this.renderPricing(); },
  /** Where the user's own data lands: for every distinct platform|model pair in the stored (non-local) rows, the row it resolves to gains the
   *  model id — rowModels by pattern, overrideModels by platform|pattern. When a PRICE_OVERRIDES row wins, the vendor row the id would otherwise
   *  hit records the winning rate in overriddenBy (pattern → Map platform|pattern → the override): "wins for <platform>" — an edit of that vendor
   *  row changes nothing for data from that platform. */
  priceMatches(rows) {
    const seen = new Set(), rowModels = new Map(), overrideModels = new Map(), overriddenBy = new Map();
    const push = (map, key, model) => { const list = map.get(key) || []; if (!list.includes(model)) list.push(model); map.set(key, list); };
    for (const r of rows) {
      if (r.local || LOCAL_PLATFORMS.has(r.platform)) continue;
      const key = r.platform + '|' + r.model; if (seen.has(key)) continue; seen.add(key);
      const hit = Pricing.resolve(r.model, r.platform), model = String(r.model || '');
      if (!hit.overrideFor) { push(rowModels, hit.pat, model); continue; }
      push(overrideModels, hit.overrideFor + '|' + hit.pat, model);
      const base = Pricing.resolve(r.model);
      if (base.fallback) continue;
      const winners = overriddenBy.get(base.pat) || new Map();
      winners.set(hit.overrideFor + '|' + hit.pat, hit); overriddenBy.set(base.pat, winners);
    }
    return { rowModels, overrideModels, overriddenBy };
  },
  /** Pricing.rows → vendor groups in list order (first appearance; the spec's two spellings of a vendor fold into one), each with its rows
   *  matched-first (stable) and the counts for the summary; rows without a vendor (the editor's own) form "Your rows", always open. */
  priceGroups(matches) {
    const groups = new Map();
    for (const r of Pricing.rows) {
      const name = this._vendorGroupName(r.v);
      let g = groups.get(name);
      if (!g) { g = { name, kind: 'editable', rows: [], matched: 0, overridden: 0, alwaysOpen: !r.v }; groups.set(name, g); }
      g.rows.push(r);
      if (matches.rowModels.has(r.pat)) g.matched++;
      if (matches.overriddenBy.has(r.pat)) g.overridden++;
    }
    for (const g of groups.values()) g.rows.sort((a, b) => Number(matches.rowModels.has(b.pat)) - Number(matches.rowModels.has(a.pat)));
    return [...groups.values()];
  },
  _vendorGroupName(v) { return v ? (PRICE_VENDOR_NAMES[String(v).toLowerCase()] || v) : 'Your rows'; },
  overrideGroup(matches) {
    const hit = (o) => matches.overrideModels.has(o.platform + '|' + o.pat);
    const rows = PRICE_OVERRIDES.slice().sort((a, b) => Number(hit(b)) - Number(hit(a)));
    return { name: 'Platform overrides', kind: 'overrides', rows, matched: rows.filter(hit).length, overridden: 0, alwaysOpen: false };
  },
  renderPriceGroup(g, matches) {
    const open = g.alwaysOpen || g.matched > 0 || g.overridden > 0;
    const d = el('details', { class: 'price-group', 'data-group': g.name, open: open ? '' : null }, el('summary', { text: this._priceGroupSummary(g) }));
    const tbody = el('tbody'), renderRow = g.kind === 'overrides' ? this.renderOverrideRow : this.renderPriceRow;
    d.appendChild(el('table', { class: 'data price-table ' + g.kind }, this._priceTableHead(g.kind), tbody));
    const fill = () => { for (const r of g.rows) tbody.appendChild(renderRow.call(this, r, matches)); };
    if (open) fill(); else d.addEventListener('toggle', fill, { once: true });
    return d;
  },
  _priceGroupSummary(g) {
    const n = g.rows.length;
    return `${g.name} · ${n} row${n === 1 ? '' : 's'} · ${g.matched} matched your data${g.overridden ? ` · ${g.overridden} overridden by a platform rate` : ''}`;
  },
  _priceTableHead(kind) { return el('thead', {}, el('tr', {}, ...PRICE_TABLE_COLUMNS[kind].map(c => el('th', { text: c })))); },
  /** an editable row: pattern (+ the model ids that landed on it), label, the four prices, provenance, delete */
  renderPriceRow(r, matches) {
    const models = matches.rowModels.get(r.pat) || [], winners = matches.overriddenBy.get(r.pat);
    const prov = el('td', { class: 'prov' });
    const refresh = () => this._fillProvenance(prov, r, winners);
    refresh();
    return el('tr', { class: models.length ? 'matched' : null },
      el('td', {}, this._priceInput(r, 'pat', 'pat', refresh), this._matchedModels(models)),
      el('td', {}, this._priceInput(r, 'label', 'label-i', refresh)),
      ...['in', 'out', 'cw', 'cr'].map(k => el('td', {}, this._priceInput(r, k, 'price', refresh))),
      prov,
      el('td', {}, this._deleteRowButton(r)));
  },
  /** a PRICE_OVERRIDES row (constant — no inputs): platform, pattern (+ the ids that landed), label, prices, provenance */
  renderOverrideRow(o, matches) {
    const models = matches.overrideModels.get(o.platform + '|' + o.pat) || [];
    const prov = el('td', { class: 'prov' });
    this._fillProvenance(prov, o, null);
    return el('tr', { class: models.length ? 'matched' : null },
      el('td', { class: 'platform', text: o.platform }),
      el('td', {}, el('code', { class: 'pat', text: o.pat }), this._matchedModels(models)),
      el('td', { class: 'label', text: o.label }),
      ...['in', 'out', 'cw', 'cr'].map(k => el('td', { class: 'num', text: String(o[k]) })),
      prov);
  },
  /** an edit saves at once (save() re-stamps the row's provenance: it now reads "user"), refreshes that row's provenance cell in place and
   *  re-renders the dashboard — never the list itself, so the next input keeps focus */
  _priceInput(r, key, cls, refreshProvenance) {
    const inp = el('input', { class: cls, value: String(r[key]), 'aria-label': key });
    inp.addEventListener('change', () => {
      r[key] = cls === 'price' ? (parseFloat(inp.value) || 0) : inp.value;
      Pricing.save(); refreshProvenance(); this.render();
    });
    return inp;
  },
  _matchedModels(models) {
    if (!models.length) return null;
    return el('div', { class: 'matched-models', text: 'in your data: ' + models.join(', '), title: 'Model ids in your stored rows that this row prices' });
  },
  _deleteRowButton(r) {
    const del = el('button', { class: 'btn small del', text: '✕', title: 'Remove row' });
    del.addEventListener('click', () => { const i = Pricing.rows.indexOf(r); if (i >= 0) Pricing.rows.splice(i, 1); Pricing.save(); this.renderPricing(); this.render(); });
    return del;
  },
  /** "verified <date>" / "unverified since Aug 2026" / "your edit" · the confidence pill · the source host (link) · the platform rates that beat this row */
  _fillProvenance(td, r, winners) {
    clear(td);
    const c = priceConfidence(r);
    td.appendChild(el('span', { class: 'verified', text: c === 'user' ? 'your edit' : r.at ? 'verified ' + r.at : PRICE_UNVERIFIED_TEXT }));
    td.appendChild(el('span', { class: 'pill c-' + c, text: c, title: PRICE_CONFIDENCE_TITLE[c] }));
    if (r.src && c !== 'user') td.appendChild(this._sourceLink(r.src));
    for (const w of (winners ? winners.values() : [])) {
      td.appendChild(el('div', { class: 'wins-for', text: `wins for ${w.platform}: $${w.in} in / $${w.out} out`,
        title: `${w.label} — ${w.platform} bills this model at its own rate, so your ${w.platform} data is priced by that override; editing this row does not change it.` }));
    }
  },
  _sourceLink(src) {
    return el('a', { class: 'src', href: src, target: '_blank', rel: 'noopener', text: URL.canParse(src) ? new URL(src).hostname : src, title: src });
  },

  /* =================== wiring =================== */
  /** A key card with static markup (Anthropic, OpenAI, Gemini, Copilot, OpenRouter): its '<id>-validate' button runs the generic key driver, a remembered
   *  key is restored into '<id>-key' (the .value property — never the attribute) with Remember ticked, and Remember follows the generated cards' rule
   *  (ensureSourceCard): untick → forget the key; tick with a key in the box → keep it. */
  _wireStaticKeyCard(c) {
    $(c.id + '-validate').addEventListener('click', () => this.connectKey(c));
    const keyEl = $(c.id + '-key'), rem = $('remember-' + c.id), saved = LS.get(c.keyLS, null);
    if (saved) { keyEl.value = saved; rem.checked = true; }
    rem.addEventListener('change', () => { if (!rem.checked) LS.del(c.keyLS); else if (keyEl.value.trim()) LS.set(c.keyLS, keyEl.value.trim()); });
  },
  updatePSCommands() {
    $('anthropic-cmd').textContent = anthropicPSCommand(null, parseInt($('anthropic-days').value, 10));
    $('openai-cmd').textContent = openaiPSCommand(null, parseInt($('openai-days').value, 10));
  },

  async refreshAll() {
    const jobs = [];
    // v7 (review m2): a handle the collector feeds is left to the collector tick below — re-scanning it here would run a second read of the same tool beside the tick
    if (this.dirHandle && !this._viaCollector('local')) jobs.push(this.rescan());
    for (const [id, h] of Object.entries(this._dirHandles)) if (h && !this._viaCollector(id)) jobs.push(this.rescanFolder(id));
    for (const c of CONNECTORS) if (c.kind === 'local-server' && Store.connectors[c.id]) jobs.push(this.connectServer(c));
    // v7: a connected collector gets ONE status tick (changed tools only — never a full reconnect; Sync on its card is the full one) while a token is at hand —
    // the input, else the remembered token (restored into the input); never from nothing
    for (const c of CONNECTORS) {
      if (c.kind !== 'collector' || !Store.connectors[c.id]) continue;
      const inp = $(c.id + '-key'), tok = (inp && inp.value.trim()) || LS.get(c.keyLS, null);
      if (!tok) continue;
      if (inp && !inp.value.trim()) inp.value = tok;
      jobs.push(this._collectorTick(c));
    }
    // key-driver cards: a remembered key (input pre-filled from LS at init) re-fetches; sessionOnly cards only while the input still holds a token
    for (const c of CONNECTORS) {
      if (!c.fetch) continue;
      const inp = $(c.id + '-key');
      if (inp && inp.value.trim() && (c.sessionOnly || LS.get(c.keyLS, null))) jobs.push(this.connectKey(c));
    }
    await Promise.allSettled(jobs);
    this.render();
  },

  _timer: null,
  setupAutoRefresh() {
    const box = $('auto-refresh'), mins = $('auto-refresh-mins');
    const minutesOr15 = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 1 ? n : 15; };   // never setInterval(NaN) (A0 #23)
    box.checked = LS.get('autoRefresh', false) === true;
    mins.value = String(minutesOr15(LS.get('autoRefreshMins', 15)));
    const apply = () => {
      const every = minutesOr15(mins.value);
      mins.value = String(every);
      LS.set('autoRefresh', box.checked);
      LS.set('autoRefreshMins', every);
      if (this._timer) clearInterval(this._timer);
      if (box.checked) this._timer = setInterval(() => this.refreshAll(), every * 60000);
    };
    box.addEventListener('change', apply);
    mins.addEventListener('change', apply);
    apply();
  },

  init() {
    View.load(); Pricing.load(); ColorMap.load(); Store.load(); Budgets.load();
    initTheme(); Tooltip.init();
    $('help-prices-date').textContent = PRICES_VERIFIED_ON;
    this.renderPricing();
    this.wireCollapsibles();
    this.wireInsightHides();
    this.wireLegacyToggle();
    for (const c of CONNECTORS) if (c.kind === 'folder-log' || c.kind === 'local-server' || c.kind === 'link-only' || c.kind === 'export-file' || c.kind === 'collector' || c.fetch) this.ensureSourceCard(c);
    this._prefillCollectorToken();   // v7: ?token= from the collector's ready-made URL → the token input, then off the address bar (no auto-connect)
    this._hubQuery = $('hub-search').value || '';   // the browser may restore the box's text across a reload — start in sync with it, not empty
    $('hub-search').addEventListener('input', () => { this._hubQuery = $('hub-search').value; this.renderHub(); });

    // range presets
    $('range-presets').querySelectorAll('button').forEach(b => {
      b.setAttribute('aria-pressed', b.dataset.range === this.filters.range ? 'true' : 'false');
      b.addEventListener('click', () => {
        this.filters.range = b.dataset.range;
        LS.set('range', b.dataset.range);
        $('range-presets').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
        $('custom-range').classList.toggle('show', b.dataset.range === 'custom');
        this.render();
      });
    });
    $('custom-range').classList.toggle('show', this.filters.range === 'custom');
    if (this.filters.from) $('date-from').value = this.filters.from;
    if (this.filters.to) $('date-to').value = this.filters.to;
    const onDate = () => {
      this.filters.from = $('date-from').value || null;
      this.filters.to = $('date-to').value || null;
      LS.set('from', this.filters.from); LS.set('to', this.filters.to);
      this.render();
    };
    $('date-from').addEventListener('change', onDate);
    $('date-to').addEventListener('change', onDate);

    // metric + group toggles
    const segWire = (id, key, lsKey) => {
      $(id).querySelectorAll('button').forEach(b => {
        b.setAttribute('aria-pressed', b.dataset[key] === this.filters[key] ? 'true' : 'false');
        b.addEventListener('click', () => {
          this.filters[key] = b.dataset[key];
          LS.set(lsKey, this.filters[key]);
          $(id).querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
          this.render();
        });
      });
    };
    segWire('metric-toggle', 'metric', 'metric');
    segWire('group-toggle', 'group', 'group');

    // chart/table view toggles
    for (const card of ['daily', 'models', 'share']) {
      const head = $('card-' + card).querySelector('.toggle');
      head.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => {
          head.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
          const showChart = b.dataset.view === 'chart';
          $(card + '-chart').hidden = !showChart;
          $(card + '-table').hidden = showChart;
          const lg = $(card + '-legend'); if (lg) lg.style.display = showChart ? '' : 'none';
        });
      });
    }

    // local folder
    $('pick-claude-folder').addEventListener('click', () => this.pickFolder());
    $('rescan-local').addEventListener('click', () => this.rescan());
    $('fallback-link').addEventListener('click', (e) => { e.preventDefault(); $('folder-fallback').click(); });
    $('folder-fallback').addEventListener('change', (e) => this.scanLocalFiles([...e.target.files].map(f => ({ path: f.webkitRelativePath || f.name, file: f }))));   // one landing path with the collector (v7): App.scanLocalFiles

    // key cards with static markup (Anthropic, OpenAI, Gemini, Copilot, OpenRouter) — the generated cards wired their controls in ensureSourceCard above
    for (const c of CONNECTORS) if (c.fetch && !$('src-' + c.id).classList.contains('generic')) this._wireStaticKeyCard(c);
    for (const id of ['anthropic-days', 'openai-days']) $(id).addEventListener('input', () => this.updatePSCommands());
    this.updatePSCommands();

    // imports
    const dz = $('dropzone');
    dz.addEventListener('click', () => $('import-files').click());
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('import-files').click(); } });
    $('import-files').addEventListener('change', (e) => { if (e.target.files.length) this.handleImportFiles([...e.target.files]); e.target.value = ''; });
    for (const ev of ['dragover', 'dragenter']) dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); });
    for (const ev of ['dragleave', 'drop']) dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); });
    dz.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) this.handleImportFiles([...e.dataTransfer.files]); });

    $('connector-modal').querySelector('.modal-close').addEventListener('click', () => this.closeConnectorModal());
    $('connector-modal').addEventListener('close', () => { this._restoreModalCard(); this._focusModalOpener(); });

    $('clear-data').addEventListener('click', () => {
      if (confirm('Clear all stored usage data from this browser? (Price edits and keys are kept.)')) {
        Store.clearAll(); IDB.del('claudeDir'); this.dirHandle = null;
        for (const k of Object.keys(this._gen)) this._gen[k]++;   // every in-flight scan / fetch bails instead of re-committing the data just cleared
        for (const id of Object.keys(this._pollTimers)) this.stopPoll(id);   // a running /metrics poll would otherwise re-create the source it just cleared (baselines in LS 'poll:*' are kept: they are counters, not usage)
        for (const id of Object.keys(this._dirHandles)) IDB.del('dir:' + id); this._dirHandles = {}; document.querySelectorAll('.src.generic .rescan').forEach(b => { b.hidden = true; });
        this._collectorSnap = {}; this._collectorSummary = []; this._collectorExcluded = new Set(); this._renderCollectorTools($('collector-tools'), []);   // v7 T3: the watch stopped with the polls above and its entry went with clearAll — snapshot, exclusions and tools table go too (Validate & connect starts over)
        $('rescan-local').hidden = true;
        for (const c of CONNECTORS) { this._setInitialStatus(c); this._setInitialStatus(c, true); }   // every status line back to its initial text — never blank: link-only keeps "No data path", key / folder cards "Not connected.", the Claude Code card its tip with the <code> path, dual-driver folder lines their noun (the gen bump above released any in-flight placeholder)
        this.render();
      }
    });

    // top actions
    $('export-csv').addEventListener('click', () => this.exportCSV());
    $('print-report').addEventListener('click', () => this.printReport(false));
    // Plan 8: Help — button, Close, a click on the backdrop (the event target is the dialog itself only outside its content), the native 'close' event
    // (Close / Esc / backdrop alike) → focus back on the button, the Copy button, and the `?` shortcut on the document
    $('help-btn').addEventListener('click', () => this.openHelp());
    $('help-modal').querySelector('.modal-close').addEventListener('click', () => this.closeHelp());
    $('help-modal').addEventListener('click', (e) => { if (e.target !== e.currentTarget) return; const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) this.closeHelp(); });   // only a click on the backdrop closes — the dialog's own padding does not
    $('help-modal').addEventListener('close', () => this._focusAfterRender(() => $('help-btn')));
    $('help-copy').addEventListener('click', () => this._copyHelpCommand());
    document.addEventListener('keydown', (e) => this._helpKey(e));
    // Ctrl+P / File > Print bypasses the button entirely — only 'beforeprint' fires for
    // every print path, so the report header must be filled from there too.
    window.addEventListener('beforeprint', () => App.printReport(true));
    $('refresh-all').addEventListener('click', () => this.refreshAll());
    $('add-price').addEventListener('click', () => {
      Pricing.rows.splice(Math.max(0, Pricing.rows.length - 1), 0, { pat: 'my-model', label: 'New model', in: 0, out: 0, cw: 0, cr: 0 });
      Pricing.save(); this.renderPricing(); this.render();
    });
    $('reset-prices').addEventListener('click', () => { if (confirm('Reset all prices to the built-in list (verified ' + PRICES_VERIFIED_ON + ')?')) { Pricing.reset(); this.renderPricing(); this.render(); } });

    this.setupAutoRefresh();

    let rt = null;
    addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => this.render(), 150); });

    this.render();
    this.restoreHandle();
    this.restoreFolderHandles();
    this._restoreCollectorWatch();   // v7 T3: a restored collector entry + a remembered token → the status watch resumes by itself; without a token the card says Reconnect
  }
};

