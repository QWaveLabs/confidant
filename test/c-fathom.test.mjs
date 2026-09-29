import test from 'node:test';
import assert from 'node:assert/strict';
import { probe, extract } from '../engine/extract/fathom.mjs';
import { check } from '../engine/lib/schema.mjs';
import { fakeCtx, mockFetch } from './c-shared.test.mjs';

const MEETING = {
  id: 'm1',
  title: 'Weekly sync',
  created_at: '2026-09-01T15:00:00.000Z',
  url: 'https://fathom.video/share/m1',
  transcript: [
    { speaker: { display_name: 'Ana Ruiz', matched_calendar_invitee_email: 'ana@acme.com' }, text: 'Let’s start.' },
    { speaker: { display_name: 'Mike Brennan', matched_calendar_invitee_email: null }, text: 'Sounds good.' },
  ],
  default_summary: { markdown_formatted: '## Summary\nWe synced.' },
  action_items: [{ description: 'Send the deck' }, 'Follow up with legal'],
  recording_duration_in_seconds: 1800,
};

test('probe reports needsKey when no Fathom key is set', async () => {
  const ctx = fakeCtx({});
  ctx.getKey = () => null;
  const result = await probe(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.needsKey, true);
});

test('probe calls the list endpoint with limit 1 and reports ok', async () => {
  const fetchImpl = mockFetch([{ status: 200, json: { items: [MEETING] } }]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'fathom_key';
  const result = await probe(ctx);
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.searchParams.get('limit'), '1');
  assert.equal(fetchImpl.calls[0].opts.headers['X-Api-Key'], 'fathom_key');
});

test('extract throws needsKey when no key is set', async () => {
  const ctx = fakeCtx({});
  ctx.getKey = () => null;
  await assert.rejects(() => extract(ctx, { cursor: null }), (err) => err.needsKey === true);
});

test('extract maps a meeting to a valid meeting record with transcript, attendees and action items', async () => {
  const fetchImpl = mockFetch([{ status: 200, json: { items: [MEETING], next_cursor: null } }]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'fathom_key';
  const { records, cursor, done } = await extract(ctx, { cursor: null, limit: 25 });

  assert.equal(records.length, 1);
  const r = records[0];
  assert.deepEqual(check('record', r), []);
  assert.equal(r.id, 'fathom:m1');
  assert.equal(r.source, 'fathom');
  assert.equal(r.kind, 'meeting');
  assert.equal(r.thread, 'meeting:fathom:m1');
  assert.equal(r.title, 'Weekly sync');
  assert.equal(r.text, 'Ana Ruiz: Let’s start.\nMike Brennan: Sounds good.');
  assert.deepEqual(r.to, [
    { handle: 'mailto:ana@acme.com', name: 'Ana Ruiz' },
    { handle: 'name:mike brennan', name: 'Mike Brennan' },
  ]);
  assert.equal(r.meta.summary, '## Summary\nWe synced.');
  assert.deepEqual(r.meta.action_items, ['Send the deck', 'Follow up with legal']);
  assert.equal(r.meta.duration_s, 1800);
  assert.equal(r.meta.needs_transcript, false);
  assert.equal(done, true);
  const cursorState = JSON.parse(cursor);
  assert.equal(cursorState.page, null);
  assert.equal(cursorState.since, '2026-09-01T15:00:00.000Z');
});

test('extract follows next_cursor across pages, then switches to a since-based incremental cursor', async () => {
  const fetchImpl = mockFetch([
    { status: 200, json: { items: [MEETING], next_cursor: 'page2' } },
    { status: 200, json: { items: [], next_cursor: null } },
  ]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'fathom_key';

  const first = await extract(ctx, { cursor: null });
  assert.equal(first.done, false);
  const state1 = JSON.parse(first.cursor);
  assert.equal(state1.page, 'page2');

  const second = await extract(ctx, { cursor: first.cursor });
  assert.equal(second.done, true);
  const state2 = JSON.parse(second.cursor);
  assert.equal(state2.page, null);

  // Second call should have paged with Fathom's own cursor, not created_after.
  const secondUrl = new URL(fetchImpl.calls[1].url);
  assert.equal(secondUrl.searchParams.get('cursor'), 'page2');
  assert.equal(secondUrl.searchParams.has('created_after'), false);
});

test('a once-completed backfill sends created_after on the next run', async () => {
  const fetchImpl = mockFetch([{ status: 200, json: { items: [], next_cursor: null } }]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'fathom_key';
  const cursor = JSON.stringify({ page: null, since: '2026-09-01T15:00:00.000Z' });
  await extract(ctx, { cursor });
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.searchParams.get('created_after'), '2026-09-01T15:00:00.000Z');
});
