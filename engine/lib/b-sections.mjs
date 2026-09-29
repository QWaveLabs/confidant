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

export function splitNote(text) {
  const m = FM.exec(text);
  if (!m) return { fmText: null, body: text, data: {} };
  return { fmText: m[1], body: text.slice(m[0].length), data: parseNote(text).data };
}

// Top-level YAML key blocks in their original order, raw.
function fmBlocks(fmText) {
  const blocks = [];
  let cur = { key: null, lines: [] };
  for (const line of fmText.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_\-]+):/.exec(line);
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

// Our keys are rewritten in place (or appended); the person's keys are kept.
// Keys we own but no longer have a value for are removed.
export function mergeFrontmatter(fmText, ours, ownedKeys) {
  const owned = new Set(ownedKeys);
  if (fmText == null) return stringifyFrontmatter(ours);
  const lines = [];
  const done = new Set();
  let afterOwned = 0;
  for (const b of fmBlocks(fmText)) {
    if (b.key && owned.has(b.key)) {
      if (ours[b.key] !== undefined && !done.has(b.key)) lines.push(serializeKey(b.key, ours[b.key]));
      done.add(b.key);
      afterOwned = lines.length;
    } else lines.push(...b.lines);
  }
  const missing = Object.entries(ours).filter(([k, v]) => v !== undefined && !done.has(k)).map(([k, v]) => serializeKey(k, v));
  lines.splice(afterOwned, 0, ...missing);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return `---\n${lines.join('\n')}\n---\n`;
}
