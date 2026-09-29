// `confidant chats`: the list a person picks exclusions from before anything
// is extracted. Names and counts only, and every row's exclude flags must
// really keep that chat or person out of extraction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, tempHome, insert, runSource, resetCaches } from './fixtures/a-fixtures.mjs';
import { chatDb, addMessage, addressBook, whatsappDb, addWa } from './fixtures/a-apple.mjs';
import { listChats } from '../engine/chats.mjs';

function home() {
  const h = tempHome();
  const db = chatDb(h);
  insert(db, 'handle', [
    { ROWID: 1, id: '+13055551234', service: 'iMessage' },
    { ROWID: 2, id: 'ana@acme.test', service: 'iMessage' },
    { ROWID: 3, id: '+13055559876', service: 'iMessage' },
  ]);
  insert(db, 'chat', [
    { ROWID: 1, guid: 'iMessage;-;+13055551234', style: 45, chat_identifier: '+13055551234', service_name: 'iMessage' },
    { ROWID: 2, guid: 'iMessage;+;chat900', style: 43, chat_identifier: 'chat900', service_name: 'iMessage', display_name: 'Family' },
    { ROWID: 3, guid: 'iMessage;+;chat901', style: 43, chat_identifier: 'chat901', service_name: 'iMessage' },
  ]);
  insert(db, 'chat_handle_join', [{ chat_id: 1, handle_id: 1 }, { chat_id: 2, handle_id: 1 }, { chat_id: 2, handle_id: 3 }, { chat_id: 3, handle_id: 1 }, { chat_id: 3, handle_id: 2 }]);
  addressBook(h, 'SRC-1', [
    { pk: 1, first: 'Mike', last: 'Brennan', phones: ['(305) 555-1234'] },
    { pk: 2, first: 'Ana', last: 'Lopez', emails: ['ana@acme.test'] },
    { pk: 3, first: 'Rosa', last: 'Diaz', phones: ['(305) 555-9876'] },
  ]);
  addMessage(db, { chat: 1, handle: 1, text: 'secret one to one words', at: '2026-09-01T14:00:00Z' });
  addMessage(db, { chat: 1, handle: 1, text: 'more private words', at: '2026-09-02T14:00:00Z' });
  for (let i = 0; i < 3; i++) addMessage(db, { chat: 2, handle: 3, text: `family chatter ${i}`, at: `2026-09-0${i + 3}T10:00:00Z` });
  addMessage(db, { chat: 3, handle: 2, text: 'deal notes', at: '2026-09-04T10:00:00Z' });

  const wa = whatsappDb(h).db;
  insert(wa, 'ZWACHATSESSION', [
    { Z_PK: 1, Z_ENT: 4, ZSESSIONTYPE: 0, ZCONTACTJID: '13055551234@s.whatsapp.net', ZPARTNERNAME: 'Mike Brennan' },
    { Z_PK: 2, Z_ENT: 4, ZSESSIONTYPE: 1, ZCONTACTJID: '120363000000000000@g.us', ZPARTNERNAME: 'Soccer parents' },
    { Z_PK: 3, Z_ENT: 4, ZSESSIONTYPE: 3, ZCONTACTJID: 'status@broadcast', ZPARTNERNAME: 'Status' },
  ]);
  addWa(wa, { chat: 1, text: 'wa private', at: '2026-09-05T10:00:00Z', fromJid: '13055551234@s.whatsapp.net' });
  addWa(wa, { chat: 2, text: 'practice moved', at: '2026-09-06T10:00:00Z', fromJid: '120363000000000000@g.us' });
  addWa(wa, { chat: 3, text: 'status post', at: '2026-09-06T11:00:00Z' });
  return h;
}

test('chats lists groups and people with counts, never message text', () => {
  resetCaches();
  const ctx = makeCtx({ home: home() });
  const v = listChats(ctx);
  assert.equal(v.sources.imessage.ok, true);
  assert.equal(v.sources.whatsapp.ok, true);
  const json = JSON.stringify(v);
  for (const words of ['secret', 'private', 'chatter', 'deal notes', 'practice', 'status post']) assert.ok(!json.includes(words), words);

  const family = v.groups.find((g) => g.name === 'Family');
  assert.equal(family.messages, 3);
  assert.equal(family.last, '2026-09-05');
  assert.deepEqual(family.exclude, [['--exclude-chat', 'imessage:iMessage;+;chat900']]);
  const unnamed = v.groups.find((g) => g.exclude[0][1] === 'imessage:iMessage;+;chat901');
  assert.equal(unnamed.name, 'Mike Brennan, Ana Lopez', 'an unnamed group is shown by its members');
  assert.ok(v.groups.some((g) => g.name === 'Soccer parents' && g.source === 'whatsapp'));
  assert.ok(!v.groups.some((g) => g.name === 'Status'), 'status and broadcast lists are not chats');
  assert.equal(v.groups[0].name, 'Family', 'most active first');

  const mike = v.people.find((p) => p.handle === 'tel:+13055551234');
  assert.equal(mike.name, 'Mike Brennan');
  assert.deepEqual(mike.sources.sort(), ['imessage', 'whatsapp'], 'one row per person across sources');
  assert.equal(mike.messages, 3);
  assert.deepEqual(mike.exclude, [['--exclude-handle', 'tel:+13055551234'], ['--exclude-person', 'Mike Brennan']]);
});

test('the printed exclude flags really keep that group chat out of extraction', async () => {
  const h = home();
  const ctx = makeCtx({ home: h, config: { exclusions: { chats: ['imessage:iMessage;+;chat900'] } } });
  await runSource(ctx, 'imessage');
  const threads = new Set(ctx.store.records({ source: 'imessage' }).map((r) => r.thread));
  assert.ok(!threads.has('imessage:iMessage;+;chat900'), 'the excluded group is gone');
  assert.ok(threads.has('imessage:iMessage;+;chat901'), 'other chats stay');
});

test('without Full Disk Access, chats says so instead of listing nothing silently', () => {
  resetCaches();
  const ctx = makeCtx({ home: tempHome() }); // no Messages or WhatsApp databases at all
  const v = listChats(ctx);
  assert.equal(v.sources.imessage.ok, false);
  assert.equal(v.sources.whatsapp.ok, false);
  assert.deepEqual(v.groups, []);
  assert.deepEqual(v.people, []);
});
