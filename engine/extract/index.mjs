// `confidant extract [--source <id>] [--probe] [--limit N] [--full]`
// Runs every enabled local/api/export/derived source page by page:
//   extractor.extract(ctx, { cursor, limit }) -> { records, cursor, done }
// Each page is privacy-filtered, validated, stored, and its cursor saved, so
// a stopped run resumes where it left off. --full ignores saved cursors.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, getSource, enabledSources } from '../lib/sources.mjs';
import { check } from '../lib/schema.mjs';
import { exclusionsPending, EXCLUSIONS_FIRST } from '../lib/f-install.mjs';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..');

async function loadModule(rel) {
  if (!rel) return null;
  const path = join(ENGINE, rel);
  return existsSync(path) ? import(path) : null;
}

// Fails closed: without the privacy filter nothing is stored.
async function loadPrivacy() {
  const mod = await loadModule('./privacy.mjs');
  if (!mod?.filterRecord) throw new Error('The privacy filter (engine/privacy.mjs) is missing, so nothing was stored.');
  return mod;
}

// Drops stored records that exclusions added since the last run now cover.
export async function purgeExcluded(ctx) {
  if (ctx.dryRun) return null;
  const privacy = await loadPrivacy();
  return privacy.purgeExcluded ? privacy.purgeExcluded(ctx) : null;
}

export async function probeSources(ctx, ids) {
  const out = [];
  for (const src of ids.map(getSource).filter(Boolean)) {
    const mod = await loadModule(src.module);
    if (!mod?.probe) {
      out.push({ id: src.id, method: src.method, ok: false, reason: src.method === 'app' ? 'read through a Codex app' : 'not built' });
      continue;
    }
    try {
      out.push({ id: src.id, method: src.method, ...(await mod.probe(ctx)) });
    } catch (err) {
      out.push({ id: src.id, method: src.method, ok: false, reason: err.message, reason_code: err.reason_code, message: err.localized, needsFullDiskAccess: !!err.needsFullDiskAccess });
    }
  }
  return out;
}

export async function extractSource(ctx, src, { limit = 2000, full = false, maxPages = Infinity } = {}) {
  const mod = await loadModule(src.module);
  if (!mod?.extract) return { id: src.id, ok: false, reason: 'not built' };
  const privacy = await loadPrivacy();
  // Exclusions that cover a whole thread (an excluded person in a small
  // chat, a bank short code) reach every record in it, whatever the order.
  const gate = privacy.threadGate ? privacy.threadGate(ctx) : null;
  const totals = { id: src.id, ok: true, pages: 0, inserted: 0, updated: 0, unchanged: 0, excluded: 0, invalid: 0 };
  let cursor = full ? null : ctx.store.getCursor(src.id);
  for (let page = 0; page < maxPages; page++) {
    const result = await mod.extract(ctx, { cursor, limit });
    const valid = [];
    for (const r of result.records ?? []) {
      if (check('record', r).length) totals.invalid++;
      else valid.push(r);
    }
    let keep;
    if (gate) {
      const g = gate.filter(valid);
      keep = g.keep;
      totals.excluded += g.excluded;
    } else {
      keep = valid.filter((r) => privacy.filterRecord(r, ctx.config).keep);
      totals.excluded += valid.length - keep.length;
    }
    if (!ctx.dryRun) {
      const c = ctx.store.upsertRecords(keep);
      totals.inserted += c.inserted;
      totals.updated += c.updated;
      totals.unchanged += c.unchanged;
      if (result.cursor !== undefined) ctx.store.setCursor(src.id, result.cursor);
    } else {
      totals.inserted += keep.length;
    }
    totals.pages++;
    cursor = result.cursor ?? cursor;
    if (result.done || !(result.records ?? []).length) break;
  }
  if (gate?.removed) totals.removed = gate.removed;
  return totals;
}

export async function run(args, ctx) {
  const ids = args.source ? [].concat(args.source) : enabledSources(ctx.config).filter((s) => s.method !== 'app').map((s) => s.id);
  if (args.probe) {
    const results = await probeSources(ctx, args.source ? ids : SOURCES.map((s) => s.id));
    ctx.log.out({ probes: results }, (v) => v.probes.map((p) => `${p.ok ? 'ok  ' : 'no  '} ${p.id}${p.reason ? `: ${p.reason}` : ''}`).join('\n'));
    return 0;
  }
  if (exclusionsPending(ctx.state)) {
    ctx.log.error(EXCLUSIONS_FIRST);
    return 7;
  }
  const results = [];
  for (const id of ids) {
    const src = getSource(id);
    if (!src) {
      results.push({ id, ok: false, reason: 'unknown source' });
      continue;
    }
    try {
      results.push(await extractSource(ctx, src, { limit: args.limit ? Number(args.limit) : undefined, full: !!args.full, maxPages: args.maxPages ? Number(args.maxPages) : Infinity }));
    } catch (err) {
      results.push({ id, ok: false, reason: err.message, reason_code: err.reason_code, message: err.localized, needsFullDiskAccess: !!err.needsFullDiskAccess });
    }
  }
  const purged = await purgeExcluded(ctx);
  ctx.log.out({ results, purged }, (v) => v.results.map((r) => (r.ok ? `${r.id}: +${r.inserted} new, ${r.updated} updated, ${r.excluded} left out` : `${r.id}: skipped (${r.reason})`)).join('\n'));
  return results.some((r) => !r.ok && r.reason !== 'not built') ? 5 : 0;
}
