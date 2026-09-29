// One spelling for every identifier, so the same person matches across
// iMessage, WhatsApp, email, calls and meetings.
//   tel:+15551234567   mailto:ana@acme.com   slack:T123/U456
//   group:whatsapp:<id>   name:mike brennan   (meeting speakers with no address)

export function normalizePhone(raw, defaultCountry = '1') {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/@s\.whatsapp\.net$|@c\.us$/i, '');
  if (!s || /@/.test(s)) return null;
  const plus = s.startsWith('+') || s.startsWith('00');
  let digits = s.replace(/\D/g, '');
  if (s.startsWith('00')) digits = digits.slice(2);
  if (!digits) return null;
  if (digits.length <= 6) return `+${digits}`; // short codes stay as-is
  if (!plus && digits.length === 10 && defaultCountry === '1') digits = `1${digits}`;
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

export function normalizeEmail(raw) {
  if (raw == null) return null;
  const m = String(raw).trim().toLowerCase().match(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+\.[a-z]{2,}/);
  return m ? m[0] : null;
}

export const phoneHandle = (raw, cc) => {
  const p = normalizePhone(raw, cc);
  return p ? `tel:${p}` : null;
};
export const emailHandle = (raw) => {
  const e = normalizeEmail(raw);
  return e ? `mailto:${e}` : null;
};
export const slackHandle = (team, user) => (user ? `slack:${team ?? ''}/${user}` : null);
export const groupHandle = (source, id) => `group:${source}:${id}`;
export const nameHandle = (name) => {
  const n = String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return n ? `name:${n}` : null;
};

// Best handle for a raw address of unknown type (phone, email or name).
export function toHandle(raw, cc) {
  if (raw == null) return null;
  return emailHandle(raw) ?? phoneHandle(raw, cc) ?? nameHandle(raw);
}

export function parseHandle(handle) {
  const i = String(handle).indexOf(':');
  return i < 0 ? { scheme: 'unknown', value: handle } : { scheme: handle.slice(0, i), value: handle.slice(i + 1) };
}

// Last 10 digits: the matching key that survives country-code differences.
export function last10(handle) {
  const { scheme, value } = parseHandle(handle);
  if (scheme !== 'tel') return null;
  const d = value.replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

export function isShortCode(handle) {
  const { scheme, value } = parseHandle(handle);
  return scheme === 'tel' && value.replace(/\D/g, '').length <= 6;
}

const NO_REPLY = /^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounce|alerts?|updates?|news(letter)?|info|support|hello|team|billing|receipts?)[@+.]/i;
export function isAutomatedEmail(handle) {
  const { scheme, value } = parseHandle(handle);
  return scheme === 'mailto' && NO_REPLY.test(value);
}
