import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readVarint, encodeVarint, encodeField, encodeMessage, fields, path, decodeNoteBody, unzipMaybe } from '../engine/lib/a-protobuf.mjs';
import { atom, atoms, findAtoms, parseTranscriptJson, transcriptFromMoov, readAudioTranscript } from '../engine/lib/a-mp4.mjs';
import { tempHome, writeFile } from './fixtures/a-fixtures.mjs';
import { noteBody } from './fixtures/a-apple.mjs';

test('protobuf varints round trip, including multi-byte and large values', () => {
  for (const n of [0, 1, 127, 128, 300, 16384, 2 ** 31 + 5, 2 ** 40]) assert.equal(readVarint(encodeVarint(n), 0)[0], n);
  assert.throws(() => readVarint(Buffer.from([0x80]), 0), /truncated/);
});

test('protobuf fields and nested paths', () => {
  const inner = encodeMessage(encodeField(1, 42), encodeField(2, 'hola'));
  const outer = encodeMessage(encodeField(3, inner), encodeField(4, 7));
  const list = [...fields(outer)];
  assert.deepEqual(list.map((f) => [f.field, f.wire]), [[3, 2], [4, 0]]);
  assert.equal(path(outer, 3, 2).toString(), 'hola');
  assert.equal(path(outer, 9, 2), undefined);
});

test('Apple Notes body: gzip, text and attachment references', () => {
  const body = noteBody('Call with Mike\n￼\nSummary here', [{ id: 'ATT-1', uti: 'com.apple.m4a-audio' }]);
  const decoded = decodeNoteBody(body);
  assert.equal(decoded.text, 'Call with Mike\n￼\nSummary here');
  assert.deepEqual(decoded.attachments, [{ id: 'ATT-1', uti: 'com.apple.m4a-audio' }]);
  assert.equal(decodeNoteBody(Buffer.from('not protobuf at all')), null);
  assert.equal(decodeNoteBody(null), null);
  assert.equal(unzipMaybe(gzipSync(Buffer.from('x'))).toString(), 'x');
});

const TSRP = { attributedString: { runs: ['Idea para ', 0, 'el cliente.', 1], attributeTable: [{ timeRange: [0, 1.2] }, { timeRange: [1.2, 2.5] }] }, locale: { identifier: 'es_MX', current: 0 } };

test('transcript JSON: runs joined, time ranges kept', () => {
  const t = parseTranscriptJson(JSON.stringify(TSRP));
  assert.equal(t.text, 'Idea para el cliente.');
  assert.deepEqual(t.segments, [{ start: 0, end: 1.2, text: 'Idea para ' }, { start: 1.2, end: 2.5, text: 'el cliente.' }]);
  assert.equal(t.locale, 'es_MX');
  assert.equal(parseTranscriptJson('{bad'), null);
  assert.equal(parseTranscriptJson(JSON.stringify({ attributedString: { runs: [] } })), null);
});

test('mp4 atoms: m4a udta/tsrp, qta keys/ilst, 64-bit sizes, moov after mdat', () => {
  const m4aMoov = atom('moov', atom('mvhd', Buffer.alloc(100)), atom('trak', atom('tkhd', Buffer.alloc(20)), atom('udta', atom('tsrp', JSON.stringify(TSRP)))));
  assert.equal(transcriptFromMoov(m4aMoov).text, 'Idea para el cliente.');
  const key = Buffer.from('com.apple.VoiceMemos.tsrp');
  const keyEntry = Buffer.concat([Buffer.from([0, 0, 0, 8 + key.length]), Buffer.from('mdta'), key]);
  const keys = atom('keys', Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), keyEntry);
  const item = Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0, 0, 1]), atom('data', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]), JSON.stringify(TSRP))]);
  item.writeUInt32BE(item.length, 0);
  const qtaMoov = atom('moov', atom('meta', atom('hdlr', Buffer.alloc(24)), keys, atom('ilst', item)));
  assert.equal(transcriptFromMoov(qtaMoov).text, 'Idea para el cliente.');
  const big = Buffer.alloc(16 + 8);
  big.writeUInt32BE(1, 0);
  big.write('free', 4, 'latin1');
  big.writeBigUInt64BE(24n, 8);
  assert.deepEqual([...atoms(big)].map((a) => a.type), ['free']);
  assert.equal(findAtoms(m4aMoov, 'tsrp').length, 1);
  const dir = tempHome();
  const file = writeFile(join(dir, 'memo.m4a'), Buffer.concat([atom('ftyp', 'M4A mp42isom'), atom('mdat', Buffer.alloc(50000, 7)), m4aMoov]));
  assert.equal(readAudioTranscript(file).text, 'Idea para el cliente.');
  const none = writeFile(join(dir, 'plain.m4a'), Buffer.concat([atom('ftyp', 'M4A '), atom('moov', atom('mvhd', Buffer.alloc(100)))]));
  assert.equal(readAudioTranscript(none), null);
  assert.equal(readAudioTranscript(join(dir, 'missing.m4a')), null);
});
