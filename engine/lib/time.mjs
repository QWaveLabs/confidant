// Date conversions for Apple databases and friends. Everything leaves here as
// an ISO 8601 UTC string.
export const APPLE_EPOCH_S = 978307200; // 2001-01-01T00:00:00Z

// Apple "Core Data" timestamps: seconds since 2001 (Notes, Calendar, Calls,
// WhatsApp). iMessage's message.date is nanoseconds since 2001 on modern macOS.
export function fromAppleTime(value) {
  if (value == null || value === '') return null;
  let n = typeof value === 'bigint' ? Number(value / 1000000n) / 1000 : Number(value);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) > 1e14) n = n / 1e9; // nanoseconds
  else if (Math.abs(n) > 1e11) n = n / 1e3; // milliseconds
  return new Date((n + APPLE_EPOCH_S) * 1000).toISOString();
}

export function fromUnix(value) {
  if (value == null || value === '') return null;
  let n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 1e14) n = n / 1e6; // microseconds
  else if (n < 1e11) n = n * 1000; // seconds
  return new Date(n).toISOString();
}

export function toIso(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const toMs = (iso) => (iso ? new Date(iso).getTime() : null);

// YYYY-MM-DD in the person's time zone (notes are dated locally).
export function localDate(iso, timeZone) {
  const d = iso instanceof Date ? iso : new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function daysAgo(n, now = new Date()) {
  return new Date(now.getTime() - n * 86400000).toISOString();
}
