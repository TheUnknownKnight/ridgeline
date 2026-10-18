import { sourceCache } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { mapLimit } from '../lib/pool.js';

/**
 * Hourly weather for the last 10 days and the next 3, per ~5 km cell, from
 * Open-Meteo (best-match models; analyses for the past). It drives the trail
 * conditions model, and the past 48 h of it is the "recent rain" the weather
 * check reports, so both share one request per cell.
 *
 * One location with 5 hourly variables over 13 days counts as one call
 * against Open-Meteo's free tier (non-commercial, 10k/day, 600/min).
 */
export const ATTRIBUTION = 'Open-Meteo (CC BY 4.0)';
export const SOURCE_URL = 'https://open-meteo.com/';

const URL = 'https://api.open-meteo.com/v1/forecast';
const HOURLY = ['temperature_2m', 'dew_point_2m', 'precipitation', 'cloud_cover', 'et0_fao_evapotranspiration'];
// Ten days covers drying and refreeze; older snow comes from NOAA's snow analysis.
const PAST_DAYS = 10;
const FORECAST_DAYS = 3;
const SNAP_DEG = 0.05;
const TTL_MS = 60 * 60 * 1000;
const STALE_MS = 6 * 60 * 60 * 1000;
// Smaller batches: one 50-location response took 3–5 s, a 25-location one ~1–2 s.
const BATCH = 25;
// Open-Meteo answers 429 "Too many concurrent requests" above two at once from one IP,
// so every caller in this process shares two slots.
const CONCURRENCY = 2;
// ~1 cell per 35 mi on a 3,400-mi route; each point is still lapse-corrected to its own elevation.
export const MAX_CELLS = 100;

const snap = (v) => Math.round(v / SNAP_DEG) * SNAP_DEG;
export const cellKeyOf = (p) => `${snap(p.lat).toFixed(2)},${snap(p.lon).toFixed(2)}`;

const asArray = (data) => (Array.isArray(data) ? data : data ? [data] : []);

const toCell = (loc) => {
  const h = loc?.hourly;
  if (!Array.isArray(h?.time) || !h.time.length) throw new Error('Open-Meteo location without hourly data');
  return {
    elevation: Number.isFinite(loc.elevation) ? loc.elevation : null,
    time: h.time.map(t => t * 1000),
    Ta: h.temperature_2m,
    Td: h.dew_point_2m,
    P: h.precipitation,
    cloud: h.cloud_cover,
    et0: h.et0_fao_evapotranspiration,
  };
};

const pending = new Map(); // cell key -> promise, so two loaders asking at once share one request

let active = 0;
const queue = [];
const withSlot = async (fn) => {
  if (active >= CONCURRENCY) await new Promise(resolve => queue.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
};

const fetchBatch = async (keys) => {
  const qs = new URLSearchParams({
    latitude: keys.map(k => k.split(',')[0]).join(','),
    longitude: keys.map(k => k.split(',')[1]).join(','),
    hourly: HOURLY.join(','),
    past_days: String(PAST_DAYS),
    forecast_days: String(FORECAST_DAYS),
    timezone: 'GMT',
    timeformat: 'unixtime',
  });
  const data = asArray(await fetchJson(`${URL}?${qs}`, { label: 'Open-Meteo hourly', timeoutMs: 15000, retries: 1, maxBytes: 20 * 1024 * 1024 }));
  if (data.length !== keys.length) throw new Error(`Open-Meteo hourly: expected ${keys.length} locations, got ${data.length}`);
  return data.map(toCell);
};

/**
 * Hourly cells for the given keys: Map(key → cell | null). Fresh cache hits
 * first, then one request per batch of misses; on failure, an older copy
 * (up to 6 h) is used and counted as stale.
 */
export const loadCells = async (keys) => {
  const out = new Map();
  const misses = [];
  const waits = [];
  let failed = 0;
  let stale = 0;
  // Every caller — the one that fetched or one that waited on it — falls back the same way.
  const settle = (k, v) => {
    if (v) { out.set(k, v); return; }
    const old = sourceCache.peek(`om:hourly:${k}`);
    if (old) { out.set(k, old.value); stale++; } else { out.set(k, null); failed++; }
  };
  for (const k of new Set(keys)) {
    const v = sourceCache.get(`om:hourly:${k}`);
    if (v !== undefined) out.set(k, v);
    else if (pending.has(k)) waits.push(pending.get(k).then(v => settle(k, v)));
    else misses.push(k);
  }
  const batches = [];
  for (let i = 0; i < misses.length; i += BATCH) batches.push(misses.slice(i, i + BATCH));
  await Promise.all([
    ...waits,
    mapLimit(batches, batches.length || 1, async (batch) => {
      const job = withSlot(() => fetchBatch(batch));
      batch.forEach((k, i) => pending.set(k, job.then(cells => cells[i]).catch(() => null)));
      try {
        const cells = await job;
        batch.forEach((k, i) => {
          sourceCache.set(`om:hourly:${k}`, cells[i], { ttlMs: TTL_MS, staleMs: STALE_MS });
          out.set(k, cells[i]);
        });
      } catch (err) {
        console.error('[open-meteo] hourly batch failed:', err.message);
        for (const k of batch) settle(k, null);
      } finally {
        for (const k of batch) pending.delete(k);
      }
    }),
  ]);
  return { cells: out, failed, stale, total: new Set(keys).size };
};

/** Rain (mm) over the 48 hours before `now` in one cell, or null. */
export const past48hMm = (cell, now) => {
  if (!cell) return null;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < cell.time.length; i++) {
    if (cell.time[i] <= now && cell.time[i] > now - 48 * 3600 * 1000 && typeof cell.P[i] === 'number') { sum += cell.P[i]; n++; }
  }
  return n ? sum : null;
};

/**
 * IANA time zone at a point, for local "8 AM" windows when the NWS forecast
 * (the usual source of the route's zone) is unavailable or outside the US.
 * One tiny Open-Meteo request per ~50 km cell, cached for a month.
 */
export const loadTimeZone = async (lat, lon) => {
  const key = `${(Math.round(lat * 2) / 2).toFixed(1)},${(Math.round(lon * 2) / 2).toFixed(1)}`;
  try {
    const { value } = await sourceCache.wrap(`om:tz:${key}`, { ttlMs: 30 * 24 * 3600 * 1000, errorTtlMs: 5 * 60 * 1000 }, async () => {
      const qs = new URLSearchParams({ latitude: lat.toFixed(3), longitude: lon.toFixed(3), timezone: 'auto', forecast_days: '1', daily: 'sunrise' });
      const data = await withSlot(() => fetchJson(`${URL}?${qs}`, { label: 'Open-Meteo time zone', timeoutMs: 6000, retries: 0 }));
      if (typeof data?.timezone !== 'string' || !data.timezone.includes('/')) throw new Error('no time zone');
      return data.timezone;
    });
    return value;
  } catch {
    return null;
  }
};
