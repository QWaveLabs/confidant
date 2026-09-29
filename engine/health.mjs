// `confidant health [--json]`
// Is everything still working: last successful update age, each enabled
// source's readability and key validity (via the extractors' own probe(),
// reused from `extract/index.mjs`), backlog progress, disk space, and
// whether the vault is still writable. Every problem comes with a plain,
// specific fix, in the vault's own language, so health_check's prompt
// never has to invent one.
import { statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from './lib/files.mjs';
import { t } from './lib/i18n.mjs';
import { enabledSources } from './lib/sources.mjs';
import { probeSources } from './extract/index.mjs';
import { defaultCodexDbPath, withCodexDb, automationStatuses, cwdsMatch } from './lib/d-codex.mjs';

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const STALE_UPDATE_HOURS = 7; // CONTRACTS.md: warn past this
const BACKLOG_STUCK_DAYS = 3;
const LOW_DISK_BYTES = 1024 * 1024 * 1024; // 1 GB

function checkUpdateAge(ctx, strings, problems) {
  const at = ctx.state?.lastUpdate?.at ?? null;
  if (!at) {
    problems.push({ area: 'update', message: strings('health.neverUpdated'), fix: strings('health.fixNeverUpdated') });
    return { at: null, ageHours: null };
  }
  const ageHours = (ctx.now.getTime() - new Date(at).getTime()) / HOUR_MS;
  if (ageHours > STALE_UPDATE_HOURS) {
    problems.push({ area: 'update', message: strings('health.staleUpdate', { hours: Math.round(ageHours) }), fix: strings('health.fixStaleUpdate') });
  }
  return { at, ageHours };
}

async function checkSources(ctx, strings, problems) {
  const ids = enabledSources(ctx.config).map((s) => s.id);
  const probes = await probeSources(ctx, ids);
  for (const p of probes) {
    if (p.ok) continue;
    const fix = p.needsFullDiskAccess ? strings('health.fixFullDiskAccess')
      : p.needsKey ? strings('health.fixKey', { source: p.id })
      : strings('health.fixSourceGeneric', { source: p.id });
    problems.push({ area: `source:${p.id}`, message: strings('health.sourceBroken', { source: p.id }), fix });
  }
  return probes;
}

// Tracks the backlog's own remaining_batches across runs, in state, so a
// count that never changes over several days can be told apart from one
// that is simply large. Returns the (possibly unchanged) tracking object
// to save, and whether the backlog looks stuck.
function checkBacklog(ctx, strings, problems) {
  const backlog = ctx.state?.backlog ?? {};
  const tracked = ctx.state?.health?.backlogTracked ?? null;
  let stuck = false;
  let next = null;
  if (!backlog.done && (backlog.remaining_batches ?? 0) > 0) {
    if (tracked && tracked.remaining_batches === backlog.remaining_batches) {
      const days = (ctx.now.getTime() - new Date(tracked.since).getTime()) / DAY_MS;
      stuck = days >= BACKLOG_STUCK_DAYS;
      next = tracked;
    } else {
      next = { remaining_batches: backlog.remaining_batches ?? 0, since: ctx.now.toISOString() };
    }
  }
  if (stuck) problems.push({ area: 'backlog', message: strings('health.backlogStuck', { days: BACKLOG_STUCK_DAYS }), fix: strings('health.fixBacklogStuck') });
  return { backlog: { ...backlog, stuck }, tracked: next };
}

function checkDisk(ctx, strings, problems) {
  try {
    const s = statfsSync(ctx.vault);
    const availableBytes = s.bavail * s.bsize;
    if (availableBytes < LOW_DISK_BYTES) problems.push({ area: 'disk', message: strings('health.lowDisk'), fix: strings('health.fixLowDisk') });
    return { availableBytes };
  } catch {
    return null; // statfs unsupported on this platform; not a health problem
  }
}

// Cross-checks each recorded task against Codex's own automations table:
// still active, and still pointed at this vault. Defensive by nature (via
// withCodexDb): a missing or reshaped Codex database means "unknown", not
// a problem, since this cross-check is a bonus, not the source of truth
// for whether a task is really scheduled.
function checkTasks(ctx, strings, problems, opts = {}) {
  const tasks = ctx.state?.tasks ?? [];
  const ids = tasks.map((tsk) => tsk.automation_id).filter(Boolean);
  if (!ids.length) return [];
  const dbPath = opts.codexDbPath ?? defaultCodexDbPath(opts.home);
  const statuses = withCodexDb(dbPath, opts.tmpDir ?? (ctx.tmpDir ? ctx.tmpDir() : undefined), (db) => automationStatuses(db, ids));
  if (statuses == null) return null; // Codex's own database is not reachable; not this vault's fault
  const byId = new Map(statuses.map((s) => [s.id, s]));
  return tasks.map((tsk) => {
    const row = byId.get(tsk.automation_id);
    const ok = !!row && row.status === 'ACTIVE' && cwdsMatch(row.cwds, ctx.vault);
    if (!ok) {
      problems.push({
        area: `task:${tsk.key}`,
        message: strings('health.taskInactive', { task: tsk.name }),
        fix: strings('health.fixTaskInactive', { task: tsk.name }),
      });
    }
    return { key: tsk.key, automation_id: tsk.automation_id, ok };
  });
}

function checkWritable(ctx, strings, problems) {
  try {
    ensureDir(ctx.paths.tmp);
    const probe = join(ctx.paths.tmp, `.health-probe-${Date.now()}`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    return true;
  } catch {
    problems.push({ area: 'vault', message: strings('health.notWritable'), fix: strings('health.fixNotWritable') });
    return false;
  }
}

export async function buildHealth(ctx, opts = {}) {
  const strings = t('agents', ctx.lang);
  const problems = [];

  const lastUpdate = checkUpdateAge(ctx, strings, problems);
  const sources = await checkSources(ctx, strings, problems);
  const { backlog, tracked } = checkBacklog(ctx, strings, problems);
  const tasks = checkTasks(ctx, strings, problems, opts);
  const disk = checkDisk(ctx, strings, problems);
  const vaultWritable = checkWritable(ctx, strings, problems);

  if (!ctx.dryRun) {
    ctx.state.health = { ...(ctx.state.health ?? {}), backlogTracked: tracked };
    ctx.saveState();
  }

  return {
    ok: problems.length === 0,
    checked_at: ctx.now.toISOString(),
    lastUpdate,
    sources,
    tasks,
    backlog,
    disk,
    vaultWritable,
    problems,
  };
}

function humanHealth(v) {
  if (v.ok) return 'Everything looks healthy.';
  return v.problems.map((p) => `- ${p.message}\n  Fix: ${p.fix}`).join('\n');
}

export async function run(args, ctx) {
  // Like `doctor`, this always exits 0: finding a problem is a successful
  // check, not a failed run. The `ok` field in the JSON carries the verdict.
  const report = await buildHealth(ctx);
  ctx.log.out(report, humanHealth);
  return 0;
}
