import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeCtx, tempHome, createDb, insert, runSource, schemaErrors, resetCaches } from './fixtures/a-fixtures.mjs';
import { appleSeconds } from './fixtures/a-apple.mjs';
import * as calendar from '../engine/extract/calendar.mjs';

const NOW = new Date('2026-09-28T16:00:00Z');
// Floating values store the wall clock as if it were UTC.
const wall = (s) => appleSeconds(`${s}Z`);

function fixture() {
  const home = tempHome();
  const db = createDb(
    join(home, 'Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb'),
    `CREATE TABLE Store (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type INTEGER, disabled INTEGER, external_id TEXT);
     CREATE TABLE Calendar (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, store_id INTEGER, title TEXT, flags INTEGER, color TEXT, type TEXT, UUID TEXT);
     CREATE TABLE CalendarItem (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT, location_id INTEGER, description TEXT, start_date REAL, start_tz TEXT,
       end_date REAL, end_tz TEXT, all_day INTEGER, calendar_id INTEGER, orig_item_id INTEGER, orig_date REAL, organizer_id INTEGER, self_attendee_id INTEGER,
       status INTEGER, invitation_status INTEGER, availability INTEGER, url TEXT, last_modified REAL, birthday_id INTEGER, external_id TEXT,
       unique_identifier TEXT, hidden INTEGER, has_recurrences INTEGER, has_attendees INTEGER, UUID TEXT, entity_type INTEGER, conference_url TEXT,
       conference_url_detected TEXT);
     CREATE TABLE Participant (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, entity_type INTEGER, type INTEGER, status INTEGER, pending_status INTEGER, role INTEGER,
       identity_id INTEGER, owner_id INTEGER, UUID TEXT, email TEXT, phone_number TEXT, is_self INTEGER, comment TEXT);
     CREATE TABLE Identity (display_name TEXT, address TEXT, first_name TEXT, last_name TEXT);
     CREATE TABLE Location (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, address TEXT, latitude REAL, longitude REAL, item_owner_id INTEGER);
     CREATE TABLE OccurrenceCache (day REAL, event_id INTEGER, calendar_id INTEGER, store_id INTEGER, occurrence_date REAL, occurrence_start_date REAL, occurrence_end_date REAL);`,
  );
  insert(db, 'Store', [{ ROWID: 1, name: 'iCloud', type: 1, disabled: 0 }, { ROWID: 2, name: 'Other', type: 5, disabled: 0 }, { ROWID: 3, name: 'Old Exchange', type: 2, disabled: 1 }]);
  insert(db, 'Calendar', [
    { ROWID: 1, store_id: 1, title: 'Work' },
    { ROWID: 2, store_id: 1, title: 'US Holidays' },
    { ROWID: 3, store_id: 2, title: 'Birthdays' },
    { ROWID: 4, store_id: 3, title: 'Legacy' },
  ]);
  insert(db, 'Identity', [{ display_name: 'Ana López', address: 'mailto:ana@acme.test' }, { display_name: null, address: 'mailto:mike@acme.test', first_name: 'Mike', last_name: 'Brennan' }]);
  insert(db, 'Location', { ROWID: 1, title: 'Acme HQ', address: '1 Main St, Miami' });
  const item = (row) => insert(db, 'CalendarItem', { entity_type: 2, hidden: 0, calendar_id: 1, start_tz: 'America/New_York', all_day: 0, last_modified: appleSeconds('2026-08-01T00:00:00Z'), ...row });
  item({ ROWID: 1, summary: 'Acme kickoff', UUID: 'U-1', unique_identifier: 'ical-1@acme', start_date: appleSeconds('2026-09-01T14:00:00Z'), end_date: appleSeconds('2026-09-01T15:00:00Z'),
    location_id: 1, organizer_id: 1, description: 'Agenda: pricing.\nJoin: https://us02web.zoom.us/j/81234567890?pwd=abc', status: 1 });
  insert(db, 'Participant', [
    { ROWID: 1, owner_id: 1, identity_id: 1, email: null, status: 2, role: 1, is_self: 0 },
    { ROWID: 2, owner_id: 1, email: 'rob@qwave.test', status: 4, is_self: 1 },
    { ROWID: 3, owner_id: 1, identity_id: 2, email: 'mike@acme.test', status: 3, is_self: 0 },
  ]);
  item({ ROWID: 2, summary: 'Offsite', UUID: 'U-2', all_day: 1, start_tz: '_float', start_date: wall('2026-09-10T00:00:00'), end_date: wall('2026-09-11T00:00:00') });
  item({ ROWID: 3, summary: '1:1 Sara', UUID: 'U-3', unique_identifier: 'series-3', has_recurrences: 1, start_date: appleSeconds('2026-09-07T13:00:00Z'), end_date: appleSeconds('2026-09-07T13:30:00Z'),
    conference_url: 'https://meet.google.com/abc-defg-hij' });
  for (const d of ['2026-09-07', '2026-09-14', '2026-09-28', '2026-10-05', '2026-12-28']) {
    insert(db, 'OccurrenceCache', { event_id: 3, calendar_id: 1, store_id: 1, occurrence_date: appleSeconds(`${d}T13:00:00Z`), occurrence_end_date: appleSeconds(`${d}T13:30:00Z`) });
  }
  item({ ROWID: 4, summary: '1:1 Sara (moved)', UUID: 'U-4', orig_item_id: 3, orig_date: appleSeconds('2026-09-21T13:00:00Z'), start_date: appleSeconds('2026-09-22T15:00:00Z'), end_date: appleSeconds('2026-09-22T15:30:00Z') });
  item({ ROWID: 5, summary: 'Far future', UUID: 'U-5', start_date: appleSeconds('2027-01-15T15:00:00Z'), end_date: appleSeconds('2027-01-15T16:00:00Z') });
  item({ ROWID: 6, summary: 'Labor Day', UUID: 'U-6', calendar_id: 2, all_day: 1, start_tz: '_float', start_date: wall('2026-09-07T00:00:00') });
  item({ ROWID: 7, summary: "Ana's birthday", UUID: 'U-7', calendar_id: 3, birthday_id: 9, all_day: 1, start_tz: '_float', start_date: wall('2026-10-02T00:00:00') });
  item({ ROWID: 8, summary: 'Buy milk', UUID: 'U-8', entity_type: 3, start_date: appleSeconds('2026-09-20T10:00:00Z') });
  item({ ROWID: 9, summary: 'Hidden', UUID: 'U-9', hidden: 1, start_date: appleSeconds('2026-09-20T10:00:00Z') });
  item({ ROWID: 10, summary: 'Lunch', UUID: 'U-10', start_tz: '_float', start_date: wall('2026-09-15T12:30:00'), end_date: wall('2026-09-15T13:30:00') });
  item({ ROWID: 11, summary: 'Old sync', UUID: 'U-11', calendar_id: 4, start_date: appleSeconds('2026-09-15T10:00:00Z') });
  item({ ROWID: 12, summary: 'Board prep', UUID: 'U-12', start_date: appleSeconds('2026-11-20T15:00:00Z'), end_date: appleSeconds('2026-11-20T16:00:00Z') });
  return { home, db };
}

test('calendar: events, attendees, all-day, floating, recurring series and filters', async () => {
  const { home } = fixture();
  const ctx = makeCtx({ home, now: NOW });
  resetCaches();
  assert.deepEqual(await calendar.probe(ctx), { ok: true, count: 11 });
  const totals = await runSource(ctx, 'calendar', { limit: 3 });
  assert.equal(totals.invalid, 0);
  const recs = ctx.store.records({ source: 'calendar' });
  assert.deepEqual(schemaErrors(recs), []);
  const titles = recs.map((r) => r.title).sort();
  assert.deepEqual(titles, ['1:1 Sara', '1:1 Sara', '1:1 Sara', '1:1 Sara', '1:1 Sara (moved)', 'Acme kickoff', 'Board prep', 'Lunch', 'Offsite']);

  const k = recs.find((r) => r.title === 'Acme kickoff');
  assert.equal(k.id, 'calendar:U-1');
  assert.equal(k.thread, 'calendar:ical-1@acme');
  assert.equal(k.kind, 'event');
  assert.equal(k.ts, '2026-09-01T14:00:00.000Z');
  assert.deepEqual(k.from, { handle: 'mailto:ana@acme.test', name: 'Ana López' });
  assert.deepEqual(k.to, [{ handle: 'mailto:rob@qwave.test', name: null }, { handle: 'mailto:mike@acme.test', name: 'Mike Brennan' }]);
  assert.equal(k.is_from_me, false);
  assert.equal(k.meta.location, 'Acme HQ, 1 Main St, Miami');
  assert.equal(k.meta.calendar, 'Work');
  assert.equal(k.meta.account, 'iCloud');
  assert.equal(k.meta.conference_url, 'https://us02web.zoom.us/j/81234567890?pwd=abc');
  assert.equal(k.url, k.meta.conference_url);
  assert.equal(k.meta.my_status, 'tentative');
  assert.equal(k.meta.attendee_status['mailto:mike@acme.test'], 'declined');
  assert.equal(k.meta.end, '2026-09-01T15:00:00.000Z');

  const off = recs.find((r) => r.title === 'Offsite');
  assert.equal(off.meta.all_day, true);
  assert.equal(off.meta.start, '2026-09-10');
  assert.equal(off.meta.end, '2026-09-11');
  assert.equal(off.ts, '2026-09-10T04:00:00.000Z', 'local midnight in New York');
  assert.equal(off.is_from_me, true, 'no organizer: my own event');
  assert.equal(recs.find((r) => r.title === 'Lunch').ts, '2026-09-15T16:30:00.000Z', 'floating wall clock read in the person\'s zone');

  const sara = recs.filter((r) => r.title === '1:1 Sara').sort((a, b) => a.ts.localeCompare(b.ts));
  assert.deepEqual(sara.map((r) => r.ts.slice(0, 10)), ['2026-09-07', '2026-09-14', '2026-09-28', '2026-10-05'], 'occurrences through today + 60 days');
  assert.ok(sara.every((r) => r.thread === 'calendar:series-3' && r.meta.recurring && r.meta.conference_url === 'https://meet.google.com/abc-defg-hij'));
  assert.equal(sara[0].id, 'calendar:U-3@2026-09-07T13:00:00.000Z');
  const moved = recs.find((r) => r.title === '1:1 Sara (moved)');
  assert.equal(moved.thread, 'calendar:series-3', 'an exception stays in its series');
});

test('calendar: later runs pick up edits and events entering the window', async () => {
  const { home, db } = fixture();
  const ctx = makeCtx({ home, now: NOW });
  await runSource(ctx, 'calendar', { limit: 4 });
  const quiet = await runSource(ctx, 'calendar');
  assert.equal(quiet.inserted + quiet.updated, 0);
  db.prepare('UPDATE CalendarItem SET summary = ?, last_modified = ? WHERE ROWID = 1').run('Acme kickoff (v2)', appleSeconds('2026-09-20T00:00:00Z'));
  const edit = await runSource(ctx, 'calendar');
  assert.equal(edit.updated, 1);
  assert.equal(ctx.store.record('calendar:U-1').title, 'Acme kickoff (v2)');
  ctx.now = new Date('2026-11-20T12:00:00Z');
  const later = await runSource(ctx, 'calendar');
  assert.equal(later.inserted, 2, 'the December occurrence and the January event enter the 60 day window');
  assert.ok(ctx.store.record('calendar:U-5'));
});

test('calendar: probe without a database', async () => {
  assert.equal((await calendar.probe(makeCtx({ home: tempHome() }))).ok, false);
});
