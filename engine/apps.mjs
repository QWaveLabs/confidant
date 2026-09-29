// `confidant apps [--json]`
//
// The connected Codex apps (Gmail, Google Calendar, Google Drive, Slack,
// Plaud) this run should refresh, each with the recipe to follow and the
// cursors saved last time. Deterministic code cannot reach these sources:
// only Codex can, through the app's own tools, so the 3-hour Brain Update
// reads this list first, pulls what is new (and one older window of
// history) per the recipe, and hands the records to `confidant ingest`.
// Without this, an app connected at install would never refresh again.
//
// Cursor keys per app, all written by `ingest --cursor-key`:
//   <id>_live    newest item already stored (ISO date or Slack ts): the
//                next run fetches everything newer than this
//   <id>_window  oldest history window already stored: the next backfill
//                step reads the window just before it
//   slack_<channel id>  per-conversation position, Slack only
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/paths.mjs';
import { enabledSources } from './lib/sources.mjs';
import { acquireLock } from './lib/lock.mjs';

const RECIPES = join(REPO_ROOT, '.agents', 'skills', 'confidant-install', 'recipes');

export function connectedApps(ctx) {
  return enabledSources(ctx.config)
    .filter((s) => s.method === 'app')
    .map((s) => {
      const cursors = Object.fromEntries(ctx.store.cursorsWithPrefix(s.id).map((c) => [c.key, { value: c.value, updated_at: c.updated_at }]));
      const recipe = join(RECIPES, `${s.id}.md`);
      return {
        id: s.id,
        label: s.label?.[ctx.lang] ?? s.label?.en ?? s.id,
        status: ctx.config.sources?.[s.id]?.status ?? null,
        recipe: existsSync(recipe) ? recipe : null,
        cursors,
        firstRun: !cursors[`${s.id}_live`],
      };
    });
}

// Another run holding the vault lock is already updating; this one should
// not pull the same apps twice. Taking and releasing the lock is the check.
function vaultLocked(ctx) {
  const lock = acquireLock(ctx.paths, 'vault');
  if (lock.held) return true;
  lock.release();
  return false;
}

function human(v) {
  if (v.locked) return 'Another run is already updating this vault. Skip the apps this time.\n';
  if (!v.apps.length) return 'No Codex apps are connected, so there is nothing to refresh here.\n';
  const lines = v.apps.map((a) => {
    const cursors = Object.entries(a.cursors).map(([k, c]) => `${k}=${c.value}`).join(', ') || 'no cursors yet';
    return `${a.id.padEnd(8)} ${a.label}\n         recipe: ${a.recipe ?? 'missing'}\n         ${cursors}`;
  });
  return `${lines.join('\n')}\nStore records with: ${v.command} ingest --source <id> --file <path> --cursor-key <key> --cursor-value <value>\n`;
}

export async function run(args, ctx) {
  const command = join(REPO_ROOT, 'bin', 'confidant');
  const locked = vaultLocked(ctx);
  const result = { locked, command, apps: locked ? [] : connectedApps(ctx) };
  ctx.log.out(result, human);
  return 0;
}
