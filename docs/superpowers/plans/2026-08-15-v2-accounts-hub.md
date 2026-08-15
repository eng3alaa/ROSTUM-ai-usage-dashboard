# v2 Accounts Hub — Connector Registry + New Connectors (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the "login for each AI" accounts hub: a single `CONNECTORS` registry driving per-platform account cards (connect → validate → sync → disconnect), add Gemini / GitHub Copilot / OpenRouter connectors, close deferred defects #5 (registry) and #7 (incremental scan cache), and clear the Plan 2 backlog items recorded in the spec.

**Architecture:** Still ONE self-contained file (`AI Usage Dashboard.html`, now ~124 KB, 41-check suite green). The seven hand-synced "what is a source" sites collapse into one `CONNECTORS` table; a new Accounts Hub card grid renders from it; the existing per-source cards become the bodies of per-connector "Manage" modals (DOM nodes moved, ids preserved, existing wiring untouched). New connectors are plain `async function` declarations (stubbable via `window.X = ...` in checks, like `fetchAnthropicAll` in Plan 1).

**Tech stack:** unchanged (vanilla HTML/JS/SVG; puppeteer-core rig in `tests/`).

**Context for the engineer:**
- Spec: `docs/superpowers/specs/2026-08-15-ai-accounts-rich-dashboard-design.md` (sections: Architecture → Connector registry; Platform connectors table; UI → Accounts hub / Connect modal; **Plan 2 backlog** — items 1–9 are all owned by this plan except #2/#3/#4, which belong to Plan 3's chart/report work).
- Plan 1 conventions ALL still apply: strict TDD with RED evidence before every fix; explicit `git add <files>` (never `-A`); check files wrap page use in `try/finally { await page.close(); }`; stateful checks reset `localStorage['aiusage:data']` + `Store.sources/billed/projects` (until T2 makes the harness do it); suite gate = **all checks pass, exit 0, run twice** — never trust count predictions.
- The dashboard file is NUL-free; normal Grep/Edit work. Functions are global via declarations; `const` bindings are lexical (callable in evaluate, not on `window`).
- Locate edit sites by the unique anchors given per task (line numbers WILL drift task to task).
- Suite: `node tests/run.mjs` (fixtures regenerate each run). Current baseline: 41 checks.

## File structure

```
AI Usage Dashboard.html          # all app changes, in place
tests/lib/harness.mjs            # T2: default storage isolation + keepStorage opt-out
tests/run.mjs                    # T2: postRun in finally
tests/fixtures/gen.mjs           # T6-T8: canned connector API payloads
tests/checks/97-registry.mjs     # T1 registry invariants + T3 compaction
tests/checks/96-scan-cache.mjs   # T4 incremental cache
tests/checks/98-hub.mjs          # T5 hub UI + state, T9 marks, T10 drill-down
tests/checks/99-connectors.mjs   # T6 Gemini, T7 Copilot, T8 OpenRouter (stubbed fetchJSON)
```

(9x-prefixed so they sort after Plan 1's checks; `95-ui-misc.mjs` already exists — do not collide.)

---

### Task 0: Branch

- [ ] `cd "D:/Code/rostum" && git checkout main && git switch -c v2-accounts-hub`
- [ ] Verify baseline: `node tests/run.mjs` → all 41 pass, exit 0. Commit nothing.

---

### Task 1: CONNECTORS registry replaces the seven hand-synced sites (defect #5)

**Files:** Modify `AI Usage Dashboard.html`, Create `tests/checks/97-registry.mjs`

- [ ] **Step 1 — failing checks.** Create `tests/checks/97-registry.mjs`:

```js
import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const reg = await page.evaluate(() => ({
      isArray: Array.isArray(CONNECTORS),
      ids: CONNECTORS.map(c => c.id),
      platforms: CONNECTORS.map(c => c.platform).filter(Boolean),
      order: PLATFORM_ORDER,
      everyHasCard: CONNECTORS.every(c => !c.statusEl || !!document.getElementById(c.statusEl)),
    }));
    ok('registry: CONNECTORS table exists with the 7 connectors',
      reg.isArray && ['local','anthropic','openai','gemini','copilot','openrouter','imports']
        .every(id => reg.ids.includes(id)), JSON.stringify(reg.ids));
    ok('registry: PLATFORM_ORDER is derived from the registry',
      reg.platforms.every(p => reg.order.includes(p)) && reg.order[reg.order.length - 1] === 'Other',
      JSON.stringify(reg.order));
    ok('registry: every connector statusEl resolves to a live element', reg.everyHasCard, '');

    // subtitle + clear-data must iterate the registry, not hardcoded lists
    const wiring = await page.evaluate(() => {
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = {} && [];
      Store.setSource('openrouter', [{ d: '2026-08-10', platform: 'OpenRouter', model: 'deepseek-v4', in: 5, cw: 0, cr: 0, out: 5, msgs: 1 }], {});
      App.renderSubtitle();
      const sub = document.getElementById('last-updated').textContent;
      return { sub };
    });
    ok('registry: subtitle names a NEW platform without hand-edits', /OpenRouter/.test(wiring.sub), wiring.sub);
  } finally {
    await page.close();
  }
}
```

Run: all three registry checks RED (`CONNECTORS is not defined`, thrown → one FAIL for the file). Everything else green.

- [ ] **Step 2 — the registry.** In the dashboard, directly ABOVE the `const PLATFORM_ORDER = [...]` line (anchor: `const PLATFORM_ORDER`), insert:

```js
/* =================================================================
 * CONNECTORS — single source of truth for every platform/source.
 * Adding a platform = adding one entry here (+ its card body HTML).
 * ================================================================= */
const CONNECTORS = [
  { id: 'local',      platform: 'Claude Code/Desktop', name: 'Claude Code / Desktop', kind: 'folder',
    statusEl: 'local-status',    brand: '#d97748', mark: 'CC', srcIds: ['local', 'local-import'] },
  { id: 'anthropic',  platform: 'Anthropic API',       name: 'Anthropic API',         kind: 'admin-key',
    statusEl: 'anthropic-status', brand: '#d4a27f', mark: 'An', srcIds: ['anthropic'], keyLS: 'key:anthropic', fetchMethod: 'fetchAnthropic' },
  { id: 'openai',     platform: 'OpenAI API',          name: 'OpenAI API',            kind: 'admin-key',
    statusEl: 'openai-status',   brand: '#10a37f', mark: 'Oa', srcIds: ['openai'], keyLS: 'key:openai', fetchMethod: 'fetchOpenAI' },
  { id: 'gemini',     platform: 'Gemini',              name: 'Gemini (Google AI)',    kind: 'api-key',
    statusEl: 'gemini-status',   brand: '#4285f4', mark: 'Ge', srcIds: ['gemini'], keyLS: 'key:gemini', fetchMethod: 'fetchGemini' },
  { id: 'copilot',    platform: 'GitHub Copilot',      name: 'GitHub Copilot',        kind: 'token',
    statusEl: 'copilot-status',  brand: '#8957e5', mark: 'Cp', srcIds: ['copilot'], keyLS: 'key:copilot', fetchMethod: 'fetchCopilot' },
  { id: 'openrouter', platform: 'OpenRouter',          name: 'OpenRouter',            kind: 'api-key',
    statusEl: 'openrouter-status', brand: '#6467f2', mark: 'Or', srcIds: ['openrouter'], keyLS: 'key:openrouter', fetchMethod: 'fetchOpenrouter' },
  { id: 'imports',    platform: null,                  name: 'Imports',               kind: 'files',
    statusEl: 'import-status',   brand: '#898781', mark: 'Im', srcIds: ['chatgpt', 'claudeai', 'csv'] },
];
const connectorById = (id) => CONNECTORS.find(c => c.id === id);
```

Then REPLACE the `PLATFORM_ORDER` literal with a derived version:

```js
const PLATFORM_ORDER = CONNECTORS.map(c => c.platform).filter(Boolean)
  .concat(['ChatGPT', 'Claude.ai', 'Other']);
```

(`ChatGPT`/`Claude.ai` are import-bucket platforms without their own connector entry; keep them explicit, `Other` stays last.)

- [ ] **Step 3 — registry-driven sites.** Three replacements, each with its anchor:
  1. **renderSubtitle** (anchor: `renderSubtitle`): replace its hardcoded `if (Store.sources.anthropic) srcNames.push('Anthropic API'); ...` chain with:
```js
    const srcNames = [];
    for (const c of CONNECTORS) {
      if (c.srcIds.some(id => Store.sources[id])) srcNames.push(c.name);
    }
```
  (keep the surrounding join/em-dash rendering as-is).
  2. **refreshAll** (anchor: `async refreshAll()`): replace the two hardcoded key checks with a registry loop that keeps identical behavior for anthropic/openai and is a no-op for connectors without a `sync` method yet:
```js
  async refreshAll() {
    const jobs = [];
    if (this.dirHandle) jobs.push(this.rescan());
    for (const c of CONNECTORS) {
      if (!c.keyLS) continue;
      const el2 = document.getElementById(c.id + '-key');
      if (LS.get(c.keyLS, null) && el2 && el2.value) {
        const fn = c.fetchMethod && this[c.fetchMethod];   // explicit — ids can't derive mixed-case names like fetchOpenAI
        if (typeof fn === 'function') jobs.push(fn.call(this));
      }
    }
    await Promise.allSettled(jobs);
    this.render();
  },
```
  3. **clear-data handler** (anchor: `clear-data`): replace the four hardcoded status resets with `for (const c of CONNECTORS) { const s = document.getElementById(c.statusEl); if (s) s.textContent = ''; }` (keep the confirm + clearAll + render).

- [ ] **Step 4 — placeholder status elements.** The three new connectors need `statusEl` targets before their cards exist (T5 builds the real cards). In the sources section HTML (anchor: `id="src-import"`), add BEFORE the import card:

```html
    <div class="card src" id="src-gemini" hidden><div class="status" id="gemini-status"></div></div>
    <div class="card src" id="src-copilot" hidden><div class="status" id="copilot-status"></div></div>
    <div class="card src" id="src-openrouter" hidden><div class="status" id="openrouter-status"></div></div>
```

- [ ] **Step 5:** suite → registry checks GREEN, all prior checks still green (subtitle check exercises the OpenRouter path end-to-end). Run twice.
- [ ] **Step 6:** `git add "AI Usage Dashboard.html" tests/checks/97-registry.mjs && git commit -m "feat: CONNECTORS registry - one table drives platforms, subtitle, refresh, clear (review #5)"`

---

### Task 2: Harness isolation + postRun-in-finally (backlog #5, #6)

**Files:** Modify `tests/lib/harness.mjs`, `tests/run.mjs`

- [ ] **Step 1:** in `openDashboard`, after `page.goto` and BEFORE the `opts.seedData` block, add:

```js
  if (!opts.seedData && !opts.keepStorage) {
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('aiusage:')) localStorage.removeItem(k); });
    await page.reload({ waitUntil: 'load' });
  }
```

- [ ] **Step 2:** in `tests/run.mjs`, restructure the per-module block so `postRun` runs even when `run` throws:

```js
    try {
      await mod.run({ browser, ok });
    } catch (err) {
      ok(f + ': threw', false, err && err.message || String(err));
    } finally {
      if (mod.postRun) { try { await mod.postRun({ ok }); } catch (e2) { ok(f + ': postRun threw', false, String(e2)); } }
    }
```

(The literal `await mod.run({ browser, ok });` line must survive.)

- [ ] **Step 3:** suite twice — all green. The existing checks' manual resets become redundant but harmless; do NOT remove them.
- [ ] **Step 4:** `git add tests/lib/harness.mjs tests/run.mjs && git commit -m "test: harness clears aiusage storage by default; postRun survives run() throw"`

---

### Task 3: Old-row compaction (backlog #1, sid row multiplication)

**Files:** Modify `AI Usage Dashboard.html`, Modify `tests/checks/97-registry.mjs`

- [ ] **Step 1 — failing check.** Append inside 97-registry's try:

```js
    const compacted = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      const rows = [];
      for (let i = 0; i < 12; i++) rows.push({ d: '2025-01-05', platform: 'Claude Code/Desktop', model: 'claude-sonnet-5', in: 10, cw: 0, cr: 0, out: 5, msgs: 1, sid: 'sess-' + i });
      rows.push({ d: dayKey(new Date()), platform: 'Claude Code/Desktop', model: 'claude-sonnet-5', in: 1, cw: 0, cr: 0, out: 1, msgs: 1, sid: 'sess-new' });
      Store.setSource('local', rows, {});
      const local = Store.sources.local.rows;
      const old = local.filter(r => r.d === '2025-01-05');
      const recent = local.filter(r => r.sid === 'sess-new');
      const t = old.reduce((a, r) => ({ in: a.in + r.in, msgs: a.msgs + r.msgs }), { in: 0, msgs: 0 });
      return { oldCount: old.length, oldHasSid: old.some(r => r.sid), recentHasSid: recent.length === 1 && !!recent[0].sid, in: t.in, msgs: t.msgs };
    });
    ok('compaction: rows older than 90d merge across sessions, totals exact',
      compacted.oldCount === 1 && !compacted.oldHasSid && compacted.in === 120 && compacted.msgs === 12,
      JSON.stringify(compacted));
    ok('compaction: recent rows keep their sid (dedupe still works)', compacted.recentHasSid, JSON.stringify(compacted));
```

RED: oldCount 12.

- [ ] **Step 2 — implement.** In `Store.setSource` (anchor: `setSource(id, rows, meta)`), compact before storing:

```js
  compactRows(rows) {
    const cutoff = addDays(todayKey(), -90);
    const keep = [], merge = new Map();
    for (const r of rows) {
      if (!r.sid || r.d >= cutoff) { keep.push(r); continue; }
      const k = r.d + '\u0001' + r.platform + '\u0001' + r.model;
      let b = merge.get(k);
      if (!b) { b = { d: r.d, platform: r.platform, model: r.model, in: 0, cw: 0, cr: 0, out: 0, msgs: 0 }; if (r.est) b.est = 1; merge.set(k, b); }
      b.in += r.in || 0; b.cw += r.cw || 0; b.cr += r.cr || 0; b.out += r.out || 0; b.msgs += r.msgs || 0;
      if (r.est) b.est = 1;
    }
    return keep.concat([...merge.values()]);
  },
  setSource(id, rows, meta) { this.sources[id] = { rows: this.compactRows(rows), meta: { ...meta, updated: Date.now() } }; this.persist(); },
```

(Only sid-carrying rows older than 90 days merge — cross-source dedupe only matters for recent overlap; est flag propagates.)

- [ ] **Step 3:** suite twice — green (Plan 1's dedupe checks all use recent/synthetic dates within 90d… NOTE: the Plan 1 fixture uses fixed dates `2026-08-10/11`, which are recent relative to 2026-08-15 but WILL age past 90d if this suite runs far in the future; if the baseline totals check fails on compaction grounds, update `tests/fixtures/gen.mjs` to generate dates relative to today — `addDays`-style — and adjust nothing else. Report if you had to do this.)
- [ ] **Step 4:** `git add "AI Usage Dashboard.html" tests/checks/97-registry.mjs [tests/fixtures/gen.mjs if touched] && git commit -m "feat: compact per-session rows older than 90 days (backlog #1)"`

---

### Task 4: Incremental scan cache (defect #7)

**Files:** Modify `AI Usage Dashboard.html`, Create `tests/checks/96-scan-cache.mjs`

- [ ] **Step 1 — failing check.** Create `tests/checks/96-scan-cache.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { openDashboard, OUT } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const sessText = fs.readFileSync(path.join(OUT, 'claude-logs', 'projects', '-D--proj1', 'sess-aaa.jsonl'), 'utf8');
    const r = await page.evaluate(async (text) => {
      const mk = () => ({ path: 'projects/-D--proj1/sess-aaa.jsonl', file: new File([text], 'sess-aaa.jsonl', { lastModified: 1754000000000 }) });
      const cache = new Map();                                  // injectable cache for tests
      const a = await parseClaudeLogsCached([mk()], null, cache);
      const b = await parseClaudeLogsCached([mk()], null, cache);
      const t = { in: 0, msgs: 0 };
      for (const row of b.rows) { t.in += row.in; t.msgs += row.msgs; }
      return { firstParsed: a.meta.parsedFiles, secondParsed: b.meta.parsedFiles, secondCached: b.meta.cachedFiles, ...t };
    }, sessText);
    ok('scan-cache: unchanged file parsed once, served from cache after',
      r.firstParsed === 1 && r.secondParsed === 0 && r.secondCached === 1, JSON.stringify(r));
    ok('scan-cache: cached result preserves exact totals', r.in === 110 && r.msgs === 2, JSON.stringify(r));
  } finally {
    await page.close();
  }
}
```

RED: `parseClaudeLogsCached is not defined`.

- [ ] **Step 2 — implement.** Directly AFTER `parseClaudeLogs` (anchor: its closing `}` before the chat-exports comment block), add:

```js
/** Incremental wrapper: per-file aggregates cached by (path, size, lastModified).
 *  cache: Map (tests) or the IDB-backed ScanCache (app). Reuses parseClaudeLogs per file. */
async function parseClaudeLogsCached(files, onProgress, cache) {
  const rows = [], projects = [];
  let msgs = 0, parsedFiles = 0, cachedFiles = 0, done = 0;
  for (const f of files) {
    const sig = f.path + '\u0001' + f.file.size + '\u0001' + f.file.lastModified;
    let entry = cache ? await cache.get(sig) : null;
    if (!entry) {
      const res = await parseClaudeLogs([f], null);
      entry = { rows: res.rows, projects: res.projects, msgs: res.meta.msgs };
      if (cache) await cache.set(sig, entry);
      parsedFiles++;
    } else cachedFiles++;
    rows.push(...entry.rows); projects.push(...entry.projects); msgs += entry.msgs;
    done++; if (onProgress) onProgress(done, files.length);
  }
  // merge project rows across files (same shape as parseClaudeLogs' projMap)
  const pm = new Map();
  for (const p of projects) {
    const k = p.project + '\u0001' + p.model;
    let b = pm.get(k);
    if (!b) { b = { ...p }; pm.set(k, b); } else { b.in += p.in; b.cw += p.cw; b.cr += p.cr; b.out += p.out; b.msgs += p.msgs; }
  }
  return { rows, projects: [...pm.values()], meta: { files: files.length, msgs, parsedFiles, cachedFiles } };
}

const ScanCache = {
  async get(sig) { try { return await IDB.get('scan:' + sig); } catch { return null; } },
  async set(sig, entry) { try { await IDB.set('scan:' + sig, entry); } catch {} },
};
```

Then in `scanHandle` (anchor: `parseClaudeLogs(files,` inside scanHandle), switch the call to `parseClaudeLogsCached(files, (done) => { prog.value = done; }, ScanCache)`, and in the folder-fallback handler (anchor: `folder-fallback`) switch its `parseClaudeLogs(files, ...)` call the same way (cache benefits both paths). The status line's message may reference `res.meta.files` — unchanged shape.

- [ ] **Step 3:** suite twice — green. **Step 4:** `git add "AI Usage Dashboard.html" tests/checks/96-scan-cache.mjs && git commit -m "feat: incremental scan cache keyed path/size/mtime (review #7)"`

---

### Task 5: Accounts hub — cards, connector state, Manage modal

**Files:** Modify `AI Usage Dashboard.html`, Create `tests/checks/98-hub.mjs`

- [ ] **Step 1 — failing checks.** Create `tests/checks/98-hub.mjs`:

```js
import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const hub = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#accounts-hub .acct')];
      return {
        n: cards.length,
        ids: cards.map(c => c.dataset.connector),
        dots: cards.map(c => c.querySelector('.dot')?.className || ''),
        allOff: cards.every(c => c.querySelector('.dot')?.classList.contains('off')),
      };
    });
    ok('hub: 7 account cards render from the registry', hub.n === 7 &&
      ['local','anthropic','openai','gemini','copilot','openrouter','imports'].every(id => hub.ids.includes(id)),
      JSON.stringify(hub.ids));
    ok('hub: all cards start disconnected (gray dot)', hub.allOff, JSON.stringify(hub.dots));

    const state = await page.evaluate(() => {
      Store.setConnector('openrouter', { label: 'my-key', lastSync: Date.now() });
      Store.setSource('openrouter', [{ d: dayKey(new Date()), platform: 'OpenRouter', model: 'deepseek-v4', in: 500, cw: 0, cr: 0, out: 200, msgs: 3 }], {});
      App.renderHub();
      const card = document.querySelector('#accounts-hub .acct[data-connector="openrouter"]');
      return {
        dot: card.querySelector('.dot').className,
        label: card.querySelector('.acct-label').textContent,
        stats: card.querySelector('.acct-stats').textContent,
      };
    });
    ok('hub: connected card shows green dot + label + 30d stats',
      /\bok\b/.test(state.dot) && /my-key/.test(state.label) && /700|0\.0/.test(state.stats),
      JSON.stringify(state));

    const stale = await page.evaluate(() => {
      Store.setConnector('openrouter', { label: 'my-key', lastSync: Date.now() - 8 * 864e5 });
      App.renderHub();
      return document.querySelector('#accounts-hub .acct[data-connector="openrouter"] .dot').className;
    });
    ok('hub: data older than 7 days turns the dot amber', /\bwarn\b/.test(stale), stale);

    const modal = await page.evaluate(() => {
      document.querySelector('#accounts-hub .acct[data-connector="anthropic"] .acct-manage').click();
      const dlg = document.getElementById('connector-modal');
      const containsCard = !!dlg.querySelector('#src-anthropic');
      const isOpen = dlg.open;
      dlg.querySelector('.modal-close').click();
      const restored = !dlg.querySelector('#src-anthropic') && !!document.querySelector('#sources #src-anthropic');
      return { isOpen, containsCard, restored };
    });
    ok('hub: Manage opens the modal hosting the real source card, close restores it',
      modal.isOpen && modal.containsCard && modal.restored, JSON.stringify(modal));
  } finally {
    await page.close();
  }
}
```

RED: `#accounts-hub` empty / `Store.setConnector is not a function` (thrown).

- [ ] **Step 2 — Store.connectors state.** In `Store` (anchor: `projects: [],`), add the field and helpers; extend `load`/`persist`/`clearAll` to carry `connectors`:

```js
  connectors: {},    // connectorId -> { label, lastSync, err }
```
```js
  setConnector(id, patch) { this.connectors[id] = { ...(this.connectors[id] || {}), ...patch }; this.persist(); },
  connectorStatus(c) {
    const st = this.connectors[c.id] || {};
    const hasData = c.srcIds.some(id => this.sources[id]);
    if (st.err) return 'warn';
    if (!hasData && !st.lastSync) return 'off';
    const ref = st.lastSync || Math.max(0, ...c.srcIds.map(id => (this.sources[id]?.meta?.updated) || 0));
    if (ref && Date.now() - ref > 7 * 864e5) return 'warn';
    return 'ok';
  },
```
`load()` gains `this.connectors = saved.connectors || {};`, `persist()` includes `connectors: this.connectors`, `clearAll()` resets it.

- [ ] **Step 3 — hub CSS.** After the `.filterbar` styles (anchor: `/* ============ Filter row ============ */` block end), insert:

```css
/* ============ Accounts hub ============ */
#accounts-hub { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; margin-bottom: 16px; }
.acct { background: var(--surface-1); border: 1px solid var(--border); border-left: 3px solid var(--acct-brand, var(--border));
        border-radius: 8px; padding: 10px 12px; cursor: pointer; }
.acct:hover { border-color: var(--baseline); border-left-color: var(--acct-brand, var(--baseline)); }
.acct-head { display: flex; align-items: center; gap: 8px; }
.acct .mark { width: 26px; height: 26px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center;
              font-size: 11px; font-weight: 700; color: #fff; background: var(--acct-brand, var(--other)); flex: none; }
.acct-name { font-weight: 650; font-size: 13px; margin-right: auto; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--other); flex: none; }
.dot.ok { background: var(--good-text); } .dot.warn { background: var(--serious); } .dot.off { background: var(--other); }
.acct-label, .acct-sync { color: var(--ink-2); font-size: 11.5px; margin-top: 4px; min-height: 14px; }
.acct-stats { font-size: 12px; margin-top: 4px; }
.acct-actions { display: flex; gap: 6px; margin-top: 8px; }
#connector-modal { border: 1px solid var(--border); border-radius: 10px; background: var(--surface-1); color: var(--ink);
                   max-width: 560px; width: calc(100vw - 48px); padding: 16px; }
#connector-modal::backdrop { background: rgba(0,0,0,0.45); }
#connector-modal .modal-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
#connector-modal .modal-close { margin-left: auto; }
#connector-modal .card.src { border: 0; padding: 0; background: transparent; }
```

- [ ] **Step 4 — hub HTML.** Directly BEFORE the KPI section (anchor: `<div class="kpis" id="kpis"`), insert:

```html
  <div id="accounts-hub" aria-label="AI accounts"></div>
  <dialog id="connector-modal">
    <div class="modal-head">
      <span class="mark" id="modal-mark"></span>
      <h2 id="modal-title"></h2>
      <button class="btn small modal-close">Close</button>
    </div>
    <div id="modal-body"></div>
  </dialog>
```

- [ ] **Step 5 — renderHub + modal logic.** New `App` methods (insert near `renderSubtitle`, anchor: `renderSubtitle`):

```js
  renderHub() {
    const hub = $('accounts-hub');
    clear(hub);
    const win30 = { from: addDays(todayKey(), -29), to: this.window().to };
    for (const c of CONNECTORS) {
      const st = Store.connectors[c.id] || {};
      const status = Store.connectorStatus(c);
      const rows = Store.allRows().filter(r => c.srcIds.includes('csv') || !c.platform ? c.srcIds.some(sid => (Store.sources[sid]?.rows || []).includes(r)) : r.platform === c.platform)
        .filter(r => r.d >= win30.from && r.d <= win30.to);
      let tok = 0, cost = 0;
      for (const r of rows) { tok += (r.in||0)+(r.cw||0)+(r.cr||0)+(r.out||0); cost += Pricing.cost(r.model, r); }
      const card = el('div', { class: 'acct', 'data-connector': c.id, style: { '--acct-brand': c.brand }, tabindex: 0, role: 'button',
        'aria-label': `${c.name}: ${status === 'ok' ? 'connected' : status === 'warn' ? 'needs attention' : 'not connected'}` },
        el('div', { class: 'acct-head' },
          el('span', { class: 'mark', text: c.mark }),
          el('span', { class: 'acct-name', text: c.name }),
          el('span', { class: 'dot ' + status })),
        el('div', { class: 'acct-label', text: st.err ? ('⚠ ' + st.err) : (st.label || (status === 'off' ? 'Not connected' : '')) }),
        el('div', { class: 'acct-sync', text: st.lastSync ? ('Synced ' + new Date(st.lastSync).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) : '' }),
        el('div', { class: 'acct-stats', text: rows.length ? `${fmtCompact(tok)} tokens · ${fmtUSD(cost)} (30d)` : '' }),
        el('div', { class: 'acct-actions' },
          el('button', { class: 'btn small acct-manage', text: status === 'off' ? 'Connect' : 'Manage', onclick: (e) => { e.stopPropagation(); this.openConnectorModal(c.id); } }),
          status !== 'off' && c.id !== 'imports' ? el('button', { class: 'btn small acct-sync-btn', text: 'Sync', onclick: (e) => { e.stopPropagation(); this.syncConnector(c.id); } }) : null,
          status !== 'off' ? el('button', { class: 'btn small', text: 'Disconnect', onclick: (e) => { e.stopPropagation(); this.disconnectConnector(c.id); } }) : null));
      card.addEventListener('click', () => this.drillDown(c));
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.drillDown(c); });
      hub.appendChild(card);
    }
  },

  openConnectorModal(id) {
    const c = connectorById(id);
    const dlg = $('connector-modal');
    $('modal-title').textContent = c.name;
    $('modal-mark').textContent = c.mark;
    $('modal-mark').style.background = c.brand;
    const src = document.getElementById('src-' + (id === 'imports' ? 'import' : id));
    if (src) { this._modalHome = src.parentNode; src.hidden = false; $('modal-body').appendChild(src); }
    dlg.showModal();
  },
  closeConnectorModal() {
    const dlg = $('connector-modal');
    const src = $('modal-body').firstElementChild;
    if (src && this._modalHome) { this._modalHome.appendChild(src); if (/^src-(gemini|copilot|openrouter)$/.test(src.id) && !Store.connectors[src.id.slice(4)]) src.hidden = true; }
    dlg.close();
  },
  syncConnector(id) {
    if (id === 'local') return this.rescan();
    const c = connectorById(id);
    const fn = c && c.fetchMethod && this[c.fetchMethod];
    if (typeof fn === 'function') return fn.call(this);
  },
  disconnectConnector(id) {
    const c = connectorById(id);
    if (c.keyLS) LS.del(c.keyLS);
    const keyInput = document.getElementById(id + '-key'); if (keyInput) keyInput.value = '';
    delete Store.connectors[id];
    if (confirm(`Also delete ${c.name}'s stored usage data? OK = delete, Cancel = keep the data.`)) {
      for (const sid of c.srcIds) delete Store.sources[sid];
      for (const sid of c.srcIds) delete Store.billed[sid];
    }
    Store.persist();
    this.render();
  },
```

Wire once in `wire()`/init (anchor: `clear-data`): `$('connector-modal').querySelector('.modal-close').addEventListener('click', () => this.closeConnectorModal());` and add `this.renderHub();` to `render()` (anchor: `_render()` body start — place after KPIs render call).

Also: `scanHandle` success sets `Store.setConnector('local', { label: res.meta.files + ' log files', lastSync: Date.now(), err: null })`; `fetchAnthropic`/`fetchOpenAI` successes set `Store.setConnector(id, { label: 'Admin key ·  last 4: ' + key.slice(-4), lastSync: Date.now(), err: null })`; their catches (non-superseded) set `Store.setConnector(id, { err: (e.message || String(e)).slice(0, 80) })`. `handleImportFiles` end sets `Store.setConnector('imports', { label: notes.length + ' file(s) imported', lastSync: Date.now() })`.

- [ ] **Step 6:** suite twice — hub checks GREEN, all prior green (note: the hub renders on every `render()`; the theme screenshots in T12 will show it).
- [ ] **Step 7:** `git add "AI Usage Dashboard.html" tests/checks/98-hub.mjs && git commit -m "feat: accounts hub - registry-driven cards, connector state, manage modal"`

---

### Task 6: Gemini connector (validate + model list; usage via guided CSV)

**Files:** Modify `AI Usage Dashboard.html`, Create `tests/checks/99-connectors.mjs`

- [ ] **Step 1 — failing check.** Create `tests/checks/99-connectors.mjs`:

```js
import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    const gem = await page.evaluate(async () => {
      window.fetchJSON = async (url) => {
        if (String(url).includes('generativelanguage')) return { models: [{ name: 'models/gemini-3.5-flash' }, { name: 'models/gemini-3-pro' }] };
        throw new Error('unexpected url ' + url);
      };
      document.getElementById('gemini-key').value = 'AIza-test';
      await App.fetchGemini();
      const st = Store.connectors.gemini;
      return { label: st && st.label, status: Store.connectorStatus(connectorById('gemini')), statusText: document.getElementById('gemini-status').textContent };
    });
    ok('gemini: key validates via models list, connector goes green',
      /2 models/.test(gem.label) && gem.status === 'ok' && /Connected/.test(gem.statusText), JSON.stringify(gem));

    const gemBad = await page.evaluate(async () => {
      window.fetchJSON = async () => { throw new Error('HTTP 400 — API key not valid'); };
      await App.fetchGemini();
      return { err: Store.connectors.gemini.err, status: Store.connectorStatus(connectorById('gemini')) };
    });
    ok('gemini: invalid key surfaces error + amber', /key not valid/i.test(gemBad.err) && gemBad.status === 'warn', JSON.stringify(gemBad));
  } finally {
    await page.close();
  }
}
```

RED: `App.fetchGemini is not a function` (thrown).

- [ ] **Step 2 — card body HTML.** Replace the placeholder `#src-gemini` div (from T1) with a real card (same structure as the anthropic card — copy its layout): heading "Gemini (Google AI)", copy explaining: *"Validates your Google AI Studio key and lists available models. Google's API has no usage-history endpoint — import a Cloud Billing export CSV (Imports card) for historical usage."*, a password input `id="gemini-key"` (placeholder `AIza…`), button `id="fetch-gemini"` "Validate & connect", remember checkbox `id="remember-gemini"`, status div `id="gemini-status"` (keep), and a link to https://aistudio.google.com/apikey.

- [ ] **Step 3 — fetcher + wiring.** Add `gemini: 0` to `App._gen`. New method next to `fetchOpenAI`:

```js
  async fetchGemini() {
    const gen = ++this._gen.gemini;
    const key = $('gemini-key').value.trim();
    const status = $('gemini-status');
    if (!key) { status.textContent = 'Paste a Google AI Studio API key first (starts with AIza).'; return; }
    if ($('remember-gemini') && $('remember-gemini').checked) LS.set('key:gemini', key);
    status.textContent = 'Validating…';
    try {
      const j = await fetchJSON('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key), {});
      if (gen !== this._gen.gemini) return;
      const n = (j.models || []).length;
      Store.setConnector('gemini', { label: n + ' models available', lastSync: Date.now(), err: null });
      status.textContent = '';
      status.appendChild(el('span', { class: 'ok', text: '● Connected. ' }));
      status.appendChild(document.createTextNode(`${n} models · usage history comes from billing CSV imports`));
      this.render();
    } catch (e) {
      if (gen !== this._gen.gemini) return;
      Store.setConnector('gemini', { err: (e.message || String(e)).slice(0, 80) });
      status.textContent = '';
      status.appendChild(el('span', { class: 'err', text: 'Validation failed: ' }));
      status.appendChild(document.createTextNode(e.message || String(e)));
      this.render();
    }
  },
```

Wire the button (anchor where `fetch-anthropic` is wired): `$('fetch-gemini').addEventListener('click', () => this.fetchGemini());`, restore remembered key on init like the others, and `remember-gemini` unchecked → `LS.del('key:gemini')` listener (copy the anthropic pattern).

- [ ] **Step 4:** suite twice — green. **Step 5:** `git add "AI Usage Dashboard.html" tests/checks/99-connectors.mjs && git commit -m "feat: Gemini connector - key validation + live model list, honest usage note"`

---

### Task 7: GitHub Copilot connector (best-effort billing usage)

**Files:** Modify `AI Usage Dashboard.html`, Modify `tests/checks/99-connectors.mjs`

- [ ] **Step 1 — failing checks** (append inside 99-connectors' try):

```js
    const cp = await page.evaluate(async () => {
      window.fetchJSON = async (url) => {
        const u = String(url);
        if (u.endsWith('/user')) return { login: 'alaa-dev' };
        if (u.includes('/settings/billing/usage')) return { usageItems: [
          { date: '2026-08-10', product: 'copilot', sku: 'copilot_premium_request', quantity: 14, netAmount: 0.56 },
          { date: '2026-08-11', product: 'copilot', sku: 'copilot_premium_request', quantity: 6, netAmount: 0.24 },
          { date: '2026-08-11', product: 'actions', sku: 'runner', quantity: 99, netAmount: 9.99 },
        ] };
        throw new Error('unexpected ' + u);
      };
      document.getElementById('copilot-key').value = 'github_pat_test';
      await App.fetchCopilot();
      const rows = Store.sources.copilot.rows;
      return { label: Store.connectors.copilot.label, n: rows.length,
        msgs: rows.reduce((a, r) => a + r.msgs, 0),
        billed: Store.billedRows('copilot').reduce((a, b) => a + b.amount, 0),
        platforms: [...new Set(rows.map(r => r.platform))] };
    });
    ok('copilot: PAT validates, only copilot items land, actions ignored',
      cp.label === 'alaa-dev' && cp.n === 2 && cp.msgs === 20 && Math.abs(cp.billed - 0.8) < 1e-9 &&
      cp.platforms.length === 1 && cp.platforms[0] === 'GitHub Copilot', JSON.stringify(cp));

    const cpNoUsage = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      window.fetchJSON = async (url) => {
        if (String(url).endsWith('/user')) return { login: 'alaa-dev' };
        throw new Error('HTTP 404');
      };
      await App.fetchCopilot();
      return { label: Store.connectors.copilot.label, err: Store.connectors.copilot.err || null,
        statusText: document.getElementById('copilot-status').textContent };
    });
    ok('copilot: usage endpoint missing degrades to validated-only, no error state',
      cpNoUsage.label === 'alaa-dev' && cpNoUsage.err === null && /no usage data|validated/i.test(cpNoUsage.statusText),
      JSON.stringify(cpNoUsage));
```

RED: `App.fetchCopilot is not a function`.

- [ ] **Step 2 — card body HTML** for `#src-copilot` (same pattern as T6): heading "GitHub Copilot", copy: *"Validates a fine-grained token (needs 'Plan: read'). Pulls Copilot premium-request usage where GitHub exposes it for your account; otherwise shows the connection only."*, password input `id="copilot-key"` (placeholder `github_pat_…`), button `id="fetch-copilot"` "Validate & connect", remember checkbox `id="remember-copilot"`, status div, link to https://github.com/settings/personal-access-tokens.

- [ ] **Step 3 — fetcher.** Add `copilot: 0` to `_gen`. New global fetcher + App method:

```js
async function fetchCopilotAll(token) {
  const h = { 'Authorization': 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28', 'Accept': 'application/vnd.github+json' };
  const user = await fetchJSON('https://api.github.com/user', h);
  let items = null;
  try {
    const y = new Date().getUTCFullYear();
    const u = await fetchJSON('https://api.github.com/users/' + user.login + '/settings/billing/usage?year=' + y, h);
    items = u.usageItems || u.usage_items || [];
  } catch (e) { console.warn('copilot billing usage unavailable', e); }
  const agg2 = makeAgg(); const billed = new Map();
  for (const it of items || []) {
    if (!String(it.product || '').toLowerCase().includes('copilot')) continue;
    const d = String(it.date || '').slice(0, 10) || (it.year + '-' + String(it.month).padStart(2, '0') + '-01');
    agg2.add(d, 'GitHub Copilot', it.sku || 'copilot', { msgs: finTok(it.quantity), est: 1 });
    billed.set(d, (billed.get(d) || 0) + finAmt(it.netAmount ?? it.net_amount ?? 0));
  }
  return { login: user.login, hadUsage: items !== null,
    rows: agg2.rows(), billed: [...billed.entries()].map(([d, amount]) => ({ d, amount })) };
}
```

```js
  async fetchCopilot() {
    const gen = ++this._gen.copilot;
    const key = $('copilot-key').value.trim();
    const status = $('copilot-status');
    if (!key) { status.textContent = 'Paste a fine-grained GitHub token first (github_pat_…).'; return; }
    if ($('remember-copilot') && $('remember-copilot').checked) LS.set('key:copilot', key);
    status.textContent = 'Validating…';
    try {
      const res = await fetchCopilotAll(key);
      if (gen !== this._gen.copilot) return;
      Store.setConnector('copilot', { label: res.login, lastSync: Date.now(), err: null });
      if (res.rows.length) { Store.setSource('copilot', res.rows, {}); Store.setBilled('copilot', res.billed); }
      status.textContent = '';
      status.appendChild(el('span', { class: 'ok', text: '● Connected. ' }));
      status.appendChild(document.createTextNode(res.rows.length
        ? `${res.rows.length} usage rows (premium requests) + billed costs`
        : (res.hadUsage ? 'validated — no Copilot usage in the billing data' : 'validated — GitHub exposes no usage data for this account')));
      this.render();
    } catch (e) {
      if (gen !== this._gen.copilot) return;
      Store.setConnector('copilot', { err: (e.message || String(e)).slice(0, 80) });
      status.textContent = '';
      status.appendChild(el('span', { class: 'err', text: 'Validation failed: ' }));
      status.appendChild(document.createTextNode(e.message || String(e)));
      this.render();
    }
  },
```

NOTE: `makeAgg().add(d, platform, model, t)` requires `t.in/cw/cr/out` to default — it uses `|| 0`, so `{ msgs, est }` alone is fine. Wire button/remember/restore like T6.

- [ ] **Step 4:** suite twice — green. **Step 5:** `git add "AI Usage Dashboard.html" tests/checks/99-connectors.mjs && git commit -m "feat: GitHub Copilot connector - PAT validation + best-effort premium-request usage"`

---

### Task 8: OpenRouter connector (key label, credits, daily activity)

**Files:** Modify `AI Usage Dashboard.html`, Modify `tests/checks/99-connectors.mjs`

- [ ] **Step 1 — failing checks** (append inside 99-connectors' try):

```js
    const or = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      window.fetchJSON = async (url) => {
        const u = String(url);
        if (u.endsWith('/api/v1/key')) return { data: { label: 'rostum-key', usage: 12.5, limit: null } };
        if (u.endsWith('/api/v1/credits')) return { data: { total_credits: 50, total_usage: 12.5 } };
        if (u.endsWith('/api/v1/activity')) return { data: [
          { date: '2026-08-10', model: 'deepseek/deepseek-v4', usage: 0.42, requests: 12, prompt_tokens: 90000, completion_tokens: 12000 },
          { date: '2026-08-11', model: 'x-ai/grok-5', usage: 1.1, requests: 4, prompt_tokens: 30000, completion_tokens: 9000 },
        ] };
        throw new Error('unexpected ' + u);
      };
      document.getElementById('openrouter-key').value = 'sk-or-test';
      await App.fetchOpenrouter();
      const rows = Store.sources.openrouter.rows;
      return { label: Store.connectors.openrouter.label, n: rows.length,
        in: rows.reduce((a, r) => a + r.in, 0), out: rows.reduce((a, r) => a + r.out, 0),
        billed: Store.billedRows('openrouter').reduce((a, b) => a + b.amount, 0),
        statusText: document.getElementById('openrouter-status').textContent };
    });
    ok('openrouter: key label + daily activity rows + billed per day + credits note',
      or.label === 'rostum-key' && or.n === 2 && or.in === 120000 && or.out === 21000 &&
      Math.abs(or.billed - 1.52) < 1e-9 && /37\.50|credits/i.test(or.statusText), JSON.stringify(or));

    const orNoActivity = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      window.fetchJSON = async (url) => {
        const u = String(url);
        if (u.endsWith('/api/v1/key')) return { data: { label: 'rostum-key' } };
        if (u.endsWith('/api/v1/credits')) return { data: { total_credits: 50, total_usage: 12.5 } };
        throw new Error('HTTP 403 — activity requires provisioning key');
      };
      await App.fetchOpenrouter();
      return { err: Store.connectors.openrouter.err || null, hasSrc: !!Store.sources.openrouter,
        statusText: document.getElementById('openrouter-status').textContent };
    });
    ok('openrouter: activity denied degrades to credits-only, no error state',
      orNoActivity.err === null && !orNoActivity.hasSrc && /credits/i.test(orNoActivity.statusText),
      JSON.stringify(orNoActivity));
```

RED: `App.fetchOpenrouter is not a function`.

- [ ] **Step 2 — card body HTML** for `#src-openrouter`: heading "OpenRouter", copy: *"One key covers every model you route through OpenRouter (DeepSeek, Grok, Mistral…). Pulls your key label, credit balance, and daily per-model activity."*, password input `id="openrouter-key"` (placeholder `sk-or-…`), button `id="fetch-openrouter"` "Validate & connect", remember checkbox `id="remember-openrouter"`, status div, link to https://openrouter.ai/settings/keys.

- [ ] **Step 3 — fetcher.** Add `openrouter: 0` to `_gen`. Global fetcher + App method (method name `fetchOpenrouter` — matches `syncConnector`'s `'fetch' + id[0].toUpperCase() + id.slice(1)` for id `openrouter`):

```js
async function fetchOpenRouterAll(key) {
  const h = { 'Authorization': 'Bearer ' + key };
  const info = await fetchJSON('https://openrouter.ai/api/v1/key', h);
  let credits = null;
  try { credits = (await fetchJSON('https://openrouter.ai/api/v1/credits', h)).data || null; } catch (e) { console.warn('openrouter credits unavailable', e); }
  let rows = [], billed = [], hadActivity = false;
  try {
    const act = await fetchJSON('https://openrouter.ai/api/v1/activity', h);
    hadActivity = true;
    const agg2 = makeAgg(); const bm = new Map();
    for (const a of act.data || []) {
      const d = String(a.date || '').slice(0, 10);
      agg2.add(d, 'OpenRouter', a.model || 'openrouter', { in: finTok(a.prompt_tokens), out: finTok(a.completion_tokens), msgs: finTok(a.requests) });
      bm.set(d, (bm.get(d) || 0) + finAmt(a.usage || 0));
    }
    rows = agg2.rows(); billed = [...bm.entries()].map(([d, amount]) => ({ d, amount }));
  } catch (e) { console.warn('openrouter activity unavailable', e); }
  return { label: (info.data && info.data.label) || 'OpenRouter key', credits, rows, billed, hadActivity };
}
```

```js
  async fetchOpenrouter() {
    const gen = ++this._gen.openrouter;
    const key = $('openrouter-key').value.trim();
    const status = $('openrouter-status');
    if (!key) { status.textContent = 'Paste an OpenRouter API key first (sk-or-…).'; return; }
    if ($('remember-openrouter') && $('remember-openrouter').checked) LS.set('key:openrouter', key);
    status.textContent = 'Fetching…';
    try {
      const res = await fetchOpenRouterAll(key);
      if (gen !== this._gen.openrouter) return;
      Store.setConnector('openrouter', { label: res.label, lastSync: Date.now(), err: null });
      if (res.rows.length) { Store.setSource('openrouter', res.rows, {}); Store.setBilled('openrouter', res.billed); }
      const creditsNote = res.credits ? ` · ${fmtUSD((res.credits.total_credits || 0) - (res.credits.total_usage || 0))} credits left` : '';
      status.textContent = '';
      status.appendChild(el('span', { class: 'ok', text: '● Connected. ' }));
      status.appendChild(document.createTextNode(res.rows.length
        ? `${res.rows.length} daily activity rows${creditsNote}`
        : `validated${creditsNote} — daily activity not available for this key type`));
      this.render();
    } catch (e) {
      if (gen !== this._gen.openrouter) return;
      Store.setConnector('openrouter', { err: (e.message || String(e)).slice(0, 80) });
      status.textContent = '';
      status.appendChild(el('span', { class: 'err', text: 'Fetch failed: ' }));
      status.appendChild(document.createTextNode(e.message || String(e)));
      this.render();
    }
  },
```

Wire button/remember/restore like T6/T7. (37.50 = 50 − 12.5 → `$37.50` via fmtUSD, which the first check's regex accepts.)

- [ ] **Step 4:** suite twice — green. **Step 5:** `git add "AI Usage Dashboard.html" tests/checks/99-connectors.mjs && git commit -m "feat: OpenRouter connector - key label, credits balance, daily per-model activity"`

---

### Task 9: Drill-down + chip identity

**Files:** Modify `AI Usage Dashboard.html`, Modify `tests/checks/98-hub.mjs`

- [ ] **Step 1 — failing checks** (append inside 98-hub's try):

```js
    const drill = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.connectors = {}; Store.projects = [];
      Store.setSource('openrouter', [{ d: dayKey(new Date()), platform: 'OpenRouter', model: 'x', in: 5, cw: 0, cr: 0, out: 5, msgs: 1 }], {});
      Store.setSource('csv', [{ d: dayKey(new Date()), platform: 'Gemini', model: 'y', in: 7, cw: 0, cr: 0, out: 7, msgs: 1 }], {});
      App.render();
      document.querySelector('#accounts-hub .acct[data-connector="openrouter"]').click();
      const rows = App.rowsIn(App.window());
      return { n: rows.length, all: rows.every(r => r.platform === 'OpenRouter') };
    });
    ok('hub: card click drills down to that platform only', drill.n === 1 && drill.all, JSON.stringify(drill));

    const undrill = await page.evaluate(() => {
      document.querySelector('#accounts-hub .acct[data-connector="openrouter"]').click();   // second click = undo
      return App.rowsIn(App.window()).length;
    });
    ok('hub: second click restores all platforms', undrill === 2, undrill);
```

RED: `drill.n === 2` (click does nothing yet).

- [ ] **Step 2 — implement.** New App method next to `renderHub`:

```js
  drillDown(c) {
    if (!c.platform) { this.filters.hiddenPlatforms = new Set(); this.render(); return; }   // imports → show everything
    const others = Store.platforms().filter(p => p !== c.platform);
    const already = others.length && others.every(p => this.filters.hiddenPlatforms.has(p)) && !this.filters.hiddenPlatforms.has(c.platform);
    this.filters.hiddenPlatforms = already ? new Set() : new Set(others);
    this.render();
    $('card-daily').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
```

(T5's `renderHub` already wires `card.addEventListener('click', () => this.drillDown(c))`; if T5 shipped it as a stub/no-op, replace the stub.) Verify the platform chips re-render from `this.filters.hiddenPlatforms` on `render()` — they do (Plan 1 behavior); no chip changes needed.

- [ ] **Step 3:** suite twice — green. **Step 4:** `git add "AI Usage Dashboard.html" tests/checks/98-hub.mjs && git commit -m "feat: account card drill-down filters to that platform (toggle)"`

---

### Task 10: Race hygiene backlog — scanHandle catch guard, unstick superseded status, soft-fail pin

**Files:** Modify `AI Usage Dashboard.html`, Modify `tests/checks/80-race.mjs`

- [ ] **Step 1 — failing checks** (append inside 80-race's try):

```js
    const softFail = await page.evaluate(async () => {
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = {} && []; Store.connectors = {};
      // import writes fresh billed data...
      await App.handleImportFiles([new File([JSON.stringify({ data: [{ starting_at: '2026-08-02T00:00:00Z', results: [{ amount: { value: '42', currency: 'USD' } }] }] })], 'cost.json')]);
      // ...then an ALREADY-IN-FLIGHT fetch resolves with usage OK but cost=null (soft fail)
      window.fetchAnthropicAll = async () => { await new Promise(r => setTimeout(r, 150)); return { usage: { rows: [{ d: '2026-08-11', platform: 'Anthropic API', model: 'claude-sonnet-5', in: 1, cw: 0, cr: 0, out: 1, msgs: 1 }] }, cost: null }; };
      document.getElementById('anthropic-key').value = 'sk-ant-admin-test';
      const p = App.fetchAnthropic();
      await new Promise(r => setTimeout(r, 10));
      App._gen.anthropic++;                                   // simulate a superseding action (import path bumps this)
      await Promise.allSettled([p]);
      const env = Store.billed.anthropic;
      return { stale: env.stale, amount: Store.billedRows('anthropic')[0].amount, statusText: document.getElementById('anthropic-status').textContent };
    });
    ok('race: soft-fail (cost=null) superseded fetch cannot stale-mark fresh import', softFail.stale === false && softFail.amount === 42, JSON.stringify(softFail));
    ok('race: superseded fetch does not leave status stuck at Fetching', !/Fetching/.test(softFail.statusText), softFail.statusText);
```

Run: the first may already be GREEN (mechanism verified in Plan 1's final review — it is then a stays-green pin, acceptable); the second must be RED (status stuck at `Fetching usage…`).

- [ ] **Step 2 — implement.**
  1. In every fetcher's gen-bail points (`fetchAnthropic`, `fetchOpenAI`, `fetchGemini`, `fetchCopilot`, `fetchOpenrouter` — both the post-await bail and the catch bail), replace the bare `return;` with:
```js
      { if (/^(Fetching|Validating)/.test(status.textContent)) status.textContent = ''; return; }
```
  2. In `scanHandle`, add the same guard to its `catch` block: first line `if (gen !== this._gen.local) return;` — note `gen` is currently declared inside the `try`; hoist the `const gen = ++this._gen.local;` declaration to before the `try` so the catch can see it.

- [ ] **Step 3:** suite twice — green. **Step 4:** `git add "AI Usage Dashboard.html" tests/checks/80-race.mjs && git commit -m "fix: unstick superseded fetch status; gen-guard scanHandle catch; pin soft-fail race"`

---

### Task 11: Full verification + screenshots + docs wrap-up

**Files:** Modify `docs/superpowers/reviews/2026-08-15-v1-code-review.md`, `docs/superpowers/specs/2026-08-15-ai-accounts-rich-dashboard-design.md`

- [ ] **Step 1:** `node tests/run.mjs && node tests/run.mjs` — ALL checks pass, exit 0, both runs (expect ~57; count is guidance, the gate is green×2).
- [ ] **Step 2:** theme screenshots (same one-off script as Plan 1 Task 16, adding a seeded connector so the hub shows a connected card): light + dark to `tests/artifacts/`, zero console errors, visually confirm the hub grid renders in both themes.
- [ ] **Step 3:** size gate: `AI Usage Dashboard.html` ≤ 340 KB.
- [ ] **Step 4:** docs: append to the review doc's Status section: `Plan 2 closes #5 (CONNECTORS registry) and #7 (incremental scan cache).` In the spec's "Plan 2 backlog" list, annotate items 1, 5, 6, 7, 8, 9 with `— DONE (Plan 2)`; items 2, 3, 4 remain for Plan 3.
- [ ] **Step 5:** `git add docs && git commit -m "docs: Plan 2 status - registry + cache landed, backlog items closed"`
- [ ] **Step 6:** report the branch commit list (`git log --oneline main..HEAD`) and clean `git status`.

---

## Self-review notes (applied while writing)

1. **Spec coverage:** registry (spec Architecture) → T1; incremental cache → T4; accounts hub UI + connector state + modal → T5; Gemini/Copilot/OpenRouter connectors with honest capability notes → T6–T8; drill-down → T9; backlog items 1/5/6/7/8/9 → T2/T3/T10. NOT in this plan (Plan 3): insights pack, narrative/reports, budgets/alerts, monogram *SVG* artwork upgrade (text monograms ship now), backlog 2/3/4, PS fallbacks for the three new connectors (all three APIs are browser-callable; revisit only if real-world CORS bites).
2. **Type consistency:** `Store.setConnector(id, patch)` / `Store.connectors[id] = {label, lastSync, err}` / `Store.connectorStatus(c)` used identically in T5, T6–T8, T10 checks. `finTok`/`finAmt` (Plan 1 round) reused by T7/T8 fetchers. `makeAgg` handles missing token fields via `|| 0`.
3. **Stubbing contract:** connectors call global `fetchJSON` (function declaration) — checks override `window.fetchJSON`. Do NOT convert fetchJSON to a const.
4. **`syncConnector`/`refreshAll` method contract:** the registry carries an explicit `fetchMethod` per key-bearing connector (`'fetchAnthropic'`, `'fetchOpenAI'`, `'fetchGemini'`, `'fetchCopilot'`, `'fetchOpenrouter'`) — never derive method names from ids (T1 review caught `fetchOpenai` ≠ `fetchOpenAI`). T6–T8 must name their App methods to match these exact strings and MUST also add their `fetchMethod` field usage nothing further — the field is already consumed generically.
5. **renderHub's 30d row filter** for the `imports` connector uses source membership, not platform — the `.includes(r)` identity test works because `allRows()` returns the same row objects held in `Store.sources[*].rows` (local-import overlap rows are filtered out before the identity test can see them).
6. **Counts:** never gate on exact totals; per-task RED/GREEN named checks + "all pass ×2" is the gate (Plan 1 lesson).

