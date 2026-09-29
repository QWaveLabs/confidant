import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptText, party, parties } from '../engine/lib/c-meeting.mjs';

test('transcriptText formats Speaker: line rows and drops empty turns', () => {
  const text = transcriptText([
    { speaker: 'Ana', text: 'Hello there.' },
    { speaker: '  ', text: '' },
    { speaker: 'Mike', text: '  General Kenobi...  ' },
  ]);
  assert.equal(text, 'Ana: Hello there.\nMike: General Kenobi...');
});

test('transcriptText falls back to Unknown for a missing speaker name', () => {
  assert.equal(transcriptText([{ speaker: null, text: 'hi' }]), 'Unknown: hi');
});

test('transcriptText returns an empty string for no utterances', () => {
  assert.equal(transcriptText([]), '');
  assert.equal(transcriptText(undefined), '');
});

test('party prefers an email handle over a name handle', () => {
  assert.deepEqual(party({ name: 'Ana Ruiz', email: 'Ana@Acme.com' }), { handle: 'mailto:ana@acme.com', name: 'Ana Ruiz' });
});

test('party falls back to a name handle with no email', () => {
  assert.deepEqual(party({ name: 'Mike Brennan' }), { handle: 'name:mike brennan', name: 'Mike Brennan' });
});

test('party returns null for an empty participant', () => {
  assert.equal(party({}), null);
  assert.equal(party(null), null);
});

test('parties filters out unidentifiable participants', () => {
  assert.deepEqual(parties([{ name: 'Ana' }, {}, null, { email: 'x@y.com' }]), [
    { handle: 'name:ana', name: 'Ana' },
    { handle: 'mailto:x@y.com', name: null },
  ]);
});
