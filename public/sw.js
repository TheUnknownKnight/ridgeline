/*
 * Ridgeline service worker: open the app and the last-viewed map area with
 * no signal. Analysis requests (/api/*) are never cached here — a stale
 * hazard answer must come from the app, labelled with its age.
 */

const SHELL_CACHE = 'ridgeline-shell-v2';
const ASSET_CACHE = 'ridgeline-assets';
// v2: OpenFreeMap vector tiles are keyed without their build (see tileKey).
const TILE_CACHE = 'ridgeline-tiles-v2';
const LEGACY_TILE_CACHE = 'ridgeline-tiles';
const KNOWN_CACHES = [SHELL_CACHE, ASSET_CACHE, TILE_CACHE];

const SHELL_FILES = ['/manifest.webmanifest', '/icon.svg'];
// Hashed bundles from a few releases back, so a tab left open still finds its files.
const ASSET_LIMIT = 60;
const TILE_LIMIT = 1500;
// On a weak signal, fall back to the cached shell instead of waiting forever.
const NAVIGATION_TIMEOUT_MS = 4000;
// The map draws nothing until its style and TileJSON arrive, so give up on the network sooner.
const MAP_METADATA_TIMEOUT_MS = 3000;
// Basemap tiles change rarely; refresh a cached one in the background at most this often.
const TILE_REFRESH_MS = 12 * 60 * 60 * 1000;

const OPENFREEMAP = 'tiles.openfreemap.org';

const isTileRequest = (url) =>
  url.hostname === OPENFREEMAP ||
  (url.hostname === 's3.amazonaws.com' && url.pathname.startsWith('/elevation-tiles-prod/')) ||
  url.hostname === 'elevation-tiles-prod.s3.amazonaws.com';

// The style JSON (/styles/positron) and TileJSON (/planet): they name the sprite and tile build to load.
const isMapMetadata = (url) => url.hostname === OPENFREEMAP && /^\/(?:styles\/)?[\w-]+$/.test(url.pathname);

// OpenFreeMap serves vector tiles under a weekly build (/planet/<build>/z/x/y.pbf) that the
// TileJSON names. Key them without the build, so tiles cached from one build still draw the
// map offline when the cached TileJSON names another.
const VERSIONED_TILE = /^(\/[\w-]+)\/[^/]+(\/\d+\/\d+\/\d+\.pbf)$/;
const tileKey = (url) => {
  const parts = url.hostname === OPENFREEMAP && url.pathname.match(VERSIONED_TILE);
  return parts ? `${url.origin}${parts[1]}/_${parts[2]}` : url.href;
};

// z/x/y map tiles, as opposed to the style, TileJSON, sprite and glyphs every map view needs.
const isTileImage = (key) => /\/\d+\/\d+\/\d+\.(?:pbf|png|webp)$/.test(new URL(key.url).pathname);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Cache keys come back in insertion order, so the front of a list is the oldest.
const dropOldest = (cache, keys, count) =>
  Promise.all(keys.slice(0, Math.max(0, count)).map(key => cache.delete(key)));

/**
 * Keep the newest TILE_LIMIT tiles. Only z/x/y tiles count or get evicted: the
 * style, TileJSON, sprite and glyphs are cached first, so oldest-first would
 * drop exactly the files every offline map needs.
 */
const trimTiles = async () => {
  const cache = await caches.open(TILE_CACHE);
  const tiles = (await cache.keys()).filter(isTileImage);
  await dropOldest(cache, tiles, tiles.length - TILE_LIMIT);
};

let tileTrimTimer = null;
const scheduleTileTrim = () => {
  clearTimeout(tileTrimTimer);
  tileTrimTimer = setTimeout(trimTiles, 3000);
};

/**
 * Keep at most ASSET_LIMIT files, but never one the cached shell needs: the map
 * library keeps its hash across many releases, so it is among the oldest
 * entries yet loaded on every launch. Leftovers from earlier releases go first.
 */
const trimAssets = async (needed) => {
  const cache = await caches.open(ASSET_CACHE);
  const keys = await cache.keys();
  const keep = new Set(needed);
  const spare = keys.filter(key => !keep.has(new URL(key.url).pathname));
  await dropOldest(cache, spare, keys.length - ASSET_LIMIT);
};

const ASSET_REF = /\/assets\/[\w.-]+\.(?:js|css|woff2?|png|svg)/g;
const assetRefs = (text) => [...new Set(text.match(ASSET_REF) || [])];

// One missing file must not abort the install; it will be cached on first use instead.
const cacheAll = (cache, urls) => Promise.allSettled(urls.map(url => cache.add(url)));

// Fetch whichever of `urls` aren't cached yet; rejects if any of them fails.
const addMissing = (cache, urls) => Promise.all(urls.map(async (url) => (await cache.match(url)) || cache.add(url)));

/**
 * The files a shell needs: the bundles its HTML references, then the files
 * those bundles reference (the map's web worker). `ensure` gets each list
 * before the bundles are read, to cache what is missing.
 */
const shellFiles = async (html, ensure = async () => {}) => {
  const assets = await caches.open(ASSET_CACHE);
  const direct = assetRefs(html);
  await ensure(assets, direct);
  const nested = new Set();
  for (const url of direct.filter(u => u.endsWith('.js'))) {
    const cached = await assets.match(url);
    for (const ref of assetRefs((await cached?.text()) || '')) if (!direct.includes(ref)) nested.add(ref);
  }
  await ensure(assets, [...nested]);
  return [...direct, ...nested];
};

const cachedShellFiles = async () => {
  const shell = await (await caches.open(SHELL_CACHE)).match('/');
  return shell ? shellFiles(await shell.text()) : [];
};

/**
 * Make `res` the cached shell, but only once every file it needs is cached:
 * HTML whose bundles are missing opens as a blank page offline. If any file
 * fails to arrive, the previous shell stays, and its files are still cached.
 */
const updateShell = async (res) => {
  const html = await res.clone().text();
  // A host maintenance page served with 200 has no app bundle; it must never become the shell.
  if (!assetRefs(html).some(ref => ref.endsWith('.js'))) throw new Error('Not an app shell');
  const needed = await shellFiles(html, addMissing);
  await (await caches.open(SHELL_CACHE)).put('/', res);
  await trimAssets(needed);
};

/**
 * Cache the shell and every file it needs, so the first offline visit works.
 * The shell cache outlives worker versions, so on an update the shell already
 * cached is complete and is only replaced by one that is too.
 */
const precache = async () => {
  const shell = await caches.open(SHELL_CACHE);
  const res = await fetch('/', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Shell request failed: ${res.status}`);
  await cacheAll(shell, SHELL_FILES);
  if (await shell.match('/')) {
    await updateShell(res).catch(() => undefined);
  } else {
    // First install: a shell with a gap beats none, and the next online launch fills the gap.
    await shellFiles(await res.clone().text(), cacheAll);
    await shell.put('/', res);
  }
};

/**
 * Carry tiles cached by the previous version over under their new keys, so an
 * update doesn't blank the offline map. Runs at install, while the old version
 * still answers the page, and is best effort.
 */
const migrateTiles = async () => {
  if (!(await caches.keys()).includes(LEGACY_TILE_CACHE)) return;
  const legacy = await caches.open(LEGACY_TILE_CACHE);
  const tiles = await caches.open(TILE_CACHE);
  for (const key of await legacy.keys()) {
    const res = await legacy.match(key);
    if (res) await tiles.put(tileKey(new URL(key.url)), res).catch(() => undefined);
  }
};

self.addEventListener('install', (event) => {
  event.waitUntil(Promise.all([precache(), migrateTiles().catch(() => undefined)]).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith('ridgeline-') && !KNOWN_CACHES.includes(name))
      .map(name => caches.delete(name)));
    await trimAssets(await cachedShellFiles());
    await self.clients.claim();
  })());
});

const isShell = (res) => res.ok && (res.headers.get('content-type') || '').includes('text/html');

const networkFirstShell = async (event) => {
  const cache = await caches.open(SHELL_CACHE);
  const network = fetch(event.request);
  // Keep updating the cached shell even after we answered from cache. This
  // clones before the page is handed the response and starts reading it.
  event.waitUntil(network.then(res => isShell(res) && updateShell(res.clone())).catch(() => undefined));
  // A proxy's 5xx page is no use on the trail; the cached app is. A 4xx or a
  // redirect is a real answer from our server, so it goes through.
  const usable = network.then(async res => (res.status >= 500 && (await cache.match('/'))) || res);
  const cachedOrNetwork = async () => (await cache.match('/')) || usable;
  try {
    return await Promise.race([usable, sleep(NAVIGATION_TIMEOUT_MS).then(cachedOrNetwork)]);
  } catch {
    return (await cache.match('/')) || Response.error();
  }
};

// The asset cache is trimmed after each shell update, once we know which files the shell needs.
const cacheFirst = async (request, cacheName) => {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
};

// Cross-origin responses hide their Date header, so record when we stored each one.
const CACHED_AT = 'x-ridgeline-cached-at';

const stamped = async (res) => {
  const headers = new Headers(res.headers);
  headers.set(CACHED_AT, String(Date.now()));
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers });
};

const ageOf = (res) => {
  const at = Number(res.headers.get(CACHED_AT));
  return at > 0 ? Date.now() - at : Infinity;
};

/**
 * Fetch the style JSON or TileJSON fresh when the signal allows. On a weak
 * signal answer from cache and drop the late network copy: storing it would
 * leave the cache describing a different map (sprite, tile build) than the one
 * this session drew and cached tiles for.
 */
const networkFirstMapMetadata = async (request) => {
  const cache = await caches.open(TILE_CACHE);
  const network = fetch(request).catch(() => null);
  const first = await Promise.race([network, sleep(MAP_METADATA_TIMEOUT_MS)]);
  if (!first?.ok) {
    const hit = await cache.match(request);
    if (hit) return hit;
  }
  // Nothing cached: wait for the network however long it takes, and keep what we serve.
  const res = first || await network;
  if (!res) return Response.error();
  if (res.ok) await cache.put(request, res.clone());
  return res;
};

const staleWhileRevalidate = async (event) => {
  const cache = await caches.open(TILE_CACHE);
  const key = tileKey(new URL(event.request.url));
  const hit = await cache.match(key);
  const refresh = () => fetch(event.request).then(async (res) => {
    if (res.ok) {
      await cache.put(key, await stamped(res.clone()));
      scheduleTileTrim();
    }
    return res;
  });
  if (!hit) return refresh();
  if (ageOf(hit) > TILE_REFRESH_MS) event.waitUntil(refresh().catch(() => undefined));
  return hit;
};

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/')) return;
    if (request.mode === 'navigate') {
      event.respondWith(networkFirstShell(event));
    } else if (url.pathname.startsWith('/assets/')) {
      event.respondWith(cacheFirst(request, ASSET_CACHE));
    } else if (SHELL_FILES.includes(url.pathname)) {
      event.respondWith(cacheFirst(request, SHELL_CACHE));
    }
    return;
  }

  if (isMapMetadata(url)) event.respondWith(networkFirstMapMetadata(request));
  else if (isTileRequest(url)) event.respondWith(staleWhileRevalidate(event));
});
