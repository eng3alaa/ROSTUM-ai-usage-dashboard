/* =================================================================
 * 2) Chat exports (ChatGPT / Claude.ai conversations.json)
 *    Token estimate: chars/4; input = full prior context re-sent per
 *    assistant turn (how the API would bill it, no caching).
 * ================================================================= */
const estTok = (chars) => Math.round(chars / 4);

function textOfChatGPTMessage(msg) {
  const c = msg && msg.content;
  if (!c) return '';
  if (Array.isArray(c.parts)) return c.parts.filter(p => typeof p === 'string').join('\n');
  if (typeof c.text === 'string') return c.text;
  return '';
}

function parseChatGPTExport(convs) {
  const agg = makeAgg();
  let msgs = 0, skipped = 0;
  for (const conv of convs) {
    if (!conv || typeof conv !== 'object' || !conv.mapping) continue;
    // Follow only the ACTIVE branch: walk the parent chain up from current_node.
    // Regenerated/edited siblings live in mapping too and must not be counted.
    const mapping = conv.mapping;
    let leafId = conv.current_node && mapping[conv.current_node] ? conv.current_node : null;
    if (!leafId) {   // fallback: leaf = node holding the latest message timestamp
      let bestT = -1;
      for (const [id, n] of Object.entries(mapping)) {
        const t = (n && n.message && n.message.create_time) || 0;
        if (t > bestT) { bestT = t; leafId = id; }
      }
    }
    const chain = [];
    let guard = 0;
    for (let id = leafId; id && mapping[id] && guard++ < 100000; id = mapping[id].parent) {
      const msg = mapping[id].message;
      if (msg && msg.author && (msg.author.role === 'user' || msg.author.role === 'assistant')) chain.push(msg);
    }
    const nodes = chain.reverse();
    let cum = 0;
    for (const m of nodes) {
      const text = textOfChatGPTMessage(m);
      const chars = text.length;
      if (m.author.role === 'assistant') {
        const model = (m.metadata && m.metadata.model_slug) || 'chatgpt';
        const secs = m.create_time || conv.create_time;   // the conversation's time stands in for an undated reply; no date at all → skipped + counted, never booked as today (A0 #7)
        if (secs) { agg.add(dayKey(new Date(secs * 1000)), 'ChatGPT', model, { in: estTok(cum), out: estTok(chars), msgs: 1, est: 1 }); msgs++; }
        else skipped++;
      }
      cum += chars;
    }
  }
  return { rows: agg.rows(), meta: { msgs, convs: convs.length, skipped } };
}

function parseClaudeAiExport(convs, assumedModel) {
  const agg = makeAgg();
  let msgs = 0, skipped = 0;
  for (const conv of convs) {
    const list = conv && conv.chat_messages;
    if (!Array.isArray(list)) continue;
    const sorted = [...list].sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    let cum = 0;
    for (const m of sorted) {
      let text = typeof m.text === 'string' ? m.text : '';
      if (!text && Array.isArray(m.content)) text = m.content.map(c => (c && c.text) || '').join('\n');
      const chars = text.length;
      if (m.sender === 'assistant') {
        const d = dayKey(m.created_at || conv.created_at || NaN);   // the conversation's time stands in for an undated reply; no date at all → skipped + counted, never booked as today (A0 #7)
        if (d) { agg.add(d, 'Claude.ai', assumedModel, { in: estTok(cum), out: estTok(chars), msgs: 1, est: 1 }); msgs++; }
        else skipped++;
      }
      cum += chars;
    }
  }
  return { rows: agg.rows(), meta: { msgs, convs: convs.length, skipped } };
}

/** Google Takeout — My Activity/Gemini Apps/MyActivity.json: array of activity records {header:'Gemini Apps',
 *  title:'Prompted <text>', time, safeHtmlItem:[{html}], products:['Gemini Apps']}. One record = one prompt +
 *  response, no conversation tree, no model, no tokens → estimated from text; input = the prompt only (lower bound).
 *  Non-Gemini and undated records are skipped and counted. */
function parseGeminiTakeout(arr) {
  const agg = makeAgg(); let msgs = 0, skipped = 0;
  const strip = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  const isGemini = (r) => r.header === 'Gemini Apps' || (Array.isArray(r.products) && r.products.includes('Gemini Apps'));
  for (const r of arr) {
    if (!r || typeof r !== 'object' || !isGemini(r)) { skipped++; continue; }
    const ts = r.time ? new Date(r.time) : null;
    if (!ts || isNaN(ts)) { skipped++; continue; }
    const prompt = String(r.title || '').replace(/^Prompted\s+/i, '');
    const resp = Array.isArray(r.safeHtmlItem) ? r.safeHtmlItem.map(x => strip(x && x.html)).join(' ') : '';
    agg.add(dayKey(ts), 'Gemini app', 'gemini (app)', { in: estTok(prompt.length), out: estTok(resp.length), msgs: 1, est: 1 }, undefined, ts.getHours());
    msgs++;
  }
  return { rows: agg.rows(), meta: { msgs, skipped, records: arr.length } };
}

/* ---------- Wave 2 chat-app exports (Grok, DeepSeek chat, Meta AI, Perplexity). All estimated from text; input = the preceding
 * prompt only (a lower bound, like Takeout); every row est:1; platform strings are the export-file cards' platforms. ---------- */
/** Timestamp of an exported record in any shape these exports use: ISO string, date-only string, 'M/D/YYYY H:MM[:SS] [AM|PM]' (local),
 *  epoch seconds or milliseconds (number or numeric string), MongoDB extended JSON {$date:{$numberLong:'ms'}} / {$date:'iso'}.
 *  → { d, hour } (local day; hour undefined for date-only values) or null. */
function exportTimestamp(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') { if (v.$date != null) return exportTimestamp(v.$date); if (v.$numberLong != null) return exportTimestamp(Number(v.$numberLong)); return null; }
  const s = String(v).trim();
  if (typeof v === 'string' && RE_DATEONLY.test(s)) return { d: s, hour: undefined };
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec(s);
  if (us) {
    let h = us[4] ? +us[4] : 0;
    if (us[7]) { const pm = /p/i.test(us[7]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
    const t = new Date(+us[3], +us[1] - 1, +us[2], h, us[5] ? +us[5] : 0, us[6] ? +us[6] : 0);
    return isNaN(t) ? null : { d: dayKey(t), hour: us[4] ? t.getHours() : undefined };
  }
  let ms = typeof v === 'number' ? v : (/^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN);
  if (Number.isFinite(ms)) { if (ms < 1e11) ms *= 1000; }   // epoch seconds → ms (no chat export predates 1973)
  else ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  const t = new Date(ms);
  return { d: dayKey(t), hour: t.getHours() };
}
/** Text of an exported message in the shapes seen: string · [parts] · {text} · {content} · {parts:[…]}. */
function exportText(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(exportText).join('\n');
  if (typeof c === 'object') { if (typeof c.text === 'string') return c.text; if (c.content != null) return exportText(c.content); if (Array.isArray(c.parts)) return exportText(c.parts); return ''; }
  return String(c);
}
/** grok.com export: {conversations:[{conversation:{title, create_time}, responses:[{message, sender:'human'|'assistant', create_time}]}]}.
 *  create_time is MongoDB extended JSON ({$date:{$numberLong}}), an ISO string or a number; a reply without one falls back to the
 *  conversation's create_time; no time anywhere → skipped and counted. Model 'grok' (the export names none). */
function parseGrokExport(obj) {
  const agg = makeAgg(); let msgs = 0, skipped = 0;
  const convs = Array.isArray(obj && obj.conversations) ? obj.conversations : [];
  for (const c of convs) {
    const meta = (c && c.conversation) || {}, list = Array.isArray(c && c.responses) ? c.responses : [];
    const convTs = exportTimestamp(meta.create_time);
    let lastHuman = 0;
    for (const r of list) {
      if (!r || typeof r !== 'object') continue;
      const chars = exportText(r.message).length;
      if (String(r.sender || '').toLowerCase() !== 'assistant') { lastHuman = chars; continue; }
      const ts = exportTimestamp(r.create_time) || convTs;
      if (!ts) { skipped++; continue; }
      agg.add(ts.d, 'Grok', 'grok', { in: estTok(lastHuman), out: estTok(chars), msgs: 1, est: 1 }, undefined, ts.hour);
      msgs++;
    }
  }
  return { rows: agg.rows(), meta: { msgs, convs: convs.length, skipped } };
}
/** chat.deepseek.com export (shape undocumented → tolerant): an array of conversations, or {conversations|data:[…]}, each with
 *  messages[{role|sender, content|text, inserted_at|created_at|create_time|timestamp, model?}]. Assistant messages → rows; model = message.model,
 *  else the conversation's model, else 'deepseek-chat'; a message without a time falls back to the conversation's; none → skipped and counted. */
const dsChatTime = (o) => exportTimestamp(o.inserted_at != null ? o.inserted_at : o.created_at != null ? o.created_at : o.create_time != null ? o.create_time : o.timestamp);
function parseDeepSeekChatExport(obj) {
  const agg = makeAgg(); let msgs = 0, skipped = 0;
  const convs = Array.isArray(obj) ? obj : (obj && (Array.isArray(obj.conversations) ? obj.conversations : Array.isArray(obj.data) ? obj.data : [])) || [];
  for (const c of convs) {
    if (!c || typeof c !== 'object') continue;
    const list = Array.isArray(c.messages) ? c.messages : [];
    const convTs = dsChatTime(c);
    let lastUser = 0;
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      const chars = exportText(m.content != null ? m.content : m.text).length;
      const role = String(m.role || m.sender || '').toLowerCase();
      if (role !== 'assistant') { if (role === 'user' || role === 'human') lastUser = chars; continue; }
      const ts = dsChatTime(m) || convTs;
      if (!ts) { skipped++; continue; }
      agg.add(ts.d, 'DeepSeek chat', String(m.model || c.model || 'deepseek-chat'), { in: estTok(lastUser), out: estTok(chars), msgs: 1, est: 1 }, undefined, ts.hour);
      msgs++;
    }
  }
  return { rows: agg.rows(), meta: { msgs, convs: convs.length, skipped } };
}
/** Meta AI thread from Download-your-information (Facebook DYI JSON): {participants:[{name}], messages:[{sender_name, timestamp_ms,
 *  content}], thread_path}. Messages are listed newest first → sorted ascending; replies whose sender_name is "Meta AI" are output, the
 *  preceding message input. Rows carry sid = thread_path (or the file name) so each thread file replaces only itself on re-import. */
function parseMetaAiExport(obj, fileName) {
  const agg = makeAgg(); let msgs = 0, skipped = 0;
  const list = Array.isArray(obj && obj.messages) ? obj.messages.filter(m => m && typeof m === 'object') : [];
  const isAi = (m) => /meta\s*ai/i.test(String(m.sender_name || ''));
  const sid = String((obj && obj.thread_path) || fileName || 'meta-ai');
  const sorted = [...list].sort((a, b) => (+a.timestamp_ms || 0) - (+b.timestamp_ms || 0));
  let lastUser = 0;
  for (const m of sorted) {
    const chars = exportText(m.content).length;
    if (!isAi(m)) { lastUser = chars; continue; }
    const ts = exportTimestamp(m.timestamp_ms != null ? m.timestamp_ms : m.timestamp);
    if (!ts) { skipped++; continue; }
    agg.add(ts.d, 'Meta AI', 'meta-ai', { in: estTok(lastUser), out: estTok(chars), msgs: 1, est: 1 }, sid, ts.hour);
    msgs++;
  }
  return { rows: agg.rows(), meta: { msgs, skipped, sid } };
}
/** Perplexity data export / exporter JSON: an array of threads (or {threads|data:[…]}); a thread is {query|query_str|question|title,
 *  answer|response|text, created_at|timestamp|date} or carries entries[]/steps[] of that shape. Rows carry sid = file name so each file
 *  (the export may be one JSON per thread) replaces only itself on re-import. */
function parsePerplexityExport(input, fileName) {
  const agg = makeAgg(); let msgs = 0, skipped = 0;
  const list = Array.isArray(input) ? input : (input && (Array.isArray(input.threads) ? input.threads : Array.isArray(input.data) ? input.data : [])) || [];
  const sid = String(fileName || 'perplexity');
  const q = (t) => exportText(t.query != null ? t.query : t.query_str != null ? t.query_str : t.question != null ? t.question : t.title);
  const a = (t) => exportText(t.answer != null ? t.answer : t.response != null ? t.response : t.text);
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const items = Array.isArray(t.entries) ? t.entries : Array.isArray(t.steps) ? t.steps : [t];
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const ts = exportTimestamp(it.created_at != null ? it.created_at : it.timestamp != null ? it.timestamp : it.date != null ? it.date : t.created_at != null ? t.created_at : t.timestamp);
      if (!ts) { skipped++; continue; }
      agg.add(ts.d, 'Perplexity', 'perplexity', { in: estTok(q(it).length), out: estTok(a(it).length), msgs: 1, est: 1 }, sid, ts.hour);
      msgs++;
    }
  }
  return { rows: agg.rows(), meta: { msgs, skipped, threads: list.length, sid } };
}

/* ---------- Plan 9 B6 exports (Mistral Vibe, Sourcegraph Cody, Character.ai): estimated from text like the Wave 2 exports — input = the preceding prompt only
 * (a lower bound), every row est:1, undated replies skipped + counted (A0 #7). Every layout is third-party / sniffed (research 2026-10-15) — field access is tolerant,
 * and each sniff below is what keeps a look-alike export (DeepSeek chat, Grok) out of these parsers. ---------- */
/** Books the assistant turns of one ordered message list. say(m) → { role: 'user' | 'assistant' | other, chars, ts: { d, hour } | null } or null (not a message);
 *  book(turn, promptChars) lands a row; counters.msgs / counters.skipped count landed and undated replies. */
function bookEstimatedTurns(list, say, book, counters) {
  let lastUser = 0;
  for (const m of list) {
    const turn = say(m);
    if (!turn) continue;
    if (turn.role !== 'assistant') { if (turn.role === 'user') lastUser = turn.chars; continue; }
    if (!turn.ts) { counters.skipped++; continue; }
    book(turn, lastUser); counters.msgs++;
  }
}
const MISTRAL_MODEL_RE = /mistral|codestral|magistral|devstral|ministral|pixtral|voxtral/i;
/** admin.mistral.ai/account/export: {account, conversations:[{…, model, messages:[{role, content}]}], …} — recognised by the file name (mistral / vibe / le chat), the
 *  account block or a Mistral-family conversation model; a bare {conversations:[{messages}]} is not claimed (DeepSeek chat has that shape). */
function isMistralVibeExport(obj, convs, fileName) {
  const withRoles = convs.some(c => c && Array.isArray(c.messages) && c.messages.some(m => m && typeof m.role === 'string'));
  if (!withRoles) return false;
  return /mistral|vibe|le[-_ ]?chat/i.test(String(fileName || '')) || !!(obj.account && typeof obj.account === 'object') || convs.some(c => c && MISTRAL_MODEL_RE.test(String(c.model || '')));
}
/** Mistral Vibe (Le Chat) export JSON (schema from a third-party guide): conversations[{id, created_at, title, model, messages:[{role, content, created_at?}]}]. Model per
 *  conversation (else 'mistral'); a message's created_at, else the conversation's; none → skipped + counted. Platform 'Mistral Vibe'. */
function parseMistralVibeExport(obj) {
  const agg = makeAgg(); const k = { msgs: 0, skipped: 0 };
  const convs = Array.isArray(obj && obj.conversations) ? obj.conversations.filter(c => c && typeof c === 'object') : [];
  for (const c of convs) {
    const convTs = exportTimestamp(c.created_at != null ? c.created_at : c.create_time), model = String(c.model || 'mistral');
    const say = (m) => m && typeof m === 'object' ? { role: String(m.role || '').toLowerCase(), chars: exportText(m.content != null ? m.content : m.text).length, ts: exportTimestamp(m.created_at != null ? m.created_at : m.timestamp) || convTs } : null;
    bookEstimatedTurns(Array.isArray(c.messages) ? c.messages : [], say, (turn, prompt) => agg.add(turn.ts.d, 'Mistral Vibe', model, { in: estTok(prompt), out: estTok(turn.chars), msgs: 1, est: 1 }, undefined, turn.ts.hour), k);
  }
  return { rows: agg.rows(), meta: { msgs: k.msgs, convs: convs.length, skipped: k.skipped } };
}
/** Cody's History > Export: an object whose values are chats with interactions[] of {humanMessage, assistantMessage}. */
function isCodyExport(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const chats = Object.values(obj).filter(v => v && typeof v === 'object' && Array.isArray(v.interactions));
  return chats.length > 0 && chats.some(ch => ch.interactions.some(it => it && typeof it === 'object' && ('humanMessage' in it || 'assistantMessage' in it)));
}
/** Sourcegraph Cody chat History > Export JSON (0.10 release-notes shape; may have drifted): {"<ISO time>": {id, chatModel?, lastInteractionTimestamp?,
 *  interactions:[{humanMessage:{text|displayText}, assistantMessage:{…}|null, timestamp?}]}}. One row per answered interaction; time = the interaction's, else its
 *  prompt's, else the chat's key / lastInteractionTimestamp (none → skipped + counted); model = chatModel, else 'cody'. Platform 'Sourcegraph Cody'. */
function parseCodyExport(obj) {
  const agg = makeAgg(); const k = { msgs: 0, skipped: 0 };
  const chats = Object.entries(obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}).filter(([, ch]) => ch && typeof ch === 'object' && Array.isArray(ch.interactions));
  const text = (m) => m && typeof m === 'object' ? exportText(m.text != null ? m.text : m.displayText) : '';
  for (const [key, ch] of chats) {
    const chatTs = exportTimestamp(key) || exportTimestamp(ch.lastInteractionTimestamp), model = String(ch.chatModel || ch.model || 'cody');
    for (const it of ch.interactions) {
      if (!it || typeof it !== 'object' || !it.assistantMessage) continue;   // an unanswered turn
      const ts = exportTimestamp(it.timestamp) || exportTimestamp(it.humanMessage && it.humanMessage.timestamp) || chatTs;
      if (!ts) { k.skipped++; continue; }
      agg.add(ts.d, 'Sourcegraph Cody', model, { in: estTok(text(it.humanMessage).length), out: estTok(text(it.assistantMessage).length), msgs: 1, est: 1 }, undefined, ts.hour);
      k.msgs++;
    }
  }
  return { rows: agg.rows(), meta: { msgs: k.msgs, chats: chats.length, skipped: k.skipped } };
}
/** A Character.ai message's human flag in the shapes third-party guides show (is_human / author.is_human / src__is_human / author__is_human / role) — undefined when none. */
const caiIsHuman = (m) => m.is_human ?? (m.author && typeof m.author === 'object' ? m.author.is_human : undefined) ?? m.src__is_human ?? m.author__is_human ?? (typeof m.role === 'string' ? /^(user|human)$/i.test(m.role) : undefined);
/** The message lists an archive file may hold: a top-level array, {messages}, {chats:[{messages}]} or {history:[{msgs}]}. */
function characterAiMessageLists(obj) {
  if (Array.isArray(obj)) return [obj];
  if (!obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj.messages)) return [obj.messages];
  const chats = Array.isArray(obj.chats) ? obj.chats : Array.isArray(obj.history) ? obj.history : [];
  return chats.filter(c => c && typeof c === 'object').map(c => Array.isArray(c.messages) ? c.messages : Array.isArray(c.msgs) ? c.msgs : []);
}
/** Character.ai: "character" in the file name (the archive's own name counts) AND a message list whose messages carry a human flag and text. */
function isCharacterAiExport(obj, fileName) {
  if (!/character/i.test(String(fileName || ''))) return false;
  return characterAiMessageLists(obj).some(list => list.some(m => m && typeof m === 'object' && typeof caiIsHuman(m) === 'boolean' && (m.text != null || m.raw_content != null || m.content != null)));
}
/** Character.ai export archive (Export Data — emailed weeks later; layout from third-party guides, sniffed): message lists with a human flag, text (text / raw_content /
 *  content) and a time (create_time / created_at / created / timestamp). A character reply is output, the preceding human message input; no model (character.ai).
 *  Rows carry sid = file name so each message file of the archive replaces only itself. */
function parseCharacterAiExport(obj, fileName) {
  const agg = makeAgg(); const k = { msgs: 0, skipped: 0 };
  const sid = String(fileName || 'character.ai');
  const when = (m) => exportTimestamp(m.create_time != null ? m.create_time : m.created_at != null ? m.created_at : m.created != null ? m.created : m.timestamp);
  const say = (m) => m && typeof m === 'object' && typeof caiIsHuman(m) === 'boolean' ? { role: caiIsHuman(m) ? 'user' : 'assistant', chars: exportText(m.text != null ? m.text : m.raw_content != null ? m.raw_content : m.content).length, ts: when(m) } : null;
  for (const list of characterAiMessageLists(obj)) bookEstimatedTurns(list, say, (turn, prompt) => agg.add(turn.ts.d, 'Character.ai', 'character.ai', { in: estTok(prompt), out: estTok(turn.chars), msgs: 1, est: 1 }, sid, turn.ts.hour), k);
  return { rows: agg.rows(), meta: { msgs: k.msgs, skipped: k.skipped, sid } };
}


/** Parses a large chat export off the main thread via a Blob-sourced Worker, so a big export doesn't freeze the tab. Rebuilds the parse
 *  functions' source inside the worker (Workers don't share scope with the page) from their .toString(): every free identifier those
 *  functions touch (dayKey, addDays, estTok, RE_DATEONLY, makeAgg, textOfChatGPTMessage, exportTimestamp, exportText, dsChatTime, parseCSV,
 *  sniffJSON …) must be listed in `fns` too, or the worker throws a ReferenceError — surfaced below as a rejection, never a hang.
 *  kind: 'chatgpt' (an array or {conversations}) · 'claudeai' (+ assumedModel) · 'grok' · 'deepseek-chat' · 'meta-ai' · 'perplexity' (+ fileName,
 *  the sid) · 'mistral-vibe' · 'cody' · 'characterai' (+ fileName, the sid — Plan 9 B6) → JSON text, parsed in the worker; 'copilot-csv' → the raw activity CSV text (+ fileName). Resolves {rows, meta} exactly as the inline
 *  parser returns it. kind 'sniff' → the worker parses the JSON, runs sniffJSON(obj, fileName) — the same exact gates as inline, e.g. DeepSeek
 *  chat's file-name / source mark — and, when that names a chat export, parses it in the same trip: resolves {kind, res} with res = {rows, meta},
 *  or null for any other shape (provider report, Takeout, empty, unknown — the caller parses those inline). Chosen over a 64 KB head sniff on the
 *  main thread (sniffJSON's gates cannot be applied to a truncated document) and over re-parsing the whole text on the main thread just to sniff
 *  (that parse is the freeze). Rejects with the worker's message (malformed JSON, an unknown kind, a parser's own throw, a ReferenceError). */
function parseInWorker(kind, text, assumedModel, fileName) {
  return new Promise((resolve, reject) => {
    const fns = { dayKey, addDays, estTok, RE_DATEONLY, makeAgg, textOfChatGPTMessage, parseChatGPTExport, parseClaudeAiExport, exportTimestamp, exportText, dsChatTime,
      parseGrokExport, parseDeepSeekChatExport, parseMetaAiExport, parsePerplexityExport, parseCSV, parseCopilotActivityCSV, sniffJSON,
      bookEstimatedTurns, MISTRAL_MODEL_RE, isMistralVibeExport, parseMistralVibeExport, isCodyExport, parseCodyExport, caiIsHuman, characterAiMessageLists, isCharacterAiExport, parseCharacterAiExport };   // Plan 9 B6 (sniffJSON reaches the three is* gates)
    const src = Object.entries(fns).map(([name, f]) => {
      const body = f.toString();
      // `function name(...) {...}` declarations stringify ready to paste; const-bound arrows (dayKey, addDays, estTok, dsChatTime) and the
      // RE_DATEONLY regex stringify as bare expressions and need their binding restored, or the worker throws "<name> is not defined" when called.
      return body.trim().startsWith('function') ? body : `const ${name} = ${body};`;
    }).join('\n')
      + '\nconst PARSERS = { chatgpt: (o) => parseChatGPTExport(Array.isArray(o) ? o : o.conversations), claudeai: (o, a) => parseClaudeAiExport(o, a), grok: (o) => parseGrokExport(o),'
      + ' "deepseek-chat": (o) => parseDeepSeekChatExport(o), "meta-ai": (o, a, n) => parseMetaAiExport(o, n), perplexity: (o, a, n) => parsePerplexityExport(o, n),'
      + ' "mistral-vibe": (o) => parseMistralVibeExport(o), cody: (o) => parseCodyExport(o), characterai: (o, a, n) => parseCharacterAiExport(o, n) };'
      + '\nconst SNIFFED = { "chatgpt-export": "chatgpt", "chatgpt-export-wrapped": "chatgpt", "claudeai-export": "claudeai", "grok-export": "grok", "deepseek-chat-export": "deepseek-chat", "meta-ai-export": "meta-ai", "perplexity-export": "perplexity",'
      + ' "mistral-vibe-export": "mistral-vibe", "cody-export": "cody", "characterai-export": "characterai" };'
      + '\nself.onmessage = (e) => { const { kind, text, assumedModel, fileName } = e.data; try {'
      + ' if (kind === "copilot-csv") { self.postMessage(parseCopilotActivityCSV(text, fileName)); return; }'
      + ' const obj = JSON.parse(text);'
      + ' if (kind === "sniff") { const k = sniffJSON(obj, fileName); self.postMessage({ kind: k, res: Object.hasOwn(SNIFFED, k) ? PARSERS[SNIFFED[k]](obj, assumedModel, fileName) : null }); return; }'
      + ' if (!Object.hasOwn(PARSERS, kind)) throw new Error("unknown parse kind: " + kind);'
      + ' self.postMessage(PARSERS[kind](obj, assumedModel, fileName));'
      + ' } catch (err) { self.postMessage({ error: String((err && err.message) || err) }); } };';
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    const worker = new Worker(url);
    const cleanup = () => { URL.revokeObjectURL(url); worker.terminate(); };
    worker.onmessage = (e) => { cleanup(); if (e.data && e.data.error) reject(new Error(e.data.error)); else resolve(e.data); };
    worker.onerror = (e) => { cleanup(); reject((e && e.error) || new Error((e && e.message) || 'worker parse failed')); };   // a script-level failure (a helper missing from `fns`, a syntax error in the rebuilt source) never reaches onmessage
    worker.postMessage({ kind, text, assumedModel, fileName });
  });
}

