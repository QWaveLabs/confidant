// Read-only checks that confirm Unit A's schema assumptions on a real Mac,
// once Full Disk Access is granted. Output is counts, booleans, column and
// table names and type identifiers only: never message text, names,
// addresses, titles or file names from the person's data. Any other string is
// replaced with "[redacted]" before it leaves this module.
// Databases are read through copies (openCopy), never opened in place.
//   sh bin/node engine/lib/a-real-probe.mjs [source id]      prints JSON
// docs/real-probe.md explains each check and what to do when it disagrees.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, release, tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canRead } from './sqlite.mjs';
import { openCopy, closeCopies, columns, tableNames } from './a-local.mjs';
import { addressBookDbs } from './a-addressbook.mjs';
import { readAudioTranscript } from './a-mp4.mjs';
import { decodeAttributedBody } from '../extract/imessage.mjs';
import { mailRoot, parseMailboxUrl, boxKind, shard, mailboxDir, walkEmlx } from '../extract/mail.mjs';
import { dbPath as calendarPath } from '../extract/calendar.mjs';
import { readNotes } from '../extract/call-recordings.mjs';
import { recordingsDir, readMemos, audioFile } from '../extract/voice-memos.mjs';

const WA = 'Library/Group Containers/group.net.whatsapp.WhatsApp.shared';
const NOTES = 'Library/Group Containers/group.com.apple.notes';
const CALL_FOLDERS = "('Call Recordings','Grabaciones de llamadas')";

export const DATABASES = {
  chat: (home) => join(home, 'Library/Messages/chat.db'),
  contacts: (home) => addressBookDbs({ home }).map((d) => d.path),
  whatsapp: (home) => join(home, WA, 'ChatStorage.sqlite'),
  whatsapp_contacts: (home) => join(home, WA, 'ContactsV2.sqlite'),
  mail: (home) => mailRoot({ home })?.index ?? null,
  accounts: (home) => join(home, 'Library/Accounts/Accounts4.sqlite'),
  calendar: (home) => calendarPath({ home }),
  calls: (home) => join(home, 'Library/Application Support/CallHistoryDB/CallHistory.storedata'),
  notes: (home) => join(home, NOTES, 'NoteStore.sqlite'),
  voice_memos: (home) => join(recordingsDir({ home }), 'CloudRecordings.db'),
  wispr: (home) => join(home, 'Library/Application Support/Wispr Flow/flow.sqlite'),
};

const cols = (table, names) => `SELECT name FROM pragma_table_info('${table}') WHERE name IN (${names.map((n) => `'${n}'`).join(',')}) ORDER BY name`;
const tables = (names) => `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${names.map((n) => `'${n}'`).join(',')}) ORDER BY name`;
const sql = (id, source, db, query, expect, shape = 'row') => ({ id, source, db, sql: query, expect, shape });
const js = (id, source, expect, run) => ({ id, source, expect, run });

const safeDir = (dir) => {
  try {
    return readdirSync(dir).filter((f) => !f.startsWith('.'));
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') throw Object.assign(err, { needsFullDiskAccess: true });
    return [];
  }
};
const WISPR_FILES = new Set(['refined.ndjson', 'raw.ndjson', 'transcript.ndjson', 'transcript.json', 'summary.json', 'metadata.json', 'audio.m4a', 'audio.wav', 'audio.webm']);
const tally = (list) => list.reduce((acc, k) => ((acc[k] = (acc[k] ?? 0) + 1), acc), {});

export const CHECKS = [
  // iMessage
  sql('imessage.columns', 'imessage', 'chat', cols('message', ['text', 'attributedBody', 'date', 'handle_id', 'service', 'is_from_me', 'associated_message_type', 'item_type', 'destination_caller_id', 'date_edited', 'date_retracted', 'thread_originator_guid', 'is_audio_message', 'balloon_bundle_id', 'cache_has_attachments']), 'All 15 names. Missing ones are read as NULL, so the extractor still works.', 'list'),
  sql('imessage.date_unit', 'imessage', 'chat', 'SELECT COUNT(*) AS messages, MAX(date) > 100000000000000 AS nanoseconds FROM message', 'nanoseconds = 1 (dates are nanoseconds since 2001).'),
  sql('imessage.body', 'imessage', 'chat', "SELECT SUM(text IS NULL OR text = '') AS no_text, SUM((text IS NULL OR text = '') AND attributedBody IS NOT NULL) AS body_only FROM message", 'body_only close to no_text: text lives in attributedBody.'),
  js('imessage.decode', 'imessage', 'decoded close to sampled: the attributedBody decoder works on this macOS.', (env) => {
    const rows = env.open('chat').prepare("SELECT attributedBody AS body FROM message WHERE (text IS NULL OR text = '') AND attributedBody IS NOT NULL ORDER BY ROWID DESC LIMIT 500").all();
    return { sampled: rows.length, decoded: rows.filter((r) => decodeAttributedBody(r.body)?.trim()).length };
  }),
  sql('imessage.associated', 'imessage', 'chat', 'SELECT associated_message_type AS value, COUNT(*) AS n FROM message WHERE associated_message_type <> 0 GROUP BY 1 ORDER BY 1', 'Only 2, 3, 1000, 2000 to 2007, 3000 to 3007 and 4000. Values of 1000 and up are skipped.', 'rows'),
  sql('imessage.item_types', 'imessage', 'chat', 'SELECT item_type AS value, COUNT(*) AS n FROM message GROUP BY 1 ORDER BY 1', 'Mostly 0. Anything else is a group event and is skipped.', 'rows'),
  sql('imessage.chat_styles', 'imessage', 'chat', 'SELECT style AS value, COUNT(*) AS n FROM chat GROUP BY 1 ORDER BY 1', '43 (groups) and 45 (direct chats).', 'rows'),

  // Contacts (one result per address book)
  sql('contacts.entities', 'contacts', 'contacts', "SELECT Z_NAME AS value, Z_ENT AS n FROM Z_PRIMARYKEY WHERE Z_NAME IN ('ABCDContact','ABCDGroup','ABCDRecord') ORDER BY 1", 'ABCDContact is listed in every book.', 'rows'),
  sql('contacts.columns', 'contacts', 'contacts', cols('ZABCDRECORD', ['Z_ENT', 'ZFIRSTNAME', 'ZLASTNAME', 'ZMIDDLENAME', 'ZNICKNAME', 'ZORGANIZATION', 'ZJOBTITLE', 'ZDEPARTMENT', 'ZNAME', 'ZUNIQUEID', 'ZMODIFICATIONDATE', 'ZCREATIONDATE']), 'All 12 names.', 'list'),
  sql('contacts.counts', 'contacts', 'contacts', 'SELECT (SELECT COUNT(*) FROM ZABCDRECORD) AS records, (SELECT COUNT(*) FROM ZABCDPHONENUMBER) AS phones, (SELECT COUNT(*) FROM ZABCDEMAILADDRESS) AS emails', 'Non-zero in the account books (Sources).'),

  // WhatsApp
  sql('whatsapp.tables', 'whatsapp', 'whatsapp', tables(['ZWAMESSAGE', 'ZWACHATSESSION', 'ZWAGROUPMEMBER', 'ZWAMEDIAITEM', 'ZWAPROFILEPUSHNAME']), 'All five tables.', 'list'),
  sql('whatsapp.message_columns', 'whatsapp', 'whatsapp', cols('ZWAMESSAGE', ['ZTEXT', 'ZMESSAGEDATE', 'ZISFROMME', 'ZFROMJID', 'ZTOJID', 'ZCHATSESSION', 'ZGROUPMEMBER', 'ZMESSAGETYPE', 'ZPUSHNAME', 'ZSTANZAID', 'ZSTARRED']), 'All 11 names.', 'list'),
  sql('whatsapp.session_columns', 'whatsapp', 'whatsapp', cols('ZWACHATSESSION', ['ZCONTACTJID', 'ZPARTNERNAME', 'ZSESSIONTYPE', 'ZCONTACTIDENTIFIER']), 'The first three; ZCONTACTIDENTIFIER only on newer builds.', 'list'),
  sql('whatsapp.types', 'whatsapp', 'whatsapp', 'SELECT ZMESSAGETYPE AS value, COUNT(*) AS n FROM ZWAMESSAGE GROUP BY 1 ORDER BY 1', 'Mostly 0. Kept: 0, 7, 27, 46 as text; 1, 2, 3, 4, 5, 8, 11, 38, 39, 53, 54 as media. Large counts of other codes need a look.', 'rows'),
  sql('whatsapp.sessions', 'whatsapp', 'whatsapp', 'SELECT ZSESSIONTYPE AS value, COUNT(*) AS n FROM ZWACHATSESSION GROUP BY 1 ORDER BY 1', '0 direct, 1 group, 2 broadcast, 3 status, 4 community. Only 0 and 1 are read.', 'rows'),
  sql('whatsapp.captions', 'whatsapp', 'whatsapp', "SELECT COUNT(*) AS images, SUM(m.ZTEXT IS NOT NULL AND m.ZTEXT <> '') AS text_set, SUM(i.ZTITLE IS NOT NULL AND i.ZTITLE <> '') AS media_title_set FROM ZWAMESSAGE m LEFT JOIN ZWAMEDIAITEM i ON i.ZMESSAGE = m.Z_PK WHERE m.ZMESSAGETYPE = 1", 'Captions show up in media_title_set (ZWAMEDIAITEM.ZTITLE). Both are read.'),
  sql('whatsapp.group_sender', 'whatsapp', 'whatsapp', 'SELECT COUNT(*) AS incoming_group, SUM(m.ZGROUPMEMBER IS NOT NULL) AS with_member FROM ZWAMESSAGE m JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION WHERE s.ZSESSIONTYPE = 1 AND m.ZISFROMME = 0', 'with_member close to incoming_group: group senders resolve through ZGROUPMEMBER.'),
  sql('whatsapp.lids', 'whatsapp', 'whatsapp', "SELECT (SELECT COUNT(*) FROM ZWAGROUPMEMBER) AS members, (SELECT SUM(ZMEMBERJID LIKE '%@lid') FROM ZWAGROUPMEMBER) AS lid_members, (SELECT SUM(ZCONTACTJID LIKE '%@lid') FROM ZWACHATSESSION) AS lid_chats", 'How many people are known only by an @lid id (no phone).'),
  sql('whatsapp.push_names', 'whatsapp', 'whatsapp', 'SELECT COUNT(*) AS n FROM ZWAPROFILEPUSHNAME', 'Non-zero: push names fill in names for @lid ids.'),
  sql('whatsapp.contacts_v2', 'whatsapp', 'whatsapp_contacts', cols('ZWAADDRESSBOOKCONTACT', ['ZLID', 'ZWHATSAPPID', 'ZPHONENUMBER', 'ZFULLNAME']), 'All four: @lid ids map to phones through ContactsV2.sqlite.', 'list'),
  js('whatsapp.lid_mapping', 'whatsapp', 'mapped close to lids. A low number means many group members appear by name only.', (env) => {
    const wa = env.open('whatsapp');
    const strip = (r) => String(r.j).replace(/@lid$/, '');
    const lids = new Set([...wa.prepare("SELECT ZMEMBERJID AS j FROM ZWAGROUPMEMBER WHERE ZMEMBERJID LIKE '%@lid'").all(), ...wa.prepare("SELECT ZCONTACTJID AS j FROM ZWACHATSESSION WHERE ZCONTACTJID LIKE '%@lid'").all()].map(strip));
    if (!env.exists('whatsapp_contacts')) return { lids: lids.size, contacts_v2: false };
    const known = new Set(env.open('whatsapp_contacts').prepare('SELECT ZLID AS j FROM ZWAADDRESSBOOKCONTACT WHERE ZLID IS NOT NULL').all().map(strip));
    return { lids: lids.size, mapped: [...lids].filter((l) => known.has(l)).length };
  }),

  // Mail
  sql('email.tables', 'email', 'mail', tables(['messages', 'subjects', 'summaries', 'addresses', 'recipients', 'mailboxes', 'message_global_data', 'labels']), 'All eight tables (labels only when a Gmail account is set up).', 'list'),
  sql('email.message_columns', 'email', 'mail', cols('messages', ['message_id', 'global_message_id', 'sender', 'subject_prefix', 'subject', 'summary', 'date_sent', 'date_received', 'mailbox', 'conversation_id', 'read', 'flagged', 'deleted', 'list_id_hash', 'unsubscribe_type']), 'All 15 names.', 'list'),
  sql('email.global_columns', 'email', 'mail', cols('message_global_data', ['message_id_header']), 'message_id_header (used for message:// links).', 'list'),
  sql('email.epoch', 'email', 'mail', 'SELECT COUNT(*) AS messages, MAX(date_received) > 1200000000 AS unix_seconds FROM messages', 'unix_seconds = 1 (the extractor also detects this at run time).'),
  sql('email.message_ids', 'email', 'mail', 'SELECT COUNT(*) AS rows, COUNT(DISTINCT message_id) AS ids, SUM(message_id = 0) AS zero FROM messages', 'zero is small: message_id is the record id; rows with 0 fall back to ROWID.'),
  sql('email.copies', 'email', 'mail', 'SELECT COUNT(*) AS in_several_mailboxes FROM (SELECT message_id FROM messages WHERE message_id <> 0 GROUP BY message_id HAVING COUNT(DISTINCT mailbox) > 1)', 'Any number: copies of one email collapse into one record.'),
  sql('email.id_collisions', 'email', 'mail', 'SELECT COUNT(*) AS collisions FROM (SELECT m.message_id FROM messages m JOIN message_global_data g ON g.ROWID = m.global_message_id WHERE m.message_id <> 0 AND g.message_id_header IS NOT NULL GROUP BY m.message_id HAVING COUNT(DISTINCT g.message_id_header) > 1)', 'collisions = 0: one message_id never covers two different emails.'),
  sql('email.mailbox_hosts', 'email', 'mail', "SELECT COUNT(*) AS mailboxes, SUM(url GLOB '*://[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]-[0-9A-F][0-9A-F][0-9A-F][0-9A-F]-*') AS uuid_hosts, SUM(url LIKE '%@%') AS address_hosts FROM mailboxes", 'uuid_hosts close to mailboxes (imap://<ACCOUNT-UUID>/INBOX).'),
  sql('email.recipient_types', 'email', 'mail', 'SELECT type AS value, COUNT(*) AS n FROM recipients GROUP BY 1 ORDER BY 1', '0 (to), 1 (cc), 2 (bcc) only.', 'rows'),
  sql('email.labels', 'email', 'mail', 'SELECT COUNT(*) AS n FROM labels', 'Non-zero with Gmail: labels mark Inbox, Spam and Trash.'),
  js('email.mailbox_kinds', 'email', 'Every account has a Sent mailbox (it names the account address); skip counts Junk, Trash and Drafts.', (env) => {
    const counts = { mail: 0, sent: 0, skip: 0, unparsed: 0 };
    const accounts = new Map();
    for (const { url } of env.open('mail').prepare('SELECT url FROM mailboxes').all()) {
      const u = parseMailboxUrl(url);
      if (!u) {
        counts.unparsed++;
        continue;
      }
      const kind = boxKind(u.segments);
      counts[kind]++;
      accounts.set(u.host, accounts.get(u.host) || kind === 'sent');
    }
    return { ...counts, accounts: accounts.size, accounts_with_sent: [...accounts.values()].filter(Boolean).length };
  }),
  js('email.accounts', 'email', 'matched and with_address equal uuid_accounts: every Mail account resolves to an address through Accounts4.', (env) => {
    const hosts = new Set(env.open('mail').prepare('SELECT url FROM mailboxes').all().map((r) => parseMailboxUrl(r.url)?.host).filter((h) => h && /^[0-9A-F-]{36}$/i.test(h)));
    if (!env.exists('accounts')) return { uuid_accounts: hosts.size, accounts_db: false };
    const rows = env.open('accounts').prepare('SELECT Z_PK AS pk, ZIDENTIFIER AS ident, ZUSERNAME AS user, ZPARENTACCOUNT AS parent FROM ZACCOUNT').all();
    const byPk = new Map(rows.map((r) => [r.pk, r]));
    let matched = 0;
    let withAddress = 0;
    for (const h of hosts) {
      const r = rows.find((x) => x.ident === h);
      if (!r) continue;
      matched++;
      if (/@/.test(String(r.user ?? '')) || /@/.test(String(byPk.get(r.parent)?.user ?? ''))) withAddress++;
    }
    return { uuid_accounts: hosts.size, matched, with_address: withAddress };
  }),
  js('email.emlx_layout', 'email', 'shard_path close to sampled. elsewhere means the fallback walk is doing the work; missing means bodies not downloaded (the summary is used).', (env) => {
    const found = mailRoot({ home: env.home });
    const db = env.open('mail');
    const boxes = new Map(db.prepare('SELECT ROWID AS id, url FROM mailboxes').all().map((b) => [b.id, parseMailboxUrl(b.url)]));
    const rows = db.prepare('SELECT ROWID AS pk, mailbox FROM messages WHERE deleted = 0 ORDER BY ROWID DESC LIMIT 300').all();
    const out = { sampled: rows.length, shard_path: 0, partial: 0, elsewhere: 0, missing: 0 };
    let index = null;
    for (const r of rows) {
      const u = boxes.get(r.mailbox);
      let hit = null;
      if (u) {
        const dir = mailboxDir(found.root, { scheme: u.scheme, account: u.host, segments: u.segments });
        for (const store of safeDir(dir)) {
          for (const n of [`${r.pk}.emlx`, `${r.pk}.partial.emlx`]) {
            const p = join(dir, store, 'Data', shard(r.pk), 'Messages', n);
            if (!hit && existsSync(p)) hit = p;
          }
        }
      }
      if (hit) {
        out.shard_path++;
        if (hit.endsWith('.partial.emlx')) out.partial++;
        continue;
      }
      if (!index) walkEmlx(found.root, (index = new Map()));
      if (index.has(r.pk)) out.elsewhere++;
      else out.missing++;
    }
    return out;
  }),

  // Calendar
  sql('calendar.columns', 'calendar', 'calendar', cols('CalendarItem', ['summary', 'description', 'start_date', 'end_date', 'start_tz', 'all_day', 'calendar_id', 'location_id', 'organizer_id', 'self_attendee_id', 'status', 'url', 'conference_url', 'conference_url_detected', 'UUID', 'unique_identifier', 'last_modified', 'has_recurrences', 'orig_item_id', 'birthday_id', 'entity_type', 'hidden']), 'All 22 names.', 'list'),
  sql('calendar.entity_types', 'calendar', 'calendar', 'SELECT entity_type AS value, COUNT(*) AS n FROM CalendarItem GROUP BY 1 ORDER BY 1', '2 are events (read); other values are reminders (skipped).', 'rows'),
  sql('calendar.stores', 'calendar', 'calendar', 'SELECT type AS value, COUNT(*) AS n, SUM(disabled = 1) AS disabled FROM Store GROUP BY 1 ORDER BY 1', 'Types 5 (Found in Mail, Birthdays) and 6 (Reminders) are skipped, as are disabled stores.', 'rows'),
  sql('calendar.all_day', 'calendar', 'calendar', "SELECT COUNT(*) AS all_day, SUM(CAST(start_date AS INTEGER) % 86400 = 0) AS utc_midnight, SUM(start_tz = '_float') AS floating FROM CalendarItem WHERE all_day = 1 AND entity_type = 2", 'utc_midnight = all_day and floating = all_day. If utc_midnight is low, all-day dates are stored at local midnight (also handled).'),
  sql('calendar.floating_timed', 'calendar', 'calendar', "SELECT COUNT(*) AS n FROM CalendarItem WHERE all_day = 0 AND start_tz = '_float' AND entity_type = 2", 'Small: timed floating events are read as wall clock in the person\'s zone.'),
  sql('calendar.participant_status', 'calendar', 'calendar', 'SELECT status AS value, COUNT(*) AS n FROM Participant GROUP BY 1 ORDER BY 1', '0 to 7 only (EventKit: 2 accepted, 3 declined, 4 tentative).', 'rows'),
  sql('calendar.participants', 'calendar', 'calendar', 'SELECT COUNT(*) AS participants, SUM(is_self = 1) AS self_rows, SUM(identity_id > 0) AS with_identity, SUM(email IS NOT NULL) AS with_email FROM Participant', 'with_identity or with_email covers most rows: attendees have addresses.'),
  sql('calendar.organizers', 'calendar', 'calendar', 'SELECT COUNT(*) AS with_organizer, SUM(p.ROWID IS NOT NULL) AS linked FROM CalendarItem i LEFT JOIN Participant p ON p.ROWID = i.organizer_id WHERE i.organizer_id > 0', 'linked = with_organizer: organizer_id points at Participant.'),
  sql('calendar.occurrences', 'calendar', 'calendar', "SELECT (SELECT COUNT(*) FROM CalendarItem WHERE has_recurrences = 1 AND entity_type = 2) AS recurring, (SELECT COUNT(DISTINCT o.event_id) FROM OccurrenceCache o JOIN CalendarItem i ON i.ROWID = o.event_id WHERE i.has_recurrences = 1) AS recurring_cached, CAST(((SELECT MAX(occurrence_date) FROM OccurrenceCache) - (strftime('%s','now') - 978307200)) / 86400 AS INTEGER) AS days_ahead, CAST(((strftime('%s','now') - 978307200) - (SELECT MIN(occurrence_date) FROM OccurrenceCache)) / 86400 AS INTEGER) AS days_back", 'recurring_cached close to recurring, days_ahead at least 60. Series outside the cache appear once, at their first date.'),
  sql('calendar.status', 'calendar', 'calendar', 'SELECT status AS value, COUNT(*) AS n FROM CalendarItem WHERE entity_type = 2 GROUP BY 1 ORDER BY 1', '0 to 3 (3 = cancelled, kept with meta.status).', 'rows'),

  // Calls
  sql('calls.columns', 'calls', 'calls', cols('ZCALLRECORD', ['ZDATE', 'ZDURATION', 'ZADDRESS', 'ZNAME', 'ZORIGINATED', 'ZANSWERED', 'ZCALLTYPE', 'ZSERVICE_PROVIDER', 'ZUNIQUE_ID', 'ZJUNKCONFIDENCE']), 'All 10 names.', 'list'),
  sql('calls.types', 'calls', 'calls', 'SELECT ZCALLTYPE AS value, COUNT(*) AS n FROM ZCALLRECORD GROUP BY 1 ORDER BY 1', '1 phone, 8 FaceTime video, 16 FaceTime audio, 0 other apps.', 'rows'),
  sql('calls.providers', 'calls', 'calls', 'SELECT ZSERVICE_PROVIDER AS value, COUNT(*) AS n FROM ZCALLRECORD GROUP BY 1 ORDER BY 2 DESC', 'com.apple.Telephony and com.apple.FaceTime.', 'rows'),
  sql('calls.address_type', 'calls', 'calls', 'SELECT typeof(ZADDRESS) AS value, COUNT(*) AS n FROM ZCALLRECORD GROUP BY 1', 'blob (text is also handled).', 'rows'),
  sql('calls.answered', 'calls', 'calls', 'SELECT ZORIGINATED AS originated, ZANSWERED AS answered, SUM(ZDURATION = 0) AS zero_length, COUNT(*) AS n FROM ZCALLRECORD GROUP BY 1, 2', 'Incoming calls with answered = 1 and zero_length are answered elsewhere; they count as missed.', 'rows'),

  // Call recordings (Apple Notes)
  sql('call_recordings.columns', 'call_recordings', 'notes', cols('ZICCLOUDSYNCINGOBJECT', ['ZIDENTIFIER', 'ZTITLE1', 'ZTITLE2', 'ZSNIPPET', 'ZFOLDER', 'ZNOTE', 'ZMEDIA', 'ZTYPEUTI', 'ZADDITIONALINDEXABLETEXT', 'ZFILENAME', 'ZGENERATION', 'ZUSERTITLE', 'ZDURATION', 'ZMARKEDFORDELETION', 'ZCREATIONDATE1', 'ZCREATIONDATE3', 'ZMODIFICATIONDATE1', 'ZNEEDSTRANSCRIPTION', 'ZHOSTAPPLICATIONIDENTIFIER']), 'At least ZIDENTIFIER, ZTITLE1, ZTITLE2, ZFOLDER, ZTYPEUTI, ZMEDIA, ZADDITIONALINDEXABLETEXT and one ZCREATIONDATE column.', 'list'),
  sql('call_recordings.folders', 'call_recordings', 'notes', `SELECT COUNT(*) AS folders FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE2 IN ${CALL_FOLDERS}`, 'At least 1 once a call has been recorded on the iPhone. 0 with recordings means the folder has another name: check call_recordings.host_apps.'),
  sql('call_recordings.notes', 'call_recordings', 'notes', `SELECT COUNT(*) AS notes, SUM(ZTITLE1 LIKE 'Call with %' OR ZTITLE1 LIKE 'Llamada con %') AS named_titles, SUM(ZTITLE1 GLOB '*[0-9][0-9][0-9][0-9]*') AS numeric_titles, SUM(ZMARKEDFORDELETION = 1) AS deleted FROM ZICCLOUDSYNCINGOBJECT WHERE ZFOLDER IN (SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE2 IN ${CALL_FOLDERS})`, 'named_titles plus numeric_titles close to notes. Otherwise the title patterns need updating (the call history match still finds the other party).'),
  sql('call_recordings.audio', 'call_recordings', 'notes', "SELECT ZTYPEUTI AS value, COUNT(*) AS n, SUM(ZADDITIONALINDEXABLETEXT IS NOT NULL AND ZADDITIONALINDEXABLETEXT <> '') AS with_transcript, SUM(ZNOTE IS NOT NULL) AS with_note, SUM(ZMEDIA IS NOT NULL) AS with_media FROM ZICCLOUDSYNCINGOBJECT WHERE ZTYPEUTI LIKE '%audio%' GROUP BY 1", 'com.apple.m4a-audio with with_media close to n.', 'rows'),
  sql('call_recordings.call_audio', 'call_recordings', 'notes', `SELECT COUNT(*) AS n, SUM(a.ZADDITIONALINDEXABLETEXT IS NOT NULL AND a.ZADDITIONALINDEXABLETEXT <> '') AS with_transcript FROM ZICCLOUDSYNCINGOBJECT a JOIN ZICCLOUDSYNCINGOBJECT n ON n.Z_PK = a.ZNOTE WHERE a.ZTYPEUTI LIKE '%audio%' AND n.ZFOLDER IN (SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE2 IN ${CALL_FOLDERS})`, 'with_transcript close to n: Apple transcripts sit in ZADDITIONALINDEXABLETEXT.'),
  sql('call_recordings.host_apps', 'call_recordings', 'notes', 'SELECT ZHOSTAPPLICATIONIDENTIFIER AS value, COUNT(*) AS n FROM ZICCLOUDSYNCINGOBJECT WHERE ZHOSTAPPLICATIONIDENTIFIER IS NOT NULL GROUP BY 1', 'A Phone app identifier here would be a sturdier way to find call recordings than the folder name.', 'rows'),
  js('call_recordings.extractor_view', 'call_recordings', 'with_audio = call_notes; body_decoded = call_notes (protobuf path 2 > 3 > 2 holds).', (env) => {
    const notes = readNotes(env.open('notes'));
    return { call_notes: notes.length, with_audio: notes.filter((n) => n.att).length, with_transcript: notes.filter((n) => n.att?.transcript).length, body_decoded: notes.filter((n) => n.body).length };
  }),
  js('call_recordings.media_layout', 'call_recordings', 'generation_folder (or direct_files) close to audio_with_media: audio lives at Accounts/<id>/Media/<media id>/<generation>/<file>.', (env) => {
    const db = env.open('notes');
    if (!columns(db, 'ZICCLOUDSYNCINGOBJECT').has('ZMEDIA')) return { zmedia_column: false };
    const idents = db.prepare("SELECT m.ZIDENTIFIER AS ident FROM ZICCLOUDSYNCINGOBJECT a JOIN ZICCLOUDSYNCINGOBJECT m ON m.Z_PK = a.ZMEDIA WHERE a.ZTYPEUTI LIKE '%audio%'").all().map((r) => r.ident).filter(Boolean);
    const accounts = join(env.home, NOTES, 'Accounts');
    const out = { audio_with_media: idents.length, direct_files: 0, generation_folder: 0, missing: 0 };
    for (const ident of idents) {
      let nested = false;
      let direct = false;
      for (const acct of safeDir(accounts)) {
        const root = join(accounts, acct, 'Media', ident);
        for (const entry of safeDir(root)) {
          const p = join(root, entry);
          if (statSync(p).isDirectory()) nested ||= safeDir(p).length > 0;
          else direct = true;
        }
      }
      out[nested ? 'generation_folder' : direct ? 'direct_files' : 'missing']++;
    }
    return out;
  }),

  // Voice Memos
  sql('voice_memos.columns', 'voice_memos', 'voice_memos', cols('ZCLOUDRECORDING', ['ZDATE', 'ZDURATION', 'ZPATH', 'ZCUSTOMLABEL', 'ZENCRYPTEDTITLE', 'ZUNIQUEID', 'ZEVICTIONDATE', 'ZFLAGS', 'ZFOLDER']), 'All 9 names.', 'list'),
  sql('voice_memos.counts', 'voice_memos', 'voice_memos', "SELECT COUNT(*) AS total, SUM(ZEVICTIONDATE IS NOT NULL) AS evicted, SUM(ZPATH IS NULL OR ZPATH = '') AS no_path, SUM(ZENCRYPTEDTITLE IS NOT NULL AND ZENCRYPTEDTITLE <> '') AS titled FROM ZCLOUDRECORDING", 'evicted matches what Recently Deleted shows in the app (those are skipped).'),
  sql('voice_memos.flags', 'voice_memos', 'voice_memos', 'SELECT ZFLAGS AS value, COUNT(*) AS n, SUM(ZEVICTIONDATE IS NOT NULL) AS evicted FROM ZCLOUDRECORDING GROUP BY 1 ORDER BY 1', 'Shows whether a ZFLAGS value lines up with evicted rows.', 'rows'),
  js('voice_memos.files', 'voice_memos', 'missing is small; apple_transcripts counts memos with a built-in transcript.', (env) => {
    const dir = recordingsDir({ home: env.home });
    const memos = readMemos(env.open('voice_memos'));
    const out = { memos: memos.length, exact: 0, other_extension: 0, missing: 0, extensions: {}, apple_transcripts: 0 };
    for (const m of memos) {
      const file = audioFile(dir, m.path);
      if (!file) {
        out.missing++;
        continue;
      }
      if (file === join(dir, basename(String(m.path)))) out.exact++;
      else out.other_extension++;
      const e = extname(file).slice(1).toLowerCase() || 'none';
      out.extensions[e] = (out.extensions[e] ?? 0) + 1;
      if (readAudioTranscript(file)?.text) out.apple_transcripts++;
    }
    return out;
  }),

  // Wispr Flow
  sql('wispr.tables', 'wispr', 'wispr', "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", 'Meetings and History are listed.', 'list'),
  sql('wispr.meeting_columns', 'wispr', 'wispr', "SELECT name FROM pragma_table_info('Meetings') ORDER BY name", 'Includes id, title, createdAt, modifiedAt, endedAt, participantNames, notes, summary, speakerMap, calendarEventExternalId, isDeleted.', 'list'),
  sql('wispr.history_columns', 'wispr', 'wispr', "SELECT name FROM pragma_table_info('History') ORDER BY name", 'Includes transcriptEntityId, asrText, formattedText, editedText, timestamp, app, url.', 'list'),
  sql('wispr.meeting_dates', 'wispr', 'wispr', "SELECT COUNT(*) AS meetings, SUM(isDeleted = 1) AS deleted, SUM(typeof(createdAt) = 'text') AS text_dates, SUM(typeof(createdAt) IN ('integer','real')) AS number_dates, SUM(createdAt GLOB '*[+-][0-9][0-9]:[0-9][0-9]' OR createdAt GLOB '*Z') AS with_zone FROM Meetings", 'Text dates without a zone are read as UTC; check a meeting time in the app if with_zone is 0.'),
  sql('wispr.history_dates', 'wispr', 'wispr', "SELECT COUNT(*) AS dictations, SUM(typeof(timestamp) = 'text') AS text_dates, SUM(timestamp GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] *') AS space_format, SUM(timestamp GLOB '*[+-][0-9][0-9]:[0-9][0-9]' OR timestamp GLOB '*Z') AS with_zone FROM History", 'space_format close to dictations (YYYY-MM-DD HH:MM:SS).'),
  js('wispr.meeting_files', 'wispr', 'with_refined close to the meeting count; first_line_keys includes speaker and text.', (env) => {
    const dir = join(env.home, 'Library/Application Support/Wispr Flow/meetings');
    if (!existsSync(dir)) return { meetings_folder: false };
    const ids = safeDir(dir);
    const names = [];
    let refined = 0;
    let keys = null;
    for (const id of ids) {
      const files = safeDir(join(dir, id));
      // Known app file names as they are; anything else only by extension.
      names.push(...files.map((f) => (WISPR_FILES.has(f) ? f : `other_${extname(f).slice(1).toLowerCase() || 'none'}`)));
      if (!files.includes('refined.ndjson')) continue;
      refined++;
      if (keys) continue;
      const first = readFileSync(join(dir, id, 'refined.ndjson'), 'utf8').split('\n').find((l) => l.trim());
      try {
        keys = Object.keys(JSON.parse(first)).sort();
      } catch {
        keys = ['unparsed'];
      }
    }
    return { meeting_folders: ids.length, with_refined: refined, file_names: tally(names), first_line_keys: keys };
  }),
  js('wispr.shapes', 'wispr', 'speakerMap is json_object (id to name) and participantNames is json_array; text shapes are also handled.', (env) => {
    const db = env.open('wispr');
    const name = tableNames(db).get('meetings');
    if (!name) return { meetings_table: false };
    const c = columns(db, name);
    const shape = (v) => {
      if (v == null || v === '') return 'empty';
      try {
        const j = JSON.parse(v);
        return Array.isArray(j) ? 'json_array' : j && typeof j === 'object' ? 'json_object' : 'json_other';
      } catch {
        return 'text';
      }
    };
    const rows = db.prepare(`SELECT ${c.pick('speakerMap', 's')}, ${c.pick('participantNames', 'p')} FROM "${name}"`).all();
    return { speaker_map: tally(rows.map((r) => shape(r.s))), participant_names: tally(rows.map((r) => shape(r.p))) };
  }),

  // Zoom
  js('zoom_local.folders', 'zoom_local', 'named close to folders ("YYYY-MM-DD HH.MM.SS Topic 81234567890").', (env) => {
    const root = join(env.home, 'Documents/Zoom');
    if (!existsSync(root)) return { zoom_folder: false };
    const dirs = safeDir(root).filter((d) => statSync(join(root, d)).isDirectory());
    const named = dirs.filter((d) => /^\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\s/.test(d));
    return { folders: dirs.length, named: named.length, with_meeting_id: named.filter((d) => /\s\d{9,12}$/.test(d)).length };
  }),
  js('zoom_local.files', 'zoom_local', 'Shows which transcript sources exist: vtt and closed_caption are read directly; m4a and mp4 need transcription.', (env) => {
    const root = join(env.home, 'Documents/Zoom');
    if (!existsSync(root)) return { zoom_folder: false };
    const kinds = [];
    for (const d of safeDir(root)) {
      const p = join(root, d);
      if (!statSync(p).isDirectory()) continue;
      for (const f of safeDir(p)) {
        kinds.push(/\.vtt$/i.test(f) ? 'vtt' : /^closed_caption.*\.txt$/i.test(f) ? 'closed_caption' : /chat.*\.txt$/i.test(f) ? 'chat' : /\.m4a$/i.test(f) ? 'm4a' : /\.mp4$/i.test(f) ? 'mp4' : 'other');
      }
    }
    return tally(kinds);
  }),
];

// Anything that is not a number, boolean, null or an identifier-like string
// (column names, UTIs, provider ids) is redacted.
const SAFE = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;
export function sanitize(value) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return SAFE.test(value) ? value : '[redacted]';
  if (Array.isArray(value)) return value.map(sanitize);
  if (value instanceof Uint8Array) return '[redacted]';
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [SAFE.test(k) ? k : '[redacted]', sanitize(v)]));
  return '[redacted]';
}

const cleanError = (msg) => String(msg ?? '').replace(/\/[^\s)]+/g, '<path>').replace(/[^A-Za-z0-9_ :.,()<>'-]/g, '').slice(0, 160);

function shapeRows(rows, shape) {
  const plain = rows.map((r) => ({ ...r }));
  if (shape === 'list') return plain.map((r) => Object.values(r)[0]);
  if (shape === 'rows') return plain;
  return plain[0] ?? null;
}

export async function realProbe({ home = homedir(), source } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'confidant-probe-'));
  const ctx = { home, tmpDir: () => tmp };
  const pathsOf = (name) => [].concat(DATABASES[name](home) ?? []);
  const env = {
    home,
    exists: (name) => {
      const p = pathsOf(name);
      return p.length > 0 && p.every((x) => existsSync(x));
    },
    open(name) {
      const [p] = pathsOf(name);
      if (!p || !existsSync(p)) throw Object.assign(new Error('not found'), { notFound: true });
      const access = canRead(p);
      if (!access.ok) throw Object.assign(new Error('no access'), { needsFullDiskAccess: access.needsFullDiskAccess, code: access.code });
      return openCopy(ctx, p);
    },
  };
  const out = [];
  try {
    for (const check of CHECKS.filter((c) => !source || c.source === source)) {
      const entry = { id: check.id, source: check.source, expect: check.expect };
      try {
        if (check.sql) {
          const paths = pathsOf(check.db);
          if (!paths.length || !paths.every((p) => existsSync(p))) {
            out.push({ ...entry, skipped: 'not found' });
            continue;
          }
          const results = paths.map((p) => {
            const access = canRead(p);
            if (!access.ok) throw Object.assign(new Error('no access'), { needsFullDiskAccess: access.needsFullDiskAccess, code: access.code });
            return shapeRows(openCopy(ctx, p).prepare(check.sql).all(), check.shape);
          });
          entry.result = sanitize(results.length === 1 ? results[0] : results);
        } else entry.result = sanitize(await check.run(env));
      } catch (err) {
        if (err.needsFullDiskAccess) entry.skipped = 'needs Full Disk Access';
        else if (err.notFound) entry.skipped = 'not found';
        else entry.error = cleanError(err.message);
      }
      out.push(entry);
    }
  } finally {
    closeCopies();
    rmSync(tmp, { recursive: true, force: true });
  }
  return { ran_at: new Date().toISOString(), darwin: release(), node: process.versions.node, checks: out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await realProbe({ source: process.argv[2] || undefined });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
