/**
 * Fixed-window per-key limiter. Each analysis fans out to several federal
 * APIs; without limits, one client could get the server's IP throttled by
 * NWS, NIFC or Open-Meteo for everyone.
 */
export const createLimiter = ({ perMinute = 30, maxTracked = 10000 } = {}) => {
  const windows = new Map(); // key -> { start, count }
  const WINDOW_MS = 60000;

  /** Count one hit for `key`. Returns { ok, remaining, retryAfterSec }. */
  const take = (key) => {
    const now = Date.now();
    let w = windows.get(key);
    if (!w || now - w.start >= WINDOW_MS) {
      w = { start: now, count: 0 };
      windows.delete(key);
      windows.set(key, w);
      if (windows.size > maxTracked) windows.delete(windows.keys().next().value);
    }
    w.count++;
    return {
      ok: w.count <= perMinute,
      remaining: Math.max(0, perMinute - w.count),
      retryAfterSec: Math.ceil((w.start + WINDOW_MS - now) / 1000),
    };
  };

  return { take, perMinute };
};

export const clientKey = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

export const sendRateLimited = (res, retryAfterSec, message) => {
  res.setHeader('Retry-After', String(retryAfterSec));
  return res.status(429).json({ error: `${message} — try again in ${retryAfterSec}s`, code: 'rate_limited' });
};

/** Express middleware form. */
export const rateLimit = ({ perMinute = 30 } = {}) => {
  const limiter = createLimiter({ perMinute });
  return (req, res, next) => {
    const r = limiter.take(clientKey(req));
    res.setHeader('RateLimit-Limit', String(perMinute));
    res.setHeader('RateLimit-Remaining', String(r.remaining));
    if (!r.ok) return sendRateLimited(res, r.retryAfterSec, 'Too many analyses');
    next();
  };
};
