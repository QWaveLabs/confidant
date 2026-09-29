// `confidant update`          the 3-hour Brain Update: extract, identify,
//                              plan batches, print them for Codex to sort
// `confidant update --finish` after Codex has merged every batch: rebuild
//                              the mocs and record the run
//
// Unit B's identity, dossiers, batch and mocs modules are loaded
// dynamically: another unit builds them in parallel, so on a fresh checkout
// they may not exist yet. Each step degrades to a warning instead of a
// crash, exactly like `extract/index.mjs` already does for a source that
// "is not built".
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock } from './lib/lock.mjs';
import { enabledSources } from './lib/sources.mjs';
import { extractSource, purgeExcluded } from './extract/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

async function loadOptional(rel) {
  const path = join(HERE, rel);
  return existsSync(path) ? import(path) : null;
}

async function runExtract(ctx) {
  const sources = enabledSources(ctx.config).filter((s) => s.method !== 'app');
  const results = [];
  for (const src of sources) {
    try {
      results.push(await extractSource(ctx, src));
    } catch (err) {
      results.push({ id: src.id, ok: false, reason: err.message, reason_code: err.reason_code, message: err.localized, needsFullDiskAccess: !!err.needsFullDiskAccess });
    }
  }
  // Exclusions added since the last update also clear what is already stored.
  await purgeExcluded(ctx);
  return results;
}

async function runIdentity(ctx) {
  const mod = await loadOptional('./identity.mjs');
  if (!mod?.buildIdentity) {
    ctx.log.warn('identity: not built yet, skipping');
    return { ok: false };
  }
  try {
    await mod.buildIdentity(ctx);
    return { ok: true };
  } catch (err) {
    ctx.log.warn(`identity: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

async function runDossiers(ctx, changedSince) {
  const mod = await loadOptional('./dossiers.mjs');
  if (!mod?.buildDossiers) {
    ctx.log.warn('dossiers: not built yet, skipping');
    return { ok: false };
  }
  try {
    await mod.buildDossiers(ctx, { changedSince });
    return { ok: true };
  } catch (err) {
    ctx.log.warn(`dossiers: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

async function runBatches(ctx) {
  const mod = await loadOptional('./batch.mjs');
  if (!mod?.planBatches) {
    ctx.log.warn('batch: not built yet, skipping');
    return [];
  }
  const batches = [];
  try {
    batches.push(...(await mod.planBatches(ctx, { scope: 'update' })));
  } catch (err) {
    ctx.log.warn(`batch (update scope): ${err.message}`);
  }
  try {
    batches.push(...(await mod.planBatches(ctx, { scope: 'backlog', count: 1 })));
  } catch (err) {
    ctx.log.warn(`batch (backlog scope): ${err.message}`);
  }
  return batches;
}

async function runMocs(ctx) {
  const mod = await loadOptional('./mocs.mjs');
  if (!mod?.buildMocs) {
    ctx.log.warn('mocs: not built yet, skipping');
    return { ok: false };
  }
  try {
    await mod.buildMocs(ctx);
    return { ok: true };
  } catch (err) {
    ctx.log.warn(`mocs: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

async function finish(ctx) {
  const mocs = await runMocs(ctx);
  ctx.state.lastUpdate = {
    at: new Date().toISOString(),
    inserted: ctx.state.lastUpdate?.inserted ?? 0,
    merged: ctx.state.lastUpdate?.merged ?? 0,
  };
  ctx.saveState();
  ctx.log.out({ ok: true, mocs: mocs.ok }, 'Brain update finished: mocs rebuilt.');
  return 0;
}

export async function run(args, ctx) {
  if (args.finish) return finish(ctx);

  const lock = acquireLock(ctx.paths, 'vault');
  if (lock.held) {
    // Another run (a scheduled task that overlapped, or a person running
    // the CLI by hand) is already updating this vault. Exit clean so the
    // caller's heartbeat rule can read `locked: true` and stay quiet.
    ctx.log.out({ ok: false, locked: true, holder: lock.holder }, 'Another run is already updating this vault. Nothing to do this time.');
    return 0;
  }

  try {
    const extracted = await runExtract(ctx);
    const identity = await runIdentity(ctx);
    const dossiers = await runDossiers(ctx, ctx.state?.lastUpdate?.at);
    const batches = await runBatches(ctx);

    // batch.mjs owns state.backlog (its estimate of history left); don't overwrite it here.

    const inserted = extracted.reduce((n, r) => n + (r.inserted ?? 0), 0);
    const out = {
      ok: true,
      extracted,
      identity: identity.ok,
      dossiers: dossiers.ok,
      batches: batches.map((b) => ({ id: b.id, path: b.path, kind: b.kind, est_tokens: b.est_tokens })),
    };
    ctx.log.out(out, (v) => [
      `Extracted: ${v.extracted.length ? v.extracted.map((e) => `${e.id} +${e.inserted ?? 0}`).join(', ') : 'no sources enabled'} (${inserted} new total)`,
      v.batches.length ? `Batches to sort:\n${v.batches.map((b) => `  ${b.path}`).join('\n')}` : 'No batches to sort.',
    ].join('\n'));
    return 0;
  } finally {
    lock.release();
  }
}
