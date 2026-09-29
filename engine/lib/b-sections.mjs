// Managed sections and frontmatter merging. Generated content lives between
//   <!-- confidant:start <name> -->  and  <!-- confidant:end <name> -->
// Everything outside those markers, and every frontmatter key we do not
// write, belongs to the person and is kept byte for byte.
import { stringifyFrontmatter, parseNote } from './frontmatter.mjs';
import { escapeRegExp } from './b-text.mjs';

export const startMarker = (name) => `<!-- confidant:start ${name} -->`;
export const endMarker = (name) => `<!-- confidant:end ${name} -->`;

export function renderSection(name, content) {
  const inner = String(content ?? '').replace(/\s+$/, '');
  return `${startMarker(name)}\n${inner ? `${inner}\n` : ''}${endMarker(name)}`;
}

function sectionRange(body, name) {
  const re = new RegExp(`${escapeRegExp(startMarker(name))}[\\s\\S]*?${escapeRegExp(endMarker(name))}`);
  const m = re.exec(body);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

export function readSection(body, name) {
  const r = sectionRange(body, name);
  if (!r) return null;
  return body.slice(r.start + startMarker(name).length, r.end - endMarker(name).length).replace(/^\n/, '').replace(/\n$/, '');
}

const block = (s) => `${s.heading ? `## ${s.heading}\n` : ''}${renderSection(s.name, s.content)}`;

// A brand new note: title, then every section that has something to say.
export function composeBody(title, sections) {
  const parts = [`# ${title}`];
  for (const s of sections) if (s.content) parts.push(block(s));
  return `${parts.join('\n\n')}\n`;
}

// Existing note: replace each section in place. A section whose markers are
// missing (new since the note was made, or deleted by the person) goes back in
// its usual position, before the next section we still find.
export function upsertSections(body, sections) {
  let out = body;
  sections.forEach((s, i) => {
    const r = sectionRange(out, s.name);
    if (r) {
      out = out.slice(0, r.start) + renderSection(s.name, s.content || s.empty || '') + out.slice(r.end);
      return;
    }
    // A start marker whose end marker was deleted: put a whole section where
    // the orphan marker was. Lines that followed it stay as the person's own
    // text; matching the orphan against a later end marker would swallow them.
    const orphan = out.indexOf(startMarker(s.name));
    if (orphan >= 0) {
      out = out.slice(0, orphan) + renderSection(s.name, s.content || s.empty || '') + out.slice(orphan + startMarker(s.name).length);
      return;
    }
    if (!s.content) return;
    let insertAt = -1;
    for (const later of sections.slice(i + 1)) {
      const lr = sectionRange(out, later.name);
      if (!lr) continue;
      insertAt = lr.start;
      if (later.heading) {
        const before = out.slice(0, lr.start);
        const h = before.lastIndexOf(`## ${later.heading}\n`);
        if (h >= 0 && before.slice(h + later.heading.length + 4).trim() === '') insertAt = h;
      }
      break;
    }
    if (insertAt >= 0) out = `${out.slice(0, insertAt)}${block(s)}\n\n${out.slice(insertAt)}`;
    else out = `${out.replace(/\s*$/, '')}\n\n${block(s)}\n`;
  });
  return out;
}

// ---------- frontmatter ----------

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function splitNote(raw) {
  // A byte-order mark hides the frontmatter from the pattern below.
  const text = String(raw).replace(/^\uFEFF/, '');
  const m = FM.exec(text);
  if (!m) return { fmText: null, body: text, data: {} };
  return { fmText: m[1], body: text.slice(m[0].length), data: parseNote(text).data };
}

// Top-level YAML key blocks in their original order, raw.
function fmBlocks(fmText) {
  const blocks = [];
  let cur = { key: null, lines: [] };
  for (const line of fmText.split(/\r?\n/)) {
    // Any YAML key: Obsidian properties can hold spaces and accents
    // ("Next call", "próxima_llamada"). List items and indented lines are not keys.
    const m = /^("[^"]*"|'[^']*'|[^\s#\-"':][^:]*?):(?:\s|$)/.exec(line);
    if (m) {
      if (cur.key !== null || cur.lines.length) blocks.push(cur);
      cur = { key: m[1], lines: [line] };
    } else cur.lines.push(line);
  }
  if (cur.key !== null || cur.lines.length) blocks.push(cur);
  return blocks;
}

function serializeKey(key, value) {
  return stringifyFrontmatter({ [key]: value }).replace(/^---\n/, '').replace(/---\n$/, '').replace(/\n$/, '');
}

// Our keys are rewritten in place; a key of ours that is new goes right
// after the one before it in our order. The person's keys are kept as they
// are. Keys we own but no longer have a value for are removed.
export function mergeFrontmatter(fmText, ours, ownedKeys) {
  const owned = new Set(ownedKeys);
  if (fmText == null) return stringifyFrontmatter(ours);
  const out = [];
  const done = new Set();
  for (const b of fmBlocks(fmText)) {
    if (b.key && owned.has(b.key)) {
      if (ours[b.key] !== undefined && !done.has(b.key)) out.push({ key: b.key, lines: [serializeKey(b.key, ours[b.key])] });
      done.add(b.key);
    } else out.push(b);
  }
  const keys = Object.keys(ours).filter((k) => ours[k] !== undefined);
  keys.forEach((k, i) => {
    if (out.some((b) => b.key === k)) return;
    let pos = -1;
    for (let j = i - 1; j >= 0 && pos < 0; j--) pos = out.findIndex((b) => b.key === keys[j]);
    const at = pos >= 0 ? pos + 1 : Math.max(0, out.findIndex((b) => b.key && owned.has(b.key)));
    out.splice(at, 0, { key: k, lines: [serializeKey(k, ours[k])] });
  });
  const lines = out.flatMap((b) => b.lines);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return `---\n${lines.join('\n')}\n---\n`;
}

// The person's own part of a note body: everything except the title line and
// our managed sections (with their headings).
export function personalText(body, headings = []) {
  let out = String(body ?? '').replace(/<!-- confidant:start ([a-z_]+) -->[\s\S]*?<!-- confidant:end \1 -->/g, '');
  for (const h of headings) out = out.replace(new RegExp(`^## ${escapeRegExp(h)}\\s*$`, 'gm'), '');
  return out.replace(/^# .*$/m, '').replace(/\n{3,}/g, '\n\n').trim();
}

// Raw frontmatter blocks for keys we do not own, so they can move with a note.
export function foreignFrontmatter(fmText, ownedKeys) {
  if (fmText == null) return [];
  const owned = new Set(ownedKeys);
  return fmBlocks(fmText).filter((b) => b.key && !owned.has(b.key));
}

export function addFrontmatterBlocks(text, blocks) {
  if (!blocks.length) return text;
  const { fmText, body } = splitNote(text);
  if (fmText == null) return text;
  const have = new Set(fmBlocks(fmText).map((b) => b.key));
  const extra = blocks.filter((b) => !have.has(b.key)).flatMap((b) => b.lines);
  if (!extra.length) return text;
  return `---\n${fmText}\n${extra.join('\n')}\n---\n${body}`;
}
