/* ---------- ZIP reader (no library): DeepSeek monthly usage export, chat-app export archives ---------- */
/** Minimal ZIP reader. Reads the tail (EOCD + central directory) up front and each entry's bytes lazily from File.slice.
 *  Methods 0 (stored) and 8 (deflate-raw via DecompressionStream); anything else, encrypted entries (flag bit 0) and ZIP64
 *  (0xFFFFFFFF sizes/offsets) throw Error('ZIP entry uses an unsupported method — unzip it first'). Sizes come from the
 *  central directory, so entries written with a data descriptor (flag bit 3) read fine. Names are decoded as UTF-8.
 *  → [{ name, size, method, bytes(): Promise<Uint8Array>, text(): Promise<string> }] (directory entries are skipped). */
async function readZipEntries(file) {
  const size = file.size;
  if (size < 22) throw new Error('Not a ZIP file (too small)');
  const tailLen = Math.min(size, 65536 + 22);   // EOCD = 22 bytes + a comment of at most 64 KB
  const tail = new Uint8Array(await file.slice(size - tailLen, size).arrayBuffer());
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('Not a ZIP file (no end-of-central-directory record)');
  const count = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true);
  if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) throw new Error('ZIP entry uses an unsupported method — unzip it first');   // ZIP64
  const cd = new Uint8Array(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const cdv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const dec = new TextDecoder('utf-8');
  const entries = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cdv.getUint32(p, true) !== 0x02014b50) throw new Error('Not a ZIP file (bad central directory)');
    const flags = cdv.getUint16(p + 8, true), method = cdv.getUint16(p + 10, true);
    const csize = cdv.getUint32(p + 20, true), usize = cdv.getUint32(p + 24, true);
    const n = cdv.getUint16(p + 28, true), m = cdv.getUint16(p + 30, true), k = cdv.getUint16(p + 32, true);
    const lho = cdv.getUint32(p + 42, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + n));
    p += 46 + n + m + k;
    if (name.endsWith('/')) continue;   // directory entry
    const unsupported = (flags & 1) !== 0 || csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || (method !== 0 && method !== 8);
    const bytes = async () => {
      if (unsupported) throw new Error('ZIP entry uses an unsupported method — unzip it first');
      const lh = new DataView(await file.slice(lho, lho + 30).arrayBuffer());
      if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('Not a ZIP file (bad local header)');
      const start = lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);   // local name + extra lengths may differ from the central ones
      const blob = file.slice(start, start + csize);
      if (method === 0) return new Uint8Array(await blob.arrayBuffer());
      return inflateBounded(blob, usize);
    };
    entries.push({ name, size: usize, method, bytes, text: async () => new TextDecoder('utf-8').decode(await bytes()) });
  }
  return entries;
}

/** "; N undated replies skipped" for a chat-export note, '' when none were (A0 #7). */
const undatedNote = (meta) => meta.skipped ? `; ${meta.skipped} undated ${meta.skipped === 1 ? 'reply' : 'replies'} skipped` : '';

/** deflate-raw → bytes, refusing to inflate past `declared` (the central directory's uncompressed size). The size is attacker-controlled, so this
 *  bound is what stands between a small archive and an unbounded allocation (A0 #22); an honest entry is read whole. */
async function inflateBounded(blob, declared) {
  const reader = blob.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > declared) { await reader.cancel(); throw new Error(`ZIP entry inflates past its declared size (${declared} bytes) — refusing to read it`); }
    chunks.push(value);
  }
  const out = new Uint8Array(total); let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/* ---------- import router (drop zone) ---------- */
/** Content sniff for ONE parsed .jsonl line dropped on Imports: which registered log format wrote it. Decisive shapes only — anything
 *  else is 'unknown' so sniffJsonlFile can look at the next line (Junie files open with AgentStartedEvent, Claude Code logs with a
 *  file-history-snapshot, …). Kinds other than 'claude' (the local-import path) map to a folder-log connector through JSONL_ROUTE. The
 *  file name is a last-resort hint (rollout-*.jsonl → Codex, tokensGenerated.jsonl → Continue) for a line with no signature of its own. */
function sniffJsonlKind(o, fileName) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'unknown';
  const type = typeof o.type === 'string' ? o.type : '';
  if (/^(session_meta|turn_context|response_item|event_msg)$/.test(type) && o.payload && typeof o.payload === 'object') return 'codex';   // rollout envelope { timestamp, type, payload }
  if (/^(session\.(start|shutdown)|assistant\.(usage|message|turn_start|turn_end)|user\.message)$/.test(type) || (/^[a-z]+\.[a-z_]+$/.test(type) && o.data && typeof o.data === 'object')) return 'copilot-cli';   // chronicle events: dotted type + data{}
  if (o.promptTokens != null || o.generatedTokens != null || o.eventName === 'tokensGenerated') return 'continue';
  const ev = o.event && typeof o.event === 'object' ? o.event : null;
  const evType = String((ev && (ev.type || ev.eventType)) || o.eventType || '');
  if (/LlmResponse/i.test(evType) || /LlmResponse/i.test(type) || (ev && /Event$/.test(evType))) return 'junie';   // Matterhorn { timestamp, event: { type: '…Event' } }
  if (type === 'assistant' || type === 'user' || type === 'summary' || (o.message && typeof o.message === 'object' && o.message.usage) || 'parentUuid' in o || (o.sessionId && o.uuid)) return 'claude';
  const hasTs = o.ts != null || o.timestamp != null;
  if (o.prompt_eval_count != null || o.eval_count != null || (hasTs && ['in', 'out', 'input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens'].some(k => typeof o[k] === 'number'))) return 'ollama';   // usage-logger line (docs/tools/ollama-usage-logger.mjs, or anything scripted to that shape) — top-level counts only, which is all parseUsageLoggerJsonl reads
  const name = String(fileName || '');
  if (/(^|\/)rollout-[^/]*\.jsonl$/i.test(name)) return 'codex';
  if (/(^|\/)tokensGenerated\.jsonl$/i.test(name)) return 'continue';
  return 'unknown';
}
/** File-level sniff: the first decisive kind among the first 50 non-blank lines, streamed through readLines (a long first line — Claude Code
 *  snapshots run to tens of KB — is never cut mid-JSON); 'unknown' when no line carries a signature. */
async function sniffJsonlFile(file, name) {
  let n = 0;
  for await (const line of readLines(file)) {
    if (!line.trim()) continue;
    if (++n > 50) break;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const kind = sniffJsonlKind(o, name);
    if (kind !== 'unknown') return kind;
  }
  return 'unknown';
}
/** Dropzone route per sniffed kind: the connector whose parser owns the format, and the path handed to that parser for a dropped file — the
 *  on-disk name when it already matches the connector's patterns, else a synthetic name the parser's own filename filter accepts (a renamed
 *  rollout / events file still parses; the parser's sid stays derived from the name). handleImportFiles prefixes every routed path with its
 *  own drop-<i>/ directory, so a directory-derived sid (Copilot CLI) differs per dropped file. parseFolderCached filters by connector.patterns and
 *  every parser by its own filename test, so the sniff decides and the path is made to agree. */
const JSONL_ROUTE = {
  codex: { id: 'codex', canon: (n) => 'rollout-' + n },
  'copilot-cli': { id: 'copilot-cli', canon: (n) => n.replace(/\.jsonl$/i, '') + '/events.jsonl' },
  continue: { id: 'continue', canon: (n) => n.replace(/\.jsonl$/i, '') + '/tokensGenerated.jsonl' },
  junie: { id: 'junie', canon: (n) => n.replace(/\.jsonl$/i, '') + '-events.jsonl' },
  ollama: { id: 'ollama', canon: (n) => 'usage-' + n },
};
const jsonlRoutePath = (c, kind, name) => (c.patterns || []).some(re => re.test(name)) ? name : JSONL_ROUTE[kind].canon(name);
function sniffJSON(obj, fileName) {
  // Wave 2 chat-export shapes (checked after the provider reports and the ChatGPT / Claude.ai / Takeout arrays)
  const dsTime = (o) => !!o && (o.inserted_at != null || o.created_at != null || o.create_time != null);
  const dsConv = (x) => !!(x && Array.isArray(x.messages) && x.messages.some(m => m && m.role && (dsTime(m) || dsTime(x))));   // a message time, or the conversation's (the parser's fallback)
  const dsMark = (o, name) => /deepseek/i.test(String(name || '')) || (!!o && !Array.isArray(o) && /deepseek/i.test(String(o.source || o.platform || o.provider || '')));   // generic "conversations with messages" JSON must not be mis-routed: DeepSeek needs the name or a source mark
  const pxItem = (x) => !!(x && typeof x === 'object' && ('query' in x || 'query_str' in x || 'question' in x) && ('answer' in x || 'response' in x || 'text' in x));
  // provider usage/cost reports only when the buckets look like buckets (results[] / start_time / starting_at) — a chat export's {data:[…]} falls through to the export sniffs below
  if (obj && Array.isArray(obj.data) && obj.data.length && obj.data.some(b => b && (Array.isArray(b.results) || typeof b.start_time === 'number' || typeof b.starting_at === 'string'))) {
    // find the first bucket that actually has results — providers emit empty buckets for zero-usage days
    const withResult = obj.data.find(b => b && Array.isArray(b.results) && b.results.length);
    const isUnixBucket = obj.data.some(b => b && typeof b.start_time === 'number');
    if (!withResult) return 'empty-report';
    const r = withResult.results[0];
    if ('amount' in r) return isUnixBucket ? 'openai-cost' : 'anthropic-cost';
    if ('input_cached_tokens' in r || isUnixBucket) return 'openai-usage';
    if ('uncached_input_tokens' in r || 'cache_read_input_tokens' in r || 'output_tokens' in r) return 'anthropic-usage';
  }
  if (Array.isArray(obj) && obj.length) {
    if (obj[0] && (obj[0].header === 'Gemini Apps' || (Array.isArray(obj[0].products) && obj[0].products.includes('Gemini Apps')))) return 'gemini-takeout';
    if (obj[0] && obj[0].mapping) return 'chatgpt-export';
    if (obj[0] && obj[0].chat_messages) return 'claudeai-export';
    if (dsConv(obj[0]) && dsMark(obj, fileName)) return 'deepseek-chat-export';
    if (pxItem(obj[0]) || (obj[0] && Array.isArray(obj[0].entries) && pxItem(obj[0].entries[0]))) return 'perplexity-export';
  }
  if (obj && !Array.isArray(obj) && typeof obj === 'object') {
    const convs = Array.isArray(obj.conversations) ? obj.conversations : null;
    if (convs && convs[0] && Array.isArray(convs[0].responses)) return 'grok-export';   // grok.com: {conversations:[{conversation, responses:[{message, sender, create_time}]}]}
    const dsList = convs || (Array.isArray(obj.data) ? obj.data : null);
    if (dsList && dsConv(dsList[0]) && dsMark(obj, fileName)) return 'deepseek-chat-export';
    if (Array.isArray(obj.participants) && Array.isArray(obj.messages) && (obj.participants.some(p => /meta\s*ai/i.test(p && p.name)) || obj.messages.some(m => /meta\s*ai/i.test(m && m.sender_name)))) return 'meta-ai-export';
    const pxList = Array.isArray(obj.threads) ? obj.threads : Array.isArray(obj.data) ? obj.data : null;   // {threads:[…]} or {data:[…]} — parsePerplexityExport reads both
    if (pxList && pxList[0] && (pxItem(pxList[0]) || (Array.isArray(pxList[0].entries) && pxItem(pxList[0].entries[0])))) return 'perplexity-export';
    if (convs && !convs.length) return 'empty-export';   // an empty {conversations:[]} (ChatGPT / Grok / DeepSeek chat alike) never reaches a parser, so it cannot replace an earlier import
    if (convs && convs[0] && convs[0].mapping) return 'chatgpt-export-wrapped';   // only ChatGPT mapping trees — any other {conversations:[…]} stays unknown
  }
  return 'unknown';
}
