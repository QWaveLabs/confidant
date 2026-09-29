// Phone and FaceTime calls from ~/Library/Application Support/CallHistoryDB/CallHistory.storedata
// (iPhone calls sync here through iCloud).
//   ZCALLRECORD  ZDATE (seconds since 2001), ZDURATION (s), ZADDRESS (a BLOB:
//                phone or email), ZNAME, ZORIGINATED (1 outgoing), ZANSWERED,
//                ZCALLTYPE (1 phone, 8 FaceTime video, 16 FaceTime audio, 0 app),
//                ZSERVICE_PROVIDER, ZUNIQUE_ID
// kind call, text is a one-line summary, thread calls:<handle>.
// Cursor: newest first by Z_PK, then new rows.
import { existsSync } from 'node:fs';
import { toHandle, nameHandle } from '../lib/handles.mjs';
import { fromAppleTime } from '../lib/time.mjs';
import { libraryPath, unreadable, openCopy, columns, pageByKey, ownerParty } from '../lib/a-local.mjs';
import { contactNames } from '../lib/a-addressbook.mjs';

export const id = 'calls';
export const dbPath = (ctx) => libraryPath(ctx, 'Application Support', 'CallHistoryDB', 'CallHistory.storedata');

const WORDS = {
  en: { outgoing: 'Outgoing', incoming: 'Incoming', missed: 'Missed', phone: 'phone call', facetime_audio: 'FaceTime audio call', facetime_video: 'FaceTime video call', app: 'call', min: 'min', sec: 's' },
  es: { outgoing: 'Llamada saliente', incoming: 'Llamada entrante', missed: 'Llamada perdida', phone: 'telefónica', facetime_audio: 'de FaceTime audio', facetime_video: 'de FaceTime video', app: '', min: 'min', sec: 's' },
};
const SERVICE = { 1: 'phone', 8: 'facetime_video', 16: 'facetime_audio', 0: 'app' };

export function summary(lang, direction, service, seconds) {
  const w = WORDS[lang] ?? WORDS.en;
  const length = direction === 'missed' ? '' : seconds >= 60 ? `, ${Math.round(seconds / 60)} ${w.min}` : `, ${Math.round(seconds)} ${w.sec}`;
  const kind = w[service] ?? w.app;
  if (lang === 'es') return `${w[direction]}${kind ? ` ${kind}` : ''}${length}`;
  return `${w[direction]} ${kind}${length}`;
}

export async function probe(ctx) {
  const path = dbPath(ctx);
  const bad = unreadable(path, 'call history');
  if (bad) return bad;
  const db = openCopy(ctx, path);
  return { ok: true, count: db.prepare('SELECT COUNT(*) AS n FROM ZCALLRECORD').get().n };
}

export const addressText = (v) => (v == null ? null : v instanceof Uint8Array ? Buffer.from(v).toString('utf8').replace(/\u0000/g, '').trim() : String(v).trim()) || null;

const STMTS = new WeakMap();
function statements(db) {
  if (STMTS.has(db)) return STMTS.get(db);
  const c = columns(db, 'ZCALLRECORD');
  const select = `SELECT Z_PK AS pk, ZDATE AS date, ${c.pick('ZDURATION', 'duration')}, ${c.pick('ZADDRESS', 'address')}, ${c.pick('ZNAME', 'name')},
      ${c.pick('ZORIGINATED', 'originated')}, ${c.pick('ZANSWERED', 'answered')}, ${c.pick('ZCALLTYPE', 'type')}, ${c.pick('ZSERVICE_PROVIDER', 'provider')},
      ${c.pick('ZUNIQUE_ID', 'uid')}, ${c.pick('ZJUNKCONFIDENCE', 'junk')} FROM ZCALLRECORD`;
  const s = {
    after: db.prepare(`${select} WHERE Z_PK > ? ORDER BY Z_PK ASC LIMIT ?`),
    before: db.prepare(`${select} WHERE Z_PK < ? ORDER BY Z_PK DESC LIMIT ?`),
    max: () => db.prepare('SELECT MAX(Z_PK) AS m FROM ZCALLRECORD').get().m ?? 0,
    near: db.prepare(`${select} WHERE ZDATE BETWEEN ? AND ? ORDER BY ABS(ZDATE - ?) LIMIT 1`),
  };
  STMTS.set(db, s);
  return s;
}

// The call closest to an Apple timestamp, for call recordings. null if none.
export function callNear(ctx, appleSeconds, windowS = 180) {
  const path = dbPath(ctx);
  if (!existsSync(path) || unreadable(path, 'call history')) return null;
  try {
    const row = statements(openCopy(ctx, path)).near.get(appleSeconds - windowS, appleSeconds + windowS, appleSeconds);
    if (!row) return null;
    const raw = addressText(row.address);
    const handle = raw ? toHandle(raw) : null;
    return { handle, name: row.name || null, outgoing: !!Number(row.originated), duration_s: Math.round(Number(row.duration ?? 0)) };
  } catch {
    return null;
  }
}

function toRecords(ctx, rows) {
  const names = contactNames(ctx);
  const out = [];
  for (const r of rows) {
    const ts = fromAppleTime(r.date);
    if (!ts) continue;
    const raw = addressText(r.address);
    const handle = raw ? toHandle(raw) : null;
    const name = (r.name && String(r.name).trim()) || (handle && names.nameFor(handle)) || null;
    const other = { handle: handle ?? (name ? nameHandle(name) : null), name };
    const outgoing = !!Number(r.originated);
    const seconds = Math.max(0, Number(r.duration ?? 0));
    const direction = outgoing ? 'outgoing' : Number(r.answered) && seconds > 0 ? 'incoming' : 'missed';
    const service = SERVICE[Number(r.type)] ?? 'phone';
    const meta = { direction, duration_s: Math.round(seconds), service, answered: !!Number(r.answered) };
    if (r.provider) meta.provider = String(r.provider);
    if (Number(r.junk) > 0) meta.junk = true;
    out.push({
      id: `calls:${r.uid ?? `pk${r.pk}`}`,
      source: 'calls',
      kind: 'call',
      thread: `calls:${other.handle ?? 'unknown'}`,
      ts,
      from: outgoing ? ownerParty(ctx) : other,
      to: outgoing ? [other] : [],
      is_from_me: outgoing,
      title: name ?? raw ?? null,
      text: summary(ctx.lang ?? 'en', direction, service, seconds),
      url: null,
      meta,
    });
  }
  return out;
}

export async function extract(ctx, { cursor, limit = 2000 } = {}) {
  const path = dbPath(ctx);
  if (!existsSync(path)) return { records: [], cursor, done: true };
  const s = statements(openCopy(ctx, path));
  return pageByKey(cursor, {
    limit,
    maxKey: s.max(),
    fetchAfter: (hi, n) => s.after.all(hi, n),
    fetchBefore: (lo, n) => s.before.all(lo, n),
    toRecords: (rows) => toRecords(ctx, rows),
  });
}
