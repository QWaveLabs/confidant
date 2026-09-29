// macOS Contacts (AddressBook). The top-level database is nearly empty; real
// cards live in Sources/<account UUID>/AddressBook-v22.abcddb, one per account
// (iCloud, Google, Exchange). Used by the contacts extractor and, best effort,
// to put names on iMessage, call and WhatsApp handles.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { canRead } from './sqlite.mjs';
import { normalizeEmail, normalizePhone, last10, parseHandle } from './handles.mjs';
import { libraryPath, listDir, openCopy, columns, tableNames, homeOf } from './a-local.mjs';

const DB_NAME = 'AddressBook-v22.abcddb';

export function addressBookRoot(ctx) {
  return libraryPath(ctx, 'Application Support', 'AddressBook');
}

// [{ path, key }] for every AddressBook database that exists.
export function addressBookDbs(ctx) {
  const root = addressBookRoot(ctx);
  const out = [];
  const top = join(root, DB_NAME);
  if (existsSync(top)) out.push({ path: top, key: 'main' });
  for (const d of listDir(join(root, 'Sources')).sort()) {
    const p = join(root, 'Sources', d, DB_NAME);
    if (existsSync(p)) out.push({ path: p, key: d });
  }
  return out;
}

export function displayName({ first, middle, last, nickname, org }) {
  const n = [first, middle, last].filter((x) => x && String(x).trim()).join(' ').trim();
  return n || String(org ?? '').trim() || String(nickname ?? '').trim() || null;
}

// Every card in one database: { pk, uid, mark, names, phones, emails, company, title, raw }.
export function readCards(db) {
  const tables = tableNames(db);
  if (!tables.has('zabcdrecord')) return [];
  const c = columns(db, 'ZABCDRECORD');
  let entFilter = '';
  if (tables.has('z_primarykey') && c.has('Z_ENT')) {
    const ent = db.prepare("SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ABCDContact'").get()?.Z_ENT;
    if (ent != null) entFilter = `WHERE r.Z_ENT = ${Number(ent)}`;
  }
  const rows = db
    .prepare(
      `SELECT r.Z_PK AS pk, ${c.pick('ZUNIQUEID', 'uid', 'r.ZUNIQUEID')}, ${c.pick('ZFIRSTNAME', 'first', 'r.ZFIRSTNAME')},
        ${c.pick('ZMIDDLENAME', 'middle', 'r.ZMIDDLENAME')}, ${c.pick('ZLASTNAME', 'last', 'r.ZLASTNAME')},
        ${c.pick('ZNICKNAME', 'nickname', 'r.ZNICKNAME')}, ${c.pick('ZORGANIZATION', 'org', 'r.ZORGANIZATION')},
        ${c.pick('ZJOBTITLE', 'job', 'r.ZJOBTITLE')}, ${c.pick('ZDEPARTMENT', 'dept', 'r.ZDEPARTMENT')},
        ${c.pick('ZNAME', 'group_name', 'r.ZNAME')},
        ${c.pick('ZMODIFICATIONDATE', 'modified', 'r.ZMODIFICATIONDATE')}, ${c.pick('ZCREATIONDATE', 'created', 'r.ZCREATIONDATE')}
       FROM ZABCDRECORD r ${entFilter}`,
    )
    .all();
  const phones = new Map();
  if (tables.has('zabcdphonenumber')) {
    for (const p of db.prepare('SELECT ZOWNER AS owner, ZFULLNUMBER AS num FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL ORDER BY ZOWNER, Z_PK').all()) {
      const n = normalizePhone(p.num);
      if (!n) continue;
      if (!phones.has(p.owner)) phones.set(p.owner, []);
      if (!phones.get(p.owner).includes(n)) phones.get(p.owner).push(n);
    }
  }
  const emails = new Map();
  if (tables.has('zabcdemailaddress')) {
    for (const e of db.prepare('SELECT ZOWNER AS owner, ZADDRESS AS addr FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL ORDER BY ZOWNER, Z_PK').all()) {
      const n = normalizeEmail(e.addr);
      if (!n) continue;
      if (!emails.has(e.owner)) emails.set(e.owner, []);
      if (!emails.get(e.owner).includes(n)) emails.get(e.owner).push(n);
    }
  }
  const cards = [];
  for (const r of rows) {
    const name = displayName(r);
    // Groups share this table: a ZNAME and no person or company fields.
    if (r.group_name && !r.first && !r.last && !r.org) continue;
    const ph = phones.get(r.pk) ?? [];
    const em = emails.get(r.pk) ?? [];
    if (!name && !ph.length && !em.length) continue;
    const names = [name, r.nickname && r.nickname !== name ? String(r.nickname).trim() : null].filter(Boolean);
    cards.push({
      pk: r.pk,
      uid: r.uid ?? `pk${r.pk}`,
      mark: Number(r.modified ?? r.created ?? 0),
      names,
      phones: ph,
      emails: em,
      company: r.org ? String(r.org).trim() : null,
      title: r.job ? String(r.job).trim() : null,
      department: r.dept ? String(r.dept).trim() : null,
      created: r.created,
      modified: r.modified,
    });
  }
  return cards;
}

// Best effort name lookup: never throws. Missing access just means no names.
const maps = new Map();
export function contactNames(ctx) {
  const key = homeOf(ctx);
  if (maps.has(key)) return maps.get(key);
  const byTail = new Map();
  const byEmail = new Map();
  try {
    for (const { path } of addressBookDbs(ctx)) {
      if (!canRead(path).ok) continue;
      try {
        for (const card of readCards(openCopy(ctx, path))) {
          const name = card.names[0];
          if (!name) continue;
          for (const p of card.phones) {
            const t = last10(`tel:${p}`) ?? p.replace(/\D/g, '');
            if (!byTail.has(t)) byTail.set(t, name);
          }
          for (const e of card.emails) if (!byEmail.has(e)) byEmail.set(e, name);
        }
      } catch {}
    }
  } catch {}
  const api = {
    size: byTail.size + byEmail.size,
    nameFor(handle) {
      if (!handle) return null;
      const { scheme, value } = parseHandle(handle);
      if (scheme === 'mailto') return byEmail.get(value) ?? null;
      if (scheme === 'tel') return byTail.get(last10(handle) ?? value.replace(/\D/g, '')) ?? null;
      return null;
    },
  };
  maps.set(key, api);
  return api;
}

export function resetContactNames() {
  maps.clear();
}
