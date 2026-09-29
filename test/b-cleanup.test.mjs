// Golden cleanup run: plan, apply, undo, then act on the person's answers.
// Regenerate the plan snapshot with UPDATE_GOLDEN=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIdentity } from '../engine/identity.mjs';
import { planBatches } from '../engine/batch.mjs';
import { mergeBatch } from '../engine/merge.mjs';
import { buildMocs } from '../engine/mocs.mjs';
import { undoRun } from '../engine/undo.mjs';
import { planCleanup, applyCleanup, run as cleanupRun } from '../engine/cleanup.mjs';
import { loadReview, resolveReview, run as reviewRun } from '../engine/review.mjs';
import { readJson, writeJson } from '../engine/lib/files.mjs';
import { parseNote } from '../engine/lib/frontmatter.mjs';
import { makeVault, snapshot } from './fixtures/b-fixture.mjs';
import { goldenRecords, contributionFor, cleanupRecords, cleanupContribution } from './fixtures/b-golden-data.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PLAN = join(HERE, 'fixtures', 'b-cleanup.plan.json');
// A scrub rule that did not exist when the bullet was merged.
const scrub = (s) => String(s).replace(/\bZETA-\d{4}\b/g, '[voucher]');
const read = (ctx, rel) => readFileSync(join(ctx.vault, rel), 'utf8');
const edit = (ctx, rel, fn) => writeFileSync(join(ctx.vault, rel), fn(read(ctx, rel)));

async function messyVault() {
  const ctx = makeVault();
  ctx.store.upsertRecords(goldenRecords(), '2026-09-28T15:00:00.000Z');
  buildIdentity(ctx);
  for (const b of await planBatches(ctx, { scope: 'install', count: 10 })) {
    writeJson(b.output, contributionFor(readJson(b.path)));
    await mergeBatch(ctx, b.id);
  }
  ctx.now = new Date('2026-09-28T18:00:00.000Z');
  ctx.store.upsertRecords(cleanupRecords(), '2026-09-28T17:00:00.000Z');
  let identity = buildIdentity(ctx);
  const batches = await planBatches(ctx, { scope: 'update', count: 5 });
  assert.deepEqual(batches.map((b) => b.kind).sort(), ['identity_review', 'update']);
  const update = batches.find((b) => b.kind === 'update');
  writeJson(update.output, cleanupContribution(readJson(update.path), identity));
  await mergeBatch(ctx, update.id);
  assert.ok(existsSync(join(ctx.vault, 'People/Ben Cole 2.md')), 'the second number got its own note first');
  const review = batches.find((b) => b.kind === 'identity_review');
  writeJson(review.output, cleanupContribution(readJson(review.path), identity));
  await mergeBatch(ctx, review.id);
  identity = buildIdentity(ctx);
  await buildMocs(ctx);
  // The person's own edits.
  edit(ctx, 'People/Ben Cole 2.md', (t) => t.replace('type: person\n', 'type: person\nnickname: Benny\n').replace(/\n$/, '\n\nPrefers WhatsApp on weekends.\n'));
  edit(ctx, 'People/Investors/Carla Diaz.md', (t) => `${t}\nMet through [[Ben Cole 2]].\n`);
  edit(ctx, 'People/Ana Ruiz.md', (t) => `${t}\nRenewals sit with [[Acme Inc]]. Ask [[Nobody Here]].\n`);
  return ctx;
}

test('cleanup plan finds duplicates, broken links, done work, quiet projects and leaks', async () => {
  const ctx = await messyVault();
  const plan = await planCleanup(ctx, { scrub });
  if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN_PLAN, `${JSON.stringify(plan, null, 2)}\n`);
  assert.ok(existsSync(GOLDEN_PLAN), 'plan snapshot exists (UPDATE_GOLDEN=1 creates it)');
  assert.deepEqual(plan, JSON.parse(readFileSync(GOLDEN_PLAN, 'utf8')));
  assert.deepEqual(plan.summary, { exact_duplicates: 1, probable_duplicates: 1, broken_links: 2, fixable_links: 1, maybe_done: 2, stale_projects: 1, sensitive: 1 });
  assert.equal(plan.exact_duplicates[0].keep.path, 'People/Ben Cole.md');
  assert.equal(plan.exact_duplicates[0].remove[0].path, 'People/Ben Cole 2.md');
  assert.deepEqual([plan.probable_duplicates[0].a.name, plan.probable_duplicates[0].b.name].sort(), ['Ana Ruiz', 'Ana Ruiz Gomez']);
  assert.equal(plan.broken_links.find((l) => l.target === 'Acme Inc').fix, 'Acme');
  assert.deepEqual(plan.maybe_done.map((m) => m.text).sort(), ['Loop in Acme legal on the contract', 'Send the signed contract after legal review']);
  assert.ok(plan.maybe_done.every((m) => m.evidence.every((e) => e.ref === 'whatsapp:bw1')), 'an email signature is not evidence');
  assert.equal(plan.stale_projects[0].project.name, 'Website refresh');
  ctx.log.lines.out.length = 0;
  await cleanupRun({ plan: true }, ctx);
  assert.equal(ctx.log.lines.out[0].summary.exact_duplicates, 1);
});

test('cleanup apply fixes only the safe things, asks about the rest, and undoes cleanly', async () => {
  const ctx = await messyVault();
  const before = snapshot(ctx.vault);
  const res = await applyCleanup(ctx, { scrub });
  assert.equal(res.applied.duplicates_merged, 1);
  assert.equal(res.applied.links_fixed, 1);
  assert.equal(res.applied.scrubbed, 1);
  assert.equal(res.applied.reviewed, 4);

  assert.ok(!existsSync(join(ctx.vault, 'People/Ben Cole 2.md')));
  const ben = read(ctx, 'People/Ben Cole.md');
  assert.ok(ben.includes('- 2026-09-28, Said legal approved the contract and he sent it signed. _(WhatsApp)_'), 'timelines combined');
  assert.ok(ben.includes('- 2026-09-24, Sent the contract draft'), 'original timeline kept');
  assert.ok(ben.includes('## Merged from Ben Cole 2\nPrefers WhatsApp on weekends.'), 'the person’s text moved over');
  assert.equal(parseNote(ben).data.nickname, 'Benny');
  assert.ok(read(ctx, 'People/Investors/Carla Diaz.md').includes('Met through [[Ben Cole]].'), 'links rewritten');
  const ana = read(ctx, 'People/Ana Ruiz.md');
  assert.ok(ana.includes('Renewals sit with [[Acme|Acme Inc]]. Ask [[Nobody Here]].'), 'renamed link fixed, unknown link left alone');
  assert.ok(read(ctx, 'People/Maya Lin.md').includes('voucher [voucher] for hosting'), 'leak scrubbed in the generated text');
  assert.equal(parseNote(read(ctx, 'Commitments/Send the signed contract after legal review.md')).data.status, 'open', 'maybe-done is asked, not applied');
  assert.ok(existsSync(join(ctx.vault, 'People/Ana Ruiz Gomez.md')), 'probable duplicates are asked, not merged');

  const queue = loadReview(ctx).items;
  assert.deepEqual(queue.map((i) => i.kind).sort(), ['duplicate', 'maybe_done', 'maybe_done', 'stale_project']);
  const note = read(ctx, 'Needs review.md');
  assert.ok(note.includes('**Are Ana Ruiz and Ana Ruiz Gomez the same person?**') || note.includes('**Are Ana Ruiz Gomez and Ana Ruiz the same person?**'));
  assert.ok(note.includes('Is "Send the signed contract after legal review" done?'));
  assert.ok(read(ctx, 'Home.md').includes('4 things need your review: [[Needs review]]'));

  const again = await applyCleanup(ctx, { scrub });
  assert.equal(again.applied.duplicates_merged + again.applied.reviewed + again.applied.scrubbed + again.applied.links_fixed, 0, 'a second run has nothing to do');

  undoRun(ctx, again.run_id ?? res.run_id, { force: true });
  if (again.run_id) undoRun(ctx, res.run_id);
  assert.deepEqual(snapshot(ctx.vault), before, 'undo restores every file, including the deleted duplicate');
  assert.equal(loadReview(ctx).items.length, 0);
});

test('answers in the review queue are applied on the next cleanup', async () => {
  const ctx = await messyVault();
  await applyCleanup(ctx, { scrub });
  const byKind = Object.fromEntries(loadReview(ctx).items.filter((i) => i.kind !== 'maybe_done' || i.question.includes('signed contract')).map((i) => [i.kind, i]));
  resolveReview(ctx, byKind.duplicate.id, { answer: 'Yes, merge them' });
  ctx.log.lines.out.length = 0;
  await reviewRun({ resolve: byKind.maybe_done.id.slice(0, 6), answer: 'yes' }, ctx);
  resolveReview(ctx, byKind.stale_project.id, { answer: 'Stalled' });
  const res = await applyCleanup(ctx, { scrub });
  assert.equal(res.applied.merged, 1);
  assert.equal(res.applied.closed, 1);
  assert.equal(res.applied.statuses, 1);
  assert.ok(!existsSync(join(ctx.vault, 'People/Ana Ruiz Gomez.md')));
  const ana = read(ctx, 'People/Ana Ruiz.md');
  assert.ok(ana.includes('procurement team to own vendor renewals. _(Email)_'), 'the other timeline moved over');
  assert.equal(buildIdentity(ctx).byHandle('mailto:ana.gomez@acmecorp.example').id, buildIdentity(ctx).byHandle('mailto:ana@acme.com').id, 'the merge is kept in identity');
  assert.equal(parseNote(read(ctx, 'Commitments/Send the signed contract after legal review.md')).data.status, 'done');
  assert.equal(parseNote(read(ctx, 'Projects/Website refresh.md')).data.status, 'stalled');
  const note = read(ctx, 'Needs review.md');
  assert.ok(note.includes('Is "Loop in Acme legal on the contract" done?'), 'the unanswered question stays');
  assert.ok(!note.includes('- [ ] **Are Ana'), 'answered questions leave the open list');
  assert.ok(note.includes('## Recently answered\n'));
  assert.ok(note.includes('Answer: Yes, merge them.'));
});
