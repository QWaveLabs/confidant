// `confidant chats [--json] [--limit N]`
//
// Run before anything is extracted, so the person can leave people and group
// chats out from the very start: their group chats and the people they
// message most, from iMessage and WhatsApp on this Mac. Metadata only:
// chat names, member names, message counts and the date of the last
// message. Never a word of any message, and nothing is stored.
//
// Every row carries the exact `init --resume` flags that exclude it:
// `--exclude-chat <thread id>` for a group (matches the whole thread,
// named or not), and `--exclude-handle` plus `--exclude-person` for a
// person, so their messages go from every chat, not only the one-to-one.
import { libraryPath, unreadable, openCopy, columns } from './lib/a-local.mjs';
import { contactNames } from './lib/a-addressbook.mjs';
import { toHandle, phoneHandle, parseHandle } from './lib/handles.mjs';

const APPLE_EPOCH_MS = 978307200000;
const GROUP_STYLE = 43;
const WA_CONTAINER = ['Group Containers', 'group.net.whatsapp.WhatsApp.shared'];
const WA_SKIP = new Set([2, 3, 4]); // broadcast lists, status, communities

const day = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : null);

function memberLabel(names) {
  const known = names.filter(Boolean);
  if (!known.length) return null;
  return known.length > 4 ? `${known.slice(0, 4).join(', ')} +${known.length - 4}` : known.join(', ');
}

function imessage(ctx, names) {
  const path = libraryPath(ctx, 'Messages', 'chat.db');
  const bad = unreadable(ctx, 'imessage', path, 'Messages database');
  if (bad) return { status: bad, groups: [], people: [] };
  const db = openCopy(ctx, path);
  const cc = columns(db, 'chat');
  const rows = db.prepare(`
    SELECT c.ROWID AS rowid, c.guid AS guid, ${cc.pick('style', 'style', 'c.style')}, ${cc.pick('chat_identifier', 'ident', 'c.chat_identifier')},
      ${cc.pick('display_name', 'display', 'c.display_name')}, COUNT(j.message_id) AS n,
      MAX(CASE WHEN m.date > 100000000000 THEN m.date / 1000000 ELSE m.date * 1000 END) AS last_ms
    FROM chat c JOIN chat_message_join j ON j.chat_id = c.ROWID JOIN message m ON m.ROWID = j.message_id
    GROUP BY c.ROWID`).all();
  const members = new Map();
  for (const r of db.prepare('SELECT j.chat_id AS chat, h.id AS id FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id').all()) {
    if (!members.has(r.chat)) members.set(r.chat, []);
    members.get(r.chat).push(r.id);
  }
  const groups = [];
  const people = [];
  for (const r of rows) {
    const last = r.last_ms == null ? null : Number(r.last_ms) + APPLE_EPOCH_MS;
    if (Number(r.style) === GROUP_STYLE) {
      const memberNames = (members.get(r.rowid) ?? []).map((id) => names.nameFor(toHandle(id)) ?? id);
      groups.push({ source: 'imessage', name: r.display || null, members: memberLabel(memberNames), messages: Number(r.n), lastMs: last, id: `imessage:${r.guid}` });
    } else {
      const handle = toHandle(r.ident);
      if (!handle) continue;
      people.push({ source: 'imessage', handle, name: names.nameFor(handle), messages: Number(r.n), lastMs: last });
    }
  }
  return { status: { ok: true }, groups, people };
}

function whatsapp(ctx, names) {
  const path = libraryPath(ctx, ...WA_CONTAINER, 'ChatStorage.sqlite');
  const bad = unreadable(ctx, 'whatsapp', path, 'WhatsApp database');
  if (bad) return { status: bad, groups: [], people: [] };
  const db = openCopy(ctx, path);
  const sc = columns(db, 'ZWACHATSESSION');
  const rows = db.prepare(`
    SELECT s.Z_PK AS pk, s.ZCONTACTJID AS jid, ${sc.pick('ZPARTNERNAME', 'name', 's.ZPARTNERNAME')}, ${sc.pick('ZSESSIONTYPE', 'type', 's.ZSESSIONTYPE')},
      COUNT(m.Z_PK) AS n, MAX(m.ZMESSAGEDATE) AS last_s
    FROM ZWACHATSESSION s JOIN ZWAMESSAGE m ON m.ZCHATSESSION = s.Z_PK
    GROUP BY s.Z_PK`).all();
  const groups = [];
  const people = [];
  for (const r of rows) {
    const type = Number(r.type ?? 0);
    if (WA_SKIP.has(type) || !r.jid) continue;
    const last = r.last_s == null ? null : Math.round(Number(r.last_s) * 1000) + APPLE_EPOCH_MS;
    const [user, server] = String(r.jid).split('@');
    if (type === 1 || server === 'g.us') {
      groups.push({ source: 'whatsapp', name: r.name || null, members: null, messages: Number(r.n), lastMs: last, id: `whatsapp:${r.jid}` });
    } else {
      const handle = server === 's.whatsapp.net' && /^\d{6,15}$/.test(user) ? phoneHandle(`+${user}`) : null;
      people.push({ source: 'whatsapp', handle, name: r.name || (handle && names.nameFor(handle)) || null, messages: Number(r.n), lastMs: last, id: `whatsapp:${r.jid}` });
    }
  }
  return { status: { ok: true }, groups, people };
}

// One row per person across sources: same phone or email means same person.
function mergePeople(rows) {
  const byKey = new Map();
  for (const p of rows) {
    const key = p.handle ?? `${p.source}:${p.id ?? p.name}`;
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, { name: p.name, handle: p.handle, sources: [p.source], messages: p.messages, lastMs: p.lastMs, chatIds: p.id ? [p.id] : [] });
      continue;
    }
    cur.name = cur.name ?? p.name;
    if (!cur.sources.includes(p.source)) cur.sources.push(p.source);
    cur.messages += p.messages;
    cur.lastMs = Math.max(cur.lastMs ?? 0, p.lastMs ?? 0) || null;
    if (p.id) cur.chatIds.push(p.id);
  }
  return [...byKey.values()];
}

function personFlags(p) {
  const flags = [];
  if (p.handle && parseHandle(p.handle).scheme !== 'name') flags.push(['--exclude-handle', p.handle]);
  if (p.name) flags.push(['--exclude-person', p.name]);
  if (!flags.length) for (const id of p.chatIds) flags.push(['--exclude-chat', id]);
  return flags;
}

// A source that changed shape or lost access mid-read reports why and the
// list carries on with the other one.
function safely(ctx, fn, names) {
  try {
    return fn(ctx, names);
  } catch (err) {
    return { status: { ok: false, reason: err.message, needsFullDiskAccess: !!err.needsFullDiskAccess }, groups: [], people: [] };
  }
}

export function listChats(ctx, { limit = 30 } = {}) {
  const names = contactNames(ctx);
  const im = safely(ctx, imessage, names);
  const wa = safely(ctx, whatsapp, names);
  const byActivity = (a, b) => b.messages - a.messages || (b.lastMs ?? 0) - (a.lastMs ?? 0);
  const groups = [...im.groups, ...wa.groups].sort(byActivity).slice(0, limit).map((g) => ({
    source: g.source,
    name: g.name ?? g.members ?? null,
    members: g.name ? g.members : null,
    messages: g.messages,
    last: day(g.lastMs),
    exclude: [['--exclude-chat', g.id]],
  }));
  const people = mergePeople([...im.people, ...wa.people]).sort(byActivity).slice(0, limit).map((p) => ({
    name: p.name,
    handle: p.handle,
    sources: p.sources,
    messages: p.messages,
    last: day(p.lastMs),
    exclude: personFlags(p),
  }));
  return { sources: { imessage: im.status, whatsapp: wa.status }, groups, people };
}

function human(v) {
  const lines = [];
  for (const [id, s] of Object.entries(v.sources)) if (!s.ok) lines.push(`${id}: ${s.message ?? s.reason ?? 'not readable'}`);
  lines.push('', 'Group chats (most active first):');
  v.groups.forEach((g, i) => lines.push(`${String(i + 1).padStart(2)}. ${g.name ?? '(unnamed group)'}${g.members ? ` [${g.members}]` : ''}  ${g.source}, ${g.messages} messages, last ${g.last ?? '?'}`));
  lines.push('', 'People (most messaged first):');
  v.people.forEach((p, i) => lines.push(`${String(i + 1).padStart(2)}. ${p.name ?? p.handle ?? '(unknown)'}  ${p.sources.join('+')}, ${p.messages} messages, last ${p.last ?? '?'}`));
  return `${lines.join('\n')}\n`;
}

export async function run(args, ctx) {
  const limit = args.limit ? Math.max(1, Number(args.limit)) : 30;
  ctx.log.out(listChats(ctx, { limit }), human);
  return 0;
}
