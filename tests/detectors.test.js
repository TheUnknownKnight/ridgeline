import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFire, perimeterLevel, incidentLevel } from '../server/fusion/detectors/fire.js';
import { detectAlerts } from '../server/fusion/detectors/alerts.js';
import { detectAvalanche } from '../server/fusion/detectors/avalanche.js';
import { detectWater } from '../server/fusion/detectors/water.js';
import { summarizePoint, detectWeather } from '../server/fusion/detectors/weather.js';
import { zoneState } from '../server/sources/avalanche.js';
import { parseValidTime } from '../server/sources/nwsForecast.js';
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
  assert.equal(perimeterLevel({ category: 'WF', percentContained: 100 }, 0), 3);
  assert.equal(perimeterLevel({ category: 'WF', percentContained: 100 }, 3), 0);
  assert.equal(perimeterLevel({ category: 'RX', percentContained: null }, 0), 3);
  assert.equal(perimeterLevel({ category: 'WF', percentContained: null }, 0), 4, 'unknown containment is not contained');
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
