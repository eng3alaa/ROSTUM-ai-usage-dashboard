// Wave-end screenshots (light / dark / print / one Manage modal) with seeded rich data. Run from the repo root:
//   node tests/tools/screenshots.mjs            → tests/artifacts/v4b-light.png, v4b-dark.png, v4b-print.png, v4b-modal.png
//   TAG=v4c node tests/tools/screenshots.mjs    → v4c-*.png (future waves)
// tests/artifacts/ is gitignored — inspect locally against the checklist in the plan; never git add the PNGs.
import fs from 'node:fs';
import path from 'node:path';
import { launch, openDashboard } from '../lib/harness.mjs';

const ART = path.join(import.meta.dirname, '..', 'artifacts');
fs.mkdirSync(ART, { recursive: true });
const TAG = process.env.TAG || 'v4b';
const out = (name) => path.join(ART, `${TAG}-${name}.png`);

const browser = await launch();
try {
  const { page, errors } = await openDashboard(browser);
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  // seed: 15 days of multi-platform rows (hour on the coding-tool rows), one budget at ~80%, connected + attention connectors,
  // folder-log projects, one hidden card (hidden chip), one collapsed group — all through the app's own stores
  await page.evaluate(() => {
    Store.sources = {}; Store.billed = {}; Store.projects = []; Store.projectsBy = {}; Store.connectors = {}; Budgets.limits = {}; LS.del('budgets'); LS.del('view'); View.load();
    const pad = (n) => String(n).padStart(2, '0');
    const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
    const idOf = (platform) => (CONNECTORS.find(c => c.platform === platform) || {}).id;
    // export-file cards never get a connector entry — their status comes from rows under their srcId (grok-export, copilot-activity-csv), the way Imports stores them
    const sidOf = (platform) => { const c = CONNECTORS.find(x => x.platform === platform); return c ? (c.kind === 'export-file' ? c.srcIds[0] : c.id) : undefined; };
    const mk = (platform, model, inT, outT, msgs, extra = {}) => { const rows = []; for (let i = 0; i < 15; i++) rows.push({ d: day(i), platform, model, in: inT, cw: 0, cr: Math.round(inT / 4), out: outT, msgs, hour: 9 + (i % 9), ...extra }); return rows; };
    const seeds = [
      ['local', 'Claude Code/Desktop', 'claude-sonnet-5', 60000, 9000, 12],
      [idOf('OpenAI Codex CLI'), 'OpenAI Codex CLI', 'gpt-5.4-codex', 30000, 5000, 8],
      [idOf('Fireworks AI'), 'Fireworks AI', 'accounts/fireworks/models/llama-v3p1-70b-instruct', 20000, 3000, 6],
      [idOf('LocalAI'), 'LocalAI', 'qwen3-14b', 15000, 2500, 5],
      [idOf('vLLM'), 'vLLM', 'meta-llama/Llama-3.1-8B', 9000, 1500, 4],
      [idOf('Azure OpenAI'), 'Azure OpenAI', 'gpt-5.4', 12000, 2000, 3],
      [sidOf('Grok'), 'Grok', 'grok-4', 4000, 1200, 3, { est: 1 }],
      [sidOf('Microsoft Copilot'), 'Microsoft Copilot', 'copilot', 2000, 800, 4, { est: 1 }],
    ];
    for (const [id, platform, model, i, o, m, extra] of seeds) if (id) Store.setSource(id, mk(platform, model, i, o, m, extra), { files: 3, msgs: 15 * m });
    for (const [id, label] of [['local', '12 log files'], [idOf('OpenAI Codex CLI'), '9 files'], [idOf('Fireworks AI'), 'acct-rostum'], [idOf('LocalAI'), '3 models installed'], [idOf('vLLM'), 'counts while this page is open']]) if (id) Store.setConnector(id, { label, lastSync: Date.now(), err: null });   // no entry for Grok / Microsoft Copilot (export-file)
    const az = idOf('Azure OpenAI'); if (az) Store.setConnector(az, { err: 'token expired — mint a new one', lastSync: Date.now() - 9 * 864e5 });   // attention card
    Store.projects = [{ project: '~/Code/rostum', model: 'claude-sonnet-5', in: 900000, cw: 0, cr: 225000, out: 135000, msgs: 180 }];
    const cx = idOf('OpenAI Codex CLI'); if (cx) Store.projectsBy[cx] = [{ project: '~/Code/rostum', model: 'gpt-5.4-codex', platform: 'OpenAI Codex CLI', in: 450000, cw: 0, cr: 112500, out: 75000, msgs: 120 }, { project: 'D:/Code/iLogger', model: 'gpt-5.4-codex', platform: 'OpenAI Codex CLI', in: 60000, cw: 0, cr: 15000, out: 9000, msgs: 20 }];
    Store.persist();
    Budgets.set('total', 1); const spent = Budgets.status().total.spent;   // status().total is null until a total limit exists
    Budgets.set('total', Math.max(0.01, Math.round(spent / 0.8 * 100) / 100));   // limit = spent / 0.8 to the cent → pct ≈ 80 and spent < limit → "approaching" banner + ~80% bar (an integer floor on a few dollars of month-to-date spend would read 96%)
    const hideMe = CONNECTORS.find(c => c.kind === 'link-only'); if (hideMe) View.hideCard(hideMe.id);   // "1 hidden — show" chip
    View.toggleCollapse('hub:cloud');   // one collapsed group
    App._render();
  });
  const shot = async (theme, name) => {
    await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); App._render(); }, theme);
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: out(name), fullPage: true });
  };
  await shot('light', 'light');
  await shot('dark', 'dark');
  // Manage modal of a cloud-token card (key input, fields, session-only note) — light theme
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light'); const c = CONNECTORS.find(x => x.kind === 'cloud-token'); App.openConnectorModal(c.id); });
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: out('modal'), fullPage: false });
  await page.evaluate(() => document.getElementById('connector-modal').close());
  // print: emulate the print medium; beforeprint/printReport fills the report header; collapsed sections must re-appear
  await page.emulateMediaType('print');
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light'); App.printReport(true); });
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: out('print'), fullPage: true });
  await page.emulateMediaType('screen');
  console.log('console errors:', errors.length, errors.slice(0, 5));
  console.log('wrote', ['light', 'dark', 'modal', 'print'].map(out).join('\n       '));
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
