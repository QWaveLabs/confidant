import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePhone, phoneHandle, emailHandle, last10, isShortCode, isAutomatedEmail, toHandle } from '../engine/lib/handles.mjs';
import { fromAppleTime, fromUnix, localDate } from '../engine/lib/time.mjs';
import { fingerprint } from '../engine/lib/hash.mjs';
import { check } from '../engine/lib/schema.mjs';
import { openMemoryStore } from '../engine/lib/store.mjs';
import { parseNote, composeNote } from '../engine/lib/frontmatter.mjs';
import { planNewVaultPath, isConfidantVault, statePaths } from '../engine/lib/paths.mjs';
import { acquireLock } from '../engine/lib/lock.mjs';
import { folderName, FOLDERS } from '../engine/lib/folders.mjs';
import { parseArgs } from '../engine/cli.mjs';

test('phones normalize to E.164 with US default', () => {
  assert.equal(normalizePhone('(555) 123-4567'), '+15551234567');
  assert.equal(normalizePhone('+52 81 1234 5678'), '+528112345678');
  assert.equal(normalizePhone('0044 20 7946 0958'), '+442079460958');
  assert.equal(normalizePhone('15551234567@s.whatsapp.net'), '+15551234567');
  assert.equal(normalizePhone('ana@acme.com'), null);
  assert.equal(phoneHandle('555-123-4567'), 'tel:+15551234567');
  assert.equal(last10('tel:+15551234567'), '5551234567');
  assert.ok(isShortCode(phoneHandle('22395')));
});

test('emails and handle detection', () => {
  assert.equal(emailHandle('Ana <ANA@Acme.com>'), 'mailto:ana@acme.com');
  assert.ok(isAutomatedEmail('mailto:no-reply@stripe.com'));
  assert.ok(!isAutomatedEmail('mailto:ana@acme.com'));
  assert.equal(toHandle('Mike Brennan'), 'name:mike brennan');
});

test('apple timestamps in seconds, ms and nanoseconds', () => {
  assert.equal(fromAppleTime(0), '2001-01-01T00:00:00.000Z');
  assert.equal(fromAppleTime(778000000), fromAppleTime(778000000n * 1000000000n));
  assert.equal(fromAppleTime(778000000 * 1e9), fromAppleTime(778000000));
  assert.equal(fromUnix(1700000000), '2023-11-14T22:13:20.000Z');
  assert.equal(localDate('2026-09-29T02:30:00Z', 'America/New_York'), '2026-09-28');
});

test('fingerprints ignore case, spacing and accents', () => {
  assert.equal(fingerprint('Send Mike the deck', 'Mike'), fingerprint('send  mike the deck.', 'MIKE'));
  assert.equal(fingerprint('Reunión con Ana'), fingerprint('reunion con ana'));
  assert.notEqual(fingerprint('a', 'b'), fingerprint('ab'));
});

test('record schema accepts a good record and rejects a bad one', () => {
  const good = { id: 'imessage:1', source: 'imessage', kind: 'message', ts: '2026-09-01T12:00:00.000Z', text: 'hi', from: { handle: 'tel:+15551234567', name: null }, to: [], is_from_me: false };
  assert.deepEqual(check('record', good), []);
  assert.ok(check('record', { ...good, kind: 'tweet' }).length);
  assert.ok(check('record', { ...good, extra: 1 }).length);
});

test('contribution schema validates commitments', () => {
  const ok = { batch_id: 'b1', commitments: [{ text: 'Send the deck', direction: 'i_owe', counterpart: 'Mike', date: '2026-09-01', source_refs: ['imessage:1'] }] };
  assert.deepEqual(check('contribution', ok), []);
  const bad = { batch_id: 'b1', commitments: [{ text: 'Send', direction: 'maybe', counterpart: 'Mike', date: '9/1', source_refs: [] }] };
  assert.equal(check('contribution', bad).length, 3);
});

test('store upserts, dedupes and detects changes', () => {
  const store = openMemoryStore();
  const r = { id: 'fathom:9', source: 'fathom', kind: 'meeting', ts: '2026-09-01T15:00:00.000Z', text: '', title: 'Sync', to: [], is_from_me: false };
  assert.deepEqual(store.upsertRecords([r]), { inserted: 1, updated: 0, unchanged: 0 });
  assert.deepEqual(store.upsertRecords([r]), { inserted: 0, updated: 0, unchanged: 1 });
  assert.deepEqual(store.upsertRecords([{ ...r, text: 'transcript arrived' }]), { inserted: 0, updated: 1, unchanged: 0 });
  assert.equal(store.record('fathom:9').text, 'transcript arrived');
  store.setCursor('fathom', '2026-09-01');
  assert.equal(store.getCursor('fathom'), '2026-09-01');
  assert.equal(store.records({ source: 'fathom', since: '2026-08-01T00:00:00Z' }).length, 1);
});

test('frontmatter round trip keeps lists, links and quotes', () => {
  const data = { type: 'commitment', counterpart: '[[Mike Brennan]]', due: '2026-10-01', tags: ['commitment', 'acme'], done: false, note: 'a: b' };
  const text = composeNote(data, '# Send the deck\n');
  const parsed = parseNote(text);
  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.body, '# Send the deck\n');
});

test('a new install never reuses an existing second brain folder', () => {
  const home = mkdtempSync(join(tmpdir(), 'cf-home-'));
  assert.equal(planNewVaultPath({ home }), join(home, 'Second Brain'));
  mkdirSync(join(home, 'Second Brain'));
  assert.equal(planNewVaultPath({ home }), join(home, 'Second Brain 2'));
  mkdirSync(join(home, 'Second Brain 2'));
  assert.equal(planNewVaultPath({ home }), join(home, 'Second Brain 3'));
  assert.equal(planNewVaultPath({ home, language: 'es' }), join(home, 'Segundo cerebro'));
  assert.ok(!isConfidantVault(join(home, 'Second Brain')));
  mkdirSync(join(home, 'Second Brain', '.confidant'));
  writeFileSync(join(home, 'Second Brain', '.confidant', 'config.json'), '{}');
  assert.ok(isConfidantVault(join(home, 'Second Brain')));
});

test('locks block a second writer and clear when stale', () => {
  const vault = mkdtempSync(join(tmpdir(), 'cf-vault-'));
  const paths = statePaths(vault);
  const a = acquireLock(paths, 'vault');
  assert.ok(a.release);
  assert.ok(acquireLock(paths, 'vault').held);
  a.release();
  const b = acquireLock(paths, 'vault');
  assert.ok(b.release);
  assert.ok(acquireLock(paths, 'vault', { now: Date.now() + 3 * 3600 * 1000 }).release, 'stale lock is taken over');
});

test('nine folders in both languages', () => {
  assert.equal(FOLDERS.length, 9);
  assert.equal(folderName('commitments', 'es'), 'Compromisos');
  assert.equal(folderName('briefs', 'es'), 'Resúmenes');
});

test('cli argument parsing', () => {
  assert.deepEqual(parseArgs(['--source', 'imessage', '--dry-run', 'x', '--limit=5']), { _: ['x'], source: 'imessage', dryRun: true, limit: '5' });
  assert.deepEqual(parseArgs(['--source', 'a', '--source', 'b']).source, ['a', 'b']);
});
