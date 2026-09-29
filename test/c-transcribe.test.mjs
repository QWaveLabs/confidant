import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribe } from '../engine/lib/c-transcribe.mjs';
import { fakeCtx, mockFetch } from './c-shared.test.mjs';

function tempAudioFile(bytes = 'not-really-audio') {
  const dir = mkdtempSync(join(tmpdir(), 'cf-audio-'));
  const path = join(dir, 'call.m4a');
  writeFileSync(path, bytes);
  return path;
}

test('returns null when there is no Deepgram key, without calling fetch', async () => {
  const fetchImpl = mockFetch([{ status: 200, json: {} }]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => null;
  const result = await transcribe(ctx, tempAudioFile(), { mimetype: 'audio/mp4' });
  assert.equal(result, null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('posts the audio bytes to Deepgram nova-3 with diarization and returns Speaker N: text lines', async () => {
  const dgResponse = {
    results: {
      utterances: [
        { speaker: 0, start: 0, end: 1.2, transcript: 'Hi there.' },
        { speaker: 1, start: 1.3, end: 2.5, transcript: 'Hello.' },
      ],
    },
  };
  const fetchImpl = mockFetch([{ status: 200, json: dgResponse }]);
  const ctx = fakeCtx({ fetchImpl, config: { language: 'en' } });
  ctx.getKey = () => 'dg_fake_key';

  const result = await transcribe(ctx, tempAudioFile(), { mimetype: 'audio/mp4' });

  assert.equal(result.provider, 'deepgram');
  assert.equal(result.text, 'Speaker 1: Hi there.\nSpeaker 2: Hello.');
  assert.deepEqual(result.utterances, [
    { speaker: 'Speaker 1', start: 0, end: 1.2, text: 'Hi there.' },
    { speaker: 'Speaker 2', start: 1.3, end: 2.5, text: 'Hello.' },
  ]);

  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers.Authorization, 'Token dg_fake_key');
  assert.equal(call.opts.headers['Content-Type'], 'audio/mp4');
  assert.equal(Buffer.isBuffer(call.opts.body) || typeof call.opts.body === 'string', true);
  const url = new URL(call.url);
  assert.equal(url.pathname, '/v1/listen');
  assert.equal(url.searchParams.get('model'), 'nova-3');
  assert.equal(url.searchParams.get('diarize'), 'true');
  assert.equal(url.searchParams.get('smart_format'), 'true');
  assert.equal(url.searchParams.get('utterances'), 'true');
  assert.equal(url.searchParams.get('punctuate'), 'true');
  assert.equal(url.searchParams.get('language'), 'en');
  assert.equal(url.searchParams.get('detect_language'), null);
});

test('uses detect_language when the vault has no language configured', async () => {
  const fetchImpl = mockFetch([{ status: 200, json: { results: { utterances: [] } } }]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'dg_fake_key';
  await transcribe(ctx, tempAudioFile(), {});
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.searchParams.get('detect_language'), 'true');
  assert.equal(url.searchParams.get('language'), null);
});

test('a missing file fails before any network call', async () => {
  const fetchImpl = mockFetch([{ status: 200, json: {} }]);
  const ctx = fakeCtx({ fetchImpl });
  ctx.getKey = () => 'dg_fake_key';
  const path = tempAudioFile();
  await assert.rejects(() => transcribe(ctx, `${path}.missing`, {}), /ENOENT/);
  assert.equal(fetchImpl.calls.length, 0);
});
