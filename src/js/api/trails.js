/**
 * Client-side Trail Finder API (shared contract with the UI panels).
 *
 * Combines:
 * - Curated featured classics (/data/featured-trails.json)
 * - Saved / offline-ready routes from IndexedDB
 * - Live USFS & NPS public trail search and stitched trail geometries
 *   (called directly via server/sources/trailSearch.js when running inside
 *   Capacitor native, or via GET /api/trails/* in the browser).
 */
import { parseRouteText } from '../gpx/importer.js';
import { cumulativeMiles, haversineMiles, sliceByMiles } from '../../../shared/geo.js';
import {
  findMatchingCorridor,
  serializeCorridor,
  assignCorridorRegion,
} from '../../../shared/trails/corridors.js';

const FEATURED_URL = '/data/featured-trails.json';
const SEARCH_ENDPOINT = '/api/trails/search';
const GEOMETRY_ENDPOINT = '/api/trails/geometry';
const DEFAULT_RADIUS_MILES = 25;
const DEFAULT_LIMIT = 80;

let featuredCache = null;
let featuredPromise = null;

const isNativePlatform = () =>
  typeof window !== 'undefined' && Boolean(window.Capacitor?.isNativePlatform?.());

const isOffline = () =>
  typeof navigator !== 'undefined' && navigator.onLine === false;

const loadNativeTrailModule = () => import('../../../server/sources/trailSearch.js');

const normalizeNameKey = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/\btrail\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const trailDedupKey = (trail) => {
  if (trail.queryMeta?.corridorId && trail.queryMeta?.unit) {
    return `${String(trail.queryMeta.source || '').toLowerCase()}|corridor:${trail.queryMeta.corridorId}|${String(trail.queryMeta.unit).toUpperCase()}`;
  }
  if (trail.queryMeta?.source) {
    const src = String(trail.queryMeta.source).toLowerCase();
    const unit = String(trail.queryMeta.unit || '').toUpperCase();
    const nm = normalizeNameKey(trail.queryMeta.name || trail.name);
    return `${src}|${unit}|${nm}`;
  }
  return `id|${trail.id || normalizeNameKey(trail.name)}`;
};

const loadFeaturedTrails = async (signal) => {
  if (featuredCache) return featuredCache;
  if (!featuredPromise) {
    featuredPromise = (async () => {
      const res = await fetch(FEATURED_URL, { signal });
      if (!res.ok) throw new Error(`Featured trails HTTP ${res.status}`);
      const json = await res.json();
      const list = Array.isArray(json) ? json : Array.isArray(json?.trails) ? json.trails : [];
      featuredCache = list.map((t) => ({ ...t, featured: true }));
      return featuredCache;
    })().catch((err) => {
      featuredPromise = null;
      if (err?.name === 'AbortError' && signal?.aborted) throw err;
      return [];
    });
  }
  return featuredPromise;
};

/** Clear the in-memory featured catalog cache (useful for tests). */
export const resetFeaturedCache = () => {
  featuredCache = null;
  featuredPromise = null;
};

const fileBaseName = (url) => String(url || '').split('/').pop()?.split('?')[0] || '';

const findSavedMatch = (trail, savedRoutes) => {
  if (!Array.isArray(savedRoutes) || !savedRoutes.length) return null;
  const targetName = normalizeNameKey(trail.name);
  const sampleFile = trail.sampleUrl ? fileBaseName(trail.sampleUrl).toLowerCase() : '';
  for (const r of savedRoutes) {
    if (!r) continue;
    if (r.meta?.trailId && r.meta.trailId === trail.id) return r;
    if (sampleFile && String(r.meta?.fileName || '').toLowerCase() === sampleFile) return r;
    if (targetName && normalizeNameKey(r.name) === targetName) return r;
  }
  return null;
};

const enrichWithSaved = (trail, savedRoutes, activeCorridor = null) => {
  const match = findSavedMatch(trail, savedRoutes);
  const enriched = {
    ...trail,
    ...(match ? {
      savedId: match.id,
      offlineReady: Boolean(match.offlinePack),
      level: match.lastCheck?.summary?.level ?? null,
    } : {}),
  };
  if (activeCorridor && !enriched.corridorRegion && enriched.queryMeta?.corridorId === activeCorridor.id) {
    enriched.corridorRegion = assignCorridorRegion(activeCorridor, enriched);
  }
  return enriched;
};

const mapSavedRoute = (r) => ({
  id: r.meta?.trailId || `saved:${r.id}`,
  name: r.name || 'Untitled route',
  region: r.meta?.region || 'Saved on this device',
  agency: r.meta?.agency || 'Saved',
  lengthMiles: Number.isFinite(r.meta?.lengthMiles) ? Math.round(r.meta.lengthMiles * 10) / 10 : null,
  gainFt: Number.isFinite(r.meta?.gainFt) ? Math.round(r.meta.gainFt) : null,
  source: r.meta?.source || 'saved',
  featured: false,
  savedId: r.id,
  offlineReady: Boolean(r.offlinePack),
  level: r.lastCheck?.summary?.level ?? null,
  ...(Array.isArray(r.meta?.start) ? { start: r.meta.start } : {}),
  ...(r.meta?.sampleUrl ? { sampleUrl: r.meta.sampleUrl } : {}),
  ...(r.meta?.queryMeta ? { queryMeta: r.meta.queryMeta } : {}),
});

const matchesQuery = (trail, query, corridor = null) => {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  if (corridor && normalizeNameKey(trail.name).includes(corridor.name.split(' (')[0].toLowerCase())) {
    return true;
  }
  const hay = `${trail.name || ''} ${trail.region || ''} ${trail.agency || ''}`.toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  return tokens.every((tok) => hay.includes(tok));
};

const extractLocation = (location) => {
  if (!location || typeof location !== 'object') return null;
  const lat = Number(location.lat);
  const lon = Number(location.lon ?? location.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
};

const fetchLiveSearch = async ({ query, loc, radiusMiles = DEFAULT_RADIUS_MILES, limit = DEFAULT_LIMIT, signal }) => {
  if (isNativePlatform()) {
    const { searchPublicTrails } = await loadNativeTrailModule();
    return searchPublicTrails({
      query,
      lat: loc?.lat ?? null,
      lon: loc?.lon ?? null,
      radiusMiles,
      limit,
    });
  }

  const qs = new URLSearchParams();
  if (query) qs.set('q', query);
  if (loc) {
    qs.set('lat', String(loc.lat));
    qs.set('lon', String(loc.lon));
    qs.set('radius', String(radiusMiles));
  }
  qs.set('limit', String(limit));

  const res = await fetch(`${SEARCH_ENDPOINT}?${qs}`, { cache: 'no-store', signal });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* handled below */ }
  if (!res.ok) {
    throw new Error(body?.error || `Trail search failed (HTTP ${res.status}).`);
  }
  return {
    trails: Array.isArray(body?.trails) ? body.trails : [],
    totalCount: Number.isFinite(body?.totalCount) ? body.totalCount : null,
    corridor: body?.corridor || null,
    note: typeof body?.note === 'string' ? body.note : null,
  };
};

/**
 * Search featured, saved, and live public USFS/NPS trails.
 *
 * Returns `{ trails, totalCount, corridor, note }`.
 */
export const searchTrails = async ({
  query = '',
  filter = 'featured',
  location = null,
  savedRoutes = [],
  signal,
} = {}) => {
  const q = String(query || '').trim();
  const loc = extractLocation(location);

  if (filter === 'saved') {
    const trails = (savedRoutes || [])
      .map(mapSavedRoute)
      .filter((t) => matchesQuery(t, q));
    return { trails, totalCount: trails.length, corridor: null, note: null };
  }

  const featured = await loadFeaturedTrails(signal);
  const localCorridor = filter !== 'near' ? findMatchingCorridor(q) : null;

  const shouldQueryLive = q.length >= 2 || (filter === 'near' && Boolean(loc));

  if (!shouldQueryLive) {
    if (filter === 'near' && !loc) {
      return { trails: [], totalCount: 0, corridor: null, note: 'Allow location access to find trails near you.' };
    }
    const trails = featured
      .filter((t) => matchesQuery(t, q))
      .map((t) => enrichWithSaved(t, savedRoutes));
    return { trails, totalCount: trails.length, corridor: null, note: null };
  }

  const featuredMatches = featured.filter((t) => {
    if (q.length >= 2) return matchesQuery(t, q, localCorridor);
    if (loc && Array.isArray(t.start)) {
      return haversineMiles(loc.lon, loc.lat, t.start[0], t.start[1]) <= DEFAULT_RADIUS_MILES;
    }
    return false;
  });

  let liveTrails = [];
  let totalCount = null;
  let corridor = serializeCorridor(localCorridor);
  let note = null;

  try {
    const live = await fetchLiveSearch({
      query: q.length >= 2 ? q : '',
      loc: filter === 'near' ? loc : null,
      signal,
    });
    liveTrails = live.trails || [];
    totalCount = live.totalCount;
    if (live.corridor) corridor = live.corridor;
    note = live.note || null;
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') throw err;
    note = isOffline()
      ? 'Offline — showing featured and saved trails only.'
      : 'Live public trail search is temporarily unavailable — showing featured trails.';
  }

  // Merge featured matches ahead of live results, deduplicating by source/unit/name.
  const merged = [];
  const seen = new Set();

  for (const t of featuredMatches) {
    const key = trailDedupKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(enrichWithSaved(t, savedRoutes, corridor));
  }

  for (const t of liveTrails) {
    const key = trailDedupKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(enrichWithSaved(t, savedRoutes, corridor));
  }

  if (filter === 'near' && loc && q.length < 2) {
    merged.sort((a, b) => {
      const da = Array.isArray(a.start) ? haversineMiles(loc.lon, loc.lat, a.start[0], a.start[1]) : Infinity;
      const db = Array.isArray(b.start) ? haversineMiles(loc.lon, loc.lat, b.start[0], b.start[1]) : Infinity;
      return da - db;
    });
  }

  return {
    trails: merged,
    totalCount: Math.max(merged.length, totalCount || 0),
    corridor: filter === 'near' ? null : corridor,
    note,
  };
};

/**
 * Fetch the full (or mile-sliced) track coordinates for a trail returned by `searchTrails`,
 * or a corridor object (`{ sampleUrl }` or `{ queryMeta: { source: 'corridor', corridorId } }`).
 *
 * Returns `{ name, coords }` (plus `lengthMiles` when available).
 */
export const fetchTrailTrack = async (trail, { startMile = null, endMile = null, signal } = {}) => {
  if (!trail || typeof trail !== 'object') {
    throw new Error('Select a trail to load its track.');
  }

  const hasSlice = startMile != null || endMile != null;

  if (trail.sampleUrl) {
    const res = await fetch(trail.sampleUrl, { signal });
    if (!res.ok) {
      throw new Error(`Could not load "${trail.name || 'sample trail'}" (HTTP ${res.status}).`);
    }
    const text = await res.text();
    const parsed = parseRouteText(text, fileBaseName(trail.sampleUrl) || 'trail.gpx');
    if (hasSlice && Array.isArray(parsed.coords) && parsed.coords.length >= 2) {
      const cum = cumulativeMiles(parsed.coords);
      const total = cum[cum.length - 1];
      const a = Math.max(0, Math.min(Number(startMile ?? 0), Math.max(0, total - 0.3)));
      const b = Math.max(a + 0.3, Math.min(Number(endMile ?? total), total));
      const coords = sliceByMiles(parsed.coords, cum, a, b);
      const sCum = cumulativeMiles(coords);
      const baseName = String(trail.name || parsed.name || 'Route').replace(/\s*\([A-Z]+\)$/, '');
      return {
        name: `${baseName} (Mi ${Math.round(a)}–${Math.round(b)})`,
        coords,
        lengthMiles: Math.round(sCum[sCum.length - 1] * 100) / 100,
      };
    }
    return {
      name: trail.name || parsed.name,
      coords: parsed.coords,
    };
  }

  if (trail.queryMeta) {
    const meta = {
      ...trail.queryMeta,
      ...(hasSlice ? { startMile, endMile } : {}),
    };

    if (isNativePlatform()) {
      const { fetchPublicTrailGeometry } = await loadNativeTrailModule();
      const data = await fetchPublicTrailGeometry(meta);
      return {
        name: hasSlice ? data.name : (trail.name || data.name),
        coords: data.coords,
        lengthMiles: data.lengthMiles,
      };
    }

    const qs = new URLSearchParams({ source: meta.source });
    if (meta.name) qs.set('name', meta.name);
    if (meta.trailNo) qs.set('trailNo', meta.trailNo);
    if (meta.trailNoPrefix) qs.set('trailNoPrefix', meta.trailNoPrefix);
    if (meta.corridorId) qs.set('corridorId', meta.corridorId);
    if (meta.unit) qs.set('unit', meta.unit);
    if (startMile != null) qs.set('startMile', String(startMile));
    if (endMile != null) qs.set('endMile', String(endMile));

    const res = await fetch(`${GEOMETRY_ENDPOINT}?${qs}`, { signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* handled below */ }
    if (!res.ok) {
      throw new Error(body?.error || `Could not load trail geometry (HTTP ${res.status}).`);
    }
    if (!Array.isArray(body?.coords) || body.coords.length < 2) {
      throw new Error(`No usable track geometry was returned for "${trail.name || 'this trail'}".`);
    }
    return {
      name: hasSlice ? body.name : (trail.name || body.name),
      coords: body.coords,
      lengthMiles: body.lengthMiles,
    };
  }

  throw new Error('This trail does not include a downloadable track.');
};
