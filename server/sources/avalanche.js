import { sourceCache } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { prepPolygons, polygonsBbox } from '../lib/spatial.js';
import { safeHttpUrl } from '../lib/url.js';

const MAP_LAYER_URL = 'https://api.avalanche.org/v2/public/products/map-layer';

export const ATTRIBUTION = 'avalanche.org (National Avalanche Center)';
export const SOURCE_URL = 'https://avalanche.org/';

// Centers re-issue in the early morning; a 10-minute refresh catches it.
const TTL_MS = 10 * 60 * 1000;
const REVALIDATE_MS = 20 * 60 * 1000;
const STALE_MS = 6 * 60 * 60 * 1000;

// Observation/information centers that never issue danger ratings.
const INFO_ONLY_CENTERS = new Set(['CAC', 'EARAC', 'EWYAIX', 'HAC', 'SOAIX']);

// map-layer dates are UTC with the offset stripped ("2026-10-19T18:00:00").
const parseUtc = (s) => {
  if (!s || typeof s !== 'string') return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) ? t : null;
};

const normalizeZone = (f) => {
  const p = f.properties || {};
  const polygons = prepPolygons(f.geometry, 0.05);
  if (!polygons.length) return null;
  const level = Number.isInteger(p.danger_level) ? p.danger_level : -1;
  return {
    id: `${p.center_id || 'UNK'}:${f.id ?? p.name}`,
    name: p.name && p.name !== 'CAIC zone' ? String(p.name).trim() : (p.center_id === 'CAIC' ? 'Colorado' : String(p.name || 'Forecast zone')),
    center: p.center || p.center_id || 'Avalanche center',
    centerId: p.center_id || null,
    state: p.state || null,
    timeZone: p.timezone || null,
    link: safeHttpUrl(p.link) || safeHttpUrl(p.center_link),
    offSeason: p.off_season === true,
    dangerLevel: level,
    danger: typeof p.danger === 'string' ? p.danger : null,
    travelAdvice: level >= 1 && typeof p.travel_advice === 'string' ? p.travel_advice.trim() : null,
    warning: p.warning?.product === 'warning',
    startsAt: parseUtc(p.start_date),
    endsAt: parseUtc(p.end_date),
    infoOnly: INFO_ONLY_CENTERS.has(p.center_id),
    polygons,
    bbox: polygonsBbox(polygons),
  };
};

const fetchZones = async () => {
  const data = await fetchJson(MAP_LAYER_URL, { label: 'avalanche.org map-layer', timeoutMs: 15000, retries: 2 });
  if (!Array.isArray(data?.features)) throw new Error('avalanche.org response missing features[]');
  const zones = data.features.map(normalizeZone).filter(Boolean);
  // ~80 zones exist year-round (rated or not); none means a broken response.
  if (zones.length === 0) throw new Error('avalanche.org returned no forecast zones');
  return zones;
};

/**
 * Forecast state per zone at `now`. Expiry is re-checked per request because
 * a cached layer can outlive the forecasts inside it.
 */
export const zoneState = (zone, now) => {
  if (zone.infoOnly) return 'info-only';
  if (zone.endsAt && zone.endsAt <= now) return 'expired';
  if (zone.dangerLevel >= 1 && zone.dangerLevel <= 5) return 'rated';
  if (zone.warning) return 'rated';
  if (zone.offSeason) return 'off-season';
  if (!zone.endsAt) return 'no-forecast';
  return 'no-rating';
};

export const loadAvalanche = async () => {
  try {
    const { value, fetchedAt, stale } = await sourceCache.wrap(
      'avy:map-layer', { ttlMs: TTL_MS, revalidateMs: REVALIDATE_MS, staleMs: STALE_MS }, fetchZones);
    return {
      status: stale ? 'stale' : 'ok',
      fetchedAt: new Date(fetchedAt).toISOString(),
      message: stale ? 'avalanche.org unreachable — showing an older copy' : `${value.length} forecast zones`,
      attribution: ATTRIBUTION,
      url: SOURCE_URL,
      data: { zones: value },
    };
  } catch (err) {
    console.error('[avalanche] load failed:', err.message);
    return {
      status: 'error',
      fetchedAt: null,
      message: 'Avalanche forecasts unavailable — check your local avalanche center',
      attribution: ATTRIBUTION,
      url: SOURCE_URL,
      data: { zones: [] },
    };
  }
};
