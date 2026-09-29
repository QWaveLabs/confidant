// config.mjs subcommands. `trust` and `wake` touch things outside the
// vault (the person's own ~/.codex/config.toml, and macOS's wake schedule),
// so every test injects a temp `home` and a fake `exec` that just records
// what would have run; nothing here calls osascript, pmset, or writes to
// Rob's real ~/.codex/config.toml.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, buildWakeCommand, buildLoginItemCommand } from '../engine/config.mjs';
import { createContext } from '../engine/lib/context.mjs';

function initVault({ dryRun = false } = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'cf-config-vault-'));
  mkdirSync(join(vault, '.confidant'), { recursive: true });
  const config = { version: 1, vault, language: 'en', role: 'founder', briefTime: '06:45', timezone: 'America/New_York', sources: {} };
  writeFileSync(join(vault, '.confidant', 'config.json'), JSON.stringify(config));
  writeFileSync(join(vault, '.confidant', 'state.json'), JSON.stringify({ phase: 'tasks', history: [] }));
  return createContext({ vault, dryRun, json: true });
}

test('config sandbox writes .codex/config.toml under the vault and respects --dry-run', async () => {
  const ctx = initVault({ dryRun: true });
  await run({ _: ['sandbox'] }, ctx);
  const path = join(ctx.vault, '.codex', 'config.toml');
  assert.equal(existsSync(path), false, 'dry-run never writes');

  const ctx2 = initVault();
  await run({ _: ['sandbox'], network: 'off' }, ctx2);
  const path2 = join(ctx2.vault, '.codex', 'config.toml');
  assert.ok(existsSync(path2));
  const text = readFileSync(path2, 'utf8');
  assert.match(text, /network_access = false/);
  ctx.close();
  ctx2.close();
});

test('config trust previews without --yes, then writes and backs up with --yes, and is idempotent', async () => {
  const ctx = initVault();
  const home = mkdtempSync(join(tmpdir(), 'cf-config-home-'));
  mkdirSync(join(home, '.codex'), { recursive: true });
  const homeConfigPath = join(home, '.codex', 'config.toml');
  writeFileSync(homeConfigPath, '# existing stuff\n[mcp_servers.docs]\ncommand = "x"\n');

  const preview = await run({ _: ['trust'] }, ctx, { home });
  assert.equal(preview, 0);
  assert.equal(readFileSync(homeConfigPath, 'utf8'), '# existing stuff\n[mcp_servers.docs]\ncommand = "x"\n', 'no --yes: file is untouched');

  await run({ _: ['trust'], yes: true }, ctx, { home });
  const afterFirst = readFileSync(homeConfigPath, 'utf8');
  assert.match(afterFirst, /\[projects\./);
  assert.match(afterFirst, /trust_level = "trusted"/);
  assert.ok(afterFirst.startsWith('# existing stuff\n[mcp_servers.docs]\ncommand = "x"\n'), 'original content preserved');
  const backups = readdirSync(join(home, '.codex')).filter((f) => f.includes('.bak'));
  assert.equal(backups.length, 1);

  await run({ _: ['trust'], yes: true }, ctx, { home });
  const afterSecond = readFileSync(homeConfigPath, 'utf8');
  assert.equal(afterSecond, afterFirst, 'second run changes nothing');
  const backupsAfter = readdirSync(join(home, '.codex')).filter((f) => f.includes('.bak'));
  assert.equal(backupsAfter.length, 1, 'an already-trusted project is not backed up again');
  ctx.close();
});

test('config source validates id and status, and updates config.sources', async () => {
  const ctx = initVault();
  const bad = await run({ _: ['source'], id: 'not-a-real-source', status: 'connected' }, ctx);
  assert.equal(bad, 2);
  const badStatus = await run({ _: ['source'], id: 'imessage', status: 'sort-of' }, ctx);
  assert.equal(badStatus, 2);

  const ok = await run({ _: ['source'], id: 'imessage', status: 'connected' }, ctx);
  assert.equal(ok, 0);
  assert.equal(ctx.config.sources.imessage.status, 'connected');
  assert.equal(ctx.config.sources.imessage.enabled, true);

  await run({ _: ['source'], id: 'gmail', status: 'blocked', note: 'waiting on Full Disk Access' }, ctx);
  assert.equal(ctx.config.sources.gmail.status, 'blocked');
  assert.equal(ctx.config.sources.gmail.enabled, false);
  assert.equal(ctx.config.sources.gmail.note, 'waiting on Full Disk Access');
  ctx.close();
});

test('wake and login-item never touch the system unless --yes is passed, and validate the time strictly', async () => {
  const ctx = initVault();
  const calls = [];
  const exec = (cmd, args) => { calls.push([cmd, args]); return ''; };

  await run({ _: ['wake'], time: '06:45' }, ctx, { exec });
  assert.equal(calls.length, 0, 'no --yes: nothing is executed');

  await run({ _: ['wake'], time: '06:45', yes: true }, ctx, { exec });
  assert.equal(calls.length, 2, 'runs osascript, then verifies with pmset -g sched');
  assert.equal(calls[0][0], 'osascript');
  assert.match(calls[0][1][1], /pmset repeat wakeorpoweron MTWRFSU 06:30:00/, '15 minutes before the brief time');

  calls.length = 0;
  await run({ _: ['login-item'], yes: true }, ctx, { exec });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'osascript');
  assert.match(calls[0][1][1], /System Events/);

  assert.throws(() => buildWakeCommand('not a time'), /Refusing to build a wake command/);
  assert.doesNotThrow(() => buildWakeCommand('23:59'));
  assert.match(buildLoginItemCommand('/Applications/ChatGPT.app')[1], /ChatGPT\.app/);
  ctx.close();
});
