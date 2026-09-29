import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeCtx, tempHome, insert, runSource, schemaErrors, writeFile, zipBuffer } from './fixtures/a-fixtures.mjs';
import { whatsappDb, whatsappContacts, addWa } from './fixtures/a-apple.mjs';
import * as wa from '../engine/extract/whatsapp.mjs';
import { parseExport, chatNameFromFile } from '../engine/extract/whatsapp-export.mjs';

const ANA = '5215512345678@s.whatsapp.net';
const GROUP = '120363041234567890@g.us';

function nativeFixture() {
  const home = tempHome();
  const { db, base } = whatsappDb(home);
  insert(db, 'ZWACHATSESSION', [
    { Z_PK: 1, ZSESSIONTYPE: 0, ZCONTACTJID: ANA, ZPARTNERNAME: 'Ana López' },
    { Z_PK: 2, ZSESSIONTYPE: 1, ZCONTACTJID: GROUP, ZPARTNERNAME: 'Deal Team' },
    { Z_PK: 3, ZSESSIONTYPE: 3, ZCONTACTJID: 'status@broadcast', ZPARTNERNAME: null },
  ]);
  insert(db, 'ZWAGROUPMEMBER', [
    { Z_PK: 1, ZCHATSESSION: 2, ZMEMBERJID: '13055557777@s.whatsapp.net', ZCONTACTNAME: 'Sara Kim' },
    { Z_PK: 2, ZCHATSESSION: 2, ZMEMBERJID: '88112233445566@lid', ZCONTACTNAME: null },
    { Z_PK: 3, ZCHATSESSION: 2, ZMEMBERJID: '99001122334455@lid', ZCONTACTNAME: null },
  ]);
  insert(db, 'ZWAPROFILEPUSHNAME', { Z_PK: 1, ZJID: '99001122334455@lid', ZPUSHNAME: 'Tomás' });
  whatsappContacts(base, [{ Z_PK: 1, ZFULLNAME: 'Diego Ruiz', ZPHONENUMBER: '+52 81 1111 2222', ZWHATSAPPID: '528111112222@s.whatsapp.net', ZLID: '88112233445566@lid' }]);
  const pk = {};
  pk.hello = addWa(db, { chat: 1, text: 'Hola Rob, ¿revisaste la propuesta?', at: '2024-01-03T14:05:30Z', fromJid: ANA });
  pk.reply = addWa(db, { chat: 1, text: 'Sí, mañana te mando comentarios', at: '2024-01-03T14:08:00Z', fromMe: true, toJid: ANA });
  pk.photo = addWa(db, { chat: 1, type: 1, at: '2024-01-04T10:00:00Z', fromJid: ANA, caption: 'Plano de la oficina' });
  pk.voice = addWa(db, { chat: 1, type: 3, at: '2024-01-04T10:01:00Z', fromJid: ANA, duration: 42 });
  pk.sticker = addWa(db, { chat: 1, type: 15, at: '2024-01-04T10:02:00Z', fromJid: ANA });
  pk.deleted = addWa(db, { chat: 1, type: 14, at: '2024-01-04T10:03:00Z', fromJid: ANA });
  pk.sara = addWa(db, { chat: 2, text: 'Kickoff Monday?', at: '2024-01-05T15:00:00Z', member: 1, fromJid: GROUP, push: 'Sara' });
  pk.diego = addWa(db, { chat: 2, text: 'Yes', at: '2024-01-05T15:01:00Z', member: 2, fromJid: GROUP });
  pk.tomas = addWa(db, { chat: 2, text: 'Count me in', at: '2024-01-05T15:02:00Z', member: 3, fromJid: GROUP });
  pk.event = addWa(db, { chat: 2, type: 6, at: '2024-01-05T15:03:00Z', fromJid: GROUP });
  pk.mine = addWa(db, { chat: 2, text: 'Great, see you all', at: '2024-01-05T15:04:00Z', fromMe: true, toJid: GROUP });
  pk.status = addWa(db, { chat: 3, text: 'status update', at: '2024-01-05T16:00:00Z', fromJid: ANA });
  return { home, db, pk };
}

test('whatsapp native: DMs, groups, captions, lids, and skipped system rows', async () => {
  const { home, pk } = nativeFixture();
  const ctx = makeCtx({ home });
  const totals = await runSource(ctx, 'whatsapp', { limit: 4 });
  assert.equal(totals.invalid, 0);
  const recs = ctx.store.records({ source: 'whatsapp' });
  assert.deepEqual(schemaErrors(recs), []);
  const by = (p) => recs.find((r) => r.id.endsWith(`3EB0${p}`));
  assert.equal(recs.length, 8, 'sticker, deleted, group event and status rows are skipped');
  assert.ok(!by(pk.sticker) && !by(pk.deleted) && !by(pk.event) && !by(pk.status));

  const hello = by(pk.hello);
  assert.deepEqual(hello.from, { handle: 'tel:+5215512345678', name: 'Ana López' });
  assert.equal(hello.thread, `whatsapp:${ANA}`);
  assert.equal(hello.ts, '2024-01-03T14:05:30.000Z');
  assert.equal(hello.meta.chat_name, 'Ana López');
  const reply = by(pk.reply);
  assert.equal(reply.is_from_me, true);
  assert.deepEqual(reply.to, [{ handle: 'tel:+5215512345678', name: 'Ana López' }]);
  assert.equal(by(pk.photo).text, 'Plano de la oficina');
  assert.equal(by(pk.photo).meta.media, 'image');
  assert.equal(by(pk.voice).text, '');
  assert.equal(by(pk.voice).meta.duration_s, 42);

  const sara = by(pk.sara);
  assert.deepEqual(sara.from, { handle: 'tel:+13055557777', name: 'Sara Kim' });
  assert.deepEqual(sara.to, [{ handle: `group:whatsapp:${GROUP}`, name: 'Deal Team' }]);
  assert.equal(sara.meta.is_group, true);
  assert.equal(sara.meta.participants.length, 3);
  assert.deepEqual(by(pk.diego).from, { handle: 'tel:+528111112222', name: 'Diego Ruiz' }, 'lid mapped through ContactsV2');
  assert.deepEqual(by(pk.tomas).from, { handle: 'name:tomás', name: 'Tomás' }, 'unmapped lid uses the push name');
  assert.equal(by(pk.tomas).meta.lid, '99001122334455@lid');
  assert.equal(by(pk.mine).from.name, 'Alex Rivera');
});

test('whatsapp native: resumable and probe', async () => {
  const { home, db } = nativeFixture();
  const ctx = makeCtx({ home });
  await runSource(ctx, 'whatsapp', { limit: 3 });
  assert.equal((await runSource(ctx, 'whatsapp')).inserted, 0);
  addWa(db, { chat: 1, text: 'Nuevo', at: '2024-02-01T10:00:00Z', fromJid: ANA });
  assert.equal((await runSource(ctx, 'whatsapp')).inserted, 1);
  assert.deepEqual(await wa.probe(ctx), { ok: true, count: 13 });
  assert.equal((await wa.probe(makeCtx({ home: tempHome() }))).ok, false);
});

const IOS = [
  '[03/01/2024, 09:05:12] Ana López: ‎Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.',
  '[03/01/2024, 09:05:12] Ana López: Hola Rob, ¿revisaste la propuesta?',
  '[03/01/2024, 09:07:40] Alex Rivera: Sí, te mando comentarios',
  'mañana temprano',
  '[13/01/2024, 18:30:00] Ana López: ‎image omitted',
  '[13/01/2024, 18:31:00] Ana López: Perfecto <This message was edited>',
  '[14/01/2024, 08:00:00] Alex Rivera: ‎This message was deleted.',
  '[14/01/2024, 08:01:00] Ana López: ‎<attached: 00000012-PHOTO-2024-01-14-08-01-00.jpg>',
  '[14/01/2024, 08:02:00] Ana López: ok',
  '[14/01/2024, 08:02:00] Ana López: ok',
].join('\n');

const ANDROID_US = [
  '1/2/24, 9:05 AM - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them. Tap to learn more.',
  '1/2/24, 9:05 AM - Mike created group "Deal Team"',
  '1/2/24, 9:06 AM - Mike: Kickoff Monday?',
  '1/2/24, 12:15 PM - Sara Kim: <Media omitted>',
  '1/15/24, 10:00 PM - +1 305 555 7777: Count me in',
  '1/15/24, 12:01 AM - ~ Lucía: 👍',
].join('\n');

const ANDROID_ES = ['05/02/24, 3:15 p. m. - Carlos: Nos vemos en la oficina', '05/02/24, 3:20 p. m. - Alex Rivera: Listo', '06/02/24, 9:00 a. m. - Carlos: <Multimedia omitido>'].join('\n');

test('export parser: iOS day-first with seconds, system, media, edits and multi-line', () => {
  const { messages, order } = parseExport(IOS, { timeZone: 'America/New_York' });
  assert.equal(order, 'dmy');
  assert.equal(messages.length, 7, 'the encryption notice and the deleted message are dropped');
  assert.equal(messages[0].ts, '2024-01-03T14:05:12.000Z');
  assert.equal(messages[1].text, 'Sí, te mando comentarios\nmañana temprano');
  assert.equal(messages[2].media, 'image');
  assert.equal(messages[3].text, 'Perfecto');
  assert.equal(messages[3].edited, true);
  assert.equal(messages[4].attachment, '00000012-PHOTO-2024-01-14-08-01-00.jpg');
});

test('export parser: Android US month-first 12h and Spanish a. m./p. m.', () => {
  const us = parseExport(ANDROID_US, { timeZone: 'UTC' });
  assert.equal(us.order, 'mdy');
  assert.deepEqual(us.messages.map((m) => [m.ts, m.sender]), [
    ['2024-01-02T09:06:00.000Z', 'Mike'],
    ['2024-01-02T12:15:00.000Z', 'Sara Kim'],
    ['2024-01-15T22:00:00.000Z', '+1 305 555 7777'],
    ['2024-01-15T00:01:00.000Z', 'Lucía'],
  ]);
  assert.equal(us.messages[1].media, 'media');
  const es = parseExport(ANDROID_ES, { timeZone: 'UTC' });
  assert.equal(es.order, 'dmy', 'ambiguous dates: the tighter reading wins');
  assert.deepEqual(es.messages.map((m) => m.ts), ['2024-02-05T15:15:00.000Z', '2024-02-05T15:20:00.000Z', '2024-02-06T09:00:00.000Z']);
  assert.equal(es.messages[2].media, 'media');
});

test('export chat names come from the file name', () => {
  assert.equal(chatNameFromFile('WhatsApp Chat - Ana López.zip'), 'Ana López');
  assert.equal(chatNameFromFile('WhatsApp Chat with Deal Team (1).txt'), 'Deal Team');
  assert.equal(chatNameFromFile('Chat de WhatsApp con Carlos.txt'), 'Carlos');
});

test('whatsapp exports: zip and txt, owner, groups, stable ids, native dedupe', async () => {
  const { home } = nativeFixture();
  const ctx = makeCtx({ home });
  const dir = join(ctx.paths.exports, 'whatsapp');
  writeFile(join(dir, 'WhatsApp Chat - Ana López.zip'), zipBuffer({ '_chat.txt': IOS, '00000012-PHOTO-2024-01-14-08-01-00.jpg': 'jpeg bytes' }));
  writeFile(join(dir, 'WhatsApp Chat with Deal Team.txt'), ANDROID_US);
  writeFile(join(dir, 'Chat de WhatsApp con Carlos.txt'), ANDROID_ES);
  writeFile(join(dir, 'notes.pdf'), 'ignored');
  await runSource(ctx, 'whatsapp');
  const totals = await runSource(ctx, 'whatsapp_export', { limit: 3 });
  assert.equal(totals.invalid, 0);
  const recs = ctx.store.records({ source: 'whatsapp_export' });
  assert.deepEqual(schemaErrors(recs), []);
  assert.equal(recs.length, 6 + 4 + 3, 'one Ana message is already in the Mac app and is skipped');

  const ana = recs.filter((r) => r.meta.chat_name === 'Ana López');
  assert.ok(ana.every((r) => r.thread === `whatsapp:${ANA}`), 'joins the native thread');
  assert.ok(!ana.some((r) => r.text === 'Hola Rob, ¿revisaste la propuesta?'));
  const mine = ana.find((r) => r.is_from_me);
  assert.equal(mine.from.name, 'Alex Rivera');
  assert.deepEqual(mine.to, [{ handle: 'tel:+5215512345678', name: 'Ana López' }], 'the real phone from the Mac app');
  assert.ok(ana.filter((r) => !r.is_from_me).every((r) => r.from.handle === 'tel:+5215512345678'));
  assert.equal(ana.filter((r) => r.text === 'ok').length, 2, 'identical lines keep separate ids');

  const team = recs.filter((r) => r.meta.chat_name === 'Deal Team');
  assert.ok(team.every((r) => r.meta.is_group && r.thread === `whatsapp:${GROUP}` && r.to[0].handle === `group:whatsapp:${GROUP}`), 'same-named native group');
  assert.deepEqual(team.find((r) => r.text === 'Count me in').from, { handle: 'tel:+13055557777', name: null });
  const carlos = recs.filter((r) => r.meta.chat_name === 'Carlos');
  assert.equal(carlos.find((r) => r.text === 'Listo').is_from_me, true);
  assert.ok(!carlos[0].meta.is_group);

  assert.equal((await runSource(ctx, 'whatsapp_export')).inserted, 0, 'nothing new on a second run');
  writeFile(join(dir, 'Chat de WhatsApp con Carlos.txt'), `${ANDROID_ES}\n07/02/24, 10:00 a. m. - Carlos: ¿Firmamos?`);
  const again = await runSource(ctx, 'whatsapp_export');
  assert.equal(again.inserted, 1, 'a re-export only adds the new line');
});

test('whatsapp exports: probe', async () => {
  const ctx = makeCtx({ home: tempHome() });
  const { probe } = await import('../engine/extract/whatsapp-export.mjs');
  assert.equal((await probe(ctx)).ok, false);
  writeFile(join(ctx.paths.exports, 'whatsapp', 'WhatsApp Chat with X.txt'), '1/2/24, 9:06 AM - X: hi');
  assert.deepEqual(await probe(ctx), { ok: true, count: 1 });
});
