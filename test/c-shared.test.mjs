// Shared test helpers for Unit C's suites (fakeCtx, mockFetch). Declares no
// tests of its own; the other test/c-*.test.mjs files import it.
import { openMemoryStore } from '../engine/lib/store.mjs';

export function fakeLog() {
  const out = [];
  const errors = [];
  return { out: (v) => out.push(v), info: () => {}, warn: () => {}, error: (m) => errors.push(m), out_: out, errors };
}

export function fakeCtx({ config = {}, dryRun = false, fetchImpl, store, lang = 'en', tz = 'UTC' } = {}) {
  return {
    store: store ?? openMemoryStore(),
    config,
    dryRun,
    lang: config.language ?? lang,
    tz: config.timezone ?? tz,
    log: fakeLog(),
    fetch: fetchImpl,
    sleep: async () => {}, // instant: retry/rate-limit tests never really wait
  };
}

// A minimal fetch-like mock. `responses` is either an array of specs
// consumed in call order (the last one repeats once exhausted) or a
// function(url, opts, callNumber) -> spec. A spec is
// { status = 200, json | text, headers } and becomes a Response-shaped
// object with .status, .ok, .headers.get(name), .text(), .json().
export function mockFetch(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const spec = typeof responses === 'function' ? responses(url, opts, calls.length) : responses[Math.min(calls.length - 1, responses.length - 1)];
    const status = spec.status ?? 200;
    const bodyText = spec.json !== undefined ? JSON.stringify(spec.json) : (spec.text ?? '');
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name) => spec.headers?.[String(name).toLowerCase()] ?? null },
      text: async () => bodyText,
      json: async () => JSON.parse(bodyText || 'null'),
    };
  };
  fn.calls = calls;
  return fn;
}
