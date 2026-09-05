import { openDashboard } from '../lib/harness.mjs';

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    // A per-file "Parsing…" status must appear before heavy work; we detect it by
    // instrumenting appendChild on the status node before importing.
    const sawParsing = await page.evaluate(async () => {
      localStorage.removeItem('aiusage:data');
      Store.sources = {}; Store.billed = {}; Store.projects = [];
      const status = document.getElementById('import-status');
      const texts = [];
      const orig = status.appendChild.bind(status);
      status.appendChild = (n) => { texts.push(n.textContent); return orig(n); };
      const csv = 'date,platform,model,input_tokens\n2026-08-10,Gemini,gemini-3,5\n';
      await App.handleImportFiles([new File([csv], 'tiny.csv', { type: 'text/csv' })]);
      status.appendChild = orig;
      return texts.some(t => /Parsing tiny\.csv/.test(t));
    });
    ok('import: shows per-file Parsing status before work', sawParsing, '');

    const keyLeak = await page.evaluate(() => {
      const SECRET = 'sk-ant-admin-SECRETSECRET';
      const inp = document.getElementById('anthropic-key');
      inp.value = SECRET;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('keyup', { bubbles: true }));
      return document.documentElement.outerHTML.includes('SECRETSECRET') ||
             document.getElementById('anthropic-cmd').textContent.includes('SECRETSECRET');
    });
    ok('security: typed key never appears in DOM text', keyLeak === false, '');

    const quotaSurfaced = await page.evaluate(() => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
      try { LS.set('probe', { x: 1 }); } finally { Storage.prototype.setItem = orig; }
      const banner = document.getElementById('storage-warning');
      const textOk = document.body.textContent.includes('storage is full');
      const styledOk = !!banner && getComputedStyle(banner).color !== getComputedStyle(document.body).color;
      return textOk && styledOk;
    });
    ok('storage: quota failure surfaces in the UI', quotaSurfaced, '');

    // Interplay guard (from Task 13 review): a quota failure DURING an import fires before
    // handleImportFiles' clear(status) — the warning must survive because it lives in a
    // dedicated #storage-warning banner, not in #import-status.
    const quotaSurvivesImport = await page.evaluate(async () => {
      document.getElementById('storage-warning')?.remove();
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
      try {
        const csv = 'date,platform,model,input_tokens\n2026-08-10,Gemini,gemini-3,5\n';
        await App.handleImportFiles([new File([csv], 'quota-probe.csv', { type: 'text/csv' })]);
      } finally { Storage.prototype.setItem = orig; }
      const banner = document.getElementById('storage-warning');
      return !!banner && banner.textContent.includes('storage is full');
    });
    ok('storage: mid-import quota warning survives the status clear', quotaSurvivesImport, '');

    // fix (clear-data): "Clear stored data" resets every status line to its initial text — link-only cards keep their permanent "No data path"
    // line, key cards read "Not connected.", dual-driver folder lines read "No <folder> folder chosen." — never blank
    const cleared = await page.evaluate(async () => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      App._render();
      const at = Date.now();
      Store.setConnector('groq', { label: 'API key · last 4: abcd', lastSync: at, err: null });
      Store.setConnector('jan', { serverLabel: '1 model', label: '1 model', lastSync: at, err: null });
      const gs = document.getElementById('groq-status'); gs.textContent = 'Validating…'; gs.dataset.gen = '3';   // an in-flight placeholder: clear-data bumps the gen, so the line resets too
      document.getElementById('jan-scan-status').textContent = 'Scanning…';
      const origConfirm = window.confirm; window.confirm = () => true;
      try { document.getElementById('clear-data').click(); } finally { window.confirm = origConfirm; }
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const t = (id) => document.getElementById(id).textContent;
      return { replicate: t('replicate-status'), groq: t('groq-status'), groqGen: gs.dataset.gen || '', jan: t('jan-status'), janScan: t('jan-scan-status'), anthropic: t('anthropic-status'), grok: t('grok-status'), conns: Object.keys(Store.connectors).length };
    });
    ok('clear-data: status lines reset to their initial text — link-only keeps "No data path", key cards "Not connected." (gen cleared), dual-driver folder line "No Jan data folder chosen.", export-file "No export imported yet." — never blank',
      /No data path/.test(cleared.replicate) && cleared.groq === 'Not connected.' && cleared.groqGen === '' && cleared.jan === 'Not connected.' && cleared.janScan === 'No Jan data folder chosen.'
      && cleared.anthropic === 'Not connected.' && /No export imported yet/.test(cleared.grok) && cleared.conns === 0, JSON.stringify(cleared));

    // copy: the Projects table lists Claude Code sessions AND Codex / Gemini CLI / Copilot CLI / Junie folder-log projects — title and hint must say so
    const proj = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.projectsBy = {}; Store.connectors = {};
      App.renderProjects();
      const h2 = document.querySelector('#card-projects h2').textContent, hintEmpty = document.getElementById('projects-hint').textContent;
      Store.projectsBy.codex = [{ project: 'D:/Code/rostum', msgs: 3, in: 100, cw: 0, cr: 0, out: 50, model: 'gpt-5-codex', platform: 'Codex' }];
      App.renderProjects();
      const hintData = document.getElementById('projects-hint').textContent, row = (document.querySelector('#projects-table td.name') || {}).textContent;
      Store.projectsBy = {}; App.renderProjects();
      return { h2, hintEmpty, hintData, row };
    });
    ok('copy: Projects card is titled "Projects" (not "local Claude sessions") and its hint names Claude Code, Codex, Gemini CLI, Copilot CLI and Junie logs (empty and with data)',
      proj.h2 === 'Projects' && proj.hintEmpty === 'from Claude Code, Codex, Gemini CLI, Copilot CLI and Junie logs' && proj.hintData === 'all time, from Claude Code, Codex, Gemini CLI, Copilot CLI and Junie logs' && proj.row === 'D:/Code/rostum', JSON.stringify(proj));

    // palette: ColorMap slots must be RELEASED when a platform no longer has data. Before this fix, once 12 platforms had ever
    // been seen in a browser profile every later platform folded into the 'Other' gray forever — even as the only platform on
    // the page. 12 platforms → replace every source with 1 new platform → it must get a real slot, and the persisted map must
    // drop the departed names.
    const slots = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      ColorMap.maps = { platform: {}, model: {} }; ColorMap.save();
      const row = (p, i) => ({ d: todayKey(), platform: p, model: 'm', in: 10 * i, cw: 0, cr: 0, out: 5, msgs: 1 });
      const twelve = Array.from({ length: 12 }, (_, i) => 'Old' + (i + 1));
      Store.setSource('csv', twelve.map((p, i) => row(p, i + 1)), {});
      App._render();
      const before = new Set(Object.values(ColorMap.maps.platform).filter(s => s !== -1)).size;
      Store.sources = {};
      Store.setSource('csv', [row('Fresh', 1)], {});
      App._render();
      const otherHex = getComputedStyle(document.documentElement).getPropertyValue('--other').trim();
      const color = ColorMap.colorOf('platform', 'Fresh', Store.platforms());
      const persisted = LS.get('colormap', null);
      const chips = [...document.querySelectorAll('#platform-chips .chip')].map(c => c.textContent);
      return { before, slot: ColorMap.maps.platform.Fresh, color, otherHex, persistedKeys: persisted ? Object.keys(persisted.platform) : null, chips };
    });
    ok('palette: slots are released — after 12 platforms, a lone new platform gets a real slot (not the Other gray) and the persisted map drops the departed names',
      slots.before === 12 && slots.slot >= 0 && slots.color !== slots.otherHex && JSON.stringify(slots.persistedKeys) === '["Fresh"]' && JSON.stringify(slots.chips) === '["Fresh"]', JSON.stringify(slots));

    // palette overflow: with more platforms than palette slots (12), the share bar and the chips must fold the overflow into ONE
    // 'Other' wedge/chip (sum of their totals, the --other gray) — the rule the daily series already applies — instead of drawing
    // every overflow platform as its own identical gray wedge/chip.
    const fold = await page.evaluate(() => {
      Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; App._drill = null; App.filters.hiddenPlatforms = new Set(); LS.del('view'); View.load();
      App.hiddenShare = new Set(); App.filters.metric = 'tokens';
      ColorMap.maps = { platform: {}, model: {} }; ColorMap.save();
      // P01..P14: 100 tokens each except P13 = 200 and P14 = 300 → total 1,700; the two overflow platforms fold to Other = 500 = 29.4%
      const tok = (i) => i === 13 ? 200 : i === 14 ? 300 : 100;
      const rows = Array.from({ length: 14 }, (_, i) => ({ d: todayKey(), platform: 'P' + String(i + 1).padStart(2, '0'), model: 'm', in: tok(i + 1), cw: 0, cr: 0, out: 0, msgs: 1 }));
      Store.setSource('csv', rows, {});
      App._render();
      const otherHex = getComputedStyle(document.documentElement).getPropertyValue('--other').trim();
      const segs = [...document.querySelectorAll('#share-chart svg g[role="img"]')].map(g => g.getAttribute('aria-label'));
      const others = segs.filter(l => /^Other:/.test(l));
      const chips = [...document.querySelectorAll('#platform-chips .chip')].map(c => c.textContent);
      const legend = [...document.querySelectorAll('#share-legend .item')].map(i => i.textContent);
      const tableRows = [...document.querySelectorAll('#share-table tbody tr')].map(tr => tr.firstChild.textContent);
      return { wedges: segs.length, others, chips, legend, tableRows, otherHex };
    });
    ok('palette overflow: 14 platforms → share bar has 13 wedges with exactly one Other (29.4% = P13 + P14); chips, share legend and share table fold the same two into one Other',
      fold.wedges === 13 && fold.others.length === 1 && /29\.4%/.test(fold.others[0]) && fold.chips.length === 13 && fold.chips.filter(c => c === 'Other').length === 1 && !fold.chips.includes('P13')
      && fold.legend.length === 13 && fold.legend.filter(c => c === 'Other').length === 1 && fold.tableRows.length === 13 && fold.tableRows.filter(c => c === 'Other').length === 1, JSON.stringify(fold));
  } finally {
    await page.close();
  }
}

export async function postRun({ ok }) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.join(import.meta.dirname, '..', '..');
  const html = fs.readFileSync(path.join(root, 'AI Usage Dashboard.html'));
  const bad = [...html].filter(b => b <= 8).length;
  ok('hygiene: no raw control bytes (<0x09) in the HTML file', bad === 0, 'found ' + bad);
  ok('size: AI Usage Dashboard.html is ≤ 600 KB', html.length <= 600 * 1024, Math.round(html.length / 1024) + ' KB');
  // every .mjs under tests/ (checks, lib, fixtures, tools — not node_modules / generated out / artifacts) and docs/tools/: separators stay visible escape text
  const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name === 'out' || e.name === 'artifacts') continue; const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (p.endsWith('.mjs')) out.push(p); } return out; };
  const files = walk(path.join(root, 'tests')).concat(fs.existsSync(path.join(root, 'docs', 'tools')) ? walk(path.join(root, 'docs', 'tools')) : []);
  const dirty = files.filter(p => [...fs.readFileSync(p)].some(b => b <= 8)).map(p => path.relative(root, p));
  ok('hygiene: no raw control bytes in tests/**/*.mjs and docs/tools/*.mjs', dirty.length === 0, dirty.join(', '));
}
