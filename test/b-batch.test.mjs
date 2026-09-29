import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { buildIdentity } from '../engine/identity.mjs';
import { planBatches, batchStatus, pack, run as batchRun } from '../engine/batch.mjs';
import { mergeBatch } from '../engine/merge.mjs';
import { check } from '../engine/lib/schema.mjs';
import { readJson, writeJson } from '../engine/lib/files.mjs';
import { estimateTokens } from '../engine/lib/b-text.mjs';
import { makeVault, msg, NOW } from './fixtures/b-fixture.mjs';

const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000);
const daysAgo = (d) => hoursAgo(d * 24);

function chatter(ctx, { people = 30, perPerson = 4, spreadDays = 50, startDay = 1 } = {}) {
  const recs = [];
  for (let p = 0; p < people; p++) {
    const h = `tel:+1555${String(2000000 + p)}`;
    for (let i = 0; i < perPerson; i++) {
      const day = startDay + ((p * 7 + i * 3) % spreadDays);
      recs.push(msg(`p${p}m${i}d${startDay}`, { thread: `imessage:p${p}`, ts: daysAgo(day), from: h, fromName: `Person ${String.fromCharCode(65 + (p % 26))}${p} Lastname`, text: `Detailed note ${i} about the shipment schedule, invoices and the next quarterly planning session.` }));
    }
  }
  ctx.store.upsertRecords(recs, '2026-09-28T15:00:00.000Z');
}

test('packing respects the token budget and item limits', () => {
  const dossiers = Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, type: 'person', items: [{ ref: `x:${i}`, text: 'y'.repeat(4000) }] }));
  const groups = pack(dossiers, { maxTokens: 12000, maxItems: 5 });
  for (const g of groups) {
    assert.ok(g.length <= 5);
    assert.ok(estimateTokens(g) <= 12000);
  }
  assert.equal(groups.flat().length, 30);
  const huge = pack([{ id: 'big', type: 'person', items: Array.from({ length: 50 }, (_, i) => ({ ref: `x:${i}`, text: 'z'.repeat(2000) })) }], { maxTokens: 10000 });
  assert.equal(huge.length, 1);
  assert.ok(huge[0][0].omitted > 0, 'an oversized dossier keeps its newest lines');
  assert.equal(huge[0][0].items[huge[0][0].items.length - 1].ref, 'x:49');
});

test('install: names to check go first, alone; content after they merge', async () => {
  const ctx = makeVault();
  ctx.store.upsertRecords([
    msg('mk', { source: 'whatsapp', thread: 'whatsapp:mike', ts: daysAgo(3), from: 'tel:+15559990000', fromName: 'Mike', text: 'Are we still on for the supplier call?' }),
    msg('mk2', { source: 'whatsapp', thread: 'whatsapp:mike', ts: daysAgo(3), me: true, to: ['tel:+15559990000'], text: 'Yes, 3pm.' }),
    msg('mb', { thread: 'imessage:mikeb', ts: daysAgo(5), from: 'tel:+15558880000', fromName: 'Mike Brennan', text: 'Supplier call moved to Thursday.' }),
    msg('mb2', { thread: 'imessage:mikeb', ts: daysAgo(5), me: true, to: ['tel:+15558880000'], text: 'Got it, thanks Mike.' }),
  ]);
  buildIdentity(ctx);
  const first = await planBatches(ctx, { scope: 'install', count: 4 });
  assert.deepEqual(first.map((b) => b.kind), ['identity_review']);
  const review = readJson(first[0].path);
  assert.deepEqual(check('batch', review), []);
  const item = review.items[0];
  assert.equal(item.reason, 'single_name');
  assert.ok(item.candidates.every((c) => c.handles.every((h) => !/\d{7}/.test(h))), 'phone numbers are masked');
  assert.ok(item.candidates[0].samples.length > 0);

  assert.deepEqual((await planBatches(ctx, { scope: 'install', count: 4 })).map((b) => b.id), [first[0].id], 'still waiting on the review');
  const [mike, mikeB] = item.candidates.map((c) => c.person_id);
  writeJson(first[0].output, { batch_id: first[0].id, identity: [{ action: 'merge', person_ids: [mikeB, mike] }] });
  const merged = await mergeBatch(ctx, first[0].id);
  assert.equal(merged.identity_fixes, 1);

  const content = await planBatches(ctx, { scope: 'install', count: 4 });
  assert.deepEqual(content.map((b) => b.kind), ['people']);
  const batch = readJson(content[0].path);
  assert.equal(batch.items.length, 1, 'both Mikes are one person now');
  assert.equal(batch.items[0].person.name, 'Mike Brennan');
  assert.ok(existsSync(batch.instructions), 'instructions path points at the sort prompt');
  assert.equal(batchStatus(ctx).install.done, false);
});

test('install batches hand out pending work first and skip a batch that keeps failing', async () => {
  const ctx = makeVault();
  chatter(ctx, { people: 40, perPerson: 8 });
  buildIdentity(ctx);
  const a = await planBatches(ctx, { scope: 'install', count: 2, maxTokens: 12000 });
  assert.equal(a.length, 2);
  const all = batchStatus(ctx).install;
  assert.ok(all.pending >= 3, `several batches planned (${all.pending})`);
  const b = await planBatches(ctx, { scope: 'install', count: 2, maxTokens: 12000 });
  assert.deepEqual(b.map((x) => x.id), a.map((x) => x.id), 'unsorted batches come back first');
  await planBatches(ctx, { scope: 'install', count: 2, maxTokens: 12000 });
  const d = await planBatches(ctx, { scope: 'install', count: 2, maxTokens: 12000 });
  assert.ok(!d.some((x) => a.some((y) => y.id === x.id)), 'after three tries a batch is skipped');
  assert.equal(batchStatus(ctx).install.skipped, 2);
  for (const x of d) {
    const batch = readJson(x.path);
    assert.deepEqual(check('batch', batch), []);
    assert.ok(batch.est_tokens <= 12000);
  }
});

test('backlog walks older history newest first until it is done', async () => {
  const ctx = makeVault();
  chatter(ctx, { people: 5, perPerson: 2, spreadDays: 20, startDay: 1 });
  chatter(ctx, { people: 5, perPerson: 2, spreadDays: 10, startDay: 75 });
  chatter(ctx, { people: 5, perPerson: 2, spreadDays: 10, startDay: 200 });
  buildIdentity(ctx);
  await planBatches(ctx, { scope: 'install', count: 10 });
  assert.equal(ctx.state.backlog.oldest_sorted, new Date(NOW.getTime() - 60 * 86400000).toISOString());

  const one = await planBatches(ctx, { scope: 'backlog', count: 1 });
  assert.equal(one.length, 1);
  const first = readJson(one[0].path);
  const dates = first.items.flatMap((d) => d.items.map((i) => i.date)).sort();
  assert.ok(dates[0] >= '2026-06-30' && dates[dates.length - 1] <= '2026-07-30', `first window is the newest older month (${dates[0]}..${dates[dates.length - 1]})`);
  assert.equal(ctx.state.backlog.done, false);

  writeJson(one[0].output, { batch_id: one[0].id });
  await mergeBatch(ctx, one[0].id);
  const two = await planBatches(ctx, { scope: 'backlog', count: 1 });
  const second = readJson(two[0].path);
  const d2 = second.items.flatMap((d) => d.items.map((i) => i.date)).sort();
  assert.ok(d2[d2.length - 1] < dates[0], 'the next window is older, empty months skipped');
  writeJson(two[0].output, { batch_id: two[0].id });
  await mergeBatch(ctx, two[0].id);
  const three = await planBatches(ctx, { scope: 'backlog', count: 1 });
  assert.deepEqual(three, []);
  assert.equal(ctx.state.backlog.done, true);
  assert.equal(batchStatus(ctx).backlog.merged, 2);
});

test('update only sorts what changed and the CLI prints JSON', async () => {
  const ctx = makeVault();
  chatter(ctx, { people: 3, perPerson: 2, spreadDays: 5 });
  buildIdentity(ctx);
  await planBatches(ctx, { scope: 'install', count: 10 });
  ctx.now = hoursAgo(-2);
  assert.deepEqual(await planBatches(ctx, { scope: 'update' }), [], 'nothing changed');
  ctx.store.upsertRecords([msg('new1', { thread: 'imessage:p1', ts: hoursAgo(-1), from: 'tel:+15552000001', text: 'The shipment cleared customs this morning.' })], '2026-09-28T18:30:00.000Z');
  ctx.now = hoursAgo(-3);
  buildIdentity(ctx);
  ctx.log.lines.out.length = 0;
  ctx.json = true;
  await batchRun({ _: ['next'], scope: 'update', count: '3' }, ctx);
  const out = ctx.log.lines.out[0];
  assert.equal(out.batches.length, 1);
  assert.equal(out.batches[0].kind, 'update');
  const batch = readJson(out.batches[0].path);
  assert.deepEqual(batch.items.map((d) => d.type), ['person']);
  await batchRun({ _: ['status'] }, ctx);
  assert.equal(ctx.log.lines.out[1].update.pending, 1);
});
