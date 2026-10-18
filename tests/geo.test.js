import test from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineMiles, cumulativeMiles, pointAtMile, sliceByMiles, samplePoints, projectOntoRoute,
  normalizeCoords, routeFingerprint, padBbox, coordsBbox,
} from '../shared/geo.js';
import { straightCoords, LON, LAT0, dLat, dLon } from './helpers.js';

test('haversine: one degree of latitude ≈ 69.09 mi', () => {
  assert.ok(Math.abs(haversineMiles(0, 0, 0, 1) - 69.0934) < 0.01);
});

test('cumulativeMiles / pointAtMile / sliceByMiles agree', () => {
  const coords = straightCoords(10);
  const cum = cumulativeMiles(coords);
  assert.ok(Math.abs(cum[cum.length - 1] - 10) < 1e-6);
  const p = pointAtMile(coords, cum, 4.25);
  assert.ok(Math.abs(p[1] - (LAT0 + dLat(4.25))) < 1e-9);
  const s = sliceByMiles(coords, cum, 2.5, 3.75);
  const sc = cumulativeMiles(s);
  assert.ok(Math.abs(sc[sc.length - 1] - 1.25) < 1e-6);
  assert.deepEqual(sliceByMiles(coords, cum, 9.9, 50).length >= 2, true);
});

test('samplePoints includes both ends and fixed spacing', () => {
  const coords = straightCoords(1);
  const pts = samplePoints(coords, cumulativeMiles(coords), 0, 1, 0.1);
  assert.equal(pts.length, 11);
  assert.equal(pts[0].mile, 0);
  assert.equal(pts.at(-1).mile, 1);
});

test('projectOntoRoute finds the mile and off-route distance', () => {
  const coords = straightCoords(10);
  const cum = cumulativeMiles(coords);
  const r = projectOntoRoute(coords, cum, LON + dLon(0.5), LAT0 + dLat(6));
  assert.ok(Math.abs(r.mile - 6) < 0.01);
  assert.ok(Math.abs(r.offRouteMiles - 0.5) < 0.01);
});

test('projectOntoRoute uses the hint on out-and-back routes', () => {
  const out = straightCoords(5);
  const coords = [...out, ...out.slice(0, -1).reverse()]; // 10 mi out and back
  const cum = cumulativeMiles(coords);
  const lat = LAT0 + dLat(2);
  const noHint = projectOntoRoute(coords, cum, LON, lat);
  assert.ok(Math.abs(noHint.mile - 2) < 0.01, 'without a hint the first pass wins');
  const onReturn = projectOntoRoute(coords, cum, LON, lat, 7.5);
  assert.ok(Math.abs(onReturn.mile - 8) < 0.01, `hint near the return leg picks mile 8, got ${onReturn.mile}`);
});

test('normalizeCoords drops junk, duplicates, and caps point count', () => {
  const raw = [[1, 2, 100], [1, 2, 100], ['x', 3], [200, 1], [1.0000001, 2.0000004], [2, 3, 99999], [3, 4, 140]];
  const out = normalizeCoords(raw);
  assert.deepEqual(out, [[1, 2, 100], [2, 3], [3, 4, 140]]);
  const dense = straightCoords(50); // 1001 points
  assert.ok(normalizeCoords(dense, 100).length <= 100);
});

test('placeholder elevation (KML altitude 0, nulls) is not treated as terrain', () => {
  const kml = straightCoords(3).map(c => [c[0], c[1], 0]);
  assert.ok(normalizeCoords(kml).every(c => c.length === 2), 'constant 0 m is stripped');
  const nulls = straightCoords(3).map(c => [c[0], c[1], null]);
  assert.ok(normalizeCoords(nulls).every(c => c.length === 2), 'null never becomes 0 m');
  const real = straightCoords(3, { ele: 2000 });
  assert.ok(normalizeCoords(real).every(c => c.length === 3), 'varying elevation is kept');
});

test('routeFingerprint is stable and order sensitive', () => {
  const a = straightCoords(3);
  assert.equal(routeFingerprint(a), routeFingerprint(a.map(c => [...c])));
  assert.notEqual(routeFingerprint(a), routeFingerprint([...a].reverse()));
  assert.match(routeFingerprint(a), /^[0-9a-f]{16}$/);
});

test('padBbox grows by the requested distance', () => {
  const b = padBbox(coordsBbox([[LON, LAT0]]), 1);
  assert.ok(Math.abs(haversineMiles(LON, LAT0, LON, b[3]) - 1) < 0.01);
});
