// `confidant mocs`: rebuilds Home.md, one index note per folder, and the
// Obsidian Bases views (Commitments, Opportunities, Projects, People, plus
// the persona's own). Also refreshes every person, company and project note
// so tiers, last contact and open loops stay current, and picks up the
// person's own edits (a commitment marked done in Obsidian).
//
// A .base file is written only when it is missing or still exactly what we
// wrote last time: once the person customizes a view in Obsidian, it is theirs.
import { existsSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { basename, join } from 'node:path';
import { FOLDERS, folderName } from './lib/folders.mjs';
import { t, fill } from './lib/i18n.mjs';
import { DEFAULT_VAULT_NAME } from './lib/paths.mjs';
import { sha1 } from './lib/hash.mjs';
import { takeLock, readText } from './lib/b-common.mjs';
import { loadPersona, personaText } from './lib/b-persona.mjs';
import { NoteWriter, TYPE_FOLDER } from './notes.mjs';
import { loadIdentity } from './identity.mjs';
import { batchStatus } from './batch.mjs';
import { openCount, reviewNoteName, writeReviewNote, loadReview } from './review.mjs';

const INDEX_LIMIT = 300;
const TYPE_BY_FOLDER = Object.fromEntries(Object.entries(TYPE_FOLDER).map(([type, key]) => [key, type]));

// ---------- Bases ----------

const yq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const yd = (s) => JSON.stringify(String(s));

function baseYaml({ filters, formulas = {}, properties = {}, views }) {
  const out = ['filters:', '  and:', ...filters.map((f) => `    - ${yq(f)}`)];
  if (Object.keys(formulas).length) {
    out.push('formulas:');
    for (const [k, v] of Object.entries(formulas)) out.push(`  ${k}: ${yq(v)}`);
  }
  if (Object.keys(properties).length) {
    out.push('properties:');
    for (const [k, v] of Object.entries(properties)) out.push(`  ${k}:`, `    displayName: ${yd(v)}`);
  }
  out.push('views:');
  for (const v of views) {
    out.push('  - type: table', `    name: ${yd(v.name)}`);
    if (v.filters?.length) {
      out.push('    filters:', `      ${v.or ? 'or' : 'and'}:`, ...v.filters.map((f) => `        - ${yq(f)}`));
    }
    if (v.groupBy) out.push('    groupBy:', `      property: ${v.groupBy}`, '      direction: ASC');
    out.push('    order:', ...v.order.map((c) => `      - ${c}`));
    if (v.sort) out.push('    sort:', `      - property: ${v.sort[0]}`, `        direction: ${v.sort[1]}`);
    if (v.limit) out.push(`    limit: ${v.limit}`);
  }
  return `${out.join('\n')}\n`;
}

const DEFAULT_COLUMNS = {
  person: ['file.name', 'company', 'kind', 'tier', 'last_contact'],
  company: ['file.name', 'kind', 'updated'],
  project: ['file.name', 'status', 'company', 'updated'],
  meeting: ['file.name', 'date', 'company', 'project'],
  decision: ['file.name', 'date', 'project', 'company'],
  commitment: ['file.name', 'direction', 'counterpart', 'due', 'status'],
  idea: ['file.name', 'date', 'status', 'project'],
  opportunity: ['file.name', 'opportunity_type', 'counterpart', 'company', 'status', 'date'],
  knowledge: ['file.name', 'date', 'updated'],
};
const DEFAULT_SORT = { person: ['last_contact', 'DESC'], commitment: ['due', 'ASC'] };

export function baseFiles(lang, persona) {
  const tr = t('notes', lang);
  const b = (k) => tr(`bases.${k}`);
  const commitmentView = (direction) => ({
    name: b(direction),
    filters: [`direction == "${direction}"`, 'status == "open"'],
    order: ['file.name', 'counterpart', 'due', 'formula.days_left', 'company', 'project', 'date'],
    sort: ['due', 'ASC'],
  });
  const files = [
    {
      key: 'commitments',
      file: `${b('commitments')}.base`,
      yaml: baseYaml({
        filters: ['type == "commitment"'],
        formulas: { days_left: 'if(due, (date(due) - today()).days, "")' },
        properties: { counterpart: b('col_with'), due: b('col_due'), 'formula.days_left': b('col_days'), company: b('col_company'), project: b('col_project'), date: b('col_date') },
        views: [commitmentView('i_owe'), commitmentView('owed_to_me'), commitmentView('delegated')],
      }),
    },
    {
      key: 'opportunities',
      file: `${b('opportunities')}.base`,
      yaml: baseYaml({
        filters: ['type == "opportunity"'],
        properties: { opportunity_type: b('col_type'), counterpart: b('col_with'), company: b('col_company'), value: b('col_value'), next_step: b('col_next'), status: b('col_status'), date: b('col_date') },
        views: [
          { name: b('opp_open'), filters: ['status == "open"'], order: ['file.name', 'opportunity_type', 'counterpart', 'company', 'value', 'next_step', 'date'], sort: ['date', 'DESC'] },
          { name: b('opp_by_type'), filters: ['status == "open"'], groupBy: 'opportunity_type', order: ['file.name', 'counterpart', 'company', 'value', 'date'], sort: ['date', 'DESC'] },
          { name: b('opp_closed'), filters: ['status != "open"'], order: ['file.name', 'status', 'opportunity_type', 'counterpart', 'date'], sort: ['date', 'DESC'] },
        ],
      }),
    },
    {
      key: 'projects',
      file: `${b('projects')}.base`,
      yaml: baseYaml({
        filters: ['type == "project"'],
        properties: { status: b('col_status'), company: b('col_company') },
        views: [
          { name: b('proj_active'), filters: ['status == "active"'], order: ['file.name', 'company', 'people', 'updated'], sort: ['updated', 'DESC'] },
          { name: b('proj_waiting'), or: true, filters: ['status == "waiting"', 'status == "stalled"'], order: ['file.name', 'status', 'company', 'updated'], sort: ['updated', 'ASC'] },
          { name: b('proj_all'), groupBy: 'status', order: ['file.name', 'company', 'updated'], sort: ['updated', 'DESC'] },
        ],
      }),
    },
    {
      key: 'people',
      file: `${b('people')}.base`,
      yaml: baseYaml({
        filters: ['type == "person"'],
        properties: { company: b('col_company'), kind: b('col_kind'), tier: b('col_tier'), last_contact: b('col_last'), relationship: b('col_relationship') },
        views: [
          { name: b('people_inner'), filters: ['tier == "inner"'], order: ['file.name', 'company', 'relationship', 'last_contact'], sort: ['last_contact', 'DESC'] },
          { name: b('people_active'), filters: ['tier == "active"'], order: ['file.name', 'company', 'kind', 'relationship', 'last_contact'], sort: ['last_contact', 'DESC'] },
          { name: b('people_all'), order: ['file.name', 'company', 'kind', 'tier', 'last_contact'], sort: ['last_contact', 'DESC'] },
        ],
      }),
    },
  ];
  for (const pb of persona?.bases ?? []) {
    const title = personaText(pb.title, lang);
    const folderKey = FOLDERS.some((f) => f.key === pb.folder) ? pb.folder : FOLDERS.find((f) => f.en === pb.folder || f.es === pb.folder)?.key;
    const type = TYPE_BY_FOLDER[folderKey];
    if (!type || !title) continue;
    const file = lang === 'en' && pb.file ? (pb.file.endsWith('.base') ? pb.file : `${pb.file}.base`) : `${title}.base`;
    if (files.some((f) => f.file === file)) continue;
    files.push({
      key: `persona:${pb.file}`,
      file,
      yaml: baseYaml({ filters: [`type == "${type}"`, ...(pb.filter ? [pb.filter] : [])], views: [{ name: title, order: DEFAULT_COLUMNS[type], ...(DEFAULT_SORT[type] ? { sort: DEFAULT_SORT[type] } : { sort: ['updated', 'DESC'] }) }] }),
    });
  }
  return files;
}

// ---------- index notes and Home ----------

function mdFiles(vault, dir) {
  const out = [];
  const walk = (rel) => {
    let names = [];
    try {
      names = readdirSync(join(vault, rel));
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const r = `${rel}/${name}`;
      // lstat: symlinks are skipped, and a broken entry is ignored.
      const st = (() => { try { return lstatSync(join(vault, r)); } catch { return null; } })();
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(r);
      else if (st.isFile() && name.endsWith('.md')) out.push(r);
    }
  };
  walk(dir);
  return out;
}

const link = (path) => `[[${basename(path, '.md')}]]`;
const byTitle = (a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
const byDateDesc = (a, b) => String(b.data.date ?? '').localeCompare(String(a.data.date ?? '')) || byTitle(a, b);

function indexContent(w, key, rows, other, baseLinks) {
  const tr = w.tr;
  const list = (xs, fmt = (r) => `- ${link(r.path)}`) => xs.slice(0, INDEX_LIMIT).map(fmt).join('\n');
  const more = (xs, baseKey) => (xs.length > INDEX_LIMIT ? `\n${fill(tr('index.more'), { n: xs.length - INDEX_LIMIT, link: baseLinks[baseKey] ?? '' })}` : '');
  const parts = [];
  const group = (heading, xs, fmt, baseKey) => {
    if (xs.length) parts.push(`### ${heading}\n${list(xs, fmt)}${more(xs, baseKey)}`);
  };
  const type = TYPE_BY_FOLDER[key];
  if (type === 'person') {
    const identity = w.identity;
    const tierOf = (r) => identity.byId(r.id)?.tier ?? 'cold';
    const fmt = (r) => `- ${link(r.path)}${r.data.company_name ? `, ${r.data.company_name}` : ''}`;
    for (const tier of ['inner', 'active', 'network']) group(tr(`tier.${tier}`), rows.filter((r) => tierOf(r) === tier).sort(byTitle), fmt, 'people');
    const cold = rows.filter((r) => tierOf(r) === 'cold').sort(byTitle);
    group(tr('tier.cold'), cold, fmt, 'people');
  } else if (type === 'project') {
    for (const st of ['active', 'waiting', 'stalled', 'idea', 'done']) group(tr(`status.${st}`), rows.filter((r) => (r.data.status ?? 'active') === st).sort(byTitle), undefined, 'projects');
  } else if (type === 'commitment') {
    const open = rows.filter((r) => (r.data.status ?? 'open') === 'open');
    const fmt = (r) => `- ${link(r.path)}${r.data.due ? ` (${fill(tr('open_line_due'), { direction: tr(`direction.${r.data.direction}`), due: r.data.due })})` : ''}`;
    for (const d of ['i_owe', 'owed_to_me', 'delegated']) group(tr(`direction.${d}`), open.filter((r) => r.data.direction === d).sort((a, b) => (a.data.due ?? '9999').localeCompare(b.data.due ?? '9999') || byDateDesc(a, b)), fmt, 'commitments');
    group(tr('index.closed'), rows.filter((r) => (r.data.status ?? 'open') !== 'open').sort(byDateDesc), undefined, 'commitments');
  } else if (type === 'opportunity') {
    group(tr('index.open'), rows.filter((r) => (r.data.status ?? 'open') === 'open').sort(byDateDesc), (r) => `- ${link(r.path)} (${tr(`opportunity_type.${r.data.opportunity_type ?? 'other'}`)})`, 'opportunities');
    group(tr('index.closed'), rows.filter((r) => (r.data.status ?? 'open') !== 'open').sort(byDateDesc), (r) => `- ${link(r.path)} (${tr(`status.${r.data.status}`)})`, 'opportunities');
  } else if (type === 'meeting' || type === 'decision' || type === 'idea') {
    const sorted = rows.slice().sort(byDateDesc);
    const months = new Map();
    for (const r of sorted.slice(0, INDEX_LIMIT)) {
      const m = String(r.data.date ?? '').slice(0, 7) || '?';
      if (!months.has(m)) months.set(m, []);
      months.get(m).push(r);
    }
    for (const [m, xs] of months) parts.push(`### ${m}\n${xs.map((r) => `- ${link(r.path)}`).join('\n')}`);
  } else if (rows.length) parts.push(list(rows.slice().sort(byTitle)) + more(rows, null));
  if (other.length) parts.push(`### ${tr('index.other')}\n${other.slice(0, INDEX_LIMIT).map((p) => `- ${link(p)}`).join('\n')}`);
  return parts.join('\n\n') || tr('index.none');
}

function latestBrief(ctx) {
  const dir = folderName('briefs', ctx.lang);
  const files = mdFiles(ctx.vault, dir);
  if (!files.length) return null;
  return files.sort((a, b) => basename(b).localeCompare(basename(a)) || b.localeCompare(a))[0];
}

function homeContent(w, counts, baseLinks) {
  const tr = w.tr;
  const ctx = w.ctx;
  const parts = [];
  const brief = latestBrief(ctx);
  parts.push(brief ? fill(tr('home.latest_brief'), { link: link(brief) }) : tr('home.no_brief'));
  const toReview = openCount(ctx);
  if (toReview) parts.push(fill(tr(toReview === 1 ? 'home.review_one' : 'home.review_many'), { n: toReview, link: `[[${reviewNoteName(ctx.lang)}]]` }));
  const folderLines = FOLDERS.map((f) => {
    const n = counts[f.key] ?? 0;
    return `- ${fill(tr('home.folder_line'), { link: `[[${folderName(f.key, ctx.lang)}]]`, count: n === 1 ? tr('home.notes_one') : fill(tr('home.notes_many'), { n }) })}`;
  });
  parts.push(`## ${tr('home.folders')}\n${folderLines.join('\n')}`);
  const views = [
    ['commitments', 'view_commitments'],
    ['opportunities', 'view_opportunities'],
    ['projects', 'view_projects'],
    ['people', 'view_people'],
  ].map(([k, v]) => `- ${baseLinks[k]}, ${tr(`home.${v}`)}`);
  parts.push(`## ${tr('home.views')}\n${views.join('\n')}`);
  const due = w
    .all('commitment')
    .filter((r) => (r.data.status ?? 'open') === 'open' && r.data.direction === 'i_owe')
    .sort((a, b) => (a.data.due ?? '9999').localeCompare(b.data.due ?? '9999') || byDateDesc(a, b))
    .slice(0, 7)
    .map((r) => {
      const vars = { link: link(r.path), direction: tr('direction.i_owe'), counterpart: w.linkOrName(r.data, 'counterpart'), due: r.data.due };
      return `- ${fill(tr(r.data.due ? 'home.due_line' : 'home.due_line_nodue'), vars)}`;
    });
  parts.push(`## ${tr('home.due')}\n${due.length ? due.join('\n') : tr('home.nothing_due')}`);
  const s = batchStatus(ctx);
  let sorting;
  if (!s.install.done && s.install.stage) sorting = fill(tr('home.install_left'), { n: s.install.pending + s.install.written });
  else if (s.backlog.done || (s.backlog.oldest_sorted && !s.backlog.remaining_batches)) sorting = tr('home.backfill_done');
  else if (s.backlog.oldest_sorted) sorting = fill(tr('home.backfill_left'), { n: s.backlog.remaining_batches ?? 0, date: String(s.backlog.oldest_sorted).slice(0, 10) });
  else sorting = tr('home.backfill_started');
  parts.push(`## ${tr('home.sorting')}\n${sorting}`);
  return parts.join('\n\n');
}

// With `writer`, runs inside the caller's run (and lock) and leaves finish()
// to the caller, so one undo covers both.
export async function buildMocs(ctx, { writer } = {}) {
  const release = writer ? () => {} : takeLock(ctx, 'vault');
  try {
    const identity = writer?.identity ?? loadIdentity(ctx, { build: true });
    const persona = loadPersona(ctx);
    const w = writer ?? new NoteWriter(ctx, { identity, persona, kind: 'mocs' });
    const tr = t('notes', ctx.lang);

    // Pick up the person's edits, then refresh notes that show derived data.
    for (const type of ['commitment', 'opportunity', 'idea']) w.all(type);
    for (const type of ['person', 'company', 'project']) for (const row of w.all(type)) w.touch(row.id);
    for (const id of w.dirty) w.touch(id);
    w.flushNotes();

    // Bases.
    const written = ctx.store.getMeta('b.bases', {}) ?? {};
    const baseLinks = {};
    const bases = baseFiles(ctx.lang, persona);
    const baseOut = [];
    for (const b of bases) {
      baseLinks[b.key] = `[[${b.file}|${b.file.replace(/\.base$/, '')}]]`;
      const current = readText(join(ctx.vault, b.file));
      const mine = current == null || sha1(current) === written[b.file] || current === b.yaml;
      if (!mine) {
        baseOut.push({ file: b.file, kept: true });
        continue;
      }
      if (w.writeFile(b.file, b.yaml)) baseOut.push({ file: b.file, written: true });
      written[b.file] = sha1(b.yaml);
    }
    if (!ctx.dryRun) ctx.store.setMeta('b.bases', written);

    // One index note per folder.
    const counts = {};
    for (const f of FOLDERS) {
      const dir = folderName(f.key, ctx.lang);
      const indexRel = `${dir}/${dir}.md`;
      const type = TYPE_BY_FOLDER[f.key];
      const rows = w.all(type).filter((r) => r.path && existsSync(join(ctx.vault, r.path)));
      const tracked = new Set(rows.map((r) => r.path));
      const files = mdFiles(ctx.vault, dir).filter((p) => p !== indexRel);
      counts[f.key] = files.length;
      const other = files.filter((p) => !tracked.has(p));
      w.writeManaged(indexRel, {
        fm: { type: 'index', confidant_id: `index_${f.key}`, folder: f.key, tags: ['index'] },
        title: dir,
        section: 'index',
        content: indexContent(w, f.key, rows, other, baseLinks),
      });
    }

    // The review queue, once there has ever been something in it.
    if (loadReview(ctx).items.length) writeReviewNote(w);

    // Home. The placeholder init writes is the engine's, not the person's:
    // replace it outright the first time.
    const placeholder = `# ${DEFAULT_VAULT_NAME[ctx.lang] ?? DEFAULT_VAULT_NAME.en}\n\n${t('vault', ctx.lang)('home.body')}\n`;
    if (readText(join(ctx.vault, 'Home.md')) === placeholder) w.deleteFile('Home.md');
    w.writeManaged('Home.md', {
      fm: { type: 'home', confidant_id: 'home', tags: ['home'] },
      title: tr('home.title'),
      section: 'home',
      content: homeContent(w, counts, baseLinks),
    });

    const out = writer ? { run_id: null, created: [], updated: [] } : w.finish({});
    return { ...out, counts, bases: baseOut };
  } finally {
    release();
  }
}

export async function run(args, ctx) {
  const out = await buildMocs(ctx);
  const total = Object.values(out.counts).reduce((a, b) => a + b, 0);
  ctx.log.out(out, `Home, ${Object.keys(out.counts).length} folder indexes and ${out.bases.length} views are current. ${total} notes in the second brain.${out.run_id ? ` (undo: confidant undo --run ${out.run_id})` : ''}`);
  return 0;
}
