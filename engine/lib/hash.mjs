import { createHash } from 'node:crypto';

export const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');
export const shortHash = (s, n = 12) => sha1(s).slice(0, n);

// Stable fingerprint for "is this the same fact?" checks: case, spacing and
// punctuation differences do not create duplicates.
export function fingerprint(...parts) {
  const norm = parts
    .flat()
    .map((p) => String(p ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim())
    .join('|');
  return shortHash(norm, 16);
}
