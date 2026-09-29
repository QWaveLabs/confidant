// Writes <vault>/.codex/config.toml, and safely appends a trusted-project
// entry to the person's own ~/.codex/config.toml. Confidant owns the whole
// vault file (it can be regenerated from scratch every time), but the home
// file is the person's: we only ever add to it, never rewrite what's there.
//
// Keys verified against learn.chatgpt.com/docs/config-file/config-reference
// (2026-09-28): sandbox_mode, approval_policy, sandbox_workspace_write.*,
// web_search, apps._default.*, apps.<id>.*, projects.<path>.trust_level.
// apps.<id> uses a plain snake_case id (apps.google_drive, apps.gmail),
// confirmed against that reference's own config.toml example.

// Escapes a string for a TOML basic string ("...").
function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const APPS = [
  { id: 'gmail', comment: 'Gmail' },
  { id: 'google_calendar', comment: 'Google Calendar' },
  { id: 'google_drive', comment: 'Google Drive' },
  { id: 'slack', comment: 'Slack' },
];

// Pure function: the exact text `confidant config sandbox` writes. Kept
// separate from any file I/O so it's trivial to snapshot-test.
export function buildSandboxToml({ network = true } = {}) {
  const lines = [
    '# Written by `confidant config sandbox`. Do not hand-edit this file: rerun',
    '# that command instead so it stays in sync with your setup.',
    '',
    '# Codex can read and write files, but only inside this vault.',
    'sandbox_mode = "workspace-write"',
    '',
    '# Once this project is trusted, the scheduled agents run without stopping',
    '# to ask for approval on every routine step.',
    'approval_policy = "never"',
    '',
    '[sandbox_workspace_write]',
    '# No extra folders: the vault itself is already writable as the workspace.',
    'writable_roots = []',
    network
      ? '# On: API sources (Fathom, Fireflies, Deepgram and friends) need the internet.'
      : '# Off: no outbound network access from inside the sandbox.',
    `network_access = ${network ? 'true' : 'false'}`,
    '',
    '# Web search stays off. The agents work from your own history, not the open web.',
    'web_search = "disabled"',
    '',
    '[apps._default]',
    '# Any app you connect later starts read-only until you decide otherwise.',
    'destructive_enabled = false',
    'open_world_enabled = false',
    '',
  ];
  for (const app of APPS) {
    lines.push(`[apps.${app.id}]`);
    lines.push(`# ${app.comment}: block write and destructive tools, and anything`);
    lines.push('# that reaches beyond the connected account (open-world tools).');
    lines.push('destructive_enabled = false');
    lines.push('open_world_enabled = false');
    lines.push('');
  }
  lines.push('# Confidant never needs to click around your screen or browse the open web.');
  lines.push('[browser_use.default_origin_policy]');
  lines.push('access = "deny"');
  lines.push('uploads = "deny"');
  lines.push('downloads = "deny"');
  lines.push('full_cdp_access = "deny"');
  lines.push('');
  lines.push('[computer_use]');
  lines.push('default_app_access = "deny"');
  lines.push('');
  return lines.join('\n');
}

// --- Trust: append-only edits to the person's own ~/.codex/config.toml ---

function projectHeader(absPath) {
  return `[projects.${tomlString(absPath)}]`;
}

// True if this exact project already has trust_level = "trusted" under its
// own [projects."<path>"] table (scanned only within that table's lines, so
// a same-named key elsewhere in the file never causes a false positive).
export function hasTrustedProject(text, absPath) {
  const header = projectHeader(absPath);
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) return false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^\[/.test(line)) break; // next table: this project's block ended
    if (/^trust_level\s*=\s*"trusted"/.test(line)) return true;
  }
  return false;
}

// Returns { text, changed }: text with a trusted-project block appended if
// one wasn't already there. Never rewrites existing lines.
export function appendTrustedProject(text, absPath) {
  if (hasTrustedProject(text, absPath)) return { text, changed: false };
  const sep = text.length && !text.endsWith('\n') ? '\n' : '';
  const block = [
    '',
    '# Added by Confidant so Codex runs this vault\'s .codex/config.toml sandbox',
    '# settings without asking for approval on every step.',
    projectHeader(absPath),
    'trust_level = "trusted"',
    '',
  ].join('\n');
  return { text: `${text}${sep}${block}`, changed: true };
}
