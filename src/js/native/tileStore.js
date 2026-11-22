/**
 * Native filesystem-backed offline tile store for Capacitor (iOS & Android).
 *
 * iOS WKWebView does not run Service Workers on custom schemes and evicts
 * browser Cache Storage unpredictably. Storing downloaded corridor tiles in
 * Capacitor `Directory.Data` and serving them via MapLibre's custom `rl-tile://`
 * protocol keeps offline topo maps rock-solid in Airplane Mode.
 */
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';

const TILE_DIR = 'ridgeline-tiles';
const OPENFREEMAP = 'tiles.openfreemap.org';
const VERSIONED_TILE = /^(\/[\w-]+)\/[^/]+(\/\d+\/\d+\/\d+\.pbf)$/;
export const NATIVE_TILE_SCHEME = 'rl-tile://';

const OFFLINE_TILE_HOSTS = new Set([
  OPENFREEMAP,
  's3.amazonaws.com',
]);

/** Canonicalize OpenFreeMap weekly build URLs so cached tiles match across refreshes. */
export const canonicalTileKey = (href) => {
  try {
    const u = new URL(href);
    const parts = u.hostname === OPENFREEMAP && u.pathname.match(VERSIONED_TILE);
    return parts ? `${u.origin}${parts[1]}/_${parts[2]}` : u.href;
  } catch {
    return String(href || '');
  }
};

/** Deterministic, filesystem-safe filename (FNV-1a 64-bit hex pair + extension). */
export const tileFilePath = (href) => {
  const key = canonicalTileKey(href);
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x01000193) >>> 0;
  }
  const ext = /\.pbf(\?|$)/i.test(key) ? 'pbf'
    : /\.png(\?|$)/i.test(key) ? 'png'
      : /\.json(\?|$)/i.test(key) ? 'json' : 'bin';
  return `${TILE_DIR}/${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}.${ext}`;
};

export const bytesToBase64 = (bytes) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < u8.length; i += step) {
    bin += String.fromCharCode(...u8.subarray(i, i + step));
  }
  return btoa(bin);
};

export const base64ToBytes = (b64) => {
  const bin = atob(String(b64 || '').replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const isOfflineTileHost = (href) => {
  try {
    const u = new URL(href);
    return (u.protocol === 'https:' || u.protocol === 'http:') && OFFLINE_TILE_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
};

export const toNativeTileUrl = (href) => `${NATIVE_TILE_SCHEME}${encodeURIComponent(href)}`;
export const fromNativeTileUrl = (protoUrl) => decodeURIComponent(String(protoUrl || '').slice(NATIVE_TILE_SCHEME.length));

/** Create a Filesystem-backed tile store (injectable `fs` for unit tests). */
export const createNativeTileStore = (fs = Filesystem, dir = Directory.Data) => ({
  async has(href) {
    try {
      await fs.stat({ path: tileFilePath(href), directory: dir });
      return true;
    } catch {
      return false;
    }
  },
  async get(href) {
    try {
      const res = await fs.readFile({ path: tileFilePath(href), directory: dir });
      if (typeof res?.data === 'string') return base64ToBytes(res.data);
      return null;
    } catch {
      return null;
    }
  },
  async put(href, arrayBufferOrBytes) {
    const b64 = bytesToBase64(arrayBufferOrBytes);
    await fs.writeFile({
      path: tileFilePath(href),
      data: b64,
      directory: dir,
      recursive: true,
    });
  },
});

export const nativeTileStore = createNativeTileStore();

let protocolRegistered = false;

/**
 * Register MapLibre's custom `rl-tile://` protocol when running inside Capacitor.
 * Checks native Filesystem first (instant offline rendering), falls back to live
 * network, and opportunistically caches fetched tiles for subsequent offline use.
 */
export const registerNativeTileProtocol = (maplibregl) => {
  if (protocolRegistered || !Capacitor.isNativePlatform() || typeof maplibregl?.addProtocol !== 'function') return false;
  maplibregl.addProtocol('rl-tile', async (params, abortController) => {
    const remoteUrl = fromNativeTileUrl(params.url);
    const cached = await nativeTileStore.get(remoteUrl);
    if (cached) return { data: cached.buffer };

    const res = await fetch(remoteUrl, { signal: abortController?.signal });
    if (!res.ok) throw new Error(`Tile HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    // Opportunistically cache tiles without delaying render.
    nativeTileStore.put(remoteUrl, buf).catch(() => {});
    return { data: buf };
  });
  protocolRegistered = true;
  return true;
};

/** MapLibre `transformRequest` helper for native builds: routes basemap & hillshade tiles through `rl-tile://`. */
export const transformNativeMapRequest = (url) => {
  if (!Capacitor.isNativePlatform()) return { url };
  if (isOfflineTileHost(url)) return { url: toNativeTileUrl(url) };
  return { url };
};
