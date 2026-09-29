// Shared HTTP for every API extractor (C): JSON in and out, retries with
// exponential backoff on 429 and 5xx (honoring Retry-After), a simple
// per-host rate limiter, request timeouts, and a clear "needs a key" error
// on 401/403. `ctx.fetch` overrides `globalThis.fetch` and `ctx.sleep`
// overrides the real delay, so tests exercise every branch without touching
// the network or waiting on real timers.
const rateStates = new WeakMap(); // ctx -> Map<host, { hits: number[] }>

function limiterState(ctx, host) {
  let byHost = rateStates.get(ctx);
  if (!byHost) {
    byHost = new Map();
    rateStates.set(ctx, byHost);
  }
  let state = byHost.get(host);
  if (!state) {
    state = { hits: [] };
    byHost.set(host, state);
  }
  return state;
}

// A sliding-window limiter: at most `perMinute` calls to `host` in any
// trailing 60s. Blocks (via `sleep`) instead of dropping requests.
async function waitForRateLimit(ctx, host, perMinute, { sleep, clock }) {
  if (!perMinute) return;
  const state = limiterState(ctx, host);
  const windowMs = 60000;
  for (;;) {
    const now = clock();
    while (state.hits.length && now - state.hits[0] >= windowMs) state.hits.shift();
    if (state.hits.length < perMinute) {
      state.hits.push(now);
      return;
    }
    await sleep(state.hits[0] + windowMs - now + 1);
  }
}

// Retry-After is either a number of seconds or an HTTP-date.
function retryAfterMs(value, clock) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - clock()) : null;
}

function backoffMs(attempt, base = 500, max = 20000) {
  return Math.min(max, base * 2 ** attempt) + Math.floor(Math.random() * 250);
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export class HttpError extends Error {
  constructor(message, { status = null, needsKey = false, body = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.needsKey = needsKey;
    this.body = body;
  }
}

// Sends one request, retrying on 429/5xx and turning 401/403 into a
// HttpError with `needsKey: true`. Returns the raw (unread) response on
// success so callers can call `.text()` or `.json()` themselves; see
// `requestJson()` for the common case.
//
// options.rateLimit = { perMinute } applies a per-host limit before sending.
// options.json, when set, is JSON.stringified as the body with a
// Content-Type header; options.body is used as-is otherwise (a string or
// raw bytes, for example Deepgram's audio upload).
export async function request(ctx, url, {
  method = 'GET',
  headers = {},
  body,
  json,
  timeoutMs = 30000,
  retries = 4,
  rateLimit,
  source,
  clock = Date.now,
} = {}) {
  const fetchFn = ctx?.fetch ?? globalThis.fetch;
  const sleep = ctx?.sleep ?? realSleep;
  const host = new URL(url).host;
  const label = source ?? host;
  const finalHeaders = { ...headers };
  let finalBody = body;
  if (json !== undefined) {
    finalBody = JSON.stringify(json);
    finalHeaders['Content-Type'] ??= 'application/json';
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (rateLimit?.perMinute) await waitForRateLimit(ctx, host, rateLimit.perMinute, { sleep, clock });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      // No redirects: a hop to another host would carry the API key headers
      // (and a POST body such as audio) somewhere we never meant to send them.
      res = await fetchFn(url, { method, headers: finalHeaders, body: finalBody, signal: controller.signal, redirect: 'error' });
    } catch (err) {
      clearTimeout(timer);
      // An invalid header value makes fetch echo the value (the key) in its
      // message, so that case gets a fixed sentence instead.
      const headerProblem = /header/i.test(err.message ?? '') && err.name !== 'AbortError';
      lastErr = new HttpError(`${label}: ${err.name === 'AbortError' ? 'timed out' : headerProblem ? 'invalid request headers, check the saved key' : err.message}`, { needsKey: headerProblem });
      if (attempt === retries || headerProblem) throw lastErr;
      await sleep(backoffMs(attempt));
      continue;
    }
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      throw new HttpError(`${label}: needs a valid API key (HTTP ${res.status})`, { status: res.status, needsKey: true, body: await safeText(res) });
    }
    if (res.status === 429 || res.status >= 500) {
      const text = await safeText(res);
      lastErr = new HttpError(`${label}: HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`, { status: res.status, body: text });
      if (attempt === retries) throw lastErr;
      const wait = Math.min(retryAfterMs(res.headers?.get?.('retry-after'), clock) ?? backoffMs(attempt), 60000);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const text = await safeText(res);
      throw new HttpError(`${label}: HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`, { status: res.status, body: text });
    }
    return res;
  }
  throw lastErr;
}

// request() + JSON body parsing. Empty body resolves to null.
export async function requestJson(ctx, url, opts = {}) {
  const res = await request(ctx, url, opts);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
