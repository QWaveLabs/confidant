// Builders for synthetic copies of Apple app databases, with the real table
// and column names (subsets). All data is invented.
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createDb, insert, writeFile, appleSeconds, appleNanos } from './a-fixtures.mjs';
import { encodeField, encodeMessage } from '../../engine/lib/a-protobuf.mjs';

// ---------- AddressBook ----------
export function addressBook(home, source = 'SRC-1', cards = []) {
  const db = createDb(
    join(home, 'Library/Application Support/AddressBook/Sources', source, 'AddressBook-v22.abcddb'),
    `CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
     CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZFIRSTNAME VARCHAR, ZLASTNAME VARCHAR, ZMIDDLENAME VARCHAR,
       ZNICKNAME VARCHAR, ZORGANIZATION VARCHAR, ZJOBTITLE VARCHAR, ZDEPARTMENT VARCHAR, ZNAME VARCHAR, ZUNIQUEID VARCHAR,
       ZMODIFICATIONDATE TIMESTAMP, ZCREATIONDATE TIMESTAMP);
     CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZOWNER INTEGER, ZFULLNUMBER VARCHAR, ZLABEL VARCHAR, ZORDERINGINDEX INTEGER);
     CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZOWNER INTEGER, ZADDRESS VARCHAR, ZADDRESSNORMALIZED VARCHAR, ZLABEL VARCHAR);
     INSERT INTO Z_PRIMARYKEY VALUES (19, 'ABCDContact', 21, 0), (20, 'ABCDGroup', 21, 0), (21, 'ABCDRecord', 0, 0);`,
  );
  addCards(db, cards);
  return db;
}

let phonePk = 1;
export function addCards(db, cards) {
  for (const c of cards) {
    insert(db, 'ZABCDRECORD', {
      Z_PK: c.pk, Z_ENT: c.group ? 20 : 19, Z_OPT: 1, ZFIRSTNAME: c.first ?? null, ZLASTNAME: c.last ?? null, ZNICKNAME: c.nickname ?? null,
      ZORGANIZATION: c.org ?? null, ZJOBTITLE: c.job ?? null, ZNAME: c.group ?? null, ZUNIQUEID: c.uid ?? `UID-${c.pk}:ABPerson`,
      ZMODIFICATIONDATE: appleSeconds(c.modified ?? '2026-01-01T00:00:00Z'), ZCREATIONDATE: appleSeconds('2025-01-01T00:00:00Z'),
    });
    for (const p of c.phones ?? []) insert(db, 'ZABCDPHONENUMBER', { Z_PK: phonePk++, Z_ENT: 22, ZOWNER: c.pk, ZFULLNUMBER: p, ZLABEL: '_$!<Mobile>!$_' });
    for (const e of c.emails ?? []) insert(db, 'ZABCDEMAILADDRESS', { Z_PK: phonePk++, Z_ENT: 23, ZOWNER: c.pk, ZADDRESS: e, ZADDRESSNORMALIZED: e.toLowerCase() });
  }
}

// ---------- Messages chat.db ----------
// An NSAttributedString typedstream with the given text.
export function attributedBody(text) {
  const bytes = Buffer.from(text, 'utf8');
  const len = bytes.length < 0x80 ? Buffer.from([bytes.length]) : bytes.length < 0x10000 ? Buffer.concat([Buffer.from([0x81]), Buffer.from([bytes.length & 0xff, bytes.length >> 8])]) : null;
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]), Buffer.from('streamtyped', 'latin1'), Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84, 0x12]),
    Buffer.from('NSAttributedString', 'latin1'), Buffer.from([0x00, 0x84, 0x84, 0x08]), Buffer.from('NSObject', 'latin1'),
    Buffer.from([0x00, 0x85, 0x92, 0x84, 0x84, 0x84, 0x08]), Buffer.from('NSString', 'latin1'), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
    len, bytes, Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49, 0x01]),
  ]);
}

export function chatDb(home, { legacy = false } = {}) {
  const modern = legacy ? '' : ', thread_originator_guid TEXT, destination_caller_id TEXT, date_retracted INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0, is_audio_message INTEGER DEFAULT 0';
  return createDb(
    join(home, 'Library/Messages/chat.db'),
    `CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT);
     CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER, account_id TEXT, chat_identifier TEXT,
       service_name TEXT, room_name TEXT, display_name TEXT, group_id TEXT, is_archived INTEGER DEFAULT 0);
     CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id));
     CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
     CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, replace INTEGER DEFAULT 0, handle_id INTEGER DEFAULT 0,
       subject TEXT, attributedBody BLOB, type INTEGER DEFAULT 0, service TEXT, account TEXT, date INTEGER, date_read INTEGER, date_delivered INTEGER,
       is_from_me INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, group_action_type INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0,
       balloon_bundle_id TEXT, associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0${modern});
     CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, created_date INTEGER DEFAULT 0, filename TEXT, uti TEXT,
       mime_type TEXT, transfer_state INTEGER DEFAULT 0, is_outgoing INTEGER DEFAULT 0, transfer_name TEXT, total_bytes INTEGER DEFAULT 0);
     CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER, UNIQUE(message_id, attachment_id));`,
  );
}

let msgN = 0;
export function addMessage(db, { chat, handle = 0, text = null, body = null, at, fromMe = false, service = 'iMessage', assoc = 0, itemType = 0, retracted = false, edited = false, myId, replyTo, seconds = false }) {
  const guid = `MSG-${++msgN}`;
  const row = {
    guid, text, handle_id: handle, attributedBody: body ? attributedBody(body) : null, service,
    date: seconds ? Math.round(appleSeconds(at)) : appleNanos(at), is_from_me: fromMe ? 1 : 0, item_type: itemType, associated_message_type: assoc,
  };
  if (myId !== undefined) row.destination_caller_id = myId;
  if (retracted) row.date_retracted = appleNanos(at);
  if (edited) row.date_edited = appleNanos(at);
  if (replyTo) row.thread_originator_guid = replyTo;
  insert(db, 'message', row);
  const rowid = db.prepare('SELECT ROWID AS r FROM message WHERE guid = ?').get(guid).r;
  if (chat) insert(db, 'chat_message_join', { chat_id: chat, message_id: rowid, message_date: 0 });
  return { rowid, guid };
}

// ---------- Apple Notes (call recordings) ----------
export function noteBody(text, attachments = []) {
  const runs = attachments.map((a) => encodeField(5, encodeMessage(encodeField(1, 1), encodeField(12, encodeMessage(encodeField(1, a.id), encodeField(2, a.uti))))));
  const note = encodeMessage(encodeField(2, text), ...runs);
  const doc = encodeMessage(encodeField(2, 0), encodeField(3, note));
  return gzipSync(encodeMessage(encodeField(2, doc)));
}

export function noteStore(home) {
  return createDb(
    join(home, 'Library/Group Containers/group.com.apple.notes/NoteStore.sqlite'),
    `CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZIDENTIFIER VARCHAR, ZTITLE1 VARCHAR, ZTITLE2 VARCHAR, ZSNIPPET VARCHAR,
       ZFOLDER INTEGER, ZNOTE INTEGER, ZMEDIA INTEGER, ZTYPEUTI VARCHAR, ZADDITIONALINDEXABLETEXT VARCHAR, ZFILENAME VARCHAR, ZGENERATION VARCHAR,
       ZUSERTITLE VARCHAR, ZDURATION FLOAT, ZMARKEDFORDELETION INTEGER, ZCREATIONDATE1 TIMESTAMP, ZCREATIONDATE3 TIMESTAMP, ZMODIFICATIONDATE1 TIMESTAMP,
       ZACCOUNT7 INTEGER, ZNAME VARCHAR);
     CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZNOTE INTEGER, ZDATA BLOB);`,
  );
}

// ---------- Call history ----------
export function callHistory(home) {
  return createDb(
    join(home, 'Library/Application Support/CallHistoryDB/CallHistory.storedata'),
    `CREATE TABLE ZCALLRECORD (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZANSWERED INTEGER, ZCALLTYPE INTEGER, ZDISCONNECTED_CAUSE INTEGER,
       ZFACE_TIME_DATA BLOB, ZNUMBER_AVAILABILITY INTEGER, ZORIGINATED INTEGER, ZREAD INTEGER, ZJUNKCONFIDENCE INTEGER, ZDATE TIMESTAMP, ZDURATION FLOAT,
       ZADDRESS BLOB, ZDEVICE_ID VARCHAR, ZISO_COUNTRY_CODE VARCHAR, ZLOCATION VARCHAR, ZNAME VARCHAR, ZSERVICE_PROVIDER VARCHAR, ZUNIQUE_ID VARCHAR);`,
  );
}

export { appleSeconds, appleNanos };

// ---------- WhatsApp ChatStorage.sqlite ----------
export function whatsappDb(home) {
  const base = join(home, 'Library/Group Containers/group.net.whatsapp.WhatsApp.shared');
  const db = createDb(
    join(base, 'ChatStorage.sqlite'),
    `CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZSESSIONTYPE INTEGER, ZARCHIVED INTEGER, ZCONTACTJID VARCHAR, ZPARTNERNAME VARCHAR, ZLASTMESSAGEDATE TIMESTAMP);
     CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZCHATSESSION INTEGER, ZISADMIN INTEGER, ZMEMBERJID VARCHAR, ZCONTACTNAME VARCHAR, ZFIRSTNAME VARCHAR);
     CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZISFROMME INTEGER, ZMESSAGETYPE INTEGER, ZSTARRED INTEGER, ZCHATSESSION INTEGER,
       ZGROUPMEMBER INTEGER, ZMEDIAITEM INTEGER, ZMESSAGEDATE TIMESTAMP, ZSENTDATE TIMESTAMP, ZFROMJID VARCHAR, ZPUSHNAME VARCHAR, ZSTANZAID VARCHAR,
       ZTEXT VARCHAR, ZTOJID VARCHAR, ZGROUPEVENTTYPE INTEGER);
     CREATE TABLE ZWAMEDIAITEM (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZMESSAGE INTEGER, ZFILESIZE INTEGER, ZMOVIEDURATION INTEGER, ZMEDIALOCALPATH VARCHAR, ZTITLE VARCHAR, ZVCARDNAME VARCHAR);
     CREATE TABLE ZWAPROFILEPUSHNAME (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZJID VARCHAR, ZPUSHNAME VARCHAR);`,
  );
  return { db, base };
}

export function whatsappContacts(base, rows) {
  const db = createDb(join(base, 'ContactsV2.sqlite'), 'CREATE TABLE ZWAADDRESSBOOKCONTACT (Z_PK INTEGER PRIMARY KEY, ZFULLNAME VARCHAR, ZPHONENUMBER VARCHAR, ZWHATSAPPID VARCHAR, ZLID VARCHAR);');
  insert(db, 'ZWAADDRESSBOOKCONTACT', rows);
  return db;
}

let waPk = 0;
export function addWa(db, { chat, text = null, at, fromMe = false, type = 0, member = null, fromJid = null, toJid = null, push = null, stanza, caption, duration }) {
  const pk = ++waPk;
  insert(db, 'ZWAMESSAGE', {
    Z_PK: pk, Z_ENT: 9, ZISFROMME: fromMe ? 1 : 0, ZMESSAGETYPE: type, ZCHATSESSION: chat, ZGROUPMEMBER: member, ZMESSAGEDATE: appleSeconds(at),
    ZFROMJID: fromJid, ZTOJID: toJid, ZPUSHNAME: push, ZSTANZAID: stanza ?? `3EB0${pk}`, ZTEXT: text,
  });
  if (caption !== undefined || duration !== undefined) insert(db, 'ZWAMEDIAITEM', { Z_PK: pk, Z_ENT: 10, ZMESSAGE: pk, ZTITLE: caption ?? null, ZMOVIEDURATION: duration ?? null });
  return pk;
}

// ---------- Apple Mail (Envelope Index + .emlx) ----------
export const MAIL_WORK = 'AAAAAAAA-1111-4111-8111-111111111111';
export const MAIL_HOME = 'BBBBBBBB-2222-4222-8222-222222222222';
export const MAIL_STORE = 'CCCCCCCC-3333-4333-8333-333333333333';
const unixSeconds = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const mailShard = (rowid) => String(Math.floor(rowid / 1000)).split('').reverse().join('/');

// "<byte count>\n" + the RFC 822 message (CRLF) + Apple's plist trailer.
export function emlx(message) {
  const body = Buffer.from(message.replace(/\r?\n/g, '\r\n'));
  return Buffer.concat([Buffer.from(`${body.length}\n`), body, Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>flags</key><integer>8590195713</integer></dict></plist>\n')]);
}

// A Mail store under <home>/Library/Mail/V10.
//   mailboxes  [{ id, account (UUID), path ('INBOX', '[Gmail]/Sent Mail') }]
//   addresses  { key: [address, display name] }; add() also takes raw addresses or { address, name }
//   accounts   Accounts4 rows: [{ uuid, address, viaParent }] (viaParent puts the address on a parent account)
// add({ rowid, box, from, subject, prefix, at, to, cc, conv, file, partial, mid, listId, labels, summary, deleted, messageId })
//   box is a mailbox id; file is the raw message text (written as .emlx in Mail's shard folder).
export function mailStore(home, { mailboxes = [{ id: 1, account: MAIL_WORK, path: 'INBOX' }, { id: 2, account: MAIL_WORK, path: 'Sent Messages' }], addresses = {}, accounts = [] } = {}) {
  const root = join(home, 'Library/Mail/V10');
  const db = createDb(
    join(root, 'MailData/Envelope Index'),
    `CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url UNIQUE, total_count INTEGER DEFAULT 0, unread_count INTEGER DEFAULT 0, source INTEGER);
     CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject COLLATE RTRIM);
     CREATE TABLE summaries (ROWID INTEGER PRIMARY KEY, summary TEXT);
     CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address COLLATE NOCASE, comment);
     CREATE TABLE message_global_data (ROWID INTEGER PRIMARY KEY, message_id INTEGER, model_category INTEGER, message_id_header TEXT);
     CREATE TABLE messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL DEFAULT 0, global_message_id INTEGER, remote_id INTEGER,
       document_id TEXT, sender INTEGER, subject_prefix TEXT, subject INTEGER NOT NULL, summary INTEGER, date_sent INTEGER, date_received INTEGER,
       mailbox INTEGER NOT NULL, remote_mailbox INTEGER, flags INTEGER NOT NULL DEFAULT 0, read INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0,
       deleted INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, conversation_id INTEGER NOT NULL DEFAULT 0, list_id_hash INTEGER, unsubscribe_type INTEGER);
     CREATE TABLE recipients (ROWID INTEGER PRIMARY KEY, message INTEGER NOT NULL, address INTEGER NOT NULL, type INTEGER, position INTEGER);
     CREATE TABLE labels (message_id INTEGER NOT NULL, mailbox_id INTEGER NOT NULL, PRIMARY KEY (message_id, mailbox_id));`,
  );
  const boxes = new Map();
  for (const b of mailboxes) {
    insert(db, 'mailboxes', { ROWID: b.id, url: `imap://${b.account}/${b.path.split('/').map(encodeURIComponent).join('/')}` });
    boxes.set(b.id, b);
  }
  const ids = new Map();
  let nextAddress = 1;
  const addAddress = (address, name = null) => {
    const key = String(address).toLowerCase();
    if (!ids.has(key)) {
      insert(db, 'addresses', { ROWID: nextAddress, address, comment: name ?? '' });
      ids.set(key, nextAddress++);
    }
    return ids.get(key);
  };
  for (const [key, [address, name]] of Object.entries(addresses)) ids.set(`key:${key}`, addAddress(address, name));
  const addressId = (who) => {
    if (who && typeof who === 'object') return addAddress(who.address, who.name);
    return ids.get(`key:${who}`) ?? addAddress(who);
  };
  if (accounts.length) {
    const adb = createDb(join(home, 'Library/Accounts/Accounts4.sqlite'), 'CREATE TABLE ZACCOUNT (Z_PK INTEGER PRIMARY KEY, ZIDENTIFIER VARCHAR, ZUSERNAME VARCHAR, ZPARENTACCOUNT INTEGER, ZACCOUNTDESCRIPTION VARCHAR);');
    let pk = 1;
    for (const a of accounts) {
      if (a.viaParent) {
        insert(adb, 'ZACCOUNT', { Z_PK: pk, ZIDENTIFIER: `PARENT-${pk}`, ZUSERNAME: a.address, ZACCOUNTDESCRIPTION: 'Parent' });
        insert(adb, 'ZACCOUNT', { Z_PK: pk + 1, ZIDENTIFIER: a.uuid, ZUSERNAME: null, ZPARENTACCOUNT: pk });
        pk += 2;
      } else insert(adb, 'ZACCOUNT', { Z_PK: pk++, ZIDENTIFIER: a.uuid, ZUSERNAME: a.address });
    }
  }
  let subjects = 0;
  const add = ({ rowid, box = 1, from, subject, prefix = null, at, to = [], cc = [], conv = 0, deleted = 0, summary = null, file, partial = false, mid, listId = null, labels = [], messageId }) => {
    insert(db, 'subjects', { ROWID: ++subjects, subject });
    if (summary) insert(db, 'summaries', { ROWID: subjects, summary });
    if (mid) insert(db, 'message_global_data', { ROWID: rowid, message_id: rowid * 7, message_id_header: mid });
    insert(db, 'messages', {
      ROWID: rowid, message_id: messageId ?? 9007199254740993n + BigInt(rowid), global_message_id: mid ? rowid : null, sender: addressId(from), subject_prefix: prefix,
      subject: subjects, summary: summary ? subjects : null, date_sent: unixSeconds(at), date_received: unixSeconds(at) + 5, mailbox: box, deleted, conversation_id: conv, list_id_hash: listId,
    });
    to.forEach((a, i) => insert(db, 'recipients', { message: rowid, address: addressId(a), type: 0, position: i }));
    cc.forEach((a, i) => insert(db, 'recipients', { message: rowid, address: addressId(a), type: 1, position: i }));
    for (const l of labels) insert(db, 'labels', { message_id: rowid, mailbox_id: l });
    if (!file) return null;
    const b = boxes.get(box);
    const path = join(root, b.account, ...b.path.split('/').map((s) => `${s}.mbox`), MAIL_STORE, 'Data', mailShard(rowid), 'Messages', `${rowid}${partial ? '.partial' : ''}.emlx`);
    return writeFile(path, emlx(file));
  };
  return { db, root, add };
}

// ---------- Calendar.sqlitedb ----------
// calendarStore(home, { stores, calendars }) -> { db, item(row), addEvent(event) }
//   item(row)      raw CalendarItem insert (event defaults filled in)
//   addEvent({ rowid, title, start, end, allDay, uuid, uid, calendar, location (text or { title, address }), description, conferenceUrl, status,
//              organizer: { email, name } | 'self', attendees: [{ email, name, status, self }], occurrences: [iso start] })
//   start/end are ISO times, or YYYY-MM-DD with allDay. Returns the CalendarItem ROWID.
export function calendarStore(home, { stores = [{ ROWID: 1, name: 'iCloud', type: 1, disabled: 0 }], calendars = [{ ROWID: 1, store_id: 1, title: 'Work' }] } = {}) {
  const db = createDb(
    join(home, 'Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb'),
    `CREATE TABLE Store (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type INTEGER, disabled INTEGER, external_id TEXT);
     CREATE TABLE Calendar (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, store_id INTEGER, title TEXT, flags INTEGER, color TEXT, type TEXT, UUID TEXT);
     CREATE TABLE CalendarItem (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT, location_id INTEGER, description TEXT, start_date REAL, start_tz TEXT,
       end_date REAL, end_tz TEXT, all_day INTEGER, calendar_id INTEGER, orig_item_id INTEGER, orig_date REAL, organizer_id INTEGER, self_attendee_id INTEGER,
       status INTEGER, invitation_status INTEGER, availability INTEGER, url TEXT, last_modified REAL, birthday_id INTEGER, external_id TEXT,
       unique_identifier TEXT, hidden INTEGER, has_recurrences INTEGER, has_attendees INTEGER, UUID TEXT, entity_type INTEGER, conference_url TEXT,
       conference_url_detected TEXT);
     CREATE TABLE Participant (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, entity_type INTEGER, type INTEGER, status INTEGER, pending_status INTEGER, role INTEGER,
       identity_id INTEGER, owner_id INTEGER, UUID TEXT, email TEXT, phone_number TEXT, is_self INTEGER, comment TEXT);
     CREATE TABLE Identity (display_name TEXT, address TEXT, first_name TEXT, last_name TEXT);
     CREATE TABLE Location (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, address TEXT, latitude REAL, longitude REAL, item_owner_id INTEGER);
     CREATE TABLE OccurrenceCache (day REAL, event_id INTEGER, calendar_id INTEGER, store_id INTEGER, occurrence_date REAL, occurrence_start_date REAL, occurrence_end_date REAL);`,
  );
  insert(db, 'Store', stores);
  insert(db, 'Calendar', calendars);
  const lastId = () => Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  const item = (row) => {
    insert(db, 'CalendarItem', { entity_type: 2, hidden: 0, calendar_id: 1, start_tz: 'America/New_York', all_day: 0, last_modified: appleSeconds('2026-08-01T00:00:00Z'), ...row });
    return row.ROWID ?? lastId();
  };
  const participant = (owner, p, extra = {}) => {
    let identity = null;
    if (p.name) {
      insert(db, 'Identity', { display_name: p.name, address: p.email ? `mailto:${p.email}` : null });
      identity = lastId();
    }
    insert(db, 'Participant', { owner_id: owner, identity_id: identity, email: p.email ?? null, status: p.status ?? 2, is_self: p.self ? 1 : 0, ...extra });
    return lastId();
  };
  const when = (value, allDay) => (allDay ? appleSeconds(`${value}T00:00:00Z`) : appleSeconds(value));
  const addEvent = ({ rowid, title, start, end, allDay = false, uuid, uid, calendar = 1, location, description, conferenceUrl, status, organizer, attendees = [], occurrences = [] }) => {
    let locationId = null;
    if (location) {
      insert(db, 'Location', typeof location === 'string' ? { title: location } : { title: location.title, address: location.address ?? null });
      locationId = lastId();
    }
    const id = item({
      ...(rowid ? { ROWID: rowid } : {}), summary: title, calendar_id: calendar, start_date: when(start, allDay), end_date: end ? when(end, allDay) : null,
      all_day: allDay ? 1 : 0, start_tz: allDay ? '_float' : 'America/New_York', location_id: locationId, description: description ?? null,
      conference_url: conferenceUrl ?? null, status: status ?? null, has_recurrences: occurrences.length ? 1 : 0,
    });
    db.prepare('UPDATE CalendarItem SET UUID = ?, unique_identifier = ? WHERE ROWID = ?').run(uuid ?? `EV-${id}`, uid ?? null, id);
    if (organizer && organizer !== 'self') db.prepare('UPDATE CalendarItem SET organizer_id = ? WHERE ROWID = ?').run(participant(id, organizer, { role: 1 }), id);
    for (const a of attendees) participant(id, a);
    const length = end ? when(end, allDay) - when(start, allDay) : 0;
    for (const o of occurrences) {
      const s = when(o, allDay);
      insert(db, 'OccurrenceCache', { event_id: id, calendar_id: calendar, store_id: 1, occurrence_date: s, occurrence_end_date: s + length });
    }
    return id;
  };
  return { db, item, addEvent };
}
