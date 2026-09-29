// Privacy: what never enters the second brain, and what gets masked when it
// does.
//   filterRecord(record, config) -> { keep, reason? }   (the extract runner calls it)
//   scrubText(text)              -> { text, redactions } (B calls it on every note string)
//   emailQuery(config)           -> Gmail search suffix  (the Gmail app recipe uses it)
//
// Rules for staying useful to a business owner:
//   - Category keyword rules only look at short items (messages, emails,
//     events). A one-hour meeting that mentions "new password" is not dropped.
//   - Banking text ("wire transfer", "payment due") only counts when the
//     sender is a short code, an automated sender or a bank. A client asking
//     about a wire stays in.
//   - Business payment tools (Stripe, PayPal, QuickBooks) are not banking.
//   - A chat that is excluded is excluded whole: every message in it carries
//     the same thread, chat name and counterpart, so the same rule fires.
import { parseHandle, last10, normalizeEmail, normalizePhone, isShortCode, isAutomatedEmail, toHandle } from './lib/handles.mjs';
import { sha1 } from './lib/hash.mjs';
import { rowToRecord } from './lib/store.mjs';
import {
  BANKING_DOMAINS, BANKING_DOMAIN_WORDS, BANK_NAMES, BANK_AMBIGUOUS, BANK_SUFFIX, BANKING_TEXT,
  HEALTH_DOMAINS, HEALTH_DOMAIN_WORDS, HEALTH_NAMES, HEALTH_TEXT, HEALTH_EVENT,
  PASSWORD_DOMAINS, PASSWORD_NAMES, PASSWORD_TEXT,
  FAMILY_WHOLE, FAMILY_PREFIX, FAMILY_CHAT, FAMILY_EVENT, FAMILY_NOT, CONSUMER_MAIL,
} from './lib/a-privacy-rules.mjs';

// Lowercase, no accents, punctuation to spaces. "María-José" -> "maria jose".
export function fold(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9@.\-+$*#':=\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const foldName = (s) => fold(s).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const SHORT_KINDS = new Set(['message', 'email', 'event', 'dictation', 'doc', 'note']);
const SMALL_CIRCLE = 2;

function domainOf(handle) {
  const { scheme, value } = parseHandle(handle ?? '');
  return scheme === 'mailto' ? value.slice(value.lastIndexOf('@') + 1) : null;
}

function domainIn(domain, list) {
  if (!domain) return false;
  for (const d of list) if (domain === d || domain.endsWith(`.${d}`)) return true;
  return false;
}

// Party names: the display name, or the value of a name: handle.
function partyName(p) {
  if (!p) return '';
  if (p.name) return p.name;
  const { scheme, value } = parseHandle(p.handle ?? '');
  return scheme === 'name' ? value : '';
}

function bankName(name) {
  const n = foldName(name);
  if (!n) return false;
  if (BANK_NAMES.test(n)) return true;
  for (const brand of BANK_AMBIGUOUS) {
    if (n === brand) return true;
    if (n.startsWith(`${brand} `) && BANK_SUFFIX.test(n.slice(brand.length + 1))) return true;
  }
  return false;
}

const looksLikeAddress = (s) => /@/.test(String(s)) || String(s).replace(/\D/g, '').length >= 7;

// Everything filterRecord needs from a config, compiled once per config.
const compiled = new WeakMap();
function compile(config) {
  if (config && compiled.has(config)) return compiled.get(config);
  const ex = config?.exclusions ?? {};
  const cats = new Set(ex.categories ?? []);
  const owner = config?.owner ?? {};
  const ownerEmails = new Set((owner.emails ?? []).map(normalizeEmail).filter(Boolean));
  const ownerTails = new Set((owner.phones ?? []).map((p) => last10(`tel:${normalizePhone(p)}`)).filter(Boolean));
  const personalAccounts = new Set((ex.emailAccounts ?? []).map(normalizeEmail).filter(Boolean));
  if (cats.has('personal-email') && !personalAccounts.size) {
    // Heuristic: someone with a business address and a consumer address wants
    // the consumer one left out.
    const consumer = [...ownerEmails].filter((e) => CONSUMER_MAIL.includes(e.split('@')[1]));
    if (consumer.length && consumer.length < ownerEmails.size) consumer.forEach((e) => personalAccounts.add(e));
  }
  const handles = new Set();
  const handleTails = new Set();
  const addHandle = (norm) => {
    if (!norm) return;
    handles.add(norm);
    const tail = last10(norm);
    if (tail) handleTails.add(tail);
  };
  for (const h of ex.handles ?? []) addHandle(normalizeHandle(h));
  // A phone number or address typed into people works as a handle too.
  for (const p of ex.people ?? []) if (looksLikeAddress(p)) addHandle(toHandle(p));
  const c = {
    cats,
    ownerName: foldName(owner.name),
    ownerEmails,
    ownerTails,
    personalAccounts,
    people: (ex.people ?? []).filter((p) => !looksLikeAddress(p)).map(foldName).filter(Boolean),
    handles,
    handleTails,
    domains: (ex.domains ?? []).map((d) => String(d).trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
    chats: (ex.chats ?? []).map((x) => ({ folded: foldName(x), raw: String(x).trim() })).filter((x) => x.folded || x.raw),
    keywords: (ex.keywords ?? []).map(fold).filter(Boolean).map((k) => new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`)),
  };
  if (config) compiled.set(config, c);
  return c;
}

// "tel:+1555...", "mailto:x", "group:whatsapp:1@g.us" stay as written (scheme
// lowercased); anything else is read as a phone, email or name.
function normalizeHandle(raw) {
  const s = String(raw ?? '').trim();
  const m = /^(tel|mailto|group|name|slack):(.+)$/i.exec(s);
  if (!m) return toHandle(s);
  const scheme = m[1].toLowerCase();
  if (scheme === 'tel') return toHandle(m[2]);
  return `${scheme}:${scheme === 'mailto' || scheme === 'name' ? m[2].toLowerCase() : m[2]}`;
}

function nameMatches(name, list) {
  const n = foldName(name);
  if (!n || !list.length) return false;
  const tokens = new Set(n.split(' '));
  for (const x of list) {
    if (n === x || n.startsWith(`${x} `)) return true;
    const xt = x.split(' ');
    if (xt.length > 1 && xt.every((t) => tokens.has(t))) return true;
  }
  return false;
}

function isOwner(p, c) {
  if (!p) return false;
  const { scheme, value } = parseHandle(p.handle ?? '');
  if (scheme === 'mailto' && c.ownerEmails.has(value)) return true;
  if (scheme === 'tel' && c.ownerTails.has(last10(p.handle))) return true;
  return !p.handle && !!c.ownerName && foldName(p.name) === c.ownerName;
}

function handleMatches(handle, c) {
  if (!handle || (!c.handles.size && !c.handleTails.size)) return false;
  if (c.handles.has(handle)) return true;
  const tail = last10(handle);
  return !!tail && c.handleTails.has(tail);
}

// The facts every rule reads, gathered once per record.
function view(record, c) {
  const meta = record.meta ?? {};
  const from = record.from ?? null;
  const to = Array.isArray(record.to) ? record.to : [];
  const parties = [from, ...to].filter(Boolean);
  const groups = parties.filter((p) => parseHandle(p.handle ?? '').scheme === 'group');
  const people = parties.filter((p) => parseHandle(p.handle ?? '').scheme !== 'group');
  const fromIsMe = !!record.is_from_me || isOwner(from, c);
  const counterparts = people.filter((p) => !isOwner(p, c) && !(fromIsMe && p === from));
  const isGroup = !!meta.is_group || groups.length > 0;
  const chatNames = [meta.chat_name, ...groups.map((g) => g.name)].filter(Boolean);
  if (record.kind === 'message' && !isGroup && record.title) chatNames.push(record.title);
  const contactNames = record.kind === 'contact' ? [...(meta.names ?? []), record.title].filter(Boolean) : [];
  const contactHandles = record.kind === 'contact'
    ? [...(meta.phones ?? []).map((p) => toHandle(p)), ...(meta.emails ?? []).map((e) => toHandle(e))].filter(Boolean)
    : [];
  const short = SHORT_KINDS.has(record.kind);
  const title = record.title ?? '';
  const body = record.kind === 'email' ? String(record.text ?? '').slice(0, 3000) : String(record.text ?? '');
  const text = fold(`${title}\n${body}`);
  const senderAutomated =
    !!from &&
    !fromIsMe &&
    (isShortCode(from.handle ?? '') || isAutomatedEmail(from.handle ?? '') || !!meta.bulk || !!meta.automated || !!meta.alphanumeric_sender);
  return { meta, from, parties, people, groups, counterparts, isGroup, fromIsMe, chatNames, contactNames, contactHandles, short, text, senderAutomated };
}

function anyDomain(v, test) {
  return [...v.parties, ...v.contactHandles.map((handle) => ({ handle }))].some((p) => test(domainOf(p.handle)));
}

function names(v) {
  return [...v.parties.map(partyName), ...v.chatNames, ...v.contactNames].filter(Boolean);
}

// A category that fires on who the thread is with (a bank's domain, a short
// code, an automated sender) covers the whole thread: the owner's "YES"
// reply to a bank text is banking too. One that fires on a person's words
// covers only that record.
const T = (reason) => ({ reason, scope: 'thread' });
const R = (reason) => ({ reason, scope: 'record' });

function categoryReason(record, v, c) {
  const kind = record.kind;
  if (c.cats.has('banking')) {
    if (anyDomain(v, (d) => domainIn(d, BANKING_DOMAINS) || (!!d && BANKING_DOMAIN_WORDS.test(`${d}.`)))) return T('banking');
    if (names(v).some(bankName)) return T('banking');
    if (v.short && BANKING_TEXT.test(v.text) && v.senderAutomated) return T('banking');
    if (v.short && BANKING_TEXT.test(v.text) && BANK_NAMES.test(v.text)) return R('banking');
  }
  if (c.cats.has('health')) {
    if (anyDomain(v, (d) => domainIn(d, HEALTH_DOMAINS) || (!!d && HEALTH_DOMAIN_WORDS.test(`${d}.`)))) return T('health');
    if ([...v.parties.map(partyName), ...v.chatNames].some((n) => HEALTH_NAMES.test(foldName(n)))) return T('health');
    if (v.short && kind !== 'event' && HEALTH_TEXT.test(v.text)) return v.senderAutomated ? T('health') : R('health');
    if (kind === 'event' && (HEALTH_EVENT.test(fold(record.title)) || HEALTH_TEXT.test(v.text))) return R('health');
  }
  if (c.cats.has('passwords')) {
    if (anyDomain(v, (d) => domainIn(d, PASSWORD_DOMAINS))) return T('passwords');
    if (v.parties.some((p) => PASSWORD_NAMES.test(foldName(partyName(p))))) return T('passwords');
    if ((kind === 'message' || kind === 'email') && PASSWORD_TEXT.test(v.text)) return v.senderAutomated ? T('passwords') : R('passwords');
  }
  if (c.cats.has('family')) {
    const relative = (n) => {
      const f = foldName(n);
      return (FAMILY_WHOLE.test(f) || FAMILY_PREFIX.test(f)) && !FAMILY_NOT.test(f);
    };
    if (v.chatNames.some((n) => (FAMILY_CHAT.test(foldName(n)) || relative(n)) && !FAMILY_NOT.test(foldName(n)))) return T('family');
    if (!v.isGroup && v.counterparts.length && v.counterparts.length <= SMALL_CIRCLE && v.counterparts.some((p) => relative(partyName(p)))) return T('family');
    if (v.contactNames.some(relative)) return R('family');
    if (kind === 'event' && FAMILY_EVENT.test(fold(record.title)) && !FAMILY_NOT.test(fold(record.title))) return R('family');
  }
  return null;
}

// Conversations (messages and emails) follow the thread rule; meetings,
// events, calls and contacts keep the per-record rules.
const CONVERSATION = new Set(['message', 'email']);
export const LARGE_GROUP = 8;

function partyReason(p, c) {
  if (!p) return null;
  if (c.people.length && nameMatches(partyName(p), c.people)) return 'person';
  if (handleMatches(p.handle, c)) return 'handle';
  if (c.domains.length && domainIn(domainOf(p.handle), c.domains)) return 'domain';
  return null;
}

// How many people are in the conversation. Groups: the member count or list
// (null when unknown, for example a Slack channel). Emails and direct chats:
// the addresses on the record, owner included.
function conversationSize(v) {
  const count = Number(v.meta.member_count);
  if (Number.isFinite(count) && count > 0) return count;
  if (Array.isArray(v.meta.participants)) return new Set(v.meta.participants).size + (v.isGroup ? 1 : 0);
  if (v.isGroup) return null;
  return new Set(v.people.map((p) => p.handle ?? foldName(partyName(p)))).size;
}

// A message in a large group that names or quotes an excluded person.
function mentionsExcluded(v, c) {
  const folded = ` ${foldName(v.text)} `;
  if (c.people.some((n) => folded.includes(` ${n} `))) return true;
  const digits = v.text.replace(/\D/g, '');
  for (const h of c.handles) {
    const { scheme, value } = parseHandle(h);
    if (scheme === 'mailto' && v.text.includes(value)) return true;
  }
  for (const tail of c.handleTails) if (digits.includes(tail)) return true;
  return false;
}

// { keep, reason?, scope? }. scope 'thread' means every record in the same
// thread goes too (threadGate and purgeExcluded apply that); 'record' means
// only this one.
export function filterRecord(record, config) {
  if (!record || !config?.exclusions) return { keep: true };
  const c = compile(config);
  const v = view(record, c);

  // Whole mail accounts (and the personal-email category).
  const account = normalizeEmail(v.meta.account);
  if (account && c.personalAccounts.has(account)) return { keep: false, reason: 'email-account', scope: 'thread' };

  // Excluded chats, by name, id or group handle: always the whole thread.
  if (c.chats.length) {
    const folded = v.chatNames.map(foldName);
    const ids = [record.thread, ...v.groups.map((g) => g.handle)].filter(Boolean);
    for (const x of c.chats) {
      if (x.folded && folded.includes(x.folded)) return { keep: false, reason: 'chat', scope: 'thread' };
      if (ids.some((id) => id === x.raw || id.endsWith(`:${x.raw}`))) return { keep: false, reason: 'chat', scope: 'thread' };
    }
  }
  if (v.groups.some((g) => handleMatches(g.handle, c))) return { keep: false, reason: 'handle', scope: 'thread' };

  // People, handles and domains.
  const senderHit = v.from && !v.fromIsMe ? partyReason(v.from, c) : null;
  if (CONVERSATION.has(record.kind)) {
    const members = [...v.people, ...(v.meta.participants ?? []).map((h) => ({ handle: h, name: null }))];
    const otherHit = members.filter((p) => p !== v.from && !isOwner(p, c)).map((p) => partyReason(p, c)).find(Boolean) ?? null;
    if (senderHit || otherHit) {
      const size = conversationSize(v);
      const large = size == null ? v.isGroup : size >= LARGE_GROUP;
      // A small thread with an excluded person in it goes whole. In a large
      // group only their own messages and the ones that name them go.
      if (!large) return { keep: false, reason: senderHit ?? otherHit, scope: 'thread' };
      if (senderHit || mentionsExcluded(v, c)) return { keep: false, reason: senderHit ?? otherHit, scope: 'record' };
    }
  } else {
    if (senderHit) return { keep: false, reason: senderHit, scope: 'record' };
    if (c.people.length) {
      const circle = v.counterparts.length <= SMALL_CIRCLE && !v.isGroup;
      if (circle && v.counterparts.some((p) => nameMatches(partyName(p), c.people))) return { keep: false, reason: 'person', scope: 'record' };
      if (v.contactNames.some((n) => nameMatches(n, c.people))) return { keep: false, reason: 'person', scope: 'record' };
    }
    if (c.handles.size || c.handleTails.size) {
      const all = [...v.parties.map((p) => p.handle), ...v.contactHandles];
      if (all.some((h) => handleMatches(h, c))) return { keep: false, reason: 'handle', scope: 'record' };
    }
    if (c.domains.length && anyDomain(v, (d) => domainIn(d, c.domains))) return { keep: false, reason: 'domain', scope: 'record' };
  }

  if (c.keywords.length) {
    const hay = fold(`${record.title ?? ''}\n${record.text ?? ''}\n${v.meta.summary ?? ''}`);
    if (c.keywords.some((re) => re.test(hay))) return { keep: false, reason: 'keyword', scope: 'record' };
  }

  const cat = categoryReason(record, v, c);
  return cat ? { keep: false, ...cat } : { keep: true };
}

// Threads excluded whole are remembered in brain.db (excluded_threads), so a
// later reply in the same thread is left out too, and records already stored
// from that thread are deleted when it is first excluded. Each page is read
// twice: first to find newly excluded threads, then to decide, so the order
// records arrive in never matters.
const THREADS_SQL = 'CREATE TABLE IF NOT EXISTS excluded_threads (thread TEXT PRIMARY KEY, reason TEXT, at TEXT NOT NULL)';

export function threadGate(ctx) {
  const memory = new Set();
  const store = ctx.store;
  const persist = !ctx.dryRun && !!store;
  let has = null;
  let add = null;
  let drop = null;
  if (store) {
    store.ensureTable(THREADS_SQL);
    has = store.db.prepare('SELECT 1 AS x FROM excluded_threads WHERE thread = ?');
    add = store.db.prepare('INSERT OR IGNORE INTO excluded_threads (thread, reason, at) VALUES (?, ?, ?)');
    drop = store.db.prepare('DELETE FROM records WHERE thread = ?');
  }
  const excluded = (thread) => !!thread && (memory.has(thread) || !!has?.get(thread));
  let removed = 0;
  return {
    excluded,
    get removed() {
      return removed;
    },
    // records -> { keep, excluded } after the thread rule.
    filter(records) {
      const checked = records.map((r) => ({ r, res: filterRecord(r, ctx.config) }));
      for (const { r, res } of checked) {
        if (res.keep || res.scope !== 'thread' || !r.thread || excluded(r.thread)) continue;
        memory.add(r.thread);
        if (persist) {
          add.run(r.thread, res.reason ?? null, new Date().toISOString());
          removed += drop.run(r.thread).changes;
        }
      }
      const keep = [];
      let out = 0;
      for (const { r, res } of checked) {
        if (!res.keep || excluded(r.thread)) out++;
        else keep.push(r);
      }
      return { keep, excluded: out };
    },
  };
}

// One name rule everywhere: merge and identity ask this instead of comparing
// names exactly, so "Carla" excluded also leaves out "Carla Diaz".
export function isExcludedName(name, config) {
  if (!name || !config?.exclusions) return false;
  return nameMatches(name, compile(config).people);
}

// Deletes stored records the current exclusions leave out, so a person or
// chat excluded after the install also disappears from brain.db and from
// everything rebuilt from it (identity, dossiers, batches, digests). Runs only
// when the exclusions change: a fingerprint is kept in the store's meta.
export function purgeExcluded(ctx, { force = false } = {}) {
  const store = ctx.store;
  const fp = sha1(JSON.stringify({ exclusions: ctx.config?.exclusions ?? null, owner: ctx.config?.owner ?? null }));
  if (!force && store.getMeta('privacy_fingerprint') === fp) return { checked: 0, removed: 0, skipped: true };
  const page = store.db.prepare('SELECT rowid AS _rowid, * FROM records WHERE rowid > ? ORDER BY rowid LIMIT 2000');
  const del = store.db.prepare('DELETE FROM records WHERE id = ?');
  const gate = threadGate(ctx);
  const each = (fn) => {
    let after = 0;
    for (;;) {
      const rows = page.all(after);
      if (!rows.length) break;
      after = rows.at(-1)._rowid;
      fn(rows.map(rowToRecord));
    }
  };
  // Pass 1: which threads are now excluded whole (the gate deletes their records).
  let checked = 0;
  each((records) => {
    checked += records.length;
    gate.filter(records);
  });
  // Pass 2: single records the rules now leave out.
  const drop = [];
  each((records) => {
    const { keep } = gate.filter(records);
    const kept = new Set(keep.map((r) => r.id));
    for (const r of records) if (!kept.has(r.id)) drop.push(r.id);
  });
  if (!ctx.dryRun) {
    store.db.exec('BEGIN');
    try {
      for (const id of drop) del.run(id);
      store.db.exec('COMMIT');
    } catch (err) {
      store.db.exec('ROLLBACK');
      throw err;
    }
    store.setMeta('privacy_fingerprint', fp);
  }
  return { checked, removed: drop.length + gate.removed };
}

// ---------- scrubText ----------

function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Issuer prefixes and lengths, so timestamps and IDs that happen to pass Luhn
// are left alone.
function cardShaped(d) {
  const n = d.length;
  const p2 = Number(d.slice(0, 2));
  const p3 = Number(d.slice(0, 3));
  const p4 = Number(d.slice(0, 4));
  if (d[0] === '4') return n === 13 || n === 16 || n === 19;
  if (p2 >= 51 && p2 <= 55) return n === 16;
  if (p4 >= 2221 && p4 <= 2720) return n === 16;
  if (p2 === 34 || p2 === 37) return n === 15;
  if (p2 === 36 || p2 === 38 || (p3 >= 300 && p3 <= 305)) return n === 14;
  if (p4 === 6011 || p2 === 65 || (p3 >= 644 && p3 <= 649) || p2 === 62) return n >= 16 && n <= 19;
  if (p4 >= 3528 && p4 <= 3589) return n >= 16 && n <= 19;
  return false;
}

function cardGrouping(raw) {
  const groups = raw.split(/[ -]/).map((g) => g.length);
  if (groups.length === 1) return true;
  const key = groups.join('-');
  if (key === '4-6-5' || key === '4-6-4') return true;
  return groups.slice(0, -1).every((g) => g === 4) && groups.at(-1) >= 1 && groups.at(-1) <= 4;
}

function ibanValid(raw) {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of v) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}

const CARD_RE = /(?<![\d+.,$€£\/-])\d(?:[ -]?\d){12,18}(?![\d.,]\d|\d)/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;
const SSN_RE = /\b(ssn|social security(?: number| no\.?| #)?|ss#|seguro social|numero de seguro social|número de seguro social)\b([^\d\n]{0,25}?)(\d{3})([- ]?)(\d{2})\4(\d{4})\b/gi;
const CODE_WORD = /\b(one[- ]time code|verification code|security code|login code|sign[- ]in code|passcode|otp|pin|code|c[oó]digo|token|clave)\b([^\d\n]{0,25}?)(\d(?:[- ]?\d){3,8})(?![\d])/gi;
const CODE_BEFORE = /\b(\d{4,8})\b(?=[^\n\d]{0,20}\b(is your|es tu|es su|is the|es el)\b[^\n]{0,40}\b(code|c[oó]digo|pin|otp|passcode|clave)\b)/gi;
const GOOGLE_CODE = /\bG-\d{5,8}\b/g;
const NOT_OTP = /(zip|postal|area|promo|promotional|discount|coupon|country|error|status|source|qr|tracking|dress|morse|bar|reference|referral|invite|invitation|gift|voucher|order|product|item|sku|style|class|course|program|tax|naics|sic|hs|cpt|icd|billing|service|de area|de descuento|promocional|de cupon|de rastreo|de referencia|de invitacion|de producto|de pedido)\s*$/i;
const PASSWORD_RE = /\b(password|passwd|pwd|contrase(?:ñ|n)a|(?<!palabra )clave|passcode)(\s*(?:is|es|:|=)\s*)([^\s,;]+)/gi;

export function scrubText(input) {
  if (input == null) return { text: input, redactions: [] };
  let text = String(input);
  const redactions = [];
  const hit = (type) => redactions.push(type);

  text = text.replace(IBAN_RE, (m) => {
    // The match can run into following capitalized words: drop trailing
    // tokens until the checksum passes.
    const tokens = m.split(' ');
    for (let n = tokens.length; n > 0; n--) {
      const candidate = tokens.slice(0, n).join(' ');
      if (ibanValid(candidate)) {
        hit('iban');
        const rest = tokens.slice(n).join(' ');
        return rest ? `[iban] ${rest}` : '[iban]';
      }
    }
    return m;
  });
  text = text.replace(CARD_RE, (m) => {
    const d = m.replace(/[ -]/g, '');
    if (d.length < 13 || d.length > 19 || !cardShaped(d) || !cardGrouping(m) || !luhn(d)) return m;
    hit('card');
    return '[card]';
  });
  text = text.replace(SSN_RE, (m, word, gap, a, sep, b, c) => {
    if (a === '000' || a === '666' || a[0] === '9' || b === '00' || c === '0000') return m;
    hit('ssn');
    return `${word}${gap}[ssn]`;
  });
  text = text.replace(GOOGLE_CODE, () => (hit('code'), '[code]'));
  text = text.replace(CODE_WORD, (m, word, gap, code, offset, whole) => {
    const digits = code.replace(/\D/g, '');
    if (digits.length < 4 || digits.length > 8) return m;
    const before = whole.slice(Math.max(0, offset - 24), offset).normalize('NFKD').replace(/[̀-ͯ]/g, '');
    if (NOT_OTP.test(before) || /(postal|de area|promocional|de descuento)/i.test(gap)) return m;
    if (/^(code|c[oó]digo)$/i.test(word) && /^(19|20)\d\d$/.test(digits)) return m;
    hit('code');
    return `${word}${gap}[code]`;
  });
  text = text.replace(CODE_BEFORE, () => (hit('code'), '[code]'));
  text = text.replace(PASSWORD_RE, (m, word, sep, value) => {
    if (/^\[(code|card|iban|ssn|password)\]/.test(value)) return m;
    const strict = /[:=]/.test(sep);
    const trail = /[.),]+$/.exec(value)?.[0] ?? '';
    const core = trail ? value.slice(0, -trail.length) : value;
    if (!core) return m;
    if (!strict && !(/\d/.test(core) || /[^A-Za-z0-9À-ɏ]/.test(core) || (/[a-z]/.test(core) && /[A-Z]/.test(core.slice(1))))) return m;
    hit('password');
    return `${word}${sep}[password]${trail}`;
  });
  return { text, redactions };
}

// ---------- emailQuery ----------

const GMAIL_BANKING = ['chase.com', 'bankofamerica.com', 'wellsfargo.com', 'capitalone.com', 'citi.com', 'americanexpress.com', 'aexp.com', 'discover.com', 'usbank.com', 'pnc.com', 'schwab.com', 'fidelity.com', 'vanguard.com', 'robinhood.com', 'etrade.com', 'sofi.com', 'ally.com', 'chime.com', 'venmo.com', 'coinbase.com', 'creditkarma.com', 'experian.com', 'bbva.com', 'bbva.mx', 'santander.com', 'banorte.com', 'banamex.com', 'bancolombia.com', 'itau.com', 'nubank.com.br', 'nu.com.mx', 'scotiabank.com', 'hsbc.com'];
const GMAIL_HEALTH = ['mychart.com', 'kp.org', 'cvs.com', 'walgreens.com', 'zocdoc.com', 'onemedical.com', 'labcorp.com', 'questdiagnostics.com', 'goodrx.com', 'express-scripts.com', 'optum.com', 'aetna.com', 'cigna.com', 'uhc.com', 'anthem.com', 'humana.com', 'teladoc.com', 'healow.com', 'followmyhealth.com', 'doctoralia.com'];
const GMAIL_PASSWORDS = ['1password.com', 'lastpass.com', 'bitwarden.com', 'dashlane.com', 'keepersecurity.com', 'nordpass.com', 'authy.com'];
const GMAIL_PASSWORD_SUBJECTS = ['verification code', 'security code', 'password reset', 'reset your password', 'sign-in code', 'login code', 'código de verificación', 'restablecer contraseña'];

const quoteTerm = (t) => (/[\s()]/.test(t) ? `"${String(t).replace(/"/g, '')}"` : String(t));
const orGroup = (terms) => `(${terms.map(quoteTerm).join(' OR ')})`;

export function emailQuery(config) {
  const ex = config?.exclusions ?? {};
  const cats = new Set(ex.categories ?? []);
  const parts = ['-category:promotions', '-category:social', '-in:spam', '-in:trash'];
  const fromDomains = [];
  if (cats.has('banking')) fromDomains.push(...GMAIL_BANKING);
  if (cats.has('health')) fromDomains.push(...GMAIL_HEALTH);
  if (cats.has('passwords')) fromDomains.push(...GMAIL_PASSWORDS);
  fromDomains.push(...(ex.domains ?? []).map((d) => String(d).trim().toLowerCase().replace(/^@/, '')).filter(Boolean));
  const unique = [...new Set(fromDomains)];
  if (unique.length) parts.push(`-from:${orGroup(unique)}`);
  if (cats.has('passwords')) parts.push(`-subject:${orGroup(GMAIL_PASSWORD_SUBJECTS)}`);
  const addrs = [...new Set((ex.handles ?? []).map(normalizeEmail).filter(Boolean))];
  if (addrs.length) parts.push(`-from:${orGroup(addrs)}`, `-to:${orGroup(addrs)}`);
  const people = (ex.people ?? []).map((p) => String(p).trim()).filter(Boolean);
  if (people.length) parts.push(`-from:${orGroup(people)}`);
  const keywords = (ex.keywords ?? []).map((k) => String(k).trim()).filter(Boolean);
  for (const k of keywords) parts.push(`-${quoteTerm(k)}`);
  return parts.join(' ');
}
