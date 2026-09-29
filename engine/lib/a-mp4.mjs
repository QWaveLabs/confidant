// MP4 / QuickTime atom walker, for the transcript Voice Memos stores inside
// its own audio files:
//   .m4a  moov/trak/udta/tsrp          (JSON)
//   .qta  moov/meta keys + ilst item   key "com.apple.VoiceMemos.tsrp"
// The JSON is { attributedString: { runs: ["Hello", 0, " world", 1],
// attributeTable: [{ timeRange: [0, 1.2] }, ...] }, locale }.
// Only the small moov atom is read into memory; mdat (the audio) is skipped.
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'meta', 'ilst', 'edts', 'dinf', 'mvex', 'moof', 'traf']);
const TSRP_KEY = 'com.apple.VoiceMemos.tsrp';
const MAX_MOOV = 64 * 1024 * 1024;

// Atoms directly inside buf[start, end): { type, start, body, end }.
export function* atoms(buf, start = 0, end = buf.length) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return;
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) size = end - pos;
    if (size < header || pos + size > end) return;
    yield { type, start: pos, body: pos + header, end: pos + size };
    pos += size;
  }
}

// QuickTime 'meta' has children right away; ISO 'meta' has 4 bytes of
// version and flags first.
function childStart(buf, atom) {
  if (atom.type !== 'meta') return atom.body;
  return buf.toString('latin1', atom.body + 4, atom.body + 8) === 'hdlr' ? atom.body : atom.body + 4;
}

export function findAtoms(buf, type, start = 0, end = buf.length, out = []) {
  for (const a of atoms(buf, start, end)) {
    if (a.type === type) out.push(a);
    if (CONTAINERS.has(a.type)) findAtoms(buf, type, childStart(buf, a), a.end, out);
  }
  return out;
}

// QuickTime metadata: 'keys' lists names, 'ilst' items are numbered by key.
function metadataValue(buf, keyName) {
  for (const meta of findAtoms(buf, 'meta')) {
    const start = childStart(buf, meta);
    let keys = [];
    let ilst = null;
    for (const a of atoms(buf, start, meta.end)) {
      if (a.type === 'keys') {
        keys = [];
        let pos = a.body + 8; // version/flags + entry count
        while (pos + 8 <= a.end) {
          const size = buf.readUInt32BE(pos);
          if (size < 8 || pos + size > a.end) break;
          keys.push(buf.toString('utf8', pos + 8, pos + size));
          pos += size;
        }
      } else if (a.type === 'ilst') ilst = a;
    }
    const index = keys.indexOf(keyName) + 1;
    if (!index || !ilst) continue;
    for (const item of atoms(buf, ilst.body, ilst.end)) {
      if (buf.readUInt32BE(item.start + 4) !== index) continue;
      for (const d of atoms(buf, item.body, item.end)) {
        if (d.type === 'data') return buf.subarray(d.body + 8, d.end);
      }
    }
  }
  return null;
}

function jsonAt(buf, from) {
  const s = buf.toString('utf8', from);
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return s.slice(0, i + 1);
  }
  return null;
}

// Transcript JSON -> { text, segments: [{ start, end, text }], locale }.
export function parseTranscriptJson(json) {
  let obj;
  try {
    obj = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return null;
  }
  const as = obj?.attributedString ?? obj;
  const runs = Array.isArray(as) ? as : as?.runs;
  if (!Array.isArray(runs)) return null;
  const table = as?.attributeTable ?? obj?.attributeTable ?? [];
  let text = '';
  const segments = [];
  for (let i = 0; i < runs.length; i++) {
    if (typeof runs[i] !== 'string') continue;
    text += runs[i];
    const idx = runs[i + 1];
    const range = typeof idx === 'number' ? table[idx]?.timeRange : null;
    if (Array.isArray(range)) segments.push({ start: range[0], end: range[1], text: runs[i] });
  }
  text = text.replace(/[ \t]+/g, ' ').trim();
  return text ? { text, segments, locale: obj?.locale?.identifier ?? null } : null;
}

export function transcriptFromMoov(moov) {
  for (const a of findAtoms(moov, 'tsrp')) {
    const brace = moov.indexOf(0x7b, a.body);
    if (brace < 0 || brace >= a.end) continue;
    const parsed = parseTranscriptJson(jsonAt(moov.subarray(0, a.end), brace));
    if (parsed) return parsed;
  }
  const value = metadataValue(moov, TSRP_KEY);
  if (value) {
    const brace = value.indexOf(0x7b);
    const parsed = brace >= 0 ? parseTranscriptJson(jsonAt(value, brace)) : null;
    if (parsed) return parsed;
  }
  const marker = moov.indexOf('{"attributedString"');
  if (marker >= 0) return parseTranscriptJson(jsonAt(moov, marker));
  return null;
}

// Reads the moov atom of an audio file and returns its transcript, or null.
export function readAudioTranscript(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const total = fstatSync(fd).size;
    const head = Buffer.alloc(16);
    let pos = 0;
    while (pos + 8 <= total) {
      readSync(fd, head, 0, 16, pos);
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (size === 1) size = Number(head.readBigUInt64BE(8));
      else if (size === 0) size = total - pos;
      if (size < 8) return null;
      if (type === 'moov') {
        if (size > MAX_MOOV) return null;
        const moov = Buffer.alloc(size);
        readSync(fd, moov, 0, size, pos);
        return transcriptFromMoov(moov);
      }
      pos += size;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Atom writer for test fixtures.
export function atom(type, ...children) {
  const body = Buffer.concat(children.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}
