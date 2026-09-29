// One writer at a time. Scheduled tasks overlap (a 3-hour update can still be
// running when the brief fires), so anything that writes notes takes a lock.
import { openSync, closeSync, writeSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDir } from './files.mjs';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function acquireLock(paths, name = 'vault', { staleMs = 2 * 3600 * 1000, now = Date.now() } = {}) {
  ensureDir(paths.locks);
  const file = join(paths.locks, `${name}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      const token = randomUUID();
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString(), token }));
      closeSync(fd);
      return {
        file,
        // Only ever removes our own lock: if it was taken over while we ran,
        // the new holder's file stays.
        release() {
          try {
            if (JSON.parse(readFileSync(file, 'utf8')).token !== token) return;
          } catch {
            return;
          }
          try { unlinkSync(file); } catch {}
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = Infinity;
      try { age = now - statSync(file).mtimeMs; } catch {}
      let holder = null;
      try { holder = JSON.parse(readFileSync(file, 'utf8')); } catch {}
      // A lock whose process is gone (a killed run) is taken over at once,
      // and so is an unreadable one older than a minute.
      const dead = holder?.pid ? holder.pid !== process.pid && !alive(holder.pid) : age > 60000;
      if (age > staleMs || dead) {
        try { unlinkSync(file); } catch {}
        continue;
      }
      return { held: true, holder };
    }
  }
  return { held: true, holder: null };
}
