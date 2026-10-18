import { createCache, sourceCache } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { mapLimit } from '../lib/pool.js';

/**
 * The ground under each trail point, once per place: hillslope steepness and
 * direction (LANDFIRE 30 m), elevation (LANDFIRE, for files without it), tree
 * canopy (USFS NLCD Tree Canopy Cover) and land cover (Annual NLCD). All are
 * ArcGIS ImageServers that sample up to 1,000 points per request.
 *
 * Terrain doesn't change, so values are cached per ~50 m grid cell (never per
 * route): overlapping routes share them and no route is stored.
 */
const LANDFIRE = 'https://lfps.usgs.gov/arcgis/rest/services/Landfire_Topo';
const IIPP = 'https://imagery.geoplatform.gov/iipp/rest/services/Vegetation';

const LAYERS = {
  slope: { url: `${LANDFIRE}/LF2020_SlpD_CONUS/ImageServer` },
  aspect: { url: `${LANDFIRE}/LF2020_Asp_CONUS/ImageServer` },
  elevation: { url: `${LANDFIRE}/LF2020_Elev_CONUS/ImageServer` },
  canopy: { url: `${IIPP}/USFS_EDW_NLCD_TCC_CONUS/ImageServer`, latestRaster: true },
  landCover: { url: `${IIPP}/USFS_EDW_NLCD_Landcover_CONUS/ImageServer`, latestRaster: true },
};

export const ATTRIBUTION = 'LANDFIRE (USGS), USFS Tree Canopy Cover, Annual NLCD';
export const SOURCE_URL = 'https://landfire.gov/';

const MAX_POINTS_PER_CALL = 1000; // getSamples silently truncates above this
const SNAP_DEG = 0.0005;          // ~50 m: closer points share one sample
const TTL_MS = 30 * 24 * 3600 * 1000;
const CATALOG_TTL_MS = 24 * 3600 * 1000;

// Its own cache: a long route can touch tens of thousands of cells, which
// must not push the national hazard feeds out of the shared source cache.
export const terrainCache = createCache({ maxEntries: 200000 });

const snap = (v) => Math.round(v / SNAP_DEG) * SNAP_DEG;
const keyOf = (p) => `${snap(p.lat).toFixed(4)},${snap(p.lon).toFixed(4)}`;

/** Raster id of the newest year in a time-series mosaic (the year is the last one in the raster name). */
const latestRasterId = async (url) => {
  const { value } = await sourceCache.wrap(`terrain:catalog:${url}`, { ttlMs: CATALOG_TTL_MS, staleMs: 7 * CATALOG_TTL_MS, errorTtlMs: 60 * 1000 }, async () => {
    const qs = new URLSearchParams({ where: '1=1', outFields: 'objectid,name', returnGeometry: 'false', f: 'json' });
    const data = await fetchJson(`${url}/query?${qs}`, { label: 'raster catalog', timeoutMs: 6000, retries: 0 });
    if (data?.error) throw new Error(`raster catalog error: ${JSON.stringify(data.error).slice(0, 120)}`);
    let best = null;
    for (const f of data?.features || []) {
      const years = String(f.attributes?.name || '').match(/(?:19|20)\d{2}/g);
      const year = years ? Number(years[years.length - 1]) : 0;
      const id = f.attributes?.objectid;
      if (Number.isFinite(id) && (!best || year > best.year || (year === best.year && id > best.id))) best = { id, year };
    }
    if (!best) throw new Error('raster catalog is empty');
    return best.id;
  });
  return value;
};

// A layer that just failed is skipped for a minute instead of being waited on by every check.
const LAYER_RETRY_MS = 60 * 1000;
const layerDownUntil = new Map();

/** Sample one layer at points ([lon, lat]); returns values by index (null where no data). */
const sampleLayer = async (layer, points) => {
  if ((layerDownUntil.get(layer.url) || 0) > Date.now()) throw new Error('layer recently failed');
  const params = {
    geometry: JSON.stringify({ points, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryMultipoint',
    returnFirstValueOnly: 'true',
    interpolation: 'RSP_NearestNeighbor',
    f: 'json',
  };
  if (layer.latestRaster) {
    params.mosaicRule = JSON.stringify({ mosaicMethod: 'esriMosaicLockRaster', lockRasterIds: [await latestRasterId(layer.url)] });
  }
  let data;
  try {
    data = await fetchJson(`${layer.url}/getSamples`, {
      method: 'POST',
      body: new URLSearchParams(params),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      label: 'terrain samples',
      timeoutMs: 8000,
      retries: 0,
    });
    if (data?.error) throw new Error(`terrain samples error: ${JSON.stringify(data.error).slice(0, 120)}`);
  } catch (err) {
    layerDownUntil.set(layer.url, Date.now() + LAYER_RETRY_MS);
    throw err;
  }
  const out = new Array(points.length).fill(null);
  for (const s of data?.samples || []) {
    const v = Number(s.value);
    if (Number.isInteger(s.locationId) && s.locationId < points.length && Number.isFinite(v)) out[s.locationId] = v;
  }
  return out;
};

const clean = {
  slope: (v) => (v == null || v < 0 || v > 90 ? null : v),
  aspect: (v) => (v == null || v < -1 || v > 360 ? null : v),          // −1 = flat
  elevation: (v) => (v == null || v < -500 || v > 9000 ? null : v),
  canopy: (v) => (v == null || v < 0 || v > 100 ? null : v / 100),     // 254/255 = no data
  landCover: (v) => (v == null || v < 11 || v > 95 ? null : v),
};

/**
 * Terrain for trail points [{ lat, lon }]. Returns { status, byPoint: [{ slopeDeg,
 * aspectDeg, elevationM, canopy, nlcd } | null], failedLayers }.
 */
export const loadTerrain = async ({ points }) => {
  const keys = points.map(keyOf);
  const unique = [...new Set(keys)];
  const values = new Map();
  const misses = [];
  for (const k of unique) {
    const v = terrainCache.get(k);
    if (v !== undefined) values.set(k, v); else misses.push(k);
  }

  const failedLayers = new Set();
  const batches = [];
  for (let i = 0; i < misses.length; i += MAX_POINTS_PER_CALL) batches.push(misses.slice(i, i + MAX_POINTS_PER_CALL));
  await mapLimit(batches, 2, async (batch) => {
    const coords = batch.map(k => { const [lat, lon] = k.split(',').map(Number); return [lon, lat]; });
    const results = {};
    await Promise.all(Object.entries(LAYERS).map(async ([name, layer]) => {
      try {
        results[name] = (await sampleLayer(layer, coords)).map(clean[name]);
      } catch (err) {
        console.error(`[terrain] ${name} failed:`, err.message);
        failedLayers.add(name);
        results[name] = null;
      }
    }));
    const complete = Object.keys(LAYERS).every(name => results[name]);
    batch.forEach((k, i) => {
      const v = {
        slopeDeg: results.slope?.[i] ?? null,
        aspectDeg: results.aspect?.[i] ?? null,
        elevationM: results.elevation?.[i] ?? null,
        canopy: results.canopy?.[i] ?? null,
        nlcd: results.landCover?.[i] ?? null,
      };
      values.set(k, v);
      // Only complete answers are kept for a month; a partial one is retried next time.
      if (complete) terrainCache.set(k, v, { ttlMs: TTL_MS });
    });
  });

  const answered = unique.filter(k => values.get(k) && Object.values(values.get(k)).some(v => v != null)).length;
  return {
    status: unique.length && answered === 0 ? 'error' : failedLayers.size ? 'partial' : 'ok',
    byPoint: keys.map(k => values.get(k) ?? null),
    failedLayers: [...failedLayers],
  };
};
