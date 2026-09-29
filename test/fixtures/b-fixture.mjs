// Test vaults for Unit B: a temp folder with config/state, a real brain.db,
// and synthetic records. Never touches real data.
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createContext } from '../../engine/lib/context.mjs';
import { statePaths } from '../../engine/lib/paths.mjs';
import { writeJson } from '../../engine/lib/files.mjs';

export const NOW = new Date('2026-09-28T16:00:00.000Z');
export const TZ = 'America/New_York';

export const TEST_PERSONA = {
  id: 'founder',
  label: { en: 'Founder', es: 'Fundador' },
  focus: { en: 'Clients, investors and the promises that move deals.', es: 'Clientes, inversionistas y las promesas que mueven los negocios.' },
  subfolders: [{ folder: 'people', name: { en: 'Investors', es: 'Inversionistas' }, rule: 'kind in [investor]', kinds: ['investor'] }],
  personKinds: ['client', 'investor', 'teammate', 'vendor', 'friend'],
  companyKinds: ['client', 'investor', 'vendor', 'own'],
  opportunityFocus: ['pricing_ask', 'introduction', 'upsell'],
  bases: [{ file: 'Investors.base', title: { en: 'Investors', es: 'Inversionistas' }, folder: 'people', filter: 'kind == "investor"' }],
};

export const OWNER = { name: 'Sam Rivera', emails: ['sam@rivera.co'], phones: ['+1 305 555 0100'], company: 'Rivera Labs' };

export function silentLog() {
  const lines = { out: [], warn: [], info: [] };
  return {
    lines,
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.warn.push(m),
    out: (value) => lines.out.push(value),
  };
}

export function makeVault({ language = 'en', owner = OWNER, now = NOW, tz = TZ, role = 'founder', exclusions, persona = TEST_PERSONA, state } = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'cf-b-'));
  const paths = statePaths(vault);
  writeJson(paths.config, { version: 1, vault, language, role, briefTime: '08:00', timezone: tz, sources: {}, owner, ...(exclusions ? { exclusions } : {}) });
  writeJson(paths.state, state ?? { phase: 'sort', history: [] });
  const ctx = createContext({ vault, now, quiet: true });
  ctx.log = silentLog();
  if (persona) ctx.persona = persona;
  return ctx;
}

// ---------- record builders ----------

const iso = (d) => new Date(d).toISOString();

export function msg(id, { source = 'imessage', thread, ts, from = null, fromName = null, to = [], me = false, text = '', title = null, meta } = {}) {
  return {
    id: `${source}:${id}`,
    source,
    kind: 'message',
    thread: thread ?? null,
    ts: iso(ts),
    from: me ? (from ? { handle: from, name: fromName } : null) : { handle: from, name: fromName },
    to: to.map((x) => (typeof x === 'string' ? { handle: x, name: null } : x)),
    is_from_me: me,
    title,
    text,
    url: null,
    meta: meta ?? {},
  };
}

export function email(id, { thread, ts, from, fromName = null, to = [], me = false, subject = '', text = '', meta } = {}) {
  return {
    id: `email:${id}`,
    source: 'email',
    kind: 'email',
    thread: thread ?? `email:${id}`,
    ts: iso(ts),
    from: { handle: from, name: fromName },
    to: to.map((x) => (typeof x === 'string' ? { handle: x, name: null } : x)),
    is_from_me: me,
    title: subject,
    text,
    url: null,
    meta: meta ?? {},
  };
}

export function meeting(id, { source = 'fathom', ts, title, attendees = [], transcript = '', summary, action_items, duration_s = 1800 } = {}) {
  return {
    id: `${source}:${id}`,
    source,
    kind: 'meeting',
    thread: `meeting:${source}:${id}`,
    ts: iso(ts),
    from: null,
    to: attendees.map((x) => (typeof x === 'string' ? { handle: x, name: null } : x)),
    is_from_me: false,
    title,
    text: transcript,
    url: null,
    meta: { duration_s, ...(summary ? { summary } : {}), ...(action_items ? { action_items } : {}) },
  };
}

export function contact(id, { names = [], phones = [], emails = [], company = null, title = null, me = false } = {}) {
  return {
    id: `contacts:${id}`,
    source: 'contacts',
    kind: 'contact',
    thread: null,
    ts: iso('2026-01-01T00:00:00Z'),
    from: null,
    to: [],
    is_from_me: false,
    title: names[0] ?? null,
    text: '',
    url: null,
    meta: { names, phones, emails, company, title, ...(me ? { is_me: true } : {}) },
  };
}

export function event(id, { ts, title, attendees = [], text = '' } = {}) {
  return {
    id: `calendar:${id}`,
    source: 'calendar',
    kind: 'event',
    thread: `calendar:${id}`,
    ts: iso(ts),
    from: null,
    to: attendees.map((x) => (typeof x === 'string' ? { handle: x, name: null } : x)),
    is_from_me: false,
    title,
    text,
    url: null,
    meta: {},
  };
}

// Every file under the vault except .confidant, as { relPath: content }.
export function snapshot(vault) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.confidant') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(vault, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(vault);
  return out;
}
