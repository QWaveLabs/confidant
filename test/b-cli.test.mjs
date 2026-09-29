import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJson, readJson } from '../engine/lib/files.mjs';
import { makeVault } from './fixtures/b-fixture.mjs';
import { goldenRecords, contributionFor } from './fixtures/b-golden-data.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = (vault, ...args) => {
  const r = spawnSync('sh', [join(ROOT, 'bin', 'confidant'), ...args, '--vault', vault, '--json'], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
};

test('the confidant commands run end to end', () => {
  const ctx = makeVault();
  ctx.store.upsertRecords(goldenRecords());
  ctx.close();
  const v = ctx.vault;
  const id = cli(v, 'identity');
  assert.equal(id.code, 0, id.err);
  assert.equal(id.out.stats.people, 3);
  const d = cli(v, 'dossiers');
  assert.equal(d.code, 0, d.err);
  assert.equal(d.out.meetings, 1);
  const next = cli(v, 'batch', 'next', '--scope', 'install', '--count', '5');
  assert.equal(next.code, 0, next.err);
  assert.equal(next.out.batches.length, 3);
  for (const b of next.out.batches) writeJson(b.output, contributionFor(readJson(b.path)));
  const merged = cli(v, 'merge', '--all');
  assert.equal(merged.code, 0, merged.err);
  assert.ok(merged.out.results.every((r) => r.ok));
  const status = cli(v, 'batch', 'status');
  assert.equal(status.out.install.merged, 3);
  assert.equal(status.out.install.done, true);
  const done = cli(v, 'batch', 'next', '--scope', 'install');
  assert.equal(done.out.done, true);
  const mocs = cli(v, 'mocs');
  assert.equal(mocs.code, 0, mocs.err);
  assert.ok(readFileSync(join(v, 'Home.md'), 'utf8').includes('# Home'));
  const last = cli(v, 'undo', '--last');
  assert.equal(last.code, 0, last.err);
  assert.ok(last.out.restored.includes('Home.md'));
  const bad = cli(v, 'merge', '--batch', 'nope');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /no batch nope/);
});
