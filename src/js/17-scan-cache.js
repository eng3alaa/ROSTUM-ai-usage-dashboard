/** ScanCache key prefix — bump whenever a parser's OUTPUT changes for unchanged bytes (cached per-file entries
 *  would otherwise serve pre-fix rows forever for finished files). History: 'scan:' → v3 (per-hour granularity,
 *  connector-prefixed signatures) → v4 (Roo/Cline inclusive tokensIn + per-request model, local:1 flags, Gemini CLI
 *  tool tokens) → v5 (folder-log project rows) → v6 (Codex per-turn last_token_usage; dupIds / dupTruncated entries). prune() sweeps
 *  EVERY older-version key so IDB keeps no dead entries. */
const SCAN_CACHE_VER = 'scan:v6:';   // v6 (Plan 5 review): T3 books Codex per-turn last_token_usage — output changed for unchanged bytes — and T2's dupIds / dupOnly entries need a rewrite (pre-T2 entries carry none) → one-time re-parse. v5: folder-log parsers emit project rows (Plan 4b T15)
const ScanCache = {
  async get(sig) { try { return await IDB.get(SCAN_CACHE_VER + sig); } catch { return null; } },
  async set(sig, entry) { try { await IDB.set(SCAN_CACHE_VER + sig, entry); } catch {} },
  // deletes stale keys for ONE connector (prefix = '<connectorId>\u0001'): keys from any OLDER cache version
  // (legacy 'scan:', 'scan:v3:', …) and current-version keys with the old 3-field signature (no connector
  // prefix) are swept regardless; other connectors' current entries are left alone.
  async prune(keep, prefix) {
    try {
      const keys = await IDB.keys('scan:');
      for (const k of keys) {
        const sig = k.startsWith(SCAN_CACHE_VER) ? k.slice(SCAN_CACHE_VER.length) : null;   // any older version ('scan:', 'scan:v3:', …) → deleted below
        if (sig === null || sig.split('\u0001').length < 4) { await IDB.del(k); continue; }
        if (prefix && !sig.startsWith(prefix)) continue;
        if (!keep.has(sig)) await IDB.del(k);
      }
    } catch {}
  },
};

