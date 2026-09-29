// Grain recordings (Personal Access Token). List and transcript are two
// calls per meeting; the list endpoint pages with an opaque cursor and can
// filter by a start date.
//
// Cursor (opaque JSON string): { page, since }.
//   - Backfill: `page` follows Grain's own response cursor until it comes
//     back null.
//   - Once a full pass finishes, `page` resets to null and `since` (the
//     newest recording's start_datetime seen) is sent as an
//     `after_datetime` filter on the next run, so later runs only ask for
//     what is new.
// cursor: null means "from the beginning," per the extractor contract.
//
// Grain's own docs describe `after_datetime`/`before_datetime` with
// wording that looks swapped (each says "after" while described as
// filtering to dates "before"); this uses the field named `after_datetime`
// to mean "only recordings since this instant," the natural reading of the
// name. Not verified against a live account; flagged in the final report.
import { getKey } from '../lib/c-keys.mjs';
import { request } from '../lib/c-http.mjs';
import { transcriptText } from '../lib/c-meeting.mjs';
import { emailHandle, nameHandle } from '../lib/handles.mjs';
import { toIso } from '../lib/time.mjs';

export const id = 'grain';

const BASE = 'https://api.grain.com/_/public-api/v2';
const API_VERSION = '2026-10-01';
// Documented: 30-request burst bucket refilling at 2 req/s (120/min sustained).
const RATE = { perMinute: 100 };

function headers(key) {
  return { Authorization: `Bearer ${key}`, 'Public-Api-Version': API_VERSION, 'Content-Type': 'application/json' };
}

async function listRecordings(ctx, key, { cursor, afterDatetime } = {}) {
  const body = { cursor: cursor ?? undefined, include: { participants: true, ai_summary: true, ai_action_items: true } };
  if (afterDatetime) body.filter = { after_datetime: afterDatetime };
  const res = await request(ctx, `${BASE}/recordings`, { method: 'POST', headers: headers(key), json: body, rateLimit: RATE, source: 'grain' });
  return JSON.parse(await res.text());
}

async function getTranscript(ctx, key, recordingId) {
  const res = await request(ctx, `${BASE}/recordings/${recordingId}/transcript`, { headers: headers(key), rateLimit: RATE, source: 'grain' });
  return JSON.parse(await res.text());
}

function toRecord(recording, transcriptRows) {
  const utterances = (transcriptRows ?? []).map((r) => ({ speaker: r.speaker, text: r.text }));
  const to = (recording.participants ?? [])
    .map((p) => ({ handle: (p.email && emailHandle(p.email)) ?? (p.name ? nameHandle(p.name) : null), name: p.name ?? null }))
    .filter((p) => p.handle);
  return {
    id: `grain:${recording.id}`,
    source: 'grain',
    kind: 'meeting',
    thread: `meeting:grain:${recording.id}`,
    ts: toIso(recording.start_datetime) ?? new Date().toISOString(),
    from: null,
    to,
    is_from_me: false,
    title: recording.title ?? null,
    text: transcriptText(utterances),
    url: recording.url ?? null,
    meta: {
      summary: recording.ai_summary?.text ?? null,
      action_items: (recording.ai_action_items ?? []).map((a) => a.text).filter(Boolean),
      duration_s: recording.duration_ms ? Math.round(recording.duration_ms / 1000) : null,
      needs_transcript: !utterances.some((u) => u.text),
    },
  };
}

export async function probe(ctx) {
  const key = (ctx.getKey ?? getKey)('grain');
  if (!key) return { ok: false, needsKey: true, reason: 'no Grain API key' };
  try {
    const data = await listRecordings(ctx, key, {});
    return { ok: true, count: data.recordings?.length ?? 0 };
  } catch (err) {
    return { ok: false, needsKey: !!err.needsKey, reason: err.message };
  }
}

export async function extract(ctx, { cursor }) {
  const key = (ctx.getKey ?? getKey)('grain');
  if (!key) {
    const err = new Error('no Grain API key');
    err.needsKey = true;
    throw err;
  }
  const state = cursor ? JSON.parse(cursor) : { page: null, since: null };
  const list = await listRecordings(ctx, key, { cursor: state.page, afterDatetime: state.page ? undefined : state.since });
  const items = list.recordings ?? [];
  const records = [];
  for (const r of items) records.push(toRecord(r, await getTranscript(ctx, key, r.id)));

  if (list.cursor) {
    return { records, cursor: JSON.stringify({ page: list.cursor, since: state.since }), done: false };
  }
  const newest = items.reduce((max, r) => (!max || (r.start_datetime && r.start_datetime > max) ? r.start_datetime : max), state.since);
  return { records, cursor: JSON.stringify({ page: null, since: newest ?? state.since }), done: true };
}
