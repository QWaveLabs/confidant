// welcome.mjs writes the one artifact a customer actually sees. These tests
// check it stays self-contained (no remote asset URLs), shows the real
// schedule from state.json rather than a guess, escapes every dynamic
// value, and picks the right filename per language.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderGuide, run } from '../engine/welcome.mjs';
import { createContext } from '../engine/lib/context.mjs';

function fixtureVault({ lang = 'en', exclusions = {}, tasks = [] } = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'cf-welcome-vault-'));
  mkdirSync(join(vault, '.confidant'), { recursive: true });
  writeFileSync(join(vault, '.confidant', 'config.json'), JSON.stringify({
    version: 1, vault, language: lang, role: 'founder', briefTime: '06:45', timezone: 'America/New_York',
    exclusions,
    sources: { imessage: { enabled: true, status: 'connected' }, gmail: { enabled: true, status: 'connected' } },
  }));
  writeFileSync(join(vault, '.confidant', 'state.json'), JSON.stringify({ phase: 'tasks', history: [], tasks }));
  return createContext({ vault, dryRun: true, json: true });
}

test('the guide is self-contained: no http(s) asset URLs, and only the brand svg is inline', () => {
  const ctx = fixtureVault();
  const { html } = renderGuide(ctx);
  assert.equal(/https?:\/\//.test(html), false, 'no remote script, style, image or link target');
  assert.match(html, /<svg/, 'the logo is inlined, not loaded from a file');
  assert.doesNotMatch(html, /<script/, 'no scripts are required to render the page');
  ctx.close();
});

test('shows the real created task time, not the generic default, and marks the rest as not scheduled yet', () => {
  const tasks = [{ key: 'brain_update', name: 'Commitment Tracker + Brain Update', rrule: 'FREQ=HOURLY;INTERVAL=3', automation_id: 'a1', created_at: '2026-09-01T00:00:00Z' }];
  const ctx = fixtureVault({ tasks });
  const { html } = renderGuide(ctx);
  assert.match(html, /Commitment Tracker \+ Brain Update[\s\S]{0,80}Every 3 hours, on the hour/);
  assert.match(html, /Not scheduled yet/);
  assert.match(html, /Planned: Weekdays at 06:45/, 'Morning Chief of Staff has no real task yet, so it shows the computed default');
  ctx.close();
});

test('escapes exclusion names and other free text before they reach the page', () => {
  const ctx = fixtureVault({ exclusions: { categories: ['banking'], people: ['<b>Uncle Bob</b> & "The Boss"'] } });
  const { html } = renderGuide(ctx);
  assert.doesNotMatch(html, /<b>Uncle Bob<\/b>/);
  assert.match(html, /&lt;b&gt;Uncle Bob&lt;\/b&gt; &amp; &quot;The Boss&quot;/);
  ctx.close();
});

test('includes the support email and picks the right filename per language', () => {
  const en = fixtureVault({ lang: 'en' });
  const guideEn = renderGuide(en);
  assert.match(guideEn.html, /support@meetconfidant\.com/);
  assert.equal(guideEn.path.endsWith('Confidant Guide.html'), true);
  en.close();

  const es = fixtureVault({ lang: 'es' });
  const guideEs = renderGuide(es);
  assert.match(guideEs.html, /support@meetconfidant\.com/);
  assert.equal(guideEs.path.endsWith('Guía de Confidant.html'), true);
  assert.match(guideEs.html, /Confidant ya está instalado/);
  es.close();
});

test('run() writes the file and records state.welcome, and --open only shells out when asked', async () => {
  const ctx = fixtureVault();
  ctx.dryRun = false;
  const opens = [];
  const exec = (cmd, args) => opens.push([cmd, args]);

  await run({ _: [] }, ctx, { exec });
  assert.equal(opens.length, 0, 'no --open: nothing is shelled out');
  const path = join(ctx.vault, 'Confidant Guide.html');
  assert.ok(existsSync(path));
  assert.match(readFileSync(path, 'utf8'), /Confidant has been installed/);
  assert.equal(ctx.state.welcome.path, path);
  assert.ok(ctx.state.welcome.at);

  await run({ _: [], open: true }, ctx, { exec });
  assert.equal(opens.length, 1);
  assert.equal(opens[0][0], 'open');
  ctx.close();
});
