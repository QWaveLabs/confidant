// `confidant merge --batch <id>` | `confidant merge --all`
//
// Takes the contribution Codex wrote for one batch and folds it into notes:
//   1. validate it against schemas/contribution.schema.json
//   2. keep only source_refs that are records in that batch; an item with no
//      real source left is dropped, so nothing unsourced reaches a note
//   3. scrub every string (privacy.scrubText) and remove dashes
//   4. resolve names to identity people and existing notes
//   5. fingerprint every item; what is already in the ledger is skipped
//   6. write notes under a pre-image backup (undo), holding the vault lock
import { readJson } from './lib/files.mjs';
import { assertValid } from './lib/schema.mjs';
import { fingerprint, shortHash } from './lib/hash.mjs';
import { nameHandle } from './lib/handles.mjs';
import { normalizeName, nameTokens, oneLine, cleanDashes, jaccard, contentWords } from './lib/b-text.mjs';
import { bPaths, bTables, takeLock, loadScrub, patchState } from './lib/b-common.mjs';
import { NoteWriter, companyKey } from './notes.mjs';
import { loadIdentity, recordFixes } from './identity.mjs';
import { batchRow, setBatchStatus, estimateBacklog } from './batch.mjs';

// Values that are ids, dates or enums: never rewritten.
const RAW_KEYS = new Set(['source_refs', 'person_ids', 'person_id', 'date', 'due', 'direction', 'status', 'type', 'action', 'batch_id']);
const SELF = new Set(['me', 'i', 'myself', 'yo', 'mi', 'owner']);

function cleanContribution(c, scrub) {
  const walk = (v, key) => {
    if (typeof v === 'string') return RAW_KEYS.has(key) ? v.trim() : cleanDashes(scrub(v)).trim();
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(c, null);
}

function batchRefs(batch) {
  const refs = new Set();
  const meetings = new Set();
  const people = new Set();
  let latest = '';
  for (const d of batch.items ?? []) {
    for (const it of d.items ?? []) {
      if (it.ref) refs.add(it.ref);
      if (it.date > latest) latest = it.date;
    }
    for (const ch of d.chunks ?? []) if (ch.ref) refs.add(ch.ref);
    if (d.meeting?.ref) {
      refs.add(d.meeting.ref);
      meetings.add(d.meeting.ref);
      if (d.meeting.date > latest) latest = d.meeting.date;
    }
    for (const c of d.candidates ?? []) {
      people.add(c.person_id);
      for (const s of c.samples ?? []) refs.add(s.ref);
    }
    if (d.type === 'person') people.add(d.id);
    for (const p of d.thread?.participants ?? []) people.add(p.person_id);
    for (const a of d.meeting?.attendees ?? []) if (a.person_id) people.add(a.person_id);
  }
  return { refs, meetings, people, latest: latest || null };
}

const maxDate = (xs) => xs.map((x) => x.date).filter(Boolean).sort().pop() ?? null;

class Merger {
  constructor(ctx, w, batch) {
    this.ctx = ctx;
    this.w = w;
    this.identity = w.identity;
    this.batch = batch;
    const { refs, meetings, people, latest } = batchRefs(batch);
    this.refs = refs;
    this.meetingRefs = meetings;
    this.participants = people;
    this.batchDate = latest ?? w.today;
    this.excluded = new Set((ctx.config?.exclusions?.people ?? []).map(normalizeName).filter(Boolean));
    const owner = this.identity.owner?.name || ctx.config?.owner?.name || '';
    this.ownerName = owner;
    this.ownerNorm = normalizeName(owner);
    this.ownerFirst = nameTokens(owner)[0] ?? null;
    this.report = { added: 0, duplicates: 0, bad_refs: 0, dropped: [], skipped_people: [], identity_fixes: 0 };
  }

  validRefs(refs) {
    const ok = (refs ?? []).filter((r) => this.refs.has(r));
    this.report.bad_refs += (refs ?? []).length - ok.length;
    return [...new Set(ok)];
  }

  drop(kind, label) {
    this.report.dropped.push(`${kind}: ${oneLine(label).slice(0, 80)}`);
  }

  isOwnerName(name) {
    const n = normalizeName(name);
    if (!n) return false;
    if (SELF.has(n) || n === this.ownerNorm) return true;
    if (this.ownerFirst && n === this.ownerFirst) return true;
    return this.identity.byName(name).some((p) => this.identity.isOwner(p));
  }

  // -> { id, person, name, fresh } | { owner: true } | null (unknown or too vague)
  resolvePerson({ person_id, name }) {
    const id = this.identity;
    const usable = (p) => p && !id.isOwner(p) && p.kind !== 'system' && p.kind !== 'excluded';
    if (person_id) {
      const p = id.byId(person_id);
      if (p && id.isOwner(p)) return { owner: true };
      if (p && !usable(p)) return null;
      if (p) return { id: p.id, person: p, name: oneLine(name) || p.name };
    }
    const n = oneLine(name);
    if (!n) return null;
    if (this.isOwnerName(n)) return { owner: true };
    if (this.excluded.has(normalizeName(n))) return null;
    const notes = this.w.findByName('person', n);
    if (notes.length) {
      const inBatch = notes.filter((r) => this.participants.has(r.id));
      const row = inBatch.length === 1 ? inBatch[0] : notes[0];
      const p = id.byId(row.id);
      if (p && !usable(p)) return null;
      return { id: row.id, person: p, name: n };
    }
    const hits = id.byName(n).filter(usable);
    if (hits.length) {
      const inBatch = hits.filter((p) => this.participants.has(p.id));
      const pick = inBatch.length === 1 ? inBatch[0] : hits.length === 1 ? hits[0] : null;
      if (pick) return { id: pick.id, person: pick, name: n };
    }
    const toks = nameTokens(n);
    if (toks.length < 2) {
      const cands = [...this.participants].map((pid) => id.byId(pid)).filter((p) => usable(p) && nameTokens(p.name)[0] === toks[0]);
      if (cands.length === 1) return { id: cands[0].id, person: cands[0], name: cands[0].name };
      return null;
    }
    const fresh = `p_${shortHash(nameHandle(n), 10)}`;
    return { id: id.byId(fresh)?.id ?? fresh, person: id.byId(fresh), name: n, fresh: !id.byId(fresh) };
  }

  // Contacts and confirmed names win; otherwise the fuller name.
  personTitle(res) {
    const p = res.person;
    if (!p) return res.name;
    if (p.name_source === 'contacts' || p.name_source === 'fix') return p.name;
    if (p.name_source === 'handle') return res.name || p.name;
    return nameTokens(res.name).length > nameTokens(p.name).length ? res.name : p.name;
  }

  ensurePerson(res, fields = {}, date) {
    if (!res || res.owner) return null;
    const w = this.w;
    let row = w.note(res.id);
    if (!row) row = w.create('person', res.id, this.personTitle(res), { kind: fields.kind ? fields.kind.toLowerCase() : undefined, company_name: fields.company ?? res.person?.company ?? undefined });
    const set = {};
    if (fields.kind) set.kind = oneLine(fields.kind).toLowerCase();
    if (fields.role) set.role = oneLine(fields.role);
    if (fields.relationship) set.relationship = oneLine(fields.relationship);
    if (fields.company) {
      const co = this.ensureCompany(fields.company, null, date);
      if (co) Object.assign(set, { company_id: co.id, company_name: co.title });
    }
    w.setFields(row, set, date);
    if (fields.topics?.length) w.unionField(row, 'topics', fields.topics.map(oneLine), 10);
    if (date && (!row.data.last_date || date > row.data.last_date)) {
      row.data.last_date = date;
      w.markDirty(row);
    }
    if (row.data.company_id) w.touch(row.data.company_id);
    return row;
  }

  ensureCompany(name, fields, date, { create = true } = {}) {
    const n = oneLine(name);
    if (!n || this.isOwnerName(n)) return null;
    const w = this.w;
    let row = w.findByName('company', n)[0] ?? null;
    if (!row && !create) return null;
    if (!row) row = w.create('company', `co_${shortHash(companyKey(n), 10)}`, n, { name: n });
    else if (normalizeName(n) !== normalizeName(row.title)) w.unionField(row, 'aliases', [n], 8);
    if (fields) w.setFields(row, { kind: fields.kind ? oneLine(fields.kind).toLowerCase() : undefined, summary: fields.summary }, date);
    return row;
  }

  ensureProject(name, fields, date, { create = true } = {}) {
    const n = oneLine(name);
    if (!n) return null;
    const w = this.w;
    let row = w.findByName('project', n)[0] ?? null;
    if (!row && !create) return null;
    if (!row) row = w.create('project', `pr_${shortHash(normalizeName(n), 10)}`, n, { name: n });
    if (fields) w.setFields(row, fields, date);
    return row;
  }

  // Link fields for company/project/counterpart: { <key>_id, <key>_name }.
  linkFields(key, row, name) {
    return row ? { [`${key}_id`]: row.id, [`${key}_name`]: row.title } : name ? { [`${key}_name`]: oneLine(name) } : {};
  }

  personRef(name) {
    const res = this.resolvePerson({ name });
    if (res?.owner) return { id: null, name: this.ownerName || oneLine(name) };
    const row = res && !res.owner ? this.w.note(res.id) : null;
    return { id: row?.id ?? null, name: row?.title ?? oneLine(name) };
  }

  addBullets(targetId, bullets, section = 'timeline') {
    const w = this.w;
    for (const b of bullets ?? []) {
      const refs = this.validRefs(b.source_refs);
      if (!refs.length || !oneLine(b.text)) {
        this.drop('bullet', b.text);
        continue;
      }
      const text = oneLine(b.text);
      const fp = fingerprint('bullet', targetId, section, b.date, text);
      if (w.hasItem(fp)) {
        this.report.duplicates++;
        continue;
      }
      const words = contentWords(text);
      const near = w.itemRows(targetId, section).find((it) => it.date === b.date && JSON.parse(it.refs).some((r) => refs.includes(r)) && jaccard(words, contentWords(it.text)) >= 0.6);
      if (near) {
        w.addItem({ fp, target: targetId, section: 'dup', date: b.date, refs });
        this.report.duplicates++;
        continue;
      }
      w.addItem({ fp, target: targetId, section, date: b.date, text, refs });
      this.report.added++;
    }
  }

  mention(row, date, refs) {
    const list = row.data.mentions ?? [];
    const key = JSON.stringify([date, [...refs].sort()]);
    if (!list.some((m) => JSON.stringify([m.date, [...m.refs].sort()]) === key)) {
      row.data.mentions = [...list, { date, refs: [...refs].sort() }];
      this.w.markDirty(row);
    }
    this.w.unionField(row, 'refs', refs, 200);
  }

  // Close match among existing notes of a type, by content words.
  similar(type, text, filter, threshold) {
    const words = contentWords(text);
    let best = null;
    for (const row of this.w.all(type)) {
      if (filter && !filter(row)) continue;
      const score = jaccard(words, contentWords(row.data.text ?? row.data.title ?? row.title));
      if (score < threshold) continue;
      const open = (row.data.status ?? 'open') === 'open' ? 1 : 0;
      if (!best || open > best.open || (open === best.open && score > best.score)) best = { row, score, open };
    }
    return best?.row ?? null;
  }

  aliasTarget(fp) {
    const r = bTables(this.ctx.store).prepare(`SELECT target FROM b_items WHERE fp = ? AND section = 'alias'`).get(fp);
    return r ? this.w.note(r.target) : null;
  }

  // ---------- sections of a contribution ----------

  identityFixes(fixes) {
    if (!fixes?.length) return;
    const w = this.w;
    w.preserve('.confidant/identity.json');
    w.preserve('.confidant/identity-fixes.json');
    const { identity, applied } = recordFixes(this.ctx, this.identity, fixes, { batchId: this.batch.id, runId: w.runId });
    this.identity = w.identity = identity;
    this.report.identity_fixes = applied;
    for (const f of fixes) {
      if (f.action !== 'rename' && !(f.action === 'merge' && f.name)) continue;
      const row = w.note(identity.byId(f.person_ids?.[0])?.id);
      if (!row || !f.name || normalizeName(row.title) === normalizeName(f.name)) continue;
      w.unionField(row, 'aliases', [row.title], 8);
      row.title = oneLine(f.name);
      row.norm = normalizeName(row.title);
      w.addToIndex('person', row.id, [row.title]);
      w.markDirty(row);
    }
  }

  companies(list) {
    for (const co of list ?? []) {
      const bullets = co.bullets ?? [];
      const row = this.ensureCompany(co.name, { kind: co.kind, summary: co.summary }, maxDate(bullets) ?? this.batchDate);
      if (row) this.addBullets(row.id, bullets);
    }
  }

  // After people exist: a company's listed people work there, unless their
  // note already names another company.
  companyPeople(list) {
    for (const co of list ?? []) {
      const row = this.w.findByName('company', co.name)[0];
      if (!row) continue;
      const date = maxDate(co.bullets ?? []) ?? this.batchDate;
      for (const name of co.people ?? []) {
        const res = this.resolvePerson({ name });
        const person = res && !res.owner ? this.w.note(res.id) : null;
        if (person && !person.data.company_id) this.w.setFields(person, { company_id: row.id, company_name: row.title }, date);
        if (person) this.w.touch(row.id);
      }
    }
  }

  projects(list) {
    for (const p of list ?? []) {
      const bullets = p.bullets ?? [];
      const date = maxDate(bullets) ?? this.batchDate;
      const co = p.company ? this.ensureCompany(p.company, null, date) : null;
      const row = this.ensureProject(p.name, { status: p.status, goal: p.goal ? oneLine(p.goal) : undefined, ...this.linkFields('company', co, p.company) }, date);
      if (!row) continue;
      const people = (p.people ?? []).filter((n) => !this.isOwnerName(n)).map((n) => this.personRef(n));
      const fresh = people.filter((x) => !(row.data.people ?? []).some((y) => (x.id && y.id === x.id) || normalizeName(y.name) === normalizeName(x.name)));
      if (fresh.length) this.w.unionField(row, 'people', fresh, 40);
      this.addBullets(row.id, bullets);
    }
  }

  people(list) {
    for (const p of list ?? []) {
      const res = this.resolvePerson(p);
      if (!res || res.owner) {
        if (!res) this.report.skipped_people.push(oneLine(p.name));
        continue;
      }
      const bullets = (p.bullets ?? []).filter((b) => (b.source_refs ?? []).some((r) => this.refs.has(r)));
      if (!bullets.length && (!this.participants.has(res.id) || res.fresh)) {
        this.report.skipped_people.push(oneLine(p.name));
        continue;
      }
      const row = this.ensurePerson(res, p, maxDate(bullets) ?? this.batchDate);
      this.addBullets(row.id, p.bullets);
    }
  }

  meetings(list) {
    const w = this.w;
    for (const m of list ?? []) {
      const refs = this.validRefs(m.source_refs);
      if (!refs.length) {
        this.drop('meeting', m.title);
        continue;
      }
      const primary = refs.find((r) => this.meetingRefs.has(r)) ?? [...refs].sort()[0];
      const id = `m_${shortHash(primary, 10)}`;
      const row = w.note(id) ?? w.create('meeting', id, m.title, { title: oneLine(m.title), date: m.date, primary_ref: primary });
      const co = m.company ? this.ensureCompany(m.company, null, m.date) : null;
      const pr = m.project ? this.ensureProject(m.project, null, m.date) : null;
      const people = [];
      for (const n of m.people ?? []) {
        if (this.isOwnerName(n)) continue;
        const ref = this.personRef(n);
        if (!people.some((x) => (x.id && x.id === ref.id) || normalizeName(x.name) === normalizeName(ref.name))) people.push(ref);
      }
      const actions = (m.action_items ?? []).map((a) => ({ text: oneLine(a.text), ...(a.owner ? { owner: this.isOwnerName(a.owner) ? this.ownerName || a.owner : this.personRef(a.owner).name } : {}), ...(a.due ? { due: a.due } : {}) }));
      w.setFields(
        row,
        {
          title: oneLine(m.title),
          date: m.date,
          summary: m.summary ? oneLine(m.summary) : undefined,
          key_points: (m.key_points ?? []).map(oneLine).filter(Boolean),
          action_items: actions,
          people,
          source_label: w.label([primary]).split(', ')[0],
          ...this.linkFields('company', co, m.company),
          ...this.linkFields('project', pr, m.project),
        },
        m.date,
      );
      w.unionField(row, 'refs', refs, 50);
    }
  }

  decisions(list) {
    const w = this.w;
    for (const d of list ?? []) {
      const refs = this.validRefs(d.source_refs);
      if (!refs.length) {
        this.drop('decision', d.title);
        continue;
      }
      const fp = fingerprint('decision', d.date, d.title);
      const row = w.note(`d_${fp}`) ?? this.similar('decision', d.title, (x) => x.data.date === d.date, 0.6) ?? w.create('decision', `d_${fp}`, d.title, { title: oneLine(d.title), date: d.date });
      const co = d.company ? this.ensureCompany(d.company, null, d.date) : null;
      const pr = d.project ? this.ensureProject(d.project, null, d.date) : null;
      const by = [];
      for (const n of d.decided_by ?? []) {
        const ref = this.personRef(n);
        if (!by.some((x) => normalizeName(x.name) === normalizeName(ref.name))) by.push(ref);
      }
      w.setFields(row, { title: oneLine(d.title), date: d.date, rationale: d.rationale, against: d.against, decided_by: by, ...this.linkFields('company', co, d.company), ...this.linkFields('project', pr, d.project) }, d.date);
      this.mention(row, d.date, refs);
      if (pr) w.touch(pr.id);
    }
  }

  // Commitments and opportunities share the same life: open, then closed.
  tracked(type, item, { key, fp, title, text, create, closeWith }) {
    const w = this.w;
    const refs = this.validRefs(item.source_refs);
    if (!refs.length) {
      this.drop(type, title);
      return null;
    }
    const prefix = type === 'commitment' ? 'c' : 'o';
    let row = w.note(`${prefix}_${fp}`) ?? this.aliasTarget(fp);
    if (!row) {
      row = this.similar(type, text, (x) => x.data.key === key && (type !== 'commitment' || x.data.direction === item.direction), 0.5);
      if (row) w.addItem({ fp, target: row.id, section: 'alias', date: item.date, refs });
    }
    const status = item.status ?? 'open';
    let bullet = null;
    if (!row) {
      row = w.create(type, `${prefix}_${fp}`, title, { ...create, key, status, status_date: item.date, date: item.date });
      bullet = text;
    } else {
      const cur = row.data.status ?? 'open';
      const since = row.data.status_date ?? '';
      if (status !== cur && (item.date > since || (item.date === since && status !== 'open' && !row.data._human?.status))) {
        row.data.status = status;
        row.data.status_date = item.date;
        row.data._dates = { ...(row.data._dates ?? {}), status: item.date };
        w.markDirty(row);
        bullet = status === 'open' ? text : this.w.tr(`marked.${status}`);
      } else if (status === cur) bullet = closeWith ?? text;
    }
    if (bullet) this.addBullets(row.id, [{ date: item.date, text: bullet, source_refs: refs }]);
    for (const k of ['counterpart_id', 'company_id', 'project_id']) if (row.data[k]) w.touch(row.data[k]);
    return row;
  }

  commitments(list) {
    const w = this.w;
    for (const k of list ?? []) {
      const res = this.resolvePerson({ name: k.counterpart });
      const cp = res && !res.owner ? (w.note(res.id) ?? ((res.person || res.fresh) ? this.ensurePerson(res, {}, k.date) : null)) : null;
      const key = cp?.id ?? normalizeName(k.counterpart);
      const fp = fingerprint('commitment', k.direction, key, k.text);
      const co = k.company ? this.ensureCompany(k.company, null, k.date, { create: false }) : null;
      const pr = k.project ? this.ensureProject(k.project, null, k.date, { create: false }) : null;
      const row = this.tracked('commitment', k, {
        key,
        fp,
        title: k.text,
        text: k.text,
        create: { text: oneLine(k.text), direction: k.direction, fingerprint: fp, ...this.linkFields('counterpart', cp, k.counterpart), ...this.linkFields('company', co, k.company), ...this.linkFields('project', pr, k.project), ...(k.due ? { due: k.due } : {}) },
      });
      if (!row) continue;
      if (k.due) w.setFields(row, { due: k.due }, k.date);
    }
  }

  opportunities(list) {
    const w = this.w;
    for (const o of list ?? []) {
      const res = o.counterpart ? this.resolvePerson({ name: o.counterpart }) : null;
      const cp = res && !res.owner ? (w.note(res.id) ?? ((res.person || res.fresh) ? this.ensurePerson(res, {}, o.date) : null)) : null;
      const co = o.company ? this.ensureCompany(o.company, null, o.date) : null;
      const key = cp?.id ?? co?.id ?? normalizeName(o.counterpart ?? o.company ?? '');
      const fp = fingerprint('opportunity', o.type, key, o.title);
      const row = this.tracked('opportunity', o, {
        key,
        fp,
        title: o.title,
        text: o.title,
        closeWith: o.next_step,
        create: { title: oneLine(o.title), opportunity_type: o.type, ...this.linkFields('counterpart', cp, o.counterpart), ...this.linkFields('company', co, o.company) },
      });
      if (!row) continue;
      w.setFields(row, { value: o.value, next_step: o.next_step }, o.date);
    }
  }

  ideas(list) {
    const w = this.w;
    for (const i of list ?? []) {
      const refs = this.validRefs(i.source_refs);
      if (!refs.length) {
        this.drop('idea', i.title);
        continue;
      }
      const fp = fingerprint('idea', i.title);
      const row = w.note(`i_${fp}`) ?? this.similar('idea', i.title, null, 0.7) ?? w.create('idea', `i_${fp}`, i.title, { title: oneLine(i.title), date: i.date, status: 'new' });
      const pr = i.project ? this.ensureProject(i.project, null, i.date, { create: false }) : null;
      const people = (i.people ?? []).filter((n) => !this.isOwnerName(n)).map((n) => this.personRef(n));
      w.setFields(row, { text: i.text, ...this.linkFields('project', pr, i.project) }, i.date);
      if (people.length) w.unionField(row, 'people', people.filter((x) => !(row.data.people ?? []).some((y) => normalizeName(y.name) === normalizeName(x.name))), 20);
      this.mention(row, i.date, refs);
    }
  }

  knowledge(list) {
    const w = this.w;
    for (const k of list ?? []) {
      const refs = this.validRefs(k.source_refs);
      if (!refs.length) {
        this.drop('knowledge', k.title);
        continue;
      }
      const date = k.date ?? this.batchDate;
      const fp = fingerprint('knowledge', k.title);
      const row = w.note(`k_${fp}`) ?? this.similar('knowledge', k.title, null, 0.7) ?? w.create('knowledge', `k_${fp}`, k.title, { title: oneLine(k.title), date });
      w.setFields(row, { text: k.text }, date);
      if (k.tags?.length) w.unionField(row, 'tags', k.tags.map(oneLine), 12);
      this.mention(row, date, refs);
    }
  }

  apply(c) {
    this.identityFixes(c.identity);
    this.companies(c.companies);
    this.people(c.people);
    this.companyPeople(c.companies);
    this.projects(c.projects);
    this.meetings(c.meetings);
    this.decisions(c.decisions);
    this.commitments(c.commitments);
    this.opportunities(c.opportunities);
    this.ideas(c.ideas);
    this.knowledge(c.knowledge);
  }
}

export async function mergeBatch(ctx, batchId, { contribution } = {}) {
  const paths = bPaths(ctx);
  const batch = readJson(paths.batch(batchId), null);
  if (!batch) throw new Error(`There is no batch ${batchId}. Run \`confidant batch next\` first.`);
  let contrib = contribution ?? readJson(paths.contribution(batchId), null);
  if (!contrib) throw new Error(`Batch ${batchId} has not been sorted yet. Write ${paths.contribution(batchId)} first.`);
  try {
    assertValid('contribution', contrib);
  } catch (err) {
    err.message = `${err.message}\nFix ${paths.contribution(batchId)} and run \`confidant merge --batch ${batchId}\` again.`;
    err.code = 'ESCHEMA';
    throw err;
  }
  if (contrib.batch_id !== batchId) throw Object.assign(new Error(`${paths.contribution(batchId)} says batch_id "${contrib.batch_id}", expected "${batchId}".`), { code: 'ESCHEMA' });
  const scrub = await loadScrub();
  contrib = cleanContribution(contrib, scrub);
  const release = takeLock(ctx, 'vault');
  try {
    const identity = loadIdentity(ctx, { build: true });
    const row = batchRow(ctx, batchId);
    const w = new NoteWriter(ctx, { identity, batchId, kind: 'merge' });
    const m = new Merger(ctx, w, batch);
    m.apply(contrib);
    const out = w.finish({ batch: { id: batchId, statusBefore: row?.status ?? null } });
    if (!ctx.dryRun) {
      setBatchStatus(ctx, batchId, 'merged', { merged_at: new Date(ctx.now).toISOString(), run_id: out.run_id });
      if (batch.scope === 'backlog') patchState(ctx, { backlog: { remaining_batches: estimateBacklog(ctx) } });
    }
    return { batch_id: batchId, ...out, ...m.report };
  } finally {
    release();
  }
}

// Every batch with a contribution that has not been merged yet.
export async function mergeAll(ctx) {
  const db = bTables(ctx.store);
  const rows = db.prepare(`SELECT id, output, status FROM b_batches WHERE status IN ('pending', 'written') ORDER BY seq`).all();
  const results = [];
  for (const r of rows) {
    if (!readJson(r.output, null)) continue;
    try {
      results.push({ ok: true, ...(await mergeBatch(ctx, r.id)) });
    } catch (err) {
      results.push({ ok: false, batch_id: r.id, error: err.message });
    }
  }
  return results;
}

const summary = (r) =>
  r.ok === false
    ? `${r.batch_id}: not merged. ${r.error}`
    : `${r.batch_id}: ${r.created.length} new notes, ${r.updated.length} updated, ${r.added} new facts${r.duplicates ? `, ${r.duplicates} already known` : ''}${r.dropped.length ? `, ${r.dropped.length} left out without a source` : ''}${r.run_id ? ` (undo: confidant undo --run ${r.run_id})` : ''}`;

export async function run(args, ctx) {
  if (args.all) {
    const results = await mergeAll(ctx);
    ctx.log.out({ results }, results.length ? results.map(summary).join('\n') : 'Nothing waiting to be merged.');
    return results.some((r) => r.ok === false) ? 6 : 0;
  }
  const id = args.batch;
  if (!id || id === true) {
    ctx.log.error('Pass --batch <id> (or --all).');
    return 2;
  }
  try {
    const result = await mergeBatch(ctx, String(id));
    ctx.log.out(result, summary({ ok: true, ...result }));
    return 0;
  } catch (err) {
    if (err.code === 'ESCHEMA') {
      ctx.log.out({ ok: false, batch_id: id, error: err.message, errors: err.errors ?? [] }, `Not merged.\n${err.message}`);
      return 6;
    }
    throw err;
  }
}
