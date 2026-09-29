// Reads .confidant/identity.json, written by Unit B's identity.mjs. The
// scheduled agents only ever read this file; they never rebuild it. Missing
// or not-yet-built gives a harmless empty identity so a digest still runs.
import { join } from 'node:path';
import { readJson } from './files.mjs';

const TIER_RANK = { inner: 0, active: 1, network: 2, cold: 3 };

export function tierRank(tier) {
  return TIER_RANK[tier] ?? 9;
}

export function loadIdentity(ctx) {
  const data = ctx.paths ? readJson(join(ctx.paths.root, 'identity.json'), null) : null;
  const people = data?.people ?? [];
  const byHandleMap = new Map();
  for (const p of people) for (const h of p.handles ?? []) byHandleMap.set(h, p);
  const byNameMap = new Map();
  for (const p of people) if (p.name) byNameMap.set(p.name.trim().toLowerCase(), p);
  return {
    owner: data?.owner ?? null,
    people,
    groups: data?.groups ?? [],
    generated_at: data?.generated_at ?? null,
    byHandle: (h) => (h ? byHandleMap.get(h) ?? null : null),
    // Commitments and dossiers only carry a counterpart's name (sometimes as
    // a "[[Wikilink]]"), never a handle, so name lookup matters just as much.
    byName: (name) => {
      if (!name) return null;
      const clean = String(name).replace(/^\[\[|\]\]$/g, '').trim().toLowerCase();
      return byNameMap.get(clean) ?? null;
    },
  };
}
