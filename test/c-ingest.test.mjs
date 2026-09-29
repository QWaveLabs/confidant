import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../engine/ingest.mjs';
import { check } from '../engine/lib/schema.mjs';
import { fakeCtx } from './c-shared.test.mjs';

function tempFile(content, name = 'in.json') {
  const dir = mkdtempSync(join(tmpdir(), 'cf-ingest-'));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

async function run1(ctx, args) {
  const code = await run(args, ctx);
  return { code, out: ctx.log.out_.at(-1) };
}

test('rejects an unknown --source', async () => {
  const ctx = fakeCtx({});
  const code = await run({ source: 'notreal', file: '-' }, ctx);
  assert.equal(code, 2);
  assert.equal(ctx.log.errors.length, 1);
});

test('rejects a missing --file', async () => {
  const ctx = fakeCtx({});
  const code = await run({ source: 'gmail' }, ctx);
  assert.equal(code, 2);
});

test('gmail: maps a raw Gmail API message resource (base64url body, headers)', async () => {
  const bodyText = Buffer.from('Hi Rob,\n\nSee you Tuesday.\n').toString('base64url');
  const message = {
    id: 'msg1',
    threadId: 'th1',
    internalDate: '1735689600000',
    labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'Subject', value: 'Re: Tuesday' },
        { name: 'From', value: 'Ana Ruiz <ana@acme.com>' },
        { name: 'To', value: 'owner@example.com' },
      ],
      mimeType: 'text/plain',
      body: { data: bodyText },
    },
  };
  const ctx = fakeCtx({ config: { owner: { emails: ['owner@example.com'] } } });
  const path = tempFile(JSON.stringify([message]));
  const { code, out } = await run1(ctx, { source: 'gmail', file: path });
  assert.equal(code, 0);
  assert.equal(out.inserted, 1);
  const stored = ctx.store.record('gmail:msg1');
  assert.deepEqual(check('record', stored), []);
  assert.equal(stored.title, 'Re: Tuesday');
  assert.equal(stored.text, 'Hi Rob,\n\nSee you Tuesday.\n');
  assert.deepEqual(stored.from, { handle: 'mailto:ana@acme.com', name: 'Ana Ruiz' });
  assert.equal(stored.is_from_me, false);
  assert.equal(stored.thread, 'email:th1');
});

test('gmail: maps a flattened search/read tool shape', async () => {
  const item = { id: 'msg2', thread_id: 'th2', subject: 'Invoice', from: 'owner@example.com', to: 'client@example.com', date: '2026-09-01T10:00:00Z', body: 'Attached is the invoice.' };
  const ctx = fakeCtx({ config: { owner: { emails: ['owner@example.com'] } } });
  const path = tempFile(JSON.stringify({ messages: [item] })); // wrapper shape
  const { out } = await run1(ctx, { source: 'gmail', file: path });
  assert.equal(out.inserted, 1);
  const stored = ctx.store.record('gmail:msg2');
  assert.equal(stored.is_from_me, true);
  assert.equal(stored.text, 'Attached is the invoice.');
});

test('gcal: maps a raw Calendar event resource', async () => {
  const event = {
    id: 'ev1',
    summary: 'Client call',
    description: 'Discuss scope',
    location: 'Zoom',
    htmlLink: 'https://calendar.google.com/event?eid=ev1',
    hangoutLink: 'https://meet.google.com/abc',
    start: { dateTime: '2026-09-05T15:00:00Z' },
    end: { dateTime: '2026-09-05T15:30:00Z' },
    organizer: { email: 'owner@example.com', displayName: 'Alex' },
    attendees: [{ email: 'client@example.com', displayName: 'Client' }],
    status: 'confirmed',
  };
  const ctx = fakeCtx({ config: { owner: { emails: ['owner@example.com'] } } });
  const path = tempFile(JSON.stringify([event]));
  const { out } = await run1(ctx, { source: 'gcal', file: path });
  assert.equal(out.inserted, 1);
  const stored = ctx.store.record('gcal:ev1');
  assert.deepEqual(check('record', stored), []);
  assert.equal(stored.kind, 'event');
  assert.equal(stored.is_from_me, true);
  assert.deepEqual(stored.to, [{ handle: 'mailto:client@example.com', name: 'Client' }]);
  assert.equal(stored.meta.meetingLink, 'https://meet.google.com/abc');
});

test('drive: maps a Drive file plus exported text, including a Meet notes doc', async () => {
  const file = {
    id: 'file1',
    name: 'Google Meet Notes - Kickoff',
    mimeType: 'application/vnd.google-apps.document',
    modifiedTime: '2026-09-06T12:00:00Z',
    webViewLink: 'https://docs.google.com/document/d/file1',
    owners: [{ emailAddress: 'owner@example.com', displayName: 'Alex' }],
    text: 'Notes: we agreed on scope.',
  };
  const ctx = fakeCtx({ config: { owner: { emails: ['owner@example.com'] } } });
  const path = tempFile(JSON.stringify([file]));
  const { out } = await run1(ctx, { source: 'drive', file: path });
  assert.equal(out.inserted, 1);
  const stored = ctx.store.record('drive:file1');
  assert.deepEqual(check('record', stored), []);
  assert.equal(stored.kind, 'doc');
  assert.equal(stored.text, 'Notes: we agreed on scope.');
  assert.equal(stored.is_from_me, true);
});

test('slack: maps a channel-read wrapper, carrying channel context onto each message', async () => {
  const wrapper = {
    channel: { id: 'C123', name: 'general' },
    team: 'T1',
    messages: [
      { ts: '1735689600.000100', user: 'U1', user_profile: { real_name: 'Ana' }, text: 'Morning!' },
      { ts: '1735689700.000200', user: 'U2', text: 'Hey there' },
    ],
  };
  const ctx = fakeCtx({ config: { owner: { emails: [] } } });
  const path = tempFile(JSON.stringify(wrapper));
  const { out } = await run1(ctx, { source: 'slack', file: path });
  assert.equal(out.inserted, 2);
  const stored = ctx.store.record('slack:C123:1735689600.000100');
  assert.deepEqual(check('record', stored), []);
  assert.equal(stored.thread, 'slack:C123');
  assert.equal(stored.meta.channelName, 'general');
  assert.deepEqual(stored.from, { handle: 'slack:T1/U1', name: 'Ana' });
});

test('slack: maps plain per-message objects that already carry their own channel field', async () => {
  const items = [{ ts: '1735689800.000300', channel: 'C9', channel_name: 'random', user: 'U3', text: 'hi' }];
  const ctx = fakeCtx({});
  const path = tempFile(JSON.stringify(items));
  const { out } = await run1(ctx, { source: 'slack', file: path });
  assert.equal(out.inserted, 1);
  const stored = ctx.store.record('slack:C9:1735689800.000300');
  assert.equal(stored.thread, 'slack:C9');
});

test('plaud: maps an export item with named and object participants', async () => {
  const item = { id: 'rec1', title: 'Client intro call', created_at: '2026-09-07T09:00:00Z', duration: 900, transcript: 'Hello, nice to meet you.', summary: 'Intro call.', participants: ['Rob', { name: 'Ana', email: 'ana@acme.com' }] };
  const ctx = fakeCtx({});
  const path = tempFile(JSON.stringify([item]));
  const { out } = await run1(ctx, { source: 'plaud', file: path });
  assert.equal(out.inserted, 1);
  const stored = ctx.store.record('plaud:rec1');
  assert.deepEqual(check('record', stored), []);
  assert.equal(stored.kind, 'recording');
  assert.deepEqual(stored.to, [
    { handle: 'name:rob', name: 'Rob' },
    { handle: 'mailto:ana@acme.com', name: 'Ana' },
  ]);
});

test('accepts JSONL input (one JSON object per line)', async () => {
  const lines = [
    JSON.stringify({ id: 'r1', title: 'A', created_at: '2026-09-08T00:00:00Z', transcript: 'a' }),
    JSON.stringify({ id: 'r2', title: 'B', created_at: '2026-09-08T01:00:00Z', transcript: 'b' }),
  ].join('\n');
  const ctx = fakeCtx({});
  const path = tempFile(lines, 'in.jsonl');
  const { out } = await run1(ctx, { source: 'plaud', file: path });
  assert.equal(out.inserted, 2);
});

test('passes through an item that already looks like a full record', async () => {
  const full = { id: 'gmail:already', source: 'gmail', kind: 'email', thread: 'email:x', ts: '2026-09-09T00:00:00Z', from: null, to: [], is_from_me: false, title: 'Already normalized', text: 'body', url: null, meta: {} };
  const ctx = fakeCtx({});
  const path = tempFile(JSON.stringify([full]));
  const { out } = await run1(ctx, { source: 'gmail', file: path });
  assert.equal(out.inserted, 1);
  assert.deepEqual(ctx.store.record('gmail:already').meta, {});
});

test('an item that makes the mapper throw is counted invalid, and the run still succeeds', async () => {
  const good = { id: 'ev1', summary: 'Fine', start: { dateTime: '2026-09-01T00:00:00Z' } };
  const ctx = fakeCtx({});
  const path = tempFile(JSON.stringify([null, good]));
  const { code, out } = await run1(ctx, { source: 'gcal', file: path });
  assert.equal(code, 0);
  assert.equal(out.invalid, 1);
  assert.equal(out.inserted, 1);
});

test('privacy.filterRecord is honored: an excluded keyword keeps the email out', async () => {
  const item = { id: 'msg3', subject: 'please exclude me', from: 'owner@example.com', body: 'x' };
  const ctx = fakeCtx({ config: { exclusions: { keywords: ['exclude me'] } } });
  const path = tempFile(JSON.stringify([item]));
  const { out } = await run1(ctx, { source: 'gmail', file: path });
  assert.equal(out.excluded, 1);
  assert.equal(out.inserted, 0);
});

test('--cursor-key stores the given --cursor-value in the store cursors', async () => {
  const ctx = fakeCtx({});
  const path = tempFile(JSON.stringify([{ id: 'r9', title: 'X', created_at: '2026-09-10T00:00:00Z', transcript: 't' }]));
  await run1(ctx, { source: 'plaud', file: path, cursorKey: 'gmail_window', cursorValue: '2026-08-01' });
  assert.equal(ctx.store.getCursor('gmail_window'), '2026-08-01');
});

test('dryRun counts records but does not write to the store', async () => {
  const ctx = fakeCtx({ dryRun: true });
  const path = tempFile(JSON.stringify([{ id: 'r10', title: 'X', created_at: '2026-09-11T00:00:00Z', transcript: 't' }]));
  const { out } = await run1(ctx, { source: 'plaud', file: path });
  assert.equal(out.inserted, 1);
  assert.equal(ctx.store.record('plaud:r10'), null);
});
