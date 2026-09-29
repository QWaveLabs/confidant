// Turns the rrule string on a created scheduled task ("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=6;BYMINUTE=45")
// into a plain sentence for the welcome guide and `confidant status`. Local
// time only: no DTSTART, no timezone math, matching how tasks are created.
const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DAY_NAMES = {
  en: { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' },
  es: { MO: 'lunes', TU: 'martes', WE: 'miércoles', TH: 'jueves', FR: 'viernes', SA: 'sábado', SU: 'domingo' },
};
const PLURAL = {
  en: { MO: 'Mondays', TU: 'Tuesdays', WE: 'Wednesdays', TH: 'Thursdays', FR: 'Fridays', SA: 'Saturdays', SU: 'Sundays' },
  es: { MO: 'los lunes', TU: 'los martes', WE: 'los miércoles', TH: 'los jueves', FR: 'los viernes', SA: 'los sábados', SU: 'los domingos' },
};

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

// Returns a human sentence, or the raw rrule if it doesn't match a shape we
// know how to describe (never throws: a strange rule just shows verbatim).
export function describeRrule(rrule, lang = 'en') {
  const r = parseRrule(rrule);
  const hour = r.BYHOUR != null ? Number(r.BYHOUR) : null;
  const minute = r.BYMINUTE != null ? Number(r.BYMINUTE) : 0;
  const time = hour != null ? `${pad2(hour)}:${pad2(minute)}` : null;
  const at = (s) => (lang === 'es' ? `${s} a las ${time}` : `${s} at ${time}`);

  if (r.FREQ === 'HOURLY') {
    const n = Number(r.INTERVAL ?? 1);
    if (lang === 'es') return n <= 1 ? 'Cada hora, en punto' : `Cada ${n} horas, en punto`;
    return n <= 1 ? 'Every hour, on the hour' : `Every ${n} hours, on the hour`;
  }
  if (r.FREQ === 'DAILY') {
    return time ? at(lang === 'es' ? 'Todos los días' : 'Every day') : (lang === 'es' ? 'Todos los días' : 'Every day');
  }
  if (r.FREQ === 'WEEKLY') {
    const days = r.BYDAY ? describeDays(r.BYDAY, lang) : (lang === 'es' ? 'Cada semana' : 'Every week');
    return time ? at(days) : days;
  }
  if (r.FREQ === 'MONTHLY') {
    return time ? at(lang === 'es' ? 'Cada mes' : 'Every month') : (lang === 'es' ? 'Cada mes' : 'Every month');
  }
  return rrule;
}
