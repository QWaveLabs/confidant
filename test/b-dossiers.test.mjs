import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildIdentity } from '../engine/identity.mjs';
import { buildDossiers, LIMITS } from '../engine/dossiers.mjs';
import { makeVault, msg, email, meeting, event, NOW } from './fixtures/b-fixture.mjs';
import { goldenRecords, updateRecords } from './fixtures/b-golden-data.mjs';

const days = (n, h = 15) => new Date(NOW.getTime() - n * 86400000 + (h - 16) * 3600000);

async function golden() {
  const ctx = makeVault();
  ctx.store.upsertRecords(goldenRecords(), '2026-09-28T15:00:00.000Z');
  buildIdentity(ctx);
  return { ctx, d: await buildDossiers(ctx) };
}

test('records route to person, thread and meeting dossiers', async () => {
  const { ctx, d } = await golden();
  const names = d.people.map((p) => p.person.name).sort();
  assert.deepEqual(names, ['Ana Ruiz', 'Ben Cole', 'Carla Diaz'], 'automated senders get no dossier');
  const ana = d.people.find((p) => p.person.name === 'Ana Ruiz');
  const refs = ana.items.map((i) => i.ref);
  assert.deepEqual(refs, ['email:e1', 'imessage:a1', 'imessage:a2'], 'thanks and reactions are left out, reading order kept');
  assert.equal(ana.items.find((i) => i.ref === 'email:e1').text, 'Attached is the pilot data from the first two weeks. Usage is up 40 percent.', 'quoted reply removed');
  assert.equal(ana.items.find((i) => i.ref === 'imessage:a2').dir, 'out');
  assert.equal(ana.person.company, 'Acme');
  assert.equal(ana.person.email_domain, 'acme.com');

  const group = d.threads.find((t) => t.thread.kind === 'group');
  assert.deepEqual(group.items.map((i) => i.from), ['Ana Ruiz', 'Ben Cole', 'Sam Rivera']);
  assert.deepEqual(group.thread.participants.map((p) => p.name).sort(), ['Ana Ruiz', 'Ben Cole']);
  const notes = d.threads.find((t) => t.thread.kind === 'notes');
  assert.equal(notes.items[0].ref, 'wispr:d1');

  assert.equal(d.meetings.length, 1);
  const m = d.meetings[0];
  assert.equal(m.meeting.ref, 'fathom:m1');
  assert.deepEqual(m.meeting.attendees.map((a) => a.name).sort(), ['Ana Ruiz', 'Ben Cole'], 'the owner is not an attendee');
  assert.ok(m.chunks[0].text.startsWith('Ana Ruiz: The pilot numbers look strong.'));
  assert.ok(m.meeting.summary.includes('extend the pilot'));

  const root = join(ctx.paths.root, 'dossiers');
  assert.ok(existsSync(join(root, 'people', `${ana.id}.json`)));
  assert.equal(readdirSync(join(root, 'meetings')).length, 1);
  assert.ok(existsSync(join(root, 'index.json')));
});

test('short answers survive only when they answer a request', async () => {
  const ctx = makeVault();
  const X = 'tel:+15554440000';
  ctx.store.upsertRecords([
    msg('1', { thread: 'imessage:x', ts: days(3), from: X, fromName: 'Xavi Mora', text: 'Can you intro me to your designer?' }),
    msg('2', { thread: 'imessage:x', ts: days(3, 16), me: true, to: [X], text: 'ok' }),
    msg('3', { thread: 'imessage:x', ts: days(2), from: X, text: 'Here is the brief for the logo.' }),
    msg('4', { thread: 'imessage:x', ts: days(2, 16), me: true, to: [X], text: 'ok' }),
  ]);
  buildIdentity(ctx);
  const d = await buildDossiers(ctx);
  assert.deepEqual(d.people[0].items.map((i) => i.ref), ['imessage:1', 'imessage:2', 'imessage:3']);
  assert.equal(d.stats.trivia, 1);
});

test('events, calls, multi-person email and meeting substance', async () => {
  const ctx = makeVault();
  const A = 'mailto:ana@acme.com';
  const B = 'mailto:ben@acme.com';
  ctx.store.upsertRecords([
    email('1', { ts: days(5), from: A, fromName: 'Ana Ruiz', to: ['mailto:sam@rivera.co'], text: 'hello there, a real note' }),
    email('2', { ts: days(5), from: B, fromName: 'Ben Cole', to: ['mailto:sam@rivera.co'], text: 'another real note' }),
    email('t1', { thread: 'email:budget', ts: days(4), from: A, fromName: 'Ana Ruiz', to: ['mailto:sam@rivera.co', B], subject: 'Re: Budget', text: 'Budget is approved for Q4.' }),
    event('ev1', { ts: days(3), title: 'Acme roadmap review', attendees: [A] }),
    event('ev2', { ts: days(3), title: 'Busy', attendees: [A] }),
    { id: 'calls:1', source: 'calls', kind: 'call', thread: null, ts: days(2).toISOString(), from: { handle: A, name: null }, to: [], is_from_me: false, title: 'Incoming call', text: '', url: null, meta: { duration_s: 420 } },
    { id: 'calls:2', source: 'calls', kind: 'call', thread: null, ts: days(2).toISOString(), from: { handle: A, name: null }, to: [], is_from_me: false, title: 'Missed call', text: '', url: null, meta: { duration_s: 0 } },
    meeting('empty', { ts: days(1), title: 'Zoom meeting', attendees: [A], transcript: 'Ana Ruiz: hi', duration_s: 60 }),
  ]);
  buildIdentity(ctx);
  const d = await buildDossiers(ctx);
  const ana = d.people.find((p) => p.person.name === 'Ana Ruiz');
  const byRef = Object.fromEntries(ana.items.map((i) => [i.ref, i]));
  assert.equal(byRef['calendar:ev1'].type, 'event');
  assert.ok(!byRef['calendar:ev2'], 'calendar noise left out');
  assert.equal(byRef['calls:1'].text, 'Incoming call (7 min)');
  assert.ok(!byRef['calls:2'], 'missed calls left out');
  const thread = d.threads.find((t) => t.thread.kind === 'email');
  assert.equal(thread.thread.name, 'Budget');
  assert.equal(thread.items[0].subject, 'Budget');
  assert.equal(d.meetings.length, 0, 'a one line generic call has no substance');
});

test('long histories keep the newest lines within the budget', async () => {
  const ctx = makeVault();
  const X = 'tel:+15554440001';
  const recs = [];
  for (let i = 0; i < 200; i++) recs.push(msg(`m${i}`, { thread: 'imessage:long', ts: new Date(NOW.getTime() - (200 - i) * 3600000), from: X, fromName: 'Lena Park', text: `Update number ${i} about the warehouse move and the new lease terms.` }));
  ctx.store.upsertRecords(recs);
  buildIdentity(ctx);
  const d = await buildDossiers(ctx);
  const p = d.people[0];
  assert.ok(p.omitted > 0);
  assert.equal(p.items[p.items.length - 1].ref, 'imessage:m199', 'newest kept');
  assert.ok(JSON.stringify(p.items).length <= LIMITS.person[p.person.tier] + 400);
});

test('changed since: only new records, with earlier lines as context', async () => {
  const ctx = makeVault();
  ctx.store.upsertRecords(goldenRecords(), '2026-09-28T15:00:00.000Z');
  ctx.store.upsertRecords(updateRecords(), '2026-09-28T17:00:00.000Z');
  buildIdentity(ctx);
  const d = await buildDossiers(ctx, { changedSince: '2026-09-28T16:00:00.000Z', frontier: '2026-07-30T00:00:00.000Z' });
  assert.equal(d.people.length, 1);
  const items = d.people[0].items;
  assert.equal(items[items.length - 1].ref, 'imessage:a5');
  assert.ok(!items[items.length - 1].context);
  assert.ok(items.slice(0, -1).every((i) => i.context), 'the rest is context');
  assert.equal(d.meetings.length, 0);
});
