// The ctx object every command and extractor receives.
//   { vault, paths, config, state, store, log, lang, tz, now, dryRun, json, saveState(), saveConfig() }
// store opens lazily so commands that never touch the database stay fast.
import { readJson, writeJson, ensureDir } from './files.mjs';
import { statePaths } from './paths.mjs';
import { openStore } from './store.mjs';
import { systemTimeZone } from './time.mjs';

export function createLog({ json = false, quiet = false } = {}) {
  const write = (level, msg) => {
    if (quiet && level === 'info') return;
    process.stderr.write(`${level === 'info' ? '' : `${level}: `}${msg}\n`);
  };
  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    // Final command output: JSON when --json, otherwise the human text.
    out(value, human) {
      if (json || human == null) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      else process.stdout.write(`${typeof human === 'function' ? human(value) : human}\n`);
    },
  };
}

export function createContext({ vault, dryRun = false, json = false, quiet = false, now = new Date() } = {}) {
  const log = createLog({ json, quiet });
  const paths = vault ? statePaths(vault) : null;
  const config = paths ? readJson(paths.config, null) : null;
  const state = paths ? readJson(paths.state, { phase: 'start', history: [] }) : null;
  let store = null;
  const ctx = {
    vault,
    paths,
    config,
    state,
    log,
    dryRun,
    json,
    now,
    lang: config?.language ?? 'en',
    tz: config?.timezone ?? systemTimeZone(),
    get store() {
      if (!store) {
        if (!paths) throw new Error('No vault. Run `confidant init` first or pass --vault.');
        store = openStore(paths);
      }
      return store;
    },
    saveConfig(next = ctx.config) {
      ctx.config = next;
      if (!dryRun) writeJson(paths.config, next);
    },
    saveState(next = ctx.state) {
      ctx.state = next;
      if (!dryRun) writeJson(paths.state, next);
    },
    tmpDir() {
      return ensureDir(paths.tmp);
    },
    close() {
      store?.close();
      store = null;
    },
  };
  return ctx;
}
