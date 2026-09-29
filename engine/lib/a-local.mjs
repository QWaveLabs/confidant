// Shared plumbing for the local extractors (Unit A): where each Mac app keeps
// its data, cached database copies, schema checks, cursors, pagers, the owner's
// own handles, and the transcription fallback.
//
// Tests point ctx.home at a temp folder that mirrors ~/Library, so nothing here
// ever needs the real home folder.
import { existsSync, statSync, readdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { canRead, openSourceCopy } from './sqlite.mjs';
import { normalizeEmail, normalizePhone, phoneHandle, emailHandle, last10, parseHandle } from './handles.mjs';
import { notOk } from './a-reasons.mjs';

export const homeOf = (ctx) => ctx?.home ?? homedir();
export const libraryPath = (ctx, ...parts) => join(homeOf(ctx), 'Library', ...parts);

export function tmpRoot(ctx) {
  if (typeof ctx?.tmpDir === 'function') {
    try {
      return ctx.tmpDir();
    } catch {}
  }
  return mkdtempSync(join(tmpdir(), 'confidant-a-'));
}

// Errors that mean "grant Full Disk Access" carry err.needsFullDiskAccess.
export function accessError(err, path) {
  if (err.code === 'EPERM' || err.code === 'EACCES') err.needsFullDiskAccess = true;
  if (!err.message.includes(path)) err.message = `${err.message} (${path})`;
  return err;
}

// Probe helper: null when the file is readable, otherwise a coded probe result.
export function unreadable(ctx, sourceId, path, what) {
  if (!existsSync(path)) return notOk(ctx, sourceId, 'not_installed', `${what} not found on this Mac`);
  const access = canRead(path);
  if (access.ok) return null;
  return access.needsFullDiskAccess ? notOk(ctx, sourceId, 'needs_full_disk_access') : notOk(ctx, sourceId, 'unreadable', `cannot read ${what} (${access.code})`);
}

export function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// Copies of Apple databases, reused across pages of one run. A 2 GB chat.db is
// copied once per process, not once per page. A changed source (new mtime or
// size on the db or its -wal) gets a fresh copy.
const copies = new Map();

function sourceSig(src) {
  return ['', '-wal']
    .map((s) => {
      try {
        const st = statSync(src + s);
        return `${st.size}:${st.mtimeMs}`;
      } catch {
        return '-';
      }
    })
    .join('|');
}

export function openCopy(ctx, src) {
  const sig = sourceSig(src);
  const hit = copies.get(src);
  if (hit && hit.sig === sig) return hit.copy.db;
  if (hit) {
    hit.copy.close();
    copies.delete(src);
  }
  let copy;
  try {
    copy = openSourceCopy(src, tmpRoot(ctx));
  } catch (err) {
    throw accessError(err, src);
  }
  copies.set(src, { sig, copy });
  return copy.db;
}

export function closeCopies() {
  for (const { copy } of copies.values()) copy.close();
  copies.clear();
}
process.once('exit', closeCopies);

// Schema drift: Apple reshapes these databases between macOS releases, so
// every query asks which columns exist first. Names compare case-insensitively.
export function tableNames(db) {
  const out = new Map();
  for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all()) out.set(r.name.toLowerCase(), r.name);
  return out;
}

export function columns(db, table) {
  const set = new Set();
  try {
    for (const c of db.prepare(`PRAGMA table_info("${table}")`).all()) set.add(c.name.toLowerCase());
  } catch {}
  return {
    has: (name) => set.has(String(name).toLowerCase()),
    size: set.size,
    // `expr AS alias` when the column exists, otherwise `NULL AS alias`.
    pick: (name, alias = name, expr) => (set.has(String(name).toLowerCase()) ? `${expr ?? name} AS ${alias}` : `NULL AS ${alias}`),
    first: (...names) => names.find((n) => set.has(n.toLowerCase())) ?? null,
  };
}

export function readCursor(cursor) {
  if (cursor == null || cursor === '') return null;
  try {
    const v = JSON.parse(cursor);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { legacy: v };
  } catch {
    return { legacy: cursor };
  }
}
export const writeCursor = (value) => JSON.stringify(value);

// Newest first, then keep up. For tables with a growing integer key (ROWID,
// Z_PK). The first run walks backwards from the newest row, so an interrupted
// install still has the most recent history. Later runs pick up new rows above
// the high mark. cursor: { hi, lo, back } where back = still backfilling.
//   fetchAfter(hi, n)  -> rows with key > hi, ascending
//   fetchBefore(lo, n) -> rows with key < lo, descending
//   toRecords(rows)    -> records (may be fewer than rows)
export async function pageByKey(cursorText, { limit = 2000, maxKey, fetchAfter, fetchBefore, toRecords, keyOf = (r) => r.pk, scanFactor = 20 }) {
  let c = readCursor(cursorText);
  if (!c || c.hi == null || (maxKey != null && maxKey < c.hi)) c = { hi: maxKey ?? 0, lo: (maxKey ?? 0) + 1, back: true };
  const records = [];
  const budget = Math.max(limit, 1) * scanFactor;
  let scanned = 0;
  while (records.length < limit && scanned < budget) {
    const rows = fetchAfter(c.hi, limit);
    if (!rows.length) break;
    scanned += rows.length;
    c.hi = keyOf(rows.at(-1));
    records.push(...(await toRecords(rows)));
    if (rows.length < limit) break;
  }
  while (c.back && records.length < limit && scanned < budget) {
    const rows = fetchBefore(c.lo, limit);
    if (!rows.length) {
      c.back = false;
      break;
    }
    scanned += rows.length;
    c.lo = keyOf(rows.at(-1));
    records.push(...(await toRecords(rows)));
    if (rows.length < limit) c.back = false;
  }
  const moreNew = fetchAfter(c.hi, 1).length > 0;
  return { records, cursor: writeCursor(c), done: !c.back && !moreNew };
}

// Watermark over (mark, id) pairs for small sources that change in place
// (contacts, recordings, meetings). Returns the items after the watermark.
export function afterMark(items, mark) {
  const sorted = [...items].sort((a, b) => a.mark - b.mark || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!mark) return sorted;
  return sorted.filter((it) => it.mark > mark.mark || (it.mark === mark.mark && it.id > mark.id));
}

// Watermark pages plus a retry list, for recordings that may still be waiting
// for a transcript. cursor: { m, pending, waiting }.
//   pending  ids to retry this run (once, at the front of the queue)
//   waiting  ids that still need a transcript; they move to pending when the
//            run finishes, so a later run retries them and this one never loops.
// build(items) -> records; a record with meta.needs_transcript goes to waiting.
export async function pendingPage(cursorText, items, { limit = 2000, build }) {
  const c = readCursor(cursorText) ?? {};
  const ids = new Set(items.map((it) => it.id));
  const pending = (c.pending ?? []).filter((id) => ids.has(id));
  const waiting = new Set((c.waiting ?? []).filter((id) => ids.has(id)));
  const fresh = afterMark(items, c.m);
  const freshIds = new Set(fresh.map((it) => it.id));
  const retry = items.filter((it) => pending.includes(it.id) && !freshIds.has(it.id));
  const queue = [...retry, ...fresh];
  const take = queue.slice(0, limit);
  const records = await build(take);
  const taken = new Set(take.map((it) => it.id));
  for (const r of records) {
    const itemId = r.meta?.item_id ?? null;
    if (r.meta?.needs_transcript && itemId) waiting.add(itemId);
  }
  const lastFresh = [...take].reverse().find((it) => freshIds.has(it.id));
  const m = lastFresh ? { mark: lastFresh.mark, id: lastFresh.id } : c.m ?? null;
  const restPending = pending.filter((id) => !taken.has(id));
  const done = queue.length <= take.length;
  const next = done ? { m, pending: [...new Set([...restPending, ...waiting])], waiting: [] } : { m, pending: restPending, waiting: [...waiting] };
  for (const r of records) if (r.meta && 'item_id' in r.meta) delete r.meta.item_id;
  return { records, cursor: writeCursor(next), done };
}

// The person running Confidant, from config.owner.
export function ownerOf(ctx) {
  const o = ctx?.config?.owner ?? {};
  const emails = (o.emails ?? []).map(normalizeEmail).filter(Boolean);
  const phones = (o.phones ?? []).map((p) => normalizePhone(p)).filter(Boolean);
  const handles = new Set([...emails.map((e) => `mailto:${e}`), ...phones.map((p) => `tel:${p}`)]);
  const tails = new Set(phones.map((p) => last10(`tel:${p}`)).filter(Boolean));
  return {
    name: o.name?.trim() || null,
    emails,
    phones,
    handles,
    isMe(handle) {
      if (!handle) return false;
      if (handles.has(handle)) return true;
      const tail = last10(handle);
      return !!tail && tails.has(tail);
    },
    handle: phones[0] ? `tel:${phones[0]}` : emails[0] ? `mailto:${emails[0]}` : null,
  };
}

// The owner as a record party. `raw` is the address the app says was used.
export function ownerParty(ctx, raw) {
  const owner = ownerOf(ctx);
  const handle = (raw && (emailHandle(raw) ?? phoneHandle(raw))) || owner.handle;
  return { handle: handle ?? null, name: owner.name };
}

// Transcription (C owns c-transcribe.mjs). Tests inject ctx.transcriber.
let transcriberModule;
export async function loadTranscriber(ctx) {
  if (ctx && 'transcriber' in ctx) return ctx.transcriber;
  if (transcriberModule === undefined) transcriberModule = await import('./c-transcribe.mjs').catch(() => null);
  return transcriberModule;
}

// Returns { text, provider } or null (no key, no module, or a failed call).
export async function transcribeFile(ctx, file, mimetype) {
  const t = await loadTranscriber(ctx);
  if (!t?.transcribe) return null;
  try {
    const res = await t.transcribe(ctx, file, { mimetype });
    if (!res) return null;
    const text = res.utterances?.length ? formatUtterances(res.utterances) : String(res.text ?? '').trim();
    return text ? { text, provider: res.provider ?? 'transcriber' } : null;
  } catch (err) {
    ctx?.log?.warn?.(`transcription failed, will retry later: ${err.message}`);
    return null;
  }
}

// "Speaker 1: line" rows, merging consecutive lines from the same speaker.
export function formatUtterances(utterances, names = {}) {
  const rows = [];
  for (const u of utterances) {
    const text = String(u.text ?? '').trim();
    if (!text) continue;
    const raw = u.speaker ?? '';
    const who = names[raw] ?? (typeof raw === 'number' || /^\d+$/.test(String(raw)) ? `Speaker ${Number(raw) + 1}` : String(raw) || 'Speaker');
    const last = rows.at(-1);
    if (last && last.who === who) last.text += ` ${text}`;
    else rows.push({ who, text });
  }
  return rows.map((r) => `${r.who}: ${r.text}`).join('\n');
}

// Wall-clock time in an IANA zone to an ISO UTC string.
const offsetFormatters = new Map();
function zoneOffsetMs(utcMs, timeZone) {
  let f = offsetFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    offsetFormatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

export function zonedToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone = 'UTC') {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!timeZone || timeZone === 'UTC') return new Date(guess).toISOString();
  let t;
  try {
    const off = zoneOffsetMs(guess, timeZone);
    t = guess - off;
    const off2 = zoneOffsetMs(t, timeZone);
    if (off2 !== off) t = guess - off2;
  } catch {
    t = guess;
  }
  return new Date(t).toISOString();
}

// Loose timestamps from app databases: numbers (s or ms since 1970), ISO
// strings, or "YYYY-MM-DD HH:MM:SS" (read as UTC unless an offset is given).
export function looseDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value))) {
    const n = Number(value);
    const ms = n > 1e14 ? n / 1000 : n > 1e11 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  let s = String(value).trim();
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (m) s = `${m[1]}T${m[2]}${m[3] ? m[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2') : 'Z'}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Text cleanup shared by every extractor: object replacement characters
// (attachments), bidi marks, NULs and stray whitespace.
export function cleanText(s) {
  if (s == null) return '';
  return String(s)
    .replace(/[\u0000￼�‎‏‪-‮]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function clip(s, max) {
  return s.length > max ? `${s.slice(0, max)}\n[...]` : s;
}

export function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') throw accessError(err, dir);
    return [];
  }
}

// Party from a raw app address (phone, email or display name).
export function partyFor(raw, name) {
  const handle = raw ? emailHandle(raw) ?? phoneHandle(raw) : null;
  return { handle, name: name?.trim() || null };
}

export const isPhoneHandle = (h) => parseHandle(h ?? '').scheme === 'tel';
