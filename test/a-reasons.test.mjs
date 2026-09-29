import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeCtx, tempHome, createDb, writeFile, resetCaches } from './fixtures/a-fixtures.mjs';
import { chatDb } from './fixtures/a-apple.mjs';
import { REASON_CODES, reasonMessage, notOk, codeForError } from '../engine/lib/a-reasons.mjs';
import { REPO_ROOT } from '../engine/lib/paths.mjs';

const IDS = { imessage: 'imessage', whatsapp: 'whatsapp', whatsapp_export: 'whatsapp-export', email: 'mail', calendar: 'calendar', contacts: 'contacts', calls: 'calls', call_recordings: 'call-recordings', voice_memos: 'voice-memos', wispr: 'wispr', zoom_local: 'zoom-local' };
const load = (id) => import(`../engine/extract/${IDS[id]}.mjs`);
const NO_DASHES = /—|–|--/;

test('i18n: both languages have every code, the same keys, and no dashes', () => {
  const en = JSON.parse(readFileSync(join(REPO_ROOT, 'i18n/extract.en.json'), 'utf8'));
  const es = JSON.parse(readFileSync(join(REPO_ROOT, 'i18n/extract.es.json'), 'utf8'));
  const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, `${p}${k}.`) : [`${p}${k}`])).sort();
  assert.deepEqual(keys(es), keys(en));
  for (const code of REASON_CODES) assert.ok(en.reasons[code] && es.reasons[code], code);
  for (const text of [...Object.values(en.reasons), ...Object.values(es.reasons)]) assert.ok(!NO_DASHES.test(text), text);
  assert.ok(!NO_DASHES.test(JSON.stringify(en)) && !NO_DASHES.test(JSON.stringify(es)));
});

test('messages are localized, use the source label, and prefer source wording', () => {
  assert.match(reasonMessage('en', 'imessage', 'needs_full_disk_access'), /^iMessage and SMS needs Full Disk Access\./);
  assert.match(reasonMessage('es', 'imessage', 'needs_full_disk_access'), /^iMessage y SMS necesita Acceso total al disco\./);
  assert.match(reasonMessage('es', 'whatsapp_export', 'no_data'), /^Todavía no hay chats exportados de WhatsApp/);
  assert.match(reasonMessage('en', 'calendar', 'no_data'), /^Calendar is set up, but there is nothing to read yet\.$/);
  assert.equal(reasonMessage('fr', 'calls', 'unreadable'), reasonMessage('en', 'calls', 'unreadable'));
  const r = notOk({ lang: 'es' }, 'fathom', 'needs_key', 'no Fathom API key');
  assert.deepEqual(Object.keys(r).sort(), ['message', 'needsKey', 'ok', 'reason', 'reason_code']);
  assert.equal(r.reason, 'no Fathom API key', 'logs keep the English reason');
  assert.equal(codeForError(Object.assign(new Error('x'), { code: 'EPERM' })), 'needs_full_disk_access');
  assert.equal(codeForError(new Error('no such table: ZWAMESSAGE')), 'schema_changed');
  assert.equal(codeForError(new Error('boom')), 'unreadable');
});

test('every probe on a Mac without the app returns a code and a message', async () => {
  for (const lang of ['en', 'es']) {
    const ctx = makeCtx({ home: tempHome(), lang });
    for (const id of Object.keys(IDS)) {
      const p = await (await load(id)).probe(ctx);
      assert.equal(p.ok, false, id);
      assert.ok(['not_installed', 'no_data'].includes(p.reason_code), `${id}: ${p.reason_code}`);
      assert.equal(typeof p.reason, 'string');
      assert.equal(p.message, reasonMessage(lang, id, p.reason_code));
      assert.ok(!NO_DASHES.test(p.message));
    }
  }
});

test('Full Disk Access, corrupt files and changed schemas get their own codes', async () => {
  const home = tempHome();
  chatDb(home);
  const path = join(home, 'Library/Messages/chat.db');
  const { probe, extract } = await load('imessage');
  chmodSync(path, 0o000);
  try {
    resetCaches();
    const p = await probe(makeCtx({ home, lang: 'es' }));
    assert.equal(p.reason_code, 'needs_full_disk_access');
    assert.equal(p.needsFullDiskAccess, true);
    assert.match(p.message, /Acceso total al disco/);
    await assert.rejects(extract(makeCtx({ home, lang: 'es' }), { cursor: null }), (err) => err.reason_code === 'needs_full_disk_access' && err.needsFullDiskAccess && /Acceso total/.test(err.localized) && !/Acceso/.test(err.message));
  } finally {
    chmodSync(path, 0o644);
  }
  const broken = tempHome();
  writeFile(join(broken, 'Library/Application Support/CallHistoryDB/CallHistory.storedata'), 'this is not a database');
  resetCaches();
  assert.equal((await (await load('calls')).probe(makeCtx({ home: broken }))).reason_code, 'unreadable');
  const drifted = tempHome();
  createDb(join(drifted, 'Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite'), 'CREATE TABLE ZSOMETHINGNEW (Z_PK INTEGER PRIMARY KEY);');
  resetCaches();
  const wa = await load('whatsapp');
  assert.equal((await wa.probe(makeCtx({ home: drifted }))).reason_code, 'schema_changed');
  await assert.rejects(wa.extract(makeCtx({ home: drifted }), { cursor: null }), (err) => err.reason_code === 'schema_changed' && typeof err.localized === 'string');
});
