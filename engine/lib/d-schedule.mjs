// Builds the six scheduled tasks (plus the temporary finish_sorting task) as
// structured local-clock time slots, then renders each to the RRULE strings
// the automation system accepts. There is no DTSTART: every BYHOUR/BYMINUTE
// is read as a wall-clock time in the vault's own time zone. The automation
// system only supports FREQ=HOURLY;INTERVAL=n or FREQ=WEEKLY with
// BYDAY/BYHOUR/BYMINUTE, so a "daily" schedule is written as FREQ=WEEKLY
// with all seven BYDAY values.
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR'];
const ALL_DAYS = [...WEEKDAYS, 'SA', 'SU'];

const pad2 = (n) => String(n).padStart(2, '0');

function parseTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return { hour: 6, minute: 45 }; // the site's own default brief time
  return { hour: Math.min(23, Math.max(0, Number(m[1]))), minute: Math.min(59, Math.max(0, Number(m[2]))) };
}

// Minutes-of-day arithmetic, clamped to today. Confidant does not need to
// wrap a brief time set before 00:15 across midnight: clamping "15 minutes
// earlier" to 00:00 is a fine outcome for a case nobody will hit in practice.
function shiftMinutes(hour, minute, delta) {
  const total = Math.max(0, Math.min(23 * 60 + 59, hour * 60 + minute + delta));
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

// How many times a day Meeting Prep runs, scaled by how busy the person's
// calendar is. Always includes the start of the working day.
function meetingPrepHours(meetingsPerWeek) {
  const n = Number(meetingsPerWeek) || 0;
  if (n > 15) return [7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  if (n >= 6) return [7, 10, 13];
  return [7, 12];
}

const rrule = (days, hours, minute) => `FREQ=WEEKLY;BYDAY=${days.join(',')};BYHOUR=${hours.join(',')};BYMINUTE=${minute}`;
const splitRrules = (days, hours, minute) => hours.map((h) => rrule(days, [h], minute));

function keysFor(days, hours, minute) {
  const out = [];
  for (const d of days) for (const h of hours) out.push(`${d} ${pad2(h)}:${pad2(minute)}`);
  return out;
}

// Finds the nearest free minute-of-hour (trying +1, -1, +2, -2, ...) so this
// task's whole set of days and hours stops colliding with an already placed
// task. A task's days and hours never move, only the one shared minute a
// rule can carry. Tasks are placed in priority order (see buildSchedule), so
// only a lower-priority task ever gets nudged.
function placeMinute(occupied, days, hours, minute, maxShift = 30) {
  for (let delta = 0; delta <= maxShift; delta++) {
    for (const sign of delta === 0 ? [0] : [1, -1]) {
      const m = minute + sign * delta;
      if (m < 0 || m > 59) continue;
      const keys = keysFor(days, hours, m);
      if (keys.every((k) => !occupied.has(k))) {
        for (const k of keys) occupied.add(k);
        return m;
      }
    }
  }
  throw new Error('No free minute found for a scheduled task; widen maxShift.');
}

// Structured slots before collision resolution. Order is priority: earlier
// entries hold their exact time; a later entry that collides gets nudged.
function rawSlots(config, { includeFinish = false } = {}) {
  const { hour: briefHour, minute: briefMinute } = parseTime(config?.briefTime);
  const meetingHours = meetingPrepHours(config?.meetingsPerWeek);
  const scan = shiftMinutes(briefHour, briefMinute, -15);
  // notificationPolicy is the Codex automation setting of the same name.
  // null keeps Codex's default: every finished run lands in Scheduled and
  // raises a desktop notification. 'failed_runs_only' still lands every run
  // in Scheduled but only notifies when a run fails; it is for the two tasks
  // that run eight times a day, so they never bury the briefs.
  const out = [
    // Every 3 hours, every day, at :10 rather than on the hour: that keeps
    // this off every fixed single-time task's own minute (follow_up_radar
    // :00, weekly_review :00, meeting_prep :30) so those stay at their exact
    // documented times, and still lands a fresh update at 06:10, just ahead
    // of the 06:30 scanner and the 06:45 brief. The HOURLY;INTERVAL=3
    // fallback cannot carry this :10 offset (there is no DTSTART): it
    // anchors to whatever minute the automation is created at instead.
    { key: 'brain_update', notificationPolicy: 'failed_runs_only', days: ALL_DAYS, hours: [0, 3, 6, 9, 12, 15, 18, 21], minute: 10, fallback: 'hourly3' },
    // The person's own chosen time. Kept exact unless it truly collides.
    { key: 'morning_brief', notificationPolicy: null, days: WEEKDAYS, hours: [briefHour], minute: briefMinute },
    { key: 'meeting_prep', notificationPolicy: null, days: WEEKDAYS, hours: meetingHours, minute: 30, fallback: 'split' },
    { key: 'follow_up_radar', notificationPolicy: null, days: WEEKDAYS, hours: [16], minute: 0 },
    { key: 'weekly_review', notificationPolicy: null, days: ['FR'], hours: [15], minute: 0 },
    { key: 'health_check', notificationPolicy: null, days: ALL_DAYS, hours: [8], minute: 20 },
    { key: 'brain_cleanup', notificationPolicy: null, days: ['SU'], hours: [20], minute: 40 },
    { key: 'check_in', notificationPolicy: null, days: ['TH'], hours: [11], minute: 40 },
    // Derived from the brief time, so it is the one most free to move.
    { key: 'opportunity_scanner', notificationPolicy: null, days: WEEKDAYS, hours: [scan.hour], minute: scan.minute },
  ];
  if (includeFinish) {
    // Offset 90 minutes from brain_update's own every-3-hours grid, so the
    // two never collide by construction: hours differ (1,4,7... vs 0,3,6...)
    // even where a minute nudge later lands them on the same minute.
    out.push({ key: 'finish_sorting', notificationPolicy: 'failed_runs_only', days: ALL_DAYS, hours: [1, 4, 7, 10, 13, 16, 19, 22], minute: 30, fallback: 'hourly3', temporary: true });
  }
  return out;
}

// The public entry point: structured schedule with final, collision-free
// rrules. `tasks.mjs` turns these into schemas/task.schema.json entries;
// tests check every occurrence across the set is unique.
export function buildSchedule(config, opts = {}) {
  const occupied = new Set();
  return rawSlots(config, opts).map((s) => {
    const minute = placeMinute(occupied, s.days, s.hours, s.minute);
    const fallbackRrules =
      s.fallback === 'hourly3' ? ['FREQ=HOURLY;INTERVAL=3']
      : s.fallback === 'split' ? splitRrules(s.days, s.hours, minute)
      : undefined;
    return {
      key: s.key,
      notificationPolicy: s.notificationPolicy ?? null,
      days: s.days,
      hours: s.hours,
      minute,
      rrule: rrule(s.days, s.hours, minute),
      fallbackRrules,
      temporary: !!s.temporary,
    };
  });
}

export const SCHEDULE_WEEKDAYS = WEEKDAYS;
export const SCHEDULE_ALL_DAYS = ALL_DAYS;
