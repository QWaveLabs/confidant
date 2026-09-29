// A small RFC 822 / MIME reader for Apple Mail's .emlx files. Zero deps.
// It unfolds headers, decodes RFC 2047 words and RFC 2231 parameters, walks
// nested multiparts, decodes base64 and quoted-printable, converts charsets
// with TextDecoder, prefers text/plain (falling back to HTML as text), and
// trims quoted replies and obvious signatures.

const CHARSET_ALIASES = {
  utf8: 'utf-8',
  'us-ascii': 'utf-8',
  ascii: 'utf-8',
  latin1: 'iso-8859-1',
  'latin-1': 'iso-8859-1',
  cp1252: 'windows-1252',
  'x-cp1252': 'windows-1252',
  'ks_c_5601-1987': 'euc-kr',
  gb2312: 'gbk',
  'x-mac-roman': 'macintosh',
  macroman: 'macintosh',
  'unicode-1-1-utf-7': 'utf-8',
};

const decoders = new Map();
export function decodeBytes(bytes, charset = 'utf-8') {
  let label = String(charset || 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '').replace(/\*.*$/, '');
  label = CHARSET_ALIASES[label] ?? label;
  let d = decoders.get(label);
  if (!d) {
    try {
      d = new TextDecoder(label);
    } catch {
      d = new TextDecoder('utf-8');
    }
    decoders.set(label, d);
  }
  return d.decode(bytes);
}

// Header bytes are usually ASCII, but raw 8-bit UTF-8 headers exist. Latin-1
// is the fallback when the bytes are not valid UTF-8.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
function headerText(bytes) {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return decodeBytes(bytes, 'windows-1252');
  }
}

function qpBytes(input, { header = false } = {}) {
  const s = header ? input.replace(/_/g, ' ') : input.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = s.charCodeAt(i);
      if (code < 256) out.push(code);
      else out.push(...Buffer.from(ch, 'utf8'));
    }
  }
  return Buffer.from(out);
}

// RFC 2047 encoded words: =?charset?B|Q?text?=. Whitespace between adjacent
// encoded words is dropped.
export function decodeWords(value) {
  if (!value || !value.includes('=?')) return value ?? '';
  return value
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?[^?]+\?[bBqQ]\?[^?]*\?=)/g, '$1')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (m, charset, enc, text) => {
      try {
        const bytes = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : qpBytes(text, { header: true });
        return decodeBytes(bytes, charset);
      } catch {
        return m;
      }
    });
}

// Header block -> [{ name (lowercase), value (decoded) }].
export function parseHeaders(block) {
  const lines = block.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1].raw += ` ${line.trim()}`;
    else {
      const i = line.indexOf(':');
      if (i > 0) out.push({ name: line.slice(0, i).trim().toLowerCase(), raw: line.slice(i + 1).trim() });
    }
  }
  return out.map((h) => ({ name: h.name, raw: h.raw, value: decodeWords(h.raw) }));
}

// "type/subtype; a=b; c*=utf-8''x" -> { type, params }
export function parseParams(value) {
  const parts = [];
  let cur = '';
  let quote = false;
  for (const ch of String(value ?? '')) {
    if (ch === '"') quote = !quote;
    if (ch === ';' && !quote) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  const type = parts.shift().trim().toLowerCase();
  const params = {};
  const continued = {};
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    const key = p.slice(0, i).trim().toLowerCase();
    let val = p.slice(i + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    const m = /^([^*]+)\*(\d+)?(\*)?$/.exec(key);
    if (m) {
      const [, base, n, star] = m;
      const encoded = star === '*' || (n == null && key.endsWith('*'));
      (continued[base] ??= []).push({ n: Number(n ?? 0), val, encoded });
    } else params[key] = decodeWords(val);
  }
  for (const [base, pieces] of Object.entries(continued)) {
    pieces.sort((a, b) => a.n - b.n);
    let charset = 'utf-8';
    const bytes = [];
    pieces.forEach((piece, idx) => {
      let v = piece.val;
      if (piece.encoded) {
        if (idx === 0) {
          const q = /^([^']*)'[^']*'(.*)$/.exec(v);
          if (q) {
            charset = q[1] || 'utf-8';
            v = q[2];
          }
        }
        bytes.push(...Buffer.from(v.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1'));
      } else bytes.push(...Buffer.from(v, 'utf8'));
    });
    params[base] = decodeBytes(Buffer.from(bytes), charset);
  }
  return { type, params };
}

// Address lists: "Ana <ana@x.com>, \"Lopez, Juan\" <juan@y.com>, bob@z.com (Bob)".
export function parseAddresses(value) {
  if (!value) return [];
  const items = [];
  let cur = '';
  let quote = false;
  let angle = 0;
  let paren = 0;
  for (const ch of value) {
    if (ch === '"' && !paren) quote = !quote;
    else if (!quote) {
      if (ch === '<') angle++;
      else if (ch === '>') angle = Math.max(0, angle - 1);
      else if (ch === '(') paren++;
      else if (ch === ')') paren = Math.max(0, paren - 1);
    }
    if ((ch === ',' || ch === ';') && !quote && !angle && !paren) {
      items.push(cur);
      cur = '';
    } else cur += ch;
  }
  items.push(cur);
  const out = [];
  for (let item of items) {
    item = item.trim();
    if (!item) continue;
    item = item.replace(/^[^"<]*?:\s*/, (m) => (m.includes('@') ? m : '')); // group label "Team: a, b;"
    const angleM = /<([^>]*)>/.exec(item);
    let address;
    let name;
    if (angleM) {
      address = angleM[1].trim();
      name = item.slice(0, angleM.index).trim();
    } else {
      const comment = /\(([^)]*)\)/.exec(item);
      address = item.replace(/\([^)]*\)/g, '').trim();
      name = comment ? comment[1].trim() : '';
    }
    name = name.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1').trim();
    if (!/@/.test(address)) continue;
    out.push({ name: name && name !== address ? name : null, address: address.toLowerCase() });
  }
  return out;
}

function splitHeaderBody(buf) {
  const s = buf.toString('latin1');
  const m = /\r?\n\r?\n/.exec(s);
  if (!m) return { head: buf, body: Buffer.alloc(0) };
  return { head: buf.subarray(0, m.index), body: buf.subarray(m.index + m[0].length) };
}

function decodeTransfer(body, encoding) {
  const enc = String(encoding ?? '').trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return qpBytes(body.toString('latin1'));
  return body;
}

function unflow(text, delsp) {
  const lines = text.split('\n');
  const out = [];
  let buf = '';
  for (let line of lines) {
    if (line.startsWith(' ')) line = line.slice(1);
    if (line.endsWith(' ') && line !== '-- ') buf += delsp ? line.slice(0, -1) : line;
    else {
      out.push(buf + line);
      buf = '';
    }
  }
  if (buf) out.push(buf);
  return out.join('\n');
}

function walk(buf, acc, depth = 0) {
  const { head, body } = splitHeaderBody(buf);
  const headers = parseHeaders(headerText(head));
  const get = (n) => headers.find((h) => h.name === n)?.value ?? null;
  const getRaw = (n) => headers.find((h) => h.name === n)?.raw ?? null;
  const { type, params } = parseParams(getRaw('content-type') ?? 'text/plain');
  const disp = parseParams(getRaw('content-disposition') ?? '');
  const filename = disp.params.filename ?? params.name ?? null;
  const encoding = get('content-transfer-encoding');
  if (type.startsWith('multipart/') && params.boundary && depth < 12) {
    const text = body.toString('latin1');
    const esc = params.boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const close = new RegExp(`(?:^|\\r?\\n)--${esc}--`).exec(text);
    const scoped = close ? text.slice(0, close.index) : text;
    const pieces = scoped.split(new RegExp(`(?:^|\\r?\\n)--${esc}[ \\t]*(?:\\r?\\n|$)`));
    pieces.shift(); // preamble
    const parts = pieces.filter((p) => p.trim()).map((p) => Buffer.from(p, 'latin1'));
    if (type === 'multipart/alternative') {
      const alt = parts.map((p) => {
        const sub = { text: [], html: [], attachments: [], forwarded: [] };
        walk(p, sub, depth + 1);
        return sub;
      });
      const plain = alt.find((a) => a.text.length);
      const html = alt.find((a) => a.html.length);
      if (plain) acc.text.push(...plain.text);
      else if (html) acc.html.push(...html.html);
      for (const a of alt) {
        acc.attachments.push(...a.attachments);
        acc.forwarded.push(...a.forwarded);
      }
    } else for (const p of parts) walk(p, acc, depth + 1);
    return headers;
  }
  if (type === 'message/rfc822' && depth < 12) {
    const inner = { text: [], html: [], attachments: [], forwarded: [] };
    walk(decodeTransfer(body, encoding), inner, depth + 1);
    acc.attachments.push({ filename: filename ?? 'forwarded message', mime: type, size: body.length });
    acc.forwarded.push(inner);
    return headers;
  }
  if (disp.type === 'attachment' || !type.startsWith('text/')) {
    const size = /base64/i.test(encoding ?? '') ? Math.floor((body.length * 3) / 4) : body.length;
    acc.attachments.push({ filename: filename ?? null, mime: type || null, size });
    return headers;
  }
  let text = decodeBytes(decodeTransfer(body, encoding), params.charset).replace(/\r\n?/g, '\n');
  if (type === 'text/html') acc.html.push(text);
  else {
    if (String(params.format).toLowerCase() === 'flowed') text = unflow(text, String(params.delsp).toLowerCase() === 'yes');
    acc.text.push(text);
  }
  return headers;
}

// .emlx: "<byte count>\n" + RFC 822 message + Apple plist trailer.
export function emlxMessage(buf) {
  const nl = buf.indexOf(0x0a);
  if (nl > 0 && nl < 16) {
    const count = Number(buf.subarray(0, nl).toString('latin1').trim());
    if (Number.isInteger(count) && count > 0) return buf.subarray(nl + 1, nl + 1 + count);
  }
  return buf;
}

export function parseMessage(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const acc = { text: [], html: [], attachments: [], forwarded: [] };
  const headers = walk(buf, acc);
  const get = (n) => headers.find((h) => h.name === n)?.value ?? null;
  const all = (n) => headers.filter((h) => h.name === n).map((h) => h.value);
  let text = acc.text.join('\n\n').trim();
  let fromHtml = false;
  if (!text && acc.html.length) {
    text = htmlToText(acc.html.join('\n'));
    fromHtml = true;
  }
  if (!text && acc.forwarded.length) {
    const f = acc.forwarded[0];
    text = f.text.join('\n\n').trim() || htmlToText(f.html.join('\n'));
  }
  const dateRaw = get('date');
  const dateMs = dateRaw ? Date.parse(dateRaw.replace(/\s*\([^)]*\)\s*$/, '')) : NaN;
  const precedence = String(get('precedence') ?? '').toLowerCase();
  const auto = String(get('auto-submitted') ?? '').toLowerCase();
  return {
    headers,
    get,
    all,
    subject: get('subject'),
    from: parseAddresses(get('from')),
    to: parseAddresses(all('to').join(', ')),
    cc: parseAddresses(all('cc').join(', ')),
    bcc: parseAddresses(all('bcc').join(', ')),
    replyTo: parseAddresses(get('reply-to')),
    date: Number.isNaN(dateMs) ? null : new Date(dateMs).toISOString(),
    messageId: (get('message-id') ?? '').replace(/^\s*<|>\s*$/g, '').trim() || null,
    inReplyTo: (get('in-reply-to') ?? '').replace(/^\s*<|>\s*$/g, '').trim() || null,
    references: (get('references') ?? '').match(/<[^>]+>/g)?.map((r) => r.slice(1, -1)) ?? [],
    text,
    fromHtml,
    attachments: acc.attachments,
    bulk: !!get('list-unsubscribe') || !!get('list-id') || ['bulk', 'list', 'junk'].includes(precedence),
    automated: !!auto && auto !== 'no',
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '\u2013', mdash: '\u2014', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', bull: '*', middot: '*', copy: '(c)', reg: '(R)', trade: '(TM)', euro: 'EUR', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', iexcl: '¡', iquest: '¿', ordm: 'º', ordf: 'ª', zwnj: '', zwj: '', shy: '' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Quoted history in HTML mail starts at one of these; everything after is cut.
const HTML_QUOTE_START = /<div[^>]+class=["'][^"']*gmail_quote|<blockquote[^>]*type=["']cite|<div[^>]+id=["']?(appendonsend|divRplyFwdMsg|mail-editor-reference-message-container)|<hr[^>]+id=["']?stopSpelling|<div[^>]+class=["'][^"']*(yahoo_quoted|moz-cite-prefix|OutlookMessageHeader)/i;

export function htmlToText(html, { cutQuotes = true } = {}) {
  let s = String(html);
  if (cutQuotes) {
    const m = HTML_QUOTE_START.exec(s);
    if (m) s = s.slice(0, m.index);
  }
  s = s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|tr|h[1-6]|ul|ol|table|blockquote|section|article|header|footer)>/gi, '\n')
    .replace(/<(p|div|tr|h[1-6]|table|blockquote)[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s)
    .replace(/[   ]/g, ' ')
    .replace(/[​-‍⁠﻿͏­]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// Quoted replies and obvious signatures. Forwarded messages are kept: their
// content is usually the point of the email.
const REPLY_HEADER = [
  /^On .{3,300}wrote:\s*$/i,
  /^El .{3,300}escribi[oó]:\s*$/i,
  /^Le .{3,300}a [ée]crit\s?:\s*$/i,
  /^Am .{3,300}schrieb .{0,200}:\s*$/i,
  /^Em .{3,300}escreveu:\s*$/i,
  /^-{2,}\s*(Original Message|Mensaje original|Message d'origine|Mensagem original)\s*-{2,}\s*$/i,
];
const OUTLOOK_FROM = /^\*?(From|De|Von):\*?\s.+/i;
const OUTLOOK_NEXT = /^\*?(Sent|Date|To|Subject|Enviado|Fecha|Para|Asunto|Cc|Enviado el|Gesendet|Envoyé|Objet)( el)?:\*?\s?/i;
const SIGNOFF = /^(Sent from my (iPhone|iPad|Android|Galaxy|Samsung|mobile device|BlackBerry)|Enviado desde mi (iPhone|iPad|Android|Samsung|celular|móvil|dispositivo)|Get Outlook for (iOS|Android)|Obtener Outlook para (iOS|Android)|Enviado desde Outlook|Sent from Outlook|Sent from Mail for Windows|Enviado desde Correo para Windows|Sent with Proton Mail|Sent from Yahoo Mail)/i;

// keepForwarded: for FW:/RV: subjects, Outlook "From:" blocks are the
// forwarded content, not quoted history.
export function trimQuoted(text, { keepForwarded = false } = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const joined = `${line} ${(lines[i + 1] ?? '').trim()}`.trim();
    if (REPLY_HEADER.some((re) => re.test(line))) {
      end = i;
      break;
    }
    if (/^(On|El) /i.test(line) && REPLY_HEADER.slice(0, 2).some((re) => re.test(joined))) {
      end = i;
      break;
    }
    if (!keepForwarded && /^_{8,}\s*$/.test(line) && OUTLOOK_FROM.test((lines[i + 1] ?? '').trim())) {
      end = i;
      break;
    }
    if (!keepForwarded && OUTLOOK_FROM.test(line) && lines.slice(i + 1, i + 5).some((l) => OUTLOOK_NEXT.test(l.trim()))) {
      if (i > 0 && /^-{3,}\s*(Forwarded message|Mensaje reenviado)/i.test((lines[i - 1] ?? '').trim())) continue;
      end = i;
      break;
    }
    if (line === '--' || lines[i] === '-- ') {
      end = i;
      break;
    }
    if (SIGNOFF.test(line)) {
      end = i;
      break;
    }
  }
  return lines
    .slice(0, end)
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
