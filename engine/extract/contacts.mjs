// Contacts cards from every AddressBook database (one per account).
// kind contact, text '', meta { names[], phones[] (E.164), emails[], company, title }.
// Cursor: a per-database watermark on (modification date, Z_PK), so edited
// cards are picked up again on later runs.
import { canRead } from '../lib/sqlite.mjs';
import { fromAppleTime } from '../lib/time.mjs';
import { addressBookDbs, readCards } from '../lib/a-addressbook.mjs';
import { openCopy, readCursor, writeCursor, afterMark, ownerOf, accessError } from '../lib/a-local.mjs';
import { guardProbe, guardExtract, notOk } from '../lib/a-reasons.mjs';

export const id = 'contacts';

async function runProbe(ctx) {
  const dbs = addressBookDbs(ctx);
  if (!dbs.length) return notOk(ctx, id, 'not_installed', 'Contacts database not found on this Mac');
  let count = 0;
  let readable = 0;
  for (const { path } of dbs) {
    const access = canRead(path);
    if (!access.ok) {
      if (access.needsFullDiskAccess) return notOk(ctx, id, 'needs_full_disk_access');
      continue;
    }
    readable++;
    try {
      count += readCards(openCopy(ctx, path)).length;
    } catch {}
  }
  return readable ? { ok: true, count } : notOk(ctx, id, 'unreadable', 'Contacts database not readable');
}

function toRecord(ctx, card, key, owner) {
  const handles = [...card.phones.map((p) => `tel:${p}`), ...card.emails.map((e) => `mailto:${e}`)];
  const name = card.names[0] ?? card.company ?? null;
  const ts = fromAppleTime(card.modified ?? card.created) ?? new Date(ctx.now ?? Date.now()).toISOString();
  return {
    id: `contacts:${key}:${card.uid}`,
    source: 'contacts',
    kind: 'contact',
    thread: null,
    ts,
    from: { handle: handles[0] ?? null, name },
    to: [],
    is_from_me: handles.some((h) => owner.isMe(h)),
    title: name,
    text: '',
    url: null,
    meta: {
      names: card.names,
      phones: card.phones,
      emails: card.emails,
      company: card.company,
      title: card.title,
      ...(card.department ? { department: card.department } : {}),
      book: key,
    },
  };
}

async function runExtract(ctx, { cursor, limit = 2000 } = {}) {
  const marks = readCursor(cursor)?.marks ?? {};
  const owner = ownerOf(ctx);
  const records = [];
  let done = true;
  for (const { path, key } of addressBookDbs(ctx)) {
    if (records.length >= limit) {
      done = false;
      break;
    }
    const access = canRead(path);
    if (!access.ok) {
      if (access.needsFullDiskAccess) throw accessError(Object.assign(new Error('Cannot read Contacts'), { code: access.code }), path);
      continue;
    }
    const cards = readCards(openCopy(ctx, path)).map((c) => ({ ...c, id: String(c.pk).padStart(12, '0') }));
    const pending = afterMark(cards, marks[key]);
    const take = pending.slice(0, limit - records.length);
    for (const card of take) records.push(toRecord(ctx, card, key, owner));
    if (take.length) marks[key] = { mark: take.at(-1).mark, id: take.at(-1).id };
    if (take.length < pending.length) done = false;
  }
  return { records, cursor: writeCursor({ marks }), done };
}

export const probe = guardProbe(id, runProbe);
export const extract = guardExtract(id, runExtract);
