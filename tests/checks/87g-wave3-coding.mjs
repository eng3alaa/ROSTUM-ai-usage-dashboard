// Plan 9 B5 — folder-log parsers A: OpenCode (opencode.db, two layouts + legacy msg_*.json), Goose (sessions.db), Devin CLI (sessions.db
// message_nodes), Kilo Code (Roo parser under the kilocode.kilo-code root), Amp (threads/**/*.json usageLedger). Fixtures: tests/fixtures/gen.mjs
// (JSON) + the committed SQLite files under tests/fixtures/sqlite/ (copied to out/wave3/ by gen.mjs; expected totals are documented in
// gen-sqlite.mjs). Binary fixtures cross into the page as base64 → Uint8Array → File. Exact totals per fixture, local:1 where the provider is a
// local runner, project rows, malformed-row counts, dedupe, registry copy. The one check that may skip (clearly) is the generator equality check
// when node:sqlite is unavailable — every parser check runs from the committed files.
import fs from 'node:fs';
import path from 'node:path';
import { openDashboard, OUT } from '../lib/harness.mjs';
import { buildSqliteFixtures, SQLITE_FIXTURES } from '../fixtures/sqlite/gen-sqlite.mjs';

const read = (...p) => fs.readFileSync(path.join(OUT, 'wave3', ...p), 'utf8');
const b64 = (...p) => fs.readFileSync(path.join(OUT, 'wave3', ...p)).toString('base64');
const SQLITE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'sqlite');

export async function run({ browser, ok }) {
  const { page } = await openDashboard(browser);
  try {
    await page.evaluate(() => { Store.sources = {}; Store.billed = {}; Store.projects = []; Store.projectsBy = {}; Store.connectors = {}; });

    // ---- OpenCode: opencode.db (≤ 1.x layout) through parseOpenCodeDb + the card (legacy msg_*.json beside it, deduped by message id) ----
    const oc = await page.evaluate(async (dbB64, dbV2B64, a1Json, a7Json) => {
      const bytes = Uint8Array.from(atob(dbB64), ch => ch.charCodeAt(0)), v2 = Uint8Array.from(atob(dbV2B64), ch => ch.charCodeAt(0));
      const c = connectorById('opencode');
      const sum = (rows) => rows.reduce((a, r) => ({ in: a.in + r.in, cw: a.cw + r.cw, cr: a.cr + r.cr, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });
      const res = await parseOpenCodeDb([{ path: 'opencode.db', file: new File([bytes], 'opencode.db', { lastModified: 1789000000000 }) }], null, new Set(), c);
      const byModel = Object.fromEntries(res.rows.map(r => [r.model + '|' + r.sid + (r.local ? '|local' : ''), { ...sum([r]), d: r.d, hour: r.hour, sid: r.sid, cost: Pricing.cost(r.model, r) }]));
      const projSum = (rows) => rows.reduce((o, p) => { o[p.project] = (o[p.project] || 0) + p.in; return o; }, {});   // project × model rows → per project
      const proj = projSum(res.projects);
      const resV2 = await parseOpenCodeDb([{ path: 'opencode.db', file: new File([v2], 'opencode.db') }], null, new Set(), c);
      // through the driver: DB + legacy JSON in one folder → msg_a1 (in both) once, msg_a7 (legacy only) added; a garbage .db is one unreadable file
      const mk = () => [
        { path: 'opencode.db', file: new File([bytes], 'opencode.db', { lastModified: 1789000000000 }) },
        { path: 'storage/message/ses_s1/msg_a1.json', file: new File([a1Json], 'msg_a1.json') },
        { path: 'storage/message/ses_s2/msg_a7.json', file: new File([a7Json], 'msg_a7.json') },
        { path: 'storage/session/prj_1/ses_s1.json', file: new File(['{"id":"ses_s1"}'], 'ses_s1.json') },   // not a message file → not matched by the card's patterns
      ];
      const folder = await parseFolderCached(c, mk(), null, new Map());
      await App.scanFiles(c, mk().concat([{ path: 'backup/opencode.db', file: new File(['garbage, not sqlite'], 'opencode.db') }]));
      const src = Store.sources.opencode;
      const scanned = { total: sum(src ? src.rows : []), status: Store.connectorStatus(c), text: document.getElementById('opencode-status').textContent, projects: (Store.projectsBy.opencode || []).length };
      Store.sources = {}; Store.connectors = {}; Store.projectsBy = {}; Store.persist();
      return { ...sum(res.rows), rows: res.rows.length, files: res.meta.files, lines: res.meta.lines, badLines: res.meta.badLines, extCost: res.meta.extCost, addedIds: res.meta.addedIds, byModel, proj,
        platforms: [...new Set(res.rows.map(r => r.platform))], sids: [...new Set(res.rows.map(r => r.sid))].sort(), expA1Day: dayKey(new Date('2026-09-10T09:00:00Z')), expA1Hour: new Date('2026-09-10T09:00:00Z').getHours(), expA5Day: dayKey(new Date('2026-09-11T23:30:00Z')),
        v2: { ...sum(resV2.rows), model: resV2.rows[0] && resV2.rows[0].model, sid: resV2.rows[0] && resV2.rows[0].sid, proj: resV2.projects.map(p => p.project), badLines: resV2.meta.badLines },
        folder: { ...sum(folder.rows), files: folder.meta.files, badLines: folder.meta.badLines, skipped: folder.meta.skipped, projWeb: projSum(folder.projects)['~/web'] }, scanned };
    }, b64('opencode', 'opencode.db'), b64('opencode-v2', 'opencode.db'), read('opencode', 'storage', 'message', 'ses_s1', 'msg_a1.json'), read('opencode', 'storage', 'message', 'ses_s2', 'msg_a7.json'));
    ok('opencode: message.data → a1 1000/50/300/200 + a2 500/0/0/100 (reasoning ⊂ output) + a3 700/300 local:1 ($0, ollama) + a5 10/5 (time from the row) → in=2210 cw=50 cr=300 out=605 msgs=4; a4 not JSON = 1 bad row; a6 in flight skipped; 17 rows read; day/hour from time.created; sid = session id; cost sum 0.0168 in meta only',
      oc.in === 2210 && oc.cw === 50 && oc.cr === 300 && oc.out === 605 && oc.msgs === 4 && oc.badLines === 1 && oc.lines === 17 && oc.files === 1 && Math.abs(oc.extCost - 0.0168) < 1e-9
      && oc.byModel['qwen3:8b|ses_s2|local'] && oc.byModel['qwen3:8b|ses_s2|local'].cost === 0 && oc.byModel['qwen3:8b|ses_s2|local'].in === 700 && oc.byModel['gpt-5.4|ses_s1'].out === 100
      && oc.byModel['claude-sonnet-4-5|ses_s1'] && oc.byModel['claude-sonnet-4-5|ses_s1'].d === oc.expA1Day && oc.byModel['claude-sonnet-4-5|ses_s1'].hour === oc.expA1Hour && oc.byModel['claude-sonnet-4-5|ses_s1'].in === 1000
      && oc.byModel['claude-sonnet-4-5|ses_s2'] && oc.byModel['claude-sonnet-4-5|ses_s2'].in === 10 && oc.byModel['claude-sonnet-4-5|ses_s2'].d === oc.expA5Day
      && oc.rows === 4 && oc.platforms.length === 1 && oc.platforms[0] === 'OpenCode' && JSON.stringify(oc.sids) === '["ses_s1","ses_s2"]' && JSON.stringify(oc.addedIds.slice().sort()) === '["msg_a1","msg_a2","msg_a3","msg_a5"]', JSON.stringify(oc));
    ok('opencode: project rows from the message path.cwd / session directory — "D:/proj-oc" in=1500, "~/web" in=710 (prettyProject)',
      oc.proj['D:/proj-oc'] === 1500 && oc.proj['~/web'] === 710 && Object.keys(oc.proj).length === 2, JSON.stringify(oc.proj));
    ok('opencode (≥ 2.0.3 layout): session_v2 / session_message with data.model{id,providerID} → in=100 cw=3 cr=5 out=20 msgs=1 claude-sonnet-4-5, sid ses_v2, project ~/svc; user + compaction rows carry no tokens',
      oc.v2.in === 100 && oc.v2.cw === 3 && oc.v2.cr === 5 && oc.v2.out === 20 && oc.v2.msgs === 1 && oc.v2.model === 'claude-sonnet-4-5' && oc.v2.sid === 'ses_v2' && JSON.stringify(oc.v2.proj) === '["~/svc"]' && oc.v2.badLines === 0, JSON.stringify(oc.v2));
    ok('opencode: the card reads opencode.db AND the legacy storage/message/*/msg_*.json in one scan — msg_a1 (in both) counted once, msg_a7 (legacy only) added → in=2220 out=607 msgs=5, 3 files, 1 skipped (session file); a garbage .db is "1 file(s) unreadable" and the rest still lands (status ok, 4 project rows)',
      oc.folder.in === 2220 && oc.folder.cw === 50 && oc.folder.cr === 300 && oc.folder.out === 607 && oc.folder.msgs === 5 && oc.folder.files === 3 && oc.folder.badLines === 1 && oc.folder.skipped === 1 && oc.folder.projWeb === 720
      && oc.scanned.total.in === 2220 && oc.scanned.status === 'ok' && /Connected/.test(oc.scanned.text) && /1 file\(s\) unreadable/.test(oc.scanned.text) && oc.scanned.projects === 4, JSON.stringify({ folder: oc.folder, scanned: oc.scanned }));

    // ---- Goose: sessions.db (session-level accumulated_* totals, model from model_config JSON, provider_name → local) ----
    const gs = await page.evaluate(async (dbB64) => {
      const bytes = Uint8Array.from(atob(dbB64), ch => ch.charCodeAt(0));
      const c = connectorById('goose');
      const sum = (rows) => rows.reduce((a, r) => ({ in: a.in + r.in, cw: a.cw + r.cw, cr: a.cr + r.cr, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });
      const res = await parseGooseDb([{ path: 'sessions/sessions.db', file: new File([bytes], 'sessions.db', { lastModified: 1789000000000 }) }], null, new Set(), c);
      const byModel = Object.fromEntries(res.rows.map(r => [r.model, { ...sum([r]), d: r.d, hour: r.hour, sid: r.sid, local: r.local || 0, cost: Pricing.cost(r.model, r) }]));
      const proj = res.projects.reduce((o, p) => { o[p.project] = (o[p.project] || 0) + p.in; return o; }, {});   // project × model rows → per project
      const seen = new Set();
      await parseGooseDb([{ path: 'a/sessions.db', file: new File([bytes], 'sessions.db') }], null, seen, c);
      const again = await parseGooseDb([{ path: 'b/sessions.db', file: new File([bytes], 'sessions.db') }], null, seen, c);
      return { ...sum(res.rows), rows: res.rows.length, lines: res.meta.lines, badLines: res.meta.badLines, byModel, proj, platform: res.rows[0] && res.rows[0].platform, addedIds: res.meta.addedIds.slice().sort(),
        expG1: dayKey(new Date('2026-09-12T08:00:00Z')), expG1Hour: new Date('2026-09-12T08:00:00Z').getHours(), againRows: again.rows.length, againDup: again.meta.dupIds.length, patterns: c.patterns.map(String) };
    }, b64('goose', 'sessions', 'sessions.db'));
    ok('goose: sessions → g1 4000/900 msgs 3 (claude-sonnet-4-5; recipe through an overflow page) + g2 1500/400 local:1 ($0, ollama) + g3 100/20 "unknown" (model_config not JSON = 1 bad row) + g5 200/50 msgs 2 (accumulated_* NULL → input_tokens/output_tokens) → in=5800 out=1370 msgs=7; g4 (no tokens) skipped; 5 rows read; day = created_at (UTC text); sid = session id; dedupe by session id',
      gs.in === 5800 && gs.cw === 0 && gs.cr === 0 && gs.out === 1370 && gs.msgs === 7 && gs.rows === 4 && gs.lines === 5 && gs.badLines === 1 && gs.platform === 'Goose'
      && gs.byModel['claude-sonnet-4-5'].in === 4000 && gs.byModel['claude-sonnet-4-5'].msgs === 3 && gs.byModel['claude-sonnet-4-5'].d === gs.expG1 && gs.byModel['claude-sonnet-4-5'].hour === gs.expG1Hour && gs.byModel['claude-sonnet-4-5'].sid === 'g1'
      && gs.byModel['llama3.2'].local === 1 && gs.byModel['llama3.2'].cost === 0 && gs.byModel['llama3.2'].in === 1500 && gs.byModel.unknown.in === 100 && gs.byModel.unknown.msgs === 1 && gs.byModel['gpt-5.4'].msgs === 2
      && JSON.stringify(gs.addedIds) === '["g1","g2","g3","g5"]' && gs.againRows === 0 && gs.againDup === 4 && gs.patterns.some(p => /sessions\\\.db/.test(p)), JSON.stringify(gs));
    ok('goose: project rows from working_dir — D:/proj-goose 4000, ~/app 1700 (g2 + g5), ~/x 100',
      gs.proj['D:/proj-goose'] === 4000 && gs.proj['~/app'] === 1700 && gs.proj['~/x'] === 100 && Object.keys(gs.proj).length === 3, JSON.stringify(gs.proj));

    // ---- Devin CLI: sessions.db message_nodes.chat_message metrics (metadata.metrics or top-level metrics), retries deduped by request_id ----
    const dv = await page.evaluate(async (dbB64) => {
      const bytes = Uint8Array.from(atob(dbB64), ch => ch.charCodeAt(0));
      const c = connectorById('devin');
      const sum = (rows) => rows.reduce((a, r) => ({ in: a.in + r.in, cw: a.cw + r.cw, cr: a.cr + r.cr, out: a.out + r.out, msgs: a.msgs + r.msgs }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });
      const res = await parseDevinDb([{ path: 'cli/sessions.db', file: new File([bytes], 'sessions.db', { lastModified: 1789000000000 }) }], null, new Set(), c);
      const rows = res.rows.map(r => ({ model: r.model, ...sum([r]), d: r.d, hour: r.hour, sid: r.sid })).sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : a.in - b.in);
      const proj = Object.fromEntries(res.projects.map(p => [p.project, p.in]));
      return { ...sum(res.rows), rows, lines: res.meta.lines, badLines: res.meta.badLines, dupIds: res.meta.dupIds, addedIds: res.meta.addedIds.slice().sort(), acus: res.meta.acus, proj, platform: res.rows[0] && res.rows[0].platform,
        expN1: dayKey(new Date('2026-09-14T09:00:00Z')), expN1Hour: new Date('2026-09-14T09:00:00Z').getHours(), expN3: dayKey(new Date('2026-09-14T22:00:00Z')), expN6: dayKey(new Date('2026-09-15T10:00:00Z')) };
    }, b64('devin', 'cli', 'sessions.db'));
    const n1 = dv.rows.find(r => r.in === 2000), n3 = dv.rows.find(r => r.in === 900), n6 = dv.rows.find(r => r.in === 50);
    ok('devin: message_nodes → n1 2000/100/800/300 (metadata.metrics, generation_model) + n3 900/0 (top-level metrics, no output field, model from sessions.model) + n6 50/10 (session d2 model gpt-5.4, time from the node row) → in=2950 cw=100 cr=800 out=310 msgs=3; n2 = retry of r1 (dupIds 1); n5 chat_message + d2 metadata not JSON = 2 bad rows; n4 user node skipped; ACUs 1.25 in meta only',
      dv.in === 2950 && dv.cw === 100 && dv.cr === 800 && dv.out === 310 && dv.msgs === 3 && dv.rows.length === 3 && dv.lines === 6 && dv.badLines === 2 && JSON.stringify(dv.dupIds) === '["devin:r1"]' && JSON.stringify(dv.addedIds) === '["devin:r1","devin:r2","devin:r3"]'
      && dv.acus === 1.25 && dv.platform === 'Devin CLI' && n1 && n1.model === 'claude-sonnet-4-5' && n1.d === dv.expN1 && n1.hour === dv.expN1Hour && n1.sid === 'd1'
      && n3 && n3.model === 'claude-sonnet-4-5' && n3.out === 0 && n3.d === dv.expN3 && n6 && n6.model === 'gpt-5.4' && n6.out === 10 && n6.d === dv.expN6 && n6.sid === 'd2', JSON.stringify(dv));
    ok('devin: project rows from sessions.working_directory — ~/api 2900, D:/tools 50', dv.proj['~/api'] === 2900 && dv.proj['D:/tools'] === 50 && Object.keys(dv.proj).length === 2, JSON.stringify(dv.proj));

    // ---- Kilo Code: the Roo parser under its own card (platform "Kilo Code", tokensIn inclusive of cache like Roo, local provider → local:1) ----
    const kiA = read('kilo', 'tasks', '1786353000000', 'ui_messages.json'), kiAm = read('kilo', 'tasks', '1786353000000', 'task_metadata.json');
    const kiB = read('kilo', 'tasks', '1786353100000', 'ui_messages.json'), kiBm = read('kilo', 'tasks', '1786353100000', 'task_metadata.json');
    const ki = await page.evaluate(async (a, am, b, bm) => {
      const c = connectorById('kilo'), roo = connectorById('roo');
      const mk = () => [
        { path: 'tasks/1786353000000/ui_messages.json', file: new File([a], 'ui_messages.json') }, { path: 'tasks/1786353000000/task_metadata.json', file: new File([am], 'task_metadata.json') },
        { path: 'tasks/1786353100000/ui_messages.json', file: new File([b], 'ui_messages.json') }, { path: 'tasks/1786353100000/task_metadata.json', file: new File([bm], 'task_metadata.json') },
      ];
      const res = await parseFolderCached(c, mk(), null, new Map());
      const sum = (rows) => rows.reduce((x, r) => ({ in: x.in + r.in, cw: x.cw + r.cw, cr: x.cr + r.cr, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });
      const local = res.rows.filter(r => r.local === 1);
      return { ...sum(res.rows), files: res.meta.files, platforms: [...new Set(res.rows.map(r => r.platform))], models: res.rows.map(r => r.model).sort(), local: local.length, localModel: local[0] && local[0].model, localCost: local[0] ? Pricing.cost(local[0].model, local[0]) : null,
        parser: c.parser, sameAsRoo: c.parser === roo.parser, card: !!document.getElementById('src-kilo'), rooCopy: roo.qualityNote, kiloHint: c.hint };
    }, kiA, kiAm, kiB, kiBm);
    ok('kilo: the Roo parser under the Kilo card — openai-protocol tokensIn 3000 − cw 100 − cr 900 → in=2000 (claude-sonnet-4.5) + ollama task 400/40 local:1 ($0) → in=2400 cw=100 cr=900 out=100 msgs=2 over 2 files, platform "Kilo Code"; parser is parseClineTasks (shared with roo)',
      ki.in === 2400 && ki.cw === 100 && ki.cr === 900 && ki.out === 100 && ki.msgs === 2 && ki.files === 2 && ki.platforms.length === 1 && ki.platforms[0] === 'Kilo Code' && JSON.stringify(ki.models) === '["claude-sonnet-4.5","qwen3:14b"]'
      && ki.local === 1 && ki.localModel === 'qwen3:14b' && ki.localCost === 0 && ki.parser === 'parseClineTasks' && ki.sameAsRoo && ki.card, JSON.stringify(ki));
    ok('kilo: the Roo card no longer tells Kilo users to pick their folder under Roo (it names the Kilo card); the Kilo hint names the kilocode.kilo-code folder',
      !/pick that globalStorage folder here instead/.test(ki.rooCopy) && /Kilo Code/.test(ki.rooCopy) && /kilocode\.kilo-code/.test(ki.kiloHint || ''), JSON.stringify({ rooCopy: ki.rooCopy.slice(-200), hint: ki.kiloHint }));

    // ---- Amp: threads/**/*.json — usageLedger events (cache from the billed message), messages[].usage fallback, non-thread JSON counted as skipped ----
    const am = await page.evaluate(async (abc, nol, bad, session) => {
      const c = connectorById('amp');
      const mk = () => [
        { path: 'threads/T-abc.json', file: new File([abc], 'T-abc.json', { lastModified: 1789000000000 }) },
        { path: 'threads/T-nol.json', file: new File([nol], 'T-nol.json', { lastModified: 1789000000000 }) },
        { path: 'threads/T-bad.json', file: new File([bad], 'T-bad.json', { lastModified: 1789000000000 }) },
        { path: 'session.json', file: new File([session], 'session.json', { lastModified: 1789000000000 }) },
        { path: 'history.jsonl', file: new File(['{"text":"x"}\n'], 'history.jsonl', { lastModified: 1789000000000 }) },   // never matched
      ];
      const sum = (rows) => rows.reduce((x, r) => ({ in: x.in + r.in, cw: x.cw + r.cw, cr: x.cr + r.cr, out: x.out + r.out, msgs: x.msgs + r.msgs }), { in: 0, cw: 0, cr: 0, out: 0, msgs: 0 });
      const direct = await parseAmpThreads(mk().slice(0, 1), null, new Set(), c);
      const nolRes = await parseAmpThreads(mk().slice(1, 2), null, new Set(), c);
      const folder = await parseFolderCached(c, mk(), null, new Map());
      const all = await parseAmpThreads(mk(), null, new Set(), c);   // the driver merges files / msgs / lines / badLines only — skippedFiles is parser metadata, read from a direct call
      const abcRows =direct.rows.map(r => ({ ...sum([r]), model: r.model, d: r.d, hour: r.hour, sid: r.sid })).sort((x, y) => x.in - y.in);
      const nolRows = nolRes.rows.map(r => ({ ...sum([r]), model: r.model, d: r.d, sid: r.sid })).sort((x, y) => x.in - y.in);
      return { abc: { ...sum(direct.rows), rows: abcRows, badLines: direct.meta.badLines, dupIds: direct.meta.dupIds, addedIds: direct.meta.addedIds.slice().sort(), credits: direct.meta.credits, lines: direct.meta.lines },
        nol: { ...sum(nolRes.rows), rows: nolRows, badLines: nolRes.meta.badLines, credits: nolRes.meta.credits },
        folder: { ...sum(folder.rows), files: folder.meta.files, badLines: folder.meta.badLines, skippedFiles: all.meta.skippedFiles, directFiles: all.meta.files, directBad: all.meta.badLines, skipped: folder.meta.skipped, platforms: [...new Set(folder.rows.map(r => r.platform))] },
        expE1: dayKey(new Date('2026-09-16T09:00:00Z')), expE1Hour: new Date('2026-09-16T09:00:00Z').getHours(), expE2: dayKey(new Date('2026-09-16T21:00:00Z')), expN1: dayKey(new Date('2026-09-17T10:00:00Z')), expFile: dayKey(new Date(1789000000000)), patterns: c.patterns.map(String) };
    }, read('amp', 'threads', 'T-abc.json'), read('amp', 'threads', 'T-nol.json'), read('amp', 'threads', 'T-bad.json'), read('amp', 'session.json'));
    ok('amp (ledger): e1 1200/400 + cache from message m-a1 (cw 200 cr 3000) + e2 800/150 (+10 tokens of total unaccounted → output 160) → in=2000 cw=200 cr=3000 out=560 msgs=2 claude-sonnet-4-5; e2 repeated = dupIds 1; e3 tokens not an object = 1 bad row; credits 19 summed in meta only, never priced; day/hour from the event timestamp (ISO or epoch ms); sid = thread id',
      am.abc.in === 2000 && am.abc.cw === 200 && am.abc.cr === 3000 && am.abc.out === 560 && am.abc.msgs === 2 && am.abc.badLines === 1 && JSON.stringify(am.abc.dupIds) === '["T-abc:e2"]' && JSON.stringify(am.abc.addedIds) === '["T-abc:e1","T-abc:e2"]' && am.abc.credits === 19 && am.abc.lines === 1
      && am.abc.rows.length === 2 && am.abc.rows[0].in === 800 && am.abc.rows[0].out === 160 && am.abc.rows[0].d === am.expE2 && am.abc.rows[1].in === 1200 && am.abc.rows[1].cr === 3000 && am.abc.rows[1].d === am.expE1 && am.abc.rows[1].hour === am.expE1Hour
      && am.abc.rows.every(r => r.model === 'claude-sonnet-4-5' && r.sid === 'T-abc'), JSON.stringify(am.abc));
    ok('amp (no ledger): messages[].usage → n-a1 gpt-5.4 300/80 on its timestamp + n-a2 5/1 "unknown" on the file date → in=305 out=81 msgs=2, credits 0',
      am.nol.in === 305 && am.nol.out === 81 && am.nol.msgs === 2 && am.nol.badLines === 0 && am.nol.credits === 0 && am.nol.rows.length === 2
      && am.nol.rows[0].model === 'unknown' && am.nol.rows[0].d === am.expFile && am.nol.rows[1].model === 'gpt-5.4' && am.nol.rows[1].d === am.expN1 && am.nol.rows.every(r => r.sid === 'T-nol'), JSON.stringify(am.nol));
    ok('amp (card): every .json under the pick is sniffed — 2 threads + 1 not-JSON (badLines 2 incl. e3) + session.json (valid JSON, not a thread → skippedFiles 1, never an error) → in=2305 out=641 cw=200 cr=3000 msgs=4 over 4 files; history.jsonl never matched; platform Amp',
      am.folder.in === 2305 && am.folder.out === 641 && am.folder.cw === 200 && am.folder.cr === 3000 && am.folder.msgs === 4 && am.folder.files === 4 && am.folder.badLines === 2 && am.folder.skipped === 1
      && am.folder.skippedFiles === 1 && am.folder.directFiles === 4 && am.folder.directBad === 2
      && am.folder.platforms.length === 1 && am.folder.platforms[0] === 'Amp' && am.patterns.length === 1 && /\\\.json\$/.test(am.patterns[0]), JSON.stringify(am.folder));

    // ---- registry: five folder-log entries in the Coding group with honest copy ----
    const reg = await page.evaluate(() => {
      const ids = ['opencode', 'goose', 'devin', 'kilo', 'amp'];
      const bad = [];
      for (const id of ids) {
        const c = connectorById(id);
        if (!c) { bad.push(id + ': missing'); continue; }
        if (c.kind !== 'folder-log' || c.category !== 'coding' || c.quality !== 'exact') bad.push(id + ': kind/category/quality');
        if (c.statusEl !== id + '-status' || !document.getElementById(c.statusEl) || !document.getElementById('src-' + id)) bad.push(id + ': statusEl / card');
        if (!Array.isArray(c.srcIds) || c.srcIds[0] !== id) bad.push(id + ': srcIds');
        if (typeof globalThis[c.parser] !== 'function') bad.push(id + ': parser ' + c.parser);
        if (!Array.isArray(c.patterns) || !c.patterns.length || !c.hint) bad.push(id + ': patterns / hint');
        if (!Array.isArray(c.paths) || c.paths.length < 2) bad.push(id + ': paths');
        if (!c.links || !c.links.get || !c.links.docs) bad.push(id + ': links');
        if (!(typeof c.qualityNote === 'string' && c.qualityNote.length >= 80 && /^Exact/.test(c.qualityNote))) bad.push(id + ': copy must open with Exact');
        if (!/source-based, not yet verified on real files/.test(c.qualityNote || '')) bad.push(id + ': honesty sentence');
        if (!c.platform || !PLATFORM_ORDER.includes(c.platform)) bad.push(id + ': platform order');
        if (document.querySelector('#accounts-hub .hub-group[data-group="coding"] .acct[data-connector="' + id + '"]') === null) { App.renderHub(); if (!document.querySelector('#accounts-hub .hub-group[data-group="coding"] .acct[data-connector="' + id + '"]')) bad.push(id + ': not in the Coding hub group'); }
      }
      const note = (id) => (connectorById(id) || {}).qualityNote || '';
      const platforms = ids.map(id => (connectorById(id) || {}).platform);
      const wal = ['opencode', 'goose', 'devin'].every(id => /-wal/.test(note(id)));
      const collector = (connectorById('collector') || {}).qualityNote || '';
      return { bad, platforms, wal, devinAcu: /ACU/.test(note('devin')) && /output/.test(note('devin')), ampCredits: /credits/.test(note('amp')) && /orb|cloud/i.test(note('amp')), gooseSession: /session-level/i.test(note('goose')),
        ocLayouts: /2\.0\.3|session_message/.test(note('opencode')) && /msg_/.test(note('opencode')), kiloRoo: /Roo/.test(note('kilo')), collectorNames: ['OpenCode', 'Goose', 'Devin CLI', 'Kilo Code', 'Amp'].every(n => collector.includes(n)),
        n: CONNECTORS.length, dupIds: CONNECTORS.map(c => c.id).filter((x, i, a) => a.indexOf(x) !== i) };
    });
    ok('registry (B5): opencode / goose / devin / kilo / amp are exact folder-log entries in Coding tools — parser registered, patterns + hint, ≥ 2 per-OS paths, get + docs links, statusEl + card + hub placement, copy opens "Exact" and carries "source-based, not yet verified on real files"; platforms OpenCode / Goose / Devin CLI / Kilo Code / Amp in PLATFORM_ORDER; ids unique',
      reg.bad.length === 0 && JSON.stringify(reg.platforms) === '["OpenCode","Goose","Devin CLI","Kilo Code","Amp"]' && reg.dupIds.length === 0, JSON.stringify(reg));
    ok('registry (B5): the copy names each parser\'s limits — the three SQLite cards warn about the -wal sidecar, Devin says ACUs and missing output tokens, Amp says credits and cloud threads, Goose says session-level, OpenCode names both layouts and msg_*.json, Kilo names Roo; the collector card lists the five tools',
      reg.wal && reg.devinAcu && reg.ampCredits && reg.gooseSession && reg.ocLayouts && reg.kiloRoo && reg.collectorNames, JSON.stringify(reg));

    // ---- committed .db fixtures == generator output (semantic: the same tables decode to the same rows; the header's SQLite version may differ) ----
    const regen = path.join(OUT, 'wave3', 'regen');
    const built = await buildSqliteFixtures(regen);
    if (!built) {
      ok('sqlite fixtures: committed .db files match a fresh gen-sqlite.mjs build', true, 'skipped: node:sqlite unavailable in this Node — only this equality check is skipped; every parser check above ran from the committed files');
    } else {
      const TABLES = { 'opencode.db': ['session', 'message', 'part'], 'opencode-v2.db': ['session_v2', 'session_message'], 'goose-sessions.db': ['sessions', 'messages'], 'devin-sessions.db': ['sessions', 'message_nodes'] };
      const pairs = SQLITE_FIXTURES.map(f => ({ f, tables: TABLES[f], committed: fs.readFileSync(path.join(SQLITE_DIR, f)).toString('base64'), fresh: fs.readFileSync(path.join(regen, f)).toString('base64'), size: fs.statSync(path.join(SQLITE_DIR, f)).size }));
      const eq = await page.evaluate((pairs) => pairs.map(p => {
        const dec = (b) => Uint8Array.from(atob(b), ch => ch.charCodeAt(0));
        const a = dec(p.committed), b = dec(p.fresh);
        const same = p.tables.every(t => JSON.stringify(readSqliteTable(a, t)) === JSON.stringify(readSqliteTable(b, t)));
        return { f: p.f, same, size: p.size, rows: p.tables.map(t => t + ':' + readSqliteTable(a, t).rows.length).join(' ') };
      }), pairs);
      ok('sqlite fixtures: the committed opencode.db / opencode-v2.db / goose-sessions.db / devin-sessions.db decode to the same tables and rows as a fresh gen-sqlite.mjs build (node:sqlite present), each < 50 KB',
        eq.every(e => e.same && e.size < 50 * 1024), JSON.stringify(eq));
    }
  } finally {
    await page.close();
  }
}
