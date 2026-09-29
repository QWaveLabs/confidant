// Reads the notes Unit B's sorter already wrote, for the scheduled-task
// digests. Read-only: never touches a note's prose, never writes one back.
// Frontmatter contract lives in CONTRACTS.md ("Note frontmatter").
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseNote } from './frontmatter.mjs';
import { t } from './i18n.mjs';

const SKIP_DIRS = new Set(['.confidant', '.agents', '.obsidian', '.git']);

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(full);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      yield full;
    }
  }
}

// Every note in the vault (any of the nine folders, any persona subfolder),
// parsed with its frontmatter. Skips Home.md and anything with no `type`
// (so AGENTS.md, a stray file, or a note mid-write never breaks a digest).
export function listNotes(vault) {
  const out = [];
  for (const file of walk(vault)) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const { data, body } = parseNote(text);
    if (!data.type) continue;
    out.push({ path: relative(vault, file), data, body });
  }
  return out;
}

export function notesOfType(vault, type) {
  return listNotes(vault).filter((n) => n.data.type === type);
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Dated bullets under the Timeline section in a note's body, newest first,
// exactly as merge.mjs (B) writes them: "- 2026-09-01, text. _(Source)_".
// The heading itself is localized (i18n/notes.*.json's headings.timeline:
// "Timeline" in English, "Cronología" in Spanish); this reads that heading
// for `lang` and always also accepts the English spelling, so a note
// carried over from a language change still parses.
export function timelineBullets(body, lang = 'en', limit = 5) {
  const localized = t('notes', lang)('headings.timeline');
  const headings = [...new Set([localized, 'Timeline'].filter(Boolean))].map(escapeRegExp).join('|');
  const re = new RegExp(`^##\\s*(?:${headings})\\s*$([\\s\\S]*?)(?=^##\\s|\\s*$(?!\\s))`, 'm');
  const m = re.exec(`${body}\n`);
  const section = m ? m[1] : body;
  const bullets = [];
  for (const line of section.split('\n')) {
    const b = /^-\s+(\d{4}-\d{2}-\d{2}),\s*(.+)$/.exec(line.trim());
    if (b) bullets.push({ date: b[1], text: b[2] });
    if (bullets.length >= limit) break;
  }
  return bullets;
}

const clean = (name) => String(name ?? '').replace(/^\[\[|\]\]$/g, '').trim().toLowerCase();

// True when a note's field (a name, or "[[Name]]", or a list of either)
// refers to `personName`.
export function mentionsPerson(field, personName) {
  if (!field || !personName) return false;
  const target = clean(personName);
  const values = Array.isArray(field) ? field : [field];
  return values.some((v) => clean(v) === target);
}
