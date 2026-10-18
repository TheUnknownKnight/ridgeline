import { sourceCache } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { mapLimit } from '../lib/pool.js';

/**
 * NOAA National Air Quality Forecast Capability: hourly PM2.5 for the next
 * 72 h on a ~5 km grid, bias-corrected, with wildfire smoke emissions — the
 * guidance behind AirNow's forecasts. Served as a time-enabled ArcGIS
 * ImageServer; getSamples reads many points × up to 20 time steps per call.
 *
 * The service holds one run at a time and swaps all 72 rasters (new ids)
 * once a day over ~30 s, so the catalog is re-read when sampling fails and
 * a half-ingested run is never pinned.
 */
const BASE = 'https://mapservices.weather.noaa.gov/raster/rest/services/air_quality';
const SERVICES = ['ndgd_apm25_hr01_bc', 'ndgd_apm25_hr01'];
export const ATTRIBUTION = 'NOAA National Air Quality Forecast Capability (PM2.5)';
export const SOURCE_URL = 'https://vlab.noaa.gov/web/osti-modeling/air-quality';

const HORIZON_MS = 48 * 3600 * 1000;
const STEP_HOURS = 3;          // 48 h in 17 steps, under the 20-rasters-per-call limit
const MAX_RASTERS_PER_CALL = 20;
const MAX_POINTS_PER_CALL = 100;
const SNAP_DEG = 0.05;
const CATALOG_TTL_MS = 20 * 60 * 1000;
const INCOMPLETE_RUN_TTL_MS = 60 * 1000;
const COMPLETE_RUN_MS = 66 * 3600 * 1000; // a 72-h run counts as fully ingested from here
const POINT_TTL_MS = 60 * 60 * 1000;
const POINT_STALE_MS = 6 * 60 * 60 * 1000;
// Below this many hours ahead the "next 48 hours" promise doesn't hold.
export const SHORT_HORIZON_HOURS = 40;
export const UNHEALTHY_FOR_SENSITIVE = 101;

// The grid's extent (from the service, converted from web mercator). Asking about
// points far outside it fails the whole request with a 400, so they never go out.
const GRID_EXTENT = [-152.9, 12.1, -49.3, 61.2];
const inGrid = (k) => {
  const [lat, lon] = k.split(',').map(Number);
  return lon >= GRID_EXTENT[0] && lon <= GRID_EXTENT[2] && lat >= GRID_EXTENT[1] && lat <= GRID_EXTENT[3];
};

const snap = (v) => Math.round(v / SNAP_DEG) * SNAP_DEG;
const keyOf = (s) => `${snap(s.lat).toFixed(2)},${snap(s.lon).toFixed(2)}`;

/** EPA PM2.5 AQI breakpoints (2024 revision), concentration in µg/m³. */
const PM25_BREAKPOINTS = [
  [0, 9.0, 0, 50], [9.1, 35.4, 51, 100], [35.5, 55.4, 101, 150], [55.5, 125.4, 151, 200],
  [125.5, 225.4, 201, 300], [225.5, 325.4, 301, 500],
];

export const pm25ToAqi = (c) => {
  if (!Number.isFinite(c) || c < 0) return null;
  const x = Math.floor(c * 10) / 10;
  for (const [cl, ch, il, ih] of PM25_BREAKPOINTS) {
    if (x <= ch) return Math.round(((ih - il) / (ch - cl)) * (Math.max(x, cl) - cl) + il);
  }
  return 500;
};

const fetchCatalog = async (service) => {
  const qs = new URLSearchParams({
    where: 'idp_issueddate IS NOT NULL',
    outFields: 'objectid,idp_validtime,idp_issueddate',
    returnGeometry: 'false',
    f: 'json',
  });
  const data = await fetchJson(`${BASE}/${service}/ImageServer/query?${qs}`, { label: 'NOAA AQ catalog', timeoutMs: 6000, retries: 0 });
  if (data?.error) throw new Error(`NOAA AQ catalog error: ${JSON.stringify(data.error).slice(0, 160)}`);
  // ~74 orphaned rows carry no valid time; they are not part of any run.
  const rows = (data?.features || []).map(f => f.attributes)
    .filter(a => Number.isFinite(a?.idp_validtime) && a.idp_validtime > 0 && Number.isFinite(a.idp_issueddate));
  if (!rows.length) throw new Error('NOAA AQ catalog is empty');
  const runs = new Map();
  for (const r of rows) {
    if (!runs.has(r.idp_issueddate)) runs.set(r.idp_issueddate, []);
    runs.get(r.idp_issueddate).push({ id: r.objectid, at: r.idp_validtime });
  }
  const ordered = [...runs].sort((a, b) => b[0] - a[0]);
  const complete = ([issued, rasters]) => Math.max(...rasters.map(r => r.at)) - issued >= COMPLETE_RUN_MS;
  // Mid-ingest the newest run holds only its first hours: use the previous run while it's still listed.
  const pick = ordered.find(complete) || ordered[0];
  return { issued: pick[0], rasters: pick[1], complete: complete(pick) };
};

/** The chosen run's rasters for the next 48 h, every STEP_HOURS. */
const loadCatalog = async (service, now) => {
  const key = `naqfc:catalog:${service}`;
  const opts = { ttlMs: CATALOG_TTL_MS, staleMs: 6 * 3600 * 1000, errorTtlMs: 60 * 1000 };
  let entry = await sourceCache.wrap(key, opts, () => fetchCatalog(service));
  if (!entry.value.complete && now - entry.fetchedAt > INCOMPLETE_RUN_TTL_MS) {
    sourceCache.delete(key);
    entry = await sourceCache.wrap(key, opts, () => fetchCatalog(service));
  }
  const rasters = entry.value.rasters
    .filter(r => r.at >= now - 3600 * 1000 && r.at <= now + HORIZON_MS)
    .sort((a, b) => a.at - b.at)
    .filter((r, i) => i % STEP_HOURS === 0)
    .slice(0, MAX_RASTERS_PER_CALL);
  if (!rasters.length) throw new Error('NOAA AQ forecast has no time steps ahead');
  return { key, issued: entry.value.issued, rasters, stale: entry.stale, horizonHours: (rasters[rasters.length - 1].at - now) / 3600e3 };
};

class StaleRunError extends Error {}

/** PM2.5 series for a batch of points: Map(key → [{ at, pm25 }]). Points outside the grid are absent. */
const sampleBatch = async (service, rasters, keys) => {
  const points = keys.map(k => { const [lat, lon] = k.split(',').map(Number); return [lon, lat]; });
  const body = new URLSearchParams({
    geometry: JSON.stringify({ points, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryMultipoint',
    returnFirstValueOnly: 'false',
    mosaicRule: JSON.stringify({ mosaicMethod: 'esriMosaicLockRaster', lockRasterIds: rasters.map(r => r.id) }),
    outFields: 'idp_validtime',
    f: 'json',
  });
  const data = await fetchJson(`${BASE}/${service}/ImageServer/getSamples`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    label: 'NOAA AQ samples',
    timeoutMs: 8000,
    retries: 0,
  });
  // An error body with HTTP 200 usually means the run was swapped and our raster ids are gone.
  if (data?.error) throw new StaleRunError(`NOAA AQ samples error: ${JSON.stringify(data.error).slice(0, 160)}`);
  const out = new Map();
  for (const s of data?.samples || []) {
    const key = keys[s.locationId];
    const pm25 = Number(s.value);
    const at = s.attributes?.idp_validtime;
    if (key == null || !Number.isFinite(pm25) || pm25 < 0 || !Number.isFinite(at)) continue;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push({ at, pm25 });
  }
  return out;
};

/**
 * Peak forecast AQI over the next 48 h from a 3-hourly PM2.5 series, and when
 * it first reaches "unhealthy for sensitive groups". AQI is defined on 24-hour
 * averages, so single-hour spikes are smoothed over three steps (~9 h) first.
 */
export const peakAqi = (series) => {
  const s = [...series].sort((a, b) => a.at - b.at);
  if (!s.length) return null;
  let best = null;
  let from = null;
  for (let i = 0; i < s.length; i++) {
    const win = s.slice(Math.max(0, i - 1), Math.min(s.length, i + 2));
    const mean = win.reduce((n, x) => n + x.pm25, 0) / win.length;
    const aqi = pm25ToAqi(mean);
    if (aqi == null) continue;
    if (from == null && aqi >= UNHEALTHY_FOR_SENSITIVE) from = s[i].at;
    // Ties go to the window centred on the highest hour, so the time points at the peak itself.
    if (!best || aqi > best.aqi || (aqi === best.aqi && s[i].pm25 > best.center)) {
      best = { aqi, at: s[i].at, pm25: Math.round(mean * 10) / 10, center: s[i].pm25 };
    }
  }
  return best && { aqi: best.aqi, at: best.at, pm25: best.pm25, from };
};

const sampleAll = async (service, catalog, misses, values) => {
  const failedKeys = [];
  let staleRun = false;
  const batches = [];
  for (let i = 0; i < misses.length; i += MAX_POINTS_PER_CALL) batches.push(misses.slice(i, i + MAX_POINTS_PER_CALL));
  const lastId = catalog.rasters[catalog.rasters.length - 1].id;
  await mapLimit(batches, 2, async (batch) => {
    try {
      const series = await sampleBatch(service, catalog.rasters, batch);
      for (const k of batch) {
        const got = series.get(k);
        if (got && got.length < catalog.rasters.length) { failedKeys.push(k); continue; } // a mixed or half-swapped run
        // Outside the grid (no samples) is a real "no data here", cached like any value.
        const v = got ? peakAqi(got) : null;
        sourceCache.set(`naqfc:${service}:${catalog.issued}:${lastId}:${k}`, v, { ttlMs: POINT_TTL_MS, staleMs: POINT_STALE_MS });
        values.set(k, v);
      }
    } catch (err) {
      if (err instanceof StaleRunError) staleRun = true;
      console.error('[naqfc] samples failed:', err.message);
      failedKeys.push(...batch);
    }
  });
  return { failedKeys, staleRun };
};

/**
 * Forecast peak AQI per sample from NOAA. Returns { status, bySample, failed,
 * total, issued, horizonHours }. Points the grid doesn't cover come back null
 * so the caller can fill them from a global model.
 */
export const loadNaqfc = async ({ samples, now = Date.now() }) => {
  let catalog = null;
  let service = null;
  for (const s of SERVICES) {
    try {
      catalog = await loadCatalog(s, now);
      service = s;
      break;
    } catch (err) {
      console.error(`[naqfc] ${s} catalog failed:`, err.message);
    }
  }
  if (!catalog) {
    return { status: 'error', bySample: samples.map(() => null), failed: samples.length, total: samples.length, issued: null, horizonHours: null };
  }

  const keys = [...new Set(samples.map(keyOf))];
  const values = new Map();
  const lastId = catalog.rasters[catalog.rasters.length - 1].id;
  const misses = [];
  for (const k of keys) {
    if (!inGrid(k)) { values.set(k, null); continue; }
    const v = sourceCache.get(`naqfc:${service}:${catalog.issued}:${lastId}:${k}`);
    if (v !== undefined) values.set(k, v); else misses.push(k);
  }
  let { failedKeys, staleRun } = await sampleAll(service, catalog, misses, values);
  if (staleRun) {
    // The run was swapped under us: re-read the catalog once and retry what failed.
    sourceCache.delete(catalog.key);
    try {
      catalog = await loadCatalog(service, now);
      ({ failedKeys } = await sampleAll(service, catalog, failedKeys, values));
    } catch (err) {
      console.error('[naqfc] catalog reload failed:', err.message);
    }
  }
  const failed = failedKeys.length;
  const short = catalog.horizonHours < SHORT_HORIZON_HOURS;
  return {
    status: failed === keys.length && keys.length ? 'error' : failed || short ? 'partial' : catalog.stale ? 'stale' : 'ok',
    bySample: samples.map(s => values.get(keyOf(s)) ?? null),
    failed,
    total: keys.length,
    issued: catalog.issued,
    horizonHours: catalog.horizonHours,
  };
};
