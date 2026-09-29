// Where and how the scheduled agents' own output lives: Briefs/YYYY-MM-DD.md
// (Resúmenes in Spanish) and the weekly file. Reading here lets a later run
// the same day see what an earlier run already wrote (morning_brief reading
// the Opportunity Scanner section opportunity_scanner wrote 15 minutes
// earlier); writing the file itself is Codex's job, following the prompt.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { folderPath } from './folders.mjs';

export function briefPath(vault, lang, dateStr) {
  return join(vault, folderPath('briefs', lang), `${dateStr}.md`);
}

export function weeklyBriefPath(vault, lang, dateStr, weeklyFileName) {
  const name = weeklyFileName.replace('{date}', dateStr);
  return join(vault, folderPath('briefs', lang), `${name}.md`);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The body text under a "## Heading" in an existing brief file, or null when
// the file or that section does not exist yet.
export function readBriefSection(vault, lang, dateStr, heading) {
  const file = briefPath(vault, lang, dateStr);
  if (!existsSync(file)) return null;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const re = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'm');
  const m = re.exec(`${text}\n`);
  return m ? m[1].trim() || null : null;
}
