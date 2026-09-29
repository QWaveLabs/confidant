// The raw store: every extracted record lives in <vault>/.confidant/brain.db.
// Records are the only shared input between extractors and the sorter.
// Units that need their own tables create them with store.ensureTable().
import { DatabaseSync } from 'node:sqlite';
import { ensureDir } from './files.mjs';
import { sha1 } from './hash.mjs';
import { toMs } from './time.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  thread TEXT,
  ts TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  from_handle TEXT,
  from_name TEXT,
  to_json TEXT NOT NULL DEFAULT '[]',
  is_from_me INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  text TEXT NOT NULL DEFAULT '',
  url TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  hash TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS records_source_ts ON records(source, ts_ms);
CREATE INDEX IF NOT EXISTS records_thread_ts ON records(thread, ts_ms);
CREATE INDEX IF NOT EXISTS records_changed ON records(changed_at);
CREATE INDEX IF NOT EXISTS records_from ON records(from_handle);
CREATE TABLE IF NOT EXISTS cursors (
  source TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

const recordHash = (r) => sha1(JSON.stringify([r.ts, r.title ?? '', r.text ?? '', r.from ?? null, r.to ?? [], r.meta ?? {}]));

export function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    thread: row.thread,
    ts: row.ts,
    from: row.from_handle || row.from_name ? { handle: row.from_handle, name: row.from_name } : null,
    to: JSON.parse(row.to_json),
    is_from_me: !!row.is_from_me,
    title: row.title,
    text: row.text,
    url: row.url,
    meta: JSON.parse(row.meta_json),
  };
}

export class Store {
  constructor(db) {
    this.db = db;
    this.db.exec(SCHEMA);
    this.#insert = db.prepare(`INSERT OR IGNORE INTO records
      (id, source, kind, thread, ts, ts_ms, from_handle, from_name, to_json, is_from_me, title, text, url, meta_json, hash, ingested_at, changed_at)
      VALUES ($id, $source, $kind, $thread, $ts, $ts_ms, $from_handle, $from_name, $to_json, $is_from_me, $title, $text, $url, $meta_json, $hash, $now, $now)`);
    this.#update = db.prepare(`UPDATE records SET kind=$kind, thread=$thread, ts=$ts, ts_ms=$ts_ms, from_handle=$from_handle, from_name=$from_name,
      to_json=$to_json, is_from_me=$is_from_me, title=$title, text=$text, url=$url, meta_json=$meta_json, hash=$hash, changed_at=$now
      WHERE id=$id AND hash<>$hash`);
    this.#update.setAllowUnknownNamedParameters(true);
  }

  #insert;
  #update;

  // Insert new records, refresh changed ones (a transcript that arrived late,
  // an edited message). Returns counts. Records must already be valid.
  upsertRecords(records, now = new Date().toISOString()) {
    const counts = { inserted: 0, updated: 0, unchanged: 0 };
    if (!records.length) return counts;
    this.db.exec('BEGIN');
    try {
      for (const r of records) {
        const params = {
          $id: r.id,
          $source: r.source,
          $kind: r.kind,
          $thread: r.thread ?? null,
          $ts: r.ts,
          $ts_ms: toMs(r.ts),
          $from_handle: r.from?.handle ?? null,
          $from_name: r.from?.name ?? null,
          $to_json: JSON.stringify(r.to ?? []),
          $is_from_me: r.is_from_me ? 1 : 0,
          $title: r.title ?? null,
          $text: r.text ?? '',
          $url: r.url ?? null,
          $meta_json: JSON.stringify(r.meta ?? {}),
          $hash: recordHash(r),
          $now: now,
        };
        if (this.#insert.run(params).changes) counts.inserted++;
        else if (this.#update.run(params).changes) counts.updated++;
        else counts.unchanged++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return counts;
  }

  // Flexible read used by identity, dossiers and digests.
  records({ source, sources, kind, thread, since, until, changedSince, fromHandle, limit, order = 'asc' } = {}) {
    const where = [];
    const params = {};
    if (source) { where.push('source = $source'); params.$source = source; }
    if (sources?.length) { where.push(`source IN (${sources.map((_, i) => `$s${i}`).join(',')})`); sources.forEach((s, i) => (params[`$s${i}`] = s)); }
    if (kind) { where.push('kind = $kind'); params.$kind = kind; }
    if (thread) { where.push('thread = $thread'); params.$thread = thread; }
    if (since) { where.push('ts_ms >= $since'); params.$since = toMs(since); }
    if (until) { where.push('ts_ms < $until'); params.$until = toMs(until); }
    if (changedSince) { where.push('changed_at > $changed'); params.$changed = changedSince; }
    if (fromHandle) { where.push('from_handle = $fh'); params.$fh = fromHandle; }
    const sql = `SELECT * FROM records ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts_ms ${order === 'desc' ? 'DESC' : 'ASC'}${limit ? ` LIMIT ${Number(limit)}` : ''}`;
    return this.db.prepare(sql).all(params).map(rowToRecord);
  }

  record(id) {
    return rowToRecord(this.db.prepare('SELECT * FROM records WHERE id = ?').get(id));
  }

  counts() {
    return this.db.prepare('SELECT source, kind, COUNT(*) n, MIN(ts) first, MAX(ts) last FROM records GROUP BY source, kind ORDER BY source').all();
  }

  getCursor(source) {
    return this.db.prepare('SELECT value FROM cursors WHERE source = ?').get(source)?.value ?? null;
  }

  setCursor(source, value, now = new Date().toISOString()) {
    this.db.prepare('INSERT INTO cursors (source, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(source, value == null ? null : String(value), now);
  }

  // Every cursor whose key starts with `prefix` (an app source keeps several,
  // e.g. gmail_live and gmail_window), as [{ key, value, updated_at }].
  cursorsWithPrefix(prefix) {
    return this.db.prepare('SELECT source AS key, value, updated_at FROM cursors WHERE substr(source, 1, ?) = ? ORDER BY source').all(prefix.length, prefix);
  }

  getMeta(key, fallback = null) {
    const v = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
    return v == null ? fallback : JSON.parse(v);
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }

  ensureTable(sql) {
    this.db.exec(sql);
  }

  close() {
    this.db.close();
  }
}

export function openStore(paths) {
  ensureDir(paths.root);
  const db = new DatabaseSync(paths.db);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  return new Store(db);
}

export function openMemoryStore() {
  return new Store(new DatabaseSync(':memory:'));
}
