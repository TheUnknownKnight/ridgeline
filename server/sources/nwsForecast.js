import { sourceCache } from '../lib/cache.js';
import { fetchJson, HttpError } from '../lib/http.js';
import { mapLimit } from '../lib/pool.js';

export const ATTRIBUTION = 'NWS gridded forecast';
export const SOURCE_URL = 'https://www.weather.gov/';

const POINT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // lat/lon -> grid cell is essentially static
const POINT_MISS_TTL_MS = 24 * 60 * 60 * 1000; // outside NWS coverage (e.g. Canada)
const GRID_TTL_MS = 60 * 60 * 1000;
const GRID_REVALIDATE_MS = 60 * 60 * 1000;
const GRID_STALE_MS = 6 * 60 * 60 * 1000;
const ERROR_TTL_MS = 15 * 1000;
const SNAP_DEG = 0.02; // ~2 km; NWS cells are 2.5 km, so snapping loses nothing
const SOFT_BUDGET_MS = 16500;

const LAYERS = {
  quantitativePrecipitation: 'precip',
  snowfallAmount: 'snow',
  iceAccumulation: 'ice',
  windGust: 'gust',
  windSpeed: 'wind',
  temperature: 'temp',
  apparentTemperature: 'apparent',
  windChill: 'windChill',
  dewpoint: 'dewpoint',
  relativeHumidity: 'rh',
  skyCover: 'skyCover',
  snowLevel: 'snowLevel',
  probabilityOfThunder: 'thunderProb',
  weather: 'weather',
};

const WEATHER_HAZARD_TYPES = new Set([
  'freezing_rain',
  'freezing_drizzle',
  'sleet',
  'ice_pellets',
  'blowing_snow',
  'fog',
  'freezing_fog',
  'thunderstorms',
]);

const DUR_RE = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/;

/** "2026-10-17T13:00:00+00:00/PT6H" -> [startMs, endMs] */
export const parseValidTime = (vt) => {
  const [startIso, dur] = String(vt || '').split('/');
  const start = Date.parse(startIso);
  const m = DUR_RE.exec(dur || '');
  if (!Number.isFinite(start) || !m) return null;
  const hours = (Number(m[1] || 0) * 24) + Number(m[2] || 0) + Number(m[3] || 0) / 60;
  return [start, start + hours * 3600000];
};

const toCanonical = (value, uom, key) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const u = String(uom || '');
  // snowLevel is altitude above sea level (m), never a depth to multiply by 1000.
  if (key === 'snowLevel') return u.endsWith('ft') ? value * 0.3048 : value;
  if (u.endsWith('degF')) return (value - 32) * 5 / 9; // -> °C
  if (u.endsWith('m_s-1')) return value * 3.6;          // -> km/h
  if (u.endsWith(':m') && !u.endsWith('mm')) return value * 1000; // m -> mm (precip/snow/ice)
  if (u.endsWith(':cm')) return value * 10;             // cm -> mm
  return value;
};

/** Parse an NWS gridpoint JSON response into canonical metric time series. */
export const parseGrid = (data) => {
  const p = data?.properties;
  if (!p) throw new Error('NWS gridpoint response missing properties');
  const series = {};
  for (const [layer, key] of Object.entries(LAYERS)) {
    const values = p[layer]?.values || [];
    const uom = p[layer]?.uom;
    const out = [];
    for (const v of values) {
      const span = parseValidTime(v.validTime);
      if (!span) continue;
      if (key === 'weather') {
        const thunder = (v.value || []).find(w => w && w.weather === 'thunderstorms');
        if (thunder) out.push([span[0], span[1], thunder.coverage || 'chance']);
      } else {
        const val = toCanonical(v.value, uom, key);
        if (val != null) out.push([span[0], span[1], val]);
      }
    }
    series[key] = out;
  }
  const weatherHazards = [];
  for (const v of p.weather?.values || []) {
    const span = parseValidTime(v.validTime);
    if (!span) continue;
    for (const w of v.value || []) {
      if (w && WEATHER_HAZARD_TYPES.has(w.weather)) {
        weatherHazards.push([span[0], span[1], {
          weather: w.weather,
          intensity: w.intensity || null,
          coverage: w.coverage || null,
        }]);
      }
    }
  }
  series.weatherHazards = weatherHazards;
  return {
    gridElevationM: typeof p.elevation?.value === 'number' ? p.elevation.value : null,
    updateTime: p.updateTime || null,
    series,
  };
};

const snap = (v) => (Math.round(v / SNAP_DEG) * SNAP_DEG).toFixed(4);

const fetchPoint = async (coordKey) => {
  const data = await fetchJson(`https://api.weather.gov/points/${coordKey}`, {
    label: 'NWS points', timeoutMs: 6000, retries: 1, headers: { Accept: 'application/geo+json' },
  });
  const props = data?.properties || {};
  if (!props.forecastGridData) throw new Error('NWS /points returned no forecastGridData');
  return { gridKey: `${props.gridId}/${props.gridX},${props.gridY}`, gridUrl: props.forecastGridData, timeZone: props.timeZone || null };
};

const is404 = (err) => err instanceof HttpError && err.status === 404;

const lookupPoint = async (lat, lon) => {
  const key = `${snap(lat)},${snap(lon)}`;
  const cacheKey = `nws:point:${key}`;
  try {
    return (await sourceCache.wrap(cacheKey, { ttlMs: POINT_TTL_MS, errorTtlMs: ERROR_TTL_MS }, () => fetchPoint(key))).value;
  } catch (err) {
    if (!is404(err)) throw err;
  }
  // Snapping can push a point across a border or coastline (e.g. the PCT's
  // southern terminus); retry the exact position before giving up.
  try {
    const exact = await fetchPoint(`${lat.toFixed(4)},${lon.toFixed(4)}`);
    sourceCache.set(cacheKey, exact, { ttlMs: POINT_TTL_MS });
    return exact;
  } catch (err) {
    // 404 = outside NWS coverage; remember that for a day so we stop asking.
    if (is404(err)) {
      sourceCache.set(cacheKey, null, { ttlMs: POINT_MISS_TTL_MS });
      return null;
    }
    throw err;
  }
};

const loadGrid = (point) => sourceCache.wrap(
  `nws:grid:${point.gridKey}`,
  { ttlMs: GRID_TTL_MS, revalidateMs: GRID_REVALIDATE_MS, staleMs: GRID_STALE_MS, errorTtlMs: ERROR_TTL_MS },
  async () => parseGrid(await fetchJson(point.gridUrl, { label: 'NWS gridpoints', timeoutMs: 8000, retries: 1 })));

/**
 * NWS gridded forecast for each sample point. Points outside NWS coverage
 * come back with grid: null and are reported, not treated as clear.
 */
export const loadForecast = async ({ samples }) => {
  if (!samples?.length) {
    return { status: 'skipped', fetchedAt: null, message: 'No forecast points requested', attribution: ATTRIBUTION, url: SOURCE_URL, data: { points: [] } };
  }

  const deadlineAt = Date.now() + SOFT_BUDGET_MS;
  const cached = (lat, lon) => sourceCache.get(`nws:point:${snap(lat)},${snap(lon)}`);
  const pointResults = await mapLimit(samples, 12, (s) => {
    const hit = cached(s.lat, s.lon);
    return hit !== undefined ? hit : lookupPoint(s.lat, s.lon);
  }, { deadlineAt });

  const gridKeys = new Map();
  pointResults.forEach((p) => { if (p && !p.error && !gridKeys.has(p.gridKey)) gridKeys.set(p.gridKey, p); });
  const gridList = [...gridKeys.values()];
  const gridResults = await mapLimit(gridList, 12, loadGrid, { deadlineAt });
  const grids = new Map();
  let stale = false;
  let oldest = null;
  gridResults.forEach((r, i) => {
    if (r.error) return;
    grids.set(gridList[i].gridKey, r.value);
    stale = stale || r.stale;
    if (!oldest || r.fetchedAt < oldest) oldest = r.fetchedAt;
  });

  let failed = 0;
  let uncovered = 0;
  const points = samples.map((s, i) => {
    const p = pointResults[i];
    if (p === null) { uncovered++; return { ...s, grid: null, reason: 'outside NWS coverage' }; }
    if (!p || p.error) { failed++; return { ...s, grid: null, reason: 'lookup failed' }; }
    const grid = grids.get(p.gridKey);
    if (!grid) { failed++; return { ...s, grid: null, reason: 'forecast fetch failed' }; }
    return { ...s, grid, gridKey: p.gridKey, timeZone: p.timeZone };
  });

  let status = stale ? 'stale' : 'ok';
  if (failed === samples.length) status = 'error';
  else if (failed > 0) status = 'partial';

  const parts = [`${samples.length - failed - uncovered}/${samples.length} forecast points from ${grids.size} NWS grid cells`];
  if (uncovered) parts.push(`${uncovered} outside NWS coverage`);
  if (failed) parts.push(`${failed} failed`);

  return {
    status,
    fetchedAt: oldest ? new Date(oldest).toISOString() : null,
    message: status === 'error' ? 'NWS forecast unavailable' : parts.join(', '),
    attribution: ATTRIBUTION,
    url: SOURCE_URL,
    data: { points },
  };
};
