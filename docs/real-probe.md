# Real Mac probe for the local extractors

Some of what the local extractors assume about Apple and app databases comes from public research, not from a real Mac. This probe checks those assumptions on a real Mac once Full Disk Access is granted.

## What it reads

- Every database is copied first (with its -wal and -shm files) and only the copy is opened. Nothing is written anywhere except a temporary folder that is deleted at the end.
- Every check is a SELECT over table and column names, counts and type codes. No check selects message text, names, addresses, titles or file names from the person's data.
- As a second guard, the output keeps only numbers, true or false, and identifier-like strings (column names, type identifiers such as com.apple.m4a-audio). Anything else prints as "[redacted]".
- Checks that run in code (marked below) return counts only.

## How to run it

1. Grant Full Disk Access to the app that will run it: the ChatGPT app (for Codex) or Terminal.
2. From the repository, or from `.confidant/engine` inside a vault, run:

```sh
sh bin/node engine/lib/a-real-probe.mjs
```

3. To probe one source, add its id: `sh bin/node engine/lib/a-real-probe.mjs email`. Ids: `imessage`, `contacts`, `whatsapp`, `email`, `calendar`, `calls`, `call_recordings`, `voice_memos`, `wispr`, `zoom_local`.
4. Each check prints its `expect` line next to its `result`. `skipped: not found` means the app is not used on this Mac. `skipped: needs Full Disk Access` means access is not granted yet.

The same checks, in order, are defined in `engine/lib/a-real-probe.mjs` (CHECKS), and database names such as `chat` or `mail` refer to its DATABASES map. A test keeps this page and that file in step.

## iMessage and SMS (`imessage`)

Reads: Library/Messages/chat.db.

Assumptions:

- message.date is nanoseconds since 2001 (the extractor also accepts seconds).
- Most text is in attributedBody, and the typedstream decoder reads it.
- associated_message_type 1000 and up are stickers, tapbacks and poll votes; item_type other than 0 is a group event.
- chat.style 43 is a group chat.

### imessage.columns

Database: `chat`.

```sql
SELECT name FROM pragma_table_info('message') WHERE name IN ('text','attributedBody','date','handle_id','service','is_from_me','associated_message_type','item_type','destination_caller_id','date_edited','date_retracted','thread_originator_guid','is_audio_message','balloon_bundle_id','cache_has_attachments') ORDER BY name
```

Expect: All 15 names. Missing ones are read as NULL, so the extractor still works.

### imessage.date_unit

Database: `chat`.

```sql
SELECT COUNT(*) AS messages, MAX(date) > 100000000000000 AS nanoseconds FROM message
```

Expect: nanoseconds = 1 (dates are nanoseconds since 2001).

### imessage.body

Database: `chat`.

```sql
SELECT SUM(text IS NULL OR text = '') AS no_text, SUM((text IS NULL OR text = '') AND attributedBody IS NOT NULL) AS body_only FROM message
```

Expect: body_only close to no_text: text lives in attributedBody.

### imessage.decode

Runs in code (counts only).

Expect: decoded close to sampled: the attributedBody decoder works on this macOS.

### imessage.associated

Database: `chat`.

```sql
SELECT associated_message_type AS value, COUNT(*) AS n FROM message WHERE associated_message_type <> 0 GROUP BY 1 ORDER BY 1
```

Expect: Only 2, 3, 1000, 2000 to 2007, 3000 to 3007 and 4000. Values of 1000 and up are skipped.

### imessage.item_types

Database: `chat`.

```sql
SELECT item_type AS value, COUNT(*) AS n FROM message GROUP BY 1 ORDER BY 1
```

Expect: Mostly 0. Anything else is a group event and is skipped.

### imessage.chat_styles

Database: `chat`.

```sql
SELECT style AS value, COUNT(*) AS n FROM chat GROUP BY 1 ORDER BY 1
```

Expect: 43 (groups) and 45 (direct chats).

If it differs: Missing columns only turn features off. A low decoded count means the attributedBody format changed: update decodeAttributedBody in engine/extract/imessage.mjs.

## Contacts (`contacts`)

Reads: Library/Application Support/AddressBook (top level and Sources/*).

Assumptions:

- Cards live in ZABCDRECORD with phones and emails in ZABCDPHONENUMBER and ZABCDEMAILADDRESS.
- Z_PRIMARYKEY names ABCDContact, which separates people from groups.

### contacts.entities

Database: `contacts`.

```sql
SELECT Z_NAME AS value, Z_ENT AS n FROM Z_PRIMARYKEY WHERE Z_NAME IN ('ABCDContact','ABCDGroup','ABCDRecord') ORDER BY 1
```

Expect: ABCDContact is listed in every book.

### contacts.columns

Database: `contacts`.

```sql
SELECT name FROM pragma_table_info('ZABCDRECORD') WHERE name IN ('Z_ENT','ZFIRSTNAME','ZLASTNAME','ZMIDDLENAME','ZNICKNAME','ZORGANIZATION','ZJOBTITLE','ZDEPARTMENT','ZNAME','ZUNIQUEID','ZMODIFICATIONDATE','ZCREATIONDATE') ORDER BY name
```

Expect: All 12 names.

### contacts.counts

Database: `contacts`.

```sql
SELECT (SELECT COUNT(*) FROM ZABCDRECORD) AS records, (SELECT COUNT(*) FROM ZABCDPHONENUMBER) AS phones, (SELECT COUNT(*) FROM ZABCDEMAILADDRESS) AS emails
```

Expect: Non-zero in the account books (Sources).

If it differs: If ABCDContact is missing, groups may appear as contacts: readCards in engine/lib/a-addressbook.mjs falls back to skipping rows that only have ZNAME.

## WhatsApp (Mac app) (`whatsapp`)

Reads: Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite and ContactsV2.sqlite.

Assumptions:

- ZMESSAGETYPE codes follow the iOS app (0 text, 1 image, 2 video, 3 audio, 6 group event, 14 deleted, 15 sticker).
- ZSESSIONTYPE 0 is a direct chat and 1 a group; 2, 3 and 4 are skipped.
- Captions are in ZWAMEDIAITEM.ZTITLE.
- Group senders resolve through ZGROUPMEMBER, and @lid ids map to phones through ContactsV2.sqlite ZWAADDRESSBOOKCONTACT.ZLID.

### whatsapp.tables

Database: `whatsapp`.

```sql
SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ZWAMESSAGE','ZWACHATSESSION','ZWAGROUPMEMBER','ZWAMEDIAITEM','ZWAPROFILEPUSHNAME') ORDER BY name
```

Expect: All five tables.

### whatsapp.message_columns

Database: `whatsapp`.

```sql
SELECT name FROM pragma_table_info('ZWAMESSAGE') WHERE name IN ('ZTEXT','ZMESSAGEDATE','ZISFROMME','ZFROMJID','ZTOJID','ZCHATSESSION','ZGROUPMEMBER','ZMESSAGETYPE','ZPUSHNAME','ZSTANZAID','ZSTARRED') ORDER BY name
```

Expect: All 11 names.

### whatsapp.session_columns

Database: `whatsapp`.

```sql
SELECT name FROM pragma_table_info('ZWACHATSESSION') WHERE name IN ('ZCONTACTJID','ZPARTNERNAME','ZSESSIONTYPE','ZCONTACTIDENTIFIER') ORDER BY name
```

Expect: The first three; ZCONTACTIDENTIFIER only on newer builds.

### whatsapp.types

Database: `whatsapp`.

```sql
SELECT ZMESSAGETYPE AS value, COUNT(*) AS n FROM ZWAMESSAGE GROUP BY 1 ORDER BY 1
```

Expect: Mostly 0. Kept: 0, 7, 27, 46 as text; 1, 2, 3, 4, 5, 8, 11, 38, 39, 53, 54 as media. Large counts of other codes need a look.

### whatsapp.sessions

Database: `whatsapp`.

```sql
SELECT ZSESSIONTYPE AS value, COUNT(*) AS n FROM ZWACHATSESSION GROUP BY 1 ORDER BY 1
```

Expect: 0 direct, 1 group, 2 broadcast, 3 status, 4 community. Only 0 and 1 are read.

### whatsapp.captions

Database: `whatsapp`.

```sql
SELECT COUNT(*) AS images, SUM(m.ZTEXT IS NOT NULL AND m.ZTEXT <> '') AS text_set, SUM(i.ZTITLE IS NOT NULL AND i.ZTITLE <> '') AS media_title_set FROM ZWAMESSAGE m LEFT JOIN ZWAMEDIAITEM i ON i.ZMESSAGE = m.Z_PK WHERE m.ZMESSAGETYPE = 1
```

Expect: Captions show up in media_title_set (ZWAMEDIAITEM.ZTITLE). Both are read.

### whatsapp.group_sender

Database: `whatsapp`.

```sql
SELECT COUNT(*) AS incoming_group, SUM(m.ZGROUPMEMBER IS NOT NULL) AS with_member FROM ZWAMESSAGE m JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION WHERE s.ZSESSIONTYPE = 1 AND m.ZISFROMME = 0
```

Expect: with_member close to incoming_group: group senders resolve through ZGROUPMEMBER.

### whatsapp.lids

Database: `whatsapp`.

```sql
SELECT (SELECT COUNT(*) FROM ZWAGROUPMEMBER) AS members, (SELECT SUM(ZMEMBERJID LIKE '%@lid') FROM ZWAGROUPMEMBER) AS lid_members, (SELECT SUM(ZCONTACTJID LIKE '%@lid') FROM ZWACHATSESSION) AS lid_chats
```

Expect: How many people are known only by an @lid id (no phone).

### whatsapp.push_names

Database: `whatsapp`.

```sql
SELECT COUNT(*) AS n FROM ZWAPROFILEPUSHNAME
```

Expect: Non-zero: push names fill in names for @lid ids.

### whatsapp.contacts_v2

Database: `whatsapp_contacts`.

```sql
SELECT name FROM pragma_table_info('ZWAADDRESSBOOKCONTACT') WHERE name IN ('ZLID','ZWHATSAPPID','ZPHONENUMBER','ZFULLNAME') ORDER BY name
```

Expect: All four: @lid ids map to phones through ContactsV2.sqlite.

### whatsapp.lid_mapping

Runs in code (counts only).

Expect: mapped close to lids. A low number means many group members appear by name only.

If it differs: Add new message codes to MEDIA or TEXT_TYPES in engine/extract/whatsapp.mjs. If lid_mapping is low, people still appear by push name, so identity matching by name carries more weight.

## Mail (`email`)

Reads: Library/Mail/V*/MailData/Envelope Index, Library/Accounts/Accounts4.sqlite and the .emlx files.

Assumptions:

- Dates are Unix seconds.
- messages.message_id is stable across copies of one email and never shared by two emails. It becomes the record id.
- Mailbox urls use the account UUID as host, and the UUID resolves to an address through Accounts4 or the Sent mailbox.
- Bodies live at <mailbox>.mbox/<store>/Data/<reversed digits of ROWID / 1000>/Messages/<ROWID>.emlx.
- recipients.type is 0 to, 1 cc, 2 bcc.

### email.tables

Database: `mail`.

```sql
SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('messages','subjects','summaries','addresses','recipients','mailboxes','message_global_data','labels') ORDER BY name
```

Expect: All eight tables (labels only when a Gmail account is set up).

### email.message_columns

Database: `mail`.

```sql
SELECT name FROM pragma_table_info('messages') WHERE name IN ('message_id','global_message_id','sender','subject_prefix','subject','summary','date_sent','date_received','mailbox','conversation_id','read','flagged','deleted','list_id_hash','unsubscribe_type') ORDER BY name
```

Expect: All 15 names.

### email.global_columns

Database: `mail`.

```sql
SELECT name FROM pragma_table_info('message_global_data') WHERE name IN ('message_id_header') ORDER BY name
```

Expect: message_id_header (used for message:// links).

### email.epoch

Database: `mail`.

```sql
SELECT COUNT(*) AS messages, MAX(date_received) > 1200000000 AS unix_seconds FROM messages
```

Expect: unix_seconds = 1 (the extractor also detects this at run time).

### email.message_ids

Database: `mail`.

```sql
SELECT COUNT(*) AS rows, COUNT(DISTINCT message_id) AS ids, SUM(message_id = 0) AS zero FROM messages
```

Expect: zero is small: message_id is the record id; rows with 0 fall back to ROWID.

### email.copies

Database: `mail`.

```sql
SELECT COUNT(*) AS in_several_mailboxes FROM (SELECT message_id FROM messages WHERE message_id <> 0 GROUP BY message_id HAVING COUNT(DISTINCT mailbox) > 1)
```

Expect: Any number: copies of one email collapse into one record.

### email.id_collisions

Database: `mail`.

```sql
SELECT COUNT(*) AS collisions FROM (SELECT m.message_id FROM messages m JOIN message_global_data g ON g.ROWID = m.global_message_id WHERE m.message_id <> 0 AND g.message_id_header IS NOT NULL GROUP BY m.message_id HAVING COUNT(DISTINCT g.message_id_header) > 1)
```

Expect: collisions = 0: one message_id never covers two different emails.

### email.mailbox_hosts

Database: `mail`.

```sql
SELECT COUNT(*) AS mailboxes, SUM(url GLOB '*://[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]-[0-9A-F][0-9A-F][0-9A-F][0-9A-F]-*') AS uuid_hosts, SUM(url LIKE '%@%') AS address_hosts FROM mailboxes
```

Expect: uuid_hosts close to mailboxes (imap://<ACCOUNT-UUID>/INBOX).

### email.recipient_types

Database: `mail`.

```sql
SELECT type AS value, COUNT(*) AS n FROM recipients GROUP BY 1 ORDER BY 1
```

Expect: 0 (to), 1 (cc), 2 (bcc) only.

### email.labels

Database: `mail`.

```sql
SELECT COUNT(*) AS n FROM labels
```

Expect: Non-zero with Gmail: labels mark Inbox, Spam and Trash.

### email.mailbox_kinds

Runs in code (counts only).

Expect: Every account has a Sent mailbox (it names the account address); skip counts Junk, Trash and Drafts.

### email.accounts

Runs in code (counts only).

Expect: matched and with_address equal uuid_accounts: every Mail account resolves to an address through Accounts4.

### email.emlx_layout

Runs in code (counts only).

Expect: shard_path close to sampled. elsewhere means the fallback walk is doing the work; missing means bodies not downloaded (the summary is used).

If it differs: If id_collisions is above 0, switch the record id in engine/extract/mail.mjs to message_id_header. If shard_path is low but elsewhere is high, the layout moved: bodies are still found by the walk, only slower. If accounts do not resolve, exclusions by account fall back to Sent mailbox senders.

## Calendar (`calendar`)

Reads: Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb.

Assumptions:

- entity_type 2 is an event; Store types 5 and 6 are derived calendars and reminders.
- All-day events are floating and stored at UTC midnight (local midnight is handled too).
- Participant.status follows EventKit, and organizer_id points at Participant.ROWID.
- OccurrenceCache holds repeats at least 60 days ahead.

### calendar.columns

Database: `calendar`.

```sql
SELECT name FROM pragma_table_info('CalendarItem') WHERE name IN ('summary','description','start_date','end_date','start_tz','all_day','calendar_id','location_id','organizer_id','self_attendee_id','status','url','conference_url','conference_url_detected','UUID','unique_identifier','last_modified','has_recurrences','orig_item_id','birthday_id','entity_type','hidden') ORDER BY name
```

Expect: All 22 names.

### calendar.entity_types

Database: `calendar`.

```sql
SELECT entity_type AS value, COUNT(*) AS n FROM CalendarItem GROUP BY 1 ORDER BY 1
```

Expect: 2 are events (read); other values are reminders (skipped).

### calendar.stores

Database: `calendar`.

```sql
SELECT type AS value, COUNT(*) AS n, SUM(disabled = 1) AS disabled FROM Store GROUP BY 1 ORDER BY 1
```

Expect: Types 5 (Found in Mail, Birthdays) and 6 (Reminders) are skipped, as are disabled stores.

### calendar.all_day

Database: `calendar`.

```sql
SELECT COUNT(*) AS all_day, SUM(CAST(start_date AS INTEGER) % 86400 = 0) AS utc_midnight, SUM(start_tz = '_float') AS floating FROM CalendarItem WHERE all_day = 1 AND entity_type = 2
```

Expect: utc_midnight = all_day and floating = all_day. If utc_midnight is low, all-day dates are stored at local midnight (also handled).

### calendar.floating_timed

Database: `calendar`.

```sql
SELECT COUNT(*) AS n FROM CalendarItem WHERE all_day = 0 AND start_tz = '_float' AND entity_type = 2
```

Expect: Small: timed floating events are read as wall clock in the person's zone.

### calendar.participant_status

Database: `calendar`.

```sql
SELECT status AS value, COUNT(*) AS n FROM Participant GROUP BY 1 ORDER BY 1
```

Expect: 0 to 7 only (EventKit: 2 accepted, 3 declined, 4 tentative).

### calendar.participants

Database: `calendar`.

```sql
SELECT COUNT(*) AS participants, SUM(is_self = 1) AS self_rows, SUM(identity_id > 0) AS with_identity, SUM(email IS NOT NULL) AS with_email FROM Participant
```

Expect: with_identity or with_email covers most rows: attendees have addresses.

### calendar.organizers

Database: `calendar`.

```sql
SELECT COUNT(*) AS with_organizer, SUM(p.ROWID IS NOT NULL) AS linked FROM CalendarItem i LEFT JOIN Participant p ON p.ROWID = i.organizer_id WHERE i.organizer_id > 0
```

Expect: linked = with_organizer: organizer_id points at Participant.

### calendar.occurrences

Database: `calendar`.

```sql
SELECT (SELECT COUNT(*) FROM CalendarItem WHERE has_recurrences = 1 AND entity_type = 2) AS recurring, (SELECT COUNT(DISTINCT o.event_id) FROM OccurrenceCache o JOIN CalendarItem i ON i.ROWID = o.event_id WHERE i.has_recurrences = 1) AS recurring_cached, CAST(((SELECT MAX(occurrence_date) FROM OccurrenceCache) - (strftime('%s','now') - 978307200)) / 86400 AS INTEGER) AS days_ahead, CAST(((strftime('%s','now') - 978307200) - (SELECT MIN(occurrence_date) FROM OccurrenceCache)) / 86400 AS INTEGER) AS days_back
```

Expect: recurring_cached close to recurring, days_ahead at least 60. Series outside the cache appear once, at their first date.

### calendar.status

Database: `calendar`.

```sql
SELECT status AS value, COUNT(*) AS n FROM CalendarItem WHERE entity_type = 2 GROUP BY 1 ORDER BY 1
```

Expect: 0 to 3 (3 = cancelled, kept with meta.status).

If it differs: If days_ahead is under 60, upcoming repeats past the cache are missing: expand Recurrence rows in engine/extract/calendar.mjs the way icalPal does.

## Call history (`calls`)

Reads: Library/Application Support/CallHistoryDB/CallHistory.storedata.

Assumptions:

- ZADDRESS is a blob holding a phone number or email.
- ZCALLTYPE 1 is phone, 8 FaceTime video, 16 FaceTime audio.

### calls.columns

Database: `calls`.

```sql
SELECT name FROM pragma_table_info('ZCALLRECORD') WHERE name IN ('ZDATE','ZDURATION','ZADDRESS','ZNAME','ZORIGINATED','ZANSWERED','ZCALLTYPE','ZSERVICE_PROVIDER','ZUNIQUE_ID','ZJUNKCONFIDENCE') ORDER BY name
```

Expect: All 10 names.

### calls.types

Database: `calls`.

```sql
SELECT ZCALLTYPE AS value, COUNT(*) AS n FROM ZCALLRECORD GROUP BY 1 ORDER BY 1
```

Expect: 1 phone, 8 FaceTime video, 16 FaceTime audio, 0 other apps.

### calls.providers

Database: `calls`.

```sql
SELECT ZSERVICE_PROVIDER AS value, COUNT(*) AS n FROM ZCALLRECORD GROUP BY 1 ORDER BY 2 DESC
```

Expect: com.apple.Telephony and com.apple.FaceTime.

### calls.address_type

Database: `calls`.

```sql
SELECT typeof(ZADDRESS) AS value, COUNT(*) AS n FROM ZCALLRECORD GROUP BY 1
```

Expect: blob (text is also handled).

### calls.answered

Database: `calls`.

```sql
SELECT ZORIGINATED AS originated, ZANSWERED AS answered, SUM(ZDURATION = 0) AS zero_length, COUNT(*) AS n FROM ZCALLRECORD GROUP BY 1, 2
```

Expect: Incoming calls with answered = 1 and zero_length are answered elsewhere; they count as missed.

If it differs: New providers or call types show up as "call" in the summary line; add them to SERVICE in engine/extract/calls.mjs.

## Phone call recordings (Notes) (`call_recordings`)

Reads: Library/Group Containers/group.com.apple.notes/NoteStore.sqlite and Accounts/*/Media.

Assumptions:

- Recordings are notes in a folder titled "Call Recordings" or "Grabaciones de llamadas".
- Titles look like "Call with <name>" or a phone number.
- The audio attachment is com.apple.m4a-audio with Apple's transcript in ZADDITIONALINDEXABLETEXT.
- The note body is a gzipped protobuf (document 2, note 3, text 2), and audio sits under Media/<media id>/<generation>/.

### call_recordings.columns

Database: `notes`.

```sql
SELECT name FROM pragma_table_info('ZICCLOUDSYNCINGOBJECT') WHERE name IN ('ZIDENTIFIER','ZTITLE1','ZTITLE2','ZSNIPPET','ZFOLDER','ZNOTE','ZMEDIA','ZTYPEUTI','ZADDITIONALINDEXABLETEXT','ZFILENAME','ZGENERATION','ZUSERTITLE','ZDURATION','ZMARKEDFORDELETION','ZCREATIONDATE1','ZCREATIONDATE3','ZMODIFICATIONDATE1','ZNEEDSTRANSCRIPTION','ZHOSTAPPLICATIONIDENTIFIER') ORDER BY name
```

Expect: At least ZIDENTIFIER, ZTITLE1, ZTITLE2, ZFOLDER, ZTYPEUTI, ZMEDIA, ZADDITIONALINDEXABLETEXT and one ZCREATIONDATE column.

### call_recordings.folders

Database: `notes`.

```sql
SELECT COUNT(*) AS folders FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE2 IN ('Call Recordings','Grabaciones de llamadas')
```

Expect: At least 1 once a call has been recorded on the iPhone. 0 with recordings means the folder has another name: check call_recordings.host_apps.

### call_recordings.notes

Database: `notes`.

```sql
SELECT COUNT(*) AS notes, SUM(ZTITLE1 LIKE 'Call with %' OR ZTITLE1 LIKE 'Llamada con %') AS named_titles, SUM(ZTITLE1 GLOB '*[0-9][0-9][0-9][0-9]*') AS numeric_titles, SUM(ZMARKEDFORDELETION = 1) AS deleted FROM ZICCLOUDSYNCINGOBJECT WHERE ZFOLDER IN (SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE2 IN ('Call Recordings','Grabaciones de llamadas'))
```

Expect: named_titles plus numeric_titles close to notes. Otherwise the title patterns need updating (the call history match still finds the other party).

### call_recordings.audio

Database: `notes`.

```sql
SELECT ZTYPEUTI AS value, COUNT(*) AS n, SUM(ZADDITIONALINDEXABLETEXT IS NOT NULL AND ZADDITIONALINDEXABLETEXT <> '') AS with_transcript, SUM(ZNOTE IS NOT NULL) AS with_note, SUM(ZMEDIA IS NOT NULL) AS with_media FROM ZICCLOUDSYNCINGOBJECT WHERE ZTYPEUTI LIKE '%audio%' GROUP BY 1
```

Expect: com.apple.m4a-audio with with_media close to n.

### call_recordings.call_audio

Database: `notes`.

```sql
SELECT COUNT(*) AS n, SUM(a.ZADDITIONALINDEXABLETEXT IS NOT NULL AND a.ZADDITIONALINDEXABLETEXT <> '') AS with_transcript FROM ZICCLOUDSYNCINGOBJECT a JOIN ZICCLOUDSYNCINGOBJECT n ON n.Z_PK = a.ZNOTE WHERE a.ZTYPEUTI LIKE '%audio%' AND n.ZFOLDER IN (SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE2 IN ('Call Recordings','Grabaciones de llamadas'))
```

Expect: with_transcript close to n: Apple transcripts sit in ZADDITIONALINDEXABLETEXT.

### call_recordings.host_apps

Database: `notes`.

```sql
SELECT ZHOSTAPPLICATIONIDENTIFIER AS value, COUNT(*) AS n FROM ZICCLOUDSYNCINGOBJECT WHERE ZHOSTAPPLICATIONIDENTIFIER IS NOT NULL GROUP BY 1
```

Expect: A Phone app identifier here would be a sturdier way to find call recordings than the folder name.

### call_recordings.extractor_view

Runs in code (counts only).

Expect: with_audio = call_notes; body_decoded = call_notes (protobuf path 2 > 3 > 2 holds).

### call_recordings.media_layout

Runs in code (counts only).

Expect: generation_folder (or direct_files) close to audio_with_media: audio lives at Accounts/<id>/Media/<media id>/<generation>/<file>.

If it differs: If folders is 0 but host_apps lists the Phone app, find call notes by ZHOSTAPPLICATIONIDENTIFIER in readNotes (engine/extract/call-recordings.mjs) instead of the folder title. Extend CALL_FOLDERS for other languages.

## Voice Memos (`voice_memos`)

Reads: Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/CloudRecordings.db and the audio files.

Assumptions:

- ZEVICTIONDATE set means Recently Deleted, and those are skipped.
- ZPATH may name .m4a while the file is .qta.
- Transcripts are inside the audio (m4a tsrp atom, qta metadata key).

### voice_memos.columns

Database: `voice_memos`.

```sql
SELECT name FROM pragma_table_info('ZCLOUDRECORDING') WHERE name IN ('ZDATE','ZDURATION','ZPATH','ZCUSTOMLABEL','ZENCRYPTEDTITLE','ZUNIQUEID','ZEVICTIONDATE','ZFLAGS','ZFOLDER') ORDER BY name
```

Expect: All 9 names.

### voice_memos.counts

Database: `voice_memos`.

```sql
SELECT COUNT(*) AS total, SUM(ZEVICTIONDATE IS NOT NULL) AS evicted, SUM(ZPATH IS NULL OR ZPATH = '') AS no_path, SUM(ZENCRYPTEDTITLE IS NOT NULL AND ZENCRYPTEDTITLE <> '') AS titled FROM ZCLOUDRECORDING
```

Expect: evicted matches what Recently Deleted shows in the app (those are skipped).

### voice_memos.flags

Database: `voice_memos`.

```sql
SELECT ZFLAGS AS value, COUNT(*) AS n, SUM(ZEVICTIONDATE IS NOT NULL) AS evicted FROM ZCLOUDRECORDING GROUP BY 1 ORDER BY 1
```

Expect: Shows whether a ZFLAGS value lines up with evicted rows.

### voice_memos.files

Runs in code (counts only).

Expect: missing is small; apple_transcripts counts memos with a built-in transcript.

If it differs: If evicted rows are still visible in the app, stop skipping them in readMemos (engine/extract/voice-memos.mjs) and use ZFLAGS instead.

## Wispr Flow (`wispr`)

Reads: Library/Application Support/Wispr Flow/flow.sqlite and meetings/<id>/.

Assumptions:

- A Meetings table with the columns listed below, and History for dictations.
- Transcripts are meetings/<id>/refined.ndjson with speaker and text keys.
- speakerMap is a JSON object of speaker id to name; participantNames is a JSON array.
- Dates without a zone are UTC.

### wispr.tables

Database: `wispr`.

```sql
SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
```

Expect: Meetings and History are listed.

### wispr.meeting_columns

Database: `wispr`.

```sql
SELECT name FROM pragma_table_info('Meetings') ORDER BY name
```

Expect: Includes id, title, createdAt, modifiedAt, endedAt, participantNames, notes, summary, speakerMap, calendarEventExternalId, isDeleted.

### wispr.history_columns

Database: `wispr`.

```sql
SELECT name FROM pragma_table_info('History') ORDER BY name
```

Expect: Includes transcriptEntityId, asrText, formattedText, editedText, timestamp, app, url.

### wispr.meeting_dates

Database: `wispr`.

```sql
SELECT COUNT(*) AS meetings, SUM(isDeleted = 1) AS deleted, SUM(typeof(createdAt) = 'text') AS text_dates, SUM(typeof(createdAt) IN ('integer','real')) AS number_dates, SUM(createdAt GLOB '*[+-][0-9][0-9]:[0-9][0-9]' OR createdAt GLOB '*Z') AS with_zone FROM Meetings
```

Expect: Text dates without a zone are read as UTC; check a meeting time in the app if with_zone is 0.

### wispr.history_dates

Database: `wispr`.

```sql
SELECT COUNT(*) AS dictations, SUM(typeof(timestamp) = 'text') AS text_dates, SUM(timestamp GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] *') AS space_format, SUM(timestamp GLOB '*[+-][0-9][0-9]:[0-9][0-9]' OR timestamp GLOB '*Z') AS with_zone FROM History
```

Expect: space_format close to dictations (YYYY-MM-DD HH:MM:SS).

### wispr.meeting_files

Runs in code (counts only).

Expect: with_refined close to the meeting count; first_line_keys includes speaker and text.

### wispr.shapes

Runs in code (counts only).

Expect: speakerMap is json_object (id to name) and participantNames is json_array; text shapes are also handled.

If it differs: This schema has no public documentation, so expect changes here. Update the column names in readMeetings and readHistory (engine/extract/wispr.mjs); the rest reads through them.

## Zoom recordings (`zoom_local`)

Reads: Documents/Zoom/<YYYY-MM-DD HH.MM.SS Topic ID>/.

Assumptions:

- Folder names carry the local start time, topic and meeting id.
- Transcripts come from .vtt or closed_caption.txt, otherwise the audio is transcribed.

### zoom_local.folders

Runs in code (counts only).

Expect: named close to folders ("YYYY-MM-DD HH.MM.SS Topic 81234567890").

### zoom_local.files

Runs in code (counts only).

Expect: Shows which transcript sources exist: vtt and closed_caption are read directly; m4a and mp4 need transcription.

If it differs: If named is low, the folder format changed: update FOLDER in engine/extract/zoom-local.mjs (the folder time is used as the meeting time).
