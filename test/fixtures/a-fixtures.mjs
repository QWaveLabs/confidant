// Fixture helpers for Unit A tests. Every fixture is built in code inside a
// temp "home" that mirrors ~/Library, so tests never touch real app data.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openMemoryStore } from '../../engine/lib/store.mjs';
import { extractSource } from '../../engine/extract/index.mjs';
import { getSource } from '../../engine/lib/sources.mjs';
import { check } from '../../engine/lib/schema.mjs';
import { closeCopies } from '../../engine/lib/a-local.mjs';
import { resetContactNames } from '../../engine/lib/a-addressbook.mjs';

export const APPLE_EPOCH = 978307200;
export const appleSeconds = (iso) => new Date(iso).getTime() / 1000 - APPLE_EPOCH;
export const appleNanos = (iso) => BigInt(Math.round(appleSeconds(iso))) * 1000000000n;

export function tempHome() {
  return mkdtempSync(join(tmpdir(), 'cf-a-home-'));
}

export function makeCtx({ home = tempHome(), config = {}, lang = 'en', tz = 'America/New_York', now = new Date('2026-09-28T16:00:00Z'), transcriber } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'cf-a-tmp-'));
  const vault = mkdtempSync(join(tmpdir(), 'cf-a-vault-'));
  const store = openMemoryStore();
  const warnings = [];
  const ctx = {
    home,
    vault,
    paths: { vault, root: join(vault, '.confidant'), tmp, exports: join(vault, '.confidant', 'exports') },
    config: { version: 1, vault, language: lang, role: 'founder', briefTime: '08:00', timezone: tz, sources: {}, owner: { name: 'Rob Hernandez', emails: ['rob@qwave.test'], phones: ['+1 305 555 0100'] }, ...config },
    state: {},
    store,
    lang,
    tz,
    now,
    dryRun: false,
    json: false,
    log: { info() {}, warn: (m) => warnings.push(m), error: (m) => warnings.push(m), out() {} },
    warnings,
    tmpDir: () => tmp,
    close() {},
  };
  if (transcriber !== undefined) ctx.transcriber = transcriber;
  return ctx;
}

// Creates a SQLite database at home-relative path parts with the given DDL.
export function createDb(file, ddl) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(ddl);
  return db;
}

export function insert(db, table, rows) {
  for (const row of [].concat(rows)) {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
  }
}

export function writeFile(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

// Fresh state between runs of the same test (source copies and name maps).
export function resetCaches() {
  closeCopies();
  resetContactNames();
}

// Runs the real extract runner: schema validation, privacy filter, store, cursor.
export async function runSource(ctx, id, opts = {}) {
  resetCaches();
  return extractSource(ctx, getSource(id), { limit: 50, ...opts });
}

export function schemaErrors(records) {
  return records.flatMap((r) => check('record', r).map((e) => `${r.id}: ${e}`));
}

// No real text in failures: ids only.
export const ids = (records) => records.map((r) => r.id).sort();
