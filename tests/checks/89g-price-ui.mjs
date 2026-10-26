// Plan 9 / A2 + Plan 10 / T3b — the price list UI and the price-set provenance. The bundled rows render grouped by vendor
// (<details class="price-group">, "N rows · M matched your data", open only where the user's own data lands, matched rows first, rows of a
// closed group filled on first open), each row with its verified date, a confidence pill, the vendor source link and — where a
// PRICE_OVERRIDES row beats it for the platform the data came from — the winning rate with "wins for <platform>"; the overrides sit in their
// own read-only group with the platform named. Above the list: "Prices verified <PRICES_VERIFIED_ON> — N days ago" (amber past 90 days,
// driven by the harness clock) with the list-price sentence. The editor keeps working on the grouped rows (add / edit / delete / reset,
// an edit flips the row's pill to "user" in place); the KPI footer and the CSV export's first line carry "prices: bundled set of <date>
// [, N user edits]"; Pricing.resolve() says which rate won (source: default / user / override, overrideFor).
import fs from 'node:fs';
import path from 'node:path';
import { openDashboard } from '../lib/harness.mjs';

const PART = path.join(import.meta.dirname, '..', '..', 'src', 'js', '02-prices.js');
const VERIFIED_ON = (fs.readFileSync(PART, 'utf8').match(/const PRICES_VERIFIED_ON = '(\d{4}-\d{2}-\d{2})';/) || [])[1];
const DAY = 86400000;
const plusDays = (iso, n) => new Date(Date.parse(iso + 'T09:00:00Z') + n * DAY).toISOString();

const seed = () => {
  Store.sources = {}; Store.billed = {}; Store.projects = []; Store.connectors = {}; LS.del('prices'); Pricing.load();
  App.filters.range = '30'; App._drill = null; App.filters.hiddenPlatforms = new Set();
  const r = (platform, model) => ({ d: dayKey(new Date(Date.now() - 3 * 86400000)), platform, model, in: 1_000_000, cw: 0, cr: 0, out: 1_000_000, msgs: 2 });
  Store.setSource('csv', [r('xAI', 'grok-4'), r('SambaNova', 'minimax-m3'), r('Anthropic API', 'claude-sonnet-5'), r('Ollama', 'llama-mystery')], {});
  App.renderPricing(); App._render();
};

export async function run({ browser, ok }) {
  ok('price-ui: PRICES_VERIFIED_ON read from src/js/02-prices.js', /^\d{4}-\d{2}-\d{2}$/.test(VERIFIED_ON || ''), String(VERIFIED_ON));
  const { page } = await openDashboard(browser, { clockAt: plusDays(VERIFIED_ON, 12) });
  try {
    await page.evaluate(seed);
    await page.evaluate(() => { window.PG = () => [...document.querySelectorAll('#pricing-groups details.price-group')]; });   // the vendor groups, re-read after every re-render

    // (1) vendor groups: every <details> summary reads "<vendor> · N rows · M matched your data[ · K overridden by a platform rate]"; the row
    //     counts add up to Pricing.rows; only groups where the data lands (or an override beats a row) are open; the overrides group names them all
    const groups = await page.evaluate(() => {
      const all = PG();
      const parse = (d) => { const m = d.querySelector('summary').textContent.match(/^(.+?) · (\d+) rows? · (\d+) matched your data(?: · (\d+) overridden by a platform rate)?$/); return m && { name: m[1], rows: +m[2], matched: +m[3], overridden: +(m[4] || 0), open: d.open, key: d.dataset.group, filled: d.querySelectorAll('tbody tr').length }; };
      const g = all.map(parse);
      const byName = (n) => g.find(x => x && x.name === n) || null;
      return { n: all.length, unparsed: g.filter(x => !x).length, keysMatchNames: g.every(x => x && x.key === x.name),
        rowsSum: g.filter(x => x && x.name !== 'Platform overrides').reduce((s, x) => s + x.rows, 0), listRows: Pricing.rows.length,
        openNames: g.filter(x => x && x.open).map(x => x.name).sort(), closedUnfilled: g.filter(x => x && !x.open).every(x => x.filled === 0),
        xai: byName('xAI'), minimax: byName('MiniMax'), anthropic: byName('Anthropic'), together: byName('Together AI'), lowerDupes: g.filter(x => x && x.name !== x.name.trim()).length,
        ov: byName('Platform overrides'), ovN: PRICE_OVERRIDES.length, fallback: byName('Fallback') };
    });
    ok(`price-ui (A2): the list renders as vendor <details class="price-group"> groups (${groups.n}) whose summaries read "<vendor> · N rows · M matched your data"; the row counts add up to Pricing.rows (${groups.listRows}); data-group = the vendor name`,
      groups.n >= 20 && groups.unparsed === 0 && groups.rowsSum === groups.listRows && groups.keysMatchNames, JSON.stringify({ n: groups.n, unparsed: groups.unparsed, rowsSum: groups.rowsSum, listRows: groups.listRows }));
    ok('price-ui (A2): vendor spellings are folded into one group each (xai + xAI → "xAI" 13 rows; together → "Together AI" 20 rows — the overrides spelled Together AI live in the Platform overrides group)',
      groups.xai && groups.xai.rows === 13 && groups.together && groups.together.rows === 20, JSON.stringify({ xai: groups.xai, together: groups.together }));
    ok('price-ui (A2): only the groups the seeded data lands on are open — Anthropic (claude-sonnet-5), xAI (grok-4 → Grok 4.3), MiniMax (minimax-m3, overridden for SambaNova) and Platform overrides; closed groups hold no rows yet (filled on first open); the local Ollama row never counts',
      JSON.stringify(groups.openNames) === JSON.stringify(['Anthropic', 'MiniMax', 'Platform overrides', 'xAI']) && groups.closedUnfilled && groups.fallback && groups.fallback.matched === 0 && !groups.fallback.open,
      JSON.stringify({ openNames: groups.openNames, closedUnfilled: groups.closedUnfilled, fallback: groups.fallback }));
    ok('price-ui (A2): counts — xAI 1 matched, Anthropic 1 matched, MiniMax 0 matched · 1 overridden by a platform rate; Platform overrides = PRICE_OVERRIDES.length rows, 1 matched',
      !!groups.xai && !!groups.anthropic && !!groups.minimax && groups.xai.matched === 1 && groups.anthropic.matched === 1 && groups.minimax.matched === 0 && groups.minimax.overridden === 1 && groups.ov && groups.ov.rows === groups.ovN && groups.ov.matched === 1,
      JSON.stringify({ xai: groups.xai, anthropic: groups.anthropic, minimax: groups.minimax, ov: groups.ov, ovN: groups.ovN }));

    // (2) a row: matched rows first (class matched + the model ids that landed), editable pattern / label / 4 prices, "verified <date>",
    //     the confidence pill, the source link (host as text, href = src, rel noopener, new tab); an Aug-2026 row reads unverified with no link
    const xai = await page.evaluate(() => {
      const d = PG().find(x => x.dataset.group === 'xAI');
      const trs = [...d.querySelectorAll('tbody tr')], first = trs[0];
      const q = (tr, s) => tr.querySelector(s);
      const t = (tr, s) => (q(tr, s) || {}).textContent;
      const ex = trs.find(tr => q(tr, 'input.pat').value === '^grok-4|^grok$');
      return { rows: trs.length, firstMatched: first.classList.contains('matched'), firstPat: q(first, 'input.pat').value, matchedModels: t(first, '.matched-models'),
        matchedIdx: trs.map((tr, i) => tr.classList.contains('matched') ? i : -1).filter(i => i >= 0),
        inputs: [...first.querySelectorAll('input')].map(i => i.className + '=' + i.value), verified: t(first, '.verified'), pill: t(first, '.pill'), pillClass: (q(first, '.pill') || {}).className,
        src: (a => a && { href: a.getAttribute('href'), rel: a.rel, target: a.target, text: a.textContent })(q(first, 'a.src')), del: !!q(first, 'button.del'), wins: !!q(first, '.wins-for'),
        existing: ex && { verified: t(ex, '.verified'), pill: t(ex, '.pill'), src: !!q(ex, 'a.src') }, headers: [...d.querySelectorAll('thead th')].map(th => th.textContent) };
    });
    ok('price-ui (A2): the xAI group lists its 13 rows with the matched Grok 4.3 row FIRST (class matched, "grok-4" named as the model that landed) and the six editable inputs (pat / label / in / out / cw / cr) with the row values',
      xai.rows === 13 && xai.firstMatched && xai.firstPat === '^grok-4\\.3' && /grok-4/.test(xai.matchedModels || '') && JSON.stringify(xai.matchedIdx) === '[0]'
      && JSON.stringify(xai.inputs) === JSON.stringify(['pat=^grok-4\\.3', 'label-i=Grok 4.3', 'price=1.25', 'price=2.5', 'price=0', 'price=0.2']) && xai.del,
      JSON.stringify({ rows: xai.rows, firstMatched: xai.firstMatched, firstPat: xai.firstPat, matchedModels: xai.matchedModels, matchedIdx: xai.matchedIdx, inputs: xai.inputs, del: xai.del }));
    ok(`price-ui (A2): provenance per row — "verified ${VERIFIED_ON}", a .pill.c-high reading "high", the source link docs.x.ai → https://docs.x.ai/docs/models (rel=noopener, target=_blank); no "wins for" on a row no override beats`,
      xai.verified === 'verified ' + VERIFIED_ON && xai.pill === 'high' && /\bpill\b/.test(xai.pillClass) && /\bc-high\b/.test(xai.pillClass) && xai.src && xai.src.href === 'https://docs.x.ai/docs/models' && /noopener/.test(xai.src.rel) && xai.src.target === '_blank' && xai.src.text === 'docs.x.ai' && !xai.wins,
      JSON.stringify({ verified: xai.verified, pill: xai.pill, pillClass: xai.pillClass, src: xai.src, wins: xai.wins }));
    ok('price-ui (A2): an Aug-2026 row carried over (at: null, c: existing) reads "unverified since Aug 2026" with an "existing" pill and no source link; the group table has the provenance column',
      xai.existing && xai.existing.verified === 'unverified since Aug 2026' && xai.existing.pill === 'existing' && !xai.existing.src && xai.headers.includes('Verified'), JSON.stringify({ existing: xai.existing, headers: xai.headers }));

    // (3) the override disclosure: the MiniMax default row for minimax-m3 says the SambaNova rate wins for SambaNova data (an edit of the
    //     vendor row changes nothing there); the Platform overrides group is read-only, names the platform, matched row first; resolve() tells
    const ov = await page.evaluate(() => {
      const G = PG();
      const mm = G.find(x => x.dataset.group === 'MiniMax');
      const tr = [...mm.querySelectorAll('tbody tr')].find(t => t.querySelector('input.pat').value === '^minimax-m3$');
      const w = tr && tr.querySelector('.wins-for');
      const og = G.find(x => x.dataset.group === 'Platform overrides');
      const rows = [...og.querySelectorAll('tbody tr')], hit = rows.find(t => t.classList.contains('matched'));
      const pick = (p) => ({ source: p.source, overrideFor: p.overrideFor || null, aliasOf: p.aliasOf || null, label: p.label, c: p.c });
      return { hasWins: !!w, wins: w && w.textContent, winsTitle: w && w.title, rowMatched: tr.classList.contains('matched'),
        ovRows: rows.length, ovMatchedN: rows.filter(t => t.classList.contains('matched')).length, ovFirstIsHit: rows[0] === hit,
        hit: hit && { platform: (hit.querySelector('.platform') || {}).textContent, label: (hit.querySelector('.label') || {}).textContent, inputs: hit.querySelectorAll('input').length, buttons: hit.querySelectorAll('button').length,
          pill: (hit.querySelector('.pill') || {}).textContent, verified: (hit.querySelector('.verified') || {}).textContent, src: !!hit.querySelector('a.src'), models: (hit.querySelector('.matched-models') || {}).textContent },
        res: pick(Pricing.resolve('minimax-m3', 'SambaNova')), base: pick(Pricing.resolve('minimax-m3')), grok: pick(Pricing.resolve('grok-4', 'xAI')), fb: pick(Pricing.resolve('zzz-never', 'xAI')) };
    });
    ok('price-ui (A2 amendment): the MiniMax default row for minimax-m3 carries ".wins-for" — "wins for SambaNova: $0.6 in / $2.4 out" — and is not itself marked matched',
      ov.hasWins && /^wins for SambaNova: \$0\.6 in \/ \$2\.4 out/.test(ov.wins) && /edit/i.test(ov.winsTitle || '') && !ov.rowMatched, JSON.stringify({ hasWins: ov.hasWins, wins: ov.wins, winsTitle: ov.winsTitle, rowMatched: ov.rowMatched }));
    ok('price-ui (A2): the Platform overrides group is read-only (no inputs, no delete), names the platform per row, lists the matched SambaNova MiniMax-M3 row first with its pill / verified / source and the model that landed',
      ov.ovRows === 17 && ov.ovMatchedN === 1 && ov.ovFirstIsHit && ov.hit && ov.hit.platform === 'SambaNova' && ov.hit.label === 'MiniMax-M3 (SambaNova)' && ov.hit.inputs === 0 && ov.hit.buttons === 0 && ov.hit.pill === 'high' && ov.hit.verified === 'unverified since Aug 2026' && ov.hit.src && /minimax-m3/.test(ov.hit.models || ''),
      JSON.stringify({ ovRows: ov.ovRows, ovMatchedN: ov.ovMatchedN, ovFirstIsHit: ov.ovFirstIsHit, hit: ov.hit }));
    ok('price-ui (A2): Pricing.resolve() says which rate won — source "override" + overrideFor "SambaNova" with the platform, source "default" without; grok-4 → default with aliasOf grok-4.3; the fallback is default with c existing',
      ov.res.source === 'override' && ov.res.overrideFor === 'SambaNova' && ov.res.label === 'MiniMax-M3 (SambaNova)' && ov.base.source === 'default' && ov.base.overrideFor === null && ov.base.label === 'MiniMax-M3 (MiniMax API default)'
      && ov.grok.source === 'default' && ov.grok.aliasOf === 'grok-4.3' && ov.grok.overrideFor === null && ov.fb.source === 'default' && ov.fb.c === 'existing', JSON.stringify({ res: ov.res, base: ov.base, grok: ov.grok, fb: ov.fb }));

    // (4) the banner (12 days after the verified date → plain) + the KPI footer + the CSV export's provenance line
    const prov = await page.evaluate(() => {
      const b = document.getElementById('prices-verified');
      const csv = App.csvExportText(App.window()).split('\n');
      return { banner: b && b.textContent, stale: b && b.classList.contains('stale'), inCard: !!b && !!b.closest('#card-pricing') && b === document.getElementById('card-pricing').firstElementChild,
        foot: (document.getElementById('kpi-foot') || {}).textContent, footAfterKpis: (document.getElementById('kpis') || {}).nextElementSibling === document.getElementById('kpi-foot'),
        csv0: csv[0], csv1: csv[1], csvRows: csv.length - 2, csvLast: csv[csv.length - 1] };
    });
    ok(`price-ui (A2): #prices-verified heads the price card — "Prices verified ${VERIFIED_ON} — 12 days ago." + the list-price sentence; not stale at 12 days`,
      prov.inCard && prov.banner === `Prices verified ${VERIFIED_ON} — 12 days ago. Costs are API-equivalent at the currently loaded list prices; historical price changes are not applied.` && prov.stale === false,
      JSON.stringify({ banner: prov.banner, stale: prov.stale, inCard: prov.inCard }));
    ok(`price-ui (T3b): the KPI footer right after #kpis reads "Costs are API-equivalent at the currently loaded list prices — prices: bundled set of ${VERIFIED_ON}" (no user edits yet)`,
      prov.footAfterKpis && prov.foot === `Costs are API-equivalent at the currently loaded list prices — prices: bundled set of ${VERIFIED_ON}`, JSON.stringify({ foot: prov.foot, footAfterKpis: prov.footAfterKpis }));
    ok(`price-ui (T3b): App.csvExportText(win) opens with "# ROSTUM export · prices: bundled set of ${VERIFIED_ON} · costs are API-equivalent at the currently loaded list prices; historical price changes are not applied", then the unchanged column header, then the 4 seeded rows`,
      prov.csv0 === `# ROSTUM export · prices: bundled set of ${VERIFIED_ON} · costs are API-equivalent at the currently loaded list prices; historical price changes are not applied`
      && prov.csv1 === 'date,platform,model,input_tokens,cache_write_tokens,cache_read_tokens,output_tokens,messages,estimated,cost_usd_api_equiv' && prov.csvRows === 4 && /,0\.0000$|,\d+\.\d{4}$/.test(prov.csvLast),
      JSON.stringify({ csv0: prov.csv0, csv1: prov.csv1, csvRows: prov.csvRows, csvLast: prov.csvLast }));

    // (5) the editor on the grouped list: + Add model lands a "Your rows" group row (pat my-model) whose pattern / price edits save as an
    //     added rule and resolve; editing a default row flips its pill to "user" IN PLACE (no re-render) and counts as a user edit on the
    //     footer; delete removes exactly that row (an empty Your rows group disappears); Reset to defaults restores the bundled list
    const ed = await page.evaluate(async () => {
      const G = () => PG();
      const settle = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));   // App.render() is rAF-batched
      const before = Pricing.rows.length;
      document.getElementById('add-price').click();
      const yours = G().find(x => x.dataset.group === 'Your rows');
      const tr = yours && [...yours.querySelectorAll('tbody tr')].find(t => t.querySelector('input.pat').value === 'my-model');
      if (!tr) return { before, added: false, yours: !!yours, groups: G().map(d => d.dataset.group) };
      const fire = (inp, v) => { inp.value = v; inp.dispatchEvent(new Event('change')); };
      fire(tr.querySelector('input.pat'), '^my-model-x$'); fire(tr.querySelector('input.price'), '7'); await settle();
      const row = Pricing.rows.find(r => r.pat === '^my-model-x$');
      const saved = LS.get('prices', null);
      const added = { label: row && row.label, in: row && row.in, pill: tr.querySelector('.pill').textContent, verified: tr.querySelector('.verified').textContent, open: yours.open,
        saved: saved && { added: saved.added.map(a => a.pat), edited: saved.edited.length, removed: saved.removed.length }, resolved: (p => ({ label: p.label, source: p.source, in: p.in }))(Pricing.resolve('my-model-x')),
        foot: document.getElementById('kpi-foot').textContent, editCount: Pricing.editCount() };
      const xai = G().find(x => x.dataset.group === 'xAI');
      const g43 = [...xai.querySelectorAll('tbody tr')].find(t => t.querySelector('input.pat').value === '^grok-4\\.3');
      const outInput = g43.querySelectorAll('input.price')[1];
      fire(outInput, '9'); await settle();
      const edited = { stillInDom: document.contains(outInput), pill: g43.querySelector('.pill').textContent, pillClass: g43.querySelector('.pill').className, verified: g43.querySelector('.verified').textContent, src: !!g43.querySelector('a.src'),
        c: Pricing.rows.find(r => r.pat === '^grok-4\\.3').c, out: Pricing.resolve('grok-4', 'xAI').out, source: Pricing.resolve('grok-4', 'xAI').source, foot: document.getElementById('kpi-foot').textContent, editCount: Pricing.editCount() };
      tr.querySelector('button.del').click(); await settle();
      const afterDel = { n: Pricing.rows.length, gone: !Pricing.rows.some(r => r.pat === '^my-model-x$'), yoursGroup: !!G().find(x => x.dataset.group === 'Your rows'), removed: LS.get('prices', null).removed.length, editCount: Pricing.editCount() };
      const origConfirm = window.confirm; window.confirm = () => true;
      try { document.getElementById('reset-prices').click(); } finally { window.confirm = origConfirm; }
      await settle();
      const blob = LS.get('prices', null);
      const afterReset = { n: Pricing.rows.length, defaults: DEFAULT_PRICES.length, out: Pricing.resolve('grok-4').out, c: Pricing.rows.find(r => r.pat === '^grok-4\\.3').c, foot: document.getElementById('kpi-foot').textContent,
        empty: !!blob && blob.added.length === 0 && blob.edited.length === 0 && blob.removed.length === 0, groups: G().length, xaiPill: (G().find(x => x.dataset.group === 'xAI').querySelector('tbody tr .pill') || {}).textContent };
      return { before, added: true, row: added, edited, afterDel, afterReset };
    });
    ok('price-ui (A2 editor): + Add model → a "Your rows" group (open) holds the new my-model row; pattern → ^my-model-x$ and in → 7 save as ONE added rule (edits blob: added [^my-model-x$], no edited / removed), resolve as source user with pill "user" / "your edit", footer "1 user edit"',
      ed.added && ed.row.label === 'New model' && ed.row.in === 7 && ed.row.pill === 'user' && ed.row.verified === 'your edit' && ed.row.open && JSON.stringify(ed.row.saved) === JSON.stringify({ added: ['^my-model-x$'], edited: 0, removed: 0 })
      && ed.row.resolved.label === 'New model' && ed.row.resolved.source === 'user' && ed.row.resolved.in === 7 && /, 1 user edit$/.test(ed.row.foot) && ed.row.editCount === 1, JSON.stringify(ed));
    ok('price-ui (A2 editor): editing a default row (Grok 4.3 out → 9) keeps the input in the DOM (no re-render under the user) and flips its provenance in place — pill "user" (.c-user), "your edit", source link gone, row c: user, resolve(grok-4, xAI).out 9 / source user; footer "2 user edits"',
      ed.added && ed.edited.stillInDom && ed.edited.pill === 'user' && /\bc-user\b/.test(ed.edited.pillClass) && ed.edited.verified === 'your edit' && !ed.edited.src && ed.edited.c === 'user' && ed.edited.out === 9 && ed.edited.source === 'user' && /, 2 user edits$/.test(ed.edited.foot) && ed.edited.editCount === 2,
      JSON.stringify(ed.edited));
    ok('price-ui (A2 editor): ✕ removes exactly the added row (rows back to the bundled count, the empty Your rows group is gone, nothing recorded as removed, 1 edit left); Reset to defaults restores the bundled list (c high again, out 2.5, empty edits blob, footer without user edits)',
      ed.added && ed.afterDel.n === ed.before && ed.afterDel.gone && !ed.afterDel.yoursGroup && ed.afterDel.removed === 0 && ed.afterDel.editCount === 1
      && ed.afterReset.n === ed.afterReset.defaults && ed.afterReset.out === 2.5 && ed.afterReset.c === 'high' && !/user edit/.test(ed.afterReset.foot) && ed.afterReset.empty && ed.afterReset.xaiPill === 'high', JSON.stringify({ before: ed.before, afterDel: ed.afterDel, afterReset: ed.afterReset }));

    // (6) a closed group fills its rows on first open (lazy) and the list re-renders itself when the stored data changes (a new model lands)
    const lazy = await page.evaluate(async () => {
      const G = () => PG();
      const d = G().find(x => x.dataset.group === 'OpenAI');
      const before = d.querySelectorAll('tbody tr').length;
      d.querySelector('summary').click();
      await new Promise(r => setTimeout(r, 0));
      const after = d.querySelectorAll('tbody tr').length, open = d.open;
      Store.setSource('csv2', [{ d: dayKey(new Date()), platform: 'OpenAI API', model: 'gpt-5.4', in: 1000, cw: 0, cr: 0, out: 0, msgs: 1 }], {});
      App._render();
      const oa = G().find(x => x.dataset.group === 'OpenAI');
      const summary = oa.querySelector('summary').textContent;
      delete Store.sources.csv2; App._render();
      return { before, after, open, rowsInList: Pricing.rows.filter(r => /^openai$/i.test(r.v || '')).length, summary, afterRemoval: G().find(x => x.dataset.group === 'OpenAI').querySelector('summary').textContent };
    });
    ok('price-ui (A2): a closed group holds no rows until its summary is clicked, then all of them; a new model in the stored data re-renders the list (OpenAI: 1 matched your data, then 0 again when it is removed)',
      lazy.before === 0 && lazy.open && lazy.after === lazy.rowsInList && lazy.after > 20 && / · 1 matched your data$/.test(lazy.summary) && / · 0 matched your data$/.test(lazy.afterRemoval), JSON.stringify(lazy));
  } finally {
    await page.close();
  }

  // (7) the banner turns amber past 90 days — the harness clock 100 days after the verified date
  const { page: late } = await openDashboard(browser, { clockAt: plusDays(VERIFIED_ON, 100) });
  try {
    const b = await late.evaluate(() => { const n = document.getElementById('prices-verified'); return { text: n && n.textContent, stale: n && n.classList.contains('stale'), role: n && n.getAttribute('role') }; });
    ok(`price-ui (A2): 100 days after ${VERIFIED_ON} the banner reads "— 100 days ago" and carries the amber .stale class`,
      b.text && b.text.startsWith(`Prices verified ${VERIFIED_ON} — 100 days ago.`) && b.stale === true && b.role === 'status', JSON.stringify(b));
  } finally {
    await late.close();
  }
}
