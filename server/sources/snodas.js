import { endpointUrl } from '../config.js';
import { createCache, sourceCache } from '../lib/cache.js';
import { fetchJson, fetchBuffer } from '../lib/http.js';
import { decodePng } from '../lib/png.js';
import { mapLimit } from '../lib/pool.js';

/**
 * Snow on the ground now: NOAA NOHRSC's daily snow analysis (SNODAS, ~1 km,
 * valid 12Z, published ~17–18Z). The map service has no point sampler that
 * scales, so the analysis is exported as PNG tiles on a fixed 1° grid (shared
 * by every route), decoded once into legend-class indices, and each trail
 * point reads a bilinear blend across valid pixels (snow water equivalent, mm).
 */
const BASE = 'https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer';
const SWE_LAYER = 7;
const SWE_FOOTPRINT_LAYER = 6;
export const ATTRIBUTION = 'NOAA NOHRSC snow analysis (SNODAS)';
export const SOURCE_URL = 'https://www.nohrsc.noaa.gov/nsa/';

const TILE_DEG = 1;
const TILE_PX = 120;              // the analysis grid is 30 arc-seconds: 120 px per degree
const MAX_TILES = 40;             // per request; points in tiles beyond this have no answer
const TTL_MS = 3 * 3600 * 1000;
const STALE_MS = 36 * 3600 * 1000;
const COLOR_TOLERANCE = 40;
const NO_CLASS = 255;
// SNODAS covers the lower 48 (and a little of Canada); outside it, no snow answer.
const COVERAGE = [-125, 24, -66.9, 52.9];

// Decoded tiles are 14 KB of class indices each; a byte cap keeps them from crowding anything out.
const tileCache = createCache({ maxEntries: 2000, maxWeight: 32 * 1024 * 1024, weigh: (v) => v?.classes?.byteLength || 1 });

export const clearSnowFailures = () => { tileCache.clearFailures(); };

const decodeBase64 = (b64) => {
  const clean = String(b64 || '').replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(globalThis.Buffer.from(clean, 'base64'));
};

/** Legend: [{ lo, hi (inches SWE), rgba }]; the first class (≈ no snow) is drawn transparent. */
const loadLegend = async () => {
  const { value } = await sourceCache.wrap('snodas:legend', { ttlMs: 24 * 3600 * 1000, staleMs: 7 * 24 * 3600 * 1000, errorTtlMs: 15 * 1000 }, async () => {
    const base = endpointUrl('snodasService', BASE);
    const data = await fetchJson(`${base}/legend?f=json`, { label: 'SNODAS legend', timeoutMs: 6000, retries: 1 });
    const layer = (data?.layers || []).find(l => l.layerId === SWE_LAYER);
    if (!layer?.legend?.length) throw new Error('SNODAS legend missing');
    const entries = await Promise.all(layer.legend.map(async (l) => {
      const [lo, hi] = String(l.label).split('-').map(s => Number(s.trim()));
      const img = await decodePng(decodeBase64(l.imageData));
      return { lo, hi, rgba: img.rgba(Math.floor(img.width / 2), Math.floor(img.height / 2)) };
    }));
    return entries.filter(c => Number.isFinite(c.lo) && Number.isFinite(c.hi));
  });
  return value;
};

const loadValidTime = async () => {
  const { value } = await sourceCache.wrap('snodas:valid', { ttlMs: TTL_MS, staleMs: STALE_MS, errorTtlMs: 15 * 1000 }, async () => {
    const base = endpointUrl('snodasService', BASE);
    const qs = new URLSearchParams({ where: '1=1', outFields: 'idp_validtime', returnGeometry: 'false', f: 'json' });
    const data = await fetchJson(`${base}/${SWE_FOOTPRINT_LAYER}/query?${qs}`, { label: 'SNODAS valid time', timeoutMs: 6000, retries: 1 });
    const times = (data?.features || []).map(f => f.attributes?.idp_validtime).filter(Number.isFinite);
    if (!times.length) throw new Error('SNODAS valid time missing');
    return Math.max(...times);
  });
  return value;
};

const classIndexOf = (legend, rgba) => {
  if (!rgba) return NO_CLASS;
  if (rgba[3] === 0) return 0;
  let best = -1;
  let bestD = Infinity;
  legend.forEach((c, i) => {
    if (c.rgba[3] === 0) return;
    const d = Math.hypot(c.rgba[0] - rgba[0], c.rgba[1] - rgba[1], c.rgba[2] - rgba[2]);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best >= 0 && bestD <= COLOR_TOLERANCE ? best : NO_CLASS;
};

/** One 1° tile, decoded to legend-class indices (one byte per pixel). */
const loadTile = async (tx, ty, validAt, legend) => {
  const key = `${validAt}:${tx},${ty}`;
  const { value } = await tileCache.wrap(key, { ttlMs: TTL_MS, staleMs: STALE_MS, errorTtlMs: 15 * 1000 }, async () => {
    const base = endpointUrl('snodasService', BASE);
    const bbox = [tx, ty, tx + TILE_DEG, ty + TILE_DEG];
    const qs = new URLSearchParams({
      bbox: bbox.join(','), bboxSR: '4326', imageSR: '4326', size: `${TILE_PX},${TILE_PX}`,
      format: 'png8', transparent: 'true', layers: `show:${SWE_LAYER}`, f: 'image',
    });
    const png = await decodePng(await fetchBuffer(`${base}/export?${qs}`, { label: 'SNODAS export', timeoutMs: 8000, retries: 1, maxBytes: 2 * 1024 * 1024 }));
    const classes = new Uint8Array(png.width * png.height);
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) classes[y * png.width + x] = classIndexOf(legend, png.rgba(x, y));
    return { width: png.width, height: png.height, classes };
  });
  return value;
};

const inCoverage = (p) => p.lon >= COVERAGE[0] && p.lon <= COVERAGE[2] && p.lat >= COVERAGE[1] && p.lat <= COVERAGE[3];
const tileOf = (p) => [Math.floor(p.lon / TILE_DEG) * TILE_DEG, Math.floor(p.lat / TILE_DEG) * TILE_DEG];

/** Indices of at most `max` items spread evenly along a list. */
const pickEvenly = (n, max) => (n <= max
  ? Array.from({ length: n }, (_, i) => i)
  : Array.from({ length: max }, (_, k) => Math.round((k * (n - 1)) / (max - 1))));

const sweMmOfClass = (ci, legend) => {
  if (ci === NO_CLASS) return null;
  const c = legend[ci];
  if (!c) return null;
  // Middle of the class, in mm of water; the open-ended top class near its floor.
  return c.lo === 0 ? 0 : ((c.lo + Math.min(c.hi, c.lo * 2)) / 2) * 25.4;
};

/** Edge-preserving bilinear SWE blend (mm) across valid neighboring pixels inside a tile. */
export const sampleTileSwe = (tile, p, tx, ty, legend) => {
  const fx = ((p.lon - tx) / TILE_DEG) * tile.width - 0.5;
  const fy = ((ty + TILE_DEG - p.lat) / TILE_DEG) * tile.height - 0.5;
  const x0 = Math.max(0, Math.min(tile.width - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(tile.height - 1, Math.floor(fy)));
  const x1 = Math.min(tile.width - 1, x0 + 1);
  const y1 = Math.min(tile.height - 1, y0 + 1);
  const wx = Math.max(0, Math.min(1, fx - x0));
  const wy = Math.max(0, Math.min(1, fy - y0));

  const corners = [
    [x0, y0, (1 - wx) * (1 - wy)],
    [x1, y0, wx * (1 - wy)],
    [x0, y1, (1 - wx) * wy],
    [x1, y1, wx * wy],
  ];
  let sum = 0;
  let weight = 0;
  for (const [cx, cy, w] of corners) {
    const v = sweMmOfClass(tile.classes[cy * tile.width + cx], legend);
    if (v != null && w > 0) {
      sum += v * w;
      weight += w;
    }
  }
  if (weight > 0) return sum / weight;
  // Fall back to nearest clamped pixel if subpixel weights all fell on NO_CLASS.
  const nx = Math.max(0, Math.min(tile.width - 1, Math.round(fx)));
  const ny = Math.max(0, Math.min(tile.height - 1, Math.round(fy)));
  return sweMmOfClass(tile.classes[ny * tile.width + nx], legend);
};

/**
 * Snow water equivalent (mm) on the ground at each point from today's
 * analysis: { status, validAt, byPoint: [sweMm | null] } (null = no answer).
 * status: skipped outside the analysis area, partial when some points in it
 * got no answer, error when none did.
 */
export const loadSnow = async ({ points, budgetMs = 13500 }) => {
  const inside = points.map(inCoverage);
  if (!inside.some(Boolean)) return { status: 'skipped', validAt: null, byPoint: points.map(() => null) };
  const deadlineAt = Date.now() + budgetMs;
  try {
    const [legend, validAt] = await Promise.all([loadLegend(), loadValidTime()]);
    // Only the tiles the route actually enters, in route order, at most MAX_TILES.
    const order = [];
    const seen = new Set();
    points.forEach((p, i) => {
      if (!inside[i]) return;
      const k = tileOf(p).join(',');
      if (!seen.has(k)) { seen.add(k); order.push(k); }
    });
    const wanted = pickEvenly(order.length, MAX_TILES).map(i => order[i]);
    const tiles = new Map();
    await mapLimit(wanted, 5, async (k) => {
      const [tx, ty] = k.split(',').map(Number);
      try { tiles.set(k, await loadTile(tx, ty, validAt, legend)); } catch (err) { console.error('[snodas] tile failed:', err.message); }
    }, { deadlineAt });
    const byPoint = points.map((p, i) => {
      if (!inside[i]) return null;
      const [tx, ty] = tileOf(p);
      const tile = tiles.get(`${tx},${ty}`);
      return tile ? sampleTileSwe(tile, p, tx, ty, legend) : null;
    });
    const asked = inside.filter(Boolean).length;
    const answered = byPoint.filter(v => v != null).length;
    return { status: answered === 0 ? 'error' : answered < asked ? 'partial' : 'ok', validAt, byPoint };
  } catch (err) {
    console.error('[snodas] load failed:', err.message);
    return { status: 'error', validAt: null, byPoint: points.map(() => null) };
  }
};
