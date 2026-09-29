import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeCtx, tempHome, createDb, insert, runSource, schemaErrors, writeFile, resetCaches } from './fixtures/a-fixtures.mjs';
import * as mail from '../engine/extract/mail.mjs';

const WORK = 'AAAAAAAA-1111-4111-8111-111111111111';
const HOME = 'BBBBBBBB-2222-4222-8222-222222222222';
const STORE = 'CCCCCCCC-3333-4333-8333-333333333333';
const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const shard = (rowid) => String(Math.floor(rowid / 1000)).split('').reverse().join('/');

function emlx(message) {
  const body = Buffer.from(message.replace(/\n/g, '\r\n'));
  return Buffer.concat([Buffer.from(`${body.length}\n`), body, Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>flags</key><integer>8590195713</integer></dict></plist>\n')]);
}

function fixture({ withAccounts = true } = {}) {
  const home = tempHome();
  const v10 = join(home, 'Library/Mail/V10');
  const db = createDb(
    join(v10, 'MailData/Envelope Index'),
    `CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url UNIQUE, total_count INTEGER DEFAULT 0, unread_count INTEGER DEFAULT 0, source INTEGER);
     CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject COLLATE RTRIM);
     CREATE TABLE summaries (ROWID INTEGER PRIMARY KEY, summary TEXT);
     CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address COLLATE NOCASE, comment);
     CREATE TABLE message_global_data (ROWID INTEGER PRIMARY KEY, message_id INTEGER, model_category INTEGER, message_id_header TEXT);
     CREATE TABLE messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL DEFAULT 0, global_message_id INTEGER, remote_id INTEGER,
       document_id TEXT, sender INTEGER, subject_prefix TEXT, subject INTEGER NOT NULL, summary INTEGER, date_sent INTEGER, date_received INTEGER,
       mailbox INTEGER NOT NULL, remote_mailbox INTEGER, flags INTEGER NOT NULL DEFAULT 0, read INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0,
       deleted INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, conversation_id INTEGER NOT NULL DEFAULT 0, list_id_hash INTEGER, unsubscribe_type INTEGER);
     CREATE TABLE recipients (ROWID INTEGER PRIMARY KEY, message INTEGER NOT NULL, address INTEGER NOT NULL, type INTEGER, position INTEGER);
     CREATE TABLE labels (message_id INTEGER NOT NULL, mailbox_id INTEGER NOT NULL, PRIMARY KEY (message_id, mailbox_id));`,
  );
  insert(db, 'mailboxes', [
    { ROWID: 1, url: `imap://${WORK}/INBOX` },
    { ROWID: 2, url: `imap://${WORK}/Sent%20Messages` },
    { ROWID: 3, url: `imap://${WORK}/Junk` },
    { ROWID: 4, url: `imap://${HOME}/INBOX` },
    { ROWID: 5, url: `imap://${HOME}/%5BGmail%5D/Sent%20Mail` },
    { ROWID: 6, url: `imap://${HOME}/%5BGmail%5D/Spam` },
    { ROWID: 7, url: `imap://${HOME}/%5BGmail%5D/All%20Mail` },
  ]);
  const addr = { rob: 1, ana: 2, maria: 3, mike: 4, news: 5, robh: 6, sara: 7 };
  insert(db, 'addresses', [
    { ROWID: 1, address: 'rob@qwave.test', comment: 'Rob Hernandez' },
    { ROWID: 2, address: 'ana@acme.test', comment: 'Ana López' },
    { ROWID: 3, address: 'maria@northwind.test', comment: 'María Ruiz' },
    { ROWID: 4, address: 'mike@acme.test', comment: '' },
    { ROWID: 5, address: 'news@list.test', comment: 'Weekly News' },
    { ROWID: 6, address: 'rob.h@gmail.com', comment: 'Rob' },
    { ROWID: 7, address: 'sara@kim.test', comment: 'Sara Kim' },
  ]);
  let subj = 0;
  const files = {};
  const add = ({ rowid, box, from, subject, prefix = null, at, to = [], cc = [], conv = 0, deleted = 0, summary = null, file, partial = false, mid, listId = null, labels = [] }) => {
    insert(db, 'subjects', { ROWID: ++subj, subject });
    if (summary) insert(db, 'summaries', { ROWID: subj, summary });
    if (mid) insert(db, 'message_global_data', { ROWID: rowid, message_id: rowid * 7, message_id_header: mid });
    insert(db, 'messages', {
      ROWID: rowid, message_id: 9007199254740993n + BigInt(rowid), global_message_id: mid ? rowid : null, sender: addr[from], subject_prefix: prefix, subject: subj,
      summary: summary ? subj : null, date_sent: unix(at), date_received: unix(at) + 5, mailbox: box, deleted, conversation_id: conv, list_id_hash: listId,
    });
    to.forEach((a, i) => insert(db, 'recipients', { message: rowid, address: addr[a], type: 0, position: i }));
    cc.forEach((a, i) => insert(db, 'recipients', { message: rowid, address: addr[a], type: 1, position: i }));
    for (const l of labels) insert(db, 'labels', { message_id: rowid, mailbox_id: l });
    if (file) {
      const account = box <= 3 ? WORK : HOME;
      const mbox = { 1: 'INBOX.mbox', 2: 'Sent Messages.mbox', 3: 'Junk.mbox', 4: 'INBOX.mbox', 5: '[Gmail].mbox/Sent Mail.mbox', 6: '[Gmail].mbox/Spam.mbox', 7: '[Gmail].mbox/All Mail.mbox' }[box];
      const path = join(v10, account, mbox, STORE, 'Data', shard(rowid), 'Messages', `${rowid}${partial ? '.partial' : ''}.emlx`);
      files[rowid] = writeFile(path, emlx(file));
    }
  };
  add({ rowid: 1001, box: 1, from: 'ana', subject: 'Proposal', at: '2026-09-01T14:00:00Z', to: ['rob'], cc: ['mike'], conv: 5, mid: 'p1@acme.test',
    file: 'From: Ana López <ana@acme.test>\nTo: rob@qwave.test\nSubject: Proposal\nMessage-ID: <p1@acme.test>\nContent-Type: text/plain; charset=utf-8\n\nHi Rob, can we sign Friday?\n\nOn Sun, Aug 31, 2026 at 9:00 AM Rob Hernandez <rob@qwave.test> wrote:\n> Send me the draft\n' });
  add({ rowid: 1002, box: 1, from: 'maria', subject: 'Reunión mañana', at: '2026-09-02T09:00:00Z', to: ['rob'],
    file: `From: =?UTF-8?Q?Mar=C3=ADa_Ruiz?= <maria@northwind.test>\nSubject: =?UTF-8?B?UmV1bmnDs24gbWHDsWFuYQ==?=\nContent-Type: text/html; charset=utf-8\nContent-Transfer-Encoding: base64\n\n${Buffer.from('<p>Nos vemos a las <b>10</b>.</p><p>Saludos</p>').toString('base64')}\n` });
  add({ rowid: 1003, box: 2, from: 'rob', subject: 'Proposal', prefix: 'Re: ', at: '2026-09-01T15:00:00Z', to: ['ana'], conv: 5,
    file: 'From: Rob <rob@qwave.test>\nSubject: Re: Proposal\nContent-Type: text/plain; charset=iso-8859-1\nContent-Transfer-Encoding: quoted-printable\n\nGracias, firmamos ma=F1ana.\n\nSent from my iPhone\n' });
  add({ rowid: 1004, box: 1, from: 'news', subject: 'This week', at: '2026-09-03T08:00:00Z', to: ['rob'], listId: 77,
    file: 'From: Weekly News <news@list.test>\nList-Unsubscribe: <mailto:unsub@list.test>\nContent-Type: multipart/mixed; boundary=b\n\n--b\nContent-Type: text/plain\n\nTop stories\n--b\nContent-Type: application/pdf\nContent-Disposition: attachment; filename=issue.pdf\nContent-Transfer-Encoding: base64\n\nJVBERi0x\n--b--\n' });
  add({ rowid: 1005, box: 3, from: 'news', subject: 'You won', at: '2026-09-03T09:00:00Z', to: ['rob'], file: 'Subject: You won\n\nspam' });
  add({ rowid: 1006, box: 1, from: 'ana', subject: 'Old draft', at: '2026-09-03T10:00:00Z', to: ['rob'], deleted: 1 });
  add({ rowid: 1007, box: 1, from: 'sara', subject: 'Quick question', at: '2026-09-04T10:00:00Z', to: ['rob'], summary: 'Are you free Thursday for a call?' });
  add({ rowid: 1008, box: 4, from: 'sara', subject: 'Dinner', at: '2026-09-04T20:00:00Z', to: ['robh'], labels: [4], file: 'Subject: Dinner\n\nSee you at 8' });
  add({ rowid: 1009, box: 7, from: 'news', subject: 'Cheap pills', at: '2026-09-04T21:00:00Z', to: ['robh'], labels: [6], file: 'Subject: x\n\nspam' });
  add({ rowid: 1010, box: 5, from: 'robh', subject: 'Dinner', prefix: 'Re: ', at: '2026-09-04T21:30:00Z', to: ['sara'], file: 'Subject: Re: Dinner\n\nGreat' });
  add({ rowid: 1011, box: 1, from: 'mike', subject: 'Found elsewhere', at: '2026-09-05T10:00:00Z', to: ['rob'] });
  add({ rowid: 23456, box: 1, from: 'ana', subject: 'Signed contract', at: '2026-09-06T10:00:00Z', to: ['rob'], partial: true, file: 'Subject: Signed contract\nContent-Type: text/plain\n\nAttached, signed.\n' });
  // 1011 lives outside the usual shard: move it.
  writeFile(join(v10, WORK, 'Archive (old).mbox', 'Messages', '1011.emlx'), emlx('Subject: Found elsewhere\n\nThe file lives in an odd folder'));
  if (withAccounts) {
    const adb = createDb(join(home, 'Library/Accounts/Accounts4.sqlite'), 'CREATE TABLE ZACCOUNT (Z_PK INTEGER PRIMARY KEY, ZIDENTIFIER VARCHAR, ZUSERNAME VARCHAR, ZPARENTACCOUNT INTEGER, ZACCOUNTDESCRIPTION VARCHAR);');
    insert(adb, 'ZACCOUNT', [{ Z_PK: 1, ZIDENTIFIER: 'PARENT-1', ZUSERNAME: 'rob@qwave.test', ZACCOUNTDESCRIPTION: 'Work' }, { Z_PK: 2, ZIDENTIFIER: WORK, ZUSERNAME: null, ZPARENTACCOUNT: 1 }]);
  }
  return { home, db, files };
}

test('mail: bodies, threads, quoting, charsets, bulk and skipped boxes', async () => {
  const { home } = fixture();
  const ctx = makeCtx({ home });
  resetCaches();
  assert.deepEqual(await mail.probe(ctx), { ok: true, count: 12 });
  const totals = await runSource(ctx, 'email', { limit: 3 });
  assert.equal(totals.invalid, 0);
  const recs = ctx.store.records({ source: 'email' });
  assert.deepEqual(schemaErrors(recs), []);
  const by = (subject) => recs.filter((r) => r.title === subject);
  assert.equal(recs.length, 9, 'junk, spam label and deleted rows are skipped');
  assert.ok(!by('You won').length && !by('Cheap pills').length && !by('Old draft').length);

  const [p] = by('Proposal');
  assert.equal(p.text, 'Hi Rob, can we sign Friday?');
  assert.equal(p.thread, 'email:c5');
  assert.equal(p.ts, '2026-09-01T14:00:00.000Z');
  assert.deepEqual(p.from, { handle: 'mailto:ana@acme.test', name: 'Ana López' });
  assert.deepEqual(p.to, [{ handle: 'mailto:rob@qwave.test', name: 'Rob Hernandez' }, { handle: 'mailto:mike@acme.test', name: null }]);
  assert.deepEqual(p.meta.cc, ['mailto:mike@acme.test']);
  assert.equal(p.meta.account, 'rob@qwave.test', 'account address from Accounts4 through the parent account');
  assert.equal(p.meta.mailbox, 'INBOX');
  assert.equal(p.meta.message_id, 'p1@acme.test');
  assert.equal(p.url, 'message://%3Cp1%40acme.test%3E');
  assert.equal(p.id, 'email:m9007199254741994', 'the 64-bit message hash survives as text');

  const [reply] = by('Re: Proposal');
  assert.equal(reply.text, 'Gracias, firmamos mañana.');
  assert.equal(reply.is_from_me, true);
  assert.equal(reply.thread, p.thread);
  assert.equal(by('Reunión mañana')[0].text, 'Nos vemos a las 10.\n\nSaludos');
  const [news] = by('This week');
  assert.equal(news.meta.bulk, true);
  assert.deepEqual(news.meta.attachments, [{ filename: 'issue.pdf', mime: 'application/pdf', size: 6 }]);
  const [summary] = by('Quick question');
  assert.equal(summary.text, 'Are you free Thursday for a call?');
  assert.equal(summary.meta.body, 'summary');
  assert.equal(by('Signed contract')[0].meta.body, 'partial');
  assert.equal(by('Found elsewhere')[0].text, 'The file lives in an odd folder');
  const [dinner] = by('Dinner');
  assert.equal(dinner.meta.account, 'rob.h@gmail.com', 'account address from its Sent mailbox');
  assert.deepEqual(dinner.meta.labels, ['INBOX']);
  assert.equal(by('Re: Dinner')[0].is_from_me, true);
});

test('mail: excluded accounts are never read, and runs are incremental', async () => {
  const { home, db } = fixture({ withAccounts: false });
  const ctx = makeCtx({ home, config: { exclusions: { emailAccounts: ['Rob.H@gmail.com'] } } });
  await runSource(ctx, 'email', { limit: 5 });
  const recs = ctx.store.records({ source: 'email' });
  assert.ok(!recs.some((r) => r.meta.account === 'rob.h@gmail.com'));
  assert.equal(recs.length, 7);
  assert.equal(recs.find((r) => r.title === 'Proposal').meta.account, 'rob@qwave.test', 'no Accounts4: the Sent mailbox still names the account');
  assert.equal((await runSource(ctx, 'email')).inserted, 0);
  insert(db, 'subjects', { ROWID: 99, subject: 'Follow up' });
  insert(db, 'messages', { ROWID: 30000, message_id: 5, sender: 2, subject: 99, date_sent: unix('2026-09-10T10:00:00Z'), date_received: unix('2026-09-10T10:00:00Z'), mailbox: 1 });
  const next = await runSource(ctx, 'email');
  assert.equal(next.inserted, 1);
  const fu = ctx.store.records({ source: 'email' }).find((r) => r.title === 'Follow up');
  assert.equal(fu.meta.body, 'none');
  assert.match(fu.thread, /^email:s[0-9a-f]{16}$/);
});

test('mail: probe without Mail data', async () => {
  const p = await mail.probe(makeCtx({ home: tempHome() }));
  assert.equal(p.ok, false);
  assert.ok(!p.needsFullDiskAccess);
});
