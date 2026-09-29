import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext } from '../engine/lib/context.mjs';
import { readJson } from '../engine/lib/files.mjs';
import { isConfidantVault } from '../engine/lib/paths.mjs';
import { run, resolveVaultPath } from '../engine/init.mjs';

function tmpHome() {
  return mkdtempSync(join(tmpdir(), 'cf-init-home-'));
}

test('resolveVaultPath never reuses an existing second brain folder, and picks the language default', () => {
  const home = tmpHome();
  assert.equal(resolveVaultPath({ language: 'en', home }), join(home, 'Second Brain'));
  mkdirSync(join(home, 'Second Brain'));
  assert.equal(resolveVaultPath({ language: 'en', home }), join(home, 'Second Brain 2'));
  assert.equal(resolveVaultPath({ language: 'es', home }), join(home, 'Segundo cerebro'));
});

test('resolveVaultPath --resume finds an existing Confidant vault instead of planning a new one', () => {
  const home = tmpHome();
  const vault = join(home, 'Second Brain');
  mkdirSync(join(vault, '.confidant'), { recursive: true });
  writeFileSync(join(vault, '.confidant', 'config.json'), '{}');
  assert.equal(resolveVaultPath({ language: 'en', home, resume: true }), vault);
});

test('init creates the nine folders, config, state and vault contract for a fresh vault', async () => {
  const home = tmpHome();
  const vault = join(home, 'Second Brain');
  const ctx = createContext({ vault: null, json: true });
  const code = await run({ role: 'founder', language: 'en', briefTime: '07:15', timezone: 'America/New_York', vault, _: [] }, ctx);
  assert.equal(code, 0);

  for (const folder of ['People', 'Companies', 'Projects', 'Decisions', 'Commitments', 'Ideas', 'Meetings', 'Opportunities', 'Knowledge', 'Briefs']) {
    assert.ok(existsSync(join(vault, folder)), `missing ${folder}`);
  }
  // founder persona subfolders
  assert.ok(existsSync(join(vault, 'Companies', 'Customers')));
  assert.ok(existsSync(join(vault, 'Companies', 'Investors')));
  assert.ok(existsSync(join(vault, 'People', 'Team')));

  assert.ok(existsSync(join(vault, 'AGENTS.md')));
  assert.ok(existsSync(join(vault, 'Home.md')));
  assert.ok(existsSync(join(vault, '.obsidian', 'app.json')));
  assert.ok(isConfidantVault(vault));

  const config = readJson(join(vault, '.confidant', 'config.json'));
  assert.equal(config.role, 'founder');
  assert.equal(config.briefTime, '07:15');
  assert.equal(config.timezone, 'America/New_York');
  assert.deepEqual(config.sources, {});

  const state = readJson(join(vault, '.confidant', 'state.json'));
  assert.equal(state.phase, 'setup');
  assert.deepEqual(state.tasks, []);

  // The engine is copied in, so a scheduled task never depends on this clone.
  assert.ok(existsSync(join(vault, '.confidant', 'engine', 'bin', 'confidant')));
  assert.ok(existsSync(join(vault, '.confidant', 'engine', 'personas', 'founder.json')));
  assert.ok(existsSync(join(vault, '.confidant', 'engine', 'prompts', 'tasks', 'morning_brief.md')));
  assert.ok(existsSync(join(vault, '.agents', 'skills', 'confidant-agents', 'SKILL.md')));
});

test('init in Spanish creates Spanish folder and subfolder names', async () => {
  const home = tmpHome();
  const vault = join(home, 'Segundo cerebro');
  const ctx = createContext({ vault: null, json: true });
  const code = await run({ role: 'recruiter', language: 'es', briefTime: '08:00', vault, _: [] }, ctx);
  assert.equal(code, 0);

  for (const folder of ['Personas', 'Empresas', 'Proyectos', 'Decisiones', 'Compromisos', 'Ideas', 'Reuniones', 'Oportunidades', 'Conocimiento', 'Resúmenes']) {
    assert.ok(existsSync(join(vault, folder)), `missing ${folder}`);
  }
  // recruiter persona subfolders, in Spanish
  assert.ok(existsSync(join(vault, 'Personas', 'Candidatos')));
  assert.ok(existsSync(join(vault, 'Proyectos', 'Puestos abiertos')));
  assert.ok(existsSync(join(vault, 'Empresas', 'Clientes')));

  const config = readJson(join(vault, '.confidant', 'config.json'));
  assert.equal(config.language, 'es');
  const home_md = readdirSync(vault).includes('Home.md');
  assert.ok(home_md);
});

test('init refuses to write into an existing non-empty folder that is not a Confidant vault', async () => {
  const home = tmpHome();
  const vault = join(home, 'Old Notes');
  mkdirSync(vault);
  writeFileSync(join(vault, 'todo.txt'), 'not a vault');
  const ctx = createContext({ vault: null, json: true });
  const code = await run({ role: 'founder', language: 'en', briefTime: '06:45', vault, _: [] }, ctx);
  assert.equal(code, 6);
  assert.ok(!existsSync(join(vault, '.confidant')));
});

test('init is idempotent with --resume: config and state survive, folders and engine copy refresh', async () => {
  const home = tmpHome();
  const vault = join(home, 'Second Brain');
  const first = createContext({ vault: null, json: true });
  await run({ role: 'founder', language: 'en', briefTime: '06:45', vault, _: [] }, first);

  const before = readJson(join(vault, '.confidant', 'config.json'));
  writeFileSync(join(vault, '.confidant', 'state.json'), JSON.stringify({ phase: 'done', history: [], tasks: [{ key: 'morning_brief', name: 'x', rrule: 'FREQ=WEEKLY', automation_id: 'abc', created_at: '2026-01-01T00:00:00Z' }], backlog: { remaining_batches: 0, oldest_sorted: null, done: true } }));

  const second = createContext({ vault: null, json: true });
  const code = await run({ role: 'founder', language: 'en', vault, resume: true, _: [] }, second);
  assert.equal(code, 0);

  const after = readJson(join(vault, '.confidant', 'config.json'));
  assert.deepEqual(after, before, 'config must not be rewritten on resume');
  const state = readJson(join(vault, '.confidant', 'state.json'));
  assert.equal(state.phase, 'done', 'state must not be rewritten on resume');
  assert.equal(state.tasks.length, 1, 'previously recorded tasks survive resume');
});

test('init --resume on a folder that is not yet a Confidant vault refuses', async () => {
  const home = tmpHome();
  const vault = join(home, 'Second Brain');
  mkdirSync(vault);
  const ctx = createContext({ vault: null, json: true });
  const code = await run({ role: 'founder', language: 'en', vault, resume: true, _: [] }, ctx);
  assert.equal(code, 6);
});

test('init --plan never writes anything, and never touches the real home directory', async () => {
  const home = tmpHome();
  const ctx = createContext({ vault: null, json: true });
  const code = await run({ plan: true, language: 'en', home, _: [] }, ctx);
  assert.equal(code, 0);
  assert.deepEqual(readdirSync(home), []);
});
