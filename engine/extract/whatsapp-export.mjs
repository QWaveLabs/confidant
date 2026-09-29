// WhatsApp chat exports the person drops into <vault>/.confidant/exports/whatsapp/
// (.zip straight from "Export chat", or the .txt inside). They seed history
// older than the Mac app keeps (about a year).
//   iOS      [DD/MM/YYYY, HH:MM:SS] Name: text      (U+200E marks system and media lines)
//   Android  DD/MM/YYYY, HH:MM - Name: text
// Day/month order is worked out per file (a part over 12 decides, else the
// order that keeps dates increasing). 12-hour clocks, "a. m."/"p. m.",
// multi-line messages, media placeholders and system lines are handled.
// Times are read in the person's time zone. Ids are stable hashes, so a
// re-export of the same chat updates rather than duplicates.
// Cursor: { files: { name: signature }, cur: { file, sig, offset } }.
import { existsSync, readFileSync, statSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename, extname } from 'node:path';
import { groupHandle, nameHandle, phoneHandle } from '../lib/handles.mjs';
import { shortHash } from '../lib/hash.mjs';
import { readCursor, writeCursor, zonedToUtc, ownerParty, listDir, cleanText, openCopy, columns } from '../lib/a-local.mjs';
import { canRead } from '../lib/sqlite.mjs';
import { dbPath as nativeDbPath } from './whatsapp.mjs';

const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
import { guardProbe, guardExtract, notOk } from '../lib/a-reasons.mjs';

export const id = 'whatsapp_export';

export function exportDir(ctx) {
  return join(ctx.paths?.exports ?? join(ctx.vault ?? '.', '.confidant', 'exports'), 'whatsapp');
}

const HEADER_IOS = /^\[(\d{1,4})[./-](\d{1,2})[./-](\d{1,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([ap]\.?\s?m\.?)?\]\s+(.*)$/i;
const HEADER_ANDROID = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([ap]\.?\s?m\.?)?\s+[-–]\s+(.*)$/i;
const BIDI = /[‎‏‪-‮⁦-⁩﻿]/g;
const MEDIA = [
  [/^<(media omitted|multimedia omitido|medios omitidos|m[ií]dia oculta)>$/i, 'media'],
  [/^(image|photo|imagen|foto) omitid[oa]$|^image omitted$/i, 'image'],
  [/^(video|v[ií]deo) omit(ted|ido)$/i, 'video'],
  [/^(audio) omit(ted|ido)$/i, 'audio'],
  [/^(sticker) omit(ted|ido)$/i, 'sticker'],
  [/^GIF omit(ted|ido)$/i, 'gif'],
  [/^(document|documento) omit(ted|ido)$|^.+ • \d+ (pages|páginas).*omit/i, 'document'],
  [/^(contact card|tarjeta de contacto) omitid[ao]$|^contact card omitted$/i, 'contact'],
  [/^<(attached|adjunto): ([^>]+)>$/i, 'attachment'],
  [/^(.+\.(jpe?g|png|webp|heic|opus|ogg|mp4|mov|pdf|vcf|m4a|aac|docx?|xlsx?|pptx?|zip)) \((file attached|archivo adjunto)\)$/i, 'attachment'],
  [/^(location|ubicaci[oó]n): https?:\/\/\S+$/i, 'location'],
];
const DELETED = /^(this message was deleted|you deleted this message|se elimin[oó] este mensaje|eliminaste este mensaje|este mensaje fue eliminado|null)\.?$/i;
const EDITED = /\s*<(this message was edited|se edit[oó] este mensaje)\.?>\s*$/i;
const ME_WORDS = new Set(['you', 'tu', 'tú', 'yo', 'voce', 'você']);

const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9+ ]/g, ' ').replace(/\s+/g, ' ').trim();

// "WhatsApp Chat with Ana López (1).txt" -> "Ana López"
export function chatNameFromFile(file) {
  let n = basename(file, extname(file)).normalize('NFC');
  n = n.replace(/\s*\(\d+\)$/, '');
  n = n.replace(/^(WhatsApp Chat (with|-)|Chat de WhatsApp (con|-)|Conversa do WhatsApp com|Conversa do WhatsApp -|Discussion WhatsApp avec)\s*/i, '');
  return n.trim() || 'WhatsApp chat';
}

function readExport(file) {
  // Regular files only (no FIFOs, sockets or links to them), within a size cap.
  const st = lstatSync(file);
  if (!st.isFile()) throw new Error('not a regular file');
  if (st.size > MAX_EXPORT_BYTES) throw new Error('export file is too large');
  let buf;
  if (extname(file).toLowerCase() === '.zip') {
    const list = execFileSync('/usr/bin/unzip', ['-Z1', file], { maxBuffer: 16 * 1024 * 1024 }).toString('utf8').split('\n').filter(Boolean);
    const entry = list.find((e) => basename(e) === '_chat.txt') ?? list.find((e) => /\.txt$/i.test(e) && !e.startsWith('__MACOSX'));
    if (!entry) return '';
    // unzip reads member names as wildcard patterns, so escape them.
    // A leading "-" would read as an unzip option, so it goes in brackets too.
    buf = execFileSync('/usr/bin/unzip', ['-p', file, entry.replace(/[[\]*?\\]/g, '\\$&').replace(/^-/, '[-]')], { maxBuffer: MAX_EXPORT_BYTES });
  } else buf = readFileSync(file);
  return buf.toString('utf8').replace(/^\ufeff/, '');
}

// Raw lines -> [{ parts: [a, b, c], h, m, s, ampm, sender, text, system }].
function scan(text) {
  const out = [];
  let ios = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/[  ]/g, ' ');
    const stripped = line.replace(/^[‎‏‪-‮⁦-⁩]+/, '');
    let m = HEADER_IOS.exec(stripped);
    let kind = 'ios';
    if (!m) {
      m = HEADER_ANDROID.exec(stripped);
      kind = 'android';
    }
    if (m && (ios === null || ios === (kind === 'ios'))) {
      ios = kind === 'ios';
      const rest = m[8];
      const colon = rest.indexOf(': ');
      const entry = { parts: [m[1], m[2], m[3]], h: +m[4], min: +m[5], s: m[6] ? +m[6] : 0, ampm: m[7] ?? null, sender: null, text: '', system: false, lrm: false };
      if (colon > 0 && colon < 80) {
        entry.sender = rest.slice(0, colon).replace(BIDI, '').replace(/^~\s*/, '').trim();
        const body = rest.slice(colon + 2);
        entry.lrm = /^[‎‏]/.test(body);
        entry.text = body.replace(BIDI, '');
      } else {
        entry.system = true;
        entry.text = rest.replace(BIDI, '');
      }
      out.push(entry);
    } else if (out.length) {
      out[out.length - 1].text += `\n${rawLine.replace(BIDI, '')}`;
    }
  }
  return out;
}

// Decide Y-M-D, D-M-Y or M-D-Y for the whole file.
function dateOrder(entries) {
  if (entries.some((e) => e.parts[0].length === 4)) return 'ymd';
  let dmy = false;
  let mdy = false;
  for (const e of entries) {
    if (+e.parts[0] > 12) dmy = true;
    if (+e.parts[1] > 12) mdy = true;
  }
  if (dmy !== mdy) return dmy ? 'dmy' : 'mdy';
  const days = (order) =>
    entries.map((e) => {
      const [d, mo, y] = order === 'dmy' ? [e.parts[0], e.parts[1], e.parts[2]] : [e.parts[1], e.parts[0], e.parts[2]];
      return Date.UTC(+y < 100 ? 2000 + +y : +y, +mo - 1, +d) / 86400000;
    });
  const inversions = (list) => list.reduce((n, v, i) => n + (i && v < list[i - 1] ? 1 : 0), 0);
  const span = (list) => list.reduce((n, v, i) => n + (i ? Math.abs(v - list[i - 1]) : 0), 0);
  const a = days('dmy');
  const b = days('mdy');
  if (inversions(a) !== inversions(b)) return inversions(a) < inversions(b) ? 'dmy' : 'mdy';
  // Chats cluster in time: the reading with the smaller total gap is the real one.
  if (span(a) !== span(b)) return span(a) < span(b) ? 'dmy' : 'mdy';
  // "9:05 AM" is US style; "9:05 a. m." is Spanish (day first).
  const ampm = entries.find((e) => e.ampm)?.ampm;
  if (ampm) return /^[AP]M$/.test(ampm.trim()) ? 'mdy' : 'dmy';
  return 'dmy';
}

// Parsed messages with ISO times. Exported for tests.
export function parseExport(text, { timeZone = 'UTC' } = {}) {
  const entries = scan(text);
  const order = dateOrder(entries);
  const messages = [];
  for (const e of entries) {
    const [p0, p1, p2] = e.parts.map(Number);
    let year;
    let month;
    let day;
    if (order === 'ymd') [year, month, day] = [p0, p1, p2];
    else if (order === 'dmy') [day, month, year] = [p0, p1, p2];
    else [month, day, year] = [p0, p1, p2];
    if (year < 100) year += 2000;
    let hour = e.h;
    if (e.ampm) {
      const pm = /^p/i.test(e.ampm);
      if (pm && hour < 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23) continue;
    const ts = zonedToUtc({ year, month, day, hour, minute: e.min, second: e.s }, timeZone);
    let body = e.text.trim();
    const edited = EDITED.test(body);
    if (edited) body = body.replace(EDITED, '');
    if (e.system || !e.sender) continue;
    if (DELETED.test(body)) continue;
    let media = null;
    let attachment = null;
    for (const [re, kind] of MEDIA) {
      const mm = re.exec(body);
      if (mm) {
        media = kind;
        if (kind === 'attachment') attachment = mm[2] ?? mm[1];
        break;
      }
    }
    if (e.lrm && !media) continue; // iOS system line ("Messages and calls are end-to-end encrypted")
    messages.push({ ts, sender: e.sender, text: media ? '' : body, media, attachment, edited });
  }
  return { messages, order };
}

function fileSig(file) {
  const st = statSync(file);
  return `${st.size}:${Math.round(st.mtimeMs)}`;
}

// Chats the Mac app knows, by name, read from ChatStorage itself. Records of
// an excluded chat never reach brain.db, so matching through the store alone
// would leave an export of that chat with a made-up thread and name handles
// that no handle or chat-id exclusion can match.
function nativeSessions(ctx) {
  const map = new Map();
  const path = nativeDbPath(ctx);
  if (!existsSync(path) || !canRead(path).ok) return map;
  try {
    const db = openCopy(ctx, path);
    const c = columns(db, 'ZWACHATSESSION');
    for (const s of db.prepare(`SELECT ZCONTACTJID AS jid, ${c.pick('ZPARTNERNAME', 'name')}, ${c.pick('ZSESSIONTYPE', 'type')} FROM ZWACHATSESSION`).all()) {
      if (!s.jid || !s.name) continue;
      const k = fold(s.name);
      if (!map.has(k)) map.set(k, { thread: `whatsapp:${s.jid}`, group: Number(s.type) === 1 || String(s.jid).endsWith('@g.us'), jid: String(s.jid) });
    }
  } catch {}
  return map;
}

// A native WhatsApp thread with the same chat name, if the Mac app has it.
function nativeThreads(ctx) {
  const map = nativeSessions(ctx);
  try {
    const rows = ctx.store.db
      .prepare("SELECT thread, json_extract(meta_json, '$.chat_name') AS name, MAX(json_extract(meta_json, '$.is_group')) AS grp FROM records WHERE source = 'whatsapp' GROUP BY thread, name")
      .all();
    for (const r of rows) if (r.name && !map.has(fold(r.name))) map.set(fold(r.name), { thread: r.thread, group: !!r.grp, jid: String(r.thread).replace(/^whatsapp:/, '') });
  } catch {}
  return map;
}

function nativeKeys(ctx, thread) {
  const keys = new Set();
  try {
    for (const r of ctx.store.records({ source: 'whatsapp', thread })) keys.add(`${r.ts.slice(0, 16)}|${fold(r.text)}`);
  } catch {}
  return keys;
}

function toRecords(ctx, file, parsed, native) {
  const chat = chatNameFromFile(file);
  const key = fold(chat);
  const owner = ctx.config?.owner ?? {};
  const ownerName = fold(owner.name);
  const senders = [...new Set(parsed.messages.map((m) => m.sender))];
  const isMeName = (s) => (!!ownerName && fold(s) === ownerName) || ME_WORDS.has(fold(s));
  let me = senders.find(isMeName) ?? null;
  const partnerIsChat = senders.some((s) => fold(s) === key);
  if (!me && senders.length === 2 && partnerIsChat) me = senders.find((s) => fold(s) !== key);
  const mapped = native.get(key);
  const isGroup = mapped ? mapped.group : senders.filter((s) => s !== me).length > 1 || (senders.length > 0 && !partnerIsChat && senders.length !== 1);
  const thread = mapped?.thread ?? `whatsapp:export:${shortHash(key, 16)}`;
  const group = { handle: mapped ? groupHandle('whatsapp', mapped.thread.replace(/^whatsapp:/, '')) : groupHandle('whatsapp_export', shortHash(key, 16)), name: chat };
  const skip = mapped ? nativeKeys(ctx, mapped.thread) : new Set();
  // A direct chat the Mac app knows: the partner's real phone handle.
  const partnerUser = mapped?.jid && !mapped.group ? /^(\d{6,15})@s\.whatsapp\.net$/.exec(mapped.jid)?.[1] : null;
  const partnerPhone = partnerUser ? phoneHandle(`+${partnerUser}`) : null;
  const seen = new Map();
  const out = [];
  for (const m of parsed.messages) {
    if (skip.has(`${m.ts.slice(0, 16)}|${fold(m.text)}`)) continue;
    const base = `${key}|${m.ts}|${m.sender}|${m.text}|${m.attachment ?? ''}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const fromMe = m.sender === me;
    const phone = /^\+?[\d\s().-]{8,}$/.test(m.sender) ? phoneHandle(m.sender.startsWith('+') ? m.sender : `+${m.sender}`) : null;
    const sender = fromMe ? ownerParty(ctx) : { handle: phone ?? (isGroup ? null : partnerPhone) ?? nameHandle(m.sender), name: phone ? null : m.sender };
    const meta = { chat_name: chat, export_file: basename(file) };
    if (isGroup) meta.is_group = true;
    if (m.media) meta.media = m.media;
    if (m.attachment) meta.attachments = [{ filename: m.attachment }];
    if (m.edited) meta.edited = true;
    out.push({
      id: `whatsapp_export:${shortHash(`${base}|${n}`, 20)}`,
      source: 'whatsapp_export',
      kind: 'message',
      thread,
      ts: m.ts,
      from: sender,
      to: isGroup ? [group] : fromMe ? [{ handle: partnerPhone ?? nameHandle(chat), name: chat }] : [],
      is_from_me: fromMe,
      title: isGroup ? chat : null,
      text: cleanText(m.text),
      url: null,
      meta,
    });
  }
  return out;
}

const EXPORT_FILE = /\.(zip|txt)$/i;
const PARSED = new Map();

async function runProbe(ctx) {
  const dir = exportDir(ctx);
  const files = existsSync(dir) ? listDir(dir).filter((f) => EXPORT_FILE.test(f)) : [];
  if (!files.length) return notOk(ctx, id, 'no_data', 'no WhatsApp exports yet', { count: 0 });
  return { ok: true, count: files.length };
}

async function runExtract(ctx, { cursor, limit = 2000 } = {}) {
  const dir = exportDir(ctx);
  const c = readCursor(cursor) ?? {};
  const files = c.files ?? {};
  let cur = c.cur ?? null;
  const list = existsSync(dir) ? listDir(dir).filter((f) => EXPORT_FILE.test(f) && !f.startsWith('.')).sort() : [];
  const native = nativeThreads(ctx);
  const records = [];
  for (const name of list) {
    if (records.length >= limit) break;
    const file = join(dir, name);
    const sig = fileSig(file);
    if (files[name] === sig && cur?.file !== name) continue;
    const offset = cur?.file === name && cur.sig === sig ? cur.offset : 0;
    let parsed;
    try {
      // Parsed once per file version, not once per page.
      const cacheKey = `${file}|${sig}|${ctx.tz ?? ''}`;
      parsed = PARSED.get(cacheKey);
      if (!parsed) {
        parsed = parseExport(readExport(file), { timeZone: ctx.tz ?? ctx.config?.timezone ?? 'UTC' });
        PARSED.clear();
        PARSED.set(cacheKey, parsed);
      }
    } catch (err) {
      ctx.log?.warn?.(`could not read WhatsApp export ${name}: ${err.message}`);
      files[name] = sig;
      continue;
    }
    const all = toRecords(ctx, file, parsed, native);
    const take = all.slice(offset, offset + (limit - records.length));
    records.push(...take);
    if (offset + take.length >= all.length) {
      files[name] = sig;
      cur = null;
    } else cur = { file: name, sig, offset: offset + take.length };
  }
  const done = !cur && list.every((n) => files[n] === fileSig(join(dir, n)));
  return { records, cursor: writeCursor({ files, cur }), done };
}

export const probe = guardProbe(id, runProbe);
export const extract = guardExtract(id, runExtract);
