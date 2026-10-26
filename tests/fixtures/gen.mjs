import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.join(import.meta.dirname, 'out');

const jl = (o) => JSON.stringify(o);

// ---- minimal ZIP writer for Wave 2 fixtures: local headers + central directory + EOCD, CRC32 (table), stored or deflate-raw entries ----
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
/** files: [{ name, data: string|Buffer, deflate?: boolean, method?: number }] → Buffer holding a valid .zip (DOS date fixed at 2026-08-01;
 *  `method` overrides the stored/deflate choice to write an entry the reader must refuse, e.g. 12 = bzip2 — data is left raw). */
function zipBuffer(files) {
  const locals = [], centrals = []; let off = 0;
  const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (8 << 5) | 1;
  for (const f of files) {
    const nameB = Buffer.from(f.name, 'utf8'), raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const method = f.method != null ? f.method : (f.deflate ? 8 : 0), data = method === 8 ? zlib.deflateRawSync(raw) : raw, crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameB.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(off, 42);
    locals.push(lh, nameB, data); centrals.push(ch, nameB);
    off += lh.length + nameB.length + data.length;
  }
  const cdBuf = Buffer.concat(centrals), cdOff = off;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(cdOff, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

export async function generate() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'claude-logs', 'projects', '-D--proj1'), { recursive: true });

  // Session aaa: 3 assistant lines, line 2 is a DUPLICATE of line 1 (same message id + requestId).
  // Expected after dedupe: in=110, cw=25, cr=50, out=220, msgs=2.
  const sess = [
    jl({ type: 'assistant', timestamp: '2026-08-10T09:00:00.000Z', cwd: 'D:\\proj1', requestId: 'r1',
         message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 25 } } }),
    jl({ type: 'assistant', timestamp: '2026-08-10T09:00:05.000Z', cwd: 'D:\\proj1', requestId: 'r1',
         message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 25 } } }),
    jl({ type: 'assistant', timestamp: '2026-08-11T10:00:00.000Z', cwd: 'D:\\proj1', requestId: 'r2',
         message: { id: 'm2', model: 'claude-fable-5', usage: { input_tokens: 10, output_tokens: 20 } } }),
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'claude-logs', 'projects', '-D--proj1', 'sess-aaa.jsonl'), sess);

  const sess2 = [
    jl({ type: 'assistant', timestamp: '2026-08-12T06:15:00.000Z', cwd: 'D:\\proj2', requestId: 'h1', message: { id: 'h1', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 10 } } }),
    jl({ type: 'assistant', timestamp: '2026-08-12T06:45:00.000Z', cwd: 'D:\\proj2', requestId: 'h2', message: { id: 'h2', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 10 } } }),
    jl({ type: 'assistant', timestamp: '2026-08-12T20:05:00.000Z', cwd: 'D:\\proj2', requestId: 'h3', message: { id: 'h3', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 10 } } }),
  ].join('\n');
  fs.mkdirSync(path.join(OUT, 'claude-logs', 'projects', '-D--proj2'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'claude-logs', 'projects', '-D--proj2', 'sess-hours.jsonl'), sess2);

  fs.writeFileSync(path.join(OUT, 'generic-badnums.csv'),
    'date,platform,model,input_tokens,output_tokens,cost\n' +
    '2026-08-10,Gemini,gemini-3.5-flash,100,1e309,0.5\n' +      // Infinity output
    '2026-08-10,Gemini,gemini-3.5-flash,12junk,50,abc\n' +      // garbage number, garbage cost
    '2026-08-11,Gemini,gemini-3.5-flash,-40,60,-0.25\n');       // negative tokens (reject), negative cost (allow: credit)

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

  // T7c (v5 T3) — the SAME session resumed in a later rollout file: total_token_usage starts at the earlier file's final cumulative
  //   (5000/1000/400 here, well above rollout-…-abc's 400/200/130), so delta-of-cumulative would book a giant first delta (4200/1100/450);
  //   last_token_usage is this turn only and is what the parser books. Per event (in/cached/out; reasoning ⊂ out, never added on top):
  //   #1 total 5300/1100/450 · last 300/100/50            → in 300−100 = 200 · cr 100 · out 50
  //   #2 total 5500/1100/480 · last 200/0/30              → in 200 · cr 0 · out 30
  //   #3 identical to #2 (rate-limit refresh re-emits it) → skipped (cumulative unchanged)
  //   #4 total 5900/1300/540 · last_token_usage: null     → fallback diff vs #2's total: in 400−200 = 200 · cr 200 · out 60
  //   #5 total 6000/1300/550 · last 100/0/10              → in 100 · cr 0 · out 10
  //   Expected: in = 200+200+200+100 = 700 · cr = 100+0+200+0 = 300 · out = 50+30+60+10 = 150 · msgs=4 · lines=7 · badLines=0
  w('codex/sessions/2026/08/11/rollout-2026-08-11T08-00-00-abc-resumed.jsonl', [
    jl({ timestamp: '2026-08-11T08:00:00.000Z', type: 'session_meta', payload: { id: 'abc', cwd: 'D:\\proj1', cli_version: '0.40.0', originator: 'codex_cli_rs' } }),
    jl({ timestamp: '2026-08-11T08:00:01.000Z', type: 'turn_context', payload: { cwd: 'D:\\proj1', model: 'gpt-5.4-codex', approval_policy: 'on-request' } }),
    jl({ timestamp: '2026-08-11T08:01:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: tk(5300, 1100, 450, 100), last_token_usage: tk(300, 100, 50, 10), model_context_window: 400000 } } }),
    jl({ timestamp: '2026-08-11T08:05:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: tk(5500, 1100, 480, 110), last_token_usage: tk(200, 0, 30, 10), model_context_window: 400000 } } }),
    jl({ timestamp: '2026-08-11T08:05:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: tk(5500, 1100, 480, 110), last_token_usage: tk(200, 0, 30, 10), model_context_window: 400000 }, rate_limits: { primary: { used_percent: 14 } } } }),   // re-emitted snapshot → skipped
    jl({ timestamp: '2026-08-11T09:10:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: tk(5900, 1300, 540, 130), last_token_usage: null, model_context_window: 400000 } } }),   // no per-turn usage → cumulative delta
    jl({ timestamp: '2026-08-11T09:20:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: tk(6000, 1300, 550, 135), last_token_usage: tk(100, 0, 10, 5), model_context_window: 400000 } } }),
  ].join('\n') + '\n');

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
      gmsg('g4', '2026-08-11T08:00:00.000Z', 'gemini-3-flash', { input: 500, output: 20, cached: 0, thoughts: 0, tool: 25, total: 545 }),   // tool = toolUsePromptTokenCount (billed input for built-in tools)
    ] }, null, 1));
  w('gemini/tmp/abc123/chats/session-bad.json', '{ this is not json');

  // T9 — Copilot CLI events. sess-1: 3 assistant.usage (e3 duplicated by id → skipped) + 1 bad line + session.shutdown that must NOT double count. sess-1 session.start carries context.cwd D:\proj1 (T15 projects).
  //   sess-1 expected: in=1200+800+100=2100 cw=100 cr=900 out=300+150+40=490 msgs=3 badLines=1
  //   sess-2: shutdown-only file → fallback to modelMetrics: in=50 out=10 msgs=2. Both files: in=2150 cw=100 cr=900 out=500 msgs=5
  const cu = (id, ts, model, d) => jl({ id, type: 'assistant.usage', timestamp: ts, data: { model, ...d } });
  w('copilot/session-state/sess-1/events.jsonl', [
    jl({ id: 'e1', type: 'session.start', timestamp: '2026-08-10T09:00:00.000Z', data: { sessionId: 'sess-1', context: { cwd: 'D:\\proj1', gitRoot: 'D:\\proj1', repository: 'alaa/proj1', branch: 'main' } } }),   // T15: cwd → Projects table (sess-2 keeps NO cwd → '(unknown project)' bucket)
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

  // Plan 5 review M2 — a SECOND Copilot CLI events file whose assistant.usage ids REPEAT sess-1's (e2 / e3 / e4): on disk every session's
  // file is named events.jsonl and the sid comes from the parent directory, so two DROPPED files need distinct synthetic directories or the
  // second one's events dedupe away against the first. Kept OUTSIDE copilot/ so the folder-scan totals above stay 2150/100/900/500/5.
  //   expected alone: in=10+20+30=60 out=5+7+9=21 msgs=3 · dropped together with sess-1: in=2160 cw=100 cr=900 out=511 msgs=6
  w('copilot-drop/events.jsonl', [
    jl({ id: 'e1', type: 'session.start', timestamp: '2026-08-12T09:00:00.000Z', data: { sessionId: 'sess-3' } }),
    cu('e2', '2026-08-12T09:01:00.000Z', 'gpt-5.4', { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 }),
    cu('e3', '2026-08-12T09:02:00.000Z', 'gpt-5.4', { inputTokens: 20, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 }),
    cu('e4', '2026-08-12T09:03:00.000Z', 'gpt-5.4', { inputTokens: 30, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 }),
  ].join('\n') + '\n');
  // T10 — Continue dev_data. Expected: in=1500+700+300=2500 out=200+50+30=280 msgs=3 badLines=1; chatInteraction.jsonl must be ignored by the pattern.
  w('continue/dev_data/0.2.0/tokensGenerated.jsonl', [
    jl({ eventName: 'tokensGenerated', schema: '0.2.0', timestamp: '2026-08-10T09:00:00.000Z', model: 'claude-sonnet-4.5', provider: 'anthropic', promptTokens: 1500, generatedTokens: 200, userId: 'u', selectedProfileId: 'local' }),
    jl({ eventName: 'tokensGenerated', schema: '0.2.0', timestamp: '2026-08-10T09:30:00.000Z', model: 'claude-sonnet-4.5', provider: 'anthropic', promptTokens: 700, generatedTokens: 50, userId: 'u', selectedProfileId: 'local' }),
    '{"eventName":"tokensGenerated","schema":"0.2.0","timestamp":"2026-08-10T10:00:00.000Z","model":"gpt-5.4","promptTokens":',   // truncated line
    jl({ eventName: 'tokensGenerated', schema: '0.2.0', timestamp: '2026-08-11T21:00:00.000Z', model: 'qwen3:14b', provider: 'ollama', promptTokens: 300, generatedTokens: 30, userId: 'u', selectedProfileId: 'local' }),
  ].join('\n') + '\n');
  w('continue/dev_data/0.2.0/chatInteraction.jsonl', jl({ eventName: 'chatInteraction', schema: '0.2.0', timestamp: '2026-08-10T09:00:00.000Z', model: 'claude-sonnet-4.5', prompt: 'hi', completion: 'hello' }) + '\n');

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
  // T11b — tokensIn semantics + per-request model attribution (checked in a SEPARATE file set so the T11 totals above stay put).
  //   Roo task: model_usage deliberately out of order (sonnet@10:00 listed before opus@09:00) — parser must sort by ts and pick the
  //   entry with the greatest ts <= request ts. Roo stores tokensIn INCLUSIVE of cache tokens → in = tokensIn - cacheReads - cacheWrites.
  //     09:00:05 apiProtocol openai  tokensIn 50000 cacheReads 45000        → opus   in=5000  cr=45000 out=100
  //     10:00:05 (no apiProtocol)    tokensIn 2000  cw 200 cr 300           → sonnet in=1500  cw=200 cr=300 out=50
  //     11:00:00 apiProtocol openai  tokensIn 100   cacheReads 900          → sonnet in=100   cr=900 (evidently exclusive: never clamp to 0)
  //     (no ts)  apiProtocol openai  tokensIn 300                           → sonnet (last entry when ts missing) in=300 out=5, day = file.lastModified
  //   Cline task (provider anthropic, no apiProtocol): tokensIn 1000 cw 100 cr 400 → under cline in=1000 (exclusive/additive); under roo in=500.
  w('roo/tasks/1786352600000/ui_messages.json', JSON.stringify([
    req(T('2026-08-10T09:00:05.000Z'), { request: '…', tokensIn: 50000, tokensOut: 100, cacheWrites: 0, cacheReads: 45000, cost: 0.1, apiProtocol: 'openai' }),
    req(T('2026-08-10T10:00:05.000Z'), { request: '…', tokensIn: 2000, tokensOut: 50, cacheWrites: 200, cacheReads: 300, cost: 0.01 }),
    req(T('2026-08-10T11:00:00.000Z'), { request: '…', tokensIn: 100, tokensOut: 10, cacheWrites: 0, cacheReads: 900, cost: 0.001, apiProtocol: 'openai' }),
    { type: 'say', say: 'api_req_started', text: JSON.stringify({ request: '…', tokensIn: 300, tokensOut: 5, cacheWrites: 0, cacheReads: 0, cost: 0.001, apiProtocol: 'openai' }) },
  ], null, 1));
  w('roo/tasks/1786352600000/task_metadata.json', JSON.stringify({ files_in_context: [], model_usage: [
    { ts: T('2026-08-10T10:00:00.000Z'), model_id: 'claude-sonnet-4.5', model_provider_id: 'openrouter', mode: 'act' },
    { ts: T('2026-08-10T09:00:00.000Z'), model_id: 'claude-opus-4.1', model_provider_id: 'openrouter', mode: 'plan' },
  ] }));
  w('cline/tasks/1786352700000/ui_messages.json', JSON.stringify([
    req(T('2026-08-11T09:00:05.000Z'), { request: '…', tokensIn: 1000, tokensOut: 20, cacheWrites: 100, cacheReads: 400, cost: 0.005 }),
  ], null, 1));
  w('cline/tasks/1786352700000/task_metadata.json', JSON.stringify({ files_in_context: [], model_usage: [{ ts: T('2026-08-11T09:00:00.000Z'), model_id: 'claude-sonnet-4.5', model_provider_id: 'anthropic', mode: 'act' }] }));
  // T11c — local-provider rows: a Cline task whose model_usage names a LOCAL backend (model_provider_id 'ollama') must come out
  //   with local:1 → Pricing.cost = $0 (platform stays 'Cline'). Separate task dir so the T11/T11b totals stay put.
  w('cline/tasks/1786352800000/ui_messages.json', JSON.stringify([
    req(T('2026-08-12T09:00:05.000Z'), { request: '…', tokensIn: 400, tokensOut: 40, cacheWrites: 0, cacheReads: 0, cost: 0 }),
  ], null, 1));
  w('cline/tasks/1786352800000/task_metadata.json', JSON.stringify({ files_in_context: [], model_usage: [{ ts: T('2026-08-12T09:00:00.000Z'), model_id: 'qwen3:14b', model_provider_id: 'ollama', mode: 'act' }] }));

  // T12 — Aider chat history. "sent" is the full prompt; cache write/hit are carved out. Expected (est):
  //   in = 8200 + (12000-2100-8000) + 500 = 10600 · cw=2100 · cr=8000 · out = 578+1200+50 = 1828 · msgs=3 · badLines=1 (unparseable Tokens line) · models gpt-5.4 (Aug 10) + claude-sonnet-4.5 (Aug 11)
  //   real aider prints "Main model:" (not "Model:"), plus a "Weak model:" line that must NOT be picked up as the row model
  w('aider/proj/.aider.chat.history.md', [
    '# aider chat started at 2026-08-10 09:12:33', '',
    '> Aider v0.86.1', '> Main model: gpt-5.4 with diff edit format', '> Weak model: gpt-5-mini', '> Git repo: .git with 12 files', '',
    '#### make it faster', '',
    'I will change the loop.', '',
    '> Tokens: 8.2k sent, 578 received. Cost: $0.03 message, $0.05 session.',
    '> Tokens: 12k sent, 2.1k cache write, 8k cache hit, 1.2k received. Cost: $0.02 message, $0.07 session.',
    '> Tokens: lots sent, some received.', '',
    '# aider chat started at 2026-08-11 14:00:00', '',
    '> Model: claude-sonnet-4.5 with diff edit format',
    '> Tokens: 500 sent, 50 received. Cost: $0.01 message, $0.01 session.', '',
  ].join('\n'));
  // T12b — Aider on a local backend: LiteLLM-style provider prefix ('ollama_chat/', 'ollama/', 'lm_studio/') → local:1 → $0. Separate repo folder so T12 totals stay put.
  w('aider/local/.aider.chat.history.md', [
    '# aider chat started at 2026-08-12 10:00:00', '',
    '> Aider v0.86.1', '> Main model: ollama_chat/qwen3 with whole edit format', '',
    '> Tokens: 1.2k sent, 90 received. Cost: $0.00 message, $0.00 session.', '',
  ].join('\n'));
  // T7b — Codex CLI on a local provider: session_meta.payload.model_provider is the built-in OSS provider id ('ollama' / 'lmstudio';
  //   older builds wrote 'oss'). Only that field says "local" — a gpt-oss:* model name alone (second file) must NOT be treated as local.
  w('codex/sessions/2026/08/12/rollout-2026-08-12T09-00-00-oss.jsonl', [
    jl({ timestamp: '2026-08-12T09:00:00.000Z', type: 'session_meta', payload: { id: 'oss1', cwd: 'D:\\proj1', cli_version: '0.60.0', originator: 'codex_cli_rs', model_provider: 'ollama' } }),
    jl({ timestamp: '2026-08-12T09:00:01.000Z', type: 'turn_context', payload: { cwd: 'D:\\proj1', model: 'gpt-oss:20b', approval_policy: 'on-request' } }),
    jl({ timestamp: '2026-08-12T09:01:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: tk(300, 0, 60, 10), last_token_usage: tk(300, 0, 60, 10) } } }),
  ].join('\n') + '\n');
  w('codex/sessions/2026/08/12/rollout-2026-08-12T10-00-00-named.jsonl', [
    jl({ timestamp: '2026-08-12T10:00:00.000Z', type: 'session_meta', payload: { id: 'named1', cwd: 'D:\\proj1', cli_version: '0.60.0', originator: 'codex_cli_rs' } }),
    jl({ timestamp: '2026-08-12T10:00:01.000Z', type: 'turn_context', payload: { cwd: 'D:\\proj1', model: 'gpt-oss:20b', approval_policy: 'on-request' } }),
    jl({ timestamp: '2026-08-12T10:01:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: tk(300, 0, 60, 10), last_token_usage: tk(300, 0, 60, 10) } } }),
  ].join('\n') + '\n');

  // T13 — Junie events. Expected: in=1500+900+300=2700 out=200+120+40=360 cr=600 msgs=3 badLines=1 (truncated line); models claude-sonnet-4.5 + gpt-5.4 (alternate nesting: event.usage + modelName)
  w('junie/.matterhorn/events/ISSUE-1 task-1-events.jsonl', [
    jl({ timestamp: '2026-08-10T09:00:00.000Z', event: { type: 'AgentStartedEvent', issueId: 'ISSUE-1' } }),
    jl({ timestamp: '2026-08-10T09:00:10.000Z', event: { type: 'LlmResponseEvent', model: 'claude-sonnet-4.5', inputTokens: 1500, outputTokens: 200, cacheTokens: 600, cost: 0.011, answer: { text: '…' } } }),
    jl({ timestamp: '2026-08-10T09:01:00.000Z', event: { type: 'LlmResponseEvent', model: 'claude-sonnet-4.5', inputTokens: 900, outputTokens: 120, cacheTokens: 0, cost: 0.004 } }),
    '{"timestamp":"2026-08-10T09:02:00.000Z","event":{"type":"LlmResponseEvent"',   // truncated
    jl({ timestamp: '2026-08-10T21:00:00.000Z', event: { type: 'LlmResponseEvent', modelName: 'gpt-5.4', usage: { inputTokens: 300, outputTokens: 40 } } }),
    jl({ timestamp: '2026-08-10T21:00:30.000Z', event: { type: 'AgentFinishedEvent' } }),
  ].join('\n') + '\n');

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
  //   Real exports carry FOUR ADDITIVE token columns: Input (w/ Cache Write) = cache-write tokens, Input (w/o Cache Write) = plain input,
  //   Cache Read, Output — and Total Tokens = their sum. The parser reconciles each row against Total Tokens.
  //   row1 (real shape, both non-zero): additive → in 33556, cw 38721, cr 301056, out 28089
  //   row2 (w/ < w/o): additive → in 500, cw 100, out 80
  //   row3 (legacy superset shape: 2500+(3000−2500)+0+600 = 3600): in 2500, cw 500, out 600
  //   row4: 'abc' rejected → in 10, cw 0, out 5 (0+10+0+5 = 15 additive)
  //   row5: reconciles neither way (total 999) → unreconciled, additive reading in 100, cw 200, cr 50, out 30
  //   Expected: in=36666 cw=39521 cr=301106 out=28804 msgs=5 rejected=1 unreconciled=1 · platform Cursor · no cost column → no billed rows
  w('cursor/usage-events.csv', [
    'Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens',
    '2026-08-10T09:00:00.000Z,Included,claude-4.5-sonnet,No,38721,33556,301056,28089,401422',
    '2026-08-10T09:30:00.000Z,Included,claude-4.5-sonnet,No,100,500,0,80,680',
    '2026-08-11T10:00:00.000Z,Usage-based,gpt-5.4,Yes,3000,2500,0,600,3600',
    '2026-08-11T10:05:00.000Z,Included,gpt-5.4,No,abc,10,0,5,15',
    '2026-08-11T10:10:00.000Z,Included,gpt-5.4,No,200,100,50,30,999',
  ].join('\n') + '\n');

  // ---- Plan 4b (Wave 2) fixtures: wave2/ subtree ----
  // T4 — LocalAI GET /api/usage?period=week (the card's DATA fetch). Buckets are the server's own labels with no zone attached —
  //   SQLite strftime('%Y-%m-%d', created_at), Postgres to_char(date_trunc('day'), 'YYYY-MM-DD'), in-memory Go time.Format("2006-01-02")
  //   (core/http/auth/usage.go periodToWindow, core/services/routing/billing/inmem.go) — i.e. plain 'YYYY-MM-DD' strings. period=day would be
  //   'YYYY-MM-DD HH:00' and period=all 'YYYY-MM' calendar months (see the -all fixture below). viewer = {id, name, role, provider}.
  //   4 buckets: one model on two days, two models on one day, one bucket with a garbage count (int64 on the real wire — robustness only).
  //   Rows (day / model): 2026-08-10 llama-3.2-3b in=1200 out=300 msgs=4 · 2026-08-10 qwen3-8b in=500 out=100 msgs=1
  //                       2026-08-11 llama-3.2-3b in=20 out=10 msgs=1 · 2026-08-11 qwen3-8b ('abc' prompt_tokens → 0) in=0 out=5 msgs=1
  //   Payload totals: in = 1200+500+20+0 = 1720 · out = 300+100+10+5 = 415 · msgs = 4+1+1+1 = 7 · 4 buckets · 2 days · 2 models · first day 2026-08-10
  w('wave2/localai-usage.json', JSON.stringify({
    usage: [
      { bucket: '2026-08-10', model: 'llama-3.2-3b', prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, request_count: 4 },
      { bucket: '2026-08-10', model: 'qwen3-8b', prompt_tokens: 500, completion_tokens: 100, total_tokens: 600, request_count: 1 },
      { bucket: '2026-08-11', model: 'llama-3.2-3b', prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, request_count: 1 },
      { bucket: '2026-08-11', model: 'qwen3-8b', prompt_tokens: 'abc', completion_tokens: 5, total_tokens: 5, request_count: 1 },
    ],
    totals: { prompt_tokens: 1720, completion_tokens: 415, total_tokens: 2135, request_count: 7 },
    viewer: { id: 'local', name: 'local', role: 'admin', provider: 'local' },
  }, null, 1));
  // T4 — LocalAI GET /api/usage?period=all: calendar-MONTH buckets ('YYYY-MM' — strftime('%Y-%m') / to_char('YYYY-MM') / Format("2006-01")),
  //   so a month's whole total would land on the 1st if it were ever turned into day rows — the card reads ONLY its totals for the
  //   "history since …" label. 4 buckets over 3 months, earliest 2026-06:
  //   totals: prompt = 30000+10000+1220+500 = 41720 · completion = 8000+2000+310+105 = 10415 · total = 41720+10415 = 52135 · requests = 60+20+5+2 = 87
  w('wave2/localai-usage-all.json', JSON.stringify({
    usage: [
      { bucket: '2026-06', model: 'llama-3.2-3b', prompt_tokens: 30000, completion_tokens: 8000, total_tokens: 38000, request_count: 60 },
      { bucket: '2026-07', model: 'llama-3.2-3b', prompt_tokens: 10000, completion_tokens: 2000, total_tokens: 12000, request_count: 20 },
      { bucket: '2026-08', model: 'llama-3.2-3b', prompt_tokens: 1220, completion_tokens: 310, total_tokens: 1530, request_count: 5 },
      { bucket: '2026-08', model: 'qwen3-8b', prompt_tokens: 500, completion_tokens: 105, total_tokens: 605, request_count: 2 },
    ],
    totals: { prompt_tokens: 41720, completion_tokens: 10415, total_tokens: 52135, request_count: 87 },
    viewer: { id: 'local', name: 'local', role: 'admin', provider: 'local' },
  }, null, 1));

  // T5a — Prometheus text exposition sample for parsePrometheus. Expected: 5 metrics (HELP/TYPE/comment + 'bad line without value' dropped):
  //   [0] vllm:prompt_tokens_total model_name=meta-llama/Llama-3.1-8B-Instruct value 1.5e+06 → 1500000
  //   [1] vllm:prompt_tokens_total model_name='quoted "name" \ back' (escapes \" and \\ unescaped) value 42, trailing timestamp ignored
  //   [2] plain_gauge 7 (no labels) · [3] empty_labels{} 3 (labels = {}) · [4] weird_value{x="y"} +Inf → Infinity
  w('wave2/prometheus-sample.txt', [
    '# HELP vllm:prompt_tokens_total Number of prefill tokens processed.',
    '# TYPE vllm:prompt_tokens_total counter',
    'vllm:prompt_tokens_total{model_name="meta-llama/Llama-3.1-8B-Instruct"} 1.5e+06',
    'vllm:prompt_tokens_total{model_name="quoted \\"name\\" \\\\ back"} 42 1723456789000',
    'plain_gauge 7',
    'empty_labels{} 3',
    'weird_value{x="y"} +Inf',
    'bad line without value',
    '# a trailing comment',
    '',
  ].join('\n'));

  // T5b — vLLM /metrics snapshots. L = Llama counters {in, out, cr, stop, len} (request_success_total split by finished_reason), Q = Qwen {in, out}.
  //   vllm:prompt_tokens_total counts EVERY prompt token, prefix-cache hits included, so pollVllm books in = prompt − cached (uncached input,
  //   the dashboard convention) and cr = cached; the baseline stores those derived counters.
  //   A (baseline):  L 1000/200/100, stop 3, len 1 · Q 50/10            → first tick seeds the baseline (in = 1000−100 = 900), nothing counted
  //   B (grew):      L 1600/350/130, stop 5, len 1 · Q 50/10            → in = 1600−130 = 1470; deltas L in=1470−900=570 out=150 cr=30 msgs=(5+1)-(3+1)=2 · Q all 0 (no Qwen row)
  //   C (restart):   L 120/30/0,     stop 1, len 0 · Q 5/1              → every counter LOWER → nothing added, baseline = C (in=120)
  //   D (after):     L 220/60/0,     stop 2, len 0 · Q 5/1              → deltas L in=100 out=30 cr=0 msgs=1 · Q 0
  //   Running totals after D: in=670 out=180 cr=30 msgs=3, one model (Llama), platform vLLM
  //   E (OTHER server, :8001): L 5000/900/400, stop 20, len 2 · Q 50/10 → in = 5000−400 = 4600. Validated right after B at :8000: the baseline is keyed by
  //                  server URL, so this seeds only (an id-keyed baseline would book a phantom 4600−1470 = 3130 in / 550 out / 270 cr / 16 msgs)
  //   F (E grew):    L 5200/950/420, stop 21, len 2 · Q 50/10           → in = 5200−420 = 4780; deltas L in=180 out=50 cr=20 msgs=1 · Q 0
  const LLAMA = 'meta-llama/Llama-3.1-8B-Instruct', QWEN = 'Qwen/Qwen3-8B';
  const vllmMetrics = (L, Q) => [
    '# HELP vllm:prompt_tokens_total Number of prefill tokens processed.',
    '# TYPE vllm:prompt_tokens_total counter',
    `vllm:prompt_tokens_total{model_name="${LLAMA}"} ${L.in}`,
    `vllm:prompt_tokens_total{model_name="${QWEN}"} ${Q.in}`,
    '# HELP vllm:generation_tokens_total Number of generation tokens processed.',
    '# TYPE vllm:generation_tokens_total counter',
    `vllm:generation_tokens_total{model_name="${LLAMA}"} ${L.out}`,
    `vllm:generation_tokens_total{model_name="${QWEN}"} ${Q.out}`,
    '# HELP vllm:prompt_tokens_cached_total Number of prefill tokens served from the prefix cache.',
    '# TYPE vllm:prompt_tokens_cached_total counter',
    `vllm:prompt_tokens_cached_total{model_name="${LLAMA}"} ${L.cr}`,
    '# HELP vllm:request_success_total Count of successfully processed requests.',
    '# TYPE vllm:request_success_total counter',
    `vllm:request_success_total{finished_reason="stop",model_name="${LLAMA}"} ${L.stop}`,
    `vllm:request_success_total{finished_reason="length",model_name="${LLAMA}"} ${L.len}`,
    '# HELP vllm:num_requests_running Number of requests currently running on GPU.',
    '# TYPE vllm:num_requests_running gauge',
    `vllm:num_requests_running{model_name="${LLAMA}"} 0.0`,
    '',
  ].join('\n');
  w('wave2/vllm-metrics-a.txt', vllmMetrics({ in: '1000.0', out: '200.0', cr: '100.0', stop: '3.0', len: '1.0' }, { in: '50.0', out: '10.0' }));
  w('wave2/vllm-metrics-b.txt', vllmMetrics({ in: '1.6e+03', out: '350.0', cr: '130.0', stop: '5.0', len: '1.0' }, { in: '50.0', out: '10.0' }));   // exponent form, as real exposition prints large counters
  w('wave2/vllm-metrics-c.txt', vllmMetrics({ in: '120.0', out: '30.0', cr: '0.0', stop: '1.0', len: '0.0' }, { in: '5.0', out: '1.0' }));
  w('wave2/vllm-metrics-d.txt', vllmMetrics({ in: '220.0', out: '60.0', cr: '0.0', stop: '2.0', len: '0.0' }, { in: '5.0', out: '1.0' }));
  w('wave2/vllm-metrics-e.txt', vllmMetrics({ in: '5000.0', out: '900.0', cr: '400.0', stop: '20.0', len: '2.0' }, { in: '50.0', out: '10.0' }));
  w('wave2/vllm-metrics-f.txt', vllmMetrics({ in: '5200.0', out: '950.0', cr: '420.0', stop: '21.0', len: '2.0' }, { in: '50.0', out: '10.0' }));

  // T5c — llama-server /metrics (--metrics on): no model label, no request counter. Expected counters: in=4321 out=876 under the /props model_path basename 'Qwen3-8B-Q4_K_M'
  w('wave2/llamacpp-metrics.txt', [
    '# HELP llamacpp:prompt_tokens_total Number of prompt tokens processed.',
    '# TYPE llamacpp:prompt_tokens_total counter',
    'llamacpp:prompt_tokens_total 4321',
    '# HELP llamacpp:tokens_predicted_total Number of generation tokens processed.',
    '# TYPE llamacpp:tokens_predicted_total counter',
    'llamacpp:tokens_predicted_total 876',
    '# HELP llamacpp:requests_processing Number of requests processing.',
    '# TYPE llamacpp:requests_processing gauge',
    'llamacpp:requests_processing 0',
    'llamacpp:kv_cache_usage_ratio 0.0123',
    '',
  ].join('\n'));

  // T6 (4b) — Jan threads/<id>/messages.jsonl. estTok = round(chars/4); input = previous user text (always estimated → every row est:1);
  //   output = metadata.tokenCount (also accepted inside metadata.tokenSpeed{}) when present, else estTok(text).
  //   t1/a1: user 40 chars → in 10 · text 100 chars but tokenCount 30 → out 30 · model message.model.id 'llama3.2-3b-instruct' · created_at ms 2026-08-10T09:00Z
  //   t1/a2: user 24 chars (plain-string content) → in 6 · text 52 chars, no tokenCount → out 13 · model metadata.model 'qwen3-4b' · created = unix SECONDS 1786396200 (= 2026-08-10T21:10:00Z)
  //   t2/a1: user 8 chars → in 2 · text 200 chars but tokenSpeed.tokenCount 45 → out 45 · no model anywhere → 'jan' · created_at ms 2026-08-12T09:00Z
  //   Expected: in=10+6+2=18 out=30+13+45=88 msgs=3 files=2 badLines=1 (one non-JSON line) · a system line is ignored · models [jan, llama3.2-3b-instruct, qwen3-4b]
  w('wave2/jan/threads/t1/messages.jsonl', [
    jl({ id: 'u1', object: 'thread.message', thread_id: 't1', role: 'user', content: [{ type: 'text', text: { value: 'x'.repeat(40), annotations: [] } }], status: 'ready', created_at: T('2026-08-10T08:59:00.000Z') }),
    jl({ id: 'a1', object: 'thread.message', thread_id: 't1', role: 'assistant', content: [{ type: 'text', text: { value: 'y'.repeat(100), annotations: [] } }], status: 'ready', created_at: T('2026-08-10T09:00:00.000Z'), model: { id: 'llama3.2-3b-instruct', engine: 'llamacpp' }, metadata: { tokenCount: 30, tokenSpeed: 25.5 } }),
    'not json at all',
    jl({ id: 'u2', thread_id: 't1', role: 'user', content: 'x'.repeat(24), created: 1786396140 }),
    jl({ id: 'a2', thread_id: 't1', role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(52) }], created: 1786396200, metadata: { model: 'qwen3-4b' } }),
  ].join('\n') + '\n');
  w('wave2/jan/threads/t2/messages.jsonl', [
    jl({ id: 'u1', thread_id: 't2', role: 'user', content: 'ab'.repeat(4), created_at: T('2026-08-12T08:59:00.000Z') }),
    jl({ id: 'a1', thread_id: 't2', role: 'assistant', content: [{ type: 'text', text: { value: 'z'.repeat(200) } }], created_at: T('2026-08-12T09:00:00.000Z'), metadata: { tokenSpeed: { message: 'a1', tokenSpeed: 30.1, tokenCount: 45, lastTimestamp: T('2026-08-12T09:00:05.000Z') } } }),
    jl({ id: 's1', thread_id: 't2', role: 'system', content: 'ignored' }),
  ].join('\n') + '\n');
  w('wave2/jan/threads/t1/thread.json', JSON.stringify({ id: 't1', title: 'test thread', assistants: [{ id: 'jan', model: { id: 'llama3.2-3b-instruct' } }] }));   // not matched by the pattern — ignored
  // T6 (4b) — text-generation-webui history JSON. Both sides estimated (est:1); the '<|BEGIN-VISIBLE-CHAT|>' greeting pair is not a generation → skipped;
  //   timestamps are LOCAL time strings ('YYYY-MM-DD HH:MM:SS') → day/hour exactly as written in every timezone.
  //   chat pair1: user 40 → in 10, reply 80 → out 20 · pair2: 16 → 4, 120 → 30 · both model 'Qwen3-8B-Q4_K_M.gguf', hour 9 → one row in=14 out=50 msgs=2
  //   instruct pair: 8 → 2, 60 → 15 · no model_name → 'text-generation-webui', hour 10
  //   Expected: in=16 out=65 msgs=3 files=3 badLines=1 (bad.json) · rows=2 · days 2026-08-10 / 2026-08-11 · hours [9, 10]
  w('wave2/tgwebui/user_data/logs/chat/Assistant/20260810-09-12-33.json', JSON.stringify({
    internal: [['<|BEGIN-VISIBLE-CHAT|>', 'How can I help you today?'], ['u'.repeat(40), 'a'.repeat(80)], ['u'.repeat(16), 'a'.repeat(120)]],
    visible: [['', 'How can I help you today?'], ['u'.repeat(40), 'a'.repeat(80)], ['u'.repeat(16), 'a'.repeat(120)]],
    metadata: { assistant_0: { timestamp: '2026-08-10 09:12:00' }, user_1: { timestamp: '2026-08-10 09:12:33' }, assistant_1: { timestamp: '2026-08-10 09:12:40', model_name: 'Qwen3-8B-Q4_K_M.gguf' },
      user_2: { timestamp: '2026-08-10 09:15:00' }, assistant_2: { timestamp: '2026-08-10 09:15:20', model_name: 'Qwen3-8B-Q4_K_M.gguf', versions: [{ content: 'older regeneration', timestamp: '2026-08-10 09:15:10' }] } } }, null, 1));
  w('wave2/tgwebui/user_data/logs/chat/Assistant/bad.json', '{');
  w('wave2/tgwebui/user_data/logs/instruct/20260811-10-00-00.json', JSON.stringify({
    internal: [['q'.repeat(8), 'r'.repeat(60)]], visible: [['q'.repeat(8), 'r'.repeat(60)]],
    metadata: { user_0: { timestamp: '2026-08-11 10:00:00' }, assistant_0: { timestamp: '2026-08-11 10:00:05' } } }, null, 1));
  w('wave2/tgwebui/user_data/logs/chat_state.json', JSON.stringify({ unique_id: 'x' }));   // not matched (no chat/ or instruct/ dir) — ignored
  // ---- Plan 4b (Wave 2) fixtures: API vendors ----
  // T7 — Fireworks billingUsage + billing/summary in the DOCUMENTED wire shape (docs.fireworks.ai/accounts/exporting-usage-and-costs, api-reference/get-billing-usage, api-reference/get-billing-summary):
  //   billingUsage = gatewayAccountUsage { serverlessCosts[], dedicatedCosts[], trainingCosts[] } — serverless rows: promptTokens / completionTokens as JSON STRINGS (int64), group { model_name } (map<string,string>), startTime / endTime, costNanoUsd;
  //   dedicated rows: acceleratorSeconds (string int64), deploymentId, acceleratorType, baseModel, group { deployment_name } — NO token fields (dedicated deployments are metered in GPU time; usageType / placement values here are illustrative).
  //   billing/summary?granularity=DAILY = { lineItems[] (PERIOD totals — must NOT be counted per day), usageBuckets[] { startTime, endTime, lineItems[] { series, category, totalCost: { currencyCode, units, nanos } } } }.
  //   Days are RELATIVE so the 90-day fetch window always covers them: A = 3 days ago, B = 40 days ago (a different 31-day window), Z = 200 days ago (outside the range → must be dropped).
  //   serverless: A llama in 12000 out 3400 · A qwen in 5000 out 900 · A llama promptTokens "abc" (rejected → 0) out 10 · B llama in 800 out 120 · Z 99999/99999 (dropped)
  //   dedicated:  A dep-1 7200 accelerator-seconds (= 2.0 accelerator-h; no tokens → no day·model row) · Z dep-1 99999 s (dropped by the window guard)
  //   Expected rows (serverless only — dedicated rows carry no tokens): in = 12000+5000+0+800 = 17800 · out = 3400+900+10+120 = 4430 · msgs = 0 (no request count in the export)
  //     3 day·model rows: A/llama (in 12000, out 3400+10 = 3410), A/qwen, B/llama · model names lose the accounts/<acct>/models/ prefix · meta.acceleratorSeconds = 7200
  //   summary per-day buckets: A serverless 1 + 0.84 = 1.84, dedicated 4 + 0.50 = 4.50 → 6.34 · B 0 + 0.12 = 0.12 · Z training 9.99 (dropped) → 2 billed days, total 6.34 + 0.12 = 6.46
  //     the top-level lineItems (period totals 1.96 + 4.50 + 9.99 = 16.45) are a trap: counting them per window too would give 6.46 + 16.45 = 22.91
  const fwDay = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const fwSpan = (n) => ({ startTime: fwDay(n) + 'T00:00:00Z', endTime: fwDay(n - 1) + 'T00:00:00Z' });
  const fwServerless = (n, model, p, c) => ({ ...fwSpan(n), promptTokens: p, completionTokens: c, cachedPromptTokens: '0', uncachedPromptTokens: p, audioInputSeconds: 0, usageType: 'TEXT_COMPLETION_INFERENCE_USAGE', group: { model_name: model }, costNanoUsd: 1234567 });
  const fwDedicated = (n, dep, secs) => ({ ...fwSpan(n), deploymentId: dep, acceleratorType: 'NVIDIA_H100_80GB', acceleratorSeconds: secs, baseModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct', usageType: 'DEDICATED_DEPLOYMENT_USAGE', placement: 'PLACEMENT_UNSPECIFIED', group: { deployment_name: 'accounts/acme/deployments/' + dep } });
  const fwMoney = (units, nanos) => ({ currencyCode: 'USD', units: String(units), nanos });   // google.type.Money as proto3 JSON: int64 units is a string, int32 nanos a number
  const fwItem = (series, category, units, nanos) => ({ category, groupingKey: 'model', groupingValue: 'llama-v3p3-70b-instruct', quantity: 1, unitAmount: fwMoney(0, 0), totalCost: fwMoney(units, nanos), series });
  w('wave2/fireworks/billingUsage-serverless.json', JSON.stringify({ serverlessCosts: [
    fwServerless(3, 'accounts/fireworks/models/llama-v3p3-70b-instruct', '12000', '3400'),
    fwServerless(3, 'accounts/fireworks/models/qwen3-235b-a22b', '5000', '900'),
    fwServerless(3, 'accounts/fireworks/models/llama-v3p3-70b-instruct', 'abc', '10'),
    fwServerless(40, 'accounts/fireworks/models/llama-v3p3-70b-instruct', '800', '120'),
    fwServerless(200, 'accounts/fireworks/models/llama-v3p3-70b-instruct', '99999', '99999'),
  ] }, null, 1));
  w('wave2/fireworks/billingUsage-dedicated.json', JSON.stringify({ dedicatedCosts: [
    fwDedicated(3, 'dep-1', '7200'),
    fwDedicated(200, 'dep-1', '99999'),
  ] }, null, 1));
  w('wave2/fireworks/billing-summary.json', JSON.stringify({
    lineItems: [fwItem('SERVERLESS', 'Text Completion', 1, 960000000), fwItem('DEDICATED_DEPLOYMENT', 'Dedicated Deployment', 4, 500000000), fwItem('TRAINING', 'Supervised Fine-Tuning', 9, 990000000)],
    usageBuckets: [
      { ...fwSpan(3), lineItems: [fwItem('SERVERLESS', 'Text Completion', 1, 840000000), fwItem('DEDICATED_DEPLOYMENT', 'Dedicated Deployment', 4, 500000000)] },
      { ...fwSpan(40), lineItems: [fwItem('SERVERLESS', 'Text Completion', 0, 120000000)] },
      { ...fwSpan(200), lineItems: [fwItem('TRAINING', 'Supervised Fine-Tuning', 9, 990000000)] },
    ] }, null, 1));
  // ---- Plan 4b fixtures (wave2/): ZIP reader + DeepSeek API monthly usage export (Task 8) ----
  // T8a — ZIP reader round-trip: one stored entry (9 bytes), one deflate-raw entry (3000 chars), one entry with an unsupported method (12 = bzip2 → bytes() must throw)
  w('wave2/zip/mini.zip', zipBuffer([
    { name: 'hello.txt', data: 'hello zip' },
    { name: 'data/long.txt', data: 'abc'.repeat(1000), deflate: true },
    { name: 'weird.bin', data: 'x', method: 12 },
  ]));
  // T8b — DeepSeek API monthly usage export (platform.deepseek.com/usage → Export monthly data). Long shape as seen by community parsers:
  //   utc_date (YYYYMMDD or YYYY-MM-DD), model, api_key_name, type (input_cache_miss_tokens | input_cache_hit_tokens | output_tokens | request_count), amount.
  //   July: in = 100000 (chat, miss) + 3000 (reasoner, miss) + 500 (chat key2, miss) = 103500 · cr = 50000 + 0 = 50000 · out = 20000 + 8000 + 0 ('abc' rejected) = 28000
  //         msgs = 12 + 2 = 14 (request_count rows only) · buckets (day, model) = 3 [(07-10 chat), (07-11 reasoner), (07-11 chat — key1 + key2 merge)] · amount rows = 10 · rejected = 1 ('abc')
  //   cost-2026-07.csv: 07-10 → 0.05 · 07-11 → 0.02 + 0.001 = 0.021 ('notanumber' rejected → rejected total 2) · currency USD
  w('wave2/deepseek/usage-2026-07.zip', zipBuffer([
    { name: 'amount-2026-07.csv', deflate: true, data: [
      'utc_date,model,api_key_name,type,amount',
      '20260710,deepseek-chat,key1,input_cache_miss_tokens,100000',
      '20260710,deepseek-chat,key1,input_cache_hit_tokens,50000',
      '20260710,deepseek-chat,key1,output_tokens,20000',
      '20260710,deepseek-chat,key1,request_count,12',
      '20260711,deepseek-reasoner,key1,input_cache_miss_tokens,3000',
      '20260711,deepseek-reasoner,key1,input_cache_hit_tokens,0',
      '20260711,deepseek-reasoner,key1,output_tokens,8000',
      '20260711,deepseek-reasoner,key1,request_count,2',
      '20260711,deepseek-chat,key2,output_tokens,abc',
      '20260711,deepseek-chat,key2,input_cache_miss_tokens,500',
    ].join('\n') + '\n' },
    { name: 'cost-2026-07.csv', data: [
      'utc_date,model,api_key_name,currency,cost',
      '2026-07-10,deepseek-chat,key1,USD,0.05',
      '2026-07-11,deepseek-reasoner,key1,USD,0.02',
      '2026-07-11,deepseek-chat,key2,USD,0.001',
      '2026-07-11,deepseek-chat,key2,USD,notanumber',
    ].join('\n') + '\n' },
    { name: 'README.txt', data: 'exported from platform.deepseek.com' },
  ]));
  //   August (second month; dashed dates; stored amount + deflated cost): in 1000 · cr 200 · out 300 · msgs 3 · cost 0.0006
  //   After both imports: in 104500 · cr 50200 · out 28300 · msgs 17 · buckets 4 · billed days 3, sum 0.05 + 0.021 + 0.0006 = 0.0716
  const dsAmountAug = ['utc_date,model,api_key_name,type,amount', '2026-08-10,deepseek-chat,key1,input_cache_miss_tokens,1000', '2026-08-10,deepseek-chat,key1,input_cache_hit_tokens,200',
    '2026-08-10,deepseek-chat,key1,output_tokens,300', '2026-08-10,deepseek-chat,key1,request_count,3'].join('\n') + '\n';
  const dsCostAug = 'utc_date,model,api_key_name,currency,cost\n2026-08-10,deepseek-chat,key1,USD,0.0006\n';
  w('wave2/deepseek/usage-2026-08.zip', zipBuffer([{ name: 'amount-2026-08.csv', data: dsAmountAug }, { name: 'cost-2026-08.csv', data: dsCostAug, deflate: true }]));
  w('wave2/deepseek/amount-2026-08.csv', dsAmountAug);   // the same CSVs dropped loose must merge into the same (day, model) keys — nothing doubles
  w('wave2/deepseek/cost-2026-08.csv', dsCostAug);
  //   September — the newer export layout: start_time_iso / end_time_iso instead of utc_date (the day is the UTC day of start_time_iso; end_time_iso is ignored),
  //   the cost file carries wallet_type + currency. in = 2000 + 300 = 2300 · cr = 500 · out = 700 + 900 = 1600 · msgs = 4 + 1 = 5 · amount rows = 7 · buckets 2 [(09-01 chat), (09-02 reasoner)]
  //   cost-2026-09.csv: 09-01 → 0.0012 · 09-02 → 0.0031 · USD · rejected 0
  w('wave2/deepseek/usage-2026-09.zip', zipBuffer([
    { name: 'amount-2026-09.csv', deflate: true, data: [
      'start_time_iso,end_time_iso,model,api_key_name,type,amount',
      '2026-09-01T00:00:00Z,2026-09-02T00:00:00Z,deepseek-chat,key1,input_cache_miss_tokens,2000',
      '2026-09-01T00:00:00Z,2026-09-02T00:00:00Z,deepseek-chat,key1,input_cache_hit_tokens,500',
      '2026-09-01T00:00:00Z,2026-09-02T00:00:00Z,deepseek-chat,key1,output_tokens,700',
      '2026-09-01T00:00:00Z,2026-09-02T00:00:00Z,deepseek-chat,key1,request_count,4',
      '2026-09-02T00:00:00Z,2026-09-03T00:00:00Z,deepseek-reasoner,key1,input_cache_miss_tokens,300',
      '2026-09-02T00:00:00Z,2026-09-03T00:00:00Z,deepseek-reasoner,key1,output_tokens,900',
      '2026-09-02T00:00:00Z,2026-09-03T00:00:00Z,deepseek-reasoner,key1,request_count,1',
    ].join('\n') + '\n' },
    { name: 'cost-2026-09.csv', data: [
      'start_time_iso,end_time_iso,model,api_key_name,wallet_type,currency,cost',
      '2026-09-01T00:00:00Z,2026-09-02T00:00:00Z,deepseek-chat,key1,topped_up,USD,0.0012',
      '2026-09-02T00:00:00Z,2026-09-03T00:00:00Z,deepseek-reasoner,key1,granted,USD,0.0031',
    ].join('\n') + '\n' },
  ]));
  // T8c — a ChatGPT export ZIP as downloaded (conversations.json + extras). One conversation: user 40 chars → in 10, assistant 80 chars → out 20, model gpt-5.4, 1 reply
  const gptSec = (iso) => T(iso) / 1000;
  w('wave2/zip/chatgpt-export.zip', zipBuffer([
    { name: 'conversations.json', deflate: true, data: JSON.stringify([{ title: 'c', create_time: gptSec('2026-08-10T09:00:00.000Z'), current_node: 'n2', mapping: {
      n1: { id: 'n1', parent: null, children: ['n2'], message: { id: 'm1', author: { role: 'user' }, create_time: gptSec('2026-08-10T09:00:00.000Z'), content: { content_type: 'text', parts: ['x'.repeat(40)] } } },
      n2: { id: 'n2', parent: 'n1', children: [], message: { id: 'm2', author: { role: 'assistant' }, create_time: gptSec('2026-08-10T09:00:05.000Z'), content: { content_type: 'text', parts: ['y'.repeat(80)] }, metadata: { model_slug: 'gpt-5.4' } } } } }]) },
    { name: 'user.json', data: '{"id":"user-1","email":"x@y.z"}' },
    { name: 'chat.html', data: '<html><body>export</body></html>' },
  ]));
  // T9 — Claude Enterprise Analytics: usage_report + cost_report (Anthropic bucket shape). Days RELATIVE: B = 45 days ago (window 2 of 3), C = 10 days ago, A = 2 days ago (both in window 3 → the stub paginates them).
  //   usage: B sonnet in 2000 cr 100 cw 0 out 900 req 20 · C opus in 300 cr 0 cw 0 out 250 req 3 · A sonnet in 1000 cr 400 cw 150+50=200 out 700 req 12
  //   Expected: in = 2000+300+1000 = 3300 · cr = 100+0+400 = 500 · cw = 0+0+200 = 200 · out = 900+250+700 = 1850 · msgs = 20+3+12 = 35 · 3 rows (B/sonnet, C/opus, A/sonnet) · platform 'Claude Enterprise (org)'
  //   cost (CENTS as decimal strings): B '30' → 0.30 · C '15.5' → 0.155 · A '184.50' → 1.845 → total 2.30 (= 230 cents)
  const ceDay = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10) + 'T00:00:00Z';
  const ceBucket = (n, results) => ({ starting_at: ceDay(n), ending_at: ceDay(n - 1), results });
  const ceUse = (model, u, cr, c5, c1, out, req) => ({ model, uncached_input_tokens: u, cache_read_input_tokens: cr, cache_creation: { ephemeral_5m_input_tokens: c5, ephemeral_1h_input_tokens: c1 }, output_tokens: out, requests: req });
  w('wave2/claude-enterprise/usage_report.json', JSON.stringify({ data: [
    ceBucket(45, [ceUse('claude-sonnet-4-5', 2000, 100, 0, 0, 900, 20)]),
    ceBucket(10, [ceUse('claude-opus-4-1', 300, 0, 0, 0, 250, 3)]),
    ceBucket(2, [ceUse('claude-sonnet-4-5', 1000, 400, 150, 50, 700, 12)]),
  ], has_more: false, next_page: null }, null, 1));
  w('wave2/claude-enterprise/cost_report.json', JSON.stringify({ data: [
    ceBucket(45, [{ amount: '30', currency: 'USD', model: 'claude-sonnet-4-5', cost_type: 'tokens', token_type: 'uncached_input_tokens' }]),
    ceBucket(10, [{ amount: '15.5', currency: 'USD', model: 'claude-opus-4-1', cost_type: 'tokens', token_type: 'output_tokens' }]),
    ceBucket(2, [{ amount: '184.50', currency: 'USD', model: 'claude-sonnet-4-5', cost_type: 'tokens', token_type: 'uncached_input_tokens' }]),
  ], has_more: false, next_page: null }, null, 1));
  // ---- Plan 4b wave-2 cloud fixtures (JSON bodies the stubbed fetch returns) ----
  // T10 — Azure Monitor metrics, resource aoai-west. Two metric generations overlap for gpt-4o on 08-11: ProcessedPromptTokens 500 /
  //   GeneratedTokens 100 AND InputTokens 480 / OutputTokens 90 → the newer pair wins for that model-day (no double count).
  //   gpt-4.1-mini 08-11 has a data point WITHOUT `total` (Azure's "no data") → no row. A timeseries without metadata → model 'azure-openai'.
  //   west rows: gpt-4o 08-10 in 1000 out 200 · gpt-4o 08-11 in 480 out 90 · gpt-4.1-mini 08-10 in 300 out 60 · azure-openai 08-12 in 0 out 7
  //   Wire format: Monitor echoes the request timespan; the page asks for <UTC midnight − 90 d>/<sync time> (sync 2026-08-12T09:30Z → start
  //   2026-05-14T00:00Z), so with interval P1D every bucket timeStamp is a calendar UTC day (T00:00:00Z) — a start at the sync time-of-day
  //   would shift every bucket to that hour instead.
  const azTs = (model, data) => ({ metadatavalues: model ? [{ name: { value: 'modelname', localizedValue: 'modelname' }, value: model }] : [], data });
  const azMetric = (name, timeseries, acct = 'aoai-west') => ({ id: '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/' + acct + '/providers/Microsoft.Insights/metrics/' + name, type: 'Microsoft.Insights/metrics', name: { value: name, localizedValue: name }, displayDescription: '', unit: 'Count', timeseries, errorCode: 'Success' });
  w('wave2/azure/metrics.json', JSON.stringify({ cost: 0, timespan: '2026-05-14T00:00:00Z/2026-08-12T09:30:00Z', interval: 'P1D', value: [
    azMetric('ProcessedPromptTokens', [
      azTs('gpt-4o', [{ timeStamp: '2026-08-10T00:00:00Z', total: 1000 }, { timeStamp: '2026-08-11T00:00:00Z', total: 500 }]),
      azTs('gpt-4.1-mini', [{ timeStamp: '2026-08-10T00:00:00Z', total: 300 }, { timeStamp: '2026-08-11T00:00:00Z' }]) ]),
    azMetric('GeneratedTokens', [
      azTs('gpt-4o', [{ timeStamp: '2026-08-10T00:00:00Z', total: 200 }, { timeStamp: '2026-08-11T00:00:00Z', total: 100 }]),
      azTs('gpt-4.1-mini', [{ timeStamp: '2026-08-10T00:00:00Z', total: 60 }]) ]),
    azMetric('InputTokens', [ azTs('gpt-4o', [{ timeStamp: '2026-08-10T00:00:00Z' }, { timeStamp: '2026-08-11T00:00:00Z', total: 480 }]) ]),
    azMetric('OutputTokens', [ azTs('gpt-4o', [{ timeStamp: '2026-08-11T00:00:00Z', total: 90 }]), azTs(null, [{ timeStamp: '2026-08-12T00:00:00Z', total: 7 }]) ]),
  ], namespace: 'Microsoft.CognitiveServices/accounts', resourceregion: 'westus' }, null, 1));
  // T10 — a SECOND resource, aoai-east, on an older deployment: legacy ProcessedPromptTokens/GeneratedTokens, plus ONE InputTokens point
  //   (08-10: 150) that overrides its OWN legacy 999 for that day (per-resource dedupe). Its gpt-4o days overlap aoai-west's, so the
  //   old/new dedupe must be keyed by (resource, day, model): keyed by (day, model) alone, west's InputTokens 480 on 08-11 would drop
  //   east's legacy 250/40, and east's InputTokens 150 on 08-10 would drop west's legacy 1000.
  //   east rows: gpt-4o 08-10 in 150 (newer wins over legacy 999) out 0 · gpt-4o 08-11 in 250 out 40
  //   Expected with both resources: gpt-4o 08-10 in 1000+150 = 1150 out 200+0 = 200 · gpt-4o 08-11 in 480+250 = 730 out 90+40 = 130 ·
  //   gpt-4.1-mini 08-10 300/60 · azure-openai 08-12 0/7 → in = 1150+730+300+0 = 2180 · out = 200+130+60+7 = 397 · 4 rows · 3 models · days 08-10/11/12
  w('wave2/azure/metrics-east.json', JSON.stringify({ cost: 0, timespan: '2026-05-14T00:00:00Z/2026-08-12T09:30:00Z', interval: 'P1D', value: [
    azMetric('ProcessedPromptTokens', [ azTs('gpt-4o', [{ timeStamp: '2026-08-10T00:00:00Z', total: 999 }, { timeStamp: '2026-08-11T00:00:00Z', total: 250 }]) ], 'aoai-east'),
    azMetric('GeneratedTokens', [ azTs('gpt-4o', [{ timeStamp: '2026-08-10T00:00:00Z' }, { timeStamp: '2026-08-11T00:00:00Z', total: 40 }]) ], 'aoai-east'),
    azMetric('InputTokens', [ azTs('gpt-4o', [{ timeStamp: '2026-08-10T00:00:00Z', total: 150 }]) ], 'aoai-east'),
    azMetric('OutputTokens', [], 'aoai-east'),
  ], namespace: 'Microsoft.CognitiveServices/accounts', resourceregion: 'eastus' }, null, 1));
  // T10 — Cost Management query result (Daily, no grouping): UsageDate is a yyyymmdd NUMBER. Expected billed: 08-10 = 12.34 · 08-11 = 0.5 + 1.16 = 1.66
  w('wave2/azure/cost.json', JSON.stringify({ id: '/subscriptions/s1/providers/Microsoft.CostManagement/query/abc', name: 'abc', type: 'Microsoft.CostManagement/query',
    properties: { nextLink: null, columns: [{ name: 'PreTaxCost', type: 'Number' }, { name: 'UsageDate', type: 'Number' }, { name: 'Currency', type: 'String' }],
      rows: [[12.34, 20260810, 'USD'], [0.5, 20260811, 'USD'], [1.16, 20260811, 'USD']] } }, null, 1));
  // T11 — Cloud Monitoring timeSeries.list, TWO pages (page 1 carries nextPageToken 'p2'). Points are 24-h aligned windows; the fetcher
  //   attributes each to the UTC date of (endTime − 1 s): endTime 2026-08-11T12:00Z → 08-11, 2026-08-10T12:00Z → 08-10.
  //   page 1: gemini-2.5-pro input 5000 (08-11) + 3000 (08-10); output 700 (08-11) + 400 (08-10)
  //   page 2: gemini-2.5-flash input 1200 (08-11), output 150 (08-11); a series WITHOUT model_user_id → model 'vertex-ai', input 10 (08-10);
  //           a point with an empty value {} → ignored
  //   Expected: in = 5000+3000+1200+10 = 9210 · out = 700+400+150 = 1250 · 4 rows (pro 08-10, pro 08-11, flash 08-11, vertex-ai 08-10) · 3 models
  const vxPt = (start, end, v) => ({ interval: { startTime: start, endTime: end }, value: { int64Value: String(v) } });
  const vxSeries = (type, model, points) => ({ metric: { labels: { type, request_type: 'shared' }, type: 'aiplatform.googleapis.com/publisher/online_serving/token_count' },
    resource: { type: 'aiplatform.googleapis.com/PublisherModel', labels: model ? { model_user_id: model, project_id: 'proj-a', location: 'us-central1' } : { project_id: 'proj-a', location: 'us-central1' } },
    metricKind: 'DELTA', valueType: 'INT64', points });
  w('wave2/vertex/timeseries-1.json', JSON.stringify({ timeSeries: [
    vxSeries('input', 'gemini-2.5-pro', [vxPt('2026-08-10T12:00:00Z', '2026-08-11T12:00:00Z', 5000), vxPt('2026-08-09T12:00:00Z', '2026-08-10T12:00:00Z', 3000)]),
    vxSeries('output', 'gemini-2.5-pro', [vxPt('2026-08-10T12:00:00Z', '2026-08-11T12:00:00Z', 700), vxPt('2026-08-09T12:00:00Z', '2026-08-10T12:00:00Z', 400)]),
  ], nextPageToken: 'p2', unit: '1' }, null, 1));
  w('wave2/vertex/timeseries-2.json', JSON.stringify({ timeSeries: [
    vxSeries('input', 'gemini-2.5-flash', [vxPt('2026-08-10T12:00:00Z', '2026-08-11T12:00:00Z', 1200)]),
    vxSeries('output', 'gemini-2.5-flash', [vxPt('2026-08-10T12:00:00Z', '2026-08-11T12:00:00Z', 150)]),
    vxSeries('input', null, [vxPt('2026-08-09T12:00:00Z', '2026-08-10T12:00:00Z', 10)]),
    vxSeries('input', 'gemini-2.5-pro', [{ interval: { startTime: '2026-08-11T12:00:00Z', endTime: '2026-08-12T12:00:00Z' }, value: {} }]),
  ], unit: '1' }, null, 1));
  // T11 — BigQuery jobs.query response for the billing-export query. Expected billed: 08-10 = 1.23 · 08-11 = 2.5
  w('wave2/vertex/bigquery.json', JSON.stringify({ kind: 'bigquery#queryResponse', schema: { fields: [{ name: 'd', type: 'DATE', mode: 'NULLABLE' }, { name: 'c', type: 'FLOAT', mode: 'NULLABLE' }] },
    jobReference: { projectId: 'proj-a', jobId: 'job_x', location: 'US' }, totalRows: '2', rows: [{ f: [{ v: '2026-08-10' }, { v: '1.23' }] }, { f: [{ v: '2026-08-11' }, { v: '2.5' }] }],
    totalBytesProcessed: '1024', jobComplete: true, cacheHit: false }, null, 1));
  // T12 — CloudWatch ListMetrics, TWO pages (page 1 carries NextToken 'n2'): claude twice (dedupe), a 2-dimension metric (ModelId+ImageSize →
  //   skipped: GetMetricData would not match it with ModelId alone), nova on page 2. Expected models: ['anthropic.claude-sonnet-4-5', 'amazon.nova-pro-v1:0']
  w('wave2/bedrock/list-metrics-1.json', JSON.stringify({ Metrics: [
    { Namespace: 'AWS/Bedrock', MetricName: 'InputTokenCount', Dimensions: [{ Name: 'ModelId', Value: 'anthropic.claude-sonnet-4-5' }] },
    { Namespace: 'AWS/Bedrock', MetricName: 'InputTokenCount', Dimensions: [{ Name: 'ModelId', Value: 'anthropic.claude-sonnet-4-5' }] },
    { Namespace: 'AWS/Bedrock', MetricName: 'InputTokenCount', Dimensions: [{ Name: 'ModelId', Value: 'stability.sd3-5-large-v1:0' }, { Name: 'ImageSize', Value: '1024x1024' }] } ], NextToken: 'n2' }, null, 1));
  w('wave2/bedrock/list-metrics-2.json', JSON.stringify({ Metrics: [
    { Namespace: 'AWS/Bedrock', MetricName: 'InputTokenCount', Dimensions: [{ Name: 'ModelId', Value: 'amazon.nova-pro-v1:0' }] } ] }, null, 1));
  // T12 — GetMetricData: Ids in<i>/out<i> index the models array (claude = 0, nova = 1); a stray Id is ignored.
  //   Wire format: on the JSON 1.0 protocol CloudWatch returns Timestamps as epoch SECONDS (integers or doubles), not ISO strings —
  //   2026-08-10T00:00:00Z = Date.UTC(2026, 7, 10) / 1000 = 1786320000 s · 2026-08-11 = 1786320000 + 86400 = 1786406400 s.
  //   Read as milliseconds those are 1970-01-21T16:12:00Z / 16:13:26Z — the bug this fixture guards. out1 keeps an ISO string so both encodings are proven to parse.
  //   Expected rows: claude 08-10 in 12000 out 1500 · claude 08-11 in 8000 out 900 · nova 08-11 in 400 out 50 → in = 20400 · out = 2450 · 3 rows
  w('wave2/bedrock/get-metric-data.json', JSON.stringify({ MetricDataResults: [
    { Id: 'in0', Label: 'InputTokenCount', Timestamps: [1786320000, 1786406400], Values: [12000, 8000], StatusCode: 'Complete' },
    { Id: 'out0', Label: 'OutputTokenCount', Timestamps: [1786320000, 1786406400], Values: [1500, 900], StatusCode: 'Complete' },
    { Id: 'in1', Label: 'InputTokenCount', Timestamps: [1786406400], Values: [400], StatusCode: 'Complete' },
    { Id: 'out1', Label: 'OutputTokenCount', Timestamps: ['2026-08-11T00:00:00Z'], Values: [50], StatusCode: 'Complete' },
    { Id: 'x9', Label: 'stray', Timestamps: [1786406400], Values: [99999], StatusCode: 'Complete' } ], Messages: [] }, null, 1));
  // T12 — Cost Explorer GetCostAndUsage (DAILY): every day in range comes back, zero days included. Expected billed: 08-10 1.23 · 08-11 0.77 · 08-12 0 (3 rows, sum 2.00)
  w('wave2/bedrock/cost.json', JSON.stringify({ ResultsByTime: [
    { TimePeriod: { Start: '2026-08-10', End: '2026-08-11' }, Total: { UnblendedCost: { Amount: '1.23', Unit: 'USD' } }, Groups: [], Estimated: false },
    { TimePeriod: { Start: '2026-08-11', End: '2026-08-12' }, Total: { UnblendedCost: { Amount: '0.77', Unit: 'USD' } }, Groups: [], Estimated: false },
    { TimePeriod: { Start: '2026-08-12', End: '2026-08-13' }, Total: { UnblendedCost: { Amount: '0', Unit: 'USD' } }, Groups: [], Estimated: true } ], DimensionValueAttributes: [] }, null, 1));
  // T13a — Grok export (grok.com → Settings → Data → Export Data). estTok = round(chars/4); input = preceding human message.
  //   t1: human 40 → assistant 80 (in 10, out 20, $numberLong ms) · human 20 → assistant 8 (in 5, out 2, ISO) ·
  //   t2: human 'abcd' → 'ok!!!' (in 1, out 1; no create_time → conversation create_time) · 'broken' 6 chars (out 2, in 1; create_time 'not a date' → conversation time) ·
  //   t3: assistant with no date anywhere → skipped.   Expected: in=17 out=25 msgs=4 convs=3 skipped=1 · platform Grok · model grok · est
  const ms = (iso) => ({ $date: { $numberLong: String(T(iso)) } });
  w('wave2/grok/grok-export.json', JSON.stringify({ conversations: [
    { conversation: { title: 't1', create_time: ms('2026-08-10T09:00:00.000Z') }, responses: [
      { message: 'x'.repeat(40), sender: 'human', create_time: ms('2026-08-10T09:00:00.000Z') },
      { message: 'y'.repeat(80), sender: 'assistant', create_time: ms('2026-08-10T09:00:05.000Z') },
      { message: 'z'.repeat(20), sender: 'human', create_time: '2026-08-10T21:30:00.000Z' },
      { message: 'w'.repeat(8), sender: 'assistant', create_time: '2026-08-10T21:30:05.000Z' } ] },
    { conversation: { title: 't2', create_time: '2026-08-11T08:00:00.000Z' }, responses: [
      { message: 'abcd', sender: 'human' }, { message: 'ok!!!', sender: 'assistant' }, { message: 'broken', sender: 'assistant', create_time: 'not a date' } ] },
    { conversation: { title: 't3' }, responses: [{ message: 'no date anywhere', sender: 'assistant' }] },
  ] }, null, 1));
  // T13b — DeepSeek chat export (chat.deepseek.com → Settings → Data → Export data). Tolerant shape: array of conversations with messages[{role, content, inserted_at|created_at, model?}].
  //   c1: user 40 → assistant 80 (in 10, out 20, model deepseek-reasoner) · user 20 → assistant 8 (in 5, out 2; epoch SECONDS; no model → deepseek-chat) ·
  //   c2: user content[] 'abcd' → 'ok!!!' (in 1, out 1) · assistant with created_at null and no conversation time → skipped.
  //   c3: create_time (epoch seconds) on the conversation and the user message, model on the conversation only: user 12 → assistant 16 with no time and no model of its own
  //       (in 3, out 4; the row lands on the conversation's create_time as the conversation's model deepseek-reasoner).
  //   Expected: in=19 out=27 msgs=4 convs=3 skipped=1 · platform 'DeepSeek chat' · models deepseek-chat + deepseek-reasoner · est
  w('wave2/deepseek/deepseek-conversations.json', JSON.stringify([
    { id: 'c1', title: 'hello', inserted_at: '2026-08-10T09:00:00.000Z', messages: [
      { role: 'user', content: 'x'.repeat(40), inserted_at: '2026-08-10T09:00:00.000Z' },
      { role: 'assistant', content: 'y'.repeat(80), inserted_at: '2026-08-10T09:00:05.000Z', model: 'deepseek-reasoner' },
      { role: 'user', content: 'z'.repeat(20), inserted_at: T('2026-08-10T21:30:00.000Z') / 1000 },
      { role: 'assistant', content: 'w'.repeat(8), inserted_at: T('2026-08-10T21:30:05.000Z') / 1000 } ] },
    { id: 'c2', title: 'two', messages: [
      { role: 'user', content: [{ type: 'text', text: 'abcd' }], created_at: '2026-08-11T08:00:00.000Z' },
      { role: 'assistant', content: 'ok!!!', created_at: '2026-08-11T08:00:03.000Z' },
      { role: 'assistant', content: 'no time', created_at: null } ] },
    { id: 'c3', title: 'three', create_time: T('2026-08-12T10:00:00.000Z') / 1000, model: 'deepseek-reasoner', messages: [
      { role: 'user', content: 'p'.repeat(12), create_time: T('2026-08-12T10:00:00.000Z') / 1000 },
      { role: 'assistant', content: 'q'.repeat(16) } ] },
  ], null, 1));
  // T13c — Meta AI thread (Download your information, JSON → message_1.json; Facebook DYI shape, newest first).
  //   sorted ascending: 08-09 'Here is the image' 17 chars (out 4, no preceding user → in 0) · user 40 → Meta AI 80 (in 10, out 20) · user 20 → Meta AI 8 (in 5, out 2) · one undated Meta AI message → skipped.
  //   Expected: in=15 out=26 msgs=3 skipped=1 · platform 'Meta AI' · model meta-ai · sid = thread_path
  w('wave2/meta-ai/message_1.json', JSON.stringify({ participants: [{ name: 'Alaa' }, { name: 'Meta AI' }], title: 'Meta AI', thread_path: 'inbox/metaai_123', messages: [
    { sender_name: 'Meta AI', content: 'undated' },
    { sender_name: 'Meta AI', timestamp_ms: T('2026-08-10T21:30:05.000Z'), content: 'w'.repeat(8) },
    { sender_name: 'Alaa', timestamp_ms: T('2026-08-10T21:30:00.000Z'), content: 'z'.repeat(20) },
    { sender_name: 'Meta AI', timestamp_ms: T('2026-08-10T09:00:05.000Z'), content: 'y'.repeat(80) },
    { sender_name: 'Alaa', timestamp_ms: T('2026-08-10T09:00:00.000Z'), content: 'x'.repeat(40) },
    { sender_name: 'Meta AI', timestamp_ms: T('2026-08-09T08:00:00.000Z'), content: 'Here is the image' },
  ] }, null, 1));
  // T13d — Perplexity data export (array of threads; tolerant field names). q1: 40 → 80 (in 10, out 20, ISO) · 20 → 8 (in 5, out 2, epoch ms) · 'abcd' → 'ok!!!' (in 1, out 1, date-only) · undated → skipped.
  //   Expected: in=16 out=23 msgs=3 threads=4 skipped=1 · platform Perplexity · model perplexity. Also shipped inside a ZIP (the way the export arrives) next to an unrelated account.json.
  const pxThreads = JSON.stringify([
    { title: 'q1', query_str: 'x'.repeat(40), answer: 'y'.repeat(80), created_at: '2026-08-10T09:00:00.000Z' },
    { query: 'z'.repeat(20), response: 'w'.repeat(8), timestamp: T('2026-08-10T21:30:00.000Z') },
    { question: 'abcd', text: 'ok!!!', date: '2026-08-11' },
    { query: 'undated', answer: 'nope' },
  ], null, 1);
  w('wave2/perplexity/threads.json', pxThreads);
  w('wave2/perplexity/perplexity-export.zip', zipBuffer([{ name: 'threads.json', data: pxThreads, deflate: true }, { name: 'account.json', data: '{"email":"x@y.z"}' }]));
  // T13e — Microsoft Copilot activity CSV (account.microsoft.com/privacy → Copilot → Export all activity history; columns undocumented → tolerant).
  //   row1 ISO: 40 → 80 (in 10, out 20) · row2 'M/D/YYYY H:MM PM' local: 20 → 8 (in 5, out 2, hour 21) · row3 ISO: 'abcd' → 'ok!!!' (in 1, out 1) · row4 unparseable date → skipped.
  //   Expected: in=16 out=23 msgs=3 skipped=1 · platform 'Microsoft Copilot' · model copilot · apps [Copilot app, Copilot in Edge]
  w('wave2/mscopilot/copilot-activity.csv', [
    'Date,App,Prompt,Response',
    '2026-08-10T09:00:00Z,Copilot app,' + 'x'.repeat(40) + ',' + 'y'.repeat(80),
    '8/10/2026 9:30 PM,Copilot in Edge,' + 'z'.repeat(20) + ',' + 'w'.repeat(8),
    '2026-08-11T08:00:00Z,Copilot app,abcd,ok!!!',
    'not a date,Copilot app,undated,skip me',
  ].join('\n') + '\n');
  // Plan 9 B3 — Cerebras Cloud Console → Analytics → Usage → "Download Report" CSV. Column names are NOT documented (research 2026-10-15: "sniff headers on
  //   import"), so this fixture is a plausible shape, not a real export: Date (UTC, per the console), Model, API Key, Requests, Input Tokens, Output Tokens, Total Tokens.
  //   The file name carries "cerebras" (the importer's name gate). Two rows on the same UTC day merge; 'abc' input is rejected (row kept: in 0); the undated row is skipped.
  //   Expected: buckets (10-05 llama in 12000 out 3000 msgs 15) · (10-06 qwen in 4000 out 1200 msgs 5) · (10-06 llama in 0 out 100 msgs 1) → in 16000 out 4300 msgs 21 · rows landed 4 · rejected 2
  w('wave2/cerebras/cerebras-usage-report.csv', [
    'Date,Model,API Key,Requests,Input Tokens,Output Tokens,Total Tokens',
    '2026-10-05T00:00:00Z,llama-3.3-70b,key-a,12,10000,2500,12500',
    '2026-10-05T13:00:00Z,llama-3.3-70b,key-a,3,2000,500,2500',
    '2026-10-06T00:00:00Z,qwen-3-235b-a22b-instruct-2507,key-a,5,4000,1200,5200',
    '2026-10-06T00:00:00Z,llama-3.3-70b,key-b,1,abc,100,100',
    'not a date,llama-3.3-70b,key-a,1,5,5,10',
  ].join('\n') + '\n');
  // T14 (4b) — Ollama desktop-app db.sqlite (schema subset of ollama/app/store/schema.sql). Needs node:sqlite; when it is unavailable nothing is
  //   written and 87b's ollama-db block reports itself skipped. One chat, 2 user + 2 assistant messages. m2's record is 6000 + 400 chars → it
  //   exceeds one 4096-byte page → overflow page. created_at shapes: ISO 'Z' text (m1/m2), SQLite 'YYYY-MM-DD HH:MM:SS' (m3, UTC), unix-seconds
  //   text (m4 = 1786396260 = 2026-08-10T21:11:00Z). kv is WITHOUT ROWID → readSqliteTable must refuse it.
  //   Expected (estTok = round(chars/4)): m2 in=estTok(40)=10 out=estTok(6000+400)=1600 model gemma3:4b · m4 in=estTok(24)=6 out=estTok(100)=25 model 'ollama'
  //   (model_name NULL) → in=16 out=1625 msgs=2, both est:1, platform Ollama, $0.
  let sqlite = null;
  // ---- Plan 9 B1 — Claude Desktop Cowork tree (cowork/local-agent-mode-sessions/<org>/<user>/local_<uuid>/…), shaped after the real folder
  //   (2026-10-27, this machine): transcripts under <sessionDir>/.claude/projects/<slug>/<sid>.jsonl (+ <sid>/subagents/agent-*.jsonl; every line
  //   carries entrypoint 'local-agent' and sessionId), Anthropic's audit at <sessionDir>/audit.jsonl: assistant mirror lines with request_id
  //   (NOT rows — the transcript already has them; ids cw-m*/cw-r* are distinct from the Claude Code fixture's m*/r*) and result lines (one per turn: uuid, session_id, total_cost_usd, timestamp, modelUsage).
  //   Session A: rows in=3300 out=1600 cr=500 cw=100 msgs=3 (m1 streamed twice → one; the subagent row joins the parent session); audit results
  //   0.05 (09-01) + 0.07 (09-02), res-2 written twice (dedupe by uuid), one garbage line, one result without a numeric total_cost_usd;
  //   outputs/notes.jsonl is a file the task wrote (99999 tokens — must be excluded). Session B: in=400 out=200 msgs=1 and NO audit (missing).
  //   Totals: in=3700 out=1800 cr=500 cw=100 msgs=4 · reported: A usd=0.12 days {09-01: 0.05, 09-02: 0.07} · missing 1 · 2 results, 1 repeat, 1 bad.
  const CW = 'cowork/local-agent-mode-sessions/0f0f0f0f-0000-4000-8000-000000000001/0f0f0f0f-0000-4000-8000-000000000002/';
  const SID_A = 'aaaa0001-0000-4000-8000-00000000000a', SID_B = 'bbbb0002-0000-4000-8000-00000000000b';
  const cwLine = (sid, o) => jl({ parentUuid: null, isSidechain: false, userType: 'external', entrypoint: 'local-agent', cwd: 'C:\\Users\\me\\cowork', sessionId: sid, version: '2.1.0', ...o });
  const cwUse = (sid, id, req, ts, model, usage) => cwLine(sid, { type: 'assistant', uuid: 'u-' + id + '-' + req, timestamp: ts, requestId: req, message: { id, type: 'message', role: 'assistant', model, content: [], usage } });
  const A = CW + 'local_aaaa0001-0000-4000-8000-000000000001/';
  w(A + '.claude/projects/C--Users-me-cowork-A/' + SID_A + '.jsonl', [
    cwLine(SID_A, { type: 'user', uuid: 'u-1', timestamp: '2026-09-01T09:59:00.000Z', message: { role: 'user', content: 'hello' } }),
    cwUse(SID_A, 'cw-m1', 'cw-r1', '2026-09-01T10:00:00.000Z', 'claude-sonnet-5', { input_tokens: 1000, output_tokens: 500 }),
    cwUse(SID_A, 'cw-m1', 'cw-r1', '2026-09-01T10:00:02.000Z', 'claude-sonnet-5', { input_tokens: 1000, output_tokens: 500 }),   // second content block of the same message → one row
    cwUse(SID_A, 'cw-m2', 'cw-r2', '2026-09-02T10:00:00.000Z', 'claude-sonnet-5', { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 }),
  ].join('\n') + '\n');
  w(A + '.claude/projects/C--Users-me-cowork-A/' + SID_A + '/subagents/agent-a0001.jsonl', cwUse(SID_A, 'cw-m3', 'cw-r3', '2026-09-02T11:00:00.000Z', 'claude-fable-5', { input_tokens: 300, output_tokens: 100 }) + '\n');
  const auditLine = (o) => jl({ ...o, _audit_timestamp: o.timestamp, _audit_hmac: 'fixture' });
  const result = (uuid, usd, ts) => auditLine({ type: 'result', subtype: 'success', uuid, session_id: SID_A, total_cost_usd: usd, timestamp: ts, num_turns: 1, duration_ms: 1000, is_error: false,
    usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { 'claude-sonnet-5': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: usd } } });
  w(A + 'audit.jsonl', [
    auditLine({ type: 'user', uuid: 'au-1', session_id: SID_A, timestamp: '2026-09-01T09:59:00.000Z', message: { role: 'user', content: 'hello' } }),
    auditLine({ type: 'assistant', uuid: 'aa-1', session_id: SID_A, request_id: 'cw-r1', timestamp: '2026-09-01T10:00:00.000Z', message: { id: 'cw-m1', model: 'claude-sonnet-5', role: 'assistant', content: [], usage: { input_tokens: 1000, output_tokens: 500 } } }),
    result('res-1', 0.05, '2026-09-01T10:01:00.000Z'),
    result('res-2', 0.07, '2026-09-02T10:02:00.000Z'),
    result('res-2', 0.07, '2026-09-02T10:02:00.000Z'),   // the same result written twice → counted once
    'this line is not JSON',
    result('res-3', 'n/a', '2026-09-02T10:03:00.000Z'),   // no numeric total_cost_usd → a bad result (surfaced), never $0
  ].join('\n') + '\n');
  w(A + 'outputs/notes.jsonl', cwUse(SID_A, 'cw-m9', 'cw-r9', '2026-09-02T12:00:00.000Z', 'claude-sonnet-5', { input_tokens: 99999, output_tokens: 99999 }) + '\n');   // written by the task, not a transcript
  w(A + '.claude/.credentials.json', '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-SECRET-FIXTURE"}}\n');   // the collector must never list it
  const B = CW + 'local_bbbb0002-0000-4000-8000-000000000002/';
  w(B + '.claude/projects/C--Users-me-cowork-B/' + SID_B + '.jsonl', cwUse(SID_B, 'cw-m4', 'cw-r4', '2026-09-03T09:00:00.000Z', 'claude-sonnet-5', { input_tokens: 400, output_tokens: 200 }) + '\n');

  const origEmit = process.emitWarning;   // some Node versions print an ExperimentalWarning when node:sqlite loads — keep the suite output clean
  process.emitWarning = (w, ...a) => { if (/SQLite/i.test(String((w && w.message) || w))) return; return origEmit.call(process, w, ...a); };
  try { sqlite = await import('node:sqlite'); } catch { sqlite = null; }
  process.emitWarning = origEmit;
  if (sqlite && sqlite.DatabaseSync) {
    const dbPath = path.join(OUT, 'wave2', 'ollama-app', 'db.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode=DELETE');   // no -wal sidecar: every row lands in db.sqlite (what the parser reads)
    db.exec('CREATE TABLE chats(id TEXT PRIMARY KEY, title TEXT, created_at TEXT)');
    db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY, chat_id TEXT, role TEXT, content TEXT, thinking TEXT, model_name TEXT, model_cloud INTEGER, created_at TEXT, updated_at TEXT)');
    db.exec('CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID');
    db.prepare('INSERT INTO chats VALUES (?,?,?)').run('c1', 'test chat', '2026-08-10T09:00:00Z');
    const ins = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)');
    ins.run('m1', 'c1', 'user', 'u'.repeat(40), null, null, 0, '2026-08-10T09:00:00Z', '2026-08-10T09:00:00Z');
    ins.run('m2', 'c1', 'assistant', 'a'.repeat(6000), 't'.repeat(400), 'gemma3:4b', 0, '2026-08-10T09:00:30Z', '2026-08-10T09:00:30Z');
    ins.run('m3', 'c1', 'user', 'u'.repeat(24), null, null, 0, '2026-08-10 21:10:00', '2026-08-10 21:10:00');
    ins.run('m4', 'c1', 'assistant', 'b'.repeat(100), null, null, 0, '1786396260', '1786396260');
    db.prepare('INSERT INTO kv VALUES (?,?)').run('schema', '1');
    db.close();
  }
}

if (process.argv[1] === import.meta.filename) await generate();
