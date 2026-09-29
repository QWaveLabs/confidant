// `confidant tasks spec --json`        -> the tasks the install skill should create
// `confidant tasks record --key <k> --id <automation id> [--name <name>]`
// `confidant tasks list`
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/paths.mjs';
import { t, fill } from './lib/i18n.mjs';
import { buildSchedule } from './lib/d-schedule.mjs';
import { assertValid } from './lib/schema.mjs';

const LANGUAGE_NAME = { en: 'English', es: 'Spanish' };

function loadPrompt(key, vars) {
  const text = readFileSync(join(REPO_ROOT, 'prompts', 'tasks', `${key}.md`), 'utf8');
  return fill(text, vars);
}

// The array `schemas/task.schema.json` describes: one entry per task the
// install skill creates with `automation_update` (mode create, status
// ACTIVE, executionEnvironment local, cwd = vault, no model pinned).
export function buildTaskSpec(config, { includeFinish = false, vault } = {}) {
  const lang = config?.language ?? 'en';
  const names = t('agents', lang);
  const schedule = buildSchedule(config, { includeFinish });
  const cwd = vault ?? config?.vault ?? '.';
  return schedule.map((s) => {
    const task = {
      key: s.key,
      name: names(`names.${s.key}`),
      rrule: s.rrule,
      prompt: loadPrompt(s.key, { language: LANGUAGE_NAME[lang] ?? 'English' }),
      notify: s.notify,
      cwd,
    };
    if (s.fallbackRrules?.length) task.fallbackRrules = s.fallbackRrules;
    if (s.temporary) task.temporary = true;
    return task;
  });
}

function humanSpec(spec) {
  return spec.map((s) => `${s.key.padEnd(20)} ${s.name.padEnd(38)} ${s.rrule}`).join('\n');
}

function recordTask(ctx, key, name, rrule, automationId) {
  const state = ctx.state ?? { tasks: [] };
  const tasks = (state.tasks ?? []).filter((tsk) => tsk.key !== key);
  tasks.push({ key, name, rrule, automation_id: automationId, created_at: new Date().toISOString() });
  ctx.state = { ...state, tasks };
  ctx.saveState();
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
    recordTask(ctx, key, name, spec.rrule, String(args.id));
    ctx.log.out({ ok: true, key, name, automation_id: String(args.id) }, `Recorded ${key} -> ${args.id}`);
    return 0;
  }

  if (sub === 'list' || !sub) {
    const tasks = ctx.state?.tasks ?? [];
    ctx.log.out({ tasks }, (v) => (v.tasks.length ? v.tasks.map((tsk) => `${tsk.key.padEnd(20)} ${tsk.name.padEnd(38)} ${tsk.rrule}  (${tsk.automation_id})`).join('\n') : 'No scheduled tasks recorded yet.'));
    return 0;
  }

  ctx.log.error(`Unknown "tasks ${sub}". Use spec, record, or list.`);
  return 2;
}
