# v3 Rich Content — Insights, Reports, Budgets + Backlog (Plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the spec's four rich-content packs — insights & analytics, narrative summary + printable report, budgets & alerts, and the remaining visual/hygiene backlog (items 2–4, 10–18) — on top of the v2 accounts hub.

**Architecture:** Still ONE self-contained file (`AI Usage Dashboard.html`, ~150 KB, 75-check suite green). New pure-math helpers (`Insights.*`) are top-level functions so checks can call them directly; new UI is an **Insights row** between the KPIs and the daily chart, a **Narrative** card, a **Budgets** editor in the settings area, dismissible **alert banners** at the top, and a print stylesheet. Rows gain an optional `hour` field (local hour, from Claude-log timestamps only). Everything renders from the same filtered `rows` `_render()` already computes.

**Tech stack:** unchanged (vanilla HTML/JS/SVG; puppeteer-core rig).

**Context for the engineer:**
- Spec: `docs/superpowers/specs/2026-08-15-ai-accounts-rich-dashboard-design.md` — sections *Insights row*, *Narrative summary*, *Reports*, *Budgets & alerts*, *Visual identity*, and the *Plan 2 backlog* list (items 2, 3, 4, 10–18 are this plan's; the rest are DONE).
- All prior conventions apply: strict TDD (RED evidence first); explicit `git add <files>`; check bodies in `try/finally { page.close() }`; the harness clears `aiusage:*` by default (pass `seedData` or `keepStorage` to keep state); suite gate = **all pass, exit 0, twice** — counts are guidance only; hygiene guard pins raw control bytes (<0x09) — never let `\u0001`-style escapes land as raw bytes.
- `App.render()` is rAF-batched: in checks, either `await` two rAFs after `render()` or call the specific `render*` method synchronously (established pattern in `98-hub.mjs`).
- Anchors below are stable strings; line numbers drift.
- Palette tokens available: `--s1..--s8` (series), `--seq-150/--seq-250` (sequential), `--good-text`, `--serious`, `--critical`, `--wash`, `--other`, `--ink`, `--ink-2`, `--muted`, `--grid`, `--surface-1`, `--border`. Add new tokens ONLY in all three theme blocks (light `:root`, dark media, `[data-theme="dark"]`).

## File structure

```
AI Usage Dashboard.html            # all app changes
tests/fixtures/gen.mjs             # T1: hour-bearing session fixture
tests/checks/91-insights-math.mjs  # T2 pure math (projection, WoW, movers, efficiency, cache savings, hours)
tests/checks/92-insights-ui.mjs    # T3 insights row + heatmap DOM
tests/checks/93-narrative.mjs      # T4
tests/checks/94-budgets.mjs        # T5 budgets + alerts
tests/checks/89-print-export.mjs   # T6 print stylesheet + report
tests/checks/88-backlog.mjs        # T7–T9 backlog pins
```

(Prefixes chosen to sort before 95–99 without colliding; alphabetical order matters only for the shared browser — every stateful check resets or seeds its own state.)

---

### Task 0: Branch + baseline

- [ ] `git checkout main && git switch -c v3-rich-content` → `node tests/run.mjs` → 75/75, exit 0.

---

### Task 1: `hour` on local rows + hour-bearing fixture

**Files:** Modify `AI Usage Dashboard.html`, `tests/fixtures/gen.mjs`, `tests/checks/10-baseline.mjs` (one appended check)

- [ ] **Step 1 — fixture.** In `tests/fixtures/gen.mjs` `generate()`, add a second session file with three assistant lines at local-distinct hours (use explicit UTC timestamps; the check will compute expected local hours in-page):

```js
  const sess2 = [
    jl({ type: 'assistant', timestamp: '2026-08-12T06:15:00.000Z', cwd: 'D:\\proj2', requestId: 'h1', message: { id: 'h1', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 10 } } }),
    jl({ type: 'assistant', timestamp: '2026-08-12T06:45:00.000Z', cwd: 'D:\\proj2', requestId: 'h2', message: { id: 'h2', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 10 } } }),
    jl({ type: 'assistant', timestamp: '2026-08-12T20:05:00.000Z', cwd: 'D:\\proj2', requestId: 'h3', message: { id: 'h3', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 10 } } }),
  ].join('\n');
  fs.mkdirSync(path.join(OUT, 'claude-logs', 'projects', '-D--proj2'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'claude-logs', 'projects', '-D--proj2', 'sess-hours.jsonl'), sess2);
```

- [ ] **Step 2 — failing check** (append inside `10-baseline.mjs`'s try):

```js
    const hourText = fs.readFileSync(path.join(OUT, 'claude-logs', 'projects', '-D--proj2', 'sess-hours.jsonl'), 'utf8');
    const hours = await page.evaluate(async (text) => {
      const res = await parseClaudeLogs([{ path: 'projects/-D--proj2/sess-hours.jsonl', file: new File([text], 'sess-hours.jsonl') }], null);
      const h = new Map();
      for (const r of res.rows) h.set(r.hour, (h.get(r.hour) || 0) + r.msgs);
      const expA = new Date('2026-08-12T06:15:00.000Z').getHours(), expB = new Date('2026-08-12T20:05:00.000Z').getHours();
      return { got: [...h.entries()].sort(), expA, expB };
    }, hourText);
    ok('baseline: local rows carry hour buckets (2 msgs early, 1 late)',
      hours.got.length === 2 && hours.got.some(([hh, n]) => hh === hours.expA && n === 2) && hours.got.some(([hh, n]) => hh === hours.expB && n === 1),
      JSON.stringify(hours));
```

RED: rows have no `hour` → one bucket keyed `undefined`.

- [ ] **Step 3 — implement.** `makeAgg` gains an optional `hour` in the key and bundle. Replace the whole `makeAgg` (anchor `function makeAgg() {`; body has visible `\u0001` escapes — keep them visible):

```js
function makeAgg() {
  const map = new Map(); // day / platform / model [/ sid] [/ hour] -> bundle
  return {
    add(d, platform, model, t, sid, hour) {
      if (!d) return;
      const hk = (hour == null || Number.isNaN(hour)) ? '' : String(hour);
      const key = d + '\u0001' + platform + '\u0001' + model + '\u0001' + (sid || '') + '\u0001' + hk;
      let b = map.get(key);
      if (!b) {
        b = { d, platform, model, in: 0, cw: 0, cr: 0, out: 0, msgs: 0, est: t.est ? 1 : 0 };
        if (sid) b.sid = sid;
        if (hk !== '') b.hour = hour;
        map.set(key, b);
      }
      b.in += t.in || 0; b.cw += t.cw || 0; b.cr += t.cr || 0; b.out += t.out || 0; b.msgs += t.msgs || 0;
      if (t.est) b.est = 1;
    },
    rows() { return [...map.values()]; }
  };
}
```

In `parseClaudeLogs` (anchor `const d = dayKey(obj.timestamp || file.lastModified);`), replace that line + the `agg.add` line with:

```js
      const ts = obj.timestamp ? new Date(obj.timestamp) : null;
      const d = dayKey(ts || file.lastModified);
      const hour = ts && !isNaN(ts) ? ts.getHours() : undefined;
      agg.add(d, 'Claude Code/Desktop', model, t, sid, hour);
```

`Store.compactRows` merges by (d, platform, model) already and drops hour on aged rows — fine (hour histogram is a "recent activity" view; the check for T2 uses recent dates). `Store.allRows` sid dedupe unaffected. NOTE: the existing baseline check `exact totals + dedupe` sums across rows — more rows per day is fine.

- [ ] **Step 4:** suite ×2 → all green (the T4 scan-cache checks compare cached vs direct totals — hour split is identical on both paths). Commit: `git add "AI Usage Dashboard.html" tests/fixtures/gen.mjs tests/checks/10-baseline.mjs && git commit -m "feat: local rows carry hour-of-day for activity insights"`

---

### Task 2: Insights math (pure functions)

**Files:** Modify `AI Usage Dashboard.html`, Create `tests/checks/91-insights-math.mjs`

- [ ] **Step 1 — failing checks.** Create `tests/checks/91-insights-math.mjs`:

```js
import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser, { tz: 'Asia/Riyadh', clockAt: '2026-08-16T09:00:00Z' });  // local Aug 16, 12:00
  try {
    const r = await page.evaluate(() => {
      const mk = (d, cost, tok = 100, msgs = 1, model = 'claude-sonnet-5', platform = 'Anthropic API', extra = {}) =>
        ({ d, platform, model, in: tok, cw: 0, cr: 0, out: 0, msgs, _cost: cost, ...extra });
      // Insights functions take rows + a costOf(row) fn so tests control cost exactly.
      const costOf = (r) => r._cost;
      // Aug 1..15 at $2/day (MTD = 30 over 15 days), today Aug 16 partial $1
      const rows = [];
      for (let i = 1; i <= 15; i++) rows.push(mk('2026-08-' + String(i).padStart(2, '0'), 2));
      rows.push(mk('2026-08-16', 1));
      const proj = Insights.projection(rows, costOf, '2026-08-16');
      // last 7 FULL days = Aug 9..15 = $2/day → remaining days after today: 31-16 = 15 → 31 + 15*2 = 61
      const wow = Insights.weekOverWeek(rows, costOf, '2026-08-16');   // ISO week Aug 10-16 (incl. today's $1) vs Aug 3-9
      const movers = Insights.topMovers([
        { project: 'A', cost: 10 }, { project: 'B', cost: 1 }, { project: 'C', cost: 5 },
      ], [
        { project: 'A', cost: 4 }, { project: 'B', cost: 3 }, { project: 'D', cost: 2 },
      ], 3);
      const eff = Insights.efficiency([
        ...Array.from({ length: 25 }, () => mk('2026-08-10', 0.5, 200, 1, 'm-many')),
        mk('2026-08-10', 9, 5000, 1, 'm-few'),
      ], costOf, 20);
      const cache = Insights.cacheSavings([
        { model: 'claude-sonnet-5', cr: 1_000_000, in: 0, cw: 0, out: 0 },   // sonnet-5: in $2/M, cr $0.2/M → saved 1.8
      ]);
      const hours = Insights.busiestHours([
        { hour: 9, msgs: 3 }, { hour: 9, msgs: 2 }, { hour: 21, msgs: 1 }, { msgs: 5 },  // last one lacks hour → ignored
      ]);
      return { proj, wow, movers, eff, cache, hours };
    });
    ok('insights: month-end projection = MTD + avg(last 7 full days) × remaining days',
      Math.abs(r.proj.mtd - 31) < 1e-9 && Math.abs(r.proj.projected - 61) < 1e-9 && r.proj.daysLeft === 15, JSON.stringify(r.proj));
    ok('insights: week-over-week compares ISO weeks (this 13 incl. partial today vs last 14 → -7%)',
      Math.abs(r.wow.thisWeek - 13) < 1e-9 && Math.abs(r.wow.lastWeek - 14) < 1e-9 && r.wow.pct === -7 && r.wow.thisStart === '2026-08-10', JSON.stringify(r.wow));
    ok('insights: top movers sorted by absolute change; ties resolve deterministically',
      r.movers.length === 3 && r.movers[0].project === 'A' && r.movers[0].delta === 6 && r.movers[1].project === 'C' && r.movers[1].delta === 5 &&
      Math.abs(r.movers[2].delta) === 2, JSON.stringify(r.movers));
    ok('insights: efficiency filters models under the message floor',
      r.eff.length === 1 && r.eff[0].model === 'm-many' && Math.abs(r.eff[0].costPerMsg - 0.5) < 1e-9 && r.eff[0].tokPerMsg === 200,
      JSON.stringify(r.eff));
    ok('insights: cache savings = cache-read tokens × (input price − cache-read price)',
      Math.abs(r.cache.saved - 1.8) < 1e-9 && r.cache.tokens === 1_000_000, JSON.stringify(r.cache));
    ok('insights: busiest hours histogram ignores rows without hour',
      r.hours.bins.length === 24 && r.hours.bins[9] === 5 && r.hours.bins[21] === 1 && r.hours.total === 6 && r.hours.peak === 9,
      JSON.stringify(r.hours));
  } finally {
    await page.close();
  }
}
```

RED: `Insights is not defined` (thrown → one FAIL).

- [ ] **Step 2 — implement.** Insert a new top-level block AFTER the `Pricing` object (anchor: the closing `};` of `Pricing`, just before the `/* ==... STORE` comment):

```js
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
    for (const r of rows) {
      if (!r.d.startsWith(ym)) continue;
      const c = costOf(r); mtd += c; byDay.set(r.d, (byDay.get(r.d) || 0) + c);
    }
    let last7 = 0, n = 0;
    for (let i = 1; i <= 7; i++) { const k = addDays(today, -i); if (k.startsWith(ym) || true) { last7 += byDay.get(k) || 0; n++; } }
    const avg = n ? last7 / n : 0;
    const daysLeft = dim - dd;
    return { mtd, avgDaily: avg, daysLeft, projected: mtd + avg * daysLeft, dim, dd };
  },
  isoWeekStart(key) { const dt = new Date(key + 'T12:00:00'); return addDays(key, -((dt.getDay() + 6) % 7)); },
  weekOverWeek(rows, costOf, today) {
    const thisStart = this.isoWeekStart(today), lastStart = addDays(thisStart, -7);
    const thisEnd = addDays(thisStart, 6), lastEnd = addDays(thisStart, -1);
    let a = 0, b = 0, aMsgs = 0, bMsgs = 0, aTok = 0, bTok = 0;
    const tok = (r) => (r.in || 0) + (r.cw || 0) + (r.cr || 0) + (r.out || 0);
    for (const r of rows) {
      if (r.d >= thisStart && r.d <= thisEnd) { a += costOf(r); aMsgs += r.msgs || 0; aTok += tok(r); }
      else if (r.d >= lastStart && r.d <= lastEnd) { b += costOf(r); bMsgs += r.msgs || 0; bTok += tok(r); }
    }
    const pct = b > 0 ? Math.round(((a - b) / b) * 100) : (a > 0 ? 100 : 0);
    return { thisWeek: a, lastWeek: b, pct, thisMsgs: aMsgs, lastMsgs: bMsgs, thisTok: aTok, lastTok: bTok, thisStart, lastStart };
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
      const p = Pricing.resolve(r.model);
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
```

(Remove the `|| true` no-op — write it clean: `const k = addDays(today, -i); last7 += byDay.get(k) || 0; n++;` — the 7-day average intentionally spans month boundaries.)

- [ ] **Step 3:** suite ×2 → green. Commit: `git add "AI Usage Dashboard.html" tests/checks/91-insights-math.mjs && git commit -m "feat: Insights pure-math helpers (projection, WoW, movers, efficiency, cache savings, hours, heatmap)"`

---

### Task 3: Insights row UI + calendar heatmap

**Files:** Modify `AI Usage Dashboard.html`, Create `tests/checks/92-insights-ui.mjs`, Modify `tests/checks/91-insights-math.mjs`

- [ ] **Step 0 — projection month-start fix (from T2 review).** `Insights.projection` filters rows to the current month BEFORE building `byDay`, so the 7-day pace reads zero for the first week of every month. Fix: build `byDay` from ALL rows (no month filter) and compute `mtd` only from current-month rows. Failing check first — append inside 91-insights-math's try: today `2026-09-03`, rows $2/day Aug 25–31 and $5/day Sep 1–2 → `mtd 10`, `avgDaily` = (5+5+2+2+2+2+2)/7 = 20/7 ≈ 2.857, `projected` = 10 + 20/7 × 27. Name `'insights: projection pace spans month boundary'`. RED pre-fix (avgDaily 10/7 ≈ 1.43). Then in `projection`: replace the loop body with `for (const r of rows) { const c = costOf(r); byDay.set(r.d, (byDay.get(r.d) || 0) + c); if (r.d.startsWith(ym)) mtd += c; }`. GREEN.

- [ ] **Step 1 — failing checks.** Create `tests/checks/92-insights-ui.mjs`:

```js
import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser, { clockAt: '2026-08-16T09:00:00Z' });
  try {
    const ui = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const rows = [];
      for (let i = 1; i <= 15; i++) rows.push({ d: '2026-08-' + String(i).padStart(2, '0'), platform: 'Anthropic API', model: 'claude-sonnet-5', in: 1_000_000, cw: 0, cr: 500_000, out: 0, msgs: 30, hour: 10 });
      Store.setSource('anthropic', rows, {});
      App.filters.range = '30';
      App._render();
      const row = document.getElementById('insights');
      const q = (id) => document.getElementById(id);
      return {
        exists: !!row,
        cards: [...row.querySelectorAll('.insight')].map(c => c.dataset.insight),
        projText: q('ins-projection-value').textContent,
        heatCells: q('ins-heatmap').querySelectorAll('rect.hm').length,
        heatHasFill: [...q('ins-heatmap').querySelectorAll('rect.hm')].some(r => r.getAttribute('fill') && r.getAttribute('fill') !== 'none'),
        hoursBars: q('ins-hours').querySelectorAll('rect.hb').length,
        cacheText: q('ins-cache-value').textContent,
        wowText: q('ins-wow').textContent,
        effRows: q('ins-efficiency').querySelectorAll('tr').length,
      };
    });
    ok('insights-ui: row renders all seven cards', ui.exists &&
      ['projection','heatmap','efficiency','cache','hours','wow','movers'].every(k => ui.cards.includes(k)), JSON.stringify(ui.cards));
    ok('insights-ui: projection shows a dollar figure', /\$\d/.test(ui.projText), ui.projText);
    ok('insights-ui: heatmap draws 13 weeks × 7 days with filled cells', ui.heatCells === 91 && ui.heatHasFill, JSON.stringify([ui.heatCells, ui.heatHasFill]));
    ok('insights-ui: hours histogram draws 24 bars', ui.hoursBars === 24, ui.hoursBars);
    ok('insights-ui: cache savings shows a dollar figure', /\$\d/.test(ui.cacheText), ui.cacheText);
    ok('insights-ui: WoW chips render', /%/.test(ui.wowText), ui.wowText);
    ok('insights-ui: efficiency table has header + at least one model row', ui.effRows >= 2, ui.effRows);

    const empty = await page.evaluate(() => {
      Store.sources = {}; App._render();
      return { hoursNote: document.getElementById('ins-hours').textContent, cards: document.querySelectorAll('#insights .insight').length };
    });
    ok('insights-ui: empty data degrades to notes, not errors', empty.cards === 7 && /no timestamped|no data/i.test(empty.hoursNote), JSON.stringify(empty));
  } finally {
    await page.close();
  }
}
```

RED: `#insights` missing (thrown at `row.querySelectorAll`).

- [ ] **Step 2 — CSS** (append after the Accounts hub CSS block, anchor `#connector-modal .card.src`):

```css
/* ============ Insights row ============ */
#insights { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin: 0 0 16px; }
.insight { background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; min-height: 96px; }
.insight .label { color: var(--ink-2); font-size: 12px; }
.insight .value { font-size: 20px; font-weight: 650; margin-top: 2px; letter-spacing: -0.01em; }
.insight .note { color: var(--muted); font-size: 11.5px; margin-top: 4px; }
.insight.span2 { grid-column: span 2; }
.insight svg { display: block; width: 100%; height: auto; margin-top: 6px; }
.insight table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 4px; }
.insight th { text-align: left; color: var(--ink-2); font-weight: 600; padding: 2px 6px 2px 0; }
.insight td { padding: 2px 6px 2px 0; border-top: 1px solid var(--grid); }
.insight td.num, .insight th.num { text-align: right; font-variant-numeric: tabular-nums; }
.wow-chip { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; margin: 4px 6px 0 0; background: var(--wash); }
.wow-chip.up { color: var(--critical); } .wow-chip.down { color: var(--good-text); }
@media (max-width: 720px) { .insight.span2 { grid-column: span 1; } }
```

- [ ] **Step 3 — HTML** (insert directly AFTER the closing `</div>` of `<div class="kpis" id="kpis">…`, i.e., before `<!-- ================= Charts ================= -->`):

```html
  <!-- ================= Insights row ================= -->
  <div id="insights" aria-label="Insights">
    <div class="insight" data-insight="projection"><div class="label">Month-end projection <span class="badge" title="MTD + average of the last 7 full days × days left">projection</span></div><div class="value" id="ins-projection-value">—</div><div class="note" id="ins-projection-note"></div></div>
    <div class="insight span2" data-insight="heatmap"><div class="label">Activity — last 13 weeks</div><div id="ins-heatmap"></div></div>
    <div class="insight" data-insight="wow"><div class="label">This week vs last</div><div id="ins-wow"></div></div>
    <div class="insight" data-insight="cache"><div class="label">Cache savings</div><div class="value" id="ins-cache-value">—</div><div class="note" id="ins-cache-note"></div></div>
    <div class="insight" data-insight="hours"><div class="label">Busiest hours</div><div id="ins-hours"></div></div>
    <div class="insight span2" data-insight="efficiency"><div class="label">Model efficiency <span class="badge">≥20 msgs</span></div><div id="ins-efficiency"></div></div>
    <div class="insight" data-insight="movers"><div class="label">Top project movers <span class="badge" title="vs the previous equal-length period">Δ</span></div><div id="ins-movers"></div></div>
  </div>
```

- [ ] **Step 4 — renderers.** Add `this.renderInsights(win, rows);` in `_render()` right after `this.renderKPIs(win, rows, days);`. Add to `App` (anchor: before `/* ---------- accounts hub ---------- */`):

```js
  /* ---------- insights ---------- */
  renderInsights(win, rows) {
    const today = todayKey();
    const costOf = (r) => Pricing.cost(r.model, r);
    const allRows = Store.allRows().filter(r => !this.filters.hiddenPlatforms.has(r.platform));   // insights that need "this month"/"13 weeks" ignore the date filter, respect platform chips
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
    else { renderHourBars(hoursBox, hb); hoursBox.appendChild(el('div', { class: 'note', text: `peak ${hb.peak}:00 · ${fmtCompact(hb.total)} msgs with timestamps` })); }
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
    const currRows = rows, prevRows = Store.allRows().filter(r => r.d >= prevWin.from && r.d <= prevWin.to && !this.filters.hiddenPlatforms.has(r.platform));
    const mv = Insights.topMovers(grp(currRows), grp(prevRows), 5);
    const mvBox = clear($('ins-movers'));
    if (!mv.length) mvBox.appendChild(el('div', { class: 'note', text: 'No data in range yet.' }));
    else for (const m of mv) mvBox.appendChild(el('div', { class: 'note', text: `${m.project}: ${m.delta >= 0 ? '+' : '−'}${fmtUSD(Math.abs(m.delta))} (${fmtUSD(m.prev)} → ${fmtUSD(m.curr)})` }));
  },
```

Add two SVG helpers next to `renderSparkline` (anchor `function renderSparkline`):

```js
/* ---------- calendar heatmap (13 weeks × 7 days) ---------- */
function renderHeatmap(container, hm, metric) {
  clear(container);
  const cell = 12, gap = 2, W = 13 * (cell + gap) + 30, H = 7 * (cell + gap) + 18;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Activity heatmap, last 13 weeks' });
  const styles = getComputedStyle(document.documentElement);
  const c0 = styles.getPropertyValue('--grid').trim(), c1 = styles.getPropertyValue('--seq-150').trim(), c2 = styles.getPropertyValue('--seq-250').trim(), c3 = styles.getPropertyValue('--accent').trim();
  hm.days.forEach((x, i) => {
    const wk = Math.floor(i / 7), dow = i % 7;
    const t = hm.max ? x.v / hm.max : 0;
    const fill = x.v === 0 ? c0 : t < 0.34 ? c1 : t < 0.67 ? c2 : c3;
    const r = el('rect', { class: 'hm', x: 30 + wk * (cell + gap), y: dow * (cell + gap), width: cell, height: cell, rx: 2, fill });
    r.appendChild(el('title', { text: `${x.d}: ${fmtMetric(x.v, metric)}` }));
    svg.appendChild(r);
  });
  ['M', 'W', 'F'].forEach((lab, k) => svg.appendChild(el('text', { class: 'axis-t', x: 0, y: (k * 2) * (cell + gap) + cell - 2, text: lab })));
  container.appendChild(svg);
}
/* ---------- 24-bin hour histogram ---------- */
function renderHourBars(container, hb) {
  const W = 240, H = 44, bw = W / 24;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H + 12}`, role: 'img', 'aria-label': 'Messages by hour of day' });
  const max = Math.max(1, ...hb.bins);
  const styles = getComputedStyle(document.documentElement);
  const fill = styles.getPropertyValue('--s1').trim();
  hb.bins.forEach((v, h) => {
    const bh = (v / max) * H;
    const r = el('rect', { class: 'hb', x: h * bw + 1, y: H - bh, width: bw - 2, height: bh, fill, opacity: v ? 1 : 0.15 });
    r.appendChild(el('title', { text: `${h}:00 — ${v} msgs` }));
    svg.appendChild(r);
  });
  [0, 6, 12, 18].forEach(h => svg.appendChild(el('text', { class: 'axis-t', x: h * bw + 1, y: H + 10, text: String(h) })));
  container.appendChild(svg);
}
```

Confirm `el()` includes `'title'` and `'text'` in its SVG tag list (it does: `['svg','g','rect','path','line','text','circle','defs','clipPath','title']`).

- [ ] **Step 5:** suite ×2 → green. Commit: `git add "AI Usage Dashboard.html" tests/checks/92-insights-ui.mjs && git commit -m "feat: insights row - projection, heatmap, WoW, cache savings, busiest hours, efficiency, movers"`

---

### Task 4: Narrative summary card

**Files:** Modify `AI Usage Dashboard.html`, Create `tests/checks/93-narrative.mjs`

- [ ] **Step 1 — failing checks:**

```js
import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser, { clockAt: '2026-08-16T09:00:00Z' });
  try {
    const t = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const rows = [];
      for (let i = 1; i <= 15; i++) {
        rows.push({ d: '2026-08-' + String(i).padStart(2, '0'), platform: 'Anthropic API', model: 'claude-sonnet-5', in: 100000, cw: 0, cr: 0, out: 20000, msgs: 10 });
        rows.push({ d: '2026-08-' + String(i).padStart(2, '0'), platform: 'OpenRouter', model: 'deepseek/deepseek-v4', in: 5000, cw: 0, cr: 0, out: 1000, msgs: 2 });
      }
      Store.setSource('anthropic', rows.filter(r => r.platform === 'Anthropic API'), {});
      Store.setSource('openrouter', rows.filter(r => r.platform === 'OpenRouter'), {});
      App.filters.range = '30'; App._render();
      const txt = document.getElementById('narrative').textContent;
      Store.sources = {}; App._render();
      const emptyTxt = document.getElementById('narrative').textContent;
      return { txt, emptyTxt };
    });
    ok('narrative: mentions totals, top model, top platform, projection', /\$\d/.test(t.txt) && /claude-sonnet-5/.test(t.txt) && /Anthropic API/.test(t.txt) && /project/i.test(t.txt), t.txt.slice(0, 200));
    ok('narrative: empty range degrades to a single honest sentence', /not enough data/i.test(t.emptyTxt), t.emptyTxt);
  } finally {
    await page.close();
  }
}
```

RED: `#narrative` missing.

- [ ] **Step 1b — heatmap size cap (from T3 review):** add `#ins-heatmap svg { max-width: 300px; }` after the insights CSS so the heatmap doesn't balloon to ~30px cells on wide layouts. No check needed (visual; T10 screenshots confirm).

- [ ] **Step 2 — implement.** HTML: insert directly after the `#insights` div: `<div class="card" id="card-narrative"><div class="card-head"><div><h2>This period in AI</h2><div class="sub" id="narrative-range"></div></div></div><div id="narrative" class="narrative"></div></div>` and CSS `.narrative { font-size: 13.5px; line-height: 1.55; } .narrative p { margin: 0 0 6px; }` (append after the insights CSS). Add `this.renderNarrative(win, rows);` in `_render()` after `renderInsights`. Method (anchor: before `/* ---------- accounts hub ---------- */`):

```js
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
    const p = Insights.projection(Store.allRows().filter(r => !this.filters.hiddenPlatforms.has(r.platform)), costOf, todayKey());
    const w = Insights.weekOverWeek(Store.allRows(), costOf, todayKey());
    const S = [];
    S.push(`You used ${fmtCompact(tok)} tokens across ${fmtCompact(msgs)} messages, worth about ${fmtUSD(cost)} at API list prices.`);
    if (tm) S.push(`${tm[0]} was the biggest line item at ${fmtUSD(tm[1])} (${Math.round(tm[1] / cost * 100)}% of spend)${tp ? `, and ${tp[0]} was the top platform` : ''}.`);
    if (td) S.push(`Your busiest day was ${fmtDayShort(td[0])} at ${fmtUSD(td[1])}.`);
    if (w.lastWeek > 0 || w.thisWeek > 0) S.push(`This week is ${w.pct === 0 ? 'flat' : (w.pct > 0 ? 'up ' : 'down ') + Math.abs(w.pct) + '%'} versus last week.`);
    S.push(`At the current pace this month projects to ${fmtUSD(p.projected)} (${fmtUSD(p.mtd)} so far, ${p.daysLeft} days left).`);
    const b = Budgets ? Budgets.status() : null;
    if (b && b.total) S.push(b.total.pct >= 100 ? `You are over your ${fmtUSD(b.total.limit)} monthly budget.` : `You have used ${b.total.pct}% of your ${fmtUSD(b.total.limit)} monthly budget.`);
    for (const s of S) box.appendChild(el('p', { text: s }));
  },
```

`Budgets` does not exist until Task 5 — guard as shown with `typeof Budgets !== 'undefined' && Budgets.status ? Budgets.status() : null` (write it that way; the `Budgets ?` form would throw a ReferenceError).

- [ ] **Step 3:** suite ×2 → green. Commit: `git add "AI Usage Dashboard.html" tests/checks/93-narrative.mjs && git commit -m "feat: narrative summary card"`

---

### Task 5: Budgets & alerts

**Files:** Modify `AI Usage Dashboard.html`, Create `tests/checks/94-budgets.mjs`

- [ ] **Step 1 — failing checks:**

```js
import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser, { clockAt: '2026-08-16T09:00:00Z' });
  try {
    const b = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      // $2/day Aug 1-16 → MTD 32; pace 2/day; 15 days left → projected 62
      const rows = []; for (let i = 1; i <= 16; i++) rows.push({ d: '2026-08-' + String(i).padStart(2, '0'), platform: 'Anthropic API', model: 'claude-sonnet-5', in: 1_000_000, cw: 0, cr: 0, out: 0, msgs: 1 });
      Store.setSource('anthropic', rows, {});
      Budgets.set('total', 40);            // 32/40 = 80% → approaching, projected 62 → overrun
      Budgets.set('Anthropic API', 100);   // 32% fine
      App._render();
      const st = Budgets.status();
      const banners = [...document.querySelectorAll('#alerts .alert')].map(a => a.dataset.kind);
      return { totalPct: st.total.pct, platPct: st.byPlatform['Anthropic API'].pct, projOver: st.total.projected > st.total.limit, banners };
    });
    ok('budgets: status math (32/40 = 80%; platform 32%)', b.totalPct === 80 && b.platPct === 32 && b.projOver, JSON.stringify(b));
    ok('budgets: 80% approaching + projected-overrun banners shown', b.banners.includes('approach:total') && b.banners.includes('overrun:total'), JSON.stringify(b.banners));

    const d = await page.evaluate(async () => {
      document.querySelector('#alerts .alert[data-kind="approach:total"] .alert-dismiss').click();
      App._render();
      const after = [...document.querySelectorAll('#alerts .alert')].map(a => a.dataset.kind);
      const persisted = LS.get('dismissedAlerts', {});
      return { after, key: Object.keys(persisted)[0] };
    });
    ok('budgets: dismissal removes banner and persists per month', !d.after.includes('approach:total') && /^approach:total:2026-08$/.test(d.key), JSON.stringify(d));

    const card = await page.evaluate(() => {
      App.renderHub();
      const c = document.querySelector('#accounts-hub .acct[data-connector="anthropic"] .budget-bar');
      return { has: !!c, w: c && c.querySelector('.fill').style.width };
    });
    ok('budgets: hub card shows a progress bar when a platform budget exists', card.has && /32%/.test(card.w), JSON.stringify(card));

    const ex = await page.evaluate(() => {
      Budgets.set('total', 30);           // 32/30 → exceeded (107%)
      App._render();
      return [...document.querySelectorAll('#alerts .alert')].map(a => a.dataset.kind);
    });
    ok('budgets: exceeded banner replaces approaching', ex.includes('exceed:total') && !ex.includes('approach:total'), JSON.stringify(ex));
  } finally {
    await page.close();
  }
}
```

RED: `Budgets is not defined`.

- [ ] **Step 2 — implement.**
  1. **Store** — after `Insights` block add:
```js
/* ---------- BUDGETS — monthly USD limits per platform or 'total' ---------- */
const Budgets = {
  limits: {},          // { total?: n, [platform]: n }
  load() { this.limits = LS.get('budgets', null) || {}; },
  set(key, usd) { if (usd == null || !(usd > 0)) delete this.limits[key]; else this.limits[key] = +usd; LS.set('budgets', this.limits); },
  monthKey(today) { return (today || todayKey()).slice(0, 7); },
  status(today) {
    const t = today || todayKey(); const ym = this.monthKey(t);
    const costOf = (r) => Pricing.cost(r.model, r);
    const rows = Store.allRows().filter(r => r.d.startsWith(ym));
    const byPlat = new Map(); let total = 0;
    for (const r of rows) { const c = costOf(r); total += c; byPlat.set(r.platform, (byPlat.get(r.platform) || 0) + c); }
    const proj = Insights.projection(Store.allRows(), costOf, t);
    const mk = (spent, limit, projected) => ({ spent, limit, pct: limit ? Math.round(spent / limit * 100) : 0, projected });
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
      if (s.pct >= 100) kinds.push(['exceed', `${label}: ${fmtUSD(s.spent)} spent — over the ${fmtUSD(s.limit)} monthly budget (${s.pct}%).`]);
      else if (s.pct >= 80) kinds.push(['approach', `${label}: ${s.pct}% of the ${fmtUSD(s.limit)} monthly budget used (${fmtUSD(s.spent)}).`]);
      if (s.projected > s.limit && s.pct < 100) kinds.push(['overrun', `${label}: on pace to exceed the ${fmtUSD(s.limit)} budget by about ${fmtUSD(s.projected - s.limit)} this month.`]);
      for (const [k, msg] of kinds) { const kind = `${k}:${scope}`; if (!dismissed[`${kind}:${ym}`]) list.push({ kind, msg, level: k === 'exceed' ? 'critical' : 'serious' }); }
    };
    consider('total', st.total, 'Total');
    for (const [p, s] of Object.entries(st.byPlatform)) consider(p, s, p);
    return list;
  },
  dismiss(kind, today) { const d = LS.get('dismissedAlerts', {}); d[`${kind}:${this.monthKey(today)}`] = Date.now(); LS.set('dismissedAlerts', d); },
};
```
  2. **Init**: where `Pricing.load(); ColorMap.load(); Store.load();` runs (anchor exactly that), append `Budgets.load();`.
  3. **HTML**: alerts container right after `<div class="wrap">` opening: `<div id="alerts" aria-live="polite"></div>`. Budget editor: after the pricing table card (anchor `id="pricing-table"`'s enclosing card end — find the closing `</div>` of that card; simplest: insert a NEW card immediately BEFORE the pricing card): 
```html
    <div class="card" id="card-budgets">
      <div class="card-head"><div><h2>Budgets</h2><div class="sub">Monthly USD limits — alerts at 80%, 100%, and projected overrun. Stored locally.</div></div></div>
      <div id="budget-editor"></div>
    </div>
```
  4. **CSS** (append after narrative CSS):
```css
/* ============ Alerts & budgets ============ */
#alerts .alert { display: flex; align-items: center; gap: 10px; padding: 8px 12px; margin: 0 0 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-1); font-size: 13px; }
#alerts .alert.serious { border-left: 4px solid var(--serious); } #alerts .alert.critical { border-left: 4px solid var(--critical); }
#alerts .alert .alert-dismiss { margin-left: auto; }
.budget-row { display: grid; grid-template-columns: 1fr 120px 1fr; gap: 10px; align-items: center; padding: 6px 0; border-top: 1px solid var(--grid); }
.budget-row:first-child { border-top: 0; }
.budget-bar { height: 6px; background: var(--grid); border-radius: 3px; overflow: hidden; margin-top: 6px; }
.budget-bar .fill { height: 100%; background: var(--accent); }
.budget-bar.warn .fill { background: var(--serious); } .budget-bar.over .fill { background: var(--critical); }
```
  5. **App**: `renderAlerts()` + `renderBudgets()` called in `_render()` (alerts first, budgets after renderHub); hub cards get a bar. Add methods (anchor: before `/* ---------- insights ---------- */`):
```js
  /* ---------- budgets & alerts ---------- */
  renderAlerts() {
    const box = clear($('alerts'));
    for (const a of Budgets.alerts()) {
      const n = el('div', { class: 'alert ' + a.level, 'data-kind': a.kind, role: 'status' },
        el('span', { text: (a.level === 'critical' ? '⛔ ' : '⚠ ') + a.msg }),
        el('button', { class: 'btn small alert-dismiss', text: 'Dismiss', onclick: () => { Budgets.dismiss(a.kind); this.render(); } }));
      box.appendChild(n);
    }
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
      return el('div', { class: 'budget-row' }, el('div', { text: label }), inp, el('div', {}, bar, note));
    };
    box.appendChild(rowFor('total', 'Total (all platforms)'));
    for (const c of CONNECTORS) if (c.platform) box.appendChild(rowFor(c.platform, c.name));
  },
```
  In `renderHub`, after the `acct-stats` element in each card, append (when `c.platform && Budgets.limits[c.platform]`):
```js
          (c.platform && Budgets.limits[c.platform]) ? (() => { const s = Budgets.status().byPlatform[c.platform]; return el('div', { class: 'budget-bar' + (s.pct >= 100 ? ' over' : s.pct >= 80 ? ' warn' : ''), title: `${fmtUSD(s.spent)} of ${fmtUSD(s.limit)} this month` }, el('div', { class: 'fill', style: { width: Math.min(100, s.pct) + '%' } })); })() : null,
```
  (Compute `Budgets.status()` once before the loop instead of per card — assign to `const bst` and use `bst.byPlatform[c.platform]`.)

- [ ] **Step 3:** suite ×2 → green. Commit: `git add "AI Usage Dashboard.html" tests/checks/94-budgets.mjs && git commit -m "feat: budgets & alerts - monthly limits per platform/total, banners at 80/100/overrun, hub bars"`

---

### Task 6: Print report + report metadata

**Files:** Modify `AI Usage Dashboard.html`, Create `tests/checks/89-print-export.mjs`

- [ ] **Step 1 — failing checks:**

```js
import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const btn = await page.evaluate(() => !!document.getElementById('print-report'));
    ok('print: Print report button exists', btn, '');
    await page.emulateMediaType('print');
    const pr = await page.evaluate(() => {
      const vis = (id) => { const e = document.getElementById(id); return e ? getComputedStyle(e).display !== 'none' : null; };
      return { hub: vis('accounts-hub'), filter: getComputedStyle(document.querySelector('.filterbar')).display, sources: vis('sources'), kpis: vis('kpis'), insights: vis('insights'), narrative: vis('card-narrative'), header: !!document.getElementById('report-meta') && vis('report-meta') };
    });
    ok('print: hub, filter bar, sources hidden; KPIs/insights/narrative/report header shown',
      pr.hub === false && pr.filter === 'none' && pr.sources === false && pr.kpis === true && pr.insights === true && pr.narrative === true && pr.header === true, JSON.stringify(pr));
    await page.emulateMediaType('screen');
    const meta = await page.evaluate(() => { App.printReport(true); return document.getElementById('report-meta').textContent; });
    ok('print: report header carries range + generated date', /Generated/.test(meta) && /\d{4}/.test(meta), meta);
  } finally {
    await page.close();
  }
}
```

RED: no `#print-report`.

- [ ] **Step 2 — implement.** Topbar: after the Export CSV button add `<button class="btn small" id="print-report" title="Print / save as PDF">Print report</button>`. After `<div class="wrap">`'s alerts div add `<div id="report-meta" class="report-meta" hidden></div>`. CSS:
```css
.report-meta { font-size: 12px; color: var(--ink-2); margin: 0 0 12px; }
@media print {
  .topbar .top-actions, .filterbar, #accounts-hub, #sources, .sources, #card-budgets, #card-pricing, #alerts, #storage-warning, .toggle, .btn { display: none !important; }
  .report-meta { display: block !important; }
  body { background: #fff; color: #000; }
  .card, .tile, .insight { break-inside: avoid; border-color: #ccc; }
  .wrap { max-width: none; padding: 0; }
}
```
(Check the actual card ids for pricing/budgets — the pricing card may lack an id; give it `id="card-pricing"`.) App method + wiring:
```js
  printReport(dryRun) {
    const win = this.window();
    const m = $('report-meta');
    m.hidden = false;
    m.textContent = `AI usage report · ${fmtDayShort(win.from)} – ${fmtDayShort(win.to)} · Generated ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })} · API-equivalent costs are estimates at list prices`;
    if (!dryRun) { window.print(); }
  },
```
`$('print-report').addEventListener('click', () => this.printReport(false));` next to export-csv wiring. `#report-meta` stays hidden on screen except after a print request (keep it visible after printReport — harmless, informative).

- [ ] **Step 3:** suite ×2 → green. Commit: `git add "AI Usage Dashboard.html" tests/checks/89-print-export.mjs && git commit -m "feat: print report - dedicated stylesheet, report header with range and generation time"`

---

### Task 7: Backlog — chart (items 2, 3, 13) + drill-down persistence (10)

**Files:** Modify `AI Usage Dashboard.html`, Create `tests/checks/88-backlog.mjs`

- [ ] **Step 1 — failing checks** (create `88-backlog.mjs` with try/finally):

```js
    // item 2: first week bucket label clamps to range start
    const lbl = await page.evaluate(() => {
      const b = bucketDays(dayRange('2025-10-01', '2026-03-31'));
      return { first: b.buckets[0].key, firstDay: b.buckets[0].days[0], label: b.buckets[0].label };
    });
    ok('backlog-2: first week bucket carries a range-clamped label', lbl.firstDay === '2025-10-01' && lbl.label && lbl.label.includes('Oct 1'), JSON.stringify(lbl));
    // item 3: delegated pointer handler — one listener on the SVG, no per-band listeners
    const del = await page.evaluate(() => {
      Store.sources = {}; Store.setSource('csv', Array.from({ length: 30 }, (_, i) => ({ d: addDays('2026-07-01', i), platform: 'Gemini', model: 'g', in: 10, cw: 0, cr: 0, out: 5, msgs: 1 })), {});
      App.filters.range = 'custom'; App.filters.from = '2026-07-01'; App.filters.to = '2026-07-30'; App._render();
      const svg = document.querySelector('#daily-chart svg');
      const bands = svg.querySelectorAll('.colband');
      // per-band listeners were removed: bands are plain rects (no tabindex), the SVG has one hit layer
      return { bands: bands.length, svgHasHit: !!svg.querySelector('.hitlayer'), anyBandTab: [...bands].some(b => b.hasAttribute('tabindex')) };
    });
    ok('backlog-3: chart uses one delegated hit layer, not per-band listeners', del.svgHasHit && !del.anyBandTab && del.bands === 30, JSON.stringify(del));
    // item 13: 9th platform gets a distinct visible slot, not the "Other" gray
    const col = await page.evaluate(() => {
      ColorMap.maps = { platform: {}, model: {} };
      const cands = ['A','B','C','D','E','F','G','H','I'];
      const colors = cands.map(p => ColorMap.colorOf('platform', p, cands));
      return { unique: new Set(colors).size, otherHex: getComputedStyle(document.documentElement).getPropertyValue('--other').trim(), last: colors[8] };
    });
    ok('backlog-13: 9+ platforms still get distinct colors (palette widened)', col.unique === 9 && col.last !== col.otherHex, JSON.stringify(col));
    // item 10: drill-down does not leak into persisted chip state
    const leak = await page.evaluate(() => {
      LS.del('hiddenPlatforms'); App.filters.hiddenPlatforms = new Set();
      Store.sources = {}; Store.setSource('openrouter', [{ d: todayKey(), platform: 'OpenRouter', model: 'x', in: 5, cw: 0, cr: 0, out: 5, msgs: 1 }], {});
      Store.setSource('csv', [{ d: todayKey(), platform: 'Gemini', model: 'y', in: 7, cw: 0, cr: 0, out: 7, msgs: 1 }], {});
      App._render();
      App.drillDown(connectorById('openrouter'));
      const afterDrill = LS.get('hiddenPlatforms', null);
      // now click an unrelated chip (Gemini) — must persist ONLY the user's chip state, not the drill set
      const chip = [...document.querySelectorAll('#platform-chips .chip')].find(c => c.textContent.includes('Gemini'));
      chip && chip.click();
      const afterChip = LS.get('hiddenPlatforms', null);
      return { afterDrill, afterChip };
    });
    ok('backlog-10: drill-down is ephemeral; chip click persists only user chip state', leak.afterDrill === null && Array.isArray(leak.afterChip) && leak.afterChip.length === 1 && leak.afterChip[0] === 'Gemini', JSON.stringify(leak));
```

(Confirm the chip container id by grep — `#platform-chips` is an assumption; adapt the selector to the real id, keep the assertion.)

- [ ] **Step 2 — implement.**
  - **Item 2:** `bucketDays` buckets gain `label`: for `week` unit, `label = 'Week of ' + fmtDayShort(b.days[0])` (first day actually IN range, not the Monday key); month unit `label = <Month YYYY>`; day unit `label = fmtDayShort(d)`. `renderStackedColumns`' tooltip title and aria-label use `bucket.label` when present (thread the buckets through: after folding, keep `const labels = buckets.map(b => b.label)` and use `labels[i]`).
  - **Item 3:** in `renderStackedColumns`, replace the per-band `hit` rects with: bands become plain `rect.colband` (no listeners, no tabindex, `pointer-events: none`), plus ONE transparent `rect.hitlayer` covering the plot area with `tabindex=0`, `role="img"`, `aria-label` = chart summary; a single `pointermove` handler computes `i = Math.floor((e.clientX - svgLeft - padL) / band)` (clamped) → `showDay(i, …)`; `pointerleave` hides; keyboard: `keydown` ArrowLeft/ArrowRight moves a `focusIdx` and calls showDay; `focus` shows focusIdx (default last day), `blur` hides. Update `aria-label` per showDay for screen readers via `hit.setAttribute('aria-label', ...)`.
  - **Item 13:** widen the series palette to 12 slots: add `--s9..--s12` in ALL THREE theme blocks (light: `--s9: #7c5cff; --s10: #0aa2c0; --s11: #b3861a; --s12: #c2417a;` dark: `--s9: #9d85ff; --s10: #22b7d6; --s11: #d09a2c; --s12: #e0568f;`), `SLOT_VARS` gains the four names, and `ColorMap.slotFor`'s two hardcoded `8`s become `SLOT_VARS.length`. Verify contrast of the new hexes against both surfaces ≥ 3:1 (they are chosen to be); if the dataviz validator script exists in the repo skill, ignore — just eyeball in the T10 screenshots.
  - **Item 10:** `drillDown` keeps a separate `this._drill = platform|null` instead of mutating `filters.hiddenPlatforms`; `rowsIn()` additionally filters by `_drill` when set; chips render from `filters.hiddenPlatforms` only (unchanged) but show a "drilled: X — clear" pill when `_drill` is set; the chip click handler continues to persist `filters.hiddenPlatforms` (now uncontaminated). `drillDown(c)` toggles `_drill` (same platform → null; imports → null). Update the two existing 98-hub drill checks ONLY if they assert on `hiddenPlatforms` internals (they assert on `rowsIn` counts — keep them).

- [ ] **Step 3:** suite ×2 → green (existing 90-bucketing checks assert `.colband` count ≤160 — still true; adjust nothing unless a check asserts tabindex on bands). Commit: `git add "AI Usage Dashboard.html" tests/checks/88-backlog.mjs && git commit -m "fix: chart week labels clamp to range; delegated hit layer; 12-slot palette; ephemeral drill-down (backlog 2,3,13,10)"`

---

### Task 8: Backlog — worker parsing (4), scan meta (15), cache eviction (16), migration (18), reveal cards (14)

**Files:** Modify `AI Usage Dashboard.html`, Modify `tests/checks/88-backlog.mjs`

- [ ] **Step 1 — failing checks** (append):

```js
    // item 15: cached scan reports lines/badLines
    const meta = await page.evaluate(async () => {
      const bad = '{"type":"assistant","message":{"usage":{"input_tokens":1,"output_tokens":1},"model":"m","id":"z1"},"requestId":"z1","timestamp":"2026-08-10T10:00:00Z"}\nnot json\n';
      const res = await parseClaudeLogsCached([{ path: 'projects/-p/s.jsonl', file: new File([bad], 's.jsonl') }], null, new Map());
      return { lines: res.meta.lines, badLines: res.meta.badLines };
    });
    ok('backlog-15: cached scan preserves lines/badLines diagnostics', meta.lines === 2 && meta.badLines === 1, JSON.stringify(meta));
    // item 16: ScanCache prunes signatures not seen in the latest scan
    const evict = await page.evaluate(async () => {
      const cache = new Map();
      const f1 = { path: 'projects/-p/a.jsonl', file: new File(['{"type":"assistant","message":{"usage":{"input_tokens":1,"output_tokens":1},"model":"m","id":"a1"},"requestId":"a1","timestamp":"2026-08-10T10:00:00Z"}'], 'a.jsonl', { lastModified: 1 }) };
      const f2 = { path: 'projects/-p/b.jsonl', file: new File(['{"type":"assistant","message":{"usage":{"input_tokens":1,"output_tokens":1},"model":"m","id":"b1"},"requestId":"b1","timestamp":"2026-08-10T10:00:00Z"}'], 'b.jsonl', { lastModified: 1 }) };
      await parseClaudeLogsCached([f1, f2], null, cache);
      const before = cache.size;
      await parseClaudeLogsCached([f1], null, cache);   // b vanished
      return { before, after: cache.size };
    });
    ok('backlog-16: cache prunes entries for files absent from the latest scan', evict.before === 2 && evict.after === 1, JSON.stringify(evict));
    // item 18: v1.1-shaped store (no connectors) migrates to connected cards
    const mig = await page.evaluate(() => {
      Store.sources = {}; Store.connectors = {};
      Store.sources.anthropic = { rows: [{ d: todayKey(), platform: 'Anthropic API', model: 'm', in: 1, cw: 0, cr: 0, out: 1, msgs: 1 }], meta: { updated: Date.now() - 1000 } };
      Store.migrateConnectors();
      return { st: Store.connectorStatus(connectorById('anthropic')), label: (Store.connectors.anthropic || {}).label };
    });
    ok('backlog-18: sources without connector state migrate to a labeled connected card', mig.st === 'ok' && /stored data/i.test(mig.label), JSON.stringify(mig));
    // item 14: connected new-platform source cards are revealed in Data sources
    const reveal = await page.evaluate(() => {
      Store.setConnector('openrouter', { label: 'k', lastSync: Date.now() });
      App._render();
      return document.getElementById('src-openrouter').hidden === false;
    });
    ok('backlog-14: connected OpenRouter card is visible in Data sources', reveal, '');
    // item 4: large import parse runs off the main thread (worker path exists and returns identical rows)
    const wk = await page.evaluate(async () => {
      const conv = [{ current_node: 'B', mapping: { root: { id: 'root', parent: null, children: ['u'] }, u: { id: 'u', parent: 'root', children: ['B'], message: { author: { role: 'user' }, create_time: 1, content: { content_type: 'text', parts: ['hi'] } } }, B: { id: 'B', parent: 'u', children: [], message: { author: { role: 'assistant' }, create_time: 2, metadata: { model_slug: 'gpt-5.4' }, content: { content_type: 'text', parts: ['x'.repeat(400)] } } } } }];
      const direct = parseChatGPTExport(conv);
      const viaWorker = await parseInWorker('chatgpt', JSON.stringify(conv));
      return { same: JSON.stringify(direct.rows) === JSON.stringify(viaWorker.rows), msgs: viaWorker.meta.msgs };
    });
    ok('backlog-4: worker parse returns identical rows for chat exports', wk.same && wk.msgs === 1, JSON.stringify(wk));
```

- [ ] **Step 2 — implement.**
  - **15:** `parseClaudeLogs` already returns `meta.lines/badLines`; the cached wrapper sums them per file into its meta (`lines`, `badLines`; cache entries store both).
  - **16:** `parseClaudeLogsCached(files, onProgress, cache)` — after the loop, if `cache.prune` exists call `await cache.prune(new Set(seenSigs))`; the injectable Map cache in tests has no `prune` — so ALSO implement pruning generically: `if (typeof cache.keys === 'function') for (const k of [...cache.keys()]) if (!seenSigs.has(k)) cache.delete(k);` for Map; and `ScanCache.prune(keep)` for IDB: list keys with the `scan:` prefix (IDB helper needs a `keys()` — add `IDB.keys(prefix)` using `getAllKeys()`), delete those not in `keep`.
  - **18:** `Store.migrateConnectors()` called at the end of `Store.load()`: for each connector, if any of its `srcIds` has rows and `this.connectors[c.id]` is missing → `this.connectors[c.id] = { label: 'stored data', lastSync: (max meta.updated over its sources) || Date.now(), err: null }`; persist once if anything migrated.
  - **14:** in `_render()` (or `renderHub`), for each of gemini/copilot/openrouter: `$('src-'+id).hidden = !Store.connectors[id]`.
  - **4:** add `function parseInWorker(kind, text)` — builds a Blob worker from the source of the parse functions: `const src = [estTok, textOfChatGPTMessage, parseChatGPTExport, parseClaudeAiExport, makeAgg, dayKey, addDays].map(f => f.toString()).join('\n')` + `self.onmessage = (e) => { const { kind, text, assumedModel } = e.data; const obj = JSON.parse(text); const res = kind === 'chatgpt' ? parseChatGPTExport(obj) : parseClaudeAiExport(obj, assumedModel); self.postMessage(res); }` — NOTE `parseChatGPTExport` references `Date.now()`, `dayKey` (uses local getters — fine in a worker), `estTok`, `makeAgg` — all included; `parseClaudeAiExport` similarly. Returns a Promise resolving to `{rows, meta}`; rejects on worker error. In `handleImportFiles`, for chatgpt/claudeai kinds AND `f.size > 8 * 1024 * 1024`, use `await parseInWorker(kind, text)` instead of the direct call (small files stay on the main thread — no worker startup cost). The check exercises the worker directly regardless of size.

- [ ] **Step 3:** suite ×2 → green. Commit: `git add "AI Usage Dashboard.html" tests/checks/88-backlog.mjs && git commit -m "fix: worker parse for big exports; scan diagnostics + cache pruning; connector migration; reveal connected cards (backlog 4,14,15,16,18)"`

---

### Task 9: Backlog — same-connector double-fetch status (9 residual), efficiency+narrative honesty (17 note), spec doc alignment

**Files:** Modify `AI Usage Dashboard.html`, Modify `tests/checks/88-backlog.mjs`, Modify spec

- [ ] **Step 1 — failing check:**

```js
    const dbl = await page.evaluate(async () => {
      Store.sources = {}; Store.connectors = {};
      let n = 0;
      window.fetchAnthropicAll = async () => { const me = ++n; await new Promise(r => setTimeout(r, me === 1 ? 50 : 400)); return { usage: { rows: [{ d: todayKey(), platform: 'Anthropic API', model: 'm' + me, in: 1, cw: 0, cr: 0, out: 1, msgs: 1 }] }, cost: [] }; };
      document.getElementById('anthropic-key').value = 'sk-ant-admin-x';
      const p1 = App.fetchAnthropic(); const p2 = App.fetchAnthropic();
      await new Promise(r => setTimeout(r, 120));   // p1 (stale) has resolved & bailed; p2 still in flight
      const mid = document.getElementById('anthropic-status').textContent;
      await Promise.allSettled([p1, p2]);
      return { mid, final: document.getElementById('anthropic-status').textContent, model: Store.sources.anthropic.rows[0].model };
    });
    ok('backlog-9: stale bail does not blank a newer in-flight placeholder', /Fetching/.test(dbl.mid) && /Connected/.test(dbl.final) && dbl.model === 'm2', JSON.stringify(dbl));
```

- [ ] **Step 2 — implement.** The unstick guard is too coarse. Make placeholders gen-tagged: when a fetcher writes its placeholder, do `status.textContent = 'Fetching usage…'; status.dataset.gen = String(gen);` (all 5 fetchers + `Validating…`). The unstick guard becomes: `if (status.dataset.gen === String(gen)) status.textContent = '';` — only the owner of the current placeholder may clear it. Success/error paths set `status.dataset.gen = ''` when they write final text.
- [ ] **Step 3 — spec alignment (docs):** in the spec's Plan 2 backlog list mark items 2, 3, 4, 10, 13, 14, 15, 16, 18 ` — DONE (Plan 3)`, item 9's residual ` — DONE (Plan 3 T9)`, item 17 ` — accepted trade-off (documented: under-count self-heals on file change; full-rows caching deferred)`, item 11 ` — DONE (Plan 3: drill-down + insights row constitute the detail view; no separate panel)`, item 12 ` — accepted (registry-as-data design)`. Update the spec **Status** line at the top to `Implemented through Plan 3 (v3).`
- [ ] **Step 4:** suite ×2 → green. Commit: `git add "AI Usage Dashboard.html" tests/checks/88-backlog.mjs docs/superpowers/specs/2026-08-15-ai-accounts-rich-dashboard-design.md && git commit -m "fix: gen-tagged status placeholders; spec backlog closed for Plan 3"`

---

### Task 10: Full verification + screenshots + wrap-up

- [ ] Suite ×2 → all green, exit 0 (expect ~110). Byte hygiene → zero control bytes across tracked text files. Size gate ≤ 400 KB.
- [ ] Screenshots light + dark with seeded rich data (15 days of multi-platform rows incl. `hour`, one budget at 80%, one connected + one attention connector) → `tests/artifacts/`; zero console errors; visually confirm the insights row (heatmap filled, hour bars, chips), the narrative paragraph, an alert banner, budget bars on cards, and the widened palette on the daily chart. Also emulate print media once and screenshot → confirm the report layout hides hub/sources/filters.
- [ ] Docs: append to `docs/superpowers/reviews/2026-08-15-v1-code-review.md` Status: `Plan 3 (branch v3-rich-content) delivers the four rich-content packs and closes backlog 2–4, 9–18.` Commit `git add docs && git commit -m "docs: Plan 3 status"`.
- [ ] Report `git log --oneline main..HEAD` and clean status.

## Self-review notes

1. **Spec coverage:** Insights row 1–7 → T2/T3 (projection, heatmap, efficiency, cache savings, busiest hours, WoW, movers — movers use platform as project surrogate for non-local rows since only local rows carry projects; local project movers can be added when `Store.projects` gains dates — record as a known simplification in T9's spec update); Narrative → T4; Reports (print + header; CSV unchanged) → T6; Budgets & alerts (per-platform + total, 80/100/overrun, dismiss per month, hub bars) → T5; Visual identity (SVG monogram artwork upgrade) → **deferred**: text monograms + brand tints shipped in Plan 2; record in T9's spec update as accepted. Backlog 2,3,4,10,13,14,15,16,18 → T7/T8; 9-residual → T9; 11/12/17 → documented decisions.
2. **Type consistency:** `Insights.*` signatures `(rows, costOf, today)`; `Budgets.status()` shape `{ total: {spent,limit,pct,projected}|null, byPlatform: {...} }` used identically in T4/T5/hub; `bucketDays` buckets gain `label`; rows gain optional `hour`; `Store.migrateConnectors`, `IDB.keys`, `ScanCache.prune`, `parseInWorker` named once and reused.
3. **Order:** T4 references `Budgets` guarded by `typeof` — safe before T5. T5's hub bar uses `Budgets.status()` — exists by then. T7's drill-down change must keep 98-hub's two drill checks green (they assert on `rowsIn` counts).
4. **Counts are guidance; gate = green ×2.**
