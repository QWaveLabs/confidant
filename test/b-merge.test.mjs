import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildIdentity } from '../engine/identity.mjs';
import { planBatches } from '../engine/batch.mjs';
import { mergeBatch, run as mergeRun } from '../engine/merge.mjs';
import { buildMocs } from '../engine/mocs.mjs';
import { undoRun, listRuns, run as undoCli } from '../engine/undo.mjs';
import { takeLock } from '../engine/lib/b-common.mjs';
import { acquireLock } from '../engine/lib/lock.mjs';
import { readJson, writeJson } from '../engine/lib/files.mjs';
import { parseNote } from '../engine/lib/frontmatter.mjs';
import { makeVault, snapshot } from './fixtures/b-fixture.mjs';
import { goldenRecords, contributionFor } from './fixtures/b-golden-data.mjs';

async function setup(opts = {}) {
  const ctx = makeVault(opts);
  ctx.store.upsertRecords(goldenRecords(), '2026-09-28T15:00:00.000Z');
  buildIdentity(ctx);
  const batches = await planBatches(ctx, { scope: 'install', count: 10 });
  const byKind = Object.fromEntries(batches.map((b) => [b.kind, b]));
  return { ctx, batches, byKind };
}

async function mergeWith(ctx, b, contribution) {
  writeJson(b.output, { batch_id: b.id, ...contribution });
  return mergeBatch(ctx, b.id);
}

const note = (ctx, rel) => readFileSync(join(ctx.vault, rel), 'utf8');

test('a contribution that breaks the schema is refused with the reason', async () => {
  const { ctx, byKind } = await setup();
  const b = byKind.people;
  writeJson(b.output, { batch_id: b.id, commitments: [{ text: 'Send it', direction: 'maybe', counterpart: 'Ana Ruiz', date: '9/22', source_refs: ['imessage:a1'] }] });
  await assert.rejects(() => mergeBatch(ctx, b.id), (err) => err.code === 'ESCHEMA' && /direction/.test(err.message) && /Fix /.test(err.message));
  ctx.log.lines.out.length = 0;
  assert.equal(await mergeRun({ batch: b.id }, ctx), 6);
  assert.ok(ctx.log.lines.out[0].errors.some((e) => e.includes('direction')));
  writeJson(b.output, { batch_id: 'someone-else' });
  await assert.rejects(() => mergeBatch(ctx, b.id), /expected/);
  assert.equal(readdirSync(ctx.vault).filter((f) => !f.startsWith('.')).length, 0, 'nothing written');
});

test('the owner, excluded people and vague names never get notes', async () => {
  const { ctx, byKind } = await setup({ exclusions: { people: ['Carla Diaz'] } });
  const r = await mergeWith(ctx, byKind.people, {
    people: [
      { name: 'Sam Rivera', bullets: [{ date: '2026-09-22', text: 'Promised the proposal', source_refs: ['imessage:a2'] }] },
      { name: 'Carla Diaz', bullets: [{ date: '2026-09-25', text: 'Offered an intro', source_refs: ['whatsapp:c1'] }] },
      { name: 'Dan', bullets: [{ date: '2026-09-25', text: 'Invests in pilots', source_refs: ['whatsapp:c1'] }] },
      { name: 'Ana', bullets: [{ date: '2026-09-22', text: 'Asked for the proposal by Friday', source_refs: ['imessage:a1'] }] },
    ],
    commitments: [{ text: 'Introduce Sam to Dan Park', direction: 'owed_to_me', counterpart: 'Carla Diaz', date: '2026-09-25', source_refs: ['whatsapp:c1'] }],
  });
  assert.deepEqual(readdirSync(join(ctx.vault, 'People')), ['Ana Ruiz.md'], 'a first name resolves to the one batch participant');
  assert.ok(r.skipped_people.includes('Carla Diaz') && r.skipped_people.includes('Dan'));
  assert.ok(r.dropped.some((d) => d.startsWith('commitment')));
  assert.ok(!existsSync(join(ctx.vault, 'Commitments')));
});

test('near duplicates, fuzzy closes and the person’s due date', async () => {
  const { ctx, byKind } = await setup();
  await mergeWith(ctx, byKind.people, contributionFor(readJson(byKind.people.path)));
  const again = await mergeWith(ctx, byKind.people, {
    people: [{ name: 'Ana Ruiz', bullets: [{ date: '2026-09-22', text: 'Asked for the revised proposal by Friday so legal can review it before the review', source_refs: ['imessage:a1'] }] }],
    commitments: [{ text: 'Send Ana the revised proposal document', direction: 'i_owe', counterpart: 'Ana Ruiz', status: 'done', date: '2026-09-23', source_refs: ['imessage:a2'] }],
  });
  assert.equal(again.added, 1, 'only the status line is new');
  assert.equal(again.duplicates, 1, 'the reworded bullet was recognized');
  assert.equal(readdirSync(join(ctx.vault, 'Commitments')).length, 4, 'closing a reworded commitment updates the existing note');
  assert.equal(parseNote(note(ctx, 'Commitments/Send Ana the revised proposal.md')).data.status, 'done');

  const rel = 'Commitments/Review the contract draft and reply to Ben.md';
  writeFileSync(join(ctx.vault, rel), note(ctx, rel).replace('due: "2026-09-28"', 'due: 2026-10-05'));
  await mergeWith(ctx, byKind.people, { commitments: [{ text: 'Review the contract draft and reply to Ben', direction: 'i_owe', counterpart: 'Ben Cole', due: '2026-09-27', date: '2026-09-24', source_refs: ['email:e3'] }] });
  assert.equal(parseNote(note(ctx, rel)).data.due, '2026-10-05', 'an older fact never overrides the person’s edit');
});

test('undo refuses to skip over a later run, and --force goes through', async () => {
  const { ctx, byKind } = await setup();
  const base = snapshot(ctx.vault);
  const r1 = await mergeWith(ctx, byKind.people, contributionFor(readJson(byKind.people.path)));
  const r2 = await mergeWith(ctx, byKind.meetings, contributionFor(readJson(byKind.meetings.path)));
  assert.throws(() => undoRun(ctx, r1.run_id), /Later runs changed the same notes/);
  ctx.log.lines.out.length = 0;
  await undoCli({ list: true }, ctx);
  assert.deepEqual(ctx.log.lines.out[0].runs.map((r) => r.id), [r2.run_id, r1.run_id]);
  undoRun(ctx, r2.run_id);
  undoRun(ctx, r1.run_id);
  assert.deepEqual(snapshot(ctx.vault), base);
  assert.throws(() => undoRun(ctx, r1.run_id), /already undone/);
  assert.equal(listRuns(ctx).filter((r) => r.undone_at).length, 2);
  const again = await mergeBatch(ctx, byKind.people.id);
  assert.ok(again.created.includes('People/Ana Ruiz.md'), 'rows came back too, so the batch merges from scratch');
  assert.equal(r1.run_id < r2.run_id, true);
});

test('identity fixes in a contribution are kept and can be undone', async () => {
  const { ctx, byKind } = await setup();
  const id = buildIdentity(ctx);
  const ben = id.byHandle('mailto:ben@acme.com');
  const r = await mergeWith(ctx, byKind.people, { identity: [{ action: 'rename', person_ids: [ben.id], name: 'Benjamin Cole' }] });
  assert.equal(r.identity_fixes, 1);
  assert.equal(buildIdentity(ctx).byId(ben.id).name, 'Benjamin Cole', 'survives a rebuild');
  undoRun(ctx, r.run_id);
  assert.equal(readJson(join(ctx.paths.root, 'identity-fixes.json'), null), null);
  assert.equal(buildIdentity(ctx).byId(ben.id).name, 'Ben Cole');
});

test('the vault lock waits for another process and takes over a dead one', async () => {
  const ctx = makeVault();
  const held = acquireLock(ctx.paths, 'vault');
  writeFileSync(held.file, JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }));
  assert.throws(() => takeLock(ctx, 'vault', { timeoutMs: 300 }), (err) => err.code === 'EBUSY');
  writeFileSync(held.file, JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
  const release = takeLock(ctx, 'vault', { timeoutMs: 300 });
  const inner = takeLock(ctx, 'vault');
  inner();
  assert.ok(existsSync(held.file), 're-entrant release keeps the lock');
  release();
  assert.ok(!existsSync(held.file));
});

test('Spanish vaults get Spanish folders, headings, Home and views', async () => {
  const { ctx, byKind } = await setup({ language: 'es' });
  for (const b of Object.values(byKind)) await mergeWith(ctx, b, contributionFor(readJson(b.path)));
  await buildMocs(ctx);
  const files = Object.keys(snapshot(ctx.vault));
  for (const f of ['Personas/Ana Ruiz.md', 'Personas/Inversionistas/Carla Diaz.md', 'Compromisos/Send Ana the revised proposal.md', 'Reuniones/2026-09-21 Pilot review.md', 'Empresas/Acme.md', 'Compromisos.base', 'Personas.base', 'Oportunidades.base', 'Proyectos.base', 'Inversionistas.base', 'Personas/Personas.md']) {
    assert.ok(files.includes(f), f);
  }
  const ana = note(ctx, 'Personas/Ana Ruiz.md');
  assert.ok(ana.includes('## Cronología') && ana.includes('## Pendientes') && ana.includes('**Relación:**'));
  assert.ok(ana.includes('(Debo, vence 2026-09-24)'));
  const home = note(ctx, 'Home.md');
  assert.ok(home.includes('# Inicio') && home.includes('## Tu segundo cerebro') && home.includes('[[Compromisos.base|Compromisos]]'));
  assert.ok(note(ctx, 'Compromisos.base').includes('name: "Me deben"'));
});

test('mocs keeps a view the person customized and links the latest brief', async () => {
  const { ctx, byKind } = await setup();
  await mergeWith(ctx, byKind.people, contributionFor(readJson(byKind.people.path)));
  await buildMocs(ctx);
  const custom = `${note(ctx, 'People.base')}  - type: cards\n    name: "My cards"\n`;
  writeFileSync(join(ctx.vault, 'People.base'), custom);
  writeFileSync(join(ctx.vault, 'Home.md'), note(ctx, 'Home.md') + '\nMy pinned links.\n');
  writeJson(join(ctx.vault, 'Briefs', 'x.json'), {});
  writeFileSync(join(ctx.vault, 'Briefs', '2026-09-27 Morning brief.md'), '# Brief\n');
  writeFileSync(join(ctx.vault, 'Briefs', '2026-09-28 Morning brief.md'), '# Brief\n');
  writeFileSync(join(ctx.vault, 'People', 'My own list.md'), '# Mine\n');
  const out = await buildMocs(ctx);
  assert.equal(note(ctx, 'People.base'), custom);
  assert.ok(out.bases.some((b) => b.file === 'People.base' && b.kept));
  const home = note(ctx, 'Home.md');
  assert.ok(home.includes('Latest brief: [[2026-09-28 Morning brief]]'));
  assert.ok(home.includes('My pinned links.'));
  assert.ok(home.includes('- [[People]]: 4 notes'));
  assert.ok(note(ctx, 'People/People.md').includes('### Other notes\n- [[My own list]]'));
});
