import test from 'node:test';
import assert from 'node:assert/strict';
import { probe, extract } from '../engine/extract/granola.mjs';
import { check } from '../engine/lib/schema.mjs';
import { fakeCtx, mockFetch } from './c-shared.test.mjs';

const NOTE_SUMMARY = { id: 'not_1', title: 'Budget review', created_at: '2026-09-02T10:00:00.000Z' };
const NOTE_FULL = {
  ...NOTE_SUMMARY,
  owner: { name: 'Oat Benson', email: 'oat@granola.ai' },
  summary: 'We reviewed the budget.',
  transcript: [
    { speaker: { source: 'microphone', diarization_label: 'Speaker A' }, text: "I'm in." },
    { speaker: { source: 'speaker', diarization_label: 'Speaker B' }, text: 'Agreed.' },
  ],
};

test('probe reports needsKey when no Granola key is set', async () => {
  const ctx = fakeCtx({});
  ctx.getKey = () => null;
  const result = await probe(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.needsKey, true);
});

test('extract lists notes then fetches each one with its transcript', async () => {
  const fetchImpl = mockFetch([
    { status: 200, json: { notes: [NOTE_SUMMARY], hasMore: false } },
    { status: 200, json: NOTE_FULL },
  ]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'grn_key';
  const { records, cursor, done } = await extract(ctx, { cursor: null });

  assert.equal(records.length, 1);
  const r = records[0];
  assert.deepEqual(check('record', r), []);
  assert.equal(r.id, 'granola:not_1');
  assert.equal(r.text, 'Speaker A: I\'m in.\nSpeaker B: Agreed.');
  assert.deepEqual(r.to, [{ handle: 'mailto:oat@granola.ai', name: 'Oat Benson' }]);
  assert.equal(r.meta.summary, 'We reviewed the budget.');
  assert.equal(done, true);

  const secondCallUrl = fetchImpl.calls[1].url;
  assert.ok(secondCallUrl.includes('/notes/not_1'));
  assert.ok(secondCallUrl.includes('include=transcript'));
  const cursorState = JSON.parse(cursor);
  assert.equal(cursorState.since, '2026-09-02T10:00:00.000Z');
});

test('follows hasMore + cursor across pages before settling on a since watermark', async () => {
  const fetchImpl = mockFetch([
    { status: 200, json: { notes: [NOTE_SUMMARY], hasMore: true, cursor: 'page2' } },
    { status: 200, json: NOTE_FULL },
  ]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'grn_key';
  const { cursor, done } = await extract(ctx, { cursor: null });
  assert.equal(done, false);
  assert.deepEqual(JSON.parse(cursor), { page: 'page2', since: null });
});

test('a completed backfill sends created_after on the next run', async () => {
  const fetchImpl = mockFetch([{ status: 200, json: { notes: [], hasMore: false } }]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'grn_key';
  const cursor = JSON.stringify({ page: null, since: '2026-09-02T10:00:00.000Z' });
  await extract(ctx, { cursor });
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.searchParams.get('created_after'), '2026-09-02T10:00:00.000Z');
  assert.equal(url.searchParams.has('cursor'), false);
});
