import test from 'node:test';
import assert from 'node:assert/strict';
import { probe, extract } from '../engine/extract/tldv.mjs';
import { check } from '../engine/lib/schema.mjs';
import { fakeCtx, mockFetch } from './c-shared.test.mjs';

const MEETING = {
  id: 'mt1',
  name: 'Kickoff',
  happenedAt: '2026-09-03T14:00:00.000Z',
  duration: 1500,
  url: 'https://tldv.io/meetings/mt1',
  organizer: { name: 'Jane Doe', email: 'jane@example.com' },
  invitees: [{ name: 'John Roe', email: 'john@example.com' }],
};
const TRANSCRIPT = { id: 'tr1', meetingId: 'mt1', data: [{ speaker: 'Jane Doe', text: 'Welcome everyone.', startTime: 0, endTime: 5 }] };
const NOTES = { markdownContent: '## Summary\nGood kickoff.', structuredNotes: [{ segmentId: 's1', timestamp: 12, text: 'Follow up next week', topicId: 't1' }] };

function listResponse(page, pages, results) {
  return { status: 200, json: { page, pages, total: results.length, pageSize: results.length, results } };
}

test('probe reports needsKey when no tl;dv key is set', async () => {
  const ctx = fakeCtx({});
  ctx.getKey = () => null;
  const result = await probe(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.needsKey, true);
});

test('extract maps a meeting with its transcript and notes into a valid record', async () => {
  const fetchImpl = mockFetch([listResponse(1, 1, [MEETING]), { status: 200, json: TRANSCRIPT }, { status: 200, json: NOTES }]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'tldv_key';
  const { records, cursor, done } = await extract(ctx, { cursor: null });

  assert.equal(records.length, 1);
  const r = records[0];
  assert.deepEqual(check('record', r), []);
  assert.equal(r.id, 'tldv:mt1');
  assert.equal(r.text, 'Jane Doe: Welcome everyone.');
  assert.deepEqual(r.to, [
    { handle: 'mailto:jane@example.com', name: 'Jane Doe' },
    { handle: 'mailto:john@example.com', name: 'John Roe' },
  ]);
  assert.equal(r.meta.summary, '## Summary\nGood kickoff.');
  assert.deepEqual(r.meta.action_items, ['Follow up next week']);
  assert.equal(r.meta.duration_s, 1500);
  assert.equal(done, true);
  assert.deepEqual(JSON.parse(cursor), { page: 1, since: '2026-09-03T14:00:00.000Z' });

  assert.equal(fetchImpl.calls[0].opts.headers['x-api-key'], 'tldv_key');
});

test('pages forward while page < pages, then settles on a since watermark', async () => {
  const fetchImpl = mockFetch([
    listResponse(1, 2, [MEETING]),
    { status: 200, json: TRANSCRIPT },
    { status: 200, json: NOTES },
  ]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'tldv_key';
  const { cursor, done } = await extract(ctx, { cursor: null });
  assert.equal(done, false);
  assert.deepEqual(JSON.parse(cursor), { page: 2, since: null });
});

test('a missing notes response (still processing) does not fail the record', async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes('/notes')) return { status: 404, json: { name: 'NotFoundError', message: 'not ready' } };
    if (url.includes('/transcript')) return { status: 200, json: TRANSCRIPT };
    return listResponse(1, 1, [MEETING]);
  });
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'tldv_key';
  const { records } = await extract(ctx, { cursor: null });
  assert.equal(records.length, 1);
  assert.equal(records[0].meta.summary, null);
  assert.deepEqual(check('record', records[0]), []);
});

test('a completed backfill sends the since watermark as `from` on page 1 only', async () => {
  const fetchImpl = mockFetch([listResponse(1, 1, [])]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'tldv_key';
  const cursor = JSON.stringify({ page: 1, since: '2026-09-03T14:00:00.000Z' });
  await extract(ctx, { cursor });
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.searchParams.get('from'), '2026-09-03T14:00:00.000Z');
});
