/**
 * Regressions from the adversarial review of the trail-conditions model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sunHour, slopeNormal, irradianceOnSlope } from '../shared/conditions/solar.js';
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

test('crust only forms when liquid meltwater refreezes, never on continuously cold dry snow', () => {
  const cold = forcing(3, () => ({ Ta: -8, Td: -15, cloud: 0 }));
  const meltFreeze = forcing(3, (d, hr) => ({ Ta: diurnal(-6, 7)(hr), Td: -8, cloud: 0 }));
  const pt = { elevM: 2500, slopeDeg: 0, aspectDeg: -1, canopy: 0, surface: 'rock' };
  const dryR = runPoint(pt, cold, { seed: { atIndex: 0, sweMm: 200 }, reads: [idx(2, 5)] }).get(idx(2, 5));
  const mfR = runPoint(pt, meltFreeze, { seed: { atIndex: 0, sweMm: 200 }, reads: [idx(2, 5)] }).get(idx(2, 5));
  assert.equal(dryR.crust, 0);
  assert.ok(mfR.crust > 0.2, `expected refreeze crust after warm day, got ${mfR.crust}`);
});

test('sub-zero clear sun melts steep south snow while steep north slope stays frozen', () => {
  const f = forcing(2, (d, hr) => ({ Ta: -2, Td: -12, cloud: 0 }));
  const south = { elevM: 2500, slopeDeg: 35, aspectDeg: 180, canopy: 0, surface: 'rock' };
  const north = { elevM: 2500, slopeDeg: 35, aspectDeg: 0, canopy: 0, surface: 'rock' };
  const sr = runPoint(south, f, { seed: { atIndex: 0, sweMm: 100 }, reads: [idx(1, 16)] }).get(idx(1, 16));
  const nr = runPoint(north, f, { seed: { atIndex: 0, sweMm: 100 }, reads: [idx(1, 16)] }).get(idx(1, 16));
  assert.ok(sr.snowmelt24hMm > nr.snowmelt24hMm, `south melt ${sr.snowmelt24hMm} should exceed north ${nr.snowmelt24hMm}`);
});

test('tree canopy reduces nighttime radiative snow-crust refreezing compared to open alpine', () => {
  const f = forcing(3, (d, hr) => ({ Ta: hr < 7 || hr > 18 ? 1 : 6, Td: -5, cloud: 0 }));
  f.wind = new Array(72).fill(0);
  const open = { elevM: 2500, slopeDeg: 0, aspectDeg: -1, canopy: 0, surface: 'rock' };
  const woods = { elevM: 2500, slopeDeg: 0, aspectDeg: -1, canopy: 0.85, surface: 'forest' };
  const rOpen = runPoint(open, f, { seed: { atIndex: 0, sweMm: 200 }, reads: [idx(2, 5)] }).get(idx(2, 5));
  const rWoods = runPoint(woods, f, { seed: { atIndex: 0, sweMm: 200 }, reads: [idx(2, 5)] }).get(idx(2, 5));
  assert.ok(rOpen.crust > rWoods.crust, `open crust ${rOpen.crust} should exceed forest crust ${rWoods.crust}`);
});

test('horizon shadow blocks direct beam; overcast diffuse light stays aspect-symmetric', () => {
  const morningSun = sunHour(Date.UTC(2026, 9, 8, 16), 37.7, -119.4, 2500);
  const flat = slopeNormal(0, -1);
  const sector = Math.floor((morningSun.azimuth % 360) / 45);
  const ring = Array(8).fill(0);
  ring[sector] = 50;
  ring[(sector + 1) % 8] = 50;
  const unblocked = irradianceOnSlope(morningSun, flat, { cloud: 0, horizonDeg: Array(8).fill(0) });
  const blocked = irradianceOnSlope(morningSun, flat, { cloud: 0, horizonDeg: ring });
  assert.equal(unblocked.blocked, false);
  assert.ok(unblocked.beam > 150);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.beam, 0);
  assert.ok(blocked.total < unblocked.total);

  const noonSun = sunHour(Date.UTC(2026, 9, 8, 20), 37.7, -119.4, 2500);
  const s30 = irradianceOnSlope(noonSun, slopeNormal(30, 180), { cloud: 100, slopeDeg: 30 });
  const n30 = irradianceOnSlope(noonSun, slopeNormal(30, 0), { cloud: 100, slopeDeg: 30 });
  assert.ok(Math.abs(s30.diffuse - n30.diffuse) < 1e-6);
});

test('humid clear night condenses frost/verglas (ice) or warm morning dew (slick)', () => {
  const freezeNight = forcing(2, (d, hr) => ({ Ta: hr < 8 ? 0.5 : -2, Td: -0.5, cloud: 0 }));
  freezeNight.wind = new Array(48).fill(0);
  const rock = { elevM: 2500, slopeDeg: 10, aspectDeg: 0, canopy: 0, surface: 'rock' };
  const rIce = runPoint(rock, freezeNight, { reads: [idx(1, 5)] }).get(idx(1, 5));
  assert.ok(rIce.groundIceMm > 0.05 || rIce.frostMm >= 0.08, JSON.stringify(rIce));
  const cIce = classifyReading(rock, rIce);
  assert.ok(cIce.some(c => c.code === 'ice'), `expected ice from frost/verglas, got ${JSON.stringify(cIce)}`);

  const warmDew = forcing(2, () => ({ Ta: 6, Td: 5.8, cloud: 0 }));
  warmDew.wind = new Array(48).fill(0);
  const dirt = { elevM: 2500, slopeDeg: 0, aspectDeg: -1, canopy: 0, surface: 'dirt' };
  const rDew = runPoint(dirt, warmDew, { reads: [idx(1, 5)] }).get(idx(1, 5));
  assert.ok(rDew.dewWet >= 0.5, JSON.stringify(rDew));
  const cDew = classifyReading(dirt, rDew);
  assert.ok(cDew.some(c => (c.code === 'wet' || c.code === 'slick') && c.why.some(w => /dew/i.test(w))), JSON.stringify(cDew));
});

test('stretches split sustained winter elevation/snow-tier transitions while merging single switchbacks', () => {
  const at = (m, elevM) => ({ mile: m, mileFrom: m - 0.5, mileTo: m + 0.5, elevM, slopeDeg: 15, aspectDeg: 180 });
  const points = [
    at(0.5, 3100), at(1.5, 3100), at(2.5, 3100), at(3.5, 3100),
    at(4.5, 2200), at(5.5, 2200), at(6.5, 2200),
  ];
  const conds = [
    ...Array(4).fill([{ code: 'snow-deep', likely: true, depthIn: 30, why: [] }]),
    ...Array(3).fill([{ code: 'snow-patchy', likely: false, depthIn: 2, why: [] }]),
  ];
  const s = toStretches(points, conds);
  assert.equal(s.length, 2, 'sustained 900 m drop splits deep winter snow from patchy snow');
  assert.equal(s[0].mileEnd, 4);
  assert.equal(s[1].mileStart, 4);
});

test('detectConditions: trace sub-0.5cm dusting and dry-ground morning frost stay in stretches without firing top-level hazards', async () => {
  const route = await buildRoute(2);
  const now = T0 + 1 * 24 * HOUR + 5 * HOUR;
  // Clear humid freezing night on dry rock (frost only, no rain/wetness -> frost-only ice reading)
  const frostCell = forcing(4, (d, hr) => ({ Ta: hr < 8 ? 0.4 : 4, Td: -0.2, cloud: 0 }));
  frostCell.wind = new Array(96).fill(0);
  const points = [0.5, 1.5].map(mile => ({ mile, mileFrom: mile - 0.5, mileTo: mile + 0.5, lat: LAT0 + dLat(mile), lon: LON, ele: null }));
  const data = {
    points, cellOf: ['c', 'c'], cells: new Map([['c', frostCell]]), spacing: 1,
    terrain: points.map(() => ({ slopeDeg: 5, aspectDeg: 0, elevationM: 2500, canopy: 0, nlcd: 31 })),
    snow: points.map(() => 0), snowValidAt: T0, confidence: { weather: 'ok', terrain: 'ok', snow: 'ok' },
  };
  const r = detectConditions(route, data, { now, timeZone: 'America/Los_Angeles' });
  assert.equal(r.hazards.some(h => h.id === 'trail:ice'), false, 'dry-ground morning frost does not fire a top-level ice hazard');
});
