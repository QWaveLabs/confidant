// Small file helpers. Every JSON write is atomic (temp file then rename) so a
// crash or a killed scheduled run never leaves half a file behind.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`Could not read ${path}: ${err.message}`);
  }
}

export function writeFileAtomic(path, content) {
  ensureDir(dirname(path));
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function writeJson(path, value) {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function* readJsonl(path) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (t) yield JSON.parse(t);
  }
}

export function appendJsonl(path, rows) {
  ensureDir(dirname(path));
  appendFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}
