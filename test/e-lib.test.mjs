// Pure-function tests for the E-owned helpers: HTML escaping, sandbox TOML,
// trust-file append, rrule descriptions, and the agent/source/folder report
// builders. No filesystem or OS calls here; see test/e-doctor.test.mjs,
// test/e-config.test.mjs and test/e-welcome.test.mjs for the I/O-facing bits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeHtml, renderTemplate } from '../engine/lib/e-html.mjs';
import { buildSandboxToml, hasTrustedProject, appendTrustedProject } from '../engine/lib/e-toml.mjs';
import { describeRrule } from '../engine/lib/e-rrule.mjs';
import { AGENT_KEYS, agentRows } from '../engine/lib/e-agents.mjs';
import { sourceRows, folderRows } from '../engine/lib/e-report.mjs';
import { openMemoryStore } from '../engine/lib/store.mjs';

test('escapeHtml neutralizes markup and renderTemplate fills {{tokens}}', () => {
  assert.equal(escapeHtml(`<script>alert('x')</script> & "quotes"`), '&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;quotes&quot;');
  assert.equal(escapeHtml(null), '');
  assert.equal(renderTemplate('Hello {{name}}, {{missing}}', { name: 'Ana' }), 'Hello Ana, {{missing}}');
});

test('sandbox toml has the verified keys and toggles network_access', () => {
  const on = buildSandboxToml({ network: true });
  const off = buildSandboxToml({ network: false });
  for (const text of [on, off]) {
    assert.match(text, /sandbox_mode = "workspace-write"/);
    assert.match(text, /approval_policy = "never"/);
    assert.match(text, /\[sandbox_workspace_write\]/);
    assert.match(text, /writable_roots = \[\]/);
    assert.match(text, /web_search = "disabled"/);
    assert.match(text, /\[apps\._default\]/);
    for (const app of ['gmail', 'google_calendar', 'google_drive', 'slack']) {
      assert.match(text, new RegExp(`\\[apps\\.${app}\\]`));
    }
    assert.match(text, /destructive_enabled = false/);
    assert.match(text, /open_world_enabled = false/);
    assert.match(text, /\[computer_use\]/);
    assert.match(text, /default_app_access = "deny"/);
  }
  assert.match(on, /network_access = true/);
  assert.match(off, /network_access = false/);
});

test('trust append is idempotent and never touches unrelated content', () => {
  const original = '# my other stuff\n[mcp_servers.docs]\ncommand = "docs-server"\n';
  const first = appendTrustedProject(original, '/Users/alex/Second Brain');
  assert.ok(first.changed);
  assert.ok(first.text.startsWith(original), 'existing content is preserved verbatim at the start');
  assert.ok(hasTrustedProject(first.text, '/Users/alex/Second Brain'));
  assert.ok(!hasTrustedProject(first.text, '/Users/alex/Other Vault'), 'a different path is not considered trusted');

  const second = appendTrustedProject(first.text, '/Users/alex/Second Brain');
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text, 'a second call makes no further changes');
});

test('trust detection only looks inside the matching [projects."..."] table', () => {
  const text = [
    '[projects."/a"]',
    'trust_level = "untrusted"',
    '',
    '[projects."/b"]',
    'trust_level = "trusted"',
  ].join('\n');
  assert.equal(hasTrustedProject(text, '/a'), false);
  assert.equal(hasTrustedProject(text, '/b'), true);
  assert.equal(hasTrustedProject(text, '/c'), false);
});

test('describeRrule reads the standard task shapes in both languages, always in 12-hour time', () => {
  assert.equal(describeRrule('FREQ=HOURLY;INTERVAL=3'), 'Every 3 hours, on the hour');
  assert.equal(describeRrule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=6;BYMINUTE=45'), 'Weekdays at 6:45 AM');
  assert.equal(describeRrule('FREQ=WEEKLY;BYDAY=FR;BYHOUR=15;BYMINUTE=0'), 'Fridays at 3:00 PM');
  assert.equal(describeRrule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=16;BYMINUTE=0', 'es'), 'Lunes a viernes a las 4:00 p. m.');
  assert.equal(describeRrule('FREQ=WEEKLY;BYDAY=FR;BYHOUR=15;BYMINUTE=0', 'es'), 'los viernes a las 3:00 p. m.');
  assert.equal(describeRrule('garbage'), 'garbage', 'an unrecognized rule shows verbatim rather than throwing');
});

test('describeRrule derives an "every N hours" sentence from a full-week multi-hour rrule, minute included', () => {
  assert.equal(describeRrule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=0,3,6,9,12,15,18,21;BYMINUTE=10'), 'Every 3 hours, 10 minutes past the hour');
  assert.equal(describeRrule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=0,3,6,9,12,15,18,21;BYMINUTE=0'), 'Every 3 hours, on the hour');
  assert.equal(describeRrule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=0,3,6,9,12,15,18,21;BYMINUTE=10', 'es'), 'Cada 3 horas, 10 minutos después de la hora');
});

test('describeRrule spells out a short weekday multi-hour cadence and ranges a long contiguous one', () => {
  assert.equal(describeRrule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7,12;BYMINUTE=30'), 'Weekdays, checking at 7:30 AM and 12:30 PM');
  assert.equal(
    describeRrule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7,8,9,10,11,12,13,14,15,16;BYMINUTE=30'),
    'Weekdays, checking every hour from 7:30 AM to 4:30 PM',
  );
});

test('agentRows prefers a real created task over tasks.mjs\'s computed spec', () => {
  const config = { briefTime: '07:00' };
  const withoutTasks = agentRows(config, { tasks: [] }, 'en');
  assert.equal(withoutTasks.length, AGENT_KEYS.length);
  const morning = withoutTasks.find((a) => a.key === 'morning_brief');
  assert.equal(morning.scheduled, false);
  assert.equal(morning.cadence, 'Weekdays at 7:00 AM');
  assert.equal(morning.name, 'Morning Chief of Staff');
  const brainUpdate = withoutTasks.find((a) => a.key === 'brain_update');
  assert.match(brainUpdate.cadence, /^Every 3 hours, \d+ minutes past the hour$/, 'brain_update runs at a fixed minute past the hour, not "on the hour"');

  const state = { tasks: [{ key: 'morning_brief', name: 'Morning Chief of Staff', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=6;BYMINUTE=30', automation_id: 'abc' }] };
  const withTask = agentRows(config, state, 'en');
  const morning2 = withTask.find((a) => a.key === 'morning_brief');
  assert.equal(morning2.scheduled, true);
  assert.equal(morning2.cadence, 'Weekdays at 6:30 AM', 'uses the real created rrule, not the computed default brief time');
});

test('sourceRows aggregates store counts per source and folderRows counts real files', () => {
  const store = openMemoryStore();
  store.upsertRecords([
    { id: 'imessage:1', source: 'imessage', kind: 'message', ts: '2026-09-01T00:00:00Z', text: 'hi', to: [], is_from_me: false },
    { id: 'imessage:2', source: 'imessage', kind: 'message', ts: '2026-09-05T00:00:00Z', text: 'hi', to: [], is_from_me: false },
  ]);
  const ctx = {
    lang: 'en',
    config: { sources: { imessage: { enabled: true, status: 'connected' }, gmail: { enabled: false } } },
    store,
  };
  const rows = sourceRows(ctx);
  const imessage = rows.find((r) => r.id === 'imessage');
  assert.equal(imessage.count, 2);
  assert.equal(imessage.firstSeen, '2026-09-01T00:00:00Z');
  assert.equal(imessage.lastSeen, '2026-09-05T00:00:00Z');
  assert.equal(imessage.status, 'connected');
  const gmail = rows.find((r) => r.id === 'gmail');
  assert.equal(gmail.count, 0);
  assert.equal(gmail.enabled, false);
  store.close();

  const vault = mkdtempSync(join(tmpdir(), 'cf-folders-'));
  mkdirSync(join(vault, 'People'), { recursive: true });
  writeFileSync(join(vault, 'People', 'Ana.md'), '# Ana');
  writeFileSync(join(vault, 'People', 'ignore.txt'), 'not markdown');
  mkdirSync(join(vault, 'People', 'VIP'), { recursive: true });
  writeFileSync(join(vault, 'People', 'VIP', 'Mike.md'), '# Mike');
  const folders = folderRows({ vault, lang: 'en' });
  assert.equal(folders.find((f) => f.key === 'people').count, 2, 'counts markdown recursively, including persona subfolders');
  assert.equal(folders.find((f) => f.key === 'projects').count, 0, 'a folder that does not exist yet counts as 0');
});
