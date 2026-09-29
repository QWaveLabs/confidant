// confidant <command> [options]
// Each command lives in its own module exporting `run(args, ctx)`.
// Global options: --vault <path> --json --dry-run --quiet
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, createLog } from './lib/context.mjs';
import { resolveVault } from './lib/paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// needsVault: resolve an existing vault before running.
export const COMMANDS = {
  doctor: { module: './doctor.mjs', needsVault: false, help: 'Check this Mac: runtime, Full Disk Access, apps, keys, Obsidian' },
  init: { module: './init.mjs', needsVault: false, help: 'Create a new vault (never reuses an existing second brain)' },
  chats: { module: './chats.mjs', needsVault: false, help: 'Group chats and most messaged people (names and counts only), to choose exclusions before extracting' },
  extract: { module: './extract/index.mjs', needsVault: true, help: 'Pull new records from local and API sources' },
  ingest: { module: './ingest.mjs', needsVault: true, help: 'Store records Codex read through a connected app' },
  apps: { module: './apps.mjs', needsVault: true, help: 'Connected Codex apps to refresh this run, with their recipes and saved cursors' },
  identity: { module: './identity.mjs', needsVault: true, help: 'Work out who is who across every source' },
  dossiers: { module: './dossiers.mjs', needsVault: true, help: 'Build per-person, per-thread and per-meeting context' },
  batch: { module: './batch.mjs', needsVault: true, help: 'Plan the next sorting batches for Codex' },
  merge: { module: './merge.mjs', needsVault: true, help: 'Validate a sorted batch and write it into notes' },
  mocs: { module: './mocs.mjs', needsVault: true, help: 'Rebuild Home, indexes and Bases views' },
  undo: { module: './undo.mjs', needsVault: true, help: 'Restore notes from before a merge' },
  update: { module: './update.mjs', needsVault: true, help: 'The 3-hour update: extract, identify, plan batches' },
  digest: { module: './digest.mjs', needsVault: true, help: 'Context for one scheduled task run' },
  tasks: { module: './tasks.mjs', needsVault: true, help: 'The scheduled tasks to create for this person' },
  welcome: { module: './welcome.mjs', needsVault: true, help: 'Write the "Confidant has been installed" guide' },
  config: { module: './config.mjs', needsVault: true, help: 'Sandbox, trust, wake schedule and login item setup' },
  keys: { module: './keys.mjs', needsVault: false, help: 'Store or check API keys in Keychain' },
  status: { module: './status.mjs', needsVault: true, help: 'What is connected, counts, backlog, tasks' },
  health: { module: './health.mjs', needsVault: true, help: 'Is everything still working? Sources, keys, last update, disk' },
  cleanup: { module: './cleanup.mjs', needsVault: true, help: 'Find duplicates, broken links and stale items; apply safe fixes' },
  review: { module: './review.mjs', needsVault: true, help: 'Items the sorter was unsure about, for the person to confirm' },
  usage: { module: './usage.mjs', needsVault: true, help: 'How Confidant is being used (counts only) and value delivered' },
  support: { module: './support.mjs', needsVault: false, help: 'Preview or send a sanitized report or feedback to the Confidant team' },
};

// Flags that never take a value, so `--dry-run foo` keeps foo positional.
const BOOLEAN_FLAGS = new Set(['json', 'dryRun', 'quiet', 'probe', 'full', 'help', 'debug', 'force', 'yes', 'finish', 'all', 'checkIn', 'send', 'apply', 'plan', 'resume', 'open', 'includeFinish', 'includeDiagnostics']);

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      let value = eq > 0 ? a.slice(eq + 1) : true;
      if (eq < 0 && !BOOLEAN_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) value = argv[++i];
      if (key in args && key !== '_') args[key] = [].concat(args[key], value);
      else args[key] = value;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function usage() {
  const lines = Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(10)} ${c.help}`);
  return `Usage: confidant <command> [--vault <path>] [--json] [--dry-run]\n\n${lines.join('\n')}`;
}

export async function main(argv = process.argv.slice(2)) {
  const [name, ...rest] = argv;
  const args = parseArgs(rest);
  const log = createLog({ json: !!args.json });
  if (!name || name === 'help' || args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const cmd = COMMANDS[name];
  if (!cmd) {
    log.error(`Unknown command "${name}".\n${usage()}`);
    return 2;
  }
  const modulePath = join(HERE, cmd.module);
  if (!existsSync(modulePath)) {
    log.error(`"${name}" is not built yet (${cmd.module}).`);
    return 3;
  }
  const vault = resolveVault({ flag: args.vault });
  if (cmd.needsVault && !vault) {
    log.error('No Confidant vault found. Run `confidant init`, or pass --vault <path>.');
    return 4;
  }
  const ctx = createContext({ vault, dryRun: !!args.dryRun, json: !!args.json, quiet: !!args.quiet });
  try {
    const mod = await import(modulePath);
    const code = await mod.run(args, ctx);
    return typeof code === 'number' ? code : 0;
  } catch (err) {
    log.error(args.debug ? err.stack : err.message);
    return 1;
  } finally {
    ctx.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code));
}
