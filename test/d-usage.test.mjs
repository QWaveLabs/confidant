import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createContext } from '../engine/lib/context.mjs';
import { statePaths } from '../engine/lib/paths.mjs';
import { readJson, writeJson } from '../engine/lib/files.mjs';
import { buildUsage, planCheckIn, run } from '../engine/usage.mjs';

const NOW = new Date('2026-09-29T14:00:00.000Z');
const DAY_S = 86400;

function freshVault({ installedAt = '2026-09-01T00:00:00.000Z', tasks = [], checkins = [] } = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'cf-usage-'));
  const paths = statePaths(vault);
  mkdirSync(paths.root, { recursive: true });
  writeJson(paths.config, { version: 1, vault, language: 'en', role: 'founder', briefTime: '06:45', timezone: 'America/New_York', sources: {}, installedAt });
  writeJson(paths.state, { phase: 'done', history: [], tasks, backlog: { remaining_batches: 0, oldest_sorted: null, done: true }, checkins });
  return { vault, paths, ctx: createContext({ vault, now: NOW, json: true }) };
}

// A fixture matching the real ~/.codex/sqlite/codex-dev.db schema, verified
// by inspecting a copy of the real file on the machine this was built on:
// automation_runs(automation_id, read_at, created_at, ...) and
// local_thread_catalog(cwd, source_created_at, ...), both epoch-based.
function fixtureCodexDb(dir, { runs = [], sessions = [] } = {}) {
  const dbPath = join(dir, 'codex-dev.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE automation_runs (thread_id TEXT, automation_id TEXT, status TEXT, read_at INTEGER, created_at INTEGER);');
  db.exec('CREATE TABLE local_thread_catalog (thread_id TEXT, cwd TEXT, source_created_at REAL);');
  const insertRun = db.prepare('INSERT INTO automation_runs VALUES (?, ?, ?, ?, ?)');
  runs.forEach((r, i) => insertRun.run(`thread-${i}`, r.automationId, 'done', r.readAt ?? null, r.createdAt));
  const insertSession = db.prepare('INSERT INTO local_thread_catalog VALUES (?, ?, ?)');
  sessions.forEach((s, i) => insertSession.run(`thread-s${i}`, s.cwd, s.createdAt));
  db.close();
  return dbPath;
}

function fixtureWorkspace(vault, { lastOpenFiles = [] } = {}) {
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  const path = join(vault, '.obsidian', 'workspace.json');
  writeFileSync(path, JSON.stringify({ lastOpenFiles }));
  return path;
}

test('with no codex database and no workspace.json, every external signal is null, never a crash', async () => {
  const { vault, ctx } = freshVault();
  const usage = await buildUsage(ctx, { codexDbPath: join(vault, 'missing.db'), workspaceJsonPath: join(vault, '.obsidian', 'workspace.json'), tmpDir: ctx.tmpDir() });
  assert.equal(usage.sessionsLast7, null);
  assert.equal(usage.briefs.recentlyOpened, null);
  assert.equal(usage.briefs.runsLast7, null);
  ctx.close();
});

test('automation_runs and local_thread_catalog are read correctly from a real-shaped fixture', async () => {
  const { vault, ctx } = freshVault({ tasks: [{ key: 'morning_brief', name: 'x', rrule: 'r', automation_id: 'auto-1', created_at: '2026-09-01T00:00:00Z' }] });
  const nowS = Math.floor(NOW.getTime() / 1000);
  const dbPath = fixtureCodexDb(vault, {
    runs: [
      { automationId: 'auto-1', readAt: nowS * 1000, createdAt: (nowS - 3600) * 1000 }, // opened, 1h ago
      { automationId: 'auto-1', readAt: null, createdAt: (nowS - 7200) * 1000 }, // unopened, 2h ago
      { automationId: 'auto-1', readAt: null, createdAt: (nowS - 30 * DAY_S) * 1000 }, // outside the 7 day window
      { automationId: 'other-automation', readAt: nowS * 1000, createdAt: (nowS - 3600) * 1000 }, // not one of this vault's tasks
    ],
    sessions: [
      { cwd: vault, createdAt: nowS - 3600 }, // this week
      { cwd: vault, createdAt: nowS - 30 * DAY_S }, // too old
      { cwd: '/some/other/project', createdAt: nowS - 3600 }, // different vault
    ],
  });
  const usage = await buildUsage(ctx, { codexDbPath: dbPath, tmpDir: ctx.tmpDir() });
  assert.equal(usage.briefs.runsLast7, 2);
  assert.equal(usage.briefs.runsOpenedLast7, 1);
  assert.equal(usage.sessionsLast7, 1);
  ctx.close();
});

test('a brief in lastOpenFiles with a fresh workspace.json counts as recently opened', async () => {
  const { vault, ctx } = freshVault();
  const workspacePath = fixtureWorkspace(vault, { lastOpenFiles: ['Briefs/2026-09-29.md', 'People/Mike Brennan.md'] });
  const usage = await buildUsage(ctx, { codexDbPath: join(vault, 'missing.db'), workspaceJsonPath: workspacePath, tmpDir: ctx.tmpDir() });
  assert.equal(usage.briefs.recentlyOpened, true);
  ctx.close();
});

test('no Briefs entry in lastOpenFiles means not recently opened', async () => {
  const { vault, ctx } = freshVault();
  const workspacePath = fixtureWorkspace(vault, { lastOpenFiles: ['People/Mike Brennan.md'] });
  const usage = await buildUsage(ctx, { codexDbPath: join(vault, 'missing.db'), workspaceJsonPath: workspacePath, tmpDir: ctx.tmpDir() });
  assert.equal(usage.briefs.recentlyOpened, false);
  ctx.close();
});

test('value counts read real notes: commitments, meetings, opportunities', async () => {
  const { vault, ctx } = freshVault();
  mkdirSync(join(vault, 'Commitments'), { recursive: true });
  writeFileSync(join(vault, 'Commitments', 'a.md'), '---\ntype: commitment\nconfidant_id: c1\nupdated: 2026-09-01\ntags: []\nsources: 1\ndirection: i_owe\ncounterpart: "[[Mike]]"\ndate: 2026-09-01\nstatus: open\n---\n# a\n');
  writeFileSync(join(vault, 'Commitments', 'b.md'), '---\ntype: commitment\nconfidant_id: c2\nupdated: 2026-09-01\ntags: []\nsources: 1\ndirection: owed_to_me\ncounterpart: "[[Nadia]]"\ndate: 2026-09-01\nstatus: done\n---\n# b\n');
  mkdirSync(join(vault, 'Meetings'), { recursive: true });
  writeFileSync(join(vault, 'Meetings', 'm.md'), '---\ntype: meeting\nconfidant_id: m1\nupdated: 2026-09-01\ntags: []\nsources: 1\ndate: 2026-09-01\n---\n# m\n');
  mkdirSync(join(vault, 'Opportunities'), { recursive: true });
  writeFileSync(join(vault, 'Opportunities', 'o.md'), '---\ntype: opportunity\nconfidant_id: o1\nupdated: 2026-09-01\ntags: []\nsources: 1\nstatus: open\ndate: 2026-09-01\n---\n# o\n');

  const usage = await buildUsage(ctx, { codexDbPath: join(vault, 'missing.db'), tmpDir: ctx.tmpDir() });
  assert.deepEqual(usage.value, { commitmentsTracked: 2, meetingsPrepped: 1, opportunitiesFlagged: 1, followUpsCaught: 1 });
  ctx.close();
});

// --- planCheckIn: pure decision logic, no filesystem needed ---

test('nothing fires before day 3 of the install, whatever else is true', () => {
  const plan = planCheckIn({ now: NOW, tz: 'America/New_York', installedAt: '2026-09-28T00:00:00Z', checkins: [], briefsRecentlyOpened: false });
  assert.equal(plan.shouldNotify, false);
});

test('first_impressions fires once, only in the 3 to 10 day window, and never again after a check-in exists', () => {
  const inWindow = planCheckIn({ now: NOW, tz: 'America/New_York', installedAt: '2026-09-24T00:00:00Z', checkins: [] }); // 5 days
  assert.deepEqual(inWindow, { shouldNotify: true, reason: 'first_impressions' });

  const tooLate = planCheckIn({ now: NOW, tz: 'America/New_York', installedAt: '2026-08-01T00:00:00Z', checkins: [] }); // way past day 10
  assert.notEqual(tooLate.reason, 'first_impressions');

  const alreadyDone = planCheckIn({ now: NOW, tz: 'America/New_York', installedAt: '2026-09-24T00:00:00Z', checkins: [{ at: '2026-09-15T00:00:00Z', reason: 'first_impressions', notified: true }] });
  assert.notEqual(alreadyDone.reason, 'first_impressions');
});

test('the first check-in touching a new month is a monthly_receipt, once per month', () => {
  const first = planCheckIn({ now: NOW, tz: 'America/New_York', installedAt: '2026-08-01T00:00:00Z', checkins: [{ at: '2026-08-15T00:00:00Z', reason: 'first_impressions', notified: true }] });
  assert.deepEqual(first, { shouldNotify: true, reason: 'monthly_receipt', monthKey: '2026-09' });

  const already = planCheckIn({ now: NOW, tz: 'America/New_York', installedAt: '2026-08-01T00:00:00Z', checkins: [{ at: '2026-09-04T00:00:00Z', reason: 'monthly_receipt', notified: true }], briefsRecentlyOpened: true });
  assert.notEqual(already.reason, 'monthly_receipt');
});

test('low_usage fires when briefs are not being opened, carrying the waiting-person hook through', () => {
  const checkins = [{ at: '2026-09-04T00:00:00Z', reason: 'monthly_receipt', notified: true }];
  const plan = planCheckIn({ now: NOW, tz: 'America/New_York', installedAt: '2026-08-01T00:00:00Z', checkins, briefsRecentlyOpened: false, waitingHook: { name: 'Mike Brennan' } });
  assert.equal(plan.shouldNotify, true);
  assert.equal(plan.reason, 'low_usage');
  assert.deepEqual(plan.hook, { name: 'Mike Brennan' });
});

test('a null (unknown) briefsRecentlyOpened never triggers low_usage', () => {
  const checkins = [{ at: '2026-09-04T00:00:00Z', reason: 'monthly_receipt', notified: true }];
  const plan = planCheckIn({ now: NOW, tz: 'America/New_York', installedAt: '2026-08-01T00:00:00Z', checkins, briefsRecentlyOpened: null });
  assert.notEqual(plan.reason, 'low_usage');
});

test('improvement_question fires roughly every 2nd week, not every week', () => {
  const checkins = [
    { at: '2026-09-04T00:00:00Z', reason: 'monthly_receipt', notified: true },
    { at: '2026-09-15T00:00:00Z', reason: 'improvement_question', notified: true, question: 'x' },
  ];
  const tooSoon = planCheckIn({ now: new Date('2026-09-24T14:00:00Z'), tz: 'America/New_York', installedAt: '2026-08-01T00:00:00Z', checkins, briefsRecentlyOpened: true }); // 9 days later
  assert.notEqual(tooSoon.reason, 'improvement_question');

  const due = planCheckIn({ now: NOW, tz: 'America/New_York', installedAt: '2026-08-01T00:00:00Z', checkins, briefsRecentlyOpened: true }); // 14 days later
  assert.equal(due.reason, 'improvement_question');
  assert.equal(due.questionIndex, 1); // one improvement_question already asked
});

test('never more than one notified check-in within a week, regardless of reason', () => {
  const checkins = [{ at: '2026-09-27T00:00:00Z', reason: 'monthly_receipt', notified: true }];
  const plan = planCheckIn({ now: NOW, tz: 'America/New_York', installedAt: '2026-08-01T00:00:00Z', checkins, briefsRecentlyOpened: false });
  assert.equal(plan.shouldNotify, false);
});

test('everything otherwise satisfied but no trigger applies stays quiet', () => {
  const checkins = [
    { at: '2026-09-04T00:00:00Z', reason: 'monthly_receipt', notified: true },
    { at: '2026-09-22T00:00:00Z', reason: 'improvement_question', notified: true },
  ];
  const plan = planCheckIn({ now: NOW, tz: 'America/New_York', installedAt: '2026-08-01T00:00:00Z', checkins, briefsRecentlyOpened: true });
  assert.deepEqual(plan, { shouldNotify: false, reason: null });
});

// --- run(): --check-in persists, plain usage does not ---

test('--check-in records the decision in state.checkins; a plain run leaves state untouched', async () => {
  const { vault, paths, ctx } = freshVault({ installedAt: '2026-09-24T00:00:00.000Z' }); // 5 days: first_impressions window
  await run({ _: [] }, ctx);
  assert.deepEqual(readJson(paths.state).checkins, []);
  ctx.close();

  const ctx2 = createContext({ vault, now: NOW, json: true });
  await run({ checkIn: true, _: [] }, ctx2);
  const after = readJson(paths.state);
  assert.equal(after.checkins.length, 1);
  assert.equal(after.checkins[0].reason, 'first_impressions');
  ctx2.close();
});

test('--check-in with dryRun never writes state', async () => {
  const { vault, paths } = freshVault({ installedAt: '2026-09-24T00:00:00.000Z' });
  const ctx = createContext({ vault, now: NOW, json: true, dryRun: true });
  await run({ checkIn: true, _: [] }, ctx);
  assert.deepEqual(readJson(paths.state).checkins, []);
  ctx.close();
});
