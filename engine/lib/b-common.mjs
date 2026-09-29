// Shared plumbing for identity, dossiers, batches, merge, mocs and undo:
// where Unit B keeps its files, its tables in brain.db, the vault lock, the
// privacy scrub, and state.json patches.
import { join } from 'node:path';
import { readFileSync, unlinkSync } from 'node:fs';
import { acquireLock } from './lock.mjs';
import { readJson, writeJson } from './files.mjs';
import { getSource } from './sources.mjs';
import { t } from './i18n.mjs';

export function bPaths(ctx) {
  const root = ctx.paths.root;
  return {
    identity: join(root, 'identity.json'),
    fixes: join(root, 'identity-fixes.json'),
    dossiers: join(root, 'dossiers'),
    batches: ctx.paths.batches,
    contrib: ctx.paths.contrib,
    backups: ctx.paths.backups,
    batch: (id) => join(ctx.paths.batches, `${id}.json`),
    contribution: (id) => join(ctx.paths.contrib, `${id}.json`),
  };
}

// ---------- tables in brain.db ----------

const TABLES = `
CREATE TABLE IF NOT EXISTS b_batches (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  path TEXT NOT NULL,
  output TEXT NOT NULL,
  since TEXT,
  until TEXT,
  est_tokens INTEGER NOT NULL DEFAULT 0,
  items INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  handed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  merged_at TEXT,
  run_id TEXT,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS b_batches_scope ON b_batches(scope, status, seq);
CREATE TABLE IF NOT EXISTS b_notes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  path TEXT,
  title TEXT NOT NULL,
  norm TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_run TEXT,
  updated_run TEXT
);
CREATE INDEX IF NOT EXISTS b_notes_type ON b_notes(type, norm);
CREATE TABLE IF NOT EXISTS b_items (
  fp TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  section TEXT NOT NULL,
  date TEXT,
  text TEXT,
  refs TEXT NOT NULL DEFAULT '[]',
  run_id TEXT,
  batch_id TEXT,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS b_items_target ON b_items(target, section);
CREATE INDEX IF NOT EXISTS b_items_run ON b_items(run_id);
CREATE TABLE IF NOT EXISTS b_runs (
  id TEXT PRIMARY KEY,
  batch_id TEXT,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  undone_at TEXT
);
`;

const ready = new WeakSet();
export function bTables(store) {
  if (!ready.has(store)) {
    store.ensureTable(TABLES);
    ready.add(store);
  }
  return store.db;
}

// ---------- the vault lock ----------

const heldHere = new Map();

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function holderAlive(pid) {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

// Returns a release function. Re-entrant inside one process, so a command
// that already holds the lock (for example `confidant update`) can call
// mergeBatch or buildMocs directly. Waits for another process up to timeoutMs.
export function takeLock(ctx, name = 'vault', { timeoutMs = 120000 } = {}) {
  if (ctx.dryRun) return () => {};
  const key = join(ctx.paths.locks, name);
  if (heldHere.get(key)) {
    heldHere.set(key, heldHere.get(key) + 1);
    return () => heldHere.set(key, heldHere.get(key) - 1);
  }
  const start = Date.now();
  for (;;) {
    const lock = acquireLock(ctx.paths, name);
    if (lock.release) {
      heldHere.set(key, 1);
      let done = false;
      return () => {
        if (done) return;
        const n = heldHere.get(key) - 1;
        if (n > 0) return heldHere.set(key, n);
        done = true;
        heldHere.delete(key);
        lock.release();
      };
    }
    if (lock.holder?.pid === process.pid) return () => {};
    if (lock.holder?.pid && !holderAlive(lock.holder.pid)) {
      try { unlinkSync(join(ctx.paths.locks, `${name}.lock`)); } catch {}
      continue;
    }
    if (Date.now() - start > timeoutMs) {
      const err = new Error(`The second brain is busy (another run holds the ${name} lock). Try again in a minute.`);
      err.code = 'EBUSY';
      throw err;
    }
    sleepSync(200);
  }
}

// ---------- privacy scrub (Unit A), with a pass-through fallback ----------

const asText = (fn) => (s) => {
  const out = fn(s);
  return typeof out === 'string' ? out : (out?.text ?? s);
};

let moduleScrub = null;
// ctx.scrubText (same signature as privacy.scrubText) wins when set, so a
// caller or a test can decide what "scrubbed" means for one context. The
// module lookup is cached; a ctx override never is.
export async function loadScrub(ctx) {
  if (typeof ctx?.scrubText === 'function') return asText(ctx.scrubText);
  if (moduleScrub) return moduleScrub;
  let fn = (s) => s;
  try {
    const mod = await import('../privacy.mjs');
    if (typeof mod.scrubText === 'function') fn = asText(mod.scrubText);
  } catch {}
  moduleScrub = fn;
  return fn;
}

// Deep copy with every string passed through fn.
export function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn);
    return out;
  }
  return value;
}

// ---------- state.json ----------

// Re-reads state from disk so a concurrent writer's other keys survive.
export function patchState(ctx, patch) {
  const current = readJson(ctx.paths.state, ctx.state ?? { phase: 'start', history: [] }) ?? {};
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    next[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(current[k] ?? {}), ...v } : v;
  }
  ctx.state = next;
  if (!ctx.dryRun) writeJson(ctx.paths.state, next);
  return next;
}

// ---------- labels ----------

export function sourceLabel(sourceId, lang = 'en') {
  const tr = t('notes', lang);
  const key = `source.${sourceId}`;
  const v = tr(key);
  if (v !== key) return v;
  return getSource(sourceId)?.label?.[lang] ?? getSource(sourceId)?.label?.en ?? sourceId;
}

export const refSource = (ref) => String(ref).split(':')[0];

export function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export const isoNow = (ctx) => (ctx.now instanceof Date ? ctx.now : new Date(ctx.now ?? Date.now())).toISOString();
