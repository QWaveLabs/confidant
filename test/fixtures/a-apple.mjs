// Builders for synthetic copies of Apple app databases, with the real table
// and column names (subsets). All data is invented.
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createDb, insert, appleSeconds, appleNanos } from './a-fixtures.mjs';
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
