/** Ollama desktop app — db.sqlite (GUI chats only; API/CLI traffic is not in here). Table messages(id, chat_id, role, content,
 *  thinking, model_name, model_cloud, created_at, updated_at, …). No token counts are stored: out = estTok(content + thinking),
 *  in = estTok(the previous user message in the same chat) → every row est:1. created_at may be ISO text, SQLite
 *  'YYYY-MM-DD HH:MM:SS' (UTC), or unix seconds/ms (number or digit string). Dedupe id 'ollama-db:<message id>' (seen/addedIds)
 *  so the same db scanned again under another path never double counts; row sid 'ollama-db:<chat_id>' groups rows per chat.
 *  An unreadable file (WITHOUT ROWID / not SQLite) THROWS — parseFolderCached counts it as one unreadable file and moves on.
 *  The -wal sidecar is not read: close the Ollama app first so the WAL is checkpointed into db.sqlite. */
async function parseOllamaDb(files, onProgress, seen = new Set(), c, siblingFiles) {
  const agg = makeAgg(); const addedIds = [], dupIds = []; let msgs = 0, lines = 0;
  const list = files.filter(f => /(^|\/)db\.sqlite$/i.test(f.path));
  const when = (v, fallback) => {
    if (typeof v === 'string' && /^\d{9,13}(\.\d+)?$/.test(v.trim())) v = +v;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v < 1e12 ? v * 1000 : v);   // unix seconds vs milliseconds
    if (typeof v === 'string') {
      let s = v.trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2').replace(/(\.\d{3})\d+/, '$1');        // 'YYYY-MM-DD HH:MM:SS[.ffffff][zone]' → ISO, ≤ 3 fraction digits
      if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) s += 'Z';                   // SQLite CURRENT_TIMESTAMP / Go UTC text carry no zone → UTC
      const d = new Date(s); if (!isNaN(d)) return d;
    }
    return new Date(fallback);
  };
  for (let fi = 0; fi < list.length; fi++) {
    const { file } = list[fi];
    const table = readSqliteTable(await file.arrayBuffer(), 'messages');   // throws on a bad file (see above)
    const col = Object.fromEntries(table.columns.map((n, i) => [String(n).toLowerCase(), i]));
    const get = (r, name) => { const i = col[name]; return i == null ? null : r[i]; };
    if (col.role == null || col.content == null) throw new Error('unsupported SQLite layout (messages has no role/content columns)');
    const lastUser = new Map();   // chat_id → text of the latest user message so far (rows arrive in rowid = insertion order)
    for (const r of table.rows) {
      lines++;
      const role = String(get(r, 'role') || '').toLowerCase();
      const chat = String(get(r, 'chat_id') ?? '');
      const text = String(get(r, 'content') ?? '');
      if (role === 'user') { lastUser.set(chat, text); continue; }
      if (role !== 'assistant') continue;
      const id = 'ollama-db:' + String(get(r, 'id') ?? (fi + ':' + lines));
      if (seen.has(id)) { dupIds.push(id); continue; }
      seen.add(id); addedIds.push(id);
      const ts = when(get(r, 'created_at'), file.lastModified);
      agg.add(dayKey(ts), (c && c.platform) || 'Ollama', String(get(r, 'model_name') || 'ollama'),
        { in: estTok((lastUser.get(chat) || '').length), out: estTok(text.length + String(get(r, 'thinking') ?? '').length), msgs: 1, est: 1 },
        'ollama-db:' + chat, ts.getHours());
      msgs++;
    }
    if (onProgress) onProgress(fi + 1, list.length);
  }
  return { rows: agg.rows(), projects: [], meta: { files: list.length, msgs, lines, badLines: 0, addedIds, dupIds } };
}
/** Ollama folder dispatcher (registry parser): usage-logger JSONL (exact, parseUsageLoggerJsonl) + desktop db.sqlite (estimated,
 *  parseOllamaDb) through one card; results concatenated. parseFolderCached hands in one file at a time, so each call sees one kind. */
async function parseOllamaFiles(files, onProgress, seen = new Set(), c, siblingFiles) {
  const a = await parseUsageLoggerJsonl(files.filter(f => /\.jsonl$/i.test(f.path)), null, seen, c);
  const b = await parseOllamaDb(files.filter(f => /(^|\/)db\.sqlite$/i.test(f.path)), null, seen, c, siblingFiles);
  if (onProgress) onProgress(files.length, files.length);
  return { rows: a.rows.concat(b.rows), projects: [], meta: { files: a.meta.files + b.meta.files, msgs: a.meta.msgs + b.meta.msgs, lines: a.meta.lines + b.meta.lines,
    badLines: a.meta.badLines + b.meta.badLines, addedIds: (a.meta.addedIds || []).concat(b.meta.addedIds || []), dupIds: (a.meta.dupIds || []).concat(b.meta.dupIds || []) } };
}

