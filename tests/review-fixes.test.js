import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCache } from '../server/lib/cache.js';
import { fetchJson, circuitOpenFor } from '../server/lib/http.js';
import { detectFire, incidentLevel } from '../server/fusion/detectors/fire.js';
import { detectAlerts } from '../server/fusion/detectors/alerts.js';
import { analyze } from '../server/fusion/engine.js';
import { getRouteModel } from '../server/fusion/route.js';
import { validateAnalyzeRequest } from '../server/lib/validate.js';
import { buildRoute, boxPolygon, firePerimeter, prepared, straightCoords, routeRequest, fakeSources, LON, LAT0, dLat, dLon } from './helpers.js';

const DAY = 86400000;

test('cache: a hung upstream never holds a request when a stale copy exists', async () => {
  const cache = createCache();
  await cache.wrap('k', { ttlMs: 1, staleMs: 60000 }, async () => 'old');
  await new Promise(r => setTimeout(r, 5));
  let calls = 0;
  const hang = () => { calls++; return new Promise(() => {}); };
  const t0 = Date.now();
  const r = await cache.wrap('k', { ttlMs: 1, staleMs: 60000 }, hang);
  assert.equal(r.value, 'old');
  assert.equal(r.stale, true);
  assert.ok(Date.now() - t0 < 4000, 'bounded wait');
  assert.equal('error' in r, false, 'stale results carry no error flag');
  // While the refresh is still in flight, later requests reuse it.
  await cache.wrap('k', { ttlMs: 1, staleMs: 60000 }, hang);
  assert.equal(calls, 1);
});

test('cache: after a failed refresh covered by stale data, retries pause', async () => {
  const cache = createCache();
  await cache.wrap('k', { ttlMs: 1, staleMs: 60000 }, async () => 'old');
  await new Promise(r => setTimeout(r, 5));
  let calls = 0;
  const broken = async () => { calls++; throw new Error('down'); };
  assert.equal((await cache.wrap('k', { ttlMs: 1, staleMs: 60000 }, broken)).stale, true);
  await new Promise(r => setTimeout(r, 5));
  assert.equal((await cache.wrap('k', { ttlMs: 1, staleMs: 60000 }, broken)).value, 'old');
  assert.equal(calls, 1);
});

test('cache: weight cap evicts least recently used', () => {
  const cache = createCache({ maxWeight: 10, weigh: (v) => v.w });
  cache.set('a', { w: 6 }, { ttlMs: 1000 });
  cache.set('b', { w: 6 }, { ttlMs: 1000 });
  assert.equal(cache.get('a'), undefined);
  assert.ok(cache.get('b'));
});

test('http: a 429 opens a circuit instead of retrying', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.writeHead(429, { 'Retry-After': '30' });
    res.end('slow down');
  }).listen(0);
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/x`;
  try {
    await assert.rejects(fetchJson(url, { retries: 3 }), (e) => e.status === 429);
    assert.equal(hits, 1, 'no retries on 429');
    assert.ok(circuitOpenFor(url));
    await assert.rejects(fetchJson(url), (e) => e.status === 429);
    assert.equal(hits, 1, 'circuit open: no request sent');
  } finally {
    server.close();
  }
});

test('fire: a fresh fire with no reported size is graded like a real fire, not a spot fire', () => {
  const now = Date.now();
  const inc = { category: 'WF', acres: null, percentContained: null, discoveredAt: now - 3600000, updatedAt: now };
  assert.equal(incidentLevel(inc, 1.26, now), 3);
  assert.equal(incidentLevel(inc, 4, now), 2);
  const abandoned = { ...inc, discoveredAt: now - 10 * DAY, updatedAt: now - 10 * DAY };
  assert.equal(incidentLevel(abandoned, 4, now), 0, 'old unsized dispatch records stay quiet');
});

test('fire: overlay level is the fire max; complex roll-up uses complex totals', async () => {
  const route = await buildRoute(15);
  const complex = { name: 'Ridge Complex', acres: 5200, percentContained: 9 };
  const member = (m0, m1, key, name, pct) => firePerimeter(boxPolygon(m0, m1), {
    key, irwinId: key, name, isComplexChild: true, complexId: '{CX}', complex, percentContained: pct,
  });
  const cxIncident = {
    key: '{CX}', category: 'CX', name: 'Ridge Complex', acres: 5200, percentContained: 9,
    lon: LON + dLon(0.5), lat: LAT0 + dLat(8), hasPerimeter: false,
  };
  const r = detectFire(route, { perimeters: [member(6.2, 7.4, '{A}', 'West Fork', 16), member(9.2, 9.6, '{B}', 'Garda Falls', 0)], incidents: [cxIncident] });
  assert.equal(r.hazards.length, 1, 'one hazard for the complex');
  const hz = r.hazards[0];
  assert.equal(hz.id, 'fire:{CX}');
  assert.equal(hz.kind, 'fire-perimeter', 'the perimeter-less CX record does not overwrite it');
  assert.match(hz.title, /Fire complex: Ridge Complex/);
  assert.match(hz.detail, /5,200 acres · 9% contained/);
  assert.match(hz.detail, /includes West Fork, Garda Falls/);
  for (const o of r.overlays.filter(o => o.properties.overlay === 'fire-perimeter')) assert.equal(o.properties.level, 4);
});

test('alerts: each zone segment keeps its own text; timing spans only segments on the route', async () => {
  const route = await buildRoute(20);
  const now = Date.now();
  const seg = (m0, m1, end, headline) => ({
    key: 'vtec:KSGX.HW.W.0003', event: 'High Wind Warning', severity: 'Severe', headline, summary: null,
    onset: now - 1000, end, sent: now, areas: [prepared(boxPolygon(m0, m1, { widthMiles: 4 }))],
  });
  const mountains = seg(2, 5, now + 10 * 3600000, 'mountains until midnight');
  const valleys = seg(30, 40, now + 3 * 3600000, 'valleys until 8 pm'); // beyond this 20-mile route
  const { hazards } = detectAlerts(route, { alerts: [valleys, mountains] }, { now });
  assert.equal(hazards.length, 1);
  assert.match(hazards[0].detail, /mountains until midnight/);
  assert.equal(hazards[0].expiresAt, new Date(now + 10 * 3600000).toISOString());
});

test('engine: a route outside the US is not reported as checked or clear', async () => {
  // Near Lake Louise, Alberta.
  const coords = Array.from({ length: 200 }, (_, i) => [-116.2, 51.4 + i * 0.0007]);
  const r = await analyze(validateAnalyzeRequest({ coordinates: coords }), { sources: fakeSources() });
  assert.equal(r.summary.incomplete, true);
  assert.equal(r.summary.outsideCoverage, true);
  assert.notEqual(r.summary.headline, 'No reported hazards on this route');
  assert.ok(r.segments.every(s => !s.checked.includes('fire') && !s.checked.includes('alerts')));
  assert.match(r.summary.caveats[0], /outside US data coverage/);
});

test('engine: a loader that hangs is cut off and reported, not awaited forever', async () => {
  const sources = fakeSources({ loadWater: () => new Promise(() => {}) });
  const t0 = Date.now();
  const r = await analyze(validateAnalyzeRequest({ coordinates: straightCoords(2) }), { sources, deadlineMs: 200 });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.sources.water.status, 'error');
  assert.match(r.sources.water.message, /did not respond in time/);
});

test('route model: re-upload with different elevation rebuilds instead of reusing', async () => {
  const m1 = await getRouteModel(routeRequest(straightCoords(2)));
  const m2 = await getRouteModel(routeRequest(straightCoords(2, { ele: 2500 })));
  assert.equal(m1.routeHash, m2.routeHash);
  assert.equal(m1.hasElevation, false);
  assert.equal(m2.hasElevation, true);
});
