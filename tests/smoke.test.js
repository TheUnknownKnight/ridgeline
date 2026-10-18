/**
 * Smoke and air quality: AQI conversion, NOAA's satellite plume KML, the
 * measured-air detector, the engine's coverage rules and the NOAA → CAMS
 * forecast fallback (network stubbed).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pm25ToAqi, peakAqi } from '../server/sources/naqfc.js';
import { parseHmsKml, parseHmsTime } from '../server/sources/hms.js';
import { detectAir, CATEGORY_LEVEL } from '../server/fusion/detectors/air.js';
import { analyze } from '../server/fusion/engine.js';
import { validateAnalyzeRequest } from '../server/lib/validate.js';
import { sourceCache } from '../server/lib/cache.js';
import { loadSmoke } from '../server/sources/smokeForecast.js';
import {
  buildRoute, boxPolygon, prepared, goodAir, fakeSources, okSource, errorSource, straightCoords, LON, LAT0, dLat, dLon,
} from './helpers.js';

test('pm25ToAqi follows the 2024 EPA breakpoints', () => {
  assert.equal(pm25ToAqi(0), 0);
  assert.equal(pm25ToAqi(9.0), 50);
  assert.equal(pm25ToAqi(9.1), 51);
  assert.equal(pm25ToAqi(35.4), 100);
  assert.equal(pm25ToAqi(35.5), 101);
  assert.equal(pm25ToAqi(55.5), 151);
  assert.equal(pm25ToAqi(125.5), 201);
  assert.equal(pm25ToAqi(225.5), 301);
  assert.equal(pm25ToAqi(900), 500);
  assert.equal(pm25ToAqi(-1), null);
});

test('peakAqi smooths a single-hour spike before converting', () => {
  const t0 = Date.UTC(2026, 9, 18, 0);
  const series = [5, 5, 200, 5, 5].map((pm25, i) => ({ at: t0 + i * 3 * 3600e3, pm25 }));
  const peak = peakAqi(series);
  // A 200 µg/m³ hour alone would be AQI ~250; over ~9 h it averages to 70 µg/m³.
  assert.equal(peak.pm25, 70);
  assert.equal(peak.aqi, pm25ToAqi(70));
  assert.equal(peak.at, t0 + 2 * 3 * 3600e3);
});

const KML = `<?xml version="1.0"?><kml><Document>
<Placemark><description><![CDATA[Start Time: 2026289 1200UTC<br>End Time: 2026289 1500UTC<br>Density: Light]]></description>
<styleUrl>#Smoke_Light_style</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>
-120.1,37.0,0 -119.9,37.0,0 -119.9,37.2,0 -120.1,37.2,0 -120.1,37.0,0
</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark><description><![CDATA[Start Time: 2026289 2000UTC<br>End Time: 2026289 2300UTC<br>Density: Heavy]]></description>
<styleUrl>#Smoke_Heavy_style</styleUrl><MultiGeometry><Polygon><outerBoundaryIs><LinearRing><coordinates>
-120.05,37.05 -119.95,37.05 -119.95,37.1 -120.05,37.1 -120.05,37.05
</coordinates></LinearRing></outerBoundaryIs></Polygon></MultiGeometry></Placemark>
<Placemark><styleUrl>#Fire_style</styleUrl><Point><coordinates>-120,37</coordinates></Point></Placemark>
</Document></kml>`;

test('HMS KML: densities, times and polygons; non-smoke placemarks ignored', () => {
  assert.equal(parseHmsTime('2026289 1200UTC'), Date.UTC(2026, 9, 16, 12, 0));
  const { plumes } = parseHmsKml(KML);
  assert.equal(plumes.length, 2);
  assert.deepEqual(plumes.map(p => p.density), ['light', 'heavy']);
  assert.equal(plumes[1].end, Date.UTC(2026, 9, 16, 23, 0));
  assert.ok(plumes[0].bbox[0] <= -120.1 + 1e-9 && plumes[0].bbox[3] >= 37.2 - 1e-9);
});

const contour = (m0, m1, category) => prepared(boxPolygon(m0, m1, { widthMiles: 2 }), { category });

test('air: an unhealthy AirNow area on the trail is an official hazard over exactly those miles', async () => {
  const route = await buildRoute(10);
  const r = detectAir(route, { contours: [goodAir(), contour(3, 5, 4)], monitors: [], plumes: [] }, {});
  assert.equal(r.checkedChunks.size, route.chunks.length, 'the good contour covers every mile');
  const hits = r.hits.filter(h => h.id === 'air:pm25');
  assert.ok(hits.length >= 2);
  assert.ok(hits.every(h => h.level === CATEGORY_LEVEL[4] && h.level === 2));
  assert.ok(hits.every(h => route.chunks[h.chunk].end >= 3 && route.chunks[h.chunk].start <= 5));
  assert.equal(r.hazards[0].source, 'OFFICIAL');
  assert.equal(r.hazards[0].title, 'Unhealthy air quality');
  assert.ok(r.overlays.some(o => o.properties.overlay === 'air-area' && o.properties.level === 2));
});

test('air: stretches outside every contour are not checked, never clear', async () => {
  const route = await buildRoute(10);
  const r = detectAir(route, { contours: [contour(0, 4, 1)], monitors: [], plumes: [] }, {});
  assert.ok(r.checkedChunks.has(0));
  assert.ok(!r.checkedChunks.has(8), 'mile 8 is outside the only contour');
  assert.equal(r.hazards.length, 0);
});

test('air: a monitor right by the trail overrides a smoothed "good" contour', async () => {
  const route = await buildRoute(20);
  const monitor = { id: 'X', name: 'Fire camp', agency: 'Forest Service', aqi: 180, category: 4, at: Date.UTC(2026, 9, 17, 22), lon: LON + dLon(1), lat: LAT0 + dLat(10) };
  const far = { ...monitor, id: 'Y', name: 'Far town', aqi: 250, category: 5, lon: LON + dLon(18) };
  const r = detectAir(route, { contours: [goodAir()], monitors: [monitor, far], plumes: [] }, {});
  const miles = r.hits.map(h => route.chunks[h.chunk].start);
  assert.ok(Math.min(...miles) >= 7 && Math.max(...miles) <= 13, 'only chunks within 3 mi of the monitor');
  assert.match(r.hazards[0].detail, /Unhealthy air measured at Fire camp \(Forest Service\), 1\.0 mi from the trail: AQI 180/);
  assert.ok(r.overlays.some(o => o.properties.overlay === 'air-monitor' && o.properties.level === 2));
  assert.ok(!r.overlays.some(o => o.properties.title?.startsWith('Far town')), 'monitors beyond 15 mi stay off the map');
});

test('air: heavy satellite smoke over the trail is a low note; light smoke is map context only', async () => {
  const route = await buildRoute(10);
  const plume = (m0, m1, density) => ({ density, start: Date.now() - 3 * 3600e3, end: Date.now() - 3600e3, ...prepared(boxPolygon(m0, m1, { widthMiles: 4 })) });
  const r = detectAir(route, { contours: [goodAir()], monitors: [], plumes: [plume(1, 3, 'heavy'), plume(6, 9, 'light')] }, {});
  const plumeHits = r.hits.filter(h => h.id === 'smoke:plume');
  assert.ok(plumeHits.length > 0 && plumeHits.every(h => h.level === 1 && route.chunks[h.chunk].start < 4));
  assert.equal(r.hazards.find(h => h.id === 'smoke:plume').title, 'Heavy smoke overhead');
  assert.equal(r.overlays.filter(o => o.properties.overlay === 'smoke-plume').length, 2);
});

test('engine: AirNow down marks the route incomplete and leaves air unchecked', async () => {
  const r = await analyze(validateAnalyzeRequest({ coordinates: straightCoords(5) }), {
    sources: fakeSources({ loadAir: async () => errorSource({ contours: [], monitors: [], plumes: [] }) }),
  });
  assert.equal(r.summary.incomplete, true);
  assert.deepEqual(r.summary.incompleteSources, ['air']);
  assert.ok(r.segments.every(s => !s.checked.includes('air')));
});

test('engine: with AirNow up, every mile in its coverage lists air as checked', async () => {
  const r = await analyze(validateAnalyzeRequest({ coordinates: straightCoords(5) }), { sources: fakeSources() });
  assert.ok(r.segments.every(s => s.checked.includes('air')));
  assert.equal(r.summary.incomplete, false);
});

test('engine: AirNow coverage counts outside the US where its contours reach', async () => {
  // A route north of the border: US-only sources are out, AirNow's contour still covers it.
  const coords = Array.from({ length: 101 }, (_, i) => [-116.0, 51.0 + i * 0.0007]);
  const canada = prepared({ type: 'Polygon', coordinates: [[[-117, 50], [-115, 50], [-115, 52], [-117, 52], [-117, 50]]] }, { category: 1 });
  const r = await analyze(validateAnalyzeRequest({ coordinates: coords }), {
    sources: fakeSources({ loadAir: async () => okSource({ contours: [canada], monitors: [], plumes: [] }) }),
  });
  assert.ok(r.summary.outsideCoverage);
  assert.ok(r.segments.every(s => s.checked.includes('air') && !s.checked.includes('fire')));
});

// ---------------------------------------------------------------- forecast fallback

const stubFetch = (handler) => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  return () => { globalThis.fetch = real; };
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const samples = (n) => Array.from({ length: n }, (_, i) => ({ mile: i * 2, lat: 37 + i * 0.1, lon: -119.5 }));

test('smoke forecast: NOAA values become peak AQI per point', async () => {
  sourceCache.clear();
  const now = Date.UTC(2026, 9, 18, 0);
  const issued = now - 6 * 3600e3;
  // A complete 72-hour run issued 6 h ago.
  const rasters = Array.from({ length: 72 }, (_, i) => ({ attributes: { objectid: 100 + i, idp_validtime: issued + (i + 1) * 3600e3, idp_issueddate: issued } }));
  const timeOf = new Map(rasters.map(r => [r.attributes.objectid, r.attributes.idp_validtime]));
  const restore = stubFetch((url, init) => {
    if (url.includes('/ImageServer/query')) return json({ features: [...rasters, { attributes: { objectid: 9, idp_validtime: null, idp_issueddate: null } }] });
    if (url.includes('/getSamples')) {
      const body = new URLSearchParams(init.body);
      const ids = JSON.parse(body.get('mosaicRule')).lockRasterIds;
      const points = JSON.parse(body.get('geometry')).points;
      assert.ok(ids.length <= 20 && !ids.includes(9), 'only the latest run, at most 20 steps, no junk rows');
      return json({ samples: points.flatMap((_, loc) => ids.map((id) => ({ locationId: loc, value: loc === 0 ? '60.0' : '4.0', attributes: { idp_validtime: timeOf.get(id) } }))) });
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const r = await loadSmoke({ samples: samples(2), now });
    assert.equal(r.status, 'ok');
    assert.equal(r.data.points[0].aq.model, 'noaa');
    assert.equal(r.data.points[0].aq.aqi, pm25ToAqi(60));
    assert.equal(r.data.points[1].aq.aqi, pm25ToAqi(4));
    assert.match(r.message, /NOAA 5 km PM2\.5 forecast for 2 points/);
  } finally {
    restore();
  }
});

test('smoke forecast: NOAA down falls back to CAMS, and says so', async () => {
  sourceCache.clear();
  const now = Date.UTC(2026, 9, 18, 0);
  const nowSec = now / 1000;
  const restore = stubFetch((url) => {
    if (url.includes('mapservices.weather.noaa.gov')) return json({ error: 'down' }, 503);
    if (url.includes('air-quality-api.open-meteo.com')) {
      const n = new URL(url).searchParams.get('latitude').split(',').length;
      const loc = { hourly: { time: [nowSec, nowSec + 3600], us_aqi_pm2_5: [40, 160] } };
      return json(n === 1 ? loc : Array.from({ length: n }, () => loc));
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const r = await loadSmoke({ samples: samples(3), now });
    assert.equal(r.status, 'ok');
    assert.ok(r.data.points.every(p => p.aq?.model === 'cams' && p.aq.aqi === 160));
    assert.match(r.message, /CAMS global model PM2\.5 forecast for 3 points \(NOAA forecast unavailable\)/);
  } finally {
    restore();
  }
});

test('smoke forecast: both services down is an error, never a clear', async () => {
  sourceCache.clear();
  const restore = stubFetch(() => json({ error: 'down' }, 503));
  try {
    const r = await loadSmoke({ samples: samples(2), now: Date.UTC(2026, 9, 18, 0) });
    assert.equal(r.status, 'error');
    assert.ok(r.data.points.every(p => p.aq == null));
  } finally {
    restore();
  }
});
