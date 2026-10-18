/**
 * Regressions from the adversarial review of the smoke layer: monitor gaps,
 * slow or frozen upstreams, coverage gaps, and plume handling.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAir } from '../server/sources/airnow.js';
import { parseHmsKml } from '../server/sources/hms.js';
import { loadSmoke } from '../server/sources/smokeForecast.js';
import { detectAir } from '../server/fusion/detectors/air.js';
import { analyze } from '../server/fusion/engine.js';
import { validateAnalyzeRequest } from '../server/lib/validate.js';
import { sourceCache } from '../server/lib/cache.js';
import { snapshotOf, diffSnapshots } from '../src/js/diff.js';
import {
  buildRoute, boxPolygon, prepared, goodAir, fakeSources, okSource, straightCoords, LON, LAT0, dLat, dLon,
} from './helpers.js';

const stubFetch = (handler) => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  return () => { globalThis.fetch = real; };
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const geojson = (features) => json({ type: 'FeatureCollection', features });

const box = { type: 'Polygon', coordinates: [[[LON - 1, LAT0 - 1], [LON + 1, LAT0 - 1], [LON + 1, LAT0 + 1], [LON - 1, LAT0 + 1], [LON - 1, LAT0 - 1]]] };
const contourFeature = (gridcode, ts) => ({ type: 'Feature', geometry: box, properties: { gridcode, Timestamp: ts } });
const monitorFeature = (aqi, ts, id = 'FS1') => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [LON + dLon(1), LAT0 + dLat(2)] },
  properties: { AQSID: id, SiteName: 'Fire camp', DataSource: 'Forest Service', PM25: 70, PM25_AQI: aqi, ValidTime: ts / 1000, Status: 'Active' },
});

const airStub = ({ contourTs, monitors, hms = 'ok' }) => (url) => {
  if (url.includes('AirNowLatestContoursPM25')) return geojson([contourFeature(1, contourTs)]);
  if (url.includes('Air_Now_Current_Monitors_PM25')) return geojson(monitors);
  if (url.includes('satepsanone')) {
    if (hms === 'hang') return new Promise(() => {});
    return new Response('<kml><Document></Document></kml>', { status: 200 });
  }
  throw new Error(`unexpected ${url}`);
};

test('AirNow: a monitor that misses an hour keeps its last reading instead of clearing', async () => {
  sourceCache.clear();
  const now = Date.now();
  let restore = stubFetch(airStub({ contourTs: now - 3600e3, monitors: [monitorFeature(180, now - 3600e3)] }));
  try {
    const first = await loadAir({ now });
    assert.equal(first.data.monitors[0].aqi, 180);
  } finally { restore(); }
  sourceCache.clear();
  restore = stubFetch(airStub({ contourTs: now - 1800e3, monitors: [monitorFeature(null, now - 1800e3)] }));
  try {
    const second = await loadAir({ now });
    const m = second.data.monitors.find(x => x.id === 'FS1');
    assert.ok(m, 'the ND monitor is still there');
    assert.equal(m.aqi, 180);
    assert.equal(m.carried, true);
    const route = await buildRoute(5);
    const r = detectAir(route, second.data, { now });
    assert.equal(r.hazards[0]?.id, 'air:pm25');
    assert.match(r.hazards[0].detail, /last reading/);
  } finally { restore(); }
});

test('AirNow: a hung satellite-smoke server never holds up or takes down measured air', async () => {
  sourceCache.clear();
  const now = Date.now();
  const restore = stubFetch(airStub({ contourTs: now - 3600e3, monitors: [], hms: 'hang' }));
  try {
    const t = Date.now();
    const r = await loadAir({ now });
    assert.ok(Date.now() - t < 4000, 'answers within the plume budget');
    assert.equal(r.status, 'ok');
    assert.equal(r.plumesStatus, 'pending');
    assert.match(r.message, /still loading/);
  } finally { restore(); }
});

test('AirNow: readings that stopped advancing are stale, then unusable, never current', async () => {
  const now = Date.now();
  for (const [ageH, status] of [[4, 'stale'], [30, 'error']]) {
    sourceCache.clear();
    const ts = now - ageH * 3600e3;
    const restore = stubFetch(airStub({ contourTs: ts, monitors: [monitorFeature(20, ts)] }));
    try {
      const r = await loadAir({ now });
      assert.equal(r.status, status, `${ageH} h old`);
      if (status === 'error') assert.equal(r.data.contours.length, 0);
    } finally { restore(); }
  }
});

test('engine: a stretch with no AirNow coverage gets a caveat, not a silent grey', async () => {
  const partial = prepared(boxPolygon(0, 2, { widthMiles: 4 }), { category: 1 });
  const r = await analyze(validateAnalyzeRequest({ coordinates: straightCoords(6) }), {
    sources: fakeSources({ loadAir: async () => okSource({ contours: [partial], monitors: [], plumes: [] }) }),
  });
  assert.ok(r.summary.caveats.some(c => /Measured air quality isn't available for/.test(c)));
});

const samples = (n) => Array.from({ length: n }, (_, i) => ({ mile: i * 2, lat: 37 + i * 0.1, lon: -119.5 }));

test('smoke forecast: NOAA hanging falls back to CAMS inside the budget', async () => {
  sourceCache.clear();
  const now = Date.UTC(2026, 9, 18, 0);
  const nowSec = now / 1000;
  const restore = stubFetch((url) => {
    if (url.includes('mapservices.weather.noaa.gov')) return new Promise(() => {});
    const n = new URL(url).searchParams.get('latitude').split(',').length;
    const loc = { hourly: { time: [nowSec, nowSec + 3600], us_aqi_pm2_5: [40, 120] } };
    return json(n === 1 ? loc : Array.from({ length: n }, () => loc));
  });
  try {
    const t = Date.now();
    const r = await loadSmoke({ samples: samples(3), now });
    assert.ok(Date.now() - t < 12000);
    assert.ok(r.data.points.every(p => p.aq?.model === 'cams'));
  } finally { restore(); }
});

test('smoke forecast: points CAMS cannot reach on a long route make the source partial', async () => {
  sourceCache.clear();
  const now = Date.UTC(2026, 9, 18, 0);
  const nowSec = now / 1000;
  const long = Array.from({ length: 120 }, (_, i) => ({ mile: i * 30, lat: 33 + i * 0.12, lon: -117 }));
  const restore = stubFetch((url) => {
    if (url.includes('mapservices.weather.noaa.gov')) return json({ error: 'down' }, 503);
    const n = new URL(url).searchParams.get('latitude').split(',').length;
    const loc = { hourly: { time: [nowSec], us_aqi_pm2_5: [30] } };
    return json(n === 1 ? loc : Array.from({ length: n }, () => loc));
  });
  try {
    const r = await loadSmoke({ samples: long, now });
    const missing = r.data.points.filter(p => !p.aq).length;
    assert.ok(missing > 0, '60 CAMS picks cannot reach 120 points 30 mi apart');
    assert.equal(r.status, 'partial');
    assert.match(r.message, new RegExp(`no forecast for ${missing} of 120 points`));
  } finally { restore(); }
});

test('diff: a satellite-smoke outage carries the plume forward instead of reporting it cleared', () => {
  const sources = (plumesStatus) => ({ air: { status: 'ok', plumesStatus } });
  const plume = { id: 'smoke:plume', type: 'smoke', source: 'OFFICIAL', level: 1, title: 'Heavy smoke overhead', ranges: [[3, 7]] };
  const before = snapshotOf({ generatedAt: 't0', mode: 'planning', sources: sources('ok'), hazards: { 'smoke:plume': plume } });
  const outage = { generatedAt: 't1', mode: 'planning', sources: sources('error'), hazards: {} };
  assert.deepEqual(diffSnapshots(before, outage).changes, []);
  assert.ok('smoke:plume' in snapshotOf(outage, before).hazards);
  const recovered = { generatedAt: 't2', mode: 'planning', sources: sources('ok'), hazards: {} };
  assert.equal(diffSnapshots(before, recovered).changes[0]?.kind, 'cleared');
});

test('air: only contours the trail crosses lead to the hazard; others keep their own title', async () => {
  const route = await buildRoute(10);
  const onTrail = prepared(boxPolygon(2, 4, { widthMiles: 2 }), { category: 3 });
  const offTrail = prepared(boxPolygon(2, 4, { offsetMiles: 6, widthMiles: 2 }), { category: 5 });
  const r = detectAir(route, { contours: [goodAir(), onTrail, offTrail], monitors: [], plumes: [] }, {});
  const areas = r.overlays.filter(o => o.properties.overlay === 'air-area');
  const off = areas.find(o => o.properties.category === 5);
  assert.equal(off.properties.hazardId, null);
  assert.equal(off.properties.levelLabel, 'Very unhealthy');
  assert.equal(areas.find(o => o.properties.category === 3).properties.hazardId, 'air:pm25');
  assert.equal(r.hazards[0].levelLabel, 'Unhealthy for sensitive groups');
});

test('air: a good monitor right by the trail counts as coverage where no contour reaches', async () => {
  const route = await buildRoute(10);
  const m = { id: 'G', name: 'Trailhead', aqi: 12, category: 1, at: Date.now(), lon: LON + dLon(0.5), lat: LAT0 + dLat(5) };
  const r = detectAir(route, { contours: [], monitors: [m], plumes: [] }, {});
  assert.ok(r.checkedChunks.has(5));
  assert.equal(r.hits.length, 0);
});

test('air: a newer light satellite trace replaces an older heavy one', async () => {
  const route = await buildRoute(10);
  const now = Date.now();
  const at = (h) => now - h * 3600e3;
  const old = { density: 'heavy', start: at(11), end: at(10), ...prepared(boxPolygon(1, 3, { widthMiles: 4 })) };
  const fresh = { density: 'light', start: at(3), end: at(2), ...prepared(boxPolygon(0, 5, { widthMiles: 4 })) };
  const withFresh = detectAir(route, { contours: [goodAir()], monitors: [], plumes: [old, fresh] }, { now });
  assert.equal(withFresh.hits.filter(h => h.id === 'smoke:plume').length, 0);
  const onlyOld = detectAir(route, { contours: [goodAir()], monitors: [], plumes: [old] }, { now });
  assert.ok(onlyOld.hits.some(h => h.id === 'smoke:plume'), 'with no newer trace the old heavy one still counts');
  assert.match(onlyOld.hazards.find(h => h.id === 'smoke:plume').title, /seen overhead 10 h ago/);
});

test('HMS KML scanning stays linear on a corrupt file', () => {
  const corrupt = '<Placemark>'.repeat(200000);
  const t = Date.now();
  assert.deepEqual(parseHmsKml(corrupt).plumes, []);
  assert.ok(Date.now() - t < 1000);
});
