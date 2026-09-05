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
