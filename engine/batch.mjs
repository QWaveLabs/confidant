// `confidant batch next [--scope install|update|backlog] [--count N] [--max-tokens N]`
// `confidant batch status`
//
// Packs dossiers into batch files Codex can sort in one pass each
// (schemas/batch.schema.json), and keeps a ledger of every batch in brain.db:
// pending (planned), written (a contribution exists), merged, skipped.
//   install: the last 60 days. Names to double check go first, alone, so the
//            people batches that follow use the confirmed identities.
//   update:  everything that changed since the last update.
//   backlog: older history, newest first, one 30-day window per call, until
//            the whole history is done. Progress lives in state.backlog.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from './lib/files.mjs';
import { REPO_ROOT } from './lib/paths.mjs';
import { daysAgo, localDate, toMs } from './lib/time.mjs';
import { shortHash } from './lib/hash.mjs';
import { check } from './lib/schema.mjs';
import { estimateTokens, oneLine } from './lib/b-text.mjs';
import { bPaths, bTables, takeLock, patchState, sourceLabel, isoNow, loadScrub } from './lib/b-common.mjs';
import { loadPersona, personaText } from './lib/b-persona.mjs';
import { buildIdentity, loadIdentity } from './identity.mjs';
import { buildDossiers } from './dossiers.mjs';
import { resolutionsFor } from './review.mjs';

const DAY = 86400000;
export const INSTALL_DAYS = 60;
export const BACKLOG_DAYS = 30;
const MAX_ATTEMPTS = 3;
const RESERVE = 6000;
const MAX_ITEMS = { people: 25, threads: 12, meetings: 6, update: 20, identity_review: 30 };
const KNOWN_PEOPLE = 300;
const KNOWN_COMPANIES = 300;
const KNOWN_PROJECTS = 200;
const KNOWN_DETAILED = 120;
const KNOWN_MEETINGS = 20;
const INSTRUCTIONS = join(REPO_ROOT, 'prompts', 'sort.md');

const meta = (ctx, key, fallback = null) => ctx.store.getMeta(`b.${key}`, fallback);
const setMeta = (ctx, key, value) => {
  if (!ctx.dryRun) ctx.store.setMeta(`b.${key}`, value);
};

// ---------- ledger ----------

function nextSeq(db) {
  return (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM b_batches').get().n);
}

// Contributions written since the last look become 'written'.
function refreshWritten(ctx) {
  const db = bTables(ctx.store);
  const rows = db.prepare(`SELECT id, output FROM b_batches WHERE status = 'pending'`).all();
  for (const r of rows) if (existsSync(r.output) && !ctx.dryRun) db.prepare(`UPDATE b_batches SET status = 'written' WHERE id = ?`).run(r.id);
}

function pendingRows(ctx, scope) {
  const db = bTables(ctx.store);
  const rows = db.prepare(`SELECT * FROM b_batches WHERE scope = ? AND status = 'pending' ORDER BY seq`).all(scope);
  const out = [];
  for (const r of rows) {
    if (r.attempts >= MAX_ATTEMPTS) {
      if (!ctx.dryRun) db.prepare(`UPDATE b_batches SET status = 'skipped' WHERE id = ?`).run(r.id);
      continue;
    }
    out.push(r);
  }
  return out;
}

export function ledgerCounts(ctx) {
  const db = bTables(ctx.store);
  const out = {};
  for (const scope of ['install', 'update', 'backlog']) out[scope] = { pending: 0, written: 0, merged: 0, skipped: 0, total: 0, est_tokens: 0 };
  for (const r of db.prepare('SELECT scope, status, COUNT(*) n, SUM(est_tokens) t FROM b_batches GROUP BY scope, status').all()) {
    const s = (out[r.scope] ??= { pending: 0, written: 0, merged: 0, skipped: 0, total: 0, est_tokens: 0 });
    s[r.status] = r.n;
    s.total += r.n;
    if (r.status === 'pending' || r.status === 'written') s.est_tokens += r.t ?? 0;
  }
  return out;
}

export function batchRow(ctx, id) {
  return bTables(ctx.store).prepare('SELECT * FROM b_batches WHERE id = ?').get(id) ?? null;
}

export function setBatchStatus(ctx, id, status, extra = {}) {
  if (ctx.dryRun) return;
  const db = bTables(ctx.store);
  db.prepare('UPDATE b_batches SET status = ?, merged_at = COALESCE(?, merged_at), run_id = COALESCE(?, run_id) WHERE id = ?').run(status, extra.merged_at ?? null, extra.run_id ?? null, id);
}

// ---------- what the sorter should reuse ----------

function participantIds(items) {
  const ids = new Set();
  for (const d of items) {
    if (d.type === 'person') ids.add(d.id);
    for (const p of d.thread?.participants ?? []) ids.add(p.person_id);
    for (const a of d.meeting?.attendees ?? []) if (a.person_id) ids.add(a.person_id);
    for (const c of d.candidates ?? []) ids.add(c.person_id);
  }
  return ids;
}

function knownFor(ctx, items, identity) {
  const db = bTables(ctx.store);
  const ids = participantIds(items);
  const rows = (type) => db.prepare('SELECT id, title, data FROM b_notes WHERE type = ?').all(type).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  const people = rows('person');
  const companies = rows('company');
  const projects = rows('project');
  const strength = (id) => identity.byId(id)?.strength ?? 0;
  people.sort((a, b) => (ids.has(b.id) ? 1 : 0) - (ids.has(a.id) ? 1 : 0) || strength(b.id) - strength(a.id) || a.title.localeCompare(b.title));
  const titleOf = new Map([...people, ...companies, ...projects].map((r) => [r.id, r.title]));
  const lastActivity = (id) => db.prepare(`SELECT MAX(date) d FROM b_items WHERE target = ? AND section = 'timeline'`).get(id)?.d ?? undefined;
  const open = (type) =>
    rows(type)
      .filter((r) => (r.data.status ?? 'open') === 'open' && (ids.has(r.data.counterpart_id) || !r.data.counterpart_id))
      .sort((a, b) => String(b.data.date ?? '').localeCompare(String(a.data.date ?? '')));
  const counterpart = (d) => titleOf.get(d.counterpart_id) ?? d.counterpart_name ?? undefined;
  const company = (d) => titleOf.get(d.company_id) ?? d.company_name ?? undefined;
  const meetings = rows('meeting')
    .filter((m) => !ids.size || (m.data.people ?? []).some((p) => ids.has(p.id)))
    .sort((a, b) => String(b.data.date ?? '').localeCompare(String(a.data.date ?? '')))
    .slice(0, KNOWN_MEETINGS);
  return {
    // Everyone with a note. Batch participants come first, with the details
    // that tell two people with similar names apart.
    people: people.slice(0, KNOWN_PEOPLE).map((r, i) => {
      const ip = identity.byId(r.id);
      const detailed = i < KNOWN_DETAILED;
      const aliases = detailed ? [...new Set([...(r.data.aliases ?? []), ...(ip?.aliases ?? [])])].filter((a) => a !== r.title).slice(0, 4) : [];
      const co = detailed ? company(r.data) ?? ip?.company ?? undefined : undefined;
      return { name: r.title, ...(ip && !identity.isOwner(ip) ? { person_id: ip.id } : {}), ...(aliases.length ? { aliases } : {}), ...(co ? { company: co } : {}) };
    }),
    companies: companies.map((r) => r.title).sort().slice(0, KNOWN_COMPANIES),
    projects: projects
      .sort((a, b) => a.title.localeCompare(b.title))
      .slice(0, KNOWN_PROJECTS)
      .map((r) => {
        const names = (r.data.people ?? []).map((p) => titleOf.get(p.id) ?? p.name).filter(Boolean).slice(0, 5);
        const last = lastActivity(r.id);
        return { name: r.title, status: r.data.status ?? 'active', ...(company(r.data) ? { company: company(r.data) } : {}), ...(names.length ? { people: names } : {}), ...(last ? { last_activity: last } : {}) };
      }),
    meetings: meetings.map((m) => ({ title: m.data.title ?? m.title, date: m.data.date, ...(titleOf.get(m.data.project_id) ?? m.data.project_name ? { project: titleOf.get(m.data.project_id) ?? m.data.project_name } : {}), people: (m.data.people ?? []).map((p) => titleOf.get(p.id) ?? p.name).slice(0, 6) })),
    commitments: open('commitment')
      .filter((r) => ids.has(r.data.counterpart_id))
      .slice(0, 80)
      .map((r) => ({ text: r.data.text, direction: r.data.direction, counterpart: counterpart(r.data), ...(r.data.due ? { due: r.data.due } : {}) })),
    opportunities: open('opportunity')
      .slice(0, 40)
      .map((r) => ({ title: r.data.title, type: r.data.opportunity_type, ...(counterpart(r.data) ? { counterpart: counterpart(r.data) } : {}) })),
    resolutions: resolutionsFor(ctx),
  };
}

// ---------- packing ----------

function shrink(d, budget) {
  const copy = structuredClone(d);
  const list = copy.type === 'meeting' ? copy.chunks : copy.items;
  let dropped = 0;
  while (list.length > 1 && estimateTokens(copy) > budget) {
    if (copy.type === 'meeting') list.pop();
    else list.shift();
    dropped++;
  }
  if (dropped) {
    if (copy.type === 'meeting') copy.meeting.truncated = true;
    else copy.omitted = (copy.omitted ?? 0) + dropped;
  }
  return copy;
}

export function pack(dossiers, { maxTokens = 40000, maxItems = 20 } = {}) {
  const budget = Math.max(2000, maxTokens - RESERVE);
  const out = [];
  let cur = [];
  let used = 0;
  for (const raw of dossiers) {
    let d = raw;
    let size = estimateTokens(d);
    if (size > budget) {
      d = shrink(d, budget);
      size = estimateTokens(d);
    }
    if (cur.length && (used + size > budget || cur.length >= maxItems)) {
      out.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(d);
    used += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

function makeBatch(ctx, { scope, kind, items, identity, since, until }) {
  const persona = loadPersona(ctx);
  const lang = ctx.lang;
  const stamp = localDate(ctx.now, ctx.tz).replace(/-/g, '');
  const id = `${scope}-${kind.replace('_', '-')}-${stamp}-${shortHash(`${scope}|${kind}|${since ?? ''}|${until ?? ''}|${items.map((d) => d.id).join(',')}`, 8)}`;
  const paths = bPaths(ctx);
  const batch = {
    id,
    kind,
    scope,
    language: lang,
    created_at: isoNow(ctx),
    owner: { person_id: identity.owner.person_id, name: identity.owner.name || ctx.config?.owner?.name || '', ...(ctx.config?.owner?.company ? { company: ctx.config.owner.company } : {}) },
    persona: {
      id: persona.id,
      label: personaText(persona.label, lang),
      focus: personaText(persona.focus, lang),
      person_kinds: persona.personKinds ?? [],
      company_kinds: persona.companyKinds ?? [],
      opportunity_focus: persona.opportunityFocus ?? [],
    },
    instructions: INSTRUCTIONS,
    known: knownFor(ctx, items, identity),
    items,
    est_tokens: 0,
    output: paths.contribution(id),
  };
  batch.est_tokens = estimateTokens(batch);
  const errors = check('batch', batch);
  if (errors.length) throw new Error(`Batch ${id} does not match the batch schema: ${errors[0]}`);
  return batch;
}

function saveBatches(ctx, scope, batches, { since, until } = {}) {
  const db = bTables(ctx.store);
  const paths = bPaths(ctx);
  const out = [];
  for (const b of batches) {
    const path = paths.batch(b.id);
    if (!ctx.dryRun) {
      const exists = db.prepare('SELECT status FROM b_batches WHERE id = ?').get(b.id);
      if (exists) continue;
      writeJson(path, b);
      db.prepare(`INSERT INTO b_batches (id, scope, kind, status, path, output, since, until, est_tokens, items, created_at, seq)
        VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`).run(b.id, scope, b.kind, path, b.output, since ?? null, until ?? null, b.est_tokens, b.items.length, b.created_at, nextSeq(db));
    }
    out.push({ id: b.id, path, kind: b.kind, est_tokens: b.est_tokens, output: b.output });
  }
  return out;
}

// ---------- identity review ----------

const maskHandle = (h) => {
  if (h.startsWith('tel:')) return `tel:…${h.replace(/\D/g, '').slice(-4)}`;
  if (h.startsWith('name:')) return null;
  return h;
};

async function identityItems(ctx, identity, ambiguities) {
  const db = bTables(ctx.store);
  const scrub = await loadScrub();
  const samplesFor = (p) => {
    const hs = p.handles.filter((h) => !h.startsWith('name:')).slice(0, 20);
    if (!hs.length) return [];
    const rows = db.prepare(`SELECT id, source, ts, text, is_from_me FROM records WHERE from_handle IN (${hs.map(() => '?').join(',')}) AND kind IN ('message', 'email') ORDER BY ts_ms DESC LIMIT 12`).all(...hs);
    return rows
      .filter((r) => oneLine(r.text).length >= 12)
      .slice(0, 3)
      .map((r) => ({ ref: r.id, date: localDate(r.ts, ctx.tz), ch: sourceLabel(r.source, ctx.lang), text: scrub(oneLine(r.text).slice(0, 280)) }));
  };
  return ambiguities.map((a) => ({
    id: a.key,
    type: 'identity_review',
    reason: a.reason,
    name: a.name,
    candidates: a.person_ids
      .map((id) => identity.byId(id))
      .filter(Boolean)
      .map((p) => ({
        person_id: p.id,
        name: p.name,
        ...(p.aliases?.length ? { aliases: p.aliases } : {}),
        ...(p.company ? { company: p.company } : {}),
        ...(p.company_hint ? { email_domain: p.company_hint } : {}),
        channels: p.sources.map((s) => sourceLabel(s, ctx.lang)),
        handles: p.handles.map(maskHandle).filter(Boolean).slice(0, 6),
        messages: p.messages,
        ...(p.last_seen ? { last_seen: localDate(p.last_seen, ctx.tz) } : {}),
        samples: samplesFor(p),
      })),
  }));
}

async function planIdentityReview(ctx, scope, identity, maxTokens) {
  const reviewed = new Set(meta(ctx, 'reviewed', []));
  const fresh = (identity.ambiguous ?? []).filter((a) => !reviewed.has(a.key));
  if (!fresh.length) return [];
  const items = await identityItems(ctx, identity, fresh);
  const groups = pack(items, { maxTokens, maxItems: MAX_ITEMS.identity_review });
  const batches = groups.map((g) => makeBatch(ctx, { scope, kind: 'identity_review', items: g, identity }));
  const saved = saveBatches(ctx, scope, batches);
  setMeta(ctx, 'reviewed', [...reviewed, ...fresh.map((a) => a.key)]);
  return saved;
}

// ---------- scopes ----------

function contentBatches(ctx, scope, dossiers, identity, maxTokens, window) {
  const batches = [];
  const add = (kind, list) => {
    for (const g of pack(list, { maxTokens, maxItems: MAX_ITEMS[kind] })) batches.push(makeBatch(ctx, { scope, kind, items: g, identity, ...window }));
  };
  if (scope === 'update') add('update', [...dossiers.meetings, ...dossiers.people, ...dossiers.threads]);
  else {
    add('people', dossiers.people);
    add('meetings', dossiers.meetings);
    add('threads', dossiers.threads);
  }
  return saveBatches(ctx, scope, batches, window);
}

async function planInstall(ctx, maxTokens) {
  const db = bTables(ctx.store);
  const state = meta(ctx, 'install', {});
  if (state.stage === 'content') return [];
  let identity = loadIdentity(ctx, { build: true });
  if (!state.stage) {
    const review = await planIdentityReview(ctx, 'install', identity, maxTokens);
    if (review.length) {
      setMeta(ctx, 'install', { stage: 'identity', at: isoNow(ctx) });
      return review;
    }
  } else if (state.stage === 'identity') {
    const open = db.prepare(`SELECT COUNT(*) n FROM b_batches WHERE scope = 'install' AND kind = 'identity_review' AND status IN ('pending', 'written')`).get().n;
    if (open) return [];
    identity = buildIdentity(ctx);
  }
  const since = daysAgo(INSTALL_DAYS, ctx.now);
  const through = isoNow(ctx);
  const dossiers = await buildDossiers(ctx, { since, identity });
  const saved = contentBatches(ctx, 'install', dossiers, identity, maxTokens, { since, until: null });
  setMeta(ctx, 'install', { stage: 'content', since, at: through });
  if (!meta(ctx, 'update_through')) setMeta(ctx, 'update_through', through);
  if (!ctx.state?.backlog?.oldest_sorted) patchState(ctx, { backlog: { oldest_sorted: since, done: false } });
  return saved;
}

async function planUpdate(ctx, maxTokens) {
  const identity = loadIdentity(ctx, { build: true });
  const install = meta(ctx, 'install', {});
  const through = isoNow(ctx);
  const last = [ctx.state?.lastUpdate?.at, meta(ctx, 'update_through'), install.at].filter(Boolean).sort().pop() ?? daysAgo(INSTALL_DAYS, ctx.now);
  const frontier = ctx.state?.backlog?.oldest_sorted ?? install.since ?? daysAgo(INSTALL_DAYS, ctx.now);
  const dossiers = await buildDossiers(ctx, { changedSince: last, frontier, identity });
  const saved = [...(await planIdentityReview(ctx, 'update', identity, maxTokens)), ...contentBatches(ctx, 'update', dossiers, identity, maxTokens, { since: last, until: through })];
  setMeta(ctx, 'update_through', through);
  return saved;
}

function earliestRecord(ctx) {
  const row = bTables(ctx.store).prepare(`SELECT MIN(ts_ms) ms FROM records WHERE kind != 'contact'`).get();
  return row?.ms ?? null;
}

// Rough count of batches the older history will still take.
export function estimateBacklog(ctx, maxTokens = 40000) {
  const oldest = ctx.state?.backlog?.oldest_sorted;
  const db = bTables(ctx.store);
  const pending = db.prepare(`SELECT COUNT(*) n FROM b_batches WHERE scope = 'backlog' AND status IN ('pending', 'written')`).get().n;
  if (ctx.state?.backlog?.done) return pending;
  if (!oldest) return pending;
  const row = db.prepare(`SELECT SUM(MIN(LENGTH(text), 1500) + 80) c FROM records WHERE kind != 'contact' AND ts_ms < ?`).get(toMs(oldest));
  const tokens = (row?.c ?? 0) / 4;
  return pending + Math.ceil((tokens * 0.6) / Math.max(1, maxTokens - RESERVE));
}

async function planBacklog(ctx, maxTokens) {
  if (ctx.state?.backlog?.done) return [];
  const identity = loadIdentity(ctx, { build: true });
  const install = meta(ctx, 'install', {});
  let until = ctx.state?.backlog?.oldest_sorted ?? install.since ?? daysAgo(INSTALL_DAYS, ctx.now);
  const earliest = earliestRecord(ctx);
  let saved = [];
  let done = false;
  for (let step = 0; step < 240; step++) {
    if (earliest == null || toMs(until) <= earliest) {
      done = true;
      break;
    }
    const since = new Date(toMs(until) - BACKLOG_DAYS * DAY).toISOString();
    const dossiers = await buildDossiers(ctx, { since, until, identity });
    const empty = !dossiers.people.length && !dossiers.threads.length && !dossiers.meetings.length;
    if (!empty) saved = contentBatches(ctx, 'backlog', dossiers, identity, maxTokens, { since, until });
    until = since;
    if (!empty) break;
  }
  if (earliest != null && toMs(until) <= earliest) done = true;
  patchState(ctx, { backlog: { oldest_sorted: until, done } });
  patchState(ctx, { backlog: { remaining_batches: estimateBacklog(ctx, maxTokens) } });
  return saved;
}

export function defaultScope(ctx) {
  const install = meta(ctx, 'install', {});
  if (install.stage !== 'content') return 'install';
  const c = ledgerCounts(ctx).install;
  return c.pending + c.written > 0 ? 'install' : 'update';
}

// Returns up to `count` batches to sort now: pending ones first, then newly
// planned ones for the scope.
export async function planBatches(ctx, { scope, maxTokens = 40000, count = 4 } = {}) {
  scope ??= defaultScope(ctx);
  if (!['install', 'update', 'backlog'].includes(scope)) throw new Error(`Unknown scope "${scope}". Use install, update or backlog.`);
  const release = takeLock(ctx, 'batch');
  try {
    refreshWritten(ctx);
    let pending = pendingRows(ctx, scope);
    const planned = [];
    if (pending.length < count) {
      if (scope === 'install') planned.push(...(await planInstall(ctx, maxTokens)));
      else if (scope === 'update') planned.push(...(await planUpdate(ctx, maxTokens)));
      else planned.push(...(await planBacklog(ctx, maxTokens)));
      pending = ctx.dryRun ? planned.map((p) => ({ ...p, attempts: 0 })) : pendingRows(ctx, scope);
    }
    const handed = pending.slice(0, count);
    if (!ctx.dryRun) {
      const db = bTables(ctx.store);
      for (const r of handed) db.prepare('UPDATE b_batches SET attempts = attempts + 1, handed_at = ? WHERE id = ?').run(isoNow(ctx), r.id);
    }
    return handed.map((r) => ({ id: r.id, path: r.path, kind: r.kind, est_tokens: r.est_tokens, output: r.output }));
  } finally {
    release();
  }
}

export function batchStatus(ctx) {
  refreshWritten(ctx);
  const counts = ledgerCounts(ctx);
  const install = meta(ctx, 'install', {});
  const db = bTables(ctx.store);
  const toMerge = db.prepare(`SELECT id FROM b_batches WHERE status = 'written' ORDER BY seq`).all().map((r) => r.id);
  const installDone = install.stage === 'content' && counts.install.pending + counts.install.written === 0;
  return {
    install: { stage: install.stage ?? null, done: installDone, ...counts.install },
    update: counts.update,
    backlog: { ...counts.backlog, ...(ctx.state?.backlog ?? {}), remaining_batches: estimateBacklog(ctx) },
    to_merge: toMerge,
  };
}

// ---------- CLI ----------

export async function run(args, ctx) {
  const sub = args._[0] ?? 'next';
  if (sub === 'status') {
    const s = batchStatus(ctx);
    ctx.log.out(s, () => {
      const line = (name, c) => `${name}: ${c.merged} merged, ${c.pending} to sort, ${c.written} to merge${c.skipped ? `, ${c.skipped} skipped` : ''}`;
      const back = s.backlog.done ? 'older history: done' : `older history: about ${s.backlog.remaining_batches} batches left${s.backlog.oldest_sorted ? `, sorted back to ${s.backlog.oldest_sorted.slice(0, 10)}` : ''}`;
      return [line('install', s.install), line('update', s.update), line('backlog', s.backlog), back, s.to_merge.length ? `run \`confidant merge --all\` for ${s.to_merge.length} sorted batches` : ''].filter(Boolean).join('\n');
    });
    return 0;
  }
  if (sub !== 'next') {
    ctx.log.error(`Unknown batch command "${sub}". Use \`batch next\` or \`batch status\`.`);
    return 2;
  }
  const scope = args.scope ?? defaultScope(ctx);
  const batches = await planBatches(ctx, { scope, count: Number(args.count ?? 4), maxTokens: Number(args.maxTokens ?? 40000) });
  const status = batchStatus(ctx);
  const done = !batches.length && (scope === 'install' ? status.install.done : scope === 'backlog' ? !!status.backlog.done : true) && !status.to_merge.length;
  ctx.log.out({ scope, batches, done, to_merge: status.to_merge, status }, () => {
    if (!batches.length) {
      if (status.to_merge.length) return `Nothing new to sort. Run \`confidant merge --all\` to write ${status.to_merge.length} sorted batches.`;
      return done ? `Nothing left to sort for ${scope}.` : `Nothing to sort right now for ${scope}.`;
    }
    return batches.map((b) => `${b.id}  ${b.kind}  ~${b.est_tokens} tokens\n  read:  ${b.path}\n  write: ${b.output}`).join('\n');
  });
  return 0;
}
