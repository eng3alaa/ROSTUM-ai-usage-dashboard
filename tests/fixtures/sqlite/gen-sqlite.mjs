// Plan 9 B5 — the SQLite fixtures of the Wave 3 coding tools (OpenCode opencode.db ×2 layouts, Goose sessions.db, Devin CLI sessions.db) + Plan 9 B6 Zed threads.db.
// They are COMMITTED as binary files next to this script so the suite and CI never depend on node:sqlite; this generator is the documented
// way to regenerate them (node tests/fixtures/sqlite/gen-sqlite.mjs — needs Node ≥ 22.13 for node:sqlite). tests/fixtures/gen.mjs copies the
// committed files into out/wave3/…; tests/checks/87g-wave3-coding.mjs reads them through readSqliteTable and, when node:sqlite is available,
// rebuilds them into out/ and asserts the committed tables decode to the same rows (semantic equality — the file header carries the SQLite
// library version, so byte equality would differ between Node versions).
// Shapes follow the research entries + the cited third-party parsers (CodeBurn, agent-walker) — not real files (none of the tools is installed
// on the research machine): 1 KB pages (overflow + interior pages with little data), journal_mode DELETE (no -wal sidecar).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const SQLITE_FIXTURES = ['opencode.db', 'opencode-v2.db', 'goose-sessions.db', 'devin-sessions.db', 'zed-threads.db'];
const T = (iso) => new Date(iso).getTime();
const hasZstd = typeof zlib.zstdCompressSync === 'function';   // Node >= 22.15 / 23.8 — zed-threads.db needs it (its thread blobs are zstd frames)

// Plan 9 B6 — Zed Agent Panel threads.db (table threads: id, summary, updated_at, data_type 'zstd' | 'json', data BLOB). One row per thread; the
// decompressed thread JSON (Zed's SerializedThread, versions 0.1.0-0.3.0) carries model{provider, model}, messages[], request_token_usage
// (per user-message id), cumulative_token_usage (the whole thread) and initial_project_snapshot.worktree_snapshots[].worktree_path. Shapes follow
// the research entry + CodeBurn's zed.md and Zed commit #31741 — Zed is not installed on the research machine (source-based).
//   t1 zstd: cumulative in=1000 cw=50 cr=300 out=200 (claude-sonnet-4-5, anthropic), 2 assistant messages → msgs 2; updated_at RFC3339; project D:\proj-zed
//   t2 zstd: cumulative in=400 out=80 (qwen3:8b via ollama → local:1), 1 assistant message; updated_at SQLite text 'YYYY-MM-DD HH:MM:SS' (UTC)
//   t3 json (legacy uncompressed): no cumulative → request_token_usage summed: in=10 out=5 (gpt-5.4, openai); updated_at epoch ms (digit text)
//   t4 zstd: the blob is a zstd magic + garbage → decode fails → badLines 1 (the collector emits an error line for it)
//   t5 zstd: a thread with no tokens anywhere → skipped (empty, not malformed)
//   ⇒ in=1410 cw=50 cr=300 out=285 msgs=4 over 3 rows, lines 5, badLines 1; project D:/proj-zed in=1000.
const zedMsg = (id, role, text) => ({ id, role, segments: [{ type: 'text', text }], context: '', creases: [], is_hidden: false });
export const ZED_THREADS = [
  { id: 't1', summary: 'wire the agent', updated_at: '2026-09-20T09:00:00Z', data_type: 'zstd', thread: {
    version: '0.3.0', summary: 'wire the agent', updated_at: '2026-09-20T09:00:00Z', model: { provider: 'anthropic', model: 'claude-sonnet-4-5' }, completion_mode: 'normal', profile: 'write',
    messages: [zedMsg(1, 'user', 'add a parser'), zedMsg(2, 'assistant', 'on it'), zedMsg(3, 'user', 'and tests'), zedMsg(4, 'assistant', 'done')],
    request_token_usage: { 1: { input_tokens: 600, output_tokens: 120, cache_creation_input_tokens: 50, cache_read_input_tokens: 100 }, 3: { input_tokens: 400, output_tokens: 80, cache_read_input_tokens: 200 } },
    cumulative_token_usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 50, cache_read_input_tokens: 300 },
    initial_project_snapshot: { worktree_snapshots: [{ worktree_path: 'D:\\proj-zed', git_state: null }], unsaved_buffer_paths: [], timestamp: '2026-09-20T08:00:00Z' } } },
  { id: 't2', summary: 'local run', updated_at: '2026-09-21 10:00:00', data_type: 'zstd', thread: {
    version: '0.2.0', summary: 'local run', model: { provider: 'ollama', model: 'qwen3:8b' }, messages: [zedMsg(1, 'user', 'explain'), zedMsg(2, 'assistant', 'sure')],
    cumulative_token_usage: { input_tokens: 400, output_tokens: 80 } } },
  { id: 't3', summary: 'legacy json', updated_at: String(T('2026-09-19T22:30:00Z')), data_type: 'json', thread: {
    version: '0.1.0', summary: 'legacy json', model: { provider: 'openai', model: 'gpt-5.4' }, messages: [zedMsg(1, 'user', 'rename'), zedMsg(2, 'assistant', 'renamed')],
    request_token_usage: { 1: { input_tokens: 10, output_tokens: 5 } } } },
  { id: 't4', summary: 'corrupt blob', updated_at: '2026-09-22T10:00:00Z', data_type: 'zstd', corrupt: true },
  { id: 't5', summary: 'empty thread', updated_at: '2026-09-22T11:00:00Z', data_type: 'zstd', thread: { version: '0.3.0', summary: 'empty thread', model: { provider: 'anthropic', model: 'claude-sonnet-4-5' }, messages: [] } },
];
/** The bytes of one thread row's data cell: a zstd frame of the thread JSON, the plain JSON text, or (t4) a zstd magic followed by garbage. */
export function zedThreadBlob(row) {
  if (row.corrupt) return Buffer.concat([Buffer.from('28b52ffd', 'hex'), Buffer.from('deadbeefcafebabe0102030405', 'hex')]);
  const json = Buffer.from(JSON.stringify(row.thread));
  return row.data_type === 'zstd' ? zlib.zstdCompressSync(json) : json;
}
/** What the collector's GET /api/file?tool=zed&path=threads.db&decode=zstd answers: one JSON line per thread row, data decoded (data_type 'json'),
 *  an `error` line for a blob that does not decode. tests/fixtures/gen.mjs writes it as the page-side fixture of the collector path. */
export function zedDecodedJsonl() {
  return ZED_THREADS.map((r) => JSON.stringify(r.corrupt
    ? { id: r.id, summary: r.summary, updated_at: r.updated_at, error: 'zstd decode failed: Unknown frame descriptor' }
    : { id: r.id, summary: r.summary, updated_at: r.updated_at, data_type: 'json', data: JSON.stringify(r.thread) })).join('\n') + '\n';
}

async function loadSqlite() {   // null when node:sqlite is unavailable; the ExperimentalWarning some Node versions print is silenced
  const origEmit = process.emitWarning;
  process.emitWarning = (w, ...a) => { if (/SQLite/i.test(String((w && w.message) || w))) return; return origEmit.call(process, w, ...a); };
  try { const m = await import('node:sqlite'); return m.DatabaseSync ? m : null; } catch { return null; }
  finally { process.emitWarning = origEmit; }
}

function openFresh(sqlite, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA page_size=1024');
  db.exec('PRAGMA journal_mode=DELETE');
  return db;
}

/** OpenCode ≤ 1.x layout (tables session / message / part; message.data = the assistant message JSON minus id/sessionID).
 *  Expected rows: a1 in=1000 cr=300 cw=50 out=200 (claude-sonnet-4-5, anthropic) · a2 in=500 out=100 (reasoning 40 ⊂ output, never added) ·
 *  a3 in=700 out=300 local:1 (qwen3:8b via ollama) · a5 in=10 out=5 (no time.created → the row's time_created) → in=2210 cw=50 cr=300 out=605 msgs=4;
 *  a4's data is not JSON (badLines 1); a6 has no tokens yet (in flight — skipped, not malformed); 10 user messages pad the table past one
 *  1 KB leaf page (interior page walk). Projects: s1 directory D:\proj-oc → "D:/proj-oc", s2 /home/me/web → "~/web" (a1/a2 carry path.cwd too). */
function buildOpenCode(sqlite, file) {
  const db = openFresh(sqlite, file);
  db.exec('CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT, directory TEXT NOT NULL, title TEXT, version TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)');
  db.exec('CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)');
  db.exec('CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)');
  const ses = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?)');
  ses.run('ses_s1', 'prj_1', null, 'quiet-fox', 'D:\\proj-oc', 'first session', '1.2.4', T('2026-09-10T08:59:00Z'), T('2026-09-10T22:00:00Z'));
  ses.run('ses_s2', 'prj_2', null, 'blue-owl', '/home/me/web', 'second session', '1.2.4', T('2026-09-11T08:00:00Z'), T('2026-09-12T08:00:00Z'));
  const msg = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
  const assistant = (o) => JSON.stringify({ role: 'assistant', mode: 'build', agent: 'build', system: [], ...o });
  msg.run('msg_u0', 'ses_s1', T('2026-09-10T08:59:30Z'), T('2026-09-10T08:59:30Z'), JSON.stringify({ role: 'user', time: { created: T('2026-09-10T08:59:30Z') } }));
  msg.run('msg_a1', 'ses_s1', T('2026-09-10T09:00:00Z'), T('2026-09-10T09:00:09Z'), assistant({ modelID: 'claude-sonnet-4-5', providerID: 'anthropic', path: { cwd: 'D:\\proj-oc', root: 'D:\\proj-oc' },
    cost: 0.0123, tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 300, write: 50 } }, time: { created: T('2026-09-10T09:00:00Z'), completed: T('2026-09-10T09:00:09Z') } }));
  msg.run('msg_a2', 'ses_s1', T('2026-09-10T21:30:00Z'), T('2026-09-10T21:30:05Z'), assistant({ modelID: 'gpt-5.4', providerID: 'openai', path: { cwd: 'D:\\proj-oc', root: 'D:\\proj-oc' },
    cost: 0.0045, tokens: { input: 500, output: 100, reasoning: 40, cache: { read: 0, write: 0 } }, time: { created: T('2026-09-10T21:30:00Z'), completed: T('2026-09-10T21:30:05Z') } }));
  msg.run('msg_a3', 'ses_s2', T('2026-09-11T09:00:00Z'), T('2026-09-11T09:00:20Z'), assistant({ modelID: 'qwen3:8b', providerID: 'ollama', path: { cwd: '/home/me/web', root: '/home/me/web' },
    cost: 0, tokens: { input: 700, output: 300, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: T('2026-09-11T09:00:00Z'), completed: T('2026-09-11T09:00:20Z') } }));
  msg.run('msg_a4', 'ses_s2', T('2026-09-11T10:00:00Z'), T('2026-09-11T10:00:00Z'), '{"role":"assistant","tokens":{"input":99999');   // truncated write → not JSON
  msg.run('msg_a5', 'ses_s2', T('2026-09-11T23:30:00Z'), T('2026-09-11T23:30:01Z'), assistant({ modelID: 'claude-sonnet-4-5', providerID: 'anthropic', cost: 0, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } }));
  msg.run('msg_a6', 'ses_s2', T('2026-09-12T08:00:00Z'), T('2026-09-12T08:00:00Z'), assistant({ modelID: 'claude-sonnet-4-5', providerID: 'anthropic', time: { created: T('2026-09-12T08:00:00Z') } }));   // still streaming: no tokens yet
  for (let i = 1; i <= 10; i++) msg.run('msg_u' + i, 'ses_s1', T('2026-09-10T09:10:00Z') + i * 60000, T('2026-09-10T09:10:00Z') + i * 60000, JSON.stringify({ role: 'user', time: { created: T('2026-09-10T09:10:00Z') + i * 60000 }, note: 'filler '.repeat(20) + i }));
  const part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)');
  part.run('prt_1', 'msg_a1', 'ses_s1', T('2026-09-10T09:00:01Z'), T('2026-09-10T09:00:01Z'), JSON.stringify({ type: 'tool', tool: 'read', callID: 'c1', state: { status: 'completed' } }));
  part.run('prt_2', 'msg_a1', 'ses_s1', T('2026-09-10T09:00:09Z'), T('2026-09-10T09:00:09Z'), JSON.stringify({ type: 'step-finish', reason: 'stop', cost: 0.0123, tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 300, write: 50 } } }));
  db.close();
}

/** OpenCode ≥ 2.0.3 layout (session_v2 / session_message with a `type` column; data.model = { id, providerID }).
 *  Expected: v2a1 in=100 cr=5 cw=3 out=20 msgs=1 (claude-sonnet-4-5); the user and compaction rows carry no tokens. Project ~/svc. */
function buildOpenCodeV2(sqlite, file) {
  const db = openFresh(sqlite, file);
  db.exec('CREATE TABLE session_v2(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT, fork_session_id TEXT, fork_boundary INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)');
  db.exec('CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)');
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?)').run('ses_v2', 'prj_9', '/home/me/svc', 'v2 session', null, null, T('2026-09-20T08:00:00Z'), T('2026-09-20T09:00:00Z'));
  const msg = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
  msg.run('msg_v2u1', 'ses_v2', 'user', 1, T('2026-09-20T08:00:00Z'), T('2026-09-20T08:00:00Z'), JSON.stringify({ role: 'user', time: { created: T('2026-09-20T08:00:00Z') } }));
  msg.run('msg_v2a1', 'ses_v2', 'assistant', 2, T('2026-09-20T08:00:05Z'), T('2026-09-20T08:00:09Z'), JSON.stringify({ role: 'assistant', model: { id: 'claude-sonnet-4-5', providerID: 'anthropic' }, path: { cwd: '/home/me/svc' },
    cost: 0.002, tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 5, write: 3 } }, time: { created: T('2026-09-20T08:00:05Z'), completed: T('2026-09-20T08:00:09Z') }, content: [{ type: 'tool', name: 'bash' }] }));
  msg.run('msg_v2c1', 'ses_v2', 'compaction', 3, T('2026-09-20T09:00:00Z'), T('2026-09-20T09:00:00Z'), JSON.stringify({ role: 'compaction', time: { created: T('2026-09-20T09:00:00Z') } }));
  db.close();
}

/** Goose sessions.db (schema v9 columns per the research; session-level totals only).
 *  Expected: g1 in=4000 out=900 msgs=3 (claude-sonnet-4-5, anthropic; recipe 1500 chars → overflow page) · g2 in=1500 out=400 msgs=1 local:1 (llama3.2 via ollama) ·
 *  g3 in=100 out=20 msgs=1 model unknown (model_config not JSON → badLines 1) · g4 no tokens at all (skipped, not malformed) ·
 *  g5 in=200 out=50 msgs=2 (accumulated_* NULL → input_tokens / output_tokens; gpt-5.4, openai) → in=5800 out=1370 msgs=7.
 *  Projects: D:/proj-goose, ~/app (g2 + g5), ~/x. created_at is SQLite CURRENT_TIMESTAMP text (UTC). */
function buildGoose(sqlite, file) {
  const db = openFresh(sqlite, file);
  db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY, working_dir TEXT NOT NULL, name TEXT, user_set_name INTEGER DEFAULT 0, session_type TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT, '
    + 'total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER, accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER, schedule_id TEXT, recipe TEXT, provider_name TEXT, model_config TEXT)');
  db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER)');
  const ses = db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const cfg = (model) => JSON.stringify({ model_name: model, context_limit: 200000, temperature: null, max_tokens: null, toolshim: false, toolshim_model: null });
  ses.run('g1', 'D:\\proj-goose', 'refactor', 1, 'user', '2026-09-12 08:00:00', '2026-09-12 09:30:00', 1200, 900, 300, 4900, 4000, 900, null, 'r'.repeat(1500), 'anthropic', cfg('claude-sonnet-4-5'));
  ses.run('g2', '/home/me/app', 'local run', 0, 'user', '2026-09-13 10:00:00', '2026-09-13 10:20:00', 500, 400, 100, 1900, 1500, 400, null, null, 'ollama', cfg('llama3.2'));
  ses.run('g3', 'C:\\Users\\me\\x', 'broken config', 0, 'user', '2026-09-13 12:00:00', '2026-09-13 12:01:00', 120, 100, 20, 120, 100, 20, null, null, 'anthropic', '{"model_name":');
  ses.run('g4', '/home/me/empty', 'empty', 0, 'user', '2026-09-13 13:00:00', '2026-09-13 13:00:00', null, null, null, null, null, null, null, null, 'anthropic', cfg('claude-sonnet-4-5'));
  ses.run('g5', '/home/me/app', 'older row', 0, 'user', '2026-09-13 11:00:00', '2026-09-13 11:05:00', 250, 200, 50, null, null, null, null, null, 'openai', cfg('gpt-5.4'));
  const m = db.prepare('INSERT INTO messages(session_id, role, content, timestamp) VALUES (?,?,?,?)');
  const say = (sid, role, n, ts) => { for (let i = 0; i < n; i++) m.run(sid, role, JSON.stringify([{ type: 'text', text: role + ' ' + i }]), ts + i); };
  say('g1', 'user', 2, 1789200000); say('g1', 'assistant', 3, 1789200010);
  say('g2', 'user', 1, 1789300000); say('g2', 'assistant', 1, 1789300010);
  say('g5', 'user', 2, 1789303600); say('g5', 'assistant', 2, 1789303610);
  db.close();
}

/** Devin CLI sessions.db (tables sessions + message_nodes per the research / CodeBurn). chat_message JSON: role, metadata{request_id,
 *  generation_model, created_at, metrics{input_tokens, cache_read_tokens, cache_creation_tokens[, output_tokens]}} — n3 keeps the metrics at the top
 *  level (the research's shorthand) so both spellings are exercised. Retries are sibling nodes sharing request_id (n2 repeats r1 → counted once).
 *  Expected: n1 in=2000 cr=800 cw=100 out=300 (claude-sonnet-4-5) · n3 in=900 out=0 (no output field; model from sessions.model) · n6 in=50 out=10
 *  (model from session d2, time from the node's created_at) → in=2950 cw=100 cr=800 out=310 msgs=3; dupIds 1 (n2); badLines 2 (n5 chat_message not JSON,
 *  d2 metadata not JSON); meta.acus 1.25 (d1 metadata.total_acu_cost). n4 is a user node (skipped). Projects: ~/api, D:/tools. */
function buildDevin(sqlite, file) {
  const db = openFresh(sqlite, file);
  db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY, working_directory TEXT, model TEXT, title TEXT, created_at TEXT, last_activity_at TEXT, hidden INTEGER DEFAULT 0, main_chain_id TEXT, prompt_history TEXT, metadata TEXT)');
  db.exec('CREATE TABLE message_nodes(node_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_id TEXT, chat_message TEXT NOT NULL, created_at TEXT)');
  const ses = db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)');
  ses.run('d1', '/Users/me/api', 'claude-sonnet-4-5', 'fix the api', '2026-09-14T08:59:00Z', '2026-09-14T22:00:00Z', 0, 'n3', JSON.stringify(['fix the api']), JSON.stringify({ total_credit_cost: 125, total_acu_cost: 1.25 }));
  ses.run('d2', 'D:\\tools', 'gpt-5.4', 'scripts', '2026-09-15T09:00:00Z', '2026-09-15T10:00:00Z', 0, 'n6', JSON.stringify(['scripts']), '{"total_acu_cost":');
  const node = db.prepare('INSERT INTO message_nodes VALUES (?,?,?,?,?)');
  const chat = (o) => JSON.stringify(o);
  node.run('n1', 'd1', null, chat({ role: 'assistant', content: 'plan', metadata: { request_id: 'r1', generation_model: 'claude-sonnet-4-5', created_at: '2026-09-14T09:00:00Z', metrics: { input_tokens: 2000, cache_read_tokens: 800, cache_creation_tokens: 100, output_tokens: 300 } }, tool_calls: [{ name: 'read_file' }] }), '2026-09-14T09:00:00Z');
  node.run('n2', 'd1', null, chat({ role: 'assistant', content: 'plan', metadata: { request_id: 'r1', generation_model: 'claude-sonnet-4-5', created_at: '2026-09-14T09:00:00Z', metrics: { input_tokens: 2000, cache_read_tokens: 800, cache_creation_tokens: 100, output_tokens: 300 } }, tool_calls: [] }), '2026-09-14T09:00:01Z');   // retry: same request_id
  node.run('n3', 'd1', 'n1', chat({ role: 'assistant', content: 'edit', metadata: { request_id: 'r2', created_at: '2026-09-14T22:00:00Z' }, metrics: { input_tokens: 900, cache_read_tokens: null, cache_creation_tokens: null }, tool_calls: [{ name: 'edit_file' }] }), '2026-09-14T22:00:00Z');
  node.run('n4', 'd2', null, chat({ role: 'user', content: 'write scripts', metadata: { is_user_input: true, created_at: '2026-09-15T09:00:00Z' } }), '2026-09-15T09:00:00Z');
  node.run('n5', 'd2', 'n4', '{"role":"assistant","metadata":{"request_id":"r9"', '2026-09-15T09:30:00Z');   // truncated write → not JSON
  node.run('n6', 'd2', 'n4', chat({ role: 'assistant', content: 'done', metadata: { request_id: 'r3', metrics: { input_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0, output_tokens: 10 } }, tool_calls: [] }), '2026-09-15 10:00:00');
  db.close();
}

/** Zed threads.db — see ZED_THREADS above for the rows and the expected totals. 1 KB pages; the t1 blob (~600 bytes compressed) stays local. */
function buildZed(sqlite, file) {
  const db = openFresh(sqlite, file);
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL, data_type TEXT NOT NULL, data BLOB NOT NULL)');
  const ins = db.prepare('INSERT INTO threads VALUES (?,?,?,?,?)');
  for (const r of ZED_THREADS) ins.run(r.id, r.summary, r.updated_at, r.data_type, zedThreadBlob(r));
  db.close();
}

const BUILDERS = { 'opencode.db': buildOpenCode, 'opencode-v2.db': buildOpenCodeV2, 'goose-sessions.db': buildGoose, 'devin-sessions.db': buildDevin, 'zed-threads.db': buildZed };
/** Writes the fixtures named in `only` (default: every one this Node can build — zed-threads.db needs zlib zstd) into `dir`.
 *  Returns the list of files written, or false (writing nothing) when node:sqlite is unavailable. */
export async function buildSqliteFixtures(dir, only = SQLITE_FIXTURES) {
  const sqlite = await loadSqlite();
  if (!sqlite) return false;
  const names = only.filter((f) => f !== 'zed-threads.db' || hasZstd);
  for (const f of names) BUILDERS[f](sqlite, path.join(dir, f));
  return names;
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const only = process.argv.slice(2).filter((f) => SQLITE_FIXTURES.includes(f));   // node gen-sqlite.mjs [name…] — regenerate a subset (default: all)
  const done = await buildSqliteFixtures(here, only.length ? only : SQLITE_FIXTURES);
  if (!done) { console.error('node:sqlite is unavailable in this Node — the committed .db files were left untouched'); process.exit(1); }
  if (!hasZstd) console.error('zlib has no zstd in this Node (needs >= 22.15) — zed-threads.db was left untouched');
  for (const f of done) console.log(`${f}  ${fs.statSync(path.join(here, f)).size} bytes`);
}
