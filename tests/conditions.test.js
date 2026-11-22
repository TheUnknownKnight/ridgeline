/**
 * Trail-conditions model: sun geometry, snow, mud and ice physics on
 * synthetic weather, the land-cover surface rules, the engine-facing
 * detector, and the PNG decoder used for the snow analysis.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { sunPosition, sunHour, slopeNormal, beamOnSlope } from '../shared/conditions/solar.js';
import { runPoint } from '../shared/conditions/model.js';
import { classifyReading, dayTiming, toStretches } from '../shared/conditions/classify.js';
import { surfaceFromLandCover } from '../shared/conditions/surfaces.js';
import { detectConditions } from '../server/fusion/conditions.js';
import { decodePng } from '../server/lib/png.js';
import { buildRoute, LON, LAT0, dLat } from './helpers.js';

const HOUR = 3600 * 1000;
const T0 = Date.UTC(2026, 9, 3, 7); // local midnight (PDT) 14 days before Oct 17

/** Hourly forcing for `days` days; fn(dayIndex, localHour) → { Ta, Td?, P?, cloud?, et0? }. */
const forcing = (days, fn, { lat = 37.7, lon = -119.4, elevation = 2500 } = {}) => {
  const f = { time: [], Ta: [], Td: [], P: [], cloud: [], et0: [], sun: [], elevation };
  for (let d = 0; d < days; d++) {
    for (let hr = 0; hr < 24; hr++) {
      const t = T0 + (d * 24 + hr) * HOUR;
      const w = fn(d, hr);
      f.time.push(t);
      f.Ta.push(w.Ta);
      f.Td.push(w.Td ?? w.Ta - 8);
      f.P.push(w.P ?? 0);
      f.cloud.push(w.cloud ?? 0);
      f.et0.push(w.et0 ?? (hr >= 9 && hr <= 16 ? 0.35 : 0.02));
      f.sun.push(sunHour(t, lat, lon, elevation));
    }
  }
  return f;
};
const diurnal = (min, max) => (hr) => min + (max - min) * Math.max(0, Math.sin(((hr - 8) / 12) * Math.PI));
const idx = (day, hr) => day * 24 + hr;

test('sun: Yosemite at solar noon on Oct 17 is ~43° up; a south slope gets more sun than a north one', () => {
  let best = { altitude: -90 };
  for (let m = 0; m < 24 * 60; m += 2) {
    const s = sunPosition(Date.UTC(2026, 9, 17, 7) + m * 60000, 37.74, -119.59);
    if (s.altitude > best.altitude) best = s;
  }
  assert.ok(Math.abs(best.altitude - 42.95) < 0.2, `max altitude ${best.altitude}`);
  const noon = sunHour(Date.UTC(2026, 9, 17, 19), 37.74, -119.59, 1200);
  assert.ok(beamOnSlope(noon, slopeNormal(30, 180)) > 2 * beamOnSlope(noon, slopeNormal(30, 0)));
  assert.equal(beamOnSlope(null, slopeNormal(0, -1)), 0);
});

test('model: a cold storm builds snow, and sun melts the south slope before the north one', () => {
  const f = forcing(12, (d, hr) => (d === 2
    ? { Ta: -4, P: 2, cloud: 100, et0: 0 }                       // 48 mm of snow-water in a day
    : { Ta: d < 2 ? -2 : diurnal(-6, 6)(hr), cloud: 0 }));
  const point = (aspectDeg) => ({ elevM: 2500, slopeDeg: 30, aspectDeg, canopy: 0, surface: 'dirt' });
  const reads = [idx(3, 12), idx(11, 15)];
  const north = runPoint(point(0), f, { reads });
  const south = runPoint(point(180), f, { reads });
  assert.ok(north.get(idx(3, 12)).sweMm > 40, 'snow is on the ground the day after the storm');
  assert.ok(south.get(idx(11, 15)).sweMm < north.get(idx(11, 15)).sweMm, 'south melts faster');
  const c = classifyReading(point(0), north.get(idx(3, 12)));
  assert.ok(['snow', 'snow-deep'].includes(c[0].code));
});

test('model: lapse rate — the same storm is snow up high and rain down low', () => {
  const f = forcing(4, (d) => (d === 1 ? { Ta: 2.5, P: 1, cloud: 100, et0: 0 } : { Ta: 2.5, cloud: 100, et0: 0 }), { elevation: 2000 });
  const high = runPoint({ elevM: 3200, slopeDeg: 0, aspectDeg: -1, canopy: 0, surface: 'rock' }, f, { reads: [idx(2, 0)] });
  const low = runPoint({ elevM: 1500, slopeDeg: 0, aspectDeg: -1, canopy: 0, surface: 'dirt' }, f, { reads: [idx(2, 0)] });
  assert.ok(high.get(idx(2, 0)).sweMm > 15, 'about 7.8 °C colder at +1,200 m: snow');
  assert.equal(low.get(idx(2, 0)).sweMm, 0);
  assert.equal(low.get(idx(2, 0)).wet, true, 'rain soaked the low dirt');
});

test('model: a soaked dirt trail is muddy, then dries over warm days', () => {
  const f = forcing(8, (d, hr) => (d === 1 ? { Ta: 10, P: 1.5, cloud: 100, et0: 0.02 } : { Ta: diurnal(8, 22)(hr), cloud: 0, et0: hr >= 9 && hr <= 16 ? 0.6 : 0.02 }));
  const point = { elevM: 2500, slopeDeg: 5, aspectDeg: 180, canopy: 0, surface: 'dirt' };
  const r = runPoint(point, f, { reads: [idx(2, 9), idx(7, 15)] });
  assert.equal(classifyReading(point, r.get(idx(2, 9)))[0].code, 'mud');
  assert.notEqual(classifyReading(point, r.get(idx(7, 15)))[0].code, 'mud', 'five sunny days later it has dried');
});

test('model: wet rock and a clear freezing night give morning ice that lets go later in the day', () => {
  const f = forcing(4, (d, hr) => (d === 1 ? { Ta: 3, P: 1, cloud: 100, et0: 0 } : { Ta: diurnal(-5, 9)(hr), Td: -10, cloud: 0 }));
  const point = { elevM: 2500, slopeDeg: 20, aspectDeg: 135, canopy: 0, surface: 'rock' };
  const hours = Array.from({ length: 12 }, (_, k) => idx(2, 6 + k));
  const r = runPoint(point, f, { reads: hours });
  assert.equal(classifyReading(point, r.get(idx(2, 7)))[0].code, 'ice');
  const timing = dayTiming(point, hours.map((h, k) => ({ localHour: 6 + k, reading: r.get(h) })));
  assert.equal(timing?.kind, 'ice');
  assert.match(timing.text, /icy until about \d+ (AM|PM)|may stay icy all day/);
});

test('model: an observed snowpack (SNODAS) seeds snow the weather history never saw', () => {
  const f = forcing(6, (d, hr) => ({ Ta: diurnal(-8, -1)(hr), cloud: 0 }));
  const point = { elevM: 3000, slopeDeg: 10, aspectDeg: 0, canopy: 0, surface: 'rock' };
  const seeded = runPoint(point, f, { seed: { atIndex: idx(3, 5), sweMm: 120 }, reads: [idx(5, 9)] });
  const unseeded = runPoint(point, f, { reads: [idx(5, 9)] });
  assert.ok(seeded.get(idx(5, 9)).sweMm > 100);
  assert.equal(unseeded.get(idx(5, 9)).sweMm, 0);
});

test('surfaces from land cover, slope and canopy', () => {
  assert.equal(surfaceFromLandCover({ nlcd: 31, slopeDeg: 35 }), 'scree');
  assert.equal(surfaceFromLandCover({ nlcd: 31, slopeDeg: 10, elevationM: 3500 }), 'rock');
  assert.equal(surfaceFromLandCover({ nlcd: 42, canopy: 0.7 }), 'forest');
  assert.equal(surfaceFromLandCover({ nlcd: 42, canopy: 0.1 }), 'dirt');
  assert.equal(surfaceFromLandCover({ nlcd: 95 }), 'fine');
  assert.equal(surfaceFromLandCover({ nlcd: 23 }), 'paved');
  assert.equal(surfaceFromLandCover({ nlcd: 12 }), 'ice');
});

test('stretches: one sunny switchback does not split a snowy stretch', () => {
  const points = Array.from({ length: 12 }, (_, i) => ({ mile: i * 0.25, mileFrom: i * 0.25 - 0.125, mileTo: i * 0.25 + 0.125, elevM: 3000, slopeDeg: 20, aspectDeg: i % 2 ? 0 : 180 }));
  const snow = [{ code: 'snow', likely: true, why: ['about 4 in of snow modeled'] }];
  const dry = [{ code: 'dry', likely: true, why: [] }];
  const per = points.map((_, i) => (i === 6 ? dry : snow));
  const s = toStretches(points, per, { smoothMiles: 0.5 });
  assert.equal(s.length, 1);
  assert.equal(s[0].regime, 'winter');
  assert.equal(s[0].parts[0].code, 'snow');
  assert.ok(s[0].parts[0].share >= 90);
});

test('detectConditions: snow on part of a route becomes an estimated hazard over those miles', async () => {
  const route = await buildRoute(6);
  const now = T0 + 12 * 24 * HOUR + 10 * HOUR;
  const cell = forcing(17, (d, hr) => (d === 10 ? { Ta: -6, P: 3, cloud: 100, et0: 0 } : { Ta: diurnal(-10, -2)(hr), cloud: 0 }), { lat: LAT0, lon: LON, elevation: 2500 });
  const points = Array.from({ length: 25 }, (_, i) => ({ mile: i * 0.25, mileFrom: Math.max(0, i * 0.25 - 0.125), mileTo: Math.min(6, i * 0.25 + 0.125), lat: LAT0 + dLat(i * 0.25), lon: LON, ele: null }));
  const data = {
    points,
    cellOf: points.map(() => 'cell'),
    cells: new Map([['cell', cell]]),
    spacing: 0.25,
    // Miles 0–3 sit 1,300 m below the weather cell: the storm falls there as rain.
    terrain: points.map(p => ({ slopeDeg: 10, aspectDeg: 0, elevationM: p.mile < 3 ? 1200 : 3000, canopy: 0, nlcd: 31 })),
    snow: points.map(() => null),
    snowValidAt: null,
    confidence: { terrain: 'ok', snow: 'error' },
  };
  const r = detectConditions(route, data, { now, timeZone: 'America/Los_Angeles' });
  assert.equal(r.block.windows[0].key, 'now');
  assert.ok(r.block.windows.length >= 3);
  const snowHits = r.hits.filter(h => h.id.startsWith('trail:snow'));
  assert.ok(snowHits.length > 0);
  assert.ok(snowHits.every(h => route.chunks[h.chunk].end >= 3), 'only the high miles hold snow');
  const hz = r.hazards.find(h => h.id.startsWith('trail:snow'));
  assert.equal(hz.source, 'ESTIMATED');
  assert.ok(hz.detail.includes('not an observation'));
  assert.equal(r.checkedChunks.size, route.chunks.length);
});

// --------------------------------------------------------------------- PNG

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

test('png: decodes an indexed image with transparency, rows using different filters', async () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(3, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; ihdr[9] = 3;
  const palette = Buffer.from([0, 0, 0, 171, 193, 191, 60, 63, 194]);
  const trns = Buffer.from([0]);
  // Row 0: filter none [0,1,2]; row 1: filter Sub, pixels [2,2,1] encoded as deltas [2,0,255].
  const raw = Buffer.from([0, 0, 1, 2, 1, 2, 0, 255]);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('PLTE', palette), chunk('tRNS', trns), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  const img = await decodePng(png);
  assert.equal(img.width, 3);
  assert.deepEqual(img.rgba(0, 0), [0, 0, 0, 0]);
  assert.deepEqual(img.rgba(1, 0), [171, 193, 191, 255]);
  assert.deepEqual(img.rgba(0, 1), [60, 63, 194, 255]);
  assert.deepEqual(img.rgba(2, 1), [171, 193, 191, 255]);
  assert.equal(img.rgba(5, 5), null);
  await assert.rejects(() => decodePng(Buffer.from('not a png')));
});
