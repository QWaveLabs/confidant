// doctor.mjs is entirely fs-based and every path is injectable, so these
// tests build a fake "Mac" in a temp dir instead of touching Rob's real
// ~/Library, ~/Applications or Keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSystem } from '../engine/doctor.mjs';

function fakeMac() {
  const home = mkdtempSync(join(tmpdir(), 'cf-doctor-'));
  mkdirSync(join(home, 'Library/Messages'), { recursive: true });
  writeFileSync(join(home, 'Library/Messages/chat.db'), 'not a real db, just needs to exist');
  mkdirSync(join(home, 'Library/Mail/V10/AAAA-account-uuid'), { recursive: true });
  mkdirSync(join(home, 'Library/Mail/V10/MailData'), { recursive: true });
  return home;
}

test('checkSystem reports Full Disk Access, mail accounts, and the planned vault path', async () => {
  const home = fakeMac();
  const report = await checkSystem({
    home,
    messagesDb: join(home, 'Library/Messages/chat.db'),
    mailRoot: join(home, 'Library/Mail'),
    chatGptApp: join(home, 'Apps/ChatGPT.app'),
    obsidianApp: join(home, 'Apps/Obsidian.app'),
    whatsappApp: join(home, 'Apps/WhatsApp.app'),
    sqlite3Path: join(home, 'usr/bin/sqlite3'),
    systemVersionPlist: join(home, 'SystemVersion.plist'),
    statfs: () => ({ bavail: 30_000_000, bsize: 1024 }), // ~30.7 GB free
    loadKeys: async () => null, // simulates C's module not being built yet
  });

  assert.equal(report.fullDiskAccess.messages.ok, true);
  assert.equal(report.fullDiskAccess.mail.ok, true);
  assert.equal(report.mail.accounts, 1);
  assert.deepEqual(report.mail.names, ['AAAA-account-uuid']);
  assert.equal(report.chatgpt.installed, false, 'no fake ChatGPT.app was created');
  assert.equal(report.obsidian.installed, false);
  assert.equal(report.whatsapp.installed, false);
  assert.ok(report.disk.freeGb > 30 && report.disk.freeGb < 32);
  assert.equal(report.disk.ok, true);
  assert.equal(report.planNewVaultPath, join(home, 'Second Brain'));
  assert.deepEqual(report.vaults.confidant, []);
  assert.equal(report.keys.deepgram, 'unknown', 'falls back to unknown when c-keys.mjs is not built yet');
  assert.equal(report.node.ok, true, 'the node actually running the test always satisfies bin/node\'s own minimum');
});

test('checkSystem flags missing Full Disk Access without needing real permission state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cf-doctor-noaccess-'));
  const messagesDb = join(home, 'Library/Messages/chat.db');
  mkdirSync(join(home, 'Library/Messages'), { recursive: true });
  writeFileSync(messagesDb, 'x');
  chmodSync(messagesDb, 0o000);
  const report = await checkSystem({
    home,
    messagesDb,
    mailRoot: join(home, 'Library/Mail'),
    statfs: () => ({ bavail: 5_000_000, bsize: 1024 }), // ~5.1 GB free: low
    loadKeys: async () => null,
  });
  assert.equal(report.fullDiskAccess.messages.ok, false);
  assert.equal(report.fullDiskAccess.messages.needsFullDiskAccess, true);
  assert.equal(report.mail.accounts, 0, 'a missing Mail folder is just zero accounts, not a crash');
  assert.equal(report.disk.ok, false, 'warns when free space is under 20 GB');
  chmodSync(messagesDb, 0o600);
});

test('checkSystem resolves an already-installed vault as resumable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cf-doctor-resume-'));
  const vault = join(home, 'Second Brain');
  mkdirSync(join(vault, '.confidant'), { recursive: true });
  writeFileSync(join(vault, '.confidant', 'config.json'), '{}');
  const report = await checkSystem({ home, mailRoot: join(home, 'Library/Mail'), statfs: () => ({ bavail: 0, bsize: 1024 }), loadKeys: async () => null });
  assert.deepEqual(report.vaults.confidant, [vault]);
  assert.equal(report.planNewVaultPath, join(home, 'Second Brain 2'), 'a new install would not collide with the resumable one');
});
