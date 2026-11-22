import { createCache, sourceCache } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { mapLimit } from '../lib/pool.js';

/**
 * The ground under each trail point, once per place: hillslope steepness and
 * direction (LANDFIRE 30 m), elevation (LANDFIRE, for files without it), tree
 * canopy (USFS NLCD Tree Canopy Cover), land cover (Annual NLCD in CONUS;
 * USFS LCMS mapped to NLCD in Alaska and Hawaii), and 8-azimuth topographic
 * horizon angles. All are ArcGIS ImageServers that sample up to 1,000 points
 * per request.
 *
 * Terrain doesn't change, so values are cached per ~50 m grid cell (never per
 * route): overlapping routes share them and no route is stored.
 */
const LANDFIRE = 'https://lfps.usgs.gov/arcgis/rest/services/Landfire_Topo';
const IIPP = 'https://imagery.geoplatform.gov/iipp/rest/services/Vegetation';

const CONUS_LAYERS = {
  slope: { url: `${LANDFIRE}/LF2020_SlpD_CONUS/ImageServer` },
  aspect: { url: `${LANDFIRE}/LF2020_Asp_CONUS/ImageServer` },
  elevation: { url: `${LANDFIRE}/LF2020_Elev_CONUS/ImageServer` },
  canopy: { url: `${IIPP}/USFS_EDW_NLCD_TCC_CONUS/ImageServer`, latestRaster: true },
  landCover: { url: `${IIPP}/USFS_EDW_NLCD_Landcover_CONUS/ImageServer`, latestRaster: true },
};

const HI_LAYERS = {
  slope: { url: `${LANDFIRE}/LF2020_SlpD_HI/ImageServer` },
  aspect: { url: `${LANDFIRE}/LF2020_Asp_HI/ImageServer` },
  elevation: { url: `${LANDFIRE}/LF2020_Elev_HI/ImageServer` },
  canopy: { url: `${IIPP}/USFS_EDW_NLCD_TCC_Hawaii/ImageServer`, latestRaster: true },
  landCover: { url: `${IIPP}/USFS_EDW_LCMS_AnnualLandcover_HI/ImageServer`, latestRaster: true, lcms: true },
};

const AK_LAYERS = {
  slope: { url: `${LANDFIRE}/LF2020_SlpD_AK/ImageServer` },
  aspect: { url: `${LANDFIRE}/LF2020_Asp_AK/ImageServer` },
  elevation: { url: `${LANDFIRE}/LF2020_Elev_AK/ImageServer` },
  landCover: { url: `${IIPP}/USFS_EDW_LCMS_AnnualLandcover_AK/ImageServer`, latestRaster: true, lcms: true },
};

const AK_SE_LAYERS = {
  ...AK_LAYERS,
  canopy: { url: `${IIPP}/USFS_EDW_NLCD_TCC_SEAK/ImageServer`, latestRaster: true },
};

const LAYERS_BY_REGION = {
  CONUS: CONUS_LAYERS,
  HI: HI_LAYERS,
  AK: AK_LAYERS,
  AK_SE: AK_SE_LAYERS,
};

// Verified against USFS_EDW_LCMS_AnnualLandcover_{AK,HI} raster legends (1..15).
const LCMS_MAP = {
  1: { nlcd: 42, canopy: 0.65 },
  2: { nlcd: 42, canopy: 0.45 },
  3: { nlcd: 43, canopy: 0.35 },
  4: { nlcd: 43, canopy: 0.30 },
  5: { nlcd: 43, canopy: 0.20 },
  6: { nlcd: 52, canopy: 0.15 },
  7: { nlcd: 52, canopy: 0.08 },
  8: { nlcd: 52, canopy: 0.05 },
  9: { nlcd: 52, canopy: 0.03 },
  10: { nlcd: 71, canopy: 0 },
  11: { nlcd: 31, canopy: 0 },
  12: { nlcd: 31, canopy: 0 },
  13: { nlcd: 12, canopy: 0 },
  14: { nlcd: 11, canopy: 0 },
  15: { nlcd: null, canopy: null },
};

export const ATTRIBUTION = 'LANDFIRE (USGS), USFS Tree Canopy Cover, Annual NLCD / LCMS';
export const SOURCE_URL = 'https://landfire.gov/';

const MAX_POINTS_PER_CALL = 1000; // getSamples silently truncates above this
const SNAP_DEG = 0.0005;          // ~50 m: closer points share one sample
const TTL_MS = 30 * 24 * 3600 * 1000;
const CATALOG_TTL_MS = 24 * 3600 * 1000;

const HORIZON_BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315];
const HORIZON_DISTS_M = [1500, 5000];
const MAX_HORIZON_STATIONS = 60; // 60 * 8 * 2 = 960 <= MAX_POINTS_PER_CALL
const EARTH_CURV_K = 0.87 / (2 * 6371000); // curvature minus standard atmospheric refraction

// Its own caches: a long route can touch tens of thousands of cells, which
// must not push the national hazard feeds out of the shared source cache.
export const terrainCache = createCache({ maxEntries: 200000 });
export const horizonCache = createCache({ maxEntries: 50000 });

const snap = (v) => Math.round(v / SNAP_DEG) * SNAP_DEG;
const keyOf = (p) => `${snap(p.lat).toFixed(4)},${snap(p.lon).toFixed(4)}`;

/** Terrain dataset region containing { lat, lon }. */
export const regionOf = ({ lat, lon }) => {
  if (lat >= 18 && lat <= 23 && lon >= -161 && lon <= -154) return 'HI';
  if (lat >= 54 && lat <= 60.5 && lon >= -141.5 && lon <= -129) return 'AK_SE';
  if (lat >= 51 && lat <= 72 && lon >= -180 && lon <= -129) return 'AK';
  return 'CONUS';
};

/** Map a USFS LCMS class (1..15) to an NLCD class + fallback canopy [0, 1]. */
export const mapLcms = (v) => LCMS_MAP[v] || { nlcd: null, canopy: null };

/** Raster id of the newest year in a time-series mosaic (the year is the last one in the raster name). */
const latestRasterId = async (url) => {
  const { value } = await sourceCache.wrap(`terrain:catalog:${url}`, { ttlMs: CATALOG_TTL_MS, staleMs: 7 * CATALOG_TTL_MS, errorTtlMs: 15 * 1000 }, async () => {
    const qs = new URLSearchParams({ where: '1=1', outFields: 'objectid,name', returnGeometry: 'false', f: 'json' });
    const data = await fetchJson(`${url}/query?${qs}`, { label: 'raster catalog', timeoutMs: 6000, retries: 1 });
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

// A layer that just failed is skipped briefly instead of being waited on by every check.
const LAYER_RETRY_MS = 15 * 1000;
const layerDownUntil = new Map();

export const clearTerrainFailures = () => { layerDownUntil.clear(); };

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
      retries: 1,
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
  aspect: (v) => (v == null || v < -1 || v > 360 ? null : v),          // -1 = flat
  elevation: (v) => (v == null || v < -500 || v > 9000 ? null : v),
  canopy: (v) => (v == null || v < 0 || v > 100 ? null : v / 100),     // 254/255 = no data
  landCover: (v, isLcms) => (isLcms ? (LCMS_MAP[v] ? v : null) : (v == null || v < 11 || v > 95 ? null : v)),
};

/** Pick at most `max` evenly-spaced indices from `list`. */
const pickEvenly = (list, max) => (list.length <= max
  ? list
  : Array.from({ length: max }, (_, k) => list[Math.round((k * (list.length - 1)) / (max - 1))]));

/** Offset [lon, lat] from (lat, lon) by distanceM along bearingDeg clockwise from north. */
const offsetCoord = (lat, lon, bearingDeg, distanceM) => {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (distanceM * Math.cos(rad)) / 111320;
  const cosLat = Math.max(0.1, Math.cos((lat * Math.PI) / 180));
  const dLon = (distanceM * Math.sin(rad)) / (111320 * cosLat);
  return [lon + dLon, lat + dLat];
};

/** Horizon elevation angle in degrees [0, 75] from z0 to probe z at distanceM. */
export const horizonAngleDeg = (z0, zProbe, distanceM) => {
  if (z0 == null || zProbe == null) return 0;
  const curv = EARTH_CURV_K * distanceM * distanceM;
  const deg = (Math.atan2(zProbe - z0 - curv, distanceM) * 180) / Math.PI;
  return Math.max(0, Math.min(75, Math.round(deg * 10) / 10));
};

/** Best-effort 8-azimuth horizon shading angles for up to 60 route stations. */
const loadHorizons = async (points, keys, byBaseKey) => {
  const resolved = new Map();
  const eligibleIdx = [];
  for (let i = 0; i < points.length; i++) {
    const base = byBaseKey.get(keys[i]);
    if (base?.elevationM == null) continue;
    const hit = horizonCache.get(keys[i]);
    if (hit !== undefined) resolved.set(keys[i], hit);
    eligibleIdx.push(i);
  }

  const stationIndices = pickEvenly(eligibleIdx, MAX_HORIZON_STATIONS);
  const byRegion = new Map();
  const seenStations = new Set();
  for (const idx of stationIndices) {
    const k = keys[idx];
    if (resolved.has(k) || seenStations.has(k)) continue;
    seenStations.add(k);
    const region = regionOf(points[idx]);
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region).push({ key: k, lat: points[idx].lat, lon: points[idx].lon, elevM: byBaseKey.get(k).elevationM });
  }

  await Promise.all([...byRegion.entries()].map(async ([region, stations]) => {
    const elevLayer = LAYERS_BY_REGION[region].elevation;
    if ((layerDownUntil.get(elevLayer.url) || 0) > Date.now()) return;
    const coords = [];
    for (const st of stations) {
      for (const bearing of HORIZON_BEARINGS) {
        for (const distM of HORIZON_DISTS_M) coords.push(offsetCoord(st.lat, st.lon, bearing, distM));
      }
    }
    try {
      const zValues = (await sampleLayer(elevLayer, coords)).map(clean.elevation);
      let cursor = 0;
      for (const st of stations) {
        const angles = new Array(HORIZON_BEARINGS.length).fill(0);
        for (let b = 0; b < HORIZON_BEARINGS.length; b++) {
          let maxA = 0;
          for (const distM of HORIZON_DISTS_M) {
            maxA = Math.max(maxA, horizonAngleDeg(st.elevM, zValues[cursor++], distM));
          }
          angles[b] = maxA;
        }
        resolved.set(st.key, angles);
        horizonCache.set(st.key, angles, { ttlMs: TTL_MS });
      }
    } catch (err) {
      console.error('[terrain] horizon probe skipped:', err.message);
    }
  }));

  // Map each point to its own horizon or nearest resolved station along the route.
  const stationPositions = [];
  for (let i = 0; i < points.length; i++) {
    if (resolved.has(keys[i])) stationPositions.push({ i, h: resolved.get(keys[i]) });
  }
  let ptr = 0;
  return points.map((_, i) => {
    const direct = resolved.get(keys[i]);
    if (direct) return direct;
    if (!stationPositions.length) return null;
    while (ptr + 1 < stationPositions.length && Math.abs(stationPositions[ptr + 1].i - i) <= Math.abs(stationPositions[ptr].i - i)) {
      ptr++;
    }
    return stationPositions[ptr].h;
  });
};

/**
 * Terrain for trail points [{ lat, lon }]. Returns { status, byPoint: [{ slopeDeg,
 * aspectDeg, elevationM, canopy, nlcd, horizonDeg } | null], failedLayers }.
 */
const DEFAULT_BUDGET_MS = 13500;
const MIN_HORIZON_BUDGET_MS = 2500;

export const loadTerrain = async ({ points, horizon = true, budgetMs = DEFAULT_BUDGET_MS }) => {
  const deadlineAt = Date.now() + budgetMs;
  const keys = points.map(keyOf);
  const unique = [...new Set(keys)];
  const values = new Map();
  const missesByRegion = new Map();
  const seenMisses = new Set();
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (values.has(k) || seenMisses.has(k)) continue;
    const v = terrainCache.get(k);
    if (v !== undefined) { values.set(k, v); continue; }
    seenMisses.add(k);
    const region = regionOf(points[i]);
    if (!missesByRegion.has(region)) missesByRegion.set(region, []);
    missesByRegion.get(region).push(k);
  }

  const failedLayers = new Set();
  const batches = [];
  for (const [region, regionMisses] of missesByRegion.entries()) {
    for (let i = 0; i < regionMisses.length; i += MAX_POINTS_PER_CALL) {
      batches.push({ region, keys: regionMisses.slice(i, i + MAX_POINTS_PER_CALL) });
    }
  }
  await mapLimit(batches, 2, async ({ region, keys: batch }) => {
    const layers = LAYERS_BY_REGION[region];
    const coords = batch.map(k => { const [lat, lon] = k.split(',').map(Number); return [lon, lat]; });
    const results = {};
    await Promise.all(Object.entries(layers).map(async ([name, layer]) => {
      try {
        results[name] = (await sampleLayer(layer, coords)).map(v => clean[name](v, layer.lcms));
      } catch (err) {
        console.error(`[terrain] ${region}/${name} failed:`, err.message);
        failedLayers.add(name);
        results[name] = null;
      }
    }));
    const complete = Object.keys(layers).every(name => results[name]);
    batch.forEach((k, i) => {
      const rawCover = results.landCover?.[i] ?? null;
      const mapped = layers.landCover.lcms && rawCover != null ? mapLcms(rawCover) : null;
      const nlcd = mapped ? mapped.nlcd : rawCover;
      const canopy = results.canopy?.[i] ?? mapped?.canopy ?? null;
      const v = {
        slopeDeg: results.slope?.[i] ?? null,
        aspectDeg: results.aspect?.[i] ?? null,
        elevationM: results.elevation?.[i] ?? null,
        canopy,
        nlcd,
      };
      values.set(k, v);
      // Only complete answers are kept for a month; a partial one is retried next time.
      if (complete) terrainCache.set(k, v, { ttlMs: TTL_MS });
    });
  }, { deadlineAt });

  const remaining = deadlineAt - Date.now();
  let horizons;
  if (horizon !== false && remaining >= MIN_HORIZON_BUDGET_MS) {
    let hTimer;
    horizons = await Promise.race([
      loadHorizons(points, keys, values).catch(() => points.map(() => null)),
      new Promise(resolve => { hTimer = setTimeout(resolve, remaining, points.map(() => null)); }),
    ]).finally(() => clearTimeout(hTimer));
  } else {
    horizons = points.map(() => null);
  }
  const answered = unique.filter(k => values.get(k) && Object.values(values.get(k)).some(v => v != null)).length;
  return {
    status: unique.length && answered === 0 ? 'error' : failedLayers.size ? 'partial' : 'ok',
    byPoint: keys.map((k, i) => {
      const v = values.get(k);
      if (!v) return null;
      return horizons[i] ? { ...v, horizonDeg: horizons[i] } : { ...v, horizonDeg: null };
    }),
    failedLayers: [...failedLayers],
  };
};
