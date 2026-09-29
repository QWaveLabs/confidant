// Fireflies transcripts via the GraphQL API. The free plan allows only 50
// requests a day; every request below asks for every field this extractor
// needs in one query, so one meeting costs one request.
//
// Cursor (opaque JSON string): { toDate, since, complete }.
//   - Backfill walks backward from now: each page's `toDate` becomes the
//     ISO instant just before the oldest transcript's date, so the next
//     page continues strictly older. Ends when a page returns fewer items
//     than the page size, or an empty page.
//   - Once the true beginning is reached, the cursor switches to
//     `{ complete: true, since }`. From then on every run fetches just the
//     newest page (up to 50 transcripts): cheap, and the store's own
//     dedupe (by content hash) makes re-seeing recent transcripts a no-op,
//     so this both catches new meetings and stays well under the daily cap.
// cursor: null means "from the beginning," per the extractor contract.
import { getKey } from '../lib/c-keys.mjs';
import { request } from '../lib/c-http.mjs';
import { transcriptText } from '../lib/c-meeting.mjs';
import { emailHandle, nameHandle } from '../lib/handles.mjs';
import { toIso } from '../lib/time.mjs';

export const id = 'fireflies';

const URL_ = 'https://api.fireflies.ai/graphql';
const PAGE_SIZE = 50; // Fireflies' documented max for `limit`

const QUERY = `query Transcripts($toDate: DateTime, $limit: Int, $skip: Int) {
  transcripts(toDate: $toDate, limit: $limit, skip: $skip, mine: true) {
    id
    title
    date
    duration
    speakers { id name }
    sentences { speaker_name text start_time end_time }
    summary { overview action_items }
    meeting_attendees { email displayName }
  }
}`;

async function graphql(ctx, key, variables) {
  const res = await request(ctx, URL_, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, json: { query: QUERY, variables }, source: 'fireflies' });
  const body = JSON.parse(await res.text());
  if (body.errors?.length) {
    const msg = body.errors.map((e) => e.message).join('; ');
    const err = new Error(`fireflies: ${msg}`);
    if (/day|daily|limit|quota/i.test(msg)) err.dailyLimit = true;
    if (/api key|unauthoriz|forbidden/i.test(msg)) err.needsKey = true;
    throw err;
  }
  return body.data;
}

function toRecord(t) {
  const utterances = (t.sentences ?? []).map((s) => ({ speaker: s.speaker_name, text: s.text }));
  const fromAttendees = (t.meeting_attendees ?? [])
    .map((a) => ({ handle: (a.email && emailHandle(a.email)) ?? (a.displayName ? nameHandle(a.displayName) : null), name: a.displayName ?? null }))
    .filter((p) => p.handle);
  const fromSpeakers = (t.speakers ?? []).map((s) => ({ handle: nameHandle(s.name), name: s.name })).filter((p) => p.handle);
  const to = fromAttendees.length ? fromAttendees : fromSpeakers;
  const actionItems = t.summary?.action_items
    ? String(t.summary.action_items).split('\n').map((s) => s.replace(/^[-*•]\s*/, '').trim()).filter(Boolean)
    : [];
  return {
    id: `fireflies:${t.id}`,
    source: 'fireflies',
    kind: 'meeting',
    thread: `meeting:fireflies:${t.id}`,
    ts: toIso(t.date) ?? new Date(t.date).toISOString(),
    from: null,
    to,
    is_from_me: false,
    title: t.title ?? null,
    text: transcriptText(utterances),
    url: null,
    meta: {
      summary: t.summary?.overview ?? null,
      action_items: actionItems,
      duration_s: t.duration ? Math.round(t.duration * 60) : null,
      needs_transcript: !utterances.some((u) => u.text),
    },
  };
}

export async function probe(ctx) {
  const key = (ctx.getKey ?? getKey)('fireflies');
  if (!key) return { ok: false, needsKey: true, reason: 'no Fireflies API key' };
  try {
    const data = await graphql(ctx, key, { limit: 1, skip: 0 });
    return { ok: true, count: data.transcripts?.length ?? 0 };
  } catch (err) {
    return { ok: false, needsKey: !!err.needsKey, reason: err.message };
  }
}

export async function extract(ctx, { cursor, limit = PAGE_SIZE }) {
  const key = (ctx.getKey ?? getKey)('fireflies');
  if (!key) {
    const err = new Error('no Fireflies API key');
    err.needsKey = true;
    throw err;
  }
  const n = Math.min(limit ?? PAGE_SIZE, PAGE_SIZE);
  const state = cursor ? JSON.parse(cursor) : { toDate: null, since: null, complete: false };

  let data;
  try {
    data = await graphql(ctx, key, { toDate: state.complete ? undefined : state.toDate ?? undefined, limit: n, skip: 0 });
  } catch (err) {
    if (err.dailyLimit) return { records: [], cursor, done: true }; // stop cleanly, resume next run
    throw err;
  }
  const items = data.transcripts ?? [];
  const records = items.map(toRecord);

  if (state.complete) {
    return { records, cursor: JSON.stringify({ toDate: null, since: state.since, complete: true }), done: true };
  }
  if (!items.length || items.length < n) {
    return { records, cursor: JSON.stringify({ toDate: null, since: state.since, complete: true }), done: true };
  }
  const oldest = items.reduce((min, t) => (t.date < min ? t.date : min), items[0].date);
  return { records, cursor: JSON.stringify({ toDate: new Date(oldest - 1).toISOString(), since: state.since, complete: false }), done: false };
}
