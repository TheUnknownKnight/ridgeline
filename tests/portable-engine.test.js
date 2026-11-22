/**
 * Portable on-device engine tests:
 * - Web-standard async PNG decoding on Uint8Array / ArrayBuffer
 * - Custom HTTP transport hook (`setHttpTransport`) + zero-Buffer HTTP client
 * - Remote endpoint overrides (`setEndpointOverrides` / `endpointUrl`) & browser-safe config
 * - Corridor-scoped queries (`scope: 'corridor'`) on NIFC, AirNow, NWPS, and NWS Alerts
 * - Local engine wrapper (`analyzeLocally`, `loadRemoteEndpoints`) and native client routing
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import config, { setEndpointOverrides, endpointUrl } from '../server/config.js';
import { decodePng } from '../server/lib/png.js';
import { fetchJson, fetchText, fetchBuffer, setHttpTransport, circuitOpenFor } from '../server/lib/http.js';
import { sourceCache } from '../server/lib/cache.js';
import { loadFire } from '../server/sources/nifc.js';
import { loadAir } from '../server/sources/airnow.js';
import { loadWater } from '../server/sources/nwps.js';
import { loadAlerts } from '../server/sources/nwsAlerts.js';
import { loadSnow, clearSnowFailures } from '../server/sources/snodas.js';
import { analyze } from '../server/fusion/engine.js';
import { validateAnalyzeRequest } from '../server/lib/validate.js';
import { analyzeLocally, loadRemoteEndpoints } from '../src/js/engine/localEngine.js';
import { analyzeRoute, setAnalysisRunner, isNativeRuntime } from '../src/js/api/client.js';
import { buildRoute, straightCoords, fakeSources, LON, LAT0 } from './helpers.js';

const stubFetch = (handler) => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  return () => { globalThis.fetch = real; };
};

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// --------------------------------------------------------------------- PNG builder (pure Uint8Array)

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
};

const concatUint8 = (parts) => {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
};

const buildSamplePng = ({ colorType = 6, bitDepth = 8, interlace = 0, includePlte = false, rawScanlines } = {}) => {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, 2, false);
  iv.setUint32(4, 2, false);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  const chunks = [sig, pngChunk('IHDR', ihdr)];
  if (includePlte) chunks.push(pngChunk('PLTE', new Uint8Array([10, 20, 30, 200, 100, 50])));
  if (rawScanlines) chunks.push(pngChunk('IDAT', new Uint8Array(deflateSync(rawScanlines))));
  chunks.push(pngChunk('IEND', new Uint8Array(0)));
  return concatUint8(chunks);
};

// --------------------------------------------------------------------- Config & Endpoint Overrides

test('config: default userAgent carries repository contact URL and endpointUrl resolves overrides safely', () => {
  assert.match(config.userAgent, /^Ridgeline\/2\.0 \(backcountry route hazard checker; .+\)$/);
  if (!process.env.CONTACT_EMAIL) {
    assert.equal(config.userAgent, 'Ridgeline/2.0 (backcountry route hazard checker; https://github.com/TheUnknownKnight/ridgeline)');
  }
  const fallback = 'https://federal.example.gov/default';
  try {
    setEndpointOverrides(null);
    assert.equal(endpointUrl('nifcPerimeters', fallback), fallback);

    setEndpointOverrides({
      nifcPerimeters: 'https://override.example.gov/perimeters',
      badScheme: 'javascript:alert(1)',
      empty: '   ',
      nonString: 42,
    });
    assert.equal(endpointUrl('nifcPerimeters', fallback), 'https://override.example.gov/perimeters');
    assert.equal(endpointUrl('badScheme', fallback), fallback);
    assert.equal(endpointUrl('empty', fallback), fallback);
    assert.equal(endpointUrl('nonString', fallback), fallback);
    assert.equal(endpointUrl('missing', fallback), fallback);
  } finally {
    setEndpointOverrides(null);
  }
  assert.equal(endpointUrl('nifcPerimeters', fallback), fallback);
});

// --------------------------------------------------------------------- Async Portable PNG Decoder

test('png: async decodePng decodes pure Uint8Array, ArrayBuffer, and non-zero byteOffset views', async () => {
  // 2x2 RGBA: row 0 filter=0, row 1 filter=2 (Up)
  const raw = new Uint8Array([
    0, 10, 20, 30, 255, 40, 50, 60, 128,
    2, 5, 5, 5, 0, 10, 10, 10, 100,
  ]);
  const bytes = buildSamplePng({ colorType: 6, rawScanlines: raw });

  const fromUint8 = await decodePng(bytes);
  assert.equal(fromUint8.width, 2);
  assert.equal(fromUint8.height, 2);
  assert.deepEqual(fromUint8.rgba(0, 0), [10, 20, 30, 255]);
  assert.deepEqual(fromUint8.rgba(1, 0), [40, 50, 60, 128]);
  assert.deepEqual(fromUint8.rgba(0, 1), [15, 25, 35, 255]);
  assert.deepEqual(fromUint8.rgba(1, 1), [50, 60, 70, 228]);
  assert.equal(fromUint8.rgba(-1, 0), null);

  // ArrayBuffer input
  const fromArrayBuffer = await decodePng(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.deepEqual(fromArrayBuffer.rgba(1, 1), [50, 60, 70, 228]);

  // Subarray with non-zero byteOffset
  const padded = new Uint8Array(bytes.byteLength + 17);
  padded.set(bytes, 7);
  const view = padded.subarray(7, 7 + bytes.byteLength);
  assert.equal(view.byteOffset, 7);
  const fromView = await decodePng(view);
  assert.deepEqual(fromView.rgba(0, 0), [10, 20, 30, 255]);

  // Validation error contracts
  await assert.rejects(() => decodePng(new Uint8Array([1, 2, 3])), /not a PNG/);
  await assert.rejects(() => decodePng(buildSamplePng({ interlace: 1, rawScanlines: raw })), /interlaced PNG not supported/);
  await assert.rejects(() => decodePng(buildSamplePng({ bitDepth: 16, rawScanlines: raw })), /unsupported PNG/);
  await assert.rejects(() => decodePng(buildSamplePng({ colorType: 3, includePlte: false, rawScanlines: new Uint8Array([0, 0, 0, 0, 0, 0]) })), /indexed PNG without a palette/);
  await assert.rejects(() => decodePng(buildSamplePng({ colorType: 6, rawScanlines: new Uint8Array([0, 1, 2]) })), /truncated PNG/);
});

// --------------------------------------------------------------------- Custom HTTP Transport

test('http: setHttpTransport intercepts JSON/text/buffer requests, enforces 429 circuit breaker, and resets cleanly', async () => {
  const calls = [];
  setHttpTransport(async (url, opts) => {
    calls.push({ url, ...opts });
    if (url.includes('/json')) return { status: 200, headers: {}, data: { hello: 'mobile' } };
    if (url.includes('/text')) return { status: 200, headers: {}, data: '<kml/>' };
    if (url.includes('/bin-b64')) return { status: 200, headers: {}, data: btoa('PNG!') };
    if (url.includes('/bin-u8')) return { status: 200, headers: {}, data: new Uint8Array([9, 8, 7]) };
    if (url.includes('/rate')) return { status: 429, headers: { 'Retry-After': '15' }, data: 'slow down' };
    return { status: 404, headers: {}, data: 'missing' };
  });

  try {
    const j = await fetchJson('https://transport-test.invalid/json', { headers: { 'X-Test': '1' } });
    assert.deepEqual(j, { hello: 'mobile' });
    assert.equal(calls[0].as, 'json');
    assert.equal(calls[0].headers['User-Agent'], config.userAgent);
    assert.equal(calls[0].headers['X-Test'], '1');

    const t = await fetchText('https://transport-test.invalid/text');
    assert.equal(t, '<kml/>');

    const b1 = await fetchBuffer('https://transport-test.invalid/bin-b64');
    assert.ok(b1 instanceof Uint8Array);
    assert.deepEqual([...b1], [80, 78, 71, 33]);

    const b2 = await fetchBuffer('https://transport-test.invalid/bin-u8');
    assert.ok(b2 instanceof Uint8Array);
    assert.deepEqual([...b2], [9, 8, 7]);

    const before429 = calls.length;
    await assert.rejects(() => fetchJson('https://rate-limit-transport.invalid/rate', { retries: 2 }), (e) => e.status === 429);
    assert.equal(calls.length - before429, 1, '429 is never retried');
    assert.ok(circuitOpenFor('https://rate-limit-transport.invalid/rate'));
    await assert.rejects(() => fetchJson('https://rate-limit-transport.invalid/rate'), (e) => e.status === 429);
    assert.equal(calls.length - before429, 1, 'open circuit short-circuits transport');
  } finally {
    setHttpTransport(null);
  }

  // After clearing transport, standard fetch is used again
  const restore = stubFetch((url) => jsonRes({ via: 'fetch', url }));
  try {
    const res = await fetchJson('https://fetch-restored.invalid/ok');
    assert.equal(res.via, 'fetch');
  } finally {
    restore();
  }
});

// --------------------------------------------------------------------- Corridor-Scoped Loaders

test('nifc: scope="corridor" sends 15 mi ArcGIS envelope spatial params, tolerates 0 incidents, and honors endpointUrl', async () => {
  sourceCache.clear();
  const route = await buildRoute(10);
  const seen = [];
  setEndpointOverrides({
    nifcPerimeters: 'https://custom-nifc.invalid/perimeters/query',
    nifcIncidents: 'https://custom-nifc.invalid/incidents/query',
  });
  const restore = stubFetch((url) => {
    seen.push(new URL(url));
    return jsonRes({ type: 'FeatureCollection', features: [] });
  });
  try {
    const res = await loadFire({ route, scope: 'corridor' });
    assert.equal(res.status, 'ok', '0 incidents in a route corridor is valid');
    assert.deepEqual(res.data, { perimeters: [], incidents: [] });
    assert.equal(seen.length, 2);
    assert.ok(seen.some(u => u.href.startsWith('https://custom-nifc.invalid/perimeters/query')));
    assert.ok(seen.some(u => u.href.startsWith('https://custom-nifc.invalid/incidents/query')));

    for (const u of seen) {
      assert.equal(u.searchParams.get('geometryType'), 'esriGeometryEnvelope');
      assert.equal(u.searchParams.get('spatialRel'), 'esriSpatialRelIntersects');
      assert.equal(u.searchParams.get('inSR'), '4326');
      const geom = JSON.parse(u.searchParams.get('geometry'));
      assert.equal(geom.spatialReference.wkid, 4326);
      assert.ok(geom.xmin < route.paddedBbox[0] - 0.15, 'xmin padded by >= 15 mi');
      assert.ok(geom.ymin < route.paddedBbox[1] - 0.15, 'ymin padded by >= 15 mi');
      assert.ok(geom.xmax > route.paddedBbox[2] + 0.15, 'xmax padded by >= 15 mi');
      assert.ok(geom.ymax > route.paddedBbox[3] + 0.15, 'ymax padded by >= 15 mi');
    }

    // Second corridor call hits bbox-derived cache
    await loadFire({ route, scope: 'corridor' });
    assert.equal(seen.length, 2, 'bbox-derived cache hit avoids refetch');

    // Nationwide default omits geometry and rejects empty incidents
    setEndpointOverrides(null);
    const nationwideUrls = [];
    const restoreNat = stubFetch((url) => {
      nationwideUrls.push(new URL(url));
      return jsonRes({ type: 'FeatureCollection', features: [] });
    });
    try {
      const nat = await loadFire();
      assert.equal(nat.status, 'error', 'nationwide empty incidents still treated as upstream glitch');
      assert.ok(nationwideUrls.every(u => u.searchParams.get('geometry') === null));
    } finally {
      restoreNat();
    }
  } finally {
    setEndpointOverrides(null);
    restore();
  }
});

test('airnow: scope="corridor" sends 30 mi ArcGIS envelope spatial params on contours & monitors and allows empty contours', async () => {
  sourceCache.clear();
  const route = await buildRoute(10);
  const now = Date.now();
  const airUrls = [];
  setEndpointOverrides({
    airnowContours: 'https://custom-air.invalid/contours/query',
    airnowMonitors: 'https://custom-air.invalid/monitors/query',
  });
  const restore = stubFetch((url) => {
    if (url.includes('satepsanone')) return new Response('<kml><Document></Document></kml>', { status: 200 });
    airUrls.push(new URL(url));
    return jsonRes({ type: 'FeatureCollection', features: [] });
  });
  try {
    const res = await loadAir({ route, now, scope: 'corridor' });
    assert.equal(res.status, 'ok', 'corridor with no contours/monitors returns ok without throwing');
    assert.deepEqual(res.data.contours, []);
    assert.deepEqual(res.data.monitors, []);
    assert.equal(airUrls.length, 2);
    assert.ok(airUrls.some(u => u.href.startsWith('https://custom-air.invalid/contours/query')));
    assert.ok(airUrls.some(u => u.href.startsWith('https://custom-air.invalid/monitors/query')));

    for (const u of airUrls) {
      assert.equal(u.searchParams.get('geometryType'), 'esriGeometryEnvelope');
      assert.equal(u.searchParams.get('spatialRel'), 'esriSpatialRelIntersects');
      assert.equal(u.searchParams.get('inSR'), '4326');
      const geom = JSON.parse(u.searchParams.get('geometry'));
      assert.equal(geom.spatialReference.wkid, 4326);
      assert.ok(geom.xmin < route.paddedBbox[0] - 0.35, 'xmin padded by >= 30 mi');
      assert.ok(geom.ymin < route.paddedBbox[1] - 0.35, 'ymin padded by >= 30 mi');
      assert.ok(geom.xmax > route.paddedBbox[2] + 0.35, 'xmax padded by >= 30 mi');
      assert.ok(geom.ymax > route.paddedBbox[3] + 0.35, 'ymax padded by >= 30 mi');
    }

    // Nationwide default still omits geometry and rejects empty contours
    setEndpointOverrides(null);
    const natUrls = [];
    const restoreNat = stubFetch((url) => {
      if (url.includes('satepsanone')) return new Response('<kml><Document></Document></kml>', { status: 200 });
      natUrls.push(new URL(url));
      return jsonRes({ type: 'FeatureCollection', features: [] });
    });
    try {
      const nat = await loadAir({ now });
      assert.equal(nat.status, 'error');
      assert.ok(natUrls.every(u => u.searchParams.get('geometry') === null));
    } finally {
      restoreNat();
    }
  } finally {
    setEndpointOverrides(null);
    restore();
  }
});

test('nwps: scope="corridor" sends 5 mi ArcGIS envelope spatial params on observed & forecast layers and honors endpointUrl', async () => {
  sourceCache.clear();
  const route = await buildRoute(10);
  const seen = [];
  setEndpointOverrides({ nwpsService: 'https://custom-nwps.invalid/riv_gauges/MapServer' });
  const restore = stubFetch((url) => {
    seen.push(new URL(url));
    return jsonRes({ type: 'FeatureCollection', features: [] });
  });
  try {
    const res = await loadWater({ route, scope: 'corridor' });
    assert.equal(res.status, 'ok');
    assert.equal(seen.length, 2);
    assert.ok(seen.some(u => u.href.startsWith('https://custom-nwps.invalid/riv_gauges/MapServer/0/query')));
    assert.ok(seen.some(u => u.href.startsWith('https://custom-nwps.invalid/riv_gauges/MapServer/7/query')));

    for (const u of seen) {
      assert.equal(u.searchParams.get('geometryType'), 'esriGeometryEnvelope');
      assert.equal(u.searchParams.get('spatialRel'), 'esriSpatialRelIntersects');
      assert.equal(u.searchParams.get('inSR'), '4326');
      const geom = JSON.parse(u.searchParams.get('geometry'));
      assert.equal(geom.spatialReference.wkid, 4326);
      assert.ok(geom.xmin < route.paddedBbox[0] - 0.05, 'xmin padded by >= 5 mi');
      assert.ok(geom.xmax > route.paddedBbox[2] + 0.05, 'xmax padded by >= 5 mi');
    }

    // Nationwide omits geometry
    setEndpointOverrides(null);
    const natUrls = [];
    const restoreNat = stubFetch((url) => {
      natUrls.push(new URL(url));
      return jsonRes({ type: 'FeatureCollection', features: [] });
    });
    try {
      const nat = await loadWater();
      assert.equal(nat.status, 'ok');
      assert.ok(natUrls.every(u => u.searchParams.get('geometry') === null));
    } finally {
      restoreNat();
    }
  } finally {
    setEndpointOverrides(null);
    restore();
  }
});

test('nwsAlerts: scope="corridor" filters by state area, caches by state, and allows 0 alerts cleanly', async () => {
  sourceCache.clear();
  const route = await buildRoute(10); // Sierra Nevada: CA + NV padded bboxes
  const seen = [];
  const restore = stubFetch((url) => {
    seen.push(new URL(url));
    return jsonRes({ type: 'FeatureCollection', features: [] });
  });
  try {
    const res = await loadAlerts({ route, scope: 'corridor' });
    assert.equal(res.status, 'ok', 'calm state with 0 alerts is valid in corridor mode');
    assert.deepEqual(res.data.alerts, []);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].searchParams.get('status'), 'actual');
    assert.equal(seen[0].searchParams.get('area'), 'CA,NV');

    // Second corridor call reuses state-keyed cache
    await loadAlerts({ route, scope: 'corridor' });
    assert.equal(seen.length, 1);

    // Nationwide still omits area= and flags 0 alerts as an error
    const nat = await loadAlerts({ route });
    assert.equal(nat.status, 'error');
    assert.equal(seen.length, 2);
    assert.equal(seen[1].searchParams.get('area'), null);
  } finally {
    restore();
  }
});

// --------------------------------------------------------------------- Engine, LocalEngine & Native Client

test('engine & localEngine: scope flows to loaders, analyzeLocally uses corridor, and loadRemoteEndpoints fails silently offline', async () => {
  const scopes = [];
  const spySources = fakeSources({
    loadFire: async (ctx) => { scopes.push(['fire', ctx.scope]); return fakeSources().loadFire(ctx); },
    loadAir: async (ctx) => { scopes.push(['air', ctx.scope]); return fakeSources().loadAir(ctx); },
    loadWater: async (ctx) => { scopes.push(['water', ctx.scope]); return fakeSources().loadWater(ctx); },
    loadAlerts: async (ctx) => { scopes.push(['alerts', ctx.scope]); return fakeSources().loadAlerts(ctx); },
  });

  // Default analyze() uses nationwide
  await analyze(validateAnalyzeRequest({ coordinates: straightCoords(3) }), { sources: spySources });
  assert.ok(scopes.every(([, s]) => s === 'nationwide'));

  // analyzeLocally() validates and passes scope='corridor'
  scopes.length = 0;
  const localRes = await analyzeLocally({ coordinates: straightCoords(3), name: 'JMT' }, { sources: spySources });
  assert.equal(localRes.version, 2);
  assert.equal(localRes.route.name, 'JMT');
  assert.ok(scopes.length === 4 && scopes.every(([, s]) => s === 'corridor'));

  // loadRemoteEndpoints loads overrides cleanly and never throws on error
  const fallback = 'https://default.example.gov/fire';
  const restoreOk = stubFetch(() => jsonRes({ endpoints: { nifcPerimeters: 'https://remote.example.gov/fire' } }));
  try {
    const loaded = await loadRemoteEndpoints('https://pages.example.gov/endpoints.json');
    assert.equal(loaded.nifcPerimeters, 'https://remote.example.gov/fire');
    assert.equal(endpointUrl('nifcPerimeters', fallback), 'https://remote.example.gov/fire');
  } finally {
    restoreOk();
    setEndpointOverrides(null);
  }

  const restoreFail = stubFetch(() => Promise.reject(new Error('offline')));
  try {
    const loaded = await loadRemoteEndpoints('https://pages.example.gov/endpoints.json');
    assert.equal(loaded, null);
    assert.equal(endpointUrl('nifcPerimeters', fallback), fallback);
  } finally {
    restoreFail();
  }
});

test('client: setAnalysisRunner and Capacitor native runtime run on-device with full coordinates (never 409)', async () => {
  assert.equal(isNativeRuntime(), false);
  const route = { id: 'abcdef0123456789', name: 'Half Dome', coords: straightCoords(4) };
  const payloads = [];
  const fakeResult = await analyzeLocally({ coordinates: route.coords, name: route.name }, { sources: fakeSources() });

  setAnalysisRunner(async (payload) => {
    payloads.push(payload);
    return fakeResult;
  });
  try {
    const r1 = await analyzeRoute({ route, lookaheadMiles: 20, location: { lat: LAT0, lng: LON }, refresh: true });
    const r2 = await analyzeRoute({ route, lookaheadMiles: 15 });
    assert.equal(r1.version, 2);
    assert.equal(r2.version, 2);
    assert.equal(payloads.length, 2);
    assert.ok(Array.isArray(payloads[0].coordinates) && Array.isArray(payloads[1].coordinates), 'always sends full coordinates on-device');
    assert.equal(payloads[0].routeHash, undefined);
    assert.equal(payloads[1].routeHash, undefined);
    assert.equal(payloads[0].refresh, true);
  } finally {
    setAnalysisRunner(null);
  }

  // Simulate Capacitor native WebView global without a custom runner:
  // analyzeRoute should auto-invoke analyzeLocally and never POST /api/analyze.
  sourceCache.clear();
  const hadWindow = 'window' in globalThis;
  const prevWindow = globalThis.window;
  globalThis.window = { Capacitor: { isNativePlatform: () => true } };
  const fetchedUrls = [];
  const restoreFetch = stubFetch((url) => {
    fetchedUrls.push(url);
    return jsonRes({ error: 'offline' }, 404);
  });
  try {
    assert.equal(isNativeRuntime(), true);
    const nativeRes = await analyzeRoute({ route, lookaheadMiles: 15 });
    assert.equal(nativeRes.version, 2);
    assert.ok(fetchedUrls.length > 0, 'native runtime invoked on-device source loaders');
    assert.ok(!fetchedUrls.some(u => u.includes('/api/analyze')), 'native runtime never posts to /api/analyze');
    assert.ok(fetchedUrls.some(u => u.includes('esriGeometryEnvelope')), 'native runtime uses corridor-scoped spatial queries');
  } finally {
    restoreFetch();
    if (hadWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
  }
  assert.equal(isNativeRuntime(), false);
});

test('snodas: loadSnow decodes base64 legend PNG and binary tile PNG asynchronously without Buffer', async () => {
  sourceCache.clear();
  clearSnowFailures();
  // 2x2 RGBA solid snow swatch [60, 120, 220, 255]
  const rawSwatch = new Uint8Array([
    0, 60, 120, 220, 255, 60, 120, 220, 255,
    0, 60, 120, 220, 255, 60, 120, 220, 255,
  ]);
  const swatchPng = buildSamplePng({ colorType: 6, rawScanlines: rawSwatch });
  const rawTransparent = new Uint8Array([
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const transparentPng = buildSamplePng({ colorType: 6, rawScanlines: rawTransparent });
  const toB64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  };
  const validAt = Date.UTC(2026, 9, 17, 12);
  const restore = stubFetch((url) => {
    if (url.includes('/legend?')) {
      return jsonRes({
        layers: [{
          layerId: 7,
          legend: [
            { label: '0 - 0.01', imageData: toB64(transparentPng) },
            { label: '2 - 4', imageData: toB64(swatchPng) },
          ],
        }],
      });
    }
    if (url.includes('/6/query?')) {
      return jsonRes({ features: [{ attributes: { idp_validtime: validAt } }] });
    }
    if (url.includes('/export?')) {
      return new Response(swatchPng, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const res = await loadSnow({ points: [{ lon: -119.5, lat: 37.5 }] });
    assert.equal(res.status, 'ok');
    assert.equal(res.validAt, validAt);
    assert.ok(Math.abs(res.byPoint[0] - 3 * 25.4) < 1e-6, `expected 76.2 mm SWE, got ${res.byPoint[0]}`);
  } finally {
    restore();
  }
});
