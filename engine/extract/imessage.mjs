// iMessage, SMS and RCS from ~/Library/Messages/chat.db.
//   - Dates are nanoseconds since 2001 on modern macOS (seconds on very old
//     ones). node:sqlite cannot hold them as numbers, so SQL converts to ms.
//   - Modern macOS keeps most text in attributedBody (a typedstream blob), not
//     in text. decodeAttributedBody pulls the NSString out of it.
//   - Tapbacks, stickers, poll votes, unsent messages and group events are
//     skipped. Attachments are metadata only (name, type, size), never content.
// Cursor: newest first by ROWID, then new rows (see pageByKey).
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { toHandle, groupHandle, nameHandle } from '../lib/handles.mjs';
import { toBuffer } from '../lib/sqlite.mjs';
import { libraryPath, unreadable, openCopy, columns, tableNames, pageByKey, ownerParty, cleanText, fileSize } from '../lib/a-local.mjs';
import { contactNames } from '../lib/a-addressbook.mjs';

export const id = 'imessage';
const APPLE_EPOCH_MS = 978307200000;
const GROUP_STYLE = 43;

export const dbPath = (ctx) => libraryPath(ctx, 'Messages', 'chat.db');

// Text from an NSAttributedString typedstream: the NSString class marker, a
// '+' (0x2b), then a length (1 byte, or 0x81 + 2 bytes LE, or 0x82 + 4 bytes LE).
export function decodeAttributedBody(blob) {
  const buf = toBuffer(blob);
  if (!buf?.length) return null;
  for (const cls of ['NSString', 'NSMutableString']) {
    const marker = buf.indexOf(cls, 0, 'latin1');
    if (marker < 0) continue;
    let p = -1;
    for (let i = marker + cls.length; i < Math.min(marker + cls.length + 12, buf.length); i++) {
      if (buf[i] === 0x2b) {
        p = i + 1;
        break;
      }
    }
    if (p < 0 || p >= buf.length) continue;
    let len;
    let start;
    if (buf[p] === 0x81) {
      if (p + 3 > buf.length) continue;
      len = buf.readUInt16LE(p + 1);
      start = p + 3;
    } else if (buf[p] === 0x82) {
      if (p + 5 > buf.length) continue;
      len = buf.readUInt32LE(p + 1);
      start = p + 5;
    } else {
      len = buf[p];
      start = p + 1;
    }
    if (!len || start + len > buf.length) continue;
    return buf.toString('utf8', start, start + len);
  }
  return null;
}

export async function probe(ctx) {
  const path = dbPath(ctx);
  const bad = unreadable(path, 'Messages database');
  if (bad) return bad;
  if (fileSize(path) > 4 * 1024 ** 3) return { ok: true, reason: 'large history' };
  const db = openCopy(ctx, path);
  const count = db.prepare('SELECT COUNT(*) AS n FROM message').get().n;
  return { ok: true, count };
}

// Per-copy lookups: chats, their participants, handles.
const lookups = new WeakMap();
function loadLookups(db) {
  if (lookups.has(db)) return lookups.get(db);
  const tables = tableNames(db);
  const hc = columns(db, 'handle');
  const handles = new Map(db.prepare(`SELECT ROWID AS rowid, id, ${hc.pick('service')} FROM handle`).all().map((h) => [h.rowid, h]));
  const cc = columns(db, 'chat');
  const chats = new Map(
    db
      .prepare(`SELECT ROWID AS rowid, guid, ${cc.pick('style')}, ${cc.pick('chat_identifier')}, ${cc.pick('display_name')}, ${cc.pick('service_name')} FROM chat`)
      .all()
      .map((c) => [c.rowid, c]),
  );
  const members = new Map();
  if (tables.has('chat_handle_join')) {
    for (const j of db.prepare('SELECT chat_id, handle_id FROM chat_handle_join').all()) {
      if (!members.has(j.chat_id)) members.set(j.chat_id, []);
      members.get(j.chat_id).push(j.handle_id);
    }
  }
  const msgChat = tables.has('chat_message_join') ? db.prepare('SELECT message_id, MIN(chat_id) AS chat_id FROM chat_message_join WHERE message_id BETWEEN ? AND ? GROUP BY message_id') : null;
  const attach =
    tables.has('message_attachment_join') && tables.has('attachment')
      ? (() => {
          const ac = columns(db, 'attachment');
          return db.prepare(
            `SELECT j.message_id AS message_id, ${ac.pick('transfer_name', 'transfer_name', 'a.transfer_name')}, ${ac.pick('filename', 'filename', 'a.filename')},
              ${ac.pick('mime_type', 'mime', 'a.mime_type')}, ${ac.pick('uti', 'uti', 'a.uti')}, ${ac.pick('total_bytes', 'bytes', 'a.total_bytes')}
             FROM message_attachment_join j JOIN attachment a ON a.ROWID = j.attachment_id WHERE j.message_id BETWEEN ? AND ?`,
          );
        })()
      : null;
  const mc = columns(db, 'message');
  const dateExpr = (col) => (mc.has(col) ? `CASE WHEN m.${col} > 100000000000 THEN m.${col} / 1000000 ELSE m.${col} * 1000 END` : 'NULL');
  const select = `SELECT m.ROWID AS pk, m.guid AS guid, ${mc.pick('text', 'text', 'm.text')}, ${mc.pick('attributedBody', 'body', 'm.attributedBody')},
      ${mc.pick('handle_id', 'handle_id', 'm.handle_id')}, ${mc.pick('service', 'service', 'm.service')}, ${dateExpr('date')} AS apple_ms,
      ${mc.pick('is_from_me', 'is_from_me', 'm.is_from_me')}, ${mc.pick('associated_message_type', 'assoc', 'm.associated_message_type')},
      ${mc.pick('item_type', 'item_type', 'm.item_type')}, ${mc.pick('thread_originator_guid', 'reply_to', 'm.thread_originator_guid')},
      ${mc.pick('destination_caller_id', 'my_id', 'm.destination_caller_id')}, ${mc.pick('cache_has_attachments', 'has_attach', 'm.cache_has_attachments')},
      ${mc.has('date_edited') ? '(m.date_edited > 0)' : '0'} AS edited, ${mc.has('date_retracted') ? '(m.date_retracted > 0)' : '0'} AS retracted,
      ${mc.pick('is_audio_message', 'audio', 'm.is_audio_message')}, ${mc.pick('balloon_bundle_id', 'balloon', 'm.balloon_bundle_id')}
    FROM message m`;
  const value = {
    handles,
    chats,
    members,
    msgChat,
    attach,
    after: db.prepare(`${select} WHERE m.ROWID > ? ORDER BY m.ROWID ASC LIMIT ?`),
    before: db.prepare(`${select} WHERE m.ROWID < ? ORDER BY m.ROWID DESC LIMIT ?`),
    max: () => db.prepare('SELECT MAX(ROWID) AS m FROM message').get().m ?? 0,
  };
  lookups.set(db, value);
  return value;
}

const SERVICE = { imessage: 'iMessage', sms: 'SMS', rcs: 'RCS' };

function handleFor(raw) {
  if (!raw) return null;
  const h = toHandle(raw);
  return h && !h.startsWith('name:') ? h : nameHandle(raw);
}

function toRecords(ctx, L, rows) {
  if (!rows.length) return [];
  const names = contactNames(ctx);
  const lo = Math.min(...rows.map((r) => r.pk));
  const hi = Math.max(...rows.map((r) => r.pk));
  const chatOf = new Map(L.msgChat ? L.msgChat.all(lo, hi).map((j) => [j.message_id, j.chat_id]) : []);
  const files = new Map();
  if (L.attach) {
    for (const a of L.attach.all(lo, hi)) {
      if (!files.has(a.message_id)) files.set(a.message_id, []);
      files.get(a.message_id).push({ filename: a.transfer_name || (a.filename ? basename(String(a.filename)) : null), mime: a.mime ?? null, uti: a.uti ?? null, bytes: a.bytes ?? null });
    }
  }
  const party = (handleRowid) => {
    const h = L.handles.get(handleRowid);
    if (!h) return null;
    const handle = handleFor(h.id);
    return { handle, name: names.nameFor(handle) };
  };
  const out = [];
  for (const r of rows) {
    if (r.apple_ms == null) continue;
    const assoc = Number(r.assoc ?? 0);
    if (assoc >= 1000) continue; // stickers, tapbacks, poll votes
    if (Number(r.item_type ?? 0) !== 0) continue; // group events, renames
    if (r.retracted) continue;
    const text = cleanText(r.text && String(r.text).trim() ? r.text : decodeAttributedBody(r.body));
    const attachments = files.get(r.pk) ?? [];
    if (!text && !attachments.length) continue;
    const chat = L.chats.get(chatOf.get(r.pk));
    const isGroup = Number(chat?.style) === GROUP_STYLE;
    const fromMe = !!r.is_from_me;
    const counterpart = party(r.handle_id) ?? (chat && !isGroup ? { handle: handleFor(chat.chat_identifier), name: null } : null);
    if (counterpart && !counterpart.name && counterpart.handle) counterpart.name = names.nameFor(counterpart.handle);
    const me = ownerParty(ctx, r.my_id ? String(r.my_id).replace(/^[a-z]:/i, '') : null);
    const meta = { service: SERVICE[String(r.service ?? chat?.service_name ?? '').toLowerCase()] ?? r.service ?? null };
    let to = [];
    if (isGroup) {
      const participants = (L.members.get(chat.rowid) ?? []).map(party).filter(Boolean);
      meta.is_group = true;
      meta.chat_name = chat.display_name || null;
      meta.participants = participants.map((p) => p.handle).filter(Boolean);
      to = [{ handle: groupHandle('imessage', chat.guid), name: chat.display_name || null }];
    } else if (fromMe && counterpart) to = [counterpart];
    if (counterpart && !isGroup) meta.chat_name = counterpart.name ?? null;
    if (!isGroup && counterpart?.handle?.startsWith('name:')) {
      meta.alphanumeric_sender = true; // "Chase", "AMEX": business sender ids
      counterpart.name ??= L.handles.get(r.handle_id)?.id ?? null;
    }
    if (attachments.length) meta.attachments = attachments;
    if (r.reply_to) meta.reply_to = `imessage:${r.reply_to}`;
    if (r.edited) meta.edited = true;
    if (r.audio) meta.audio = true;
    if (r.balloon) meta.app = String(r.balloon).split(':').pop();
    out.push({
      id: `imessage:${r.guid}`,
      source: 'imessage',
      kind: 'message',
      thread: `imessage:${chat?.guid ?? counterpart?.handle ?? 'unknown'}`,
      ts: new Date(Number(r.apple_ms) + APPLE_EPOCH_MS).toISOString(),
      from: fromMe ? me : counterpart ?? { handle: null, name: null },
      to,
      is_from_me: fromMe,
      title: isGroup ? chat.display_name || null : null,
      text,
      url: null,
      meta,
    });
  }
  return out;
}

export async function extract(ctx, { cursor, limit = 2000 } = {}) {
  const path = dbPath(ctx);
  if (!existsSync(path)) return { records: [], cursor, done: true };
  const db = openCopy(ctx, path);
  const L = loadLookups(db);
  return pageByKey(cursor, {
    limit,
    maxKey: L.max(),
    fetchAfter: (hi, n) => L.after.all(hi, n),
    fetchBefore: (lo, n) => L.before.all(lo, n),
    toRecords: (rows) => toRecords(ctx, L, rows),
  });
}
