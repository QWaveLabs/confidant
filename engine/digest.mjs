// `confidant digest <key>`
// Prints the markdown context one scheduled task run needs: notes
// frontmatter (via lib/frontmatter.mjs, read through lib/d-notes.mjs),
// store records, and .confidant/identity.json. Target 5 to 10K tokens,
// with the per-section item caps below as the hard cap. Every function here
// gives a sensible, short "nothing to report" output when notes or
// identity do not exist yet, so a digest never fails on a fresh vault.
import { t } from './lib/i18n.mjs';
import { localDate } from './lib/time.mjs';
import { dayBounds, localHourMinute, localTimeToInstant } from './lib/d-time.mjs';
import { loadIdentity, tierRank } from './lib/d-identity.mjs';
import { notesOfType, timelineBullets, mentionsPerson } from './lib/d-notes.mjs';
import { readBriefSection, weeklyBriefPath } from './lib/d-brief.mjs';
import { buildSchedule } from './lib/d-schedule.mjs';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { parseNote } from './lib/frontmatter.mjs';

const DAY_MS = 86400000;
const daysBetween = (aStr, bStr) => Math.round((Date.parse(bStr) - Date.parse(aStr)) / DAY_MS);

function section(title, body) {
  return `## ${title}\n\n${body || '_None._'}\n`;
}

function list(items) {
  return items.length ? items.join('\n') : '';
}

// The most recent record on every thread, newest first. Used both to find
// who the person owes a reply to and, per attendee, their last exchange.
function latestPerThread(ctx, opts = {}) {
  const rows = ctx.store.records({ order: 'desc', limit: opts.limit ?? 5000, ...opts.filter });
  const seen = new Map();
  for (const r of rows) {
    if (!r.thread || seen.has(r.thread)) continue;
    seen.set(r.thread, r);
  }
  return [...seen.values()];
}

function latestForHandles(ctx, handles) {
  let best = null;
  for (const h of handles ?? []) {
    const rows = ctx.store.records({ fromHandle: h, order: 'desc', limit: 1 });
    if (rows[0] && (!best || new Date(rows[0].ts) > new Date(best.ts))) best = rows[0];
  }
  return best;
}

// `name` may already be a wikilink ("[[Mike Brennan]]", as commitment and
// opportunity notes store a counterpart) or a plain name; normalize first
// so a link is never wrapped twice.
function personLine(name, identity) {
  const clean = String(name ?? '').replace(/^\[\[|\]\]$/g, '').trim();
  if (!clean) return 'Someone';
  const p = identity.byName(clean);
  return p?.note_path ? `[[${clean}]]` : clean;
}

// A note body's first non-blank line, with any markdown heading marker
// stripped, e.g. "# Send Mike the pricing" -> "Send Mike the pricing".
function firstLine(body, fallback) {
  const line = (body ?? '').split('\n').find((l) => l.trim());
  return (line ? line.trim() : String(fallback ?? '')).replace(/^#{1,6}\s*/, '');
}

// ---- morning_brief -------------------------------------------------------

function peopleWaitingOnYou(ctx, identity, hours = 20) {
  const cutoff = ctx.now.getTime() - hours * 3600 * 1000;
  return latestPerThread(ctx)
    .filter((r) => !r.is_from_me && r.from?.handle && new Date(r.ts).getTime() <= cutoff)
    .map((r) => ({ record: r, person: identity.byHandle(r.from.handle) }))
    .sort((a, b) => tierRank(a.person?.tier) - tierRank(b.person?.tier) || new Date(a.record.ts) - new Date(b.record.ts))
    .slice(0, 10);
}

function stalledProjects(ctx, today, days = 14) {
  return notesOfType(ctx.vault, 'project')
    .filter((n) => n.data.status === 'active' && n.data.updated && daysBetween(n.data.updated, today) >= days)
    .sort((a, b) => daysBetween(b.data.updated, today) - daysBetween(a.data.updated, today));
}

function openCommitments(ctx, filterFn) {
  return notesOfType(ctx.vault, 'commitment').filter((n) => n.data.status === 'open' && (!filterFn || filterFn(n)));
}

function openOpportunities(ctx) {
  return notesOfType(ctx.vault, 'opportunity').filter((n) => n.data.status === 'open');
}

function morningBrief(ctx, identity, strings) {
  const h = strings('headings.morning_brief');
  const today = localDate(ctx.now, ctx.tz);
  const waiting = peopleWaitingOnYou(ctx, identity).map(({ record, person }) => {
    const name = person?.name ?? record.from?.name ?? record.from?.handle ?? 'Unknown';
    const days = Math.max(1, Math.floor((ctx.now.getTime() - new Date(record.ts).getTime()) / DAY_MS));
    return `- ${personLine(name, identity)}: "${(record.text || record.title || '').slice(0, 140)}" (${days}d, ${record.source})`;
  });
  const due = openCommitments(ctx, (n) => n.data.direction === 'i_owe' && n.data.due && n.data.due <= today)
    .sort((a, b) => (a.data.due < b.data.due ? -1 : 1))
    .map((n) => `- ${n.data.due < today ? strings('labels.overdue') : strings('labels.dueToday')}: ${firstLine(n.body, n.data.confidant_id)} (with ${personLine(n.data.counterpart, identity)}, due ${n.data.due})`);
  const { since, until } = dayBounds(today, ctx.tz, ctx.now);
  const meetings = ctx.store.records({ kind: 'event', since, until, order: 'asc' });
  const meetingLines = meetings.map((m, i) => {
    const time = new Date(m.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: ctx.tz });
    const attendees = (m.to ?? []).map((p) => personLine(p.name ?? identity.byHandle(p.handle)?.name ?? p.handle, identity)).join(', ');
    return `- ${i === 0 ? `**${strings('labels.firstMeeting')}** ` : ''}${time}: ${m.title || 'Meeting'}${attendees ? ` with ${attendees}` : ''}`;
  });
  const stalled = stalledProjects(ctx, today).map((n) => `- ${firstLine(n.body, n.path)}: no update in ${daysBetween(n.data.updated, today)}d`);
  const opps = openOpportunities(ctx).map((n) => `- ${firstLine(n.body, n.path)}${n.data.value ? ` (${n.data.value})` : ''}`);
  // opportunity_scanner runs 15 minutes before this one and, when it found
  // something, already wrote this section into today's brief.
  const scanned = readBriefSection(ctx.vault, ctx.lang, today, strings('headings.opportunity_scanner.open'));

  return [
    section(h.waiting, list(waiting)),
    section(h.commitments, list(due)),
    section(h.meetings, list(meetingLines)),
    section(h.stalled, list(stalled)),
    section(h.opportunities, list([...opps, ...(scanned ? [scanned] : [])])),
  ].join('\n');
}

// ---- follow_up_radar -------------------------------------------------------

function followUpRadar(ctx, identity, strings) {
  const h = strings('headings.follow_up_radar');
  const today = localDate(ctx.now, ctx.tz);
  const tomorrow = localDate(new Date(ctx.now.getTime() + DAY_MS), ctx.tz);
  const open = openCommitments(ctx);
  const byDirection = (dir) => open.filter((n) => n.data.direction === dir);

  const renderGroup = (notes) =>
    notes.map((n) => {
      const dueTomorrow = n.data.due === tomorrow;
      let line = `- ${firstLine(n.body, n.data.confidant_id)} (with ${personLine(n.data.counterpart, identity)}${n.data.due ? `, due ${n.data.due}` : ''})`;
      if (dueTomorrow) {
        line = `- **${strings('labels.dueTomorrow')}** ${line.slice(2)}`;
        const person = identity.byName(n.data.counterpart);
        const last = latestForHandles(ctx, person?.handles);
        if (last) line += `\n  ${strings('labels.lastExchange')}: "${(last.text || last.title || '').slice(0, 160)}" (${last.source}, ${localDate(last.ts, ctx.tz)})`;
      }
      return line;
    });

  return [
    section(h.i_owe, list(renderGroup(byDirection('i_owe')))),
    section(h.owed_to_me, list(renderGroup(byDirection('owed_to_me')))),
    section(h.delegated, list(renderGroup(byDirection('delegated')))),
  ].join('\n');
}

// ---- meeting_prep -----------------------------------------------------------

function nextMeetingPrepBound(ctx) {
  const schedule = buildSchedule(ctx.config).find((s) => s.key === 'meeting_prep');
  const today = localDate(ctx.now, ctx.tz);
  const { hour: nowHour, minute: nowMinute } = localHourMinute(ctx.now, ctx.tz);
  const later = (schedule?.hours ?? []).filter((hr) => hr > nowHour || (hr === nowHour && schedule.minute > nowMinute)).sort((a, b) => a - b);
  const { until: endOfDay } = dayBounds(today, ctx.tz, ctx.now);
  if (!later.length) return endOfDay;
  return localTimeToInstant(today, later[0], schedule.minute, ctx.tz, ctx.now);
}

function attendeeSection(ctx, identity, strings, personName, handle) {
  const h = strings('headings.meeting_prep');
  const person = handle ? identity.byHandle(handle) : identity.byName(personName);
  const name = person?.name ?? personName ?? 'Unknown';
  let noteBody = '';
  let noteData = {};
  if (person?.note_path) {
    const file = join(ctx.vault, person.note_path);
    if (existsSync(file)) {
      try {
        const parsed = parseNote(readFileSync(file, 'utf8'));
        noteBody = parsed.body;
        noteData = parsed.data;
      } catch { /* note not readable yet; digest still runs */ }
    }
  }
  const who = [
    noteData.relationship,
    noteData.company ? `Company: ${noteData.company}` : null,
    noteData.tier ? `Tier: ${noteData.tier}` : null,
  ].filter(Boolean).map((s) => String(s).replace(/\.\s*$/, '')).join('. ');
  const history = timelineBullets(noteBody, 3).map((b) => `- ${b.date}, ${b.text}`);
  const commitments = openCommitments(ctx, (n) => mentionsPerson(n.data.counterpart, name));
  const promises = commitments.map((n) => `- ${n.data.direction === 'i_owe' ? 'You owe them' : n.data.direction === 'owed_to_me' ? 'They owe you' : 'Delegated'}: ${firstLine(n.body, n.data.confidant_id)}${n.data.due ? ` (due ${n.data.due})` : ''}`);
  const decisions = notesOfType(ctx.vault, 'decision').filter((n) => mentionsPerson(n.data.decided_by, name));
  const decided = decisions.map((n) => `- ${n.data.date}: ${firstLine(n.body, n.data.confidant_id)}`);
  const opportunities = notesOfType(ctx.vault, 'opportunity').filter((n) => n.data.status === 'open' && mentionsPerson(n.data.counterpart, name));
  const oppLines = opportunities.map((n) => `- ${firstLine(n.body, n.path)}`);

  return [
    `### ${name}`,
    section(h.who, who || list(history)),
    section(h.history, list(history)),
    section(h.decided, list(decided)),
    section(h.promises, list(promises)),
    section(h.opportunity, list(oppLines)),
  ].join('\n');
}

function meetingPrep(ctx, identity, strings) {
  const today = localDate(ctx.now, ctx.tz);
  const { since } = dayBounds(today, ctx.tz, ctx.now);
  const until = nextMeetingPrepBound(ctx);
  const meetings = ctx.store.records({ kind: 'event', since: ctx.now.toISOString() > since ? ctx.now.toISOString() : since, until, order: 'asc' });
  if (!meetings.length) return '_No meetings before the next Meeting Prep run._\n';
  return meetings.map((m) => {
    const time = new Date(m.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: ctx.tz });
    const heading = `# ${time}: ${m.title || 'Meeting'}\n`;
    const attendees = (m.to ?? []).length ? m.to : [{ handle: null, name: null }];
    return heading + attendees.map((a) => attendeeSection(ctx, identity, strings, a.name, a.handle)).join('\n');
  }).join('\n---\n\n');
}

// ---- opportunity_scanner -----------------------------------------------------

function opportunityScanner(ctx, identity, strings) {
  const h = strings('headings.opportunity_scanner');
  const since = new Date(ctx.now.getTime() - 7 * DAY_MS).toISOString();
  const recent = ctx.store.records({ since, order: 'desc', limit: 300 })
    .filter((r) => !r.is_from_me)
    .map((r) => `- ${localDate(r.ts, ctx.tz)} ${r.source}: ${(r.text || r.title || '').slice(0, 160)}`);
  // CONTRACTS.md lists an opportunity note's own category under the key
  // `type`, which collides with the note-kind field every note already has
  // (also `type`). Until that is disambiguated (flagged in the final
  // report), read defensively: prefer a distinct `opportunity_type` key if
  // B ever adds one, and never assume `type` here is the category.
  const open = openOpportunities(ctx).map((n) => {
    const category = n.data.opportunity_type ? ` (${n.data.opportunity_type})` : '';
    return `- ${firstLine(n.body, n.path)}${category}${n.data.value ? `, ${n.data.value}` : ''}`;
  });
  return [section(h.recent, list(recent)), section(h.open, list(open))].join('\n');
}

// ---- weekly_review -----------------------------------------------------------

function weeklyReview(ctx, identity, strings) {
  const h = strings('headings.weekly_review');
  const today = localDate(ctx.now, ctx.tz);
  const weekAgo = localDate(new Date(ctx.now.getTime() - 7 * DAY_MS), ctx.tz);
  const inWeek = (d) => d && d >= weekAgo && d <= today;

  // No note type covers "team blocker", "recurring problem" or "biggest
  // development" (three of the ten headings below), so there is no note
  // query that can fill them. Give the run the week's raw meetings and
  // conversations instead; prompts/tasks/weekly_review.md has it infer
  // those three sections from this material rather than from notes.
  const weekStart = dayBounds(weekAgo, ctx.tz, ctx.now).since;
  const weekMeetings = ctx.store.records({ kind: 'meeting', since: weekStart, until: ctx.now.toISOString(), order: 'desc', limit: 20 })
    .map((m) => `- ${localDate(m.ts, ctx.tz)} ${m.title || 'Meeting'}: ${(m.meta?.summary || m.text || '').slice(0, 200)}`);
  const weekThreads = ctx.store.records({ since: weekStart, until: ctx.now.toISOString(), order: 'desc', limit: 150 })
    .filter((r) => !r.is_from_me && r.kind !== 'meeting')
    .slice(0, 30)
    .map((r) => `- ${localDate(r.ts, ctx.tz)} ${r.source}: ${(r.text || r.title || '').slice(0, 160)}`);

  const decisions = notesOfType(ctx.vault, 'decision').filter((n) => inWeek(n.data.date)).map((n) => `- ${n.data.date}: ${firstLine(n.body, n.data.confidant_id)}`);
  const commitmentsAll = notesOfType(ctx.vault, 'commitment');
  const opened = commitmentsAll.filter((n) => inWeek(n.data.date)).map((n) => `- Opened: ${firstLine(n.body, n.data.confidant_id)}`);
  const closed = commitmentsAll.filter((n) => n.data.status === 'done' && inWeek(n.data.updated)).map((n) => `- Closed: ${firstLine(n.body, n.data.confidant_id)}`);
  const stalled = stalledProjects(ctx, today).map((n) => `- ${firstLine(n.body, n.path)}`);
  const opps = openOpportunities(ctx).map((n) => `- ${firstLine(n.body, n.path)}`);
  const waiting = peopleWaitingOnYou(ctx, identity).map(({ record, person }) => `- ${personLine(person?.name ?? record.from?.name ?? 'Someone', identity)}`);
  const nextWeekStart = localDate(new Date(ctx.now.getTime() + DAY_MS), ctx.tz);
  const nextWeekEnd = localDate(new Date(ctx.now.getTime() + 7 * DAY_MS), ctx.tz);
  const { since } = dayBounds(nextWeekStart, ctx.tz, ctx.now);
  const { until } = dayBounds(nextWeekEnd, ctx.tz, ctx.now);
  const nextWeek = ctx.store.records({ kind: 'event', since, until, order: 'asc' }).map((m) => `- ${localDate(m.ts, ctx.tz)}: ${m.title || 'Meeting'}`);

  return [
    section(h.context, list([...weekMeetings, ...weekThreads])),
    section(h.decisions, list(decisions)),
    section(h.commitments, list([...opened, ...closed])),
    section(h.stalled, list(stalled)),
    section(h.opportunities, list(opps)),
    section(h.waiting, list(waiting)),
    section(h.blockers, ''),
    section(h.recurring, ''),
    section(h.ideas, list(notesOfType(ctx.vault, 'idea').map((n) => `- ${firstLine(n.body, n.path)}`))),
    section(h.developments, ''),
    section(h.priorities, list(nextWeek)),
  ].join('\n');
}

// ---- brain_update ------------------------------------------------------------

function brainUpdate(ctx, identity, strings) {
  const h = strings('headings.brain_update');
  const counts = ctx.store.counts();
  const backlog = ctx.state?.backlog ?? {};
  const lines = [
    `- Last update: ${ctx.state?.lastUpdate?.at ?? 'never'}`,
    `- Backlog: ${backlog.remaining_batches ?? 0} batches remaining${backlog.done ? ' (done)' : ''}`,
    ...counts.map((c) => `- ${c.source}/${c.kind}: ${c.n} (${c.first ?? '?'} to ${c.last ?? '?'})`),
  ];
  return section(h.status, list(lines));
}

const BUILDERS = {
  morning_brief: morningBrief,
  follow_up_radar: followUpRadar,
  meeting_prep: meetingPrep,
  opportunity_scanner: opportunityScanner,
  weekly_review: weeklyReview,
  brain_update: brainUpdate,
};

export function buildDigest(ctx, key) {
  const builder = BUILDERS[key];
  if (!builder) throw new Error(`Unknown digest "${key}". Use one of: ${Object.keys(BUILDERS).join(', ')}`);
  const identity = loadIdentity(ctx);
  const strings = t('agents', ctx.lang);
  const title = strings(`names.${key}`);
  const body = builder(ctx, identity, strings);
  return `# ${title}\n\n${body}`;
}

export async function run(args, ctx) {
  const key = args._[0];
  if (!key || !BUILDERS[key]) {
    ctx.log.error(`confidant digest <key>, one of: ${Object.keys(BUILDERS).join(', ')}`);
    return 2;
  }
  const text = buildDigest(ctx, key);
  process.stdout.write(`${text}\n`);
  return 0;
}
