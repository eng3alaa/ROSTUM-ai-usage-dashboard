// Node-level test for docs/tools/ollama-usage-logger.mjs — no browser. The suite runs it from tests/checks/89b-usage-logger.mjs;
// alone:  node tests/tools/usage-logger.test.mjs
// A fake upstream (stands in for Ollama) answers three POSTs; the logger runs as a child process proxying to it; the JSONL it
// appends under tests/fixtures/out/ (gitignored) must hold one line per request with the EXACT counts the upstream sent:
//   /api/chat            — 12 MB of streamed NDJSON filler lines, then the done:true object (prompt_eval_count 123 / eval_count 456)
//   /v1/chat/completions — ~100 KB of SSE chunks, then the usage chunk (77 / 11), then data: [DONE]
//   /api/generate        — one non-streamed ~200 KB JSON document with the counts near its end (31 / 9)
//   /v1/completions      — 20 000 SSE chunks of ~110 B (≈ 2 MB) written one by one, then the usage chunk (5 / 3): logged, and the request finishes in < 5 s
// Windows-safe: 127.0.0.1 only, a probed free port for the proxy, connect-polling for readiness, every wait ≤ 10 s, the child is
// always killed in finally.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(import.meta.dirname, '..', '..');
const LOGGER = path.join(ROOT, 'docs', 'tools', 'ollama-usage-logger.mjs');
const OUT_DIR = path.join(ROOT, 'tests', 'fixtures', 'out');
const MODEL = 'llama4:8b';
const CHAT = { in: 123, out: 456 }, V1 = { in: 77, out: 11 }, GEN = { in: 31, out: 9 }, SMALL = { in: 5, out: 3 };
const PATHS = ['/api/chat', '/v1/chat/completions', '/api/generate', '/v1/completions'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// res.write with backpressure — a 12 MB body must not pile up in the fake upstream's socket buffer
const writeAll = async (res, buf, times) => {
  for (let i = 0; i < times && !res.destroyed; i++) {
    if (res.write(buf)) continue;
    await new Promise((r) => { const done = () => { res.off('drain', done); res.off('close', done); r(); }; res.once('drain', done); res.once('close', done); });   // both removed — no listener pile-up over ~190 blocks
  }
};

// --- fake upstream bodies ------------------------------------------------------------------------------------------------
const chatLine = JSON.stringify({ model: MODEL, created_at: '2026-09-10T00:00:00Z', message: { role: 'assistant', content: 'x'.repeat(1000) }, done: false }) + '\n';
const CHAT_BLOCK = Buffer.from(chatLine.repeat(Math.ceil(64 * 1024 / chatLine.length)));            // ~64 KB of complete lines
const CHAT_BLOCKS = Math.ceil(12 * 1024 * 1024 / CHAT_BLOCK.length);                                  // → ≥ 12 MB
const CHAT_FINAL = Buffer.from(JSON.stringify({ model: MODEL, created_at: '2026-09-10T00:00:01Z', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', total_duration: 1, prompt_eval_count: CHAT.in, eval_count: CHAT.out }) + '\n');
const sseLine = 'data: ' + JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: { content: 'hello ' }, finish_reason: null }], usage: null }) + '\n\n';
const SSE_BLOCK = Buffer.from(sseLine.repeat(Math.ceil(100 * 1024 / sseLine.length)));               // ~100 KB — more than the 64 KB window
const SSE_FINAL = Buffer.from('data: ' + JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: MODEL, choices: [], usage: { prompt_tokens: V1.in, completion_tokens: V1.out, total_tokens: V1.in + V1.out } }) + '\n\ndata: [DONE]\n\n');
const GEN_DOC = Buffer.from(JSON.stringify({ model: MODEL, created_at: '2026-09-10T00:00:02Z', response: 'y'.repeat(199 * 1024), done: true, done_reason: 'stop', context: Array.from({ length: 300 }, (_, i) => i + 1), total_duration: 5, load_duration: 1, prompt_eval_count: GEN.in, prompt_eval_duration: 2, eval_count: GEN.out, eval_duration: 2 }));
// 20 000 SSE chunks of ~110 B (≈ 2 MB) written ONE BY ONE (each res.write is its own HTTP chunk → its own 'data' event in the proxy), then the
// usage chunk: the proxy's Capture takes ~20 000 small pushes — a per-push Buffer.concat of the 64 KB tail (O(n × 64 KB)) is what review item m1 removed
const SMALL_CHUNK = Buffer.from('data: ' + JSON.stringify({ id: 'cmpl-1', object: 'text_completion', model: MODEL, choices: [{ text: 'hi', index: 0, finish_reason: null }] }) + '\n\n');
const SMALL_CHUNKS = 20000;
const SMALL_FINAL = Buffer.from('data: ' + JSON.stringify({ id: 'cmpl-1', object: 'text_completion', model: MODEL, choices: [], usage: { prompt_tokens: SMALL.in, completion_tokens: SMALL.out, total_tokens: SMALL.in + SMALL.out } }) + '\n\ndata: [DONE]\n\n');
const EXPECT_BYTES = { '/api/chat': CHAT_BLOCK.length * CHAT_BLOCKS + CHAT_FINAL.length, '/v1/chat/completions': SSE_BLOCK.length + SSE_FINAL.length, '/api/generate': GEN_DOC.length, '/v1/completions': SMALL_CHUNK.length * SMALL_CHUNKS + SMALL_FINAL.length };

let upstreamHits = 0;   // A0 #21: a request the proxy refused (421) must never reach the upstream
function fakeUpstream() {
  return http.createServer((req, res) => {
    upstreamHits++;
    req.resume();
    req.on('end', async () => {
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      if (req.url === '/api/chat') { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); await writeAll(res, CHAT_BLOCK, CHAT_BLOCKS); res.end(CHAT_FINAL); }
      else if (req.url === '/v1/chat/completions') { res.writeHead(200, { 'content-type': 'text/event-stream' }); await writeAll(res, SSE_BLOCK, 1); res.end(SSE_FINAL); }
      else if (req.url === '/api/generate') { res.writeHead(200, { 'content-type': 'application/json', 'content-length': GEN_DOC.length }); res.end(GEN_DOC); }
      else if (req.url === '/v1/completions') { res.writeHead(200, { 'content-type': 'text/event-stream' }); await writeAll(res, SMALL_CHUNK, SMALL_CHUNKS); res.end(SMALL_FINAL); }
      else { res.writeHead(404); res.end(); }
    });
  });
}

// --- client through the proxy ----------------------------------------------------------------------------------------------
const post = (port, pathname, extraHeaders = {}) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true });
  const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...extraHeaders } }, (res) => {
    let bytes = 0;
    res.on('data', (c) => { bytes += c.length; });
    res.on('end', () => resolve({ status: res.statusCode, bytes }));
    res.on('error', reject);
  });
  req.on('error', reject);
  req.setTimeout(10000, () => req.destroy(new Error('timeout ' + pathname)));
  req.end(body);
});
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const canConnect = (port) => new Promise((resolve) => { const s = net.connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
const readLines = (file) => { let t = ''; try { t = fs.readFileSync(file, 'utf8'); } catch { return []; } return t.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return { parseError: l }; } }); };

export async function run() {
  const results = [];
  const add = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail) });
  const summary = () => ({ pass: results.every((r) => r.pass), detail: results.filter((r) => !r.pass).map((r) => r.name + ': ' + r.detail).join(' | '), results });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const logFile = path.join(OUT_DIR, `usage-logger-${process.pid}.jsonl`);
  try { fs.unlinkSync(logFile); } catch { /* absent */ }
  const upstream = fakeUpstream();
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  const port = await freePort();
  let child = null, out = '', err = '', exited = null;
  const io = () => `stdout=${out.trim().replace(/\s+/g, ' ')} · stderr=${err.trim().replace(/\s+/g, ' ')}`;
  try {
    child = spawn(process.execPath, [LOGGER], { env: { ...process.env, LOG_PORT: String(port), OLLAMA_URL: `http://127.0.0.1:${upPort}`, USAGE_LOG: logFile }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code, signal) => { exited = { code, signal }; });
    const deadline = Date.now() + 10000;
    let listening = false;
    while (!listening && Date.now() < deadline && !exited) { listening = await canConnect(port); if (!listening) await sleep(100); }
    if (!listening) { add('usage-logger: proxy starts and listens on LOG_PORT', false, `not listening on ${port} · exit=${JSON.stringify(exited)} · ${io()}`); return summary(); }

    const got = {}, took = {};
    for (const p of PATHS) { const t0 = Date.now(); got[p] = await post(port, p); took[p] = Date.now() - t0; }
    // the line is appended (fs.appendFile) after the proxy ends the client response — give it a moment
    const until = Date.now() + 5000;
    let lines = [];
    while (Date.now() < until) { lines = readLines(logFile); if (lines.length >= PATHS.length) break; await sleep(100); }

    const check = (p, exp) => {
      const ls = lines.filter((l) => l.path === p), l = ls[0];
      const pass = ls.length === 1 && l.in === exp.in && l.out === exp.out && l.model === MODEL && l.platform === 'Ollama' && l.msgs === 1 && !Number.isNaN(Date.parse(l.ts));
      return { pass, detail: ls.length ? `want in=${exp.in} out=${exp.out} model=${MODEL} · got ${JSON.stringify(ls)}` : `no line for ${p} (${lines.length} line(s) total: ${JSON.stringify(lines)}) · ${io()}` };
    };
    const chat = check('/api/chat', CHAT), v1 = check('/v1/chat/completions', V1), gen = check('/api/generate', GEN), small = check('/v1/completions', SMALL);
    add('usage-logger: 12 MB streamed response is logged with exact counts', chat.pass, chat.detail);
    add('usage-logger: /v1 SSE stream over the window — the final usage chunk is logged (77/11)', v1.pass, v1.detail);
    add('usage-logger: non-streamed 200 KB /api/generate document — the counts near its end are logged (31/9)', gen.pass, gen.detail);
    const passthrough = PATHS.every((p) => got[p].status === 200 && got[p].bytes === EXPECT_BYTES[p]);
    // A0 #21: Host allow-list like the collector's — a DNS name resolving to 127.0.0.1 (rebinding) is answered 421 and never forwarded (the Host rewrite would otherwise defeat Ollama's own loopback check)
    const hitsBefore = upstreamHits;
    const evil = await post(port, '/api/chat', { host: 'evil.test' });
    const evilPort = await post(port, '/api/chat', { host: '127.0.0.1.evil.test:' + port });
    const okHost = await post(port, '/v1/completions', { host: 'localhost:' + port });
    add('usage-logger (A0 #21): Host evil.test / 127.0.0.1.evil.test:<port> → 421 JSON and the upstream is never hit; Host localhost:<port> is proxied (200)',
      evil.status === 421 && evilPort.status === 421 && upstreamHits === hitsBefore + 1 && okHost.status === 200, JSON.stringify({ evil: evil.status, evilPort: evilPort.status, okHost: okHost.status, hits: upstreamHits - hitsBefore }));
    add('usage-logger: 20 000 small SSE chunks (~2 MB) — the final usage chunk is logged (5/3) and the request finishes in under 5 s (tail kept as a chunk list, one concat at read time)', small.pass && took['/v1/completions'] < 5000, small.detail + ' · ' + took['/v1/completions'] + ' ms');
    const until2 = Date.now() + 5000; let lines2 = readLines(logFile);   // the localhost-Host request's line is appended after its response ends — give it a moment too
    while (Date.now() < until2 && lines2.length < PATHS.length + 1) { await sleep(100); lines2 = readLines(logFile); }
    add('usage-logger: exactly four JSONL lines (+1 for the localhost Host check) and every body passed through byte-for-byte', lines.length === PATHS.length && passthrough && lines2.length === PATHS.length + 1, `${lines.length} line(s) then ${lines2.length} · ${JSON.stringify(got)} · expected bytes ${JSON.stringify(EXPECT_BYTES)}`);
    return summary();
  } catch (e) {
    add('usage-logger: test threw', false, (e && e.stack || String(e)) + ' · ' + io());
    return summary();
  } finally {
    if (child && exited === null) { child.kill(); await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)]); }
    await new Promise((r) => upstream.close(r));
    try { fs.unlinkSync(logFile); } catch { /* keep going */ }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const r = await run();
  for (const x of r.results) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass ? '' : '  — ' + x.detail}`);
  process.exit(r.pass ? 0 : 1);
}
