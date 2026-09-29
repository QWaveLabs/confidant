// `confidant review [--json]`
// `confidant review --resolve <id> --answer <text>` | `confidant review --dismiss <id>`
//
// The review queue: things the sorter (or cleanup) was not sure about, kept
// in .confidant/review.json and shown to the person in `Needs review.md`
// (ES `Por revisar.md`) at the vault root. Answers go back into every later
// batch as `known.resolutions`, so the next sort follows them.
import { join } from 'node:path';
import { readJson } from './lib/files.mjs';
import { t, fill } from './lib/i18n.mjs';
import { fingerprint } from './lib/hash.mjs';
import { localDate } from './lib/time.mjs';
import { oneLine, normalizeName } from './lib/b-text.mjs';
import { bTables, takeLock, isoNow, sourceLabel, refSource } from './lib/b-common.mjs';
import { NoteWriter } from './notes.mjs';

export const REVIEW_FILE = '.confidant/review.json';
const RESOLUTIONS_IN_BATCH = 40;
const RECENT_ANSWERS = 10;

export const reviewNoteName = (lang) => t('notes', lang)('review.title');
export const reviewNotePath = (lang) => `${reviewNoteName(lang)}.md`;

export function loadReview(ctx) {
  const data = readJson(join(ctx.vault, REVIEW_FILE), null);
  return { items: Array.isArray(data?.items) ? data.items : [] };
}

export const reviewId = (question, subject) => `r_${fingerprint(question, subject ?? '').slice(0, 10)}`;

// Dates for each cited record, from the store.
function sourcesFor(ctx, refs) {
  const db = bTables(ctx.store);
  const out = [];
  for (const ref of refs.slice(0, 5)) {
    const row = db.prepare('SELECT source, ts FROM records WHERE id = ?').get(ref);
    out.push({ label: sourceLabel(row?.source ?? refSource(ref), ctx.lang), ...(row?.ts ? { date: localDate(row.ts, ctx.tz) } : {}) });
  }
  return out;
}

// Adds new questions (same question about the same subject counts once).
// Writes through the run's writer so undo covers it. Returns how many were new.
export function addReviewItems(w, items, { origin = 'sort', batchId = null } = {}) {
  if (!items?.length) return 0;
  const ctx = w.ctx;
  const data = loadReview(ctx);
  const have = new Set(data.items.map((i) => i.id));
  let added = 0;
  for (const it of items) {
    const question = oneLine(it.question);
    if (!question) continue;
    const id = reviewId(question, it.subject);
    if (have.has(id)) continue;
    have.add(id);
    data.items.push({
      id,
      status: 'open',
      question,
      ...(it.options?.length ? { options: it.options.map(oneLine).filter(Boolean) } : {}),
      ...(it.subject ? { subject: oneLine(it.subject) } : {}),
      refs: it.source_refs ?? [],
      sources: sourcesFor(ctx, (it.source_refs ?? []).filter((r) => !r.startsWith('note:'))),
      origin,
      ...(it.kind ? { kind: it.kind } : {}),
      ...(it.data ? { data: it.data } : {}),
      ...(batchId ? { batch_id: batchId } : {}),
      created_at: isoNow(ctx),
    });
    added++;
  }
  if (added) w.writeFile(REVIEW_FILE, `${JSON.stringify(data, null, 2)}\n`);
  return added;
}

export function reviewContent(ctx, items) {
  const tr = t('notes', ctx.lang);
  const open = items.filter((i) => i.status === 'open');
  const parts = [];
  if (!open.length) parts.push(tr('review.none'));
  else {
    parts.push(tr('review.intro'));
    parts.push(
      open
        .map((i) => {
          const bits = [`- [ ] **${i.question}**`];
          if (i.options?.length) bits.push(fill(tr('review.options'), { options: i.options.join(', ') }));
          if (i.subject) bits.push(fill(tr('review.about'), { subject: i.subject }));
          const src = (i.sources ?? []).map((s) => (s.date ? `${s.label}, ${s.date}` : s.label));
          return `${bits.join(' ')}${src.length ? ` _(${[...new Set(src)].join('; ')})_` : ''} \`${i.id}\``;
        })
        .join('\n'),
    );
  }
  const answered = items
    .filter((i) => i.status === 'resolved')
    .sort((a, b) => String(b.resolved_at).localeCompare(String(a.resolved_at)))
    .slice(0, RECENT_ANSWERS);
  if (answered.length) parts.push(`## ${tr('review.answered')}\n${answered.map((i) => `- [x] ${i.question} ${fill(tr('review.answer'), { answer: i.answer })}`).join('\n')}`);
  return parts.join('\n\n');
}

export function writeReviewNote(w) {
  const items = loadReview(w.ctx).items;
  return w.writeManaged(reviewNotePath(w.ctx.lang), {
    fm: { type: 'review', confidant_id: 'review', open: items.filter((i) => i.status === 'open').length, tags: ['review'] },
    title: reviewNoteName(w.ctx.lang),
    section: 'review',
    content: reviewContent(w.ctx, items),
  });
}

// Answers the sorter should follow, newest first.
export function resolutionsFor(ctx, limit = RESOLUTIONS_IN_BATCH) {
  return loadReview(ctx)
    .items.filter((i) => i.status === 'resolved' && i.answer)
    .sort((a, b) => String(b.resolved_at).localeCompare(String(a.resolved_at)))
    .slice(0, limit)
    .map((i) => ({ question: i.question, answer: i.answer, ...(i.subject ? { subject: i.subject } : {}) }));
}

export function openCount(ctx) {
  return loadReview(ctx).items.filter((i) => i.status === 'open').length;
}

function findItem(items, id) {
  const exact = items.find((i) => i.id === id);
  if (exact) return exact;
  const loose = items.filter((i) => i.id.startsWith(id) || normalizeName(i.question) === normalizeName(id));
  return loose.length === 1 ? loose[0] : null;
}

export function resolveReview(ctx, id, { answer, dismiss = false } = {}) {
  const release = takeLock(ctx, 'vault');
  try {
    const w = new NoteWriter(ctx, { kind: 'review' });
    const data = loadReview(ctx);
    const item = findItem(data.items, id);
    if (!item) throw new Error(`There is no review item ${id}. See \`confidant review\`.`);
    if (!dismiss && !oneLine(answer)) throw new Error('Pass the answer with --answer "<text>".');
    item.status = dismiss ? 'dismissed' : 'resolved';
    if (!dismiss) item.answer = oneLine(answer);
    item.resolved_at = isoNow(ctx);
    w.writeFile(REVIEW_FILE, `${JSON.stringify(data, null, 2)}\n`);
    writeReviewNote(w);
    const out = w.finish({});
    return { item, run_id: out.run_id };
  } finally {
    release();
  }
}

export async function run(args, ctx) {
  if (args.resolve || args.dismiss) {
    const id = String(args.resolve ?? args.dismiss);
    const { item } = resolveReview(ctx, id, { answer: args.answer === true ? '' : args.answer, dismiss: !!args.dismiss && !args.resolve });
    ctx.log.out({ item }, item.status === 'resolved' ? `Noted. The next sort will follow: ${item.answer}` : 'Set aside.');
    return 0;
  }
  const items = loadReview(ctx).items;
  const open = items.filter((i) => i.status === 'open');
  ctx.log.out({ open, resolved: items.filter((i) => i.status === 'resolved').length }, open.length ? open.map((i) => `${i.id}  ${i.question}${i.options?.length ? `  (${i.options.join(' / ')})` : ''}`).join('\n') : 'Nothing needs review right now.');
  return 0;
}
