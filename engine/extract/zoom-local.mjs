// Zoom local recordings in ~/Documents/Zoom/<"YYYY-MM-DD HH.MM.SS Topic 81234567890">/
//   *.vtt / recording.transcript.vtt   transcript (when Zoom made one)
//   closed_caption.txt                 "[Name] HH:MM:SS" + text
//   meeting_saved_chat.txt / chat.txt  in-meeting chat
//   audio*.m4a, *.mp4                  transcribed (C's c-transcribe) when no text exists
// kind meeting, one record per folder, "Speaker: line" transcript. Folder times
// are the Mac's local time, read in the person's time zone.
// Cursor: file-mtime watermark per folder plus a retry list (pendingPage).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { nameHandle } from '../lib/handles.mjs';
import { shortHash } from '../lib/hash.mjs';
import { homeOf, pendingPage, cleanText, clip, zonedToUtc, transcribeFile, listDir } from '../lib/a-local.mjs';
import { guardProbe, guardExtract, notOk } from '../lib/a-reasons.mjs';

export const id = 'zoom_local';
const MAX_TRANSCRIBE = 3;
export const zoomDir = (ctx) => join(homeOf(ctx), 'Documents', 'Zoom');

const FOLDER = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})\.(\d{2})\.(\d{2})\s*(.*?)(?:\s+(\d{9,12}))?$/;
const CUE_TIME = /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/;

export function parseFolderName(name, timeZone = 'UTC') {
  const m = FOLDER.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, topic, meetingId] = m;
  return { ts: zonedToUtc({ year: +y, month: +mo, day: +d, hour: +h, minute: +mi, second: +s }, timeZone), topic: topic.trim() || null, meetingId: meetingId ?? null };
}

// WebVTT -> [{ speaker, text, end }]
export function parseVtt(text) {
  const out = [];
  const blocks = String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const t = lines.findIndex((l) => CUE_TIME.test(l));
    if (t < 0) continue;
    const m = CUE_TIME.exec(lines[t]);
    const end = (+(m[5] ?? 0)) * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000;
    let body = lines.slice(t + 1).join(' ');
    let speaker = null;
    const voice = /^<v\s+([^>]+)>(.*?)(?:<\/v>)?$/i.exec(body);
    if (voice) [, speaker, body] = voice;
    else {
      const named = /^([^:]{1,60}):\s+(.+)$/.exec(body);
      if (named) [, speaker, body] = named;
    }
    body = body.replace(/<[^>]+>/g, '').trim();
    if (body) out.push({ speaker: speaker?.trim() || null, text: body, end });
  }
  return out;
}

// closed_caption.txt -> [{ speaker, text }]
export function parseClosedCaptions(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const h = /^\[(.+?)\]\s+\d{1,2}:\d{2}:\d{2}\s*$/.exec(line.trim());
    if (h) {
      cur = { speaker: h[1].trim(), text: '' };
      out.push(cur);
    } else if (cur && line.trim()) cur.text = `${cur.text} ${line.trim()}`.trim();
  }
  return out.filter((c) => c.text);
}

// meeting_saved_chat.txt -> [{ sender, text }]
export function parseChat(text) {
  const out = [];
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^\d{1,2}:\d{2}:\d{2}\s+From\s+(.+?)(?:\s+to\s+(.+?))?\s*:\s*(.*)$/i.exec(line.trim());
    if (m) out.push({ sender: m[1].replace(/\s+/g, ' ').trim(), text: m[3].trim() });
    else if (out.length && line.trim()) out[out.length - 1].text = `${out[out.length - 1].text}\n${line.trim()}`.trim();
  }
  return out.filter((c) => c.text);
}

const joinLines = (rows) => {
  const out = [];
  for (const r of rows) {
    const last = out.at(-1);
    if (last && last.speaker === r.speaker) last.text += ` ${r.text}`;
    else out.push({ speaker: r.speaker, text: r.text });
  }
  return out.map((r) => (r.speaker ? `${r.speaker}: ${r.text}` : r.text)).join('\n');
};

function folders(ctx) {
  const root = zoomDir(ctx);
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of listDir(root)) {
    const dir = join(root, name);
    let files;
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir).filter((f) => !f.startsWith('.'));
    } catch {
      continue;
    }
    if (!files.length) continue;
    const mark = Math.max(...files.map((f) => statSync(join(dir, f)).mtimeMs));
    out.push({ id: name, mark: Math.round(mark), dir, files });
  }
  return out;
}

async function runProbe(ctx) {
  const root = zoomDir(ctx);
  if (!existsSync(root)) return notOk(ctx, id, 'not_installed', 'no Zoom recordings folder on this Mac');
  const n = folders(ctx).length;
  return n ? { ok: true, count: n } : notOk(ctx, id, 'no_data', 'no Zoom recordings yet', { count: 0 });
}

async function build(ctx, items) {
  const tz = ctx.tz ?? ctx.config?.timezone ?? 'UTC';
  const owner = ctx.config?.owner?.name?.trim().toLowerCase();
  let budget = MAX_TRANSCRIBE;
  const out = [];
  for (const f of items) {
    const info = parseFolderName(f.id, tz);
    const ts = info?.ts ?? new Date(f.mark).toISOString();
    const recordId = `zoom_local:${shortHash(f.id, 16)}`;
    const pick = (re) => f.files.filter((x) => re.test(x)).sort();
    const vtt = pick(/\.vtt$/i)[0];
    const cc = pick(/^closed_caption.*\.txt$/i)[0];
    const chatFile = pick(/(^meeting_saved.*chat.*|^chat)\.txt$/i)[0];
    const meta = { item_id: f.id, folder: f.id };
    if (info?.meetingId) meta.meeting_id = info.meetingId;
    let rows = [];
    if (vtt) {
      rows = parseVtt(readFileSync(join(f.dir, vtt), 'utf8'));
      meta.transcript_source = 'zoom';
      if (rows.length) meta.duration_s = Math.round(rows.at(-1).end);
    } else if (cc) {
      rows = parseClosedCaptions(readFileSync(join(f.dir, cc), 'utf8'));
      meta.transcript_source = 'zoom_captions';
    }
    let text = joinLines(rows);
    if (!text) {
      delete meta.transcript_source;
      const prior = ctx.store?.record?.(recordId);
      if (prior?.text && prior.meta?.transcript_source) {
        text = prior.text;
        meta.transcript_source = prior.meta.transcript_source;
      } else {
        const audio = pick(/\.m4a$/i)[0];
        const video = pick(/\.mp4$/i)[0];
        const file = audio ?? video;
        const res = file && budget > 0 ? (budget--, await transcribeFile(ctx, join(f.dir, file), audio ? 'audio/mp4' : 'video/mp4')) : null;
        if (res) {
          text = res.text;
          meta.transcript_source = res.provider;
        } else if (file) meta.needs_transcript = true;
      }
    }
    const chat = chatFile ? parseChat(readFileSync(join(f.dir, chatFile), 'utf8')) : [];
    if (chat.length) meta.chat = clip(chat.map((c) => `${c.sender}: ${c.text}`).join('\n'), 20000);
    const people = [...new Set([...rows.map((r) => r.speaker), ...chat.map((c) => c.sender)].filter(Boolean))].filter((n) => n.toLowerCase() !== owner && !/^speaker \d+$/i.test(n));
    if (!text && !chat.length && !meta.needs_transcript) continue;
    out.push({
      id: recordId,
      source: 'zoom_local',
      kind: 'meeting',
      thread: `meeting:zoom_local:${shortHash(f.id, 16)}`,
      ts,
      from: null,
      to: people.map((n) => ({ handle: nameHandle(n), name: n })),
      is_from_me: false,
      title: info?.topic ?? f.id,
      text: clip(cleanText(text), 200000),
      url: null,
      meta,
    });
  }
  return out;
}

async function runExtract(ctx, { cursor, limit = 2000 } = {}) {
  if (!existsSync(zoomDir(ctx))) return { records: [], cursor, done: true };
  return pendingPage(cursor, folders(ctx), { limit, build: (items) => build(ctx, items) });
}

export const probe = guardProbe(id, runProbe);
export const extract = guardExtract(id, runExtract);
