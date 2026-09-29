import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createContext } from '../engine/lib/context.mjs';
import { statePaths } from '../engine/lib/paths.mjs';
import { readJson, writeJson } from '../engine/lib/files.mjs';
import { buildHealth } from '../engine/health.mjs';

// health.mjs calls `probeSources` (the same helper `extract` uses) for
// every enabled source. With nothing enabled, that call is a genuine
// no-op stub: no imessage database, no Full Disk Access, no key ever gets
// touched. That is the "stubbed probes" case the team lead asked for.
function freshVault({ now = new Date('2026-09-29T14:00:00.000Z'), lastUpdateAt, backlog, sources = {} } = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'cf-health-'));
  const paths = statePaths(vault);
  mkdirSync(paths.root, { recursive: true });
  writeJson(paths.config, { version: 1, vault, language: 'en', role: 'founder', briefTime: '06:45', timezone: 'America/New_York', sources });
  writeJson(paths.state, {
    phase: 'done',
    history: [],
    tasks: [],
    backlog: backlog ?? { remaining_batches: 0, oldest_sorted: null, done: true },
    ...(lastUpdateAt !== undefined ? { lastUpdate: { at: lastUpdateAt, inserted: 0, merged: 0 } } : {}),
  });
  return createContext({ vault, now, json: true });
}

test('a vault updated recently, with nothing enabled, is healthy', async () => {
  const ctx = freshVault({ lastUpdateAt: '2026-09-29T10:00:00.000Z' }); // 4 hours before "now"
  const report = await buildHealth(ctx);
  assert.equal(report.ok, true);
  assert.deepEqual(report.problems, []);
  assert.equal(report.sources.length, 0);
  ctx.close();
});

test('a vault that has never updated reports a problem with a plain fix', async () => {
  const ctx = freshVault({}); // no lastUpdate at all
  const report = await buildHealth(ctx);
  assert.equal(report.ok, false);
  const p = report.problems.find((x) => x.area === 'update');
  assert.ok(p);
  assert.match(p.fix, /confidant update/);
  ctx.close();
});

test('an update older than 7 hours is flagged, one younger is not', async () => {
  const stale = freshVault({ lastUpdateAt: '2026-09-29T06:00:00.000Z' }); // 8 hours before "now"
  const staleReport = await buildHealth(stale);
  assert.ok(staleReport.problems.some((p) => p.area === 'update'));
  stale.close();

  const fresh = freshVault({ lastUpdateAt: '2026-09-29T08:00:00.000Z' }); // 6 hours before "now"
  const freshReport = await buildHealth(fresh);
  assert.ok(!freshReport.problems.some((p) => p.area === 'update'));
  fresh.close();
});

test('an unbuilt source is reported as not ok but never throws (the current extract.mjs "not built" contract)', async () => {
  const ctx = freshVault({ lastUpdateAt: '2026-09-29T13:00:00.000Z', sources: { gmail: { enabled: true } } });
  const report = await buildHealth(ctx);
  // gmail is method "app": no module, probeSources reports it not ok with
  // a plain reason, and health must not treat that as a hard failure of
  // the whole check.
  assert.equal(report.sources.length, 1);
  assert.equal(report.sources[0].ok, false);
  ctx.close();
});

test('a backlog stuck at the same count for several days is flagged; a moving backlog is not', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'cf-health-backlog-'));
  const paths = statePaths(vault);
  mkdirSync(paths.root, { recursive: true });
  writeJson(paths.config, { version: 1, vault, language: 'en', role: 'founder', briefTime: '06:45', timezone: 'America/New_York', sources: {} });
  writeJson(paths.state, { phase: 'done', history: [], tasks: [], backlog: { remaining_batches: 5, oldest_sorted: null, done: false }, lastUpdate: { at: '2026-09-29T10:00:00.000Z' } });

  const day1 = createContext({ vault, now: new Date('2026-09-29T14:00:00.000Z'), json: true });
  const r1 = await buildHealth(day1);
  assert.ok(!r1.backlog.stuck, 'not stuck on the first sighting');
  day1.close();

  const day4 = createContext({ vault, now: new Date('2026-10-02T14:00:00.000Z'), json: true });
  const r2 = await buildHealth(day4);
  assert.ok(r2.backlog.stuck, 'stuck after 3+ days at the same remaining_batches');
  assert.ok(r2.problems.some((p) => p.area === 'backlog'));
  day4.close();
});

test('a backlog that moves is never flagged as stuck', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'cf-health-moving-'));
  const paths = statePaths(vault);
  mkdirSync(paths.root, { recursive: true });
  writeJson(paths.config, { version: 1, vault, language: 'en', role: 'founder', briefTime: '06:45', timezone: 'America/New_York', sources: {} });
  writeJson(paths.state, { phase: 'done', history: [], tasks: [], backlog: { remaining_batches: 5, oldest_sorted: null, done: false }, lastUpdate: { at: '2026-09-29T10:00:00.000Z' } });

  const day1 = createContext({ vault, now: new Date('2026-09-29T14:00:00.000Z'), json: true });
  await buildHealth(day1);
  day1.close();

  // Backlog moved down by the next check.
  const current = readJson(paths.state);
  current.backlog.remaining_batches = 3;
  writeJson(paths.state, current);

  const day4 = createContext({ vault, now: new Date('2026-10-02T14:00:00.000Z'), json: true });
  const r2 = await buildHealth(day4);
  assert.ok(!r2.backlog.stuck);
  day4.close();
});

test('disk space and vault writability are reported without throwing', async () => {
  const ctx = freshVault({ lastUpdateAt: '2026-09-29T13:00:00.000Z' });
  const report = await buildHealth(ctx);
  assert.ok(report.disk === null || typeof report.disk.availableBytes === 'number');
  assert.equal(report.vaultWritable, true);
  ctx.close();
});

function fixtureCodexDb(dir, automations) {
  const dbPath = join(dir, 'codex-dev.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE automations (id TEXT, status TEXT, cwds TEXT, next_run_at INTEGER, last_run_at INTEGER);');
  const insert = db.prepare('INSERT INTO automations VALUES (?, ?, ?, ?, ?)');
  for (const a of automations) insert.run(a.id, a.status, JSON.stringify(a.cwds), null, null);
  db.close();
  return dbPath;
}

test('a task whose automation is active and still points at this vault is fine', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'cf-health-tasks-'));
  const paths = statePaths(vault);
  mkdirSync(paths.root, { recursive: true });
  writeJson(paths.config, { version: 1, vault, language: 'en', role: 'founder', briefTime: '06:45', timezone: 'America/New_York', sources: {} });
  writeJson(paths.state, { phase: 'done', history: [], tasks: [{ key: 'morning_brief', name: 'Morning Chief of Staff', rrule: 'r', automation_id: 'auto-1', created_at: '2026-09-01T00:00:00Z' }], backlog: { remaining_batches: 0, oldest_sorted: null, done: true }, lastUpdate: { at: '2026-09-29T13:00:00.000Z' } });
  const dbPath = fixtureCodexDb(vault, [{ id: 'auto-1', status: 'ACTIVE', cwds: [vault] }]);

  const ctx = createContext({ vault, now: new Date('2026-09-29T14:00:00.000Z'), json: true });
  const report = await buildHealth(ctx, { codexDbPath: dbPath, tmpDir: ctx.tmpDir() });
  assert.equal(report.ok, true);
  assert.deepEqual(report.tasks, [{ key: 'morning_brief', automation_id: 'auto-1', ok: true }]);
  ctx.close();
});

test('a task Codex paused, or repointed at a different cwd, is flagged with a plain fix', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'cf-health-tasks-paused-'));
  const paths = statePaths(vault);
  mkdirSync(paths.root, { recursive: true });
  writeJson(paths.config, { version: 1, vault, language: 'en', role: 'founder', briefTime: '06:45', timezone: 'America/New_York', sources: {} });
  writeJson(paths.state, {
    phase: 'done', history: [], backlog: { remaining_batches: 0, oldest_sorted: null, done: true }, lastUpdate: { at: '2026-09-29T13:00:00.000Z' },
    tasks: [
      { key: 'morning_brief', name: 'Morning Chief of Staff', rrule: 'r', automation_id: 'auto-1', created_at: '2026-09-01T00:00:00Z' },
      { key: 'weekly_review', name: 'Weekly CEO Review', rrule: 'r', automation_id: 'auto-2', created_at: '2026-09-01T00:00:00Z' },
    ],
  });
  const dbPath = fixtureCodexDb(vault, [
    { id: 'auto-1', status: 'PAUSED', cwds: [vault] },
    { id: 'auto-2', status: 'ACTIVE', cwds: ['/somewhere/else'] },
  ]);

  const ctx = createContext({ vault, now: new Date('2026-09-29T14:00:00.000Z'), json: true });
  const report = await buildHealth(ctx, { codexDbPath: dbPath, tmpDir: ctx.tmpDir() });
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((p) => p.area === 'task:morning_brief'));
  assert.ok(report.problems.some((p) => p.area === 'task:weekly_review'));
  assert.match(report.problems.find((p) => p.area === 'task:morning_brief').fix, /Morning Chief of Staff/);
  ctx.close();
});

test('with no Codex database reachable, task status is unknown, not a problem', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'cf-health-tasks-nodb-'));
  const paths = statePaths(vault);
  mkdirSync(paths.root, { recursive: true });
  writeJson(paths.config, { version: 1, vault, language: 'en', role: 'founder', briefTime: '06:45', timezone: 'America/New_York', sources: {} });
  writeJson(paths.state, { phase: 'done', history: [], tasks: [{ key: 'morning_brief', name: 'x', rrule: 'r', automation_id: 'auto-1', created_at: '2026-09-01T00:00:00Z' }], backlog: { remaining_batches: 0, oldest_sorted: null, done: true }, lastUpdate: { at: '2026-09-29T13:00:00.000Z' } });

  const ctx = createContext({ vault, now: new Date('2026-09-29T14:00:00.000Z'), json: true });
  const report = await buildHealth(ctx, { codexDbPath: join(vault, 'missing.db'), tmpDir: ctx.tmpDir() });
  assert.equal(report.ok, true);
  assert.equal(report.tasks, null);
  ctx.close();
});

test('health always exits 0: a problem is a successful check, not a failed run', async () => {
  const { run } = await import('../engine/health.mjs');
  const ctx = freshVault({});
  const code = await run({ _: [] }, ctx);
  assert.equal(code, 0);
  ctx.close();
});
