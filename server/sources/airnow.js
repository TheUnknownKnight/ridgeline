import { sourceCache } from '../lib/cache.js';
import { queryAllGeoJson } from '../lib/arcgis.js';
import { prepPolygons, polygonsBbox } from '../lib/spatial.js';
import { loadSmokePlumes } from './hms.js';

/**
 * Measured air quality now: EPA AirNow's hourly PM2.5 picture, nationwide,
 * shared by every route. Two layers from EPA's public ArcGIS org:
 * - contours: AQI-category polygons interpolated from the monitors (what
 *   the AirNow Fire and Smoke Map shows);
 * - monitors: the stations themselves, including Forest Service monitors
 *   set up near fires.
 * Satellite smoke plumes (NOAA HMS) ride along as map context.
 */
const ORG = 'https://services.arcgis.com/cJ9YHowT8TU7DUyn/ArcGIS/rest/services';
const CONTOURS_URL = `${ORG}/AirNowLatestContoursPM25/FeatureServer/0/query`;
const MONITORS_URL = `${ORG}/Air_Now_Current_Monitors_PM25/FeatureServer/0/query`;

export const ATTRIBUTION = 'EPA AirNow (PM2.5)';
export const SOURCE_URL = 'https://fire.airnow.gov/';

// AirNow publishes once an hour, ~40 min past. Older than a few hours is no longer "now".
const TTL_MS = 10 * 60 * 1000;
const REVALIDATE_MS = 20 * 60 * 1000;
const STALE_MS = 3 * 60 * 60 * 1000;
// Judged by the readings' own time, not by when we fetched them: EPA's layer
// can keep answering with an hour that stopped advancing.
const READINGS_STALE_MS = 3 * 60 * 60 * 1000;
const READINGS_DEAD_MS = 12 * 60 * 60 * 1000;
// A monitor that misses an hour ("ND", common for temporary fire monitors)
// keeps its last reading this long instead of vanishing: a gap in a monitor
// must not read as cleaner air.
const CARRY_MS = 3 * 60 * 60 * 1000;
const PLUME_BUDGET_MS = 2500;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** AirNow AQI categories (gridcode): 1 good … 6 hazardous. */
export const AQI_CATEGORIES = ['', 'good', 'moderate', 'unhealthy for sensitive groups', 'unhealthy', 'very unhealthy', 'hazardous'];

export const categoryOfAqi = (aqi) => (aqi == null ? null
  : aqi <= 50 ? 1 : aqi <= 100 ? 2 : aqi <= 150 ? 3 : aqi <= 200 ? 4 : aqi <= 300 ? 5 : 6);

const normalizeContour = (f) => {
  const category = num(f.properties?.gridcode);
  if (!(category >= 1 && category <= 6)) return null;
  // Contours are smooth, regional shapes; ~0.1 mi keeps point-in-polygon cheap.
  const polygons = prepPolygons(f.geometry, 0.1);
  if (!polygons.length) return null;
  return { category, polygons, bbox: polygonsBbox(polygons), at: num(f.properties?.Timestamp) };
};

const normalizeMonitor = (f) => {
  const p = f.properties || {};
  const c = f.geometry?.type === 'Point' ? f.geometry.coordinates : null;
  let aqi = num(p.PM25_AQI);
  if (aqi != null && aqi < 0) aqi = null; // "ND": no data this hour
  if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
  if (p.Status && String(p.Status).toLowerCase() !== 'active') return null;
  const site = String(p.SiteName || '').trim();
  return {
    id: String(p.AQSID || `${c[0]},${c[1]}`),
    // Temporary monitors are named by their AQS id only; say who runs them instead.
    name: site && site !== p.AQSID ? site : `${p.DataSource || 'Temporary'} monitor`,
    agency: p.DataSource ? String(p.DataSource) : null,
    aqi,
    pm25: num(p.PM25),
    category: aqi == null ? null : categoryOfAqi(aqi),
    at: num(p.ValidTime) != null ? num(p.ValidTime) * (p.ValidTime < 1e12 ? 1000 : 1) : null,
    lon: c[0],
    lat: c[1],
  };
};

/** Last good reading per monitor (AQSID), so an "ND" hour carries it forward. */
const lastReadings = new Map();

const carryForward = (monitors, now) => {
  for (const [id, r] of lastReadings) if (now - r.at > CARRY_MS) lastReadings.delete(id);
  const out = [];
  for (const m of monitors) {
    if (m.aqi != null && Number.isFinite(m.at)) {
      lastReadings.set(m.id, { aqi: m.aqi, pm25: m.pm25, category: m.category, at: m.at });
      out.push(m);
    } else if (lastReadings.has(m.id)) {
      out.push({ ...m, ...lastReadings.get(m.id), carried: true });
    }
  }
  return out;
};

const fetchAirNow = async () => {
  const [rawContours, rawMonitors] = await Promise.all([
    queryAllGeoJson(CONTOURS_URL, {
      where: '1=1',
      outFields: 'gridcode,Timestamp',
      returnGeometry: 'true',
      maxAllowableOffset: '0.005',
      geometryPrecision: '4',
    }, 'AirNow contours'),
    queryAllGeoJson(MONITORS_URL, {
      where: '1=1',
      outFields: 'AQSID,SiteName,DataSource,PM25,PM25_AQI,ValidTime,Status',
      returnGeometry: 'true',
      geometryPrecision: '4',
    }, 'AirNow monitors'),
  ]);
  const contours = rawContours.map(normalizeContour).filter(Boolean);
  const monitors = carryForward(rawMonitors.map(normalizeMonitor).filter(Boolean), Date.now());
  // The contours cover most of the lower 48 (mostly "good", with gaps far from
  // any monitor); none at all is an upstream glitch.
  if (!contours.length) throw new Error('AirNow returned no contours nationwide');
  const at = contours.map(c => c.at).filter(Boolean);
  return { contours, monitors, validAt: at.length ? Math.max(...at) : null };
};

const plumeNote = (plumes) => ({
  error: ' Satellite smoke plumes unavailable.',
  partial: ' Some satellite smoke plumes unavailable.',
  pending: ' Satellite smoke plumes still loading.',
}[plumes.status] || '');

/**
 * Satellite plumes are map context: they get a short budget and never hold
 * up (or take down) the measured air quality. A slow NOAA keeps loading in
 * the background and fills the cache for the next check.
 */
const boundedPlumes = (now) => {
  let timer;
  const budget = new Promise(resolve => {
    timer = setTimeout(resolve, PLUME_BUDGET_MS, { status: 'pending', data: { plumes: [] } });
  });
  return Promise.race([loadSmokePlumes({ now }), budget]).finally(() => clearTimeout(timer));
};

const failed = (message, plumes) => ({
  status: 'error',
  fetchedAt: null,
  message: message + plumeNote(plumes),
  attribution: ATTRIBUTION,
  url: SOURCE_URL,
  plumesStatus: plumes.status,
  data: { contours: [], monitors: [], validAt: null, plumes: plumes.data?.plumes || [] },
});

/** Nationwide AirNow contours + monitors (+ NOAA satellite smoke plumes for the map). */
export const loadAir = async ({ now = Date.now() } = {}) => {
  const plumesPromise = boundedPlumes(now);
  let cached;
  try {
    cached = await sourceCache.wrap('airnow:all', { ttlMs: TTL_MS, revalidateMs: REVALIDATE_MS, staleMs: STALE_MS }, fetchAirNow);
  } catch (err) {
    console.error('[airnow] load failed:', err.message);
    return failed('Measured air quality unavailable — smoke at ground level could not be checked.', await plumesPromise);
  }
  const plumes = await plumesPromise;
  const { value, fetchedAt, stale } = cached;
  const newestMonitor = Math.max(0, ...value.monitors.map(m => m.at || 0));
  const validAt = value.validAt || newestMonitor || null;
  const ageMs = validAt ? now - validAt : Infinity;
  const hours = Number.isFinite(ageMs) ? Math.max(1, Math.round(ageMs / 3600000)) : null;
  if (ageMs > READINGS_DEAD_MS) {
    return failed(validAt
      ? `AirNow has not updated in ${hours} h — air at ground level could not be checked.`
      : 'AirNow readings carry no time — air at ground level could not be checked.', plumes);
  }
  // Monitors older than a few hours say nothing about now; a new array keeps the cache untouched.
  const monitors = value.monitors.filter(m => Number.isFinite(m.at) && now - m.at <= READINGS_STALE_MS);
  const old = stale || ageMs > READINGS_STALE_MS;
  return {
    status: old ? 'stale' : 'ok',
    fetchedAt: new Date(fetchedAt).toISOString(),
    validAt: new Date(validAt).toISOString(),
    message: (old
      ? `AirNow's latest readings are from ${hours} h ago — they may not show current smoke.`
      : `Hourly PM2.5 from ${monitors.length} monitors nationwide.`) + plumeNote(plumes),
    attribution: ATTRIBUTION,
    url: SOURCE_URL,
    plumesStatus: plumes.status,
    data: { ...value, monitors, validAt, plumes: plumes.data?.plumes || [] },
  };
};
