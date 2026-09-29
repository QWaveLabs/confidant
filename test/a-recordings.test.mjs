import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeCtx, tempHome, createDb, insert, runSource, schemaErrors, writeFile, resetCaches } from './fixtures/a-fixtures.mjs';
import { callHistory, noteStore, noteBody, addressBook, appleSeconds } from './fixtures/a-apple.mjs';
import { atom } from '../engine/lib/a-mp4.mjs';
import * as calls from '../engine/extract/calls.mjs';
import * as recordings from '../engine/extract/call-recordings.mjs';
import * as memos from '../engine/extract/voice-memos.mjs';

function fakeTranscriber() {
  const seen = [];
  return {
    seen,
    async transcribe(ctx, file, { mimetype }) {
      seen.push({ file, mimetype });
      return { text: 'raw', utterances: [{ speaker: 0, start: 0, end: 1, text: 'Hola, ¿cómo va?' }, { speaker: 0, start: 1, end: 2, text: 'Bien.' }, { speaker: 1, start: 2, end: 3, text: 'Todo listo.' }], provider: 'deepgram' };
    },
  };
}

function callsFixture(home) {
  const db = callHistory(home);
  insert(db, 'ZCALLRECORD', [
    { Z_PK: 1, ZUNIQUE_ID: 'C-1', ZDATE: appleSeconds('2026-09-10T15:00:00Z'), ZDURATION: 725.4, ZADDRESS: Buffer.from('+13055551234'), ZORIGINATED: 1, ZANSWERED: 1, ZCALLTYPE: 1, ZSERVICE_PROVIDER: 'com.apple.Telephony' },
    { Z_PK: 2, ZUNIQUE_ID: 'C-2', ZDATE: appleSeconds('2026-09-11T16:00:00Z'), ZDURATION: 42, ZADDRESS: Buffer.from('ana@acme.test'), ZNAME: 'Ana López', ZORIGINATED: 0, ZANSWERED: 1, ZCALLTYPE: 16, ZSERVICE_PROVIDER: 'com.apple.FaceTime' },
    { Z_PK: 3, ZUNIQUE_ID: 'C-3', ZDATE: appleSeconds('2026-09-12T17:00:00Z'), ZDURATION: 0, ZADDRESS: Buffer.from('+15550009999'), ZORIGINATED: 0, ZANSWERED: 0, ZCALLTYPE: 1 },
  ]);
  return db;
}

test('calls: direction, service, names and summaries in both languages', async () => {
  const home = tempHome();
  const db = callsFixture(home);
  addressBook(home, 'SRC-1', [{ pk: 1, first: 'Mike', last: 'Brennan', phones: ['305-555-1234'] }]);
  const ctx = makeCtx({ home });
  await runSource(ctx, 'calls', { limit: 2 });
  const recs = ctx.store.records({ source: 'calls' });
  assert.deepEqual(schemaErrors(recs), []);
  assert.equal(recs.length, 3);
  const [out, facetime, missed] = recs;
  assert.equal(out.kind, 'call');
  assert.equal(out.is_from_me, true);
  assert.deepEqual(out.to, [{ handle: 'tel:+13055551234', name: 'Mike Brennan' }]);
  assert.equal(out.thread, 'calls:tel:+13055551234');
  assert.equal(out.text, 'Outgoing phone call, 12 min');
  assert.deepEqual(out.meta, { direction: 'outgoing', duration_s: 725, service: 'phone', answered: true, provider: 'com.apple.Telephony' });
  assert.deepEqual(facetime.from, { handle: 'mailto:ana@acme.test', name: 'Ana López' });
  assert.equal(facetime.text, 'Incoming FaceTime audio call, 42 s');
  assert.equal(missed.meta.direction, 'missed');
  assert.equal(missed.text, 'Missed phone call');
  assert.equal(calls.summary('es', 'outgoing', 'phone', 125), 'Llamada saliente telefónica, 2 min');
  assert.equal(calls.summary('es', 'missed', 'facetime_audio', 0), 'Llamada perdida de FaceTime audio');
  insert(db, 'ZCALLRECORD', { Z_PK: 4, ZUNIQUE_ID: 'C-4', ZDATE: appleSeconds('2026-09-13T10:00:00Z'), ZDURATION: 60, ZADDRESS: Buffer.from('+13055551234'), ZORIGINATED: 1, ZANSWERED: 1, ZCALLTYPE: 1 });
  assert.equal((await runSource(ctx, 'calls')).inserted, 1);
  resetCaches();
  assert.deepEqual(await calls.probe(ctx), { ok: true, count: 4 });
});

function notesFixture(home) {
  const db = noteStore(home);
  const media = (pk, ident, file) => {
    insert(db, 'ZICCLOUDSYNCINGOBJECT', { Z_PK: pk, Z_ENT: 11, ZIDENTIFIER: ident, ZFILENAME: file, ZGENERATION: '1' });
    writeFile(join(home, 'Library/Group Containers/group.com.apple.notes/Accounts/ACCT-1/Media', ident, '1_GEN', file), atom('ftyp', 'M4A '));
  };
  insert(db, 'ZICCLOUDSYNCINGOBJECT', [
    { Z_PK: 1, Z_ENT: 15, ZIDENTIFIER: 'F-1', ZTITLE2: 'Call Recordings' },
    { Z_PK: 2, Z_ENT: 15, ZIDENTIFIER: 'F-2', ZTITLE2: 'Grabaciones de llamadas' },
    { Z_PK: 3, Z_ENT: 15, ZIDENTIFIER: 'F-3', ZTITLE2: 'Groceries' },
  ]);
  const note = (pk, ident, folder, title, at, { deleted = 0, text, attachments = [] } = {}) => {
    insert(db, 'ZICCLOUDSYNCINGOBJECT', { Z_PK: pk, Z_ENT: 12, ZIDENTIFIER: ident, ZFOLDER: folder, ZTITLE1: title, ZCREATIONDATE3: appleSeconds(at), ZMODIFICATIONDATE1: appleSeconds(at) + 30, ZMARKEDFORDELETION: deleted });
    insert(db, 'ZICNOTEDATA', { Z_PK: pk, ZNOTE: pk, ZDATA: noteBody(text ?? `${title}\n￼`, attachments) });
  };
  note(10, 'N-1', 1, 'Call with Mike Brennan', '2026-09-10T15:00:40Z', { text: 'Call with Mike Brennan\n￼\nMike will send the contract by Friday.', attachments: [{ id: 'A-1', uti: 'com.apple.m4a-audio' }] });
  insert(db, 'ZICCLOUDSYNCINGOBJECT', { Z_PK: 20, Z_ENT: 5, ZIDENTIFIER: 'A-1', ZTYPEUTI: 'com.apple.m4a-audio', ZNOTE: 10, ZMEDIA: 30, ZDURATION: 720.2, ZADDITIONALINDEXABLETEXT: 'Hey Mike, about the contract. Sure, Friday works.' });
  media(30, 'M-1', 'Audio.m4a');
  note(11, 'N-2', 1, '+1 (305) 555-9999', '2026-09-14T10:00:00Z');
  insert(db, 'ZICCLOUDSYNCINGOBJECT', { Z_PK: 21, Z_ENT: 5, ZIDENTIFIER: 'A-2', ZTYPEUTI: 'com.apple.m4a-audio', ZNOTE: 11, ZMEDIA: 31 });
  media(31, 'M-2', 'Audio.m4a');
  note(12, 'N-3', 2, 'Llamada con Ana López', '2026-09-15T18:00:00Z', { attachments: [{ id: 'A-3', uti: 'com.apple.m4a-audio' }] });
  insert(db, 'ZICCLOUDSYNCINGOBJECT', { Z_PK: 22, Z_ENT: 5, ZIDENTIFIER: 'A-3', ZTYPEUTI: 'com.apple.m4a-audio', ZMEDIA: 32 });
  media(32, 'M-3', 'Audio.m4a');
  note(13, 'N-4', 3, 'Milk and eggs', '2026-09-15T19:00:00Z');
  note(14, 'N-5', 1, 'Call with Old Friend', '2026-09-16T19:00:00Z', { deleted: 1 });
  return db;
}

test('call recordings: Apple transcripts, call history match, transcription and retries', async () => {
  const home = tempHome();
  callsFixture(home);
  addressBook(home, 'SRC-1', [{ pk: 1, first: 'Mike', last: 'Brennan', phones: ['305-555-1234'] }]);
  notesFixture(home);
  const ctx = makeCtx({ home, transcriber: null });
  resetCaches();
  assert.deepEqual(await recordings.probe(ctx), { ok: true, count: 3 });
  await runSource(ctx, 'call_recordings');
  let recs = ctx.store.records({ source: 'call_recordings' });
  assert.deepEqual(schemaErrors(recs), []);
  assert.equal(recs.length, 3, 'other folders and deleted notes are ignored');
  const mike = ctx.store.record('call_recordings:N-1');
  assert.equal(mike.kind, 'call');
  assert.equal(mike.text, 'Hey Mike, about the contract. Sure, Friday works.');
  assert.equal(mike.meta.transcript_source, 'apple');
  assert.equal(mike.meta.summary, 'Mike will send the contract by Friday.');
  assert.equal(mike.meta.duration_s, 720);
  assert.equal(mike.meta.direction, 'outgoing', 'matched to the call 40 seconds earlier');
  assert.equal(mike.is_from_me, true);
  assert.deepEqual(mike.to, [{ handle: 'tel:+13055551234', name: 'Mike Brennan' }]);
  assert.equal(mike.thread, 'calls:tel:+13055551234', 'joins the call history thread');
  const pending = ctx.store.record('call_recordings:N-2');
  assert.equal(pending.meta.needs_transcript, true);
  assert.equal(pending.text, '');
  assert.deepEqual(pending.to, [{ handle: 'tel:+13055559999', name: null }]);
  const ana = ctx.store.record('call_recordings:N-3');
  assert.deepEqual(ana.to, [{ handle: 'name:ana lópez', name: 'Ana López' }]);
  assert.equal(ana.meta.needs_transcript, true, 'found through the note body reference');

  const t = fakeTranscriber();
  ctx.transcriber = t;
  const retry = await runSource(ctx, 'call_recordings');
  assert.equal(retry.updated, 2);
  assert.equal(t.seen.length, 2);
  assert.equal(t.seen[0].mimetype, 'audio/mp4');
  assert.ok(t.seen[0].file.endsWith('Audio.m4a'));
  const done = ctx.store.record('call_recordings:N-2');
  assert.equal(done.text, 'Speaker 1: Hola, ¿cómo va? Bien.\nSpeaker 2: Todo listo.');
  assert.equal(done.meta.transcript_source, 'deepgram');
  assert.ok(!done.meta.needs_transcript);
  const quiet = await runSource(ctx, 'call_recordings');
  assert.equal(quiet.updated + quiet.inserted, 0);
  assert.equal(t.seen.length, 2, 'nothing is transcribed twice');
});

const TSRP = (text) => JSON.stringify({ attributedString: { runs: [text, 0], attributeTable: [{ timeRange: [0, 3] }] }, locale: { identifier: 'en_US' } });

test('voice memos: Apple transcripts in m4a and qta, folders, deleted and placeholder rows', async () => {
  const home = tempHome();
  const dir = join(home, 'Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings');
  const db = createDb(
    join(dir, 'CloudRecordings.db'),
    `CREATE TABLE ZCLOUDRECORDING (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZFLAGS INTEGER, ZFOLDER INTEGER, ZDATE TIMESTAMP, ZDURATION FLOAT, ZEVICTIONDATE TIMESTAMP,
       ZLOCALDURATION FLOAT, ZCUSTOMLABEL VARCHAR, ZCUSTOMLABELFORSORTING VARCHAR, ZENCRYPTEDTITLE VARCHAR, ZPATH VARCHAR, ZUNIQUEID VARCHAR);
     CREATE TABLE ZFOLDER (Z_PK INTEGER PRIMARY KEY, ZENCRYPTEDNAME VARCHAR, ZUUID VARCHAR);`,
  );
  insert(db, 'ZFOLDER', { Z_PK: 1, ZENCRYPTEDNAME: 'Ideas' });
  insert(db, 'ZCLOUDRECORDING', [
    { Z_PK: 1, ZDATE: appleSeconds('2026-09-01T12:00:00Z'), ZDURATION: 33.4, ZENCRYPTEDTITLE: 'Pricing idea', ZPATH: '20260901 080000-AAAA.m4a', ZUNIQUEID: 'VM-1', ZFOLDER: 1 },
    { Z_PK: 2, ZDATE: appleSeconds('2026-09-02T12:00:00Z'), ZDURATION: 12, ZCUSTOMLABEL: 'Enhanced memo', ZPATH: '20260902 080000-BBBB.m4a', ZUNIQUEID: 'VM-2' },
    { Z_PK: 3, ZDATE: appleSeconds('2026-09-03T12:00:00Z'), ZDURATION: 60, ZENCRYPTEDTITLE: 'Walk notes', ZPATH: '20260903 080000-CCCC.m4a', ZUNIQUEID: 'VM-3' },
    { Z_PK: 4, ZDATE: appleSeconds('2026-09-04T12:00:00Z'), ZENCRYPTEDTITLE: 'Deleted', ZPATH: 'x.m4a', ZUNIQUEID: 'VM-4', ZEVICTIONDATE: appleSeconds('2026-09-05T00:00:00Z') },
    { Z_PK: 5, ZDATE: appleSeconds('2026-09-05T12:00:00Z'), ZENCRYPTEDTITLE: 'Placeholder', ZPATH: '', ZUNIQUEID: 'VM-5' },
  ]);
  writeFile(join(dir, '20260901 080000-AAAA.m4a'), Buffer.concat([atom('ftyp', 'M4A '), atom('moov', atom('trak', atom('udta', atom('tsrp', TSRP('Raise the retainer to five thousand.'))))), atom('mdat', Buffer.alloc(100))]));
  const key = Buffer.from('com.apple.VoiceMemos.tsrp');
  const item = Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0, 0, 1]), atom('data', Buffer.alloc(8), TSRP('Enhanced audio transcript.'))]);
  item.writeUInt32BE(item.length, 0);
  const keys = atom('keys', Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), Buffer.concat([Buffer.from([0, 0, 0, 8 + key.length]), Buffer.from('mdta'), key]));
  writeFile(join(dir, '20260902 080000-BBBB.qta'), Buffer.concat([atom('ftyp', 'qt  '), atom('moov', atom('meta', atom('hdlr', Buffer.alloc(24)), keys, atom('ilst', item)))]));
  writeFile(join(dir, '20260903 080000-CCCC.m4a'), Buffer.concat([atom('ftyp', 'M4A '), atom('moov', atom('mvhd', Buffer.alloc(100)))]));
  const t = fakeTranscriber();
  const ctx = makeCtx({ home, transcriber: t });
  resetCaches();
  assert.deepEqual(await memos.probe(ctx), { ok: true, count: 3 });
  await runSource(ctx, 'voice_memos', { limit: 2 });
  const recs = ctx.store.records({ source: 'voice_memos' });
  assert.deepEqual(schemaErrors(recs), []);
  assert.equal(recs.length, 3);
  const [a, b, c] = recs;
  assert.equal(a.kind, 'recording');
  assert.equal(a.title, 'Pricing idea');
  assert.equal(a.text, 'Raise the retainer to five thousand.');
  assert.equal(a.meta.folder, 'Ideas');
  assert.equal(a.meta.duration_s, 33);
  assert.equal(a.is_from_me, true);
  assert.equal(b.title, 'Enhanced memo');
  assert.equal(b.text, 'Enhanced audio transcript.', 'ZPATH said .m4a, the file is .qta');
  assert.equal(c.meta.transcript_source, 'deepgram');
  assert.equal(t.seen.length, 1);
  assert.equal((await runSource(ctx, 'voice_memos')).inserted, 0);
});
