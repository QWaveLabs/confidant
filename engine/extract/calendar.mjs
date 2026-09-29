// Calendar events from ~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb
// (older macOS: ~/Library/Calendars/Calendar.sqlitedb). Every account the
// Calendar app syncs (iCloud, Google, Exchange) lands here.
//   CalendarItem   summary, start_date/end_date (seconds since 2001), start_tz
//                  ('_float' = wall clock), all_day, calendar_id, location_id,
//                  organizer_id, url, conference_url(_detected), UUID,
//                  unique_identifier, last_modified, has_recurrences, orig_item_id,
//                  entity_type (2 = event), hidden, status
//   Participant    owner_id -> CalendarItem, email, status, role, is_self, identity_id -> Identity
//   OccurrenceCache event_id, occurrence_date, occurrence_end_date: expanded repeats
// One record per occurrence, through today + 60 days (meeting prep needs the
// week ahead). kind event, ts = start, thread calendar:<series id>.
// Cursor: a full pass by id, then each run re-reads changed items, events that
// just entered the window, and the next two weeks.
import { existsSync } from 'node:fs';
import { emailHandle, normalizeEmail } from '../lib/handles.mjs';
import { fromAppleTime, localDate } from '../lib/time.mjs';
import { libraryPath, unreadable, openCopy, columns, tableNames, readCursor, writeCursor, ownerOf, zonedToUtc, cleanText, clip } from '../lib/a-local.mjs';

export const id = 'calendar';
const AHEAD_DAYS = 60;
const RECHECK_DAYS = 14;
const APPLE_EPOCH = 978307200;
const STATUS = { 0: 'unknown', 1: 'pending', 2: 'accepted', 3: 'declined', 4: 'tentative', 5: 'delegated', 6: 'completed', 7: 'in-process' };
const EVENT_STATUS = { 1: 'confirmed', 2: 'tentative', 3: 'cancelled' };
const SKIP_CALENDAR = /holiday|feriado|festivo|birthdays|cumpleaños|siri suggestions|sugerencias de siri|found in (mail|apps)/i;
const CONFERENCE = /https?:\/\/[^\s<>"')]*(zoom\.us\/(j|my|w)\/|meet\.google\.com\/|teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com\/meet|webex\.com\/(meet|join|[a-z0-9.]+\/j\.php)|whereby\.com\/|meet\.around\.co\/|app\.gather\.town\/)[^\s<>"')]*/i;

export function dbPath(ctx) {
  const modern = libraryPath(ctx, 'Group Containers', 'group.com.apple.calendar', 'Calendar.sqlitedb');
  const legacy = libraryPath(ctx, 'Calendars', 'Calendar.sqlitedb');
  return existsSync(modern) || !existsSync(legacy) ? modern : legacy;
}

export async function probe(ctx) {
  const path = dbPath(ctx);
  const bad = unreadable(path, 'Calendar database');
  if (bad) return bad;
  const db = openCopy(ctx, path);
  const c = columns(db, 'CalendarItem');
  return { ok: true, count: db.prepare(`SELECT COUNT(*) AS n FROM CalendarItem${c.has('entity_type') ? ' WHERE entity_type = 2' : ''}`).get().n };
}

// Apple seconds -> { iso, date }. Floating and all-day values are wall clock
// times stored as if UTC; they are read in the person's time zone.
function when(sec, tz, { floating, allDay }) {
  if (sec == null) return null;
  const n = Number(sec);
  if (!Number.isFinite(n)) return null;
  const wall = new Date((n + APPLE_EPOCH) * 1000);
  if (allDay) {
    const date = n % 86400 === 0 ? wall.toISOString().slice(0, 10) : localDate(wall, tz);
    const [y, m, d] = date.split('-').map(Number);
    return { iso: zonedToUtc({ year: y, month: m, day: d }, tz), date };
  }
  if (floating) {
    const iso = zonedToUtc({ year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate(), hour: wall.getUTCHours(), minute: wall.getUTCMinutes(), second: wall.getUTCSeconds() }, tz);
    return { iso, date: localDate(iso, tz) };
  }
  const iso = fromAppleTime(n);
  return { iso, date: localDate(iso, tz) };
}

const CACHE = new WeakMap();

function load(db) {
  if (CACHE.has(db)) return CACHE.get(db);
  const tables = tableNames(db);
  const ic = columns(db, 'CalendarItem');
  const cc = columns(db, 'Calendar');
  const sc = tables.has('store') ? columns(db, 'Store') : null;
  const calendars = new Map();
  const storeJoin = sc && cc.has('store_id');
  for (const c of db
    .prepare(
      `SELECT c.ROWID AS rowid, ${cc.pick('title', 'title', 'c.title')}, ${storeJoin ? `${sc.pick('name', 'store', 's.name')}, ${sc.pick('type', 'store_type', 's.type')}, ${sc.pick('disabled', 'disabled', 's.disabled')}` : 'NULL AS store, NULL AS store_type, NULL AS disabled'}
       FROM Calendar c ${storeJoin ? 'LEFT JOIN Store s ON s.ROWID = c.store_id' : ''}`,
    )
    .all()) {
    const skip = Number(c.disabled) === 1 || [5, 6].includes(Number(c.store_type)) || SKIP_CALENDAR.test(c.title ?? '');
    calendars.set(c.rowid, { title: c.title ?? null, account: c.store ?? null, skip });
  }
  const where = [ic.has('entity_type') ? 'i.entity_type = 2' : null, ic.has('hidden') ? '(i.hidden IS NULL OR i.hidden = 0)' : null].filter(Boolean);
  const items = db
    .prepare(
      `SELECT i.ROWID AS rowid, ${ic.pick('summary', 'summary', 'i.summary')}, ${ic.pick('description', 'description', 'i.description')},
        i.start_date AS start_date, ${ic.pick('end_date', 'end_date', 'i.end_date')}, ${ic.pick('start_tz', 'start_tz', 'i.start_tz')},
        ${ic.pick('all_day', 'all_day', 'i.all_day')}, ${ic.pick('calendar_id', 'calendar_id', 'i.calendar_id')}, ${ic.pick('location_id', 'location_id', 'i.location_id')},
        ${ic.pick('organizer_id', 'organizer_id', 'i.organizer_id')}, ${ic.pick('self_attendee_id', 'self_id', 'i.self_attendee_id')}, ${ic.pick('status', 'status', 'i.status')},
        ${ic.pick('url', 'url', 'i.url')}, ${ic.pick('conference_url', 'conference_url', 'i.conference_url')}, ${ic.pick('conference_url_detected', 'conference_detected', 'i.conference_url_detected')},
        ${ic.pick('UUID', 'uuid', 'i.UUID')}, ${ic.pick('unique_identifier', 'uid', 'i.unique_identifier')}, ${ic.pick('last_modified', 'modified', 'i.last_modified')},
        ${ic.pick('has_recurrences', 'recurs', 'i.has_recurrences')}, ${ic.pick('orig_item_id', 'orig_id', 'i.orig_item_id')}, ${ic.pick('birthday_id', 'birthday', 'i.birthday_id')}
       FROM CalendarItem i ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    )
    .all();
  const locations = new Map();
  if (tables.has('location')) {
    const lc = columns(db, 'Location');
    for (const l of db.prepare(`SELECT ROWID AS rowid, ${lc.pick('title')}, ${lc.pick('address')} FROM Location`).all()) locations.set(l.rowid, l);
  }
  const participants = new Map();
  const byRowid = new Map();
  if (tables.has('participant')) {
    const pc = columns(db, 'Participant');
    const identity = tables.has('identity') && pc.has('identity_id');
    for (const p of db
      .prepare(
        `SELECT p.ROWID AS rowid, p.owner_id AS owner, ${pc.pick('email', 'email', 'p.email')}, ${pc.pick('status', 'status', 'p.status')}, ${pc.pick('role', 'role', 'p.role')},
          ${pc.pick('is_self', 'is_self', 'p.is_self')}, ${identity ? 'i.display_name AS display_name, i.address AS address, i.first_name AS first, i.last_name AS last' : 'NULL AS display_name, NULL AS address, NULL AS first, NULL AS last'}
         FROM Participant p ${identity ? 'LEFT JOIN Identity i ON i.rowid = p.identity_id' : ''}`,
      )
      .all()) {
      const email = normalizeEmail(p.email) ?? normalizeEmail(String(p.address ?? '').replace(/^mailto:/i, ''));
      const name = (p.display_name && String(p.display_name).trim()) || [p.first, p.last].filter(Boolean).join(' ').trim() || null;
      const party = { rowid: p.rowid, handle: email ? emailHandle(email) : null, name, status: STATUS[Number(p.status)] ?? null, self: !!Number(p.is_self) };
      byRowid.set(p.rowid, party);
      if (!participants.has(p.owner)) participants.set(p.owner, []);
      participants.get(p.owner).push(party);
    }
  }
  const occurrences = new Map();
  if (tables.has('occurrencecache')) {
    const oc = columns(db, 'OccurrenceCache');
    for (const o of db.prepare(`SELECT event_id AS event, occurrence_date AS start, ${oc.pick('occurrence_end_date', 'end')} FROM OccurrenceCache`).all()) {
      if (!occurrences.has(o.event)) occurrences.set(o.event, []);
      occurrences.get(o.event).push(o);
    }
  }
  const value = { calendars, items, locations, participants, byRowid, occurrences };
  CACHE.set(db, value);
  return value;
}

function conferenceLink(item, location) {
  if (item.conference_url) return String(item.conference_url);
  if (item.conference_detected && /^https?:/i.test(String(item.conference_detected))) return String(item.conference_detected);
  for (const s of [item.url, location, item.description]) {
    const m = CONFERENCE.exec(String(s ?? ''));
    if (m) return m[0];
  }
  return null;
}

// Every event instance with start <= horizon, sorted by record id.
function instances(ctx, data, horizonMs) {
  const tz = ctx.tz ?? ctx.config?.timezone ?? 'UTC';
  const owner = ownerOf(ctx);
  const byRow = new Map(data.items.map((i) => [i.rowid, i]));
  const out = [];
  for (const item of data.items) {
    const cal = data.calendars.get(item.calendar_id);
    if (cal?.skip || Number(item.birthday) > 0) continue;
    const master = Number(item.orig_id) > 0 ? byRow.get(Number(item.orig_id)) ?? item : item;
    const series = master.uid || master.uuid || `row${master.rowid}`;
    const opts = { floating: item.start_tz === '_float', allDay: !!Number(item.all_day) };
    const duration = item.end_date != null ? Number(item.end_date) - Number(item.start_date) : 0;
    const locRow = data.locations.get(item.location_id);
    const location = [locRow?.title, locRow?.address && locRow.address !== locRow.title ? locRow.address : null].filter(Boolean).join(', ') || null;
    const people = data.participants.get(item.rowid) ?? [];
    const organizer = data.byRowid.get(item.organizer_id) ?? null;
    const attendees = people.filter((p) => p.rowid !== item.organizer_id);
    const me = people.find((p) => p.self || (p.handle && owner.isMe(p.handle))) ?? data.byRowid.get(item.self_id) ?? null;
    const organizerIsMe = !organizer || organizer.self || owner.isMe(organizer.handle);
    const link = conferenceLink(item, location);
    const recurring = !!Number(item.recurs);
    const slots = recurring && data.occurrences.get(item.rowid)?.length ? data.occurrences.get(item.rowid).map((o) => ({ start: o.start, end: o.end ?? Number(o.start) + duration, occ: true })) : [{ start: item.start_date, end: item.end_date, occ: false }];
    const base = item.uuid || item.uid || `row${item.rowid}`;
    for (const slot of slots) {
      const start = when(slot.start, tz, opts);
      if (!start?.iso) continue;
      const startMs = Date.parse(start.iso);
      if (startMs > horizonMs) continue;
      const end = when(slot.end, tz, opts);
      out.push({
        id: slot.occ ? `calendar:${base}@${start.iso}` : `calendar:${base}`,
        mark: Number(item.modified ?? master.modified ?? 0),
        startMs,
        build: () => ({
          id: slot.occ ? `calendar:${base}@${start.iso}` : `calendar:${base}`,
          source: 'calendar',
          kind: 'event',
          thread: `calendar:${series}`,
          ts: start.iso,
          from: organizer ? { handle: organizer.handle, name: organizer.name } : organizerIsMe ? { handle: owner.handle, name: owner.name } : null,
          to: attendees.map((p) => ({ handle: p.handle, name: p.name })),
          is_from_me: !!organizerIsMe,
          title: item.summary ? String(item.summary).trim() : null,
          text: clip(cleanText(item.description), 4000),
          url: link ?? (item.url ? String(item.url) : null),
          meta: {
            start: opts.allDay ? start.date : start.iso,
            end: end ? (opts.allDay ? end.date : end.iso) : null,
            all_day: opts.allDay,
            location,
            calendar: cal?.title ?? null,
            account: cal?.account ?? null,
            organizer: organizer ? organizer.handle ?? organizer.name : null,
            conference_url: link,
            ...(item.url ? { event_url: String(item.url) } : {}),
            ...(EVENT_STATUS[Number(item.status)] ? { status: EVENT_STATUS[Number(item.status)] } : {}),
            ...(me?.status ? { my_status: me.status } : {}),
            ...(attendees.length ? { attendee_status: Object.fromEntries(attendees.filter((p) => p.handle && p.status).map((p) => [p.handle, p.status])) } : {}),
            ...(recurring || master !== item ? { recurring: true } : {}),
          },
        }),
      });
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

export async function extract(ctx, { cursor, limit = 2000 } = {}) {
  const path = dbPath(ctx);
  if (!existsSync(path)) return { records: [], cursor, done: true };
  const db = openCopy(ctx, path);
  const data = load(db);
  const nowMs = new Date(ctx.now ?? Date.now()).getTime();
  const horizon = nowMs + AHEAD_DAYS * 86400000;
  const all = instances(ctx, data, horizon);
  const maxMark = all.reduce((m, it) => Math.max(m, it.mark), 0);
  const c = readCursor(cursor) ?? {};
  let pool;
  let next;
  if (c.phase !== 'inc') {
    // First pass: everything, in id order.
    const mod = c.mod ?? maxMark;
    pool = all;
    next = (pos, finished) => (finished ? { phase: 'inc', mod, hz: c.hz ?? horizon, pos: null } : { phase: 'full', mod, hz: c.hz ?? horizon, pos });
  } else {
    const soonFrom = nowMs - 86400000;
    const soonTo = nowMs + RECHECK_DAYS * 86400000;
    pool = all.filter((it) => it.mark > c.mod || it.startMs > c.hz || (it.startMs >= soonFrom && it.startMs <= soonTo));
    next = (pos, finished) => (finished ? { phase: 'inc', mod: Math.max(c.mod, maxMark), hz: horizon, pos: null } : { ...c, pos });
  }
  const start = c.pos ? pool.findIndex((it) => it.id > c.pos) : 0;
  const slice = start < 0 ? [] : pool.slice(start, start + limit);
  const finished = start < 0 || start + slice.length >= pool.length;
  return { records: slice.map((it) => it.build()), cursor: writeCursor(next(slice.at(-1)?.id ?? c.pos ?? null, finished)), done: finished };
}
