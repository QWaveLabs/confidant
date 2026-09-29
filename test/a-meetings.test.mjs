import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeCtx, tempHome, createDb, insert, runSource, schemaErrors, writeFile, resetCaches } from './fixtures/a-fixtures.mjs';
import * as wispr from '../engine/extract/wispr.mjs';
import * as zoom from '../engine/extract/zoom-local.mjs';

function wisprFixture(home) {
  const dir = join(home, 'Library/Application Support/Wispr Flow');
  const db = createDb(
    join(dir, 'flow.sqlite'),
    `CREATE TABLE Meetings (id TEXT PRIMARY KEY, title TEXT, createdAt DATETIME, modifiedAt DATETIME, endedAt DATETIME, participantNames TEXT, notes TEXT,
       summary TEXT, speakerMap TEXT, calendarEventExternalId TEXT, isDeleted TINYINT(1) DEFAULT 0);
     CREATE TABLE History (transcriptEntityId UUID PRIMARY KEY, asrText TEXT, formattedText TEXT, editedText TEXT, timestamp DATETIME, app TEXT, url TEXT,
       duration FLOAT, numWords INTEGER, isArchived TINYINT(1) DEFAULT 0);`,
  );
  insert(db, 'Meetings', [
    { id: 'm-1', title: 'Acme pricing', createdAt: '2026-09-10 14:00:00.000 +00:00', modifiedAt: '2026-09-10 15:00:05.000 +00:00', endedAt: '2026-09-10 14:45:00.000 +00:00',
      participantNames: JSON.stringify(['Rob Hernandez', 'Ana López']), summary: 'Agreed on a pilot.', speakerMap: JSON.stringify({ spk_0: 'Rob Hernandez', spk_1: 'Ana López' }), calendarEventExternalId: 'ical-1@acme' },
    { id: 'm-2', title: 'Deleted one', createdAt: '2026-09-11 14:00:00', modifiedAt: '2026-09-11 14:00:00', isDeleted: 1 },
    { id: 'm-3', title: 'Still processing', createdAt: '2026-09-12T14:00:00.000Z', modifiedAt: '2026-09-12T14:00:00.000Z', participantNames: 'Sara Kim, Mike Brennan' },
  ]);
  insert(db, 'History', [{ transcriptEntityId: 'h-1', asrText: 'send the deck', formattedText: 'Send the deck.', editedText: null, timestamp: '2026-09-10 16:00:00', app: 'com.tinyspeck.slackmacgap', numWords: 3 }]);
  const ndjson = [
    { id: 1, speaker: 'spk_0', text: 'Thanks for joining.', timestamp: 0 },
    { id: 2, speaker: 'spk_0', text: 'Let us talk pricing.', timestamp: 2 },
    { id: 3, speaker: 'spk_1', text: 'We can do a pilot.', timestamp: 5 },
    { id: 4, speaker: '2', text: 'Sounds good.', timestamp: 9 },
  ].map((r) => JSON.stringify(r)).join('\n');
  writeFile(join(dir, 'meetings', 'm-1', 'refined.ndjson'), `${ndjson}\n`);
  return { db, dir };
}

test('wispr: meetings with speaker names, participants and summaries; dictations off by default', async () => {
  const home = tempHome();
  const { dir } = wisprFixture(home);
  const ctx = makeCtx({ home });
  resetCaches();
  assert.deepEqual(await wispr.probe(ctx), { ok: true, count: 2 });
  await runSource(ctx, 'wispr');
  const recs = ctx.store.records({ source: 'wispr' });
  assert.deepEqual(schemaErrors(recs), []);
  assert.equal(recs.length, 2, 'deleted meeting skipped, no dictations');
  const m = ctx.store.record('wispr:m-1');
  assert.equal(m.kind, 'meeting');
  assert.equal(m.thread, 'meeting:wispr:m-1');
  assert.equal(m.ts, '2026-09-10T14:00:00.000Z');
  assert.equal(m.text, 'Rob Hernandez: Thanks for joining. Let us talk pricing.\nAna López: We can do a pilot.\nSpeaker 2: Sounds good.');
  assert.deepEqual(m.to, [{ handle: 'name:ana lópez', name: 'Ana López' }], 'the owner is not an attendee of their own meeting');
  assert.equal(m.meta.summary, 'Agreed on a pilot.');
  assert.equal(m.meta.duration_s, 2700);
  assert.equal(m.meta.calendar_event_id, 'ical-1@acme');
  const pending = ctx.store.record('wispr:m-3');
  assert.equal(pending.meta.needs_transcript, true);
  assert.deepEqual(pending.to.map((p) => p.name), ['Sara Kim', 'Mike Brennan']);
  writeFile(join(dir, 'meetings', 'm-3', 'refined.ndjson'), `${JSON.stringify({ id: 1, speaker: 'Sara Kim', text: 'Kickoff notes.' })}\n`);
  const retry = await runSource(ctx, 'wispr');
  assert.equal(retry.updated, 1);
  assert.equal(ctx.store.record('wispr:m-3').text, 'Sara Kim: Kickoff notes.');
});

test('wispr: dictations when turned on', async () => {
  const home = tempHome();
  wisprFixture(home);
  const ctx = makeCtx({ home, config: { sources: { wispr: { enabled: true, dictations: true } } } });
  await runSource(ctx, 'wispr');
  const d = ctx.store.record('wispr:h:h-1');
  assert.equal(d.kind, 'dictation');
  assert.equal(d.text, 'Send the deck.');
  assert.equal(d.meta.app, 'com.tinyspeck.slackmacgap');
  assert.equal(d.is_from_me, true);
});

test('zoom local: VTT, closed captions, chat, audio transcription, and folder names', async () => {
  const home = tempHome();
  const root = join(home, 'Documents/Zoom');
  const a = join(root, '2026-09-15 14.30.12 Acme Weekly 81234567890');
  writeFile(join(a, 'recording.transcript.vtt'), 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nAna López: Welcome everyone.\n\n2\n00:00:04.500 --> 00:00:09.250\n<v Rob Hernandez>Thanks, quick update on pricing.</v>\n\n3\n00:10:00.000 --> 00:10:05.500\nAna López: Let us sign.\n');
  writeFile(join(a, 'meeting_saved_chat.txt'), '14:31:02 From Mike Brennan to Everyone:\n\tdeck link: https://example.test/deck\n14:32:10 From  Ana López  to  Everyone:\n\tthanks\n');
  writeFile(join(a, 'audio1234567890.m4a'), 'audio');
  const b = join(root, "2026-09-16 10.00.00 Rob Hernandez's Zoom Meeting");
  writeFile(join(b, 'closed_caption.txt'), '[Sara Kim] 10:00:05\nMorning.\n\n[Sara Kim] 10:00:09\nReady when you are.\n\n[Rob Hernandez] 10:00:15\nLet us start.\n');
  const c = join(root, '2026-09-17 09.00.00 Board call');
  writeFile(join(c, 'audio0001.m4a'), 'audio');
  writeFile(join(root, 'empty folder', '.DS_Store'), '');
  const seen = [];
  const ctx = makeCtx({ home, tz: 'America/New_York', transcriber: { async transcribe(_ctx, file, opts) { seen.push(opts.mimetype); return { text: 'Board agreed.', utterances: [], provider: 'deepgram' }; } } });
  assert.deepEqual(await zoom.probe(ctx), { ok: true, count: 3 });
  await runSource(ctx, 'zoom_local', { limit: 2 });
  const recs = ctx.store.records({ source: 'zoom_local' });
  assert.deepEqual(schemaErrors(recs), []);
  assert.equal(recs.length, 3);
  const [weekly, captions, board] = recs;
  assert.equal(weekly.title, 'Acme Weekly');
  assert.equal(weekly.ts, '2026-09-15T18:30:12.000Z');
  assert.equal(weekly.meta.meeting_id, '81234567890');
  assert.equal(weekly.text, 'Ana López: Welcome everyone.\nRob Hernandez: Thanks, quick update on pricing.\nAna López: Let us sign.');
  assert.equal(weekly.meta.duration_s, 606);
  assert.equal(weekly.meta.chat, 'Mike Brennan: deck link: https://example.test/deck\nAna López: thanks');
  assert.deepEqual(weekly.to.map((p) => p.name).sort(), ['Ana López', 'Mike Brennan']);
  assert.equal(captions.title, "Rob Hernandez's Zoom Meeting");
  assert.equal(captions.text, 'Sara Kim: Morning. Ready when you are.\nRob Hernandez: Let us start.');
  assert.equal(board.text, 'Board agreed.');
  assert.equal(board.meta.transcript_source, 'deepgram');
  assert.deepEqual(seen, ['audio/mp4']);
  assert.equal((await runSource(ctx, 'zoom_local')).inserted, 0);
  assert.equal(seen.length, 1);
});

test('zoom local: parsers', () => {
  assert.deepEqual(zoom.parseFolderName('2024-03-05 09.05.00 Standup', 'UTC'), { ts: '2024-03-05T09:05:00.000Z', topic: 'Standup', meetingId: null });
  assert.equal(zoom.parseFolderName('random'), null);
  assert.deepEqual(zoom.parseChat('10:05:12\t From  Ana : hola\n'), [{ sender: 'Ana', text: 'hola' }]);
  assert.deepEqual(zoom.parseVtt('WEBVTT\n\n00:01.000 --> 00:02.000\nhello'), [{ speaker: null, text: 'hello', end: 2 }], 'mm:ss cues without hours');
});

test('wispr and zoom probes without data', async () => {
  const ctx = makeCtx({ home: tempHome() });
  assert.equal((await wispr.probe(ctx)).ok, false);
  assert.equal((await zoom.probe(ctx)).ok, false);
});
