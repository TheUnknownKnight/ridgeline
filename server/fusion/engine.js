import { projectOntoRoute, pointAtMile } from '../../shared/geo.js';
import { daylight } from '../../shared/sun.js';
import { SOURCE_KEYS } from '../../shared/levels.js';
import { getRouteModel, forecastSamples } from './route.js';
import { createHitTable, consolidate } from './consolidate.js';
import { buildSummary } from './summary.js';
import { countVertices } from '../lib/spatial.js';
import { loadFire } from '../sources/nifc.js';
import { loadAlerts } from '../sources/nwsAlerts.js';
import { loadAvalanche } from '../sources/avalanche.js';
import { loadWater } from '../sources/nwps.js';
import { inUnitedStatesBbox } from '../sources/usStates.js';
import { loadForecast } from '../sources/nwsForecast.js';
import { loadRecentPrecip } from '../sources/openmeteo.js';
import { loadSmoke } from '../sources/smokeForecast.js';
import { loadAir } from '../sources/airnow.js';
import { loadConditions, detectConditions } from './conditions.js';
import { detectFire } from './detectors/fire.js';
import { detectAlerts } from './detectors/alerts.js';
import { detectAvalanche } from './detectors/avalanche.js';
import { detectWater } from './detectors/water.js';
import { detectWeather } from './detectors/weather.js';
import { detectSmoke } from './detectors/smoke.js';
import { detectAir } from './detectors/air.js';

export const defaultSources = {
  loadFire, loadAlerts, loadAvalanche, loadWater, loadAir, loadForecast, loadRecentPrecip, loadSmoke, loadConditions,
};

// Forecast sampling: dense inside the On-Trail window, capped for long routes in Planning.
const ON_TRAIL_FORECAST_SPACING = 1;
const PLANNING_MIN_SPACING = 2;
const MAX_FORECAST_POINTS = 120;
// NOAA's air-quality grid is ~5 km; CAMS (the fallback) thins itself to its own ~40 km.
const MAX_SMOKE_POINTS = 120;
const MIN_SMOKE_SPACING = 2;
const MAX_OVERLAY_VERTICES = 60000;
const OFFICIAL_SOURCES = ['fire', 'alerts', 'avalanche', 'water', 'air'];

const round2 = (n) => Math.round(n * 100) / 100;

// No single upstream may hold the whole analysis hostage. A loader that
// overruns keeps running in the background (and fills the cache for the next
// request); this analysis reports it as unavailable.
const SOURCE_DEADLINE_MS = 20000;

/** A loader must never take the whole analysis down; a crash or overrun becomes an 'error' source. */
const safeLoad = async (label, fn, ctx, deadlineMs = SOURCE_DEADLINE_MS) => {
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve({
      status: 'error', fetchedAt: null, message: `${label} did not respond in time`, data: null,
    }), deadlineMs);
  });
  try {
    return await Promise.race([fn(ctx), deadline]);
  } catch (err) {
    console.error(`[engine] ${label} loader crashed:`, err);
    return { status: 'error', fetchedAt: null, message: `${label} unavailable`, data: null };
  } finally {
    clearTimeout(timer);
  }
};

const fmtMiles = (m) => (m < 10 ? m.toFixed(1) : String(Math.round(m)));

/** Plain-language notes about what could not be checked, shown with the verdict. */
const buildCaveats = ({ route, outside, avalancheUnchecked, coverage, window, forecastOk, airUnchecked, smokeOk }) => {
  const caveats = [];
  const miles = (set) => [...set].reduce((n, i) => n + (route.chunks[i].end - route.chunks[i].start), 0);
  if (outside.size) {
    caveats.push(`${fmtMiles(miles(outside))} mi of this route is outside US data coverage — fires, alerts, avalanche, rivers and the forecast were not checked there.`);
  }
  if (avalancheUnchecked.size) {
    const centers = [...new Set(coverage.filter(c => c.state !== 'off-season' && c.state !== 'info-only').map(c => c.center))];
    caveats.push(`Avalanche danger isn't rated for ${fmtMiles(miles(avalancheUnchecked))} mi of this route right now${centers.length ? ` — check ${centers.join(', ')}` : ''}.`);
  }
  if (airUnchecked?.size) {
    caveats.push(`Measured air quality isn't available for ${fmtMiles(miles(airUnchecked))} mi of this route (no AirNow monitors close enough)${smokeOk ? ' — the smoke forecast still covers it' : ''}.`);
  }
  if (window && forecastOk) {
    caveats.push(`Forecast hazards were checked for Mi ${fmtMiles(window.start)}–${fmtMiles(window.end)} (your lookahead) over the next 72 hours.`);
  }
  return caveats;
};

const publicSource = (s, extra = {}) => ({
  status: s.status,
  fetchedAt: s.fetchedAt || null,
  message: s.message || '',
  attribution: s.attribution || '',
  url: s.url || null,
  ...extra,
});

const STATE_TEXT = {
  'off-season': 'off-season',
  expired: 'forecast expired, not yet re-issued',
  'no-forecast': 'no current forecast',
  'no-rating': 'no danger rating issued',
  'info-only': 'observations only, no ratings',
};

const avalancheCoverageMessage = (base, coverage) => {
  if (!coverage.length) return base;
  const list = coverage.slice(0, 3).map(c => `${c.zone} (${STATE_TEXT[c.state] || c.state})`).join(', ');
  const more = coverage.length > 3 ? ` +${coverage.length - 3} more` : '';
  return `${base}. Not rated on this route: ${list}${more}`;
};

const capOverlays = (features) => {
  const sorted = [...features].sort((a, b) => (b.properties.level || 0) - (a.properties.level || 0));
  const out = [];
  let vertices = 0;
  let dropped = 0;
  for (const f of sorted) {
    const n = f.geometry.type === 'Point' ? 1
      : countVertices(f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates);
    if (vertices + n > MAX_OVERLAY_VERTICES) { dropped++; continue; }
    vertices += n;
    out.push(f);
  }
  if (dropped) console.warn(`[engine] dropped ${dropped} map overlays over the ${MAX_OVERLAY_VERTICES}-vertex budget`);
  return out;
};

/**
 * Analyze a validated request (see lib/validate.js). Sources are injectable
 * so tests can run the full pipeline offline.
 */
export const analyze = async (request, { sources = defaultSources, now = Date.now(), deadlineMs = SOURCE_DEADLINE_MS } = {}) => {
  const route = await getRouteModel(request);
  const L = route.lengthMiles;

  let position = null;
  let window = null;
  if (request.location) {
    const p = projectOntoRoute(route.coords, route.cum, request.location.lng, request.location.lat, request.location.lastMile ?? null);
    position = {
      mile: round2(p.mile),
      offRouteMiles: round2(p.offRouteMiles),
      lat: request.location.lat,
      lng: request.location.lng,
    };
    window = {
      start: round2(Math.max(0, p.mile - 1)),
      end: round2(Math.min(L, p.mile + request.lookaheadMiles)),
      lookaheadMiles: request.lookaheadMiles,
    };
  }

  const range = window ? { start: window.start, end: window.end } : { start: 0, end: L };
  const span = Math.max(0.01, range.end - range.start);
  const spacing = window ? ON_TRAIL_FORECAST_SPACING : Math.max(PLANNING_MIN_SPACING, L / MAX_FORECAST_POINTS);
  const fSamples = forecastSamples(route, range.start, range.end, Math.min(spacing, span));
  const smokeSpacing = Math.max(MIN_SMOKE_SPACING, span / MAX_SMOKE_POINTS);
  const sSamples = forecastSamples(route, range.start, range.end, Math.min(smokeSpacing, span));

  const ctx = { route, now };
  const [fire, alerts, avalanche, water, air, forecast, recentPrecip, smoke, conditions] = await Promise.all([
    safeLoad('Wildfire', sources.loadFire, ctx, deadlineMs),
    safeLoad('NWS alerts', sources.loadAlerts, ctx, deadlineMs),
    safeLoad('Avalanche', sources.loadAvalanche, ctx, deadlineMs),
    safeLoad('River gauges', sources.loadWater, ctx, deadlineMs),
    safeLoad('Air quality', sources.loadAir, ctx, deadlineMs),
    safeLoad('Forecast', sources.loadForecast, { ...ctx, samples: fSamples }, deadlineMs),
    safeLoad('Recent rainfall', sources.loadRecentPrecip, { ...ctx, samples: fSamples }, deadlineMs),
    safeLoad('Smoke forecast', sources.loadSmoke, { ...ctx, samples: sSamples }, deadlineMs),
    safeLoad('Trail conditions', sources.loadConditions, { ...ctx, range }, deadlineMs),
  ]);

  // The NWS forecast names the route's zone; without it (outage, abroad) the conditions loader looked one up.
  const timeZone = forecast.data?.points?.find(p => p.timeZone)?.timeZone || conditions.data?.timeZone || undefined;
  const opts = { now, timeZone };
  const results = {
    fire: detectFire(route, fire.data, opts),
    alerts: detectAlerts(route, alerts.data, opts),
    avalanche: detectAvalanche(route, avalanche.data, opts),
    water: detectWater(route, water.data, opts),
    air: detectAir(route, air.data, opts),
    forecast: detectWeather(route, forecast.data, recentPrecip.status === 'error' ? null : recentPrecip.data, {
      ...opts, range, maxGapMiles: spacing / 2 + 0.75,
    }),
    smoke: detectSmoke(route, smoke.data, { ...opts, range, maxGapMiles: smokeSpacing / 2 + 0.75 }),
    conditions: detectConditions(route, conditions.data, opts),
  };

  const catalog = new Map();
  const table = createHitTable(route.chunks.length);
  for (const r of Object.values(results)) {
    for (const h of r.hazards) catalog.set(h.id, h);
    for (const hit of r.hits) table.add(hit);
  }

  // US-only sources say nothing about stretches outside the US.
  const outside = new Set(results.forecast.uncoveredChunks);
  for (const chunk of route.chunks) {
    if (chunk.samplesCoarse.every(s => !inUnitedStatesBbox(s.lon, s.lat))) outside.add(chunk.i);
  }

  const sourceState = { fire, alerts, avalanche, water, air, forecast, smoke, conditions };
  const officialChecked = OFFICIAL_SOURCES.filter(k => sourceState[k].status !== 'error');
  const forecastOk = forecast.status !== 'error';
  const smokeOk = smoke.status !== 'error';
  const conditionsOk = conditions.status !== 'error';
  const checkedFor = (i) => {
    const smokeChecked = smokeOk && results.smoke.checkedChunks.has(i);
    // The conditions model runs anywhere it has weather (terrain and snow inputs are US-only, so it is less sure abroad).
    const conditionsChecked = conditionsOk && results.conditions.checkedChunks.has(i);
    // AirNow reaches into Canada and Mexico where its contours do; nothing else US-only does.
    const airChecked = officialChecked.includes('air') && results.air.checkedChunks.has(i);
    if (outside.has(i)) return [...(airChecked ? ['air'] : []), ...(smokeChecked ? ['smoke'] : []), ...(conditionsChecked ? ['conditions'] : [])];
    const list = officialChecked.filter(k => (k !== 'avalanche' || !results.avalanche.uncheckedChunks.has(i))
      && (k !== 'air' || airChecked));
    if (forecastOk && results.forecast.checkedChunks.has(i)) list.push('forecast');
    if (smokeChecked) list.push('smoke');
    if (conditionsChecked) list.push('conditions');
    return list;
  };

  const { segments, hazards } = consolidate(route.chunks, table, checkedFor, catalog);

  const precipNote = recentPrecip.status === 'error' ? '. Recent rainfall unavailable, so rain totals are forecast only' : '';
  const sourcesOut = {
    fire: publicSource(fire),
    alerts: publicSource(alerts),
    avalanche: publicSource(avalanche, { coverage: results.avalanche.coverage }),
    water: publicSource(water),
    air: publicSource(air, { nearestMonitor: results.air.nearestMonitor, validAt: air.validAt ?? null, plumesStatus: air.plumesStatus ?? 'error' }),
    forecast: publicSource(forecast, {
      sampledEveryMiles: round2(spacing),
      range: [round2(range.start), round2(range.end)],
      horizonHours: 72,
    }),
    smoke: publicSource(smoke, { sampledEveryMiles: round2(smokeSpacing) }),
    conditions: publicSource(conditions, { range: [round2(range.start), round2(range.end)] }),
  };
  sourcesOut.avalanche.message = avalancheCoverageMessage(sourcesOut.avalanche.message, results.avalanche.coverage);
  sourcesOut.forecast.message += precipNote;
  for (const k of SOURCE_KEYS) if (!sourcesOut[k]) sourcesOut[k] = { status: 'skipped', fetchedAt: null, message: '', attribution: '', url: null };

  const overlays = capOverlays(Object.values(results).flatMap(r => r.overlays || []));

  // Daylight where the hiker is (On trail) or at the trailhead (Planning).
  const [sunLon, sunLat, sunEle] = position
    ? [position.lng, position.lat, pointAtMile(route.coords, route.cum, position.mile)[2] ?? 0]
    : [route.coords[0][0], route.coords[0][1], route.coords[0][2] ?? 0];
  const sun = daylight(now, sunLon, sunLat, sunEle);
  const isoOrNull = (ms) => (ms == null ? null : new Date(ms).toISOString());

  return {
    version: 2,
    routeHash: route.routeHash,
    generatedAt: new Date(now).toISOString(),
    mode: window ? 'on-trail' : 'planning',
    route: {
      name: request.name || null,
      lengthMiles: round2(L),
      chunkCount: route.chunks.length,
      hasElevation: route.hasElevation,
      timeZone: timeZone || null,
    },
    position,
    window,
    daylight: {
      at: position ? 'position' : 'start',
      isDaylight: sun.isDaylight,
      sunrise: isoOrNull(sun.sunrise),
      sunset: isoOrNull(sun.sunset),
      civilDusk: isoOrNull(sun.civilDusk),
    },
    sources: sourcesOut,
    summary: buildSummary({
      hazards,
      segments,
      sources: sourcesOut,
      position,
      outsideCoverage: outside.size > 0,
      caveats: buildCaveats({
        route,
        outside,
        avalancheUnchecked: new Set([...results.avalanche.uncheckedChunks].filter(i => !outside.has(i))),
        coverage: results.avalanche.coverage,
        window,
        forecastOk,
        // A failed AirNow is already listed as incomplete; this is about coverage gaps.
        airUnchecked: air.status === 'error' ? null
          : new Set(route.chunks.map(c => c.i).filter(i => !results.air.checkedChunks.has(i))),
        smokeOk,
      }),
    }),
    segments,
    hazards,
    conditions: results.conditions.block,
    overlays: { type: 'FeatureCollection', features: overlays },
  };
};
