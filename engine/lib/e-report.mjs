// Shared "what's actually connected" reporting, used by both `confidant
// status` and the welcome guide so the two never disagree.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCES } from './sources.mjs';
import { FOLDERS, BRIEFS, folderName } from './folders.mjs';

// One row per known source: registry info, what config.sources says, and
// real counts from the store (0 when nothing has been extracted yet).
export function sourceRows(ctx) {
  const counts = ctx.store.counts();
  const bySource = new Map();
  for (const row of counts) {
    const agg = bySource.get(row.source) ?? { n: 0, first: null, last: null };
    agg.n += row.n;
    if (!agg.first || row.first < agg.first) agg.first = row.first;
    if (!agg.last || row.last > agg.last) agg.last = row.last;
    bySource.set(row.source, agg);
  }
  return SOURCES.map((src) => {
    const cfg = ctx.config?.sources?.[src.id];
    const agg = bySource.get(src.id) ?? { n: 0, first: null, last: null };
    return {
      id: src.id,
      label: src.label?.[ctx.lang] ?? src.label?.en ?? src.id,
      method: src.method,
      enabled: !!cfg?.enabled,
      status: cfg?.status ?? (cfg?.enabled ? 'connected' : 'unused'),
      note: cfg?.note ?? null,
      since: cfg?.since ?? null,
      count: agg.n,
      firstSeen: agg.first,
      lastSeen: agg.last,
    };
  });
}

// Recursively counts .md files under a vault folder (0 if it doesn't exist
// yet, e.g. a fresh vault before the first sort has run).
function countMarkdown(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) n += countMarkdown(full);
    else if (entry.toLowerCase().endsWith('.md')) n += 1;
  }
  return n;
}

// One row per vault folder (the nine content folders plus Briefs), with how
// many notes are in it right now.
export function folderRows(ctx) {
  const keys = [...FOLDERS.map((f) => f.key), BRIEFS.key];
  return keys.map((key) => ({
    key,
    name: folderName(key, ctx.lang),
    count: countMarkdown(join(ctx.vault, folderName(key, ctx.lang))),
  }));
}
