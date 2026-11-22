import { padBbox } from '../../shared/geo.js';
import { endpointUrl } from '../config.js';
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
const FORECAST_LAYER = 7; // 168-hour (7-day) forecast; filtered to 72 h (or trip ETA) in detectWater

export const ATTRIBUTION = 'NOAA National Water Prediction Service';
export const SOURCE_URL = 'https://water.noaa.gov/';

const TTL_MS = 15 * 60 * 1000;
const REVALIDATE_MS = 15 * 60 * 1000;
const STALE_MS = 3 * 60 * 60 * 1000;
const MAX_OBS_AGE_MS = 6 * 60 * 60 * 1000;
const FLOODING = ['action', 'minor', 'moderate', 'major'];

// SHEF physical-element prefixes that measure reservoir pools, lakes, or ocean/coastal
// tides rather than flowing river/creek crossings:
// HP = pool/reservoir, HM = marine/tidal, HC = coastal/tidal, HT = tide/tsunami, HL = lake, HI = intake.
const NON_STREAM_SHEF_RE = /^(HP|HM|HC|HT|HL|HI)/;
const TIDE_NAME_RE = /\b(tide\s+(gauge|station)|in\s+m[hl]lw|in\s+mhhw|ocean\s+front)\b/i;

export const isStreamGauge = (p) => {
  if (!p) return false;
  const pedts = String(p.pedts || '').trim().toUpperCase();
  if (NON_STREAM_SHEF_RE.test(pedts)) return false;
  const text = [p.waterbody, p.location].filter(Boolean).join(' ');
  if (TIDE_NAME_RE.test(text)) return false;
  return true;
};

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

const CORRIDOR_PAD_MILES = 5;

const corridorEnvelope = (bbox, padMiles) => {
  const [w, s, e, n] = padBbox(bbox, padMiles);
  const xmin = Math.max(-180, Math.floor(w * 100) / 100);
  const ymin = Math.max(-90, Math.floor(s * 100) / 100);
  const xmax = Math.min(180, Math.ceil(e * 100) / 100);
  const ymax = Math.min(90, Math.ceil(n * 100) / 100);
  return {
    cacheKey: `${xmin.toFixed(2)},${ymin.toFixed(2)},${xmax.toFixed(2)},${ymax.toFixed(2)}`,
    params: {
      geometry: JSON.stringify({ xmin, ymin, xmax, ymax, spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryEnvelope',
      spatialRel: 'esriSpatialRelIntersects',
      inSR: '4326',
    },
  };
};

const queryLayer = async (layer, spatialParams = {}) => {
  const service = endpointUrl('nwpsService', SERVICE);
  const qs = new URLSearchParams({
    where: `status IN (${FLOODING.map(s => `'${s}'`).join(',')})`,
    outFields: `${COMMON_FIELDS},${LAYER_FIELDS[layer]}`,
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
    ...spatialParams,
  });
  const data = await fetchJson(`${service}/${layer}/query?${qs}`, { label: 'NOAA river gauges', timeoutMs: 20000, retries: 2 });
  if (data?.error) throw new Error(`NOAA gauges query error: ${JSON.stringify(data.error).slice(0, 200)}`);
  if (!Array.isArray(data?.features)) throw new Error('NOAA gauges response missing features[]');
  return data.features;
};

const toGauge = (f) => {
  const p = f.properties || {};
  const c = f.geometry?.coordinates;
  if (!p.gaugelid || !Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
  if (!isStreamGauge(p)) return null;
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

const fetchGauges = async (spatialParams = {}) => {
  const [observed, forecast] = await Promise.all([
    queryLayer(OBSERVED_LAYER, spatialParams),
    queryLayer(FORECAST_LAYER, spatialParams),
  ]);
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

/** Gauges at or above action stage nationwide or along a route corridor (observed now or 7-day forecast). */
export const loadWater = async ({ route, scope = 'nationwide' } = {}) => {
  const corridor = scope === 'corridor' && Boolean(route?.paddedBbox);
  const env = corridor ? corridorEnvelope(route.paddedBbox, CORRIDOR_PAD_MILES) : null;
  const cacheKey = env ? `noaa:gauges:corridor:${env.cacheKey}` : 'noaa:gauges';
  try {
    const { value, fetchedAt, stale } = await sourceCache.wrap(
      cacheKey,
      { ttlMs: TTL_MS, revalidateMs: REVALIDATE_MS, staleMs: STALE_MS },
      () => fetchGauges(env ? env.params : {}),
    );
    return {
      status: stale ? 'stale' : 'ok',
      fetchedAt: new Date(fetchedAt).toISOString(),
      message: stale
        ? 'River gauge service unreachable — showing an older copy'
        : `${value.length} stream gauges ${corridor ? 'near route' : 'nationwide'} at or above action stage (now or forecast)`,
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
