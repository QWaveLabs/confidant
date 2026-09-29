import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIdentity, loadIdentity, recordFixes, canonHandle } from '../engine/identity.mjs';
import { makeVault, msg, email, meeting, contact, NOW } from './fixtures/b-fixture.mjs';

const days = (n) => new Date(NOW.getTime() - n * 86400000);
const ANA_TEL = 'tel:+15550102000';

function seed(ctx) {
  const r = [
    contact('1', { names: ['Ana Ruiz'], phones: ['(555) 010-2000'], emails: ['ana@acme.com'], company: 'Acme', title: 'VP Operations' }),
    contact('me', { names: ['Sam Rivera'], phones: ['+1 305 555 0100'], emails: ['sam@rivera.co', 'sam.home@gmail.com'], me: true }),
    msg('1', { thread: 'imessage:ana', ts: days(2), from: ANA_TEL, fromName: 'Ana', text: 'Can you send the revised proposal by Friday?' }),
    msg('2', { thread: 'imessage:ana', ts: days(2), me: true, to: [ANA_TEL], text: 'Yes, will send Thursday.' }),
    msg('3', { thread: 'imessage:ana', ts: days(1), me: true, text: 'Sent it over.' }),
    email('1', { ts: days(5), from: 'mailto:ANA@Acme.com', fromName: 'Ana Ruiz', to: ['mailto:sam@rivera.co'], subject: 'Pilot', text: 'Pilot data attached.' }),
    email('2', { ts: days(4), me: true, from: 'mailto:sam@rivera.co', fromName: 'Sam Rivera', to: ['mailto:ana@acme.com', 'mailto:ben@acme.com'], subject: 'Re: Pilot', text: 'Thanks, reviewing.' }),
    email('3', { ts: days(3), from: 'mailto:ben@acme.com', fromName: 'Ben Cole', to: ['mailto:sam@rivera.co'], subject: 'Contract', text: 'Draft contract.' }),
    // WhatsApp number written without the country code joins by last 10 digits.
    msg('w1', { source: 'whatsapp', thread: 'whatsapp:ana', ts: days(10), from: 'tel:+525550102000', fromName: 'Ana R', text: 'Hola Sam' }),
    // A group chat with three other people.
    msg('g1', { thread: 'imessage:team', ts: days(6), from: ANA_TEL, to: ['mailto:ben@acme.com', 'tel:+15557770000'], text: 'Kickoff Monday?' }),
    msg('g2', { thread: 'imessage:team', ts: days(6), from: 'mailto:ben@acme.com', to: [ANA_TEL, 'tel:+15557770000'], text: 'Works for me' }),
    msg('g3', { thread: 'imessage:team', ts: days(6), from: 'tel:+15557770000', fromName: 'Carla Diaz', to: [ANA_TEL], text: 'Same' }),
    // Automated senders.
    msg('s1', { thread: 'imessage:22395', ts: days(1), from: 'tel:22395', text: 'Your verification code is 123456' }),
    ...Array.from({ length: 12 }, (_, i) => email(`n${i}`, { ts: days(i + 1), from: 'mailto:news@shop.example', fromName: 'Shop', to: ['mailto:sam@rivera.co'], subject: `Deals ${i}`, text: 'Sale', meta: { list_unsubscribe: '<mailto:u@shop.example>' } })),
    email('nr', { ts: days(2), from: 'mailto:no-reply@stripe.com', to: ['mailto:sam@rivera.co'], subject: 'Receipt', text: 'Paid' }),
    // Meeting speaker known only by name, and a single-word name.
    meeting('m1', { ts: days(7), title: 'Pilot review', attendees: [{ handle: 'mailto:ana@acme.com', name: 'Ana Ruiz' }, { handle: null, name: 'Ben Cole' }, { handle: null, name: 'Sam' }], transcript: 'Ana Ruiz: data looks good\nBen Cole: contract next' }),
    msg('mk', { source: 'whatsapp', thread: 'whatsapp:mike', ts: days(3), from: 'tel:+15559990000', fromName: 'Mike', text: 'Are we still on for lunch?' }),
    msg('mk2', { source: 'whatsapp', thread: 'whatsapp:mike', ts: days(3), me: true, to: ['tel:+15559990000'], text: 'Yes' }),
    msg('mb', { thread: 'imessage:mikeb', ts: days(20), from: 'tel:+15558880000', fromName: 'Mike Brennan', text: 'Deck looks great' }),
    msg('mb2', { thread: 'imessage:mikeb', ts: days(20), me: true, to: ['tel:+15558880000'], text: 'Thanks Mike' }),
  ];
  ctx.store.upsertRecords(r);
}

test('identity merges handles across channels and finds the owner', () => {
  const ctx = makeVault();
  seed(ctx);
  const id = buildIdentity(ctx);
  assert.equal(id.owner.name, 'Sam Rivera');
  assert.ok(id.owner.handles.includes('mailto:sam@rivera.co'));
  assert.ok(id.owner.handles.includes('mailto:sam.home@gmail.com'), 'me card merges into the owner');
  assert.ok(id.owner.handles.includes('name:sam'), 'owner first name as a speaker is the owner');

  const ana = id.byHandle('mailto:ana@acme.com');
  assert.equal(ana.name, 'Ana Ruiz');
  assert.equal(ana.name_source, 'contacts');
  assert.equal(ana.company, 'Acme');
  assert.equal(id.byHandle('tel:+525550102000'), ana, 'last 10 digits join WhatsApp');
  assert.equal(id.byHandle('tel:(555) 010-2000'), ana);
  assert.equal(id.byHandle('mailto:ANA@ACME.COM'), ana, 'emails compare lowercased');
  assert.ok(ana.two_way);
  assert.equal(ana.company_hint, 'acme.com');
  assert.ok(ana.sources.includes('whatsapp') && ana.sources.includes('email') && ana.sources.includes('fathom'));

  const ben = id.byHandle('mailto:ben@acme.com');
  assert.equal(ben.name, 'Ben Cole');
  assert.ok(ben.handles.includes('name:ben cole'), 'speaker name joins the one Ben Cole');

  assert.equal(id.byHandle('tel:22395').kind, 'system');
  assert.equal(id.byHandle('mailto:news@shop.example').kind, 'system');
  assert.equal(id.byHandle('mailto:no-reply@stripe.com').kind, 'system');
  assert.equal(id.byHandle('tel:+15557770000').name, 'Carla Diaz');

  const group = id.groupByThread('imessage:team');
  assert.ok(group, 'three senders make a group');
  assert.equal(group.members.length, 3);
  assert.equal(id.groupByThread('imessage:ana'), null);

  const persisted = JSON.parse(readFileSync(join(ctx.paths.root, 'identity.json'), 'utf8'));
  assert.equal(persisted.people.length, id.people.length);
  assert.equal(typeof persisted.byHandle, 'undefined');
  for (const p of persisted.people) {
    for (const k of ['id', 'name', 'kind', 'handles', 'sources', 'first_seen', 'last_seen', 'messages', 'two_way', 'strength', 'tier']) assert.ok(k in p, `${k} on person`);
    assert.ok(['inner', 'active', 'network', 'cold'].includes(p.tier));
  }
});

test('ids are stable across rebuilds and fixes survive them', () => {
  const ctx = makeVault();
  seed(ctx);
  const first = buildIdentity(ctx);
  const again = buildIdentity(ctx);
  assert.deepEqual(first.people.map((p) => p.id).sort(), again.people.map((p) => p.id).sort());

  const mike = again.byHandle('tel:+15559990000');
  const mikeB = again.byHandle('tel:+15558880000');
  assert.equal(mike.name, 'Mike');
  const amb = again.ambiguous.find((a) => a.reason === 'single_name' && a.person_ids[0] === mike.id);
  assert.ok(amb, 'single-word name is flagged for review');
  assert.ok(amb.person_ids.includes(mikeB.id), 'with the Mike it could be');

  const { identity: fixed, applied } = recordFixes(ctx, again, [{ action: 'merge', person_ids: [mikeB.id, mike.id] }], { batchId: 'b1' });
  assert.equal(applied, 1);
  assert.equal(fixed.byHandle('tel:+15559990000').id, mikeB.id);
  assert.ok(fixed.byId(mike.id), 'old id still resolves');

  // A rebuild from scratch (new handles arriving) keeps the confirmed merge.
  ctx.store.upsertRecords([msg('mk3', { source: 'whatsapp', thread: 'whatsapp:mike', ts: days(1), from: 'tel:+15559990000', text: 'Running late' })]);
  const rebuilt = buildIdentity(ctx);
  assert.equal(rebuilt.byHandle('tel:+15559990000').id, mikeB.id);
  assert.equal(rebuilt.byHandle('tel:+15558880000').id, mikeB.id);
  assert.equal(rebuilt.byId(mike.id)?.id, mikeB.id);

  recordFixes(ctx, rebuilt, [{ action: 'rename', person_ids: [mikeB.id], name: 'Michael Brennan' }, { action: 'not_a_person', person_ids: [rebuilt.byHandle('tel:+15557770000').id] }]);
  const renamed = buildIdentity(ctx);
  assert.equal(renamed.byId(mikeB.id).name, 'Michael Brennan');
  assert.ok(renamed.byId(mikeB.id).aliases.includes('Mike Brennan'));
  assert.equal(renamed.byHandle('tel:+15557770000').kind, 'system');
});

test('strength and tiers follow recency, frequency and two-way contact', () => {
  const ctx = makeVault();
  const recs = [];
  for (let d = 0; d < 60; d += 2) {
    recs.push(msg(`a${d}`, { thread: 'imessage:close', ts: days(d), from: 'tel:+15551110000', fromName: 'Close Friend', text: `note ${d}` }));
    recs.push(msg(`b${d}`, { thread: 'imessage:close', ts: days(d), me: true, to: ['tel:+15551110000'], text: `reply ${d}` }));
  }
  recs.push(msg('old', { thread: 'imessage:old', ts: days(400), from: 'tel:+15552220000', fromName: 'Old Contact', text: 'hello from long ago' }));
  ctx.store.upsertRecords(recs);
  const id = buildIdentity(ctx);
  const close = id.byHandle('tel:+15551110000');
  const old = id.byHandle('tel:+15552220000');
  assert.equal(close.tier, 'inner');
  assert.equal(old.tier, 'cold');
  assert.ok(close.strength > old.strength);
});

test('shared handles on many cards never join people, and owner handles never leak', () => {
  const ctx = makeVault();
  ctx.store.upsertRecords([
    contact('a', { names: ['Alex One'], phones: ['+1 555 300 0001', '+1 555 300 9999'] }),
    contact('b', { names: ['Blake Two'], phones: ['+1 555 300 0002', '+1 555 300 9999'] }),
    contact('c', { names: ['Casey Three'], phones: ['+1 555 300 0003', '+1 555 300 9999'] }),
    contact('d', { names: ['Dana Four'], phones: ['+1 555 300 0004', '+1 305 555 0100'] }),
    msg('1', { thread: 'imessage:a', ts: days(1), from: 'tel:+15553000001', text: 'hi from alex' }),
    msg('2', { thread: 'imessage:b', ts: days(1), from: 'tel:+15553000002', text: 'hi from blake' }),
    msg('3', { thread: 'imessage:d', ts: days(1), from: 'tel:+15553000004', text: 'hi from dana' }),
  ]);
  const id = buildIdentity(ctx);
  assert.notEqual(id.byHandle('tel:+15553000001').id, id.byHandle('tel:+15553000002').id);
  assert.equal(id.byHandle('tel:+15553000004').name, 'Dana Four');
  assert.ok(!id.owner.handles.includes('tel:+15553000004'), 'a card listing the owner number does not merge into the owner');
  assert.equal(id.byHandle('tel:+13055550100').kind, 'owner');
});

test('canonical handles', () => {
  assert.equal(canonHandle('mailto:A@B.com'), 'mailto:a@b.com');
  assert.equal(canonHandle('tel:555-010-2000'), 'tel:+15550102000');
  assert.equal(canonHandle('name:Ana  Ruiz'), 'name:ana ruiz');
  assert.equal(loadIdentity(makeVault()).people.length, 0);
});

test('identity is fast on 150K records', () => {
  const ctx = makeVault();
  const recs = [];
  for (let i = 0; i < 150000; i++) {
    const p = i % 3000;
    const handle = p % 2 ? `tel:+1555${String(1000000 + p).slice(-7)}` : `mailto:person${p}@example${p % 40}.com`;
    const me = i % 3 === 0;
    recs.push({
      id: `imessage:${i}`,
      source: p % 2 ? 'imessage' : 'email',
      kind: p % 2 ? 'message' : 'email',
      thread: `t:${p}`,
      ts: new Date(NOW.getTime() - (i % 700) * 86400000).toISOString(),
      from: me ? { handle: 'mailto:sam@rivera.co', name: 'Sam Rivera' } : { handle, name: `Person ${p}` },
      to: me ? [{ handle, name: null }] : [{ handle: 'mailto:sam@rivera.co', name: null }],
      is_from_me: me,
      title: null,
      text: 'x',
      url: null,
      meta: {},
    });
  }
  for (let i = 0; i < recs.length; i += 10000) ctx.store.upsertRecords(recs.slice(i, i + 10000));
  const start = Date.now();
  const id = buildIdentity(ctx);
  const ms = Date.now() - start;
  assert.equal(id.stats.records, 150000);
  assert.ok(id.people.length >= 3000);
  assert.ok(ms < 20000, `identity took ${ms}ms`);
});
