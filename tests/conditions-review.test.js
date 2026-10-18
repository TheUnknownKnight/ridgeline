/**
 * Regressions from the adversarial review of the trail-conditions model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sunHour } from '../shared/conditions/solar.js';
import { runPoint } from '../shared/conditions/model.js';
import { classifyReading, dayTiming, toStretches, CONDITIONS } from '../shared/conditions/classify.js';
import { detectConditions } from '../server/fusion/conditions.js';
import { buildRoute, LON, LAT0, dLat } from './helpers.js';

const HOUR = 3600 * 1000;
const T0 = Date.UTC(2026, 9, 8, 7);

const forcing = (days, fn, { lat = 37.7, lon = -119.4, elevation = 2500, t0 = T0 } = {}) => {
  const f = { time: [], Ta: [], Td: [], P: [], cloud: [], et0: [], sun: [], elevation };
  for (let d = 0; d < days; d++) {
    for (let hr = 0; hr < 24; hr++) {
      const t = t0 + (d * 24 + hr) * HOUR;
      const w = fn(d, hr);
      f.time.push(t);
      f.Ta.push(w.Ta);
      f.Td.push(w.Td ?? w.Ta - 8);
      f.P.push(w.P ?? 0);
      f.cloud.push(w.cloud ?? 0);
      f.et0.push(w.et0 ?? 0.02);
      f.sun.push(sunHour(t, lat, lon, elevation));
    }
  }
  return f;
};
const diurnal = (min, max) => (hr) => min + (max - min) * Math.max(0, Math.sin(((hr - 8) / 12) * Math.PI));
const idx = (day, hr) => day * 24 + hr;
const levelOf = (c) => (c.likely ? CONDITIONS[c.code].level : Math.min(1, CONDITIONS[c.code].level));

test('snow hazard level never drops as the snow gets deeper', () => {
  const point = { surface: 'rock', slopeDeg: 0, canopy: 0 };
  let prev = 0;
  for (let cm = 0.5; cm <= 200; cm += 0.5) {
    const [c] = classifyReading(point, { depthCm: cm, sweMm: cm * 3, fresh: 0, meltToday: 0, liq: 0, cc: 0, Ta: -2, wet: false, wetness: 0, hoursDry: 0 });
    const level = levelOf(c);
    assert.ok(level >= prev, `${cm} cm rated ${level} after ${prev}`);
    prev = level;
  }
  assert.equal(prev, 2);
});

test('a deep pack melts no slower than a shallow one in the same melt-freeze weather', () => {
  const f = forcing(6, (d, hr) => ({ Ta: diurnal(-4, 8)(hr), cloud: 0 }));
  const point = { elevM: 2500, slopeDeg: 0, aspectDeg: -1, canopy: 0, surface: 'rock' };
  const meltDay4 = (swe) => {
    const r = runPoint(point, f, { seed: { atIndex: 0, sweMm: swe }, reads: [idx(3, 6), idx(4, 6)] });
    return r.get(idx(3, 6)).sweMm - r.get(idx(4, 6)).sweMm;
  };
  const shallow = meltDay4(100);
  assert.ok(shallow > 1);
  assert.ok(meltDay4(600) >= shallow * 0.9, 'cold content is limited to the surface layer');
});

test('a clear night just above freezing refreezes the surface: firm at dawn, not "soft all day"', () => {
  const f = forcing(4, (d, hr) => ({ Ta: hr < 7 || hr > 19 ? 2 : diurnal(2, 9)(hr), Td: -8, cloud: 0 }));
  const point = { elevM: 2500, slopeDeg: 0, aspectDeg: -1, canopy: 0, surface: 'rock' };
  const hours = Array.from({ length: 12 }, (_, k) => idx(2, 6 + k));
  const r = runPoint(point, f, { seed: { atIndex: 0, sweMm: 300 }, reads: hours });
  const timing = dayTiming(point, hours.map((h, k) => ({ localHour: 6 + k, reading: r.get(h) })));
  assert.doesNotMatch(timing.text, /soft all day/);
});

test('a dusting of snow is never reported as dry', () => {
  const f = forcing(3, (d, hr) => (d === 1 && hr === 3 ? { Ta: -3, P: 1.2, cloud: 100 } : { Ta: -3, cloud: d === 1 ? 100 : 0 }));
  const point = { elevM: 2500, slopeDeg: 0, aspectDeg: -1, canopy: 0, surface: 'rock' };
  const r = runPoint(point, f, { reads: [idx(1, 7)] });
  const codes = classifyReading(point, r.get(idx(1, 7))).map(c => c.code);
  assert.ok(!codes.includes('dry'), codes.join());
});

test('fresh snow follows the storm total, not the hourly rate', () => {
  const point = { elevM: 2500, slopeDeg: 0, aspectDeg: -1, canopy: 0, surface: 'rock' };
  const slow = forcing(3, (d, hr) => ({ Ta: -5, P: d === 0 ? 0.4 : 0, cloud: 100 }));
  const r = runPoint(point, slow, { reads: [idx(1, 8)] });
  assert.ok(r.get(idx(1, 8)).fresh > 5, 'about 10 mm over a day of light snow is fresh');
});

test('stretches start where the model starts and show unmodeled miles as "Not estimated"', () => {
  const at = (mile) => ({ mile, mileFrom: mile - 0.125, mileTo: mile + 0.125, elevM: 2000, slopeDeg: 0, aspectDeg: -1 });
  const points = [10, 10.25, 10.5, 11.5, 11.75].map(at);
  const dry = [{ code: 'dry', likely: true, why: [] }];
  const s = toStretches(points, points.map(() => dry), { range: { start: 9.875, end: 12.5 } });
  assert.equal(s[0].mileStart, 9.9);
  assert.ok(s.some(x => x.regime === 'missing' && x.mileStart === 10.6 && x.mileEnd === 11.4), JSON.stringify(s.map(x => [x.regime, x.mileStart, x.mileEnd])));
  assert.equal(s[s.length - 1].regime, 'missing', 'trailing miles past the last point');
});

test('detectConditions lines up weather cells fetched on different UTC days', async () => {
  const route = await buildRoute(2);
  const now = T0 + 9 * 24 * HOUR + 10 * HOUR;
  const weather = (d, hr) => ({ Ta: d === 9 ? 12 : -2, cloud: 0 }); // only the day containing `now` is warm
  const older = forcing(13, weather, { lat: LAT0, lon: LON });
  const newer = forcing(12, (d, hr) => weather(d + 1, hr), { lat: LAT0, lon: LON, t0: T0 + 24 * HOUR });
  const points = [0.5, 1.5].map(mile => ({ mile, mileFrom: mile - 0.5, mileTo: mile + 0.5, lat: LAT0 + dLat(mile), lon: LON, ele: null }));
  const data = {
    points, cellOf: ['a', 'b'], cells: new Map([['a', older], ['b', newer]]), spacing: 1,
    terrain: points.map(() => ({ slopeDeg: 0, aspectDeg: -1, elevationM: 2500, canopy: 0, nlcd: 31 })),
    snow: points.map(() => 0), snowValidAt: T0, confidence: { weather: 'ok', terrain: 'ok', snow: 'ok' },
  };
  const r = detectConditions(route, data, { now, timeZone: 'America/Los_Angeles' });
  assert.ok(r.block, 'both cells aligned onto one axis');
  assert.equal(r.checkedChunks.size, route.chunks.length);
});
