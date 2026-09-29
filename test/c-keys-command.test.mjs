import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../engine/keys.mjs';
import { fakeCtx } from './c-shared.test.mjs';

test('keys status prints which keys exist without ever calling the real Keychain', async () => {
  const ctx = fakeCtx({});
  ctx.getKey = (name) => (name === 'fathom' ? 'sk_x' : null);
  const code = await run({ _: ['status'] }, ctx);
  assert.equal(code, 0);
  const { status } = ctx.log.out_.at(-1);
  assert.equal(status.find((s) => s.name === 'fathom').set, true);
  assert.equal(status.find((s) => s.name === 'deepgram').set, false);
  assert.equal(status.length, 7);
});

test('keys set <unknown> fails with a clear error and does not prompt', async () => {
  const ctx = fakeCtx({});
  let promptCalled = false;
  ctx.promptForKey = () => { promptCalled = true; return true; };
  const code = await run({ _: ['set', 'notarealservice'] }, ctx);
  assert.equal(code, 2);
  assert.equal(promptCalled, false);
});

test('keys set <name> prompts and reports success', async () => {
  const ctx = fakeCtx({});
  ctx.promptForKey = async () => true;
  const code = await run({ _: ['set', 'grain'] }, ctx);
  assert.equal(code, 0);
  assert.deepEqual(ctx.log.out_.at(-1), { ok: true });
});

test('keys set <name> reports failure when the dialog is cancelled', async () => {
  const ctx = fakeCtx({});
  ctx.promptForKey = async () => false;
  const code = await run({ _: ['set', 'grain'] }, ctx);
  assert.equal(code, 1);
  assert.deepEqual(ctx.log.out_.at(-1), { ok: false });
});

test('keys set <name> --dry-run never opens the dialog', async () => {
  const ctx = fakeCtx({ dryRun: true });
  let promptCalled = false;
  ctx.promptForKey = () => { promptCalled = true; return true; };
  const code = await run({ _: ['set', 'grain'], dryRun: true }, ctx);
  assert.equal(code, 0);
  assert.equal(promptCalled, false);
});

test('no subcommand prints usage and fails', async () => {
  const ctx = fakeCtx({});
  const code = await run({ _: [] }, ctx);
  assert.equal(code, 2);
  assert.equal(ctx.log.errors.length, 1);
});
