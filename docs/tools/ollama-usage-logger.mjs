#!/usr/bin/env node
/**
 * ollama-usage-logger.mjs — one-file, zero-dependency Node proxy that sits in front of Ollama,
 * forwards every request untouched, and appends one JSONL line per completed generate/chat
 * request with the EXACT token counts Ollama reports (prompt_eval_count / eval_count on the native
 * endpoints, usage.* on the /v1 OpenAI-compatible ones).
 *
 * Why: Ollama keeps no usage history — token counts exist only inside each API response.
 *
 * How the counts are read: the response body is never buffered whole. Per in-flight response the
 * proxy keeps the first 64 KB (to read the model) and a rolling window of the last 64 KB, and the
 * counts are read from that window when the response ends — the usage object Ollama / OpenAI-
 * compatible servers send last (the done:true NDJSON line; the final SSE usage chunk, which exists
 * only when the client set stream_options.include_usage; the end of a non-streamed document).
 * Memory stays ~128 KB per response whatever its size, so a 12 MB stream is logged like a 1 KB one.
 * Should the counts not sit in that last 64 KB, nothing is logged and a warning is printed — counts
 * are never estimated.
 *
 * Run:      node docs/tools/ollama-usage-logger.mjs
 * Then point clients at the proxy instead of Ollama, e.g.
 *   PowerShell:  $env:OLLAMA_HOST = "127.0.0.1:11435"; ollama run llama4
 *   bash:        OLLAMA_HOST=127.0.0.1:11435 ollama run llama4
 *   OpenAI SDKs: base_url = "http://127.0.0.1:11435/v1"
 * and in the dashboard's Ollama card choose the folder that holds the JSONL (default ~/.ai-usage).
 *
 * Env: LOG_PORT (11435; 0 = any free port, printed at start) · OLLAMA_URL (http://127.0.0.1:11434) · USAGE_LOG (~/.ai-usage/ollama-usage.jsonl)
 * Line shape: {"ts":"<ISO>","platform":"Ollama","model":"llama4:8b","in":123,"out":456,"msgs":1,"path":"/api/chat"}
 * The dashboard reads it with parseUsageLoggerJsonl (any {ts, platform, model, in, out} JSONL works).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = parseInt(process.env.LOG_PORT || '11435', 10);
const UPSTREAM = new URL(process.env.OLLAMA_URL || 'http://127.0.0.1:11434');
const OUT = process.env.USAGE_LOG || path.join(os.homedir(), '.ai-usage', 'ollama-usage.jsonl');
const CAPTURE = /^\/(api\/(generate|chat)|v1\/(chat\/completions|completions|responses))(\?|$)/;
const HEAD_BYTES = 64 * 1024;   // the model is read from the first 64 KB of a response (its first object carries it)
const TAIL_BYTES = 64 * 1024;   // the counts are read from the last 64 KB — the usage object is the last thing a server sends

fs.mkdirSync(path.dirname(OUT), { recursive: true });

// Head + rolling tail of one response body: push() every chunk; memory is bounded by HEAD_BYTES + TAIL_BYTES + one chunk.
class Capture {
  constructor() { this.size = 0; this.head = []; this.headLen = 0; this.tail = Buffer.alloc(0); }
  push(chunk) {
    this.size += chunk.length;
    if (this.headLen < HEAD_BYTES) { this.head.push(chunk); this.headLen += chunk.length; }
    this.tail = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    if (this.tail.length > TAIL_BYTES) this.tail = this.tail.subarray(this.tail.length - TAIL_BYTES);   // trim from the front
  }
  headText() { return Buffer.concat(this.head).subarray(0, HEAD_BYTES).toString('utf8'); }
  tailText() { return this.tail.toString('utf8'); }
}

// Complete JSON objects in a window of text: one per NDJSON line or per SSE "data:" line (a lone document is one line).
// A window that starts / ends mid-line has a cut first / last line — the caller says which to drop.
function objectsIn(text, dropFirst, dropLast) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out = [];
  for (let s of lines) {
    s = s.trim(); if (s.startsWith('data:')) s = s.slice(5).trim();
    if (s[0] !== '{') continue;
    try { out.push(JSON.parse(s)); } catch { /* not a complete object */ }
  }
  return out;
}
// Ollama native (prompt_eval_count / eval_count) or OpenAI-compatible (usage.prompt_tokens / completion_tokens — sent only on the
// final chunk, and only when the client asked for stream_options.include_usage; otherwise there is nothing to record)
function countsOf(o) {
  if (o.prompt_eval_count != null || o.eval_count != null) return { in: +o.prompt_eval_count || 0, out: +o.eval_count || 0 };
  const u = o.usage;
  if (u && (u.prompt_tokens != null || u.completion_tokens != null || u.input_tokens != null)) return { in: +(u.prompt_tokens ?? u.input_tokens) || 0, out: +(u.completion_tokens ?? u.output_tokens) || 0 };
  return null;
}
// When the object that carries the counts is itself bigger than the window (a non-streamed document; a done object with a long
// context[]), read the count keys from the window's raw text: JSON escapes quotes inside strings, so an unescaped "key": can only be a key.
function countKeysIn(text) {
  const last = (re) => { let m, v = null; while ((m = re.exec(text))) v = m[1]; return v; };
  const pe = last(/"prompt_eval_count"\s*:\s*(\d+)/g), ec = last(/"eval_count"\s*:\s*(\d+)/g);
  if (pe != null || ec != null) return { in: +pe || 0, out: +ec || 0 };
  const pt = last(/"prompt_tokens"\s*:\s*(\d+)/g) ?? last(/"input_tokens"\s*:\s*(\d+)/g);
  const ct = last(/"completion_tokens"\s*:\s*(\d+)/g) ?? last(/"output_tokens"\s*:\s*(\d+)/g);
  return (pt != null || ct != null) ? { in: +pt || 0, out: +ct || 0 } : null;
}
// → { model, in, out }, or null when the last TAIL_BYTES carry no counts
function extract(cap) {
  const tail = cap.tailText();
  let counts = null, model = null;
  for (const o of objectsIn(tail, cap.size > TAIL_BYTES, false)) { const c = countsOf(o); if (c) { counts = c; if (o.model) model = String(o.model); } }   // the last object with counts wins
  if (!counts) counts = countKeysIn(tail);
  if (!counts) return null;
  const head = cap.headText();
  const first = objectsIn(head, false, cap.size > HEAD_BYTES).find((o) => o.model);   // the first object that carries "model"
  if (first) model = String(first.model);
  else if (!model) { const m = /"model"\s*:\s*"([^"\\]*)"/.exec(head); if (m) model = m[1]; }   // a document too big to parse in the window
  return { model: model || 'unknown', in: counts.in, out: counts.out };
}

function record(pathname, cap) {
  const r = extract(cap);
  if (!r) {
    if (cap.size > TAIL_BYTES) console.warn(`usage-logger: usage not found in the last ${TAIL_BYTES / 1024} KB of a ${cap.size}-byte response (${pathname}) — nothing logged`);
    return;
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), platform: 'Ollama', model: r.model, in: r.in, out: r.out, msgs: 1, path: pathname });
  fs.appendFile(OUT, line + '\n', (err) => { if (err) console.error('usage-logger: write failed', err.message); });
  console.log(`logged ${r.model} in=${r.in} out=${r.out} (${pathname})`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const capture = req.method === 'POST' && CAPTURE.test(url.pathname);
  const up = http.request({ hostname: UPSTREAM.hostname, port: UPSTREAM.port || 80, path: req.url, method: req.method, headers: { ...req.headers, host: UPSTREAM.host } }, (ur) => {
    res.writeHead(ur.statusCode || 502, ur.headers);
    const cap = capture ? new Capture() : null;
    if (cap) ur.on('data', (chunk) => cap.push(chunk));   // tee for the log; pipe() below owns the pass-through and its backpressure
    ur.pipe(res);
    ur.on('end', () => { if (cap && (ur.statusCode || 500) < 400) { try { record(url.pathname, cap); } catch (e) { console.error('usage-logger: parse failed', e.message); } } });
    ur.on('error', () => res.end());
  });
  up.on('error', (e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'upstream unreachable: ' + e.message })); });
  req.pipe(up);
});
server.listen(PORT, '127.0.0.1', () => {
  const port = server.address().port;   // LOG_PORT=0 → whatever the OS handed out
  console.log(`ollama-usage-logger: http://127.0.0.1:${port} → ${UPSTREAM.origin} · writing ${OUT}`);
  console.log(`Point clients at the proxy: OLLAMA_HOST=127.0.0.1:${port}  (or base_url http://127.0.0.1:${port}/v1)`);
});
