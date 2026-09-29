import test from 'node:test';
import assert from 'node:assert/strict';
import { probe, extract } from '../engine/extract/grain.mjs';
import { check } from '../engine/lib/schema.mjs';
import { fakeCtx, mockFetch } from './c-shared.test.mjs';

const RECORDING = {
  id: 'rec1',
  title: 'All Hands',
  start_datetime: '2026-01-01T09:30:00Z',
  duration_ms: 1800000,
  url: 'https://grain.com/share/recording/rec1',
  participants: [{ name: 'Luke Skywalker', email: 'luke@example.com' }],
  ai_summary: { text: 'We covered roadmap.' },
  ai_action_items: [{ text: 'Ship the release' }],
};
const TRANSCRIPT = [{ start: 8000, end: 9000, text: 'Hello there.', speaker: 'Obi Wan' }];

test('probe reports needsKey when no Grain key is set', async () => {
  const ctx = fakeCtx({});
  ctx.getKey = () => null;
  const result = await probe(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.needsKey, true);
});

test('extract lists recordings, fetches each transcript, and sends the version header', async () => {
  const fetchImpl = mockFetch([
    { status: 200, json: { cursor: null, recordings: [RECORDING] } },
    { status: 200, json: TRANSCRIPT },
  ]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'grain_pat';
  const { records, cursor, done } = await extract(ctx, { cursor: null });

  assert.equal(records.length, 1);
  const r = records[0];
  assert.deepEqual(check('record', r), []);
  assert.equal(r.id, 'grain:rec1');
  assert.equal(r.text, 'Obi Wan: Hello there.');
  assert.deepEqual(r.to, [{ handle: 'mailto:luke@example.com', name: 'Luke Skywalker' }]);
  assert.equal(r.meta.summary, 'We covered roadmap.');
  assert.deepEqual(r.meta.action_items, ['Ship the release']);
  assert.equal(r.meta.duration_s, 1800);
  assert.equal(done, true);
  assert.deepEqual(JSON.parse(cursor), { page: null, since: '2026-01-01T09:30:00Z' });

  for (const call of fetchImpl.calls) assert.equal(call.opts.headers['Public-Api-Version'], '2026-10-01');
  assert.equal(fetchImpl.calls[0].opts.method, 'POST');
});

test('follows a returned cursor across pages before settling on a since watermark', async () => {
  const fetchImpl = mockFetch([
    { status: 200, json: { cursor: 'page2', recordings: [RECORDING] } },
    { status: 200, json: TRANSCRIPT },
  ]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'grain_pat';
  const { cursor, done } = await extract(ctx, { cursor: null });
  assert.equal(done, false);
  assert.deepEqual(JSON.parse(cursor), { page: 'page2', since: null });
});

test('a completed backfill sends after_datetime and omits the cursor', async () => {
  const fetchImpl = mockFetch([{ status: 200, json: { cursor: null, recordings: [] } }]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'grain_pat';
  const cursor = JSON.stringify({ page: null, since: '2026-01-01T09:30:00Z' });
  await extract(ctx, { cursor });
  const body = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.deepEqual(body.filter, { after_datetime: '2026-01-01T09:30:00Z' });
  assert.equal(body.cursor, undefined);
});
