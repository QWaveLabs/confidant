// Wispr Flow, from ~/Library/Application Support/Wispr Flow/.
//   flow.sqlite  Meetings (id, title, createdAt, modifiedAt, endedAt,
//                participantNames, notes, summary, speakerMap,
//                calendarEventExternalId, isDeleted)
//                History (dictations: transcriptEntityId, asrText, formattedText,
//                editedText, timestamp, app, url, duration, numWords)
//   meetings/<id>/refined.ndjson   one { id, speaker, text, timestamp } per line
// Meetings become kind meeting records with "Speaker: line" transcripts.
// Dictations only when config.sources.wispr.dictations is true (off by
// default: dictated text usually already sits in iMessage or Slack).
// Column names are read defensively: this schema is not documented.
// Cursor: { mt, hs } watermarks (modifiedAt, timestamp) via pendingPage.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nameHandle } from '../lib/handles.mjs';
import { libraryPath, unreadable, openCopy, columns, tableNames, pendingPage, readCursor, writeCursor, ownerParty, cleanText, clip, looseDate } from '../lib/a-local.mjs';
import { guardProbe, guardExtract } from '../lib/a-reasons.mjs';

export const id = 'wispr';
export const appDir = (ctx) => libraryPath(ctx, 'Application Support', 'Wispr Flow');
export const dbPath = (ctx) => join(appDir(ctx), 'flow.sqlite');

const json = (v, fallback) => {
  if (v == null || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};

function names(value) {
  const parsed = json(value, null);
  const list = Array.isArray(parsed) ? parsed : typeof value === 'string' ? value.split(/[,;\n]/) : [];
  return list.map((x) => (typeof x === 'string' ? x : x?.name ?? x?.displayName ?? '')).map((s) => String(s).trim()).filter(Boolean);
}

function speakerNames(value) {
  const parsed = json(value, {});
  if (Array.isArray(parsed)) return Object.fromEntries(parsed.map((s) => [s.id ?? s.speaker ?? s.key, s.name ?? s.label]).filter(([k, v]) => k != null && v));
  return Object.fromEntries(Object.entries(parsed ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : v?.name ?? v?.label]).filter(([, v]) => v));
}

function table(db, ...candidates) {
  const t = tableNames(db);
  for (const c of candidates) if (t.has(c.toLowerCase())) return t.get(c.toLowerCase());
  return null;
}

function readMeetings(db) {
  const name = table(db, 'Meetings', 'Meeting');
  if (!name) return [];
  const c = columns(db, name);
  return db
    .prepare(
      `SELECT ${c.first('id', 'meetingId') ?? 'rowid'} AS id, ${c.pick('title')}, ${c.pick('createdAt', 'created')}, ${c.pick('modifiedAt', 'modified')}, ${c.pick('endedAt', 'ended')},
        ${c.pick('participantNames', 'participants')}, ${c.pick('notes')}, ${c.pick('summary')}, ${c.pick('speakerMap', 'speakers')},
        ${c.pick('calendarEventExternalId', 'calendar_id')}, ${c.pick('isDeleted', 'deleted')}, ${c.pick('transcript')}
       FROM "${name}"`,
    )
    .all()
    .filter((m) => !Number(m.deleted));
}

function transcriptLines(ctx, meeting) {
  const dir = join(appDir(ctx), 'meetings', String(meeting.id));
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.ndjson'));
  } catch {}
  files.sort((a, b) => (a === 'refined.ndjson' ? -1 : b === 'refined.ndjson' ? 1 : a.localeCompare(b)));
  for (const f of files) {
    const rows = [];
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {}
    }
    if (rows.length) return rows;
  }
  const inline = json(meeting.transcript, null);
  if (Array.isArray(inline)) return inline;
  if (typeof meeting.transcript === 'string' && meeting.transcript.trim()) return [{ speaker: null, text: meeting.transcript }];
  return [];
}

function format(rows, speakers) {
  const out = [];
  for (const r of rows) {
    const text = cleanText(r.text ?? r.content ?? '');
    if (!text) continue;
    const raw = r.speaker ?? r.speakerId ?? null;
    let who = null;
    if (raw != null) {
      const numbered = /^(?:speaker[_ ]?)?(\d+)$/i.exec(String(raw));
      who = speakers[raw] ?? (numbered ? `Speaker ${numbered[1]}` : String(raw));
    }
    const last = out.at(-1);
    if (last && last.who === who) last.text += ` ${text}`;
    else out.push({ who, text });
  }
  return out.map((r) => (r.who ? `${r.who}: ${r.text}` : r.text)).join('\n');
}

function meetingRecord(ctx, m) {
  const ts = looseDate(m.created) ?? looseDate(m.modified);
  if (!ts) return null;
  const speakers = speakerNames(m.speakers);
  const rows = transcriptLines(ctx, m);
  const text = clip(format(rows, speakers), 200000);
  const owner = ctx.config?.owner?.name?.trim().toLowerCase();
  const people = [...new Set([...names(m.participants), ...Object.values(speakers)])].filter((n) => n.toLowerCase() !== owner);
  const ended = looseDate(m.ended);
  const meta = { item_id: String(m.id) };
  if (m.summary) meta.summary = cleanText(typeof m.summary === 'string' ? m.summary : JSON.stringify(m.summary));
  if (m.notes) meta.notes = cleanText(m.notes);
  if (ended) meta.duration_s = Math.max(0, Math.round((Date.parse(ended) - Date.parse(ts)) / 1000));
  if (m.calendar_id) meta.calendar_event_id = String(m.calendar_id);
  if (Object.keys(speakers).length) meta.speakers = Object.values(speakers);
  if (!text) meta.needs_transcript = true;
  return {
    id: `wispr:${m.id}`,
    source: 'wispr',
    kind: 'meeting',
    thread: `meeting:wispr:${m.id}`,
    ts,
    from: null,
    to: people.map((n) => ({ handle: nameHandle(n), name: n })),
    is_from_me: false,
    title: m.title ? String(m.title).trim() : null,
    text,
    url: null,
    meta,
  };
}

function readHistory(db) {
  const name = table(db, 'History');
  if (!name) return [];
  const c = columns(db, name);
  const key = c.first('transcriptEntityId', 'id');
  if (!key) return [];
  return db
    .prepare(
      `SELECT ${key} AS id, ${c.pick('asrText', 'asr')}, ${c.pick('formattedText', 'formatted')}, ${c.pick('editedText', 'edited')}, ${c.pick('timestamp', 'at')},
        ${c.pick('app')}, ${c.pick('url')}, ${c.pick('duration')}, ${c.pick('numWords', 'words')}, ${c.pick('isArchived', 'archived')}
       FROM "${name}"`,
    )
    .all();
}

function dictationRecord(ctx, h) {
  const ts = looseDate(h.at);
  const text = cleanText(h.edited || h.formatted || h.asr);
  if (!ts || !text) return null;
  const meta = { item_id: String(h.id) };
  if (h.app) meta.app = String(h.app);
  if (h.url) meta.url = String(h.url);
  if (h.duration != null) meta.duration_s = Math.round(Number(h.duration));
  if (h.words != null) meta.words = Number(h.words);
  return { id: `wispr:h:${h.id}`, source: 'wispr', kind: 'dictation', thread: null, ts, from: ownerParty(ctx), to: [], is_from_me: true, title: null, text, url: null, meta };
}

async function runProbe(ctx) {
  const path = dbPath(ctx);
  const bad = unreadable(ctx, id, path, 'Wispr Flow database');
  if (bad) return bad;
  const db = openCopy(ctx, path);
  return { ok: true, count: readMeetings(db).length };
}

const markOf = (...values) => {
  for (const v of values) {
    const iso = looseDate(v);
    if (iso) return Date.parse(iso);
  }
  return 0;
};

async function runExtract(ctx, { cursor, limit = 2000 } = {}) {
  const path = dbPath(ctx);
  if (!existsSync(path)) return { records: [], cursor, done: true };
  const db = openCopy(ctx, path);
  const c = readCursor(cursor) ?? {};
  const meetings = readMeetings(db).map((m) => ({ ...m, id: String(m.id), mark: markOf(m.modified, m.ended, m.created) }));
  const mt = await pendingPage(c.mt ?? null, meetings, { limit, build: (items) => items.map((m) => meetingRecord(ctx, m)).filter(Boolean) });
  const records = [...mt.records];
  let hs = { cursor: c.hs ?? null, done: true };
  if (ctx.config?.sources?.wispr?.dictations === true && mt.done && records.length < limit) {
    const history = readHistory(db).filter((h) => !Number(h.archived)).map((h) => ({ ...h, id: String(h.id), mark: markOf(h.at) }));
    hs = await pendingPage(c.hs ?? null, history, { limit: limit - records.length, build: (items) => items.map((h) => dictationRecord(ctx, h)).filter(Boolean) });
    records.push(...hs.records);
  }
  return { records, cursor: writeCursor({ mt: mt.cursor, hs: hs.cursor }), done: mt.done && hs.done };
}

export const probe = guardProbe(id, runProbe);
export const extract = guardExtract(id, runExtract);
