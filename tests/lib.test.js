import test from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../server/lib/cache.js';
import { pointInPolygons, distanceToPolygonsMiles, prepPolygons, buildGridIndex, queryBbox } from '../server/lib/spatial.js';
import { validateAnalyzeRequest, ValidationError } from '../server/lib/validate.js';
import { mapLimit } from '../server/lib/pool.js';
import { fetchJson } from '../server/lib/http.js';
import { boxPolygon, straightCoords, LON, LAT0, dLat, dLon } from './helpers.js';

test('cache: concurrent misses share one fetch', async () => {
  const cache = createCache();
  let calls = 0;
  const fetchFn = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return 42; };
  const results = await Promise.all([1, 2, 3].map(() => cache.wrap('k', { ttlMs: 1000 }, fetchFn)));
  assert.equal(calls, 1);
  assert.deepEqual(results.map(r => r.value), [42, 42, 42]);
});

test('cache: a failed refresh serves the stale copy, flagged', async () => {
  const cache = createCache();
  await cache.wrap('k', { ttlMs: 1, staleMs: 60000 }, async () => 'good');
  await new Promise(r => setTimeout(r, 5));
  const r = await cache.wrap('k', { ttlMs: 1, staleMs: 60000 }, async () => { throw new Error('down'); });
  assert.equal(r.value, 'good');
  assert.equal(r.stale, true);
});

test('cache: failures are never cached as values', async () => {
  const cache = createCache();
  await assert.rejects(cache.wrap('k', { ttlMs: 1000 }, async () => { throw new Error('down'); }));
  const r = await cache.wrap('k', { ttlMs: 1000 }, async () => 'later');
  assert.equal(r.value, 'later');
});

test('cache: errorTtlMs fails fast instead of re-waiting on a broken upstream', async () => {
  const cache = createCache();
  let calls = 0;
  const broken = async () => { calls++; throw new Error('down'); };
  await assert.rejects(cache.wrap('k', { ttlMs: 1000, errorTtlMs: 60000 }, broken));
  await assert.rejects(cache.wrap('k', { ttlMs: 1000, errorTtlMs: 60000 }, broken));
  assert.equal(calls, 1);
});

test('cache: revalidate window returns old value and refreshes in background', async () => {
  const cache = createCache();
  await cache.wrap('k', { ttlMs: 1, revalidateMs: 60000 }, async () => 'v1');
  await new Promise(r => setTimeout(r, 5));
  const r = await cache.wrap('k', { ttlMs: 1000, revalidateMs: 60000 }, async () => 'v2');
  assert.equal(r.value, 'v1');
  await new Promise(r2 => setTimeout(r2, 5));
  assert.equal(cache.get('k'), 'v2');
});

test('cache: evicts least recently used past maxEntries', async () => {
  const cache = createCache({ maxEntries: 2 });
  cache.set('a', 1, { ttlMs: 1000 });
  cache.set('b', 2, { ttlMs: 1000 });
  cache.get('a');
  cache.set('c', 3, { ttlMs: 1000 });
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
});

test('spatial: point in polygon respects holes; distance to edge', () => {
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];
  const polys = prepPolygons({ type: 'Polygon', coordinates: [outer, hole] });
  assert.equal(pointInPolygons(1, 1, polys), true);
  assert.equal(pointInPolygons(5, 5, polys), false);
  assert.equal(pointInPolygons(11, 5, polys), false);

  const box = prepPolygons(boxPolygon(0, 1, { offsetMiles: 2, widthMiles: 1 }));
  const d = distanceToPolygonsMiles(LON, LAT0 + dLat(0.5), box);
  assert.ok(Math.abs(d - 1.5) < 0.02, `expected ~1.5 mi, got ${d}`);
  assert.equal(distanceToPolygonsMiles(LON + dLon(2), LAT0 + dLat(0.5), box), 0);
});

test('spatial: grid index returns only nearby features', () => {
  const features = [
    { id: 'near', bbox: [-120.1, 37, -119.9, 37.2] },
    { id: 'far', bbox: [-80, 30, -79, 31] },
  ];
  const idx = buildGridIndex(features);
  assert.deepEqual(queryBbox(idx, [-120.05, 37.05, -120, 37.1]).map(f => f.id), ['near']);
});

test('validate: rejects malformed input with codes', () => {
  const bad = [
    [null, 'invalid_request'],
    [[], 'invalid_request'],
    [{}, 'invalid_route'],
    [{ coordinates: [[0, 0]] }, 'invalid_route'],
    [{ coordinates: [[0, 0], ['a', 1]] }, 'invalid_route'],
    [{ coordinates: [[0, 0], [0, 95]] }, 'invalid_route'],
    [{ routeHash: 'nope' }, 'invalid_route'],
    [{ coordinates: straightCoords(1), location: { lat: 'x', lng: 1 } }, 'invalid_location'],
  ];
  for (const [body, code] of bad) {
    assert.throws(() => validateAnalyzeRequest(body), (e) => e instanceof ValidationError && e.code === code, JSON.stringify(body)?.slice(0, 60));
  }
});

test('validate: tiny payload expanding to a huge route is rejected', () => {
  const coords = Array.from({ length: 300 }, (_, i) => [i % 2 ? 179 : 0, 0]);
  assert.throws(() => validateAnalyzeRequest({ coordinates: coords }), (e) => e.code === 'route_too_long');
});

test('validate: server strips placeholder elevation even if the client did not', () => {
  const r = validateAnalyzeRequest({ coordinates: straightCoords(3).map(c => [c[0], c[1], 0]) });
  assert.equal(r.hasElevation, false);
  assert.ok(r.coords.every(c => c.length === 2));
});

test('validate: clamps lookahead, keeps only known fields', () => {
  const r = validateAnalyzeRequest({
    coordinates: straightCoords(2), lookaheadMiles: '500', name: 'A\u0000B', extra: 'x',
    location: { lat: 37, lng: -120, lastMile: 1.5, junk: true },
  });
  assert.equal(r.lookaheadMiles, 50);
  assert.equal(r.name, 'AB');
  assert.deepEqual(r.location, { lat: 37, lng: -120, lastMile: 1.5 });
  assert.equal('extra' in r, false);
  const h = validateAnalyzeRequest({ routeHash: '0123456789abcdef' });
  assert.equal(h.routeHash, '0123456789abcdef');
  assert.equal(h.coords, undefined);
});

test('validate: accepts valid trip itinerary and rejects invalid trip payloads', () => {
  const ok = validateAnalyzeRequest({
    coordinates: straightCoords(5),
    trip: { startAt: '2026-10-17T12:00:00Z', paceMilesPerDay: 15, junk: true },
  });
  assert.deepEqual(ok.trip, { startAt: '2026-10-17T12:00:00.000Z', paceMilesPerDay: 15 });

  assert.throws(
    () => validateAnalyzeRequest({ coordinates: straightCoords(5), trip: { startAt: 'not-a-date' } }),
    (e) => e instanceof ValidationError && e.code === 'invalid_trip',
  );
  assert.throws(
    () => validateAnalyzeRequest({ coordinates: straightCoords(5), trip: { startAt: '2026-10-17T12:00:00Z', paceMilesPerDay: -2 } }),
    (e) => e instanceof ValidationError && e.code === 'invalid_trip',
  );
});


test('mapLimit: preserves finished items and marks stragglers failed when deadlineAt expires', async () => {
  let slowTimer;
  const items = [10, 5000, 15];
  const results = await mapLimit(items, 2, (ms) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(ms * 2), ms);
    if (ms > 1000) slowTimer = t;
  }), { deadlineAt: Date.now() + 80 });
  clearTimeout(slowTimer);
  assert.equal(results[0], 20);
  assert.ok(results[1]?.error instanceof Error);
  assert.equal(results[2], 30);
});

test('cache.clearFailures forgets remembered negative failures without evicting good entries', async () => {
  const cache = createCache();
  cache.set('good', 'ok', { ttlMs: 60000 });
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls === 1) throw new Error('transient');
    return 'recovered';
  };
  await assert.rejects(cache.wrap('flaky', { ttlMs: 60000, errorTtlMs: 60000 }, fn));
  await assert.rejects(cache.wrap('flaky', { ttlMs: 60000, errorTtlMs: 60000 }, fn));
  assert.equal(calls, 1);

  cache.clearFailures();
  const r = await cache.wrap('flaky', { ttlMs: 60000, errorTtlMs: 60000 }, fn);
  assert.equal(r.value, 'recovered');
  assert.equal(cache.get('good'), 'ok');
  assert.equal(validateAnalyzeRequest({ coordinates: straightCoords(2), refresh: true }).refresh, true);
});

test('http: fetchJson surfaces underlying cause code on network errors', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND example.invalid'), { code: 'ENOTFOUND' });
    throw new TypeError('fetch failed', { cause });
  };
  try {
    await assert.rejects(
      fetchJson('https://example.invalid/test', { retries: 0, label: 'test' }),
      (err) => /fetch failed \(ENOTFOUND\)/.test(err.message) && err.code === 'ENOTFOUND',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
