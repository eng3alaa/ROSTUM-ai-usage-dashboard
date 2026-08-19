import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, 'out');

const jl = (o) => JSON.stringify(o);

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
}

if (process.argv[1] === import.meta.filename) await generate();
