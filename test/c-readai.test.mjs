import test from 'node:test';
import assert from 'node:assert/strict';
import { probe, extract } from '../engine/extract/readai.mjs';
import { check } from '../engine/lib/schema.mjs';
import { fakeCtx, mockFetch } from './c-shared.test.mjs';

const CRED = 'client_abc:secret_xyz:refresh_1';

function tokenResponse(refreshToken = 'refresh_1') {
  return { status: 200, json: { access_token: 'access_tok', refresh_token: refreshToken, expires_in: 599, token_type: 'bearer' } };
}

const MEETING_SUMMARY = { id: 'mtg1', start_time_ms: 1733800000000 };
const MEETING_FULL = {
  id: 'mtg1',
  title: 'Weekly status sync',
  start_time_ms: 1733800000000,
  end_time_ms: 1733803600000,
  report_url: 'https://app.read.ai/analytics/meetings/mtg1',
  participants: [{ name: 'Alice Example', email: 'alice@example.com' }],
  summary: 'We reviewed timelines.',
  transcript: { turns: [{ speaker: { name: 'Alice Example' }, text: "Let's start." }] },
};

test('probe reports needsKey when no Read.ai credential is set', async () => {
  const ctx = fakeCtx({});
  ctx.getKey = () => null;
  const result = await probe(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.needsKey, true);
});

test('probe reports needsKey when the stored credential is not the 3-part composite', async () => {
  const ctx = fakeCtx({});
  ctx.getKey = () => 'just-one-value';
  const result = await probe(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.needsKey, true);
});

test('extract refreshes an access token with Basic auth before listing meetings', async () => {
  const fetchImpl = mockFetch([tokenResponse(), { status: 200, json: { object: 'list', data: [MEETING_SUMMARY], has_more: false } }, tokenResponse(), { status: 200, json: MEETING_FULL }]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => CRED;

  const { records } = await extract(ctx, { cursor: null });

  assert.equal(records.length, 1);
  const r = records[0];
  assert.deepEqual(check('record', r), []);
  assert.equal(r.id, 'readai:mtg1');
  assert.equal(r.title, 'Weekly status sync');
  assert.equal(r.text, "Alice Example: Let's start.");
  assert.deepEqual(r.to, [{ handle: 'mailto:alice@example.com', name: 'Alice Example' }]);
  assert.equal(r.meta.duration_s, 3600);

  const tokenCall = fetchImpl.calls[0];
  assert.equal(tokenCall.url, 'https://authn.read.ai/oauth2/token');
  const expectedBasic = Buffer.from('client_abc:secret_xyz').toString('base64');
  assert.equal(tokenCall.opts.headers.Authorization, `Basic ${expectedBasic}`);
  assert.ok(tokenCall.opts.body.includes('refresh_token=refresh_1'));

  const listCall = fetchImpl.calls[1];
  assert.equal(listCall.opts.headers.Authorization, 'Bearer access_tok');
});

test('a rotated refresh token is written back to Keychain via ctx.setKey, never returned or logged', async () => {
  const fetchImpl = mockFetch([tokenResponse('refresh_2'), { status: 200, json: { object: 'list', data: [], has_more: false } }]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => CRED;
  let saved = null;
  ctx.setKey = (name, value) => { saved = { name, value }; };

  await extract(ctx, { cursor: null });

  assert.deepEqual(saved, { name: 'readai', value: 'client_abc:secret_xyz:refresh_2' });
});

test('extract throws needsKey when no credential is stored', async () => {
  const ctx = fakeCtx({});
  ctx.getKey = () => null;
  await assert.rejects(() => extract(ctx, { cursor: null }), (err) => err.needsKey === true);
});

test('extract sends start_time_ms.gte from the cursor watermark and updates it from the newest meeting', async () => {
  const fetchImpl = mockFetch([tokenResponse(), { status: 200, json: { object: 'list', data: [MEETING_SUMMARY], has_more: false } }, tokenResponse(), { status: 200, json: MEETING_FULL }]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => CRED;
  const cursor = JSON.stringify({ since: 1733700000000 });

  const result = await extract(ctx, { cursor });

  const listUrl = new URL(fetchImpl.calls[1].url);
  assert.equal(listUrl.searchParams.get('start_time_ms.gte'), '1733700000000');
  assert.deepEqual(JSON.parse(result.cursor), { since: 1733800000000 });
  assert.equal(result.done, true);
});
