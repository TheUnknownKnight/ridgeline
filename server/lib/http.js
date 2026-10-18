import config from '../config.js';

export class HttpError extends Error {
  constructor(message, status, url) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

// When a host rate-limits us (429), stop calling it for a while instead of
// hammering it with retries from every request (which also burns our quota).
const DEFAULT_BACKOFF_MS = 60000;
const MAX_BACKOFF_MS = 15 * 60000;
const openCircuits = new Map(); // host -> reopenAt

const hostOf = (url) => {
  try { return new URL(url).host; } catch { return url; }
};

const retryAfterMs = (res) => {
  const h = res.headers.get('retry-after');
  if (!h) return DEFAULT_BACKOFF_MS;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(MAX_BACKOFF_MS, Math.max(1000, secs * 1000));
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.min(MAX_BACKOFF_MS, Math.max(1000, at - Date.now())) : DEFAULT_BACKOFF_MS;
};

export const circuitOpenFor = (url) => {
  const until = openCircuits.get(hostOf(url));
  return until && until > Date.now() ? until : null;
};

const isRetryable = (err) => !(err instanceof HttpError) || err.status >= 500;

/** Read a body, refusing anything larger than maxBytes (a runaway upstream must not eat memory). */
const readBody = async (res, maxBytes, label) => {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${label} response too large (${declared} bytes)`);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`${label} response over ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

const DEFAULT_MAX_BYTES = 30 * 1024 * 1024;

const attemptFetch = async (url, { timeoutMs, headers, label, method = 'GET', body, as = 'json', maxBytes = DEFAULT_MAX_BYTES }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      body,
      headers: { 'User-Agent': config.userAgent, Accept: as === 'json' ? 'application/json' : '*/*', ...headers },
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === 429) openCircuits.set(hostOf(url), Date.now() + retryAfterMs(res));
      // Only the start of an error page is useful; never buffer a huge one.
      let text = '';
      try {
        const reader = res.body?.getReader();
        if (reader) {
          const { value } = await reader.read();
          if (value) text = Buffer.from(value.buffer, value.byteOffset, Math.min(value.byteLength, 1024)).toString('utf8');
          await reader.cancel().catch(() => {});
        }
      } catch { /* the status is what matters */ }
      throw new HttpError(`${label} HTTP ${res.status}: ${text.slice(0, 160)}`, res.status, url);
    }
    const payload = await readBody(res, maxBytes, label);
    const data = as === 'buffer' ? payload : as === 'json' ? JSON.parse(payload.toString('utf8')) : payload.toString('utf8');
    if (config.logUpstream) console.log(`[http] ${label} ${Date.now() - started}ms ${url.slice(0, 140)}`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${label} timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

const withRetries = async (url, options) => {
  const { retries = 1, label = 'upstream' } = options;
  for (let attempt = 0; ; attempt++) {
    const blockedUntil = circuitOpenFor(url);
    if (blockedUntil) {
      throw new HttpError(`${label} rate-limited us; retrying after ${new Date(blockedUntil).toISOString()}`, 429, url);
    }
    try {
      return await attemptFetch(url, { timeoutMs: 12000, headers: {}, label, ...options });
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
};

/**
 * Fetch JSON with a timeout that covers headers AND body parsing (a slow body
 * stream must not outlive the deadline). Retries network errors, timeouts and
 * 5xx (federal APIs return transient 500s); never retries 429. Pass `method`
 * and `body` for a POST (ArcGIS getSamples takes form-encoded POSTs).
 */
export const fetchJson = (url, options = {}) => withRetries(url, { ...options, as: 'json' });

/** Same contract as fetchJson, for text bodies (KML). */
export const fetchText = (url, options = {}) => withRetries(url, { ...options, as: 'text' });

/** Same contract as fetchJson, for binary bodies (PNG map exports). */
export const fetchBuffer = (url, options = {}) => withRetries(url, { ...options, as: 'buffer' });
