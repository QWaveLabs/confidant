// Reading other apps' live SQLite databases safely. We never open the
// original: we copy the database with its -wal and -shm files into
// .confidant/tmp and read the copy. That avoids locking Messages or WhatsApp
// and works under the Codex sandbox, which blocks writing -shm in place.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, openSync, closeSync, rmSync, constants } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDir } from './files.mjs';

// { ok: true } or { ok: false, code: 'EPERM' | 'ENOENT' | ... }.
// EPERM on an Apple database almost always means Full Disk Access is missing.
export function canRead(path) {
  try {
    closeSync(openSync(path, 'r'));
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err.code, needsFullDiskAccess: err.code === 'EPERM' || err.code === 'EACCES' };
  }
}

export function openSourceCopy(srcPath, tmpRoot) {
  const access = canRead(srcPath);
  if (!access.ok) {
    const err = new Error(`Cannot read ${srcPath} (${access.code})`);
    err.code = access.code;
    err.needsFullDiskAccess = access.needsFullDiskAccess;
    throw err;
  }
  const dir = ensureDir(join(tmpRoot, `copy-${randomUUID().slice(0, 8)}`));
  const dest = join(dir, basename(srcPath));
  // COPYFILE_FICLONE makes an instant APFS clone when possible and falls back
  // to a normal copy, so a multi-gigabyte chat.db costs nothing to snapshot.
  copyFileSync(srcPath, dest, constants.COPYFILE_FICLONE);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(srcPath + suffix)) copyFileSync(srcPath + suffix, dest + suffix, constants.COPYFILE_FICLONE);
  }
  const db = new DatabaseSync(dest);
  return {
    db,
    path: dest,
    close() {
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Convenience: run fn(db) against a copy and always clean up.
export function withSourceCopy(srcPath, tmpRoot, fn) {
  const copy = openSourceCopy(srcPath, tmpRoot);
  try {
    return fn(copy.db);
  } finally {
    copy.close();
  }
}

// node:sqlite returns BLOB columns as Uint8Array.
export const toBuffer = (v) => (v == null ? null : Buffer.isBuffer(v) ? v : Buffer.from(v));
