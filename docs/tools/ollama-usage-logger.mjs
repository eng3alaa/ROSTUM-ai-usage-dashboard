#!/usr/bin/env node
/**
 * ollama-usage-logger.mjs — one-file, zero-dependency Node proxy that sits in front of Ollama,
 * forwards every request untouched, and appends one JSONL line per completed generate/chat
 * request with the EXACT token counts Ollama reports (prompt_eval_count / eval_count on the native
 * endpoints, usage.* on the /v1 OpenAI-compatible ones).
 *
 * Why: Ollama keeps no usage history — token counts exist only inside each API response.
 *
 * Run:      node docs/tools/ollama-usage-logger.mjs
 * Then point clients at the proxy instead of Ollama, e.g.
 *   PowerShell:  $env:OLLAMA_HOST = "127.0.0.1:11435"; ollama run llama4
 *   bash:        OLLAMA_HOST=127.0.0.1:11435 ollama run llama4
 *   OpenAI SDKs: base_url = "http://127.0.0.1:11435/v1"
 * and in the dashboard's Ollama card choose the folder that holds the JSONL (default ~/.ai-usage).
 *
 * Env: LOG_PORT (11435) · OLLAMA_URL (http://127.0.0.1:11434) · USAGE_LOG (~/.ai-usage/ollama-usage.jsonl)
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
const MAX_BUF = 8 * 1024 * 1024;   // never hold more than 8 MB of a single response body

fs.mkdirSync(path.dirname(OUT), { recursive: true });

function record(pathname, body) {
  let model = 'unknown', inTok = 0, outTok = 0, found = false;
  const text = body.toString('utf8');
  if (pathname.startsWith('/api/')) {
    // native: NDJSON when streaming, single JSON otherwise — the done:true object carries the counts
    for (const line of text.split('\n')) {
      const s = line.trim(); if (!s || s[0] !== '{') continue;
      let o; try { o = JSON.parse(s); } catch { continue; }
      if (o.model) model = o.model;
      if (o.prompt_eval_count != null || o.eval_count != null) { inTok = +o.prompt_eval_count || 0; outTok = +o.eval_count || 0; found = true; }
    }
  } else {
    // OpenAI-compatible: one JSON, or SSE "data: {...}" chunks (usage is only present when the client
    // asked for stream_options.include_usage — otherwise there is nothing to record)
    const sse = /^data:/m.test(text);
    const chunks = sse ? text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(l => l && l !== '[DONE]') : [text];
    for (const s of chunks) {
      let o; try { o = JSON.parse(s); } catch { continue; }
      if (o.model) model = o.model;
      const u = o.usage;
      if (u && (u.prompt_tokens != null || u.completion_tokens != null || u.input_tokens != null)) {
        inTok = +(u.prompt_tokens ?? u.input_tokens) || 0; outTok = +(u.completion_tokens ?? u.output_tokens) || 0; found = true;
      }
    }
  }
  if (!found) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), platform: 'Ollama', model, in: inTok, out: outTok, msgs: 1, path: pathname });
  fs.appendFile(OUT, line + '\n', (err) => { if (err) console.error('usage-logger: write failed', err.message); });
  console.log(`logged ${model} in=${inTok} out=${outTok} (${pathname})`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const capture = req.method === 'POST' && CAPTURE.test(url.pathname);
  const up = http.request({ hostname: UPSTREAM.hostname, port: UPSTREAM.port || 80, path: req.url, method: req.method, headers: { ...req.headers, host: UPSTREAM.host } }, (ur) => {
    res.writeHead(ur.statusCode || 502, ur.headers);
    const parts = []; let size = 0;
    ur.on('data', (chunk) => { res.write(chunk); if (capture && size < MAX_BUF) { parts.push(chunk); size += chunk.length; } });   // stream through, tee for the log
    ur.on('end', () => { res.end(); if (capture && (ur.statusCode || 500) < 400) { try { record(url.pathname, Buffer.concat(parts)); } catch (e) { console.error('usage-logger: parse failed', e.message); } } });
    ur.on('error', () => res.end());
  });
  up.on('error', (e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'upstream unreachable: ' + e.message })); });
  req.pipe(up);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`ollama-usage-logger: http://127.0.0.1:${PORT} → ${UPSTREAM.origin} · writing ${OUT}`);
  console.log(`Point clients at the proxy: OLLAMA_HOST=127.0.0.1:${PORT}  (or base_url http://127.0.0.1:${PORT}/v1)`);
});
