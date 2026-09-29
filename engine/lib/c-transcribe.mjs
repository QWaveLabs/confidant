// Deepgram transcription for audio Unit A's local extractors hand off
// (phone call recordings, Voice Memos, local Zoom recordings). Returns null
// when there is no Deepgram key, so the caller keeps the record with
// meta.needs_transcript = true and retries on a later run.
import { statSync, readFileSync } from 'node:fs';
import { getKey } from './c-keys.mjs';
import { request } from './c-http.mjs';

const MAX_BYTES = 2 * 1024 * 1024 * 1024; // Deepgram's file size limit
const PROCESSING_TIMEOUT_MS = 10 * 60 * 1000; // long audio can take a while

function buildUrl(lang) {
  const params = new URLSearchParams({ model: 'nova-3', diarize: 'true', smart_format: 'true', utterances: 'true', punctuate: 'true' });
  if (lang) params.set('language', lang);
  else params.set('detect_language', 'true');
  return `https://api.deepgram.com/v1/listen?${params}`;
}

function toUtterances(data) {
  const list = data?.results?.utterances ?? [];
  return list.map((u) => ({ speaker: `Speaker ${(u.speaker ?? 0) + 1}`, start: u.start ?? 0, end: u.end ?? 0, text: (u.transcript ?? '').trim() }));
}

function toText(utterances) {
  return utterances
    .filter((u) => u.text)
    .map((u) => `${u.speaker}: ${u.text}`)
    .join('\n');
}

export async function transcribe(ctx, filePath, { mimetype = 'audio/mp4' } = {}) {
  const key = (ctx.getKey ?? getKey)('deepgram');
  if (!key) return null;
  const { size } = statSync(filePath);
  if (size > MAX_BYTES) throw new Error(`${filePath}: larger than Deepgram's 2 GB limit`);
  const bytes = readFileSync(filePath);
  const lang = ctx?.config?.language ?? null;
  const res = await request(ctx, buildUrl(lang), {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': mimetype },
    body: bytes,
    timeoutMs: PROCESSING_TIMEOUT_MS,
    retries: 2,
    source: 'deepgram',
  });
  const data = JSON.parse(await res.text());
  const utterances = toUtterances(data);
  return { text: toText(utterances), utterances, provider: 'deepgram' };
}
