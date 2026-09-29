import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, tempHome, runSource, schemaErrors, resetCaches } from './fixtures/a-fixtures.mjs';
import { addressBook, addCards } from './fixtures/a-apple.mjs';
import * as contacts from '../engine/extract/contacts.mjs';

test('contacts: cards from every source database, groups skipped', async () => {
  const home = tempHome();
  addressBook(home, 'SRC-A', [
    { pk: 1, first: 'Mike', last: 'Brennan', org: 'Acme', job: 'CFO', phones: ['(305) 555-1234', '+1 305 555 1234'], emails: ['Mike@Acme.test'] },
    { pk: 2, org: 'Northwind Logistics', emails: ['ops@northwind.test'] },
    { pk: 3, group: 'Board' },
    { pk: 4, first: 'Rob', last: 'Hernandez', phones: ['+1 305 555 0100'] },
  ]);
  addressBook(home, 'SRC-B', [{ pk: 1, first: 'Ana', last: 'López', nickname: 'Anita', phones: ['+52 55 1234 5678'] }]);
  const ctx = makeCtx({ home });
  resetCaches();
  assert.deepEqual(await contacts.probe(ctx), { ok: true, count: 4 });
  await runSource(ctx, 'contacts');
  const recs = ctx.store.records({ source: 'contacts' });
  assert.deepEqual(schemaErrors(recs), []);
  assert.equal(recs.length, 4);
  const mike = recs.find((r) => r.title === 'Mike Brennan');
  assert.deepEqual(mike.meta.phones, ['+13055551234'], 'duplicates collapse after normalizing');
  assert.deepEqual(mike.meta.emails, ['mike@acme.test']);
  assert.equal(mike.meta.company, 'Acme');
  assert.equal(mike.meta.title, 'CFO');
  assert.equal(mike.kind, 'contact');
  assert.equal(mike.text, '');
  assert.deepEqual(recs.find((r) => r.title === 'Northwind Logistics').meta.names, ['Northwind Logistics']);
  assert.deepEqual(recs.find((r) => r.title === 'Ana López').meta.names, ['Ana López', 'Anita']);
  assert.equal(recs.find((r) => r.title === 'Rob Hernandez').is_from_me, true);
});

test('contacts: edited cards come back, unchanged ones do not', async () => {
  const home = tempHome();
  const db = addressBook(home, 'SRC-A', [{ pk: 1, first: 'Mike', last: 'Brennan', phones: ['3055551234'] }]);
  const ctx = makeCtx({ home });
  await runSource(ctx, 'contacts');
  assert.equal((await runSource(ctx, 'contacts')).inserted, 0);
  db.prepare('UPDATE ZABCDRECORD SET ZJOBTITLE = ?, ZMODIFICATIONDATE = ZMODIFICATIONDATE + 100 WHERE Z_PK = 1').run('CEO');
  addCards(db, [{ pk: 2, first: 'Sara', last: 'Kim', emails: ['sara@kim.test'], modified: '2026-02-01T00:00:00Z' }]);
  const t = await runSource(ctx, 'contacts');
  assert.equal(t.updated, 1);
  assert.equal(t.inserted, 1);
  assert.equal(ctx.store.records({ source: 'contacts' }).find((r) => r.title === 'Mike Brennan').meta.title, 'CEO');
});

test('contacts: paging across databases stays complete', async () => {
  const home = tempHome();
  addressBook(home, 'SRC-A', Array.from({ length: 5 }, (_, i) => ({ pk: i + 1, first: `A${i}`, last: 'One', phones: [`30555500${10 + i}`] })));
  addressBook(home, 'SRC-B', Array.from({ length: 4 }, (_, i) => ({ pk: i + 1, first: `B${i}`, last: 'Two', emails: [`b${i}@two.test`] })));
  const ctx = makeCtx({ home });
  const t = await runSource(ctx, 'contacts', { limit: 2 });
  assert.equal(t.inserted, 9);
  assert.ok(t.pages >= 5);
});

test('contacts: probe without an address book', async () => {
  const p = await contacts.probe(makeCtx({ home: tempHome() }));
  assert.equal(p.ok, false);
});
