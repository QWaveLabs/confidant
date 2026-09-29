import test from 'node:test';
import assert from 'node:assert/strict';
import { filterRecord, scrubText, emailQuery } from '../engine/privacy.mjs';

const owner = { name: 'Alex Rivera', emails: ['alex@owner.test', 'alex.r@gmail.com'], phones: ['+1 305 555 0100'] };
const cfg = (exclusions) => ({ owner, exclusions });
const ALL = cfg({ categories: ['banking', 'health', 'passwords', 'family', 'personal-email'] });

let n = 0;
const msg = (over = {}) => ({ id: `imessage:${++n}`, source: 'imessage', kind: 'message', ts: '2026-09-01T12:00:00Z', thread: 'imessage:t1', from: { handle: 'tel:+13055551234', name: 'Ana Lopez' }, to: [], is_from_me: false, title: null, text: 'See you at 3', meta: {}, ...over });
const email = (over = {}) => ({ id: `email:${++n}`, source: 'email', kind: 'email', ts: '2026-09-01T12:00:00Z', thread: 'email:c1', from: { handle: 'mailto:ana@acme.com', name: 'Ana Lopez' }, to: [{ handle: 'mailto:alex@owner.test', name: 'Alex Rivera' }], is_from_me: false, title: 'Proposal', text: 'Here is the proposal.', meta: {}, ...over });
const keep = (r, c = ALL) => filterRecord(r, c).keep;
const reason = (r, c = ALL) => filterRecord(r, c).reason;

test('no exclusions keeps everything', () => {
  assert.equal(filterRecord(msg({ text: 'Your verification code is 123456' }), { owner }).keep, true);
  assert.equal(filterRecord(msg(), null).keep, true);
});

test('banking: bank domains and subdomains are excluded, EN and ES', () => {
  assert.equal(reason(email({ from: { handle: 'mailto:no-reply@alertsp.chase.com', name: 'Chase' } })), 'banking');
  assert.equal(reason(email({ from: { handle: 'mailto:notificaciones@bbva.mx', name: 'BBVA México' } })), 'banking');
  assert.equal(reason(email({ from: { handle: 'mailto:alertas@banorte.com', name: null } })), 'banking');
  assert.equal(reason(email({ from: { handle: 'mailto:info@firstcitizensbank.com', name: null } })), 'banking');
  assert.equal(reason(email({ from: { handle: 'mailto:service@bancolombia.com.co', name: null } })), 'banking');
});

test('banking: bank short-code SMS with account language is excluded', () => {
  assert.equal(reason(msg({ from: { handle: 'tel:+24273', name: null }, text: 'Chase: A $52.10 debit card transaction was made on your account ending in 1234.' })), 'banking');
  assert.equal(reason(msg({ from: { handle: 'tel:+26628', name: null }, text: 'BBVA: Compra por $1,250.00 con tu tarjeta terminada en 4321.' })), 'banking');
  assert.equal(reason(msg({ from: { handle: 'tel:+73981', name: null }, text: 'Saldo disponible en tu cuenta terminada en 8899: $10,000' })), 'banking');
});

test('banking: sender and chat names, strict for ambiguous brands', () => {
  assert.equal(reason(msg({ from: { handle: 'tel:+15551112222', name: 'Bank of America' } })), 'banking');
  assert.equal(reason(msg({ from: { handle: 'tel:+525512345678', name: 'Santander México' } })), 'banking');
  assert.equal(reason(msg({ from: { handle: 'tel:+15551112222', name: 'Chase' } })), 'banking');
  assert.equal(reason(msg({ from: { handle: 'tel:+15551112222', name: 'Chase Bank' } })), 'banking');
  assert.equal(keep(msg({ from: { handle: 'tel:+15551112222', name: 'Chase Miller' } })), true, 'a person named Chase stays');
  assert.equal(keep(msg({ from: { handle: 'tel:+15551112222', name: 'Ally Johnson' } })), true, 'a person named Ally stays');
  assert.equal(keep(msg({ text: 'Let us discover what the client needs' })), true);
});

test('banking: business payment tools and client money talk are kept', () => {
  assert.equal(keep(email({ from: { handle: 'mailto:receipts@stripe.com', name: 'Stripe' }, title: 'Payment received', text: 'You received a payment of $4,000 from Acme.' })), true);
  assert.equal(keep(email({ from: { handle: 'mailto:service@paypal.com', name: 'PayPal' }, text: 'Invoice paid' })), true);
  assert.equal(keep(email({ from: { handle: 'mailto:quickbooks@notification.intuit.com', name: 'QuickBooks' }, text: 'Invoice 1042 payment due' })), true);
  assert.equal(keep(email({ text: 'Can you send the wire transfer details? Payment due Friday.' })), true, 'a client asking about a wire stays');
  assert.equal(keep(msg({ text: 'Transferencia enviada, revisa tu correo' })), true, 'a person mentioning a transfer stays');
});

test('health: providers, pharmacies and strong phrases, EN and ES', () => {
  assert.equal(reason(email({ from: { handle: 'mailto:noreply@mychart.org', name: 'MyChart' }, title: 'New test result' })), 'health');
  assert.equal(reason(email({ from: { handle: 'mailto:cvs@cvs.com', name: 'CVS Pharmacy' } })), 'health');
  assert.equal(reason(email({ from: { handle: 'mailto:citas@sonrisadental.mx', name: null } })), 'health');
  assert.equal(reason(msg({ from: { handle: 'tel:+525598765432', name: 'Clínica San José' } })), 'health');
  assert.equal(reason(msg({ text: 'Your prescription is ready for pickup' })), 'health');
  assert.equal(reason(msg({ text: 'Te recuerdo tu cita médica mañana a las 10' })), 'health');
  assert.equal(reason(msg({ text: 'Ya salieron los resultados de laboratorio' })), 'health');
  assert.equal(reason(msg({ text: 'Tu receta está lista en farmacia' })), 'health');
  assert.equal(reason({ ...msg(), kind: 'event', source: 'calendar', title: 'Dentist', text: '' }), 'health');
  assert.equal(reason({ ...msg(), kind: 'event', source: 'calendar', title: 'Cita con la doctora', text: '' }), 'health');
});

test('health: recipes, meetings and business words are kept', () => {
  assert.equal(keep(msg({ text: 'Te paso la receta del pastel' })), true, 'receta alone is a recipe');
  assert.equal(keep(msg({ text: 'Tenemos cita con el cliente el martes' })), true, 'cita alone is a meeting');
  assert.equal(keep({ ...msg(), kind: 'event', source: 'calendar', title: 'Call with Dr. Patel (investor)', text: '' }), true);
  assert.equal(keep({ ...msg(), kind: 'meeting', source: 'zoom_local', title: 'Weekly sync', text: 'Speaker 1: my prescription is ready, anyway, the pipeline' }), true, 'long transcripts are not dropped by a phrase');
});

test('passwords: codes, resets and password managers, EN and ES', () => {
  assert.equal(reason(msg({ from: { handle: 'tel:+32665', name: null }, text: 'Your verification code is 482913' })), 'passwords');
  assert.equal(reason(msg({ text: 'G-482913 is your Google verification code.' })), 'passwords');
  assert.equal(reason(msg({ text: 'Tu código de verificación es 4821' })), 'passwords');
  assert.equal(reason(email({ from: { handle: 'mailto:no-reply@accounts.example.com', name: null }, title: 'Reset your password', text: 'Click the link' })), 'passwords');
  assert.equal(reason(email({ title: 'Restablecer tu contraseña', text: 'Sigue el enlace' })), 'passwords');
  assert.equal(reason(email({ from: { handle: 'mailto:hello@1password.com', name: '1Password' } })), 'passwords');
  assert.equal(reason(msg({ text: 'the wifi contraseña: Qwave2026!' })), 'passwords');
});

test('passwords: meeting invites and code reviews are kept', () => {
  assert.equal(keep(email({ title: 'Zoom meeting invite', text: 'Join Zoom Meeting\nMeeting ID: 812 3456 7890\nPasscode: 123456' })), true);
  assert.equal(keep({ ...msg(), kind: 'event', source: 'calendar', title: 'Sync', text: 'Access code: 123 456 789' }), true);
  assert.equal(keep(msg({ text: 'Can you do a code review today?' })), true);
  assert.equal(keep(msg({ text: 'Cuál es la palabra clave: innovación' })), true);
});

test('family: relatives in DMs and family chats, not family offices', () => {
  assert.equal(reason(msg({ from: { handle: 'tel:+13055559999', name: 'Mom' } })), 'family');
  assert.equal(reason(msg({ from: { handle: 'tel:+13055559999', name: 'Mamá Rosa' } })), 'family');
  assert.equal(reason(msg({ is_from_me: true, from: { handle: 'tel:+13055550100', name: 'Alex Rivera' }, to: [{ handle: 'tel:+13055559999', name: 'Tío Juan' }] })), 'family', 'my messages to a relative too');
  assert.equal(reason(msg({ to: [{ handle: 'group:imessage:chat1', name: 'Familia Hernández' }], meta: { chat_name: 'Familia Hernández', is_group: true } })), 'family');
  assert.equal(keep(msg({ from: { handle: 'tel:+13055559999', name: 'Mama Juana Bar Miami' } })), true);
  assert.equal(keep(msg({ from: { handle: 'tel:+13055559999', name: 'Son Nguyen' } })), true);
  assert.equal(keep(msg({ to: [{ handle: 'group:whatsapp:1@g.us', name: 'Smith Family Office deal' }], meta: { chat_name: 'Smith Family Office deal', is_group: true } })), true);
  assert.equal(keep(msg({ from: { handle: 'tel:+13055559999', name: 'Bro Code Agency' } })), true);
});

test('people: excluded names drop the whole DM thread, only their own lines in groups', () => {
  const c = cfg({ people: ['María José Pérez'] });
  assert.equal(reason(msg({ from: { handle: 'tel:+1', name: 'Maria Jose Perez' } }), c), 'person');
  assert.equal(reason(msg({ is_from_me: true, from: { handle: 'tel:+13055550100', name: 'Alex' }, to: [{ handle: 'tel:+13055557777', name: 'María José Pérez' }] }), c), 'person');
  assert.equal(reason(msg({ from: { handle: 'name:perez maria jose', name: null } }), c), 'person', 'token order does not matter');
  const group = { to: [{ handle: 'group:whatsapp:9@g.us', name: 'Deal room' }], meta: { is_group: true, chat_name: 'Deal room' } };
  assert.equal(keep(msg({ ...group, from: { handle: 'tel:+15550001111', name: 'Ana Lopez' } }), c), true);
  assert.equal(reason(msg({ ...group, from: { handle: 'tel:+15550002222', name: 'María José Pérez' } }), c), 'person');
  assert.equal(reason({ ...msg(), kind: 'contact', source: 'contacts', from: null, title: 'María José Pérez', text: '', meta: { names: ['María José Pérez'], phones: [], emails: [] } }, c), 'person');
  const meeting = { ...msg(), kind: 'meeting', source: 'wispr', from: null, to: ['A', 'B', 'C', 'María José Pérez'].map((x) => ({ handle: null, name: x })) };
  assert.equal(keep(meeting, c), true, 'a big meeting she attended stays');
});

test('handles, domains, chats and keywords always apply', () => {
  assert.equal(reason(msg({ from: { handle: 'tel:+13055551234' } }), cfg({ handles: ['(305) 555-1234'] })), 'handle');
  assert.equal(reason(email(), cfg({ handles: ['ANA@ACME.COM'] })), 'handle');
  assert.equal(reason(email(), cfg({ people: ['ana@acme.com'] })), 'handle', 'an address typed into people');
  assert.equal(reason(email({ from: { handle: 'mailto:x@mail.lawfirm.com' } }), cfg({ domains: ['@lawfirm.com'] })), 'domain');
  const chat = { thread: 'whatsapp:120363@g.us', to: [{ handle: 'group:whatsapp:120363@g.us', name: 'Pádel Sábados' }], meta: { is_group: true, chat_name: 'Pádel Sábados' } };
  assert.equal(reason(msg(chat), cfg({ chats: ['padel sabados'] })), 'chat');
  assert.equal(reason(msg(chat), cfg({ chats: ['120363@g.us'] })), 'chat');
  assert.equal(reason(msg({ is_from_me: true, ...chat }), cfg({ chats: ['Pádel Sábados'] })), 'chat', 'my own messages in that chat too');
  assert.equal(reason(msg({ text: 'About the divorce papers' }), cfg({ keywords: ['divorce'] })), 'keyword');
  assert.equal(keep(msg({ text: 'Divorced parents' }), cfg({ keywords: ['divorce'] })), true, 'whole words only');
  assert.equal(reason(msg({ text: 'Firma del divorcio' }), cfg({ keywords: ['Divorcio'] })), 'keyword');
  assert.equal(reason(msg({ to: [{ handle: 'group:imessage:iMessage;+;chat77', name: null }], meta: { is_group: true } }), cfg({ handles: ['group:imessage:iMessage;+;chat77'] })), 'handle');
});

test('personal email accounts: explicit list and the consumer address heuristic', () => {
  assert.equal(reason(email({ meta: { account: 'alex.r@gmail.com' } }), cfg({ emailAccounts: ['Alex.R@gmail.com'] })), 'email-account');
  assert.equal(keep(email({ meta: { account: 'alex@owner.test' } }), cfg({ emailAccounts: ['alex.r@gmail.com'] })), true);
  assert.equal(reason(email({ meta: { account: 'alex.r@gmail.com' } }), cfg({ categories: ['personal-email'] })), 'email-account');
  assert.equal(keep(email({ meta: { account: 'alex.r@gmail.com' } }), { owner: { emails: ['alex.r@gmail.com'] }, exclusions: { categories: ['personal-email'] } }), true, 'a gmail-only owner keeps it');
});

test('scrubText masks Luhn-valid cards only', () => {
  const r = scrubText('Card 4111 1111 1111 1111 and amex 3782-822463-10005, visa 4012888888881881.');
  assert.equal(r.text, 'Card [card] and amex [card], visa [card].');
  assert.deepEqual(r.redactions, ['card', 'card', 'card']);
  for (const s of ['Call +1 305 555 0100', 'Order 112-1234567-1234567', 'Invoice 4111 1111 1111 1112', 'Tracking 1Z999AA10123456784', 'Total $1,234,567.89', 'Date 2026-09-28 12:30', 'Stamp 20260928123045', 'Ref 5105 1051 0510 5106 1']) {
    assert.equal(scrubText(s).text, s, s);
  }
});

test('scrubText masks IBANs with a valid checksum, SSNs with context', () => {
  assert.equal(scrubText('IBAN: DE89 3704 0044 0532 0130 00 PLEASE PAY').text, 'IBAN: [iban] PLEASE PAY');
  assert.equal(scrubText('ES9121000418450200051332').text, '[iban]');
  assert.equal(scrubText('DE89 3704 0044 0532 0130 01').text, 'DE89 3704 0044 0532 0130 01', 'bad checksum stays');
  assert.equal(scrubText('My SSN is 123-45-6789').text, 'My SSN is [ssn]');
  assert.equal(scrubText('Número de seguro social: 123 45 6789').text, 'Número de seguro social: [ssn]');
  assert.equal(scrubText('Part number 123-45-6789').text, 'Part number 123-45-6789', 'no context, no change');
});

test('scrubText masks one-time codes near code words, not other numbers', () => {
  assert.equal(scrubText('Your verification code is 482913.').text, 'Your verification code is [code].');
  assert.equal(scrubText('Tu código de verificación es 4821').text, 'Tu código de verificación es [code]');
  assert.equal(scrubText('482913 is your Instagram code').text, '[code] is your Instagram code');
  assert.equal(scrubText('G-482913 is your Google verification code.').text, '[code] is your Google verification code.');
  assert.equal(scrubText('OTP: 123 456').text, 'OTP: [code]');
  for (const s of ['Zip code 33101', 'Código postal 06600', 'Promo code 2024 saves 20%', 'Meeting ID: 812 3456 7890', 'Call me at 305 555 0100', 'Order code 99812', 'The code of conduct 2026']) {
    assert.equal(scrubText(s).text, s, s);
  }
});

test('scrubText masks written passwords', () => {
  assert.equal(scrubText('wifi password: Qwave2026!').text, 'wifi password: [password]');
  assert.equal(scrubText('la contraseña es Tigre#88.').text, 'la contraseña es [password].');
  assert.equal(scrubText('Passcode: aB3dE9').text, 'Passcode: [password]');
  assert.equal(scrubText('the password is wrong').text, 'the password is wrong');
  assert.equal(scrubText('palabra clave: innovación').text, 'palabra clave: innovación');
  assert.deepEqual(scrubText(null), { text: null, redactions: [] });
});

test('emailQuery builds a Gmail search suffix from the exclusions', () => {
  const base = emailQuery({});
  assert.ok(base.includes('-category:promotions') && base.includes('-category:social'));
  const q = emailQuery({ exclusions: { categories: ['banking', 'passwords'], domains: ['lawfirm.com'], handles: ['ex@old.com'], keywords: ['divorce papers'], people: ['Mom'] } });
  assert.match(q, /-from:\([^)]*chase\.com OR [^)]*lawfirm\.com[^)]*\)/);
  assert.match(q, /-subject:\("verification code" OR /);
  assert.ok(q.includes('-to:(ex@old.com)'));
  assert.ok(q.includes('-"divorce papers"'));
  assert.ok(q.includes('-from:(Mom)'));
  assert.ok(!/—|--/.test(q));
});
