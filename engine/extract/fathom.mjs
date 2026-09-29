// Fathom meetings: transcript, summary and action items all arrive in the
// list response, so extract() never makes a second call per meeting.
//
// Cursor (opaque JSON string): { page, since }.
//   - Backfill: `page` walks Fathom's own `next_cursor` until it runs out.
//   - Once backfilled, `page` stays null and `since` (the newest meeting's
//     created_at we have seen) is sent as `created_after` on every future
//     run, so a 3-hour update only asks Fathom for what is new.
// cursor: null means "from the beginning," per the extractor contract.
import { getKey } from '../lib/c-keys.mjs';
import { request } from '../lib/c-http.mjs';
import { transcriptText } from '../lib/c-meeting.mjs';
import { emailHandle, nameHandle } from '../lib/handles.mjs';
import { toIso } from '../lib/time.mjs';

export const id = 'fathom';

const BASE = 'https://api.fathom.ai/external/v1/meetings';
// Fathom's docs mark include_transcript requests as the heavy tier: 30/min.
const RATE = { perMinute: 30 };

async function listMeetings(ctx, key, { cursor, createdAfter, limit = 25 } = {}) {
  const params = new URLSearchParams({ include_transcript: 'true', include_summary: 'true', include_action_items: 'true' });
  if (limit) params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  else if (createdAfter) params.set('created_after', createdAfter);
  const res = await request(ctx, `${BASE}?${params}`, { headers: { 'X-Api-Key': key }, rateLimit: RATE, source: 'fathom' });
  const text = await res.text();
  return text ? JSON.parse(text) : { items: [] };
}

function attendeesFromTranscript(transcript) {
  const seen = new Map();
  for (const entry of transcript) {
    const name = entry?.speaker?.display_name ?? null;
    const email = entry?.speaker?.matched_calendar_invitee_email ?? null;
    const handle = (email && emailHandle(email)) ?? (name ? nameHandle(name) : null);
    if (!handle || seen.has(handle)) continue;
    seen.set(handle, { handle, name });
  }
  return [...seen.values()];
}

function attendeesFromInvitees(invitees) {
  return (invitees ?? [])
    .map((p) => ({ handle: (p.email && emailHandle(p.email)) ?? (p.name ? nameHandle(p.name) : null), name: p.name ?? null }))
    .filter((p) => p.handle);
}

function actionItemText(item) {
  if (typeof item === 'string') return item;
  return item?.description ?? item?.text ?? null;
}

function toRecord(meeting) {
  const transcript = meeting.transcript ?? [];
  const utterances = transcript.map((e) => ({ speaker: e?.speaker?.display_name, text: e.text }));
  const fromTranscript = attendeesFromTranscript(transcript);
  const to = fromTranscript.length ? fromTranscript : attendeesFromInvitees(meeting.calendar_invitees);
  const meetingId = meeting.id ?? meeting.recording_id;
  return {
    id: `fathom:${meetingId}`,
    source: 'fathom',
    kind: 'meeting',
    thread: `meeting:fathom:${meetingId}`,
    ts: toIso(meeting.created_at ?? meeting.scheduled_start_time) ?? new Date().toISOString(),
    from: null,
    to,
    is_from_me: false,
    title: meeting.title ?? meeting.meeting_title ?? null,
    text: transcriptText(utterances),
    url: meeting.url ?? meeting.share_url ?? null,
    meta: {
      summary: meeting.default_summary?.markdown_formatted ?? null,
      action_items: (meeting.action_items ?? []).map(actionItemText).filter(Boolean),
      duration_s: meeting.recording_duration_in_seconds ?? meeting.duration_seconds ?? null,
      needs_transcript: !utterances.some((u) => u.text),
    },
  };
}

export async function probe(ctx) {
  const key = (ctx.getKey ?? getKey)('fathom');
  if (!key) return { ok: false, needsKey: true, reason: 'no Fathom API key' };
  try {
    const data = await listMeetings(ctx, key, { limit: 1 });
    return { ok: true, count: data.items?.length ?? 0 };
  } catch (err) {
    return { ok: false, needsKey: !!err.needsKey, reason: err.message };
  }
}

export async function extract(ctx, { cursor, limit = 25 }) {
  const key = (ctx.getKey ?? getKey)('fathom');
  if (!key) {
    const err = new Error('no Fathom API key');
    err.needsKey = true;
    throw err;
  }
  const state = cursor ? JSON.parse(cursor) : { page: null, since: null };
  const data = await listMeetings(ctx, key, { cursor: state.page, createdAfter: state.page ? undefined : state.since, limit });
  const items = data.items ?? [];
  const records = items.map(toRecord);

  if (data.next_cursor) {
    return { records, cursor: JSON.stringify({ page: data.next_cursor, since: state.since }), done: false };
  }
  const newest = items.reduce((max, m) => {
    const t = m.created_at ?? m.scheduled_start_time;
    return !max || (t && t > max) ? t : max;
  }, state.since);
  return { records, cursor: JSON.stringify({ page: null, since: newest ?? state.since }), done: true };
}
