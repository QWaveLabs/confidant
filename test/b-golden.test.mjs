// Golden test: fixture records and canned sorter output produce this exact
// vault. Regenerate after an intended format change with
//   UPDATE_GOLDEN=1 sh bin/node --test test/b-golden.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIdentity } from '../engine/identity.mjs';
import { planBatches } from '../engine/batch.mjs';
import { mergeBatch } from '../engine/merge.mjs';
import { buildMocs } from '../engine/mocs.mjs';
import { undoRun } from '../engine/undo.mjs';
import { check } from '../engine/lib/schema.mjs';
import { readJson, writeJson } from '../engine/lib/files.mjs';
import { parseNote } from '../engine/lib/frontmatter.mjs';
import { makeVault, snapshot } from './fixtures/b-fixture.mjs';
import { goldenRecords, updateRecords, contributionFor } from './fixtures/b-golden-data.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'fixtures', 'b-golden.snapshot.json');

async function sortAll(ctx, batches) {
  const results = [];
  for (const b of batches) {
    const batch = readJson(b.path);
    assert.deepEqual(check('batch', batch), [], `${b.id} matches the batch schema`);
    const contribution = contributionFor(batch);
    assert.deepEqual(check('contribution', contribution), [], `${b.id} canned contribution is valid`);
    writeJson(b.output, contribution);
    results.push(await mergeBatch(ctx, b.id));
  }
  return results;
}

async function install() {
  const ctx = makeVault();
  ctx.store.upsertRecords(goldenRecords(), '2026-09-28T15:00:00.000Z');
  buildIdentity(ctx);
  const batches = await planBatches(ctx, { scope: 'install', count: 10 });
  const results = await sortAll(ctx, batches);
  await buildMocs(ctx);
  return { ctx, batches, results };
}

test('golden vault: tree and note contents', async () => {
  const { ctx, batches, results } = await install();
  assert.deepEqual(batches.map((b) => b.kind), ['people', 'meetings', 'threads']);
  const people = results[0];
  assert.deepEqual(people.skipped_people, ['Invented Person'], 'a person with only made-up sources is left out');
  assert.ok(people.dropped.some((d) => d.includes('no real source')), 'a commitment with only made-up sources is dropped');
  const snap = snapshot(ctx.vault);
  if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, `${JSON.stringify(snap, null, 2)}\n`);
  assert.ok(existsSync(GOLDEN), 'golden snapshot exists (UPDATE_GOLDEN=1 creates it)');
  const expected = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(Object.keys(snap).sort(), Object.keys(expected).sort(), 'vault tree');
  for (const [path, content] of Object.entries(expected)) assert.equal(snap[path], content, path);
  for (const [path, content] of Object.entries(snap)) {
    const prose = content.replace(/^---$/gm, '').replace(/<!-- confidant:(start|end) [a-z_]+ -->/g, '');
    assert.ok(!/—|--/.test(prose), `${path} has no em dash or double hyphen`);
  }
});

test('golden vault: merging again and rebuilding changes nothing', async () => {
  const { ctx, batches } = await install();
  const before = snapshot(ctx.vault);
  for (const b of batches) {
    const again = await mergeBatch(ctx, b.id);
    assert.equal(again.run_id, null, 'no run recorded for a no-op merge');
    assert.equal(again.items_added, 0);
  }
  await buildMocs(ctx);
  buildIdentity(ctx);
  await buildMocs(ctx);
  assert.deepEqual(snapshot(ctx.vault), before);
});

test('golden vault: an update keeps the person’s prose, closes the commitment in place, and undoes cleanly', async () => {
  const { ctx } = await install();
  const ana = join(ctx.vault, 'People/Ana Ruiz.md');
  const commitmentPath = join(ctx.vault, 'Commitments/Send Ana the revised proposal.md');
  const prose = readFileSync(ana, 'utf8').replace('# Ana Ruiz\n', '# Ana Ruiz\n\nMet at a conference in 2025. Prefers calls before 10am.\n') + '\n## My notes\nAsk about her trip to Lisbon.\n';
  writeFileSync(ana, prose);
  const before = snapshot(ctx.vault);
  const commitmentsBefore = readdirSync(join(ctx.vault, 'Commitments')).length;

  ctx.now = new Date('2026-09-28T18:00:00.000Z');
  ctx.store.upsertRecords(updateRecords(), '2026-09-28T17:00:00.000Z');
  buildIdentity(ctx);
  const batches = await planBatches(ctx, { scope: 'update', count: 5 });
  assert.deepEqual(batches.map((b) => b.kind), ['update']);
  const update = readJson(batches[0].path);
  assert.ok(update.items[0].items.some((i) => i.ref === 'imessage:a5' && !i.context), 'the new message is in the batch');
  assert.ok(update.items[0].items.some((i) => i.context), 'earlier lines come along as context');
  assert.ok(update.known.commitments.some((c) => c.text === 'Send Ana the revised proposal'), 'open commitments are offered for reuse');
  const [res] = await sortAll(ctx, batches);

  const after = readFileSync(ana, 'utf8');
  assert.ok(after.includes('Met at a conference in 2025. Prefers calls before 10am.'));
  assert.ok(after.includes('## My notes\nAsk about her trip to Lisbon.'));
  assert.ok(after.includes('- 2026-09-28, Confirmed the revised proposal looks good and is sharing it with legal. _(iMessage)_'));
  assert.ok(after.indexOf('2026-09-28, Confirmed') < after.indexOf('2026-09-22, Asked'), 'newest first');
  assert.ok(!after.includes('[[Send Ana the revised proposal]]'), 'no longer an open loop');
  assert.ok(after.includes('Nothing open right now.'));
  const commitment = readFileSync(commitmentPath, 'utf8');
  assert.equal(parseNote(commitment).data.status, 'done');
  assert.ok(commitment.includes('- 2026-09-28, Marked done. _(iMessage)_'));
  assert.equal(readdirSync(join(ctx.vault, 'Commitments')).length, commitmentsBefore, 'status update did not create a new note');

  undoRun(ctx, res.run_id);
  assert.deepEqual(snapshot(ctx.vault), before, 'undo restores every file');
  const redo = await mergeBatch(ctx, batches[0].id);
  assert.ok(redo.items_added > 0, 'the undone batch merges again');
  assert.equal(parseNote(readFileSync(commitmentPath, 'utf8')).data.status, 'done');
});

test('golden vault: a commitment the person marks done in Obsidian stays done', async () => {
  const { ctx } = await install();
  const path = join(ctx.vault, 'Commitments/Review the contract draft and reply to Ben.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('status: open', 'status: done'));
  await buildMocs(ctx);
  const ben = readFileSync(join(ctx.vault, 'People/Ben Cole.md'), 'utf8');
  assert.ok(!ben.includes('[[Review the contract draft and reply to Ben]]'), 'person note drops the closed loop');
  assert.equal(parseNote(readFileSync(path, 'utf8')).data.status, 'done');
  const home = readFileSync(join(ctx.vault, 'Home.md'), 'utf8');
  assert.ok(!home.includes('[[Review the contract draft and reply to Ben]]'));
});
