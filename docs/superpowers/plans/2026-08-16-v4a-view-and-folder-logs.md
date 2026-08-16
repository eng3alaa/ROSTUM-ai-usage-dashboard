# v4a View Layer + Folder-Log Platforms (Plan 4a — Wave 1 of the "Every LLM + Customizable View" spec)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Wave 1 of `docs/superpowers/specs/2026-08-16-every-llm-and-view-design.md`: (1) the **View layer** — hide/unhide account cards, collapsible section headers, per-insight hide, legacy Data-sources section hidden by default; (2) **hub at scale** — category groups, connected-first ordering, search when >12 cards; (3) a **generic `folder-log` driver** (registry `patterns` + `parser`, per-connector incremental cache and folder handles, generic source cards rendered from the registry) plus **nine folder-log parsers** (OpenAI Codex CLI, Gemini CLI, GitHub Copilot CLI, Continue.dev, Cline, Roo Code, Aider, JetBrains Junie, LM Studio); (4) an **Ollama `local-server`** connector (live validate + CORS/offline messages) with a documented one-file usage-logger proxy; (5) two **export importers** (Gemini Takeout `MyActivity.json`, Cursor usage-events CSV).

**Architecture:** Still ONE self-contained file (`AI Usage Dashboard.html`, ~185 KB, 127-check suite green). New pieces: a `View` store (`aiusage:view`) consulted by `renderHub`, section headers, insights and the sources section; `SECTIONS` / `HUB_GROUPS` / `QUALITY_LABEL` tables; `parseFolderCached(connector, files, onProgress, cache)` generalizes `parseClaudeLogsCached` (which becomes a one-line wrapper) with a **connector-prefixed cache signature** and **connector-scoped pruning**; `App.ensureSourceCard(c)` renders a hidden `<div class="card src generic" id="src-<id>">` from registry fields for every `folder-log` / `local-server` entry (so `statusEl` resolves and the Manage modal has a body); `App.scanFiles(c, files)` is the single scan entry point (folder pick, classic chooser fallback, tests). Every parser is a global `async function parseX(files, onProgress, seen, connector, siblingFiles)` returning **exactly the `parseClaudeLogs` shape** `{ rows, projects, meta: { files, msgs, lines, badLines, addedIds } }` so the cached wrapper works unchanged (`projects` may be `[]`; `addedIds` may be `[]` for id-less formats).

**Tech stack:** unchanged (vanilla HTML/JS/SVG; puppeteer-core rig in `tests/`).

**Context for the engineer — conventions carried from Plans 1–3 (all still binding):**
- **Strict TDD per task:** the failing check is listed in full → RED gate with the expected failure text → exact implementation (full old/new code, anchored by unique strings, never line numbers) → GREEN ×2 → explicit `git add <files>` commit with the exact message. Never `git add -A`.
- **Checks:** wrap page use in `try/finally { await page.close(); }`; stateful blocks reset `Store.sources/billed/projects/connectors`, `App._drill`, `App.filters.hiddenPlatforms` (and, new in this plan, `LS.del('view'); View.load();`); `App._render()` is the synchronous inner render (`App.render()` is rAF-batched — call the specific `render*`/`apply*` method or `_render()`); the harness clears `aiusage:*` on every `openDashboard` unless `seedData`/`keepStorage` is passed; `clockAt`/`tz` opts exist.
- **Hygiene:** `95-ui-misc.mjs` pins **zero raw control bytes (<0x09)** in the HTML. Every `\u0001` separator in this plan is written as the visible 6-character escape text and MUST land in the HTML as visible text. Verify after any edit that touches those lines with a byte scan built from `String.fromCharCode` (never type the byte): `node -e "const b=require('fs').readFileSync('AI Usage Dashboard.html');let n=0;for(const x of b)if(x<9)n++;console.log('control bytes:',n)"` → `control bytes: 0`. Same for `tests/**` and `docs/tools/*.mjs`.
- **Suite gate** = every check passes, exit 0, **run twice**; counts are guidance only. Baseline at branch start: **127 checks**. New check files: `85-hub-groups.mjs` (T5), `86-view.mjs` (T1–T4), `87-folder-logs.mjs` (T6–T16) — prefixes sort without colliding with existing 10,20,…,80,88,89,90…99.
- **File size gate ≤ 600 KB.** Do not edit spec/plan docs from tasks (only T17 touches docs).
- **Registry rule:** a new platform is ONE `CONNECTORS` entry + ONE parser function. The `folder-log` driver is generic: `scanFolder(connector, handle)` → files matched by `connector.patterns` → `globalThis[connector.parser]` → rows. New connectors carry `statusEl: '<id>-status'`; the element is created by `ensureSourceCard` at init (97-registry's `everyHasCard` check must stay green).
- **Card copy honesty:** every generic card states data quality first (`exact` / `estimated` / `validate-only` / `no data`) and a `qualityNote` that matches the platform's row in `docs/superpowers/specs/2026-08-16-llm-platform-research.json` (paths, formats, which fields carry counts, and the caveats). Estimated rows carry `est: 1`. Local-server cards say usage is live/validate only.
- Anchors below are stable strings; line numbers drift. Functions are global declarations (stubbable via `window.X = …` in checks — `fetchJSON`, `probeServer`); `const` bindings are lexical.
- Palette tokens: no new CSS custom properties are introduced by this plan (all new CSS reuses `--ink`, `--ink-2`, `--muted`, `--border`, `--wash`, `--good-text`, `--serious`, `--surface-1`, `--grid`, `--accent`), so the three theme blocks are untouched.

## File structure

```
AI Usage Dashboard.html            # all app changes
docs/tools/ollama-usage-logger.mjs # T15: one-file Node proxy that writes usage JSONL (user runs it; dashboard only reads)
tests/fixtures/gen.mjs             # T6–T16: synthetic fixtures per format (each with a duplicate or malformed record)
tests/checks/86-view.mjs           # T1 hide/unhide cards, T2 collapse, T3 insight hide, T4 legacy sources
tests/checks/85-hub-groups.mjs     # T5 groups / ordering / search / group collapse
tests/checks/87-folder-logs.mjs    # T6 driver, T7–T14 parsers, T15 Ollama, T16 exports
tests/checks/98-hub.mjs            # T6: one assertion generalized (7 → CONNECTORS.length)
```

Fixture tree written under `tests/fixtures/out/` (regenerated each run):

```
usage-log/ollama-usage.jsonl                                   # T6/T15  in=1060 out=370 msgs=3 bad=1
codex/sessions/2026/08/10/rollout-2026-08-10T09-00-00-abc.jsonl # T7      in=200 cr=200 out=130 msgs=3 bad=1
gemini/tmp/abc123/chats/session-2026-08-10T09-00-aaaa.json     # T8      in=1800 cr=1700 out=470 msgs=3
gemini/tmp/abc123/chats/session-bad.json                       # T8      malformed file → badLines=1
copilot/session-state/sess-1/events.jsonl                      # T9      in=2100 cw=100 cr=900 out=490 msgs=3 bad=1
copilot/session-state/sess-2/events.jsonl                      # T9      shutdown-only fallback: in=50 out=10 msgs=2
continue/dev_data/0.2.0/tokensGenerated.jsonl (+chatInteraction.jsonl ignored) # T10 in=2500 out=280 msgs=3 bad=1
cline/tasks/1786352400000/ui_messages.json + task_metadata.json # T11     in=1700 out=380 cw=100 cr=900 msgs=2
cline/tasks/1786352500000/ui_messages.json                     # T11     malformed → badLines=1
aider/proj/.aider.chat.history.md                              # T12     in=10600 cw=2100 cr=8000 out=1828 msgs=3 bad=1 (est)
junie/.matterhorn/events/ISSUE-1 task-1-events.jsonl           # T13     in=2700 cr=600 out=360 msgs=3 bad=1
lmstudio/conversations/1723/chat.conversation.json (+bad.conversation.json) # T14 in=1970 out=350 msgs=3 bad=1
takeout/MyActivity.json                                        # T16     est in=16 out=23 msgs=3 skipped=2
cursor/usage-events.csv                                        # T16     in=4010 cw=700 cr=900 out=985 msgs=4 rejected=1
```

---

### Task 0: Branch + baseline

- [ ] `cd "D:/Code/rostum" && git checkout main && git switch -c v4a-view-folder-logs`
- [ ] `node tests/run.mjs` → 127/127, exit 0. Run twice. Commit nothing.
- [ ] Byte-hygiene baseline: the `node -e` scan above → `control bytes: 0`.

---

### Task 1: `View` store + hide/unhide account cards

**Files:** Modify `AI Usage Dashboard.html`, Create `tests/checks/86-view.mjs`

- [ ] **Step 1 — failing checks.** Create `tests/checks/86-view.mjs`:

```js
import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    // ---- T1: hide / unhide account cards ----
    const hide = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      App._drill = null; App.filters.hiddenPlatforms = new Set();
      LS.del('view'); View.load();
      App._render();
      const before = document.querySelectorAll('#accounts-hub .acct').length;
      document.querySelector('#accounts-hub .acct[data-connector="openrouter"] .acct-hide').click();
      App._render();
      const after = document.querySelectorAll('#accounts-hub .acct').length;
      const gone = !document.querySelector('#accounts-hub .acct[data-connector="openrouter"]');
      const chip = document.querySelector('#hub-chips .hub-hidden-chip');
      const persisted = (LS.get('view', {}) || {}).hiddenCards;
      return { before, after, gone, chipText: chip && chip.textContent, persisted };
    });
    ok('view: ✕ hides an account card, chip counts it, preference persists',
      hide.after === hide.before - 1 && hide.gone && /^1 hidden — show$/.test(hide.chipText || '') &&
      Array.isArray(hide.persisted) && hide.persisted.length === 1 && hide.persisted[0] === 'openrouter', JSON.stringify(hide));

    const show = await page.evaluate(() => {
      document.querySelector('#hub-chips .hub-hidden-chip').click();
      App._render();
      return { back: !!document.querySelector('#accounts-hub .acct[data-connector="openrouter"]'),
        chip: !!document.querySelector('#hub-chips .hub-hidden-chip'), persisted: LS.get('view', {}).hiddenCards.length };
    });
    ok('view: "N hidden — show" chip restores every hidden card', show.back && !show.chip && show.persisted === 0, JSON.stringify(show));

    const reveal = await page.evaluate(() => {
      View.hideCard('openrouter'); App._render();
      const hiddenFirst = !document.querySelector('#accounts-hub .acct[data-connector="openrouter"]');
      Store.setConnector('openrouter', { label: 'my-key', lastSync: Date.now(), err: null });   // connect → auto-reveal
      App._render();
      return { hiddenFirst, back: !!document.querySelector('#accounts-hub .acct[data-connector="openrouter"]'), pref: View.isCardHidden('openrouter') };
    });
    ok('view: connecting a hidden card auto-reveals it', reveal.hiddenFirst && reveal.back && reveal.pref === false, JSON.stringify(reveal));
  } finally {
    await page.close();
  }
}
```

RED: `View is not defined` (thrown → `86-view.mjs: threw`).

- [ ] **Step 2 — the store.** Insert directly AFTER the `LS` object (anchor: the line `/* ---------- theme ---------- */`, insert before it):

```js
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
  onConnectorChange(id, status) { if (status !== 'off' && this.isCardHidden(id)) this.revealCard(id); },
};
```

- [ ] **Step 3 — auto-reveal hook.** In `Store`, replace (anchor `setConnector(id, patch)`):

```js
  setConnector(id, patch) { this.connectors[id] = { ...(this.connectors[id] || {}), ...patch }; this.persist(); },
```
with
```js
  setConnector(id, patch) {
    this.connectors[id] = { ...(this.connectors[id] || {}), ...patch }; this.persist();
    View.onConnectorChange(id, this.connectorStatus({ id }));   // connected/attention → un-hide the card (View.hiddenCards)
  },
```
(`connectorStatus` reads only `c.id`, so the `{ id }` stub is sufficient. `View` is a top-level `const` declared before `Store`, and `setConnector` only ever runs after script evaluation, so no TDZ.)

- [ ] **Step 4 — HTML.** Directly BEFORE `  <div id="accounts-hub" aria-label="AI accounts"></div>` insert:

```html
  <div id="hub-bar"><span id="hub-chips"></span></div>
```

- [ ] **Step 5 — CSS.** After the line `#connector-modal .card.src { border: 0; padding: 0; background: transparent; }` append:

```css
#hub-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 0 8px; min-height: 0; }
#hub-bar:empty { display: none; }
.acct .acct-hide { border: 0; background: transparent; color: var(--muted); font-size: 12px; line-height: 1; padding: 2px 5px; border-radius: 4px; cursor: pointer; opacity: 0; flex: none; }
.acct:hover .acct-hide, .acct:focus-within .acct-hide, .acct .acct-hide:focus-visible { opacity: 1; }
.acct .acct-hide:hover { color: var(--ink); background: var(--wash); }
```
And in the print block, replace
```css
  .topbar .top-actions, .filterbar, #accounts-hub, #sources, .sources, #card-budgets, #card-pricing, #alerts, #storage-warning, .toggle, .btn { display: none !important; }
```
with
```css
  .topbar .top-actions, .filterbar, #accounts-hub, #sources, .sources, #card-budgets, #card-pricing, #alerts, #storage-warning, .toggle, .btn, #hub-bar, .acct-hide { display: none !important; }
```

- [ ] **Step 6 — renderHub.** Two edits inside `renderHub()`. Replace
```js
    for (const c of CONNECTORS) {
      const st = Store.connectors[c.id] || {};
      const status = Store.connectorStatus(c);
```
with
```js
    const chips = clear($('hub-chips'));
    const hiddenN = CONNECTORS.filter(c => View.isCardHidden(c.id)).length;
    if (hiddenN) chips.appendChild(el('button', { class: 'chip hub-hidden-chip', type: 'button', text: `${hiddenN} hidden — show`, title: 'Show hidden account cards',
      onclick: () => { View.showAllCards(); this.render(); } }));
    for (const c of CONNECTORS) {
      if (View.isCardHidden(c.id)) continue;
      const st = Store.connectors[c.id] || {};
      const status = Store.connectorStatus(c);
```
and replace
```js
          el('span', { class: 'acct-name', text: c.name }),
          el('span', { class: 'dot ' + status })),
```
with
```js
          el('span', { class: 'acct-name', text: c.name }),
          el('span', { class: 'dot ' + status }),
          el('button', { class: 'acct-hide', type: 'button', text: '✕', title: 'Hide this card', 'aria-label': 'Hide ' + c.name,
            onclick: (e) => { e.stopPropagation(); View.hideCard(c.id); this.render(); }, onkeydown: (e) => e.stopPropagation() })),
```
(`onkeydown` stops Enter on the ✕ from also firing the card's Enter→drillDown handler.)

- [ ] **Step 7 — init.** Replace `    Pricing.load(); ColorMap.load(); Store.load(); Budgets.load();` with `    View.load(); Pricing.load(); ColorMap.load(); Store.load(); Budgets.load();`.

- [ ] **Step 8:** suite ×2 → green (86-view's three T1 checks + all 127). Commit: `git add "AI Usage Dashboard.html" tests/checks/86-view.mjs && git commit -m "feat: View store + hide/unhide account cards (hover x, N hidden chip, auto-reveal on connect)"`

---

### Task 2: Section collapse (▾/▸ in every major card header; persisted; print ignores)

**Files:** Modify `AI Usage Dashboard.html`, Modify `tests/checks/86-view.mjs`

- [ ] **Step 1 — failing checks.** Append inside 86-view's `try`, after the T1 blocks:

```js
    // ---- T2: section collapse ----
    const col = await page.evaluate(() => {
      LS.del('view'); View.load(); App.applyCollapse();
      const heads = SECTIONS.map(s => !!document.querySelector(`.collapse-btn[data-section="${s.id}"]`));
      const btn = document.querySelector('.collapse-btn[data-section="narrative"]');
      btn.click();
      return { allHeads: heads.every(Boolean), n: heads.length,
        collapsedDisplay: getComputedStyle(document.getElementById('narrative')).display,
        pref: View.isCollapsed('narrative'), glyph: btn.textContent, expanded: btn.getAttribute('aria-expanded') };
    });
    ok('view: every major section header has a collapse toggle; collapsing hides the body and persists',
      col.allHeads && col.n >= 10 && col.collapsedDisplay === 'none' && col.pref === true && col.glyph === '▸' && col.expanded === 'false', JSON.stringify(col));
    await page.emulateMediaType('print');
    const printed = await page.evaluate(() => getComputedStyle(document.getElementById('narrative')).display);
    await page.emulateMediaType('screen');
    ok('view: print ignores collapse (collapsed body renders in print media)', printed !== 'none', printed);

    const { page: p2 } = await openDashboard(browser, { keepStorage: true });   // reload with the same localStorage
    try {
      const again = await p2.evaluate(async () => {
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { pref: View.isCollapsed('narrative'), display: getComputedStyle(document.getElementById('narrative')).display };
      });
      ok('view: collapse survives reload', again.pref && again.display === 'none', JSON.stringify(again));
    } finally { await p2.close(); }
    await page.evaluate(() => { LS.del('view'); View.load(); App.applyCollapse(); });   // leave page 1 expanded for the next blocks
```

RED: `App.applyCollapse is not a function` (the first statement of the T2 block; thrown after the T1 checks pass).

- [ ] **Step 2 — HTML.** Five edits:
  1. Replace `  <!-- ================= Insights row ================= -->\n  <div id="insights" aria-label="Insights">` with
```html
  <!-- ================= Insights row ================= -->
  <div class="row-head" id="insights-head"><h2>Insights</h2><span id="insights-chips"></span></div>
  <div id="insights" aria-label="Insights">
```
  2. In `#card-daily`: `      <figure>\n        <div class="chartbox" id="daily-chart"` → `      <figure id="daily-body">\n        <div class="chartbox" id="daily-chart"`.
  3. In `#card-models`: `      <figure>\n        <div class="chartbox" id="models-chart"` → `      <figure id="models-body">\n        <div class="chartbox" id="models-chart"`.
  4. In `#card-share`: `      <figure>\n        <div class="chartbox" id="share-chart"` → `      <figure id="share-body">\n        <div class="chartbox" id="share-chart"`.
  5. `  <div class="section-title">\n    <h2>API price list</h2>` → `  <div class="section-title" id="pricing-title">\n    <h2>API price list</h2>` and `  <div class="section-title">\n    <h2>Data sources</h2>` → `  <div class="section-title" id="sources-title">\n    <h2>Data sources</h2>`.

- [ ] **Step 3 — CSS.** After the `.acct .acct-hide:hover` line append:

```css
/* ============ Collapsible sections (View.collapsed) ============ */
.collapse-btn { border: 0; background: transparent; color: var(--muted); cursor: pointer; padding: 0 4px; font-size: 12px; line-height: 1; flex: none; }
.collapse-btn:hover { color: var(--ink); }
.row-head { display: flex; align-items: baseline; gap: 8px; margin: 0 0 6px; }
.row-head h2 { font-size: 13px; color: var(--ink-2); font-weight: 650; margin: 0; }
@media screen { .sec-collapsed { display: none !important; } }   /* screen-only: print ignores collapse by construction */
```
Print list: append `, .collapse-btn` to the print `display: none !important` selector list (after `.acct-hide`).

- [ ] **Step 4 — SECTIONS table.** After the `View` object append:

```js
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
```

- [ ] **Step 5 — App methods.** Insert before `  /* ---------- accounts hub ---------- */`:

```js
  /* ---------- collapsible sections ---------- */
  wireCollapsibles() {
    for (const s of SECTIONS) {
      const host = $(s.head); if (!host) continue;
      const head = host.matches('.card-head, .section-title, .row-head') ? host : host.querySelector('.card-head, .section-title, .row-head');
      if (!head || head.querySelector('.collapse-btn')) continue;
      const btn = el('button', { class: 'collapse-btn', type: 'button', 'data-section': s.id });
      btn.addEventListener('click', () => { View.toggleCollapse(s.id); this.applyCollapse(); this.render(); });   // re-render: charts measure a hidden (0-width) container otherwise
      head.insertBefore(btn, head.firstChild);
    }
    this.applyCollapse();
  },
  applyCollapse() {
    for (const s of SECTIONS) {
      const on = View.isCollapsed(s.id);
      const btn = document.querySelector(`.collapse-btn[data-section="${s.id}"]`);
      if (btn) { btn.textContent = on ? '▸' : '▾'; btn.setAttribute('aria-expanded', String(!on)); btn.title = (on ? 'Expand ' : 'Collapse ') + s.label; }
      for (const id of s.body) { const b = $(id); if (b) b.classList.toggle('sec-collapsed', on); }
    }
  },
```
Init: after `    this.renderPricing();` add `    this.wireCollapsibles();`.

- [ ] **Step 6:** suite ×2 → green. Commit: `git add "AI Usage Dashboard.html" tests/checks/86-view.mjs && git commit -m "feat: collapsible section headers (persisted; print ignores)"`

---

### Task 3: Insight-card hide + "show all" chip

**Files:** Modify `AI Usage Dashboard.html`, Modify `tests/checks/86-view.mjs`

- [ ] **Step 1 — failing check.** Append inside 86-view's `try`:

```js
    // ---- T3: insight hide ----
    const ins = await page.evaluate(() => {
      LS.del('view'); View.load(); App.applyCollapse(); App.applyInsightHides(); App._render();
      const card = document.querySelector('#insights .insight[data-insight="cache"]');
      card.querySelector('.insight-hide').click();
      const hidden = card.hidden;
      const chip = document.querySelector('#insights-chips .insights-hidden-chip');
      const pref = View.isInsightHidden('cache');
      const chipText = chip && chip.textContent;
      chip.click();
      return { hidden, chipText, pref, restored: card.hidden === false, chipGone: !document.querySelector('#insights-chips .insights-hidden-chip'), prefAfter: View.isInsightHidden('cache'),
        stillSeven: document.querySelectorAll('#insights .insight').length === 7 };
    });
    ok('view: insight ✕ hides one card; "show all" chip restores; DOM keeps all 7 cards',
      ins.hidden && /1 insight hidden — show all/.test(ins.chipText || '') && ins.pref && ins.restored && ins.chipGone && !ins.prefAfter && ins.stillSeven, JSON.stringify(ins));
```

RED: `App.applyInsightHides is not a function`.

- [ ] **Step 2 — CSS.** After the collapsible CSS block append:

```css
.insight { position: relative; }
.insight-hide { position: absolute; top: 4px; right: 6px; border: 0; background: transparent; color: var(--muted); cursor: pointer; font-size: 12px; line-height: 1; padding: 2px 4px; border-radius: 4px; opacity: 0; }
.insight:hover .insight-hide, .insight-hide:focus-visible { opacity: 1; }
.insight-hide:hover { color: var(--ink); background: var(--wash); }
```
Print list: append `, .insight-hide, #insights-chips` after `.collapse-btn`.

- [ ] **Step 3 — App methods.** After `applyCollapse()` add:

```js
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
```
Init: after `    this.wireCollapsibles();` add `    this.wireInsightHides();`. (`.insight` has no author `display` rule, so the `hidden` attribute hides it; hidden insights stay hidden in print — that is a user choice, unlike section collapse.)

- [ ] **Step 4:** suite ×2 → green (92-insights-ui still counts 7 `.insight` nodes — hidden cards remain in the DOM). Commit: `git add "AI Usage Dashboard.html" tests/checks/86-view.mjs && git commit -m "feat: per-insight hide + show-all chip"`

---

### Task 4: Data sources hidden by default + settings toggle

**Files:** Modify `AI Usage Dashboard.html`, Modify `tests/checks/86-view.mjs`

- [ ] **Step 1 — failing checks.** Append inside 86-view's `try`:

```js
    // ---- T4: legacy Data sources section ----
    const legacy = await page.evaluate(() => {
      LS.del('view'); View.load(); App.applyLegacySources();
      const offDisplay = getComputedStyle(document.getElementById('sources')).display;
      const titleOff = getComputedStyle(document.getElementById('sources-title')).display;
      const cb = document.getElementById('show-legacy-sources');
      cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
      const onDisplay = getComputedStyle(document.getElementById('sources')).display;
      const pref = LS.get('view', {}).showLegacySources;
      cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true }));
      return { offDisplay, titleOff, onDisplay, pref };
    });
    ok('view: legacy Data sources hidden by default; settings toggle shows and persists',
      legacy.offDisplay === 'none' && legacy.titleOff === 'none' && legacy.onDisplay !== 'none' && legacy.pref === true, JSON.stringify(legacy));
    const modalStill = await page.evaluate(async () => {
      App.openConnectorModal('anthropic');
      const dlg = document.getElementById('connector-modal');
      const inModal = !!dlg.querySelector('#src-anthropic') && getComputedStyle(dlg.querySelector('#src-anthropic')).display !== 'none';
      const closed = new Promise(r => dlg.addEventListener('close', r, { once: true })); dlg.close(); await closed;
      return { inModal, home: !!document.querySelector('#sources #src-anthropic') };
    });
    ok('view: connector modal still hosts source cards while the legacy section is hidden', modalStill.inModal && modalStill.home, JSON.stringify(modalStill));
    await page.evaluate(() => { LS.del('view'); View.load(); App.applyCollapse(); App.applyInsightHides(); App.applyLegacySources(); App._render(); });
```

RED: `App.applyLegacySources is not a function`.

- [ ] **Step 2 — HTML.** Replace `  <div id="hub-bar"><span id="hub-chips"></span></div>` with:

```html
  <div id="hub-bar"><span id="hub-chips"></span><label class="inline" title="The legacy per-source cards below the charts — the accounts hub above hosts the same cards in its Manage dialog"><input type="checkbox" id="show-legacy-sources"> Show legacy source cards</label></div>
```
Also update the two "connect a source below" strings: `<div class="subtitle" id="last-updated">No data yet — connect a source below.</div>` → `…connect an account above.</div>`, and in `renderSubtitle` `: 'No data yet — connect a source below.';` → `: 'No data yet — connect an account above.';`. In `emptyNode()`, replace `    const a = el('a', { text: 'connect a source below' });\n    a.addEventListener('click', () => $('src-local').scrollIntoView({ behavior: 'smooth' }));` with `    const a = el('a', { text: 'connect an account' });\n    a.addEventListener('click', () => this.openConnectorModal('local'));`.

- [ ] **Step 3 — CSS.** Change `@media screen { .sec-collapsed { display: none !important; } }` to `@media screen { .sec-collapsed, .legacy-off { display: none !important; } }`; remove `#hub-bar:empty { display: none; }` (the bar is never empty now); add `#hub-bar label.inline { font-size: 12px; color: var(--ink-2); display: inline-flex; gap: 6px; align-items: center; margin-left: auto; }`. Print list: append `, #sources-title` (the title would otherwise print above a hidden section).

- [ ] **Step 4 — App methods.** After `applyInsightHides()`:

```js
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
```
Init: after `    this.wireInsightHides();` add `    this.wireLegacyToggle();`. (Cards moved into `#modal-body` by `openConnectorModal` render normally — the `legacy-off` class lives on the section, not the cards; `_restoreModalCard` puts them back into the hidden section.)

- [ ] **Step 5:** suite ×2 → green (89-print still sees `#sources` hidden in print; 98-hub's `#sources #src-anthropic` queries are display-independent). Commit: `git add "AI Usage Dashboard.html" tests/checks/86-view.mjs && git commit -m "feat: legacy Data sources hidden by default with settings toggle"`

---

### Task 5: Registry `category` + hub groups, connected-first ordering, search when >12

**Files:** Modify `AI Usage Dashboard.html`, Create `tests/checks/85-hub-groups.mjs`

- [ ] **Step 1 — failing checks.** Create `tests/checks/85-hub-groups.mjs`:

```js
import { openDashboard } from '../lib/harness.mjs';

const ORDER = ['coding', 'chat', 'local', 'api', 'cloud'];

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const grp = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load(); App._hubQuery = '';
      App._render();
      const groups = [...document.querySelectorAll('#accounts-hub .hub-group')].map(g => g.dataset.group);
      const labels = [...document.querySelectorAll('#accounts-hub .hub-group h3')].map(h => h.textContent);
      const inGroup = (id) => document.querySelector(`#accounts-hub .acct[data-connector="${id}"]`).closest('.hub-group').dataset.group;
      return { groups, labels, local: inGroup('local'), copilot: inGroup('copilot'), anthropic: inGroup('anthropic'), imports: inGroup('imports'),
        every: CONNECTORS.every(c => !!c.category), n: document.querySelectorAll('#accounts-hub .acct').length, total: CONNECTORS.length };
    });
    ok('hub-groups: every registry entry has a category; cards render inside groups in spec order; empty groups omitted',
      grp.every && grp.n === grp.total && grp.local === 'coding' && grp.copilot === 'coding' && grp.anthropic === 'api' && grp.imports === 'chat' &&
      JSON.stringify(grp.groups) === JSON.stringify(ORDER.filter(g => grp.groups.includes(g))) &&
      grp.labels.includes('Coding tools') && grp.labels.includes('API vendors') && grp.labels.includes('Chat apps'), JSON.stringify(grp));

    const order = await page.evaluate(() => {
      Store.setConnector('openrouter', { label: 'k', lastSync: Date.now(), err: null });   // ok
      Store.setConnector('gemini', { err: 'bad key' });                                    // warn
      App._render();
      return { ids: [...document.querySelectorAll('#accounts-hub .hub-group[data-group="api"] .acct')].map(c => c.dataset.connector) };
    });
    ok('hub-groups: connected → attention → disconnected, then registry order',
      order.ids[0] === 'openrouter' && order.ids[1] === 'gemini' && order.ids.indexOf('anthropic') < order.ids.indexOf('openai'), JSON.stringify(order));

    const search = await page.evaluate(() => {
      Store.connectors = {}; App._render();
      const total = document.querySelectorAll('#accounts-hub .acct').length;
      const box = document.getElementById('hub-search');
      const ruleOk = box.hidden === !(total > 12);
      App._hubQuery = 'openrouter'; App.renderHub();
      const filtered = [...document.querySelectorAll('#accounts-hub .acct')].map(c => c.dataset.connector);
      const stillShown = box.hidden === !(total > 12);   // the rule counts un-hidden cards, not the query result
      App._hubQuery = ''; App.renderHub();
      return { total, ruleOk, filtered, stillShown, restored: document.querySelectorAll('#accounts-hub .acct').length };
    });
    ok('hub-groups: search box appears only when >12 cards are visible; query filters by name without hiding the box',
      search.ruleOk && search.stillShown && search.filtered.length === 1 && search.filtered[0] === 'openrouter' && search.restored === search.total, JSON.stringify(search));

    const gcol = await page.evaluate(() => {
      document.querySelector('#accounts-hub .hub-group[data-group="api"] .collapse-btn').click();
      const body = document.querySelector('#accounts-hub .hub-group[data-group="api"] .hub-group-body');
      const display = getComputedStyle(body).display;
      const pref = View.isCollapsed('hub:api');
      View.toggleCollapse('hub:api'); App.renderHub();
      return { display, pref, back: getComputedStyle(document.querySelector('#accounts-hub .hub-group[data-group="api"] .hub-group-body')).display };
    });
    ok('hub-groups: group header toggle collapses the group and persists in the View store', gcol.display === 'none' && gcol.pref === true && gcol.back !== 'none', JSON.stringify(gcol));

    const budgetRows = await page.evaluate(() => {
      Store.sources = {}; Store.connectors = {}; Budgets.limits = {}; LS.del('budgets');
      App.renderBudgets();
      const empty = document.querySelectorAll('#budget-editor .budget-row').length;
      Store.setConnector('openrouter', { label: 'k', lastSync: Date.now(), err: null });
      App.renderBudgets();
      const one = document.querySelectorAll('#budget-editor .budget-row').length;
      Store.connectors = {};
      return { empty, one };
    });
    ok('hub-groups: budget editor lists Total + only platforms that are connected, budgeted, or have data', budgetRows.empty === 1 && budgetRows.one === 2, JSON.stringify(budgetRows));
  } finally {
    await page.close();
  }
}
```

RED: `.closest('.hub-group')` returns null → `Cannot read properties of null (reading 'dataset')` (thrown → `85-hub-groups.mjs: threw`).

- [ ] **Step 2 — registry `category` + tables.** Replace the seven entries' opening lines to add `category` (exact edits — one per entry):

| anchor (unique start of the entry) | add before `kind:` |
|---|---|
| `{ id: 'local',      platform: 'Claude Code/Desktop', name: 'Claude Code / Desktop', kind: 'folder',` | `category: 'coding', ` → `…name: 'Claude Code / Desktop', category: 'coding', kind: 'folder',` |
| `{ id: 'anthropic',  platform: 'Anthropic API',       name: 'Anthropic API',         kind: 'admin-key',` | `category: 'api', ` |
| `{ id: 'openai',     platform: 'OpenAI API',          name: 'OpenAI API',            kind: 'admin-key',` | `category: 'api', ` |
| `{ id: 'gemini',     platform: 'Gemini',              name: 'Gemini (Google AI)',    kind: 'api-key',` | `category: 'api', ` |
| `{ id: 'copilot',    platform: 'GitHub Copilot',      name: 'GitHub Copilot',        kind: 'token',` | `category: 'coding', ` |
| `{ id: 'openrouter', platform: 'OpenRouter',          name: 'OpenRouter',            kind: 'api-key',` | `category: 'api', ` |
| `{ id: 'imports',    platform: null,                  name: 'Imports',               kind: 'files',` | `category: 'chat', ` |

Then directly AFTER `const connectorById = (id) => CONNECTORS.find(c => c.id === id);` add:

```js
/* Hub groups (spec order). Within a group: connected → attention → disconnected, then registry order. */
const HUB_GROUPS = [
  { id: 'coding', label: 'Coding tools' },
  { id: 'chat',   label: 'Chat apps' },
  { id: 'local',  label: 'Local runners' },
  { id: 'api',    label: 'API vendors' },
  { id: 'cloud',  label: 'Cloud' },
];
/* Data-quality badge copy (honesty rule: quality first). */
const QUALITY_LABEL = { exact: 'exact', estimated: 'estimated', validate: 'validate-only', none: 'no data' };
```

- [ ] **Step 3 — HTML.** Replace `  <div id="hub-bar"><span id="hub-chips"></span>` (start of the hub-bar line) with `  <div id="hub-bar"><input type="search" id="hub-search" placeholder="Search accounts…" aria-label="Search accounts" hidden><span id="hub-chips"></span>` (rest of the line unchanged).

- [ ] **Step 4 — CSS.** Replace `#accounts-hub { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; margin-bottom: 16px; }` with:

```css
#accounts-hub { display: block; margin-bottom: 16px; }   /* groups own the grid now */
.hub-group { margin-bottom: 12px; }
.hub-group-head { display: flex; align-items: baseline; gap: 8px; margin: 0 0 6px; }
.hub-group-head h3 { font-size: 12px; font-weight: 650; margin: 0; color: var(--ink-2); text-transform: uppercase; letter-spacing: .05em; }
.hub-group-head .hint { color: var(--muted); font-size: 11.5px; }
.hub-group-body { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.acct .badge { font-size: 9.5px; padding: 0 5px; }
```
Replace `input[type="date"], input[type="text"], input[type="password"], select {` with `input[type="date"], input[type="text"], input[type="password"], input[type="search"], select {` and add `#hub-bar input[type="search"] { min-width: 220px; }` after the `#hub-bar label.inline` rule.

- [ ] **Step 5 — renderHub → groups.** Replace EVERYTHING from `  /* ---------- accounts hub ---------- */\n  renderHub() {` up to (not including) `  openConnectorModal(id) {` with:

```js
  /* ---------- accounts hub ---------- */
  hubCard(c, allRows, win30, bst) {
    const st = Store.connectors[c.id] || {};
    const status = Store.connectorStatus(c);
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
    const card = el('div', { class: 'acct', 'data-connector': c.id, style: { '--acct-brand': c.brand }, tabindex: 0, role: 'button',
      'aria-label': `${c.name}: ${status === 'ok' ? 'connected' : status === 'warn' ? 'needs attention' : 'not connected'}` },
      el('div', { class: 'acct-head' },
        el('span', { class: 'mark', text: c.mark }),
        el('span', { class: 'acct-name', text: c.name }),
        c.quality ? el('span', { class: 'badge q-' + c.quality, text: QUALITY_LABEL[c.quality] || c.quality, title: c.qualityNote || '' }) : null,
        el('span', { class: 'dot ' + status }),
        el('button', { class: 'acct-hide', type: 'button', text: '✕', title: 'Hide this card', 'aria-label': 'Hide ' + c.name,
          onclick: (e) => { e.stopPropagation(); View.hideCard(c.id); this.render(); }, onkeydown: (e) => e.stopPropagation() })),
      el('div', { class: 'acct-label', text: st.err ? ('⚠ ' + st.err) : (st.label || (status === 'off' ? 'Not connected' : '')) }),
      el('div', { class: 'acct-sync', text: st.lastSync ? ('Synced ' + new Date(st.lastSync).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) : '' }),
      el('div', { class: 'acct-stats', text: rows.length ? `${fmtCompact(tok)} tokens · ${fmtUSD(cost)} (30d)` : '' }),
      (c.platform && Budgets.limits[c.platform]) ? (() => { const s = bst.byPlatform[c.platform]; return el('div', { class: 'budget-bar' + (s.pct >= 100 ? ' over' : s.pct >= 80 ? ' warn' : ''), title: `${fmtUSD(s.spent)} of ${fmtUSD(s.limit)} this month` }, el('div', { class: 'fill', style: { width: Math.min(100, s.pct) + '%' } })); })() : null,
      el('div', { class: 'acct-actions' },
        el('button', { class: 'btn small acct-manage', text: status === 'off' ? 'Connect' : 'Manage', onclick: (e) => { e.stopPropagation(); this.openConnectorModal(c.id); } }),
        status !== 'off' && c.id !== 'imports' ? el('button', { class: 'btn small acct-sync-btn', text: 'Sync', onclick: (e) => { e.stopPropagation(); this.syncConnector(c.id); } }) : null,
        status !== 'off' ? el('button', { class: 'btn small', text: 'Disconnect', onclick: (e) => { e.stopPropagation(); this.disconnectConnector(c.id); } }) : null));
    card.addEventListener('click', () => this.drillDown(c));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.drillDown(c); });
    return card;
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
    const q = (this._hubQuery || '').trim().toLowerCase();
    const visible = CONNECTORS.filter(c => !View.isCardHidden(c.id));
    const hiddenN = CONNECTORS.length - visible.length;
    $('hub-search').hidden = visible.length <= 12;   // rule is on un-hidden cards, NOT on the query result — the box must not vanish while typing
    const chips = clear($('hub-chips'));
    if (hiddenN) chips.appendChild(el('button', { class: 'chip hub-hidden-chip', type: 'button', text: `${hiddenN} hidden — show`, title: 'Show hidden account cards',
      onclick: () => { View.showAllCards(); this.render(); } }));
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
            onclick: () => { View.toggleCollapse('hub:' + g.id); this.renderHub(); } }),
          el('h3', { text: g.label }),
          el('span', { class: 'hint', text: `${nConn} of ${members.length} connected` })),
        body));
    }
    // reveal Data-sources cards for newly-connected platforms that start hidden in the HTML
    // (consistent with _restoreModalCard's re-hide-if-unconnected rule on modal close) — but
    // never touch a card that's currently open INSIDE the connector modal: any render while
    // the user is mid-edit (resize, timer, etc.) would otherwise blank it out from under them.
    for (const id of ['gemini', 'copilot', 'openrouter']) {
      const src = $('src-' + id);
      if (src && src.parentNode !== $('modal-body')) src.hidden = !Store.connectors[id];
    }
  },

```
(T1's hide button and chip are carried into `hubCard`/`renderHub` unchanged in behavior; the search input is left alone by `clear($('hub-chips'))` so typing keeps focus/value.)

- [ ] **Step 6 — search wiring + budget editor.** Init, after `    this.wireLegacyToggle();`: `    $('hub-search').addEventListener('input', () => { this._hubQuery = $('hub-search').value; this.renderHub(); });` and add the field `  _hubQuery: '',   // hub search box text (never persisted)` as a new line inserted directly AFTER the `App` literal's `_drill` line — the full existing line is `  _drill: null,   // ephemeral platform drill-down (from an accounts-hub card click) — never persisted, never touches filters.hiddenPlatforms`.
  In `renderBudgets`, replace `    for (const c of CONNECTORS) if (c.platform) box.appendChild(rowFor(c.platform, c.name));` with:
```js
    // the registry is large now — list Total + platforms you actually use (connected, budgeted, or with data), once per platform
    const seenP = new Set(), hasData = new Set(Store.allRows().map(r => r.platform));
    for (const c of CONNECTORS) {
      if (!c.platform || seenP.has(c.platform)) continue;
      seenP.add(c.platform);
      if (Budgets.limits[c.platform] == null && !hasData.has(c.platform) && Store.connectorStatus(c) === 'off') continue;
      box.appendChild(rowFor(c.platform, c.name));
    }
    box.appendChild(el('div', { class: 'note', text: 'Platforms appear here once connected, budgeted, or once they have data.' }));
```

- [ ] **Step 7:** suite ×2 → green (98-hub selectors `#accounts-hub .acct` still match inside groups; 94-budgets asserts on `Budgets.status()`/hub bars, not editor rows). Commit: `git add "AI Usage Dashboard.html" tests/checks/85-hub-groups.mjs && git commit -m "feat: hub groups by category, connected-first, search >12 (registry category)"`

---

### Task 6: Generic `folder-log` driver

**Files:** Modify `AI Usage Dashboard.html`, `tests/fixtures/gen.mjs`, `tests/checks/98-hub.mjs`, Create `tests/checks/87-folder-logs.mjs`

- [ ] **Step 1 — fixture + helper.** In `tests/fixtures/gen.mjs`, inside `generate()` after the `generic-badnums.csv` write, add the shared writer and the T6 fixture:

```js
  // ---- Plan 4a fixtures: one folder per format, each with a duplicate or malformed record ----
  const w = (rel, text) => { const p = path.join(OUT, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  const T = (iso) => Date.parse(iso);

  // T6/T15 — universal usage-log JSONL (what docs/tools/ollama-usage-logger.mjs writes). Expected: in=1060 out=370 msgs=3 badLines=1
  w('usage-log/ollama-usage.jsonl', [
    jl({ ts: '2026-08-10T09:00:00.000Z', platform: 'Ollama', model: 'llama4:8b', in: 120, out: 300, msgs: 1, path: '/api/chat' }),
    jl({ ts: '2026-08-10T09:05:00.000Z', platform: 'Ollama', model: 'llama4:8b', in: 40, out: 10, msgs: 1, path: '/api/generate' }),
    'this line is not json',
    jl({ ts: '2026-08-11T21:00:00.000Z', platform: 'Ollama', model: 'qwen3:14b', prompt_eval_count: 900, eval_count: 60, path: '/v1/chat/completions' }),
  ].join('\n') + '\n');
```

- [ ] **Step 2 — failing checks.** Create `tests/checks/87-folder-logs.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { openDashboard, OUT } from '../lib/harness.mjs';

const read = (...p) => fs.readFileSync(path.join(OUT, ...p), 'utf8');
const sum = (rows) => rows.reduce((a, r) => ({ in: a.in + (r.in || 0), cw: a.cw + (r.cw || 0), cr: a.cr + (r.cr || 0), out: a.out + (r.out || 0), msgs: a.msgs + (r.msgs || 0) }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    // ---- T6: generic folder-log driver ----
    const logText = read('usage-log', 'ollama-usage.jsonl');
    const drv = await page.evaluate(async (text) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const tmp = { id: 'tmp-log', platform: 'TmpLog', name: 'Temp log', category: 'local', kind: 'folder-log', statusEl: 'tmp-log-status', brand: '#888888', mark: 'Tm', srcIds: ['tmp-log'],
        patterns: [/\.jsonl$/i], parser: 'parseUsageLoggerJsonl', hint: 'usage JSONL', quality: 'exact', qualityNote: 'temp', paths: ['x'], links: {} };
      const tmp2 = { ...tmp, id: 'tmp-log2', statusEl: 'tmp-log2-status', srcIds: ['tmp-log2'], platform: 'TmpLog2' };
      CONNECTORS.push(tmp, tmp2);
      App.ensureSourceCard(tmp); App.ensureSourceCard(tmp2);
      const cardOk = !!document.getElementById('src-tmp-log') && !!document.getElementById('tmp-log-status') && !!document.getElementById('tmp-log-pick')
        && !!document.getElementById('tmp-log-fallback') && /exact/i.test(document.querySelector('#src-tmp-log .badge').textContent) && document.getElementById('src-tmp-log').hidden === true;
      const mk = () => [
        { path: 'logs/ollama-usage.jsonl', file: new File([text], 'ollama-usage.jsonl', { lastModified: 1754000000000 }) },
        { path: 'logs/readme.txt', file: new File(['x'], 'readme.txt', { lastModified: 1754000000000 }) },   // not matched by patterns
      ];
      await App.scanFiles(tmp, mk());
      const rows = Store.sources['tmp-log'].rows;
      const t = rows.reduce((a, r) => ({ in: a.in + r.in, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, out: 0, msgs: 0 });
      const st = Store.connectors['tmp-log'];
      const status = Store.connectorStatus(tmp);   // capture BEFORE the cleanup below deletes the connector state
      const statusText = document.getElementById('tmp-log-status').textContent;
      App.renderHub();
      const hubCard = !!document.querySelector('#accounts-hub .acct[data-connector="tmp-log"]');
      // cache: same connector hits; a DIFFERENT connector with the same paths must NOT hit; pruning is per connector
      const cache = new Map();
      const a = await parseFolderCached(tmp, mk(), null, cache);
      const b = await parseFolderCached(tmp, mk(), null, cache);
      const c2 = await parseFolderCached(tmp2, mk(), null, cache);
      const sigs = [...cache.keys()];
      await parseFolderCached(tmp2, [], null, cache);   // tmp2 sees no files → prunes ONLY tmp2 entries
      const afterPrune = { tmp: sigs.length && [...cache.keys()].filter(k => k.startsWith('tmp-log\u0001')).length, tmp2: [...cache.keys()].filter(k => k.startsWith('tmp-log2\u0001')).length };
      // cleanup
      CONNECTORS.splice(CONNECTORS.indexOf(tmp), 2);
      document.getElementById('src-tmp-log').remove(); document.getElementById('src-tmp-log2').remove();
      delete Store.sources['tmp-log']; delete Store.connectors['tmp-log']; Store.persist(); App._render();
      return { cardOk, ...t, platform: rows[0] && rows[0].platform, label: st && st.label, status, statusText, hubCard,
        files: a.meta.files, aParsed: a.meta.parsedFiles, bCached: b.meta.cachedFiles, c2Parsed: c2.meta.parsedFiles, sigs, afterPrune };
    }, logText);
    ok('folder-log: generic card + scanFiles land rows under the connector (in=1060 out=370 msgs=3; platform from rows; connected status)',
      drv.cardOk && drv.in === 1060 && drv.out === 370 && drv.msgs === 3 && drv.platform === 'Ollama' && /^1 file$/.test(drv.label || '') && drv.status === 'ok'
      && /Connected/.test(drv.statusText) && /1 unreadable/.test(drv.statusText) && drv.hubCard, JSON.stringify(drv));
    ok('folder-log: cache is keyed per connector (same connector hits, other connector misses) and pruning is connector-scoped',
      drv.files === 1 && drv.aParsed === 1 && drv.bCached === 1 && drv.c2Parsed === 1 && drv.sigs.length === 2 && drv.sigs.every(k => /^tmp-log2?\u0001/.test(k))
      && drv.afterPrune.tmp === 1 && drv.afterPrune.tmp2 === 0, JSON.stringify({ sigs: drv.sigs, afterPrune: drv.afterPrune }));
  } finally {
    await page.close();
  }
}
```
(`sum` is a Node-side helper kept for later blocks; totals inside `page.evaluate` are reduced in-page. The `\u0001` in this check file is JS source text — the visible escape — and the byte scan in T6 Step 7 covers `tests/**` too.)

RED: `App.ensureSourceCard is not a function` (thrown → `87-folder-logs.mjs: threw`).

- [ ] **Step 3 — registry: local gains driver fields; PLATFORM_ORDER dedupes.** Replace the `local` entry with:

```js
  { id: 'local',      platform: 'Claude Code/Desktop', name: 'Claude Code / Desktop', category: 'coding', kind: 'folder',
    statusEl: 'local-status',    brand: '#d97748', mark: 'CC', srcIds: ['local', 'local-import'],
    patterns: [/\.jsonl$/i], exclude: /\/(todos|statsig)\//, parser: 'parseClaudeLogs' },
```
Replace
```js
const PLATFORM_ORDER = CONNECTORS.map(c => c.platform).filter(Boolean)
  .concat(['ChatGPT', 'Claude.ai', 'Other']);
```
with
```js
// deduped: several connectors may share one platform (GitHub Copilot billing + Copilot CLI logs)
const PLATFORM_ORDER = [...new Set(CONNECTORS.map(c => c.platform).filter(Boolean))]
  .concat(['ChatGPT', 'Claude.ai', 'Other']);
```
Registry field reference for the entries added in T7–T16 — document it in the comment block above `const CONNECTORS = [`. Replace the single comment line
```js
 * Adding a platform = adding one entry here (+ its card body HTML).
```
with these four comment lines:
```js
 * Adding a platform = adding one entry here + one parser function (folder-log/local-server cards are rendered from the entry by App.ensureSourceCard).
 * folder-log fields: patterns [RegExp] (files to read) · siblings [RegExp] (extra files handed to the parser, e.g. task_metadata.json) · exclude RegExp (tested against '/' + path)
 *                    · parser 'globalFnName' · hint · quality exact|estimated|validate|none · qualityNote · paths [] · links {get,docs,usage}
 * local-server fields: baseUrl · validate 'globalFnName' (async (base) → {label, detail}) · corsHint · optional patterns/parser for a usage-logger folder
```

- [ ] **Step 4 — generic walker + cached driver.** Replace the whole `parseClaudeLogsCached` function (from `/** Incremental wrapper: per-file aggregates cached by (path, size, lastModified).` through its closing `}` before `const ScanCache = {`) with:

```js
/** Generic folder walker: collects files whose relative path matches any RegExp in `patterns`
 *  (depth ≤ 8, ≤ 20 000 files, skips VCS/dependency/checkpoint dirs). Used by every folder-log
 *  connector; the Claude scanner keeps its own projects-aware walker (collectJsonlFromHandle). */
const GENERIC_SKIP_DIRS = /^(node_modules|\.git|checkpoints|\.venv|venv|__pycache__)$/i;
async function collectFilesFromHandle(dirHandle, patterns, path = '', out = [], depth = 0) {
  if (depth > 8 || out.length > 20000) return out;
  const dirs = [];
  for await (const [name, h] of dirHandle.entries()) {
    if (h.kind === 'directory') { if (!GENERIC_SKIP_DIRS.test(name)) dirs.push([name, h]); }
    else if (patterns.some(re => re.test(path + name))) { try { out.push({ path: path + name, file: await h.getFile() }); } catch {} }
  }
  for (const [name, h] of dirs) await collectFilesFromHandle(h, patterns, path + name + '/', out, depth + 1);
  return out;
}

/** Generic incremental scan: per-file aggregates cached by (connectorId, path, size, lastModified).
 *  connector.patterns select the files the parser owns; connector.siblings are collected too and
 *  handed to the parser as `siblingFiles` — computed ONCE per scan, sibling files only, never parsed on their own; connector.exclude drops paths.
 *  connector.parser names a global `async function parseX(files, onProgress, seen, connector, siblingFiles)`
 *  returning { rows, projects, meta: { files, msgs, lines, badLines, addedIds? } } (parseClaudeLogs' shape).
 *  cache: Map (tests) or the IDB-backed ScanCache (app). Files are processed in sorted-path order with a
 *  `runningSeen` set spanning the whole scan, so cross-file duplicates stay deduped even though each file
 *  is parsed/cached separately (parsers that emit addedIds opt in; id-less parsers never collide).
 *  Pruning is scoped to THIS connector's signature prefix — one connector's scan never evicts another's. */
async function parseFolderCached(connector, files, onProgress, cache) {
  const parser = globalThis[connector.parser];
  if (typeof parser !== 'function') throw new Error('No parser registered: ' + connector.parser);
  const pats = connector.patterns || [/./];
  const keep = (f) => !(connector.exclude && connector.exclude.test('/' + f.path));
  const sibPats = connector.siblings || [];
  const main = files.filter(f => keep(f) && pats.some(re => re.test(f.path))).sort((a, b) => a.path < b.path ? -1 : 1);
  const siblingFiles = sibPats.length ? files.filter(f => keep(f) && sibPats.some(re => re.test(f.path))) : [];   // one filter per scan — handed to every per-file parser call by reference
  const rows = [], projects = [];
  let msgs = 0, parsedFiles = 0, cachedFiles = 0, done = 0, lines = 0, badLines = 0;
  const runningSeen = new Set();
  const seen = new Set();   // signatures present in THIS scan — stale entries for absent files get pruned below
  const prefix = connector.id + '\u0001';
  for (const f of main) {
    const sig = prefix + f.path + '\u0001' + f.file.size + '\u0001' + f.file.lastModified;
    seen.add(sig);
    let entry = cache ? await cache.get(sig) : null;
    // an entry without `ids`, or whose ids collide with what's already been counted this scan, is a miss (re-parse)
    const isMiss = !entry || !entry.ids || entry.ids.some(id => runningSeen.has(id));
    if (isMiss) {
      const res = await parser([f], null, runningSeen, connector, siblingFiles);
      entry = { rows: res.rows, projects: res.projects || [], msgs: res.meta.msgs || 0, ids: res.meta.addedIds || [], lines: res.meta.lines || 0, badLines: res.meta.badLines || 0 };
      if (cache) await cache.set(sig, entry);
      parsedFiles++;
    } else {
      entry.ids.forEach(id => runningSeen.add(id));
      cachedFiles++;
    }
    rows.push(...entry.rows); projects.push(...entry.projects); msgs += entry.msgs;
    lines += entry.lines ?? 0; badLines += entry.badLines ?? 0;   // pre-fix entries lack these — 0, not NaN
    done++; if (onProgress) onProgress(done, main.length);
  }
  if (cache) {
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
  return { rows, projects: [...pm.values()], meta: { files: main.length, msgs, parsedFiles, cachedFiles, lines, badLines } };
}
/** Claude-logs wrapper kept for its callers and the 96/88 checks: identical behavior, now routed through
 *  the generic driver (signature gains the 'local' prefix → one-time re-parse of existing caches). */
async function parseClaudeLogsCached(files, onProgress, cache) {
  return parseFolderCached(connectorById('local'), files, onProgress, cache);
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
```
Then update `ScanCache.prune`: replace everything from the comment line `  // deletes any 'scan:'-prefixed IDB key that isn't a live v3 entry — this also sweeps up` (and its second comment line) through the method's closing `  },` (i.e. the old comment + the whole `async prune(keep) {…}` body) with:

```js
  // deletes stale keys for ONE connector (prefix = '<connectorId>\u0001'): legacy pre-v3 keys and
  // v3 keys with the old 3-field signature (no connector prefix) are swept regardless; other
  // connectors' entries are left alone.
  async prune(keep, prefix) {
    try {
      const keys = await IDB.keys('scan:');
      for (const k of keys) {
        const sig = k.startsWith('scan:v3:') ? k.slice(8) : null;
        if (sig === null || sig.split('\u0001').length < 4) { await IDB.del(k); continue; }
        if (prefix && !sig.startsWith(prefix)) continue;
        if (!keep.has(sig)) await IDB.del(k);
      }
    } catch {}
  },
```
(Every `\u0001` above is visible escape text — run the byte scan after this step.)

- [ ] **Step 5 — App: generic cards, scans, handles.** Add fields after `  dirHandle: null,`: `  _dirHandles: {},   // connectorId → FileSystemDirectoryHandle for folder-log connectors (IDB 'dir:<id>')`. Insert the following methods directly BEFORE `  async pickFolder() {`:

```js
  /* =================== generic folder-log / local-server connectors =================== */
  /** Renders the hidden source card for a registry entry (statusEl target + Manage-modal body). Idempotent. */
  ensureSourceCard(c) {
    if (document.getElementById('src-' + c.id)) return;
    const q = c.quality || 'none';
    const kids = [
      el('div', { class: 'card-head' }, el('h2', { text: c.name }), el('span', { class: 'badge q-' + q, text: QUALITY_LABEL[q] || q })),
      el('div', { class: 'desc', text: c.qualityNote || '' }),
    ];
    if (c.paths && c.paths.length) {
      const p = el('div', { class: 'note' }, 'Where the files live: ');
      c.paths.forEach((s, i) => { if (i) p.appendChild(document.createTextNode(' · ')); p.appendChild(el('code', { text: s })); });
      kids.push(p);
    }
    if (c.baseUrl) {
      kids.push(el('div', { class: 'row' },
        el('input', { type: 'text', id: c.id + '-url', value: LS.get('url:' + c.id, null) || c.baseUrl, 'aria-label': c.name + ' server URL', spellcheck: 'false' }),
        el('button', { class: 'btn primary', id: c.id + '-validate', text: 'Validate & connect', onclick: () => this.connectServer(c) })));
    }
    if (c.patterns) {
      const fb = el('input', { type: 'file', id: c.id + '-fallback', webkitdirectory: '', multiple: '', hidden: '' });
      fb.addEventListener('change', (e) => { const files = [...e.target.files].map(f => ({ path: f.webkitRelativePath || f.name, file: f })); e.target.value = ''; if (files.length) this.scanFiles(c, files); });
      kids.push(el('div', { class: 'row' },
        el('button', { class: 'btn' + (c.baseUrl ? '' : ' primary'), id: c.id + '-pick', text: c.baseUrl ? 'Choose usage-log folder…' : 'Choose folder…', onclick: () => this.pickFolderFor(c) }),
        el('button', { class: 'btn rescan', id: c.id + '-rescan', text: 'Re-scan', hidden: '', onclick: () => this.rescanFolder(c.id) }),
        el('progress', { id: c.id + '-progress', max: '100', value: '0', hidden: '' }),
        fb));
      const link = el('a', { href: '#', text: 'use the classic folder chooser' });
      link.addEventListener('click', (e) => { e.preventDefault(); fb.click(); });
      kids.push(el('div', { class: 'note' }, 'Files are read in your browser only. Looking for: ' + (c.hint || 'log files') + '. If the folder picker does not open, ', link, ' instead.'));
    }
    kids.push(el('div', { class: 'status', id: c.id + '-status', text: 'Not connected.' }));
    const L = c.links || {}, ln = [];
    if (L.get) ln.push(el('a', { href: L.get, target: '_blank', rel: 'noopener', text: 'Get it' }));
    if (L.docs) ln.push(el('a', { href: L.docs, target: '_blank', rel: 'noopener', text: 'Where the numbers come from' }));
    if (L.usage) ln.push(el('a', { href: L.usage, target: '_blank', rel: 'noopener', text: 'Vendor usage page' }));
    if (ln.length) { const row = el('div', { class: 'note links' }); ln.forEach((a, i) => { if (i) row.appendChild(document.createTextNode(' · ')); row.appendChild(a); }); kids.push(row); }
    const card = el('div', { class: 'card src generic', id: 'src-' + c.id, hidden: '' }, ...kids);
    $('sources').appendChild(card);   // NOT insertBefore($('src-import')): that card may be living inside the connector modal at the time → insertBefore would throw
  },
  /** Single scan entry point for folder-log connectors (folder pick, classic chooser, tests). files: [{path, file}]. */
  async scanFiles(c, files) {
    const status = $(c.id + '-status'), prog = $(c.id + '-progress');
    const gen = this._gen[c.id] = (this._gen[c.id] || 0) + 1;
    try {
      if (!files.length) { status.textContent = `No matching files found in that folder — expected ${c.hint || 'log files'}.`; return; }
      if (prog) { prog.hidden = false; prog.value = 0; prog.max = files.length; }
      document.querySelectorAll('.card').forEach(x => x.classList.add('stale'));
      const res = await parseFolderCached(c, files, (done, total) => { if (prog) { prog.max = total; prog.value = done; } }, ScanCache);
      if (gen !== this._gen[c.id]) return;   // superseded by a newer scan of this connector
      if (!res.meta.files) { status.textContent = `No matching files found — expected ${c.hint || 'log files'}.`; return; }
      Store.setSource(c.id, res.rows, { files: res.meta.files, msgs: res.meta.msgs, lines: res.meta.lines, badLines: res.meta.badLines });
      Store.setConnector(c.id, { label: `${res.meta.files} file${res.meta.files === 1 ? '' : 's'}`, lastSync: Date.now(), err: null });
      const rs = $(c.id + '-rescan'); if (rs) rs.hidden = !this._dirHandles[c.id];
      status.textContent = '';
      status.appendChild(el('span', { class: 'ok', text: '● Connected. ' }));
      const nf = res.meta.files, nm = res.meta.msgs;
      status.appendChild(document.createTextNode(`${nf} file${nf === 1 ? '' : 's'} · ${fmtInt(nm)} message${nm === 1 ? '' : 's'} · scanned ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
        + (res.meta.badLines ? ` · ${fmtInt(res.meta.badLines)} unreadable line(s) skipped` : '')));
      this.render();
    } catch (e) {
      if (gen !== this._gen[c.id]) return;
      Store.setConnector(c.id, { err: (e.message || String(e)).slice(0, 80) });
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
    const status = $(c.id + '-status');
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
      try {
        let perm = await h.queryPermission({ mode: 'read' });
        if (perm !== 'granted') perm = await h.requestPermission({ mode: 'read' });
        if (perm === 'granted') { await this.scanFolder(c, h); return; }
      } catch (e) { console.warn(e); }
    }
    return this.pickFolderFor(c);
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
          const s = $(c.id + '-status');
          if (s) s.textContent = Store.sources[c.id]
            ? `Showing saved data (${fmtInt(((Store.sources[c.id] || {}).meta || {}).msgs || 0)} messages). Click Re-scan to refresh from disk.`
            : 'Folder remembered — click Re-scan to grant access and load.';
        }
      } catch (e) { console.warn(e); }
    }
  },

```
Wiring edits:
  1. `syncConnector(id)`: the anchor is the two-line pair `    if (id === 'local') return this.rescan();\n    const c = connectorById(id);` (unique — `const c = connectorById(id);` alone occurs three times in `App`); directly after that pair insert `    if (c && c.kind === 'folder-log') return this.rescanFolder(id);`.
  2. `disconnectConnector(id)`: after `    if (id === 'local') { IDB.del('claudeDir'); this.dirHandle = null; }` insert
```js
    if (this._dirHandles[id]) { delete this._dirHandles[id]; IDB.del('dir:' + id); }
    if (c.kind === 'folder-log' || c.kind === 'local-server') { const rs = $(id + '-rescan'); if (rs) rs.hidden = true; const s = $(c.statusEl); if (s) s.textContent = 'Not connected.'; }
```
  3. `_restoreModalCard`: replace `if (/^src-(gemini|copilot|openrouter)$/.test(src.id) && !Store.connectors[src.id.slice(4)]) src.hidden = true;` with `if ((/^src-(gemini|copilot|openrouter)$/.test(src.id) || src.classList.contains('generic')) && !Store.connectors[src.id.slice(4)]) src.hidden = true;`.
  4. `renderHub` reveal loop: replace `    for (const id of ['gemini', 'copilot', 'openrouter']) {\n      const src = $('src-' + id);\n      if (src && src.parentNode !== $('modal-body')) src.hidden = !Store.connectors[id];\n    }` with
```js
    for (const c of CONNECTORS) {
      if (!/^(gemini|copilot|openrouter)$/.test(c.id) && c.kind !== 'folder-log' && c.kind !== 'local-server') continue;
      const src = $('src-' + c.id);
      if (src && src.parentNode !== $('modal-body')) src.hidden = !Store.connectors[c.id];
    }
```
  5. `refreshAll`: after `    if (this.dirHandle) jobs.push(this.rescan());` insert `    for (const [id, h] of Object.entries(this._dirHandles)) if (h) jobs.push(this.rescanFolder(id));`.
  6. `clear-data` handler: after `        Store.clearAll(); IDB.del('claudeDir'); this.dirHandle = null;` insert `        for (const id of Object.keys(this._dirHandles)) IDB.del('dir:' + id); this._dirHandles = {}; document.querySelectorAll('.src.generic .rescan').forEach(b => { b.hidden = true; });`.
  7. Init: after `    this.wireLegacyToggle();` insert `    for (const c of CONNECTORS) if (c.kind === 'folder-log' || c.kind === 'local-server') this.ensureSourceCard(c);` and after `    this.restoreHandle();` insert `    this.restoreFolderHandles();`.
  8. CSS after `.acct .badge { … }`: `.badge.q-exact { color: var(--good-text); } .badge.q-estimated { color: var(--serious); } .badge.q-none { color: var(--muted); } .src.generic .links a { white-space: nowrap; }`.

- [ ] **Step 6 — 98-hub generalization.** In `tests/checks/98-hub.mjs`, replace `    ok('hub: 7 account cards render from the registry', hub.n === 7 &&` with `    ok('hub: every registry card renders (baseline 7 ids present)', hub.n === hub.total &&` and add `total: CONNECTORS.length,` inside the returned object (after `n: cards.length,`). (Registry-driven assertion; the registry grows from T7 on.)

- [ ] **Step 7:** suite ×2 → green (96-scan-cache and 88-backlog-15/16 exercise `parseClaudeLogsCached` through the new driver: Map caches only see keys prefixed `local\u0001…`; the connector-scoped prune keeps their before/after counts 2 → 1). Byte scan → 0. Commit: `git add "AI Usage Dashboard.html" tests/fixtures/gen.mjs tests/checks/87-folder-logs.mjs tests/checks/98-hub.mjs && git commit -m "feat: generic folder-log driver - registry patterns/parser, per-connector cache + dir handles, generic source cards"`

---

### Task 7: Parser — OpenAI Codex CLI (delta-of-cumulative `token_count`)

**Files:** Modify `AI Usage Dashboard.html`, `tests/fixtures/gen.mjs`, `tests/checks/87-folder-logs.mjs`

Research row: `%USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-<timestamp>-<uuid>.jsonl` (+ `archived_sessions/`; `CODEX_HOME` overrides). Records with `type:"event_msg"` and `payload.type:"token_count"` hold `payload.info.total_token_usage {input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}` — **cumulative per session → take deltas**; `payload.info` may be `null` (rate-limit-only snapshot). Model from `turn_context` / `session_meta` payloads. `cached_input_tokens` is a subset of `input_tokens`; `reasoning_output_tokens` is a subset of `output_tokens`. Cache-write tokens are not recorded. Quality **exact**.

- [ ] **Step 1 — fixture.** Append inside `generate()`:

```js
  // T7 — Codex CLI rollout. Cumulative snapshots (in,cached,out): (100,0,50) → (250,100,80) → same again (dup) → (400,200,130); one info:null snapshot; one bad line.
  // Expected deltas: in = (100-0)+(150-100)+(150-100) = 200 · cr = 0+100+100 = 200 · out = 50+30+50 = 130 · msgs=3 · badLines=1 · lines=8 · model gpt-5.4-codex
  const tk = (i, c, o, r) => ({ input_tokens: i, cached_input_tokens: c, output_tokens: o, reasoning_output_tokens: r, total_tokens: i + o });
  w('codex/sessions/2026/08/10/rollout-2026-08-10T09-00-00-abc.jsonl', [
    jl({ timestamp: '2026-08-10T09:00:00.000Z', type: 'session_meta', payload: { id: 'abc', cwd: 'D:\\proj1', cli_version: '0.40.0', originator: 'codex_cli_rs' } }),
    jl({ timestamp: '2026-08-10T09:00:01.000Z', type: 'turn_context', payload: { cwd: 'D:\\proj1', model: 'gpt-5.4-codex', approval_policy: 'on-request' } }),
    jl({ timestamp: '2026-08-10T09:01:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: tk(100, 0, 50, 10), last_token_usage: tk(100, 0, 50, 10) } } }),
    jl({ timestamp: '2026-08-10T09:05:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: tk(250, 100, 80, 20), last_token_usage: tk(150, 100, 30, 10) } } }),
    jl({ timestamp: '2026-08-10T09:05:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: tk(250, 100, 80, 20), last_token_usage: tk(150, 100, 30, 10) } } }),   // duplicate snapshot → delta 0
    'not json at all',
    jl({ timestamp: '2026-08-10T21:10:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: tk(400, 200, 130, 40), last_token_usage: tk(150, 100, 50, 20) } } }),
    jl({ timestamp: '2026-08-10T21:10:05.000Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 12 } } } }),   // rate-limit-only snapshot → skipped, not malformed
  ].join('\n') + '\n');
```

- [ ] **Step 2 — failing check.** Append inside 87-folder-logs' `try`:

```js
    // ---- T7: OpenAI Codex CLI ----
    const codexText = read('codex', 'sessions', '2026', '08', '10', 'rollout-2026-08-10T09-00-00-abc.jsonl');
    const cx = await page.evaluate(async (text) => {
      const c = connectorById('codex');
      const res = await parseCodexRollouts([{ path: 'sessions/2026/08/10/rollout-2026-08-10T09-00-00-abc.jsonl', file: new File([text], 'rollout-2026-08-10T09-00-00-abc.jsonl') }], null, new Set(), c);
      const t = res.rows.reduce((a, r) => ({ in: a.in + r.in, cr: a.cr + r.cr, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, cr: 0, out: 0, msgs: 0 });
      const hours = [...new Set(res.rows.map(r => r.hour))].sort((a, b) => a - b);
      const expHours = [...new Set([new Date('2026-08-10T09:01:00.000Z').getHours(), new Date('2026-08-10T21:10:00.000Z').getHours()])].sort((a, b) => a - b);
      App.renderHub();
      return { ...t, badLines: res.meta.badLines, lines: res.meta.lines, models: [...new Set(res.rows.map(r => r.model))], platforms: [...new Set(res.rows.map(r => r.platform))], hours, expHours,
        sid: res.rows[0] && res.rows[0].sid, card: !!document.getElementById('src-codex'), cat: c && c.category, kind: c && c.kind, quality: c && c.quality,
        hub: !!document.querySelector('#accounts-hub .hub-group[data-group="coding"] .acct[data-connector="codex"]') };
    }, codexText);
    ok('codex: delta-of-cumulative token_count → in=200 cr=200 out=130 msgs=3; duplicate snapshot + info:null skipped; 1 bad line; hours + sid kept',
      cx.in === 200 && cx.cr === 200 && cx.out === 130 && cx.msgs === 3 && cx.badLines === 1 && cx.lines === 8 && cx.models.length === 1 && cx.models[0] === 'gpt-5.4-codex'
      && cx.platforms.length === 1 && cx.platforms[0] === 'OpenAI Codex CLI' && JSON.stringify(cx.hours) === JSON.stringify(cx.expHours) && cx.sid === 'rollout-2026-08-10T09-00-00-abc', JSON.stringify(cx));
    ok('codex: registry entry is a folder-log coding tool with an exact-quality generic card in the Coding group', cx.card && cx.cat === 'coding' && cx.kind === 'folder-log' && cx.quality === 'exact' && cx.hub, JSON.stringify(cx));
```

RED: `parseCodexRollouts is not defined`.

- [ ] **Step 3 — registry entry.** Insert directly BEFORE the `imports` entry (`  { id: 'imports',`):

```js
  // ---- Wave 1 folder-log connectors (generic driver; one parser each) ----
  { id: 'codex', platform: 'OpenAI Codex CLI', name: 'OpenAI Codex CLI', category: 'coding', kind: 'folder-log',
    statusEl: 'codex-status', brand: '#10a37f', mark: 'Cx', srcIds: ['codex'],
    patterns: [/(^|\/)rollout-[^/]*\.jsonl$/i], parser: 'parseCodexRollouts', hint: 'rollout-*.jsonl session files (sessions/YYYY/MM/DD/)',
    quality: 'exact',
    qualityNote: 'Exact tokens from Codex CLI session rollouts: token_count events carry cumulative input / cached-input / output / reasoning totals per session — the parser takes deltas, so re-scans never double count. Cache-write tokens are not recorded by Codex; ChatGPT-plan usage has no dollar value, so cost here is API-equivalent at list prices. Pick ~/.codex (sessions + archived_sessions are both read).',
    paths: ['%USERPROFILE%\\.codex\\sessions\\YYYY\\MM\\DD\\rollout-*.jsonl (Windows)', '~/.codex/sessions/… (macOS/Linux)', 'CODEX_HOME overrides ~/.codex'],
    links: { get: 'https://github.com/openai/codex', docs: 'https://ccusage.com/guide/codex/', usage: 'https://platform.openai.com/usage' } },
```

- [ ] **Step 4 — parser.** Insert after `parseUsageLoggerJsonl`:

```js
/* =================================================================
 * Folder-log parsers (Wave 1). Contract: async (files, onProgress, seen, connector, siblingFiles)
 *   → { rows, projects, meta: { files, msgs, lines, badLines, addedIds } }   (parseClaudeLogs' shape)
 * Whole-file JSON formats count files as `lines` and unparseable files as `badLines`.
 * ================================================================= */
/** OpenAI Codex CLI — ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. token_count events are CUMULATIVE per
 *  session: rows are the deltas between consecutive snapshots (a repeated/identical snapshot → delta 0 → skipped;
 *  a counter that goes backwards = new session/reset → counted from zero). cached_input_tokens ⊂ input_tokens,
 *  reasoning_output_tokens ⊂ output_tokens. Model = latest turn_context/session_meta model. */
async function parseCodexRollouts(files, onProgress, seen = new Set()) {
  const agg = makeAgg(); let msgs = 0; const k = { lines: 0, badLines: 0 };
  const list = files.filter(f => /(^|\/)rollout-[^/]*\.jsonl$/i.test(f.path));
  for (let fi = 0; fi < list.length; fi++) {
    const { path, file } = list[fi];
    const sid = (path.split('/').pop() || '').replace(/\.jsonl$/i, '');
    let model = 'codex', prev = null;
    await eachJsonl(file, (o) => {
      const p = o.payload || {};
      if (o.type === 'session_meta' || o.type === 'turn_context') { if (p.model) model = String(p.model); return; }
      if (o.type !== 'event_msg' || p.type !== 'token_count' || !p.info || !p.info.total_token_usage) return;
      const u = p.info.total_token_usage;
      const cur = { in: finTok(+u.input_tokens || 0), cr: finTok(+u.cached_input_tokens || 0), out: finTok(+u.output_tokens || 0) };
      const base = prev && cur.in >= prev.in && cur.out >= prev.out ? prev : { in: 0, cr: 0, out: 0 };
      const d = { in: cur.in - base.in, cr: Math.max(0, cur.cr - base.cr), out: cur.out - base.out };
      prev = cur;
      if (d.in <= 0 && d.out <= 0) return;   // no new usage since the last snapshot (duplicate line / heartbeat)
      const ts = o.timestamp ? new Date(o.timestamp) : null, okTs = ts && !isNaN(ts);
      agg.add(dayKey(okTs ? ts : file.lastModified), 'OpenAI Codex CLI', model,
        { in: Math.max(0, d.in - d.cr), cr: d.cr, out: Math.max(0, d.out), msgs: 1 }, sid, okTs ? ts.getHours() : undefined);
      msgs++;
    }, k);
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: [], meta: { files: list.length, msgs, lines: k.lines, badLines: k.badLines, addedIds: [] } };
}
```

- [ ] **Step 5:** suite ×2 → green (85-hub-groups' `n === total` and 98-hub's `n === CONNECTORS.length` absorb the new entry). Commit: `git add "AI Usage Dashboard.html" tests/fixtures/gen.mjs tests/checks/87-folder-logs.mjs && git commit -m "feat: OpenAI Codex CLI folder-log parser (delta of cumulative token_count)"`

---

### Task 8: Parser — Gemini CLI sessions

**Files:** Modify `AI Usage Dashboard.html`, `tests/fixtures/gen.mjs`, `tests/checks/87-folder-logs.mjs`

Research row: `%USERPROFILE%\.gemini\tmp\<project_hash>\chats\session-*.json` (`GEMINI_CLI_HOME` overrides; auto-pruned 30 d / 50 files). Docs say sessions record "token usage statistics (input, output, cached, etc.)" but do not enumerate field names → **sniff defensively**: the recorder writes `messages[]` with `type: 'user' | 'gemini'`, `timestamp`, `model`, and `tokens: { input, output, cached, thoughts, tool, total }`; the parser also accepts a raw `usageMetadata {promptTokenCount, candidatesTokenCount, cachedContentTokenCount, thoughtsTokenCount}`. `input` includes `cached`; thoughts are billed as output. Quality **exact**.

- [ ] **Step 1 — fixture.**

```js
  // T8 — Gemini CLI session. Expected: in = (1000-200)+(2000-1500)+(500-0) = 1800 · cr = 200+1500 = 1700 · out = (300+50)+(100+0)+(20+0) = 470 · msgs=3 (g2 dup by id skipped; g3 has no tokens) · files=2 badLines=1
  const gmsg = (id, ts, model, t) => ({ id, timestamp: ts, type: 'gemini', content: 'reply ' + id, model, tokens: t });
  w('gemini/tmp/abc123/chats/session-2026-08-10T09-00-aaaa.json', JSON.stringify({
    sessionId: 'aaaa', projectHash: 'abc123', startTime: '2026-08-10T09:00:00.000Z', lastUpdated: '2026-08-11T08:00:00.000Z',
    messages: [
      { id: 'u1', timestamp: '2026-08-10T09:00:00.000Z', type: 'user', content: 'hi' },
      gmsg('g1', '2026-08-10T09:00:05.000Z', 'gemini-3-pro', { input: 1000, output: 300, cached: 200, thoughts: 50, tool: 0, total: 1350 }),
      gmsg('g2', '2026-08-10T09:10:00.000Z', 'gemini-3-pro', { input: 2000, output: 100, cached: 1500, thoughts: 0, tool: 0, total: 2100 }),
      gmsg('g2', '2026-08-10T09:10:00.000Z', 'gemini-3-pro', { input: 2000, output: 100, cached: 1500, thoughts: 0, tool: 0, total: 2100 }),   // duplicate id
      { id: 'g3', timestamp: '2026-08-10T21:00:00.000Z', type: 'gemini', content: 'no token stats recorded' },
      gmsg('g4', '2026-08-11T08:00:00.000Z', 'gemini-3-flash', { input: 500, output: 20, cached: 0, thoughts: 0, tool: 0, total: 520 }),
    ] }, null, 1));
  w('gemini/tmp/abc123/chats/session-bad.json', '{ this is not json');
```

- [ ] **Step 2 — failing check.**

```js
    // ---- T8: Gemini CLI ----
    const gemA = read('gemini', 'tmp', 'abc123', 'chats', 'session-2026-08-10T09-00-aaaa.json'), gemB = read('gemini', 'tmp', 'abc123', 'chats', 'session-bad.json');
    const gc = await page.evaluate(async (a, b) => {
      const c = connectorById('gemini-cli');
      const res = await parseGeminiCliSessions([
        { path: 'tmp/abc123/chats/session-2026-08-10T09-00-aaaa.json', file: new File([a], 'session-2026-08-10T09-00-aaaa.json') },
        { path: 'tmp/abc123/chats/session-bad.json', file: new File([b], 'session-bad.json') }], null, new Set(), c);
      const t = res.rows.reduce((x, r) => ({ in: x.in + r.in, cr: x.cr + r.cr, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, cr: 0, out: 0, msgs: 0 });
      return { ...t, files: res.meta.files, badLines: res.meta.badLines, models: [...new Set(res.rows.map(r => r.model))].sort(), platform: res.rows[0].platform,
        hourOk: res.rows.some(r => r.hour === new Date('2026-08-10T09:00:05.000Z').getHours()), sid: res.rows[0].sid, ids: res.meta.addedIds.length, kind: c.kind, cat: c.category, card: !!document.getElementById('src-gemini-cli') };
    }, gemA, gemB);
    ok('gemini-cli: session JSON → in=1800 cr=1700 out=470 msgs=3 (dup id + token-less message skipped); malformed file counted as badLines',
      gc.in === 1800 && gc.cr === 1700 && gc.out === 470 && gc.msgs === 3 && gc.files === 2 && gc.badLines === 1 && JSON.stringify(gc.models) === JSON.stringify(['gemini-3-flash', 'gemini-3-pro'])
      && gc.platform === 'Gemini CLI' && gc.hourOk && gc.sid === 'aaaa' && gc.ids === 3 && gc.kind === 'folder-log' && gc.cat === 'coding' && gc.card, JSON.stringify(gc));
```

RED: `parseGeminiCliSessions is not defined`.

- [ ] **Step 3 — registry entry** (after the `codex` entry):

```js
  { id: 'gemini-cli', platform: 'Gemini CLI', name: 'Gemini CLI', category: 'coding', kind: 'folder-log',
    statusEl: 'gemini-cli-status', brand: '#4285f4', mark: 'Gc', srcIds: ['gemini-cli'],
    patterns: [/(^|\/)session-[^/]*\.json$/i], parser: 'parseGeminiCliSessions', hint: 'chats/session-*.json files (pick ~/.gemini or ~/.gemini/tmp)',
    quality: 'exact',
    qualityNote: 'Exact tokens from Gemini CLI\'s auto-recorded sessions (session-*.json: per-response input / output / cached / thoughts counts and model). Google\'s docs do not publish the field names, so the parser sniffs tokens{} (and usageMetadata{}) defensively. Sessions auto-prune after 30 days / 50 files by default — import regularly. Cost is API-equivalent at list prices (Code Assist quota is not exposed).',
    paths: ['%USERPROFILE%\\.gemini\\tmp\\<project_hash>\\chats\\session-*.json (Windows)', '~/.gemini/tmp/<hash>/chats/ (macOS/Linux)', 'GEMINI_CLI_HOME overrides ~/.gemini'],
    links: { get: 'https://github.com/google-gemini/gemini-cli', docs: 'https://geminicli.com/docs/cli/session-management/' } },
```

- [ ] **Step 4 — parser** (after `parseCodexRollouts`):

```js
/** Gemini CLI — ~/.gemini/tmp/<hash>/chats/session-*.json (whole-file JSON). messages[] of type 'gemini' carry
 *  tokens {input, output, cached, thoughts, tool, total} (input includes cached; thoughts bill as output) — or,
 *  defensively, usageMetadata {promptTokenCount, candidatesTokenCount, cachedContentTokenCount, thoughtsTokenCount}.
 *  Dedupe by sessionId:messageId. */
async function parseGeminiCliSessions(files, onProgress, seen = new Set()) {
  const agg = makeAgg(); const addedIds = []; let msgs = 0, lines = 0, badLines = 0;
  const list = files.filter(f => /(^|\/)session-[^/]*\.json$/i.test(f.path));
  for (let fi = 0; fi < list.length; fi++) {
    const { path, file } = list[fi];
    let obj; try { obj = JSON.parse(await file.text()); } catch { badLines++; continue; }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.messages)) { badLines++; continue; }
    lines++;
    const sid = String(obj.sessionId || (path.split('/').pop() || '').replace(/\.json$/i, ''));
    for (const m of obj.messages) {
      if (!m || m.type === 'user') continue;
      const um = m.usageMetadata;
      const t = m.tokens || (um ? { input: um.promptTokenCount, output: um.candidatesTokenCount, cached: um.cachedContentTokenCount, thoughts: um.thoughtsTokenCount } : null);
      if (!t) continue;
      if (m.id != null) { const id = sid + ':' + m.id; if (seen.has(id)) continue; seen.add(id); addedIds.push(id); }
      const input = finTok(+t.input || 0), cached = finTok(+t.cached || 0), output = finTok(+t.output || 0), thoughts = finTok(+t.thoughts || 0);
      const ts = m.timestamp ? new Date(m.timestamp) : null, okTs = ts && !isNaN(ts);
      agg.add(dayKey(okTs ? ts : file.lastModified), 'Gemini CLI', String(m.model || obj.model || 'gemini'),
        { in: Math.max(0, input - cached), cr: cached, out: output + thoughts, msgs: 1 }, sid, okTs ? ts.getHours() : undefined);
      msgs++;
    }
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: [], meta: { files: list.length, msgs, lines, badLines, addedIds } };
}
```

- [ ] **Step 5:** suite ×2 → green. Commit: `git add "AI Usage Dashboard.html" tests/fixtures/gen.mjs tests/checks/87-folder-logs.mjs && git commit -m "feat: Gemini CLI session parser"`

---

### Task 9: Parser — GitHub Copilot CLI `events.jsonl` (separate `copilot-cli` entry, same platform)

**Files:** Modify `AI Usage Dashboard.html`, `tests/fixtures/gen.mjs`, `tests/checks/87-folder-logs.mjs`

Research row: `%USERPROFILE%\.copilot\session-state\<session-id>\events.jsonl` — `assistant.usage` events carry server-reported input / output / cache-read / cache-write tokens + model; `session.shutdown` carries per-model totals (`modelMetrics.<model>.requests.{count,cost}` / `.usage.*`). Documented by GitHub; exact field paths come from third-party parsers → tolerant parser. The existing `copilot` connector keeps its PAT billing path; `copilot-cli` is a **separate registry entry with the same `platform: 'GitHub Copilot'`** so both aggregate under one platform (T5's `hubCard` already switches to source-membership stats for shared platforms; `PLATFORM_ORDER` is deduped since T6). Quality **exact**.

- [ ] **Step 1 — fixture.**

```js
  // T9 — Copilot CLI events. sess-1: 3 assistant.usage (e3 duplicated by id → skipped) + 1 bad line + session.shutdown that must NOT double count.
  //   sess-1 expected: in=1200+800+100=2100 cw=100 cr=900 out=300+150+40=490 msgs=3 badLines=1
  //   sess-2: shutdown-only file → fallback to modelMetrics: in=50 out=10 msgs=2. Both files: in=2150 cw=100 cr=900 out=500 msgs=5
  const cu = (id, ts, model, d) => jl({ id, type: 'assistant.usage', timestamp: ts, data: { model, ...d } });
  w('copilot/session-state/sess-1/events.jsonl', [
    jl({ id: 'e1', type: 'session.start', timestamp: '2026-08-10T09:00:00.000Z', data: { sessionId: 'sess-1' } }),
    cu('e2', '2026-08-10T09:01:00.000Z', 'claude-sonnet-4.5', { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 900, cacheWriteTokens: 100, cost: 1 }),
    cu('e3', '2026-08-10T09:02:00.000Z', 'claude-sonnet-4.5', { inputTokens: 800, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 1 }),
    cu('e3', '2026-08-10T09:02:00.000Z', 'claude-sonnet-4.5', { inputTokens: 800, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 1 }),   // duplicate id
    'oops not json',
    cu('e4', '2026-08-10T21:00:00.000Z', 'gpt-5.4', { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 }),
    jl({ id: 'e5', type: 'session.shutdown', timestamp: '2026-08-10T21:05:00.000Z', data: { modelMetrics: {
      'claude-sonnet-4.5': { requests: { count: 2, cost: 2 }, usage: { inputTokens: 2000, outputTokens: 450, cacheReadTokens: 900, cacheWriteTokens: 100 } },
      'gpt-5.4': { requests: { count: 1, cost: 0 }, usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 } } } } }),
  ].join('\n') + '\n');
  w('copilot/session-state/sess-2/events.jsonl', [
    jl({ id: 'f1', type: 'session.start', timestamp: '2026-08-11T10:00:00.000Z', data: { sessionId: 'sess-2' } }),
    jl({ id: 'f2', type: 'session.shutdown', timestamp: '2026-08-11T10:20:00.000Z', data: { modelMetrics: { 'gpt-5.4': { requests: { count: 2, cost: 0 }, usage: { inputTokens: 50, outputTokens: 10 } } } } }),
  ].join('\n') + '\n');
```

- [ ] **Step 2 — failing check.**

```js
    // ---- T9: GitHub Copilot CLI ----
    const cp1 = read('copilot', 'session-state', 'sess-1', 'events.jsonl'), cp2 = read('copilot', 'session-state', 'sess-2', 'events.jsonl');
    const cpc = await page.evaluate(async (a, b) => {
      const c = connectorById('copilot-cli');
      const files = [{ path: 'session-state/sess-1/events.jsonl', file: new File([a], 'events.jsonl') }, { path: 'session-state/sess-2/events.jsonl', file: new File([b], 'events.jsonl') }];
      const res = await parseCopilotCliEvents(files, null, new Set(), c);
      const t = res.rows.reduce((x, r) => ({ in: x.in + r.in, cw: x.cw + r.cw, cr: x.cr + r.cr, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });
      // both copilot connectors share the platform: hub stats must come from each card's OWN source rows
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      Store.setSource('copilot-cli', res.rows.map(r => ({ ...r, d: dayKey(new Date()) })), {});
      Store.setConnector('copilot-cli', { label: '2 files', lastSync: Date.now(), err: null });
      Store.setSource('copilot', [{ d: dayKey(new Date()), platform: 'GitHub Copilot', model: 'copilot_premium_request', in: 0, cw: 0, cr: 0, out: 0, msgs: 7, est: 1 }], {});
      Store.setConnector('copilot', { label: 'alaa-dev', lastSync: Date.now(), err: null });
      App.renderHub();
      const cliStats = document.querySelector('#accounts-hub .acct[data-connector="copilot-cli"] .acct-stats').textContent;
      const patStats = document.querySelector('#accounts-hub .acct[data-connector="copilot"] .acct-stats').textContent;
      const chips = [...document.querySelectorAll('#platform-chips .chip')].filter(ch => /GitHub Copilot/.test(ch.textContent)).length;
      Store.sources = {}; Store.connectors = {}; Store.persist();
      return { ...t, badLines: res.meta.badLines, platform: c.platform, samePlatform: c.platform === connectorById('copilot').platform, sids: [...new Set(res.rows.map(r => r.sid))].sort(),
        cliStats, patStats, chipsBefore: chips, kind: c.kind, cat: c.category, card: !!document.getElementById('src-copilot-cli') };
    }, cp1, cp2);
    ok('copilot-cli: assistant.usage rows (dup id skipped, shutdown not double-counted) + shutdown-only fallback → in=2150 cw=100 cr=900 out=500 msgs=5; 1 bad line',
      cpc.in === 2150 && cpc.cw === 100 && cpc.cr === 900 && cpc.out === 500 && cpc.msgs === 5 && cpc.badLines === 1 && JSON.stringify(cpc.sids) === JSON.stringify(['sess-1', 'sess-2']), JSON.stringify(cpc));
    ok('copilot-cli: separate registry entry on the shared "GitHub Copilot" platform; hub cards show their own source stats',
      cpc.platform === 'GitHub Copilot' && cpc.samePlatform && cpc.kind === 'folder-log' && cpc.cat === 'coding' && cpc.card && /tokens/.test(cpc.cliStats) && cpc.cliStats !== cpc.patStats, JSON.stringify({ cli: cpc.cliStats, pat: cpc.patStats }));
```
(The `chipsBefore` value is informational; `renderChips` runs on `_render`, not `renderHub` — leave it out of the assertion.)

RED: `parseCopilotCliEvents is not defined`.

- [ ] **Step 3 — registry entry** (after `gemini-cli`):

```js
  { id: 'copilot-cli', platform: 'GitHub Copilot', name: 'GitHub Copilot CLI (logs)', category: 'coding', kind: 'folder-log',
    statusEl: 'copilot-cli-status', brand: '#8957e5', mark: 'Cl', srcIds: ['copilot-cli'],
    patterns: [/(^|\/)events\.jsonl$/i], parser: 'parseCopilotCliEvents', hint: 'session-state/<session-id>/events.jsonl (pick ~/.copilot)',
    quality: 'exact',
    qualityNote: 'Exact tokens from Copilot CLI session events (events.jsonl: assistant.usage carries server-reported input / output / cache-read / cache-write tokens and model; session.shutdown holds per-model totals, used only when a session has no per-request events). Documented by GitHub; the exact field paths were verified against third-party parsers, so the parser is tolerant. This is separate from the GitHub Copilot billing card (PAT) — both roll up under the GitHub Copilot platform. VS Code Copilot Chat has no local token log unless you enable its OTel file export (Wave 2 parser).',
    paths: ['%USERPROFILE%\\.copilot\\session-state\\<session-id>\\events.jsonl (Windows)', '~/.copilot/session-state/… (macOS/Linux)'],
    links: { get: 'https://github.com/github/copilot-cli', docs: 'https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle', usage: 'https://github.com/settings/billing' } },
```

- [ ] **Step 4 — parser** (after `parseGeminiCliSessions`):

```js
/** GitHub Copilot CLI — ~/.copilot/session-state/<sid>/events.jsonl. Per-request `assistant.usage` events
 *  (data.model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens; camelCase or snake_case) are the
 *  source of truth; `session.shutdown` data.modelMetrics is used ONLY when a file has no usage events at all
 *  (older CLIs / crashed sessions), as one row per model with msgs = requests.count. Dedupe by sid:eventId. */
async function parseCopilotCliEvents(files, onProgress, seen = new Set()) {
  const agg = makeAgg(); const addedIds = []; let msgs = 0; const k = { lines: 0, badLines: 0 };
  const list = files.filter(f => /(^|\/)events\.jsonl$/i.test(f.path));
  const num = (o, a, b) => finTok(+(o[a] ?? o[b] ?? 0) || 0);
  for (let fi = 0; fi < list.length; fi++) {
    const { path, file } = list[fi];
    const parts = path.split('/'); const sid = parts.length > 1 ? parts[parts.length - 2] : (path.replace(/\.jsonl$/i, ''));
    let usageEvents = 0; const shutdowns = [];
    await eachJsonl(file, (o) => {
      const d = o.data || o.payload || o;
      const type = String(o.type || o.event || '');
      if (type === 'assistant.usage') {
        if (o.id != null) { const id = sid + ':' + o.id; if (seen.has(id)) return; seen.add(id); addedIds.push(id); }
        const ts = o.timestamp ? new Date(o.timestamp) : null, okTs = ts && !isNaN(ts);
        agg.add(dayKey(okTs ? ts : file.lastModified), 'GitHub Copilot', String(d.model || 'copilot'),
          { in: num(d, 'inputTokens', 'input_tokens'), out: num(d, 'outputTokens', 'output_tokens'), cr: num(d, 'cacheReadTokens', 'cache_read_tokens'), cw: num(d, 'cacheWriteTokens', 'cache_write_tokens'), msgs: 1 },
          sid, okTs ? ts.getHours() : undefined);
        msgs++; usageEvents++;
      } else if (type === 'session.shutdown' && d.modelMetrics && typeof d.modelMetrics === 'object') {
        shutdowns.push({ ts: o.timestamp, metrics: d.modelMetrics });
      }
    }, k);
    if (!usageEvents) for (const s of shutdowns) {
      const ts = s.ts ? new Date(s.ts) : null, okTs = ts && !isNaN(ts);
      for (const [model, m] of Object.entries(s.metrics)) {
        const u = (m && m.usage) || {}, n = finTok(+((m && m.requests && m.requests.count) ?? 1) || 0) || 1;
        agg.add(dayKey(okTs ? ts : file.lastModified), 'GitHub Copilot', model,
          { in: num(u, 'inputTokens', 'input_tokens'), out: num(u, 'outputTokens', 'output_tokens'), cr: num(u, 'cacheReadTokens', 'cache_read_tokens'), cw: num(u, 'cacheWriteTokens', 'cache_write_tokens'), msgs: n }, sid, okTs ? ts.getHours() : undefined);
        msgs += n;
      }
    }
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: [], meta: { files: list.length, msgs, lines: k.lines, badLines: k.badLines, addedIds } };
}
```

- [ ] **Step 5:** suite ×2 → green (99-connectors' `copilot` PAT checks untouched; the `platforms.length === 1` assertion there still holds because both entries share the string). Commit: `git add "AI Usage Dashboard.html" tests/fixtures/gen.mjs tests/checks/87-folder-logs.mjs && git commit -m "feat: GitHub Copilot CLI events.jsonl parser (separate copilot-cli entry, shared platform)"`

---

### Task 10: Parser — Continue.dev `tokensGenerated.jsonl`

**Files:** Modify `AI Usage Dashboard.html`, `tests/fixtures/gen.mjs`, `tests/checks/87-folder-logs.mjs`

Research row: `%USERPROFILE%\.continue\dev_data\<schemaVersion e.g. 0.2.0>\tokensGenerated.jsonl` (also `chatInteraction.jsonl`, `autocomplete.jsonl` — not token sources). Events: `promptTokens`, `generatedTokens`, `model`, `provider`, `timestamp` (on by default). Counts come from the provider response (some providers/Ollama estimate). No cost in the file. Quality **exact**.

- [ ] **Step 1 — fixture.**

```js
  // T10 — Continue dev_data. Expected: in=1500+700+300=2500 out=200+50+30=280 msgs=3 badLines=1; chatInteraction.jsonl must be ignored by the pattern.
  w('continue/dev_data/0.2.0/tokensGenerated.jsonl', [
    jl({ eventName: 'tokensGenerated', schema: '0.2.0', timestamp: '2026-08-10T09:00:00.000Z', model: 'claude-sonnet-4.5', provider: 'anthropic', promptTokens: 1500, generatedTokens: 200, userId: 'u', selectedProfileId: 'local' }),
    jl({ eventName: 'tokensGenerated', schema: '0.2.0', timestamp: '2026-08-10T09:30:00.000Z', model: 'claude-sonnet-4.5', provider: 'anthropic', promptTokens: 700, generatedTokens: 50, userId: 'u', selectedProfileId: 'local' }),
    '{"eventName":"tokensGenerated","schema":"0.2.0","timestamp":"2026-08-10T10:00:00.000Z","model":"gpt-5.4","promptTokens":',   // truncated line
    jl({ eventName: 'tokensGenerated', schema: '0.2.0', timestamp: '2026-08-11T21:00:00.000Z', model: 'qwen3:14b', provider: 'ollama', promptTokens: 300, generatedTokens: 30, userId: 'u', selectedProfileId: 'local' }),
  ].join('\n') + '\n');
  w('continue/dev_data/0.2.0/chatInteraction.jsonl', jl({ eventName: 'chatInteraction', schema: '0.2.0', timestamp: '2026-08-10T09:00:00.000Z', model: 'claude-sonnet-4.5', prompt: 'hi', completion: 'hello' }) + '\n');
```

- [ ] **Step 2 — failing check.**

```js
    // ---- T10: Continue.dev ----
    const ctA = read('continue', 'dev_data', '0.2.0', 'tokensGenerated.jsonl'), ctB = read('continue', 'dev_data', '0.2.0', 'chatInteraction.jsonl');
    const ct = await page.evaluate(async (a, b) => {
      const c = connectorById('continue');
      const files = [{ path: 'dev_data/0.2.0/tokensGenerated.jsonl', file: new File([a], 'tokensGenerated.jsonl') }, { path: 'dev_data/0.2.0/chatInteraction.jsonl', file: new File([b], 'chatInteraction.jsonl') }];
      const direct = await parseContinueDevData(files, null, new Set(), c);
      const viaDriver = await parseFolderCached(c, files, null, new Map());   // pattern filter must drop chatInteraction.jsonl
      const t = direct.rows.reduce((x, r) => ({ in: x.in + r.in, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, out: 0, msgs: 0 });
      return { ...t, badLines: direct.meta.badLines, files: direct.meta.files, driverFiles: viaDriver.meta.files, models: [...new Set(direct.rows.map(r => r.model))].sort(), platform: direct.rows[0].platform,
        hourOk: direct.rows.some(r => r.hour === new Date('2026-08-11T21:00:00.000Z').getHours()), kind: c.kind, cat: c.category, card: !!document.getElementById('src-continue') };
    }, ctA, ctB);
    ok('continue: tokensGenerated.jsonl → in=2500 out=280 msgs=3 (1 truncated line); other dev_data files ignored by the pattern',
      ct.in === 2500 && ct.out === 280 && ct.msgs === 3 && ct.badLines === 1 && ct.files === 1 && ct.driverFiles === 1 && JSON.stringify(ct.models) === JSON.stringify(['claude-sonnet-4.5', 'qwen3:14b'])
      && ct.platform === 'Continue.dev' && ct.hourOk && ct.kind === 'folder-log' && ct.cat === 'coding' && ct.card, JSON.stringify(ct));
```

RED: `parseContinueDevData is not defined`.

- [ ] **Step 3 — registry entry** (after `copilot-cli`):

```js
  { id: 'continue', platform: 'Continue.dev', name: 'Continue.dev', category: 'coding', kind: 'folder-log',
    statusEl: 'continue-status', brand: '#5b8def', mark: 'Co', srcIds: ['continue'],
    patterns: [/(^|\/)tokensGenerated\.jsonl$/i], parser: 'parseContinueDevData', hint: 'dev_data/<version>/tokensGenerated.jsonl (pick ~/.continue)',
    quality: 'exact',
    qualityNote: 'Exact tokens from Continue\'s development data (dev_data/<schemaVersion>/tokensGenerated.jsonl: promptTokens, generatedTokens, model, provider, timestamp — written locally, on by default). Counts come from each provider\'s response; some providers (and Ollama) report estimates. The file has no cost — cost here is API-equivalent at list prices. Other dev_data files (chatInteraction, autocomplete) carry no token counts and are ignored.',
    paths: ['%USERPROFILE%\\.continue\\dev_data\\<schemaVersion>\\tokensGenerated.jsonl (Windows)', '~/.continue/dev_data/… (macOS/Linux)'],
    links: { get: 'https://continue.dev', docs: 'https://docs.continue.dev/customize/deep-dives/development-data' } },
```

- [ ] **Step 4 — parser** (after `parseCopilotCliEvents`):

```js
/** Continue.dev — ~/.continue/dev_data/<ver>/tokensGenerated.jsonl: one event per model response
 *  {promptTokens, generatedTokens, model, provider, timestamp}. No ids → no dedupe (each event is one request). */
async function parseContinueDevData(files, onProgress) {
  const agg = makeAgg(); let msgs = 0; const k = { lines: 0, badLines: 0 };
  const list = files.filter(f => /(^|\/)tokensGenerated\.jsonl$/i.test(f.path));
  for (let fi = 0; fi < list.length; fi++) {
    const { file } = list[fi];
    await eachJsonl(file, (o) => {
      if (o.promptTokens == null && o.generatedTokens == null) return;
      const ts = o.timestamp ? new Date(o.timestamp) : null, okTs = ts && !isNaN(ts);
      agg.add(dayKey(okTs ? ts : file.lastModified), 'Continue.dev', String(o.model || 'unknown'),
        { in: finTok(+o.promptTokens || 0), out: finTok(+o.generatedTokens || 0), msgs: 1 }, undefined, okTs ? ts.getHours() : undefined);
      msgs++;
    }, k);
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: [], meta: { files: list.length, msgs, lines: k.lines, badLines: k.badLines, addedIds: [] } };
}
```

- [ ] **Step 5:** suite ×2 → green. Commit: `git add "AI Usage Dashboard.html" tests/fixtures/gen.mjs tests/checks/87-folder-logs.mjs && git commit -m "feat: Continue.dev tokensGenerated parser"`

---

### Task 11: Parser — Cline + Roo Code (shared parser, two entries)

**Files:** Modify `AI Usage Dashboard.html`, `tests/fixtures/gen.mjs`, `tests/checks/87-folder-logs.mjs`

Research row: Cline `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\tasks\<taskId>\ui_messages.json` (+ `task_metadata.json`, `api_conversation_history.json`); Roo Code `…\rooveterinaryinc.roo-cline\tasks\…` (same format; Kilo Code fork `kilocode.kilo-code`). `ui_messages.json` = array of messages; entries with `say:"api_req_started"` have a JSON string in `text` carrying `tokensIn, tokensOut, cacheWrites, cacheReads, cost`. Model from `task_metadata.json` `model_usage[]`. Cost is the extension's own price-table estimate, not a bill (shown in the status line only). Task folders can be huge (`checkpoints/`) — the generic walker skips that dir. Quality **exact**.

- [ ] **Step 1 — fixture.**

```js
  // T11 — Cline/Roo task folders. Expected: in=1200+500=1700 out=300+80=380 cw=100 cr=900 msgs=2 (dup ts skipped; in-flight request skipped) badLines=1 (second task malformed); model claude-sonnet-4.5; extCost=0.016
  const req = (ts, info) => ({ ts, type: 'say', say: 'api_req_started', text: JSON.stringify(info) });
  w('cline/tasks/1786352400000/ui_messages.json', JSON.stringify([
    { ts: T('2026-08-10T09:00:00.000Z'), type: 'say', say: 'text', text: 'do the thing' },
    req(T('2026-08-10T09:00:01.000Z'), { request: '…', tokensIn: 1200, tokensOut: 300, cacheWrites: 100, cacheReads: 900, cost: 0.012, apiProtocol: 'anthropic' }),
    req(T('2026-08-10T09:00:01.000Z'), { request: '…', tokensIn: 1200, tokensOut: 300, cacheWrites: 100, cacheReads: 900, cost: 0.012, apiProtocol: 'anthropic' }),   // duplicate ts
    req(T('2026-08-10T09:01:40.000Z'), { request: '…' }),                                                                                                          // still in flight → no tokens yet
    req(T('2026-08-10T21:03:20.000Z'), { request: '…', tokensIn: 500, tokensOut: 80, cacheWrites: 0, cacheReads: 0, cost: 0.004 }),
  ], null, 1));
  w('cline/tasks/1786352400000/task_metadata.json', JSON.stringify({ files_in_context: [], model_usage: [{ ts: T('2026-08-10T09:00:00.000Z'), model_id: 'claude-sonnet-4.5', model_provider_id: 'anthropic', mode: 'act' }] }));
  w('cline/tasks/1786352500000/ui_messages.json', '[{"ts":1786352500000,"type":"say","say":"api_req_started","text":"{\\"tokensIn\\":5');   // truncated file
```

- [ ] **Step 2 — failing check.**

```js
    // ---- T11: Cline + Roo Code ----
    const clA = read('cline', 'tasks', '1786352400000', 'ui_messages.json'), clM = read('cline', 'tasks', '1786352400000', 'task_metadata.json'), clB = read('cline', 'tasks', '1786352500000', 'ui_messages.json');
    const cl = await page.evaluate(async (a, m, b) => {
      const mk = () => [
        { path: 'tasks/1786352400000/ui_messages.json', file: new File([a], 'ui_messages.json') },
        { path: 'tasks/1786352400000/task_metadata.json', file: new File([m], 'task_metadata.json') },
        { path: 'tasks/1786352500000/ui_messages.json', file: new File([b], 'ui_messages.json') },
      ];
      const cline = connectorById('cline'), roo = connectorById('roo');
      const r1 = await parseFolderCached(cline, mk(), null, new Map());   // through the driver: siblings must reach the parser
      const r2 = await parseFolderCached(roo, mk(), null, new Map());
      const t = r1.rows.reduce((x, r) => ({ in: x.in + r.in, cw: x.cw + r.cw, cr: x.cr + r.cr, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });
      const direct = await parseClineTasks(mk().slice(0, 2), null, new Set(), cline, mk());
      return { ...t, files: r1.meta.files, badLines: r1.meta.badLines, model: r1.rows[0].model, p1: r1.rows[0].platform, p2: r2.rows[0].platform, sameParser: cline.parser === roo.parser && cline.parser === 'parseClineTasks',
        extCost: direct.meta.extCost, sid: r1.rows[0].sid, hourOk: r1.rows.some(r => r.hour === new Date('2026-08-10T21:03:20.000Z').getHours()),
        cards: !!document.getElementById('src-cline') && !!document.getElementById('src-roo'), cats: cline.category === 'coding' && roo.category === 'coding' };
    }, clA, clM, clB);
    ok('cline/roo: api_req_started tokens → in=1700 out=380 cw=100 cr=900 msgs=2 (dup + in-flight skipped); model from task_metadata; malformed task = badLines',
      cl.in === 1700 && cl.out === 380 && cl.cw === 100 && cl.cr === 900 && cl.msgs === 2 && cl.files === 2 && cl.badLines === 1 && cl.model === 'claude-sonnet-4.5' && Math.abs(cl.extCost - 0.016) < 1e-9
      && cl.sid === '1786352400000' && cl.hourOk, JSON.stringify(cl));
    ok('cline/roo: one shared parser, two entries with their own platform strings and cards', cl.sameParser && cl.p1 === 'Cline' && cl.p2 === 'Roo Code' && cl.cards && cl.cats, JSON.stringify(cl));
```

RED: `connectorById('cline')` is undefined → `parseFolderCached` throws `Cannot read properties of undefined (reading 'parser')`.

- [ ] **Step 3 — registry entries** (after `continue`):

```js
  { id: 'cline', platform: 'Cline', name: 'Cline (VS Code)', category: 'coding', kind: 'folder-log',
    statusEl: 'cline-status', brand: '#9b6bff', mark: 'Cn', srcIds: ['cline'],
    patterns: [/(^|\/)ui_messages\.json$/i], siblings: [/(^|\/)task_metadata\.json$/i], parser: 'parseClineTasks', hint: 'tasks/<taskId>/ui_messages.json (pick the saoudrizwan.claude-dev folder)',
    quality: 'exact',
    qualityNote: 'Exact tokens from Cline task folders (tasks/<taskId>/ui_messages.json: api_req_started entries carry tokensIn / tokensOut / cacheWrites / cacheReads / cost). Model comes from task_metadata.json when present. The cost field is Cline\'s own price-table estimate, not a bill — the dashboard reports it in the status line only and prices rows at list prices. Task folders can be huge (checkpoints/) — only the JSON files are read.',
    paths: ['%APPDATA%\\Code\\User\\globalStorage\\saoudrizwan.claude-dev\\tasks (Windows)', '~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks (macOS)', 'same layout under Cursor/Windsurf/VSCodium user dirs'],
    links: { get: 'https://cline.bot', docs: 'https://github.com/cline/cline/issues/7742' } },
  { id: 'roo', platform: 'Roo Code', name: 'Roo Code (VS Code)', category: 'coding', kind: 'folder-log',
    statusEl: 'roo-status', brand: '#e2a736', mark: 'Ro', srcIds: ['roo'],
    patterns: [/(^|\/)ui_messages\.json$/i], siblings: [/(^|\/)task_metadata\.json$/i], parser: 'parseClineTasks', hint: 'tasks/<taskId>/ui_messages.json (pick the rooveterinaryinc.roo-cline folder)',
    quality: 'exact',
    qualityNote: 'Roo Code is a Cline fork with the same task-file format: exact tokens from tasks/<taskId>/ui_messages.json api_req_started entries (tokensIn / tokensOut / cacheWrites / cacheReads / cost). Cost is the extension\'s own estimate, not a bill (status line only). Kilo Code (kilocode.kilo-code) uses the same layout — pick that globalStorage folder here instead.',
    paths: ['%APPDATA%\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\tasks (Windows)', '~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks (Linux)', '~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks (macOS)'],
    links: { get: 'https://roocode.com', docs: 'https://deepwiki.com/RooCodeInc/Roo-Code/2.3-state-management-and-storage' } },
```

- [ ] **Step 4 — parser** (after `parseContinueDevData`):

```js
/** Cline / Roo Code / Kilo Code — <globalStorage>/tasks/<taskId>/ui_messages.json (whole-file JSON array). Entries with
 *  say:'api_req_started' carry a JSON string in `text` {tokensIn, tokensOut, cacheWrites, cacheReads, cost}; entries
 *  still in flight have no token fields and are skipped. Model = last task_metadata.json model_usage[].model_id in the
 *  same task dir (handed in via siblingFiles — the driver's connector.siblings list, or `files` itself for direct callers).
 *  The dir→metadata index is built once per siblingFiles ARRAY (WeakMap by identity), so the driver's per-file calls
 *  do not rebuild it. Platform = connector.platform ('Cline' | 'Roo Code'). Dedupe by taskId:ts.
 *  meta.extCost = sum of the extension's own cost estimates (informational only). */
const _clineMetaIndex = new WeakMap();   // siblingFiles array → Map(dir → task_metadata.json File)
async function parseClineTasks(files, onProgress, seen = new Set(), c, siblingFiles) {
  const platform = (c && c.platform) || 'Cline';
  const agg = makeAgg(); const addedIds = []; let msgs = 0, lines = 0, badLines = 0, extCost = 0;
  const list = files.filter(f => /(^|\/)ui_messages\.json$/i.test(f.path));
  const src = Array.isArray(siblingFiles) ? siblingFiles : files;
  let metaByDir = _clineMetaIndex.get(src);
  if (!metaByDir) {
    metaByDir = new Map();
    for (const f of src) { const m = f.path.match(/^(.*\/)?task_metadata\.json$/i); if (m) metaByDir.set(m[1] || '', f.file); }
    _clineMetaIndex.set(src, metaByDir);
  }
  for (let fi = 0; fi < list.length; fi++) {
    const { path, file } = list[fi];
    const dir = path.slice(0, path.lastIndexOf('/') + 1);
    const taskId = dir.split('/').filter(Boolean).pop() || (path.replace(/\.json$/i, ''));
    let model = 'unknown';
    const mf = metaByDir.get(dir);
    if (mf) { try { const mo = JSON.parse(await mf.text()); const mu = mo && mo.model_usage; if (Array.isArray(mu) && mu.length && mu[mu.length - 1].model_id) model = String(mu[mu.length - 1].model_id); } catch {} }
    let arr; try { arr = JSON.parse(await file.text()); } catch { badLines++; continue; }
    if (!Array.isArray(arr)) { badLines++; continue; }
    lines++;
    for (const m of arr) {
      if (!m || m.say !== 'api_req_started' || typeof m.text !== 'string') continue;
      let info; try { info = JSON.parse(m.text); } catch { continue; }
      if (!info || (info.tokensIn == null && info.tokensOut == null)) continue;   // request still in flight when the file was written
      if (m.ts != null) { const id = taskId + ':' + m.ts; if (seen.has(id)) continue; seen.add(id); addedIds.push(id); }
      const ts = m.ts != null ? new Date(+m.ts) : null, okTs = ts && !isNaN(ts);
      agg.add(dayKey(okTs ? ts : file.lastModified), platform, model,
        { in: finTok(+info.tokensIn || 0), out: finTok(+info.tokensOut || 0), cw: finTok(+info.cacheWrites || 0), cr: finTok(+info.cacheReads || 0), msgs: 1 }, taskId, okTs ? ts.getHours() : undefined);
      extCost += Number.isFinite(+info.cost) ? +info.cost : 0;
      msgs++;
    }
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: [], meta: { files: list.length, msgs, lines, badLines, addedIds, extCost } };
}
```
Note: `extCost` is not persisted (the cached wrapper keeps only the shared shape); it is informational for direct callers. Also note the accepted staleness: a change to `task_metadata.json` alone (model label) does not invalidate the cached `ui_messages.json` entry until that file changes.

- [ ] **Step 5:** suite ×2 → green. Commit: `git add "AI Usage Dashboard.html" tests/fixtures/gen.mjs tests/checks/87-folder-logs.mjs && git commit -m "feat: Cline + Roo Code task parser (api_req_started tokens)"`

---

### Task 12: Parser — Aider chat history (`.aider.chat.history.md`, estimated)

**Files:** Modify `AI Usage Dashboard.html`, `tests/fixtures/gen.mjs`, `tests/checks/87-folder-logs.mjs`

Research row: per-repo `.aider.chat.history.md` (`AIDER_CHAT_HISTORY_FILE`) prints tool lines like `> Tokens: 8.2k sent, 578 received. Cost: $0.03 message, $0.05 session.` (with caching: `Tokens: 12k sent, 2.1k cache write, 8k cache hit, 1.2k received.`) — regex-parseable, **k-rounded → estimated**. Session header `# aider chat started at YYYY-MM-DD HH:MM:SS`; model line `> Model: <name> with <fmt> edit format`. Exact numbers need `--analytics-log <file>.jsonl` (`message_send` events) — Wave 2. Quality **estimated**; rows carry `est: 1`; no `hour` (the file has only session-start times).

- [ ] **Step 1 — fixture.**

```js
  // T12 — Aider chat history. "sent" is the full prompt; cache write/hit are carved out. Expected (est):
  //   in = 8200 + (12000-2100-8000) + 500 = 10600 · cw=2100 · cr=8000 · out = 578+1200+50 = 1828 · msgs=3 · badLines=1 (unparseable Tokens line) · models gpt-5.4 (Aug 10) + claude-sonnet-4.5 (Aug 11)
  w('aider/proj/.aider.chat.history.md', [
    '# aider chat started at 2026-08-10 09:12:33', '',
    '> Aider v0.86.1', '> Model: gpt-5.4 with diff edit format', '> Git repo: .git with 12 files', '',
    '#### make it faster', '',
    'I will change the loop.', '',
    '> Tokens: 8.2k sent, 578 received. Cost: $0.03 message, $0.05 session.',
    '> Tokens: 12k sent, 2.1k cache write, 8k cache hit, 1.2k received. Cost: $0.02 message, $0.07 session.',
    '> Tokens: lots sent, some received.', '',
    '# aider chat started at 2026-08-11 14:00:00', '',
    '> Model: claude-sonnet-4.5 with diff edit format',
    '> Tokens: 500 sent, 50 received. Cost: $0.01 message, $0.01 session.', '',
  ].join('\n'));
```

- [ ] **Step 2 — failing check.**

```js
    // ---- T12: Aider ----
    const aiderText = read('aider', 'proj', '.aider.chat.history.md');
    const ai = await page.evaluate(async (text) => {
      const c = connectorById('aider');
      const res = await parseAiderHistory([{ path: 'proj/.aider.chat.history.md', file: new File([text], '.aider.chat.history.md') }], null, new Set(), c);
      const t = res.rows.reduce((x, r) => ({ in: x.in + r.in, cw: x.cw + r.cw, cr: x.cr + r.cr, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });
      const byModel = Object.fromEntries(res.rows.map(r => [r.model, r.d]));
      return { ...t, badLines: res.meta.badLines, lines: res.meta.lines, allEst: res.rows.every(r => r.est === 1), noHour: res.rows.every(r => r.hour == null), byModel, platform: res.rows[0].platform,
        quality: c.quality, kind: c.kind, cat: c.category, card: !!document.getElementById('src-aider'), badge: document.querySelector('#src-aider .badge').textContent };
    }, aiderText);
    ok('aider: "Tokens:" lines → est. in=10600 cw=2100 cr=8000 out=1828 msgs=3; k-rounding honored; unparseable line = badLines; per-session model + day; no hour',
      ai.in === 10600 && ai.cw === 2100 && ai.cr === 8000 && ai.out === 1828 && ai.msgs === 3 && ai.badLines === 1 && ai.lines === 4 && ai.allEst && ai.noHour
      && ai.byModel['gpt-5.4'] === '2026-08-10' && ai.byModel['claude-sonnet-4.5'] === '2026-08-11' && ai.platform === 'Aider', JSON.stringify(ai));
    ok('aider: card is honest — estimated badge, folder-log coding tool', ai.quality === 'estimated' && /estimated/i.test(ai.badge) && ai.kind === 'folder-log' && ai.cat === 'coding' && ai.card, JSON.stringify(ai));
```

RED: `parseAiderHistory is not defined`.

- [ ] **Step 3 — registry entry** (after `roo`):

```js
  { id: 'aider', platform: 'Aider', name: 'Aider', category: 'coding', kind: 'folder-log',
    statusEl: 'aider-status', brand: '#14b8a6', mark: 'Ai', srcIds: ['aider'],
    patterns: [/(^|\/)\.aider\.chat\.history\.md$/i], parser: 'parseAiderHistory', hint: '.aider.chat.history.md files (pick a project folder, or a parent folder that holds several repos)',
    quality: 'estimated',
    qualityNote: 'Estimated: aider\'s chat history (.aider.chat.history.md, per repo) prints rounded "Tokens: 8.2k sent, 578 received" lines per message — parsed with k-rounding, so totals are approximate and rows are marked est. Cache write/hit tokens are carved out of "sent" when printed; the model comes from each session\'s "Model:" line; messages carry the session\'s date but no reliable hour. Aider has no account or server — usage is billed by the underlying provider key. For exact numbers run aider with --analytics-log <file>.jsonl (message_send events; Wave 2 parser).',
    paths: ['<repo>\\.aider.chat.history.md (per project; AIDER_CHAT_HISTORY_FILE overrides)', 'optional: --llm-history-file, --analytics-log <file>.jsonl'],
    links: { get: 'https://aider.chat', docs: 'https://aider.chat/docs/config/options.html' } },
```

- [ ] **Step 4 — parser** (after `parseClineTasks`):

```js
/** Aider — .aider.chat.history.md. Lines: '# aider chat started at YYYY-MM-DD HH:MM:SS' (session day),
 *  '> Model: <name> with <fmt> edit format', '> Tokens: 8.2k sent[, 2.1k cache write][, 8k cache hit], 578 received. Cost: …'.
 *  k-rounded → est:1. `lines` = Tokens lines seen, `badLines` = Tokens lines that did not parse. No hour (session start only). */
async function parseAiderHistory(files, onProgress) {
  const agg = makeAgg(); let msgs = 0, lines = 0, badLines = 0;
  const list = files.filter(f => /(^|\/)\.aider\.chat\.history\.md$/i.test(f.path));
  const reStart = /^#\s*aider chat started at\s+(\d{4}-\d{2}-\d{2})/i;
  const reModel = /^>?\s*Model:\s*(\S+)/;
  const reTok = /Tokens:\s*([\d.,]+k?)\s*sent(?:,\s*([\d.,]+k?)\s*cache write)?(?:,\s*([\d.,]+k?)\s*cache hit)?,\s*([\d.,]+k?)\s*received/i;
  const num = (s) => { if (!s) return 0; const k = /k$/i.test(s); const v = parseFloat(s.replace(/,/g, '')); return Number.isFinite(v) ? Math.round(k ? v * 1000 : v) : NaN; };
  for (let fi = 0; fi < list.length; fi++) {
    const { file } = list[fi];
    let day = dayKey(file.lastModified), model = 'aider';
    for (const line of (await file.text()).split(/\r?\n/)) {
      let m;
      if ((m = reStart.exec(line))) { day = m[1]; continue; }
      if ((m = reModel.exec(line))) { model = m[1]; continue; }
      if (!/Tokens:/.test(line)) continue;
      lines++;
      m = reTok.exec(line);
      if (!m) { badLines++; continue; }
      const sent = num(m[1]), cw = num(m[2]), cr = num(m[3]), out = num(m[4]);
      if ([sent, cw, cr, out].some(Number.isNaN)) { badLines++; continue; }
      agg.add(day, 'Aider', model, { in: Math.max(0, sent - cw - cr), cw, cr, out, msgs: 1, est: 1 });
      msgs++;
    }
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: [], meta: { files: list.length, msgs, lines, badLines, addedIds: [] } };
}
```

- [ ] **Step 5:** suite ×2 → green. Commit: `git add "AI Usage Dashboard.html" tests/fixtures/gen.mjs tests/checks/87-folder-logs.mjs && git commit -m "feat: Aider chat-history parser (estimated, k-rounded)"`

---

### Task 13: Parser — JetBrains Junie events

**Files:** Modify `AI Usage Dashboard.html`, `tests/fixtures/gen.mjs`, `tests/checks/87-folder-logs.mjs`

Research row: Junie IDE plugin `%LOCALAPPDATA%\JetBrains\<IDE-version>\projects\<project>\matterhorn\.matterhorn\events\<issueId> <taskId>-events.jsonl` (macOS `~/Library/Caches/JetBrains/<IDE>/projects/<name>/matterhorn/.matterhorn/`, Linux `~/.cache/JetBrains/…`); Junie CLI `~/.junie/sessions/*/events.jsonl`. `LlmResponseEvent` records carry `inputTokens, outputTokens, cacheTokens, cost, model` (undocumented; nesting varies by version → tolerant lookup). Regular AI Assistant chat has no local token log → platform quality **estimated** (coverage), row counts exact.

- [ ] **Step 1 — fixture.**

```js
  // T13 — Junie events. Expected: in=1500+900+300=2700 out=200+120+40=360 cr=600 msgs=3 badLines=1 (truncated line); models claude-sonnet-4.5 + gpt-5.4 (alternate nesting: event.usage + modelName)
  w('junie/.matterhorn/events/ISSUE-1 task-1-events.jsonl', [
    jl({ timestamp: '2026-08-10T09:00:00.000Z', event: { type: 'AgentStartedEvent', issueId: 'ISSUE-1' } }),
    jl({ timestamp: '2026-08-10T09:00:10.000Z', event: { type: 'LlmResponseEvent', model: 'claude-sonnet-4.5', inputTokens: 1500, outputTokens: 200, cacheTokens: 600, cost: 0.011, answer: { text: '…' } } }),
    jl({ timestamp: '2026-08-10T09:01:00.000Z', event: { type: 'LlmResponseEvent', model: 'claude-sonnet-4.5', inputTokens: 900, outputTokens: 120, cacheTokens: 0, cost: 0.004 } }),
    '{"timestamp":"2026-08-10T09:02:00.000Z","event":{"type":"LlmResponseEvent"',   // truncated
    jl({ timestamp: '2026-08-10T21:00:00.000Z', event: { type: 'LlmResponseEvent', modelName: 'gpt-5.4', usage: { inputTokens: 300, outputTokens: 40 } } }),
    jl({ timestamp: '2026-08-10T21:00:30.000Z', event: { type: 'AgentFinishedEvent' } }),
  ].join('\n') + '\n');
```

- [ ] **Step 2 — failing check.**

```js
    // ---- T13: JetBrains Junie ----
    const junieText = read('junie', '.matterhorn', 'events', 'ISSUE-1 task-1-events.jsonl');
    const ju = await page.evaluate(async (text) => {
      const c = connectorById('junie');
      const res = await parseJunieEvents([{ path: '.matterhorn/events/ISSUE-1 task-1-events.jsonl', file: new File([text], 'ISSUE-1 task-1-events.jsonl') }], null, new Set(), c);
      const t = res.rows.reduce((x, r) => ({ in: x.in + r.in, cr: x.cr + r.cr, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, cr: 0, out: 0, msgs: 0 });
      const matched = c.patterns.some(re => re.test('.matterhorn/events/ISSUE-1 task-1-events.jsonl')) && c.patterns.some(re => re.test('sessions/abc/events.jsonl'));
      return { ...t, badLines: res.meta.badLines, models: [...new Set(res.rows.map(r => r.model))].sort(), platform: res.rows[0].platform, hourOk: res.rows.some(r => r.hour === new Date('2026-08-10T21:00:00.000Z').getHours()),
        matched, quality: c.quality, kind: c.kind, cat: c.category, card: !!document.getElementById('src-junie'), noteOk: /AI Assistant chat/.test(c.qualityNote) };
    }, junieText);
    ok('junie: LlmResponseEvent records → in=2700 cr=600 out=360 msgs=3 (tolerant nesting); truncated line = badLines; both IDE and CLI file names match',
      ju.in === 2700 && ju.cr === 600 && ju.out === 360 && ju.msgs === 3 && ju.badLines === 1 && JSON.stringify(ju.models) === JSON.stringify(['claude-sonnet-4.5', 'gpt-5.4']) && ju.platform === 'JetBrains Junie' && ju.hourOk && ju.matched, JSON.stringify(ju));
    ok('junie: card is honest about coverage (estimated; Junie runs only)', ju.quality === 'estimated' && ju.noteOk && ju.kind === 'folder-log' && ju.cat === 'coding' && ju.card, JSON.stringify(ju));
```

RED: `parseJunieEvents is not defined`.

- [ ] **Step 3 — registry entry** (after `aider`):

```js
  { id: 'junie', platform: 'JetBrains Junie', name: 'JetBrains AI Assistant / Junie', category: 'coding', kind: 'folder-log',
    statusEl: 'junie-status', brand: '#087cfa', mark: 'Ju', srcIds: ['junie'],
    patterns: [/(^|\/)[^/]*events\.jsonl$/i], parser: 'parseJunieEvents', hint: 'matterhorn/.matterhorn/events/*-events.jsonl (IDE) or sessions/*/events.jsonl (Junie CLI)',
    quality: 'estimated',
    qualityNote: 'Junie agent runs only: matterhorn/.matterhorn/events/<issue> <task>-events.jsonl (and ~/.junie/sessions/*/events.jsonl) LlmResponseEvent records carry inputTokens / outputTokens / cacheTokens / cost / model — those counts are exact, but regular AI Assistant chat and completions write no local token log, so JetBrains AI totals here understate real usage (hence "estimated"). Undocumented format that varies by version (the parser is tolerant); the IDE cache dir may be cleared. Individual JetBrains accounts have no usage API or export.',
    paths: ['%LOCALAPPDATA%\\JetBrains\\<IDE-version>\\projects\\<project>\\matterhorn\\.matterhorn\\events\\ (Windows)', '~/Library/Caches/JetBrains/<IDE>/projects/<name>/matterhorn/.matterhorn/ (macOS)', '~/.cache/JetBrains/… (Linux)', '~/.junie/sessions/*/events.jsonl (Junie CLI)'],
    links: { get: 'https://www.jetbrains.com/junie/', docs: 'https://github.com/dmeehan1968/junie-explorer', usage: 'https://www.jetbrains.com/help/ai-assistant/licensing-and-subscriptions.html' } },
```

- [ ] **Step 4 — parser** (after `parseAiderHistory`):

```js
/** JetBrains Junie — *-events.jsonl / events.jsonl. Each line {timestamp, event:{type,…}} (or flat). LlmResponseEvent
 *  records carry inputTokens/outputTokens/cacheTokens (+cost, model) — nesting varies by version, so the token object
 *  is looked up at event, event.answer, event.usage, event.response, event.tokenUsage, event.statistics. */
async function parseJunieEvents(files, onProgress) {
  const agg = makeAgg(); let msgs = 0; const k = { lines: 0, badLines: 0 };
  const list = files.filter(f => /(^|\/)[^/]*events\.jsonl$/i.test(f.path));
  const pick = (o, ...keys) => { for (const key of keys) if (o && o[key] != null) return finTok(+o[key] || 0); return 0; };
  for (let fi = 0; fi < list.length; fi++) {
    const { path, file } = list[fi];
    const sid = (path.split('/').pop() || '').replace(/\.jsonl$/i, '');
    await eachJsonl(file, (o) => {
      const ev = o.event && typeof o.event === 'object' ? o.event : o;
      const type = String(ev.type || ev.eventType || o.type || '');
      if (!/LlmResponse/i.test(type)) return;
      const src = [ev, ev.answer, ev.usage, ev.response, ev.tokenUsage, ev.statistics].find(x => x && typeof x === 'object' && (x.inputTokens != null || x.input_tokens != null));
      if (!src) return;
      const model = String(ev.model || ev.modelName || (ev.answer && (ev.answer.model || ev.answer.modelName)) || src.model || 'junie');
      const tsRaw = o.timestamp || ev.timestamp || o.time; const ts = tsRaw ? new Date(tsRaw) : null, okTs = ts && !isNaN(ts);
      agg.add(dayKey(okTs ? ts : file.lastModified), 'JetBrains Junie', model,
        { in: pick(src, 'inputTokens', 'input_tokens'), out: pick(src, 'outputTokens', 'output_tokens'), cr: pick(src, 'cacheTokens', 'cacheInputTokens', 'cache_read_tokens'), cw: pick(src, 'cacheCreateInputTokens', 'cacheCreationTokens', 'cache_write_tokens'), msgs: 1 },
        sid, okTs ? ts.getHours() : undefined);
      msgs++;
    }, k);
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: [], meta: { files: list.length, msgs, lines: k.lines, badLines: k.badLines, addedIds: [] } };
}
```

- [ ] **Step 5:** suite ×2 → green. Commit: `git add "AI Usage Dashboard.html" tests/fixtures/gen.mjs tests/checks/87-folder-logs.mjs && git commit -m "feat: JetBrains Junie events parser"`

---

### Task 14: Parser — LM Studio conversations

**Files:** Modify `AI Usage Dashboard.html`, `tests/fixtures/gen.mjs`, `tests/checks/87-folder-logs.mjs`

Research row: `~/.lmstudio/conversations/` (Windows `%USERPROFILE%\.lmstudio\conversations\`; older `~/.cache/lm-studio/conversations`), files `*.conversation.json`: `messages[]` with `versions[]` / `currentlySelected` / `role`; assistant versions carry `steps[]` contentBlocks with `genInfo { indexedModelIdentifier, identifier, stats { promptTokensCount, predictedTokensCount, totalTokensCount, … } }` (SDK `LLMPredictionStats`). LM Studio warns the structure is unstable → defensive. Messages carry no timestamps → chat lands on `createdAt` or the file date. Chats made through the API server are not written here. Quality **exact**.

- [ ] **Step 1 — fixture.**

```js
  // T14 — LM Studio conversation. Only the SELECTED version of a regenerated message counts (v1: 250 out; v0's 300 is ignored); a multiStep with two content blocks counts both.
  //   Expected: in=120+900+950=1970 out=250+40+60=350 msgs=3 · models llama-4-8b + qwen3-14b (short identifier preferred over the publisher-prefixed indexedModelIdentifier) · files=2 badLines=1 · day = local day of 2026-08-10T09:00Z (createdAt)
  const gi = (ident, indexed, p, o) => ({ type: 'contentBlock', content: [{ type: 'text', text: '…' }], genInfo: { indexedModelIdentifier: indexed, identifier: ident, loadModelConfig: {}, predictionConfig: {}, stats: { stopReason: 'eosFound', tokensPerSecond: 42, timeToFirstTokenSec: 0.2, totalTimeSec: 3, promptTokensCount: p, predictedTokensCount: o, totalTokensCount: p + o } } });
  w('lmstudio/conversations/1723/chat.conversation.json', JSON.stringify({
    name: 'test chat', createdAt: T('2026-08-10T09:00:00.000Z'), pinned: false, perChatPredictionConfig: {}, tokenCount: 0,
    messages: [
      { versions: [{ type: 'singleStep', role: 'user', content: [{ type: 'text', text: 'hi' }] }], currentlySelected: 0 },
      { versions: [
        { type: 'multiStep', role: 'assistant', steps: [gi('llama-4-8b', 'lmstudio-community/Llama-4-8B', 120, 300)] },
        { type: 'multiStep', role: 'assistant', steps: [gi('llama-4-8b', 'lmstudio-community/Llama-4-8B', 120, 250)] } ], currentlySelected: 1 },
      { versions: [{ type: 'multiStep', role: 'assistant', steps: [gi('qwen3-14b', undefined, 900, 40), { type: 'toolCallRequest', toolCallRequest: {} }, gi('qwen3-14b', undefined, 950, 60)] }], currentlySelected: 0 },
      { versions: [{ type: 'singleStep', role: 'assistant', content: [{ type: 'text', text: 'no genInfo here' }] }], currentlySelected: 0 },
    ] }, null, 1));
  w('lmstudio/conversations/1723/bad.conversation.json', '{"name":"broken",');
```

- [ ] **Step 2 — failing check.**

```js
    // ---- T14: LM Studio ----
    const lmA = read('lmstudio', 'conversations', '1723', 'chat.conversation.json'), lmB = read('lmstudio', 'conversations', '1723', 'bad.conversation.json');
    const lm = await page.evaluate(async (a, b) => {
      App.renderHub();   // hub query below needs a fresh synchronous render (App.render() is rAF-batched)
      const c = connectorById('lmstudio');
      const res = await parseLmStudioConversations([{ path: 'conversations/1723/chat.conversation.json', file: new File([a], 'chat.conversation.json') }, { path: 'conversations/1723/bad.conversation.json', file: new File([b], 'bad.conversation.json') }], null, new Set(), c);
      const t = res.rows.reduce((x, r) => ({ in: x.in + r.in, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, out: 0, msgs: 0 });
      return { ...t, files: res.meta.files, badLines: res.meta.badLines, models: [...new Set(res.rows.map(r => r.model))].sort(), platform: res.rows[0].platform, days: [...new Set(res.rows.map(r => r.d))], expDay: dayKey(new Date('2026-08-10T09:00:00.000Z')),
        kind: c.kind, cat: c.category, card: !!document.getElementById('src-lmstudio'), hub: !!document.querySelector('#accounts-hub .hub-group[data-group="local"] .acct[data-connector="lmstudio"]'),
        // honesty: local open-weight models run on your hardware → API-equivalent cost must be $0, not the "Unknown model" fallback price
        localCost: (Pricing.load(), Pricing.cost('llama-3.3-70b', { in: 1_000_000, out: 1_000_000, cw: 0, cr: 0 })), hostedStillPriced: Pricing.cost('claude-sonnet-5', { in: 1_000_000, out: 0, cw: 0, cr: 0 }) };
    }, lmA, lmB);
    ok('lmstudio: genInfo.stats per selected assistant version → in=1970 out=350 msgs=3; regenerated sibling ignored; malformed file = badLines; day from createdAt',
      lm.in === 1970 && lm.out === 350 && lm.msgs === 3 && lm.files === 2 && lm.badLines === 1 && JSON.stringify(lm.models) === JSON.stringify(['llama-4-8b', 'qwen3-14b']) && lm.platform === 'LM Studio'
      && lm.days.length === 1 && lm.days[0] === lm.expDay, JSON.stringify(lm));
    ok('lmstudio: registry entry is a Local-runner folder-log card', lm.kind === 'folder-log' && lm.cat === 'local' && lm.card && lm.hub, JSON.stringify(lm));
    ok('pricing: local open-weight models (llama/qwen/mistral/…) price at $0 — they run on your hardware; hosted rows untouched', lm.localCost === 0 && lm.hostedStillPriced > 0, JSON.stringify({ localCost: lm.localCost, hosted: lm.hostedStillPriced }));
```
RED: `parseLmStudioConversations is not defined`.

- [ ] **Step 3 — registry entry + $0 local price row.** First, honesty for local runners: without a matching row, LM Studio / Ollama models fall through to the `Unknown model` fallback ($3/$15 per M) and show a non-zero API-equivalent cost for free local inference. In `DEFAULT_PRICES`, insert directly BEFORE the fallback line `  { pat: '.*',                             label: 'Unknown model',         in: 3,    out: 15,  cw: 3.75, cr: 0.3 },`:

```js
  // --- Local open-weight models (Ollama / LM Studio / llama.cpp …): no API bill — $0 unless you edit the row to compare against a hosted equivalent
  { pat: '^(llama|qwen|mistral|mixtral|gemma|phi|deepseek-r1|codellama|tinyllama)', label: 'Local open-weight (runs on your hardware)', in: 0, out: 0, cw: 0, cr: 0 },
```
(Pattern is anchored at the start so hosted ids like `x-ai/grok…` or `deepseek/deepseek-v4` via OpenRouter are unaffected; `Pricing.resolve` matches case-insensitively and takes the FIRST match, and this row sits after every vendor row. `Pricing.load()` takes a saved `aiusage:prices` list wholesale, so a user who edited prices before this change will not have the row until they click the pricing card's "Reset to defaults" (or add it by hand) — say so in T17's docs note. The suite runs with cleared storage, so defaults apply in checks.) Then the registry entry (after `junie`):

```js
  { id: 'lmstudio', platform: 'LM Studio', name: 'LM Studio', category: 'local', kind: 'folder-log',
    statusEl: 'lmstudio-status', brand: '#6d5dfc', mark: 'LM', srcIds: ['lmstudio'],
    patterns: [/\.conversation\.json$/i], parser: 'parseLmStudioConversations', hint: '*.conversation.json chat files (pick ~/.lmstudio/conversations)',
    quality: 'exact',
    qualityNote: 'Exact tokens from LM Studio chat files (~/.lmstudio/conversations/**/*.conversation.json): each assistant message\'s genInfo.stats carries promptTokensCount / predictedTokensCount and the model\'s load identifier. Only the currently selected version of a regenerated message is counted. Messages carry no timestamps — a whole chat lands on its createdAt/file date. LM Studio warns this structure is undocumented and may change, so the parser is defensive. Chats made through the API server are not written to this folder (no usage-history endpoint exists; the server\'s CORS toggle is off by default). Local models are priced $0 — they run on your hardware; switch the "Local open-weight" price row to compare against hosted equivalents.',
    paths: ['%USERPROFILE%\\.lmstudio\\conversations\\ (Windows)', '~/.lmstudio/conversations/ (macOS/Linux)', 'older installs: ~/.cache/lm-studio/conversations'],
    links: { get: 'https://lmstudio.ai', docs: 'https://lmstudio.ai/docs/app/basics/chat' } },
```

- [ ] **Step 4 — parser** (after `parseJunieEvents`):

```js
/** LM Studio — *.conversation.json (whole-file JSON). For each message take versions[currentlySelected]; assistant
 *  versions are 'multiStep' (steps[] contentBlocks, each with genInfo.stats) or 'singleStep' (genInfo on the version).
 *  in = stats.promptTokensCount, out = stats.predictedTokensCount, model = genInfo.identifier (the short load id, e.g. 'llama-4-8b' —
 *  matches the $0 local price row) || indexedModelIdentifier (publisher-prefixed / .gguf path — display fallback only).
 *  Day = createdAt (ms) or the file's lastModified; no per-message timestamps → no hour. */
async function parseLmStudioConversations(files, onProgress) {
  const agg = makeAgg(); let msgs = 0, lines = 0, badLines = 0;
  const list = files.filter(f => /\.conversation\.json$/i.test(f.path));
  for (let fi = 0; fi < list.length; fi++) {
    const { path, file } = list[fi];
    let obj; try { obj = JSON.parse(await file.text()); } catch { badLines++; continue; }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.messages)) { badLines++; continue; }
    lines++;
    const created = obj.createdAt ?? obj.created_at;
    const day = dayKey(typeof created === 'number' && created > 0 ? new Date(created) : file.lastModified);
    const sid = (path.split('/').pop() || '').replace(/\.conversation\.json$/i, '');
    for (const m of obj.messages) {
      if (!m) continue;
      const vs = Array.isArray(m.versions) ? m.versions : [m];
      const v = vs[Math.min(Math.max(0, +m.currentlySelected || 0), vs.length - 1)];
      if (!v || v.role !== 'assistant') continue;
      const blocks = Array.isArray(v.steps) ? v.steps : [v];
      for (const b of blocks) {
        const gi = b && b.genInfo, st = gi && gi.stats;
        if (!st) continue;
        agg.add(day, 'LM Studio', String(gi.identifier || gi.indexedModelIdentifier || 'lm-studio'),
          { in: finTok(+st.promptTokensCount || 0), out: finTok(+st.predictedTokensCount || 0), msgs: 1 }, sid);
        msgs++;
      }
    }
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: [], meta: { files: list.length, msgs, lines, badLines, addedIds: [] } };
}
```

- [ ] **Step 5:** suite ×2 → green. Commit: `git add "AI Usage Dashboard.html" tests/fixtures/gen.mjs tests/checks/87-folder-logs.mjs && git commit -m "feat: LM Studio conversation parser"`

---

### Task 15: Ollama `local-server` (live validate, CORS/offline messages) + usage-logger proxy doc

**Files:** Modify `AI Usage Dashboard.html`, `tests/checks/87-folder-logs.mjs`, Create `docs/tools/ollama-usage-logger.mjs`

Research row: `http://localhost:11434` — `GET /api/tags` (installed models), `GET /api/ps` (loaded models); every generate/chat response carries `prompt_eval_count` / `eval_count`, but there is **no usage-history endpoint**: the dashboard can only validate live, and history must come from a request log kept by the caller (the usage-logger proxy → `folder-log` via `parseUsageLoggerJsonl`, T6). CORS: Chrome sends `Origin: null` for `file://`, which does not match Ollama's default `file://*` allow-list → set `OLLAMA_ORIGINS="*"` and restart. Desktop-app chats live in `db.sqlite` (SQLite, no token counts) — **skipped in Wave 1** (no sql.js in a single file; recorded in T17's backlog). Quality **exact** (live/validate only).

- [ ] **Step 1 — failing checks.** Append inside 87-folder-logs' `try` (reuse `logText` from T6):

```js
    // ---- T15: Ollama local-server ----
    const ol = await page.evaluate(async (text) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const c = connectorById('ollama');
      const origFetch = fetchJSON, origProbe = probeServer;
      window.fetchJSON = async (url) => {
        const u = String(url);
        if (u.endsWith('/api/tags')) return { models: [{ name: 'llama4:8b' }, { name: 'qwen3:14b' }] };
        if (u.endsWith('/api/ps')) return { models: [{ name: 'llama4:8b' }] };
        throw new Error('unexpected ' + u);
      };
      await App.connectServer(c);
      const okState = { label: Store.connectors.ollama && Store.connectors.ollama.label, status: Store.connectorStatus(c), text: document.getElementById('ollama-status').textContent, url: LS.get('url:ollama', null) };
      // server up but CORS-blocked: fetch throws TypeError, the no-cors probe succeeds
      window.fetchJSON = async () => { throw new TypeError('Failed to fetch'); };
      window.probeServer = async () => true;
      await App.connectServer(c);
      const cors = { err: Store.connectors.ollama && Store.connectors.ollama.err, status: Store.connectorStatus(c), text: document.getElementById('ollama-status').textContent };
      // server down: the probe fails too → off (not an error state)
      window.probeServer = async () => false;
      await App.connectServer(c);
      const down = { has: !!Store.connectors.ollama, status: Store.connectorStatus(c), text: document.getElementById('ollama-status').textContent };
      window.fetchJSON = origFetch; window.probeServer = origProbe;
      // the same card also reads usage-logger JSONL through the folder-log path
      await App.scanFiles(c, [{ path: 'ollama-usage.jsonl', file: new File([text], 'ollama-usage.jsonl') }]);
      const logged = Store.sources.ollama && Store.sources.ollama.rows.reduce((a, r) => a + r.in, 0);
      Store.sources = {}; Store.connectors = {}; Store.persist();
      return { okState, cors, down, logged, kind: c.kind, cat: c.category, quality: c.quality, card: !!document.getElementById('src-ollama') && !!document.getElementById('ollama-url') && !!document.getElementById('ollama-validate') && !!document.getElementById('ollama-pick'),
        note: /no usage history|keeps no usage history/i.test(c.qualityNote) && /db\.sqlite/.test(c.qualityNote) };
    }, logText);
    ok('ollama: validates via stubbed /api/tags + /api/ps (label = models installed, detail = loaded now); URL persisted',
      /2 models installed/.test(ol.okState.label || '') && ol.okState.status === 'ok' && /1 loaded/.test(ol.okState.text) && ol.okState.url === 'http://localhost:11434', JSON.stringify(ol.okState));
    ok('ollama: CORS-blocked → attention with the OLLAMA_ORIGINS fix; unreachable → off ("not running")',
      /OLLAMA_ORIGINS/.test(ol.cors.err || '') && ol.cors.status === 'warn' && /OLLAMA_ORIGINS/.test(ol.cors.text) && !ol.down.has && ol.down.status === 'off' && /not running/i.test(ol.down.text), JSON.stringify({ cors: ol.cors, down: ol.down }));
    ok('ollama: one card = local-server validate + usage-logger folder (exact, honest note); logger rows land under the ollama source',
      ol.kind === 'local-server' && ol.cat === 'local' && ol.quality === 'exact' && ol.card && ol.note && ol.logged === 1060, JSON.stringify(ol));
```

RED: `probeServer is not defined` (the `origProbe` capture on the block's third line throws before anything else runs).

- [ ] **Step 2 — registry entry** (after `lmstudio`):

```js
  // ---- Wave 1 local-server connector (generic driver + optional usage-logger folder) ----
  { id: 'ollama', platform: 'Ollama', name: 'Ollama', category: 'local', kind: 'local-server',
    statusEl: 'ollama-status', brand: '#333333', mark: 'Ol', srcIds: ['ollama'],
    baseUrl: 'http://localhost:11434', validate: 'validateOllama',
    corsHint: 'Ollama is running but blocked this page (CORS). Set OLLAMA_ORIGINS="*" (or your page origin), restart Ollama, then validate again.',
    patterns: [/usage[^/]*\.jsonl$/i], parser: 'parseUsageLoggerJsonl', hint: 'usage-logger JSONL files (ollama-usage.jsonl — see docs/tools/ollama-usage-logger.mjs)',
    quality: 'exact',
    qualityNote: 'Live check only: Ollama keeps no usage history and no per-request log — exact token counts (prompt_eval_count / eval_count) exist only inside each API response. This card verifies the server (GET /api/tags, /api/ps) and shows what is installed and loaded now. For history, run the one-file proxy docs/tools/ollama-usage-logger.mjs (it forwards requests to Ollama and appends exact per-request JSONL) and pick its output folder below. Desktop-app chats live in db.sqlite (SQLite, no token counts) — not read in this version. If validation says CORS: set OLLAMA_ORIGINS="*" and restart Ollama. Logged models are priced $0 — they run on your hardware; switch the "Local open-weight" price row to compare against hosted equivalents.',
    paths: ['server: http://localhost:11434 (OLLAMA_HOST)', 'usage log: ~/.ai-usage/ollama-usage.jsonl (written by the proxy)', 'server.log has request lines but no tokens; db.sqlite has chats but no tokens'],
    links: { get: 'https://ollama.com/download', docs: 'https://docs.ollama.com/api' } },
```
Add `'Ollama'` — no change needed to `PLATFORM_ORDER` (derived).

- [ ] **Step 3 — validators.** After `fetchJSON` (anchor: the closing `}` of `async function fetchJSON(url, headers) {…}`) add:

```js
/** Opaque reachability probe: resolves true if SOMETHING answers at url (even without CORS headers), false if
 *  the connection fails. Lets connectServer tell "running but CORS-blocked" from "not running". */
async function probeServer(url) {
  try { await fetch(url + '/', { mode: 'no-cors', cache: 'no-store' }); return true; } catch { return false; }
}
/** Ollama live validate: /api/tags (installed) + /api/ps (loaded). No usage history exists on the server. */
async function validateOllama(base) {
  const tags = await fetchJSON(base + '/api/tags', {});
  let ps = null; try { ps = await fetchJSON(base + '/api/ps', {}); } catch {}
  const n = Array.isArray(tags && tags.models) ? tags.models.length : 0;
  const loaded = ps && Array.isArray(ps.models) ? ps.models.length : 0;
  return { label: `${n} models installed`, detail: `${n} models installed · ${loaded} loaded now · no usage history on the server (see the note; usage-logger JSONL is read from the folder below)` };
}
```

- [ ] **Step 4 — App.connectServer.** Insert after `restoreFolderHandles()`:

```js
  /** local-server driver: validate via the registry's `validate` fn; distinguish CORS-blocked (attention + fix) from not running (off). */
  async connectServer(c) {
    const status = $(c.id + '-status');
    const gen = this._gen[c.id] = (this._gen[c.id] || 0) + 1;
    const urlEl = $(c.id + '-url');
    const base = ((urlEl && urlEl.value.trim()) || c.baseUrl).replace(/\/+$/, '');
    LS.set('url:' + c.id, base);
    status.textContent = 'Checking ' + base + '…'; status.dataset.gen = String(gen);
    try {
      const fn = globalThis[c.validate];
      if (typeof fn !== 'function') throw new Error('No validator registered: ' + c.validate);
      const res = await fn(base);
      if (gen !== this._gen[c.id]) { if (status.dataset.gen === String(gen)) status.textContent = ''; return; }   // superseded — only clear the placeholder if it's still ours
      Store.setConnector(c.id, { label: res.label, lastSync: Date.now(), err: null });
      status.textContent = ''; status.dataset.gen = '';
      status.appendChild(el('span', { class: 'ok', text: '● Connected. ' }));
      status.appendChild(document.createTextNode(res.detail || ''));
      this.render();
    } catch (e) {
      if (gen !== this._gen[c.id]) { if (status.dataset.gen === String(gen)) status.textContent = ''; return; }
      const up = await probeServer(base).catch(() => false);
      status.textContent = ''; status.dataset.gen = '';
      if (up) {
        const msg = c.corsHint || ('Server is running at ' + base + ' but blocked this page (CORS) — allow this origin on the server, then validate again.');
        Store.setConnector(c.id, { err: msg.slice(0, 80) });
        status.appendChild(el('span', { class: 'err', text: 'Blocked: ' }));
        status.appendChild(document.createTextNode(msg + (e && e.message && !/Failed to fetch/i.test(e.message) ? ` (${e.message})` : '')));
      } else {
        // unreachable = not running → truly off, not an error state
        delete Store.connectors[c.id]; Store.persist();
        status.textContent = `Not running at ${base} — start it and validate again.`;
      }
      this.render();
    }
  },
```
Wiring: in `syncConnector(id)`, after the folder-log line insert `    if (c && c.kind === 'local-server') { const jobs = [this.connectServer(c)]; if (this._dirHandles[id]) jobs.push(this.rescanFolder(id)); return Promise.all(jobs); }`. In `refreshAll`, after the `_dirHandles` loop insert `    for (const c of CONNECTORS) if (c.kind === 'local-server' && Store.connectors[c.id]) jobs.push(this.connectServer(c));`. **No auto-validate on page load** (a refused localhost fetch logs a console error and would trip 10-baseline's "no console errors"); validation runs on the button, Sync, and Refresh only.

- [ ] **Step 5 — usage-logger proxy.** Create `docs/tools/ollama-usage-logger.mjs` (whole file):

```js
#!/usr/bin/env node
/**
 * ollama-usage-logger.mjs — one-file, zero-dependency Node proxy that sits in front of Ollama,
 * forwards every request untouched, and appends one JSONL line per completed generate/chat
 * request with the EXACT token counts Ollama reports (prompt_eval_count / eval_count on the native
 * endpoints, usage.* on the /v1 OpenAI-compatible ones).
 *
 * Why: Ollama keeps no usage history — token counts exist only inside each API response.
 *
 * Run:      node docs/tools/ollama-usage-logger.mjs
 * Then point clients at the proxy instead of Ollama, e.g.
 *   PowerShell:  $env:OLLAMA_HOST = "127.0.0.1:11435"; ollama run llama4
 *   bash:        OLLAMA_HOST=127.0.0.1:11435 ollama run llama4
 *   OpenAI SDKs: base_url = "http://127.0.0.1:11435/v1"
 * and in the dashboard's Ollama card choose the folder that holds the JSONL (default ~/.ai-usage).
 *
 * Env: LOG_PORT (11435) · OLLAMA_URL (http://127.0.0.1:11434) · USAGE_LOG (~/.ai-usage/ollama-usage.jsonl)
 * Line shape: {"ts":"<ISO>","platform":"Ollama","model":"llama4:8b","in":123,"out":456,"msgs":1,"path":"/api/chat"}
 * The dashboard reads it with parseUsageLoggerJsonl (any {ts, platform, model, in, out} JSONL works).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = parseInt(process.env.LOG_PORT || '11435', 10);
const UPSTREAM = new URL(process.env.OLLAMA_URL || 'http://127.0.0.1:11434');
const OUT = process.env.USAGE_LOG || path.join(os.homedir(), '.ai-usage', 'ollama-usage.jsonl');
const CAPTURE = /^\/(api\/(generate|chat)|v1\/(chat\/completions|completions|responses))(\?|$)/;
const MAX_BUF = 8 * 1024 * 1024;   // never hold more than 8 MB of a single response body

fs.mkdirSync(path.dirname(OUT), { recursive: true });

function record(pathname, body) {
  let model = 'unknown', inTok = 0, outTok = 0, found = false;
  const text = body.toString('utf8');
  if (pathname.startsWith('/api/')) {
    // native: NDJSON when streaming, single JSON otherwise — the done:true object carries the counts
    for (const line of text.split('\n')) {
      const s = line.trim(); if (!s || s[0] !== '{') continue;
      let o; try { o = JSON.parse(s); } catch { continue; }
      if (o.model) model = o.model;
      if (o.prompt_eval_count != null || o.eval_count != null) { inTok = +o.prompt_eval_count || 0; outTok = +o.eval_count || 0; found = true; }
    }
  } else {
    // OpenAI-compatible: one JSON, or SSE "data: {...}" chunks (usage is only present when the client
    // asked for stream_options.include_usage — otherwise there is nothing to record)
    const sse = /^data:/m.test(text);
    const chunks = sse ? text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(l => l && l !== '[DONE]') : [text];
    for (const s of chunks) {
      let o; try { o = JSON.parse(s); } catch { continue; }
      if (o.model) model = o.model;
      const u = o.usage;
      if (u && (u.prompt_tokens != null || u.completion_tokens != null || u.input_tokens != null)) {
        inTok = +(u.prompt_tokens ?? u.input_tokens) || 0; outTok = +(u.completion_tokens ?? u.output_tokens) || 0; found = true;
      }
    }
  }
  if (!found) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), platform: 'Ollama', model, in: inTok, out: outTok, msgs: 1, path: pathname });
  fs.appendFile(OUT, line + '\n', (err) => { if (err) console.error('usage-logger: write failed', err.message); });
  console.log(`logged ${model} in=${inTok} out=${outTok} (${pathname})`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const capture = req.method === 'POST' && CAPTURE.test(url.pathname);
  const up = http.request({ hostname: UPSTREAM.hostname, port: UPSTREAM.port || 80, path: req.url, method: req.method, headers: { ...req.headers, host: UPSTREAM.host } }, (ur) => {
    res.writeHead(ur.statusCode || 502, ur.headers);
    const parts = []; let size = 0;
    ur.on('data', (chunk) => { res.write(chunk); if (capture && size < MAX_BUF) { parts.push(chunk); size += chunk.length; } });   // stream through, tee for the log
    ur.on('end', () => { res.end(); if (capture && (ur.statusCode || 500) < 400) { try { record(url.pathname, Buffer.concat(parts)); } catch (e) { console.error('usage-logger: parse failed', e.message); } } });
    ur.on('error', () => res.end());
  });
  up.on('error', (e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'upstream unreachable: ' + e.message })); });
  req.pipe(up);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`ollama-usage-logger: http://127.0.0.1:${PORT} → ${UPSTREAM.origin} · writing ${OUT}`);
  console.log(`Point clients at the proxy: OLLAMA_HOST=127.0.0.1:${PORT}  (or base_url http://127.0.0.1:${PORT}/v1)`);
});
```
Smoke (manual, optional — no Ollama in CI): `node --check docs/tools/ollama-usage-logger.mjs` must exit 0. Add the note to `docs/tools/` only via this file (no README).

- [ ] **Step 6:** suite ×2 → green; byte scan of `docs/tools/ollama-usage-logger.mjs` → 0. Commit: `git add "AI Usage Dashboard.html" tests/checks/87-folder-logs.mjs docs/tools/ollama-usage-logger.mjs && git commit -m "feat: Ollama local-server validate + CORS/offline messages + usage-logger proxy doc"`

---

### Task 16: Export parsers — Gemini Takeout `MyActivity.json` (estimated) + Cursor usage-events CSV (exact)

**Files:** Modify `AI Usage Dashboard.html`, `tests/fixtures/gen.mjs`, `tests/checks/87-folder-logs.mjs`

Research rows: **Gemini** — `Takeout/My Activity/Gemini Apps/MyActivity.json` (choose JSON): array of `{header:'Gemini Apps', title:'Prompted <text>', time (ISO), safeHtmlItem:[{html}], products:['Gemini Apps'], …}`; an activity log (one record per prompt/response), no model, no tokens → **estimated** from text; not a conversation tree, so input is the prompt only (lower bound). Platform string `'Gemini app'` (distinct from the `'Gemini'` API connector — chat-app rows must not masquerade as API usage). **Cursor** — `cursor.com/dashboard?tab=usage → Export CSV` (individual users): per-event `Date, Kind, Model, Max Mode, Input (w/ Cache Write), Input (w/o Cache Write), Cache Read, Output Tokens, Total Tokens` (+ `Cost` before mid-2026; team CSVs add `User`) — column names are not officially documented → **detect defensively** (`Kind` + `Model` + an `Input…` and an `Output…` column, plus `Max Mode` or `Cache Read`); tokens **exact**, cost only if the column exists. Cache-write tokens = `Input (w/ Cache Write) − Input (w/o Cache Write)`.

- [ ] **Step 1 — fixtures.**

```js
  // T16a — Gemini Takeout MyActivity.json. estTok = round(chars/4). r1: prompt 40 → 10, html 80 → 20 · r2: 20 → 5, 'Hi & bye' 8 → 2 · r3: 4 → 1, 'ok !!' 5 → 1
  //   Expected: in=16 out=23 msgs=3 skipped=2 (a YouTube record + an undated Gemini record) · platform 'Gemini app' · est
  w('takeout/MyActivity.json', JSON.stringify([
    { header: 'Gemini Apps', title: 'Prompted ' + 'x'.repeat(40), time: '2026-08-10T09:00:00.000Z', safeHtmlItem: [{ html: '<p>' + 'y'.repeat(80) + '</p>' }], products: ['Gemini Apps'], activityControls: ['Gemini Apps Activity'] },
    { header: 'Gemini Apps', title: 'Prompted ' + 'abcdefghij'.repeat(2), time: '2026-08-10T21:30:00.000Z', safeHtmlItem: [{ html: 'Hi &amp; bye' }], products: ['Gemini Apps'] },
    { header: 'YouTube', title: 'Watched something', time: '2026-08-10T22:00:00.000Z', products: ['YouTube'] },
    { header: 'Gemini Apps', title: 'Prompted abcd', time: '2026-08-11T08:00:00.000Z', safeHtmlItem: [{ html: '<b>ok</b>!!' }], products: ['Gemini Apps'] },
    { header: 'Gemini Apps', title: 'Prompted no time on this one', safeHtmlItem: [{ html: 'x' }], products: ['Gemini Apps'] },
  ], null, 1));
  // T16b — Cursor usage-events CSV (header set as reported by users on forum.cursor.com; parsed defensively).
  //   row1: in 1000, cw 200 (1200−1000), cr 900, out 300 · row2: in 500, cw 0, out 80 · row3: in 2500, cw 500, out 600 · row4: 'abc' rejected → in 10, cw 0, out 5
  //   Expected: in=4010 cw=700 cr=900 out=985 msgs=4 rejected=1 · platform Cursor · no cost column → no billed rows
  w('cursor/usage-events.csv', [
    'Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens',
    '2026-08-10T09:00:00.000Z,Included,claude-4.5-sonnet,No,1200,1000,900,300,2400',
    '2026-08-10T09:30:00.000Z,Included,claude-4.5-sonnet,No,500,500,0,80,580',
    '2026-08-11T10:00:00.000Z,Usage-based,gpt-5.4,Yes,3000,2500,0,600,3600',
    '2026-08-11T10:05:00.000Z,Included,gpt-5.4,No,abc,10,0,5,15',
  ].join('\n') + '\n');
```

- [ ] **Step 2 — failing checks.**

```js
    // ---- T16: exports (Gemini Takeout + Cursor CSV) ----
    const takeout = read('takeout', 'MyActivity.json'), cursorCsv = read('cursor', 'usage-events.csv');
    const ex = await page.evaluate(async (tk, cs) => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {};
      const kind = sniffJSON(JSON.parse(tk), 'MyActivity.json');
      const g = parseGeminiTakeout(JSON.parse(tk));
      const gt = g.rows.reduce((a, r) => ({ in: a.in + r.in, out: a.out + r.out, msgs: a.msgs + r.msgs, est: a.est && r.est === 1 }), { in: 0, out: 0, msgs: 0, est: true });
      const head = parseCSV(cs.split(/\r?\n/, 1)[0])[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
      const isCursor = isCursorUsageCSV(head), isGenericHead = isCursorUsageCSV(['date', 'platform', 'model', 'input_tokens', 'output_tokens']);
      const cu = parseCursorUsageCSV(cs);
      const ct = cu.rows.reduce((a, r) => ({ in: a.in + r.in, cw: a.cw + r.cw, cr: a.cr + r.cr, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });
      await App.handleImportFiles([new File([tk], 'MyActivity.json', { type: 'application/json' }), new File([cs], 'usage-events.csv', { type: 'text/csv' })]);
      const notes = document.getElementById('import-status').textContent;
      const out = { kind, gt, gPlat: g.rows[0].platform, gSkipped: g.meta.skipped, gHourOk: g.rows.some(r => r.hour === new Date('2026-08-10T21:30:00.000Z').getHours()),
        isCursor, isGenericHead, ct, cPlat: cu.rows[0].platform, cRejected: cu.meta.rejected, cBilled: cu.billed.length,
        srcT: !!Store.sources['gemini-takeout'], srcC: !!Store.sources['cursor-csv'], genericCsvUntouched: !Store.sources.csv, notes,
        badge: document.querySelector('#src-import .badge').textContent, imports: connectorById('imports').srcIds, order: PLATFORM_ORDER };
      Store.sources = {}; Store.connectors = {}; Store.persist();
      return out;
    }, takeout, cursorCsv);
    ok('takeout: MyActivity.json sniffed as gemini-takeout and parsed (est. in=16 out=23 msgs=3; 2 records skipped; hour kept) as platform "Gemini app"',
      ex.kind === 'gemini-takeout' && ex.gt.in === 16 && ex.gt.out === 23 && ex.gt.msgs === 3 && ex.gt.est && ex.gPlat === 'Gemini app' && ex.gSkipped === 2 && ex.gHourOk, JSON.stringify(ex.gt));
    ok('cursor: usage-events CSV detected (generic CSV header is NOT) and parsed exactly (in=4010 cw=700 cr=900 out=985 msgs=4; 1 rejected cell; no cost column)',
      ex.isCursor && !ex.isGenericHead && ex.ct.in === 4010 && ex.ct.cw === 700 && ex.ct.cr === 900 && ex.ct.out === 985 && ex.ct.msgs === 4 && ex.cPlat === 'Cursor' && ex.cRejected === 1 && ex.cBilled === 0, JSON.stringify(ex.ct));
    ok('imports: drop zone routes both formats to their own sources (generic csv untouched); badge + srcIds + PLATFORM_ORDER list them',
      ex.srcT && ex.srcC && ex.genericCsvUntouched && /Gemini Takeout/.test(ex.notes) && /Cursor/.test(ex.notes) && /Takeout/.test(ex.badge) && /Cursor/.test(ex.badge)
      && ex.imports.includes('gemini-takeout') && ex.imports.includes('cursor-csv') && ex.order.includes('Gemini app') && ex.order.includes('Cursor'), JSON.stringify({ notes: ex.notes, badge: ex.badge, imports: ex.imports }));
```

RED: `parseGeminiTakeout is not defined`.

- [ ] **Step 3 — registry + order + copy.**
  1. Imports entry: replace `srcIds: ['chatgpt', 'claudeai', 'csv'] },` with `srcIds: ['chatgpt', 'claudeai', 'csv', 'gemini-takeout', 'cursor-csv'] },`.
  2. `PLATFORM_ORDER`: replace `  .concat(['ChatGPT', 'Claude.ai', 'Other']);` with `  .concat(['ChatGPT', 'Claude.ai', 'Gemini app', 'Cursor', 'Other']);   // import-only platforms without their own connector entry; Other stays last`.
  3. Imports card copy — replace
```html
      <div class="card-head"><h2>Imports</h2><span class="badge">ChatGPT · Claude.ai · Gemini · CSV</span></div>
      <div class="desc">
        Drop exported files here:
        <b>ChatGPT</b> data export (<code>conversations.json</code>) · <b>Claude.ai</b> data export (<code>conversations.json</code>) ·
        API responses saved by the PowerShell commands · or a generic <b>CSV</b>
        (<code>date, platform, model, input_tokens, output_tokens[, cache_read_tokens, cache_write_tokens, cost_usd]</code>) — handy for Gemini, which has no usage API.
      </div>
```
  with
```html
      <div class="card-head"><h2>Imports</h2><span class="badge">ChatGPT · Claude.ai · Gemini Takeout · Cursor CSV · CSV</span></div>
      <div class="desc">
        Drop exported files here:
        <b>ChatGPT</b> data export (<code>conversations.json</code>; tokens estimated from text) · <b>Claude.ai</b> data export (<code>conversations.json</code>; estimated) ·
        <b>Gemini</b> Google Takeout (<code>My Activity/Gemini Apps/MyActivity.json</code> — pick JSON format in Takeout; estimated from text, one record per prompt) ·
        <b>Cursor</b> usage-events CSV (cursor.com/dashboard → Usage → Export CSV; exact tokens, cost only if the column is present) ·
        API responses saved by the PowerShell commands · or a generic <b>CSV</b>
        (<code>date, platform, model, input_tokens, output_tokens[, cache_read_tokens, cache_write_tokens, cost_usd]</code>) — handy for the Gemini API, which has no usage endpoint.
        Consumer chat apps expose no usage API a local page can call — their usage comes from your data export.
      </div>
```

- [ ] **Step 4 — parsers + sniff.** After `parseClaudeAiExport` (anchor: the closing `}` before `/** Parses a large chat export off the main thread`) add:

```js
/** Google Takeout — My Activity/Gemini Apps/MyActivity.json: array of activity records {header:'Gemini Apps',
 *  title:'Prompted <text>', time, safeHtmlItem:[{html}], products:['Gemini Apps']}. One record = one prompt +
 *  response, no conversation tree, no model, no tokens → estimated from text; input = the prompt only (lower bound).
 *  Non-Gemini and undated records are skipped and counted. */
function parseGeminiTakeout(arr) {
  const agg = makeAgg(); let msgs = 0, skipped = 0;
  const strip = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  const isGemini = (r) => r.header === 'Gemini Apps' || (Array.isArray(r.products) && r.products.includes('Gemini Apps'));
  for (const r of arr) {
    if (!r || typeof r !== 'object' || !isGemini(r)) { skipped++; continue; }
    const ts = r.time ? new Date(r.time) : null;
    if (!ts || isNaN(ts)) { skipped++; continue; }
    const prompt = String(r.title || '').replace(/^Prompted\s+/i, '');
    const resp = Array.isArray(r.safeHtmlItem) ? r.safeHtmlItem.map(x => strip(x && x.html)).join(' ') : '';
    agg.add(dayKey(ts), 'Gemini app', 'gemini (app)', { in: estTok(prompt.length), out: estTok(resp.length), msgs: 1, est: 1 }, undefined, ts.getHours());
    msgs++;
  }
  return { rows: agg.rows(), meta: { msgs, skipped, records: arr.length } };
}
```
In `sniffJSON`, inside `if (Array.isArray(obj) && obj.length) {` add as the FIRST test:
```js
    if (obj[0] && (obj[0].header === 'Gemini Apps' || (Array.isArray(obj[0].products) && obj[0].products.includes('Gemini Apps')))) return 'gemini-takeout';
```
After `parseGenericCSV` (anchor: its closing `}` before `/* =================================================================\n * 4) Provider API payloads`) add:

```js
/* Cursor dashboard "usage events" CSV (individual users: cursor.com/dashboard → Usage → Export CSV). Header cells as
 * reported by users: Date, Kind, Model, Max Mode, Input (w/ Cache Write), Input (w/o Cache Write), Cache Read,
 * Output Tokens, Total Tokens[, Cost][, User]. Not officially documented → detected + parsed defensively.
 * `head` = header cells normalized to lowercase_with_underscores. */
function isCursorUsageCSV(head) {
  return head.includes('kind') && head.includes('model') && head.some(h => /^input/.test(h)) && head.some(h => /^output/.test(h)) && (head.includes('max_mode') || head.some(h => /^cache_read/.test(h)));
}
function parseCursorUsageCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('Empty CSV');
  const head = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const find = (re) => head.findIndex(h => re.test(h));
  const iDate = find(/^(date|timestamp|time)$/), iModel = find(/^model$/), iInCw = find(/^input_w_cache_write/), iInNoCw = find(/^input_w_o_cache_write/),
        iIn = find(/^input(_tokens)?$/), iCr = find(/^cache_read/), iOut = find(/^output(_tokens)?$/), iCost = find(/^cost/);
  if (iDate < 0 || iModel < 0) throw new Error('Not a Cursor usage-events CSV (needs Date + Model columns)');
  const agg = makeAgg(); const billed = new Map(); let n = 0, rejected = 0;
  const num = (c, i) => { if (i < 0) return 0; const raw = String(c[i] ?? '').trim(); if (!raw) return 0; const v = Number(raw.replace(/[,$\s]/g, '')); if (Number.isFinite(v) && v >= 0) return v; rejected++; return 0; };
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r]; const raw = String(c[iDate] || '').trim();
    const ts = new Date(raw); const d = RE_DATEONLY.test(raw) ? raw : dayKey(ts);
    if (!d) { rejected++; continue; }
    const model = String(c[iModel] || '').trim() || 'cursor';
    const inTok = iInNoCw >= 0 ? num(c, iInNoCw) : num(c, iIn);
    const cw = iInCw >= 0 && iInNoCw >= 0 ? Math.max(0, num(c, iInCw) - inTok) : 0;   // "Input (w/ Cache Write)" − "Input (w/o Cache Write)" = cache-write tokens
    const hour = !RE_DATEONLY.test(raw) && !isNaN(ts) ? ts.getHours() : undefined;
    agg.add(d, 'Cursor', model, { in: inTok, cw, cr: num(c, iCr), out: num(c, iOut), msgs: 1 }, undefined, hour);
    n++;
    if (iCost >= 0 && String(c[iCost] ?? '').trim() !== '') { const v = Number(String(c[iCost]).replace(/[,$\s]/g, '')); if (Number.isFinite(v)) billed.set(d, (billed.get(d) || 0) + v); }
  }
  return { rows: agg.rows(), billed: [...billed.entries()].map(([d, amount]) => ({ d, amount })), meta: { rows: n, rejected } };
}
```

- [ ] **Step 5 — import routing.** In `handleImportFiles`, replace
```js
        if (f.name.endsWith('.csv')) {
          const res = parseGenericCSV(await f.text());
```
with
```js
        if (f.name.endsWith('.csv')) {
          const csvText = await f.text();
          const headCells = (parseCSV(csvText.split(/\r?\n/, 1)[0])[0] || []).map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
          if (isCursorUsageCSV(headCells)) {
            const res = parseCursorUsageCSV(csvText);
            Store.setSource('cursor-csv', res.rows, res.meta);   // re-import replaces (one export = the full window)
            if (res.billed.length) Store.setBilled('cursor-csv', res.billed);
            notes.push(`${f.name}: Cursor usage-events CSV — ${res.meta.rows} events (exact tokens${res.billed.length ? ' + cost column' : '; no cost column in this export'})`
              + (res.meta.rejected ? ` — ${res.meta.rejected} value(s) rejected (non-numeric or negative)` : ''));
            imported++;
            continue;
          }
          const res = parseGenericCSV(csvText);
```
and, in the JSON branch, after the `claudeai-export` block (`        } else if (kind === 'anthropic-usage') {` is the next anchor) insert BEFORE it:
```js
        } else if (kind === 'gemini-takeout') {
          const res = parseGeminiTakeout(obj);
          Store.setSource('gemini-takeout', res.rows, res.meta);
          notes.push(`${f.name}: Gemini Takeout — ${fmtInt(res.meta.msgs)} prompts (estimated tokens${res.meta.skipped ? `; ${res.meta.skipped} non-Gemini/undated record(s) skipped` : ''})`);
          imported++;
```
(That is: change `        } else if (kind === 'anthropic-usage') {` into the takeout block followed by the unchanged anthropic-usage line.)

- [ ] **Step 6:** suite ×2 → green (40-sniff's existing kinds are unaffected: the Takeout test precedes the `mapping`/`chat_messages` tests but matches only Gemini records). Commit: `git add "AI Usage Dashboard.html" tests/fixtures/gen.mjs tests/checks/87-folder-logs.mjs && git commit -m "feat: Gemini Takeout + Cursor usage CSV importers"`

---

### Task 17: Final verification + screenshots (light/dark/print) + docs status

**Files:** Modify `docs/superpowers/specs/2026-08-16-every-llm-and-view-design.md`, `docs/superpowers/reviews/2026-08-15-v1-code-review.md`; artifacts under `tests/artifacts/`

- [ ] **Suite ×2** → all green, exit 0 (expect roughly 127 + 3 T1 + 3 T2 + 1 T3 + 2 T4 + 5 T5 + 2 T6 + 2 T7 + 1 T8 + 2 T9 + 1 T10 + 2 T11 + 2 T12 + 2 T13 + 2 T14 + 3 T15 + 3 T16 ≈ 163 — guidance only).
- [ ] **Byte hygiene** across `AI Usage Dashboard.html`, `tests/**/*.mjs`, `docs/tools/*.mjs` → `control bytes: 0` (the `String.fromCharCode` scan; never type the byte). **Size gate:** `AI Usage Dashboard.html` ≤ 600 KB (expect ~215 KB).
- [ ] **Screenshots** with seeded rich data (15 days of multi-platform rows incl. `hour` from at least Codex + Cline + LM Studio fixtures, one budget at 80%, one connected + one attention connector, one hidden card so the "1 hidden — show" chip is visible, one collapsed group) → `tests/artifacts/v4a-light.png`, `v4a-dark.png`, and `v4a-print.png` (emulate print — confirm collapsed sections re-appear, hub/hub-bar/✕ buttons hidden). Zero console errors. Visually confirm: group headers with counts, quality badges on cards, the ✕ on hover, the search box (registry now has 17 entries → box visible), the Ollama card's URL row + folder row inside the Manage modal, generic cards' link rows.
- [ ] **Docs.** In the spec, set the Status line to `Wave 1 implemented (Plan 4a, branch v4a-view-folder-logs); Wave 2 pending` and append a **Wave 1 notes** section listing: (a) Ollama desktop `db.sqlite` history deferred (needs sql.js; no token counts there anyway); (b) folder-log parsers do not feed the Projects table yet (Codex/Cline carry cwd/task ids — Wave 2: per-source projects); (c) secondary methods deferred to Wave 2 parsers: Aider `--analytics-log` JSONL, Gemini CLI telemetry outfile, VS Code Copilot Chat OTel file, Cursor `state.vscdb`; (d) budget editor now lists only used/budgeted platforms; (e) hub search matches card name only; (f) new $0 "Local open-weight" price row — users with a saved price list must Reset to defaults (or add it) to see local models priced at $0. Append to `docs/superpowers/reviews/2026-08-15-v1-code-review.md` Status: `Plan 4a (branch v4a-view-folder-logs) delivers the View layer, hub groups/search, the generic folder-log driver with 9 parsers, Ollama local-server + usage-logger doc, and Gemini Takeout / Cursor CSV importers.` Commit: `git add docs/superpowers/specs/2026-08-16-every-llm-and-view-design.md docs/superpowers/reviews/2026-08-15-v1-code-review.md tests/artifacts/v4a-light.png tests/artifacts/v4a-dark.png tests/artifacts/v4a-print.png && git commit -m "docs: Plan 4a status + Wave 1 screenshots"`
- [ ] Report `git log --oneline main..HEAD` (expect 17 commits) and a clean `git status`. Do not merge — the whole-branch integration review precedes the merge (spec: Testing).

## Self-review notes

1. **Spec coverage per task.** View preferences (`aiusage:view` shape `{hiddenCards, collapsed, hiddenInsights, showLegacySources}`) → T1 (cards: hover ✕, "N hidden — show", auto-reveal via `Store.setConnector`), T2 (▾/▸ on insights row, narrative, daily, by-model, platform share, model breakdown, projects, budgets, price list, data sources; collapsed = body hidden, header stays; print ignores via a screen-only rule), T3 (✕ per insight + "show all"), T4 (legacy sources hidden by default + settings toggle in the hub bar). Hub at scale (groups in spec order, group headers collapsible through the View store as `hub:<group>`, connected → attention → disconnected then registry order, search box when visible cards > 12 filtering by name; existing 7 mapped: local/copilot → coding, anthropic/openai/gemini/openrouter → api, imports → chat) → T5. Connector kinds: `folder-log` generic driver (glob-match → parser → rows; incremental cache keyed per connector; `scanFolder(connector, handle)`) → T6; parsers Codex/Gemini CLI/Copilot CLI/Continue/Cline/Roo/Aider/Junie/LM Studio → T7–T14 (each: registry entry + one parser + fixture with a duplicate or malformed record + exact-totals check + platform + hour where the format has it); `local-server` live-validate for Ollama with unreachable → off and CORS → one-line env fix, plus the usage-logger one-file script written in full → T15; `export-file` sniffed parsers for Gemini Takeout (estimated) and Cursor CSV (exact) with sniff/CSV routing and Imports badge/copy → T16. Honesty rules: every generic card's copy is quality-first and mirrors its research row (Junie/Aider are `estimated`; Ollama says live/validate only; the Imports card says chat-app usage comes from data exports); local open-weight models price at $0 via a new anchored `DEFAULT_PRICES` row (T14, asserted in 87-folder-logs) so free local inference never shows the "Unknown model" fallback cost. Error handling: unrecognized files skipped and counted (`meta.files` counts matched files only; parse errors → `badLines`, never abort); local-server unreachable → not running (off, not error); CORS → hint; export unrecognized → "format not recognized" as today. Storage: `ScanCache` keys per (connectorId, path, size, mtime) with connector-scoped pruning; `PLATFORM_ORDER` deduped and extended with import-only platforms.
2. **Deferred to Wave 2 (with reasons).** Ollama desktop `db.sqlite` history — spec listed "Ollama history" in Wave 1, but reading SQLite in one file needs sql.js (WASM, ~1 MB) and the table carries no token counts (estimation only) → deferred, card says so. Folder-log projects into the Projects table (parsers return `projects: []`; `Store.projects` stays Claude-only to avoid the local scan overwriting merged data) → Wave 2 per-source projects. Secondary/exact-upgrade methods (Aider `--analytics-log` JSONL, Gemini CLI telemetry outfile, VS Code Copilot Chat OTel export, Cursor `state.vscdb`) → Wave 2 parsers, noted on the cards. LocalAI/vLLM/llama.cpp/GPT4All/Jan/text-gen-webui, api-key vendors, cloud-token trio, remaining exports, link-only cards, Claude.ai Enterprise Analytics — Wave 2 per spec.
3. **Type / name consistency (every new name, defined once, reused verbatim).** Store: `View` (`prefs`, `load`, `save`, `isCardHidden`, `hideCard`, `revealCard`, `showAllCards`, `isCollapsed`, `toggleCollapse`, `isInsightHidden`, `hideInsight`, `showAllInsights`, `setLegacySources`, `onConnectorChange`), `VIEW_DEFAULTS`. Tables: `SECTIONS` (id/label/head/body), `HUB_GROUPS` (id/label), `QUALITY_LABEL`, `GENERIC_SKIP_DIRS`. Registry fields: `category`, `kind: 'folder-log' | 'local-server'`, `patterns`, `siblings`, `exclude`, `parser`, `hint`, `quality`, `qualityNote`, `paths`, `links {get, docs, usage}`, `baseUrl`, `validate`, `corsHint`, `statusEl: '<id>-status'`, `srcIds: [id]`. App: `_hubQuery`, `_dirHandles`, `wireCollapsibles`, `applyCollapse`, `wireInsightHides`, `applyInsightHides`, `wireLegacyToggle`, `applyLegacySources`, `hubCard`, `renderHub`, `ensureSourceCard`, `scanFiles`, `scanFolder`, `pickFolderFor`, `rescanFolder`, `restoreFolderHandles`, `connectServer`; `_gen[c.id]` dynamic counters. Globals: `collectFilesFromHandle`, `parseFolderCached`, `parseClaudeLogsCached` (wrapper), `eachJsonl`, `parseUsageLoggerJsonl`, `parseCodexRollouts`, `parseGeminiCliSessions`, `parseCopilotCliEvents`, `parseContinueDevData`, `parseClineTasks`, `parseAiderHistory`, `parseJunieEvents`, `parseLmStudioConversations`, `probeServer`, `validateOllama`, `parseGeminiTakeout`, `isCursorUsageCSV`, `parseCursorUsageCSV`; `ScanCache.prune(keep, prefix)`. Parser contract: `(files, onProgress, seen, connector, siblingFiles) → { rows, projects, meta: { files, msgs, lines, badLines, addedIds } }` (`siblingFiles` = the connector.siblings matches, filtered once per scan; `_clineMetaIndex` WeakMap memoizes per array). Registry ids: `codex`, `gemini-cli`, `copilot-cli`, `continue`, `cline`, `roo`, `aider`, `junie`, `lmstudio`, `ollama`; source ids equal the connector id; import sources `gemini-takeout`, `cursor-csv`. Platform strings: `OpenAI Codex CLI`, `Gemini CLI`, `GitHub Copilot` (shared), `Continue.dev`, `Cline`, `Roo Code`, `Aider`, `JetBrains Junie`, `LM Studio`, `Ollama`, `Gemini app`, `Cursor`. DOM ids: `hub-bar`, `hub-chips`, `hub-search`, `show-legacy-sources`, `insights-head`, `insights-chips`, `sources-title`, `pricing-title`, `daily-body`, `models-body`, `share-body`, `src-<id>`, `<id>-status|-pick|-rescan|-progress|-fallback|-url|-validate`. Classes: `acct-hide`, `hub-hidden-chip`, `collapse-btn`, `row-head`, `sec-collapsed`, `legacy-off`, `insight-hide`, `insights-hidden-chip`, `hub-group`, `hub-group-head`, `hub-group-body`, `generic`, `rescan`, `links`, `q-<quality>`. Storage keys: LS `view`, `url:<id>`; IDB `dir:<id>`; cache sig `<connectorId>\u0001<path>\u0001<size>\u0001<mtime>` under `scan:v3:`.
4. **Order dependencies.** T1 before T2–T5 (View); T2 creates `#insights-head`/`#insights-chips` used by T3 and the section ids used by T4; T5 defines `QUALITY_LABEL` used by T6's cards; T6 defines `parseUsageLoggerJsonl` + `scanFiles` used by T15; T7 is the first permanent registry growth (T6 already generalized 98-hub's count and 85-hub-groups asserts against `CONNECTORS.length`); T9 relies on T5's shared-platform membership rule and T6's `PLATFORM_ORDER` dedupe; T16 extends `PLATFORM_ORDER` and the Imports `srcIds`. `Store.setConnector` calls `View.onConnectorChange` — `View` is declared before `Store` and only used at runtime.
5. **Byte hygiene note.** The plan's `\u0001` separators (cache signature and project keys in `parseFolderCached`, `ScanCache.prune`'s split, the check's `startsWith` probes) are visible six-character escapes; the implementer must paste them as text and run the `String.fromCharCode` byte scan after T6 and before every commit that touches those lines. The suite's `95-ui-misc` postRun pins the HTML; extend the manual scan to `tests/**` and `docs/tools/**` in T17.
6. **Existing checks touched.** Only `98-hub.mjs`'s card-count assertion (7 → `CONNECTORS.length`, registry-driven) — everything else stays byte-identical; 96-scan-cache / 88-backlog-15/16 keep passing through the wrapper because the Map cache only ever holds `local`-prefixed keys and pruning is scoped to that prefix.
7. **Counts are guidance; gate = green ×2.**
