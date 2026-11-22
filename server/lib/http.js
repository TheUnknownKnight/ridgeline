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
const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

let customTransport = null;

/**
 * Install an optional custom HTTP transport (e.g. Capacitor native `CapacitorHttp`)
 * to replace `fetch`. Pass null to restore standard `fetch`.
 *
 * Signature:
 *   fn(url, { method, headers, body, timeoutMs, as })
 *     -> Promise<Response | { status: number, headers?: Headers | Record<string, string>, data?: unknown, body?: unknown }>
 */
export const setHttpTransport = (fn) => {
  customTransport = typeof fn === 'function' ? fn : null;
};

const hostOf = (url) => {
  try { return new URL(url).host; } catch { return url; }
};

const getHeader = (headers, name) => {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      if (Array.isArray(v)) return v.join(', ');
      return v == null ? null : String(v);
    }
  }
  return null;
};

const retryAfterMs = (headers) => {
  const h = getHeader(headers, 'retry-after');
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

const concatBytes = (chunks, totalSize) => {
  const out = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

const base64ToBytes = (b64) => {
  const clean = String(b64 || '').replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const toBytes = (value) => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
};

/** Read a body, refusing anything larger than maxBytes (a runaway upstream must not eat memory). */
const readBody = async (res, maxBytes, label) => {
  const declared = Number(getHeader(res.headers, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${label} response too large (${declared} bytes)`);
  if (!res.body || typeof res.body.getReader !== 'function') {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`${label} response over ${maxBytes} bytes`);
    return bytes;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    size += bytes.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`${label} response over ${maxBytes} bytes`);
    }
    chunks.push(bytes);
  }
  return concatBytes(chunks, size);
};

const DEFAULT_MAX_BYTES = 30 * 1024 * 1024;

const snippetOf = (raw) => {
  if (typeof raw === 'string') return raw.slice(0, 160);
  const bytes = toBytes(raw);
  if (bytes) return decoder.decode(bytes.subarray(0, Math.min(bytes.byteLength, 1024))).slice(0, 160);
  if (raw != null && typeof raw === 'object') {
    try { return JSON.stringify(raw).slice(0, 160); } catch { return ''; }
  }
  return '';
};

const decodeTransportBody = (res, { as, maxBytes, label }) => {
  const declared = Number(getHeader(res.headers, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${label} response too large (${declared} bytes)`);
  const payload = res.data !== undefined ? res.data : res.body;

  if (as === 'buffer') {
    const bytes = toBytes(payload) ?? (typeof payload === 'string' ? base64ToBytes(payload) : new Uint8Array(0));
    if (bytes.byteLength > maxBytes) throw new Error(`${label} response over ${maxBytes} bytes`);
    return bytes;
  }

  const bytes = toBytes(payload);
  if (bytes) {
    if (bytes.byteLength > maxBytes) throw new Error(`${label} response over ${maxBytes} bytes`);
    const text = decoder.decode(bytes);
    return as === 'json' ? JSON.parse(text) : text;
  }

  if (typeof payload === 'string') {
    if (payload.length > maxBytes || (payload.length * 3 > maxBytes && encoder.encode(payload).byteLength > maxBytes)) {
      throw new Error(`${label} response over ${maxBytes} bytes`);
    }
    return as === 'json' ? JSON.parse(payload) : payload;
  }

  if (as === 'json') return payload;
  return payload == null ? '' : typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
};

const isFetchResponse = (res) => Boolean(
  res && typeof res.ok === 'boolean' && (typeof res.arrayBuffer === 'function' || typeof res.body?.getReader === 'function'),
);

const attemptFetch = async (url, { timeoutMs, headers, label, method = 'GET', body, as = 'json', maxBytes = DEFAULT_MAX_BYTES }) => {
  const controller = new AbortController();
  let timeoutReject = null;
  const timer = setTimeout(() => {
    controller.abort();
    if (timeoutReject) {
      const err = new Error(`${label} timed out after ${timeoutMs}ms`);
      err.name = 'AbortError';
      timeoutReject(err);
    }
  }, timeoutMs);
  const started = Date.now();
  const mergedHeaders = { 'User-Agent': config.userAgent, Accept: as === 'json' ? 'application/json' : '*/*', ...headers };
  try {
    const transport = customTransport;
    let res;
    if (transport) {
      const timeoutPromise = new Promise((_, reject) => { timeoutReject = reject; });
      res = await Promise.race([
        Promise.resolve().then(() => transport(url, { method, headers: mergedHeaders, body, timeoutMs, as })),
        timeoutPromise,
      ]);
    } else {
      res = await fetch(url, {
        method,
        body,
        headers: mergedHeaders,
        signal: controller.signal,
      });
    }

    if (isFetchResponse(res)) {
      if (!res.ok) {
        if (res.status === 429) openCircuits.set(hostOf(url), Date.now() + retryAfterMs(res.headers));
        // Only the start of an error page is useful; never buffer a huge one.
        let text = '';
        try {
          const reader = res.body?.getReader();
          if (reader) {
            const { value } = await reader.read();
            if (value) {
              const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
              text = decoder.decode(bytes.subarray(0, Math.min(bytes.byteLength, 1024)));
            }
            await reader.cancel().catch(() => {});
          } else if (typeof res.text === 'function') {
            text = (await res.text()).slice(0, 1024);
          }
        } catch { /* the status is what matters */ }
        throw new HttpError(`${label} HTTP ${res.status}: ${text.slice(0, 160)}`, res.status, url);
      }
      const payload = await readBody(res, maxBytes, label);
      const data = as === 'buffer' ? payload : as === 'json' ? JSON.parse(decoder.decode(payload)) : decoder.decode(payload);
      if (config.logUpstream) console.log(`[http] ${label} ${Date.now() - started}ms ${url.slice(0, 140)}`);
      return data;
    }

    const status = typeof res?.status === 'number' ? res.status : 0;
    if (status < 200 || status >= 300) {
      if (status === 429) openCircuits.set(hostOf(url), Date.now() + retryAfterMs(res?.headers));
      const text = snippetOf(res?.data !== undefined ? res.data : res?.body);
      throw new HttpError(`${label} HTTP ${status}: ${text}`, status, url);
    }
    const data = decodeTransportBody(res, { as, maxBytes, label });
    if (config.logUpstream) console.log(`[http] ${label} ${Date.now() - started}ms ${url.slice(0, 140)}`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${label} timed out after ${timeoutMs}ms`);
    if (err?.cause && !(err instanceof HttpError)) {
      const detail = err.cause.code || err.cause.message || String(err.cause);
      const wrapped = new Error(`${err.message} (${detail})`, { cause: err.cause });
      wrapped.code = err.cause.code;
      throw wrapped;
    }
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
