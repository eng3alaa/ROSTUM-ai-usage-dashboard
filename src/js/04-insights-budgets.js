/* =================================================================
 * INSIGHTS — pure analytics helpers. All take (rows, costOf, todayKey)
 * so callers (and tests) control cost attribution and "today".
 * ================================================================= */
const Insights = {
  projection(rows, costOf, today) {
    const ym = today.slice(0, 7);
    const y = +today.slice(0, 4), m = +today.slice(5, 7), dd = +today.slice(8, 10);
    const dim = new Date(y, m, 0).getDate();
    let mtd = 0;
    const byDay = new Map();
    for (const r of rows) { const c = costOf(r); byDay.set(r.d, (byDay.get(r.d) || 0) + c); if (r.d.startsWith(ym)) mtd += c; }
    let last7 = 0, n = 0;
    for (let i = 1; i <= 7; i++) { const k = addDays(today, -i); last7 += byDay.get(k) || 0; n++; }
    const avg = n ? last7 / n : 0;
    const daysLeft = dim - dd;
    return { mtd, avgDaily: avg, daysLeft, projected: mtd + avg * daysLeft, dim, dd };
  },
  isoWeekStart(key) { const dt = new Date(key + 'T12:00:00'); return addDays(key, -((dt.getDay() + 6) % 7)); },
  // Week-to-date vs the SAME elapsed days last week — comparing a partial "this week" to a
  // FULL "last week" (thisStart..thisStart+6) makes early-week deltas look catastrophic.
  weekOverWeek(rows, costOf, today) {
    const thisStart = this.isoWeekStart(today), lastStart = addDays(thisStart, -7);
    const dow = Math.round((new Date(today + 'T12:00:00') - new Date(thisStart + 'T12:00:00')) / 86400000);   // days elapsed this week (0..6)
    const thisEnd = today, lastEnd = addDays(lastStart, dow);
    let a = 0, b = 0, aMsgs = 0, bMsgs = 0, aTok = 0, bTok = 0;
    const tok = (r) => (r.in || 0) + (r.cw || 0) + (r.cr || 0) + (r.out || 0);
    for (const r of rows) {
      if (r.d >= thisStart && r.d <= thisEnd) { a += costOf(r); aMsgs += r.msgs || 0; aTok += tok(r); }
      else if (r.d >= lastStart && r.d <= lastEnd) { b += costOf(r); bMsgs += r.msgs || 0; bTok += tok(r); }
    }
    const pct = b > 0 ? Math.round(((a - b) / b) * 100) : (a > 0 ? 100 : 0);
    return { thisWeek: a, lastWeek: b, pct, thisMsgs: aMsgs, lastMsgs: bMsgs, thisTok: aTok, lastTok: bTok, thisStart, lastStart, daysElapsed: dow + 1 };
  },
  topMovers(curr, prev, n = 5) {
    const m = new Map();
    for (const p of curr) m.set(p.project, { project: p.project, curr: p.cost, prev: 0 });
    for (const p of prev) { const e = m.get(p.project) || { project: p.project, curr: 0, prev: 0 }; e.prev = p.cost; m.set(p.project, e); }
    return [...m.values()].map(e => ({ ...e, delta: e.curr - e.prev }))
      .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, n);
  },
  efficiency(rows, costOf, minMsgs = 20) {
    const by = new Map();
    for (const r of rows) {
      let e = by.get(r.model); if (!e) { e = { model: r.model, cost: 0, tok: 0, msgs: 0 }; by.set(r.model, e); }
      e.cost += costOf(r); e.tok += (r.in || 0) + (r.cw || 0) + (r.cr || 0) + (r.out || 0); e.msgs += r.msgs || 0;
    }
    return [...by.values()].filter(e => e.msgs >= minMsgs)
      .map(e => ({ model: e.model, msgs: e.msgs, costPerMsg: e.cost / e.msgs, tokPerMsg: Math.round(e.tok / e.msgs) }))
      .sort((a, b) => b.msgs - a.msgs);
  },
  cacheSavings(rows) {
    let saved = 0, tokens = 0;
    for (const r of rows) {
      const cr = r.cr || 0; if (!cr) continue;
      const p = Pricing.resolve(r.model, r.platform);
      saved += cr * (p.in - p.cr) / 1e6; tokens += cr;
    }
    return { saved, tokens };
  },
  busiestHours(rows) {
    const bins = new Array(24).fill(0); let total = 0;
    for (const r of rows) { if (r.hour == null) continue; bins[r.hour] += r.msgs || 0; total += r.msgs || 0; }
    let peak = -1, best = -1; bins.forEach((v, i) => { if (v > best) { best = v; peak = i; } });
    return { bins, total, peak: total ? peak : -1 };
  },
  heatmap(rows, valueOf, today, weeks = 13) {
    const end = today; const start = addDays(this.isoWeekStart(today), -7 * (weeks - 1));
    const by = new Map();
    for (const r of rows) if (r.d >= start && r.d <= end) by.set(r.d, (by.get(r.d) || 0) + valueOf(r));
    const days = dayRange(start, end).map(d => ({ d, v: by.get(d) || 0 }));
    const max = Math.max(0, ...days.map(x => x.v));
    return { start, end, days, max };
  },
};

/* ---------- BUDGETS — monthly USD limits per platform or 'total' ---------- */
const Budgets = {
  limits: {},          // { total?: n, [platform]: n }
  load() {   // a budget is a finite positive number or nothing (A0 #23)
    const saved = LS.get('budgets', null);
    this.limits = {};
    for (const [k, v] of Object.entries(isRecord(saved) ? saved : {})) if (Number.isFinite(+v) && +v > 0) this.limits[k] = +v;
  },
  set(key, usd) { if (usd == null || !Number.isFinite(+usd) || !(+usd > 0)) delete this.limits[key]; else this.limits[key] = +usd; LS.set('budgets', this.limits); },
  monthKey(today) { return (today || todayKey()).slice(0, 7); },
  status(today) {
    const t = today || todayKey(); const ym = this.monthKey(t);
    const costOf = (r) => Pricing.cost(r.model, r);
    const rows = Store.allRows().filter(r => r.d.startsWith(ym));
    const byPlat = new Map(); let total = 0;
    for (const r of rows) { const c = costOf(r); total += c; byPlat.set(r.platform, (byPlat.get(r.platform) || 0) + c); }
    const proj = Insights.projection(Store.allRows(), costOf, t);
    const mk = (spent, limit, projected) => ({ spent, limit, pct: limit ? Math.floor(spent / limit * 100) : 0, projected });   // floor: pct >= 100 ⟺ spent >= limit
    const out = { total: this.limits.total ? mk(total, this.limits.total, proj.projected) : null, byPlatform: {} };
    for (const [k, lim] of Object.entries(this.limits)) {
      if (k === 'total') continue;
      const spent = byPlat.get(k) || 0;
      const share = total ? spent / total : 0;
      out.byPlatform[k] = mk(spent, lim, proj.projected * share);
    }
    return out;
  },
  alerts(today) {
    const st = this.status(today); const ym = this.monthKey(today);
    const dismissed = LS.get('dismissedAlerts', {});
    const list = [];
    const consider = (scope, s, label) => {
      if (!s) return;
      const kinds = [];
      const pct = s.limit ? Math.floor(s.spent / s.limit * 100) : 0;   // display pct: floor, so 99.6% never reads as 100%
      if (s.spent >= s.limit) kinds.push(['exceed', `${label}: ${fmtUSD(s.spent)} estimated — over the ${fmtUSD(s.limit)} monthly budget (${pct}%).`]);
      else if (s.pct >= 80) kinds.push(['approach', `${label}: ${pct}% of the ${fmtUSD(s.limit)} monthly budget used (${fmtUSD(s.spent)}).`]);
      if (s.projected > s.limit && s.spent < s.limit) kinds.push(['overrun', `${label}: on pace to exceed the ${fmtUSD(s.limit)} budget by about ${fmtUSD(s.projected - s.limit)} this month.`]);
      for (const [k, msg] of kinds) { const kind = `${k}:${scope}`; if (!dismissed[`${kind}:${ym}`]) list.push({ kind, msg, level: k === 'exceed' ? 'critical' : 'serious' }); }
    };
    consider('total', st.total, 'Total');
    for (const [p, s] of Object.entries(st.byPlatform)) consider(p, s, p);
    return list;
  },
  dismiss(kind, today) { this.dismissKey(`${kind}:${this.monthKey(today)}`); },
  dismissKey(key) { const d = LS.get('dismissedAlerts', {}); d[key] = Date.now(); LS.set('dismissedAlerts', d); },   // Plan 6: the unpriced notice keys on the SET of model names, not the month
};

