// iPhone call recordings (iOS 18.1+). The Phone app saves each recording as a
// note in the Apple Notes "Call Recordings" folder ("Grabaciones de llamadas"),
// which syncs to the Mac:
//   ~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite
//   ZICCLOUDSYNCINGOBJECT  folders (ZTITLE2), notes (ZTITLE1, ZFOLDER, ZIDENTIFIER,
//                          ZCREATIONDATE1/3, ZMODIFICATIONDATE1, ZMARKEDFORDELETION),
//                          attachments (ZTYPEUTI com.apple.m4a-audio, ZNOTE,
//                          ZADDITIONALINDEXABLETEXT = Apple's transcript, ZMEDIA -> media row)
//   ZICNOTEDATA.ZDATA      gzipped protobuf body (text + attachment references)
//   Accounts/<account>/Media/<media id>/<generation>/<file>   the audio
// No transcript yet: transcribe the audio (C's c-transcribe) or keep the record
// with meta.needs_transcript and retry on a later run. Ids are the note ids,
// so the retry updates the same record. The other party comes from the title
// or from the call history entry closest in time.
// Cursor: modification watermark plus a retry list (pendingPage).
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { toHandle, nameHandle, phoneHandle } from '../lib/handles.mjs';
import { fromAppleTime } from '../lib/time.mjs';
import { decodeNoteBody } from '../lib/a-protobuf.mjs';
import { libraryPath, unreadable, openCopy, columns, pendingPage, ownerParty, cleanText, transcribeFile } from '../lib/a-local.mjs';
import { contactNames } from '../lib/a-addressbook.mjs';
import { callNear } from './calls.mjs';
import { guardProbe, guardExtract, notOk } from '../lib/a-reasons.mjs';

export const id = 'call_recordings';
const MAX_TRANSCRIBE = 5;
const CALL_FOLDERS = new Set(['call recordings', 'grabaciones de llamadas', 'llamadas grabadas', 'gravacoes de chamadas', 'enregistrements d appels', 'anrufaufzeichnungen']);
const TITLE = /^(?:phone\s+)?(?:call|llamada|grabaci[oó]n de (?:la )?llamada)\s+(?:with|con|de|a)\s+(.+)$/i;
const AUDIO_UTI = /audio|m4a|mpeg-4-audio/i;

const NOTES = ['Group Containers', 'group.com.apple.notes'];
export const dbPath = (ctx) => libraryPath(ctx, ...NOTES, 'NoteStore.sqlite');
const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Notes in the call recordings folder, with their audio attachment.
export function readNotes(db) {
  const c = columns(db, 'ZICCLOUDSYNCINGOBJECT');
  if (!c.has('ZTITLE2')) return [];
  const folders = db
    .prepare('SELECT Z_PK AS pk, ZTITLE2 AS title FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE2 IS NOT NULL')
    .all()
    .filter((f) => CALL_FOLDERS.has(fold(f.title)))
    .map((f) => f.pk);
  if (!folders.length) return [];
  const created = ['ZCREATIONDATE3', 'ZCREATIONDATE1', 'ZCREATIONDATE'].filter((n) => c.has(n));
  const createdExpr = created.length ? `COALESCE(${created.map((n) => `n.${n}`).join(', ')})` : 'NULL';
  const notes = db
    .prepare(
      `SELECT n.Z_PK AS pk, n.ZIDENTIFIER AS ident, ${c.pick('ZTITLE1', 'title', 'n.ZTITLE1')}, ${c.pick('ZSNIPPET', 'snippet', 'n.ZSNIPPET')},
        ${createdExpr} AS created, ${c.pick('ZMODIFICATIONDATE1', 'modified', 'n.ZMODIFICATIONDATE1')}, d.ZDATA AS data
       FROM ZICCLOUDSYNCINGOBJECT n LEFT JOIN ZICNOTEDATA d ON d.ZNOTE = n.Z_PK
       WHERE n.ZFOLDER IN (${folders.map(Number).join(',')}) ${c.has('ZMARKEDFORDELETION') ? 'AND (n.ZMARKEDFORDELETION IS NULL OR n.ZMARKEDFORDELETION = 0)' : ''}`,
    )
    .all();
  const attachSql = `SELECT a.Z_PK AS pk, a.ZIDENTIFIER AS ident, ${c.pick('ZNOTE', 'note', 'a.ZNOTE')}, a.ZTYPEUTI AS uti,
      ${c.pick('ZADDITIONALINDEXABLETEXT', 'transcript', 'a.ZADDITIONALINDEXABLETEXT')}, ${c.pick('ZDURATION', 'duration', 'a.ZDURATION')},
      ${c.pick('ZUSERTITLE', 'user_title', 'a.ZUSERTITLE')}, m.ZIDENTIFIER AS media_ident, ${c.pick('ZFILENAME', 'filename', 'm.ZFILENAME')}
    FROM ZICCLOUDSYNCINGOBJECT a LEFT JOIN ZICCLOUDSYNCINGOBJECT m ON m.Z_PK = ${c.has('ZMEDIA') ? 'a.ZMEDIA' : 'NULL'}
    WHERE a.ZTYPEUTI IS NOT NULL`;
  const audio = db.prepare(attachSql).all().filter((a) => AUDIO_UTI.test(a.uti));
  return notes.map((n) => {
    const body = decodeNoteBody(n.data);
    const refs = new Set((body?.attachments ?? []).map((a) => a.id));
    const att = audio.find((a) => (a.note != null && a.note === n.pk) || refs.has(a.ident)) ?? null;
    return { ...n, body, att };
  });
}

export function findMedia(ctx, mediaIdent, filename) {
  if (!mediaIdent) return null;
  const accounts = libraryPath(ctx, ...NOTES, 'Accounts');
  let dirs = [];
  try {
    dirs = readdirSync(accounts);
  } catch {
    return null;
  }
  for (const acct of dirs) {
    const root = join(accounts, acct, 'Media', mediaIdent);
    if (!existsSync(root)) continue;
    const found = [];
    const walk = (d, depth) => {
      if (depth > 4) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (!e.name.startsWith('.')) found.push(p);
      }
    };
    try {
      walk(root, 0);
    } catch {}
    const best = found.find((p) => filename && p.endsWith(filename)) ?? found.sort((a, b) => statSync(b).size - statSync(a).size)[0];
    if (best) return best;
  }
  return null;
}

async function runProbe(ctx) {
  const path = dbPath(ctx);
  const bad = unreadable(ctx, id, path, 'Notes database');
  if (bad) return bad;
  const notes = readNotes(openCopy(ctx, path));
  return notes.length ? { ok: true, count: notes.length } : notOk(ctx, id, 'no_data', 'no call recordings in Notes yet', { count: 0 });
}

function otherParty(ctx, title, created) {
  const names = contactNames(ctx);
  const m = TITLE.exec(String(title ?? '').trim());
  const who = (m ? m[1] : String(title ?? '')).trim();
  const digits = who.replace(/\D/g, '');
  if (digits.length >= 7 && /^[+\d\s().-]+$/.test(who)) {
    const handle = phoneHandle(who);
    return { party: { handle, name: names.nameFor(handle) }, call: callNear(ctx, created) };
  }
  const call = created != null ? callNear(ctx, created) : null;
  if (call?.handle) return { party: { handle: call.handle, name: (m ? who : null) ?? call.name ?? names.nameFor(call.handle) }, call };
  if (m) return { party: { handle: toHandle(who) ?? nameHandle(who), name: who }, call };
  return { party: null, call };
}

async function build(ctx, notes) {
  const out = [];
  let budget = MAX_TRANSCRIBE;
  for (const n of notes) {
    const ts = fromAppleTime(n.created ?? n.modified);
    if (!ts) continue;
    const recordId = `call_recordings:${n.ident}`;
    const noteText = cleanText(n.body?.text ?? n.snippet ?? '');
    const title = (n.title && String(n.title).trim()) || cleanText(n.att?.user_title) || noteText.split('\n')[0] || null;
    let text = cleanText(n.att?.transcript ?? '');
    const meta = { item_id: n.ident };
    if (text) meta.transcript_source = 'apple';
    else {
      const prior = ctx.store?.record?.(recordId);
      if (prior?.text && prior.meta?.transcript_source && prior.meta.transcript_source !== 'apple') {
        text = prior.text;
        meta.transcript_source = prior.meta.transcript_source;
      } else {
        const file = findMedia(ctx, n.att?.media_ident, n.att?.filename);
        const res = file && budget > 0 ? (budget--, await transcribeFile(ctx, file, 'audio/mp4')) : null;
        if (res) {
          text = res.text;
          meta.transcript_source = res.provider;
        } else meta.needs_transcript = true;
      }
    }
    const { party, call } = otherParty(ctx, title, n.created);
    const summary = noteText.split('\n').filter((l) => l.trim() && l.trim() !== title).join('\n').trim();
    if (summary) meta.summary = summary;
    if (n.att?.duration) meta.duration_s = Math.round(Number(n.att.duration));
    else if (call?.duration_s) meta.duration_s = call.duration_s;
    if (call) meta.direction = call.outgoing ? 'outgoing' : 'incoming';
    const outgoing = !!call?.outgoing;
    out.push({
      id: recordId,
      source: 'call_recordings',
      kind: 'call',
      thread: party?.handle && !party.handle.startsWith('name:') ? `calls:${party.handle}` : `call_recordings:${n.ident}`,
      ts,
      from: call ? (outgoing ? ownerParty(ctx) : party) : null,
      to: call ? (outgoing && party ? [party] : []) : party ? [party] : [],
      is_from_me: outgoing,
      title,
      text,
      url: null,
      meta,
    });
  }
  return out;
}

async function runExtract(ctx, { cursor, limit = 2000 } = {}) {
  const path = dbPath(ctx);
  if (!existsSync(path)) return { records: [], cursor, done: true };
  const notes = readNotes(openCopy(ctx, path)).map((n) => ({ ...n, id: n.ident, mark: Number(n.modified ?? n.created ?? 0) }));
  return pendingPage(cursor, notes, { limit, build: (items) => build(ctx, items) });
}

export const probe = guardProbe(id, runProbe);
export const extract = guardExtract(id, runExtract);
