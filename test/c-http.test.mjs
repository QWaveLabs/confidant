import test from 'node:test';
import assert from 'node:assert/strict';
import { request, requestJson, HttpError } from '../engine/lib/c-http.mjs';
import { fakeCtx, mockFetch } from './c-shared.test.mjs';

test('requestJson parses a successful JSON response', async () => {
  const fetchImpl = mockFetch([{ status: 200, json: { ok: true } }]);
  const ctx = fakeCtx({ fetchImpl });
  const data = await requestJson(ctx, 'https://api.example.com/things', {});
  assert.deepEqual(data, { ok: true });
  assert.equal(fetchImpl.calls.length, 1);
});

test('401 becomes an HttpError with needsKey, and never retries', async () => {
  const fetchImpl = mockFetch([{ status: 401, text: 'nope' }]);
  const ctx = fakeCtx({ fetchImpl });
  await assert.rejects(
    () => request(ctx, 'https://api.example.com/things', { retries: 3 }),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.needsKey, true);
      assert.equal(err.status, 401);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test('403 also becomes needsKey', async () => {
  const fetchImpl = mockFetch([{ status: 403 }]);
  const ctx = fakeCtx({ fetchImpl });
  await assert.rejects(() => request(ctx, 'https://api.example.com/x', {}), (err) => err.needsKey === true);
});

test('429 retries and honors Retry-After, then succeeds', async () => {
  const fetchImpl = mockFetch([{ status: 429, headers: { 'retry-after': '2' } }, { status: 200, json: { ok: true } }]);
  const ctx = fakeCtx({ fetchImpl });
  const sleeps = [];
  ctx.sleep = async (ms) => sleeps.push(ms);
  const data = await requestJson(ctx, 'https://api.example.com/x', { retries: 2 });
  assert.deepEqual(data, { ok: true });
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
});

test('5xx retries with exponential backoff when no Retry-After is given', async () => {
  const fetchImpl = mockFetch([{ status: 503 }, { status: 503 }, { status: 200, json: { ok: true } }]);
  const ctx = fakeCtx({ fetchImpl });
  const sleeps = [];
  ctx.sleep = async (ms) => sleeps.push(ms);
  const data = await requestJson(ctx, 'https://api.example.com/x', { retries: 3 });
  assert.deepEqual(data, { ok: true });
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1] > sleeps[0], 'second backoff should be longer than the first');
});

test('gives up after exhausting retries and throws the last error', async () => {
  const fetchImpl = mockFetch([{ status: 500 }, { status: 500 }]);
  const ctx = fakeCtx({ fetchImpl });
  await assert.rejects(
    () => request(ctx, 'https://api.example.com/x', { retries: 1 }),
    (err) => {
      assert.equal(err.status, 500);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 2);
});

test('a plain 4xx (not 401/403/429) throws without retrying', async () => {
  const fetchImpl = mockFetch([{ status: 404, text: 'not found' }]);
  const ctx = fakeCtx({ fetchImpl });
  await assert.rejects(() => request(ctx, 'https://api.example.com/x', { retries: 3 }), (err) => err.status === 404);
  assert.equal(fetchImpl.calls.length, 1);
});

test('json option stringifies the body and sets Content-Type', async () => {
  const fetchImpl = mockFetch([{ status: 200, json: {} }]);
  const ctx = fakeCtx({ fetchImpl });
  await request(ctx, 'https://api.example.com/x', { method: 'POST', json: { a: 1 } });
  const call = fetchImpl.calls[0];
  assert.equal(call.opts.body, JSON.stringify({ a: 1 }));
  assert.equal(call.opts.headers['Content-Type'], 'application/json');
});

test('rate limiter blocks the (n+1)th call within a minute and lets it through after the window', async () => {
  const fetchImpl = mockFetch(() => ({ status: 200, json: { ok: true } }));
  const ctx = fakeCtx({ fetchImpl });
  let now = 0;
  const sleeps = [];
  ctx.sleep = async (ms) => {
    sleeps.push(ms);
    now += ms; // fast-forward the fake clock instead of really waiting
  };
  const clock = () => now;
  const opts = { rateLimit: { perMinute: 2 }, clock };
  await request(ctx, 'https://api.example.com/x', opts);
  await request(ctx, 'https://api.example.com/x', opts);
  await request(ctx, 'https://api.example.com/x', opts); // should have to wait
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 0);
});

test('rate limits are tracked per host', async () => {
  const fetchImpl = mockFetch(() => ({ status: 200, json: {} }));
  const ctx = fakeCtx({ fetchImpl });
  let now = 0;
  const sleeps = [];
  ctx.sleep = async (ms) => { sleeps.push(ms); now += ms; };
  const opts = { rateLimit: { perMinute: 1 }, clock: () => now };
  await request(ctx, 'https://a.example.com/x', opts);
  await request(ctx, 'https://b.example.com/x', opts); // different host, should not wait
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(sleeps.length, 0);
});
