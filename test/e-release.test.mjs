import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillPrompt, normalizeRepoUrl } from '../scripts/release.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('fillPrompt fills the real CUSTOMER_PROMPT.md placeholders', () => {
  const template = readFileSync(join(REPO_ROOT, 'CUSTOMER_PROMPT.md'), 'utf8');
  const filled = fillPrompt(template, { repoUrl: 'https://github.com/x/confidant', tag: 'v2.0.0', sha: 'deadbeef' });
  assert.match(filled, /clone https:\/\/github\.com\/x\/confidant at tag/);
  assert.match(filled, /\bv2\.0\.0\b/);
  assert.match(filled, /\bdeadbeef\b/);
  assert.doesNotMatch(filled, /\{REPO_URL\}|\{TAG\}|\{SHA\}/, 'no placeholder is left unfilled');
});

test('fillPrompt leaves a visible placeholder for anything not provided, rather than silently blanking it', () => {
  const filled = fillPrompt('clone {REPO_URL} at {TAG} ({SHA})', {});
  assert.equal(filled, 'clone {REPO_URL} at {TAG} ({SHA})');
});

test('normalizeRepoUrl turns an ssh remote into a plain https URL', () => {
  assert.equal(normalizeRepoUrl('git@github.com:QWaveLabs/confidant.git'), 'https://github.com/QWaveLabs/confidant');
  assert.equal(normalizeRepoUrl('https://github.com/QWaveLabs/confidant.git'), 'https://github.com/QWaveLabs/confidant');
  assert.equal(normalizeRepoUrl('https://github.com/QWaveLabs/confidant'), 'https://github.com/QWaveLabs/confidant');
  assert.equal(normalizeRepoUrl(null), null);
});
