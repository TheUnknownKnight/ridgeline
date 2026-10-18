/**
 * POST /api/analyze. The first check of a route in this session uploads its
 * coordinates; later checks send only the route hash, so On trail refreshes
 * stay small on a weak signal. If the server has forgotten the route
 * (restart, eviction) it answers 409 and we upload once more.
 */

const ENDPOINT = '/api/analyze';
const TIMEOUT_MS = 60_000;
const LOOKAHEAD_MIN = 5;
const LOOKAHEAD_MAX = 50;

const MESSAGES = {
  offline: "Can't reach Ridgeline — check your connection.",
  timeout: 'The check took too long. Try again in a minute.',
  server: 'The analysis service had a problem. Try again in a minute.',
  rejected: "Ridgeline couldn't check this route.",
  rateLimited: 'Too many checks in a short time. Wait a minute, then try again.',
  unexpected: 'Ridgeline sent back an answer it could not read. Try again in a minute.',
};

/** Route ids the server has accepted coordinates for during this session. */
const uploaded = new Set();

export class AnalysisError extends Error {
  constructor(message, { status = 0, code = 'unknown', retryAfterSec = null } = {}) {
    super(message);
    this.name = 'AnalysisError';
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

/** One signal that fires on the caller's abort or after the timeout, whichever comes first. */
const linkSignal = (callerSignal) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), TIMEOUT_MS);
  const onAbort = () => controller.abort(callerSignal.reason);
  if (callerSignal?.aborted) onAbort();
  else callerSignal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
    },
  };
};

/** Network-level failures: the caller's abort passes through untouched so it can be ignored. */
const transportError = (err, callerSignal, signal) => {
  if (callerSignal?.aborted) return err;
  if (signal.aborted) return new AnalysisError(MESSAGES.timeout, { code: 'timeout' });
  return new AnalysisError(MESSAGES.offline, { code: 'offline' });
};

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const httpError = (res, body) => {
  const serverMessage = typeof body?.error === 'string' ? body.error : null;
  const code = typeof body?.code === 'string' ? body.code : `http_${res.status}`;
  const opts = { status: res.status, code };
  if (res.status === 409 && code === 'route_unknown') return new AnalysisError(MESSAGES.rejected, opts);
  if (res.status === 429) {
    const retryAfterSec = Number(res.headers.get('Retry-After')) || null;
    return new AnalysisError(serverMessage || MESSAGES.rateLimited, { ...opts, retryAfterSec });
  }
  if (res.status === 400 || res.status === 413) return new AnalysisError(serverMessage || MESSAGES.rejected, opts);
  if (res.status >= 500) return new AnalysisError(MESSAGES.server, opts);
  return new AnalysisError(serverMessage || MESSAGES.rejected, opts);
};

const isAnalysis = (body) => body && body.version === 2 && Array.isArray(body.segments) &&
  body.summary && body.hazards && body.sources;

const post = async (payload, signal, callerSignal) => {
  let res;
  let text;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal,
    });
    text = await res.text();
  } catch (err) {
    throw transportError(err, callerSignal, signal);
  }
  const body = parseJson(text);
  if (!res.ok) throw httpError(res, body);
  if (!isAnalysis(body)) throw new AnalysisError(MESSAGES.unexpected, { status: res.status, code: 'bad_response' });
  return body;
};

const clampLookahead = (miles) => Math.round(Math.min(LOOKAHEAD_MAX, Math.max(LOOKAHEAD_MIN, Number(miles) || 15)));

/**
 * Analyze a route. `location` is { lat, lng, accuracyMeters?, lastMile? } in
 * On trail mode, otherwise null. Rejects with AnalysisError (plain-language
 * message) or, when the caller aborts, with the caller's AbortError.
 */
export const analyzeRoute = async ({ route, location = null, lookaheadMiles = 15, signal } = {}) => {
  const link = linkSignal(signal);
  const shared = { location: location || null, lookaheadMiles: clampLookahead(lookaheadMiles) };
  try {
    if (uploaded.has(route.id)) {
      try {
        return await post({ routeHash: route.id, ...shared }, link.signal, signal);
      } catch (err) {
        if (err.code !== 'route_unknown') throw err;
        uploaded.delete(route.id);
      }
    }
    const result = await post({ coordinates: route.coords, name: route.name, ...shared }, link.signal, signal);
    // Only reuse the hash when the server fingerprinted the route the same way we did.
    if (result.routeHash === route.id) uploaded.add(route.id);
    return result;
  } finally {
    link.release();
  }
};
