// `confidant ingest --source <gmail|gcal|drive|slack|plaud> --file <path|->
//     [--cursor-key <key>] [--cursor-value <value>]`
//
// Stores records Codex already read through a connected app. Reads the
// whole file as JSON (an array, an object with one obvious list property,
// or a single object) or JSONL (one JSON value per line), maps every item
// to a record shaped like schemas/record.schema.json, validates,
// privacy-filters, and upserts. Liberal in what it accepts, because a
// Codex app's tool output shape can vary by version:
//
// --source gmail: a raw Gmail API message resource
//   {id, threadId, internalDate, labelIds,
//    payload: {headers:[{name,value}], body:{data}, parts:[...]}, snippet}
//   or a flattened shape {id, thread_id|threadId, subject, from, to, cc,
//   date|internalDate, body|text|snippet, labels}.
//
// --source gcal: a Calendar API event resource
//   {id, summary, description, location, htmlLink, hangoutLink,
//    start:{dateTime|date}, end:{...}, organizer:{email,displayName},
//    attendees:[{email,displayName}], status}
//   or a flattened {id, title, start, end, attendees, description, url}.
//
// --source drive: a Drive file plus its exported text
//   {id, name, mimeType, modifiedTime|modifiedDate, webViewLink,
//    owners:[{emailAddress,displayName}]|lastModifyingUser, text|content}.
//   A Google Meet notes doc uses the same shape; its exported text is the
//   meeting notes.
//
// --source slack: a conversations.history message
//   {ts, thread_ts, user, user_profile:{real_name}, text, channel,
//    permalink, reactions}, or a channel read's wrapper
//   {channel:{id,name}, team, messages:[...]} (wrapper fields are copied
//   onto every message that does not already carry them).
//
// --source plaud: an export or tool item
//   {id, title, created_at|date, duration, transcript|text, summary,
//    participants:[{name,email}|"name"]}.
//
// Any item that already looks like a full record (has string `source`,
// `kind`, `ts` and `text`) is passed through as-is, still validated and
// privacy-filtered.
import { readFileSync } from 'node:fs';
import { check } from './lib/schema.mjs';
import { emailHandle, nameHandle, slackHandle } from './lib/handles.mjs';
import { toIso, fromUnix } from './lib/time.mjs';

// Fails closed: without the privacy filter nothing is stored.
async function loadPrivacy() {
  const mod = await import('./privacy.mjs');
  if (!mod?.filterRecord) throw new Error('The privacy filter (engine/privacy.mjs) is missing, so nothing was stored.');
  return mod;
}

const MAX_TEXT = 200000;

function* jsonlItems(text) {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t) yield JSON.parse(t);
  }
}

const LIST_KEYS = ['items', 'messages', 'results', 'files', 'events', 'threads', 'data'];

export function readItems(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let parsed;
  let isJson = true;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    isJson = false;
  }
  if (!isJson) return [...jsonlItems(trimmed)];
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const listKey = LIST_KEYS.find((k) => Array.isArray(parsed[k]));
    if (listKey) {
      const context = { ...parsed };
      delete context[listKey];
      return parsed[listKey].map((it) => (it && typeof it === 'object' && !Array.isArray(it) ? { ...it, _context: context } : it));
    }
    return [parsed];
  }
  return [];
}

function isFullRecord(item) {
  return !!item && typeof item === 'object' && typeof item.source === 'string' && typeof item.kind === 'string' && typeof item.ts === 'string' && typeof item.text === 'string';
}

// -- gmail -------------------------------------------------------------
function gmailHeader(headers, name) {
  return (headers ?? []).find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function b64url(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function decodeGmailBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return b64url(payload.body.data);
  if (payload.mimeType === 'text/html' && payload.body?.data) return stripHtml(b64url(payload.body.data));
  if (payload.parts) {
    const plain = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (plain?.body?.data) return b64url(plain.body.data);
    const html = payload.parts.find((p) => p.mimeType === 'text/html');
    if (html?.body?.data) return stripHtml(b64url(html.body.data));
    for (const part of payload.parts) {
      const text = decodeGmailBody(part);
      if (text) return text;
    }
  }
  if (payload.body?.data) return b64url(payload.body.data);
  return '';
}

function parseAddressList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(.*?)<([^>]+)>$/);
      const name = m ? m[1].trim().replace(/^"|"$/g, '') || null : null;
      const email = m ? m[2].trim() : s;
      return { handle: emailHandle(email), name };
    })
    .filter((p) => p.handle);
}

function mapGmail(item, { ownerHandles, account }) {
  if (isFullRecord(item)) return account ? { ...item, meta: { ...(item.meta ?? {}), account } } : item;
  const headers = item.payload?.headers;
  const subject = headers ? gmailHeader(headers, 'Subject') : (item.subject ?? item.title ?? null);
  const fromRaw = headers ? gmailHeader(headers, 'From') : item.from;
  const toRaw = headers ? gmailHeader(headers, 'To') : item.to;
  const ccRaw = headers ? gmailHeader(headers, 'Cc') : item.cc;
  const dateRaw = headers ? gmailHeader(headers, 'Date') : (item.date ?? null);
  const from = parseAddressList(fromRaw)[0] ?? null;
  const to = [...parseAddressList(toRaw), ...parseAddressList(ccRaw)];
  const text = item.payload ? decodeGmailBody(item.payload) || item.snippet || '' : (item.body ?? item.text ?? item.snippet ?? '');
  const ts = item.internalDate ? fromUnix(item.internalDate) : (toIso(dateRaw) ?? new Date().toISOString());
  const threadId = item.threadId ?? item.thread_id ?? item.id;
  return {
    id: `gmail:${item.id ?? `${threadId}:${ts}`}`,
    source: 'gmail',
    kind: 'email',
    thread: `email:${threadId}`,
    ts,
    from,
    to,
    is_from_me: from ? ownerHandles.has(from.handle) : false,
    title: subject,
    text: text || '',
    url: item.id ? `https://mail.google.com/mail/u/0/#all/${item.id}` : null,
    // The connected Gmail account, so emailAccounts exclusions apply to it.
    meta: { labels: item.labelIds ?? item.labels ?? [], ...(account ? { account } : {}) },
  };
}

// -- gcal ----------------------------------------------------------------
function mapGcal(item, { ownerHandles }) {
  if (isFullRecord(item)) return item;
  const start = item.start?.dateTime ?? item.start?.date ?? item.start;
  const end = item.end?.dateTime ?? item.end?.date ?? item.end;
  const to = (item.attendees ?? item.invitees ?? [])
    .map((a) => ({ handle: (a.email && emailHandle(a.email)) ?? (a.displayName || a.name ? nameHandle(a.displayName ?? a.name) : null), name: a.displayName ?? a.name ?? null }))
    .filter((p) => p.handle);
  const organizerEmail = item.organizer?.email ?? (typeof item.organizer === 'string' ? item.organizer : null);
  const from = organizerEmail ? { handle: emailHandle(organizerEmail), name: item.organizer?.displayName ?? null } : null;
  const text = [item.description ?? '', item.location ? `Location: ${item.location}` : ''].filter(Boolean).join('\n\n');
  return {
    id: `gcal:${item.id}`,
    source: 'gcal',
    kind: 'event',
    thread: `calendar:${item.id}`,
    ts: toIso(start) ?? new Date().toISOString(),
    from,
    to,
    is_from_me: from ? ownerHandles.has(from.handle) : false,
    title: item.summary ?? item.title ?? null,
    text,
    url: item.htmlLink ?? item.url ?? null,
    meta: { end: toIso(end), location: item.location ?? null, meetingLink: item.hangoutLink ?? item.meetingLink ?? null, status: item.status ?? null },
  };
}

// -- drive -----------------------------------------------------------------
function mapDrive(item, { ownerHandles }) {
  if (isFullRecord(item)) return item;
  const owner = (item.owners ?? [])[0] ?? item.lastModifyingUser ?? null;
  const ownerEmail = owner?.emailAddress ?? owner?.email ?? null;
  const from = owner ? { handle: ownerEmail ? emailHandle(ownerEmail) : (owner.displayName ? nameHandle(owner.displayName) : null), name: owner.displayName ?? owner.name ?? null } : null;
  return {
    id: `drive:${item.id}`,
    source: 'drive',
    kind: 'doc',
    thread: null,
    ts: toIso(item.modifiedTime ?? item.modifiedDate ?? item.updatedTime) ?? new Date().toISOString(),
    from,
    to: [],
    is_from_me: from ? ownerHandles.has(from.handle) : false,
    title: item.name ?? item.title ?? null,
    text: item.text ?? item.content ?? item.exportedText ?? item.body ?? '',
    url: item.webViewLink ?? item.url ?? null,
    meta: { mimeType: item.mimeType ?? null, path: item.path ?? null },
  };
}

// -- slack -------------------------------------------------------------
function slackChannelId(item) {
  const c = item.channel ?? item._context?.channel ?? item._context?.id;
  if (!c) return item.channel_id ?? 'unknown';
  return typeof c === 'string' ? c : (c.id ?? c.name ?? 'unknown');
}

function slackChannelName(item) {
  const c = item.channel ?? item._context?.channel;
  return (typeof c === 'object' ? c?.name : null) ?? item.channel_name ?? null;
}

function fromSlackTs(ts) {
  const n = Number(ts);
  return Number.isFinite(n) ? new Date(n * 1000).toISOString() : new Date().toISOString();
}

function mapSlack(item, { ownerHandles }) {
  if (isFullRecord(item)) return item;
  const channelId = slackChannelId(item);
  const team = item.team ?? item._context?.team ?? '';
  const userId = item.user ?? item.user_id ?? item.userId ?? null;
  const userName = item.user_profile?.real_name ?? item.username ?? item.user_name ?? null;
  const from = userId ? { handle: slackHandle(team, userId), name: userName } : (userName ? { handle: nameHandle(userName), name: userName } : null);
  const ts = item.ts ? fromSlackTs(item.ts) : (toIso(item.date ?? item.timestamp) ?? new Date().toISOString());
  return {
    id: `slack:${channelId}:${item.ts ?? item.id ?? ts}`,
    source: 'slack',
    kind: 'message',
    thread: `slack:${channelId}`,
    ts,
    from,
    to: [],
    is_from_me: from ? ownerHandles.has(from.handle) : false,
    title: null,
    text: item.text ?? item.message ?? '',
    url: item.permalink ?? null,
    meta: { channel: channelId, channelName: slackChannelName(item), threadTs: item.thread_ts ?? item._context?.thread_ts ?? null },
  };
}

// -- plaud -------------------------------------------------------------
function mapPlaud(item) {
  if (isFullRecord(item)) return item;
  const to = (item.participants ?? [])
    .map((p) => (typeof p === 'string' ? { handle: nameHandle(p), name: p } : { handle: (p.email && emailHandle(p.email)) ?? (p.name ? nameHandle(p.name) : null), name: p.name ?? null }))
    .filter((p) => p.handle);
  return {
    id: `plaud:${item.id}`,
    source: 'plaud',
    kind: 'recording',
    thread: `meeting:plaud:${item.id}`,
    ts: toIso(item.created_at ?? item.date ?? item.recordedAt) ?? new Date().toISOString(),
    from: null,
    to,
    is_from_me: false,
    title: item.title ?? null,
    text: item.transcript ?? item.text ?? '',
    url: item.url ?? null,
    meta: { summary: item.summary ?? null, duration_s: item.duration ?? item.duration_s ?? null },
  };
}

const MAPPERS = { gmail: mapGmail, gcal: mapGcal, drive: mapDrive, slack: mapSlack, plaud: mapPlaud };

export async function run(args, ctx) {
  const source = args.source;
  if (!source || !MAPPERS[source]) {
    ctx.log.error(`--source must be one of ${Object.keys(MAPPERS).join(', ')}.`);
    return 2;
  }
  const filePath = args.file;
  if (!filePath) {
    ctx.log.error('--file <path|-> is required.');
    return 2;
  }
  const raw = filePath === '-' ? readFileSync(0, 'utf8') : readFileSync(filePath, 'utf8');
  const items = readItems(raw);
  const ownerHandles = new Set((ctx.config?.owner?.emails ?? []).map(emailHandle).filter(Boolean));
  const account = typeof args.account === 'string' ? args.account.trim().toLowerCase() : null;
  const privacy = await loadPrivacy();
  if (args.cursorKey && !String(args.cursorKey).startsWith(source)) {
    ctx.log.error(`--cursor-key must start with "${source}" so it can never move another source's cursor.`);
    return 2;
  }

  const totals = { source, read: items.length, inserted: 0, updated: 0, unchanged: 0, excluded: 0, invalid: 0 };
  const keep = [];
  for (const item of items) {
    let record;
    try {
      record = MAPPERS[source](item, { ownerHandles, account });
    } catch {
      totals.invalid++;
      continue;
    }
    // A record read through the <source> app can only be a <source> record:
    // it can never overwrite iMessage or email rows, or carry an id it made up.
    if (!record || record.source !== source || typeof record.id !== 'string' || !record.id.startsWith(`${source}:`) || /:undefined(:|$)/.test(record.id)) {
      totals.invalid++;
      continue;
    }
    if (typeof record.text === 'string' && record.text.length > MAX_TEXT) record.text = `${record.text.slice(0, MAX_TEXT)}\n[...]`;
    if (check('record', record).length) {
      totals.invalid++;
      continue;
    }
    if (!privacy.filterRecord(record, ctx.config).keep) {
      totals.excluded++;
      continue;
    }
    keep.push(record);
  }

  if (!ctx.dryRun) {
    const counts = ctx.store.upsertRecords(keep);
    totals.inserted = counts.inserted;
    totals.updated = counts.updated;
    totals.unchanged = counts.unchanged;
    if (args.cursorKey) ctx.store.setCursor(String(args.cursorKey), args.cursorValue != null ? String(args.cursorValue) : new Date().toISOString());
  } else {
    totals.inserted = keep.length;
  }

  ctx.log.out(totals, () => `${source}: read ${totals.read}, +${totals.inserted} new, ${totals.updated} updated, ${totals.excluded} left out, ${totals.invalid} invalid`);
  return 0;
}
