// Voice Memos from ~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/
// (older macOS: ~/Library/Application Support/com.apple.voicememos/Recordings/).
//   CloudRecordings.db  ZCLOUDRECORDING: ZDATE (seconds since 2001), ZDURATION,
//                       ZPATH (file name), ZENCRYPTEDTITLE (plain title despite
//                       the name), ZCUSTOMLABEL, ZUNIQUEID, ZEVICTIONDATE (set =
//                       Recently Deleted), ZFOLDER -> ZFOLDER.ZENCRYPTEDNAME
// Apple's own transcript lives inside the audio file (a 'tsrp' atom in .m4a,
// a metadata key in .qta; see a-mp4.mjs). Otherwise the file is transcribed
// (C's c-transcribe) or kept with meta.needs_transcript for a later run.
// kind recording. Cursor: date watermark plus a retry list (pendingPage).
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readAudioTranscript } from '../lib/a-mp4.mjs';
import { libraryPath, unreadable, openCopy, columns, tableNames, pendingPage, ownerParty, cleanText, transcribeFile } from '../lib/a-local.mjs';
import { fromAppleTime } from '../lib/time.mjs';
import { guardProbe, guardExtract } from '../lib/a-reasons.mjs';

export const id = 'voice_memos';
const MAX_TRANSCRIBE = 5;

export function recordingsDir(ctx) {
  const modern = libraryPath(ctx, 'Group Containers', 'group.com.apple.VoiceMemos.shared', 'Recordings');
  const legacy = libraryPath(ctx, 'Application Support', 'com.apple.voicememos', 'Recordings');
  return existsSync(join(modern, 'CloudRecordings.db')) || !existsSync(join(legacy, 'CloudRecordings.db')) ? modern : legacy;
}
export const dbPath = (ctx) => join(recordingsDir(ctx), 'CloudRecordings.db');

export function readMemos(db) {
  const c = columns(db, 'ZCLOUDRECORDING');
  const tables = tableNames(db);
  const folder = tables.has('zfolder') && c.has('ZFOLDER') && columns(db, 'ZFOLDER').has('ZENCRYPTEDNAME');
  return db
    .prepare(
      `SELECT r.Z_PK AS pk, r.ZDATE AS date, ${c.pick('ZDURATION', 'duration', 'r.ZDURATION')}, ${c.pick('ZPATH', 'path', 'r.ZPATH')},
        ${c.pick('ZENCRYPTEDTITLE', 'title', 'r.ZENCRYPTEDTITLE')}, ${c.pick('ZCUSTOMLABEL', 'label', 'r.ZCUSTOMLABEL')}, ${c.pick('ZUNIQUEID', 'uid', 'r.ZUNIQUEID')},
        ${c.pick('ZEVICTIONDATE', 'evicted', 'r.ZEVICTIONDATE')}, ${folder ? 'f.ZENCRYPTEDNAME AS folder' : 'NULL AS folder'}
       FROM ZCLOUDRECORDING r ${folder ? 'LEFT JOIN ZFOLDER f ON f.Z_PK = r.ZFOLDER' : ''}`,
    )
    .all()
    .filter((r) => r.evicted == null && r.path);
}

// ZPATH can say .m4a while the file on disk is .qta (after Enhance), or the reverse.
export function audioFile(dir, path) {
  const p = join(dir, basename(String(path)));
  if (existsSync(p)) return p;
  for (const ext of ['.m4a', '.qta']) {
    const alt = p.replace(/\.(m4a|qta)$/i, ext);
    if (existsSync(alt)) return alt;
  }
  return null;
}

async function runProbe(ctx) {
  const path = dbPath(ctx);
  const bad = unreadable(ctx, id, path, 'Voice Memos database');
  if (bad) return bad;
  return { ok: true, count: readMemos(openCopy(ctx, path)).length };
}

async function build(ctx, dir, memos) {
  const out = [];
  let budget = MAX_TRANSCRIBE;
  for (const m of memos) {
    const ts = fromAppleTime(m.date);
    if (!ts) continue;
    const recordId = `voice_memos:${m.uid ?? basename(String(m.path))}`;
    const file = audioFile(dir, m.path);
    const meta = { item_id: m.id, duration_s: Math.round(Number(m.duration ?? 0)), file: basename(String(m.path)) };
    if (m.folder) meta.folder = String(m.folder);
    let text = '';
    const apple = file ? readAudioTranscript(file) : null;
    if (apple?.text) {
      text = apple.text;
      meta.transcript_source = 'apple';
      if (apple.locale) meta.locale = apple.locale;
    } else {
      const prior = ctx.store?.record?.(recordId);
      if (prior?.text && prior.meta?.transcript_source && prior.meta.transcript_source !== 'apple') {
        text = prior.text;
        meta.transcript_source = prior.meta.transcript_source;
      } else {
        const res = file && budget > 0 ? (budget--, await transcribeFile(ctx, file, 'audio/mp4')) : null;
        if (res) {
          text = res.text;
          meta.transcript_source = res.provider;
        } else meta.needs_transcript = true;
      }
    }
    if (!file) meta.missing_file = true;
    out.push({
      id: recordId,
      source: 'voice_memos',
      kind: 'recording',
      thread: `recording:voice_memos:${m.uid ?? m.pk}`,
      ts,
      from: ownerParty(ctx),
      to: [],
      is_from_me: true,
      title: cleanText(m.title || m.label) || null,
      text: cleanText(text),
      url: null,
      meta,
    });
  }
  return out;
}

async function runExtract(ctx, { cursor, limit = 2000 } = {}) {
  const path = dbPath(ctx);
  if (!existsSync(path)) return { records: [], cursor, done: true };
  const dir = recordingsDir(ctx);
  const memos = readMemos(openCopy(ctx, path)).map((m) => ({ ...m, id: String(m.uid ?? m.pk), mark: Number(m.date ?? 0) }));
  return pendingPage(cursor, memos, { limit, build: (items) => build(ctx, dir, items) });
}

export const probe = guardProbe(id, runProbe);
export const extract = guardExtract(id, runExtract);
