import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext } from '../engine/lib/context.mjs';
import { statePaths } from '../engine/lib/paths.mjs';
import { writeJson } from '../engine/lib/files.mjs';
import { buildDigest } from '../engine/digest.mjs';

// A small, realistic fixture vault: a person note with a timeline, a
// stalled project, two open commitments (one overdue and owed by the
// person, one owed to the person and due tomorrow), an open opportunity, a
// decision, plus a couple of store records (an unanswered inbound message
// and a calendar event today). Every digest is built from exactly this.
function buildFixture({ now = new Date('2026-09-25T14:00:00.000Z') } = {}) { // Friday 10:00 America/New_York
  const vault = mkdtempSync(join(tmpdir(), 'cf-digest-'));
  const paths = statePaths(vault);
  mkdirSync(paths.root, { recursive: true });

  const config = { version: 1, vault, language: 'en', role: 'founder', briefTime: '06:45', timezone: 'America/New_York', sources: {} };
  writeJson(paths.config, config);
  writeJson(paths.state, { phase: 'done', history: [], tasks: [], backlog: { remaining_batches: 2, oldest_sorted: null, done: false } });

  writeJson(join(paths.root, 'identity.json'), {
    owner: { person_id: 'me', name: 'Rob', handles: [] },
    people: [
      { id: 'p1', name: 'Mike Brennan', kind: 'customer', handles: ['tel:+15551230000'], sources: ['imessage'], tier: 'active', note_path: 'People/Mike Brennan.md' },
      { id: 'p2', name: 'Nadia Petrov', kind: 'customer', handles: ['mailto:nadia@brightwell.com'], sources: ['email'], tier: 'inner', note_path: null },
    ],
    groups: [],
    generated_at: now.toISOString(),
  });

  mkdirSync(join(vault, 'People'), { recursive: true });
  writeFileSync(join(vault, 'People', 'Mike Brennan.md'), [
    '---',
    'type: person',
    'confidant_id: p1',
    'updated: 2026-09-20',
    'tags: []',
    'sources: 3',
    'name: Mike Brennan',
    'kind: customer',
    'company: Acme',
    'relationship: Client since March.',
    'tier: active',
    '---',
    '# Mike Brennan',
    '',
    '## Timeline',
    '- 2026-09-20, Asked about the CRM filtering update. _(Zoom)_',
    '- 2026-09-10, Confirmed renewal terms. _(Calls)_',
    '',
  ].join('\n'));

  mkdirSync(join(vault, 'Projects'), { recursive: true });
  writeFileSync(join(vault, 'Projects', 'Halden Proposal.md'), '---\ntype: project\nconfidant_id: proj1\nupdated: 2026-09-01\ntags: []\nsources: 2\nname: Halden Proposal\nstatus: active\ncompany: Halden\n---\n# Halden Proposal\n');

  mkdirSync(join(vault, 'Commitments'), { recursive: true });
  writeFileSync(join(vault, 'Commitments', 'send-pricing.md'), '---\ntype: commitment\nconfidant_id: c1\nupdated: 2026-09-20\ntags: []\nsources: 1\ndirection: i_owe\ncounterpart: "[[Mike Brennan]]"\ncompany: Acme\ndue: 2026-09-20\nstatus: open\ndate: 2026-09-15\nfingerprint: abc123\n---\n# Send Mike the updated CRM filtering pricing\n');
  writeFileSync(join(vault, 'Commitments', 'renewal-owed.md'), '---\ntype: commitment\nconfidant_id: c2\nupdated: 2026-09-15\ntags: []\nsources: 1\ndirection: owed_to_me\ncounterpart: "[[Nadia Petrov]]"\ndue: 2026-09-26\nstatus: open\ndate: 2026-09-15\nfingerprint: def456\n---\n# Nadia owes the signed renewal\n');

  mkdirSync(join(vault, 'Opportunities'), { recursive: true });
  // Note: CONTRACTS.md names an opportunity note's own category `type`,
  // which collides with the `type` field every note already has for its
  // kind (person/company/.../opportunity). Flagged in the final report;
  // this fixture keeps `type: opportunity` as the note-kind and gives the
  // category its own key, which is what digest.mjs reads defensively.
  writeFileSync(join(vault, 'Opportunities', 'brightwell-austin.md'), '---\ntype: opportunity\nconfidant_id: o1\nupdated: 2026-09-22\ntags: []\nsources: 1\nopportunity_type: upsell\nstatus: open\ncounterpart: "[[Nadia Petrov]]"\nvalue: "$4,000/mo"\ndate: 2026-09-22\n---\n# Brightwell wants Austin\n');

  mkdirSync(join(vault, 'Decisions'), { recursive: true });
  writeFileSync(join(vault, 'Decisions', 'annual-plan.md'), '---\ntype: decision\nconfidant_id: d1\nupdated: 2026-09-24\ntags: []\nsources: 1\ndate: 2026-09-24\ndecided_by:\n  - "[[Mike Brennan]]"\n---\n# Hold the annual plan until Q2 churn data is in\n');

  const ctx = createContext({ vault, now, json: false });
  ctx.store.upsertRecords([
    { id: 'imessage:1', source: 'imessage', kind: 'message', thread: 'imessage:chat1', ts: '2026-09-23T12:00:00.000Z', text: 'Can you send the pricing?', from: { handle: 'tel:+15551230000', name: 'Mike Brennan' }, to: [], is_from_me: false },
    { id: 'calendar:1', source: 'calendar', kind: 'event', thread: 'calendar:evt1', ts: '2026-09-25T15:30:00.000Z', title: 'Sync with Mike', text: '', from: null, to: [{ handle: 'tel:+15551230000', name: 'Mike Brennan' }], is_from_me: false },
  ]);
  return ctx;
}

test('morning_brief digest surfaces waiting people, overdue commitments, meetings, stalled projects', () => {
  const ctx = buildFixture();
  const text = buildDigest(ctx, 'morning_brief');
  ctx.close();
  assert.match(text, /Morning Chief of Staff/);
  assert.match(text, /\[\[Mike Brennan\]\].*Can you send the pricing/);
  assert.match(text, /Overdue: Send Mike the updated CRM filtering pricing/);
  assert.match(text, /Sync with Mike/);
  assert.match(text, /Halden Proposal: no update in \d+d/);
  assert.ok(!text.includes('[[[['), 'a name already in identity must not be double-wikilinked');
});

test('follow_up_radar digest groups by direction and flags what is due tomorrow with the last exchange', () => {
  const ctx = buildFixture();
  const text = buildDigest(ctx, 'follow_up_radar');
  ctx.close();
  assert.match(text, /## I owe/);
  assert.match(text, /## Owed to me/);
  assert.match(text, /## Delegated/);
  assert.match(text, /\*\*Due tomorrow\*\*.*Nadia owes the signed renewal/);
});

test('meeting_prep digest gives per-attendee sections from the person note and open commitments', () => {
  const ctx = buildFixture();
  const text = buildDigest(ctx, 'meeting_prep');
  ctx.close();
  assert.match(text, /Mike Brennan/);
  assert.match(text, /Asked about the CRM filtering update/);
  assert.match(text, /Hold the annual plan until Q2 churn data is in/);
  assert.match(text, /You owe them: Send Mike the updated CRM filtering pricing/);
});

test('opportunity_scanner digest lists recent inbound records and open opportunities', () => {
  const ctx = buildFixture();
  const text = buildDigest(ctx, 'opportunity_scanner');
  ctx.close();
  assert.match(text, /Can you send the pricing/);
  assert.match(text, /Brightwell wants Austin/);
});

test('weekly_review digest has all ten sections, in order', () => {
  const ctx = buildFixture();
  const text = buildDigest(ctx, 'weekly_review');
  ctx.close();
  const headings = ['Major decisions', 'Unfinished commitments', 'Stalled projects', 'Revenue opportunities', 'People waiting on you', 'Team blockers', 'Recurring problems', 'Ideas worth revisiting', 'Biggest developments', 'Priorities for next week'];
  let cursor = -1;
  for (const h of headings) {
    const idx = text.indexOf(`## ${h}`);
    assert.ok(idx > cursor, `expected "${h}" after the previous heading`);
    cursor = idx;
  }
});

test('brain_update digest reports backlog and record counts without crashing', () => {
  const ctx = buildFixture();
  const text = buildDigest(ctx, 'brain_update');
  ctx.close();
  assert.match(text, /Backlog: 2 batches remaining/);
  assert.match(text, /imessage\/message: 1/);
});

test('a digest works with sensible empty output on a vault with no notes and no identity yet', () => {
  const vault = mkdtempSync(join(tmpdir(), 'cf-digest-empty-'));
  const paths = statePaths(vault);
  mkdirSync(paths.root, { recursive: true });
  writeJson(paths.config, { version: 1, vault, language: 'en', role: 'founder', briefTime: '06:45', timezone: 'America/New_York', sources: {} });
  writeJson(paths.state, { phase: 'setup', history: [], tasks: [], backlog: { remaining_batches: 0, oldest_sorted: null, done: false } });
  const ctx = createContext({ vault, now: new Date('2026-09-25T14:00:00.000Z'), json: false });
  for (const key of ['morning_brief', 'follow_up_radar', 'meeting_prep', 'opportunity_scanner', 'weekly_review']) {
    const text = buildDigest(ctx, key);
    assert.ok(text.length > 0);
    assert.match(text, /_None\.|No meetings before/);
  }
  // brain_update always has a status line (even "never" and "0 batches"),
  // so it never shows the "_None." empty marker; that is correct, not a gap.
  const status = buildDigest(ctx, 'brain_update');
  assert.match(status, /Last update: never/);
  assert.match(status, /Backlog: 0 batches remaining/);
  ctx.close();
});

test('Spanish vault digests use Spanish headings', () => {
  const ctx = buildFixture();
  ctx.lang = 'es';
  const text = buildDigest(ctx, 'follow_up_radar');
  ctx.close();
  assert.match(text, /## Yo debo/);
  assert.match(text, /## Me deben/);
  assert.match(text, /## Delegué/);
});
