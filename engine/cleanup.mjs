// `confidant cleanup --plan [--json]` | `confidant cleanup --apply [--json]`
//
// Plan lists what could be wrong in the second brain:
//   exact_duplicates     two notes for one person (same handles) or one fact
//                        (same fingerprint), or a copied note file
//   probable_duplicates  similar names that also share a company or people
//   broken_links         [[links]] that go nowhere (fixable when the target
//                        is an old name or alias of a note)
//   maybe_done           open commitments a newer record suggests are done
//   stale_projects       active projects with nothing in 30 days
//   sensitive            generated text that privacy.scrubText now catches
// Apply does only the safe things (exact duplicates, links to renamed notes,
// scrubbing generated text, rebuilding indexes) in one backup run, and puts
// the uncertain ones in the review queue. Answers from that queue are applied
// on the next run: a confirmed duplicate is merged, a confirmed done
// commitment is closed, a stale project gets the status the person chose.
import { existsSync, readdirSync, readFileSync, statSync, lstatSync } from 'node:fs';
import { basename, join } from 'node:path';
import { t, fill } from './lib/i18n.mjs';
import { localDate, toMs } from './lib/time.mjs';
import { normalizeName, nameTokens, contentWords, jaccard, oneLine, cleanEmailText } from './lib/b-text.mjs';
import { splitNote, personalText, foreignFrontmatter, addFrontmatterBlocks } from './lib/b-sections.mjs';
import { bTables, takeLock, loadScrub, readText } from './lib/b-common.mjs';
import { NoteWriter, OWNED, companyKey } from './notes.mjs';
import { loadIdentity, recordFixes } from './identity.mjs';
import { loadReview, addReviewItems, writeReviewNote } from './review.mjs';
import { buildMocs } from './mocs.mjs';

const STALE_DAYS = 30;
const TYPES = ['person', 'company', 'project', 'meeting', 'decision', 'commitment', 'idea', 'opportunity', 'knowledge'];
const DONE_WORDS = /\b(sent|done|finished|completed|signed|delivered|received|got it|here it is|attached|shared|thanks for (sending|the))\b|\b(enviad[oa]|envié|listo|hecho|terminad[oa]|firmad[oa]|recibid[oa]|recibí|aquí está|adjunto|gracias por (enviar|mandar))\b/i;
const YES = /^(y|yes|yeah|yep|si|sí|correct|correcto|merge|unir|done|hecho)\b/i;

// ---------- scanning ----------

function mdFiles(vault) {
  const out = [];
  const walk = (rel) => {
    let names = [];
    try {
      names = readdirSync(join(vault, rel || '.'));
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      const r = rel ? `${rel}/${name}` : name;
      // lstat: symlinks are skipped (never followed out of the vault), and a
      // broken entry is ignored instead of stopping the run.
      const st = (() => { try { return lstatSync(join(vault, r)); } catch { return null; } })();
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(r);
      else if (st.isFile() && name.endsWith('.md')) out.push(r);
    }
  };
  walk('');
  return out;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// "Ben Cole" ~ "Benjamin Cole", "Ana Ruiz" ~ "Ana Ruiz Gomez", "Jon Park" ~ "John Park".
function similarNames(a, b) {
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (x.length < 2 || y.length < 2) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.every((w) => long.includes(w))) return true;
  const firstOk = x[0] === y[0] || (x[0].length >= 3 && y[0].length >= 3 && (x[0].startsWith(y[0]) || y[0].startsWith(x[0]))) || levenshtein(x[0], y[0]) <= 1;
  return firstOk && x[x.length - 1] === y[y.length - 1] && normalizeName(a) !== normalizeName(b);
}

const LINK = /(!?)\[\[([^\]|#^]+)([#^][^\]|]*)?(\|[^\]]*)?\]\]/g;

class Cleanup {
  constructor(ctx, w, scrub) {
    this.ctx = ctx;
    this.w = w;
    this.scrub = scrub;
    this.tr = t('notes', ctx.lang);
    this.identity = w.identity;
    this.rows = TYPES.flatMap((type) => w.all(type));
    this.byId = new Map(this.rows.map((r) => [r.id, r]));
  }

  // ---------- plan ----------

  exactDuplicates() {
    const out = [];
    const groups = new Map();
    const push = (key, row) => {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    };
    for (const r of this.rows) {
      const d = r.data;
      if (r.type === 'person') {
        const p = this.identity.byId(r.id);
        if (p && !this.identity.isOwner(p)) push(`person:${p.id}`, r);
      } else if (r.type === 'company') push(`company:${companyKey(r.title)}`, r);
      else if (r.type === 'project') push(`project:${normalizeName(r.title)}`, r);
      else if (r.type === 'meeting') push(`meeting:${d.primary_ref ?? r.id}`, r);
      else if (r.type === 'decision') push(`decision:${d.date}:${normalizeName(d.title ?? r.title)}`, r);
      else if (r.type === 'commitment') push(`commitment:${d.direction}:${d.key ?? d.counterpart_id ?? normalizeName(d.counterpart_name)}:${normalizeName(d.text ?? r.title)}`, r);
      else if (r.type === 'opportunity') push(`opportunity:${d.opportunity_type}:${d.key ?? ''}:${normalizeName(d.title ?? r.title)}`, r);
      else push(`${r.type}:${normalizeName(d.title ?? r.title)}`, r);
    }
    for (const [key, rows] of groups) {
      if (rows.length < 2) continue;
      const identityId = key.startsWith('person:') ? key.slice(7) : null;
      const itemCount = (id) => this.w.db.prepare('SELECT COUNT(*) n FROM b_items WHERE target = ?').get(id).n;
      const sorted = rows.slice().sort((a, b) => (b.id === identityId ? 1 : 0) - (a.id === identityId ? 1 : 0) || itemCount(b.id) - itemCount(a.id) || String(a.created_run).localeCompare(String(b.created_run)) || a.id.localeCompare(b.id));
      out.push({ type: rows[0].type, reason: identityId ? 'same_handles' : 'same_fingerprint', keep: this.ref(sorted[0]), remove: sorted.slice(1).map((r) => this.ref(r)) });
    }
    // The same note file copied inside the vault.
    const byConfidantId = new Map();
    for (const rel of mdFiles(this.ctx.vault)) {
      const m = /^confidant_id:\s*"?([^"\s]+)"?\s*$/m.exec(readFileSync(join(this.ctx.vault, rel), 'utf8').slice(0, 2000));
      if (!m || !this.byId.has(m[1])) continue;
      if (!byConfidantId.has(m[1])) byConfidantId.set(m[1], []);
      byConfidantId.get(m[1]).push(rel);
    }
    for (const [id, files] of byConfidantId) {
      if (files.length < 2) continue;
      const row = this.byId.get(id);
      const main = this.w.locate(row);
      out.push({ type: row.type, reason: 'copied_file', keep: this.ref(row), remove: files.filter((f) => f !== main).map((f) => ({ id, path: f, copy: true })) });
    }
    return out;
  }

  ref(row) {
    return { id: row.id, path: this.w.locate(row) ?? row.path, name: row.title };
  }

  probableDuplicates(exact) {
    const out = [];
    const already = new Set(exact.flatMap((g) => [g.keep.id, ...g.remove.map((r) => r.id)]));
    const people = this.rows.filter((r) => r.type === 'person' && !already.has(r.id));
    const together = new Map();
    const link = (ids) => {
      for (const a of ids) for (const b of ids) if (a !== b) (together.get(a) ?? together.set(a, new Set()).get(a)).add(b);
    };
    for (const r of this.rows) {
      if (r.type === 'meeting' || r.type === 'project') link((r.data.people ?? []).map((p) => p.id).filter(Boolean));
    }
    for (const g of this.identity.groups ?? []) link(g.members ?? []);
    for (let i = 0; i < people.length; i++) {
      for (let j = i + 1; j < people.length; j++) {
        const a = people[i];
        const b = people[j];
        if (!similarNames(a.title, b.title)) continue;
        const sameCompany = a.data.company_id && a.data.company_id === b.data.company_id;
        const shared = [...(together.get(a.id) ?? [])].some((x) => (together.get(b.id) ?? new Set()).has(x));
        if (!sameCompany && !shared) continue;
        out.push({ type: 'person', reason: sameCompany ? 'similar_name_same_company' : 'similar_name_shared_people', a: this.ref(a), b: this.ref(b) });
      }
    }
    const companies = this.rows.filter((r) => r.type === 'company' && !already.has(r.id));
    for (let i = 0; i < companies.length; i++) {
      for (let j = i + 1; j < companies.length; j++) {
        const x = companyKey(companies[i].title);
        const y = companyKey(companies[j].title);
        if (x === y || Math.min(x.length, y.length) < 4) continue;
        if (x.startsWith(`${y} `) || y.startsWith(`${x} `) || levenshtein(x, y) <= 1) out.push({ type: 'company', reason: 'similar_name', a: this.ref(companies[i]), b: this.ref(companies[j]) });
      }
    }
    const projects = this.rows.filter((r) => r.type === 'project' && !already.has(r.id));
    for (let i = 0; i < projects.length; i++) {
      for (let j = i + 1; j < projects.length; j++) {
        const a = projects[i];
        const b = projects[j];
        if (jaccard(a.title, b.title) >= 0.6 && (a.data.company_id ?? '') === (b.data.company_id ?? '')) out.push({ type: 'project', reason: 'similar_name_same_company', a: this.ref(a), b: this.ref(b) });
      }
    }
    return out;
  }

  // Every file basename, plus old names and aliases of our notes.
  linkTargets() {
    const files = new Set();
    const walk = (rel) => {
      for (const name of readdirSync(join(this.ctx.vault, rel || '.'))) {
        if (name.startsWith('.')) continue;
        const r = rel ? `${rel}/${name}` : name;
        const st = (() => { try { return lstatSync(join(this.ctx.vault, r)); } catch { return null; } })();
        if (!st || st.isSymbolicLink()) continue;
        if (st.isDirectory()) walk(r);
        else {
          files.add(name.toLowerCase());
          if (name.endsWith('.md')) files.add(basename(name, '.md').toLowerCase());
        }
      }
    };
    walk('');
    const renamed = new Map();
    for (const r of this.rows) {
      const current = basename(this.w.locate(r) ?? r.path ?? '', '.md');
      for (const n of [r.title, ...(r.data.aliases ?? []), ...(r.data.former_paths ?? []).map((p) => basename(p, '.md'))]) {
        const k = normalizeName(n);
        if (k && normalizeName(current) !== k && !renamed.has(k)) renamed.set(k, current);
      }
    }
    return { files, renamed };
  }

  brokenLinks() {
    const { files, renamed } = this.linkTargets();
    const out = [];
    for (const rel of mdFiles(this.ctx.vault)) {
      const text = readFileSync(join(this.ctx.vault, rel), 'utf8');
      for (const m of text.matchAll(LINK)) {
        const target = m[2].trim();
        const base = target.split('/').pop();
        if (files.has(base.toLowerCase()) || files.has(`${base.toLowerCase()}.md`)) continue;
        const fix = renamed.get(normalizeName(base));
        out.push({ file: rel, link: m[0], target, ...(fix && !files.has(base.toLowerCase()) ? { fix } : {}) });
      }
    }
    return out;
  }

  maybeDone() {
    const db = this.w.db;
    const out = [];
    for (const r of this.rows) {
      if (r.type !== 'commitment' || (r.data.status ?? 'open') !== 'open') continue;
      const person = this.identity.byId(r.data.counterpart_id);
      const handles = (person?.handles ?? []).filter((h) => !h.startsWith('name:'));
      if (!handles.length) continue;
      const words = contentWords(r.data.text ?? r.title);
      const since = toMs(`${r.data.status_date ?? r.data.date ?? '1970-01-01'}T23:59:59Z`);
      // What they sent, and what the owner sent to them.
      const rows = db
        .prepare(`SELECT id, ts, kind, text FROM records WHERE ts_ms > ? AND kind IN ('message', 'email') AND (from_handle IN (${handles.map(() => '?').join(',')}) OR (is_from_me = 1 AND (${handles.map(() => 'to_json LIKE ?').join(' OR ')}))) ORDER BY ts_ms ASC LIMIT 400`)
        .all(since, ...handles, ...handles.map((h) => `%"${h}"%`));
      const evidence = [];
      for (const rec of rows) {
        const text = rec.kind === 'email' ? cleanEmailText(rec.text) : rec.text ?? '';
        if (!DONE_WORDS.test(text)) continue;
        const shared = [...contentWords(text)].filter((w) => words.has(w) && w.length >= 4).length;
        if (shared >= Math.min(2, words.size)) evidence.push({ ref: rec.id, date: localDate(rec.ts, this.ctx.tz) });
      }
      if (evidence.length) out.push({ commitment: this.ref(r), text: r.data.text ?? r.title, evidence: evidence.slice(0, 3) });
    }
    return out;
  }

  staleProjects() {
    const out = [];
    const cutoff = localDate(new Date(this.ctx.now.getTime() - STALE_DAYS * 86400000), this.ctx.tz);
    for (const r of this.rows) {
      if (r.type !== 'project' || (r.data.status ?? 'active') !== 'active') continue;
      const dates = [
        this.w.db.prepare(`SELECT MAX(date) d FROM b_items WHERE target = ? AND section = 'timeline'`).get(r.id)?.d,
        ...this.rows.filter((x) => x.data.project_id === r.id).map((x) => x.data.status_date ?? x.data.date),
        ...Object.values(r.data._dates ?? {}),
      ].filter(Boolean);
      const last = dates.sort().pop() ?? null;
      if (!last || last < cutoff) out.push({ project: this.ref(r), last_activity: last });
    }
    return out;
  }

  sensitive() {
    const out = [];
    const same = (s) => typeof s !== 'string' || this.scrub(s) === s;
    for (const it of this.w.db.prepare(`SELECT fp, target, text FROM b_items WHERE text IS NOT NULL`).all()) {
      if (!same(it.text)) out.push({ where: 'generated', target: it.target, path: this.byId.get(it.target)?.path ?? null, item: it.fp });
    }
    for (const r of this.rows) {
      const bad = Object.entries(r.data).filter(([k, v]) => !k.startsWith('_') && typeof v === 'string' && !same(v)).map(([k]) => k);
      if (bad.length) out.push({ where: 'generated', target: r.id, path: r.path, fields: bad });
      const rel = this.w.locate(r);
      const text = rel ? readText(join(this.ctx.vault, rel)) : null;
      if (text && !same(personalText(splitNote(text).body))) out.push({ where: 'person', target: r.id, path: rel });
    }
    return out;
  }

  plan() {
    const exact = this.exactDuplicates();
    return {
      exact_duplicates: exact,
      probable_duplicates: this.probableDuplicates(exact),
      broken_links: this.brokenLinks(),
      maybe_done: this.maybeDone(),
      stale_projects: this.staleProjects(),
      sensitive: this.sensitive(),
    };
  }

  // ---------- apply ----------

  // Fold `dup` into `keep`: timeline, fields, references, the person's text,
  // and every [[link]] in the vault.
  mergeNotes(keep, dup) {
    const w = this.w;
    const keepItems = w.db.prepare('SELECT section, date, text FROM b_items WHERE target = ?').all(keep.id);
    const seen = new Set(keepItems.map((i) => `${i.section}|${i.date}|${normalizeName(i.text)}`));
    for (const it of w.db.prepare('SELECT fp, section, date, text FROM b_items WHERE target = ?').all(dup.id)) {
      const k = `${it.section}|${it.date}|${normalizeName(it.text)}`;
      w.updateItem(it.fp, { target: keep.id, ...(seen.has(k) && it.section === 'timeline' ? { section: 'dup' } : {}) });
      seen.add(k);
    }
    for (const [k, v] of Object.entries(dup.data)) {
      if (k.startsWith('_') || v == null || v === '') continue;
      if (Array.isArray(v)) {
        const merged = [...(keep.data[k] ?? [])];
        for (const x of v) if (!merged.some((y) => JSON.stringify(y) === JSON.stringify(x))) merged.push(x);
        keep.data[k] = merged;
      } else if (keep.data[k] == null || keep.data[k] === '') keep.data[k] = v;
    }
    keep.data.aliases = [...new Set([...(keep.data.aliases ?? []), dup.title])].filter((a) => normalizeName(a) !== normalizeName(keep.title));
    if (dup.type === 'commitment' || dup.type === 'opportunity') {
      if ((dup.data.status_date ?? '') > (keep.data.status_date ?? '')) Object.assign(keep.data, { status: dup.data.status, status_date: dup.data.status_date });
    }
    w.markDirty(keep);
    for (const r of this.rows) {
      if (r.id === dup.id || r.id === keep.id) continue;
      let changed = false;
      for (const key of ['company', 'project', 'counterpart']) {
        if (r.data[`${key}_id`] === dup.id) {
          r.data[`${key}_id`] = keep.id;
          r.data[`${key}_name`] = keep.title;
          changed = true;
        }
      }
      for (const key of ['people', 'decided_by']) {
        if (!(r.data[key] ?? []).some((p) => p.id === dup.id)) continue;
        const list = [];
        for (const p of r.data[key]) {
          const next = p.id === dup.id ? { id: keep.id, name: keep.title } : p;
          if (!list.some((x) => x.id && x.id === next.id)) list.push(next);
        }
        r.data[key] = list;
        changed = true;
      }
      if (changed) w.markDirty(r);
    }
    const keepRel = w.locate(keep);
    const dupRel = w.locate(dup);
    this.foldFile(keep, keepRel, dupRel, basename(dupRel, '.md'));
    w.removeNote(dup);
    this.rewriteLinks(basename(dupRel, '.md'), basename(keepRel, '.md'));
    w.touch(keep.id);
  }

  // The person's own words and frontmatter keys from `fromRel` move into `toRel`.
  foldFile(row, toRel, fromRel, label) {
    const w = this.w;
    const from = readText(join(this.ctx.vault, fromRel));
    const to = readText(join(this.ctx.vault, toRel));
    if (from == null || to == null) return;
    const { fmText, body } = splitNote(from);
    const headings = Object.values(this.tr('headings'));
    const mine = personalText(body, headings);
    let next = addFrontmatterBlocks(to, foreignFrontmatter(fmText, OWNED[row.type] ?? []));
    if (mine) next = `${next.replace(/\s*$/, '')}\n\n## ${fill(this.tr('merged_from'), { name: label })}\n${mine}\n`;
    w.writeFile(toRel, next);
  }

  // keepDisplay: a fixed link still reads as the person wrote it.
  rewriteLinks(fromBase, toBase, only, { keepDisplay = false } = {}) {
    const w = this.w;
    const want = normalizeName(fromBase);
    for (const rel of only ?? mdFiles(this.ctx.vault)) {
      const abs = join(this.ctx.vault, rel);
      const text = readText(abs);
      if (text == null) continue;
      const next = text.replace(LINK, (m, bang, target, sub = '', shown) => {
        if (normalizeName(target.split('/').pop()) !== want) return m;
        const display = shown ?? (keepDisplay && target !== toBase ? `|${target}` : '');
        return `${bang}[[${toBase}${sub}${display === `|${toBase}` ? '' : display}]]`;
      });
      if (next !== text) w.writeFile(rel, next);
    }
  }

  applyResolved(review) {
    const done = { merged: 0, closed: 0, statuses: 0 };
    for (const item of review.items) {
      if (item.status !== 'resolved' || item.origin !== 'cleanup' || item.applied || !item.data) continue;
      const answer = oneLine(item.answer);
      const first = item.options?.[0];
      const yes = YES.test(answer) || (first && normalizeName(answer) === normalizeName(first));
      if (item.kind === 'duplicate' && yes) {
        const count = (id) => this.w.db.prepare('SELECT COUNT(*) n FROM b_items WHERE target = ?').get(id).n;
        let a = this.w.note(item.data.a);
        let b = this.w.note(item.data.b);
        if (a && b && count(b.id) > count(a.id)) [a, b] = [b, a];
        if (a && b) {
          if (a.type === 'person' && this.identity.byId(a.id) && this.identity.byId(b.id) && this.identity.byId(a.id) !== this.identity.byId(b.id)) {
            this.w.preserve('.confidant/identity.json');
            this.w.preserve('.confidant/identity-fixes.json');
            this.identity = this.w.identity = recordFixes(this.ctx, this.identity, [{ action: 'merge', person_ids: [a.id, b.id] }], { runId: this.w.runId }).identity;
          }
          this.mergeNotes(a, b);
          done.merged++;
        }
      } else if (item.kind === 'maybe_done' && yes) {
        const c = this.w.note(item.data.commitment);
        if (c && (c.data.status ?? 'open') === 'open') {
          Object.assign(c.data, { status: 'done', status_date: this.w.today });
          c.data._dates = { ...(c.data._dates ?? {}), status: this.w.today };
          this.w.markDirty(c);
          for (const k of ['counterpart_id', 'company_id', 'project_id']) this.w.touch(c.data[k]);
          done.closed++;
        }
      } else if (item.kind === 'stale_project') {
        const p = this.w.note(item.data.project);
        const pick = { [normalizeName(this.tr('review.waiting'))]: 'waiting', [normalizeName(this.tr('review.stalled'))]: 'stalled', [normalizeName(this.tr('review.done'))]: 'done', waiting: 'waiting', stalled: 'stalled', done: 'done' }[normalizeName(answer)];
        if (p && pick) {
          Object.assign(p.data, { status: pick });
          p.data._dates = { ...(p.data._dates ?? {}), status: this.w.today };
          this.w.markDirty(p);
          done.statuses++;
        }
      }
      item.applied = true;
      review.changed = true;
    }
    return done;
  }

  apply(plan) {
    const w = this.w;
    const applied = { scrubbed: 0, duplicates_merged: 0, copies_folded: 0, links_fixed: 0, reviewed: 0 };
    // 1. Scrub generated text; notes re-render from the scrubbed rows.
    for (const s of plan.sensitive) {
      if (s.where !== 'generated') continue;
      if (s.item) {
        const it = w.db.prepare('SELECT text FROM b_items WHERE fp = ?').get(s.item);
        w.updateItem(s.item, { text: this.scrub(it.text) });
      } else {
        const row = w.note(s.target);
        for (const f of s.fields ?? []) row.data[f] = this.scrub(row.data[f]);
        w.markDirty(row);
      }
      applied.scrubbed++;
    }
    // 2. Exact duplicates.
    for (const g of plan.exact_duplicates) {
      const keep = w.note(g.keep.id);
      for (const r of g.remove) {
        if (r.copy) {
          this.foldFile(keep, w.locate(keep), r.path, basename(r.path, '.md'));
          w.deleteFile(r.path);
          this.rewriteLinks(basename(r.path, '.md'), basename(w.locate(keep), '.md'));
          applied.copies_folded++;
        } else {
          const dup = w.note(r.id);
          if (keep && dup) {
            this.mergeNotes(keep, dup);
            applied.duplicates_merged++;
          }
        }
      }
    }
    // 3. Answers from the review queue.
    const review = loadReview(this.ctx);
    Object.assign(applied, this.applyResolved(review));
    if (review.changed) w.writeFile('.confidant/review.json', `${JSON.stringify({ items: review.items }, null, 2)}\n`);
    // 4. Links to notes that were renamed.
    for (const l of this.brokenLinks()) {
      if (!l.fix) continue;
      const before = readText(join(this.ctx.vault, l.file));
      this.rewriteLinks(l.target.split('/').pop(), l.fix, [l.file], { keepDisplay: true });
      if (readText(join(this.ctx.vault, l.file)) !== before) applied.links_fixed++;
    }
    // 5. The uncertain ones go to the person.
    const tr = this.tr;
    const items = [
      ...plan.probable_duplicates.map((p) => ({
        kind: 'duplicate',
        question: p.type === 'person' ? fill(tr('review.dup_person'), { a: p.a.name, b: p.b.name }) : fill(tr('review.dup_note'), { a: p.a.name, b: p.b.name, kind: tr(`bases.${p.type === 'company' ? 'col_company' : 'col_project'}`).toLowerCase() }),
        options: [tr('review.yes_merge'), tr('review.no_keep')],
        subject: p.a.name,
        source_refs: [`note:${p.a.id}`, `note:${p.b.id}`],
        data: { a: p.a.id, b: p.b.id },
      })),
      ...plan.maybe_done.map((m) => ({ kind: 'maybe_done', question: fill(tr('review.maybe_done'), { text: m.text }), options: [tr('review.yes_done'), tr('review.no_open')], subject: m.commitment.name, source_refs: m.evidence.map((e) => e.ref), data: { commitment: m.commitment.id } })),
      ...plan.stale_projects.map((s) => ({ kind: 'stale_project', question: fill(tr('review.stale_project'), { name: s.project.name }), options: [tr('review.yes_active'), tr('review.waiting'), tr('review.stalled'), tr('review.done')], subject: s.project.name, source_refs: [`note:${s.project.id}`], data: { project: s.project.id } })),
    ];
    applied.reviewed = addReviewItems(w, items, { origin: 'cleanup' });
    if (loadReview(this.ctx).items.length) writeReviewNote(w);
    return applied;
  }
}

async function open(ctx, { scrub } = {}) {
  const identity = loadIdentity(ctx, { build: true });
  const w = new NoteWriter(ctx, { identity, kind: 'cleanup' });
  const fn = scrub ?? (await loadScrub(ctx));
  return new Cleanup(ctx, w, fn);
}

export async function planCleanup(ctx, opts = {}) {
  const c = await open(ctx, opts);
  const plan = c.plan();
  return { ...plan, summary: summarize(plan) };
}

export async function applyCleanup(ctx, opts = {}) {
  const release = takeLock(ctx, 'vault');
  try {
    const c = await open(ctx, opts);
    const plan = c.plan();
    const applied = c.apply(plan);
    c.w.flushNotes();
    await buildMocs(ctx, { writer: c.w });
    const out = c.w.finish({});
    return { run_id: out.run_id, applied, plan: summarize(plan), created: out.created, updated: out.updated };
  } finally {
    release();
  }
}

function summarize(plan) {
  return {
    exact_duplicates: plan.exact_duplicates.reduce((n, g) => n + g.remove.length, 0),
    probable_duplicates: plan.probable_duplicates.length,
    broken_links: plan.broken_links.length,
    fixable_links: plan.broken_links.filter((l) => l.fix).length,
    maybe_done: plan.maybe_done.length,
    stale_projects: plan.stale_projects.length,
    sensitive: plan.sensitive.length,
  };
}

export async function run(args, ctx) {
  if (args.apply) {
    const out = await applyCleanup(ctx);
    const a = out.applied;
    ctx.log.out(out, `Cleaned up: ${a.duplicates_merged + a.copies_folded} duplicate notes merged, ${a.links_fixed} links fixed, ${a.scrubbed} private details removed, ${a.reviewed} questions added to review.${out.run_id ? ` (undo: confidant undo --run ${out.run_id})` : ''}`);
    return 0;
  }
  const plan = await planCleanup(ctx);
  const s = plan.summary;
  ctx.log.out(plan, `Found ${s.exact_duplicates} duplicate notes, ${s.probable_duplicates} possible duplicates, ${s.broken_links} broken links (${s.fixable_links} fixable), ${s.maybe_done} commitments that may be done, ${s.stale_projects} quiet projects and ${s.sensitive} private details. Run \`confidant cleanup --apply\` to fix the safe ones.`);
  return 0;
}
