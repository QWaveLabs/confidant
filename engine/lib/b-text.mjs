// Text helpers for the sorter and the vault writer: name matching, safe file
// names, the substance filter, email cleanup and dash cleanup.
import { parseHandle } from './handles.mjs';

const MARKS = /[̀-ͯ]/g;

export const foldAccents = (s) => String(s ?? '').normalize('NFKD').replace(MARKS, '');

// "Ana María Ruiz-Pérez" and "ana maria ruiz perez" compare equal.
export function normalizeName(s) {
  return foldAccents(s).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export const nameTokens = (s) => normalizeName(s).split(' ').filter(Boolean);

export const looksLikeHandle = (name) => /@/.test(String(name ?? '')) || /^[+\d().\-\s]{6,}$/.test(String(name ?? '').trim());

export function titleCase(s) {
  return String(s ?? '').replace(/(^|[\s\-'])(\p{L})/gu, (m, pre, ch) => pre + ch.toUpperCase());
}

// A readable stand-in until someone has a real name.
export function prettyHandle(handle) {
  if (!handle) return 'Unknown';
  const { scheme, value } = parseHandle(handle);
  if (scheme === 'tel') {
    const d = value.replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') return `+1 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
    return `+${d}`;
  }
  if (scheme === 'mailto') return value;
  if (scheme === 'name') return titleCase(value);
  return value || String(handle);
}

// No em dashes and no double hyphens anywhere a person reads.
export function cleanDashes(s) {
  return String(s ?? '')
    .replace(/[ \t]*[—―][ \t]*/g, ', ')
    .replace(/[ \t]+–[ \t]+/g, ', ')
    .replace(/[ \t]*-{2,}[ \t]*/g, ', ')
    .replace(/,[ \t]*,/g, ',')
    .replace(/^,[ \t]*/gm, '')
    .replace(/[ \t]*,[ \t]*$/gm, '');
}

// One line of plain text: trimmed, single spaced, no dashes.
export const oneLine = (s) => cleanDashes(String(s ?? '').replace(/\s*\n\s*/g, ' ')).replace(/\s+/g, ' ').trim();

// Capital first letter, final punctuation.
export function ensureSentence(s) {
  let t = oneLine(s);
  if (!t) return t;
  t = t.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  if (!/[.!?…)"'»”]$/.test(t)) t += '.';
  return t;
}

// File names that work on macOS and in Obsidian links.
export function safeFileName(raw, max = 90) {
  let s = cleanDashes(String(raw ?? ''))
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\//g, '-')
    .replace(/[\\:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (s.length > max) {
    s = s.slice(0, max);
    const cut = s.lastIndexOf(' ');
    if (cut > max * 0.6) s = s.slice(0, cut);
    s = s.replace(/[.,;:\s-]+$/, '');
  }
  return s || 'Untitled';
}

// Obsidian tags: lowercase words joined by hyphens, never all digits.
export function slugTag(s) {
  const t = normalizeName(s).replace(/ /g, '-');
  if (!t) return '';
  return /^\d+$/.test(t) ? `n${t}` : t;
}

export const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const estimateTokens = (v) => Math.ceil((typeof v === 'string' ? v : JSON.stringify(v)).length / 4);

// Cut at a word boundary.
export function trimText(s, max) {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.7 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

const STOP = new Set('the and for with that this from have has had was were are you your our their them they she him her his its but not all any can will would should could about into over then than just also been more some what when who how why a an to of in on at by or as is it be we i me my mi el la los las de del y o en un una con por para que se su sus lo al es'.split(' '));

export function contentWords(s) {
  return new Set(nameTokens(s).filter((w) => w.length > 2 && !STOP.has(w)));
}

export function jaccard(a, b) {
  const A = a instanceof Set ? a : contentWords(a);
  const B = b instanceof Set ? b : contentWords(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---------- substance filter ----------

// Pure noise: greetings, thanks, laughter, emoji. Never worth a token.
const NOISE = new Set([
  'thanks', 'thank you', 'thanks so much', 'thank you so much', 'thx', 'ty', 'tysm', 'thanks man', 'thank u', 'many thanks',
  'lol', 'lmao', 'rofl', 'hi', 'hello', 'hey', 'hey there', 'yo', 'bye', 'good night', 'goodnight', 'gn', 'good morning', 'gm',
  'morning', 'night', 'you too', 'same to you', 'np', 'no problem', 'no worries', 'welcome', 'youre welcome', 'love you', 'ily',
  'miss you', 'xoxo', 'see you', 'see ya', 'cya', 'ttyl', 'congrats', 'congratulations', 'happy birthday', 'nice', 'wow', 'omg',
  'gracias', 'muchas gracias', 'mil gracias', 'gracias a ti', 'hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches',
  'chao', 'chau', 'adios', 'de nada', 'igualmente', 'besos', 'un beso', 'abrazo', 'un abrazo', 'te quiero', 'nos vemos', 'felicidades',
  'feliz cumpleanos', 'jaja', 'jeje', 'jiji', 'que bien', 'genial',
]);

// Acknowledgements: noise on their own, but an answer to a question or a
// request can be a promise, so the dossier keeps them in that case.
const ACKS = new Set([
  'ok', 'okay', 'okk', 'k', 'kk', 'oki', 'okey', 'yes', 'yeah', 'yep', 'yup', 'ya', 'sure', 'of course', 'cool', 'great', 'perfect',
  'awesome', 'got it', 'sounds good', 'will do', 'on it', 'done', 'noted', 'agreed', 'deal', 'for sure', 'absolutely', 'ok thanks',
  'ok thank you', 'ok great', 'ok cool', 'no', 'nope', 'not yet', 'si', 'sip', 'claro', 'dale', 'listo', 'vale', 'va', 'sale', 'perfecto',
  'bueno', 'de acuerdo', 'entendido', 'excelente', 'super', 'ok gracias', 'hecho', 'todavia no', 'aun no',
]);

const REACTION = /^(liked|loved|laughed at|emphasized|questioned|disliked|reacted\s+\S{1,12}\s+to|le gustó|le encantó|se rió de|enfatizó|cuestionó|no le gustó|reaccionó\s+\S{1,12}\s+a)\s+[“"'«]/i;
const CODE = /(verification|security|login|sign.?in|one.?time|confirmation|access)\s+code|code is\s*:?\s*\d{4,}|código( de verificación)?\s*(es)?\s*:?\s*\d{4,}|\b\d{4,8}\b is your/i;

// 'noise' | 'ack' | 'content'
export function classifyText(text, meta = {}) {
  if (meta?.reaction || meta?.is_reaction || meta?.tapback) return 'noise';
  const t = String(text ?? '').trim();
  if (!t) return 'noise';
  if (REACTION.test(t)) return 'noise';
  const core = normalizeName(t);
  if (!core || core.length < 2) return 'noise';
  if (NOISE.has(core)) return 'noise';
  if (/^((ha|ja|je|ji|he|hi)+h?|lol+|xd+)$/.test(core.replace(/ /g, ''))) return 'noise';
  if (t.length < 220 && CODE.test(t)) return 'noise';
  if (ACKS.has(core)) return 'ack';
  return 'content';
}

const REQUEST = /\?\s*$|\b(can you|could you|would you|will you|please|pls|let me know|lmk|send me|are you able|puedes|podrías|podrias|por favor|me mandas|me envías|me envias|avísame|avisame|me confirmas)\b/i;
export const looksLikeRequest = (text) => REQUEST.test(String(text ?? ''));

const CAL_NOISE = /^(busy|hold|on hold|blocked?|block|focus( time| block)?|deep work|lunch|breakfast|dinner|ooo|out of office|commute|travel( time)?|gym|workout|personal|private|tentative|free|available|do not book|dnd|no meetings?|home|school pickup|pickup|ocupado|bloqueado|almuerzo|comida|cena|personal|privado|gimnasio|traslado)$/i;
const CAL_PREFIX = /^(canceled|cancelled|cancelado|declined|rechazado|updated invitation|invitation|accepted|tentatively accepted|invitación|invitacion|aceptado|aceptada)\b\s*:?/i;

export function isCalendarNoise(title) {
  const t = oneLine(title).replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return true;
  return CAL_NOISE.test(t) || CAL_PREFIX.test(oneLine(title));
}

// Email bodies: keep what this person wrote, not the quoted thread below it.
export function cleanEmailText(text) {
  let s = String(text ?? '').replace(/\r\n?/g, '\n');
  const cuts = [
    /^\s*On .{5,300}wrote:\s*$/m,
    /^\s*El .{5,300}escribió:\s*$/m,
    /^\s*-{2,}\s*(Original Message|Mensaje original|Forwarded message|Mensaje reenviado)\s*-{2,}/im,
    /^\s*From:\s.+\n\s*(Sent|Date):\s/m,
    /^\s*De:\s.+\n\s*(Enviado|Fecha):\s/m,
    /^--\s*$/m,
    /^\s*(Sent from my|Enviado desde mi|Get Outlook for)\b/im,
  ];
  for (const re of cuts) {
    const m = re.exec(s);
    if (m && m.index > 0) s = s.slice(0, m.index);
  }
  return s
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Free mail providers never name a company.
export const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.es', 'ymail.com', 'hotmail.com', 'hotmail.es', 'outlook.com', 'outlook.es', 'live.com',
  'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'yandex.com', 'mail.com',
  'zoho.com', 'fastmail.com', 'hey.com', 'pm.me', 'qq.com', '163.com', 'comcast.net', 'att.net', 'verizon.net', 'sbcglobal.net', 'bellsouth.net',
]);

export function emailDomain(handle) {
  const { scheme, value } = parseHandle(handle ?? '');
  if (scheme !== 'mailto') return null;
  const at = value.lastIndexOf('@');
  return at > 0 ? value.slice(at + 1) : null;
}
