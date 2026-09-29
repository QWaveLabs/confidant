// `confidant config <sandbox|trust|wake|login-item|source|phase|privacy> ...`
// Sandbox, trust, wake schedule and login item setup, plus recording a
// source's real status in config.json. Every subcommand supports --dry-run
// and prints exactly what it will change before it changes anything.
import { existsSync, readFileSync, appendFileSync, copyFileSync, constants as fsc } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ensureDir, writeFileAtomic } from './lib/files.mjs';
import { HOME, expandHome } from './lib/paths.mjs';
import { getSource } from './lib/sources.mjs';
import { assertValid } from './lib/schema.mjs';
import { buildSandboxToml, hasTrustedProject, appendTrustedProject } from './lib/e-toml.mjs';
import { PHASES } from './lib/f-install.mjs';

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
  const { text: after, changed, conflict = false } = appendTrustedProject(before, ctx.vault);
  const willWrite = changed && !!args.yes && !ctx.dryRun;
  let backupPath = null;
  const diff = changed ? after.slice(before.length) : '';
  if (willWrite) {
    ensureDir(join(expandHome(home), '.codex'));
    if (existsSync(homeConfigPath)) {
      // copyFileSync keeps the original's permissions (it may hold tokens).
      backupPath = `${homeConfigPath}.confidant-${Date.now()}.bak`;
      copyFileSync(homeConfigPath, backupPath, fsc.COPYFILE_EXCL);
    }
    // Append only: whatever the Codex app wrote meanwhile is kept.
    appendFileSync(homeConfigPath, diff);
  }
  const result = { path: homeConfigPath, alreadyTrusted: !changed && !conflict, conflict, wouldChange: changed, written: willWrite, backupPath, diff };
  ctx.log.out(result, () => {
    if (conflict) return `${homeConfigPath} already has a setting for ${ctx.vault}, so nothing was changed. Set trust_level = "trusted" for it there by hand.\n`;
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
  const pmset = `/usr/bin/pmset repeat wakeorpoweron MTWRFSU ${time}:00`;
  return { pmset, osascript: ['-e', `do shell script "${pmset}" with administrator privileges`] };
}

// pmset -g sched prints 12-hour times ("6:30AM"); accept either spelling.
export function schedMentions(output, time) {
  const [h, m] = time.split(':').map(Number);
  const twelve = `${h % 12 || 12}:${String(m).padStart(2, '0')}${h < 12 ? 'AM' : 'PM'}`;
  const text = String(output ?? '').toUpperCase().replace(/\s+(AM|PM)/g, '$1');
  return text.includes(time) || text.includes(twelve);
}

function runWake(args, ctx, { exec = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8' }) } = {}) {
  const briefTime = args.time ?? ctx.config?.briefTime ?? '06:45';
  if (!STRICT_TIME.test(String(briefTime))) {
    ctx.log.error(`The brief time must look like 07:30 (24-hour), not ${JSON.stringify(briefTime)}.`);
    return 2;
  }
  const wakeTime = minutesBefore(briefTime, 15);
  const { pmset, osascript } = buildWakeCommand(wakeTime);
  const willRun = !!args.yes && !ctx.dryRun;
  let verified = null;
  if (willRun) {
    exec('/usr/bin/osascript', osascript);
    try {
      verified = schedMentions(exec('/usr/bin/pmset', ['-g', 'sched']), wakeTime);
    } catch {
      verified = null;
    }
  }
  const result = { briefTime, wakeTime, command: pmset, ran: willRun, verified };
  ctx.log.out(result, () => (willRun
    ? `Set wake at ${wakeTime} (15 minutes before your ${briefTime} brief). Verified: ${verified ? 'yes' : 'could not confirm'}.\n`
    : `Would run (asks for your Mac password): ${pmset}\nThis replaces any repeating wake or power-on schedule already set on this Mac.\n`));
  return 0;
}

// --- login-item ---------------------------------------------------------

export function buildLoginItemCommand(appPath = '/Applications/ChatGPT.app') {
  return ['-e', `tell application "System Events" to make login item at end with properties {path:"${appPath}", hidden:false}`];
}

function runLoginItem(args, ctx, { exec = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8' }) } = {}) {
  const script = buildLoginItemCommand();
  const willRun = !!args.yes && !ctx.dryRun;
  if (willRun) exec('/usr/bin/osascript', script);
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

// --- phase ----------------------------------------------------------------

// Records the install step just finished, so a resumed install (after the
// Full Disk Access relaunch, or a usage limit) knows where to pick up.
function runPhase(args, ctx) {
  const phase = args._[1];
  if (!PHASES.includes(phase)) {
    ctx.log.error(`Use: confidant config phase <${PHASES.join('|')}>`);
    return 2;
  }
  const state = ctx.state ?? { phase: 'start', history: [] };
  const next = { ...state, phase, history: [...(state.history ?? []), { phase, at: new Date().toISOString() }] };
  if (!ctx.dryRun) {
    ctx.state = next;
    ctx.saveState();
  }
  ctx.log.out({ phase }, () => `Install step recorded: ${phase}\n`);
  return 0;
}

// --- privacy ------------------------------------------------------------

// What the person said about ChatGPT's "Improve the model for everyone"
// setting: off (they turned it off), workspace (a Business, Enterprise or
// Edu workspace, not trained on by default), or on (they chose to keep it).
// Only their answer is recorded; nothing here can read the setting itself.
const TRAINING = ['off', 'workspace', 'on'];

function runPrivacy(args, ctx) {
  const training = args.training;
  if (!TRAINING.includes(training)) {
    ctx.log.error(`Use: confidant config privacy --training <${TRAINING.join('|')}>`);
    return 2;
  }
  const privacy = { training, at: new Date().toISOString() };
  if (!ctx.dryRun) {
    ctx.state = { ...(ctx.state ?? {}), privacy };
    ctx.saveState();
  }
  ctx.log.out(privacy, () => `Model training setting recorded: ${training}\n`);
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
    case 'phase': return runPhase(args, ctx);
    case 'privacy': return runPrivacy(args, ctx);
    default:
      ctx.log.error(`Unknown "confidant config ${sub ?? ''}". Use sandbox, trust, wake, login-item, source, phase or privacy.`);
      return 2;
  }
}
