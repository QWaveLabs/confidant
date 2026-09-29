// Local-clock helpers for the scheduled agents: turning a vault's own
// "07:30 in America/New_York" into the UTC instant `store.records()` needs,
// and back. lib/time.mjs (U0) only converts a known instant to a local date
// string; these go the other direction.
const fmt = new Map();

function offsetFormatter(timeZone) {
  if (!fmt.has(timeZone)) {
    fmt.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmt.get(timeZone);
}

// Minutes to add to a UTC instant to get that zone's wall clock (the zone's
// offset from UTC), evaluated near `date` so it tracks daylight saving.
export function tzOffsetMinutes(date, timeZone) {
  const parts = Object.fromEntries(offsetFormatter(timeZone).formatToParts(date).map((p) => [p.type, p.value]));
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - date.getTime()) / 60000);
}

// The wall-clock hour and minute in `timeZone` at instant `date`.
export function localHourMinute(date, timeZone) {
  const offset = tzOffsetMinutes(date, timeZone);
  const shifted = new Date(date.getTime() + offset * 60000);
  return { hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
}

// The UTC instant, as an ISO string, of HH:MM on `dateStr` (YYYY-MM-DD) in
// `timeZone`. `now` anchors the offset lookup (matters only around a
// daylight-saving change on `dateStr` itself).
export function localTimeToInstant(dateStr, hour, minute, timeZone, now = new Date()) {
  const offset = tzOffsetMinutes(now, timeZone);
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour, minute, 0) - offset * 60000).toISOString();
}

// [start, end) of `dateStr` (YYYY-MM-DD) in `timeZone`, as ISO instants: an
// exact 24 hours from local midnight, so `until` is a clean exclusive bound
// for `store.records({ since, until })` with no last-second gap.
export function dayBounds(dateStr, timeZone, now = new Date()) {
  const since = localTimeToInstant(dateStr, 0, 0, timeZone, now);
  return { since, until: new Date(new Date(since).getTime() + 86400000).toISOString() };
}
