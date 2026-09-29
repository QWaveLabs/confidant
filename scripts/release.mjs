// Fills CUSTOMER_PROMPT.md's {REPO_URL} {TAG} {SHA} placeholders from the
// current git tag, commit and remote (or from --repo/--tag/--sha flags),
// prints the result, and writes it to dist/customer-prompt.txt.
//
//   sh bin/node scripts/release.mjs
//   sh bin/node scripts/release.mjs --repo https://github.com/x/y --tag v2.0.0 --sha abc123
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fill } from '../engine/lib/i18n.mjs';
import { writeFileAtomic } from '../engine/lib/files.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function git(args, exec) {
  try {
    // stdio: silence git's own stderr (e.g. "no tag" on an untagged commit)
    // so a missing tag doesn't look like a script failure; we handle it below.
    return exec('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// Normalizes a git remote URL (ssh or .git-suffixed) to a plain https URL,
// since that's what a customer's Codex clone command should use.
export function normalizeRepoUrl(url) {
  if (!url) return url;
  let out = url.trim();
  const ssh = out.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (ssh) out = `https://${ssh[1]}/${ssh[2]}`;
  out = out.replace(/\.git$/, '');
  return out;
}

export function detectGitInfo({ exec = execFileSync } = {}) {
  const sha = git(['rev-parse', 'HEAD'], exec);
  const tag = git(['describe', '--tags', '--exact-match'], exec) ?? git(['rev-parse', '--short', 'HEAD'], exec);
  const remote = normalizeRepoUrl(git(['remote', 'get-url', 'origin'], exec));
  return { sha, tag, repoUrl: remote };
}

// Pure: fills the template with {REPO_URL} {TAG} {SHA}. Kept separate from
// any file or git I/O so it's trivial to test.
export function fillPrompt(template, { repoUrl, tag, sha }) {
  return fill(template, { REPO_URL: repoUrl ?? '{REPO_URL}', TAG: tag ?? '{TAG}', SHA: sha ?? '{SHA}' });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repoUrl = argv[++i];
    else if (a === '--tag') out.tag = argv[++i];
    else if (a === '--sha') out.sha = argv[++i];
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const overrides = parseArgs(argv);
  const needsGit = !overrides.repoUrl || !overrides.tag || !overrides.sha;
  const detected = needsGit ? detectGitInfo() : {};
  const info = { ...detected, ...overrides };
  const missing = ['repoUrl', 'tag', 'sha'].filter((k) => !info[k]);
  if (missing.length) {
    process.stderr.write(`release: could not determine ${missing.join(', ')}. Pass --repo, --tag and/or --sha, or run this from a tagged git checkout.\n`);
    return 1;
  }
  const templatePath = join(REPO_ROOT, 'CUSTOMER_PROMPT.md');
  const template = readFileSync(templatePath, 'utf8');
  const filled = fillPrompt(template, info);
  const outPath = join(REPO_ROOT, 'dist', 'customer-prompt.txt');
  writeFileAtomic(outPath, filled);
  process.stdout.write(`${filled}\n`);
  process.stderr.write(`\nWrote ${outPath}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code));
}
