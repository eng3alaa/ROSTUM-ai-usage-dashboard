/* =================================================================
 * Minimal SQLite 3 reader (no library): enough to read ONE rowid table out of a .sqlite file in the browser.
 * Supported: page sizes 512..65536 + reserved bytes, sqlite_master on page 1, table b-trees (interior 0x05 / leaf 0x0D),
 * overflow chains, record serial types 0-9, 12+ (blob → Uint8Array), 13+ (UTF-8 text), INTEGER PRIMARY KEY rowid aliases,
 * columns added later by ALTER TABLE (short records are NULL-padded). Throws Error('unsupported SQLite layout …') for WITHOUT
 * ROWID tables (index b-trees 0x02/0x0A), UTF-16 databases and reserved serial types; Error('not a SQLite file') for garbage;
 * Error('table not found: <name>') when sqlite_master has no such table. The -wal sidecar is NEVER read — rows still sitting in
 * the write-ahead log are invisible until the owning app checkpoints (close the Ollama app first).
 * File format: https://www.sqlite.org/fileformat2.html
 * ================================================================= */
function readSqliteTable(buffer, tableName) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const bad = (why) => new Error('unsupported SQLite layout' + (why ? ' (' + why + ')' : ''));
  const MAGIC = 'SQLite format 3';                                            // 16-byte header string: these 15 chars + one NUL byte (offset 15)
  if (u8.length < 100 || u8[15] !== 0 || [...MAGIC].some((ch, i) => u8[i] !== ch.charCodeAt(0))) throw new Error('not a SQLite file');
  let pageSize = dv.getUint16(16); if (pageSize === 1) pageSize = 65536;   // offset 16: big-endian u16; 1 means 65536
  const usable = pageSize - u8[20];                                         // offset 20: reserved bytes at the END of every page
  const textEnc = dv.getUint32(56);                                          // 1 = UTF-8 (0 on a never-written db); 2/3 = UTF-16 → unsupported
  if (textEnc > 1) throw bad('text encoding ' + textEnc);
  const nPages = Math.floor(u8.length / pageSize);
  const pageOff = (n) => (n - 1) * pageSize;                                 // pages are 1-based
  const dec = new TextDecoder('utf-8');
  // varint: 1–9 bytes, big-endian 7-bit groups; a 9th byte carries all 8 bits
  const varint = (a, pos) => {
    let v = 0;
    for (let i = 0; i < 8; i++) { const b = a[pos + i]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return [v, i + 1]; }
    return [v * 256 + a[pos + 8], 9];
  };
  // table-leaf cell payload: if it does not fit, the local part follows the SQLite formula (X = U-35, M = ((U-12)*32/255)-23,
  // K = M + ((P-M) % (U-4)); local = K ≤ X ? K : M), then a u32 first-overflow-page number; each overflow page = u32 next + data
  const maxLocal = usable - 35, minLocal = Math.floor((usable - 12) * 32 / 255) - 23;
  const readPayload = (pos, size) => {
    if (size <= maxLocal) return u8.subarray(pos, pos + size);
    const K = minLocal + ((size - minLocal) % (usable - 4));
    const local = K <= maxLocal ? K : minLocal;
    const out = new Uint8Array(size);
    out.set(u8.subarray(pos, pos + local), 0);
    let filled = local, next = dv.getUint32(pos + local), guard = 0;
    while (next && filled < size) {
      if (next > nPages || guard++ > nPages) throw bad('overflow chain');
      const o = pageOff(next), chunk = Math.min(usable - 4, size - filled);
      out.set(u8.subarray(o + 4, o + 4 + chunk), filled);
      filled += chunk; next = dv.getUint32(o);
    }
    if (filled < size) throw bad('truncated overflow chain');
    return out;
  };
  // record: varint header size, one serial type per column, then the values back to back
  const decodeRecord = (pay) => {
    const pdv = new DataView(pay.buffer, pay.byteOffset, pay.byteLength);
    const [hdrSize, n0] = varint(pay, 0);
    const types = []; let hp = n0;
    while (hp < hdrSize) { const [t, n] = varint(pay, hp); types.push(t); hp += n; }
    const vals = []; let bp = hdrSize;
    for (const t of types) {
      let v = null, len = 0;
      if (t === 0) v = null;
      else if (t === 1) { v = pdv.getInt8(bp); len = 1; }
      else if (t === 2) { v = pdv.getInt16(bp); len = 2; }
      else if (t === 3) { v = (pdv.getInt8(bp) << 16) | pdv.getUint16(bp + 1); len = 3; }
      else if (t === 4) { v = pdv.getInt32(bp); len = 4; }
      else if (t === 5) { v = pdv.getInt16(bp) * 4294967296 + pdv.getUint32(bp + 2); len = 6; }
      else if (t === 6) { v = Number(pdv.getBigInt64(bp)); len = 8; }
      else if (t === 7) { v = pdv.getFloat64(bp); len = 8; }
      else if (t === 8) v = 0;
      else if (t === 9) v = 1;
      else if (t >= 12 && t % 2 === 0) { len = (t - 12) / 2; v = pay.slice(bp, bp + len); }          // blob
      else if (t >= 13) { len = (t - 13) / 2; v = dec.decode(pay.subarray(bp, bp + len)); }           // text
      else throw bad('serial type ' + t);                                                             // 10, 11 are reserved
      vals.push(v); bp += len;
    }
    return vals;
  };
  // b-tree walk. Page header: type byte, first freeblock u16, cell count u16 (+3), cell content start u16 (+5), fragmented bytes (+7),
  // right-most child u32 (+8, interior only); then the cell pointer array (u16 offsets from the START of the page). Page 1's header
  // sits after the 100-byte file header, but its cell offsets are still relative to byte 0 of the page.
  const walk = (pageNo, onRow, depth) => {
    if (depth > 64 || pageNo < 1 || pageNo > nPages) throw bad('page ' + pageNo);
    const base = pageOff(pageNo), hdr = base + (pageNo === 1 ? 100 : 0);
    const type = u8[hdr], nCells = dv.getUint16(hdr + 3);
    if (type === 0x0D) {                                                      // table leaf: cells = varint payload size, varint rowid, payload
      for (let i = 0; i < nCells; i++) {
        const cell = base + dv.getUint16(hdr + 8 + i * 2);
        const [size, a] = varint(u8, cell), [rowid, b] = varint(u8, cell + a);
        onRow(rowid, decodeRecord(readPayload(cell + a + b, size)));
      }
    } else if (type === 0x05) {                                               // table interior: cells = u32 left child, varint key (unused); then the right-most child
      for (let i = 0; i < nCells; i++) walk(dv.getUint32(base + dv.getUint16(hdr + 12 + i * 2)), onRow, depth + 1);
      walk(dv.getUint32(hdr + 8), onRow, depth + 1);
    } else throw bad('page type 0x' + type.toString(16));                     // 0x02 / 0x0A = index b-tree (WITHOUT ROWID tables live there)
  };
  // sqlite_master is the table b-tree rooted at page 1: columns type, name, tbl_name, rootpage, sql
  let master = null;
  walk(1, (rowid, r) => { if (!master && r[0] === 'table' && String(r[1]).toLowerCase() === String(tableName).toLowerCase()) master = r; }, 0);
  if (!master) throw new Error('table not found: ' + tableName);
  const sql = String(master[4] || '');
  if (/WITHOUT\s+ROWID/i.test(sql)) throw bad('WITHOUT ROWID');
  // column names from CREATE TABLE: the parenthesized list split on commas at depth 0, first token per entry (quotes stripped);
  // table constraints (PRIMARY KEY(…), UNIQUE, CHECK, FOREIGN KEY, CONSTRAINT) are not columns
  const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
  const parts = []; let d = 0, cur = '';
  for (const ch of body) { if (ch === '(') d++; else if (ch === ')') d--; if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch; }
  parts.push(cur);
  const columns = [], rowidAlias = [];
  for (const p of parts) {
    const s = p.trim(); if (!s || /^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b/i.test(s)) continue;
    const m = /^("([^"]*)"|`([^`]*)`|\[([^\]]*)\]|'([^']*)'|([^\s]+))\s*([\s\S]*)$/.exec(s);
    const name = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6];
    if (/^INTEGER\s+PRIMARY\s+KEY\b/i.test(m[7] || '')) rowidAlias.push(columns.length);   // rowid alias: the record holds NULL, the cell's rowid is the value
    columns.push(name);
  }
  const rows = [];
  walk(master[3], (rowid, vals) => {
    while (vals.length < columns.length) vals.push(null);   // columns added by ALTER TABLE are absent from older records
    for (const i of rowidAlias) if (vals[i] == null) vals[i] = rowid;
    rows.push(vals.slice(0, columns.length));
  }, 0);
  return { columns, rows };
}

