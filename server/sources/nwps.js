import { sourceCache } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';

/**
 * NOAA National Water Prediction Service river gauges, via NOAA's ArcGIS
 * map service. The NWPS REST API allows only 10 requests per 5 minutes per
 * IP; this service lets us ask once, nationwide, for just the gauges that
 * are at or above action stage (observed and forecast).
 */
const SERVICE = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer';
const OBSERVED_LAYER = 0;
const FORECAST_LAYER = 15; // full forecast period (≈ 14 days); worst forecast status

export const ATTRIBUTION = 'NOAA National Water Prediction Service';
export const SOURCE_URL = 'https://water.noaa.gov/';

const TTL_MS = 15 * 60 * 1000;
const REVALIDATE_MS = 15 * 60 * 1000;
const STALE_MS = 3 * 60 * 60 * 1000;
const MAX_OBS_AGE_MS = 6 * 60 * 60 * 1000;
const FLOODING = ['action', 'minor', 'moderate', 'major'];

const num = (s) => {
  const v = Number.parseFloat(s);
  return Number.isFinite(v) && v > -900 ? v : null;
};

// Times arrive as "2026-10-17 19:57:00" in UTC.
const utc = (s) => {
  if (!s || typeof s !== 'string') return null;
  const t = Date.parse(`${s.trim().replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : null;
};

const COMMON_FIELDS = 'gaugelid,status,location,waterbody,state,wfo,url,units,action,flood,moderate,major,pedts';
const LAYER_FIELDS = { [OBSERVED_LAYER]: 'observed,obstime', [FORECAST_LAYER]: 'forecast,fcsttime' };

const queryLayer = async (layer) => {
  const qs = new URLSearchParams({
    where: `status IN (${FLOODING.map(s => `'${s}'`).join(',')})`,
    outFields: `${COMMON_FIELDS},${LAYER_FIELDS[layer]}`,
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  });
  const data = await fetchJson(`${SERVICE}/${layer}/query?${qs}`, { label: 'NOAA river gauges', timeoutMs: 20000, retries: 2 });
  if (data?.error) throw new Error(`NOAA gauges query error: ${JSON.stringify(data.error).slice(0, 200)}`);
  if (!Array.isArray(data?.features)) throw new Error('NOAA gauges response missing features[]');
  return data.features;
};

const toGauge = (f) => {
  const p = f.properties || {};
  const c = f.geometry?.coordinates;
  if (!p.gaugelid || !Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
  // Reservoir/lake pool gauges (SHEF "HP") are not crossing hazards.
  if (String(p.pedts || '').toUpperCase().startsWith('HP')) return null;
  return {
    id: String(p.gaugelid).toUpperCase(),
    name: [p.waterbody, p.location].filter(Boolean).map(s => String(s).trim()).join(' at ') || p.gaugelid,
    lon: c[0],
    lat: c[1],
    state: p.state || null,
    url: p.url || null,
    units: p.units || null,
    stages: { action: num(p.action), flood: num(p.flood), moderate: num(p.moderate), major: num(p.major) },
    status: p.status,
    value: num(p.observed ?? p.forecast),
    time: utc(p.obstime ?? p.fcsttime),
  };
};

const fetchGauges = async () => {
  const [observed, forecast] = await Promise.all([queryLayer(OBSERVED_LAYER), queryLayer(FORECAST_LAYER)]);
  const now = Date.now();
  const byId = new Map();
  for (const g of observed.map(toGauge).filter(Boolean)) {
    if (g.time && now - g.time > MAX_OBS_AGE_MS) continue; // old readings say nothing about the creek today
    byId.set(g.id, { ...g, observed: { category: g.status, value: g.value, time: g.time }, forecast: null });
  }
  for (const g of forecast.map(toGauge).filter(Boolean)) {
    const entry = byId.get(g.id) || { ...g, observed: null };
    entry.forecast = { category: g.status, value: g.value, time: g.time };
    byId.set(g.id, entry);
  }
  return [...byId.values()];
};

/** Gauges at or above action stage nationwide (observed now or forecast). */
export const loadWater = async () => {
  try {
    const { value, fetchedAt, stale } = await sourceCache.wrap(
      'noaa:gauges', { ttlMs: TTL_MS, revalidateMs: REVALIDATE_MS, staleMs: STALE_MS }, fetchGauges);
    return {
      status: stale ? 'stale' : 'ok',
      fetchedAt: new Date(fetchedAt).toISOString(),
      message: stale
        ? 'River gauge service unreachable — showing an older copy'
        : `${value.length} gauges nationwide at or above action stage (now or forecast)`,
      attribution: ATTRIBUTION,
      url: SOURCE_URL,
      data: { gauges: value },
    };
  } catch (err) {
    console.error('[gauges] load failed:', err.message);
    return {
      status: 'error',
      fetchedAt: null,
      message: 'River gauge data unavailable',
      attribution: ATTRIBUTION,
      url: SOURCE_URL,
      data: { gauges: [] },
    };
  }
};
