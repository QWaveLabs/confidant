// Defensive, read-only access to the Codex desktop app's own database,
// `~/.codex/sqlite/codex-dev.db`. Confirmed by inspecting a real copy of
// that file (read-only, structure and counts only, never row content):
//   automations(id, status, rrule, cwds JSON-array-of-strings, ...)
//   automation_runs(automation_id, thread_id, status, read_at, created_at, source_cwd, ...)
//   local_thread_catalog(thread_id, cwd, source_created_at, project_id, ...)
// `automations.cwds` and `local_thread_catalog.cwd` hold real filesystem
// paths; `source_created_at` is epoch seconds (sometimes fractional),
// `automation_runs.read_at`/`created_at` are unverified (automation_runs
// was empty on the machine this was built on) so both are passed through
// `fromUnix`, which already guesses seconds vs milliseconds. This file is
// invented against one real database, not a published schema: every read
// here must stay defensive, since a future Codex version can rename or
// drop any of this without warning. See the final report for the
// verification status.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openSourceCopy } from './sqlite.mjs';
import { fromUnix } from './time.mjs';

export function defaultCodexDbPath(home = homedir()) {
  return join(home, '.codex', 'sqlite', 'codex-dev.db');
}

// Runs `fn(db)` against a throwaway copy of the Codex database and always
// cleans up. Returns `fallback` (default null) for a missing file, a
// locked file, a missing table, or any other read problem: usage and
// health must never fail just because this file moved or changed shape.
export function withCodexDb(dbPath, tmpDir, fn, fallback = null) {
  if (!dbPath || !existsSync(dbPath)) return fallback;
  let copy;
  try {
    copy = openSourceCopy(dbPath, tmpDir);
  } catch {
    return fallback;
  }
  try {
    return fn(copy.db);
  } catch {
    return fallback;
  } finally {
    copy.close();
  }
}

// automations.cwds is a JSON array of paths; true when any of them is this
// vault (exact match, since Codex records the working directory as given).
export function cwdsMatch(cwdsJson, vault) {
  try {
    const list = JSON.parse(cwdsJson ?? '[]');
    return Array.isArray(list) && list.includes(vault);
  } catch {
    return false;
  }
}

// Automation run counts for this vault's own scheduled tasks (by
// automation_id, from state.tasks), since `sinceIso`: how many ran, how
// many were opened (`read_at` set). Null when the database or table is not
// there; { total: 0, read: 0 } when it is there but empty or no runs match.
export function automationRunStats(db, automationIds, sinceIso) {
  if (!automationIds.length) return { total: 0, read: 0 };
  const sinceEpoch = sinceIso ? new Date(sinceIso).getTime() / 1000 : 0;
  const placeholders = automationIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT read_at, created_at FROM automation_runs WHERE automation_id IN (${placeholders})`).all(...automationIds);
  let total = 0;
  let read = 0;
  for (const r of rows) {
    const createdIso = fromUnix(r.created_at);
    if (createdIso && new Date(createdIso).getTime() / 1000 < sinceEpoch) continue;
    total++;
    if (r.read_at != null) read++;
  }
  return { total, read };
}

// This vault's own automations: status, cwds and last run, keyed by
// automation_id. Used by health to notice a task Codex itself has paused,
// or that no longer lists this vault among its working directories.
export function automationStatuses(db, automationIds) {
  if (!automationIds.length) return [];
  const placeholders = automationIds.map(() => '?').join(',');
  return db.prepare(`SELECT id, status, cwds, next_run_at, last_run_at FROM automations WHERE id IN (${placeholders})`).all(...automationIds);
}

// Codex sessions (threads) opened with this vault as the working directory,
// since `sinceIso`. A proxy for "questions asked in the vault project this
// week": every session started here is, in practice, the person asking
// Confidant something directly instead of waiting for a scheduled brief.
export function sessionCount(db, vault, sinceIso) {
  const sinceEpoch = sinceIso ? new Date(sinceIso).getTime() / 1000 : 0;
  const rows = db.prepare('SELECT cwd, source_created_at FROM local_thread_catalog WHERE cwd = ?').all(vault);
  return rows.filter((r) => Number(r.source_created_at) >= sinceEpoch).length;
}
