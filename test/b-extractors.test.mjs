// End to end on Unit A's real extractors: fake Apple databases in a temp
// home, the extract runner, then identity, dossiers and a planned batch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSource } from '../engine/extract/index.mjs';
import { getSource } from '../engine/lib/sources.mjs';
import { buildIdentity } from '../engine/identity.mjs';
import { buildDossiers } from '../engine/dossiers.mjs';
import { planBatches } from '../engine/batch.mjs';
import { check } from '../engine/lib/schema.mjs';
import { readJson } from '../engine/lib/files.mjs';
import { tempHome, insert, resetCaches } from './fixtures/a-fixtures.mjs';
import { chatDb, addMessage, addressBook } from './fixtures/a-apple.mjs';
import { makeVault } from './fixtures/b-fixture.mjs';

function appleHome() {
  const home = tempHome();
  const db = chatDb(home);
  insert(db, 'handle', [
    { ROWID: 1, id: '+15550102000', service: 'iMessage' },
    { ROWID: 2, id: 'ben@acme.example', service: 'iMessage' },
    { ROWID: 3, id: '24273', service: 'SMS' },
    { ROWID: 4, id: '+15550104000', service: 'SMS' },
  ]);
  insert(db, 'chat', [
    { ROWID: 1, guid: 'iMessage;-;+15550102000', style: 45, chat_identifier: '+15550102000', service_name: 'iMessage' },
    { ROWID: 2, guid: 'iMessage;+;chat900', style: 43, chat_identifier: 'chat900', service_name: 'iMessage', display_name: 'Acme deal room' },
    { ROWID: 3, guid: 'SMS;-;24273', style: 45, chat_identifier: '24273', service_name: 'SMS' },
  ]);
  insert(db, 'chat_handle_join', [{ chat_id: 1, handle_id: 1 }, { chat_id: 2, handle_id: 1 }, { chat_id: 2, handle_id: 2 }, { chat_id: 2, handle_id: 4 }, { chat_id: 3, handle_id: 3 }]);
  addressBook(home, 'SRC-1', [
    { pk: 1, first: 'Ana', last: 'Ruiz', phones: ['(555) 010-2000'], emails: ['ana@acme.example'] },
    { pk: 2, first: 'Ben', last: 'Cole', emails: ['Ben@Acme.example'] },
  ]);
  addMessage(db, { chat: 1, handle: 1, text: 'Can you send the revised proposal by Friday?', at: '2026-09-22T14:00:00Z' });
  addMessage(db, { chat: 1, handle: 1, text: 'Yes, I will send it Thursday.', at: '2026-09-22T14:05:00Z', fromMe: true });
  addMessage(db, { chat: 1, handle: 1, text: 'Loved "Yes, I will send it Thursday."', at: '2026-09-22T14:06:00Z', assoc: 2000 });
  addMessage(db, { chat: 2, handle: 2, text: 'Board meets Friday to approve the pilot.', at: '2026-09-23T10:00:00Z' });
  addMessage(db, { chat: 2, handle: 0, text: 'Works for me, I will bring the numbers.', at: '2026-09-23T10:05:00Z', fromMe: true });
  addMessage(db, { chat: 3, handle: 3, text: 'Your code is 482913', at: '2026-09-24T09:00:00Z', service: 'SMS' });
  return home;
}

test('Unit A extractors feed identity, dossiers and batches', async () => {
  const ctx = makeVault();
  ctx.home = appleHome();
  resetCaches();
  for (const id of ['contacts', 'imessage']) {
    const r = await extractSource(ctx, getSource(id), { limit: 50 });
    assert.ok(r.ok && r.inserted > 0, `${id}: ${JSON.stringify(r)}`);
  }
  resetCaches();
  const identity = buildIdentity(ctx);
  const ana = identity.byHandle('mailto:ana@acme.example');
  assert.equal(ana?.name, 'Ana Ruiz');
  assert.equal(identity.byHandle('tel:+15550102000'), ana, 'the card joins her phone and email');
  assert.equal(identity.byHandle('mailto:ben@acme.example').name, 'Ben Cole');
  const group = identity.groupByThread('imessage:iMessage;+;chat900');
  assert.equal(group?.name, 'Acme deal room');
  assert.equal(group.members.length, 3);
  assert.notEqual(identity.byHandle('tel:24273')?.kind, 'person');

  const d = await buildDossiers(ctx, { since: '2026-08-01T00:00:00Z' });
  const anaDossier = d.people.find((p) => p.id === ana.id);
  assert.deepEqual(anaDossier.items.map((i) => i.dir), ['in', 'out'], 'the reaction is left out');
  assert.equal(d.threads[0].thread.name, 'Acme deal room');
  assert.ok(!d.people.some((p) => p.person.name.includes('24273')));

  const batches = await planBatches(ctx, { scope: 'install', count: 5 });
  for (const b of batches) assert.deepEqual(check('batch', readJson(b.path)), []);
  assert.deepEqual(batches.map((b) => b.kind).sort(), ['people', 'threads']);
});
