/**
 * Offline trail pack builder: while on Wi-Fi or trailhead service, saves the
 * route GPX, latest hazard analysis, OpenFreeMap style + TileJSON + sprites,
 * and route-corridor map tiles.
 * - On web: writes to Cache Storage (`ridgeline-tiles-v2`) used by public/sw.js.
 * - On Capacitor native (iOS & Android): writes to persistent native Filesystem
 *   storage (`nativeTileStore`) served by MapLibre's `rl-tile://` protocol so
 *   iOS WKWebView never evicts offline maps and Service Workers are not needed.
 */
import * as db from '../storage/db.js';
import { corridorTilesForRoute } from './trailMath.js';
import { isNativeApp } from '../native/bridge.js';
import { nativeTileStore } from '../native/tileStore.js';

const TILE_CACHE = 'ridgeline-tiles-v2';
const CACHED_AT = 'x-ridgeline-cached-at';
const OPENFREEMAP = 'tiles.openfreemap.org';
const VERSIONED_TILE = /^(\/[\w-]+)\/[^/]+(\/\d+\/\d+\/\d+\.pbf)$/;

const BASEMAPS = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const TERRAIN_TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const CONCURRENCY = 6;
const MAX_VECTOR_TILES = 240;
const MAX_HILLSHADE_TILES = 60;

/** Mirror public/sw.js tileKey so pre-cached tiles match MapLibre offline requests across weekly builds. */
const tileCacheKey = (href) => {
  try {
    const url = new URL(href);
    const parts = url.hostname === OPENFREEMAP && url.pathname.match(VERSIONED_TILE);
    return parts ? `${url.origin}${parts[1]}/_${parts[2]}` : url.href;
  } catch {
    return href;
  }
};

const putStamped = async (cache, key, res) => {
  const headers = new Headers(res.headers);
  headers.set(CACHED_AT, String(Date.now()));
  const body = await res.blob();
  await cache.put(key, new Response(body, { status: res.status, statusText: res.statusText, headers }));
};

const fetchAndCacheWeb = async (cache, url, { signal, stamp = true } = {}) => {
  const key = tileCacheKey(url);
  if (await cache.match(key)) return { cached: true, skipped: true };
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (stamp) await putStamped(cache, key, res);
  else await cache.put(key, res);
  return { cached: true, skipped: false };
};

const fetchAndCacheNative = async (url, { signal } = {}) => {
  if (await nativeTileStore.has(url)) return { cached: true, skipped: true };
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await nativeTileStore.put(url, await res.arrayBuffer());
  return { cached: true, skipped: false };
};

const runPool = async (items, limit, worker, signal) => {
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      if (signal?.aborted) return;
      const idx = cursor++;
      await worker(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
};

/**
 * Discover active OpenFreeMap style metadata (TileJSON URL, vector tile
 * template, sprite assets) and cache them so MapLibre boots cleanly offline.
 */
const prepareBasemapMeta = async ({ cache, native, styleUrl, signal }) => {
  const res = await fetch(styleUrl, { signal });
  if (!res.ok) throw new Error(`Style HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const style = JSON.parse(new TextDecoder().decode(buf));
  if (native) await nativeTileStore.put(styleUrl, buf);
  else await cache.put(styleUrl, new Response(buf, { status: 200, headers: { 'Content-Type': 'application/json' } }));

  const spriteUrls = [];
  if (typeof style.sprite === 'string') {
    for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) spriteUrls.push(`${style.sprite}${suffix}`);
  }
  await Promise.allSettled(spriteUrls.map(u => (native ? fetchAndCacheNative(u, { signal }) : fetchAndCacheWeb(cache, u, { signal, stamp: false }))));

  // Find the primary vector TileJSON source (usually https://tiles.openfreemap.org/planet).
  const vectorSource = Object.values(style.sources || {}).find(s => s?.type === 'vector' && typeof s.url === 'string');
  if (!vectorSource) return { vectorTemplate: null };

  const tjRes = await fetch(vectorSource.url, { signal });
  if (!tjRes.ok) throw new Error(`TileJSON HTTP ${tjRes.status}`);
  const tjBuf = await tjRes.arrayBuffer();
  const tileJson = JSON.parse(new TextDecoder().decode(tjBuf));
  if (native) await nativeTileStore.put(vectorSource.url, tjBuf);
  else await cache.put(vectorSource.url, new Response(tjBuf, { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const vectorTemplate = Array.isArray(tileJson.tiles) ? tileJson.tiles[0] : null;
  return { vectorTemplate };
};

/**
 * Save everything needed for offline On-trail use: route GPX, current analysis
 * (if loaded), basemap metadata, and route-corridor map + hillshade tiles.
 */
export const saveOfflinePack = async ({ route, result = null, mode = 'planning', theme = 'dark', onProgress, signal } = {}) => {
  if (!route) throw new Error('No route selected');

  // 1. Always persist route + latest analysis in IndexedDB first.
  await db.saveRoute(route);
  if (result) await db.saveResult(db.resultKey(route.id, result.mode || mode), result);

  let cachedTiles = 0;
  let failedTiles = 0;
  let totalTiles = 0;

  const native = isNativeApp();
  const canCache = native || typeof caches !== 'undefined';

  if (canCache) {
    const cache = native ? null : await caches.open(TILE_CACHE);
    const styleUrl = BASEMAPS[theme] || BASEMAPS.dark;
    onProgress?.({ phase: 'meta', done: 0, total: 0 });

    try {
      const { vectorTemplate } = await prepareBasemapMeta({ cache, native, styleUrl, signal });
      const urls = [];
      if (vectorTemplate) {
        const vecTiles = corridorTilesForRoute(route.coords, {
          zooms: [9, 10, 11, 12, 13],
          padTiles: 1,
          maxTiles: MAX_VECTOR_TILES,
        });
        for (const t of vecTiles) {
          urls.push(vectorTemplate.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y)));
        }
      }
      // Also cache overview terrain hillshade tiles so mountain relief shows offline.
      const demTiles = corridorTilesForRoute(route.coords, {
        zooms: [9, 10, 11],
        padTiles: 0,
        maxTiles: MAX_HILLSHADE_TILES,
      });
      for (const t of demTiles) {
        urls.push(TERRAIN_TILE_URL.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y)));
      }

      totalTiles = urls.length;
      let done = 0;
      onProgress?.({ phase: 'tiles', done: 0, total: totalTiles });

      await runPool(urls, CONCURRENCY, async (url) => {
        try {
          if (native) await fetchAndCacheNative(url, { signal });
          else await fetchAndCacheWeb(cache, url, { signal, stamp: true });
          cachedTiles++;
        } catch (err) {
          if (signal?.aborted) return;
          failedTiles++;
        } finally {
          done++;
          if (!signal?.aborted) onProgress?.({ phase: 'tiles', done, total: totalTiles });
        }
      }, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      // Route & analysis are still safely stored in IndexedDB even if tile prefetch failed.
    }
  }

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const pack = {
    savedAt: Date.now(),
    tileCount: cachedTiles,
    totalTiles,
    failedTiles,
    resultAt: result?.generatedAt || null,
  };
  await db.saveOfflineMeta(route.id, pack);
  return pack;
};
