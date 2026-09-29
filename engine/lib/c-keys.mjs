// API keys live in macOS Keychain, one item per service: service name
// "confidant-<name>", account "confidant". getKey never prints a value.
// `exec` (for the `security` CLI) and `ask` (for the hidden dialog) are
// both injectable, so tests never touch the real Keychain or open a real
// dialog.
import { execFileSync } from 'node:child_process';
import { t } from './i18n.mjs';

export const KEY_NAMES = ['deepgram', 'fathom', 'fireflies', 'granola', 'readai', 'grain', 'tldv'];

const SECURITY = '/usr/bin/security';
const ACCOUNT = 'confidant';
const service = (name) => `confidant-${name}`;

function defaultExec(cmdArgs) {
  try {
    return execFileSync(SECURITY, cmdArgs, { encoding: 'utf8' }).replace(/\n$/, '');
  } catch (err) {
    if (err.status === 44) return null; // security's "item not found" exit code
    throw err;
  }
}

// The Keychain item's password, or null when it does not exist.
export function getKey(name, { exec = defaultExec } = {}) {
  return exec(['find-generic-password', '-s', service(name), '-a', ACCOUNT, '-w']);
}

// Writes (or replaces, -U) the Keychain item directly, without a dialog.
// promptForKey uses this. Extractors that must persist a rotated token
// (Read.ai's refresh token rotates on every use) use it too.
export function setKey(name, value, { exec = defaultExec } = {}) {
  exec(['add-generic-password', '-U', '-s', service(name), '-a', ACCOUNT, '-w', value]);
  return true;
}

function quoteApplescript(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function defaultAsk(prompt, title) {
  const script = `display dialog ${quoteApplescript(prompt)} default answer "" with title ${quoteApplescript(title)} with hidden answer`;
  let out;
  try {
    out = execFileSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8' });
  } catch {
    return null; // the person clicked Cancel, or osascript itself failed
  }
  const m = out.match(/text returned:([\s\S]*)$/);
  return m ? m[1].replace(/\r?\n$/, '') : null;
}

// Shows a hidden native macOS dialog and stores what was typed in Keychain.
// Never prints the value anywhere. Returns false when the person cancels or
// types nothing. `lang` is optional (the contracted signature is
// `promptForKey(name, label)`); the CLI passes ctx.lang for a translated
// prompt, everything else defaults to English.
export async function promptForKey(name, label, { lang = 'en', exec = defaultExec, ask = defaultAsk } = {}) {
  const tr = t('keys', lang);
  const value = ask(tr('prompt', { label }), 'Confidant');
  const trimmed = value == null ? '' : String(value).trim();
  if (!trimmed) return false;
  setKey(name, trimmed, { exec });
  return true;
}
