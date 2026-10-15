// Plan 9 / A1 — the generated price data model. The JSON in docs/superpowers/specs/ is the source of truth; tests/tools/sync-prices.mjs
// renders it into the HTML's PRICES block (PRICES_VERIFIED_ON, DEFAULT_PRICES, PRICE_OVERRIDES, MODEL_ALIASES). This check loads the
// same JSON in Node and asserts, in the page, that Pricing.resolve() lands where the JSON says for EVERY id: rows[].ids → the row's
// label (ids that are also retired aliases price as their successor and carry aliasOf), overrides → the platform row only when the
// platform is given, aliases → aliasOf === successor and never the fallback; the ids asserted by 88/97 keep their labels; a user-edited
// LS 'prices' list still replaces the rows only; the drift guard (sync-prices --check) exits 0; the file stays ≤ 800 KB.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDashboard } from '../lib/harness.mjs';

const ROOT = path.join(import.meta.dirname, '..', '..');
const JSON_PATH = path.join(ROOT, 'docs', 'superpowers', 'specs', '2026-10-15-price-rows.json');

export async function run({ browser, ok }) {
  const json = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const { page } = await openDashboard(browser);
  try {
    const res = await page.evaluate((json) => {
      LS.del('prices'); Pricing.load();
      // top-level const declarations are not globalThis properties — read them through typeof guards so a missing constant is a FAIL, not a throw
      const VERIFIED = typeof PRICES_VERIFIED_ON !== 'undefined' ? PRICES_VERIFIED_ON : undefined;
      const ovr = typeof PRICE_OVERRIDES !== 'undefined' ? PRICE_OVERRIDES : undefined;
      const al = typeof MODEL_ALIASES !== 'undefined' ? MODEL_ALIASES : undefined;
      const aliasOf = {}; for (const a of json.retired_aliases) if (a.successor) aliasOf[a.id.toLowerCase()] = a.successor;
      const succOf = (id) => aliasOf[String(id).toLowerCase()] || aliasOf[normalizeModelId(id)] || null;
      // (1) every id in rows[].ids
      const rowBad = []; let ids = 0, aliased = 0;
      for (const r of json.rows) for (const id of r.ids) {
        ids++;
        const hit = Pricing.resolve(id), succ = succOf(id);
        if (succ) { aliased++; const want = Pricing.resolve(succ).label; if (hit.label !== want || hit.aliasOf !== succ) rowBad.push([id, 'alias→' + succ, want, hit.label, hit.aliasOf || null]); }
        else if (hit.label !== r.label) rowBad.push([id, r.label, hit.label]);
      }
      // (2) every override: with the platform → the override row; without → something else
      const ovBad = []; let ovIds = 0;
      for (const o of json.overrides) for (const id of o.ids) {
        ovIds++;
        const a = Pricing.resolve(id, o.platform), b = Pricing.resolve(id);
        if (a.label !== o.label || b.label === o.label) ovBad.push([id, o.platform, o.label, a.label, b.label]);
      }
      // (3) every alias with a successor: aliasOf set, never the fallback row
      const alBad = []; let alIds = 0, noSucc = 0;
      for (const a of json.retired_aliases) {
        if (!a.successor) { noSucc++; continue; }
        alIds++;
        const h = Pricing.resolve(a.id);
        if (h.aliasOf !== a.successor || Pricing.isFallback(a.id)) alBad.push([a.id, a.successor, h.label, h.aliasOf || null, Pricing.isFallback(a.id)]);
      }
      // (4) legacy ids asserted by 88 / 97
      const L = (m) => Pricing.resolve(m).label;
      const legacy = {
        'claude-opus-4.1': L('claude-opus-4.1'), 'claude-4.1-opus': L('claude-4.1-opus'),
        'anthropic.claude-opus-4-1-20250805-v1:0': L('anthropic.claude-opus-4-1-20250805-v1:0'), 'claude-opus-4-1-20250805': L('claude-opus-4-1-20250805'),
        'gpt-5.4': L('gpt-5.4'), 'gemini-2.5-flash': L('gemini-2.5-flash'), 'claude-3.5-sonnet': L('claude-3.5-sonnet'),
      };
      // (5) constants + the returned object is a copy (the cached row in Pricing.rows never gains aliasOf)
      const grok = Pricing.resolve('grok-4'); const grok2 = Pricing.resolve('GROK-4');
      const rowHasAlias = Pricing.rows.some(r => 'aliasOf' in r);
      const alKeysLower = !!al && Object.keys(al).every(k => k === k.toLowerCase());
      // (6) Pricing.cost passes the row's platform; isFallback takes the platform too
      const o0 = json.overrides[0]; const M = { in: 1e6, out: 1e6, cw: 0, cr: 0 };
      const costOv = Pricing.cost(o0.ids[0], { ...M, platform: o0.platform }), costNo = Pricing.cost(o0.ids[0], M);
      const d0 = Pricing.resolve(o0.ids[0]);
      // (7) a user-edited LS 'prices' list replaces the rows only — overrides and aliases stay constant; reset restores the generated rows
      LS.set('prices', [{ pat: '^mine$', label: 'Mine', in: 1, out: 2, cw: 0, cr: 0 }, { pat: '.*', label: 'Unknown model', in: 3, out: 15, cw: 3.75, cr: 0.3 }]);
      Pricing.load();
      const user = { mine: Pricing.resolve('mine').label, rows: Pricing.rows.length, aliasStill: Pricing.resolve('grok-4').aliasOf || null, ovStill: Pricing.resolve(o0.ids[0], o0.platform).label, fbStill: Pricing.isFallback('zzz-never') };
      Pricing.reset();
      user.afterReset = Pricing.rows.length; user.resetLast = Pricing.rows[Pricing.rows.length - 1].pat;
      LS.del('prices'); Pricing.load();
      return {
        ids, aliased, rowBad: rowBad.slice(0, 10), rowBadN: rowBad.length, ovIds, ovBad, alIds, noSucc, alBad: alBad.slice(0, 10), alBadN: alBad.length, legacy,
        verifiedOn: VERIFIED, defaults: DEFAULT_PRICES.length, lastPat: DEFAULT_PRICES[DEFAULT_PRICES.length - 1].pat, lastRow: JSON.stringify((({ pat, label, in: i, out, cw, cr }) => ({ pat, label, in: i, out, cw, cr }))(DEFAULT_PRICES[DEFAULT_PRICES.length - 1])),
        ovN: ovr ? ovr.length : null, alN: al ? Object.keys(al).length : null, alKeysLower,
        grokAlias: grok.aliasOf || null, grokAlias2: grok2.aliasOf || null, grokLabel: grok.label, rowHasAlias, copy: grok !== Pricing.rows.find(r => r.label === grok.label),
        costOv, costNo, costOvWant: o0.in + o0.out, costNoWant: d0.in + d0.out, user,
      };
    }, json);
    const nSucc = json.retired_aliases.filter(a => a.successor).length;
    ok(`prices (Plan 9): every id in rows[].ids resolves to its row (${json.rows.length} rows, ${res.ids} ids; ids that are also retired aliases price as their successor with aliasOf)`,
      res.ids === 343 && res.rowBadN === 0, `mismatches ${res.rowBadN}: ${JSON.stringify(res.rowBad)}`);
    ok(`prices: every override (${json.overrides.length} rows, ${res.ovIds} ids) wins only when its platform is given — resolve(id, platform).label === override.label and resolve(id).label !== it`,
      res.ovIds > 0 && res.ovBad.length === 0, JSON.stringify(res.ovBad));
    ok(`prices: every retired alias with a successor (${nSucc}) resolves with aliasOf === successor and is never the fallback row (${res.noSucc} aliases without a successor fall to Unknown by design)`,
      res.alIds === nSucc && res.alBadN === 0, `mismatches ${res.alBadN}: ${JSON.stringify(res.alBad)}`);
    ok('prices: the ids asserted by 88/97 keep their labels (opus-4.1 dotted / family-last / Bedrock / dated → Opus 4 / 4.1; gpt-5.4; gemini-2.5-flash; claude-3.5-sonnet → Sonnet 4.x / 3.x)',
      res.legacy['claude-opus-4.1'] === 'Claude Opus 4 / 4.1' && res.legacy['claude-4.1-opus'] === 'Claude Opus 4 / 4.1' && res.legacy['anthropic.claude-opus-4-1-20250805-v1:0'] === 'Claude Opus 4 / 4.1'
      && res.legacy['claude-opus-4-1-20250805'] === 'Claude Opus 4 / 4.1' && res.legacy['gpt-5.4'] === 'GPT-5.4' && res.legacy['gemini-2.5-flash'] === 'Gemini 2.5 Flash' && res.legacy['claude-3.5-sonnet'] === 'Claude Sonnet 4.x / 3.x',
      JSON.stringify(res.legacy));
    ok(`prices: PRICES_VERIFIED_ON === json.generated (${json.generated}); DEFAULT_PRICES has ${json.rows.length} rows ending in the unchanged '.*' Unknown-model row; PRICE_OVERRIDES ${json.overrides.length}; MODEL_ALIASES ${nSucc} lowercased keys`,
      res.verifiedOn === json.generated && res.defaults === json.rows.length && res.lastPat === '.*' && res.lastRow === JSON.stringify({ pat: '.*', label: 'Unknown model', in: 3, out: 15, cw: 3.75, cr: 0.3 })
      && res.ovN === json.overrides.length && res.alN === nSucc && res.alKeysLower,
      JSON.stringify({ verifiedOn: res.verifiedOn, defaults: res.defaults, lastPat: res.lastPat, lastRow: res.lastRow, ovN: res.ovN, alN: res.alN, alKeysLower: res.alKeysLower }));
    ok('prices: resolve() returns a copy — aliasOf lives on the returned object (grok-4 → grok-4.3, case-insensitive), never on the row in Pricing.rows',
      res.grokAlias === 'grok-4.3' && res.grokAlias2 === 'grok-4.3' && !res.rowHasAlias && res.copy, JSON.stringify({ grokAlias: res.grokAlias, grokAlias2: res.grokAlias2, grokLabel: res.grokLabel, rowHasAlias: res.rowHasAlias, copy: res.copy }));
    ok('prices: Pricing.cost(model, t) passes t.platform — an overridden id costs the override rate with the platform and the default rate without',
      Math.abs(res.costOv - res.costOvWant) < 1e-9 && Math.abs(res.costNo - res.costNoWant) < 1e-9 && res.costOv !== res.costNo, JSON.stringify({ costOv: res.costOv, costNo: res.costNo, costOvWant: res.costOvWant, costNoWant: res.costNoWant }));
    ok('prices: a user-edited LS "prices" list replaces the rows only (2 rows, ^mine$ resolves) while aliases/overrides stay constant; reset restores the generated rows with .* last',
      res.user.mine === 'Mine' && res.user.rows === 2 && res.user.aliasStill === 'grok-4.3' && res.user.ovStill === json.overrides[0].label && res.user.fbStill === true
      && res.user.afterReset === json.rows.length && res.user.resetLast === '.*', JSON.stringify(res.user));
  } finally {
    await page.close();
  }
  // drift guard: the HTML block must equal a fresh render of the JSON
  const chk = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'tools', 'sync-prices.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
  ok('prices: node tests/tools/sync-prices.mjs --check exits 0 (PRICES block == fresh render of the JSON)', chk.status === 0, String((chk.stdout || '') + (chk.stderr || '')).trim().slice(0, 400));
  const html = fs.readFileSync(path.join(ROOT, 'AI Usage Dashboard.html'));
  ok('prices: AI Usage Dashboard.html is ≤ 800 KB with the full price list inline', html.length <= 800 * 1024, Math.round(html.length / 1024) + ' KB');
}
