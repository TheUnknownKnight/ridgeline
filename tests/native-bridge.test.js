import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCapacitorTransport } from '../src/js/native/httpBridge.js';
import {
  canonicalTileKey,
  tileFilePath,
  isOfflineTileHost,
  toNativeTileUrl,
  fromNativeTileUrl,
  bytesToBase64,
  base64ToBytes,
  createNativeTileStore,
} from '../src/js/native/tileStore.js';
import { setEndpointOverrides, endpointUrl } from '../server/config.js';
import { setHttpTransport, fetchJson, fetchBuffer } from '../server/lib/http.js';

test('native httpBridge: translates CapacitorHttp requests, POST bodies, and binary responses cleanly', async () => {
  const calls = [];
  const fakeCapHttp = {
    async request(req) {
      calls.push(req);
      if (req.responseType === 'arraybuffer') {
        return { status: 200, headers: { 'content-type': 'image/png' }, data: bytesToBase64(new Uint8Array([1, 2, 3, 4])) };
      }
      return { status: 200, headers: { 'content-type': 'application/json' }, data: { ok: true, echo: req.data ?? null } };
    },
  };
  setHttpTransport(createCapacitorTransport(fakeCapHttp));
  try {
    const body = new URLSearchParams({ f: 'json', where: '1=1' });
    const json = await fetchJson('https://example.test/api', { method: 'POST', body, label: 'cap test' });
    assert.deepEqual(json, { ok: true, echo: 'f=json&where=1%3D1' });
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].responseType, 'json');

    const bin = await fetchBuffer('https://example.test/tile.png', { label: 'cap bin' });
    assert.deepEqual([...bin], [1, 2, 3, 4]);
    assert.equal(calls[1].responseType, 'arraybuffer');
  } finally {
    setHttpTransport(null);
  }
});

test('native tileStore: canonicalizes OpenFreeMap versioned URLs and round-trips tiles through Filesystem', async () => {
  const v1 = 'https://tiles.openfreemap.org/planet/20261101_001001_pt/12/680/1584.pbf';
  const v2 = 'https://tiles.openfreemap.org/planet/20261115_001001_pt/12/680/1584.pbf';
  assert.equal(canonicalTileKey(v1), canonicalTileKey(v2), 'weekly OpenFreeMap builds share one offline key');
  assert.equal(tileFilePath(v1), tileFilePath(v2));
  assert.match(tileFilePath(v1), /^ridgeline-tiles\/[0-9a-f]{16}\.pbf$/);

  assert.equal(isOfflineTileHost(v1), true);
  assert.equal(isOfflineTileHost('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/10/170/396.png'), true);
  assert.equal(isOfflineTileHost('https://api.weather.gov/alerts'), false);

  const wrapped = toNativeTileUrl(v1);
  assert.ok(wrapped.startsWith('rl-tile://'));
  assert.equal(fromNativeTileUrl(wrapped), v1);

  const mem = new Map();
  const fakeFs = {
    async stat({ path }) { if (!mem.has(path)) throw new Error('ENOENT'); return { size: mem.get(path).length }; },
    async readFile({ path }) { if (!mem.has(path)) throw new Error('ENOENT'); return { data: mem.get(path) }; },
    async writeFile({ path, data }) { mem.set(path, data); },
  };
  const store = createNativeTileStore(fakeFs);
  assert.equal(await store.has(v1), false);
  const sample = new Uint8Array([10, 20, 30, 255, 0, 128]);
  assert.deepEqual([...base64ToBytes(bytesToBase64(sample))], [...sample]);
  await store.put(v1, sample);
  assert.equal(await store.has(v2), true, 'cross-week lookup hits cached tile');
  const readBack = await store.get(v2);
  assert.deepEqual([...readBack], [...sample]);
});

test('config: setEndpointOverrides supports nested docs/endpoints.json manifest cleanly', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../docs/endpoints.json', import.meta.url), 'utf8'));
  setEndpointOverrides(raw);
  try {
    assert.equal(endpointUrl('nifcPerimeters', 'fallback'), raw.endpoints.nifc.perimeters);
    assert.equal(endpointUrl('airnowContours', 'fallback'), raw.endpoints.airnow.contours);
    assert.equal(endpointUrl('nwpsService', 'fallback'), raw.endpoints.nwps.service);
    assert.equal(endpointUrl('nwsAlerts', 'fallback'), raw.endpoints.nws.alerts);
    assert.equal(endpointUrl('snodasService', 'fallback'), raw.endpoints.snodas.base);
    assert.equal(endpointUrl('usfsTrails', 'fallback'), raw.endpoints.usfsTrails.query);
    assert.equal(endpointUrl('npsTrails', 'fallback'), raw.endpoints.npsTrails.query);
  } finally {
    setEndpointOverrides(null);
  }
});
