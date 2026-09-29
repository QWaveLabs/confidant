// `confidant usage [--json] [--check-in]`
// Counts only, never content: briefs written and opened, notes opened
// recently, sessions in this vault, and the value delivered (commitments
// tracked, meetings prepped, opportunities flagged, follow-ups caught).
// Every external read (Codex's own database, Obsidian's workspace.json) is
// defensive: a missing or reshaped file gives null, never an error.
//
// `--check-in` also computes and records whether the Confidant Check-in
// task should speak this run (see planCheckIn below) and, only when it
// decides to, appends the decision to state.checkins so the next run knows
// not to repeat itself within a week, or the same improvement question
// within two.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { t } from './lib/i18n.mjs';
import { localDate } from './lib/time.mjs';
import { folderPath } from './lib/folders.mjs';
import { notesOfType } from './lib/d-notes.mjs';
import { loadIdentity } from './lib/d-identity.mjs';
import { peopleWaitingOnYou } from './digest.mjs';
import { defaultCodexDbPath, withCodexDb, automationRunStats, sessionCount } from './lib/d-codex.mjs';

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// Obsidian's workspace.json has no per-file timestamp: `lastOpenFiles` is
// just an ordered list of recently used paths. The best honest signal this
// gives us is "was a brief among the recently used files, as of roughly
// when this file itself last changed". Null when Obsidian has never
// written the file (headless install, or the person has not opened the
// vault yet), which check-in treats as "unknown", not "unused".
function briefOpenSignal(ctx, workspacePath, days) {
  if (!existsSync(workspacePath)) return null;
  let stat;
  try {
    stat = statSync(workspacePath);
  } catch {
    return null;
  }
  const data = readJsonSafe(workspacePath);
  if (!data) return null;
  const briefsPrefix = `${folderPath('briefs', ctx.lang)}/`;
  const lastOpen = Array.isArray(data.lastOpenFiles) ? data.lastOpenFiles : [];
  const hasBriefInRecents = lastOpen.some((p) => typeof p === 'string' && p.startsWith(briefsPrefix));
  const ageDays = (ctx.now.getTime() - stat.mtimeMs) / DAY_MS;
  return { hasBriefInRecents, workspaceAgeDays: ageDays, recentlyOpened: hasBriefInRecents && ageDays <= days };
}

function countBriefsWritten(ctx) {
  const dir = join(ctx.vault, folderPath('briefs', ctx.lang));
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

// commitmentsTracked and followUpsCaught both count commitment notes, by
// design: every commitment Confidant tracks either stays open (still
// tracked) or gets closed (a follow-up actually caught before it slipped).
function valueCounts(ctx) {
  const commitments = notesOfType(ctx.vault, 'commitment');
  return {
    commitmentsTracked: commitments.length,
    meetingsPrepped: notesOfType(ctx.vault, 'meeting').length,
    opportunitiesFlagged: notesOfType(ctx.vault, 'opportunity').length,
    followUpsCaught: commitments.filter((n) => n.data.status === 'done').length,
  };
}

// The Confidant Check-in decision. Pure function of state and the signals
// already gathered above, so it is fully testable without a database or a
// filesystem. See CONTRACTS.md "Trust, cleanup, support" for the rules;
// priority below (most specific and most useful first) is this unit's own
// judgment call where the contract lists several conditions without
// saying which wins when more than one applies at once.
export function planCheckIn({ now, tz, installedAt, checkins = [], briefsRecentlyOpened, waitingHook } = {}) {
  const daysSinceInstall = installedAt ? Math.floor((now.getTime() - new Date(installedAt).getTime()) / DAY_MS) : null;
  // Nothing to check in on yet: even a "first of the month" value receipt
  // would be near-empty this early, so nothing fires before day 3,
  // whatever else is true.
  if (daysSinceInstall == null || daysSinceInstall < 3) {
    return { shouldNotify: false, reason: null };
  }

  const sorted = [...checkins].sort((a, b) => new Date(a.at) - new Date(b.at));
  const last = sorted[sorted.length - 1] ?? null;
  if (last && now.getTime() - new Date(last.at).getTime() < WEEK_MS - DAY_MS) {
    // Never more than one check-in notification a week, however this run
    // was triggered.
    return { shouldNotify: false, reason: null };
  }

  const everCheckedIn = checkins.length > 0;
  if (!everCheckedIn && daysSinceInstall <= 10) {
    return { shouldNotify: true, reason: 'first_impressions' };
  }

  // Both sides go through localDate, so a check-in stored as a UTC instant
  // still compares against the vault's own local calendar month; near a
  // month boundary, a raw UTC string slice could disagree with `tz`.
  const monthKey = localDate(now, tz).slice(0, 7);
  const hasThisMonth = checkins.some((c) => c.reason === 'monthly_receipt' && localDate(new Date(c.at), tz).slice(0, 7) === monthKey);
  if (!hasThisMonth) {
    return { shouldNotify: true, reason: 'monthly_receipt', monthKey };
  }

  if (briefsRecentlyOpened === false) {
    return { shouldNotify: true, reason: 'low_usage', hook: waitingHook ?? null };
  }

  const lastImprovement = [...sorted].reverse().find((c) => c.reason === 'improvement_question');
  const dueForImprovement = !lastImprovement || now.getTime() - new Date(lastImprovement.at).getTime() >= 13 * DAY_MS;
  if (dueForImprovement) {
    const askedCount = checkins.filter((c) => c.reason === 'improvement_question').length;
    return { shouldNotify: true, reason: 'improvement_question', questionIndex: askedCount };
  }

  return { shouldNotify: false, reason: null };
}

export async function buildUsage(ctx, opts = {}) {
  const home = opts.home;
  const codexDbPath = opts.codexDbPath ?? defaultCodexDbPath(home);
  const workspacePath = opts.workspaceJsonPath ?? join(ctx.vault, '.obsidian', 'workspace.json');
  const tmpDir = ctx.tmpDir ? ctx.tmpDir() : opts.tmpDir;

  const automationIds = (ctx.state?.tasks ?? []).map((tsk) => tsk.automation_id).filter(Boolean);
  const sinceIso = new Date(ctx.now.getTime() - WEEK_MS).toISOString();

  const runStats = withCodexDb(codexDbPath, tmpDir, (db) => automationRunStats(db, automationIds, sinceIso));
  const sessionsLast7 = withCodexDb(codexDbPath, tmpDir, (db) => sessionCount(db, ctx.vault, sinceIso));
  const brief = briefOpenSignal(ctx, workspacePath, 7);
  const value = valueCounts(ctx);

  const identity = loadIdentity(ctx);
  const waiting = peopleWaitingOnYou(ctx, identity, 20);
  const waitingHook = waiting[0] ? { name: waiting[0].person?.name ?? waiting[0].record.from?.name ?? null } : null;

  const checkIn = planCheckIn({
    now: ctx.now,
    tz: ctx.tz,
    installedAt: ctx.config?.installedAt,
    checkins: ctx.state?.checkins ?? [],
    briefsRecentlyOpened: brief?.recentlyOpened ?? null,
    waitingHook,
  });
  // Resolve the actual question text here, once, so both a plain preview
  // (`usage --json` on its own) and a recorded check-in (`--check-in`)
  // agree on exactly what was asked.
  if (checkIn.reason === 'improvement_question') {
    const questions = t('agents', ctx.lang)('checkIn.questions');
    const list = Array.isArray(questions) ? questions : [];
    checkIn.question = list.length ? list[checkIn.questionIndex % list.length] : null;
  }

  return {
    generated_at: ctx.now.toISOString(),
    install: { installedAt: ctx.config?.installedAt ?? null, daysSinceInstall: ctx.config?.installedAt ? Math.floor((ctx.now.getTime() - new Date(ctx.config.installedAt).getTime()) / DAY_MS) : null },
    briefs: { written: countBriefsWritten(ctx), recentlyOpened: brief?.recentlyOpened ?? null, runsLast7: runStats?.total ?? null, runsOpenedLast7: runStats?.read ?? null },
    sessionsLast7,
    value,
    checkIn,
  };
}

function humanUsage(v) {
  const lines = [
    `Briefs written: ${v.briefs.written}`,
    `Brief opened in the last 7 days: ${v.briefs.recentlyOpened === null ? 'unknown' : v.briefs.recentlyOpened ? 'yes' : 'no'}`,
    `Sessions in this vault, last 7 days: ${v.sessionsLast7 === null ? 'unknown' : v.sessionsLast7}`,
    `Value: ${v.value.commitmentsTracked} commitments tracked, ${v.value.meetingsPrepped} meetings prepped, ${v.value.opportunitiesFlagged} opportunities flagged, ${v.value.followUpsCaught} follow-ups caught`,
    `Check-in: ${v.checkIn.shouldNotify ? `notify (${v.checkIn.reason})` : 'stay quiet'}`,
  ];
  return lines.join('\n');
}

export async function run(args, ctx) {
  const usage = await buildUsage(ctx);
  if (args.checkIn && usage.checkIn.shouldNotify && !ctx.dryRun) {
    const entry = { at: ctx.now.toISOString(), reason: usage.checkIn.reason, notified: true };
    if (usage.checkIn.question) entry.question = usage.checkIn.question;
    ctx.state.checkins = [...(ctx.state.checkins ?? []), entry];
    ctx.saveState();
  }
  ctx.log.out(usage, humanUsage);
  return 0;
}
