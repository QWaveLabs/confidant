// Email from Apple Mail: the universal path for Gmail, Outlook, iCloud and
// IMAP accounts, and the way to read the whole history without the model.
//   ~/Library/Mail/V*/MailData/Envelope Index   messages, subjects, summaries,
//                                               addresses, recipients, mailboxes,
//                                               message_global_data, labels
//   ~/Library/Mail/V*/<account>/<box>.mbox/<store>/Data/<shard>/Messages/<ROWID>.emlx
//   (shard = digits of floor(ROWID / 1000), reversed). .partial.emlx has its
//   attachments stored apart; the text is still inside.
// Mailbox urls look like imap://<ACCOUNT-UUID>/INBOX. The UUID maps to an
// address through ~/Library/Accounts/Accounts4.sqlite, or through the senders
// of that account's Sent mailbox.
// Skips Junk, Spam, Trash, Drafts and Outbox, deleted rows, and accounts in
// config.exclusions.emailAccounts. Cursor: newest first by ROWID, then new rows.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { emailHandle, normalizeEmail } from '../lib/handles.mjs';
import { shortHash } from '../lib/hash.mjs';
import { canRead } from '../lib/sqlite.mjs';
import { fromAppleTime, fromUnix } from '../lib/time.mjs';
import { emlxMessage, parseMessage, trimQuoted } from '../lib/a-mime.mjs';
import { libraryPath, unreadable, openCopy, columns, tableNames, pageByKey, ownerOf, cleanText, clip, listDir, accessError } from '../lib/a-local.mjs';

export const id = 'email';
const MAX_TEXT = 20000;
const MAX_FILE = 25 * 1024 * 1024;

// The newest ~/Library/Mail/V* folder that has an Envelope Index.
export function mailRoot(ctx) {
  const base = libraryPath(ctx, 'Mail');
  const versions = listDir(base)
    .filter((d) => /^V\d+$/.test(d))
    .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  for (const v of versions) {
    const index = join(base, v, 'MailData', 'Envelope Index');
    if (existsSync(index)) return { root: join(base, v), index };
  }
  return null;
}

const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const SKIP_BOX = /^(junk|junk e-?mail|spam|bulk mail|trash|deleted messages|deleted items|bin|papelera|papelera de reciclaje|correo no deseado|no deseado|elementos eliminados|drafts|borradores|outbox|bandeja de salida|notes|notas)$/;
const SENT_BOX = /^(sent|sent messages|sent items|sent mail|enviados|elementos enviados|correo enviado|mensajes enviados|enviado)$/;

// imap://UUID/%5BGmail%5D/All%20Mail -> { scheme, host, segments }
export function parseMailboxUrl(url) {
  const m = /^([a-z]+):\/\/([^/]*)\/?(.*)$/i.exec(String(url ?? ''));
  if (!m) return null;
  const segments = m[3]
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  return { scheme: m[1].toLowerCase(), host: m[2], segments };
}

function boxKind(segments) {
  const last = fold(segments.at(-1) ?? '');
  const joined = fold(segments.join('/'));
  if (SKIP_BOX.test(last) || /^\[gmail\]\/(spam|trash|drafts|bin|papelera|borradores)$/.test(joined)) return 'skip';
  if (SENT_BOX.test(last)) return 'sent';
  return 'mail';
}

function accountAddresses(ctx, db, mailboxes) {
  const byAccount = new Map();
  const add = (account, addr) => {
    const e = normalizeEmail(addr);
    if (!e) return;
    if (!byAccount.has(account)) byAccount.set(account, new Set());
    byAccount.get(account).add(e);
  };
  for (const box of mailboxes.values()) {
    const host = box.account;
    if (host.includes('@')) add(host, decodeURIComponent(host.slice(0, host.lastIndexOf('@'))));
  }
  const accountsDb = libraryPath(ctx, 'Accounts', 'Accounts4.sqlite');
  if (existsSync(accountsDb) && canRead(accountsDb).ok) {
    try {
      const adb = openCopy(ctx, accountsDb);
      const ac = columns(adb, 'ZACCOUNT');
      const rows = adb.prepare(`SELECT Z_PK AS pk, ZIDENTIFIER AS ident, ${ac.pick('ZUSERNAME', 'user')}, ${ac.pick('ZPARENTACCOUNT', 'parent')}, ${ac.pick('ZACCOUNTDESCRIPTION', 'descr')} FROM ZACCOUNT`).all();
      const byPk = new Map(rows.map((r) => [r.pk, r]));
      for (const r of rows) {
        const addr = normalizeEmail(r.user) ?? normalizeEmail(byPk.get(r.parent)?.user) ?? normalizeEmail(r.descr);
        if (addr && r.ident) add(r.ident, addr);
      }
    } catch {}
  }
  const sentIds = new Map();
  for (const [rowid, box] of mailboxes) if (box.kind === 'sent') (sentIds.get(box.account) ?? sentIds.set(box.account, []).get(box.account)).push(rowid);
  for (const [account, rowids] of sentIds) {
    try {
      const rows = db
        .prepare(`SELECT DISTINCT a.address AS address FROM messages m JOIN addresses a ON a.ROWID = m.sender WHERE m.mailbox IN (${rowids.map(Number).join(',')}) LIMIT 20`)
        .all();
      for (const r of rows) add(account, r.address);
    } catch {}
  }
  return byAccount;
}

const LOOKUPS = new WeakMap();
function loadLookups(ctx, db, root) {
  if (LOOKUPS.has(db)) return LOOKUPS.get(db);
  const tables = tableNames(db);
  const mailboxes = new Map();
  for (const b of db.prepare('SELECT ROWID AS rowid, url FROM mailboxes').all()) {
    const u = parseMailboxUrl(b.url);
    if (!u) continue;
    mailboxes.set(b.rowid, { url: b.url, scheme: u.scheme, account: u.host, segments: u.segments, kind: boxKind(u.segments), name: u.segments.join('/') });
  }
  const accounts = accountAddresses(ctx, db, mailboxes);
  const owner = ownerOf(ctx);
  const mine = new Set(owner.emails);
  for (const set of accounts.values()) for (const e of set) mine.add(e);
  const excluded = new Set((ctx.config?.exclusions?.emailAccounts ?? []).map(normalizeEmail).filter(Boolean));
  for (const box of mailboxes.values()) {
    const addrs = [...(accounts.get(box.account) ?? [])];
    box.address = addrs[0] ?? null;
    if (addrs.some((a) => excluded.has(a))) box.excluded = true;
  }
  const mc = columns(db, 'messages');
  const joins = [];
  const sel = [
    'm.ROWID AS pk',
    mc.has('message_id') ? 'CAST(m.message_id AS TEXT) AS mid_hash' : 'NULL AS mid_hash',
    mc.pick('subject_prefix', 'subject_prefix', 'm.subject_prefix'),
    mc.pick('date_sent', 'date_sent', 'm.date_sent'),
    mc.pick('date_received', 'date_received', 'm.date_received'),
    'm.mailbox AS mailbox',
    mc.has('conversation_id') ? 'CAST(m.conversation_id AS TEXT) AS conv' : 'NULL AS conv',
    mc.pick('read', 'is_read', 'm.read'),
    mc.pick('flagged', 'flagged', 'm.flagged'),
    mc.pick('deleted', 'deleted', 'm.deleted'),
    mc.has('list_id_hash') ? 'CAST(m.list_id_hash AS TEXT) AS list_id' : 'NULL AS list_id',
    mc.pick('unsubscribe_type', 'unsub', 'm.unsubscribe_type'),
  ];
  if (tables.has('subjects')) {
    joins.push('LEFT JOIN subjects s ON s.ROWID = m.subject');
    sel.push('s.subject AS subject');
  } else sel.push('NULL AS subject');
  if (tables.has('summaries') && mc.has('summary')) {
    joins.push('LEFT JOIN summaries su ON su.ROWID = m.summary');
    sel.push('su.summary AS summary');
  } else sel.push('NULL AS summary');
  joins.push('LEFT JOIN addresses a ON a.ROWID = m.sender');
  sel.push('a.address AS from_addr', 'a.comment AS from_name');
  if (tables.has('message_global_data') && mc.has('global_message_id') && columns(db, 'message_global_data').has('message_id_header')) {
    joins.push('LEFT JOIN message_global_data g ON g.ROWID = m.global_message_id');
    sel.push('g.message_id_header AS mid_header');
  } else sel.push('NULL AS mid_header');
  const select = `SELECT ${sel.join(', ')} FROM messages m ${joins.join(' ')}`;
  const maxDate = db.prepare(`SELECT MAX(${mc.has('date_received') ? 'date_received' : 'date_sent'}) AS d FROM messages`).get().d ?? 0;
  const value = {
    root,
    mailboxes,
    mine,
    unix: Number(maxDate) > 1.2e9,
    after: db.prepare(`${select} WHERE m.ROWID > ? ORDER BY m.ROWID ASC LIMIT ?`),
    before: db.prepare(`${select} WHERE m.ROWID < ? ORDER BY m.ROWID DESC LIMIT ?`),
    recipients: tables.has('recipients')
      ? db.prepare('SELECT r.message AS msg, r.type AS type, r.position AS pos, a.address AS address, a.comment AS name FROM recipients r JOIN addresses a ON a.ROWID = r.address WHERE r.message BETWEEN ? AND ? ORDER BY r.message, r.type, r.position')
      : null,
    labels: tables.has('labels') ? db.prepare('SELECT message_id AS msg, mailbox_id AS box FROM labels WHERE message_id BETWEEN ? AND ?') : null,
    max: () => db.prepare('SELECT MAX(ROWID) AS m FROM messages').get().m ?? 0,
    index: new Map(),
    stores: new Map(),
  };
  LOOKUPS.set(db, value);
  return value;
}

export async function probe(ctx) {
  let found;
  try {
    found = mailRoot(ctx);
  } catch (err) {
    return { ok: false, reason: 'needs Full Disk Access', needsFullDiskAccess: !!err.needsFullDiskAccess };
  }
  if (!found) return { ok: false, reason: 'Mail app data not found on this Mac' };
  const bad = unreadable(found.index, 'Mail index');
  if (bad) return bad;
  const db = openCopy(ctx, found.index);
  return { ok: true, count: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n };
}

// ---------- .emlx files ----------
const shard = (rowid) => String(Math.floor(rowid / 1000)).split('').reverse().join('/');

function mailboxDir(L, box) {
  if (box.scheme === 'local') return join(L.root, 'Mailboxes', ...box.segments.map((s) => `${s}.mbox`));
  return join(L.root, box.account, ...box.segments.map((s) => `${s}.mbox`));
}

function walkEmlx(dir, out, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name !== 'Attachments') walkEmlx(join(dir, e.name), out, depth + 1);
    } else {
      const m = /^(\d+)(\.partial)?\.emlx$/.exec(e.name);
      if (m && (!out.has(Number(m[1])) || !m[2])) out.set(Number(m[1]), join(dir, e.name));
    }
  }
}

export function findEmlx(L, rowid, box) {
  const names = [`${rowid}.emlx`, `${rowid}.partial.emlx`];
  if (box) {
    const dir = mailboxDir(L, box);
    const shards = [shard(rowid), rowid < 1000 ? '' : null].filter((s) => s !== null);
    if (!L.stores.has(dir)) L.stores.set(dir, listDir(dir).filter((d) => /^[0-9A-F-]{36}$/i.test(d)));
    const stores = L.stores.get(dir);
    for (const store of stores) {
      for (const s of shards) {
        for (const n of names) {
          const p = join(dir, store, 'Data', s, 'Messages', n);
          if (existsSync(p)) return p;
        }
      }
    }
    for (const n of names) {
      const p = join(dir, 'Messages', n);
      if (existsSync(p)) return p;
    }
  }
  // Fallback: index every .emlx under the account (or the whole store) once.
  const key = box && box.scheme !== 'local' && !box.account.includes('@') ? join(L.root, box.account) : L.root;
  if (!L.index.has(key)) {
    const map = new Map();
    walkEmlx(key, map);
    L.index.set(key, map);
  }
  return L.index.get(key).get(rowid) ?? null;
}

function readBody(file) {
  try {
    if (statSync(file).size > MAX_FILE) return null;
    return parseMessage(emlxMessage(readFileSync(file)));
  } catch {
    return null;
  }
}

// ---------- records ----------
const normSubject = (s) => fold(s).replace(/^((re|fw|fwd|rv|tr|aw|wg|rif|sv|vs|ref)\s*(\[\d+\])?\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim();

function toRecords(ctx, L, rows) {
  if (!rows.length) return [];
  const lo = Math.min(...rows.map((r) => r.pk));
  const hi = Math.max(...rows.map((r) => r.pk));
  const rcpt = new Map();
  if (L.recipients) {
    for (const r of L.recipients.all(lo, hi)) {
      if (!rcpt.has(r.msg)) rcpt.set(r.msg, []);
      rcpt.get(r.msg).push(r);
    }
  }
  const labels = new Map();
  if (L.labels) {
    for (const l of L.labels.all(lo, hi)) {
      if (!labels.has(l.msg)) labels.set(l.msg, []);
      labels.get(l.msg).push(l.box);
    }
  }
  const toIso = (v) => (v == null || !Number(v) ? null : L.unix ? fromUnix(Number(v)) : fromAppleTime(Number(v)));
  const out = [];
  for (const r of rows) {
    if (Number(r.deleted)) continue;
    const box = L.mailboxes.get(r.mailbox);
    if (!box || box.kind === 'skip' || box.excluded) continue;
    const boxLabels = (labels.get(r.pk) ?? []).map((b) => L.mailboxes.get(b)).filter(Boolean);
    if (boxLabels.some((b) => b.kind === 'skip')) continue;
    const ts = toIso(r.date_sent) ?? toIso(r.date_received);
    if (!ts) continue;
    const file = findEmlx(L, r.pk, box);
    const parsed = file ? readBody(file) : null;
    const subject = `${r.subject_prefix ?? ''}${r.subject ?? parsed?.subject ?? ''}`.trim() || null;
    const forwarded = /^(fw|fwd|rv|tr|wg)\s*:/i.test(subject ?? '');
    let text = '';
    let body = 'none';
    if (parsed?.text) {
      text = cleanText(trimQuoted(parsed.text, { keepForwarded: forwarded }));
      body = file.endsWith('.partial.emlx') ? 'partial' : 'full';
    } else if (r.summary) {
      text = cleanText(r.summary);
      body = 'summary';
    }
    const truncated = text.length > MAX_TEXT;
    text = clip(text, MAX_TEXT);
    const fromAddr = normalizeEmail(r.from_addr) ?? parsed?.from[0]?.address ?? null;
    const from = { handle: fromAddr ? `mailto:${fromAddr}` : null, name: (r.from_name && String(r.from_name).trim()) || parsed?.from[0]?.name || null };
    const people = (rcpt.get(r.pk) ?? []).map((x) => ({ type: Number(x.type), handle: emailHandle(x.address), name: (x.name && String(x.name).trim()) || null })).filter((x) => x.handle);
    const list = people.length
      ? people
      : [...(parsed?.to ?? []).map((a) => ({ type: 0, ...a })), ...(parsed?.cc ?? []).map((a) => ({ type: 1, ...a }))].map((a) => ({ type: a.type, handle: `mailto:${a.address}`, name: a.name }));
    const seen = new Set();
    const to = [];
    for (const p of list) {
      if (seen.has(p.handle)) continue;
      seen.add(p.handle);
      to.push({ handle: p.handle, name: p.name });
    }
    const participants = [from.handle, ...to.map((p) => p.handle)].filter(Boolean).sort();
    const midHeader = (r.mid_header ?? parsed?.messageId ?? '').replace(/^<|>$/g, '') || null;
    const idKey = r.mid_hash && r.mid_hash !== '0' ? `m${r.mid_hash}` : `r${r.pk}`;
    const thread = r.conv && r.conv !== '0' ? `email:c${r.conv}` : `email:s${shortHash(`${normSubject(subject)}|${participants.join(',')}`, 16)}`;
    const meta = {
      account: box.address,
      mailbox: box.name,
      body,
      read: !!Number(r.is_read),
    };
    if (boxLabels.length) meta.labels = boxLabels.map((b) => b.name);
    if (midHeader) meta.message_id = midHeader;
    if (Number(r.flagged)) meta.flagged = true;
    if (parsed?.bulk || (r.list_id && r.list_id !== '0') || Number(r.unsub) > 0) meta.bulk = true;
    if (parsed?.automated) meta.automated = true;
    const cc = people.filter((p) => p.type === 1).map((p) => p.handle);
    if (cc.length) meta.cc = cc;
    if (parsed?.attachments?.length) meta.attachments = parsed.attachments.map((a) => ({ filename: a.filename, mime: a.mime, size: a.size }));
    if (truncated) meta.truncated = true;
    out.push({
      id: `email:${idKey}`,
      source: 'email',
      kind: 'email',
      thread,
      ts,
      from,
      to,
      is_from_me: box.kind === 'sent' || (!!fromAddr && L.mine.has(fromAddr)),
      title: subject,
      text,
      url: midHeader ? `message://%3C${encodeURIComponent(midHeader)}%3E` : null,
      meta,
    });
  }
  return out;
}

export async function extract(ctx, { cursor, limit = 2000 } = {}) {
  let found;
  try {
    found = mailRoot(ctx);
  } catch (err) {
    throw accessError(err, libraryPath(ctx, 'Mail'));
  }
  if (!found) return { records: [], cursor, done: true };
  const db = openCopy(ctx, found.index);
  const L = loadLookups(ctx, db, found.root);
  return pageByKey(cursor, {
    limit,
    maxKey: L.max(),
    fetchAfter: (hi, n) => L.after.all(hi, n),
    fetchBefore: (lo, n) => L.before.all(lo, n),
    toRecords: (rows) => toRecords(ctx, L, rows),
  });
}
