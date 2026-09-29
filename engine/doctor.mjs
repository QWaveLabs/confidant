// `confidant doctor [--json]`
// Checks this Mac before or during an install: runtime, disk, Full Disk
// Access, the apps we depend on, existing vaults to resume, and which API
// keys are already in Keychain. Every path is injectable so tests never
// touch Rob's real Mac; see checkSystem's default parameter object.
import { existsSync, readdirSync, readFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { canRead } from './lib/sqlite.mjs';
import { HOME, findConfidantVaults, obsidianVaults, planNewVaultPath } from './lib/paths.mjs';

export const MIN_NODE = { major: 22, minor: 13 };
const KEY_NAMES = ['deepgram', 'fathom', 'fireflies', 'granola', 'readai', 'grain', 'tldv'];

function nodeIsRecentEnough(version = process.version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return major > 23 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13);
}

// Reads one <key>Name</key><string>value</string> pair out of an XML plist
// without a plist parser dependency. Returns null if the file or key is
// missing, so a moved or renamed app never throws doctor over.
function readPlistString(path, key) {
  try {
    const xml = readFileSync(path, 'utf8');
    const m = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function checkDisk(path, statfs) {
  try {
    const st = statfs(path);
    const freeBytes = Number(st.bavail) * Number(st.bsize);
    const freeGb = Math.round((freeBytes / 1e9) * 10) / 10;
    return { path, freeGb, ok: freeGb >= 20 };
  } catch {
    return { path, freeGb: null, ok: null };
  }
}

// Heuristic: an account "folder" under the newest Library/Mail/V* directory
// that isn't one of Mail's own bookkeeping folders. Good enough to answer
// "has this person set up Mail at all", not an exact account list.
function mailAccountNames(mailRoot) {
  let versions = [];
  try {
    versions = readdirSync(mailRoot).filter((d) => /^V\d+$/.test(d)).sort();
  } catch {
    return [];
  }
  if (!versions.length) return [];
  const latest = join(mailRoot, versions[versions.length - 1]);
  const skip = new Set(['MailData', 'Mailboxes', 'Attachments', '.DS_Store']);
  try {
    return readdirSync(latest, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !skip.has(e.name) && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function checkKeys(loadKeys) {
  const mod = await loadKeys().catch(() => null);
  if (!mod?.getKey) return Object.fromEntries(KEY_NAMES.map((k) => [k, 'unknown']));
  return Object.fromEntries(KEY_NAMES.map((k) => {
    try {
      return [k, !!mod.getKey(k)];
    } catch {
      return [k, 'unknown'];
    }
  }));
}

// The full check. Every I/O boundary is a parameter with a real-Mac default,
// so tests pass a temp home and fake apps and never touch ~/Library.
export async function checkSystem({
  home = HOME,
  language = 'en',
  chatGptApp = '/Applications/ChatGPT.app',
  obsidianApp = '/Applications/Obsidian.app',
  whatsappApp = '/Applications/WhatsApp.app',
  sqlite3Path = '/usr/bin/sqlite3',
  systemVersionPlist = '/System/Library/CoreServices/SystemVersion.plist',
  messagesDb = join(home, 'Library/Messages/chat.db'),
  mailRoot = join(home, 'Library/Mail'),
  diskPath = home,
  statfs = statfsSync,
  loadKeys = () => import('./lib/c-keys.mjs'),
} = {}) {
  const chatGptVersion = readPlistString(join(chatGptApp, 'Contents/Info.plist'), 'CFBundleShortVersionString');
  const mailAccounts = mailAccountNames(mailRoot);
  const messagesAccess = canRead(messagesDb);
  const mailAccess = canRead(mailRoot);

  return {
    node: { version: process.version, path: process.execPath, ok: nodeIsRecentEnough() },
    sqlite3: { path: sqlite3Path, ok: existsSync(sqlite3Path) },
    macos: { version: readPlistString(systemVersionPlist, 'ProductVersion') },
    disk: checkDisk(diskPath, statfs),
    chatgpt: { installed: existsSync(chatGptApp), path: chatGptApp, version: chatGptVersion },
    fullDiskAccess: {
      messages: { ok: messagesAccess.ok, needsFullDiskAccess: !!messagesAccess.needsFullDiskAccess },
      mail: { ok: mailAccess.ok, needsFullDiskAccess: !!mailAccess.needsFullDiskAccess },
    },
    obsidian: { installed: existsSync(obsidianApp), path: obsidianApp },
    vaults: {
      obsidian: obsidianVaults(),
      confidant: findConfidantVaults({ home }),
    },
    planNewVaultPath: planNewVaultPath({ language, home }),
    mail: { accounts: mailAccounts.length, names: mailAccounts },
    whatsapp: { installed: existsSync(whatsappApp) },
    keys: await checkKeys(loadKeys),
  };
}

// This text is read by Codex during the install, not shown verbatim to the
// person, so (like the other engine commands) it stays in plain English
// regardless of ctx.lang.
function humanText(report) {
  const yn = (b) => (b === true ? 'yes' : b === false ? 'no' : 'unknown');
  const lines = [
    `Node ${report.node.version} (${report.node.ok ? 'ok' : 'too old'}) at ${report.node.path}`,
    `sqlite3: ${yn(report.sqlite3.ok)}`,
    `macOS: ${report.macos.version ?? 'unknown'}`,
    `Free disk: ${report.disk.freeGb ?? 'unknown'} GB${report.disk.ok === false ? ' (low, want 20+)' : ''}`,
    `ChatGPT app: ${yn(report.chatgpt.installed)}${report.chatgpt.version ? ` v${report.chatgpt.version}` : ''}`,
    `Full Disk Access, Messages: ${yn(report.fullDiskAccess.messages.ok)}`,
    `Full Disk Access, Mail: ${yn(report.fullDiskAccess.mail.ok)}`,
    `Obsidian installed: ${yn(report.obsidian.installed)}`,
    `Obsidian vaults found: ${report.vaults.obsidian.length}`,
    `Resumable Confidant vaults: ${report.vaults.confidant.length ? report.vaults.confidant.join(', ') : 'none'}`,
    `A new install would create: ${report.planNewVaultPath}`,
    `Mail accounts on this Mac: ${report.mail.accounts}`,
    `WhatsApp for Mac installed: ${yn(report.whatsapp.installed)}`,
    `Keys in Keychain: ${Object.entries(report.keys).map(([k, v]) => `${k}=${yn(v)}`).join(', ')}`,
  ];
  return `${lines.join('\n')}\n`;
}

export async function run(args, ctx) {
  const report = await checkSystem({ language: ctx.lang });
  ctx.log.out(report, humanText);
  return 0;
}
