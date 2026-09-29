// `confidant identity`: works out who is who across every source.
//
// Deterministic. Every handle seen in records is a node; nodes join through
// Contacts cards (all phones and emails on one card), the last 10 digits of
// a phone, lowercased emails, full-name matches for meeting speakers, and
// the merges already confirmed in .confidant/identity-fixes.json. Person ids
// stay stable across rebuilds, so notes and fixes keep pointing at the same
// person. Writes .confidant/identity.json (CONTRACTS.md, Identity).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from './lib/files.mjs';
import { parseHandle, last10, isShortCode, isAutomatedEmail, phoneHandle, emailHandle, nameHandle } from './lib/handles.mjs';
import { shortHash, fingerprint } from './lib/hash.mjs';
import { normalizeName, nameTokens, prettyHandle, looksLikeHandle, titleCase, emailDomain, FREEMAIL, oneLine } from './lib/b-text.mjs';
import { bPaths, bTables, takeLock, isoNow } from './lib/b-common.mjs';

const DAY = 86400000;
export const TIER_THRESHOLDS = { inner: 75, active: 50, network: 25 };
const INNER_MAX = 30;
const AMBIGUITY_TOP = 300;
const AMBIGUITY_MAX = 60;
const MEETING_MAX_PEOPLE = 11;
const DIRECT_MAX = { message: 1, email: 5 };
export const OWNER_ID = 'owner';

// ---------- handles and small helpers ----------

export function canonHandle(h) {
  if (!h) return null;
  const s = String(h).trim();
  const { scheme, value } = parseHandle(s);
  if (!value) return null;
  if (scheme === 'mailto') return `mailto:${value.toLowerCase()}`;
  if (scheme === 'tel') return phoneHandle(value) ?? s;
  if (scheme === 'name') return nameHandle(value);
  return s;
}

const safeJson = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
const uniq = (xs) => [...new Set(xs)];
const isGroup = (h) => h.startsWith('group:');
const isName = (h) => h.startsWith('name:');
const valueOf = (x) => (x && typeof x === 'object' ? x.value ?? x.address ?? x.number ?? null : x);

function cleanDisplayName(raw) {
  let n = oneLine(raw)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+(via|vía)\s+.+$/i, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
  if (!n || n.length > 60 || looksLikeHandle(n)) return null;
  return n;
}

function topName(names) {
  let best = null;
  let bestN = -1;
  for (const [raw, n] of names) {
    const name = cleanDisplayName(raw);
    if (!name) continue;
    if (n > bestN || (n === bestN && (name.length > best.length || (name.length === best.length && name < best)))) {
      best = name;
      bestN = n;
    }
  }
  return best;
}

function isBulkMeta(meta) {
  if (!meta || typeof meta !== 'object') return false;
  if (meta.bulk === true || meta.is_bulk === true || meta.newsletter === true || meta.list === true) return true;
  const src = { ...meta, ...(meta.headers && typeof meta.headers === 'object' ? meta.headers : {}) };
  for (const [k, v] of Object.entries(src)) {
    const key = k.toLowerCase().replace(/_/g, '-');
    if ((key === 'list-unsubscribe' || key === 'list-id' || key === 'unsubscribe') && v) return true;
    if (key === 'precedence' && /bulk|list|junk/i.test(String(v))) return true;
    if (key === 'auto-submitted' && v && !/^no$/i.test(String(v))) return true;
  }
  return false;
}

class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  add(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  has(x) {
    return this.parent.has(x);
  }
  find(x) {
    while (this.parent.get(x) !== x) {
      const gp = this.parent.get(this.parent.get(x));
      this.parent.set(x, gp);
      x = gp;
    }
    return x;
  }
  // The root of a cluster is always its smallest handle, whatever the order.
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
  clusters() {
    const out = new Map();
    for (const x of this.parent.keys()) {
      const r = this.find(x);
      if (!out.has(r)) out.set(r, []);
      out.get(r).push(x);
    }
    for (const v of out.values()) v.sort();
    return out;
  }
}

// ---------- one pass over the store ----------

function newStat() {
  return { names: new Map(), sources: new Set(), first: Infinity, last: -Infinity, inbound: 0, outbound: 0, meetings: 0, calls: 0, answered: 0, days: new Set(), fromMe: 0, fromOther: 0, bulk: 0, emails: 0, other: 0 };
}

function parseCard(r) {
  const meta = safeJson(r.meta, {});
  const names = uniq([...(meta.names ?? []), r.title, r.from_name].map((n) => oneLine(valueOf(n))).filter(Boolean));
  const handles = uniq([...(meta.phones ?? []).map((p) => phoneHandle(valueOf(p))), ...(meta.emails ?? []).map((e) => emailHandle(valueOf(e)))].filter(Boolean));
  return { id: r.id, name: names.find((n) => !looksLikeHandle(n)) ?? null, names, handles, company: oneLine(meta.company) || null, title: oneLine(meta.title) || null, isMe: !!(meta.is_me || meta.me || meta.isMe) };
}

function scan(ctx) {
  const db = bTables(ctx.store);
  const nowMs = ctx.now.getTime();
  const yearAgo = nowMs - 365 * DAY;
  const H = new Map();
  const T = new Map();
  const cards = [];
  const ownerNames = new Map();
  let records = 0;
  let earliest = Infinity;
  const st = (h) => {
    let s = H.get(h);
    if (!s) H.set(h, (s = newStat()));
    return s;
  };
  const touch = (s, ms, source) => {
    if (ms < s.first) s.first = ms;
    if (ms > s.last) s.last = ms;
    s.sources.add(source);
    if (ms >= yearAgo) s.days.add(Math.floor(ms / DAY));
  };
  const addName = (map, name) => {
    const n = oneLine(name);
    if (n && n.length <= 80) map.set(n, (map.get(n) ?? 0) + 1);
  };
  const stmt = db.prepare(`SELECT id, source, kind, thread, ts_ms, from_handle, from_name, to_json, is_from_me, title,
    CASE WHEN kind IN ('contact', 'email', 'call') THEN meta_json END AS meta FROM records`);
  for (const r of stmt.iterate()) {
    records++;
    if (r.kind === 'contact') {
      cards.push(parseCard(r));
      continue;
    }
    if (r.ts_ms < earliest) earliest = r.ts_ms;
    const fromMe = !!r.is_from_me;
    const fromH = canonHandle(r.from_handle) ?? (!fromMe && r.from_name ? nameHandle(r.from_name) : null);
    if (fromMe && r.from_name) addName(ownerNames, r.from_name);
    const to = [];
    for (const p of safeJson(r.to_json, [])) {
      const h = canonHandle(p?.handle) ?? (p?.name ? nameHandle(p.name) : null);
      if (h) to.push({ h, name: p.name });
    }
    const groupH = [fromH, ...to.map((x) => x.h)].find((h) => h && isGroup(h)) ?? null;
    if (fromH && !isGroup(fromH)) {
      const s = st(fromH);
      if (r.from_name) addName(s.names, r.from_name);
      if (fromMe) s.fromMe++;
      else s.fromOther++;
    }
    const people = [];
    for (const { h, name } of to) {
      if (isGroup(h)) continue;
      const s = st(h);
      if (name) addName(s.names, name);
      people.push(h);
    }
    const ms = r.ts_ms;
    const kind = r.kind;
    if (kind === 'meeting' || kind === 'event' || (kind === 'recording' && people.length)) {
      const attendees = uniq([fromH, ...people].filter((h) => h && !isGroup(h)));
      if (attendees.length <= MEETING_MAX_PEOPLE) {
        for (const h of attendees) {
          const s = st(h);
          s.meetings++;
          s.other++;
          touch(s, ms, r.source);
        }
      }
    } else if (kind === 'call') {
      const meta = safeJson(r.meta, {});
      const other = fromMe ? people[0] : fromH;
      if (other) {
        const s = st(other);
        s.calls++;
        s.other++;
        if (Number(meta.duration_s ?? meta.duration ?? 0) > 0) s.answered++;
        touch(s, ms, r.source);
      }
    } else if (kind === 'message' || kind === 'email') {
      if (!fromMe && fromH && !isGroup(fromH)) {
        const s = st(fromH);
        s.inbound++;
        touch(s, ms, r.source);
        if (kind === 'email') {
          s.emails++;
          if (isBulkMeta(safeJson(r.meta, {}))) s.bulk++;
        } else s.other++;
      }
      if (fromMe && !groupH && people.length > 0 && people.length <= DIRECT_MAX[kind]) {
        for (const h of people) {
          const s = st(h);
          s.outbound++;
          if (kind !== 'email') s.other++;
          touch(s, ms, r.source);
        }
      }
      if (kind === 'message' && r.thread) {
        let t = T.get(r.thread);
        if (!t) T.set(r.thread, (t = { source: r.source, senders: new Set(), recips: new Set(), group: null, names: new Map(), count: 0, last: -Infinity, ownerOnly: { n: 0, days: new Set(), first: Infinity, last: -Infinity } }));
        t.count++;
        if (ms > t.last) t.last = ms;
        if (groupH) {
          t.group = groupH;
          const gp = to.find((x) => x.h === groupH);
          if (gp?.name) addName(t.names, gp.name);
        }
        if (r.title) addName(t.names, r.title);
        if (!fromMe && fromH && !isGroup(fromH)) t.senders.add(fromH);
        for (const h of people) t.recips.add(h);
        if (fromMe && !people.length) {
          const o = t.ownerOnly;
          o.n++;
          if (ms < o.first) o.first = ms;
          if (ms > o.last) o.last = ms;
          if (ms >= yearAgo) o.days.add(Math.floor(ms / DAY));
        }
      }
    }
  }
  return { H, T, cards, ownerNames, records, earliest: Number.isFinite(earliest) ? earliest : null };
}

// ---------- fixes (identity_review results and human confirmations) ----------

export function loadFixes(ctx) {
  const f = readJson(bPaths(ctx).fixes, []);
  return Array.isArray(f) ? f : [];
}

// ---------- build ----------

export function buildIdentity(ctx, { write = true } = {}) {
  const release = write ? takeLock(ctx, 'vault') : () => {};
  try {
    const identity = computeIdentity(ctx);
    if (write && !ctx.dryRun) writeJson(bPaths(ctx).identity, identity);
    return attachIdentity(identity);
  } finally {
    release();
  }
}

function computeIdentity(ctx) {
  const { H, T, cards, ownerNames, records, earliest } = scan(ctx);
  const db = bTables(ctx.store);
  const nowMs = ctx.now.getTime();
  const cfgOwner = ctx.config?.owner ?? {};
  const prior = readJson(bPaths(ctx).identity, null);
  const fixes = loadFixes(ctx);
  const excl = ctx.config?.exclusions ?? {};
  const excludedNames = new Set((excl.people ?? []).map(normalizeName).filter(Boolean));
  const excludedHandles = new Set((excl.handles ?? []).map(canonHandle).filter(Boolean));

  // Owner: configured addresses, handles that mostly send "from me", and the
  // owner's own Contacts card.
  const owner = new Set();
  for (const e of cfgOwner.emails ?? []) {
    const h = emailHandle(e);
    if (h) owner.add(h);
  }
  for (const p of cfgOwner.phones ?? []) {
    const h = phoneHandle(p);
    if (h) owner.add(h);
  }
  for (const [h, s] of H) if (!isGroup(h) && !isName(h) && s.fromMe > 0 && s.fromMe > s.fromOther) owner.add(h);
  let ownerName = oneLine(cfgOwner.name) || null;
  let ownerCard = cards.find((c) => c.isMe) ?? null;
  if (!ownerName) ownerName = ownerCard?.name ?? topName(ownerNames);
  if (!ownerCard && ownerName) ownerCard = cards.find((c) => c.names.some((n) => normalizeName(n) === normalizeName(ownerName))) ?? null;
  if (!ownerCard) ownerCard = cards.find((c) => c.handles.some((h) => owner.has(h)) && c.names.some((n) => ownerName && nameTokens(n)[0] === nameTokens(ownerName)[0])) ?? null;
  if (ownerCard) for (const h of ownerCard.handles) owner.add(h);
  const ownerTel10 = new Set([...owner].map(last10).filter(Boolean));
  const ownerNorm = ownerName ? normalizeName(ownerName) : null;
  const ownerFirst = ownerName ? nameTokens(ownerName)[0] : null;

  const uf = new UnionFind();
  for (const h of H.keys()) if (!isGroup(h)) uf.add(h);
  for (const h of owner) uf.add(h);

  // Contacts cards. A handle on three or more cards is shared (an office
  // line, a family email) and never joins people.
  const onCards = new Map();
  for (const c of cards) for (const h of c.handles) onCards.set(h, (onCards.get(h) ?? 0) + 1);
  const cardHandles = new Map();
  for (const c of cards) {
    const mine = c === ownerCard;
    const hs = c.handles.filter((h) => mine || (onCards.get(h) <= 2 && !owner.has(h) && !ownerTel10.has(last10(h))));
    cardHandles.set(c, hs);
    for (const h of hs) uf.add(h);
    for (let i = 1; i < hs.length; i++) uf.union(hs[0], hs[i]);
  }

  // Same phone written two ways.
  const by10 = new Map();
  for (const h of [...uf.parent.keys()].sort()) {
    const k = last10(h);
    if (!k) continue;
    if (by10.has(k)) uf.union(h, by10.get(k));
    else by10.set(k, h);
  }
  for (const h of uf.parent.keys()) if (ownerTel10.has(last10(h))) owner.add(h);

  // Owner handles are one person.
  const ownerList = [...owner].sort();
  for (let i = 1; i < ownerList.length; i++) uf.union(ownerList[0], ownerList[i]);

  // Confirmed merges.
  const priorById = new Map();
  for (const p of prior?.people ?? []) {
    priorById.set(p.id, p);
    for (const m of p.merged_ids ?? []) if (!priorById.has(m)) priorById.set(m, p);
  }
  const fixHandles = (f) => uniq([...(f.handles ?? []), ...(f.person_ids ?? []).flatMap((id) => priorById.get(id)?.handles ?? [])].map(canonHandle).filter(Boolean));
  const sortedFixes = [...fixes].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
  const preferIds = new Set();
  for (const f of sortedFixes) {
    if (f.action !== 'merge') continue;
    const hs = fixHandles(f).filter((h) => uf.has(h) && !owner.has(h));
    for (let i = 1; i < hs.length; i++) uf.union(hs[0], hs[i]);
    if (f.person_ids?.[0]) preferIds.add(f.person_ids[0]);
  }

  // Meeting speakers known only by name join the one person with that full name.
  const cardsByHandle = new Map();
  for (const c of cards) for (const h of cardHandles.get(c)) if (!cardsByHandle.has(h)) cardsByHandle.set(h, c);
  let clusters = uf.clusters();
  const nameIndex = new Map();
  for (const [root, members] of clusters) {
    if (members.every(isName) || members.some((h) => owner.has(h))) continue;
    const names = new Set();
    for (const h of members) {
      const c = cardsByHandle.get(h);
      if (c?.name) names.add(normalizeName(c.name));
    }
    const merged = new Map();
    for (const h of members) for (const [n, k] of H.get(h)?.names ?? []) merged.set(n, (merged.get(n) ?? 0) + k);
    const display = topName(merged);
    if (display) names.add(normalizeName(display));
    for (const n of names) {
      if (!n) continue;
      if (!nameIndex.has(n)) nameIndex.set(n, new Set());
      nameIndex.get(n).add(root);
    }
  }
  const ownerRoot = ownerList.length ? uf.find(ownerList[0]) : null;
  for (const [, members] of clusters) {
    if (!members.every(isName)) continue;
    for (const h of members) {
      const n = normalizeName(parseHandle(h).value);
      if (ownerNorm && (n === ownerNorm || (ownerFirst && n === ownerFirst))) {
        if (ownerRoot) uf.union(ownerRoot, h);
        else owner.add(h);
        continue;
      }
      const hits = nameIndex.get(n);
      if (nameTokens(n).length >= 2 && hits?.size === 1) uf.union([...hits][0], h);
    }
  }
  clusters = uf.clusters();

  // Owner cluster.
  const ownerHandles = new Set();
  for (const [, members] of clusters) if (members.some((h) => owner.has(h))) for (const h of members) ownerHandles.add(h);
  const rootOf = (h) => (uf.has(h) ? uf.find(h) : null);
  const ownerRoots = new Set([...ownerHandles].map(rootOf));

  // Threads: group chats, and owner messages in one-to-one chats.
  const groups = [];
  const credit = new Map();
  for (const [thread, t] of T) {
    const parts = new Set([...t.senders, ...t.recips].map(rootOf).filter((r) => r && !ownerRoots.has(r)));
    if (t.group || parts.size >= 2) {
      groups.push({ thread, t, members: [...parts].sort() });
    } else if (parts.size === 1 && t.ownerOnly.n) {
      const root = [...parts][0];
      const c = credit.get(root) ?? { n: 0, days: new Set(), first: Infinity, last: -Infinity };
      c.n += t.ownerOnly.n;
      for (const d of t.ownerOnly.days) c.days.add(d);
      c.first = Math.min(c.first, t.ownerOnly.first);
      c.last = Math.max(c.last, t.ownerOnly.last);
      credit.set(root, c);
    }
  }

  // People. Someone only ever copied on an email, with no card and no group
  // chat, is not someone the owner knows.
  const groupRoots = new Set(groups.flatMap((g) => g.members));
  const people = [];
  for (const [root, members] of clusters) {
    if (ownerRoots.has(root)) continue;
    const stats = members.map((h) => H.get(h)).filter(Boolean);
    if (!stats.length) continue;
    const a = newStat();
    for (const s of stats) {
      for (const [n, k] of s.names) a.names.set(n, (a.names.get(n) ?? 0) + k);
      for (const x of s.sources) a.sources.add(x);
      for (const d of s.days) a.days.add(d);
      a.first = Math.min(a.first, s.first);
      a.last = Math.max(a.last, s.last);
      for (const k of ['inbound', 'outbound', 'meetings', 'calls', 'answered', 'bulk', 'emails', 'other']) a[k] += s[k];
    }
    const c = credit.get(root);
    if (c) {
      a.outbound += c.n;
      for (const d of c.days) a.days.add(d);
      a.first = Math.min(a.first, c.first);
      a.last = Math.max(a.last, c.last);
    }
    const memberCards = uniq(members.map((h) => cardsByHandle.get(h)).filter(Boolean)).sort((x, y) => cardHandles.get(y).length - cardHandles.get(x).length || x.id.localeCompare(y.id));
    const card = memberCards[0] ?? null;
    if (a.inbound + a.outbound + a.meetings + a.calls === 0 && !card && !groupRoots.has(root)) continue;
    let name;
    let nameSource;
    const display = topName(a.names);
    if (card?.name) {
      name = card.name;
      nameSource = 'contacts';
    } else if (display) {
      name = display;
      nameSource = 'display';
    } else if (members.some(isName)) {
      name = titleCase(parseHandle(members.find(isName)).value);
      nameSource = 'display';
    } else {
      const pref = members.find((h) => h.startsWith('tel:')) ?? members.find((h) => h.startsWith('mailto:')) ?? members[0];
      name = prettyHandle(pref);
      nameSource = 'handle';
    }
    const aliasSet = new Map();
    for (const cc of memberCards) for (const n of cc.names) if (!looksLikeHandle(n)) aliasSet.set(normalizeName(n), n);
    for (const [n] of [...a.names].sort((x, y) => y[1] - x[1])) {
      const clean = cleanDisplayName(n);
      if (clean && !aliasSet.has(normalizeName(clean))) aliasSet.set(normalizeName(clean), clean);
    }
    aliasSet.delete(normalizeName(name));
    const aliases = [...aliasSet.values()].slice(0, 5);

    const real = members.filter((h) => !isName(h));
    let kind = 'person';
    if (real.length && real.every((h) => isShortCode(h) || isAutomatedEmail(h))) kind = 'system';
    else if (!card && a.bulk > 0 && a.bulk * 2 >= a.emails && a.outbound === 0) kind = 'system';
    else if (!card && a.other === 0 && a.outbound === 0 && a.inbound >= 10) kind = 'system';
    if (members.some((h) => excludedHandles.has(h)) || excludedNames.has(normalizeName(name)) || aliases.some((x) => excludedNames.has(normalizeName(x)))) kind = 'excluded';

    const domains = new Map();
    const ownerDomains = new Set([...ownerHandles].map(emailDomain).filter(Boolean));
    for (const h of members) {
      const d = emailDomain(h);
      if (d && !FREEMAIL.has(d) && !ownerDomains.has(d) && !isAutomatedEmail(h)) domains.set(d, (domains.get(d) ?? 0) + (H.get(h)?.inbound ?? 0) + 1);
    }
    const companyHint = [...domains].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] ?? null;

    const f = Math.min(1, Math.log(1 + a.days.size) / Math.log(121));
    const ago = Number.isFinite(a.last) && a.last > 0 ? Math.max(0, (nowMs - a.last) / DAY) : Infinity;
    const rec = Number.isFinite(ago) ? Math.exp(-ago / 90) : 0;
    const twoWay = (a.inbound > 0 && a.outbound > 0) || a.meetings > 0 || a.answered > 0;
    const strength = kind === 'person' ? Math.round(100 * (0.45 * f + 0.35 * rec + 0.2 * (twoWay ? 1 : 0))) : 0;

    people.push({
      root,
      members,
      person: {
        id: null,
        name,
        name_source: nameSource,
        aliases,
        kind,
        company: card?.company ?? null,
        company_hint: companyHint,
        title: card?.title ?? null,
        handles: members,
        sources: [...a.sources].sort(),
        first_seen: Number.isFinite(a.first) ? new Date(a.first).toISOString() : null,
        last_seen: Number.isFinite(a.last) && a.last > 0 ? new Date(a.last).toISOString() : null,
        messages: a.inbound + a.outbound + a.meetings + a.calls,
        inbound: a.inbound,
        outbound: a.outbound,
        meetings: a.meetings,
        two_way: twoWay,
        strength,
        tier: 'cold',
        note_path: null,
        merged_ids: [],
      },
    });
  }

  // Stable ids: reuse the prior id that shares the most handles, preferring
  // one that already has a note or was named first in a confirmed merge.
  const priorByHandle = new Map();
  for (const p of prior?.people ?? []) for (const h of p.handles ?? []) priorByHandle.set(h, p.id);
  const notePaths = new Map();
  for (const row of db.prepare(`SELECT id, path FROM b_notes WHERE type = 'person'`).all()) notePaths.set(row.id, row.path);
  const plan = people.map((entry) => {
    const counts = new Map();
    for (const h of entry.members) {
      const id = priorByHandle.get(h);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const cands = [...counts].sort(
      (x, y) =>
        (preferIds.has(y[0]) ? 1 : 0) - (preferIds.has(x[0]) ? 1 : 0) ||
        (notePaths.has(y[0]) ? 1 : 0) - (notePaths.has(x[0]) ? 1 : 0) ||
        y[1] - x[1] ||
        (priorById.get(y[0])?.messages ?? 0) - (priorById.get(x[0])?.messages ?? 0) ||
        x[0].localeCompare(y[0]),
    );
    return { entry, cands, overlap: cands[0]?.[1] ?? 0 };
  });
  plan.sort((x, y) => y.overlap - x.overlap || x.entry.root.localeCompare(y.entry.root));
  const used = new Set();
  for (const { entry, cands } of plan) {
    const p = entry.person;
    const pick = cands.find(([id]) => !used.has(id))?.[0];
    let id = pick;
    if (!id) {
      id = `p_${shortHash(entry.root, 10)}`;
      for (let n = 2; used.has(id); n++) id = `p_${shortHash(`${entry.root}#${n}`, 10)}`;
    }
    used.add(id);
    p.id = id;
    const merged = new Set();
    for (const [cid] of cands) {
      if (cid !== id) merged.add(cid);
      for (const m of priorById.get(cid)?.merged_ids ?? []) merged.add(m);
    }
    merged.delete(id);
    p.merged_ids = [...merged].sort();
    const priorPath = priorById.get(id)?.note_path ?? null;
    p.note_path = notePaths.get(id) ?? (priorPath && existsSync(join(ctx.vault, priorPath)) ? priorPath : null);
  }

  const byId = new Map();
  for (const { person } of people) {
    byId.set(person.id, person);
    for (const m of person.merged_ids) if (!byId.has(m)) byId.set(m, person);
  }

  // Other confirmed fixes: names, kinds, companies, not a person.
  for (const f of sortedFixes) {
    if (f.action === 'merge') continue;
    const targets = new Set();
    for (const id of f.person_ids ?? []) if (byId.get(id)) targets.add(byId.get(id));
    const hs = new Set(fixHandles(f));
    if (!targets.size && hs.size) for (const { person } of people) if (person.handles.some((h) => hs.has(h))) targets.add(person);
    for (const p of targets) applyFixFields(p, f);
  }
  const mergeFixes = sortedFixes.filter((f) => f.action === 'merge' && f.name);
  for (const f of mergeFixes) {
    const p = byId.get(f.person_ids?.[0]);
    if (p) applyFixFields(p, { action: 'rename', name: f.name });
  }

  // Tiers.
  const ranked = people.map((x) => x.person).filter((p) => p.kind !== 'system' && p.kind !== 'excluded').sort((x, y) => y.strength - x.strength || x.id.localeCompare(y.id));
  ranked.forEach((p, i) => {
    let tier = p.strength >= TIER_THRESHOLDS.inner ? 'inner' : p.strength >= TIER_THRESHOLDS.active ? 'active' : p.strength >= TIER_THRESHOLDS.network ? 'network' : 'cold';
    if (tier === 'inner' && i >= INNER_MAX) tier = 'active';
    p.tier = tier;
  });

  const rootToId = new Map(people.map((x) => [x.root, x.person.id]));
  const groupOut = groups
    .map(({ thread, t, members }) => {
      const memberIds = members.map((r) => rootToId.get(r)).filter(Boolean);
      const label = topName(t.names) ?? memberIds.map((id) => byId.get(id)?.name?.split(' ')[0]).filter(Boolean).slice(0, 4).join(', ');
      return {
        id: `g_${shortHash(thread, 10)}`,
        name: label || thread,
        thread,
        handles: t.group ? [t.group] : [],
        source: t.source,
        members: memberIds.sort(),
        messages: t.count,
        last_seen: Number.isFinite(t.last) ? new Date(t.last).toISOString() : null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const peopleOut = people.map((x) => x.person).sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id));
  const ambiguous = findAmbiguities(peopleOut);
  const tiers = { inner: 0, active: 0, network: 0, cold: 0 };
  for (const p of peopleOut) if (p.kind !== 'system' && p.kind !== 'excluded') tiers[p.tier]++;
  return {
    version: 1,
    generated_at: isoNow(ctx),
    owner: { person_id: OWNER_ID, name: ownerName ?? '', handles: [...ownerHandles].sort() },
    people: peopleOut,
    groups: groupOut,
    ambiguous,
    stats: {
      records,
      earliest: earliest ? new Date(earliest).toISOString() : null,
      handles: H.size,
      people: peopleOut.filter((p) => p.kind !== 'system' && p.kind !== 'excluded').length,
      system: peopleOut.filter((p) => p.kind === 'system').length,
      excluded: peopleOut.filter((p) => p.kind === 'excluded').length,
      groups: groupOut.length,
      tiers,
    },
  };
}

function applyFixFields(p, f) {
  if (f.action === 'rename' && f.name) {
    const next = oneLine(f.name);
    const keepOld = p.name_source !== 'handle' && normalizeName(p.name) !== normalizeName(next);
    p.aliases = uniq([...(keepOld ? [p.name] : []), ...p.aliases]).filter((a) => normalizeName(a) !== normalizeName(next)).slice(0, 5);
    p.name = next;
    p.name_source = 'fix';
  }
  if (f.action === 'set_kind' && f.kind) p.kind = f.kind === 'person' || f.kind === 'system' ? f.kind : oneLine(f.kind).toLowerCase();
  if (f.action === 'set_company' && f.company) p.company = oneLine(f.company);
  if (f.action === 'not_a_person') p.kind = 'system';
  if (p.kind === 'system') {
    p.strength = 0;
    p.tier = 'cold';
  }
}

// Same name on different people, and single-word names, among the people
// who matter most. These become identity_review batches.
function findAmbiguities(people) {
  const top = people.filter((p) => p.kind !== 'system' && p.kind !== 'excluded').slice(0, AMBIGUITY_TOP);
  const out = [];
  const byNorm = new Map();
  for (const p of top) {
    const n = normalizeName(p.name);
    if (!n || p.name_source === 'handle') continue;
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n).push(p);
  }
  for (const [, ps] of byNorm) {
    if (ps.length < 2) continue;
    const ids = ps.map((p) => p.id).sort();
    out.push({ key: fingerprint('same_name', ids), reason: 'same_name', name: ps[0].name, person_ids: ids });
  }
  for (const p of top) {
    const toks = nameTokens(p.name);
    if (toks.length !== 1 || p.name_source === 'contacts' || p.name_source === 'fix') continue;
    const cands = top.filter((q) => q.id !== p.id && nameTokens(q.name)[0] === toks[0] && nameTokens(q.name).length > 1).map((q) => q.id);
    const ids = [p.id, ...cands.sort()];
    out.push({ key: fingerprint('single_name', ids), reason: 'single_name', name: p.name, person_ids: ids });
  }
  return out.slice(0, AMBIGUITY_MAX);
}

// ---------- loading ----------

export function emptyIdentity() {
  return { version: 1, generated_at: null, owner: { person_id: OWNER_ID, name: '', handles: [] }, people: [], groups: [], ambiguous: [], stats: {} };
}

// Adds lookups that never serialize: byHandle, byId, byName, groupByThread.
export function attachIdentity(data) {
  const byH = new Map();
  const by10 = new Map();
  const byId = new Map();
  const byNorm = new Map();
  const groupsByThread = new Map();
  const owner = { id: data.owner?.person_id ?? OWNER_ID, kind: 'owner', name: data.owner?.name ?? '', handles: data.owner?.handles ?? [], aliases: [] };
  const index = (p) => {
    for (const h of p.handles ?? []) {
      byH.set(h, p);
      const k = last10(h);
      if (k && !by10.has(k)) by10.set(k, p);
    }
    for (const n of [p.name, ...(p.aliases ?? [])]) {
      const k = normalizeName(n);
      if (!k) continue;
      if (!byNorm.has(k)) byNorm.set(k, []);
      if (!byNorm.get(k).includes(p)) byNorm.get(k).push(p);
    }
  };
  index(owner);
  byId.set(owner.id, owner);
  for (const p of data.people ?? []) {
    index(p);
    byId.set(p.id, p);
  }
  for (const p of data.people ?? []) for (const m of p.merged_ids ?? []) if (!byId.has(m)) byId.set(m, p);
  for (const g of data.groups ?? []) groupsByThread.set(g.thread, g);
  Object.defineProperties(data, {
    ownerPerson: { value: owner, enumerable: false, configurable: true },
    byHandle: {
      enumerable: false,
      configurable: true,
      value(h) {
        const c = canonHandle(h);
        if (!c) return null;
        return byH.get(c) ?? (last10(c) ? by10.get(last10(c)) : null) ?? null;
      },
    },
    byId: { enumerable: false, configurable: true, value: (id) => byId.get(id) ?? null },
    byName: { enumerable: false, configurable: true, value: (name) => byNorm.get(normalizeName(name)) ?? [] },
    groupByThread: { enumerable: false, configurable: true, value: (thread) => groupsByThread.get(thread) ?? null },
    isOwner: { enumerable: false, configurable: true, value: (p) => !!p && (p === owner || p.id === owner.id) },
  });
  return data;
}

export function loadIdentity(ctx, { build = false } = {}) {
  const data = ctx.paths ? readJson(bPaths(ctx).identity, null) : null;
  if (!data && build) return buildIdentity(ctx);
  return attachIdentity(data ?? emptyIdentity());
}

export function saveIdentity(ctx, identity) {
  if (!ctx.dryRun) writeJson(bPaths(ctx).identity, identity);
  return attachIdentity(identity);
}

// Store fixes from a contribution (with the handles they cover, so rebuilds
// keep them) and apply them to the current identity right away.
export function recordFixes(ctx, identity, fixes, { batchId, runId } = {}) {
  if (!fixes?.length) return { identity, applied: 0 };
  const stored = loadFixes(ctx);
  const at = isoNow(ctx);
  let applied = 0;
  for (const raw of fixes) {
    const persons = uniq((raw.person_ids ?? []).map((id) => identity.byId(id)).filter((p) => p && !identity.isOwner(p)));
    if (!persons.length) continue;
    const fix = {
      action: raw.action,
      person_ids: persons.map((p) => p.id),
      handles: uniq(persons.flatMap((p) => p.handles)).sort(),
      ...(raw.name ? { name: oneLine(raw.name) } : {}),
      ...(raw.kind ? { kind: oneLine(raw.kind) } : {}),
      ...(raw.company ? { company: oneLine(raw.company) } : {}),
      at,
      ...(batchId ? { batch_id: batchId } : {}),
      ...(runId ? { run_id: runId } : {}),
    };
    if (fix.action === 'merge') {
      if (persons.length < 2) continue;
      const keep = persons[0];
      for (const other of persons.slice(1)) {
        keep.handles = uniq([...keep.handles, ...other.handles]).sort();
        keep.sources = uniq([...keep.sources, ...other.sources]).sort();
        keep.aliases = uniq([...keep.aliases, other.name, ...other.aliases]).filter((a) => normalizeName(a) !== normalizeName(keep.name) && !looksLikeHandle(a)).slice(0, 5);
        keep.merged_ids = uniq([...keep.merged_ids, other.id, ...other.merged_ids]).filter((id) => id !== keep.id).sort();
        for (const k of ['messages', 'inbound', 'outbound', 'meetings']) keep[k] = (keep[k] ?? 0) + (other[k] ?? 0);
        keep.first_seen = [keep.first_seen, other.first_seen].filter(Boolean).sort()[0] ?? null;
        keep.last_seen = [keep.last_seen, other.last_seen].filter(Boolean).sort().pop() ?? null;
        keep.two_way = keep.two_way || other.two_way;
        keep.strength = Math.max(keep.strength, other.strength);
        const order = ['inner', 'active', 'network', 'cold'];
        keep.tier = order[Math.min(order.indexOf(keep.tier), order.indexOf(other.tier))];
        keep.note_path = keep.note_path ?? other.note_path;
        if (keep.name_source === 'handle' && other.name_source !== 'handle') {
          keep.name = other.name;
          keep.name_source = other.name_source;
        }
        keep.company = keep.company ?? other.company;
        identity.people = identity.people.filter((p) => p !== other);
      }
      if (fix.name) applyFixFields(keep, { action: 'rename', name: fix.name });
    } else {
      for (const p of persons) applyFixFields(p, fix);
    }
    stored.push(fix);
    applied++;
  }
  if (!applied) return { identity, applied };
  identity.ambiguous = findAmbiguities(identity.people);
  if (!ctx.dryRun) writeJson(bPaths(ctx).fixes, stored);
  return { identity: saveIdentity(ctx, identity), applied };
}

// ---------- CLI ----------

export async function run(args, ctx) {
  const identity = buildIdentity(ctx);
  const s = identity.stats;
  ctx.log.out(
    { owner: identity.owner, stats: s, ambiguous: identity.ambiguous.length, path: bPaths(ctx).identity },
    `${s.people} people (${s.tiers.inner} inner, ${s.tiers.active} active, ${s.tiers.network} network, ${s.tiers.cold} cold), ${s.groups} group chats, ${s.system} automated senders left out. ${identity.ambiguous.length} names to double check.`,
  );
  return 0;
}
