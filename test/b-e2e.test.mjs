// End-to-end install, the way the install skill runs it: a fake Mac (temp
// HOME with Apple databases from Unit A's fixture builders and one Fathom
// page), then the real CLI modules in order: init, config source, extract,
// identity, dossiers, batch next, sort (a stand-in for Codex that writes
// contributions from the batch items), merge, mocs, tasks, welcome. Then a
// brain update three hours later, and the whole install again in Spanish.
import { FAKE_HOME } from './fixtures/b-e2e-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, COMMANDS } from '../engine/cli.mjs';
import { createContext } from '../engine/lib/context.mjs';
import { readJson, writeJson } from '../engine/lib/files.mjs';
import { check } from '../engine/lib/schema.mjs';
import { parseNote } from '../engine/lib/frontmatter.mjs';
import { resetCaches } from './fixtures/a-fixtures.mjs';
import { buildMac, laterMessages, fathomFetch, OWNER } from './fixtures/b-e2e-apple.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = ['imessage', 'whatsapp', 'email', 'calendar', 'contacts', 'calls', 'fathom'];

// Runs one command the way engine/cli.mjs does, with the test's fetch and key.
async function cli(vault, line) {
  const [name, ...rest] = line;
  const args = parseArgs(rest);
  const ctx = createContext({ vault: COMMANDS[name].needsVault ? vault : null, json: true, quiet: true });
  const outs = [];
  const problems = [];
  ctx.log = { info() {}, warn: (m) => problems.push(m), error: (m) => problems.push(m), out: (v) => outs.push(v) };
  Object.assign(ctx, { home: FAKE_HOME, fetch: fathomFetch(), getKey: (n) => (n === 'fathom' ? 'test-fathom-key' : null) });
  resetCaches();
  try {
    const mod = await import(join(ROOT, 'engine', COMMANDS[name].module));
    const code = await mod.run(args, ctx);
    return { code: code ?? 0, out: outs[outs.length - 1], problems };
  } finally {
    ctx.close();
    resetCaches();
  }
}

async function ok(vault, line) {
  const r = await cli(vault, line);
  assert.equal(r.code, 0, `${line.join(' ')}: ${r.problems.join(' | ')}`);
  return r.out;
}

// ---------- a stand-in for Codex following prompts/sort.md ----------

const first = (name) => String(name).split(' ')[0];
const clip = (s, n = 180) => (s.length > n ? `${s.slice(0, n - 1).trim()}.` : s);

function sortPerson(d, c) {
  const lines = d.items.filter((i) => !i.context);
  const said = lines.filter((i) => i.dir === 'in' && !i.type && i.ch !== 'Email').slice(-3);
  const bullets = said.map((i) => ({ date: i.date, text: clip(`Wrote: ${i.text}`), source_refs: [i.ref] }));
  for (const i of lines.filter((x) => x.type === 'call')) bullets.push({ date: i.date, text: 'Had a phone call', source_refs: [i.ref] });
  for (const i of lines.filter((x) => x.type === 'event')) bullets.push({ date: i.date, text: `Met for ${i.text}`, source_refs: [i.ref] });
  for (const i of lines.filter((x) => x.ch === 'Email' && x.dir === 'in')) bullets.push({ date: i.date, text: clip(`Emailed about ${i.subject}: ${i.text}`), source_refs: [i.ref] });
  if (bullets.length) c.people.push({ person_id: d.id, name: d.person.name, ...(d.person.company ? { company: d.person.company } : {}), bullets });
  for (const i of lines) {
    if (i.dir === 'in' && /revised proposal by/i.test(i.text)) {
      const reply = lines.find((x) => x.dir === 'out' && x.date === i.date);
      c.commitments.push({ text: `Send ${first(d.person.name)} the revised proposal`, direction: 'i_owe', counterpart: d.person.name, date: i.date, source_refs: [i.ref, ...(reply ? [reply.ref] : [])] });
    }
    if (i.dir === 'in' && /got the revised proposal/i.test(i.text)) {
      c.commitments.push({ text: `Send ${first(d.person.name)} the revised proposal`, direction: 'i_owe', counterpart: d.person.name, status: 'done', date: i.date, source_refs: [i.ref] });
    }
    if (i.dir === 'in' && /introduce you to/i.test(i.text)) {
      c.commitments.push({ text: 'Introduce Sam to Dan Park at Northwind Ventures', direction: 'owed_to_me', counterpart: d.person.name, date: i.date, source_refs: [i.ref] });
    }
  }
}

function sortThread(d, c) {
  const lines = d.items.filter((i) => !i.context);
  if (d.thread.kind === 'group' && lines.length) {
    c.knowledge.push({ title: `${d.thread.name} notes`, text: lines.map((i) => `${i.from}: ${i.text}`).join(' '), date: lines[lines.length - 1].date, source_refs: lines.map((i) => i.ref) });
  }
}

function sortMeeting(d, c) {
  const m = d.meeting;
  c.meetings.push({
    title: m.title,
    date: m.date,
    people: m.attendees.map((a) => a.name),
    summary: clip(m.summary ?? d.chunks[0].text, 400),
    action_items: (m.action_items ?? []).map((text) => ({ text })),
    source_refs: [m.ref],
  });
  for (const a of m.attendees.filter((x) => x.person_id)) c.people.push({ person_id: a.person_id, name: a.name, bullets: [{ date: m.date, text: `Joined the ${m.title}`, source_refs: [m.ref] }] });
}

function contributionFor(batch) {
  const c = { batch_id: batch.id, people: [], commitments: [], meetings: [], knowledge: [] };
  for (const d of batch.items) {
    if (d.type === 'person') sortPerson(d, c);
    else if (d.type === 'thread') sortThread(d, c);
    else if (d.type === 'meeting') sortMeeting(d, c);
  }
  for (const k of Object.keys(c)) if (Array.isArray(c[k]) && !c[k].length) delete c[k];
  assert.deepEqual(check('contribution', c), [], `${batch.id} contribution is valid`);
  return c;
}

async function sortAndMerge(vault, batches) {
  for (const b of batches) {
    const batch = readJson(b.path);
    assert.deepEqual(check('batch', batch), [], `${b.id} matches the batch schema`);
    assert.ok(existsSync(batch.instructions), 'the sort prompt path resolves');
    writeJson(batch.output, contributionFor(batch));
    await ok(vault, ['merge', '--batch', b.id]);
  }
}

// ---------- helpers ----------

function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const notesIn = (vault, folder) => {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.md')) out.push(relative(vault, p));
    }
  };
  walk(join(vault, folder));
  return out.sort();
};

// Every scheduled minute a task fires in one week: "day hour:minute".
function slots(rrule) {
  const part = (k) => new RegExp(`${k}=([^;]+)`).exec(rrule)?.[1];
  const freq = part('FREQ');
  const days = part('BYDAY')?.split(',') ?? ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  const interval = Number(part('INTERVAL') ?? 1);
  const hours = part('BYHOUR')?.split(',').map(Number) ?? (freq === 'HOURLY' ? Array.from({ length: 24 }, (_, h) => h).filter((h) => h % interval === 0) : [0]);
  const minutes = part('BYMINUTE')?.split(',').map(Number) ?? [0];
  return days.flatMap((d) => hours.flatMap((h) => minutes.map((m) => `${d} ${h}:${m}`)));
}

async function install(language) {
  const vaultOut = await ok(null, ['init', '--role', 'founder', '--language', language, '--brief-time', '07:30', '--timezone', 'America/New_York', '--owner-name', OWNER.name, '--owner-email', OWNER.email]);
  const vault = vaultOut.vault;
  for (const id of SOURCES) await ok(vault, ['config', 'source', '--id', id, '--status', 'connected']);
  // Exclusions are reviewed before anything is read; extract refuses until then.
  await ok(vault, ['chats']);
  await ok(vault, ['config', 'phase', 'exclusions']);
  const extracted = await ok(vault, ['extract']);
  for (const id of SOURCES) {
    const r = extracted.results.find((x) => x.id === id);
    assert.ok(r?.ok && r.inserted > 0, `${id} extracted: ${JSON.stringify(r)}`);
  }
  const identity = await ok(vault, ['identity']);
  const dossiers = await ok(vault, ['dossiers']);
  // The install skill loop: batch next until done, sorting and merging each round.
  for (let round = 0; round < 10; round++) {
    const next = await ok(vault, ['batch', 'next', '--scope', 'install', '--count', '4']);
    if (!next.batches.length) {
      assert.equal(next.done, true);
      break;
    }
    await sortAndMerge(vault, next.batches);
  }
  await ok(vault, ['mocs']);
  const spec = await ok(vault, ['tasks', 'spec']);
  for (const s of spec) await ok(vault, ['tasks', 'record', '--key', s.key, '--id', `automation-${s.key}`]);
  const welcome = await ok(vault, ['welcome']);
  return { vault, identity, dossiers, spec, welcome };
}

// ---------- the test ----------

test('end to end: install, three hours later, and Spanish', async () => {
  // Someone already has an unrelated second brain at the default path.
  const old = join(FAKE_HOME, 'Second Brain');
  mkdirSync(join(old, 'Projects'), { recursive: true });
  writeFileSync(join(old, 'Home.md'), '# My old notes\n\nDo not touch.\n');
  writeFileSync(join(old, 'Projects', 'Garden.md'), '- plant tomatoes\n');
  const oldTree = tree(old);
  const mac = buildMac(FAKE_HOME);

  // ---- install in English ----
  const { vault, identity, dossiers, spec, welcome } = await install('en');
  assert.equal(vault, join(FAKE_HOME, 'Second Brain 2'), 'a new vault next to the old one');
  assert.equal(identity.stats.people, 3, 'Ana, Ben and Carla; the code sender and an unknown missed call left out');
  // Ana, Ben (email) and Carla; the group chat; the Fathom meeting.
  assert.deepEqual([dossiers.people, dossiers.threads, dossiers.meetings], [3, 1, 1]);

  const people = notesIn(vault, 'People');
  for (const n of ['People/Ana Ruiz.md', 'People/Ben Cole.md', 'People/Carla Diaz.md']) assert.ok(people.includes(n), `${n} in ${people}`);
  const ana = readFileSync(join(vault, 'People/Ana Ruiz.md'), 'utf8');
  assert.equal(parseNote(ana).data.company, '[[Acme]]', 'Acme came up for two people, so it has a note');
  assert.ok(existsSync(join(vault, 'Companies/Acme.md')));
  assert.ok(ana.includes('_(iMessage)_') && ana.includes('_(WhatsApp)_'), 'one person across channels');
  assert.ok(ana.includes('Had a phone call. _(Call)_'));
  assert.ok(ana.includes('Met for [[Acme]] roadmap review. _(Calendar)_'));
  assert.ok(!ana.includes('Focus time'), 'calendar noise is left out');
  const ben = readFileSync(join(vault, 'People/Ben Cole.md'), 'utf8');
  assert.ok(ben.includes('Emailed about Contract draft: Contract draft attached. Can we sign by October 15?. _(Email)_') || ben.includes('Emailed about Contract draft: Contract draft attached. Can we sign by October 15? _(Email)_'), 'mail, with the reply quote and signature removed');
  assert.ok(!people.some((n) => /news|weekly/i.test(n)), 'newsletters never become people');
  assert.ok(!ana.includes('Loved'), 'reactions never reach a note');
  assert.deepEqual(notesIn(vault, 'Meetings').filter((n) => !n.endsWith('/Meetings.md')).length, 1);
  const commitment = join(vault, 'Commitments/Send Ana the revised proposal.md');
  assert.equal(parseNote(readFileSync(commitment, 'utf8')).data.status, 'open');
  const home = readFileSync(join(vault, 'Home.md'), 'utf8');
  assert.ok(home.startsWith('---\ntype: home'), 'the init placeholder was replaced');
  assert.ok(!home.includes('is being built'));
  assert.ok(home.includes('- [[People]]: 3 notes'));
  for (const b of ['Commitments.base', 'Opportunities.base', 'Projects.base', 'People.base']) assert.ok(existsSync(join(vault, b)), b);

  // ---- scheduled tasks ----
  assert.equal(spec.length, 9);
  assert.deepEqual(check('task', spec), []);
  const seen = new Map();
  for (const s of spec) {
    for (const slot of slots(s.rrule)) {
      assert.ok(!seen.has(slot), `${s.key} and ${seen.get(slot)} both fire at ${slot}`);
      seen.set(slot, s.key);
    }
  }

  // ---- welcome guide ----
  assert.ok(existsSync(welcome.path));
  const guide = readFileSync(welcome.path, 'utf8');
  const noteCount = ['People', 'Companies', 'Projects', 'Decisions', 'Commitments', 'Ideas', 'Meetings', 'Opportunities', 'Knowledge'].reduce((n, f) => n + notesIn(vault, f).length, 0);
  assert.ok(guide.includes(`<span class="stat-value">${SOURCES.length}</span>`), 'real number of connected sources');
  // The guide counts every .md in the nine folders, which today includes the
  // nine folder index notes; accept the count with or without them.
  assert.ok(new RegExp(`<span class="stat-value">(${noteCount}|${noteCount - 9})</span>`).test(guide), `real note count (${noteCount})`);
  assert.ok(/7:30/.test(guide), 'task times from the brief time');
  assert.ok(guide.includes('support@meetconfidant.com'));

  // ---- three hours later ----
  const before = { people: notesIn(vault, 'People'), commitments: notesIn(vault, 'Commitments') };
  laterMessages(mac);
  const update = await ok(vault, ['update']);
  assert.ok(update.extracted.some((e) => e.id === 'imessage' && e.inserted === 1));
  const updates = update.batches.filter((b) => b.kind === 'update');
  assert.ok(updates.length >= 1, 'the new messages are in an update batch');
  await sortAndMerge(vault, update.batches.map((b) => ({ ...b, output: readJson(b.path).output })));
  await ok(vault, ['update', '--finish']);
  const after = readFileSync(join(vault, 'People/Ana Ruiz.md'), 'utf8');
  assert.equal((after.match(/Got the revised proposal/g) ?? []).length, 1, 'the new fact landed once');
  assert.equal((after.match(/Can you send the revised proposal/g) ?? []).length, 1, 'old facts are not repeated');
  assert.equal(parseNote(readFileSync(commitment, 'utf8')).data.status, 'done', 'the commitment closed in place');
  assert.deepEqual(notesIn(vault, 'People'), before.people);
  assert.deepEqual(notesIn(vault, 'Commitments'), before.commitments, 'no duplicate notes');
  assert.ok(readFileSync(join(vault, 'People/Carla Diaz.md'), 'utf8').includes('Just sent the intro email'));
  const again = await ok(vault, ['update']);
  assert.deepEqual(again.batches.filter((b) => b.kind === 'update'), [], 'nothing new, nothing to sort');
  assert.ok(readJson(join(vault, '.confidant', 'state.json')).lastUpdate.at);

  // ---- the old second brain was never touched ----
  assert.deepEqual(tree(old), oldTree);

  // ---- the same install in Spanish ----
  const es = await install('es');
  assert.equal(es.vault, join(FAKE_HOME, 'Segundo cerebro'));
  for (const f of ['Personas', 'Empresas', 'Proyectos', 'Decisiones', 'Compromisos', 'Ideas', 'Reuniones', 'Oportunidades', 'Conocimiento', 'Resúmenes']) assert.ok(existsSync(join(es.vault, f)), f);
  const anaEs = readFileSync(join(es.vault, 'Personas/Ana Ruiz.md'), 'utf8');
  assert.ok(anaEs.includes('## Cronología') && anaEs.includes('**Empresa:** [[Acme]]'));
  assert.ok(anaEs.includes('_(Llamada)_'));
  assert.ok(existsSync(join(es.vault, 'Compromisos/Send Ana the revised proposal.md')));
  const homeEs = readFileSync(join(es.vault, 'Home.md'), 'utf8');
  assert.ok(homeEs.includes('# Inicio') && homeEs.includes('## Tu segundo cerebro'));
  assert.ok(existsSync(join(es.vault, 'Compromisos.base')));
  assert.ok(es.welcome.path.endsWith('Guía de Confidant.html'));
  assert.deepEqual(tree(old), oldTree);
});
