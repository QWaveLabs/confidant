// tl;dv meetings, transcript and notes (summary, topics) via the v1alpha1
// REST API. Programmatic access depends on the meeting organizer's plan
// (Pro/Business/Enterprise); a Free organizer's meetings are visible in the
// UI but come back 403 here, which the http helper turns into needsKey.
//
// Cursor (opaque JSON string): { page, since }.
//   - GET /meetings pages by page number, not an opaque token, so backfill
//     just increments `page` until `page >= pages`.
//   - Once a full pass finishes, `page` resets to 1 and `since` (the
//     newest meeting's happenedAt seen) is sent as the `from` filter, so
//     later runs only ask for what is new.
// cursor: null means "from the beginning," per the extractor contract.
import { getKey } from '../lib/c-keys.mjs';
import { request } from '../lib/c-http.mjs';
import { transcriptText } from '../lib/c-meeting.mjs';
import { emailHandle, nameHandle } from '../lib/handles.mjs';
import { toIso } from '../lib/time.mjs';

export const id = 'tldv';

const BASE = 'https://pasta.tldv.io/v1alpha1';
const PAGE_SIZE = 50;

function headers(key) {
  return { 'x-api-key': key, 'Content-Type': 'application/json' };
}

async function listMeetings(ctx, key, { page = 1, from } = {}) {
  const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
  if (from) qs.set('from', from);
  const res = await request(ctx, `${BASE}/meetings?${qs}`, { headers: headers(key), source: 'tldv' });
  return JSON.parse(await res.text());
}

async function getTranscript(ctx, key, meetingId) {
  const res = await request(ctx, `${BASE}/meetings/${meetingId}/transcript`, { headers: headers(key), source: 'tldv' });
  return JSON.parse(await res.text());
}

// Notes can 404 while a meeting's summary is still being generated; that is
// not a failure worth stopping the run for.
async function getNotes(ctx, key, meetingId) {
  try {
    const res = await request(ctx, `${BASE}/meetings/${meetingId}/notes`, { headers: headers(key), source: 'tldv', retries: 0 });
    return JSON.parse(await res.text());
  } catch {
    return null;
  }
}

function toRecord(meeting, transcript, notes) {
  const utterances = (transcript?.data ?? []).map((s) => ({ speaker: s.speaker, text: s.text }));
  const attendees = [meeting.organizer, ...(meeting.invitees ?? [])].filter(Boolean);
  const to = attendees
    .map((p) => ({ handle: (p.email && emailHandle(p.email)) ?? (p.name ? nameHandle(p.name) : null), name: p.name ?? null }))
    .filter((p) => p.handle);
  const actionItems = (notes?.structuredNotes ?? []).map((n) => n.text).filter(Boolean);
  return {
    id: `tldv:${meeting.id}`,
    source: 'tldv',
    kind: 'meeting',
    thread: `meeting:tldv:${meeting.id}`,
    ts: toIso(meeting.happenedAt) ?? new Date().toISOString(),
    from: null,
    to,
    is_from_me: false,
    title: meeting.name ?? null,
    text: transcriptText(utterances),
    url: meeting.url ?? null,
    meta: { summary: notes?.markdownContent ?? null, action_items: actionItems, duration_s: meeting.duration ?? null, needs_transcript: !utterances.some((u) => u.text) },
  };
}

export async function probe(ctx) {
  const key = (ctx.getKey ?? getKey)('tldv');
  if (!key) return { ok: false, needsKey: true, reason: 'no tl;dv API key' };
  try {
    const data = await listMeetings(ctx, key, {});
    return { ok: true, count: data.results?.length ?? 0 };
  } catch (err) {
    return { ok: false, needsKey: !!err.needsKey, reason: err.message };
  }
}

export async function extract(ctx, { cursor }) {
  const key = (ctx.getKey ?? getKey)('tldv');
  if (!key) {
    const err = new Error('no tl;dv API key');
    err.needsKey = true;
    throw err;
  }
  const state = cursor ? JSON.parse(cursor) : { page: 1, since: null };
  const list = await listMeetings(ctx, key, { page: state.page, from: state.page > 1 ? undefined : state.since });
  const items = list.results ?? [];
  const records = [];
  for (const m of items) {
    const [transcript, notes] = await Promise.all([getTranscript(ctx, key, m.id).catch(() => null), getNotes(ctx, key, m.id)]);
    records.push(toRecord(m, transcript, notes));
  }

  const morePages = (list.page ?? state.page) < (list.pages ?? state.page);
  if (morePages) {
    return { records, cursor: JSON.stringify({ page: state.page + 1, since: state.since }), done: false };
  }
  const newest = items.reduce((max, m) => (!max || (m.happenedAt && m.happenedAt > max) ? m.happenedAt : max), state.since);
  return { records, cursor: JSON.stringify({ page: 1, since: newest ?? state.since }), done: true };
}
