// Scheduled runs show their result in chat, and every connected tool keeps
// refreshing after the install: task spec and verify, `apps`, the live
// cursor `ingest` keeps, `config phase`, and the prompt and recipe
// contracts the scheduled runs and the install skill depend on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createContext } from '../engine/lib/context.mjs';
import { statePaths } from '../engine/lib/paths.mjs';
import { writeJson, readJson } from '../engine/lib/files.mjs';
import { acquireLock } from '../engine/lib/lock.mjs';
import { verifyTasks, run as runTasks } from '../engine/tasks.mjs';
import { connectedApps, run as runApps } from '../engine/apps.mjs';
import { run as runIngest } from '../engine/ingest.mjs';
import { run as runConfig } from '../engine/config.mjs';
import { run as runExtract } from '../engine/extract/index.mjs';
import { buildHealth } from '../engine/health.mjs';
import { fakeCtx } from './c-shared.test.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const NOW = new Date('2026-09-30T14:00:00.000Z');

function vaultCtx({ sources = {}, tasks = [], phase = 'sort', lastUpdate = true } = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'cf-chat-'));
  const paths = statePaths(vault);
  mkdirSync(paths.root, { recursive: true });
  writeJson(paths.config, { version: 1, vault, language: 'en', role: 'founder', briefTime: '06:45', timezone: 'America/New_York', sources });
  writeJson(paths.state, { phase, history: [], tasks, backlog: { remaining_batches: 0, oldest_sorted: null, done: true }, ...(lastUpdate ? { lastUpdate: { at: '2026-09-30T12:00:00.000Z', inserted: 0, merged: 0 } } : {}) });
  return createContext({ vault, now: NOW, json: true, quiet: true });
}

// The columns `automationStatuses` reads, as in the real
// ~/.codex/sqlite/codex-dev.db (checked 2026-09-29, schema only).
function codexDb(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'cf-codex-'));
  const dbPath = join(dir, 'codex-dev.db');
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', next_run_at INTEGER, last_run_at INTEGER, cwds TEXT NOT NULL DEFAULT '[]', rrule TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'cron', notification_policy TEXT)");
  const insert = db.prepare('INSERT INTO automations (id, name, prompt, status, cwds, kind, notification_policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)');
  for (const r of rows) insert.run(r.id, r.name ?? r.id, 'p', r.status ?? 'ACTIVE', JSON.stringify(r.cwds ?? []), r.kind ?? 'cron', r.notification_policy ?? null);
  db.close();
  return { dbPath, tmpDir: dir };
}

const task = (key, id) => ({ key, name: key, rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=7;BYMINUTE=0', automation_id: id, created_at: '2026-09-29T00:00:00.000Z' });

// ---------- tasks verify ----------

test('tasks verify: flags a heartbeat, a paused task, the wrong folder and a deleted one', () => {
  const ctx = vaultCtx({ tasks: [task('morning_brief', 'a1'), task('follow_up_radar', 'a2'), task('weekly_review', 'a3'), task('meeting_prep', 'a4'), task('health_check', 'a5')] });
  const { dbPath, tmpDir } = codexDb([
    { id: 'a1', cwds: [ctx.vault] },
    { id: 'a2', cwds: [ctx.vault], kind: 'heartbeat' },
    { id: 'a3', cwds: [ctx.vault], status: 'PAUSED' },
    { id: 'a4', cwds: ['/Users/someone/Desktop'] },
  ]);
  const v = verifyTasks(ctx, { codexDbPath: dbPath, tmpDir });
  const by = Object.fromEntries(v.tasks.map((t) => [t.key, t]));
  assert.equal(v.reachable, true);
  assert.equal(v.ok, false);
  assert.equal(by.morning_brief.ok, true);
  assert.equal(by.follow_up_radar.problem, 'heartbeat');
  assert.equal(by.weekly_review.problem, 'paused');
  assert.equal(by.meeting_prep.problem, 'wrong_folder');
  assert.equal(by.health_check.problem, 'not_found');
  assert.ok(v.missing.includes('brain_update'));
  assert.ok(!v.missing.includes('finish_sorting'), 'the temporary task is never expected');
  ctx.close();
});

test('tasks verify: every task present, standalone and in the vault is ok', () => {
  const keys = ['brain_update', 'opportunity_scanner', 'morning_brief', 'meeting_prep', 'follow_up_radar', 'weekly_review', 'health_check', 'brain_cleanup', 'check_in'];
  const ctx = vaultCtx({ tasks: keys.map((k, i) => task(k, `id${i}`)) });
  const { dbPath, tmpDir } = codexDb(keys.map((_, i) => ({ id: `id${i}`, cwds: [ctx.vault] })));
  const v = verifyTasks(ctx, { codexDbPath: dbPath, tmpDir });
  assert.equal(v.ok, true);
  assert.deepEqual(v.missing, []);
  ctx.close();
});

test('tasks verify: an unreadable Codex database is "not verified", never "broken"', () => {
  const ctx = vaultCtx({ tasks: [task('morning_brief', 'a1')] });
  const v = verifyTasks(ctx, { codexDbPath: '/nonexistent/codex-dev.db' });
  assert.equal(v.reachable, false);
  assert.equal(v.ok, null);
  ctx.close();
});

test('health flags a task that Codex created as a heartbeat', async () => {
  const ctx = vaultCtx({ tasks: [task('morning_brief', 'a1')] });
  const { dbPath, tmpDir } = codexDb([{ id: 'a1', cwds: [ctx.vault], kind: 'heartbeat' }]);
  const report = await buildHealth(ctx, { codexDbPath: dbPath, tmpDir });
  assert.ok(report.problems.some((p) => p.area === 'task:morning_brief'));
  ctx.close();
});

test('tasks record keeps every automation a split rule created, and forget drops one', async () => {
  const ctx = vaultCtx();
  await runTasks({ _: ['record'], key: 'meeting_prep', id: 'm1', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=7;BYMINUTE=30' }, ctx);
  await runTasks({ _: ['record'], key: 'meeting_prep', id: 'm2', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=12;BYMINUTE=30' }, ctx);
  await runTasks({ _: ['record'], key: 'meeting_prep', id: 'm2' }, ctx); // same id again: replaced, not duplicated
  let tasks = readJson(ctx.paths.state).tasks;
  assert.deepEqual(tasks.map((t) => t.automation_id).sort(), ['m1', 'm2']);
  await runTasks({ _: ['forget'], id: 'm1' }, ctx);
  tasks = readJson(ctx.paths.state).tasks;
  assert.deepEqual(tasks.map((t) => t.automation_id), ['m2']);
  ctx.close();
});

// ---------- apps ----------

test('apps lists only connected Codex apps, with their recipe and saved cursors', () => {
  const ctx = vaultCtx({ sources: {
    gmail: { enabled: true, status: 'connected', since: '2026-09-29T00:00:00.000Z' },
    gcal: { enabled: true, status: 'connected', since: '2026-09-29T00:00:00.000Z' },
    slack: { enabled: false, status: 'skipped', since: '2026-09-29T00:00:00.000Z' },
    imessage: { enabled: true, status: 'connected', since: '2026-09-29T00:00:00.000Z' },
  } });
  ctx.store.setCursor('gmail_live', '2026-09-30T09:00:00.000Z');
  ctx.store.setCursor('gmail_window', '2026-08-01');
  ctx.store.setCursor('gcal_window', '2026-07-01');
  ctx.store.setCursor('slack_C1', '1700000000.0001');
  const apps = connectedApps(ctx);
  assert.deepEqual(apps.map((a) => a.id), ['gmail', 'gcal']);
  const gmail = apps[0];
  assert.equal(gmail.cursors.gmail_live.value, '2026-09-30T09:00:00.000Z');
  assert.equal(gmail.cursors.gmail_window.value, '2026-08-01');
  assert.equal(gmail.firstRun, false);
  assert.equal(apps[1].firstRun, true, 'no gcal_live yet');
  for (const a of apps) assert.match(readFileSync(a.recipe, 'utf8'), /## Every 3 hours \(Brain Update\)/);
  ctx.close();
});

test('apps reports locked, and lists nothing, while another run holds the vault', async () => {
  const ctx = vaultCtx({ sources: { gmail: { enabled: true, status: 'connected', since: '2026-09-29T00:00:00.000Z' } } });
  const held = acquireLock(ctx.paths, 'vault');
  const outputs = [];
  ctx.log.out = (v) => outputs.push(v);
  await runApps({ _: [] }, ctx);
  assert.equal(outputs[0].locked, true);
  assert.deepEqual(outputs[0].apps, []);
  held.release();
  await runApps({ _: [] }, ctx);
  assert.equal(outputs[1].locked, false);
  assert.equal(outputs[1].apps.length, 1);
  assert.match(outputs[1].command, /bin\/confidant$/);
  ctx.close();
});

// ---------- ingest keeps <source>_live ----------

function gmailFile(messages) {
  const dir = mkdtempSync(join(tmpdir(), 'cf-live-'));
  const path = join(dir, 'in.jsonl');
  writeFileSync(path, messages.map((m) => JSON.stringify({ id: m.id, threadId: m.id, subject: 's', from: 'Ana <ana@acme.com>', to: 'owner@example.com', internalDate: String(Date.parse(m.ts)), body: 'hello' })).join('\n'));
  return path;
}

test('ingest moves <source>_live forward to the newest item, and never back', async () => {
  const ctx = fakeCtx({ config: { owner: { emails: ['owner@example.com'] } } });
  await runIngest({ source: 'gmail', file: gmailFile([{ id: 'm1', ts: '2026-09-20T10:00:00.000Z' }, { id: 'm2', ts: '2026-09-25T10:00:00.000Z' }]) }, ctx);
  assert.equal(ctx.store.getCursor('gmail_live'), '2026-09-25T10:00:00.000Z');
  // An older backfill window: gmail_window moves, gmail_live stays.
  await runIngest({ source: 'gmail', file: gmailFile([{ id: 'm0', ts: '2026-08-01T10:00:00.000Z' }]), cursorKey: 'gmail_window', cursorValue: '2026-08-01' }, ctx);
  assert.equal(ctx.store.getCursor('gmail_live'), '2026-09-25T10:00:00.000Z');
  assert.equal(ctx.store.getCursor('gmail_window'), '2026-08-01');
  // A date in the future never becomes the live cursor.
  await runIngest({ source: 'gmail', file: gmailFile([{ id: 'm9', ts: '2099-01-01T00:00:00.000Z' }]) }, ctx);
  assert.equal(ctx.store.getCursor('gmail_live'), '2026-09-25T10:00:00.000Z');
});

test('ingest never sets gcal_live: upcoming events would push it past today', async () => {
  const ctx = fakeCtx({});
  const dir = mkdtempSync(join(tmpdir(), 'cf-gcal-'));
  const path = join(dir, 'ev.jsonl');
  writeFileSync(path, JSON.stringify({ id: 'e1', summary: 'Board prep', start: { dateTime: '2026-09-20T15:00:00Z' }, end: { dateTime: '2026-09-20T16:00:00Z' } }));
  await runIngest({ source: 'gcal', file: path, cursorKey: 'gcal_upcoming', cursorValue: '2026-09-30' }, ctx);
  assert.equal(ctx.store.getCursor('gcal_live'), null);
  assert.equal(ctx.store.getCursor('gcal_upcoming'), '2026-09-30');
});

// ---------- config phase ----------

test('config phase records the last finished install step, and refuses a made-up one', async () => {
  const ctx = vaultCtx();
  assert.equal(await runConfig({ _: ['phase', 'connect'] }, ctx), 0);
  const state = readJson(ctx.paths.state);
  assert.equal(state.phase, 'connect');
  assert.equal(state.history.at(-1).phase, 'connect');
  assert.equal(await runConfig({ _: ['phase', 'almost-done'] }, ctx), 2);
  ctx.close();
});

// ---------- privacy: exclusions before anything is read ----------

test('during an install, extract and ingest refuse until the exclusions review is recorded', async () => {
  const ctx = vaultCtx({ phase: 'connect', lastUpdate: false });
  const errors = [];
  ctx.log.error = (m) => errors.push(m);
  assert.equal(await runExtract({ _: [] }, ctx), 7);
  assert.equal(await runIngest({ source: 'gmail', file: '-' }, ctx), 7);
  assert.match(errors[0], /confidant chats/);
  assert.equal(await runExtract({ _: [], probe: true }, ctx), 0, 'probing reads no content and is allowed');
  await runConfig({ _: ['phase', 'exclusions'] }, ctx);
  assert.equal(await runExtract({ _: [] }, ctx), 0);
  ctx.close();
});

test('an older vault that already ran a Brain Update is never held back', async () => {
  const ctx = vaultCtx({ phase: 'setup', lastUpdate: true });
  assert.equal(await runExtract({ _: [] }, ctx), 0);
  ctx.close();
});

test('config privacy records the model training answer, and only a known one', async () => {
  const ctx = vaultCtx();
  assert.equal(await runConfig({ _: ['privacy'], training: 'off' }, ctx), 0);
  assert.equal(readJson(ctx.paths.state).privacy.training, 'off');
  assert.equal(await runConfig({ _: ['privacy'], training: 'maybe' }, ctx), 2);
  ctx.close();
});

// ---------- prompt, recipe and skill contracts ----------

test('every task prompt ends its run with one ::inbox-item line and shows the result in chat', () => {
  const dir = join(ROOT, 'prompts/tasks');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const text = readFileSync(join(dir, f), 'utf8');
    assert.match(text, /## Your reply in this chat/, f);
    assert.equal((text.match(/^::inbox-item\{title="\.\.\." summary="\.\.\."\}$/gm) ?? []).length, 1, f);
    assert.doesNotMatch(text, /heartbeat|DONT_NOTIFY|<decision>/i, f);
    assert.doesNotMatch(text, /—|\s--\s/, `${f}: no em dashes or double hyphens in prose`);
  }
  for (const key of ['morning_brief', 'follow_up_radar', 'meeting_prep', 'weekly_review']) {
    const text = readFileSync(join(dir, `${key}.md`), 'utf8');
    assert.match(text, /Put the (whole|full)/, `${key} must put the whole brief in the chat`);
  }
});

test('the brain update refreshes every connected Codex app before sorting', () => {
  const text = readFileSync(join(ROOT, 'prompts/tasks/brain_update.md'), 'utf8');
  const apps = text.indexOf('confidant apps --json');
  const update = text.indexOf('confidant update` and read');
  assert.ok(apps > 0 && update > apps, 'apps first, then update');
  for (const id of ['gmail', 'gcal', 'drive', 'slack', 'plaud']) {
    const recipe = readFileSync(join(ROOT, '.agents/skills/confidant-install/recipes', `${id}.md`), 'utf8');
    assert.match(recipe, /## Every 3 hours \(Brain Update\)/, id);
    assert.doesNotMatch(recipe, /—|\s--\s/, `${id}: no em dashes or double hyphens in prose`);
  }
  assert.match(readFileSync(join(ROOT, '.agents/skills/confidant-install/recipes/gcal.md'), 'utf8'), /14 days/);
});

test('the install skill probes every source, and creates standalone tasks on the vault project, then verifies', () => {
  const text = readFileSync(join(ROOT, '.agents/skills/confidant-install/SKILL.md'), 'utf8');
  assert.match(text, /extract --probe --json/);
  assert.match(text, /`kind`: `cron`/);
  assert.match(text, /`projectId`/);
  assert.match(text, /create_project/);
  assert.match(text, /tasks verify --json/);
  assert.match(text, /config phase/);
  assert.doesNotMatch(text, /no model pinned/);
});

test('the install puts privacy first and exclusions before anything is read', () => {
  const text = readFileSync(join(ROOT, '.agents/skills/confidant-install/SKILL.md'), 'utf8');
  const at = (s) => text.indexOf(s);
  assert.ok(at('## Privacy first') > 0 && at('## Privacy first') < at('## Setup'));
  assert.match(text, /Improve the model for everyone/);
  assert.match(text, /Mejorar el modelo para todos/);
  assert.match(text, /config privacy --training/);
  assert.ok(at('## Leave people and chats out') > at('## Connect') && at('## Leave people and chats out') < at('## Extract'));
  assert.match(text, /confidant chats --json/);
  const prompt = readFileSync(join(ROOT, 'CUSTOMER_PROMPT.md'), 'utf8');
  assert.match(prompt, /turning off model training/);
  assert.match(prompt, /choose which people and\n> group chats to leave out/);
});
