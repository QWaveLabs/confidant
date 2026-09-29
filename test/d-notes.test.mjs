import test from 'node:test';
import assert from 'node:assert/strict';
import { timelineBullets, mentionsPerson } from '../engine/lib/d-notes.mjs';

test('timelineBullets reads the English heading for an English vault', () => {
  const body = '# Mike Brennan\n\n## Timeline\n- 2026-09-20, Asked about the CRM filtering update. _(Zoom)_\n- 2026-09-10, Confirmed renewal terms. _(Calls)_\n';
  assert.deepEqual(timelineBullets(body, 'en'), [
    { date: '2026-09-20', text: 'Asked about the CRM filtering update. _(Zoom)_' },
    { date: '2026-09-10', text: 'Confirmed renewal terms. _(Calls)_' },
  ]);
});

test('timelineBullets reads "Cronología", the Spanish heading merge.mjs writes for a Spanish vault', () => {
  const body = '# Mike Brennan\n\n## Cronología\n- 2026-09-20, Preguntó por la actualización del CRM. _(Zoom)_\n';
  assert.deepEqual(timelineBullets(body, 'es'), [
    { date: '2026-09-20', text: 'Preguntó por la actualización del CRM. _(Zoom)_' },
  ]);
});

test('timelineBullets tolerates an English-headed note read as Spanish, and vice versa', () => {
  const enBody = '# Mike Brennan\n\n## Timeline\n- 2026-09-20, x. _(Zoom)_\n';
  assert.equal(timelineBullets(enBody, 'es').length, 1, 'an English heading must still be found in a Spanish vault');

  const esBody = '# Mike Brennan\n\n## Cronología\n- 2026-09-20, x. _(Zoom)_\n';
  assert.equal(timelineBullets(esBody, 'en').length, 1, 'a Spanish heading must still be found by default English matching');
});

test('timelineBullets defaults to English when no language is given, and stays empty with no Timeline section at all', () => {
  const body = '# Mike Brennan\n\n## Timeline\n- 2026-09-20, x. _(Zoom)_\n';
  assert.equal(timelineBullets(body).length, 1);
  assert.deepEqual(timelineBullets('# No timeline here\njust prose\n', 'en'), []);
});

test('timelineBullets respects the limit and stops at the next heading', () => {
  const body = '# Mike Brennan\n\n## Timeline\n- 2026-09-20, a\n- 2026-09-19, b\n- 2026-09-18, c\n\n## Other\n- 2026-09-01, not a timeline bullet\n';
  const bullets = timelineBullets(body, 'en', 2);
  assert.equal(bullets.length, 2);
  assert.deepEqual(bullets.map((b) => b.date), ['2026-09-20', '2026-09-19']);
});

test('mentionsPerson still handles a wikilink or a plain name, unaffected by this change', () => {
  assert.ok(mentionsPerson('[[Mike Brennan]]', 'Mike Brennan'));
  assert.ok(mentionsPerson(['Nadia Petrov', 'Mike Brennan'], 'mike brennan'));
  assert.ok(!mentionsPerson('[[Someone Else]]', 'Mike Brennan'));
});
