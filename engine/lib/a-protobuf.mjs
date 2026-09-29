// A tiny protobuf wire-format reader: enough to pull the text and attachment
// references out of an Apple Notes body (ZICNOTEDATA.ZDATA, gzipped
// NoteStoreProto). No schema needed: we walk field numbers.
//   NoteStoreProto.document (2) -> Document.note (3) -> Note.note_text (2)
//   Note.attribute_run (5) -> AttributeRun.attachment_info (12) -> identifier (1), type_uti (2)
import { gunzipSync, inflateSync } from 'node:zlib';

export function readVarint(buf, pos) {
  let value = 0;
  let mult = 1;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new RangeError('truncated varint');
    const b = buf[pos++];
    value += (b & 0x7f) * mult;
    if (!(b & 0x80)) return [value, pos];
    mult *= 128;
  }
  throw new RangeError('varint too long');
}

// Yields { field, wire, value } where value is a number (varint, fixed) or a
// Buffer (length-delimited). Groups are skipped.
export function* fields(buf) {
  let pos = 0;
  while (pos < buf.length) {
    const [tag, p1] = readVarint(buf, pos);
    pos = p1;
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) {
      const [v, p2] = readVarint(buf, pos);
      pos = p2;
      yield { field, wire, value: v };
    } else if (wire === 1) {
      if (pos + 8 > buf.length) throw new RangeError('truncated fixed64');
      yield { field, wire, value: buf.readDoubleLE(pos) };
      pos += 8;
    } else if (wire === 2) {
      const [len, p2] = readVarint(buf, pos);
      if (p2 + len > buf.length) throw new RangeError('truncated bytes');
      yield { field, wire, value: buf.subarray(p2, p2 + len) };
      pos = p2 + len;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) throw new RangeError('truncated fixed32');
      yield { field, wire, value: buf.readFloatLE(pos) };
      pos += 4;
    } else if (wire === 3 || wire === 4) {
      continue; // deprecated groups carry no payload of their own
    } else throw new RangeError(`unknown wire type ${wire}`);
  }
}

export function first(buf, field) {
  for (const f of fields(buf)) if (f.field === field) return f.value;
  return undefined;
}

export function all(buf, field) {
  const out = [];
  for (const f of fields(buf)) if (f.field === field) out.push(f.value);
  return out;
}

// Follow nested length-delimited fields: path(buf, 2, 3, 2).
export function path(buf, ...nums) {
  let cur = buf;
  for (const n of nums) {
    if (!Buffer.isBuffer(cur)) return undefined;
    cur = first(cur, n);
    if (cur === undefined) return undefined;
  }
  return cur;
}

export function unzipMaybe(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf);
  if (buf[0] === 0x78) {
    try {
      return inflateSync(buf);
    } catch {}
  }
  return buf;
}

// Apple Notes body -> { text, attachments: [{ id, uti }] }. null if unreadable.
export function decodeNoteBody(zdata) {
  if (zdata == null) return null;
  try {
    const note = path(unzipMaybe(zdata), 2, 3);
    if (!note) return null;
    const textBuf = first(note, 2);
    const attachments = [];
    for (const run of all(note, 5)) {
      const info = Buffer.isBuffer(run) ? first(run, 12) : undefined;
      if (!Buffer.isBuffer(info)) continue;
      const id = first(info, 1);
      const uti = first(info, 2);
      if (Buffer.isBuffer(id)) attachments.push({ id: id.toString('utf8'), uti: Buffer.isBuffer(uti) ? uti.toString('utf8') : null });
    }
    return { text: Buffer.isBuffer(textBuf) ? textBuf.toString('utf8') : '', attachments };
  } catch {
    return null;
  }
}

// Writer used by tests to build fixtures (and handy for round trips).
export function encodeVarint(n) {
  const out = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return Buffer.from(out);
}

export function encodeField(field, value) {
  if (typeof value === 'number') return Buffer.concat([encodeVarint(field * 8), encodeVarint(value)]);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return Buffer.concat([encodeVarint(field * 8 + 2), encodeVarint(bytes.length), bytes]);
}

export const encodeMessage = (...parts) => Buffer.concat(parts);
