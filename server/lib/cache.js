/**
 * In-memory TTL cache with:
 *  - in-flight de-duplication (concurrent misses share one upstream fetch),
 *  - stale-while-revalidate and stale-on-error (flagged stale),
 *  - a bounded wait: when a usable stale copy exists, a slow or hung
 *    upstream never holds a request longer than STALE_WAIT_MS,
 *  - negative caching of failures so a broken upstream isn't re-waited on,
 *  - entry-count and weight caps with least-recently-used eviction.
 *
 * Values are shared between requests: callers must never mutate them.
 */
const STALE_WAIT_MS = 3000;
// After a failed refresh that we covered with stale data, don't retry for this long.
const STALE_FAILURE_TTL_MS = 30000;

export const createCache = ({ maxEntries = 500, maxWeight = Infinity, weigh = () => 1 } = {}) => {
  const entries = new Map(); // key -> { value, fetchedAt, expiresAt, staleUntil, weight }
  const inflight = new Map();
  const failures = new Map(); // key -> { error, until }
  const stats = { hits: 0, misses: 0, staleServed: 0, evictions: 0 };
  let totalWeight = 0;

  const remove = (key) => {
    const e = entries.get(key);
    if (!e) return;
    totalWeight -= e.weight;
    entries.delete(key);
  };

  const touch = (key, entry) => {
    entries.delete(key);
    entries.set(key, entry);
  };

  const evict = (now) => {
    // Drop dead entries from the cold end first, then enforce the caps.
    for (const [k, e] of entries) {
      if (e.staleUntil > now) break;
      remove(k);
    }
    while (entries.size > maxEntries || (totalWeight > maxWeight && entries.size > 1)) {
      remove(entries.keys().next().value);
      stats.evictions++;
    }
  };

  const set = (key, value, { ttlMs, staleMs = 0 }, now = Date.now()) => {
    remove(key);
    const entry = { value, fetchedAt: now, expiresAt: now + ttlMs, staleUntil: now + ttlMs + staleMs, weight: weigh(value) };
    entries.set(key, entry);
    totalWeight += entry.weight;
    evict(now);
    return entry;
  };

  const recordFailure = (key, error, ttlMs) => {
    if (!(ttlMs > 0)) return;
    failures.set(key, { error, until: Date.now() + ttlMs });
    if (failures.size > maxEntries) failures.delete(failures.keys().next().value);
  };

  const refresh = (key, opts, fetchFn) => {
    let pending = inflight.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const value = await fetchFn();
          failures.delete(key);
          return set(key, value, opts);
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, pending);
    }
    return pending;
  };

  const staleResult = (entry) => {
    stats.staleServed++;
    return { value: entry.value, fetchedAt: entry.fetchedAt, stale: true };
  };

  /**
   * Returns { value, fetchedAt, stale }. Throws only when the fetch fails and
   * no usable stale value exists.
   *
   * revalidateMs: for this long after expiry the old value is returned
   * immediately (not flagged stale) while a background refresh runs.
   * staleMs: beyond that, the old value is still served — flagged stale —
   * whenever the upstream fails or is slow.
   * errorTtlMs: after a failure with nothing to serve, fail fast this long.
   */
  const wrap = async (key, { ttlMs, staleMs = 0, revalidateMs = 0, errorTtlMs = 0 }, fetchFn) => {
    const now = Date.now();
    const entry = entries.get(key);
    const opts = { ttlMs, staleMs: Math.max(staleMs, revalidateMs) };
    const failure = failures.get(key);
    const recentFailure = failure && failure.until > now;

    if (entry && entry.expiresAt > now) {
      stats.hits++;
      touch(key, entry);
      return { value: entry.value, fetchedAt: entry.fetchedAt, stale: false };
    }
    if (entry && revalidateMs > 0 && entry.expiresAt + revalidateMs > now) {
      stats.hits++;
      if (!recentFailure) {
        refresh(key, opts, fetchFn).catch(err => recordFailure(key, err, STALE_FAILURE_TTL_MS));
      }
      return { value: entry.value, fetchedAt: entry.fetchedAt, stale: false };
    }
    stats.misses++;

    const usable = entry && entry.staleUntil > now ? entry : null;
    if (recentFailure) {
      if (usable) return staleResult(usable);
      throw failure.error;
    }

    const pending = refresh(key, opts, fetchFn);
    if (usable) {
      // Never let a slow upstream hold the request when we have something to show.
      pending.catch(err => recordFailure(key, err, STALE_FAILURE_TTL_MS));
      let timer;
      const timeout = new Promise(resolve => { timer = setTimeout(resolve, STALE_WAIT_MS, null); });
      const fresh = await Promise.race([pending.catch(() => null), timeout]);
      clearTimeout(timer);
      if (fresh) return { value: fresh.value, fetchedAt: fresh.fetchedAt, stale: false };
      return staleResult(usable);
    }

    try {
      const fresh = await pending;
      return { value: fresh.value, fetchedAt: fresh.fetchedAt, stale: false };
    } catch (err) {
      recordFailure(key, err, errorTtlMs);
      throw err;
    }
  };

  /** Fresh value or undefined. */
  const get = (key) => {
    const entry = entries.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return undefined;
    touch(key, entry);
    return entry.value;
  };

  /** Value still inside its stale window (fresh or not), with its age; or undefined. */
  const peek = (key) => {
    const entry = entries.get(key);
    if (!entry || entry.staleUntil <= Date.now()) return undefined;
    return { value: entry.value, fetchedAt: entry.fetchedAt, stale: entry.expiresAt <= Date.now() };
  };

  const clear = () => {
    entries.clear();
    inflight.clear();
    failures.clear();
    totalWeight = 0;
  };

  return {
    wrap,
    get,
    peek,
    set: (key, value, opts) => { set(key, value, opts); },
    /** Forget one key (and any remembered failure), so the next wrap fetches afresh. */
    delete: (key) => { remove(key); failures.delete(key); },
    /** Forget remembered negative failures while keeping valid cached values. */
    clearFailures: () => { failures.clear(); },
    clear,
    stats: () => ({ keys: entries.size, weight: totalWeight, inflight: inflight.size, failures: failures.size, ...stats }),
  };
};

// Upstream data (fires, alerts, zones, forecasts) — shared by all requests.
export const sourceCache = createCache({ maxEntries: 5000 });
