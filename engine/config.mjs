// `confidant config <sandbox|trust|wake|login-item|source> ...`
// Sandbox, trust, wake schedule and login item setup, plus recording a
// source's real status in config.json. Every subcommand supports --dry-run
// and prints exactly what it will change before it changes anything.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ensureDir, writeFileAtomic } from './lib/files.mjs';
import { HOME, expandHome } from './lib/paths.mjs';
import { getSource } from './lib/sources.mjs';
import { assertValid } from './lib/schema.mjs';
import { buildSandboxToml, hasTrustedProject, appendTrustedProject } from './lib/e-toml.mjs';

const STATUSES = ['connected', 'partial', 'skipped', 'blocked', 'unused'];

// --- sandbox ------------------------------------------------------------

function runSandbox(args, ctx) {
  const network = args.network === 'off' ? false : true;
  const text = buildSandboxToml({ network });
  const path = join(ctx.vault, '.codex', 'config.toml');
  if (!ctx.dryRun) {
    ensureDir(join(ctx.vault, '.codex'));
    writeFileAtomic(path, text);
  }
  const result = { path, network, written: !ctx.dryRun, text };
  ctx.log.out(result, () => `${ctx.dryRun ? 'Would write' : 'Wrote'} ${path}\n\n${text}`);
  return 0;
}

// --- trust ----------------------------------------------------------------

function runTrust(args, ctx, { home = HOME } = {}) {
  const homeConfigPath = join(expandHome(home), '.codex', 'config.toml');
  const before = existsSync(homeConfigPath) ? readFileSync(homeConfigPath, 'utf8') : '';
  const { text: after, changed } = appendTrustedProject(before, ctx.vault);
  const willWrite = changed && !!args.yes && !ctx.dryRun;
  let backupPath = null;
  if (willWrite) {
    ensureDir(join(expandHome(home), '.codex'));
    if (existsSync(homeConfigPath)) {
      backupPath = `${homeConfigPath}.confidant-${Date.now()}.bak`;
      writeFileSync(backupPath, before);
    }
    writeFileSync(homeConfigPath, after);
  }
  const diff = changed ? after.slice(before.length) : '';
  const result = { path: homeConfigPath, alreadyTrusted: !changed, wouldChange: changed, written: willWrite, backupPath, diff };
  ctx.log.out(result, () => {
    if (!changed) return `${ctx.vault} is already trusted in ${homeConfigPath}.\n`;
    if (!willWrite) return `Would add to ${homeConfigPath} (pass --yes to write):\n${diff}`;
    return `Trusted ${ctx.vault} in ${homeConfigPath} (backup: ${backupPath}).\n${diff}`;
  });
  return 0;
}

// --- wake -------------------------------------------------------------

function minutesBefore(time, minutes) {
  const [h, m] = String(time).split(':').map(Number);
  const total = ((h * 60 + m - minutes) % (24 * 60) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// time must already be a strict HH:MM (24h) string: it's interpolated into
// a shell string for `osascript ... do shell script`, so anything looser
// than this pattern is refused rather than risk building a bad command.
const STRICT_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function buildWakeCommand(time) {
  if (!STRICT_TIME.test(time)) throw new Error(`Refusing to build a wake command for an invalid time: ${JSON.stringify(time)}`);
  const pmset = `pmset repeat wakeorpoweron MTWRFSU ${time}:00`;
  return { pmset, osascript: ['-e', `do shell script "${pmset}" with administrator privileges`] };
}

function runWake(args, ctx, { exec = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8' }) } = {}) {
  const briefTime = args.time ?? ctx.config?.briefTime ?? '06:45';
  const wakeTime = minutesBefore(briefTime, 15);
  const { pmset, osascript } = buildWakeCommand(wakeTime);
  const willRun = !!args.yes && !ctx.dryRun;
  let verified = null;
  if (willRun) {
    exec('osascript', osascript);
    try {
      verified = exec('pmset', ['-g', 'sched']).includes(wakeTime);
    } catch {
      verified = null;
    }
  }
  const result = { briefTime, wakeTime, command: pmset, ran: willRun, verified };
  ctx.log.out(result, () => (willRun
    ? `Set wake at ${wakeTime} (15 minutes before your ${briefTime} brief). Verified: ${verified ? 'yes' : 'could not confirm'}.\n`
    : `Would run (asks for your Mac password): ${pmset}\n`));
  return 0;
}

// --- login-item ---------------------------------------------------------

export function buildLoginItemCommand(appPath = '/Applications/ChatGPT.app') {
  return ['-e', `tell application "System Events" to make login item at end with properties {path:"${appPath}", hidden:false}`];
}

function runLoginItem(args, ctx, { exec = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8' }) } = {}) {
  const script = buildLoginItemCommand();
  const willRun = !!args.yes && !ctx.dryRun;
  if (willRun) exec('osascript', script);
  const result = { ran: willRun, appPath: '/Applications/ChatGPT.app' };
  ctx.log.out(result, () => (willRun ? 'Added ChatGPT as a login item.\n' : 'Would add ChatGPT as a login item.\n'));
  return 0;
}

// --- source ---------------------------------------------------------------

function runSource(args, ctx) {
  const id = args.id;
  const status = args.status;
  if (!id || !getSource(id)) {
    ctx.log.error(`Unknown source id "${id}".`);
    return 2;
  }
  if (!STATUSES.includes(status)) {
    ctx.log.error(`--status must be one of ${STATUSES.join(', ')}.`);
    return 2;
  }
  const existing = ctx.config.sources?.[id] ?? {};
  const enabled = args.enabled != null ? args.enabled === 'true' || args.enabled === true : (status === 'connected' || status === 'partial');
  const entry = { enabled, status, since: existing.since ?? new Date().toISOString() };
  if (args.note) entry.note = args.note;
  else if (existing.note) entry.note = existing.note;
  const next = { ...ctx.config, sources: { ...ctx.config.sources, [id]: entry } };
  assertValid('config', next);
  if (!ctx.dryRun) ctx.saveConfig(next);
  ctx.log.out({ id, ...entry }, () => `${id}: ${status}${entry.note ? ` (${entry.note})` : ''}\n`);
  return 0;
}

export async function run(args, ctx, deps = {}) {
  const sub = args._[0];
  switch (sub) {
    case 'sandbox': return runSandbox(args, ctx);
    case 'trust': return runTrust(args, ctx, deps);
    case 'wake': return runWake(args, ctx, deps);
    case 'login-item': return runLoginItem(args, ctx, deps);
    case 'source': return runSource(args, ctx);
    default:
      ctx.log.error(`Unknown "confidant config ${sub ?? ''}". Use sandbox, trust, wake, login-item or source.`);
      return 2;
  }
}
