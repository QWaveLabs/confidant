// A thread is excluded whole. An excluded person in an email thread or a
// group chat under 8 people takes the whole thread with them, the owner's
// replies included; in a group of 8 or more only their messages and the ones
// that name them go. Applied at extract time (runner and ingest) and by the
// brain.db purge. All data is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { threadGate, purgeExcluded, filterRecord } from '../engine/privacy.mjs';
import { openMemoryStore } from '../engine/lib/store.mjs';
import { run as ingestRun } from '../engine/ingest.mjs';
import { makeCtx, tempHome, insert, writeFile, runSource } from './fixtures/a-fixtures.mjs';
import { chatDb, addMessage } from './fixtures/a-apple.mjs';
import { makeVault } from './fixtures/b-fixture.mjs';

const OWNER = { name: 'Alex Rivera', emails: ['alex@rivera.test'], phones: ['+1 305 555 0100'] };
const ME = { handle: 'mailto:alex@rivera.test', name: 'Alex Rivera' };
const CARLA = { handle: 'mailto:carla@diaz.test', name: 'Carla Diaz' };
const person = (n) => ({ handle: `mailto:p${n}@team.test`, name: `Person ${n}` });
let n = 0;
const email = (thread, from, to, text = 'Update', extra = {}) => ({
  id: `email:t${++n}`, source: 'email', kind: 'email', thread, ts: new Date(Date.UTC(2026, 8, 1, 10, n)).toISOString(),
  from, to, is_from_me: from === ME, title: 'Deal', text, url: null, meta: {}, ...extra,
});
const gateCtx = (exclusions) => ({ store: openMemoryStore(), config: { owner: OWNER, exclusions }, dryRun: false });

test('email: an excluded person in a small thread takes the owner\'s replies with them', () => {
  const ctx = gateCtx({ people: ['Carla Diaz'] });
  const first = email('email:c1', CARLA, [ME, person(1), person(2)], 'Here are the terms');
  const reply = email('email:c1', ME, [person(1), person(2)], 'Thanks, will review');
  const later = email('email:c1', person(1), [ME, person(2)], 'Agreed on my side');
  const other = email('email:c2', person(1), [ME], 'Unrelated');
  // The owner's reply arrives first (newest first), before Carla's email.
  const gate = threadGate(ctx);
  ctx.store.upsertRecords(gate.filter([reply]).keep);
  assert.equal(ctx.store.records({}).length, 1, 'not yet known to be excluded');
  const { keep, excluded } = gate.filter([first, later, other]);
  ctx.store.upsertRecords(keep);
  assert.deepEqual(ctx.store.records({}).map((r) => r.thread), ['email:c2'], 'the earlier-stored reply was removed too');
  assert.equal(excluded, 2);
  assert.equal(gate.removed, 1);
  assert.equal(threadGate(ctx).filter([email('email:c1', person(2), [ME], 'one more')]).keep.length, 0, 'remembered across runs');
});

test('email: in a thread of 8 or more only their emails and the ones that name them go', () => {
  const ctx = gateCtx({ people: ['Carla Diaz'] });
  const everyone = [ME, CARLA, ...[1, 2, 3, 4, 5, 6].map(person)];
  const hers = email('email:all', CARLA, everyone.filter((p) => p !== CARLA), 'My numbers');
  const plain = email('email:all', person(1), everyone.filter((p) => p !== person(1)), 'Agenda attached');
  const naming = email('email:all', person(2), everyone, 'As Carla Diaz said, the numbers look off');
  const { keep } = threadGate(ctx).filter([hers, plain, naming]);
  assert.deepEqual(keep.map((r) => r.text), ['Agenda attached']);
  assert.equal(filterRecord(plain, ctx.config).keep, true);
});

test('group chats: under 8 members an excluded member takes the whole chat, even silent', () => {
  const config = { owner: OWNER, exclusions: { handles: ['+1 555 000 1111'] } };
  const group = (from, participants, text) => ({ id: `imessage:g${++n}`, source: 'imessage', kind: 'message', thread: 'imessage:g', ts: '2026-09-01T10:00:00Z', from, to: [{ handle: 'group:imessage:g', name: 'Weekend' }], is_from_me: from === ME, title: 'Weekend', text, url: null, meta: { is_group: true, chat_name: 'Weekend', participants } });
  const small = ['tel:+15550001111', 'tel:+15550002222', 'tel:+15550003333'];
  assert.deepEqual(filterRecord(group(ME, small, 'Dinner at 8?'), config), { keep: false, reason: 'handle', scope: 'thread' });
  const big = [...small, ...[4, 5, 6, 7, 8, 9].map((i) => `tel:+1555000${i}${i}${i}${i}`)];
  assert.equal(filterRecord(group(ME, big, 'Dinner at 8?'), config).keep, true);
  assert.deepEqual(filterRecord(group({ handle: 'tel:+15550001111', name: null }, big, 'I am in'), config), { keep: false, reason: 'handle', scope: 'record' });
  assert.equal(filterRecord(group({ handle: 'tel:+15550002222', name: null }, big, 'Call 555-000-1111 for the table'), config).keep, false, 'naming her number');
});

test('iMessage: the owner\'s reply to a bank short code goes with the alert, in any order', async () => {
  const home = tempHome();
  const db = chatDb(home);
  insert(db, 'handle', [{ ROWID: 1, id: '24273', service: 'SMS' }, { ROWID: 2, id: '+13055551234', service: 'iMessage' }]);
  insert(db, 'chat', [{ ROWID: 1, guid: 'SMS;-;24273', style: 45, chat_identifier: '24273' }, { ROWID: 2, guid: 'iMessage;-;+13055551234', style: 45, chat_identifier: '+13055551234' }]);
  addMessage(db, { chat: 1, handle: 1, text: 'Chase: Did you make a $912.00 debit card purchase on your account ending in 4321? Reply YES or NO', at: '2026-09-01T10:00:00Z', service: 'SMS' });
  addMessage(db, { chat: 1, handle: 1, text: 'YES', at: '2026-09-01T10:01:00Z', fromMe: true, service: 'SMS' });
  addMessage(db, { chat: 2, handle: 2, text: 'Lunch Friday?', at: '2026-09-01T11:00:00Z' });
  const ctx = makeCtx({ home, config: { owner: OWNER, exclusions: { categories: ['banking'] } } });
  const t = await runSource(ctx, 'imessage', { limit: 1 });
  assert.deepEqual(ctx.store.records({}).map((r) => r.text), ['Lunch Friday?']);
  assert.equal(t.excluded + (t.removed ?? 0), 2);
});

test('ingest: a Gmail thread with an excluded person and a Slack DM go whole; big channels keep the rest', async () => {
  const ctx = makeVault({ owner: OWNER, exclusions: { people: ['Carla Diaz'], chats: ['legal'] } });
  const dir = mkdtempSync(join(tmpdir(), 'cf-threads-'));
  const gmail = join(dir, 'gmail.json');
  writeFileSync(gmail, JSON.stringify([
    { id: 'g2', threadId: 't1', subject: 'Re: Terms', from: 'Alex Rivera <alex@rivera.test>', to: 'p1@team.test', body: 'Thanks', internalDate: '1790000100000' },
    { id: 'g1', threadId: 't1', subject: 'Terms', from: 'Carla Diaz <carla@diaz.test>', to: 'alex@rivera.test, p1@team.test', body: 'Here', internalDate: '1790000000000' },
    { id: 'g3', threadId: 't2', subject: 'Other', from: 'p2@team.test', to: 'alex@rivera.test', body: 'Hi', internalDate: '1790000200000' },
  ]));
  await ingestRun({ source: 'gmail', file: gmail, account: 'alex@rivera.test' }, ctx);
  assert.deepEqual(ctx.store.records({ source: 'gmail' }).map((r) => r.id), ['gmail:g3']);
  const slack = join(dir, 'slack.json');
  writeFileSync(slack, JSON.stringify([
    { channel: 'D1', ts: '1790000000', user: 'UME', username: 'Alex Rivera', text: 'See you then' },
    { channel: 'D1', ts: '1790000100', user: 'UC', username: 'Carla Diaz', text: 'Private note' },
    { channel: { id: 'C1', name: 'general' }, ts: '1790000200', user: 'UC', username: 'Carla Diaz', text: 'Hello all' },
    { channel: { id: 'C1', name: 'general' }, ts: '1790000300', user: 'U2', username: 'Person Two', text: 'Standup at 10' },
    { channel: { id: 'C2', name: 'legal' }, ts: '1790000400', user: 'U2', username: 'Person Two', text: 'Contract review' },
  ]));
  await ingestRun({ source: 'slack', file: slack }, ctx);
  assert.deepEqual(ctx.store.records({ source: 'slack' }).map((r) => r.text), ['Standup at 10']);
});

test('WhatsApp exports: a small group export goes whole, a big one keeps the rest', async () => {
  const ctx = makeCtx({ home: tempHome(), config: { owner: OWNER, exclusions: { people: ['Carla Diaz'] } } });
  const dir = join(ctx.paths.exports, 'whatsapp');
  writeFile(join(dir, 'WhatsApp Chat - Weekend.txt'), ['1/2/24, 9:06 AM - Carla Diaz: my news', '1/2/24, 9:07 AM - Alex Rivera: congrats', '1/2/24, 9:08 AM - Person One: yay'].join('\n'));
  const big = ['1/3/24, 9:00 AM - Carla Diaz: hello', '1/3/24, 9:01 AM - Person One: standup moved', '1/3/24, 9:02 AM - Person Two: Carla Diaz is out today'];
  for (let i = 3; i <= 8; i++) big.push(`1/3/24, 9:1${i} AM - Person ${i}: ok`);
  writeFile(join(dir, 'WhatsApp Chat - Company.txt'), big.join('\n'));
  await runSource(ctx, 'whatsapp_export');
  const kept = ctx.store.records({}).map((r) => `${r.meta.chat_name}: ${r.text}`);
  assert.ok(!kept.some((k) => k.startsWith('Weekend')), 'the small group is gone, the owner\'s congrats included');
  assert.ok(kept.includes('Company: standup moved'));
  assert.ok(!kept.some((k) => /Carla/.test(k) || k === 'Company: hello'));
});

test('purge: an exclusion added later removes whole threads and trims big groups', () => {
  const ctx = gateCtx(undefined);
  const everyone = [ME, CARLA, ...[1, 2, 3, 4, 5, 6].map(person)];
  ctx.store.upsertRecords([
    email('email:small', ME, [person(1)], 'Following up'),
    email('email:small', CARLA, [ME, person(1)], 'Numbers'),
    email('email:big', person(1), everyone.filter((p) => p !== person(1)), 'Agenda'),
    email('email:big', CARLA, everyone.filter((p) => p !== CARLA), 'Mine'),
  ]);
  ctx.config.exclusions = { people: ['Carla'] };
  const r = purgeExcluded(ctx);
  assert.equal(r.removed, 3);
  assert.deepEqual(ctx.store.records({}).map((x) => x.text), ['Agenda']);
  assert.equal(threadGate(ctx).filter([email('email:small', person(1), [ME], 'Late reply')]).keep.length, 0, 'the purged thread stays excluded');
});
