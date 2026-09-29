import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildIdentity } from '../engine/identity.mjs';
import { planBatches } from '../engine/batch.mjs';
import { mergeBatch } from '../engine/merge.mjs';
import { undoRun } from '../engine/undo.mjs';
import { loadReview, run as reviewRun } from '../engine/review.mjs';
import { readJson, writeJson } from '../engine/lib/files.mjs';
import { makeVault, msg } from './fixtures/b-fixture.mjs';
import { goldenRecords, updateRecords } from './fixtures/b-golden-data.mjs';

async function setup(opts) {
  const ctx = makeVault(opts);
  ctx.store.upsertRecords(goldenRecords(), '2026-09-28T15:00:00.000Z');
  buildIdentity(ctx);
  const batches = await planBatches(ctx, { scope: 'install', count: 10 });
  return { ctx, people: batches.find((b) => b.kind === 'people') };
}

test('unsure items become review questions, and answers reach the next batch', async () => {
  const { ctx, people } = await setup();
  writeJson(people.output, {
    batch_id: people.id,
    review: [
      { question: 'Is the revised proposal for the Acme pilot or a new renewal?', options: ['Acme pilot', 'Renewal'], subject: 'Ana Ruiz', source_refs: ['imessage:a1'] },
      { question: 'A question with no real source at all', source_refs: ['imessage:nope'] },
    ],
  });
  const r = await mergeBatch(ctx, people.id);
  assert.equal(r.review_added, 1);
  assert.ok(r.dropped.some((d) => d.startsWith('review')));
  const note = readFileSync(join(ctx.vault, 'Needs review.md'), 'utf8');
  assert.ok(note.includes('- [ ] **Is the revised proposal for the Acme pilot or a new renewal?** Options: Acme pilot, Renewal. About: Ana Ruiz. _(iMessage, 2026-09-22)_'));
  const [item] = loadReview(ctx).items;

  const again = await mergeBatch(ctx, people.id);
  assert.equal(again.review_added, 0, 'the same question is asked once');

  ctx.log.lines.out.length = 0;
  await reviewRun({}, ctx);
  assert.equal(ctx.log.lines.out[0].open.length, 1);
  await reviewRun({ resolve: item.id, answer: 'Acme pilot' }, ctx);
  assert.equal(loadReview(ctx).items[0].status, 'resolved');
  assert.ok(readFileSync(join(ctx.vault, 'Needs review.md'), 'utf8').includes('Nothing needs your review right now.'));

  ctx.now = new Date('2026-09-28T18:00:00.000Z');
  ctx.store.upsertRecords(updateRecords(), '2026-09-28T17:00:00.000Z');
  buildIdentity(ctx);
  const [next] = await planBatches(ctx, { scope: 'update' });
  const batch = readJson(next.path);
  assert.deepEqual(batch.known.resolutions, [{ question: item.question, answer: 'Acme pilot', subject: 'Ana Ruiz' }]);

  undoRun(ctx, r.run_id, { force: true });
  assert.ok(!existsSync(join(ctx.vault, 'Needs review.md')));
});

test('a company gets a note only when it is listed or comes up twice', async () => {
  const { ctx, people } = await setup();
  writeJson(people.output, {
    batch_id: people.id,
    opportunities: [{ title: 'Intro to Northwind Ventures', type: 'introduction', counterpart: 'Carla Diaz', company: 'Northwind Ventures', date: '2026-09-25', source_refs: ['whatsapp:c1'] }],
    commitments: [{ text: 'Send the pilot deck to Ana', direction: 'i_owe', counterpart: 'Ana Ruiz', company: 'Beta Corp', date: '2026-09-22', source_refs: ['imessage:a2'] }],
  });
  await mergeBatch(ctx, people.id);
  assert.ok(!existsSync(join(ctx.vault, 'Companies')), 'single mentions stay plain text');
  const opp = readFileSync(join(ctx.vault, 'Opportunities/Intro to Northwind Ventures.md'), 'utf8');
  assert.ok(opp.includes('company: Northwind Ventures'));

  ctx.now = new Date('2026-09-28T18:00:00.000Z');
  ctx.store.upsertRecords([msg('c3', { source: 'whatsapp', thread: 'whatsapp:carla', ts: new Date('2026-09-28T13:00:00Z'), from: 'tel:+5215512345678', text: 'Dan at Northwind Ventures wants a call next week.' })], '2026-09-28T17:00:00.000Z');
  buildIdentity(ctx);
  const [next] = await planBatches(ctx, { scope: 'update' });
  writeJson(next.output, { batch_id: next.id, commitments: [{ text: 'Set up a call with Dan at Northwind Ventures', direction: 'i_owe', counterpart: 'Carla Diaz', company: 'Northwind Ventures', date: '2026-09-28', source_refs: ['whatsapp:c3'] }] });
  await mergeBatch(ctx, next.id);
  assert.ok(existsSync(join(ctx.vault, 'Companies/Northwind Ventures.md')), 'the second mention creates it');
  assert.ok(readFileSync(join(ctx.vault, 'Opportunities/Intro to Northwind Ventures.md'), 'utf8').includes('company: "[[Northwind Ventures]]"'), 'the earlier note now links to it');
  assert.ok(!existsSync(join(ctx.vault, 'Companies/Beta Corp.md')));
});

test('Spanish vaults get Por revisar.md', async () => {
  const { ctx, people } = await setup({ language: 'es' });
  writeJson(people.output, { batch_id: people.id, review: [{ question: '¿La propuesta es para el piloto de Acme?', source_refs: ['imessage:a1'] }] });
  await mergeBatch(ctx, people.id);
  const note = readFileSync(join(ctx.vault, 'Por revisar.md'), 'utf8');
  assert.ok(note.includes('# Por revisar') && note.includes('Responde cualquiera en Codex'));
});
