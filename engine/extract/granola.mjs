// Granola notes (Business plan and up). The list endpoint takes
// `created_after` and pages with an opaque `cursor`; each note's transcript
// is a second call.
//
// Cursor (opaque JSON string): { page, since }.
//   - Backfill: `page` follows Granola's own response cursor until
//     `hasMore` is false.
//   - Once a full pass finishes, `page` resets to null and `since` (the
//     newest note's created_at seen) is sent as `created_after` on the next
//     run, so later runs only ask for what is new.
// cursor: null means "from the beginning," per the extractor contract.
import { getKey } from '../lib/c-keys.mjs';
import { request } from '../lib/c-http.mjs';
import { transcriptText } from '../lib/c-meeting.mjs';
import { emailHandle, nameHandle } from '../lib/handles.mjs';
import { toIso } from '../lib/time.mjs';

export const id = 'granola';

const BASE = 'https://public-api.granola.ai/v1';
const RATE = { perMinute: 280 }; // documented: 5 req/s sustained

async function listNotes(ctx, key, { cursor, createdAfter } = {}) {
  const params = new URLSearchParams();
  if (createdAfter) params.set('created_after', createdAfter);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  const res = await request(ctx, `${BASE}/notes${qs ? `?${qs}` : ''}`, { headers: { Authorization: `Bearer ${key}` }, rateLimit: RATE, source: 'granola' });
  return JSON.parse(await res.text());
}

async function getNote(ctx, key, noteId) {
  const res = await request(ctx, `${BASE}/notes/${noteId}?include=transcript`, { headers: { Authorization: `Bearer ${key}` }, rateLimit: RATE, source: 'granola' });
  return JSON.parse(await res.text());
}

function toRecord(note) {
  const utterances = (note.transcript ?? []).map((t) => ({ speaker: t.speaker?.diarization_label ?? t.speaker?.source ?? 'Unknown', text: t.text }));
  const owner = note.owner ? { handle: (note.owner.email && emailHandle(note.owner.email)) ?? (note.owner.name ? nameHandle(note.owner.name) : null), name: note.owner.name ?? null } : null;
  return {
    id: `granola:${note.id}`,
    source: 'granola',
    kind: 'meeting',
    thread: `meeting:granola:${note.id}`,
    ts: toIso(note.created_at ?? note.createdAt) ?? new Date().toISOString(),
    from: null,
    to: owner?.handle ? [owner] : [],
    is_from_me: false,
    title: note.title ?? null,
    text: transcriptText(utterances),
    url: note.url ?? null,
    meta: { summary: note.summary ?? null, action_items: [], duration_s: note.duration_s ?? null, needs_transcript: !utterances.some((u) => u.text) },
  };
}

export async function probe(ctx) {
  const key = (ctx.getKey ?? getKey)('granola');
  if (!key) return { ok: false, needsKey: true, reason: 'no Granola API key' };
  try {
    const data = await listNotes(ctx, key, {});
    return { ok: true, count: data.notes?.length ?? 0 };
  } catch (err) {
    return { ok: false, needsKey: !!err.needsKey, reason: err.message };
  }
}

export async function extract(ctx, { cursor }) {
  const key = (ctx.getKey ?? getKey)('granola');
  if (!key) {
    const err = new Error('no Granola API key');
    err.needsKey = true;
    throw err;
  }
  const state = cursor ? JSON.parse(cursor) : { page: null, since: null };
  const list = await listNotes(ctx, key, { cursor: state.page, createdAfter: state.page ? undefined : state.since });
  const notes = list.notes ?? [];
  const records = [];
  for (const n of notes) records.push(toRecord(await getNote(ctx, key, n.id)));

  const newest = notes.reduce((max, n) => {
    const t = toIso(n.created_at ?? n.createdAt);
    return !max || (t && t > max) ? t : max;
  }, state.since);
  if (list.hasMore && list.cursor) {
    return { records, cursor: JSON.stringify({ page: list.cursor, since: state.since }), done: false };
  }
  return { records, cursor: JSON.stringify({ page: null, since: newest ?? state.since }), done: true };
}
