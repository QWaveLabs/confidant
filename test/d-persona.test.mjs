import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../engine/lib/files.mjs';
import { check } from '../engine/lib/schema.mjs';
import { REPO_ROOT } from '../engine/lib/paths.mjs';
import { FOLDER_KEYS } from '../engine/lib/folders.mjs';

const ROLES = ['founder', 'agency', 'consultant', 'investor', 'sales', 'executive', 'recruiter'];

test('every persona file exists, one per role, and nothing extra', () => {
  const files = readdirSync(join(REPO_ROOT, 'personas')).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, ROLES.map((r) => `${r}.json`).sort());
});

for (const role of ROLES) {
  test(`persona "${role}" validates against schemas/persona.schema.json`, () => {
    const persona = readJson(join(REPO_ROOT, 'personas', `${role}.json`), null);
    assert.ok(persona, `${role}.json should exist`);
    assert.deepEqual(check('persona', persona), []);
    assert.equal(persona.id, role);
  });

  test(`persona "${role}" adds at most 4 subfolders in known folders, with EN and ES names`, () => {
    const persona = readJson(join(REPO_ROOT, 'personas', `${role}.json`), null);
    assert.ok(persona.subfolders.length <= 4);
    for (const sub of persona.subfolders) {
      assert.ok(FOLDER_KEYS.includes(sub.folder), `${role}: unknown folder key "${sub.folder}"`);
      assert.ok(sub.name.en && sub.name.es, `${role}: subfolder under ${sub.folder} needs en and es names`);
    }
  });
}

test('every persona base references one of its own subfolders', () => {
  for (const role of ROLES) {
    const persona = readJson(join(REPO_ROOT, 'personas', `${role}.json`), null);
    const subfolderPaths = new Set(
      persona.subfolders.map((s) => `${s.folder[0].toUpperCase()}${s.folder.slice(1)}`),
    );
    for (const base of persona.bases ?? []) {
      const top = base.folder.split('/')[0];
      assert.ok(
        [...subfolderPaths].some((p) => base.folder.startsWith(p)) || FOLDER_KEYS.some((k) => top.toLowerCase() === k),
        `${role}: base "${base.file}" folder "${base.folder}" is not one of its subfolders`,
      );
    }
  }
});
