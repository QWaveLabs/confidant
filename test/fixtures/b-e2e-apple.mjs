// The fake Mac for the end-to-end install test, built with Unit A's fixture
// builders: Contacts, iMessage, WhatsApp, Mail, Calendar and call history, with dates
// relative to now so everything falls inside the 60-day install window.
// Plus one Fathom page served through ctx.fetch. All people are invented.
import { insert } from './a-fixtures.mjs';
import { addressBook, chatDb, addMessage, whatsappDb, whatsappContacts, addWa, callHistory, appleSeconds, mailStore, calendarStore, MAIL_WORK } from './a-apple.mjs';
import { mockFetch } from '../c-shared.test.mjs';

const DAY = 86400000;
export const at = (daysAgo, hour = 15) => {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

export const OWNER = { name: 'Sam Rivera', email: 'sam@rivera.example' };
const ANA_TEL = '+15550102000';
const ANA_JID = '15550102000@s.whatsapp.net';
const CARLA_JID = '5215512345678@s.whatsapp.net';

export function buildMac(home) {
  addressBook(home, 'SRC-1', [
    { pk: 1, first: 'Ana', last: 'Ruiz', org: 'Acme', job: 'VP Operations', phones: ['(555) 010-2000'], emails: ['ana@acme.example'] },
    { pk: 2, first: 'Ben', last: 'Cole', org: 'Acme', emails: ['ben@acme.example'], phones: ['(555) 010-3000'] },
    { pk: 3, first: 'Carla', last: 'Diaz', phones: ['+52 1 55 1234 5678'] },
    { pk: 4, first: 'Sam', last: 'Rivera', emails: [OWNER.email], phones: ['+1 305 555 0100'] },
  ]);

  const chat = chatDb(home);
  insert(chat, 'handle', [
    { ROWID: 1, id: ANA_TEL, service: 'iMessage' },
    { ROWID: 2, id: '+15550103000', service: 'iMessage' },
    { ROWID: 3, id: '24273', service: 'SMS' },
  ]);
  insert(chat, 'chat', [
    { ROWID: 1, guid: `iMessage;-;${ANA_TEL}`, style: 45, chat_identifier: ANA_TEL, service_name: 'iMessage' },
    { ROWID: 2, guid: 'iMessage;+;chat777', style: 43, chat_identifier: 'chat777', service_name: 'iMessage', display_name: 'Acme pilot team' },
    { ROWID: 3, guid: 'SMS;-;24273', style: 45, chat_identifier: '24273', service_name: 'SMS' },
  ]);
  insert(chat, 'chat_handle_join', [{ chat_id: 1, handle_id: 1 }, { chat_id: 2, handle_id: 1 }, { chat_id: 2, handle_id: 2 }, { chat_id: 3, handle_id: 3 }]);
  addMessage(chat, { chat: 1, handle: 1, text: 'Can you send the revised proposal by Friday? Legal wants it before the pilot review.', at: at(6) });
  addMessage(chat, { chat: 1, handle: 1, text: 'Yes, I will send it Thursday.', at: at(6, 16), fromMe: true });
  addMessage(chat, { chat: 1, handle: 1, text: 'Loved "Yes, I will send it Thursday."', at: at(6, 17), assoc: 2000 });
  addMessage(chat, { chat: 2, handle: 1, text: 'Procurement needs two signatures on anything over 50k.', at: at(8) });
  addMessage(chat, { chat: 2, handle: 2, text: 'I can be the second signer for the pilot contract.', at: at(8, 16) });
  addMessage(chat, { chat: 2, handle: 0, text: 'Perfect, thanks both.', at: at(8, 17), fromMe: true });
  addMessage(chat, { chat: 3, handle: 3, text: 'Your verification code is 482913', at: at(2), service: 'SMS' });

  const { db: wa, base } = whatsappDb(home);
  insert(wa, 'ZWACHATSESSION', [
    { Z_PK: 1, ZSESSIONTYPE: 0, ZCONTACTJID: CARLA_JID, ZPARTNERNAME: 'Carla Diaz' },
    { Z_PK: 2, ZSESSIONTYPE: 0, ZCONTACTJID: ANA_JID, ZPARTNERNAME: 'Ana Ruiz' },
  ]);
  whatsappContacts(base, [{ Z_PK: 1, ZFULLNAME: 'Carla Diaz', ZPHONENUMBER: '+52 1 55 1234 5678', ZWHATSAPPID: CARLA_JID, ZLID: null }]);
  addWa(wa, { chat: 1, text: 'Happy to introduce you to Dan Park at Northwind Ventures. He invests in pilots like yours.', at: at(3), fromJid: CARLA_JID });
  addWa(wa, { chat: 1, text: 'That would be great, thank you Carla.', at: at(3, 16), fromMe: true, toJid: CARLA_JID });
  addWa(wa, { chat: 2, text: 'Sharing the pilot usage numbers on Monday.', at: at(9), fromJid: ANA_JID });

  const mail = mailStore(home, {
    mailboxes: [{ id: 1, account: MAIL_WORK, path: 'INBOX' }, { id: 2, account: MAIL_WORK, path: 'Sent Messages' }],
    addresses: { sam: [OWNER.email, OWNER.name], ben: ['ben@acme.example', 'Ben Cole'], news: ['news@list.example', 'Weekly News'] },
    accounts: [{ uuid: MAIL_WORK, address: OWNER.email }],
  });
  mail.add({ rowid: 1001, box: 1, from: 'ben', subject: 'Contract draft', at: at(4), to: ['sam'], conv: 7, mid: 'c1@acme.example',
    file: `From: Ben Cole <ben@acme.example>\nTo: ${OWNER.email}\nSubject: Contract draft\nMessage-ID: <c1@acme.example>\nContent-Type: text/plain; charset=utf-8\n\nContract draft attached. Can we sign by October 15?\n` });
  mail.add({ rowid: 1002, box: 2, from: 'sam', subject: 'Contract draft', prefix: 'Re: ', at: at(4, 18), to: ['ben'], conv: 7,
    file: `From: ${OWNER.name} <${OWNER.email}>\nTo: ben@acme.example\nSubject: Re: Contract draft\nContent-Type: text/plain; charset=utf-8\n\nI will review it and get back to you by Monday.\n\nSent from my iPhone\n` });
  mail.add({ rowid: 1003, box: 1, from: 'news', subject: 'This week in pilots', at: at(3), to: ['sam'], listId: 77,
    file: 'From: Weekly News <news@list.example>\nSubject: This week in pilots\nList-Unsubscribe: <mailto:u@list.example>\nContent-Type: text/plain\n\nTen tips for better pilots.\n' });

  const cal = calendarStore(home);
  cal.addEvent({ title: 'Acme roadmap review', start: at(2, 18), end: at(2, 19), organizer: { email: 'ana@acme.example', name: 'Ana Ruiz' }, attendees: [{ email: 'ana@acme.example', name: 'Ana Ruiz' }, { email: OWNER.email, name: OWNER.name, self: true }] });
  cal.addEvent({ title: 'Focus time', start: at(1, 14), end: at(1, 16), attendees: [{ email: 'ana@acme.example', name: 'Ana Ruiz' }] });

  const calls = callHistory(home);
  insert(calls, 'ZCALLRECORD', [
    { Z_PK: 1, ZUNIQUE_ID: 'C-1', ZDATE: appleSeconds(at(5)), ZDURATION: 612, ZADDRESS: Buffer.from(ANA_TEL), ZORIGINATED: 1, ZANSWERED: 1, ZCALLTYPE: 1, ZSERVICE_PROVIDER: 'com.apple.Telephony' },
    { Z_PK: 2, ZUNIQUE_ID: 'C-2', ZDATE: appleSeconds(at(4)), ZDURATION: 0, ZADDRESS: Buffer.from('+15550109999'), ZORIGINATED: 0, ZANSWERED: 0, ZCALLTYPE: 1 },
  ]);
  return { chat, wa };
}

// Three hours later: Ana confirms the proposal, Carla sends the intro.
export function laterMessages({ chat, wa }) {
  addMessage(chat, { chat: 1, handle: 1, text: 'Got the revised proposal, it looks good. Sharing it with legal today.', at: new Date(Date.now() - 60000).toISOString() });
  addWa(wa, { chat: 1, text: 'Just sent the intro email to Dan.', at: new Date(Date.now() - 30000).toISOString(), fromJid: CARLA_JID });
}

export function fathomFetch() {
  const meeting = {
    id: 'pilot-review-1',
    title: 'Pilot review',
    created_at: at(7),
    url: 'https://fathom.video/share/pilot-review-1',
    transcript: [
      { speaker: { display_name: 'Ana Ruiz', matched_calendar_invitee_email: 'ana@acme.example' }, text: 'The pilot numbers look strong.' },
      { speaker: { display_name: 'Ben Cole', matched_calendar_invitee_email: 'ben@acme.example' }, text: 'We want to extend it through October before we sign.' },
      { speaker: { display_name: 'Sam Rivera', matched_calendar_invitee_email: OWNER.email }, text: 'That works. I will send the revised proposal.' },
      { speaker: { display_name: 'Ben Cole', matched_calendar_invitee_email: 'ben@acme.example' }, text: 'I will send the signed contract once legal reviews it.' },
    ],
    default_summary: { markdown_formatted: '## Summary\nReviewed pilot results with Acme and agreed to extend the pilot through October before signing an annual contract.' },
    action_items: [{ description: 'Sam: send the revised proposal' }, { description: 'Ben: send the signed contract after legal review' }],
    recording_duration_in_seconds: 1800,
  };
  return mockFetch([{ status: 200, json: { items: [meeting], next_cursor: null } }]);
}
