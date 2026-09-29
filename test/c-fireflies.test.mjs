import test from 'node:test';
import assert from 'node:assert/strict';
import { probe, extract } from '../engine/extract/fireflies.mjs';
import { check } from '../engine/lib/schema.mjs';
import { fakeCtx, mockFetch } from './c-shared.test.mjs';

function transcript(id, date, over = {}) {
  return {
    id,
    title: `Call ${id}`,
    date,
    duration: 30,
    speakers: [{ id: 's1', name: 'Ana' }],
    sentences: [{ speaker_name: 'Ana', text: 'Hi.' }],
    summary: { overview: 'A quick call.', action_items: '- Send the recap\n- Book a follow-up' },
    meeting_attendees: [{ email: 'ana@acme.com', displayName: 'Ana Ruiz' }],
    ...over,
  };
}

function gqlOk(transcripts) {
  return { status: 200, json: { data: { transcripts } } };
}

test('probe reports needsKey when no Fireflies key is set', async () => {
  const ctx = fakeCtx({});
  ctx.getKey = () => null;
  const result = await probe(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.needsKey, true);
});

test('a GraphQL "unauthorized" error is surfaced as needsKey', async () => {
  const fetchImpl = mockFetch([{ status: 200, json: { errors: [{ message: 'Your API key is unauthorized' }] } }]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'ff_key';
  const result = await probe(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.needsKey, true);
});

test('extract maps a transcript to a valid meeting record', async () => {
  const fetchImpl = mockFetch([gqlOk([transcript('t1', 1756742400000)])]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'ff_key';
  const { records } = await extract(ctx, { cursor: null });
  assert.equal(records.length, 1);
  const r = records[0];
  assert.deepEqual(check('record', r), []);
  assert.equal(r.id, 'fireflies:t1');
  assert.equal(r.text, 'Ana: Hi.');
  assert.deepEqual(r.to, [{ handle: 'mailto:ana@acme.com', name: 'Ana Ruiz' }]);
  assert.equal(r.meta.summary, 'A quick call.');
  assert.deepEqual(r.meta.action_items, ['Send the recap', 'Book a follow-up']);
  assert.equal(r.meta.duration_s, 1800);
});

test('backfill walks backward and switches to complete:true once a short page is seen', async () => {
  const fetchImpl = mockFetch([gqlOk([transcript('t1', 5000), transcript('t2', 4000)])]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'ff_key';
  const { cursor, done } = await extract(ctx, { cursor: null, limit: 50 }); // page smaller than limit -> complete
  assert.equal(done, true);
  const state = JSON.parse(cursor);
  assert.equal(state.complete, true);
});

test('once complete, extract fetches only the newest page (no toDate) every run', async () => {
  const fetchImpl = mockFetch(() => gqlOk([transcript('t3', 9000)]));
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'ff_key';
  const cursor = JSON.stringify({ toDate: null, since: null, complete: true });
  await extract(ctx, { cursor });
  const body = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(body.variables.toDate, undefined);
});

test('a daily-limit GraphQL error stops cleanly and keeps the same cursor to resume next run', async () => {
  const fetchImpl = mockFetch([{ status: 200, json: { errors: [{ message: 'You have reached your daily limit of 50 requests' }] } }]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'ff_key';
  const cursor = JSON.stringify({ toDate: '2026-08-01T00:00:00.000Z', since: null, complete: false });
  const result = await extract(ctx, { cursor });
  assert.deepEqual(result.records, []);
  assert.equal(result.done, true);
  assert.equal(result.cursor, cursor); // unchanged: nothing was lost
});
