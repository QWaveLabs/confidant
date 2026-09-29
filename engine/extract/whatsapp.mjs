// WhatsApp from the native Mac app (Catalyst build, same Core Data schema as
// iOS): ~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite.
//   ZWAMESSAGE        ZTEXT, ZMESSAGEDATE (seconds since 2001), ZISFROMME, ZFROMJID,
//                     ZTOJID, ZCHATSESSION, ZGROUPMEMBER, ZMESSAGETYPE, ZPUSHNAME, ZSTANZAID
//   ZWACHATSESSION    ZCONTACTJID, ZPARTNERNAME, ZSESSIONTYPE (0 DM, 1 group, 2 broadcast, 3 status, 4 community)
//   ZWAGROUPMEMBER    ZMEMBERJID, ZCONTACTNAME
//   ZWAMEDIAITEM      ZMESSAGE, ZTITLE (media captions)
//   ZWAPROFILEPUSHNAME ZJID, ZPUSHNAME (when present)
// Handles: phone jids -> tel:+E164, groups -> group:whatsapp:<jid>. @lid ids
// carry no phone: they map through ContactsV2.sqlite when it has them, else a
// name: handle from the push or contact name, with the lid kept in meta.
// Cursor: newest first by Z_PK, then new rows.
import { existsSync } from 'node:fs';
import { phoneHandle, groupHandle, nameHandle } from '../lib/handles.mjs';
import { fromAppleTime } from '../lib/time.mjs';
import { canRead } from '../lib/sqlite.mjs';
import { libraryPath, unreadable, openCopy, columns, tableNames, pageByKey, ownerParty, cleanText } from '../lib/a-local.mjs';
import { contactNames } from '../lib/a-addressbook.mjs';

export const id = 'whatsapp';
const CONTAINER = ['Group Containers', 'group.net.whatsapp.WhatsApp.shared'];
export const dbPath = (ctx) => libraryPath(ctx, ...CONTAINER, 'ChatStorage.sqlite');

// ZMESSAGETYPE codes (IPED, wa-explorer). Types not listed are system rows.
const MEDIA = { 1: 'image', 2: 'video', 3: 'audio', 4: 'contact', 5: 'location', 7: 'link', 8: 'document', 11: 'gif', 38: 'image', 39: 'video', 53: 'audio', 54: 'video' };
const TEXT_TYPES = new Set([0, 7, 27, 46]);
const SKIP_SESSIONS = new Set([2, 3, 4]);

export async function probe(ctx) {
  const path = dbPath(ctx);
  const bad = unreadable(path, 'WhatsApp database');
  if (bad) return bad;
  const db = openCopy(ctx, path);
  return { ok: true, count: db.prepare('SELECT COUNT(*) AS n FROM ZWAMESSAGE').get().n };
}

const str = (v) => {
  if (v == null) return null;
  const s = v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v);
  const clean = s.replace(/[\u0000-\u001f�]/g, '').trim();
  return clean || null;
};

function loadLookups(ctx, db) {
  const tables = tableNames(db);
  const sc = columns(db, 'ZWACHATSESSION');
  const sessions = new Map(
    db
      .prepare(`SELECT Z_PK AS pk, ZCONTACTJID AS jid, ${sc.pick('ZPARTNERNAME', 'name')}, ${sc.pick('ZSESSIONTYPE', 'type')}, ${sc.pick('ZCONTACTIDENTIFIER', 'contact_id')} FROM ZWACHATSESSION`)
      .all()
      .map((s) => [s.pk, s]),
  );
  const members = new Map();
  const byChat = new Map();
  if (tables.has('zwagroupmember')) {
    const gc = columns(db, 'ZWAGROUPMEMBER');
    for (const g of db.prepare(`SELECT Z_PK AS pk, ${gc.pick('ZCHATSESSION', 'chat')}, ZMEMBERJID AS jid, ${gc.pick('ZCONTACTNAME', 'name')}, ${gc.pick('ZFIRSTNAME', 'first')} FROM ZWAGROUPMEMBER`).all()) {
      members.set(g.pk, g);
      if (g.chat != null) {
        if (!byChat.has(g.chat)) byChat.set(g.chat, []);
        byChat.get(g.chat).push(g);
      }
    }
  }
  const pushNames = new Map();
  if (tables.has('zwaprofilepushname')) {
    for (const p of db.prepare('SELECT ZJID AS jid, ZPUSHNAME AS name FROM ZWAPROFILEPUSHNAME').all()) if (p.jid) pushNames.set(p.jid, str(p.name));
  }
  // @lid -> phone, from the address book the app keeps next to the chats.
  const lids = new Map();
  const contactsDb = libraryPath(ctx, ...CONTAINER, 'ContactsV2.sqlite');
  if (existsSync(contactsDb) && canRead(contactsDb).ok) {
    try {
      const cdb = openCopy(ctx, contactsDb);
      const cc = columns(cdb, 'ZWAADDRESSBOOKCONTACT');
      if (cc.has('ZLID')) {
        for (const r of cdb.prepare(`SELECT ZLID AS lid, ${cc.pick('ZWHATSAPPID', 'wa')}, ${cc.pick('ZPHONENUMBER', 'phone')}, ${cc.pick('ZFULLNAME', 'name')} FROM ZWAADDRESSBOOKCONTACT WHERE ZLID IS NOT NULL`).all()) {
          lids.set(String(r.lid).replace(/@lid$/, ''), { phone: r.wa ? String(r.wa).split('@')[0] : r.phone, name: str(r.name) });
        }
      }
    } catch {}
  }
  const mc = columns(db, 'ZWAMESSAGE');
  const select = `SELECT m.Z_PK AS pk, ${mc.pick('ZTEXT', 'text', 'm.ZTEXT')}, m.ZMESSAGEDATE AS date, ${mc.pick('ZISFROMME', 'from_me', 'm.ZISFROMME')},
      ${mc.pick('ZFROMJID', 'from_jid', 'm.ZFROMJID')}, ${mc.pick('ZTOJID', 'to_jid', 'm.ZTOJID')}, ${mc.pick('ZCHATSESSION', 'chat', 'm.ZCHATSESSION')},
      ${mc.pick('ZGROUPMEMBER', 'member', 'm.ZGROUPMEMBER')}, ${mc.pick('ZMESSAGETYPE', 'type', 'm.ZMESSAGETYPE')}, ${mc.pick('ZPUSHNAME', 'push', 'm.ZPUSHNAME')},
      ${mc.pick('ZSTANZAID', 'stanza', 'm.ZSTANZAID')}, ${mc.pick('ZSTARRED', 'starred', 'm.ZSTARRED')}
    FROM ZWAMESSAGE m`;
  const media = tables.has('zwamediaitem')
    ? (() => {
        const dc = columns(db, 'ZWAMEDIAITEM');
        return db.prepare(`SELECT ZMESSAGE AS msg, ${dc.pick('ZTITLE', 'title')}, ${dc.pick('ZVCARDNAME', 'vcard')}, ${dc.pick('ZFILESIZE', 'size')}, ${dc.pick('ZMOVIEDURATION', 'duration')} FROM ZWAMEDIAITEM WHERE ZMESSAGE BETWEEN ? AND ?`);
      })()
    : null;
  return {
    sessions,
    members,
    byChat,
    pushNames,
    lids,
    media,
    after: db.prepare(`${select} WHERE m.Z_PK > ? ORDER BY m.Z_PK ASC LIMIT ?`),
    before: db.prepare(`${select} WHERE m.Z_PK < ? ORDER BY m.Z_PK DESC LIMIT ?`),
    max: () => db.prepare('SELECT MAX(Z_PK) AS m FROM ZWAMESSAGE').get().m ?? 0,
  };
}

// jid -> { handle, name, lid? }
function jidParty(L, names, jid, fallbackName) {
  if (!jid) return null;
  const [user, server] = String(jid).split('@');
  if (server === 'g.us') return { handle: groupHandle('whatsapp', jid), name: fallbackName ?? null };
  if (server === 'lid') {
    const mapped = L.lids.get(user);
    const name = fallbackName ?? mapped?.name ?? L.pushNames.get(jid) ?? null;
    const phone = mapped?.phone ? phoneHandle(`+${String(mapped.phone).replace(/^\+/, '')}`) : null;
    return { handle: phone ?? (name ? nameHandle(name) : null), name, lid: jid };
  }
  const handle = /^\d{6,15}$/.test(user) ? phoneHandle(`+${user}`) : null;
  const name = fallbackName ?? (handle && names.nameFor(handle)) ?? L.pushNames.get(jid) ?? null;
  return { handle, name };
}

const LOOKUPS = new WeakMap();

function toRecords(ctx, L, rows) {
  if (!rows.length) return [];
  const names = contactNames(ctx);
  const lo = Math.min(...rows.map((r) => r.pk));
  const hi = Math.max(...rows.map((r) => r.pk));
  const mediaOf = new Map(L.media ? L.media.all(lo, hi).map((m) => [m.msg, m]) : []);
  const out = [];
  for (const r of rows) {
    const type = Number(r.type ?? 0);
    const session = L.sessions.get(r.chat);
    if (!session || SKIP_SESSIONS.has(Number(session.type))) continue;
    if (!TEXT_TYPES.has(type) && !MEDIA[type]) continue;
    const item = mediaOf.get(r.pk);
    const text = cleanText(str(r.text) ?? (MEDIA[type] ? str(item?.title) : null) ?? '');
    if (!text && !MEDIA[type]) continue;
    const ts = fromAppleTime(r.date);
    if (!ts) continue;
    const chatJid = session.jid;
    const isGroup = Number(session.type) === 1 || String(chatJid).endsWith('@g.us');
    const fromMe = !!r.from_me;
    const meta = {};
    let from;
    let to = [];
    let partner = null;
    if (isGroup) {
      meta.is_group = true;
      meta.chat_name = str(session.name);
      meta.participants = (L.byChat.get(r.chat) ?? []).map((g) => jidParty(L, names, g.jid, str(g.name))?.handle).filter(Boolean);
      to = [{ handle: groupHandle('whatsapp', chatJid), name: meta.chat_name }];
      if (fromMe) from = ownerParty(ctx);
      else {
        const m = L.members.get(r.member);
        from = jidParty(L, names, m?.jid ?? r.from_jid, str(m?.name) ?? str(r.push));
      }
    } else {
      partner = jidParty(L, names, chatJid, str(session.name));
      meta.chat_name = partner?.name ?? null;
      if (fromMe) {
        from = ownerParty(ctx);
        to = partner ? [{ handle: partner.handle, name: partner.name }] : [];
      } else from = partner;
    }
    const lid = isGroup ? from?.lid : partner?.lid;
    if (lid) meta.lid = lid;
    if (MEDIA[type]) meta.media = MEDIA[type];
    if (item?.duration) meta.duration_s = Math.round(Number(item.duration));
    if (r.starred) meta.starred = true;
    out.push({
      id: `whatsapp:${r.stanza ? `${chatJid}/${r.stanza}` : `pk${r.pk}`}`,
      source: 'whatsapp',
      kind: 'message',
      thread: `whatsapp:${chatJid}`,
      ts,
      from: from ? { handle: from.handle ?? null, name: from.name ?? null } : { handle: null, name: null },
      to,
      is_from_me: fromMe,
      title: isGroup ? meta.chat_name : null,
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
  if (!LOOKUPS.has(db)) LOOKUPS.set(db, loadLookups(ctx, db));
  const L = LOOKUPS.get(db);
  return pageByKey(cursor, {
    limit,
    maxKey: L.max(),
    fetchAfter: (hi, n) => L.after.all(hi, n),
    fetchBefore: (lo, n) => L.before.all(lo, n),
    toRecords: (rows) => toRecords(ctx, L, rows),
  });
}
