import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { haversineMiles } from '../shared/geo.js';
import { stitchSegments, extractLineSegments } from '../shared/trails/stitch.js';
import {
  escapeSqlString,
  sanitizeLikeTerm,
  formatTrailName,
  formatUsfsRegion,
  normalizeUsfsSearchFeatures,
  normalizeNpsSearchFeatures,
  searchPublicTrails,
  fetchPublicTrailGeometry,
  USFS_TRAILS_URL,
  NPS_TRAILS_URL,
} from '../server/sources/trailSearch.js';
import { createApp } from '../server/app.js';
import { createApiRouter } from '../server/api/router.js';
import { searchTrails, fetchTrailTrack, resetFeaturedCache } from '../src/js/api/trails.js';
import { LON, LAT0, dLat, dLon } from './helpers.js';

/** Build a straight north-south polyline from mile `m0` to `m1` at optional east offset. */
const segLine = (m0, m1, { offsetMiles = 0, step = 0.05, ele = null } = {}) => {
  const n = Math.max(1, Math.round(Math.abs(m1 - m0) / step));
  const x = LON + dLon(offsetMiles);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const m = m0 + (m1 - m0) * (i / n);
    const pt = [x, LAT0 + dLat(m)];
    if (ele != null) pt.push(ele + i * 2);
    out.push(pt);
  }
  return out;
};

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const withMockFetch = async (handler, fn) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
};

const withServer = async (app, fn) => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
};

// ------------------------------------------------------------------ stitchSegments

test('stitchSegments: chains in-order contiguous segments without duplicating joint vertices', () => {
  const s1 = segLine(0, 1);
  const s2 = segLine(1, 2.5);
  const s3 = segLine(2.5, 4);
  const res = stitchSegments([s1, s2, s3]);
  assert.ok(res);
  assert.equal(res.segmentsUsed, 3);
  assert.equal(res.totalSegments, 3);
  assert.ok(Math.abs(res.lengthMiles - 4) < 0.02, `expected ~4 mi, got ${res.lengthMiles}`);
  assert.ok(haversineMiles(res.start[0], res.start[1], s1[0][0], s1[0][1]) < 0.001);
  assert.ok(haversineMiles(res.end[0], res.end[1], s3.at(-1)[0], s3.at(-1)[1]) < 0.001);
  // Ensure no consecutive identical points.
  for (let i = 1; i < res.coords.length; i++) {
    const same = res.coords[i][0] === res.coords[i - 1][0] && res.coords[i][1] === res.coords[i - 1][1];
    assert.equal(same, false, 'no duplicate joint vertices');
  }
});

test('stitchSegments: chains shuffled and reversed segments from both ends', () => {
  const s1 = segLine(0, 1.5).reverse(); // reversed first leg
  const s2 = segLine(1.5, 4.5);         // longest middle leg (seed)
  const s3 = segLine(4.5, 6.0).reverse(); // reversed final leg
  const res = stitchSegments([s3, s1, s2]);
  assert.ok(res);
  assert.equal(res.segmentsUsed, 3);
  assert.equal(res.totalSegments, 3);
  assert.ok(Math.abs(res.lengthMiles - 6.0) < 0.03, `expected ~6 mi, got ${res.lengthMiles}`);
  for (let i = 1; i < res.coords.length; i++) {
    const step = haversineMiles(res.coords[i - 1][0], res.coords[i - 1][1], res.coords[i][0], res.coords[i][1]);
    assert.ok(step < 0.1, `unexpected jump of ${step.toFixed(3)} mi at index ${i}`);
  }
});

test('stitchSegments: picks longest continuous component and rejects multi-mile teleport lines', () => {
  // Component A: 5 miles continuous (2 segments)
  const a1 = segLine(0, 2.5, { offsetMiles: 0 });
  const a2 = segLine(2.5, 5.0, { offsetMiles: 0 });
  // Component B: 1.8 miles, located 15 miles away (separate trail with the same name)
  const b1 = segLine(0, 1.8, { offsetMiles: 15 });
  const res = stitchSegments([b1, a1, a2], { maxGapMiles: 0.35 });
  assert.ok(res);
  assert.equal(res.segmentsUsed, 2);
  assert.equal(res.totalSegments, 3);
  assert.ok(Math.abs(res.lengthMiles - 5.0) < 0.03, `expected ~5 mi, got ${res.lengthMiles}`);
  // Every step must stay tiny — never a 15-mile teleport line!
  for (let i = 1; i < res.coords.length; i++) {
    const step = haversineMiles(res.coords[i - 1][0], res.coords[i - 1][1], res.coords[i][0], res.coords[i][1]);
    assert.ok(step < 0.15, `teleport jump detected: ${step.toFixed(2)} mi`);
  }
});

test('stitchSegments: enforces minLengthMiles, drops invalid points, and strips placeholder elevation', () => {
  assert.equal(stitchSegments([]), null);
  assert.equal(stitchSegments([[['bad', null], [999, 999]]]), null);
  assert.equal(stitchSegments([segLine(0, 0.1)], { minLengthMiles: 0.25 }), null);

  // Constant 0 m elevation is stripped; varying elevation is kept.
  const flatZ = segLine(0, 1).map(([lon, lat]) => [lon, lat, 0]);
  const resFlat = stitchSegments([flatZ]);
  assert.ok(resFlat);
  assert.ok(resFlat.coords.every((c) => c.length === 2));

  const realZ = segLine(0, 1, { ele: 1500 });
  const resEle = stitchSegments([realZ]);
  assert.ok(resEle);
  assert.ok(resEle.coords.every((c) => c.length === 3));
});

test('stitchSegments: simplifies tracks exceeding 2500 vertices while preserving length', () => {
  // 3,200 points along a slight zigzag (~16 mi)
  const dense = [];
  for (let i = 0; i <= 3200; i++) {
    const m = i * 0.005;
    const wiggle = Math.sin(i * 0.1) * 0.001;
    dense.push([LON + dLon(wiggle), LAT0 + dLat(m)]);
  }
  const res = stitchSegments([dense]);
  assert.ok(res);
  assert.ok(res.coords.length <= 2500, `expected <= 2500 vertices, got ${res.coords.length}`);
  assert.ok(Math.abs(res.lengthMiles - 16) < 0.3);
});

test('extractLineSegments: unpacks LineString, MultiLineString, and GeometryCollection', () => {
  const segs = extractLineSegments([
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [0, 1]] } },
    { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[1, 1], [1, 2]], [[2, 2], [2, 3]]] } },
    {
      type: 'Feature',
      geometry: {
        type: 'GeometryCollection',
        geometries: [{ type: 'LineString', coordinates: [[3, 3], [3, 4]] }],
      },
    },
  ]);
  assert.equal(segs.length, 4);
});

// ------------------------------------------------------------------ trailSearch.js

test('trailSearch: SQL escaping neutralizes quotes, wildcards, and control chars', () => {
  assert.equal(escapeSqlString("Angel's Landing' OR '1'='1"), "Angel''s Landing'' OR ''1''=''1");
  assert.equal(sanitizeLikeTerm("50% _drop; 'test'\n\t"), "50 drop ''test''");
  assert.equal(escapeSqlString('a'.repeat(200), 50).length, 50);
  assert.equal(formatTrailName('MOUNT WHITNEY'), 'Mount Whitney');
  assert.equal(formatTrailName('WHITNEY PORTAL NRT'), 'Whitney Portal NRT');
  assert.equal(formatTrailName('Bright Angel'), 'Bright Angel');
  assert.equal(formatUsfsRegion('050454'), 'Inyo National Forest, CA');
  assert.equal(formatUsfsRegion('029999'), 'USFS Rocky Mountain Region (CO/WY/SD)');
});

test('trailSearch: normalizes and dedupes USFS multi-district segments and NPS MAPLABEL trails', () => {
  const usfs = normalizeUsfsSearchFeatures([
    {
      type: 'Feature',
      properties: { trail_name: 'WESTERN STATES', trail_no: '16E10', admin_org: '051754', gis_miles: 5.5 },
      geometry: { type: 'LineString', coordinates: segLine(0, 5.5) },
    },
    {
      type: 'Feature',
      properties: { trail_name: 'WESTERN STATES', trail_no: '16E10', admin_org: '051757', gis_miles: 3.3 },
      geometry: { type: 'LineString', coordinates: segLine(5.5, 8.8) },
    },
  ]);
  assert.equal(usfs.length, 1);
  assert.equal(usfs[0].name, 'Western States');
  assert.equal(usfs[0].region, 'Tahoe National Forest, CA');
  assert.equal(usfs[0].agency, 'USFS');
  assert.equal(usfs[0].lengthMiles, 8.8);
  assert.deepEqual(usfs[0].queryMeta, {
    source: 'usfs',
    trailNo: '16E10',
    name: 'WESTERN STATES',
    unit: '0517',
  });

  const nps = normalizeNpsSearchFeatures([
    {
      type: 'Feature',
      properties: { TRLNAME: null, MAPLABEL: 'Beehive Trail', UNITNAME: 'Acadia National Park', UNITCODE: 'ACAD', TRLSTATUS: 'Existing' },
      geometry: { type: 'LineString', coordinates: segLine(0, 0.8) },
    },
    {
      type: 'Feature',
      properties: { TRLNAME: 'Old Closed', UNITNAME: 'Acadia National Park', UNITCODE: 'ACAD', TRLSTATUS: 'Decommissioned' },
      geometry: { type: 'LineString', coordinates: segLine(0, 1.0) },
    },
  ]);
  assert.equal(nps.length, 1);
  assert.equal(nps[0].name, 'Beehive Trail');
  assert.equal(nps[0].agency, 'NPS');
  assert.equal(nps[0].region, 'Acadia National Park');
  assert.equal(nps[0].queryMeta.unit, 'ACAD');
});

test('trailSearch: searchPublicTrails escapes SQL, handles partial outage, and supports proximity', async () => {
  const seenUrls = [];
  await withMockFetch(async (url) => {
    seenUrls.push(String(url));
    if (String(url).startsWith(USFS_TRAILS_URL)) {
      return new Response('Upstream error', { status: 500 });
    }
    if (String(url).startsWith(NPS_TRAILS_URL)) {
      return jsonResponse({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {
              TRLNAME: "Angel's Landing Trail",
              UNITNAME: 'Zion National Park',
              UNITCODE: 'ZION',
              TRLSTATUS: 'Existing',
            },
            geometry: { type: 'LineString', coordinates: segLine(0, 1.2) },
          },
        ],
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }, async () => {
    const res = await searchPublicTrails({ query: "Angel's Landing' OR '1'='1", limit: 10 });
    assert.equal(res.trails.length, 1);
    assert.equal(res.trails[0].source, 'nps');
    assert.match(res.note, /U\.S\. Forest Service.*unavailable/i);

    const npsUrl = new URL(seenUrls.find((u) => u.startsWith(NPS_TRAILS_URL)));
    const where = npsUrl.searchParams.get('where');
    assert.ok(where.includes("ANGEL''S LANDING'' OR ''1''=''1"), `expected escaped single quotes in ${where}`);
  });

  // Spatial "Near me" query sends geometry + distance + units and sorts closest first.
  const spatialUrls = [];
  await withMockFetch(async (url) => {
    spatialUrls.push(String(url));
    if (String(url).startsWith(USFS_TRAILS_URL)) {
      return jsonResponse({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: { trail_name: 'FAR TRAIL', trail_no: '10', admin_org: '050454', gis_miles: 5 },
          geometry: { type: 'LineString', coordinates: segLine(0, 5, { offsetMiles: 8 }) },
        }],
      });
    }
    return jsonResponse({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { TRLNAME: 'Close Trail', UNITNAME: 'Yosemite National Park', UNITCODE: 'YOSE' },
        geometry: { type: 'LineString', coordinates: segLine(0, 2, { offsetMiles: 0.5 }) },
      }],
    });
  }, async () => {
    const res = await searchPublicTrails({ lat: LAT0, lon: LON, radiusMiles: 15 });
    assert.equal(res.note, null);
    assert.equal(res.trails.length, 2);
    assert.equal(res.trails[0].name, 'Close Trail');
    assert.equal(res.trails[1].name, 'Far Trail');
    const u = new URL(spatialUrls[0]);
    assert.equal(u.searchParams.get('geometry'), `${LON},${LAT0}`);
    assert.equal(u.searchParams.get('units'), 'esriSRUnit_StatuteMile');
    assert.equal(u.searchParams.get('distance'), '15');
  });
});

test('trailSearch: fetchPublicTrailGeometry stitches segments and errors cleanly when empty', async () => {
  await withMockFetch(async () => jsonResponse({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: segLine(2, 4).reverse() } },
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: segLine(0, 2) } },
    ],
  }), async () => {
    const res = await fetchPublicTrailGeometry({ source: 'nps', name: 'Bright Angel', unit: 'GRCA' });
    assert.equal(res.name, 'Bright Angel');
    assert.ok(Math.abs(res.lengthMiles - 4) < 0.03);
    assert.ok(res.coords.length >= 2);
  });

  await withMockFetch(async () => jsonResponse({ type: 'FeatureCollection', features: [] }), async () => {
    await assert.rejects(
      fetchPublicTrailGeometry({ source: 'nps', name: 'Missing Trail', unit: 'GRCA' }),
      (err) => err.code === 'trail_not_found' && /No public trail geometry/i.test(err.message),
    );
  });
});

// ------------------------------------------------------------------ Express API router

test('api: /api/trails/search and /api/trails/geometry validate inputs cleanly', async () => {
  await withServer(createApp({ analyze: async () => ({}) }), async (base) => {
    const empty = await fetch(`${base}/api/trails/search`);
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).code, 'invalid_query');

    const tooShort = await fetch(`${base}/api/trails/search?q=a`);
    assert.equal(tooShort.status, 400);
    assert.equal((await tooShort.json()).code, 'invalid_query');

    const halfLoc = await fetch(`${base}/api/trails/search?lat=37.7`);
    assert.equal(halfLoc.status, 400);
    assert.equal((await halfLoc.json()).code, 'invalid_location');

    const badLat = await fetch(`${base}/api/trails/search?lat=999&lon=-119.5`);
    assert.equal(badLat.status, 400);
    assert.equal((await badLat.json()).code, 'invalid_location');

    const badRadius = await fetch(`${base}/api/trails/search?q=yosemite&radius=-5`);
    assert.equal(badRadius.status, 400);
    assert.equal((await badRadius.json()).code, 'invalid_query');

    const badSource = await fetch(`${base}/api/trails/geometry?source=osm&name=Test`);
    assert.equal(badSource.status, 400);
    assert.equal((await badSource.json()).code, 'invalid_source');

    const missingName = await fetch(`${base}/api/trails/geometry?source=nps`);
    assert.equal(missingName.status, 400);
    assert.equal((await missingName.json()).code, 'invalid_trail');
  });
});

test('api: /api/trails/search and /api/trails/geometry return results and map 404s cleanly', async () => {
  const app = express();
  app.use('/api', createApiRouter({
    analyze: async () => ({}),
    searchTrails: async ({ query }) => ({
      trails: [{ id: 'nps:GRCA:bright-angel', name: `Match ${query}`, agency: 'NPS', source: 'nps', lengthMiles: 7.9 }],
      note: null,
    }),
    fetchTrailGeometry: async ({ name }) => {
      if (name === 'Missing') {
        const err = new Error('No geometry');
        err.code = 'trail_not_found';
        throw err;
      }
      return { name, coords: segLine(0, 2), lengthMiles: 2 };
    },
  }));

  await withServer(app, async (base) => {
    const search = await fetch(`${base}/api/trails/search?q=bright`);
    assert.equal(search.status, 200);
    const sBody = await search.json();
    assert.equal(sBody.trails.length, 1);
    assert.equal(sBody.note, null);

    const geom = await fetch(`${base}/api/trails/geometry?source=nps&name=Bright%20Angel&unit=GRCA`);
    assert.equal(geom.status, 200);
    const gBody = await geom.json();
    assert.equal(gBody.name, 'Bright Angel');
    assert.equal(gBody.lengthMiles, 2);
    assert.ok(Array.isArray(gBody.coords) && gBody.coords.length >= 2);

    const missing = await fetch(`${base}/api/trails/geometry?source=nps&name=Missing`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'trail_not_found');
  });
});

// ------------------------------------------------------------------ Client trails.js contract

test('client trails API: featured merge, saved filter, live search dedupe, and fetchTrailTrack', async () => {
  resetFeaturedCache();
  const featuredFixture = {
    version: 1,
    trails: [
      {
        id: 'nps:GRCA:bright-angel',
        name: 'Bright Angel Trail',
        region: 'Grand Canyon National Park, AZ',
        agency: 'NPS',
        lengthMiles: 7.9,
        gainFt: 4380,
        source: 'nps',
        featured: true,
        start: [-112.14, 36.05],
        queryMeta: { source: 'nps', trailNo: null, name: 'Bright Angel', unit: 'GRCA' },
      },
    ],
  };

  const savedRoutes = [
    {
      id: 'abc1234567890def',
      name: 'Bright Angel Trail',
      meta: { lengthMiles: 7.9, trailId: 'nps:GRCA:bright-angel' },
      offlinePack: { savedAt: Date.now() },
      lastCheck: { summary: { level: 2 } },
    },
  ];

  await withMockFetch(async (url) => {
    const s = String(url);
    if (s === '/data/featured-trails.json') return jsonResponse(featuredFixture);
    if (s.startsWith('/api/trails/search')) {
      return jsonResponse({
        trails: [
          {
            id: 'nps:GRCA:bright-angel',
            name: 'Bright Angel',
            region: 'Grand Canyon National Park',
            agency: 'NPS',
            lengthMiles: 7.9,
            gainFt: null,
            source: 'nps',
            start: [-112.14, 36.05],
            queryMeta: { source: 'nps', trailNo: null, name: 'Bright Angel', unit: 'GRCA' },
          },
          {
            id: 'nps:GRCA:south-kaibab',
            name: 'South Kaibab Trail',
            region: 'Grand Canyon National Park',
            agency: 'NPS',
            lengthMiles: 6.4,
            gainFt: null,
            source: 'nps',
            start: [-112.08, 36.05],
            queryMeta: { source: 'nps', trailNo: null, name: 'South Kaibab', unit: 'GRCA' },
          },
        ],
        note: null,
      });
    }
    if (s.startsWith('/api/trails/geometry')) {
      return jsonResponse({ name: 'Bright Angel', coords: segLine(0, 7.9), lengthMiles: 7.9 });
    }
    throw new Error(`Unexpected fetch: ${s}`);
  }, async () => {
    // Saved filter
    const saved = await searchTrails({ filter: 'saved', query: 'bright', savedRoutes });
    assert.equal(saved.trails.length, 1);
    assert.equal(saved.trails[0].savedId, 'abc1234567890def');
    assert.equal(saved.trails[0].offlineReady, true);
    assert.equal(saved.trails[0].level, 2);

    // Featured filter merges saved offline status
    const feat = await searchTrails({ filter: 'featured', savedRoutes });
    assert.equal(feat.trails.length, 1);
    assert.equal(feat.trails[0].featured, true);
    assert.equal(feat.trails[0].savedId, 'abc1234567890def');
    assert.equal(feat.trails[0].offlineReady, true);
    assert.equal(feat.trails[0].level, 2);

    // Live search merges & dedupes featured Bright Angel with live Bright Angel + adds South Kaibab
    const searched = await searchTrails({ query: 'bright', filter: 'featured', savedRoutes });
    assert.equal(searched.trails.length, 2);
    assert.equal(searched.trails[0].featured, true);
    assert.equal(searched.trails[0].gainFt, 4380);
    assert.equal(searched.trails[1].id, 'nps:GRCA:south-kaibab');

    // fetchTrailTrack via queryMeta
    const track = await fetchTrailTrack(searched.trails[0]);
    assert.equal(track.name, 'Bright Angel Trail');
    assert.ok(track.coords.length >= 2);
  });
});

// ------------------------------------------------------------------ Static assets sanity

test('static assets: featured-trails.json, docs/endpoints.json, and docs/privacy.html are valid', () => {
  const featured = JSON.parse(fs.readFileSync(new URL('../public/data/featured-trails.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(featured.trails) && featured.trails.length >= 7);
  assert.equal(featured.trails[0].sampleUrl, '/samples/jmt-yosemite.gpx');
  assert.ok(fs.existsSync(new URL('../public/samples/jmt-yosemite.gpx', import.meta.url)));
  for (const trail of featured.trails.slice(1)) {
    assert.ok(trail.queryMeta?.source === 'nps' || trail.queryMeta?.source === 'usfs');
    assert.ok(trail.queryMeta?.name);
  }

  const endpoints = JSON.parse(fs.readFileSync(new URL('../docs/endpoints.json', import.meta.url), 'utf8'));
  assert.ok(endpoints.version >= 1);
  assert.ok(Date.parse(endpoints.updatedAt) > 0);
  for (const key of ['nifc', 'airnow', 'nwps', 'nws', 'usfsTrails', 'npsTrails']) {
    assert.ok(endpoints.endpoints[key], `missing endpoint entry: ${key}`);
  }

  const privacy = fs.readFileSync(new URL('../docs/privacy.html', import.meta.url), 'utf8');
  assert.match(privacy, /No accounts/i);
  assert.match(privacy, /No analytics/i);
  assert.match(privacy, /AGPL-3\.0/i);
  assert.match(privacy, /https:\/\/github\.com\/TheUnknownKnight\/ridgeline/);
  assert.match(privacy, /Backcountry Safety Notice/i);
});
