import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, safeFileName, cleanDashes, ensureSentence, classifyText, looksLikeRequest, isCalendarNoise, cleanEmailText, prettyHandle, jaccard, slugTag, trimText } from '../engine/lib/b-text.mjs';
import { composeBody, upsertSections, mergeFrontmatter, readSection, renderSection } from '../engine/lib/b-sections.mjs';
import { parseNote } from '../engine/lib/frontmatter.mjs';
import { subfolderFor, DEFAULT_PERSONA } from '../engine/lib/b-persona.mjs';

test('names compare without accents, case or punctuation', () => {
  assert.equal(normalizeName('Ana María Ruiz-Pérez'), 'ana maria ruiz perez');
  assert.equal(normalizeName('  JOSÉ  '), 'jose');
  assert.equal(prettyHandle('tel:+15550102000'), '+1 555 010 2000');
  assert.equal(prettyHandle('name:ben cole'), 'Ben Cole');
});

test('file names are safe for macOS and Obsidian', () => {
  assert.equal(safeFileName('Q3: plan / budget? "final" #1 [draft]'), 'Q3 plan - budget final 1 draft');
  assert.equal(safeFileName('Pilot review — next steps'), 'Pilot review, next steps');
  assert.equal(safeFileName('...hidden.'), 'hidden');
  assert.ok(safeFileName('word '.repeat(40)).length <= 90);
  assert.equal(safeFileName(''), 'Untitled');
});

test('dashes become commas and sentences end cleanly', () => {
  assert.equal(cleanDashes('Investor — warm intros'), 'Investor, warm intros');
  assert.equal(cleanDashes('follow up -- tomorrow'), 'follow up, tomorrow');
  assert.equal(cleanDashes('9 – 5 schedule'), '9, 5 schedule');
  assert.equal(ensureSentence('asked for the deck'), 'Asked for the deck.');
  assert.equal(ensureSentence('Done?'), 'Done?');
  assert.equal(slugTag('Owed to me'), 'owed-to-me');
  assert.equal(trimText('one two three four', 9), 'one two…');
});

test('substance filter drops noise and keeps answers to requests', () => {
  assert.equal(classifyText('thanks!'), 'noise');
  assert.equal(classifyText('jajaja'), 'noise');
  assert.equal(classifyText('👍'), 'noise');
  assert.equal(classifyText('Liked “see you at 5”'), 'noise');
  assert.equal(classifyText('Le gustó “nos vemos”'), 'noise');
  assert.equal(classifyText('Your verification code is 482913'), 'noise');
  assert.equal(classifyText('ok'), 'ack');
  assert.equal(classifyText('Dale'), 'ack');
  assert.equal(classifyText('Can you send the deck?'), 'content');
  assert.equal(classifyText('hi', { reaction: true }), 'noise');
  assert.ok(looksLikeRequest('Can you send the deck by Friday'));
  assert.ok(looksLikeRequest('¿Me mandas la propuesta?'));
  assert.ok(!looksLikeRequest('Deck sent.'));
});

test('calendar noise and quoted email text are left out', () => {
  assert.ok(isCalendarNoise('Busy'));
  assert.ok(isCalendarNoise('Focus time'));
  assert.ok(isCalendarNoise('Canceled: Weekly sync'));
  assert.ok(isCalendarNoise('Invitation: Pilot review'));
  assert.ok(!isCalendarNoise('Pilot review with Acme'));
  const body = 'Sounds good, see notes below.\n\nOn Mon, Sep 1, 2026 at 9:00 Ana wrote:\n> old stuff\n> more';
  assert.equal(cleanEmailText(body), 'Sounds good, see notes below.');
  assert.equal(cleanEmailText('Hola\n\nEnviado desde mi iPhone'), 'Hola');
  assert.equal(cleanEmailText('Line one\n> quoted\nLine two'), 'Line one\nLine two');
});

test('word overlap for near duplicates', () => {
  assert.ok(jaccard('Send Ana the revised proposal', 'Sent Ana the revised proposal today') >= 0.5);
  assert.ok(jaccard('Send the deck', 'Book the flights') < 0.2);
});

test('managed sections are replaced in place and everything else is kept', () => {
  const body = composeBody('Ana', [
    { name: 'summary', heading: null, content: '**Company:** Acme' },
    { name: 'open', heading: 'Open loops', content: '' },
    { name: 'timeline', heading: 'Timeline', content: '- 2026-09-01, Met. _(Email)_' },
  ]);
  assert.ok(!body.includes('Open loops'), 'empty sections are not created');
  const mine = body.replace('# Ana\n', '# Ana\n\nMy own note about Ana.\n') + '\n## Mine\nKeep this.\n';
  const next = upsertSections(mine, [
    { name: 'summary', heading: null, content: '**Company:** Acme Inc' },
    { name: 'open', heading: 'Open loops', content: '- [[Send the deck]]' },
    { name: 'timeline', heading: 'Timeline', content: '- 2026-09-02, Called. _(Call)_\n- 2026-09-01, Met. _(Email)_' },
  ]);
  assert.ok(next.includes('My own note about Ana.'));
  assert.ok(next.includes('## Mine\nKeep this.'));
  assert.equal(readSection(next, 'summary'), '**Company:** Acme Inc');
  assert.ok(next.indexOf('## Open loops') < next.indexOf('## Timeline'), 'new section goes back in its usual place');
  const emptied = upsertSections(next, [{ name: 'open', heading: 'Open loops', content: '', empty: 'Nothing open right now.' }]);
  assert.equal(readSection(emptied, 'open'), 'Nothing open right now.');
  assert.equal(upsertSections(next, [{ name: 'timeline', heading: 'Timeline', content: readSection(next, 'timeline') }]), next, 'same content, same bytes');
  assert.equal(renderSection('x', ''), '<!-- confidant:start x -->\n<!-- confidant:end x -->');
});

test('frontmatter merge rewrites our keys and keeps the person’s', () => {
  const fm = 'type: person\nname: Ana\nstatus: open\nmood: happy\nmy_list:\n  - a\n  - b';
  const out = mergeFrontmatter(fm, { type: 'person', name: 'Ana Ruiz', company: '[[Acme]]' }, ['type', 'name', 'company', 'status']);
  const { data } = parseNote(`${out}body`);
  assert.equal(data.name, 'Ana Ruiz');
  assert.equal(data.company, '[[Acme]]');
  assert.equal(data.mood, 'happy');
  assert.deepEqual(data.my_list, ['a', 'b']);
  assert.equal(data.status, undefined, 'owned key without a value is removed');
  assert.ok(out.indexOf('company:') < out.indexOf('mood:'), 'new owned keys stay with ours');
});

test('persona subfolders by kind or rule', () => {
  const persona = { ...DEFAULT_PERSONA, subfolders: [{ folder: 'people', name: { en: 'Investors', es: 'Inversionistas' }, rule: 'kind in [investor]' }, { folder: 'opportunities', name: { en: 'Intros', es: 'Intros' }, rule: 'type == "introduction"' }] };
  assert.equal(subfolderFor(persona, 'people', { kind: 'investor' }, 'es'), 'Inversionistas');
  assert.equal(subfolderFor(persona, 'people', { kind: 'client' }, 'en'), null);
  assert.equal(subfolderFor(persona, 'opportunities', { opportunity_type: 'introduction' }, 'en'), 'Intros');
});
