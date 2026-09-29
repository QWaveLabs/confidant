// The vault writer. Notes are rendered from Unit B's tables in brain.db:
//   b_notes  one row per note (its id, path, title and current fields)
//   b_items  every dated bullet, fingerprinted, with the records it came from
// so rendering is deterministic, merging the same batch twice changes
// nothing, and undo can restore both the files and the rows.
//
// Only content between <!-- confidant:start X --> and <!-- confidant:end X -->
// and the frontmatter keys listed in OWNED are ever rewritten. When the
// person edits one of the EDITABLE fields in Obsidian (a commitment's status,
// a due date), their value wins and is adopted into the tables.
import { closeSync, copyFileSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ensureDir, writeFileAtomic, writeJson } from './lib/files.mjs';
import { folderPath, folderName, FOLDERS } from './lib/folders.mjs';
import { localDate } from './lib/time.mjs';
import { t, fill } from './lib/i18n.mjs';
import { composeNote } from './lib/frontmatter.mjs';
import { normalizeName, nameTokens, safeFileName, slugTag, ensureSentence, oneLine, escapeRegExp } from './lib/b-text.mjs';
import { composeBody, upsertSections, mergeFrontmatter, splitNote, readSection } from './lib/b-sections.mjs';
import { bPaths, bTables, sourceLabel, refSource, readText, isoNow } from './lib/b-common.mjs';
import { loadPersona, subfolderFor } from './lib/b-persona.mjs';

export const TYPE_FOLDER = {
  person: 'people',
  company: 'companies',
  project: 'projects',
  meeting: 'meetings',
  decision: 'decisions',
  commitment: 'commitments',
  idea: 'ideas',
  opportunity: 'opportunities',
  knowledge: 'knowledge',
};

const TAIL = ['updated', 'tags', 'sources', 'latest_source'];
export const OWNED = {
  person: ['type', 'confidant_id', 'name', 'aliases', 'kind', 'company', 'role', 'relationship', 'tier', 'last_contact', 'phones', 'emails', ...TAIL],
  company: ['type', 'confidant_id', 'name', 'aliases', 'kind', ...TAIL],
  project: ['type', 'confidant_id', 'name', 'status', 'company', 'people', ...TAIL],
  meeting: ['type', 'confidant_id', 'date', 'people', 'company', 'project', 'source', ...TAIL],
  decision: ['type', 'confidant_id', 'date', 'project', 'company', 'decided_by', ...TAIL],
  commitment: ['type', 'confidant_id', 'direction', 'counterpart', 'company', 'project', 'due', 'status', 'date', 'fingerprint', ...TAIL],
  idea: ['type', 'confidant_id', 'date', 'status', 'project', ...TAIL],
  opportunity: ['type', 'confidant_id', 'opportunity_type', 'status', 'counterpart', 'company', 'value', 'date', 'next_step', ...TAIL],
  knowledge: ['type', 'confidant_id', 'date', ...TAIL],
};

// Frontmatter fields the person may change by hand; their edit wins.
export const EDITABLE = {
  person: ['kind', 'company', 'role', 'relationship'],
  company: ['kind'],
  project: ['status', 'company'],
  meeting: [],
  decision: [],
  commitment: ['status', 'due', 'direction'],
  idea: ['status'],
  opportunity: ['status', 'value', 'next_step', 'opportunity_type'],
  knowledge: [],
};

// Frontmatter field -> the data fields that hold a link: { id, name }.
const LINK_FIELDS = { company: 'company', project: 'project', counterpart: 'counterpart' };
const OPEN_STATUSES = { commitment: 'open', opportunity: 'open' };
const COMPANY_SUFFIX = /\s+(inc|incorporated|llc|l l c|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|sa|s a|sas|sa de cv|s de rl|srl|sl|bv|pty|pte)$/;

export const companyKey = (name) => {
  let n = normalizeName(name);
  for (let i = 0; i < 2; i++) n = n.replace(COMPANY_SUFFIX, '').trim();
  return n;
};
const keyFor = (type, name) => (type === 'company' ? companyKey(name) : normalizeName(name));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const uniq = (xs) => [...new Set(xs)];
const stripLink = (v) => (typeof v === 'string' ? v.replace(/^\[\[([^\]|]+)(\|[^\]]*)?\]\]$/, '$1').trim() : v);

export class NoteWriter {
  constructor(ctx, { identity, persona, batchId = null, kind = 'merge' } = {}) {
    this.ctx = ctx;
    this.db = bTables(ctx.store);
    this.identity = identity;
    this.persona = persona ?? loadPersona(ctx);
    this.lang = ctx.lang;
    this.tr = t('notes', this.lang);
    this.today = localDate(ctx.now, ctx.tz);
    this.batchId = batchId;
    this.kind = kind;
    const seq = this.db.prepare('SELECT COUNT(*) n FROM b_runs').get().n + 1;
    const stamp = isoNow(ctx).replace(/[-:]/g, '').slice(0, 15);
    this.runId = `${stamp}-${String(seq).padStart(4, '0')}`;
    this.rows = new Map();
    this.preimages = new Map();
    this.dirty = new Set();
    this.touched = new Set();
    this.itemsAdded = [];
    this.index = null;
    this.basenames = null;
    this.files = [];
    this.fileSeen = new Set();
    this.created = [];
    this.updated = [];
    this.vaultIndex = null;
    this.itemPre = new Map();
    this.removed = new Set();
  }

  // ---------- registry ----------

  loadRow(r) {
    if (!r) return null;
    const row = { ...r, data: JSON.parse(r.data) };
    this.rows.set(row.id, row);
    this.syncFromFile(row);
    return row;
  }

  note(id) {
    if (!id || this.removed.has(id)) return null;
    if (this.rows.has(id)) return this.rows.get(id);
    return this.loadRow(this.db.prepare('SELECT * FROM b_notes WHERE id = ?').get(id));
  }

  all(type) {
    for (const r of this.db.prepare('SELECT * FROM b_notes WHERE type = ?').all(type)) if (!this.rows.has(r.id)) this.loadRow(r);
    return [...this.rows.values()].filter((r) => r.type === type && !this.removed.has(r.id)).sort((a, b) => a.id.localeCompare(b.id));
  }

  buildIndex() {
    if (this.index) return this.index;
    this.index = new Map();
    for (const r of this.db.prepare('SELECT id, type, title, data FROM b_notes').all()) {
      const data = this.rows.get(r.id)?.data ?? JSON.parse(r.data);
      this.addToIndex(r.type, r.id, [r.title, ...(data.aliases ?? [])]);
    }
    return this.index;
  }

  addToIndex(type, id, names) {
    const idx = this.index ?? this.buildIndex();
    if (!idx.has(type)) idx.set(type, new Map());
    const m = idx.get(type);
    for (const n of names) {
      const k = keyFor(type, n);
      if (!k) continue;
      if (!m.has(k)) m.set(k, new Set());
      m.get(k).add(id);
    }
  }

  // Existing note of this type by title or alias (accents and case ignored).
  findByName(type, name) {
    const k = keyFor(type, name);
    if (!k) return [];
    const ids = this.buildIndex().get(type)?.get(k);
    return ids ? [...ids].sort().filter((id) => !this.removed.has(id)).map((id) => this.note(id)).filter(Boolean) : [];
  }

  markDirty(row) {
    if (!this.preimages.has(row.id)) {
      const before = this.db.prepare('SELECT * FROM b_notes WHERE id = ?').get(row.id) ?? null;
      this.preimages.set(row.id, before ? { ...before } : null);
    }
    this.dirty.add(row.id);
    this.touched.add(row.id);
  }

  create(type, id, title, data = {}) {
    const existing = this.note(id);
    if (existing) return existing;
    const cleanTitle = oneLine(title) || 'Untitled';
    const row = { id, type, path: null, title: cleanTitle, norm: keyFor(type, cleanTitle), data: { ...data }, created_run: this.runId, updated_run: this.runId };
    row.path = this.planPath(row);
    this.rows.set(id, row);
    this.addToIndex(type, id, [cleanTitle, ...(data.aliases ?? [])]);
    this.markDirty(row);
    this.backfillLinks(row);
    return row;
  }

  // Notes that named this company, project or person before it had a note
  // now link to it.
  backfillLinks(row) {
    const keys = { company: ['company'], project: ['project'], person: ['counterpart'] }[row.type];
    if (!keys) return;
    const names = new Set([row.title, ...(row.data.aliases ?? [])].map((n) => keyFor(row.type, n)));
    for (const r of this.db.prepare('SELECT id FROM b_notes').all()) {
      if (r.id === row.id) continue;
      const other = this.note(r.id);
      for (const key of keys) {
        const name = other.data[`${key}_name`];
        if (other.data[`${key}_id`] || !name || !names.has(keyFor(row.type, name))) continue;
        other.data[`${key}_id`] = row.id;
        this.markDirty(other);
      }
    }
  }

  // Drops a note row (and optionally its file) inside this run, for undo.
  removeNote(row, { deleteFile = true } = {}) {
    this.markDirty(row);
    this.dirty.delete(row.id);
    this.touched.delete(row.id);
    this.removed.add(row.id);
    const rel = this.locate(row);
    if (deleteFile && rel) this.deleteFile(rel);
  }

  // Latest fact wins: a field is replaced only by a fact dated the same day
  // or later than the one that set it (or by the person's own edit).
  setFields(row, fields, date) {
    let changed = false;
    row.data._dates ??= {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
      const prev = row.data._dates[k] ?? '';
      if (prev && date && date < prev) continue;
      if (same(row.data[k], v)) {
        if (date && date > prev) row.data._dates[k] = date;
        continue;
      }
      row.data[k] = v;
      row.data._dates[k] = date ?? prev;
      changed = true;
    }
    if (changed) this.markDirty(row);
    return changed;
  }

  unionField(row, key, values, limit = 50) {
    const next = uniq([...(row.data[key] ?? []), ...values.filter(Boolean)]).slice(0, limit);
    if (same(next, row.data[key] ?? [])) return false;
    row.data[key] = next;
    this.markDirty(row);
    return true;
  }

  touch(id) {
    if (id && this.note(id)) this.touched.add(id);
  }

  // ---------- items ----------

  // Change an existing item (retarget, scrub), keeping its first state for undo.
  updateItem(fp, patch) {
    const before = this.db.prepare('SELECT * FROM b_items WHERE fp = ?').get(fp);
    if (!before) return false;
    if (!this.itemPre.has(fp)) this.itemPre.set(fp, { fp, target: before.target, section: before.section, text: before.text });
    const next = { target: patch.target ?? before.target, section: patch.section ?? before.section, text: patch.text ?? before.text };
    if (!this.ctx.dryRun) this.db.prepare('UPDATE b_items SET target = ?, section = ?, text = ? WHERE fp = ?').run(next.target, next.section, next.text, fp);
    this.touched.add(before.target);
    this.touched.add(next.target);
    return true;
  }

  hasItem(fp) {
    return !!this.db.prepare('SELECT 1 FROM b_items WHERE fp = ?').get(fp);
  }

  itemRows(target, section) {
    return this.db.prepare('SELECT * FROM b_items WHERE target = ? AND section = ? ORDER BY date DESC, seq ASC').all(target, section);
  }

  addItem({ fp, target, section, date = null, text = null, refs = [] }) {
    if (this.hasItem(fp)) return false;
    if (!this.ctx.dryRun) {
      const seq = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 n FROM b_items').get().n;
      this.db.prepare('INSERT INTO b_items (fp, target, section, date, text, refs, run_id, batch_id, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(fp, target, section, date, text, JSON.stringify(refs), this.runId, this.batchId, seq);
    }
    this.itemsAdded.push(fp);
    if (section !== 'alias' && section !== 'dup' && section !== 'mention') this.touched.add(target);
    return true;
  }

  // ---------- paths ----------

  loadBasenames() {
    if (this.basenames) return this.basenames;
    this.basenames = new Set();
    for (const r of this.db.prepare('SELECT path FROM b_notes WHERE path IS NOT NULL').all()) this.basenames.add(pathKey(basename(r.path, '.md')));
    this.basenames.add('home');
    for (const f of FOLDERS) this.basenames.add(folderName(f.key, this.lang).toLowerCase());
    return this.basenames;
  }

  planPath(row) {
    const key = TYPE_FOLDER[row.type];
    const sub = subfolderFor(this.persona, key, { ...row.data, kind: row.data.kind }, this.lang);
    const folder = folderPath(key, this.lang, sub);
    const dated = row.type === 'meeting' || row.type === 'decision';
    const base = dated ? `${row.data.date ?? this.today} ${safeFileName(row.title, 80)}` : safeFileName(row.title);
    const taken = this.loadBasenames();
    const qualifier =
      row.type === 'person'
        ? row.data.company_name
        : row.type === 'project'
          ? this.tr('project_suffix')
          : row.type === 'company'
            ? this.tr('company_suffix')
            : row.type === 'commitment' || row.type === 'opportunity'
              ? row.data.counterpart_name
              : null;
    const candidates = [base];
    if (qualifier) candidates.push(`${base} (${safeFileName(qualifier, 40)})`);
    for (let n = 2; n < 50; n++) candidates.push(`${base} ${n}`);
    for (const c of candidates) {
      const rel = `${folder}/${c}.md`;
      const key = pathKey(c);
      if (taken.has(key) || existsSync(join(this.ctx.vault, rel))) continue;
      taken.add(key);
      return rel;
    }
    return `${folder}/${base} ${row.id}.md`;
  }

  // The note file, following it if the person moved or renamed it.
  locate(row) {
    if (row.path && existsSync(join(this.ctx.vault, row.path))) return row.path;
    if (!this.vaultIndex) {
      this.vaultIndex = new Map();
      for (const f of FOLDERS) {
        const walk = (dir) => {
          let names = [];
          try {
            names = readdirSync(join(this.ctx.vault, dir));
          } catch {
            return;
          }
          for (const name of names) {
            const rel = `${dir}/${name}`;
            const abs = join(this.ctx.vault, rel);
            const st = (() => { try { return lstatSync(abs); } catch { return null; } })();
            if (!st || st.isSymbolicLink()) continue;
            if (st.isDirectory()) walk(rel);
            else if (st.isFile() && name.endsWith('.md')) {
              const fd = openSync(abs, 'r');
              const buf = Buffer.alloc(2000);
              const n = readSync(fd, buf, 0, 2000, 0);
              closeSync(fd);
              const head = buf.subarray(0, n).toString('utf8');
              const m = /^confidant_id:\s*"?([^"\s]+)"?\s*$/m.exec(head);
              if (m) this.vaultIndex.set(m[1], rel);
            }
          }
        };
        walk(folderName(f.key, this.lang));
      }
    }
    const moved = this.vaultIndex.get(row.id);
    if (moved && moved !== row.path) {
      this.markDirty(row);
      row.path = moved;
    }
    return moved ?? row.path;
  }

  // ---------- the person's own edits ----------

  syncFromFile(row) {
    const editable = EDITABLE[row.type] ?? [];
    const written = row.data._written;
    if (!editable.length || !written || !row.path) return;
    const rel = this.locate(row);
    const abs = join(this.ctx.vault, rel);
    let mtime = null;
    try {
      mtime = statSync(abs).mtimeMs;
    } catch {
      return;
    }
    if (row.data._mtime && mtime === row.data._mtime) return;
    const text = readText(abs);
    if (text == null) return;
    const { data: fm } = splitNote(text);
    // No frontmatter (or not ours): nothing to adopt, rather than reading
    // every field as cleared by the person.
    if (fm?.confidant_id == null) return;
    const adopt = {};
    for (const f of editable) {
      if (same(fm[f], written[f])) continue;
      adopt[f] = fm[f];
    }
    if (!Object.keys(adopt).length) return;
    row.data._dates ??= {};
    for (const [f, v] of Object.entries(adopt)) {
      const linkKey = LINK_FIELDS[f];
      if (linkKey) {
        const name = stripLink(v);
        const target = name ? this.findByName(f === 'counterpart' ? 'person' : f, name)[0] : null;
        row.data[`${linkKey}_id`] = target?.id ?? null;
        row.data[`${linkKey}_name`] = name ?? null;
      } else row.data[f] = v ?? undefined;
      row.data._dates[f] = this.today;
      if (f === 'status') row.data.status_date = this.today;
    }
    row.data._human = { ...(row.data._human ?? {}), ...Object.fromEntries(Object.keys(adopt).map((f) => [f, this.today])) };
    this.markDirty(row);
  }

  // ---------- links ----------

  link(id, fallback) {
    const row = id ? this.note(id) : null;
    if (!row) return fallback ? oneLine(fallback) : '';
    return `[[${basename(this.locate(row) ?? row.path, '.md')}]]`;
  }

  linkOrName(data, key) {
    const id = data[`${key}_id`];
    if (id && this.note(id)) return this.link(id);
    const name = data[`${key}_name`];
    if (!name) return '';
    const found = this.findByName(key === 'counterpart' ? 'person' : key, name)[0];
    return found ? this.link(found.id) : oneLine(name);
  }

  linker() {
    if (this._linker) return this._linker;
    const targets = new Map();
    const put = (name, row) => {
      const n = oneLine(name);
      if (!n || targets.has(n)) return;
      targets.set(n, row.id);
    };
    for (const type of ['person', 'company', 'project']) {
      const rows = new Map(this.db.prepare('SELECT id, title, path, data FROM b_notes WHERE type = ?').all(type).map((r) => [r.id, { ...r, data: JSON.parse(r.data) }]));
      for (const r of this.rows.values()) if (r.type === type) rows.set(r.id, r);
      for (const row of [...rows.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        for (const n of [row.title, ...(row.data.aliases ?? [])]) {
          if (type === 'person' ? nameTokens(n).length >= 2 : n.length >= 4) put(n, row);
        }
      }
    }
    const names = [...targets.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
    const re = names.length ? new RegExp(`(?<![\\p{L}\\p{N}\\[])(${names.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}\\]])`, 'gu') : null;
    const byNorm = new Map();
    for (const [n, id] of targets) byNorm.set(normalizeName(n), id);
    this._linker = { targets, re, byNorm };
    return this._linker;
  }

  // Link the first mention of each known person, company and project. Links
  // the sorter wrote to notes that do not exist become plain text.
  linkify(text, selfId) {
    const { targets, re, byNorm } = this.linker();
    const done = new Set([selfId]);
    let s = String(text).replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, target, shown) => {
      const id = byNorm.get(normalizeName(target));
      if (!id || id === selfId) return shown ?? target;
      done.add(id);
      const base = basename(this.note(id).path, '.md');
      const display = shown ?? target;
      return display === base ? `[[${base}]]` : `[[${base}|${display}]]`;
    });
    if (!re) return s;
    const parts = s.split(/(\[\[[^\]]+\]\])/);
    return parts
      .map((part) => {
        if (part.startsWith('[[')) return part;
        return part.replace(re, (m) => {
          const id = targets.get(m);
          if (!id || done.has(id)) return m;
          done.add(id);
          const base = basename(this.note(id).path, '.md');
          return base === m ? `[[${base}]]` : `[[${base}|${m}]]`;
        });
      })
      .join('');
  }

  // ---------- provenance ----------

  meetingByRef() {
    if (this._meetingByRef) return this._meetingByRef;
    const m = new Map();
    for (const row of this.all('meeting')) for (const ref of row.data.refs ?? []) if (!m.has(ref)) m.set(ref, row.id);
    this._meetingByRef = m;
    return m;
  }

  label(refs, selfId) {
    const labels = uniq(refs.map((r) => sourceLabel(refSource(r), this.lang)));
    const meetings = uniq(refs.map((r) => this.meetingByRef().get(r)).filter((id) => id && id !== selfId)).map((id) => this.link(id));
    return [...labels, ...meetings].join(', ');
  }

  bullet(item, selfId) {
    const refs = JSON.parse(item.refs);
    return `- ${item.date}, ${this.linkify(ensureSentence(item.text), selfId)} _(${this.label(refs, selfId)})_`;
  }

  provenance(row) {
    const refs = new Set(row.data.refs ?? []);
    let latest = null;
    for (const it of this.db.prepare(`SELECT date, refs FROM b_items WHERE target = ? AND section NOT IN ('alias', 'dup') ORDER BY date DESC, seq DESC`).all(row.id)) {
      const rs = JSON.parse(it.refs);
      for (const r of rs) refs.add(r);
      if (!latest && rs.length) latest = rs[0];
    }
    if (!latest && row.data.refs?.length) latest = row.data.primary_ref ?? row.data.refs[0];
    return { count: refs.size, latest: latest ? sourceLabel(refSource(latest), this.lang) : undefined };
  }

  // ---------- rendering ----------

  render(row) {
    const r = RENDER[row.type](this, row);
    const { count, latest } = this.provenance(row);
    const fm = { type: row.type, confidant_id: row.id, ...r.fm, updated: undefined, tags: r.tags.filter(Boolean), sources: count, latest_source: latest };
    for (const [k, v] of Object.entries(fm)) {
      if (v === null || v === '' || (Array.isArray(v) && !v.length && k !== 'tags')) fm[k] = undefined;
      else if (typeof v === 'string') fm[k] = oneLine(v);
    }
    return { fm, title: r.title, sections: r.sections };
  }

  // Writes one note if anything changed. Returns 'created' | 'updated' | null.
  writeNote(row) {
    const { fm, title, sections } = this.render(row);
    const rel = this.locate(row) ?? this.planPath(row);
    if (rel !== row.path) {
      this.markDirty(row);
      row.path = rel;
    }
    const abs = join(this.ctx.vault, rel);
    const before = readText(abs);
    const owned = OWNED[row.type];
    const compose = (updated) => {
      const data = { ...fm, updated };
      const ordered = Object.fromEntries(owned.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));
      if (before == null) return composeNote(ordered, composeBody(title, sections));
      const { fmText, body } = splitNote(before);
      return `${mergeFrontmatter(fmText, ordered, owned)}${upsertSections(body, sections)}`;
    };
    const prevUpdated = before == null ? null : splitNote(before).data.updated;
    let content = compose(prevUpdated ?? this.today);
    if (before != null && content !== before) content = compose(this.today);
    const written = Object.fromEntries((EDITABLE[row.type] ?? []).map((f) => [f, fm[f]]));
    if (!same(row.data._written, written)) {
      row.data._written = written;
      this.markDirty(row);
    }
    if (content === before) return null;
    this.writeFile(rel, content);
    if (!this.ctx.dryRun) {
      row.data._mtime = statSync(abs).mtimeMs;
      this.markDirty(row);
    }
    return before == null ? 'created' : 'updated';
  }

  // Keep a pre-image of a vault file (once per run) before anything changes it.
  preserve(rel) {
    if (this.fileSeen.has(rel)) return;
    this.fileSeen.add(rel);
    const abs = insideDir(this.ctx.vault, rel);
    const existed = existsSync(abs);
    this.files.push({ path: rel, existed });
    if (existed && !this.ctx.dryRun) {
      const dest = join(this.backupDir(), 'files', rel);
      ensureDir(dirname(dest));
      copyFileSync(abs, dest);
    }
  }

  deleteFile(rel) {
    const abs = insideDir(this.ctx.vault, rel);
    if (!existsSync(abs)) return false;
    this.preserve(rel);
    if (!this.ctx.dryRun) unlinkSync(abs);
    return true;
  }

  // A file where only the frontmatter keys in fm and one section are ours.
  writeManaged(rel, { fm, title, section, content }) {
    const owned = Object.keys(fm).concat('updated');
    const before = readText(join(this.ctx.vault, rel));
    const compose = (updated) => {
      const data = { ...fm, updated };
      const sections = [{ name: section, heading: null, content }];
      if (before == null) return composeNote(data, composeBody(title, sections));
      const { fmText, body } = splitNote(before);
      return `${mergeFrontmatter(fmText, data, owned)}${upsertSections(body, sections)}`;
    };
    const prev = before == null ? null : splitNote(before).data.updated;
    let text = compose(prev ?? this.today);
    if (before != null && text !== before) text = compose(this.today);
    return this.writeFile(rel, text);
  }

  // Any vault file, with a pre-image backup the first time a run touches it.
  writeFile(rel, content) {
    const abs = insideDir(this.ctx.vault, rel);
    if (readText(abs) === content) return false;
    this.preserve(rel);
    if (!this.ctx.dryRun) writeFileAtomic(abs, content);
    return true;
  }

  backupDir() {
    return join(bPaths(this.ctx).backups, this.runId);
  }

  // Render every note touched so far. Safe to call more than once.
  flushNotes() {
    this._linker = null;
    this._meetingByRef = null;
    const ids = [...this.touched].sort();
    this.touched.clear();
    for (const id of ids) {
      const row = this.note(id);
      if (!row) continue;
      const res = this.writeNote(row);
      if (res === 'created') this.created.push(row.path);
      else if (res === 'updated') this.updated.push(row.path);
    }
  }

  // Render what is left, save rows, record the run for undo.
  finish({ batch, identityChanged } = {}) {
    this.flushNotes();
    if (this.identity && !this.ctx.dryRun) identityChanged = this.syncIdentityPaths() || identityChanged;
    const rowsChanged = [...this.dirty];
    if (!this.ctx.dryRun) {
      const up = this.db.prepare(`INSERT INTO b_notes (id, type, path, title, norm, data, created_run, updated_run) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET type = excluded.type, path = excluded.path, title = excluded.title, norm = excluded.norm, data = excluded.data, updated_run = excluded.updated_run`);
      for (const id of rowsChanged) {
        const row = this.rows.get(id);
        up.run(row.id, row.type, row.path, row.title, row.norm, JSON.stringify(row.data), row.created_run ?? this.runId, this.runId);
      }
      for (const id of this.removed) this.db.prepare('DELETE FROM b_notes WHERE id = ?').run(id);
    }
    const changed = this.files.length || rowsChanged.length || this.removed.size || this.itemPre.size || this.itemsAdded.length || (batch && batch.statusBefore !== 'merged') || identityChanged;
    if (changed && !this.ctx.dryRun) {
      const manifest = {
        run_id: this.runId,
        kind: this.kind,
        batch_id: this.batchId,
        at: isoNow(this.ctx),
        // What this run left in each file, so undo can tell later edits apart.
        files: this.files.map((f) => {
          const abs = join(this.ctx.vault, f.path);
          return { ...f, after: existsSync(abs) ? fileHash(readFileSync(abs)) : null };
        }),
        notes: Object.fromEntries([...this.preimages].filter(([id]) => this.dirty.has(id) || this.removed.has(id))),
        items: this.itemsAdded,
        items_before: [...this.itemPre.values()],
        ...(batch ? { batch: { id: batch.id, status_before: batch.statusBefore ?? null } } : {}),
      };
      writeJson(join(this.backupDir(), 'manifest.json'), manifest);
      this.db.prepare('INSERT OR REPLACE INTO b_runs (id, batch_id, kind, at, files) VALUES (?, ?, ?, ?, ?)').run(this.runId, this.batchId, this.kind, manifest.at, JSON.stringify(this.files.map((f) => f.path)));
    }
    return { run_id: changed ? this.runId : null, created: this.created.sort(), updated: this.updated.sort(), items_added: this.itemsAdded.length };
  }

  // identity.json keeps note_path for every person with a note.
  syncIdentityPaths() {
    let changed = false;
    for (const row of this.rows.values()) {
      if (row.type !== 'person') continue;
      const p = this.identity.byId(row.id);
      if (p && !this.identity.isOwner(p) && p.note_path !== row.path) {
        p.note_path = row.path;
        changed = true;
      }
    }
    if (changed) this.writeFile('.confidant/identity.json', `${JSON.stringify(this.identity, null, 2)}\n`);
    return changed;
  }

  // ---------- shared queries for renderers ----------

  openFor(field, id) {
    const out = [];
    for (const type of ['commitment', 'opportunity']) {
      for (const row of this.all(type)) {
        if ((row.data.status ?? 'open') !== OPEN_STATUSES[type]) continue;
        if (row.data[`${field}_id`] !== id) continue;
        out.push(row);
      }
    }
    return out.sort((a, b) => (a.data.due ?? '9999').localeCompare(b.data.due ?? '9999') || String(b.data.date ?? '').localeCompare(String(a.data.date ?? '')) || a.id.localeCompare(b.id));
  }

  openLines(rows) {
    return rows
      .map((row) => {
        if (row.type === 'commitment') {
          const direction = this.tr(`direction.${row.data.direction}`);
          return `- ${this.link(row.id)} (${row.data.due ? fill(this.tr('open_line_due'), { direction, due: row.data.due }) : fill(this.tr('open_line'), { direction })})`;
        }
        return `- ${this.link(row.id)} (${fill(this.tr('opp_line'), { type: this.tr(`opportunity_type.${row.data.opportunity_type ?? 'other'}`), status: this.tr(`status.${row.data.status ?? 'open'}`) })})`;
      })
      .join('\n');
  }

  timeline(row) {
    return this.itemRows(row.id, 'timeline')
      .map((it) => this.bullet(it, row.id))
      .join('\n');
  }

  field(labelKey, value) {
    return value ? `**${this.tr(`fields.${labelKey}`)}:** ${value}` : null;
  }
}

// ---------- renderers, one per note type ----------

const lines = (...xs) => xs.flat().filter(Boolean).join('\n');
const linkList = (w, list) => uniq((list ?? []).map((p) => w.link(p.id, p.name)).filter(Boolean));
const sec = (w, name, content, headingKey = name, empty) => ({ name, heading: headingKey ? w.tr(`headings.${headingKey}`) : null, content: content || '', ...(empty ? { empty } : {}) });

function personRender(w, row) {
  const d = row.data;
  const ip = w.identity?.byId(row.id);
  const person = ip && !w.identity.isOwner(ip) ? ip : null;
  const phones = (person?.handles ?? []).filter((h) => h.startsWith('tel:') && !/^tel:\+?\d{1,6}$/.test(h)).map((h) => h.slice(4));
  const emails = (person?.handles ?? []).filter((h) => h.startsWith('mailto:')).map((h) => h.slice(7));
  const company = d.company_id || d.company_name ? w.linkOrName(d, 'company') : person?.company ?? undefined;
  const kind = d.kind ?? (person && person.kind !== 'person' ? person.kind : undefined);
  const aliases = uniq([...(d.aliases ?? []), ...(person?.aliases ?? []), ...(person && normalizeName(person.name) !== normalizeName(row.title) ? [person.name] : [])]).filter((a) => normalizeName(a) !== normalizeName(row.title) && !/^[+\d\s()-]+$/.test(a)).slice(0, 6);
  const open = w.openFor('counterpart', row.id);
  return {
    title: row.title,
    fm: {
      name: row.title,
      aliases,
      kind,
      company,
      role: d.role,
      relationship: d.relationship,
      tier: person?.tier,
      last_contact: person?.last_seen ? localDate(person.last_seen, w.ctx.tz) : d.last_date,
      phones,
      emails,
    },
    tags: ['person', kind && kind !== 'person' && kind !== 'contact' ? slugTag(kind) : null],
    sections: [
      sec(w, 'summary', lines(w.field('relationship', d.relationship && w.linkify(ensureSentence(d.relationship), row.id)), w.field('company', company), w.field('role', d.role), w.field('topics', (d.topics ?? []).join(', '))), null),
      sec(w, 'open', w.openLines(open), 'open', w.tr('nothing_open')),
      sec(w, 'timeline', w.timeline(row)),
    ],
  };
}

function companyRender(w, row) {
  const d = row.data;
  const people = w.all('person').filter((p) => p.data.company_id === row.id).map((p) => `- ${w.link(p.id)}${p.data.role ? `, ${p.data.role}` : ''}`);
  const projects = w.all('project').filter((p) => p.data.company_id === row.id).map((p) => `- ${w.link(p.id)} (${w.tr(`status.${p.data.status ?? 'active'}`)})`);
  const open = w.openFor('company', row.id);
  return {
    title: row.title,
    fm: { name: row.title, aliases: (d.aliases ?? []).filter((a) => normalizeName(a) !== normalizeName(row.title)), kind: d.kind },
    tags: ['company', d.kind ? slugTag(d.kind) : null],
    sections: [
      sec(w, 'summary', lines(d.summary ? w.linkify(ensureSentence(d.summary), row.id) : null, w.field('kind', d.kind)), null),
      sec(w, 'people', people.join('\n')),
      sec(w, 'projects', projects.join('\n')),
      sec(w, 'open', w.openLines(open), 'open', w.tr('nothing_open')),
      sec(w, 'timeline', w.timeline(row)),
    ],
  };
}

function projectRender(w, row) {
  const d = row.data;
  const people = linkList(w, d.people);
  const company = w.linkOrName(d, 'company');
  const decisions = w
    .all('decision')
    .filter((x) => x.data.project_id === row.id)
    .sort((a, b) => String(b.data.date).localeCompare(String(a.data.date)) || a.id.localeCompare(b.id))
    .map((x) => `- ${x.data.date}, ${w.link(x.id)}`);
  const open = w.openFor('project', row.id);
  return {
    title: row.title,
    fm: { name: row.title, status: d.status ?? 'active', company: company || undefined, people },
    tags: ['project'],
    sections: [
      sec(w, 'summary', lines(w.field('goal', d.goal && w.linkify(ensureSentence(d.goal), row.id)), w.field('status', w.tr(`status.${d.status ?? 'active'}`)), w.field('company', company), w.field('people', people.join(', '))), null),
      sec(w, 'open', w.openLines(open), 'open', w.tr('nothing_open')),
      sec(w, 'decisions', decisions.join('\n')),
      sec(w, 'timeline', w.timeline(row)),
    ],
  };
}

function meetingRender(w, row) {
  const d = row.data;
  const people = linkList(w, d.people);
  const company = w.linkOrName(d, 'company');
  const project = w.linkOrName(d, 'project');
  const checked = new Set();
  const prior = row.path ? readText(join(w.ctx.vault, row.path)) : null;
  if (prior) for (const m of (readSection(splitNote(prior).body, 'action_items') ?? '').matchAll(/^- \[[xX]\] (.+)$/gm)) checked.add(m[1].trim());
  const actions = (d.action_items ?? []).map((a) => {
    const text = `${w.linkify(`${a.owner ? `${oneLine(a.owner)}: ` : ''}${oneLine(a.text)}`, row.id)}${a.due ? ` (${fill(w.tr('action_due'), { due: a.due })})` : ''}`;
    return `- [${checked.has(text) ? 'x' : ' '}] ${text}`;
  });
  return {
    title: d.title ?? row.title,
    fm: { date: d.date, people, company: company || undefined, project: project || undefined, source: d.source_label },
    tags: ['meeting'],
    sections: [
      sec(w, 'details', lines(w.field('date', d.date), w.field('people', people.join(', ')), w.field('company', company), w.field('project', project), w.field('source', d.source_label)), null),
      sec(w, 'summary', d.summary ? w.linkify(oneLine(d.summary), row.id) : ''),
      sec(w, 'key_points', (d.key_points ?? []).map((k) => `- ${w.linkify(ensureSentence(k), row.id)}`).join('\n')),
      sec(w, 'action_items', actions.join('\n')),
    ],
  };
}

function decisionRender(w, row) {
  const d = row.data;
  const by = linkList(w, d.decided_by);
  const company = w.linkOrName(d, 'company');
  const project = w.linkOrName(d, 'project');
  return {
    title: d.title ?? row.title,
    fm: { date: d.date, project: project || undefined, company: company || undefined, decided_by: by },
    tags: ['decision'],
    sections: [
      sec(w, 'details', lines(w.field('date', d.date), w.field('decided_by', by.join(', ')), w.field('project', project), w.field('company', company), w.field('source', mentions(w, row))), null),
      sec(w, 'why', d.rationale ? w.linkify(ensureSentence(d.rationale), row.id) : ''),
      sec(w, 'against', d.against ? w.linkify(ensureSentence(d.against), row.id) : ''),
    ],
  };
}

function mentions(w, row) {
  return (row.data.mentions ?? [])
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((m) => `${m.date} (${w.label(m.refs, row.id)})`)
    .join(', ');
}

function commitmentRender(w, row) {
  const d = row.data;
  const counterpart = w.linkOrName(d, 'counterpart');
  const company = w.linkOrName(d, 'company');
  const project = w.linkOrName(d, 'project');
  return {
    title: row.title,
    fm: {
      direction: d.direction,
      counterpart: counterpart || undefined,
      company: company || undefined,
      project: project || undefined,
      due: d.due,
      status: d.status ?? 'open',
      date: d.date,
      fingerprint: d.fingerprint,
    },
    tags: ['commitment', slugTag(d.direction)],
    sections: [
      sec(w, 'details', lines(w.field('direction', w.tr(`direction.${d.direction}`)), w.field('counterpart', counterpart), w.field('due', d.due), w.field('status', w.tr(`status.${d.status ?? 'open'}`)), w.field('company', company), w.field('project', project)), null),
      sec(w, 'timeline', w.timeline(row)),
    ],
  };
}

function ideaRender(w, row) {
  const d = row.data;
  const people = linkList(w, d.people);
  const project = w.linkOrName(d, 'project');
  return {
    title: row.title,
    fm: { date: d.date, status: d.status ?? 'new', project: project || undefined },
    tags: ['idea'],
    sections: [
      sec(w, 'idea', d.text ? w.linkify(oneLine(d.text), row.id) : ''),
      sec(w, 'details', lines(w.field('people', people.join(', ')), w.field('project', project), w.field('status', w.tr(`status.${d.status ?? 'new'}`)), w.field('source', mentions(w, row))), null),
    ],
  };
}

function opportunityRender(w, row) {
  const d = row.data;
  const counterpart = w.linkOrName(d, 'counterpart');
  const company = w.linkOrName(d, 'company');
  return {
    title: row.title,
    fm: {
      opportunity_type: d.opportunity_type,
      status: d.status ?? 'open',
      counterpart: counterpart || undefined,
      company: company || undefined,
      value: d.value,
      date: d.date,
      next_step: d.next_step,
    },
    tags: ['opportunity', slugTag(d.opportunity_type ?? 'other')],
    sections: [
      sec(w, 'details', lines(w.field('type', w.tr(`opportunity_type.${d.opportunity_type ?? 'other'}`)), w.field('status', w.tr(`status.${d.status ?? 'open'}`)), w.field('counterpart', counterpart), w.field('company', company), w.field('value', d.value), w.field('next_step', d.next_step && ensureSentence(d.next_step))), null),
      sec(w, 'timeline', w.timeline(row)),
    ],
  };
}

function knowledgeRender(w, row) {
  const d = row.data;
  return {
    title: row.title,
    fm: { date: d.date },
    tags: ['knowledge', ...(d.tags ?? []).map(slugTag)],
    sections: [sec(w, 'knowledge', d.text ? w.linkify(String(d.text).trim(), row.id) : ''), sec(w, 'details', w.field('source', mentions(w, row)), null)],
  };
}

const RENDER = {
  person: personRender,
  company: companyRender,
  project: projectRender,
  meeting: meetingRender,
  decision: decisionRender,
  commitment: commitmentRender,
  idea: ideaRender,
  opportunity: opportunityRender,
  knowledge: knowledgeRender,
};

// ---------- undo ----------

// Undo never destroys: whatever is in the vault right now is copied to
// backups/<run>/undone/ before a pre-image replaces it or a created note is
// removed, and notes changed since the run are reported as edited_after.
// Manifest paths are contained in the vault and the backup folder, so an
// edited manifest cannot reach anywhere else.
export function restoreRun(ctx, runId) {
  const dir = join(bPaths(ctx).backups, runId);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const db = bTables(ctx.store);
  const restored = [];
  const editedAfter = [];
  const plan = manifest.files.map((f) => ({ f, abs: insideDir(ctx.vault, f.path), src: f.existed ? insideDir(join(dir, 'files'), f.path) : null }));
  for (const { f, abs, src } of plan) {
    if (existsSync(abs)) {
      const now = readFileSync(abs);
      if (f.after && fileHash(now) !== f.after) editedAfter.push(f.path);
      const keep = insideDir(join(dir, 'undone'), f.path);
      ensureDir(dirname(keep));
      writeFileAtomic(keep, now);
    }
    if (f.existed) {
      ensureDir(dirname(abs));
      writeFileAtomic(abs, readFileSync(src));
    } else if (existsSync(abs)) unlinkSync(abs);
    restored.push(f.path);
  }
  db.exec('BEGIN');
  try {
    for (const [id, before] of Object.entries(manifest.notes ?? {})) {
      if (!before) db.prepare('DELETE FROM b_notes WHERE id = ?').run(id);
      else
        db.prepare(`INSERT INTO b_notes (id, type, path, title, norm, data, created_run, updated_run) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET type = excluded.type, path = excluded.path, title = excluded.title, norm = excluded.norm, data = excluded.data, created_run = excluded.created_run, updated_run = excluded.updated_run`).run(
          before.id,
          before.type,
          before.path,
          before.title,
          before.norm,
          before.data,
          before.created_run,
          before.updated_run,
        );
    }
    db.prepare('DELETE FROM b_items WHERE run_id = ?').run(runId);
    for (const it of manifest.items_before ?? []) db.prepare('UPDATE b_items SET target = ?, section = ?, text = ? WHERE fp = ?').run(it.target, it.section, it.text, it.fp);
    if (manifest.batch?.id) db.prepare('UPDATE b_batches SET status = ?, merged_at = NULL, run_id = NULL WHERE id = ?').run(manifest.batch.status_before && manifest.batch.status_before !== 'merged' ? 'written' : manifest.batch.status_before ?? 'written', manifest.batch.id);
    db.prepare('UPDATE b_runs SET undone_at = ? WHERE id = ?').run(isoNow(ctx), runId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { run_id: runId, restored, edited_after: editedAfter, kept_in: join(dir, 'undone'), manifest };
}

// APFS treats "José" typed as NFC or NFD, and any letter case, as one file
// name, so collisions are checked on this key.
export const pathKey = (name) => String(name).normalize('NFC').toLowerCase();

export const fileHash = (buf) => createHash('sha1').update(buf).digest('hex');

// The absolute path of rel inside root. Throws for absolute paths and for
// anything that climbs out (../), so no manifest or row can point elsewhere.
export function insideDir(root, rel) {
  const base = resolve(root);
  const abs = resolve(base, String(rel));
  if (typeof rel !== 'string' || !rel || isAbsolute(rel) || rel.includes('\0') || (abs !== base && !abs.startsWith(base + sep))) {
    throw new Error(`Refusing a path outside ${base}: ${JSON.stringify(rel)}`);
  }
  return abs;
}
