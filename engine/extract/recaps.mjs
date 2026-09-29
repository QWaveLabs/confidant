// Notetaker recap emails already sitting in the store, under source
// 'email' (Unit A's local Mail.app extractor) or 'gmail' (Unit C's
// ingest.mjs, when the person's Gmail account is not in Mail.app). A
// derived source: no network calls, no key, no probe failure mode.
//
// Recognizes recap emails from Fathom, Zoom AI Companion, Otter, Fireflies,
// Read.ai, tl;dv, Microsoft Teams/Copilot and Google Gemini ("Notes by
// Gemini"). Skips a recap when the same meeting already exists from a real
// API source, matched by title and local calendar date, so a person who
// connects both Fathom's API and reads Fathom's recap email gets one
// meeting note, not two.
//
// Cursor: the ISO ts of the last email record looked at (inclusive on the
// next run; the store's hash-based upsert makes reprocessing the boundary
// email a harmless no-op). cursor: null means "every email record ever
// stored," per the extractor contract.
import { localDate } from '../lib/time.mjs';

export const id = 'recaps';

const RECOGNIZERS = [
  { name: 'fathom', match: /fathom\.video|notifications@fathom/i },
  { name: 'zoom', match: /zoom\.us|AI Companion/i },
  { name: 'otter', match: /otter\.ai/i },
  { name: 'fireflies', match: /fireflies\.ai/i },
  { name: 'readai', match: /read\.ai/i },
  { name: 'tldv', match: /tldv\.io|tl;?dv/i },
  { name: 'teams', match: /Microsoft Teams|Copilot recap/i },
  { name: 'gemini', match: /Notes by Gemini|workspace-noreply@google\.com/i },
];

function recognize(email) {
  const haystack = `${email.from?.handle ?? ''} ${email.from?.name ?? ''} ${email.title ?? ''}`;
  return RECOGNIZERS.find((r) => r.match.test(haystack)) ?? null;
}

// Recap subjects usually read "Meeting notes: <title>", "Notes: <title>" or
// "<title> - Notes by Gemini." Falls back to the raw subject.
function extractTitle(email) {
  const subject = (email.title ?? '').trim();
  if (!subject) return null;
  const prefixed = subject.match(/^(?:meeting notes?|notes?|summary|(?:copilot\s+)?recap)\s*[:\-]\s*(.+)$/i);
  if (prefixed) return prefixed[1].trim();
  const suffixed = subject.match(/^(.+?)\s*[-–]\s*(?:notes by gemini|meeting notes?)$/i);
  return (suffixed ? suffixed[1] : subject).trim() || null;
}

function extractActionItems(text) {
  const lines = (text ?? '').split('\n');
  const items = [];
  let inSection = false;
  for (const line of lines) {
    if (/^\s*(action items?|next steps?|to-?dos?)\s*:?\s*$/i.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/) ?? line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet) {
      items.push(bullet[1].trim());
      continue;
    }
    if (line.trim() === '') continue;
    break; // a non-bullet, non-blank line closes the section
  }
  return items;
}

export async function probe(ctx) {
  const count = ctx.store.records({ sources: ['email', 'gmail'], limit: 1 }).length;
  return { ok: true, count };
}

export async function extract(ctx, { cursor, limit = 200 }) {
  const emails = ctx.store.records({ sources: ['email', 'gmail'], since: cursor ?? undefined, order: 'asc', limit });
  const records = [];
  for (const email of emails) {
    const hit = recognize(email);
    if (!hit) continue;
    const title = extractTitle(email);
    if (title) {
      const date = localDate(email.ts, ctx.tz);
      const dup = ctx.store
        .records({ kind: 'meeting', since: `${date}T00:00:00.000Z`, until: `${date}T23:59:59.999Z` })
        .some((r) => r.source !== 'recaps' && (r.title ?? '').trim().toLowerCase() === title.toLowerCase());
      if (dup) continue;
    }
    const text = (email.text ?? '').trim();
    const attendees = (email.to ?? []).filter((p) => p.handle && p.handle !== email.from?.handle);
    records.push({
      id: `recaps:${email.id}`,
      source: 'recaps',
      kind: 'meeting',
      thread: `meeting:recaps:${email.id}`,
      ts: email.ts,
      from: null,
      to: attendees,
      is_from_me: false,
      title,
      text,
      url: email.url ?? null,
      meta: { summary: text, action_items: extractActionItems(text), duration_s: null, recap_provider: hit.name },
    });
  }
  const last = emails.length ? emails[emails.length - 1].ts : cursor;
  return { records, cursor: last, done: emails.length < limit };
}
