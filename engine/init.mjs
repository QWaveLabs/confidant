// `confidant init --role <r> --language <en|es> --brief-time HH:MM
//   [--timezone <tz>] [--owner-name <name>] [--owner-email <e> ...]
//   [--exclude-category <c> ...] [--exclude-person <p> ...] [--vault <path>]
//   [--resume]`
// `confidant init --plan` only prints where a new vault would go, and any
// second brain init already found. Neither writes anything.
//
// The one rule that matters more than any flag: an install never writes
// into a folder that is not already a Confidant vault, unless --resume says
// so. A brand new vault always gets its own new folder.
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ensureDir, readJson, writeJson, writeFileAtomic } from './lib/files.mjs';
import {
  statePaths, planNewVaultPath, isConfidantVault, findConfidantVaults,
  obsidianVaults, expandHome, REPO_ROOT, DEFAULT_VAULT_NAME,
} from './lib/paths.mjs';
import { FOLDERS, BRIEFS, folderPath } from './lib/folders.mjs';
import { assertValid } from './lib/schema.mjs';
import { systemTimeZone } from './lib/time.mjs';
import { t } from './lib/i18n.mjs';

const PERSONA_ROLES = ['founder', 'agency', 'consultant', 'investor', 'sales', 'executive', 'recruiter'];
// Everything a scheduled task needs, copied into the vault so it never
// depends on the installer's own clone still being on disk.
const ENGINE_COPY = ['bin', 'engine', 'schemas', 'prompts', 'personas', 'i18n', 'templates', '.agents'];

function loadPersona(role) {
  return readJson(join(REPO_ROOT, 'personas', `${role}.json`), null);
}

// The vault path init will use, and what it found already there. A pure
// function so tests can pass their own `home` without touching the real
// one; `run()` below is the only caller that lets it default to the OS home.
export function resolveVaultPath({ vaultFlag, language = 'en', resume = false, home } = {}) {
  if (vaultFlag) return resolve(expandHome(String(vaultFlag)));
  if (resume) {
    const found = findConfidantVaults({ home });
    if (found.length) return found[0];
  }
  return planNewVaultPath({ language, home });
}

function copyEngine(vaultEngineDir) {
  ensureDir(vaultEngineDir);
  for (const name of ENGINE_COPY) {
    const src = join(REPO_ROOT, name);
    if (existsSync(src)) cpSync(src, join(vaultEngineDir, name), { recursive: true });
  }
}

function copyAgentSkills(vault) {
  const src = join(REPO_ROOT, '.agents', 'skills');
  if (!existsSync(src)) return;
  const dest = join(vault, '.agents', 'skills');
  ensureDir(dest);
  for (const name of ['confidant-agents', 'confidant-sort']) {
    const from = join(src, name);
    if (existsSync(from)) cpSync(from, join(dest, name), { recursive: true });
  }
}

function createFolders(vault, lang, persona) {
  for (const f of FOLDERS) ensureDir(join(vault, folderPath(f.key, lang)));
  ensureDir(join(vault, folderPath(BRIEFS.key, lang)));
  for (const sub of persona?.subfolders ?? []) {
    ensureDir(join(vault, folderPath(sub.folder, lang, sub.name?.[lang] ?? sub.name?.en)));
  }
}

function writeHomeIfAbsent(vault, lang) {
  const dest = join(vault, 'Home.md');
  if (existsSync(dest)) return;
  const strings = t('vault', lang);
  const title = DEFAULT_VAULT_NAME[lang] ?? DEFAULT_VAULT_NAME.en;
  writeFileAtomic(dest, `# ${title}\n\n${strings('home.body')}\n`);
}

// A fixed, language-independent file: what Obsidian should never show in
// the file explorer or search.
function writeObsidianConfigIfAbsent(vault) {
  const dest = join(vault, '.obsidian', 'app.json');
  if (existsSync(dest)) return;
  const src = join(REPO_ROOT, 'templates', 'vault', 'obsidian-app.json');
  ensureDir(join(vault, '.obsidian'));
  writeFileAtomic(dest, readFileSync(src, 'utf8'));
}

function writeVaultAgentsIfAbsent(vault, lang) {
  const dest = join(vault, 'AGENTS.md');
  if (existsSync(dest)) return;
  const src = join(REPO_ROOT, 'templates', 'vault', `AGENTS.${lang === 'es' ? 'es' : 'en'}.md`);
  writeFileAtomic(dest, readFileSync(src, 'utf8'));
}

// A random id for support and feedback reports only (schemas/config.schema.json
// wants 16 to 40 lowercase alphanumerics; 24 matches the other short ids
// this codebase already uses).
function generateInstallId(len = 24) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function buildConfig(args, vault, language, role) {
  const owner = {};
  if (args.ownerName) owner.name = String(args.ownerName);
  const emails = [].concat(args.ownerEmail ?? []).filter(Boolean).map(String);
  if (emails.length) owner.emails = emails;

  const exclusions = {};
  const categories = [].concat(args.excludeCategory ?? []).filter(Boolean).map(String);
  if (categories.length) exclusions.categories = categories;
  const people = [].concat(args.excludePerson ?? []).filter(Boolean).map(String);
  if (people.length) exclusions.people = people;

  const config = {
    version: 1,
    vault,
    language,
    role,
    briefTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(args.briefTime ?? '')) ? args.briefTime : '06:45',
    timezone: args.timezone ? String(args.timezone) : systemTimeZone(),
    sources: {},
    installedAt: new Date().toISOString(),
    installId: generateInstallId(),
  };
  if (Object.keys(owner).length) config.owner = owner;
  if (Object.keys(exclusions).length) config.exclusions = exclusions;
  return config;
}

function emptyState() {
  return {
    phase: 'setup',
    history: [{ phase: 'setup', at: new Date().toISOString() }],
    tasks: [],
    backlog: { remaining_batches: 0, oldest_sorted: null, done: false },
    checkins: [],
  };
}

export async function run(args, ctx) {
  const language = args.language === 'es' ? 'es' : 'en';
  const strings = t('vault', language);

  if (args.plan) {
    // `--home` is an internal override, never documented to a person: it
    // exists only so tests can exercise --plan without ever touching the
    // real OS home directory or the real Obsidian registry under it.
    const home = args.home ? resolve(expandHome(String(args.home))) : undefined;
    const registry = home ? join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json') : undefined;
    const vault = planNewVaultPath({ language, home });
    ctx.log.out(
      { vault, existing: findConfidantVaults({ home }), obsidianVaults: obsidianVaults(registry) },
      (v) => [
        strings('wouldCreate', { vault: v.vault }),
        v.existing.length ? `${strings('existingFound')}\n${v.existing.map((p) => `  ${p}`).join('\n')}` : strings('noExisting'),
      ].join('\n'),
    );
    return 0;
  }

  const resume = !!args.resume;
  const vault = resolveVaultPath({ vaultFlag: args.vault, language, resume });
  const existingConfig = readJson(statePaths(vault).config, null);

  if (existsSync(vault) && !isConfidantVault(vault) && !resume) {
    const entries = readdirSync(vault).filter((n) => !n.startsWith('.'));
    if (entries.length) {
      ctx.log.error(strings('refuseOverwrite', { vault }));
      return 6;
    }
  }
  if (resume && !existingConfig) {
    ctx.log.error(strings('resumeMissing', { vault }));
    return 6;
  }

  const role = existingConfig?.role ?? args.role;
  if (!PERSONA_ROLES.includes(role)) {
    ctx.log.error(strings('unknownRole', { roles: PERSONA_ROLES.join(', ') }));
    return 2;
  }
  const persona = loadPersona(role);
  if (!persona) {
    ctx.log.error(strings('missingPersona', { role }));
    return 2;
  }

  const paths = statePaths(vault);
  const effectiveLang = existingConfig?.language ?? language;

  if (!ctx.dryRun) {
    ensureDir(vault);
    createFolders(vault, effectiveLang, persona);
    for (const key of ['exports', 'batches', 'contrib', 'backups', 'digests', 'logs', 'locks', 'tmp']) ensureDir(paths[key]);
  }

  let config = existingConfig;
  if (!config) {
    config = buildConfig(args, vault, language, role);
    assertValid('config', config);
    if (!ctx.dryRun) writeJson(paths.config, config);
  }

  let state = readJson(paths.state, null);
  if (!state) {
    state = emptyState();
    if (!ctx.dryRun) writeJson(paths.state, state);
  }

  if (!ctx.dryRun) {
    copyEngine(paths.engine);
    copyAgentSkills(vault);
    writeVaultAgentsIfAbsent(vault, effectiveLang);
    writeObsidianConfigIfAbsent(vault);
    writeHomeIfAbsent(vault, effectiveLang);
  }

  ctx.log.out(
    { vault, role, language: config.language, resumed: !!existingConfig },
    strings('ready', { vault }),
  );
  return 0;
}
