// welcome.mjs writes the one artifact a customer actually sees. These tests
// check it stays self-contained (no remote asset URLs), shows the real
// schedule from state.json rather than a guess, escapes every dynamic
// value, and picks the right filename per language.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { renderGuide, run } from '../engine/welcome.mjs';
import { createContext } from '../engine/lib/context.mjs';
import { HOME } from '../engine/lib/paths.mjs';

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
  assert.match(html, /Planned: Weekdays at 6:45 AM/, 'Morning Chief of Staff has no real task yet, so it shows the computed default, in 12-hour time');
  assert.doesNotMatch(html, /\b0\d:\d\d\b/, 'no raw, leading-zero 24-hour time (a "06:45" style typo) ever reaches the page');
  ctx.close();
});

test('a brain_update not yet scheduled shows its real every-3-hours-past-the-hour cadence, not "on the hour"', () => {
  const ctx = fixtureVault({ tasks: [] });
  const { html } = renderGuide(ctx);
  assert.match(html, /Planned: Every 3 hours, \d+ minutes past the hour/, 'the brain_update install actually runs at :10 past, not on the hour');
  ctx.close();
});

test('the Obsidian link uses the real absolute path, but the visible vault path has home replaced with ~', () => {
  const vault = join(HOME, `.cf-welcome-tilde-test-${randomUUID()}`);
  mkdirSync(join(vault, '.confidant'), { recursive: true });
  writeFileSync(join(vault, '.confidant', 'config.json'), JSON.stringify({
    version: 1, vault, language: 'en', role: 'founder', briefTime: '06:45', timezone: 'America/New_York', sources: {},
  }));
  writeFileSync(join(vault, '.confidant', 'state.json'), JSON.stringify({ phase: 'tasks', history: [], tasks: [] }));
  const ctx = createContext({ vault, dryRun: true, json: true });
  try {
    const { html } = renderGuide(ctx);
    const tail = vault.slice(HOME.length);
    assert.ok(html.includes(`~${tail}`), 'the visible path is shortened with ~ in place of the home directory');
    assert.ok(!html.includes(vault), 'the raw absolute path never appears as page text');
    assert.match(html, /href="obsidian:\/\/open\?path=/, 'the Obsidian link is an obsidian://open?path= URL');
    assert.ok(html.includes(`path=${encodeURIComponent(vault)}"`), 'the link itself still carries the real, encoded absolute path');
  } finally {
    ctx.close();
    rmSync(vault, { recursive: true, force: true });
  }
});

test('the summary strip shows real counts, the next morning brief, and whether history is still filling in', () => {
  const ctx = fixtureVault({ tasks: [{ key: 'morning_brief', name: 'Morning Chief of Staff', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=6;BYMINUTE=45', automation_id: 'a2' }] });
  ctx.store.upsertRecords([
    { id: 'imessage:1', source: 'imessage', kind: 'message', ts: '2026-09-01T00:00:00Z', text: 'hi', to: [], is_from_me: false },
    { id: 'gmail:1', source: 'gmail', kind: 'email', ts: '2026-09-02T00:00:00Z', text: 'hi', to: [], is_from_me: false },
  ]);
  mkdirSync(join(ctx.vault, 'People'), { recursive: true });
  writeFileSync(join(ctx.vault, 'People', 'Ana.md'), '# Ana');
  const { html } = renderGuide(ctx);
  assert.match(html, /<div class="stats">/);
  assert.match(html, /<span class="stat-value">2<\/span><span class="stat-label">Sources connected<\/span>/, 'both configured sources are status: connected in the fixture');
  assert.match(html, /<span class="stat-value">1<\/span><span class="stat-label">Notes written<\/span>/);
  assert.match(html, /<span class="stat-label">Next morning brief<\/span>/);
  assert.match(html, /\d{1,2}:\d{2} (AM|PM)<\/span><span class="stat-label">Next morning brief/, 'the next brief time is 12-hour, not raw 06:45');
  assert.match(html, /Still filling in your older history/, 'the fixture state has no backlog.done, so history is still filling in');
  ctx.close();
});

test('the "Email the Confidant team" button is a mailto link with a short, sanitized diagnostic summary and no content leak', () => {
  const ctx = fixtureVault({
    exclusions: { people: ['Secret Contact'] },
  });
  ctx.config.sources.gmail = { enabled: false, status: 'blocked', note: 'personal inbox, never send this note' };
  ctx.state.lastUpdate = { at: new Date(ctx.now.getTime() - 3 * 3600 * 1000).toISOString(), inserted: 5, merged: 2 };
  const { html } = renderGuide(ctx);
  const m = html.match(/<a class="button" href="([^"]+)">([^<]+)<\/a>/);
  assert.ok(m, 'the email button is present');
  assert.equal(m[2], 'Email the Confidant team');
  const mailto = m[1].replace(/&amp;/g, '&');
  assert.match(mailto, /^mailto:support@meetconfidant\.com\?subject=/);
  const body = decodeURIComponent(mailto.split('body=')[1]);
  assert.match(body, /Version: /);
  assert.match(body, /macOS: /);
  assert.match(body, /Sources connected: \d/);
  assert.match(body, /Last update: 3 hours ago/);
  assert.match(body, /Known issues: Gmail/);
  assert.ok(!body.includes('personal inbox, never send this note'), 'a source\'s freeform note never reaches the summary');
  assert.ok(!body.includes('Secret Contact'), 'exclusion names never reach the summary');
  assert.ok(!body.includes(ctx.vault), 'the raw absolute vault path never reaches the summary');
  ctx.close();
});

test('the favicon is a self-contained inline SVG data URI, never a request for /favicon.ico', () => {
  const ctx = fixtureVault();
  const { html } = renderGuide(ctx);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+">/);
  assert.doesNotMatch(html, /favicon\.ico/);
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
