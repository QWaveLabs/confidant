// Turns the rrule string on a created scheduled task ("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=6;BYMINUTE=45")
// into a plain sentence for the welcome guide and `confidant status`. Local
// time only: no DTSTART, no timezone math, matching how tasks are created.
// Times always show 12-hour clock ("6:45 AM" / "6:45 a. m."), never raw
// 24-hour "06:45": that raw form reads like a typo to most people.
const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DAY_NAMES = {
  en: { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' },
  es: { MO: 'lunes', TU: 'martes', WE: 'miércoles', TH: 'jueves', FR: 'viernes', SA: 'sábado', SU: 'domingo' },
};
const PLURAL = {
  en: { MO: 'Mondays', TU: 'Tuesdays', WE: 'Wednesdays', TH: 'Thursdays', FR: 'Fridays', SA: 'Saturdays', SU: 'Sundays' },
  es: { MO: 'los lunes', TU: 'los martes', WE: 'los miércoles', TH: 'los jueves', FR: 'los viernes', SA: 'los sábados', SU: 'los domingos' },
};
// 0=Sunday..6=Saturday, matching Date#getUTCDay(), mapped to our MO-first codes.
const WEEKDAY_BY_JS_DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function parseRrule(rrule) {
  const out = {};
  for (const part of String(rrule ?? '').split(';')) {
    const [k, v] = part.split('=');
    if (k) out[k] = v;
  }
  return out;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// 24-hour hour/minute -> a 12-hour clock string in the site's own style.
export function formatTime12(hour, minute, lang = 'en') {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const mm = pad2(minute);
  const suffix = lang === 'es' ? (hour < 12 ? 'a. m.' : 'p. m.') : (hour < 12 ? 'AM' : 'PM');
  return `${h12}:${mm} ${suffix}`;
}

function parseHours(byhour) {
  return String(byhour ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

function describeDays(byday, lang) {
  const codes = byday.split(',').filter((c) => DAY_CODES.includes(c));
  const set = new Set(codes);
  const isSet = (...want) => set.size === want.length && want.every((c) => set.has(c));
  if (isSet('MO', 'TU', 'WE', 'TH', 'FR')) return lang === 'es' ? 'Lunes a viernes' : 'Weekdays';
  if (isSet('MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU')) return lang === 'es' ? 'Todos los días' : 'Every day';
  if (isSet('SA', 'SU')) return lang === 'es' ? 'Fines de semana' : 'Weekends';
  if (codes.length === 1) return PLURAL[lang]?.[codes[0]] ?? PLURAL.en[codes[0]];
  return codes.map((c) => DAY_NAMES[lang]?.[c] ?? DAY_NAMES.en[c]).join(lang === 'es' ? ' y ' : ' and ');
}

function isAllSevenDays(byday) {
  const codes = new Set(String(byday ?? '').split(',').filter(Boolean));
  return codes.size === 7 && DAY_CODES.every((c) => codes.has(c));
}

// The common step between evenly spaced hours covering the full day
// (0, 3, 6, ... 21), or null when the hours are not an even "every N hours"
// grid starting at midnight.
function evenHourStep(hours) {
  if (hours.length < 2) return null;
  const sorted = [...hours].sort((a, b) => a - b);
  const step = sorted[1] - sorted[0];
  if (step <= 0) return null;
  for (let i = 1; i < sorted.length; i++) if (sorted[i] - sorted[i - 1] !== step) return null;
  if (sorted[0] !== 0 || 24 % step !== 0 || sorted.length !== 24 / step) return null;
  return step;
}

function everyNHours(step, minute, lang) {
  const past = minute === 0 ? (lang === 'es' ? 'en punto' : 'on the hour') : lang === 'es' ? `${minute} minutos después de la hora` : `${minute} minutes past the hour`;
  if (lang === 'es') return step <= 1 ? `Cada hora, ${past}` : `Cada ${step} horas, ${past}`;
  return step <= 1 ? `Every hour, ${past}` : `Every ${step} hours, ${past}`;
}

function joinList(items, lang) {
  if (items.length <= 1) return items[0] ?? '';
  const sep = lang === 'es' ? ' y ' : ' and ';
  return `${items.slice(0, -1).join(', ')}${sep}${items.at(-1)}`;
}

// A weekday cadence that checks at several, unevenly-spaced hours a day
// (Meeting Prep). A short list is spelled out; a long contiguous run
// (a busy calendar's every-half-hour tier) is shown as a range instead of
// ten separate times.
function describeMultiHour(days, hours, minute, lang) {
  const sorted = [...hours].sort((a, b) => a - b);
  const contiguous = sorted.every((h, i) => i === 0 || h - sorted[i - 1] === 1);
  if (sorted.length > 3 && contiguous) {
    const from = formatTime12(sorted[0], minute, lang);
    const to = formatTime12(sorted.at(-1), minute, lang);
    return lang === 'es' ? `${days}, revisa cada hora de ${from} a ${to}` : `${days}, checking every hour from ${from} to ${to}`;
  }
  const times = joinList(sorted.map((h) => formatTime12(h, minute, lang)), lang);
  return lang === 'es' ? `${days}, revisa a las ${times}` : `${days}, checking at ${times}`;
}

// Returns a human sentence, or the raw rrule if it doesn't match a shape we
// know how to describe (never throws: a strange rule just shows verbatim).
export function describeRrule(rrule, lang = 'en') {
  const r = parseRrule(rrule);
  const minute = r.BYMINUTE != null ? Number(r.BYMINUTE) : 0;

  if (r.FREQ === 'HOURLY') {
    const n = Number(r.INTERVAL ?? 1);
    if (lang === 'es') return n <= 1 ? 'Cada hora, en punto' : `Cada ${n} horas, en punto`;
    return n <= 1 ? 'Every hour, on the hour' : `Every ${n} hours, on the hour`;
  }
  if (r.FREQ === 'DAILY') {
    const hours = parseHours(r.BYHOUR);
    const base = lang === 'es' ? 'Todos los días' : 'Every day';
    if (hours.length === 1) return lang === 'es' ? `${base} a las ${formatTime12(hours[0], minute, lang)}` : `${base} at ${formatTime12(hours[0], minute, lang)}`;
    return base;
  }
  if (r.FREQ === 'WEEKLY') {
    const hours = parseHours(r.BYHOUR);
    if (r.BYDAY && isAllSevenDays(r.BYDAY) && hours.length > 1) {
      const step = evenHourStep(hours);
      if (step) return everyNHours(step, minute, lang);
    }
    const days = r.BYDAY ? describeDays(r.BYDAY, lang) : lang === 'es' ? 'Cada semana' : 'Every week';
    if (hours.length > 1) return describeMultiHour(days, hours, minute, lang);
    if (hours.length === 1) return lang === 'es' ? `${days} a las ${formatTime12(hours[0], minute, lang)}` : `${days} at ${formatTime12(hours[0], minute, lang)}`;
    return days;
  }
  if (r.FREQ === 'MONTHLY') {
    const hours = parseHours(r.BYHOUR);
    const base = lang === 'es' ? 'Cada mes' : 'Every month';
    if (hours.length === 1) return lang === 'es' ? `${base} a las ${formatTime12(hours[0], minute, lang)}` : `${base} at ${formatTime12(hours[0], minute, lang)}`;
    return base;
  }
  return rrule;
}

// The next local occurrence of a single-hour WEEKLY rrule (the shape every
// once-a-day agent uses), as a short "Day, time" label: "Today, 6:45 AM",
// "Tomorrow, 6:45 AM", "Monday, 6:45 AM". Returns null for a shape this
// does not cover (no BYDAY, more than one BYHOUR, or a non-weekly rule):
// callers show "not scheduled yet" instead of guessing.
export function nextWeeklyTime(rrule, { now = new Date(), tz = 'UTC', lang = 'en' } = {}) {
  const r = parseRrule(rrule);
  if (r.FREQ !== 'WEEKLY' || !r.BYDAY) return null;
  const hours = parseHours(r.BYHOUR);
  if (hours.length !== 1) return null;
  const days = new Set(r.BYDAY.split(',').filter((c) => DAY_CODES.includes(c)));
  if (!days.size) return null;
  const hour = hours[0];
  const minute = r.BYMINUTE != null ? Number(r.BYMINUTE) : 0;

  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const todayUtcMidnight = new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00Z`);
  const todayCode = WEEKDAY_BY_JS_DAY[todayUtcMidnight.getUTCDay()];
  const nowMinutes = Number(get('hour')) * 60 + Number(get('minute'));
  const targetMinutes = hour * 60 + minute;
  const startIdx = DAY_CODES.indexOf(todayCode);

  for (let offset = 0; offset <= 7; offset++) {
    const code = DAY_CODES[(startIdx + offset) % 7];
    if (!days.has(code)) continue;
    if (offset === 0 && nowMinutes >= targetMinutes) continue; // already ran today
    const time = formatTime12(hour, minute, lang);
    const label = offset === 0 ? (lang === 'es' ? 'Hoy' : 'Today') : offset === 1 ? (lang === 'es' ? 'Mañana' : 'Tomorrow') : capitalize(DAY_NAMES[lang]?.[code] ?? DAY_NAMES.en[code]);
    return `${label}, ${time}`;
  }
  return null;
}
