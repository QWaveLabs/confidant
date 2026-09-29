// Read.ai meetings. Unlike the other five API sources, Read.ai's API is not
// a single self-serve key: it is full OAuth 2.1 with dynamic client
// registration, a one-time browser consent step, 10-minute access tokens,
// and refresh tokens that rotate on every use. There is no page that hands
// out one paste-able key.
//
// So `confidant keys set readai` stores a composite credential, entered
// once after the one-time browser flow documented in
// .agents/skills/confidant-install/recipes/keys.md:
//   "client_id:client_secret:refresh_token"
// Every call here exchanges the refresh token for a fresh access token
// first. Because the refresh token rotates, the new one is written straight
// back to Keychain via setKey (never shown, never logged).
//
// Cursor (opaque JSON string): { since }, the newest meeting's
// start_time_ms seen so far, sent as `start_time_ms.gte` on every call.
// Read.ai's published docs show only that filter and a `has_more` flag on
// the list response, with no documented "go further back within one page"
// parameter, so deep backward pagination beyond one page (`limit`) per run
// is not implemented here; see the final report.
import { getKey, setKey } from '../lib/c-keys.mjs';
import { request } from '../lib/c-http.mjs';
import { transcriptText } from '../lib/c-meeting.mjs';
import { emailHandle, nameHandle } from '../lib/handles.mjs';
import { toIso } from '../lib/time.mjs';

export const id = 'readai';

const BASE = 'https://api.read.ai/v1';
const TOKEN_URL = 'https://authn.read.ai/oauth2/token';
const PAGE_LIMIT = 25;

function parseCredential(raw) {
  const parts = String(raw).split(':');
  if (parts.length !== 3) return null;
  const [clientId, clientSecret, refreshToken] = parts;
  return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : null;
}

async function refreshAccessToken(ctx, cred) {
  const basic = Buffer.from(`${cred.clientId}:${cred.clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cred.refreshToken });
  const res = await request(ctx, TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    source: 'readai',
  });
  const data = JSON.parse(await res.text());
  if (data.refresh_token && data.refresh_token !== cred.refreshToken) {
    (ctx.setKey ?? setKey)('readai', `${cred.clientId}:${cred.clientSecret}:${data.refresh_token}`);
  }
  return data.access_token;
}

async function authed(ctx, cred, path) {
  const token = await refreshAccessToken(ctx, cred);
  return request(ctx, `${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` }, source: 'readai' });
}

async function listMeetings(ctx, cred, { sinceMs } = {}) {
  const qs = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (sinceMs) qs.set('start_time_ms.gte', String(sinceMs));
  const res = await authed(ctx, cred, `/meetings?${qs}`);
  return JSON.parse(await res.text());
}

async function getMeeting(ctx, cred, meetingId) {
  const res = await authed(ctx, cred, `/meetings/${meetingId}?expand[]=summary&expand[]=transcript`);
  return JSON.parse(await res.text());
}

function toRecord(m) {
  const utterances = (m.transcript?.turns ?? []).map((t) => ({ speaker: t.speaker?.name, text: t.text }));
  const to = (m.participants ?? [])
    .map((p) => ({ handle: (p.email && emailHandle(p.email)) ?? (p.name ? nameHandle(p.name) : null), name: p.name ?? null }))
    .filter((p) => p.handle);
  return {
    id: `readai:${m.id}`,
    source: 'readai',
    kind: 'meeting',
    thread: `meeting:readai:${m.id}`,
    ts: toIso(m.start_time_ms) ?? new Date().toISOString(),
    from: null,
    to,
    is_from_me: false,
    title: m.title ?? null,
    text: transcriptText(utterances),
    url: m.report_url ?? null,
    meta: {
      summary: m.summary ?? null,
      action_items: [],
      duration_s: m.end_time_ms && m.start_time_ms ? Math.round((m.end_time_ms - m.start_time_ms) / 1000) : null,
      needs_transcript: !utterances.some((u) => u.text),
    },
  };
}

export async function probe(ctx) {
  const raw = (ctx.getKey ?? getKey)('readai');
  if (!raw) return { ok: false, needsKey: true, reason: 'no Read.ai credential' };
  const cred = parseCredential(raw);
  if (!cred) return { ok: false, needsKey: true, reason: 'Read.ai credential is incomplete, run keys set readai again' };
  try {
    const data = await listMeetings(ctx, cred, {});
    return { ok: true, count: data.data?.length ?? 0 };
  } catch (err) {
    return { ok: false, needsKey: !!err.needsKey, reason: err.message };
  }
}

export async function extract(ctx, { cursor }) {
  const raw = (ctx.getKey ?? getKey)('readai');
  if (!raw) {
    const err = new Error('no Read.ai credential');
    err.needsKey = true;
    throw err;
  }
  const cred = parseCredential(raw);
  if (!cred) {
    const err = new Error('Read.ai credential is incomplete, run keys set readai again');
    err.needsKey = true;
    throw err;
  }
  const state = cursor ? JSON.parse(cursor) : { since: null };
  const list = await listMeetings(ctx, cred, { sinceMs: state.since });
  const items = list.data ?? [];
  const records = [];
  for (const item of items) records.push(toRecord(await getMeeting(ctx, cred, item.id)));

  const newest = items.reduce((max, m) => (!max || (m.start_time_ms && m.start_time_ms > max) ? m.start_time_ms : max), state.since);
  return { records, cursor: JSON.stringify({ since: newest ?? state.since }), done: true };
}
