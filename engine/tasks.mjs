// `confidant tasks spec --json`        -> the tasks the install skill should create
// `confidant tasks record --key <k> --id <automation id> [--name <name>] [--rrule <rule>]`
// `confidant tasks forget --id <automation id>`
// `confidant tasks verify [--json]`    -> checks Codex's own records for every recorded task
// `confidant tasks list`
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/paths.mjs';
import { t, fill } from './lib/i18n.mjs';
import { buildSchedule } from './lib/d-schedule.mjs';
import { assertValid } from './lib/schema.mjs';
import { defaultCodexDbPath, withCodexDb, automationStatuses, cwdsMatch } from './lib/d-codex.mjs';

const LANGUAGE_NAME = { en: 'English', es: 'Spanish' };

function loadPrompt(key, vars) {
  const text = readFileSync(join(REPO_ROOT, 'prompts', 'tasks', `${key}.md`), 'utf8');
  return fill(text, vars);
}

// The array `schemas/task.schema.json` describes: one entry per task the
// install skill creates with `automation_update`. Every field below except
// key, cwd, fallbackRrules and temporary is passed to that tool as is:
// kind cron (a standalone task whose every run is its own chat in
// Scheduled, never a heartbeat attached to the install chat), status
// ACTIVE, executionEnvironment local, and the project whose folder is cwd.
export function buildTaskSpec(config, { includeFinish = false, vault } = {}) {
  const lang = config?.language ?? 'en';
  const names = t('agents', lang);
  const schedule = buildSchedule(config, { includeFinish });
  const cwd = vault ?? config?.vault ?? '.';
  return schedule.map((s) => {
    const task = {
      key: s.key,
      kind: 'cron',
      name: names(`names.${s.key}`),
      rrule: s.rrule,
      prompt: loadPrompt(s.key, { language: LANGUAGE_NAME[lang] ?? 'English' }),
      status: 'ACTIVE',
      executionEnvironment: 'local',
      reasoningEffort: 'medium',
      notificationPolicy: s.notificationPolicy ?? null,
      cwd,
    };
    if (s.fallbackRrules?.length) task.fallbackRrules = s.fallbackRrules;
    if (s.temporary) task.temporary = true;
    return task;
  });
}

function humanSpec(spec) {
  return spec.map((s) => `${s.key.padEnd(20)} ${s.name.padEnd(38)} ${s.rrule}${s.notificationPolicy ? `  (${s.notificationPolicy})` : ''}`).join('\n');
}

// Upserts by automation id. A key can own several automations when its
// combined rule was rejected and the install created one per fallback rule,
// so recording a second id for the same key keeps the first.
function recordTask(ctx, key, name, rrule, automationId) {
  const state = ctx.state ?? { tasks: [] };
  const tasks = (state.tasks ?? []).filter((tsk) => tsk.automation_id !== automationId);
  tasks.push({ key, name, rrule, automation_id: automationId, created_at: new Date().toISOString() });
  ctx.state = { ...state, tasks };
  ctx.saveState();
}

// What Codex itself says about every recorded task. `problem` is one of
// not_found (deleted or never saved), heartbeat (attached to a chat instead
// of standalone, so its results can vanish from view), paused, and
// wrong_folder (does not run in this vault). Null when Codex's database is
// not readable from here, which is not the same as broken.
export function verifyTasks(ctx, opts = {}) {
  const recorded = ctx.state?.tasks ?? [];
  const expected = buildTaskSpec(ctx.config, { vault: ctx.vault }).map((s) => s.key);
  const recordedKeys = new Set(recorded.map((tsk) => tsk.key));
  const missing = expected.filter((k) => !recordedKeys.has(k));
  const ids = recorded.map((tsk) => tsk.automation_id);
  const dbPath = opts.codexDbPath ?? defaultCodexDbPath(opts.home);
  const rows = ids.length ? withCodexDb(dbPath, opts.tmpDir ?? (ctx.tmpDir ? ctx.tmpDir() : undefined), (db) => automationStatuses(db, ids)) : [];
  if (rows == null) return { ok: null, reachable: false, missing, tasks: recorded.map((tsk) => ({ key: tsk.key, name: tsk.name, automation_id: tsk.automation_id, ok: null, problem: null })) };
  const byId = new Map(rows.map((r) => [r.id, r]));
  const tasks = recorded.map((tsk) => {
    const row = byId.get(tsk.automation_id);
    const problem = !row ? 'not_found'
      : row.kind === 'heartbeat' ? 'heartbeat'
      : row.status !== 'ACTIVE' ? 'paused'
      : !cwdsMatch(row.cwds, ctx.vault) ? 'wrong_folder'
      : null;
    return {
      key: tsk.key,
      name: tsk.name,
      automation_id: tsk.automation_id,
      kind: row?.kind ?? null,
      status: row?.status ?? null,
      notification_policy: row?.notification_policy ?? null,
      ok: !problem,
      problem,
    };
  });
  return { ok: !missing.length && tasks.every((tsk) => tsk.ok), reachable: true, missing, tasks };
}

const PROBLEM_TEXT = {
  not_found: 'not found in Codex (deleted, or never saved)',
  heartbeat: 'created as a heartbeat inside a chat; delete it and create it again as a standalone (cron) task on the vault project',
  paused: 'paused',
  wrong_folder: 'does not run in this vault; delete it and create it again on the vault project',
};

function humanVerify(v) {
  if (!v.reachable) return 'Could not read the Codex app\'s own records from here, so nothing was verified.\n';
  const lines = v.tasks.map((tsk) => `${tsk.ok ? 'ok     ' : 'PROBLEM'} ${tsk.key.padEnd(20)} ${tsk.name}${tsk.problem ? `: ${PROBLEM_TEXT[tsk.problem]}` : ''}`);
  if (v.missing.length) lines.push(`Not created yet: ${v.missing.join(', ')}`);
  lines.push(v.ok ? 'Every scheduled task is set up correctly.' : 'Some scheduled tasks need attention.');
  return `${lines.join('\n')}\n`;
}

export async function run(args, ctx) {
  const sub = args._[0];

  if (sub === 'spec') {
    const spec = buildTaskSpec(ctx.config, { includeFinish: !!args.includeFinish, vault: ctx.vault });
    assertValid('task', spec);
    ctx.log.out(spec, humanSpec);
    return 0;
  }

  if (sub === 'record') {
    const key = args.key;
    if (!key) {
      ctx.log.error('tasks record needs --key <task key>.');
      return 2;
    }
    if (!args.id) {
      ctx.log.error('tasks record needs --id <automation id>.');
      return 2;
    }
    const spec = buildTaskSpec(ctx.config, { includeFinish: true, vault: ctx.vault }).find((s) => s.key === key);
    if (!spec) {
      ctx.log.error(`Unknown task key "${key}".`);
      return 2;
    }
    const name = args.name ?? spec.name;
    const rrule = args.rrule ? String(args.rrule) : spec.rrule;
    recordTask(ctx, key, name, rrule, String(args.id));
    ctx.log.out({ ok: true, key, name, rrule, automation_id: String(args.id) }, `Recorded ${key} -> ${args.id}`);
    return 0;
  }

  if (sub === 'forget') {
    if (!args.id) {
      ctx.log.error('tasks forget needs --id <automation id>.');
      return 2;
    }
    const before = ctx.state?.tasks ?? [];
    const tasks = before.filter((tsk) => tsk.automation_id !== String(args.id));
    if (tasks.length !== before.length) {
      ctx.state = { ...ctx.state, tasks };
      ctx.saveState();
    }
    ctx.log.out({ ok: true, removed: before.length - tasks.length }, `Forgot ${before.length - tasks.length} recorded task(s) with id ${args.id}.`);
    return 0;
  }

  if (sub === 'verify') {
    const result = verifyTasks(ctx);
    ctx.log.out(result, humanVerify);
    return 0;
  }

  if (sub === 'list' || !sub) {
    const tasks = ctx.state?.tasks ?? [];
    ctx.log.out({ tasks }, (v) => (v.tasks.length ? v.tasks.map((tsk) => `${tsk.key.padEnd(20)} ${tsk.name.padEnd(38)} ${tsk.rrule}  (${tsk.automation_id})`).join('\n') : 'No scheduled tasks recorded yet.'));
    return 0;
  }

  ctx.log.error(`Unknown "tasks ${sub}". Use spec, record, forget, verify, or list.`);
  return 2;
}
