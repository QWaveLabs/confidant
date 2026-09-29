import test from 'node:test';
import assert from 'node:assert/strict';
import { probe, extract } from '../engine/extract/recaps.mjs';
import { check } from '../engine/lib/schema.mjs';
import { fakeCtx } from './c-shared.test.mjs';

function emailRecord(over = {}) {
  return {
    id: `email:${over.idSuffix ?? '1'}`,
    source: over.source ?? 'email',
    kind: 'email',
    thread: 'email:t1',
    ts: over.ts ?? '2026-09-10T15:00:00.000Z',
    from: over.from ?? { handle: 'mailto:notifications@fathom.video', name: 'Fathom' },
    to: over.to ?? [{ handle: 'mailto:rob@acme.com', name: 'Rob' }],
    is_from_me: false,
    title: over.title ?? 'Meeting notes: Weekly sync',
    text: over.text ?? 'Summary of the call.\n\nAction items:\n- Send the deck\n- Book a follow-up\n\nThanks!',
    url: null,
    meta: {},
  };
}

test('probe counts email and gmail records without needing a key', async () => {
  const ctx = fakeCtx({});
  ctx.store.upsertRecords([emailRecord()]);
  const result = await probe(ctx);
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
});

test('recognizes a Fathom recap email and extracts title, summary and action items', async () => {
  const ctx = fakeCtx({});
  ctx.store.upsertRecords([emailRecord()]);
  const { records, done } = await extract(ctx, { cursor: null });
  assert.equal(records.length, 1);
  const r = records[0];
  assert.deepEqual(check('record', r), []);
  assert.equal(r.source, 'recaps');
  assert.equal(r.kind, 'meeting');
  assert.equal(r.title, 'Weekly sync');
  assert.deepEqual(r.meta.action_items, ['Send the deck', 'Book a follow-up']);
  assert.equal(r.meta.recap_provider, 'fathom');
  assert.equal(done, true);
});

test('ignores an ordinary email that matches no notetaker', async () => {
  const ctx = fakeCtx({});
  ctx.store.upsertRecords([emailRecord({ from: { handle: 'mailto:friend@example.com', name: 'A Friend' }, title: 'Dinner Friday?' })]);
  const { records } = await extract(ctx, { cursor: null });
  assert.equal(records.length, 0);
});

test('recognizes tl;dv, Gemini and Teams recaps by sender or subject', async () => {
  const ctx = fakeCtx({});
  ctx.store.upsertRecords([
    emailRecord({ idSuffix: '2', from: { handle: 'mailto:notify@tldv.io', name: 'tl;dv' }, title: 'Notes: Board prep', ts: '2026-09-11T00:00:00.000Z' }),
    emailRecord({ idSuffix: '3', from: { handle: 'mailto:workspace-noreply@google.com', name: 'Google' }, title: 'Standup - Notes by Gemini', ts: '2026-09-12T00:00:00.000Z' }),
    emailRecord({ idSuffix: '4', from: { handle: 'mailto:noreply@microsoft.com', name: 'Microsoft Teams' }, title: 'Copilot recap: Planning', ts: '2026-09-13T00:00:00.000Z' }),
  ]);
  const { records } = await extract(ctx, { cursor: null });
  const providers = records.map((r) => r.meta.recap_provider).sort();
  assert.deepEqual(providers, ['gemini', 'teams', 'tldv']);
  assert.deepEqual(records.map((r) => r.title).sort(), ['Board prep', 'Planning', 'Standup']);
});

test('skips a recap when the same meeting already exists from a real API source', async () => {
  const ctx = fakeCtx({});
  ctx.store.upsertRecords([
    { id: 'fathom:m1', source: 'fathom', kind: 'meeting', thread: 'meeting:fathom:m1', ts: '2026-09-10T14:00:00.000Z', from: null, to: [], is_from_me: false, title: 'Weekly Sync', text: 'transcript', meta: {} },
    emailRecord(),
  ]);
  const { records } = await extract(ctx, { cursor: null });
  assert.equal(records.length, 0);
});

test('reads gmail-sourced emails as well as email-sourced ones', async () => {
  const ctx = fakeCtx({});
  ctx.store.upsertRecords([emailRecord({ source: 'gmail' })]);
  const { records } = await extract(ctx, { cursor: null });
  assert.equal(records.length, 1);
});

test('cursor resumes from the last email ts and reports done when under the page limit', async () => {
  const ctx = fakeCtx({});
  ctx.store.upsertRecords([emailRecord({ ts: '2026-09-10T15:00:00.000Z' })]);
  const first = await extract(ctx, { cursor: null, limit: 200 });
  assert.equal(first.cursor, '2026-09-10T15:00:00.000Z');
  assert.equal(first.done, true);
});
