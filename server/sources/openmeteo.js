import { sourceCache } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { mapLimit } from '../lib/pool.js';
import { loadCells, cellKeyOf, past48hMm } from './weatherHistory.js';

/**
 * Open-Meteo fills two gaps NWS gridpoints cannot: rain that already fell
 * (model analysis for the past 48 h) and, as the fallback where NOAA's
 * air-quality forecast has no data, smoke/air quality (CAMS, ~40 km).
 * Free tier: non-commercial, ~600 location-calls/min, 10k/day per IP, so
 * points are snapped and cached, and only cache misses are requested.
 */
export const PRECIP_ATTRIBUTION = 'Open-Meteo (CC BY 4.0)';
export const AQ_ATTRIBUTION = 'Open-Meteo Air Quality / CAMS (CC BY 4.0)';
export const SOURCE_URL = 'https://open-meteo.com/';

const AQ_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const SNAP_DEG = 0.05;
const TTL_MS = 60 * 60 * 1000;
const STALE_MS = 6 * 60 * 60 * 1000;
const BATCH = 100; // keeps GET URLs well under the ~8 KB nginx limit

const snap = (v) => Math.round(v / SNAP_DEG) * SNAP_DEG;
const keyOf = (s) => `${snap(s.lat).toFixed(2)},${snap(s.lon).toFixed(2)}`;

const asArray = (data) => (Array.isArray(data) ? data : data ? [data] : []);

/**
 * Fetch `extract(locationResponse)` for every distinct snapped point,
 * batching cache misses into multi-location requests.
 */
const loadPoints = async ({ samples, cachePrefix, url, params, extract, label, timeoutMs = 15000, retries = 1 }) => {
  const keys = [...new Set(samples.map(keyOf))];
  const values = new Map();
  const misses = [];
  for (const k of keys) {
    const v = sourceCache.get(`${cachePrefix}:${k}`);
    if (v !== undefined) values.set(k, v); else misses.push(k);
  }

  let failedKeys = 0;
  let staleKeys = 0;
  const batches = [];
  for (let i = 0; i < misses.length; i += BATCH) batches.push(misses.slice(i, i + BATCH));
  await mapLimit(batches, 2, async (batch) => {
    const qs = new URLSearchParams({
      ...params,
      latitude: batch.map(k => k.split(',')[0]).join(','),
      longitude: batch.map(k => k.split(',')[1]).join(','),
      timezone: 'GMT',
      timeformat: 'unixtime',
    });
    try {
      const data = asArray(await fetchJson(`${url}?${qs}`, { label, timeoutMs, retries }));
      if (data.length !== batch.length) throw new Error(`${label}: expected ${batch.length} locations, got ${data.length}`);
      batch.forEach((k, i) => {
        const v = extract(data[i]);
        sourceCache.set(`${cachePrefix}:${k}`, v, { ttlMs: TTL_MS, staleMs: STALE_MS });
        values.set(k, v);
      });
    } catch (err) {
      console.error(`[open-meteo] ${label} batch failed:`, err.message);
      // Fall back to recent-but-expired values rather than losing them.
      for (const k of batch) {
        const old = sourceCache.peek(`${cachePrefix}:${k}`);
        if (old) { values.set(k, old.value); staleKeys++; } else failedKeys++;
      }
    }
  });

  return {
    bySample: samples.map(s => values.get(keyOf(s)) ?? null),
    failed: failedKeys,
    stale: staleKeys,
    total: keys.length,
  };
};

/** Indices of at most `max` samples spread evenly along the list. */
const pickEvenly = (n, max) => {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: max }, (_, k) => Math.round((k * (n - 1)) / (max - 1)));
};

/** For each sample index, the position (in picks) of the nearest picked sample. */
const nearestPick = (n, picks) => {
  const out = new Array(n);
  let p = 0;
  for (let i = 0; i < n; i++) {
    while (p < picks.length - 1 && Math.abs(picks[p + 1] - i) <= Math.abs(picks[p] - i)) p++;
    out[i] = p;
  }
  return out;
};

// PM2.5 only (already a 24-hour rolling mean): the all-pollutant us_aqi would
// present ozone as smoke and disagree with NOAA and AirNow.
const maxAqi = (loc, nowSec) => {
  const t = loc?.hourly?.time || [];
  const a = loc?.hourly?.us_aqi_pm2_5 || [];
  let best = null;
  let from = null;
  for (let i = 0; i < t.length; i++) {
    if (t[i] < nowSec - 3600 || t[i] > nowSec + 48 * 3600 || typeof a[i] !== 'number' || a[i] < 0 || a[i] > 500) continue;
    if (from == null && a[i] >= 101) from = t[i] * 1000;
    if (!best || a[i] > best.aqi) best = { aqi: a[i], at: t[i] * 1000 };
  }
  return best && { ...best, from };
};

const statusOf = ({ failed, stale, total }) => (total && failed === total ? 'error' : failed ? 'partial' : stale ? 'stale' : 'ok');

// Recent rain only needs a coarse picture; cap per-analysis quota use.
const MAX_PRECIP_POINTS = 40;

/**
 * Model-estimated liquid rainfall over the last 48 h at each sample. Read from
 * the same hourly cells the trail-conditions model uses (one request each).
 */
export const loadRecentPrecip = async ({ samples, now = Date.now() }) => {
  const picks = pickEvenly(samples.length, MAX_PRECIP_POINTS);
  const keys = picks.map(i => cellKeyOf(samples[i]));
  const r = await loadCells(keys);
  const values = keys.map((k, idx) => {
    const mm = past48hMm(r.cells.get(k), now, { elevM: samples[picks[idx]]?.ele ?? null });
    return mm == null ? null : { past48hMm: mm };
  });
  const nearest = nearestPick(samples.length, picks);
  return {
    status: statusOf(r),
    fetchedAt: new Date(now).toISOString(),
    message: r.failed ? `Recent rainfall unavailable for ${r.failed}/${r.total} points` : `Recent rainfall for ${r.total} points`,
    attribution: PRECIP_ATTRIBUTION,
    url: SOURCE_URL,
    data: { bySample: samples.map((_, i) => values[nearest[i]]) },
  };
};

/** Peak forecast US AQI (next 48 h) at each sample, from CAMS (coarse; the NOAA fallback). */
export const loadCamsSmoke = async ({ samples, now = Date.now(), timeoutMs, retries }) => {
  if (!samples?.length) {
    return { status: 'skipped', fetchedAt: null, message: 'No air-quality points requested', attribution: AQ_ATTRIBUTION, url: SOURCE_URL, data: { points: [] } };
  }
  const nowSec = Math.floor(now / 1000);
  const r = await loadPoints({
    samples,
    cachePrefix: 'om:aq25',
    url: AQ_URL,
    params: { hourly: 'us_aqi_pm2_5', forecast_days: '3' },
    extract: (loc) => maxAqi(loc, nowSec),
    label: 'Open-Meteo air quality',
    timeoutMs,
    retries,
  });
  const status = statusOf(r);
  return {
    status,
    fetchedAt: new Date(now).toISOString(),
    message: status === 'error'
      ? 'Air-quality forecast unavailable'
      : `Air-quality forecast for ${r.total - r.failed}/${r.total} points${r.stale ? ` (${r.stale} from an older run)` : ''} — coarse ~40 km model; may under-report smoke near fires`,
    attribution: AQ_ATTRIBUTION,
    url: SOURCE_URL,
    data: { points: samples.map((s, i) => ({ ...s, aq: r.bySample[i] })) },
  };
};
