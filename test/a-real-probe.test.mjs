import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome, createDb, insert, writeFile } from './fixtures/a-fixtures.mjs';
import { chatDb, addMessage, addressBook, whatsappDb, whatsappContacts, addWa, noteStore, noteBody, callHistory, appleSeconds } from './fixtures/a-apple.mjs';
import { CHECKS, realProbe, sanitize } from '../engine/lib/a-real-probe.mjs';
import { REPO_ROOT } from '../engine/lib/paths.mjs';

// A token planted in every content field. It must never reach the output.
const SECRET = 'Zqxj';

function plantedHome() {
  const home = tempHome();
  const chat = chatDb(home);
  insert(chat, 'handle', { ROWID: 1, id: '+13055551234', service: 'iMessage' });
  insert(chat, 'chat', [{ ROWID: 1, guid: 'iMessage;-;+13055551234', style: 45, chat_identifier: '+13055551234' }, { ROWID: 2, guid: 'iMessage;+;chat1', style: 43, display_name: `${SECRET} group` }]);
  addMessage(chat, { chat: 1, handle: 1, text: `${SECRET} plan`, at: '2026-09-01T10:00:00Z' });
  addMessage(chat, { chat: 1, handle: 1, body: `${SECRET} body`, at: '2026-09-01T10:01:00Z' });
  addMessage(chat, { chat: 2, handle: 1, text: 'hi', at: '2026-09-01T10:02:00Z', assoc: 2001 });
  addressBook(home, 'SRC-1', [{ pk: 1, first: SECRET, last: 'Person', org: `${SECRET} Inc`, phones: ['305-555-1234'], emails: [`${SECRET.toLowerCase()}@acme.test`] }]);
  const { db: wa, base } = whatsappDb(home);
  insert(wa, 'ZWACHATSESSION', [{ Z_PK: 1, ZSESSIONTYPE: 0, ZCONTACTJID: '15551112222@s.whatsapp.net', ZPARTNERNAME: SECRET }, { Z_PK: 2, ZSESSIONTYPE: 1, ZCONTACTJID: '1203@g.us', ZPARTNERNAME: `${SECRET} team` }]);
  insert(wa, 'ZWAGROUPMEMBER', [{ Z_PK: 1, ZCHATSESSION: 2, ZMEMBERJID: '777@lid', ZCONTACTNAME: SECRET }, { Z_PK: 2, ZCHATSESSION: 2, ZMEMBERJID: '888@lid' }]);
  whatsappContacts(base, [{ Z_PK: 1, ZFULLNAME: SECRET, ZLID: '777@lid', ZWHATSAPPID: '15553334444@s.whatsapp.net' }]);
  addWa(wa, { chat: 1, text: `${SECRET} hola`, at: '2026-09-02T10:00:00Z', fromJid: '15551112222@s.whatsapp.net' });
  addWa(wa, { chat: 2, text: SECRET, at: '2026-09-02T10:01:00Z', member: 1 });
  addWa(wa, { chat: 1, type: 1, at: '2026-09-02T10:02:00Z', caption: `${SECRET} photo` });
  const notes = noteStore(home);
  insert(notes, 'ZICCLOUDSYNCINGOBJECT', [
    { Z_PK: 1, ZIDENTIFIER: 'F-1', ZTITLE2: 'Call Recordings' },
    { Z_PK: 10, ZIDENTIFIER: 'N-1', ZFOLDER: 1, ZTITLE1: `Call with ${SECRET}`, ZCREATIONDATE3: appleSeconds('2026-09-03T10:00:00Z') },
    { Z_PK: 20, ZIDENTIFIER: 'A-1', ZTYPEUTI: 'com.apple.m4a-audio', ZNOTE: 10, ZMEDIA: 30, ZADDITIONALINDEXABLETEXT: `${SECRET} transcript` },
    { Z_PK: 30, ZIDENTIFIER: 'M-1', ZFILENAME: `${SECRET}.m4a` },
  ]);
  insert(notes, 'ZICNOTEDATA', { Z_PK: 1, ZNOTE: 10, ZDATA: noteBody(`Call with ${SECRET}`) });
  writeFile(join(home, 'Library/Group Containers/group.com.apple.notes/Accounts/ACCT/Media/M-1/1_GEN', `${SECRET}.m4a`), 'x');
  const calls = callHistory(home);
  insert(calls, 'ZCALLRECORD', { Z_PK: 1, ZDATE: appleSeconds('2026-09-03T10:00:00Z'), ZDURATION: 60, ZADDRESS: Buffer.from('+13055551234'), ZNAME: SECRET, ZORIGINATED: 1, ZANSWERED: 1, ZCALLTYPE: 1, ZSERVICE_PROVIDER: 'com.apple.Telephony' });
  const wdir = join(home, 'Library/Application Support/Wispr Flow');
  const w = createDb(join(wdir, 'flow.sqlite'), 'CREATE TABLE Meetings (id TEXT, title TEXT, createdAt TEXT, participantNames TEXT, speakerMap TEXT, isDeleted INTEGER); CREATE TABLE History (transcriptEntityId TEXT, formattedText TEXT, timestamp TEXT);');
  insert(w, 'Meetings', { id: 'm1', title: SECRET, createdAt: '2026-09-04 10:00:00', participantNames: JSON.stringify([SECRET]), speakerMap: JSON.stringify({ s0: SECRET }), isDeleted: 0 });
  insert(w, 'History', { transcriptEntityId: 'h1', formattedText: SECRET, timestamp: '2026-09-04 11:00:00' });
  writeFile(join(wdir, 'meetings/m1/refined.ndjson'), `${JSON.stringify({ speaker: 's0', text: SECRET })}\n`);
  writeFile(join(wdir, 'meetings/m1', `${SECRET} notes.txt`), SECRET);
  writeFile(join(home, 'Documents/Zoom', `2026-09-15 14.30.12 ${SECRET} Weekly 81234567890`, 'recording.transcript.vtt'), `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${SECRET}: hi\n`);
  return home;
}

const byId = (report) => Object.fromEntries(report.checks.map((c) => [c.id, c]));

test('real probe: counts and schema names only, planted content never leaks', async () => {
  const report = await realProbe({ home: plantedHome() });
  const text = JSON.stringify(report);
  assert.ok(!text.toLowerCase().includes(SECRET.toLowerCase()), 'no planted content in the output');
  assert.ok(!text.includes('5551234') && !text.includes('acme.test'), 'no phone numbers or addresses');
  const c = byId(report);
  assert.equal(report.checks.length, CHECKS.length);
  assert.deepEqual(c['imessage.decode'].result, { sampled: 1, decoded: 1 });
  assert.deepEqual(c['imessage.chat_styles'].result, [{ value: 43, n: 1 }, { value: 45, n: 1 }]);
  assert.deepEqual(c['imessage.associated'].result, [{ value: 2001, n: 1 }]);
  assert.equal(c['imessage.date_unit'].result.nanoseconds, 1);
  assert.deepEqual(c['contacts.counts'].result, { records: 1, phones: 1, emails: 1 });
  assert.deepEqual(c['whatsapp.lid_mapping'].result, { lids: 2, mapped: 1 });
  assert.deepEqual(c['whatsapp.captions'].result, { images: 1, text_set: 0, media_title_set: 1 });
  assert.deepEqual(c['call_recordings.folders'].result, { folders: 1 });
  assert.deepEqual(c['call_recordings.extractor_view'].result, { call_notes: 1, with_audio: 1, with_transcript: 1, body_decoded: 1 });
  assert.deepEqual(c['call_recordings.media_layout'].result, { audio_with_media: 1, direct_files: 0, generation_folder: 1, missing: 0 });
  assert.deepEqual(c['calls.address_type'].result, [{ value: 'blob', n: 1 }]);
  assert.deepEqual(c['wispr.shapes'].result, { speaker_map: { json_object: 1 }, participant_names: { json_array: 1 } });
  assert.deepEqual(c['wispr.meeting_files'].result, { meeting_folders: 1, with_refined: 1, file_names: { 'refined.ndjson': 1, other_txt: 1 }, first_line_keys: ['speaker', 'text'] });
  assert.deepEqual(c['zoom_local.folders'].result, { folders: 1, named: 1, with_meeting_id: 1 });
  assert.equal(c['email.tables'].skipped, 'not found');
  assert.ok(report.checks.every((x) => 'result' in x || x.skipped || x.error));
  const errors = report.checks.filter((x) => x.error);
  assert.ok(errors.every((x) => /no such (column|table)/.test(x.error)), JSON.stringify(errors.map((x) => [x.id, x.error])));
  assert.equal(c['call_recordings.host_apps'].error, 'no such column: ZHOSTAPPLICATIONIDENTIFIER', 'older Notes schemas report the missing column');
});

test('real probe: one source at a time, and an empty Mac skips everything', async () => {
  const one = await realProbe({ home: plantedHome(), source: 'calls' });
  assert.ok(one.checks.length > 0 && one.checks.every((x) => x.source === 'calls'));
  const empty = await realProbe({ home: tempHome() });
  for (const x of empty.checks) assert.ok(x.skipped === 'not found' || (x.result && typeof x.result === 'object'), x.id);
});

test('sanitize keeps numbers and identifiers, redacts everything else', () => {
  assert.deepEqual(sanitize({ n: 3, ok: true, uti: 'com.apple.m4a-audio', name: 'Ana López', bad: 'hi there', bytes: new Uint8Array([1]) }), { n: 3, ok: true, uti: 'com.apple.m4a-audio', name: '[redacted]', bad: '[redacted]', bytes: '[redacted]' });
  assert.deepEqual(sanitize({ 'Ana López': 1 }), { '[redacted]': 1 });
});

test('docs/real-probe.md lists every check with its exact SQL and has no dashes', () => {
  const doc = readFileSync(join(REPO_ROOT, 'docs/real-probe.md'), 'utf8');
  for (const c of CHECKS) {
    assert.ok(doc.includes(`### ${c.id}\n`), c.id);
    if (c.sql) assert.ok(doc.includes(c.sql), `${c.id} SQL`);
    assert.ok(doc.includes(c.expect), `${c.id} expect`);
  }
  assert.ok(!/—|–|--/.test(doc));
});
