import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWords, parseHeaders, parseParams, parseAddresses, parseMessage, emlxMessage, htmlToText, trimQuoted, decodeBytes } from '../engine/lib/a-mime.mjs';

const crlf = (s) => s.replace(/\n/g, '\r\n');

test('RFC 2047 words: base64, Q, adjacent words and charsets', () => {
  assert.equal(decodeWords('=?UTF-8?B?UmV1bmnDs24gbWHDsWFuYQ==?='), 'Reunión mañana');
  assert.equal(decodeWords('=?iso-8859-1?Q?Gracias_por_la_propuesta=2C_Jos=E9?='), 'Gracias por la propuesta, José');
  assert.equal(decodeWords('=?utf-8?q?Hola?= =?utf-8?q?_mundo?='), 'Hola mundo', 'whitespace between encoded words is dropped');
  assert.equal(decodeWords('Re: =?windows-1252?Q?Caf=E9?= today'), 'Re: Café today');
  assert.equal(decodeWords('plain subject'), 'plain subject');
  assert.equal(decodeBytes(Buffer.from([0x93, 0x68, 0x69, 0x94]), 'windows-1252'), '“hi”');
  assert.equal(decodeBytes(Buffer.from('ok'), 'x-unknown-charset'), 'ok');
});

test('headers unfold and parameters decode, including RFC 2231', () => {
  const h = parseHeaders('Subject: a very\r\n long subject\r\nX-Other: 1');
  assert.equal(h[0].value, 'a very long subject');
  assert.equal(h[1].name, 'x-other');
  const p = parseParams('text/plain; charset="ISO-8859-1"; format=flowed');
  assert.deepEqual(p, { type: 'text/plain', params: { charset: 'ISO-8859-1', format: 'flowed' } });
  assert.equal(parseParams("attachment; filename*=UTF-8''Propuesta%20Se%C3%B1al.pdf").params.filename, 'Propuesta Señal.pdf');
  assert.equal(parseParams('attachment; filename*0="Long "; filename*1="name.pdf"').params.filename, 'Long name.pdf');
});

test('address lists with quotes, commas, comments and groups', () => {
  assert.deepEqual(parseAddresses('"López, Ana" <Ana@Acme.test>, bob@b.test (Bob B), Undisclosed recipients:;'), [
    { name: 'López, Ana', address: 'ana@acme.test' },
    { name: 'Bob B', address: 'bob@b.test' },
  ]);
  assert.deepEqual(parseAddresses('Team: a@x.test, b@x.test;'), [{ name: null, address: 'a@x.test' }, { name: null, address: 'b@x.test' }]);
  assert.deepEqual(parseAddresses('=?UTF-8?Q?Mar=C3=ADa?= <maria@x.test>'.replace(/=\?UTF-8\?Q\?Mar=C3=ADa\?=/, 'María')), [{ name: 'María', address: 'maria@x.test' }]);
});

test('multipart: nested mixed/alternative/related, prefers text/plain, lists attachments', () => {
  const raw = crlf(`From: Ana <ana@acme.test>
To: rob@qwave.test
Subject: =?UTF-8?B?UHJvcHVlc3Rh?=
Date: Mon, 1 Sep 2026 10:00:00 -0400 (EDT)
Message-ID: <abc123@acme.test>
Content-Type: multipart/mixed; boundary="outer"

preamble
--outer
Content-Type: multipart/alternative; boundary=inner

--inner
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Hola Rob,=20
la propuesta va adjunta. Caf=C3=A9 ma=C3=B1ana?
--inner
Content-Type: text/html; charset=utf-8

<p>HTML version</p>
--inner--
--outer
Content-Type: application/pdf; name="propuesta.pdf"
Content-Disposition: attachment; filename="propuesta.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQK
--outer--
epilogue text`);
  const m = parseMessage(Buffer.from(raw));
  assert.equal(m.subject, 'Propuesta');
  assert.equal(m.messageId, 'abc123@acme.test');
  assert.equal(m.date, '2026-09-01T14:00:00.000Z');
  assert.deepEqual(m.from, [{ name: 'Ana', address: 'ana@acme.test' }]);
  assert.equal(m.text, 'Hola Rob, \nla propuesta va adjunta. Café mañana?');
  assert.deepEqual(m.attachments, [{ filename: 'propuesta.pdf', mime: 'application/pdf', size: 9 }]);
  assert.ok(!m.text.includes('epilogue'));
  assert.equal(m.bulk, false);
});

test('HTML only, base64 and latin-1, bulk headers, flowed text', () => {
  const html = Buffer.from('<html><head><style>p{}</style></head><body><p>Hola&nbsp;Rob &amp; equipo</p><ul><li>Uno</li><li>Dos</li></ul><div class="gmail_quote">On Mon wrote: old stuff</div></body></html>').toString('base64');
  const m = parseMessage(Buffer.from(crlf(`From: news@list.test\nList-Unsubscribe: <mailto:u@list.test>\nContent-Type: text/html; charset=utf-8\nContent-Transfer-Encoding: base64\n\n${html}`)));
  assert.equal(m.text, 'Hola Rob & equipo\n\n- Uno\n- Dos');
  assert.equal(m.fromHtml, true);
  assert.equal(m.bulk, true);
  const latin = Buffer.concat([Buffer.from('Content-Type: text/plain; charset=iso-8859-1\r\n\r\n'), Buffer.from([0x41, 0xf1, 0x6f])]);
  assert.equal(parseMessage(latin).text, 'Año');
  const flowed = parseMessage(Buffer.from('Content-Type: text/plain; format=flowed\n\nThis line is \nsoft wrapped.\nNew line.'));
  assert.equal(flowed.text, 'This line is soft wrapped.\nNew line.');
});

test('emlx framing: byte count line, message, plist trailer', () => {
  const msg = 'Subject: hi\n\nbody';
  const emlx = Buffer.from(`${Buffer.byteLength(msg)}\n${msg}<?xml version="1.0"?><plist><dict/></plist>`);
  assert.equal(emlxMessage(emlx).toString(), msg);
  assert.equal(parseMessage(emlxMessage(emlx)).text, 'body');
});

test('htmlToText decodes entities and cuts quoted history', () => {
  assert.equal(htmlToText('<div>Precio: 10&euro; &#8211; &#x41;</div><blockquote type="cite">quoted</blockquote>'), 'Precio: 10EUR – A');
  assert.equal(htmlToText('<p>Hi</p><div id="appendonsend"></div><hr><b>From:</b> x'), 'Hi');
});

test('trimQuoted: EN, ES, Outlook, signatures, and forwards kept', () => {
  assert.equal(trimQuoted('Sounds good.\n\nOn Mon, Sep 1, 2026 at 10:00 AM Ana López <ana@acme.test> wrote:\n> old'), 'Sounds good.');
  assert.equal(trimQuoted('Perfecto.\n\nEl lun, 1 sept 2026 a las 10:00, Ana López\n<ana@acme.test> escribió:\n> viejo'), 'Perfecto.');
  assert.equal(trimQuoted('Ok\n________________________________\nFrom: Ana\nSent: Monday\nTo: Rob\nSubject: X\nold'), 'Ok');
  assert.equal(trimQuoted('Listo\nDe: Ana López\nEnviado el: lunes\nPara: Rob\nAsunto: X'), 'Listo');
  assert.equal(trimQuoted('Yes\n\nSent from my iPhone'), 'Yes');
  assert.equal(trimQuoted('Sí\n\nEnviado desde mi iPhone'), 'Sí');
  assert.equal(trimQuoted('Thanks\n-- \nRob Hernandez\nCEO'), 'Thanks');
  assert.equal(trimQuoted('inline\n> quoted line\nanswer'), 'inline\nanswer');
  const fwd = 'FYI\n\n---------- Forwarded message ---------\nFrom: Ana <ana@acme.test>\nDate: Mon\nSubject: Deal\nTo: Rob\n\nThe actual deal terms';
  assert.ok(trimQuoted(fwd).includes('The actual deal terms'));
  assert.ok(trimQuoted('FYI\n________________________________\nFrom: Ana\nSent: Monday\n\nTerms', { keepForwarded: true }).includes('Terms'));
});
