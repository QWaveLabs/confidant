import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { makeCtx, tempHome, insert, runSource, schemaErrors, resetCaches } from './fixtures/a-fixtures.mjs';
import { chatDb, addMessage, addressBook, attributedBody } from './fixtures/a-apple.mjs';
import * as imessage from '../engine/extract/imessage.mjs';

function fixture() {
  const home = tempHome();
  const db = chatDb(home);
  insert(db, 'handle', [
    { ROWID: 1, id: '+13055551234', service: 'iMessage' },
    { ROWID: 2, id: 'ana@acme.test', service: 'iMessage' },
    { ROWID: 3, id: '24273', service: 'SMS' },
    { ROWID: 4, id: '+525512345678', service: 'SMS' },
  ]);
  insert(db, 'chat', [
    { ROWID: 1, guid: 'iMessage;-;+13055551234', style: 45, chat_identifier: '+13055551234', service_name: 'iMessage' },
    { ROWID: 2, guid: 'iMessage;+;chat900', style: 43, chat_identifier: 'chat900', service_name: 'iMessage', display_name: 'Acme deal room' },
    { ROWID: 3, guid: 'SMS;-;24273', style: 45, chat_identifier: '24273', service_name: 'SMS' },
  ]);
  insert(db, 'chat_handle_join', [{ chat_id: 1, handle_id: 1 }, { chat_id: 2, handle_id: 1 }, { chat_id: 2, handle_id: 2 }, { chat_id: 2, handle_id: 4 }, { chat_id: 3, handle_id: 3 }]);
  addressBook(home, 'SRC-1', [
    { pk: 1, first: 'Mike', last: 'Brennan', phones: ['(305) 555-1234'] },
    { pk: 2, first: 'Ana', last: 'López', emails: ['Ana@Acme.test'] },
  ]);
  const m = {};
  m.plain = addMessage(db, { chat: 1, handle: 1, text: 'Can you send the deck?', at: '2026-09-01T14:00:00Z' });
  m.body = addMessage(db, { chat: 1, handle: 1, body: 'Sent from attributedBody ✓', at: '2026-09-01T14:01:00Z', fromMe: true, myId: 'alex@owner.test' });
  m.long = addMessage(db, { chat: 1, handle: 1, body: 'x'.repeat(300), at: '2026-09-01T14:02:00Z' });
  m.tapback = addMessage(db, { chat: 1, handle: 1, text: 'Loved "Can you send the deck?"', at: '2026-09-01T14:03:00Z', assoc: 2000 });
  m.group = addMessage(db, { chat: 2, handle: 2, text: 'Board meets Friday', at: '2026-09-02T10:00:00Z' });
  m.groupMine = addMessage(db, { chat: 2, handle: 0, text: 'Works for me', at: '2026-09-02T10:05:00Z', fromMe: true });
  m.rename = addMessage(db, { chat: 2, handle: 2, text: null, at: '2026-09-02T10:06:00Z', itemType: 2 });
  m.unsent = addMessage(db, { chat: 1, handle: 1, text: 'oops', at: '2026-09-02T11:00:00Z', retracted: true });
  m.sms = addMessage(db, { chat: 3, handle: 3, text: 'Chase: $52.10 debit card transaction on account ending in 1234', at: '2026-09-03T09:00:00Z', service: 'SMS' });
  m.photo = addMessage(db, { chat: 1, handle: 1, text: '￼', at: '2026-09-03T12:00:00Z', replyTo: 'MSG-1' });
  insert(db, 'attachment', { ROWID: 1, guid: 'AT-1', filename: '~/Library/Messages/Attachments/ab/IMG_0001.HEIC', mime_type: 'image/heic', uti: 'public.heic', transfer_name: 'IMG_0001.HEIC', total_bytes: 123456 });
  insert(db, 'message_attachment_join', { message_id: m.photo.rowid, attachment_id: 1 });
  return { home, db, m };
}

test('attributedBody decoding: short, long (2 byte length) and junk', () => {
  assert.equal(imessage.decodeAttributedBody(attributedBody('hola')), 'hola');
  assert.equal(imessage.decodeAttributedBody(attributedBody('é'.repeat(200))), 'é'.repeat(200));
  assert.equal(imessage.decodeAttributedBody(new Uint8Array([1, 2, 3])), null);
  assert.equal(imessage.decodeAttributedBody(null), null);
});

test('imessage: full history in pages, newest first, valid records', async () => {
  const { home, m } = fixture();
  const ctx = makeCtx({ home });
  const first = await imessage.extract(ctx, { cursor: null, limit: 3 });
  assert.equal(first.done, false);
  assert.equal(first.records[0].id, `imessage:${m.photo.guid}`, 'newest first');
  const totals = await runSource(ctx, 'imessage', { limit: 3 });
  assert.equal(totals.invalid, 0);
  const recs = ctx.store.records({ source: 'imessage' });
  assert.deepEqual(schemaErrors(recs), []);
  const byId = Object.fromEntries(recs.map((r) => [r.id.replace('imessage:', ''), r]));
  assert.equal(recs.length, 7, 'tapback, rename and unsent message are skipped');
  assert.ok(!byId[m.tapback.guid] && !byId[m.rename.guid] && !byId[m.unsent.guid]);

  const plain = byId[m.plain.guid];
  assert.equal(plain.ts, '2026-09-01T14:00:00.000Z');
  assert.deepEqual(plain.from, { handle: 'tel:+13055551234', name: 'Mike Brennan' });
  assert.equal(plain.thread, 'imessage:iMessage;-;+13055551234');
  assert.equal(plain.meta.service, 'iMessage');

  const mine = byId[m.body.guid];
  assert.equal(mine.text, 'Sent from attributedBody ✓');
  assert.equal(mine.is_from_me, true);
  assert.deepEqual(mine.from, { handle: 'mailto:alex@owner.test', name: 'Alex Rivera' });
  assert.deepEqual(mine.to, [{ handle: 'tel:+13055551234', name: 'Mike Brennan' }]);
  assert.equal(byId[m.long.guid].text.length, 300);

  const group = byId[m.group.guid];
  assert.equal(group.meta.is_group, true);
  assert.equal(group.meta.chat_name, 'Acme deal room');
  assert.deepEqual(group.to, [{ handle: 'group:imessage:iMessage;+;chat900', name: 'Acme deal room' }]);
  assert.deepEqual(group.from, { handle: 'mailto:ana@acme.test', name: 'Ana López' });
  assert.deepEqual(group.meta.participants.sort(), ['mailto:ana@acme.test', 'tel:+13055551234', 'tel:+525512345678']);
  assert.equal(byId[m.groupMine.guid].from.name, 'Alex Rivera');

  const photo = byId[m.photo.guid];
  assert.equal(photo.text, '');
  assert.deepEqual(photo.meta.attachments, [{ filename: 'IMG_0001.HEIC', mime: 'image/heic', uti: 'public.heic', bytes: 123456 }]);
  assert.equal(photo.meta.reply_to, 'imessage:MSG-1');
  assert.equal(byId[m.sms.guid].meta.service, 'SMS');
});

test('imessage: resumable, only new rows on the next run', async () => {
  const { home, db } = fixture();
  const ctx = makeCtx({ home });
  await runSource(ctx, 'imessage', { limit: 4 });
  const again = await runSource(ctx, 'imessage', { limit: 4 });
  assert.equal(again.inserted, 0);
  addMessage(db, { chat: 1, handle: 1, text: 'New one', at: '2026-09-10T09:00:00Z' });
  const next = await runSource(ctx, 'imessage', { limit: 4 });
  assert.equal(next.inserted, 1);
  assert.equal(ctx.store.records({ source: 'imessage' }).length, 8);
});

test('imessage: privacy categories drop the bank short code thread', async () => {
  const { home } = fixture();
  const ctx = makeCtx({ home, config: { exclusions: { categories: ['banking'] } } });
  const totals = await runSource(ctx, 'imessage', { limit: 100 });
  assert.equal(totals.excluded, 1);
  assert.ok(!ctx.store.records({ source: 'imessage' }).some((r) => r.thread === 'imessage:SMS;-;24273'));
});

test('imessage: older schema without the newer columns, dates in seconds', async () => {
  const home = tempHome();
  const db = chatDb(home, { legacy: true });
  insert(db, 'handle', { ROWID: 1, id: '+13055551234', service: 'SMS' });
  insert(db, 'chat', { ROWID: 1, guid: 'SMS;-;+13055551234', style: 45, chat_identifier: '+13055551234', service_name: 'SMS' });
  addMessage(db, { chat: 1, handle: 1, text: 'old times', at: '2015-05-01T10:00:00Z', seconds: true, service: 'SMS' });
  const ctx = makeCtx({ home });
  await runSource(ctx, 'imessage');
  const [r] = ctx.store.records({ source: 'imessage' });
  assert.equal(r.ts, '2015-05-01T10:00:00.000Z');
  assert.equal(r.text, 'old times');
});

test('imessage: probe reports counts, a missing database, and Full Disk Access', async () => {
  const { home } = fixture();
  resetCaches();
  assert.deepEqual(await imessage.probe(makeCtx({ home })), { ok: true, count: 10 });
  const empty = await imessage.probe(makeCtx({ home: tempHome() }));
  assert.equal(empty.ok, false);
  assert.ok(!empty.needsFullDiskAccess);
  const locked = join(home, 'Library/Messages/chat.db');
  chmodSync(locked, 0o000);
  try {
    resetCaches();
    const p = await imessage.probe(makeCtx({ home }));
    assert.equal(p.needsFullDiskAccess, true);
    await assert.rejects(imessage.extract(makeCtx({ home }), { cursor: null }), (err) => err.needsFullDiskAccess === true);
  } finally {
    chmodSync(locked, 0o644);
  }
});
