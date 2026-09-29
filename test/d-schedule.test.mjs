import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule } from '../engine/lib/d-schedule.mjs';
import { buildTaskSpec } from '../engine/tasks.mjs';
import { check } from '../engine/lib/schema.mjs';

const RRULE_RE = /^FREQ=(HOURLY|DAILY|WEEKLY|MONTHLY)(;[A-Z]+=[A-Z0-9,+-]+)*$/;

function occurrenceKeys(entry) {
  const out = [];
  for (const d of entry.days) for (const h of entry.hours) out.push(`${d} ${String(h).padStart(2, '0')}:${String(entry.minute).padStart(2, '0')}`);
  return out;
}

function assertNoCollisions(schedule) {
  const seen = new Map();
  for (const entry of schedule) {
    for (const key of occurrenceKeys(entry)) {
      assert.ok(!seen.has(key), `collision: ${key} used by both "${seen.get(key)}" and "${entry.key}"`);
      seen.set(key, entry.key);
    }
  }
}

test('the default 06:45 brief, no meetings, produces the documented schedule', () => {
  const schedule = buildSchedule({ briefTime: '06:45', meetingsPerWeek: 0 });
  const byKey = Object.fromEntries(schedule.map((s) => [s.key, s]));
  assert.equal(byKey.brain_update.rrule, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=0,3,6,9,12,15,18,21;BYMINUTE=0');
  assert.deepEqual(byKey.brain_update.fallbackRrules, ['FREQ=HOURLY;INTERVAL=3']);
  assert.equal(byKey.morning_brief.rrule, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=6;BYMINUTE=45');
  assert.equal(byKey.opportunity_scanner.rrule, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=6;BYMINUTE=30');
  assert.equal(byKey.meeting_prep.rrule, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7,12;BYMINUTE=30');
  assert.equal(byKey.follow_up_radar.rrule, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=16;BYMINUTE=0');
  // Fridays 15:00 is inside brain_update's own every-3-hours grid (it runs
  // every day, including Friday, at :00 past 0,3,6,9,12,15,18,21). Weekly
  // review is the lower-priority task, so it is the one nudged, by the
  // smallest possible amount: one minute.
  assert.equal(byKey.weekly_review.rrule, 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=15;BYMINUTE=1');
});

test('meeting_prep scales with meetingsPerWeek', () => {
  assert.deepEqual(buildSchedule({ meetingsPerWeek: 0 }).find((s) => s.key === 'meeting_prep').hours, [7, 12]);
  assert.deepEqual(buildSchedule({ meetingsPerWeek: 5 }).find((s) => s.key === 'meeting_prep').hours, [7, 12]);
  assert.deepEqual(buildSchedule({ meetingsPerWeek: 6 }).find((s) => s.key === 'meeting_prep').hours, [7, 10, 13]);
  assert.deepEqual(buildSchedule({ meetingsPerWeek: 15 }).find((s) => s.key === 'meeting_prep').hours, [7, 10, 13]);
  assert.deepEqual(buildSchedule({ meetingsPerWeek: 16 }).find((s) => s.key === 'meeting_prep').hours, [7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
});

test('no two tasks ever start at the same minute, across brief times and meeting volumes', () => {
  const briefTimes = ['06:00', '06:45', '07:00', '07:15', '07:30', '07:45', '08:00', '08:15', '09:00', '15:00'];
  const volumes = [0, 3, 6, 10, 15, 20, 40];
  for (const briefTime of briefTimes) {
    for (const meetingsPerWeek of volumes) {
      for (const includeFinish of [false, true]) {
        const schedule = buildSchedule({ briefTime, meetingsPerWeek }, { includeFinish });
        assertNoCollisions(schedule);
      }
    }
  }
});

test('every rrule and fallback rrule matches the task schema pattern', () => {
  const schedule = buildSchedule({ briefTime: '08:15', meetingsPerWeek: 20 }, { includeFinish: true });
  for (const s of schedule) {
    assert.match(s.rrule, RRULE_RE, s.rrule);
    for (const fb of s.fallbackRrules ?? []) assert.match(fb, RRULE_RE, fb);
  }
});

test('buildTaskSpec produces schema-valid tasks with real prompt text, in the vault language', () => {
  const config = { language: 'en', role: 'founder', briefTime: '06:45', timezone: 'America/New_York', meetingsPerWeek: 3 };
  const spec = buildTaskSpec(config, { vault: '/tmp/some-vault' });
  assert.deepEqual(check('task', spec), []);
  assert.equal(spec.length, 6); // finish_sorting only appears with includeFinish
  for (const task of spec) {
    assert.equal(task.cwd, '/tmp/some-vault');
    assert.ok(task.prompt.length >= 40);
    assert.match(task.prompt, /heartbeat/);
    assert.match(task.prompt, /English/);
  }
  const morning = spec.find((t) => t.key === 'morning_brief');
  assert.equal(morning.name, 'Morning Chief of Staff');
  assert.equal(morning.notify, 'heartbeat');
});

test('buildTaskSpec in Spanish uses Spanish task names and asks the prompt to write in Spanish', () => {
  const config = { language: 'es', role: 'founder', briefTime: '07:00', timezone: 'America/Mexico_City', meetingsPerWeek: 0 };
  const spec = buildTaskSpec(config, { includeFinish: true, vault: '/tmp/es-vault' });
  assert.deepEqual(check('task', spec), []);
  const byKey = Object.fromEntries(spec.map((t) => [t.key, t]));
  assert.equal(byKey.morning_brief.name, 'Mano derecha matutina');
  assert.equal(byKey.follow_up_radar.name, 'Radar de seguimiento');
  assert.equal(byKey.weekly_review.name, 'Revisión semanal de dirección');
  for (const task of spec) assert.match(task.prompt, /Spanish/);
});

test('no em dashes or double hyphens anywhere in a generated task spec', () => {
  const config = { language: 'en', role: 'sales', briefTime: '06:45', meetingsPerWeek: 20 };
  const spec = buildTaskSpec(config, { includeFinish: true, vault: '/tmp/v' });
  for (const task of spec) {
    assert.ok(!task.name.includes('—'), task.name);
    assert.ok(!task.prompt.includes('—'), `${task.key} prompt has an em dash`);
    assert.ok(!/[a-z0-9]--[a-z0-9]/i.test(task.prompt), `${task.key} prompt has a double hyphen`);
  }
});
