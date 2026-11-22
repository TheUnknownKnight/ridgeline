import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFire, perimeterLevel, incidentLevel, isFireEnded, isMopUpPerimeter } from '../server/fusion/detectors/fire.js';
import { detectAlerts, alertLevel } from '../server/fusion/detectors/alerts.js';
import { isTrailAlert } from '../server/sources/nwsAlerts.js';
import { detectAvalanche } from '../server/fusion/detectors/avalanche.js';
import { detectWater } from '../server/fusion/detectors/water.js';
import { isStreamGauge } from '../server/sources/nwps.js';
import { summarizePoint, detectWeather } from '../server/fusion/detectors/weather.js';
import { past48hMm } from '../server/sources/weatherHistory.js';
import { zoneState } from '../server/sources/avalanche.js';
import { parseValidTime, parseGrid } from '../server/sources/nwsForecast.js';
import { regionOf, mapLcms, horizonAngleDeg } from '../server/sources/terrain.js';
import { sampleTileSwe } from '../server/sources/snodas.js';
import { buildRoute, boxPolygon, firePerimeter, prepared, LON, LAT0, dLat, dLon } from './helpers.js';

const chunksHit = (hits, id) => [...new Set(hits.filter(h => h.id === id).map(h => h.chunk))].sort((a, b) => a - b);
const levelAt = (hits, id, chunk) => Math.max(0, ...hits.filter(h => h.id === id && h.chunk === chunk).map(h => h.level));

test('fire: a short crossing between old midpoint samples is caught', async () => {
  const route = await buildRoute(10);
  // 0.23 mi of trail inside the perimeter, nowhere near a chunk midpoint (x.5).
  const fire = firePerimeter(boxPolygon(3.02, 3.25));
  const { hits, hazards } = detectFire(route, { perimeters: [fire], incidents: [] });
  assert.equal(levelAt(hits, 'fire:{TEST-FIRE}', 3), 4);
  const hit = hits.find(h => h.chunk === 3 && h.level === 4);
  assert.equal(hit.note, 'trail crosses perimeter');
  assert.equal(hazards[0].kind, 'fire-perimeter');
  assert.match(hazards[0].detail, /10% contained/);
});

test('fire: proximity grades by distance; 0% contained is shown as 0%', async () => {
  const route = await buildRoute(10);
  const fire = firePerimeter(boxPolygon(4, 5, { offsetMiles: 0.85, widthMiles: 0.5 }), { percentContained: 0 }); // edge 0.6 mi east
  const { hits, hazards } = detectFire(route, { perimeters: [fire], incidents: [] });
  assert.equal(levelAt(hits, 'fire:{TEST-FIRE}', 4), 3, 'within 1 mi -> high');
  assert.equal(levelAt(hits, 'fire:{TEST-FIRE}', 7), 2, 'within 5 mi -> moderate');
  assert.match(hazards[0].detail, /0% contained/);
});

test('fire: perimeter level rules', () => {
  const wf = { category: 'WF', percentContained: 20 };
  assert.equal(perimeterLevel(wf, 0), 4);
  assert.equal(perimeterLevel(wf, 0.8), 3);
  assert.equal(perimeterLevel(wf, 4), 2);
  assert.equal(perimeterLevel(wf, 6), 0);
  assert.equal(perimeterLevel({ category: 'WF', percentContained: 100 }, 0), 0, '100% contained fire has ended');
  assert.equal(perimeterLevel({ category: 'WF', percentContained: 100 }, 3), 0);
  assert.equal(perimeterLevel({ category: 'RX', percentContained: null }, 0), 3);
  assert.equal(perimeterLevel({ category: 'WF', percentContained: null }, 0), 4, 'unknown containment is not contained');
});

test('fire: ended fires (100% contained, out, controlled, Final 209, stale unmapped) are hidden, while active campaign fires are never cut off', async () => {
  const DAY = 86400000;
  const now = Date.now();
  const route = await buildRoute(10);

  // Ended signals:
  assert.equal(isFireEnded({ category: 'WF', percentContained: 100 }, now, { isPerimeter: true }), true);
  assert.equal(isFireEnded({ category: 'WF', percentContained: 40, outAt: now - 1000 }, now, { isPerimeter: true }), true);
  assert.equal(isFireEnded({ category: 'WF', percentContained: 80, controlledAt: now - 1000 }, now, { isPerimeter: true }), true);
  assert.equal(isFireEnded({ category: 'WF', percentContained: 95, containedAt: now - 1000 }, now, { isPerimeter: true }), true);
  assert.equal(isFireEnded({ category: 'WF', percentContained: 90, icsStatus: 'F' }, now, { isPerimeter: true }), true);

  // Old unmapped dispatches with no ICS-209 (even if IRWIN batch sync touched updatedAt today):
  const staleSpot = { category: 'WF', acres: 0.2, discoveredAt: now - 12 * DAY, updatedAt: now - 1000, percentContained: null };
  assert.equal(isFireEnded(staleSpot, now, { isPerimeter: false }), true);
  assert.equal(incidentLevel(staleSpot, 0.2, now), 0);

  const staleUnmapped = { category: 'WF', acres: 120, discoveredAt: now - 45 * DAY, updatedAt: now - 1000, percentContained: null };
  assert.equal(isFireEnded(staleUnmapped, now, { isPerimeter: false }), true);

  // Safety checks: active multi-month campaign fires must NEVER be cut off!
  const longCampaignPerim = firePerimeter(boxPolygon(2, 3), {
    key: '{CAMPAIGN-PERIM}',
    name: 'Sisi',
    discoveredAt: now - 115 * DAY,
    perimeterAsOf: now - 35 * DAY,
    updatedAt: now - 2 * DAY,
    percentContained: 65,
    icsStatus: 'U',
    icsAt: now - 3 * DAY,
  });
  assert.equal(isFireEnded(longCampaignPerim, now, { isPerimeter: true }), false);
  assert.equal(perimeterLevel(longCampaignPerim, 0, now), 4);

  // Even without an ICS-209 field, a mapped perimeter with 0 < pct < 100 is kept active:
  const partialPerimNoIcs = firePerimeter(boxPolygon(5, 6), {
    key: '{PARTIAL-PERIM}',
    name: 'Autumn',
    discoveredAt: now - 90 * DAY,
    perimeterAsOf: now - 40 * DAY,
    percentContained: 92,
    icsStatus: null,
  });
  assert.equal(isFireEnded(partialPerimNoIcs, now, { isPerimeter: true }), false);

  // Long-running unmapped incident with an active ICS-209 ('U' or 'I') is kept active:
  const activeIcsIncident = {
    key: '{ACTIVE-ICS}',
    name: 'Bee Haven',
    category: 'WF',
    acres: 2060,
    percentContained: 85,
    discoveredAt: now - 65 * DAY,
    updatedAt: now - 2 * DAY,
    icsStatus: 'U',
    icsAt: now - 5 * DAY,
    lon: LON + dLon(0.5),
    lat: LAT0 + dLat(8),
    hasPerimeter: false,
  };
  assert.equal(isFireEnded(activeIcsIncident, now, { isPerimeter: false }), false);
  assert.ok(incidentLevel(activeIcsIncident, 0.5, now) >= 3);

  const endedPerim = firePerimeter(boxPolygon(1, 2), {
    key: '{ENDED-PERIM}',
    name: 'Old Summer Fire',
    percentContained: 100,
  });
  const { hazards } = detectFire(route, {
    perimeters: [longCampaignPerim, partialPerimNoIcs, endedPerim],
    incidents: [activeIcsIncident, { ...staleUnmapped, key: '{STALE}', lon: LON, lat: LAT0 + dLat(4), hasPerimeter: false }],
  }, { now });
  const ids = hazards.map(h => h.id).sort();
  assert.deepEqual(ids, ['fire:{ACTIVE-ICS}', 'fire:{CAMPAIGN-PERIM}', 'fire:{PARTIAL-PERIM}']);
});

test('fire: incidents without perimeters are flagged; mapped ones are not double counted', async () => {
  const route = await buildRoute(20);
  const base = { category: 'WF', percentContained: 5, updatedAt: Date.now(), discoveredAt: Date.now(), state: 'CA', name: 'Spot' };
  const incidents = [
    { ...base, key: '{BIG}', acres: 3000, lon: LON + dLon(1), lat: LAT0 + dLat(10), hasPerimeter: false },
    { ...base, key: '{MAPPED}', acres: 3000, lon: LON + dLon(1), lat: LAT0 + dLat(10), hasPerimeter: true },
    { ...base, key: '{TINY}', acres: 0.1, lon: LON + dLon(6), lat: LAT0 + dLat(15), hasPerimeter: false },
  ];
  const { hits, hazards } = detectFire(route, { perimeters: [], incidents });
  assert.ok(levelAt(hits, 'fire:{BIG}', 10) >= 3);
  assert.equal(chunksHit(hits, 'fire:{MAPPED}').length, 0);
  assert.equal(chunksHit(hits, 'fire:{TINY}').length, 0, 'a 0.1 acre fire 6 mi away is noise');
  assert.match(hazards.find(h => h.id === 'fire:{BIG}').title, /no mapped perimeter/);
  assert.equal(incidentLevel({ ...base, acres: 0.1 }, 0.5), 2);
});

test('alerts: hit only the chunks inside the alert area, graded by severity', async () => {
  const route = await buildRoute(20);
  const area = prepared(boxPolygon(5.1, 7.9, { widthMiles: 4 }));
  const alert = {
    key: 'vtec:KSTO.FW.W.0001', event: 'Red Flag Warning', severity: 'Severe', summary: 'RED FLAG WARNING IN EFFECT', headline: 'Red Flag Warning issued…',
    onset: Date.now() - 1000, end: Date.now() + 3600000, sent: Date.now(), areas: [area], polygons: [], zones: [],
  };
  const { hits, hazards } = detectAlerts(route, { alerts: [alert] });
  assert.deepEqual(chunksHit(hits, 'alert:vtec:KSTO.FW.W.0001'), [5, 6, 7]);
  assert.equal(hits[0].level, 3);
  assert.match(hazards[0].detail, /^Red flag warning in effect/);
});

test('avalanche: rated zones hit; unrated in-season zones are "not checked", not clear', async () => {
  const route = await buildRoute(10);
  const now = Date.now();
  const base = { center: 'Test AC', centerId: 'TAC', offSeason: false, warning: false, infoOnly: false, timeZone: 'America/Denver', link: 'https://example.org' };
  const rated = { ...prepared(boxPolygon(0, 3.1, { widthMiles: 4 })), ...base, id: 'TAC:1', name: 'North', dangerLevel: 3, endsAt: now + 3600000, startsAt: now - 3600000, travelAdvice: 'Dangerous' };
  const unrated = { ...prepared(boxPolygon(5, 7, { widthMiles: 4 })), ...base, id: 'TAC:2', name: 'South', dangerLevel: -1, endsAt: now + 3600000, startsAt: now - 3600000 };
  const offSeason = { ...prepared(boxPolygon(8, 9.5, { widthMiles: 4 })), ...base, id: 'TAC:3', name: 'East', dangerLevel: -1, offSeason: true, endsAt: null };
  const r = detectAvalanche(route, { zones: [rated, unrated, offSeason] }, { now });
  assert.deepEqual(chunksHit(r.hits, 'avy:TAC:1'), [0, 1, 2, 3]);
  assert.equal(r.hits[0].level, 3);
  assert.ok(r.uncheckedChunks.has(5) && r.uncheckedChunks.has(6));
  assert.ok(!r.uncheckedChunks.has(8), 'off-season is not "unchecked"');
  assert.deepEqual(r.coverage.map(c => c.state).sort(), ['no-rating', 'off-season']);
});

test('avalanche: zone state handles expiry, warnings and info-only centers', () => {
  const now = Date.now();
  assert.equal(zoneState({ dangerLevel: 3, endsAt: now - 1 }, now), 'expired');
  assert.equal(zoneState({ dangerLevel: 2, endsAt: now + 1 }, now), 'rated');
  assert.equal(zoneState({ dangerLevel: -1, warning: true, endsAt: now + 1 }, now), 'rated');
  assert.equal(zoneState({ dangerLevel: -1, offSeason: true }, now), 'off-season');
  assert.equal(zoneState({ dangerLevel: -1, endsAt: null }, now), 'no-forecast');
  assert.equal(zoneState({ dangerLevel: 4, infoOnly: true }, now), 'info-only');
});

test('water: only flooding gauges on the trail count', async () => {
  const route = await buildRoute(10);
  const gauge = (id, offset, mile, category) => ({
    id, name: `Creek ${id}`, lon: LON + dLon(offset), lat: LAT0 + dLat(mile), units: 'ft', stages: { flood: 6 },
    observed: { category, value: 7.1, time: Date.now() - 600000 }, forecast: null,
  });
  const { hits } = detectWater(route, { gauges: [gauge('A', 0.2, 4.3, 'minor'), gauge('B', 2, 6, 'major'), gauge('C', 0.1, 8, 'no_flooding')] });
  assert.deepEqual(hits.map(h => [h.id, h.chunk, h.level]), [['gauge:A', 4, 2]]);
});

test('weather: forecast intervals are clipped to the horizon and prorated', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  assert.deepEqual(parseValidTime('2026-10-17T06:00:00+00:00/PT12H'), [Date.parse('2026-10-17T06:00:00Z'), Date.parse('2026-10-17T18:00:00Z')]);
  const series = (vals) => vals.map(([s, h, v]) => [Date.parse(s), Date.parse(s) + h * 3600000, v]);
  const grid = {
    gridElevationM: 2000,
    series: {
      // 12 mm over 06–18Z: only the 6 h after `now` count -> 6 mm.
      precip: series([['2026-10-17T06:00:00Z', 12, 12], ['2026-10-25T00:00:00Z', 6, 500]]),
      snow: [], gust: series([['2026-10-17T00:00:00Z', 6, 100], ['2026-10-18T00:00:00Z', 1, 80]]),
      temp: series([['2026-10-18T10:00:00Z', 1, -5]]), apparent: [], thunderProb: [], weather: [],
    },
  };
  const s = summarizePoint({ grid, ele: 3000 }, now, { past48hMm: 25.4 });
  assert.ok(Math.abs(s.nextPrecipIn - 6 / 25.4) < 1e-6);
  assert.ok(Math.abs(s.pastPrecipIn - 1) < 1e-6);
  assert.ok(Math.abs(s.gustMph - 80 / 1.609344) < 1e-6, 'gust that ended before now is ignored');
  // 1000 m above the grid cell: 6.5 °C colder.
  assert.ok(Math.abs(s.coldF - ((-5 - 6.5) * 9 / 5 + 32)) < 1e-6);
});

test('weather: estimates are capped below official levels', async () => {
  const route = await buildRoute(5);
  const now = Date.now();
  const grid = { gridElevationM: null, series: { precip: [[now, now + 3600000, 200]], snow: [], gust: [[now, now + 3600000, 150]], temp: [], apparent: [], thunderProb: [], weather: [[now, now + 3600000, 'likely']] } };
  const points = [0, 2.5, 5].map(mile => ({ mile, lon: LON, lat: LAT0 + dLat(mile), ele: null, grid }));
  const r = detectWeather(route, { points }, null, { now, range: { start: 0, end: 5 }, maxGapMiles: 2 });
  assert.ok(r.hits.length > 0);
  assert.ok(r.hits.every(h => h.level <= 2));
  assert.equal(r.checkedChunks.size, 5);
  assert.ok(r.hazards.every(h => h.source === 'ESTIMATED'));
});

test('nwsForecast parseGrid keeps snowLevel in meters (not mm) and parses extended layers', () => {
  const vt = '2026-10-17T12:00:00+00:00/PT6H';
  const g = parseGrid({
    properties: {
      elevation: { value: 1800 },
      snowLevel: { uom: 'wmoUnit:m', values: [{ validTime: vt, value: 2400 }] },
      iceAccumulation: { uom: 'wmoUnit:m', values: [{ validTime: vt, value: 0.005 }] },
      windSpeed: { uom: 'wmoUnit:km_h-1', values: [{ validTime: vt, value: 40 }] },
      windChill: { uom: 'wmoUnit:degC', values: [{ validTime: vt, value: -18 }] },
      dewpoint: { uom: 'wmoUnit:degC', values: [{ validTime: vt, value: -10 }] },
      relativeHumidity: { uom: 'wmoUnit:percent', values: [{ validTime: vt, value: 92 }] },
      skyCover: { uom: 'wmoUnit:percent', values: [{ validTime: vt, value: 80 }] },
      weather: { values: [{ validTime: vt, value: [{ weather: 'freezing_rain', intensity: 'light', coverage: 'likely' }] }] },
    },
  });
  assert.equal(g.series.snowLevel[0][2], 2400);
  assert.equal(g.series.ice[0][2], 5);
  assert.equal(g.series.wind[0][2], 40);
  assert.equal(g.series.windChill[0][2], -18);
  assert.equal(g.series.weatherHazards[0][2].weather, 'freezing_rain');
});

test('terrain helpers: HI/AK/SEAK/CONUS routing, LCMS->NLCD mapping (12=barren, 13=snow), horizon angle', () => {
  assert.equal(regionOf({ lat: 20.7, lon: -156.2 }), 'HI');
  assert.equal(regionOf({ lat: 58.3, lon: -134.4 }), 'AK_SE');
  assert.equal(regionOf({ lat: 63.1, lon: -151.0 }), 'AK');
  assert.equal(regionOf({ lat: 37.7, lon: -119.5 }), 'CONUS');

  assert.equal(mapLcms(12).nlcd, 31, 'LCMS 12 is barren/impervious -> NLCD 31');
  assert.equal(mapLcms(13).nlcd, 12, 'LCMS 13 is snow/ice -> NLCD 12');
  assert.equal(mapLcms(15).nlcd, null);
  assert.ok(horizonAngleDeg(1000, 1500, 1500) > 17);
  assert.equal(horizonAngleDeg(1000, 800, 1500), 0);
});

test('snodas: edge-preserving bilinear SWE blending avoids masking valid snow beside NO_CLASS', () => {
  const legend = [{ lo: 0, hi: 0 }, { lo: 2, hi: 4 }];
  const classes = new Uint8Array(16).fill(255);
  classes[0] = 0;
  classes[1] = 1; // row 0, col 1 -> midpoint 3 in * 25.4 = 76.2 mm
  const tile = { width: 4, height: 4, classes };
  const swe = sampleTileSwe(tile, { lon: 0.25, lat: 0.875 }, 0, 0, legend);
  assert.ok(Math.abs(swe - 38.1) < 1e-6, `expected 38.1 mm, got ${swe}`);
});

test('weather: per-chunk terrain elevation, snowLevel mountain snow, windChill, ice, and trip ETA', async () => {
  const route = await buildRoute(15);
  const now = Date.parse('2026-10-17T12:00:00Z');
  const h = 3600000;
  const grid = {
    gridElevationM: 1500,
    series: {
      // Rain at 1500m, snowLevel 2200m during first 48h, freezing rain later around day 4
      precip: [[now, now + 24 * h, 25]],
      snow: [[now, now + 24 * h, 0]],
      snowLevel: [[now, now + 24 * h, 2200]],
      wind: [[now + 48 * h, now + 96 * h, 35]],
      temp: [[now, now + 24 * h, 2], [now + 48 * h, now + 96 * h, -12]],
      apparent: [], gust: [], thunderProb: [], weather: [],
      ice: [[now + 48 * h, now + 72 * h, 3]], // ~0.12 in glaze on day 3
      weatherHazards: [],
    },
  };
  const points = [0, 7, 15].map(mile => ({ mile, lon: LON, lat: LAT0 + dLat(mile), ele: null, grid }));
  // Chunk 1 climbs to 2500m (above 2200m snowLevel -> ~10 in mountain snow + lapsed cold)
  const terrainPoints = route.chunks.map(c => ({
    mile: (c.start + c.end) / 2, mileFrom: c.start, mileTo: c.end,
    elevM: c.i === 1 ? 2500 : 1500, slopeDeg: 5, surface: 'dirt',
  }));
  const rNow = detectWeather(route, { points }, null, { now, range: { start: 0, end: 15 }, maxGapMiles: 10, terrainPoints });
  assert.ok(rNow.hazards.some(hz => hz.id === 'wx:snow'), 'chunk 1 above snowLevel flags mountain snow');
  assert.ok(rNow.hazards.some(hz => hz.id === 'wx:ice'), 'iceAccumulation flags wx:ice');
  assert.ok(rNow.hits.some(hit => hit.chunk === 1 && hit.id === 'wx:snow'));

  // With 3 mi/day trip starting now, chunk 14 (day 4.6) lies past 96h grid end -> counted in itineraryBeyondForecastMiles
  const rTrip = detectWeather(route, { points }, null, {
    now, range: { start: 0, end: 15 }, maxGapMiles: 10, terrainPoints,
    trip: { startAt: new Date(now).toISOString(), paceMilesPerDay: 3 },
  });
  assert.ok(rTrip.itineraryBeyondForecastMiles >= 2, `expected beyond-horizon miles, got ${rTrip.itineraryBeyondForecastMiles}`);
});

test('alerts: itinerary trip filters expired zones before hiker arrival', async () => {
  const route = await buildRoute(20);
  const now = Date.parse('2026-10-17T12:00:00Z');
  const h = 3600000;
  const area = prepared(boxPolygon(15, 18, { widthMiles: 4 }));
  const shortAlert = {
    key: 'vtec:SHORT.1', event: 'Wind Advisory', severity: 'Moderate',
    onset: now, end: now + 12 * h, sent: now, areas: [area], polygons: [], zones: [],
  };
  // At 5 mi/day, hiker reaches mile 15 on day 3 (72h), after the 12h advisory ended.
  const withoutTrip = detectAlerts(route, { alerts: [shortAlert] }, { now });
  const withTrip = detectAlerts(route, { alerts: [shortAlert] }, { now, trip: { startAt: new Date(now).toISOString(), paceMilesPerDay: 5 } });
  assert.ok(withoutTrip.hits.length > 0);
  assert.equal(withTrip.hits.length, 0);
});

test('water: detects ungauged creek runoff/snowmelt surges outside covered gauges (capped at level 2)', async () => {
  const route = await buildRoute(8);
  const gauges = [{
    id: 'G1', name: 'Gauged Creek', lon: LON, lat: LAT0 + dLat(1.5), units: 'ft',
    observed: { category: 'no_flooding', value: 2.0, time: Date.now() }, forecast: null,
  }];
  const hydrology = [
    { mile: 1.5, mileFrom: 1, mileTo: 2, peakSnowmelt24hMm: 50, peakRunoff48hMm: 60 }, // gauged chunk 1 -> skipped!
    { mile: 5.5, mileFrom: 5, mileTo: 6, peakSnowmelt24hMm: 45, peakRunoff48hMm: 62 }, // ungauged chunk 5 -> flagged!
  ];
  const r = detectWater(route, { gauges }, { hydrology });
  assert.deepEqual(chunksHit(r.hits, 'water:runoff'), [5]);
  assert.equal(r.hits[0].level, 2);
  assert.equal(r.hazards[0].source, 'ESTIMATED');
});

test('avalanche: attaches conservative terrainContext while keeping official rating', async () => {
  const route = await buildRoute(5);
  const now = Date.now();
  const rated = {
    ...prepared(boxPolygon(1, 3.2, { widthMiles: 4 })),
    id: 'TAC:9', name: 'Ridge', center: 'Test AC', centerId: 'TAC', offSeason: false,
    warning: false, infoOnly: false, dangerLevel: 2, startsAt: now - 3600000, endsAt: now + 3600000,
    timeZone: 'America/Denver', link: 'https://example.org',
  };
  const terrainPoints = [
    { mile: 1.5, mileFrom: 1, mileTo: 2, elevM: 3000, slopeDeg: 34 },
    { mile: 2.5, mileFrom: 2, mileTo: 3, elevM: 3200, slopeDeg: 38 },
  ];
  const r = detectAvalanche(route, { zones: [rated] }, { now, terrainPoints });
  assert.equal(r.hits[0].level, 2);
  assert.equal(r.hazards[0].terrainContext.steepMiles, 2);
  assert.equal(r.hazards[0].terrainContext.maxSlopeDeg, 38);
  assert.match(r.hazards[0].detail, />=25 deg slope/);
});


test('alerts: emits only hit areas, deduplicates shared zones by severity, and smooths jagged display rings', async () => {
  const route = await buildRoute(20);
  const now = Date.now();
  const ring = [];
  for (let i = 0; i <= 40; i++) ring.push([LON - dLon(3) + (i % 2 ? dLon(0.08) : 0), LAT0 + dLat(2 + i * 0.25)]);
  for (let i = 40; i >= 0; i--) ring.push([LON + dLon(3) + (i % 2 ? dLon(0.08) : 0), LAT0 + dLat(2 + i * 0.25)]);
  ring.push(ring[0]);
  const hitZone = { ...prepared({ type: 'Polygon', coordinates: [ring] }), key: 'forecast/CAZ069', name: 'Sierra' };
  const offRouteZone = { ...prepared(boxPolygon(5, 8, { offsetMiles: 25, widthMiles: 4 })), key: 'forecast/CAZ019', name: 'Valley' };
  const advisory = {
    key: 'vtec:KSTO.WI.Y.0001', event: 'Wind Advisory', severity: 'Minor',
    onset: now - 1000, end: now + 3600000, sent: now, areas: [hitZone, offRouteZone], polygons: [], zones: [],
  };
  const warning = {
    key: 'vtec:KSTO.WS.W.0002', event: 'Winter Storm Warning', severity: 'Severe',
    onset: now - 1000, end: now + 3600000, sent: now, areas: [hitZone], polygons: [], zones: [],
  };
  const { overlays } = detectAlerts(route, { alerts: [advisory, warning] }, { now });
  assert.equal(overlays.length, 2, 'off-route zone is omitted while both alerts on the hit zone remain clickable');
  const advOverlay = overlays.find(o => o.properties.hazardId === 'alert:vtec:KSTO.WI.Y.0001');
  const warnOverlay = overlays.find(o => o.properties.hazardId === 'alert:vtec:KSTO.WS.W.0002');
  assert.equal(warnOverlay.properties.primary, true, 'higher-severity alert draws ambient fill/border');
  assert.equal(advOverlay.properties.primary, false, 'lower-severity alert on same zone stays clickable without double-drawing');
  assert.ok(warnOverlay.geometry.coordinates[0].length < ring.length / 2, 'display outline simplifies jagged micro-zigzags');
});

test('fire: sub-acre CAD spot dispatches and off-trail slash-pile burns stay quiet; static >=90% burn scars downgrade to mop-up', async () => {
  const DAY = 86400000;
  const now = Date.now();
  // 0.01-acre LA County CAD spot ticket 1.6 mi off-trail is noise; right on-trail still warns.
  const cadSpot = { category: 'WF', name: 'Lac-421650', acres: 0.01, percentContained: null, discoveredAt: now - 3600000, updatedAt: now };
  assert.equal(incidentLevel(cadSpot, 1.6, now), 0);
  assert.equal(incidentLevel(cadSpot, 0.4, now), 2);

  // Truly unsized fire older than 24 h drops to spot reach instead of mid-size wildfire.
  const staleUnsized = { category: 'WF', name: 'Old CAD', acres: null, percentContained: null, discoveredAt: now - 36 * 3600000, updatedAt: now };
  assert.equal(incidentLevel(staleUnsized, 3.0, now), 0);

  // Administrative slash-pile burns stay quiet beyond ~1.25 mi and cap at Low unless directly on trail.
  const pileBurn = { category: 'RX', name: 'Admin Station Piles (Drd) RX', acres: null, percentContained: null, discoveredAt: now - 2 * DAY, updatedAt: now };
  assert.equal(incidentLevel(pileBurn, 2.0, now), 0);
  assert.equal(incidentLevel(pileBurn, 0.7, now), 1);
  assert.equal(incidentLevel(pileBurn, 0.1, now), 2);

  // 95% contained perimeter untouched for 60 days with Minimal behavior is mop-up/burn-scar, not active L3/L4 wildfire.
  const mopUp = firePerimeter(boxPolygon(3, 4), {
    key: '{MOPUP}', name: 'Three Queens', percentContained: 95,
    discoveredAt: now - 120 * DAY, perimeterAsOf: now - 60 * DAY, behavior: 'Minimal',
  });
  assert.equal(isMopUpPerimeter(mopUp, now), true);
  assert.equal(perimeterLevel(mopUp, 2.0, now), 0, '2 mi off-trail mop-up is not a hazard');
  assert.equal(perimeterLevel(mopUp, 0.7, now), 1, 'within 1 mi is low caution');
  assert.equal(perimeterLevel(mopUp, 0, now), 2, 'crossing burn scar is moderate caution');
  const route = await buildRoute(8);
  const { hazards } = detectFire(route, { perimeters: [mopUp], incidents: [] }, { now });
  assert.match(hazards[0].title, /^Burned area: Three Queens/);

  // Active behavior on a high-containment perimeter still keeps full active wildfire grading.
  const rekindled = { ...mopUp, behavior: 'Active' };
  assert.equal(isMopUpPerimeter(rekindled, now), false);
  assert.equal(perimeterLevel(rekindled, 0, now), 4);
  assert.equal(perimeterLevel(rekindled, 0.7, now), 3);
});

test('alerts: marine/non-trail and past/unlikely alerts are dropped; watches cap below warnings and statements stay low', async () => {
  assert.equal(isTrailAlert('Small Craft Advisory'), false);
  assert.equal(isTrailAlert('Gale Warning'), false);
  assert.equal(isTrailAlert('Storm Warning'), false);
  assert.equal(isTrailAlert('Rip Current Statement'), false);
  assert.equal(isTrailAlert('911 Telephone Outage'), false);
  assert.equal(isTrailAlert('Hydrologic Outlook'), false);
  assert.equal(isTrailAlert('Winter Storm Warning'), true);
  assert.equal(isTrailAlert('Severe Thunderstorm Warning'), true);
  assert.equal(isTrailAlert('Coastal Flood Warning'), true);
  assert.equal(isTrailAlert('Red Flag Warning'), true);

  assert.equal(alertLevel({ event: 'High Wind Watch', severity: 'Severe', certainty: 'Possible' }), 2);
  assert.equal(alertLevel({ event: 'High Wind Warning', severity: 'Severe', certainty: 'Likely' }), 3);
  assert.equal(alertLevel({ event: 'Special Weather Statement', severity: 'Moderate', certainty: 'Observed' }), 1);
  assert.equal(alertLevel({ event: 'Wind Advisory', severity: 'Moderate', urgency: 'Past' }), 0);
  assert.equal(alertLevel({ event: 'Flood Warning', severity: 'Severe', certainty: 'Unlikely' }), 0);

  const route = await buildRoute(10);
  const now = Date.now();
  const area = prepared(boxPolygon(2, 6, { widthMiles: 4 }));
  const gale = { key: 'vtec:MARINE.1', event: 'Gale Warning', severity: 'Moderate', onset: now, end: now + 3600000, sent: now, areas: [area] };
  assert.equal(detectAlerts(route, { alerts: [gale] }, { now }).hazards.length, 0);
});

test('water: ocean/tide/pool gauges are rejected and forecast floods past 72 h do not false-alarm', async () => {
  assert.equal(isStreamGauge({ pedts: 'HMIFE', waterbody: 'Atlantic Coast', location: 'Atlantic City (IN MLLW)' }), false);
  assert.equal(isStreamGauge({ pedts: 'HCIRP', waterbody: 'Bokeelia Back Bay (In MHHW)' }), false);
  assert.equal(isStreamGauge({ pedts: 'HPIRG', waterbody: 'Lake Mead' }), false);
  assert.equal(isStreamGauge({ pedts: 'HGIRG', waterbody: 'Tide Gauge' }), false);
  assert.equal(isStreamGauge({ pedts: 'HGIRG', waterbody: 'Merced River', location: 'Happy Isles' }), true);

  const route = await buildRoute(10);
  const now = Date.parse('2026-11-22T00:00:00Z');
  const farForecast = {
    id: 'FAR1', name: 'Distant Crest Creek', lon: LON, lat: LAT0 + dLat(3), units: 'ft',
    observed: null,
    forecast: { category: 'moderate', value: 12, time: now + 110 * 3600000 },
  };
  const nearForecast = {
    id: 'NEAR1', name: 'Soon Crest Creek', lon: LON, lat: LAT0 + dLat(6), units: 'ft',
    observed: null,
    forecast: { category: 'minor', value: 9, time: now + 24 * 3600000 },
  };
  const r = detectWater(route, { gauges: [farForecast, nearForecast] }, { now });
  assert.deepEqual(r.hazards.map(h => h.id), ['gauge:NEAR1']);
});

test('weather: freezing snowstorms exclude snow from rain totals, snowLevel integrates sub-intervals, and 10% thunder noise stays quiet', () => {
  const now = Date.parse('2026-11-22T00:00:00Z');
  const h = 3600000;
  // Sub-freezing snowstorm: 30 mm QPF at -6 C should be snow, NOT "Heavy rain / mud".
  const blizzard = {
    gridElevationM: 2500,
    series: {
      precip: [[now, now + 12 * h, 30]],
      snow: [[now, now + 12 * h, 300]],
      temp: [[now, now + 12 * h, -6]],
      thunderProb: [[now, now + 6 * h, 12]],
      gust: [], apparent: [], weather: [], ice: [], weatherHazards: [], snowLevel: [],
    },
  };
  const sBlizz = summarizePoint({ grid: blizzard, ele: 2500 }, now, null);
  assert.equal(sBlizz.nextPrecipIn, 0, 'sub-freezing QPF must not count as rain');
  assert.ok(sBlizz.snowIn > 10);
  assert.equal(sBlizz.thunderLevel, 0, '12% thunder prob is below the 15% slight-chance floor');

  // Past 48 h rain analysis excludes hours <= 0 C (snow) and counts warm hours (rain).
  const cell = {
    elevation: 2000,
    time: [now - 10 * h, now - 5 * h],
    Ta: [-5, 6],
    P: [20, 10],
  };
  assert.equal(past48hMm(cell, now), 10);

  // Cold-front snowLevel dropping only in the last 1 h of a 6 h 24 mm QPF block (trail 2000 m):
  // 5 h at snowLevel 3000 m (rain) + 1 h at 1500 m (snow) => 4 mm SWE = ~40 mm (~1.6 in) snow, NOT 240 mm (~9.5 in).
  const coldFront = {
    gridElevationM: 2000,
    series: {
      precip: [[now, now + 6 * h, 24]],
      snow: [[now, now + 6 * h, 0]],
      snowLevel: [[now, now + 5 * h, 3000], [now + 5 * h, now + 6 * h, 1500]],
      temp: [], gust: [], apparent: [], thunderProb: [], weather: [], ice: [], weatherHazards: [],
    },
  };
  const sFront = summarizePoint({ grid: coldFront, ele: 2000 }, now, null);
  assert.ok(sFront.snowIn > 1.3 && sFront.snowIn < 1.9, `expected ~1.6 in snow from 1/6 cold-front overlap, got ${sFront.snowIn}`);
  assert.ok(sFront.nextPrecipIn > 0.7 && sFront.nextPrecipIn < 0.9, `expected ~0.79 in rain from 5/6 warm overlap, got ${sFront.nextPrecipIn}`);
});

test('avalanche: off-season zones with leftover dangerLevel and stale undated zones are not rated active', () => {
  const now = Date.now();
  assert.equal(zoneState({ dangerLevel: 2, offSeason: true, warning: false }, now), 'off-season');
  assert.equal(zoneState({ dangerLevel: 3, offSeason: false, startsAt: now - 72 * 3600000, endsAt: null }, now), 'expired');
  assert.equal(zoneState({ dangerLevel: -1, offSeason: true, warning: true }, now), 'rated');
});
