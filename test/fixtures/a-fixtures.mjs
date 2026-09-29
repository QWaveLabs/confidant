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

// A stored (uncompressed) ZIP built in code, for WhatsApp export fixtures.
import { crc32 } from 'node:zlib';
export function zipBuffer(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = Object.keys(entries).length;
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
