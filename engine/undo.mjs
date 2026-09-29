// `confidant undo --run <id>` | `confidant undo --last` | `confidant undo --list`
// Puts back every file a merge (or mocs) run changed, from the pre-image
// backup in .confidant/backups/<run>/, and restores the ledger rows, so the
// batch can be sorted and merged again.
import { bTables, takeLock } from './lib/b-common.mjs';
import { restoreRun } from './notes.mjs';

export function listRuns(ctx, limit = 20) {
  return bTables(ctx.store)
    .prepare('SELECT id, batch_id, kind, at, files, undone_at FROM b_runs ORDER BY rowid DESC LIMIT ?')
    .all(limit)
    .map((r) => ({ ...r, files: JSON.parse(r.files).length }));
}

export function undoRun(ctx, runId, { force = false } = {}) {
  const db = bTables(ctx.store);
  const run = db.prepare('SELECT rowid, * FROM b_runs WHERE id = ?').get(runId);
  if (!run) throw new Error(`There is no run ${runId}. See \`confidant undo --list\`.`);
  if (run.undone_at) throw new Error(`Run ${runId} was already undone.`);
  const mine = new Set(JSON.parse(run.files));
  const later = db.prepare('SELECT id, files FROM b_runs WHERE rowid > ? AND undone_at IS NULL').all(run.rowid);
  const overlap = later.filter((r) => JSON.parse(r.files).some((f) => mine.has(f))).map((r) => r.id);
  if (overlap.length && !force) {
    throw new Error(`Later runs changed the same notes (${overlap.join(', ')}). Undo those first, newest first, or pass --force.`);
  }
  if (ctx.dryRun) return { run_id: runId, restored: [...mine], dry_run: true };
  const release = takeLock(ctx, 'vault');
  try {
    const { restored, manifest } = restoreRun(ctx, runId);
    return { run_id: runId, batch_id: manifest.batch_id ?? null, restored };
  } finally {
    release();
  }
}

export async function run(args, ctx) {
  if (args.list) {
    const runs = listRuns(ctx);
    ctx.log.out({ runs }, runs.length ? runs.map((r) => `${r.id}  ${r.kind}${r.batch_id ? ` ${r.batch_id}` : ''}  ${r.files} files${r.undone_at ? '  (undone)' : ''}`).join('\n') : 'No runs yet.');
    return 0;
  }
  let id = args.run;
  if (args.last) id = listRuns(ctx, 50).find((r) => !r.undone_at)?.id;
  if (!id || id === true) {
    ctx.log.error('Pass --run <id>, --last or --list.');
    return 2;
  }
  const out = undoRun(ctx, String(id), { force: !!args.force });
  ctx.log.out(out, `Restored ${out.restored.length} files from before run ${out.run_id}.${out.batch_id ? ` Batch ${out.batch_id} can be merged again.` : ''}`);
  return 0;
}
