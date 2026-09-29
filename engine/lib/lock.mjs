// One writer at a time. Scheduled tasks overlap (a 3-hour update can still be
// running when the brief fires), so anything that writes notes takes a lock.
import { openSync, closeSync, writeSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from './files.mjs';

export function acquireLock(paths, name = 'vault', { staleMs = 2 * 3600 * 1000, now = Date.now() } = {}) {
  ensureDir(paths.locks);
  const file = join(paths.locks, `${name}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }));
      closeSync(fd);
      return {
        file,
        release() {
          try { unlinkSync(file); } catch {}
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = Infinity;
      try { age = now - statSync(file).mtimeMs; } catch {}
      if (age > staleMs) {
        try { unlinkSync(file); } catch {}
        continue;
      }
      let holder = null;
      try { holder = JSON.parse(readFileSync(file, 'utf8')); } catch {}
      return { held: true, holder };
    }
  }
  return { held: true, holder: null };
}
