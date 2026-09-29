// Where things live: the vault, its hidden .confidant state folder, and the
// rule that an install never writes into a second brain it did not create.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = homedir();
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const STATE_DIRNAME = '.confidant';
export const DEFAULT_VAULT_NAME = { en: 'Second Brain', es: 'Segundo cerebro' };
export const OBSIDIAN_REGISTRY = join(HOME, 'Library/Application Support/obsidian/obsidian.json');

export function expandHome(p) {
  return p.replace(/^~(?=$|\/)/, HOME);
}

export function statePaths(vault) {
  const root = join(vault, STATE_DIRNAME);
  return {
    vault,
    root,
    config: join(root, 'config.json'),
    state: join(root, 'state.json'),
    db: join(root, 'brain.db'),
    tmp: join(root, 'tmp'),
    exports: join(root, 'exports'),
    batches: join(root, 'batches'),
    contrib: join(root, 'contrib'),
    backups: join(root, 'backups'),
    digests: join(root, 'digests'),
    logs: join(root, 'logs'),
    locks: join(root, 'locks'),
    engine: join(root, 'engine'),
  };
}

export function isConfidantVault(dir) {
  return existsSync(join(dir, STATE_DIRNAME, 'config.json'));
}

// Obsidian's own list of vaults the person has opened.
export function obsidianVaults(registry = OBSIDIAN_REGISTRY) {
  try {
    const data = JSON.parse(readFileSync(registry, 'utf8'));
    return Object.entries(data.vaults ?? {}).map(([id, v]) => ({ id, path: v.path, open: !!v.open }));
  } catch {
    return [];
  }
}

export function findConfidantVaults({ registry, home = HOME } = {}) {
  const candidates = new Set(obsidianVaults(registry).map((v) => v.path));
  for (const name of Object.values(DEFAULT_VAULT_NAME)) {
    candidates.add(join(home, name));
    for (let n = 2; n <= 9; n++) candidates.add(join(home, `${name} ${n}`));
  }
  return [...candidates].filter((p) => p && isConfidantVault(p));
}

// A new install always gets a brand new folder. If the person already has a
// second brain (any existing folder at the default path, Confidant or not),
// we pick the next free name instead of touching it.
export function planNewVaultPath({ language = 'en', home = HOME, name } = {}) {
  const base = name ?? DEFAULT_VAULT_NAME[language] ?? DEFAULT_VAULT_NAME.en;
  let candidate = join(home, base);
  for (let n = 2; existsSync(candidate); n++) candidate = join(home, `${base} ${n}`);
  return candidate;
}

// Finds the vault for commands that need one: explicit flag, env, the current
// folder (scheduled tasks run inside the vault), or the only Confidant vault.
export function resolveVault({ flag, env = process.env, cwd = process.cwd() } = {}) {
  if (flag) return resolve(expandHome(String(flag)));
  if (env.CONFIDANT_VAULT) return resolve(expandHome(env.CONFIDANT_VAULT));
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (isConfidantVault(d)) return d;
    if (d === dirname(d)) break;
  }
  const found = findConfidantVaults();
  return found.length === 1 ? found[0] : null;
}
