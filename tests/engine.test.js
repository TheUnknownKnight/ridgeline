import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../server/fusion/engine.js';
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
