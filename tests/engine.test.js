import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, capOverlays } from '../server/fusion/engine.js';
import { validateAnalyzeRequest } from '../server/lib/validate.js';
import { RouteUnknownError } from '../server/fusion/route.js';
import { straightCoords, boxPolygon, firePerimeter, fakeSources, okSource, errorSource, LON, LAT0, dLat } from './helpers.js';

const request = (miles, extra = {}) => validateAnalyzeRequest({ coordinates: straightCoords(miles), ...extra });

test('engine: clear route covers every mile with contiguous segments', async () => {
  const r = await analyze(request(12.4), { sources: fakeSources() });
  assert.equal(r.version, 2);
  assert.equal(r.mode, 'planning');
  assert.equal(r.summary.level, 0);
  assert.equal(r.summary.headline, 'No reported hazards on this route');
  assert.equal(r.segments[0].mileStart, 0);
  assert.equal(r.segments.at(-1).mileEnd, 12.4, 'last partial mile is not rounded up');
  for (let i = 1; i < r.segments.length; i++) assert.equal(r.segments[i].mileStart, r.segments[i - 1].mileEnd);
});

test('engine: a source outage is reported, never shown as clear', async () => {
  const sources = fakeSources({
    loadFire: async () => errorSource({ perimeters: [], incidents: [] }),
    loadAlerts: async () => { throw new Error('boom'); },
  });
  const r = await analyze(request(5), { sources });
  assert.equal(r.sources.fire.status, 'error');
  assert.equal(r.sources.alerts.status, 'error');
  assert.equal(r.summary.incomplete, true);
  assert.deepEqual(r.summary.incompleteSources.sort(), ['alerts', 'fire']);
  assert.notEqual(r.summary.headline, 'No reported hazards on this route');
  for (const s of r.segments) {
    assert.ok(!s.checked.includes('fire') && !s.checked.includes('alerts'), 'segments must not claim fire/alerts were checked');
  }
});

test('engine: fire crossing yields an extreme segment and a ranked headline', async () => {
  const sources = fakeSources({ loadFire: async () => okSource({ perimeters: [firePerimeter(boxPolygon(6.2, 7.4))], incidents: [] }) });
  const r = await analyze(request(15), { sources });
  assert.equal(r.summary.level, 4);
  const hz = r.hazards['fire:{TEST-FIRE}'];
  assert.ok(hz.ranges.length >= 1);
  assert.equal(hz.closest.miles, 0);
  const seg = r.segments.find(s => s.level === 4);
  assert.deepEqual([seg.mileStart, seg.mileEnd], [6, 8]);
  assert.match(r.summary.headline, /Wildfire: Test Fire/);
  assert.equal(r.overlays.features[0].properties.overlay, 'fire-perimeter');
});

test('engine: on-trail window, position and next hazard', async () => {
  const sources = fakeSources({ loadFire: async () => okSource({ perimeters: [firePerimeter(boxPolygon(30, 31))], incidents: [] }) });
  const r = await analyze(request(40, { location: { lat: LAT0 + dLat(10), lng: LON }, lookaheadMiles: 15 }), { sources });
  assert.equal(r.mode, 'on-trail');
  assert.ok(Math.abs(r.position.mile - 10) < 0.05);
  assert.deepEqual([r.window.start, r.window.end], [r.position.mile - 1, r.position.mile + 15].map(v => Math.round(v * 100) / 100));
  // Official hazards beyond the window are still found.
  assert.equal(r.summary.nextHazard.id, 'fire:{TEST-FIRE}');
  assert.ok(r.summary.nextHazard.milesAhead > 10);
  // The forecast was only sampled inside the window.
  assert.deepEqual(r.sources.forecast.range, [r.window.start, r.window.end]);
});

test('engine: routeHash refresh works after an upload, and fails cleanly before', async () => {
  const coords = straightCoords(3.3);
  const first = await analyze(validateAnalyzeRequest({ coordinates: coords }), { sources: fakeSources() });
  const again = await analyze(validateAnalyzeRequest({ routeHash: first.routeHash }), { sources: fakeSources() });
  assert.equal(again.route.lengthMiles, first.route.lengthMiles);
  await assert.rejects(analyze(validateAnalyzeRequest({ routeHash: 'ffffffffffffffff' }), { sources: fakeSources() }), RouteUnknownError);
});

test('engine: consolidation merges only identical hazard sets', async () => {
  const sources = fakeSources({
    loadFire: async () => okSource({ perimeters: [firePerimeter(boxPolygon(2, 6, { offsetMiles: 3, widthMiles: 1 }))], incidents: [] }),
  });
  const r = await analyze(request(10), { sources });
  // Edge is 2.5 mi east: moderate (≤5 mi) along the side, never high.
  const levels = r.segments.map(s => s.level);
  assert.ok(levels.every(l => l <= 2));
  for (let i = 1; i < r.segments.length; i++) {
    const a = r.segments[i - 1], b = r.segments[i];
    const sig = (s) => s.refs.map(x => `${x.id}@${x.level}`).join('|') + s.checked.join(',');
    assert.notEqual(sig(a), sig(b), `adjacent segments ${a.mileStart} and ${b.mileStart} should have merged`);
  }
});

test('engine: capOverlays simplifies huge polygons before dropping features', () => {
  const ring = Array.from({ length: 3000 }, (_, i) => {
    const a = (i / 2999) * Math.PI * 2;
    return [LON + Math.cos(a) * 0.2, LAT0 + Math.sin(a) * 0.2];
  });
  ring.push(ring[0]);
  const big = {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { overlay: 'fire-perimeter', level: 4, title: 'Huge Fire' },
  };
  const { features, stats } = capOverlays([big]);
  assert.equal(features.length, 1);
  assert.equal(stats.dropped, 0);
  assert.equal(stats.simplified, 1);
  assert.ok(stats.vertices < 1500, `expected <1500 simplified vertices, got ${stats.vertices}`);
  const outRing = features[0].geometry.coordinates[0];
  assert.deepEqual(outRing[0], outRing[outRing.length - 1]);
});

test('engine: exposes trip beyond-horizon caveat, landfire elevation fallback, and structured diagnostics', async () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const h = 3600000;
  const grid = {
    gridElevationM: 2000,
    series: {
      precip: [[now, now + 24 * h, 5]],
      snow: [], gust: [], wind: [], temp: [[now, now + 24 * h, 5]], apparent: [], thunderProb: [], weather: [], ice: [],
    },
  };
  const sources = fakeSources({
    loadForecast: async ({ samples }) => okSource({
      points: samples.map(s => ({ ...s, grid, gridKey: 'TEST/1,1', timeZone: 'America/Los_Angeles' })),
    }),
    loadConditions: async ({ route, range }) => {
      const pts = [0.5, 2.5, 4.5, 6.5, 8.5].filter(m => m <= range.end).map(m => ({
        mile: m, mileFrom: m - 1, mileTo: m + 1, lon: LON, lat: LAT0 + dLat(m), ele: null,
      }));
      const tm0 = now - 10 * 24 * h;
      const axis = Array.from({ length: 13 * 24 }, (_, k) => tm0 + k * h);
      const cell = {
        elevation: 2000, time: axis,
        Ta: axis.map(() => 6), Td: axis.map(() => 0), P: axis.map(() => 0), cloud: axis.map(() => 0), et0: axis.map(() => 0.05),
      };
      return okSource({
        points: pts,
        cellOf: pts.map(() => 'cell0'),
        cells: new Map([['cell0', cell]]),
        spacing: 2,
        range,
        timeZone: 'America/Los_Angeles',
        terrain: pts.map((_, idx) => ({ slopeDeg: idx === 2 ? 30 : 5, aspectDeg: 180, elevationM: 2000 + idx * 100, canopy: 0.1, nlcd: 31 })),
        snow: pts.map(() => 0),
        snowValidAt: tm0,
        confidence: { weather: 'ok', terrain: 'ok', snow: 'ok' },
      });
    },
  });
  const req = request(10, { trip: { startAt: new Date(now).toISOString(), paceMilesPerDay: 4 } });
  const res = await analyze(req, { sources, now });
  assert.equal(res.route.elevationFt.source, 'landfire');
  assert.ok(res.diagnostics.itineraryBeyondForecastMiles >= 5);
  assert.ok(res.summary.caveats.some(c => /beyond the 7-day NWS forecast horizon/i.test(c)));
  assert.equal(res.diagnostics.conditions.steepMiles, 2);
});
