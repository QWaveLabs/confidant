import test from 'node:test';
import assert from 'node:assert/strict';
import { getKey, setKey, promptForKey, KEY_NAMES } from '../engine/lib/c-keys.mjs';

function fakeExec(store) {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    const [cmd] = args;
    const svc = args[args.indexOf('-s') + 1];
    if (cmd === 'find-generic-password') return store.has(svc) ? store.get(svc) : null;
    if (cmd === 'add-generic-password') {
      const value = args[args.indexOf('-w') + 1];
      store.set(svc, value);
      return '';
    }
    throw new Error(`unexpected security call: ${cmd}`);
  };
  exec.calls = calls;
  return exec;
}

test('KEY_NAMES lists every service the recipes cover', () => {
  assert.deepEqual(KEY_NAMES, ['deepgram', 'fathom', 'fireflies', 'granola', 'readai', 'grain', 'tldv']);
});

test('getKey returns null for a missing item and the value once set', () => {
  const store = new Map();
  const exec = fakeExec(store);
  assert.equal(getKey('fathom', { exec }), null);
  setKey('fathom', 'sk_live_abc', { exec });
  assert.equal(getKey('fathom', { exec }), 'sk_live_abc');
});

test('setKey uses the confidant-<name> service and confidant account', () => {
  const store = new Map();
  const exec = fakeExec(store);
  setKey('grain', 'grn_pat_1', { exec });
  const addCall = exec.calls.find((c) => c[0] === 'add-generic-password');
  assert.equal(addCall[addCall.indexOf('-s') + 1], 'confidant-grain');
  assert.equal(addCall[addCall.indexOf('-a') + 1], 'confidant');
  assert.equal(addCall.includes('-U'), true);
});

test('promptForKey stores a trimmed, non-empty answer and returns true', async () => {
  const store = new Map();
  const exec = fakeExec(store);
  const ask = () => '  secret-value  ';
  const ok = await promptForKey('deepgram', 'Deepgram', { exec, ask });
  assert.equal(ok, true);
  assert.equal(getKey('deepgram', { exec }), 'secret-value');
});

test('promptForKey returns false and stores nothing on cancel', async () => {
  const store = new Map();
  const exec = fakeExec(store);
  const ask = () => null;
  const ok = await promptForKey('deepgram', 'Deepgram', { exec, ask });
  assert.equal(ok, false);
  assert.equal(store.size, 0);
});

test('promptForKey returns false for a blank answer', async () => {
  const store = new Map();
  const exec = fakeExec(store);
  const ask = () => '   ';
  const ok = await promptForKey('fireflies', 'Fireflies', { exec, ask });
  assert.equal(ok, false);
  assert.equal(store.size, 0);
});

test('promptForKey never passes the key value to ask() and asks in the requested language', async () => {
  const store = new Map();
  const exec = fakeExec(store);
  let seenPrompt = null;
  const ask = (prompt) => {
    seenPrompt = prompt;
    return 'value';
  };
  await promptForKey('tldv', 'tl;dv', { exec, ask, lang: 'es' });
  assert.ok(seenPrompt.includes('tl;dv'));
  assert.ok(!seenPrompt.includes('value'));
  assert.ok(/llavero/i.test(seenPrompt), 'Spanish prompt should be used for lang: es');
});
