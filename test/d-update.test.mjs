import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext } from '../engine/lib/context.mjs';
import { statePaths } from '../engine/lib/paths.mjs';
import { writeJson } from '../engine/lib/files.mjs';
import { acquireLock } from '../engine/lib/lock.mjs';
import { run } from '../engine/update.mjs';

// Unit B's identity.mjs, dossiers.mjs, batch.mjs and mocs.mjs are built in
// parallel and do not exist in this checkout yet. `update.mjs` must degrade
// gracefully to each one being "not built" rather than throwing, exactly
// like `extract/index.mjs` already does for an unbuilt source. This test
// exercises that real condition, not a stub.
function freshVault({ sources = {} } = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'cf-update-'));
  const paths = statePaths(vault);
  mkdirSync(paths.root, { recursive: true });
  writeJson(paths.config, { version: 1, vault, language: 'en', role: 'founder', briefTime: '06:45', timezone: 'America/New_York', sources });
  writeJson(paths.state, { phase: 'setup', history: [], tasks: [], backlog: { remaining_batches: 0, oldest_sorted: null, done: false } });
  return createContext({ vault, json: true });
}

test('update runs cleanly with no sources enabled and no B modules built yet', async () => {
  const ctx = freshVault();
  const code = await run({ _: [] }, ctx);
  assert.equal(code, 0);
  assert.equal(ctx.state.backlog.remaining_batches, 0);
  ctx.close();
});

test('update --finish records lastUpdate even when mocs.mjs does not exist yet', async () => {
  const ctx = freshVault();
  const code = await run({ finish: true, _: [] }, ctx);
  assert.equal(code, 0);
  assert.ok(ctx.state.lastUpdate?.at);
  ctx.close();
});

test('update exits clean and does not throw when the vault is already locked', async () => {
  const ctx = freshVault();
  const lock = acquireLock(ctx.paths, 'vault');
  assert.ok(lock.release);
  const code = await run({ _: [] }, ctx);
  assert.equal(code, 0);
  lock.release();
  ctx.close();
});

test('update releases its lock so a second run right after can proceed', async () => {
  const ctx = freshVault();
  assert.equal(await run({ _: [] }, ctx), 0);
  assert.equal(await run({ _: [] }, ctx), 0); // would hang or fail with "locked" if the first run leaked its lock
  ctx.close();
});

test('update skips an app-method source (Gmail, Slack, ...) since those are read through Codex, not extracted here', async () => {
  const ctx = freshVault({ sources: { gmail: { enabled: true } } });
  const code = await run({ _: [] }, ctx);
  assert.equal(code, 0); // must not try to `import('./extract/gmail.mjs')`, which does not exist
  ctx.close();
});
