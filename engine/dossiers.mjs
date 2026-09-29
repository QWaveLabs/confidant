// `confidant dossiers [--since <iso>] [--until <iso>] [--changed-since <iso>]`
// Context for the sorter: one dossier per person (their one-to-one messages,
// emails, calls and events across channels), per substantive thread (group
// chats, multi-person email threads, the owner's own notes) and per meeting
// (transcript chunks, resolved attendees). Trivia is left out, long text is
// trimmed, and every line keeps its record id so the sorter can cite it.
// Writes .confidant/dossiers/{people,threads,meetings}/<id>.json.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from './lib/files.mjs';
import { localDate, daysAgo, toMs } from './lib/time.mjs';
import { shortHash } from './lib/hash.mjs';
import { nameHandle, isAutomatedEmail } from './lib/handles.mjs';
import { t } from './lib/i18n.mjs';
import { classifyText, looksLikeRequest, isCalendarNoise, cleanEmailText, trimText, prettyHandle, normalizeName, oneLine } from './lib/b-text.mjs';
import { bPaths, bTables, loadScrub, sourceLabel } from './lib/b-common.mjs';
import { loadIdentity, canonHandle } from './identity.mjs';

export const LIMITS = {
  message: 600,
  email: 1500,
  event: 300,
  note: 1500,
  person: { inner: 32000, active: 20000, network: 10000, cold: 6000 },
  thread: 32000,
  notes: 16000,
  transcript: 90000,
  chunk: 8000,
  summary: 3000,
};
const MAX_EVENT_PEOPLE = 10;
const CONTEXT_BEFORE = 4;
const GENERIC_MEETING = /^(impromptu (google meet|zoom|teams) meeting|.*'s (zoom|google meet|teams|personal) meeting( room)?|new meeting|my meeting|meeting|call|untitled|reunión|reunion|llamada|sin título)$/i;
const SPEAKER = /^([^:\n]{1,60}):\s/;

const stripSubject = (s) => oneLine(s).replace(/^((re|fw|fwd|rv|reenv|aw)\s*:\s*)+/i, '').trim();
const charsOf = (x) => JSON.stringify(x).length;

function summaryText(meta) {
  const s = meta?.summary;
  if (!s) return '';
  if (typeof s === 'string') return s;
  return String(s.markdown_formatted ?? s.text ?? s.markdown ?? '');
}

function actionItems(meta) {
  const a = meta?.action_items;
  if (!a) return [];
  const list = Array.isArray(a) ? a : [a];
  return list
    .map((x) => (typeof x === 'string' ? x : x?.text ?? x?.description ?? ''))
    .map(oneLine)
    .filter(Boolean)
    .slice(0, 30);
}

function meetingIsSubstantive(r) {
  const title = oneLine(r.title);
  const text = r.text ?? '';
  const summary = summaryText(r.meta);
  if (text.length < 200 && summary.length < 200) return false;
  if (title && !GENERIC_MEETING.test(title)) return true;
  if (summary.length > 400) return true;
  const minutes = Number(r.meta?.duration_s ?? 0) / 60;
  const speakers = new Set(text.split('\n').map((l) => SPEAKER.exec(l)?.[1]).filter(Boolean));
  return minutes >= 3 || (r.to ?? []).length >= 2 || speakers.size >= 2;
}

function isoWeek(date) {
  const d = new Date(`${date}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function chunkTranscript(text, ref) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  let total = 0;
  let truncated = false;
  for (const line of lines) {
    if (total + line.length > LIMITS.transcript) {
      truncated = true;
      break;
    }
    if (cur && cur.length + line.length + 1 > LIMITS.chunk) {
      chunks.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${line}` : line;
    total += line.length + 1;
  }
  if (cur) chunks.push(cur);
  return { chunks: chunks.map((c, i) => ({ ref, i, text: c })), truncated };
}

// Newest first until the budget is spent, then back in reading order.
// Context lines never count as the reason a dossier exists.
function fitItems(items, budget) {
  const kept = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const size = charsOf(items[i]);
    if (kept.length && used + size > budget) break;
    kept.push(items[i]);
    used += size;
  }
  return kept.reverse();
}

export async function buildDossiers(ctx, { since, until, changedSince, frontier, write = true, identity } = {}) {
  identity ??= loadIdentity(ctx, { build: true });
  const scrub = await loadScrub();
  const db = bTables(ctx.store);
  const { tz, lang } = ctx;
  const tr = t('notes', lang);
  const ownerName = identity.owner?.name || tr('me');
  const window = changedSince ? { changedSince, since: frontier ?? since ?? null, until: until ?? null } : { since: since ?? daysAgo(60, ctx.now), until: until ?? null };
  let records = changedSince ? ctx.store.records({ changedSince, since: window.since ?? undefined, until: window.until ?? undefined }) : ctx.store.records({ since: window.since, until: window.until ?? undefined });
  records = records.filter((r) => r.kind !== 'contact');
  const stats = { records: records.length, used: 0, trivia: 0, automated: 0, context: 0 };

  // Changed-only runs get a few earlier lines of each conversation as context.
  const context = new Set();
  if (changedSince) {
    const firstByThread = new Map();
    for (const r of records) {
      if (!r.thread || (r.kind !== 'message' && r.kind !== 'email')) continue;
      if (!firstByThread.has(r.thread) || r.ts < firstByThread.get(r.thread)) firstByThread.set(r.thread, r.ts);
    }
    const have = new Set(records.map((r) => r.id));
    const extra = [];
    for (const [thread, ts] of firstByThread) {
      for (const r of ctx.store.records({ thread, until: ts, order: 'desc', limit: CONTEXT_BEFORE })) {
        if (have.has(r.id)) continue;
        have.add(r.id);
        context.add(r.id);
        extra.push(r);
      }
    }
    records = [...extra, ...records].sort((a, b) => toMs(a.ts) - toMs(b.ts) || a.id.localeCompare(b.id));
  }

  const resolve = (party) => {
    if (!party) return null;
    const h = canonHandle(party.handle) ?? (party.name ? nameHandle(party.name) : null);
    return h ? identity.byHandle(h) : null;
  };
  const usable = (p) => p && !identity.isOwner(p) && p.kind !== 'system' && p.kind !== 'excluded';
  const nameOf = (p, party) => (p ? (identity.isOwner(p) ? ownerName : p.name) : oneLine(party?.name) || prettyHandle(canonHandle(party?.handle)));
  const noteTitle = (id) => db.prepare('SELECT title FROM b_notes WHERE id = ?').get(id)?.title ?? null;

  // One-to-one chats where the owner wrote without a recipient on record.
  const dmCounterpart = new Map();
  const counterpartFor = (thread) => {
    if (!thread) return null;
    if (dmCounterpart.has(thread)) return dmCounterpart.get(thread);
    let found = null;
    for (const r of ctx.store.records({ thread, order: 'desc', limit: 40 })) {
      const p = r.is_from_me ? null : resolve(r.from);
      if (usable(p)) {
        found = p;
        break;
      }
    }
    dmCounterpart.set(thread, found);
    return found;
  };

  const people = new Map();
  const threads = new Map();
  const meetings = [];
  const lastLine = new Map();
  const personBucket = (p) => {
    if (!people.has(p.id)) people.set(p.id, { person: p, items: [] });
    return people.get(p.id);
  };
  const threadBucket = (key, init) => {
    if (!threads.has(key)) threads.set(key, { key, ...init, participants: new Map(), items: [] });
    return threads.get(key);
  };
  const clean = (s, max) => trimText(scrub(String(s ?? '')), max);

  // Short acknowledgements only matter when they answer a question.
  const keepLine = (bucketKey, dir, text, meta) => {
    const kind = classifyText(text, meta);
    const prev = lastLine.get(bucketKey);
    lastLine.set(bucketKey, { dir, text });
    if (kind === 'content') return true;
    if (kind === 'ack' && prev && prev.dir !== dir && looksLikeRequest(prev.text)) return true;
    stats.trivia++;
    return false;
  };

  for (const r of records) {
    const isCtx = context.has(r.id);
    const date = localDate(r.ts, tz);
    const ch = sourceLabel(r.source, lang);
    const base = { ref: r.id, date, ch, ...(isCtx ? { context: true } : {}) };
    const fromP = r.is_from_me ? identity.ownerPerson : resolve(r.from);

    if (r.kind === 'meeting' || r.kind === 'recording') {
      const others = (r.to ?? []).map((party) => ({ party, p: resolve(party) })).filter((x) => !identity.isOwner(x.p));
      const text = r.text ?? '';
      const speakers = [...new Set(text.split('\n').map((l) => SPEAKER.exec(l.trim())?.[1]?.trim()).filter(Boolean))];
      if (r.kind === 'recording' && !others.length && speakers.length < 2) {
        if (normalizeName(text).length < 40 || isCtx) continue;
        const key = `notes:${r.source}:${isoWeek(date)}`;
        threadBucket(key, { kind: 'notes', name: `${ch} ${isoWeek(date)}`, source: ch }).items.push({ ...base, text: clean(text, LIMITS.note) });
        stats.used++;
        continue;
      }
      if (isCtx || !meetingIsSubstantive(r)) {
        if (!isCtx) stats.trivia++;
        continue;
      }
      const attendees = [];
      const seen = new Set();
      for (const { party, p } of others) {
        if (p && (p.kind === 'system' || p.kind === 'excluded')) continue;
        const key = p?.id ?? normalizeName(party.name ?? party.handle);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        attendees.push(p ? { person_id: p.id, name: p.name } : { name: nameOf(null, party) });
      }
      const unmatched = [];
      for (const s of speakers) {
        const hits = identity.byName(s).filter((p) => !identity.isOwner(p));
        const isOwnerName = identity.byName(s).some((p) => identity.isOwner(p)) || normalizeName(s) === normalizeName(ownerName);
        if (isOwnerName) continue;
        if (hits.length === 1 && usable(hits[0])) {
          if (!seen.has(hits[0].id)) {
            seen.add(hits[0].id);
            attendees.push({ person_id: hits[0].id, name: hits[0].name });
          }
        } else if (!seen.has(normalizeName(s))) {
          seen.add(normalizeName(s));
          unmatched.push(s);
        }
      }
      const { chunks, truncated } = chunkTranscript(scrub(text), r.id);
      const summary = clean(summaryText(r.meta), LIMITS.summary);
      meetings.push({
        id: `m_${shortHash(r.id, 10)}`,
        type: 'meeting',
        meeting: {
          ref: r.id,
          title: oneLine(r.title) || ch,
          date,
          source: ch,
          ...(r.meta?.duration_s ? { duration_min: Math.round(Number(r.meta.duration_s) / 60) } : {}),
          attendees,
          ...(unmatched.length ? { unmatched } : {}),
          ...(summary ? { summary } : {}),
          ...(actionItems(r.meta).length ? { action_items: actionItems(r.meta).map((a) => scrub(a)) } : {}),
          ...(truncated ? { truncated: true } : {}),
        },
        chunks,
      });
      stats.used++;
      continue;
    }

    if (r.kind === 'note' || r.kind === 'dictation' || r.kind === 'doc') {
      if (isCtx || normalizeName(r.text).length < 40) {
        stats.trivia++;
        continue;
      }
      const key = `notes:${r.source}:${isoWeek(date)}`;
      threadBucket(key, { kind: 'notes', name: `${ch} ${isoWeek(date)}`, source: ch }).items.push({ ...base, ...(r.title ? { title: oneLine(r.title) } : {}), text: clean(r.text, LIMITS.note) });
      stats.used++;
      continue;
    }

    if (r.kind === 'event') {
      if (isCalendarNoise(r.title) || isCtx) {
        stats.trivia++;
        continue;
      }
      const attendees = [...new Map((r.to ?? []).map(resolve).filter(usable).map((p) => [p.id, p])).values()];
      if (!attendees.length || attendees.length > MAX_EVENT_PEOPLE) continue;
      const desc = oneLine(scrub(r.text ?? ''));
      for (const p of attendees) personBucket(p).items.push({ ...base, type: 'event', text: trimText(`${oneLine(r.title)}${desc ? `. ${desc}` : ''}`, LIMITS.event) });
      stats.used++;
      continue;
    }

    if (r.kind === 'call') {
      const other = r.is_from_me ? resolve((r.to ?? [])[0]) : fromP;
      const secs = Number(r.meta?.duration_s ?? r.meta?.duration ?? 0);
      if (!usable(other) || secs < 30 || isCtx) continue;
      const mins = Math.max(1, Math.round(secs / 60));
      personBucket(other).items.push({ ...base, type: 'call', dir: r.is_from_me ? 'out' : 'in', text: `${oneLine(r.text || r.title || ch)} (${mins} min)` });
      stats.used++;
      continue;
    }

    if (r.kind === 'email') {
      if (!r.is_from_me && (fromP?.kind === 'system' || isAutomatedEmail(canonHandle(r.from?.handle) ?? '') || !fromP || fromP.kind === 'excluded')) {
        stats.automated++;
        continue;
      }
      if (isCalendarNoise(r.title) && /:/.test(r.title ?? '')) {
        stats.trivia++;
        continue;
      }
      const parties = [...new Map([fromP, ...(r.to ?? []).map(resolve)].filter(usable).map((p) => [p.id, p])).values()];
      if (!parties.length) continue;
      const body = cleanEmailText(r.text);
      const subject = stripSubject(r.title);
      if (!body && !subject) continue;
      const line = {
        ...base,
        from: nameOf(fromP, r.from),
        ...(parties.length > 1 ? {} : { dir: r.is_from_me ? 'out' : 'in' }),
        ...(subject ? { subject: scrub(subject) } : {}),
        text: clean(body, LIMITS.email),
      };
      if (parties.length >= 2) {
        const b = threadBucket(r.thread ?? r.id, { kind: 'email', name: subject || ch, source: ch });
        for (const p of parties) b.participants.set(p.id, p);
        b.items.push(line);
      } else personBucket(parties[0]).items.push(line);
      stats.used++;
      continue;
    }

    if (r.kind === 'message') {
      const group = identity.groupByThread(r.thread);
      const text = r.text ?? '';
      if (group) {
        const key = r.thread;
        if (!keepLine(key, r.is_from_me ? 'out' : fromP?.id ?? 'in', text, r.meta)) continue;
        const b = threadBucket(key, { kind: 'group', name: group.name, source: ch, group });
        if (usable(fromP)) b.participants.set(fromP.id, fromP);
        b.items.push({ ...base, from: nameOf(fromP, r.from), text: clean(text, LIMITS.message) });
        stats.used++;
        continue;
      }
      let other = r.is_from_me ? null : fromP;
      if (r.is_from_me) {
        const tos = [...new Map((r.to ?? []).map(resolve).filter(usable).map((p) => [p.id, p])).values()];
        other = tos.length === 1 ? tos[0] : tos.length ? null : counterpartFor(r.thread);
      }
      if (!usable(other)) {
        if (fromP?.kind === 'system') stats.automated++;
        continue;
      }
      const dir = r.is_from_me ? 'out' : 'in';
      if (!keepLine(`p:${other.id}`, dir, text, r.meta)) continue;
      personBucket(other).items.push({ ...base, dir, text: clean(text, LIMITS.message) });
      stats.used++;
    }
  }

  const substantive = (items) => items.some((i) => !i.context);
  const peopleOut = [];
  for (const { person: p, items } of people.values()) {
    if (!substantive(items)) continue;
    const kept = fitItems(items, LIMITS.person[p.tier] ?? LIMITS.person.cold);
    if (!substantive(kept)) continue;
    const note = noteTitle(p.id);
    peopleOut.push({
      id: p.id,
      type: 'person',
      person: {
        person_id: p.id,
        name: p.name,
        ...(p.aliases?.length ? { aliases: p.aliases } : {}),
        ...(p.company ? { company: p.company } : {}),
        ...(p.company_hint ? { email_domain: p.company_hint } : {}),
        ...(p.title ? { title: p.title } : {}),
        tier: p.tier,
        ...(p.kind !== 'person' ? { kind: p.kind } : {}),
        ...(note ? { note } : {}),
      },
      items: kept,
      ...(kept.length < items.length ? { omitted: items.length - kept.length } : {}),
    });
  }
  peopleOut.sort((a, b) => (identity.byId(b.id)?.strength ?? 0) - (identity.byId(a.id)?.strength ?? 0) || a.id.localeCompare(b.id));

  const threadsOut = [];
  for (const b of threads.values()) {
    if (!substantive(b.items)) continue;
    const kept = fitItems(b.items, b.kind === 'notes' ? LIMITS.notes : LIMITS.thread);
    if (!substantive(kept)) continue;
    const members = b.group ? b.group.members.map((id) => identity.byId(id)).filter(usable) : [];
    for (const p of members) b.participants.set(p.id, p);
    threadsOut.push({
      id: `t_${shortHash(b.key, 10)}`,
      type: 'thread',
      thread: {
        key: b.key,
        kind: b.kind,
        name: scrub(b.name),
        source: b.source,
        ...(b.kind !== 'notes' ? { participants: [...b.participants.values()].map((p) => ({ person_id: p.id, name: p.name })) } : {}),
      },
      items: kept,
      ...(kept.length < b.items.length ? { omitted: b.items.length - kept.length } : {}),
    });
  }
  const lastDate = (d) => d.items[d.items.length - 1]?.date ?? '';
  threadsOut.sort((a, b) => lastDate(b).localeCompare(lastDate(a)) || a.id.localeCompare(b.id));
  meetings.sort((a, b) => b.meeting.date.localeCompare(a.meeting.date) || a.id.localeCompare(b.id));

  const out = { window, people: peopleOut, threads: threadsOut, meetings, stats };
  if (write && !ctx.dryRun) writeDossiers(ctx, out);
  return out;
}

function writeDossiers(ctx, out) {
  const root = bPaths(ctx).dossiers;
  for (const [dir, list] of [['people', out.people], ['threads', out.threads], ['meetings', out.meetings]]) {
    rmSync(join(root, dir), { recursive: true, force: true });
    for (const d of list) writeJson(join(root, dir, `${d.id}.json`), d);
  }
  writeJson(join(root, 'index.json'), {
    window: out.window,
    stats: out.stats,
    people: out.people.map((d) => d.id),
    threads: out.threads.map((d) => d.id),
    meetings: out.meetings.map((d) => d.id),
  });
}

export async function run(args, ctx) {
  const out = await buildDossiers(ctx, {
    since: args.since ?? (args.changedSince ? undefined : daysAgo(Number(args.days ?? 60), ctx.now)),
    until: args.until,
    changedSince: args.changedSince,
  });
  ctx.log.out(
    { window: out.window, people: out.people.length, threads: out.threads.length, meetings: out.meetings.length, stats: out.stats, path: bPaths(ctx).dossiers },
    `${out.people.length} people, ${out.threads.length} threads and ${out.meetings.length} meetings ready to sort (${out.stats.used} of ${out.stats.records} records used, ${out.stats.trivia} small talk and ${out.stats.automated} automated left out).`,
  );
  return 0;
}
