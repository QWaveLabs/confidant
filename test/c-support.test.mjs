import { homedir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, sanitizeDiagnostics, statusCounts, collectDiagnostics, checkRateLimit } from '../engine/support.mjs';
import { fakeCtx, mockFetch } from './c-shared.test.mjs';

function tempMessage(text) {
  const dir = mkdtempSync(join(tmpdir(), 'cf-support-'));
  const path = join(dir, 'message.txt');
  writeFileSync(path, text);
  return path;
}

function withState(ctx, state = {}) {
  ctx.state = state;
  ctx.saveState = (next) => {
    ctx.state = next ?? ctx.state;
  };
  return ctx;
}

test('rejects an unknown --kind', async () => {
  const ctx = withState(fakeCtx({}));
  const code = await run({ kind: 'complaint', messageFile: tempMessage('hi') }, ctx);
  assert.equal(code, 2);
});

test('rejects a missing --message-file', async () => {
  const ctx = withState(fakeCtx({}));
  const code = await run({ kind: 'support' }, ctx);
  assert.equal(code, 2);
});

test('rejects an empty message file', async () => {
  const ctx = withState(fakeCtx({}));
  const code = await run({ kind: 'support', messageFile: tempMessage('   \n  ') }, ctx);
  assert.equal(code, 2);
});

test('preview mode (no --send) never touches the network and shows exactly what would be sent', async () => {
  const fetchImpl = mockFetch([{ status: 200, json: {} }]);
  const ctx = withState(fakeCtx({ fetchImpl, config: { installId: 'abc123' } }));
  const code = await run({ kind: 'feedback', messageFile: tempMessage('The onboarding was confusing.') }, ctx);
  assert.equal(code, 0);
  assert.equal(fetchImpl.calls.length, 0);
  const out = ctx.log.out_.at(-1);
  assert.equal(out.payload.kind, 'feedback');
  assert.equal(out.payload.message, 'The onboarding was confusing.');
  assert.equal(out.payload.diagnostics, null, 'no --include-diagnostics means no diagnostics');
  assert.equal(out.payload.install_id, 'abc123');
});

test('--include-diagnostics collects doctor, health and status counts, sanitized', async () => {
  const fakeStatus = {
    buildStatus: () => ({
      sources: [{ enabled: true, status: 'connected', count: 5 }, { enabled: false, status: 'unused', count: 0 }],
      folders: [{ count: 3 }, { count: 2 }],
      backlog: { remaining_batches: 1, done: false },
      lastUpdate: { at: '2026-09-20T00:00:00Z', inserted: 4, merged: 2 },
      phase: 'done',
      agents: [{ scheduled: true }, { scheduled: false }],
    }),
  };
  const fakeDoctor = { checkSystem: async () => ({ mail: { names: ['alex@example.com'] }, vaults: { confidant: [`${homedir()}/Second Brain`] } }) };
  const fakeHealth = { checkHealth: async () => ({ ok: true, phone: 'call me at 555-123-4567' }) };
  const ctx = withState(fakeCtx({}));
  const code = await run(
    { kind: 'support', messageFile: tempMessage('Fireflies key stopped working.'), includeDiagnostics: true },
    ctx,
    { loadDoctor: async () => fakeDoctor, loadHealth: async () => fakeHealth, loadStatus: async () => fakeStatus },
  );
  assert.equal(code, 0);
  const { diagnostics } = ctx.log.out_.at(-1).payload;
  assert.equal(diagnostics.status.sourcesConnected, 1);
  assert.equal(diagnostics.status.totalRecords, 5);
  assert.equal(diagnostics.status.notesWritten, 5);
  assert.equal(diagnostics.status.agentsScheduled, 1);
  // Allowlisted: account names, vault paths and free text never leave, not
  // even masked. Only counts, booleans and codes do.
  assert.equal(diagnostics.doctor.confidantVaults, 1);
  assert.equal(diagnostics.doctor.mail, undefined);
  assert.equal(diagnostics.health.ok, true);
  assert.equal(diagnostics.health.phone, undefined);
  const sent = JSON.stringify(diagnostics);
  for (const leak of ['alex@example.com', 'Second Brain', '555-123-4567', homedir()]) assert.ok(!sent.includes(leak), leak);
  assert.deepEqual(Object.keys(diagnostics).sort(), ['doctor', 'health', 'status']);
});

test('collectDiagnostics tolerates a missing health module without throwing', async () => {
  const ctx = withState(fakeCtx({}));
  const diagnostics = await collectDiagnostics(ctx, {
    loadDoctor: async () => ({ checkSystem: async () => ({ ok: true }) }),
    loadHealth: async () => {
      throw new Error('Cannot find module');
    },
    loadStatus: async () => ({ buildStatus: () => ({}) }),
  });
  assert.equal(diagnostics.health, null);
  assert.equal(typeof diagnostics.doctor, 'object');
  assert.equal(diagnostics.doctor.mailAccounts, null);
});

test('sanitizeDiagnostics strips emails, phone numbers and home-directory paths anywhere in a nested shape', () => {
  const home = '/Users/alex';
  const out = sanitizeDiagnostics(
    {
      a: 'contact ana@acme.com or +1 (555) 123-4567',
      b: [`${home}/Second Brain/People/Ana.md`, 'fine, no secrets here'],
      c: { deep: `${home}/Library/Mail` },
      n: 42,
      bool: true,
    },
    home,
  );
  assert.equal(out.a, 'contact [redacted email] or [redacted phone]');
  assert.equal(out.b[0], '~/Second Brain/People/Ana.md');
  assert.equal(out.b[1], 'fine, no secrets here');
  assert.equal(out.c.deep, '~/Library/Mail');
  assert.equal(out.n, 42);
  assert.equal(out.bool, true);
});

test('sanitizeDiagnostics leaves short digit runs (versions, ports) alone', () => {
  const out = sanitizeDiagnostics({ v: 'v23.4.0', port: 'listening on 3939' });
  assert.equal(out.v, 'v23.4.0');
  assert.equal(out.port, 'listening on 3939');
});

test('statusCounts drops free text (source notes, folder names, agent names, cadence) and keeps only counts', () => {
  const counts = statusCounts({
    sources: [{ enabled: true, status: 'connected', count: 2, note: 'personal inbox excluded', label: 'Gmail' }],
    folders: [{ count: 4, name: 'People' }],
    backlog: { remaining_batches: 0, done: true },
    lastUpdate: { at: '2026-09-20T00:00:00Z', inserted: 1, merged: 1 },
    phase: 'done',
    agents: [{ scheduled: true, name: 'Morning Chief of Staff', cadence: 'Weekdays at 6:45 AM' }],
  });
  assert.deepEqual(Object.keys(counts).sort(), [
    'agentsScheduled', 'backlogDone', 'backlogRemaining', 'lastUpdateAt', 'lastUpdateInserted', 'lastUpdateMerged', 'notesWritten', 'phase', 'sourcesConnected', 'sourcesEnabled', 'totalRecords',
  ].sort());
  assert.equal(counts.sourcesConnected, 1);
  assert.equal(counts.notesWritten, 4);
  assert.equal(counts.backlogDone, true);
});

test('--send without --yes refuses and never calls the network', async () => {
  const fetchImpl = mockFetch([{ status: 200, json: {} }]);
  const ctx = withState(fakeCtx({ fetchImpl }));
  const code = await run({ kind: 'support', messageFile: tempMessage('help'), send: true }, ctx);
  assert.equal(code, 2);
  assert.equal(fetchImpl.calls.length, 0);
});

test('--send --yes posts the exact payload and records the send for the rate limit', async () => {
  const fetchImpl = mockFetch([{ status: 200, json: { ok: true } }]);
  const ctx = withState(fakeCtx({ fetchImpl, config: { installId: 'inst_1', language: 'en' } }));
  const code = await run({ kind: 'support', messageFile: tempMessage('It crashed.'), send: true, yes: true }, ctx);
  assert.equal(code, 0);
  assert.equal(fetchImpl.calls.length, 1);
  const body = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.deepEqual(body, { install_id: 'inst_1', kind: 'support', message: 'It crashed.', diagnostics: null, version: '2.0.0-dev', language: 'en' });
  const out = ctx.log.out_.at(-1);
  assert.equal(out.sent, true);
  assert.equal(ctx.state.support.sent.length, 1);
});

test('--dry-run with --send --yes never touches the network or the send count', async () => {
  const fetchImpl = mockFetch([{ status: 200, json: {} }]);
  const ctx = withState(fakeCtx({ fetchImpl, dryRun: true }));
  const code = await run({ kind: 'support', messageFile: tempMessage('help'), send: true, yes: true }, ctx);
  assert.equal(code, 0);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(ctx.state.support, undefined);
  assert.equal(ctx.log.out_.at(-1).dryRun, true);
});

test('checkRateLimit blocks after 3 sends in a day and 10 in a month', () => {
  const now = new Date('2026-09-29T12:00:00Z');
  const today3 = Array.from({ length: 3 }, (_, i) => new Date(now.getTime() - i * 3600 * 1000).toISOString());
  const ctxDay = { state: { support: { sent: today3 } } };
  assert.equal(checkRateLimit(ctxDay, now).ok, false);

  const spreadOverMonth = Array.from({ length: 10 }, (_, i) => new Date(now.getTime() - i * 2 * 24 * 3600 * 1000).toISOString());
  const ctxMonth = { state: { support: { sent: spreadOverMonth } } };
  const result = checkRateLimit(ctxMonth, now);
  assert.equal(result.ok, false);
  assert.match(result.reason, /10 reports this month/);

  assert.equal(checkRateLimit({ state: {} }, now).ok, true);
});

test('a local rate limit hit falls back to a mailto link and never calls the network', async () => {
  const fetchImpl = mockFetch([{ status: 200, json: {} }]);
  const now = new Date();
  const threeToday = Array.from({ length: 3 }, () => now.toISOString());
  const ctx = withState(fakeCtx({ fetchImpl }), { support: { sent: threeToday } });
  const code = await run({ kind: 'support', messageFile: tempMessage('still broken'), send: true, yes: true }, ctx);
  assert.equal(code, 0);
  assert.equal(fetchImpl.calls.length, 0);
  const out = ctx.log.out_.at(-1);
  assert.equal(out.sent, false);
  assert.match(out.mailto, /^mailto:support@meetconfidant\.com\?subject=/);
  assert.match(out.mailto, /still%20broken|still\+broken/, 'the message text is present in the mailto body');
});

test('a network failure falls back to a mailto link with the same text and does not count against the rate limit', async () => {
  const fetchImpl = async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  };
  const ctx = withState(fakeCtx({ fetchImpl }));
  const code = await run({ kind: 'support', messageFile: tempMessage('offline test'), send: true, yes: true }, ctx);
  assert.equal(code, 0);
  const out = ctx.log.out_.at(-1);
  assert.equal(out.sent, false);
  assert.match(out.mailto, /^mailto:/);
  assert.equal(ctx.state.support, undefined, 'a failed send is never recorded against the local rate limit');
});

test('a 429 from the server is reported as "slow down" with a mailto fallback', async () => {
  const fetchImpl = mockFetch([{ status: 429 }, { status: 429 }]);
  const ctx = withState(fakeCtx({ fetchImpl }));
  const code = await run({ kind: 'support', messageFile: tempMessage('rate limited'), send: true, yes: true }, ctx);
  assert.equal(code, 0);
  const out = ctx.log.out_.at(-1);
  assert.equal(out.sent, false);
  assert.match(out.reason, /slow down/);
  assert.match(out.mailto, /^mailto:/);
});

test('the mailto fallback never appears unless send actually failed or was blocked; a plain preview has none', async () => {
  const ctx = withState(fakeCtx({}));
  await run({ kind: 'support', messageFile: tempMessage('just looking') }, ctx);
  assert.equal(ctx.log.out_.at(-1).mailto, undefined);
});
