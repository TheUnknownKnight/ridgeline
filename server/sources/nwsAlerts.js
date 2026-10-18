import { sourceCache } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { mapLimit } from '../lib/pool.js';
import { prepPolygons, polygonsBbox } from '../lib/spatial.js';
import { bboxIntersects } from '../../shared/geo.js';
import { statesForRoute, STATE_CODES } from './usStates.js';

const ALERTS_URL = 'https://api.weather.gov/alerts/active?status=actual';
const ZONE_URL = 'https://api.weather.gov/zones';

export const ATTRIBUTION = 'National Weather Service';
export const SOURCE_URL = 'https://www.weather.gov/';

// Alerts change minute to minute (the API itself says max-age=5); refresh
// every minute and never serve anything older than 30 min as current.
const ALERTS_TTL_MS = 60 * 1000;
const ALERTS_REVALIDATE_MS = 2 * 60 * 1000;
const ALERTS_STALE_MS = 30 * 60 * 1000;
// Zone boundaries change about twice a year.
const ZONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ZONE_SIMPLIFY_MILES = 0.08;
const MAX_ZONE_FETCHES = 400;

const DEAD_VTEC_ACTIONS = new Set(['CAN', 'UPG', 'EXP']);
const SEVERITY_RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };

const parseZoneUrl = (url) => {
  const m = /\/zones\/(forecast|fire|county|public)\/([A-Z]{2}[ZC]\d{3})$/i.exec(String(url || '').trim());
  if (!m) return null;
  const type = m[1].toLowerCase() === 'public' ? 'forecast' : m[1].toLowerCase();
  return { key: `${type}/${m[2].toUpperCase()}`, type, id: m[2].toUpperCase(), state: m[2].slice(0, 2).toUpperCase() };
};

// "/O.NEW.KSTO.FW.W.0012.261018T1800Z-261019T0300Z/" -> { key: 'KSTO.FW.W.0012', action: 'NEW' }
const parseVtec = (vtec) => {
  const m = /\/[OTEX]\.([A-Z]{3})\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\./.exec(String(vtec || ''));
  return m ? { action: m[1], key: `${m[2]}.${m[3]}.${m[4]}.${m[5]}` } : null;
};

const ms = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

const normalizeAlert = (f) => {
  const p = f.properties || {};
  if (p.status !== 'Actual' || p.messageType === 'Cancel') return null;
  const vtec = parseVtec(p.parameters?.VTEC?.[0]);
  if (vtec && DEAD_VTEC_ACTIONS.has(vtec.action)) return null;
  if (p.response === 'AllClear' && p.urgency === 'Past') return null;

  // `expires` is when the message expires, not the hazard; prefer `ends`.
  const end = ms(p.ends) ?? ms(p.parameters?.eventEndingTime?.[0]) ?? ms(p.expires);
  const polygons = f.geometry ? prepPolygons(f.geometry, 0) : [];
  return {
    // One event (VTEC key) is often split into zone segments with different
    // text and times; each segment stays its own record and the detector
    // groups them into one hazard.
    key: vtec ? `vtec:${vtec.key}` : `id:${p.id || f.id}`,
    segmentId: p.id || f.id || null,
    event: p.event || 'Weather alert',
    // headline carries local issue/expiry times; NWSheadline is the plain-language summary (ALL CAPS).
    headline: p.headline || null,
    summary: p.parameters?.NWSheadline?.[0] || null,
    severity: p.severity || 'Unknown',
    urgency: p.urgency || 'Unknown',
    certainty: p.certainty || 'Unknown',
    sent: ms(p.sent),
    onset: ms(p.onset) ?? ms(p.effective),
    end,
    senderName: p.senderName || null,
    areaDesc: p.areaDesc || null,
    description: p.description ? String(p.description).slice(0, 1500) : null,
    instruction: p.instruction ? String(p.instruction).slice(0, 800) : null,
    // A warned polygon is authoritative; its county zones are broader than the warning.
    polygons,
    bbox: polygons.length ? polygonsBbox(polygons) : null,
    zones: polygons.length ? [] : (p.affectedZones || []).map(parseZoneUrl).filter(Boolean),
  };
};

const fetchAlerts = async () => {
  const data = await fetchJson(ALERTS_URL, {
    label: 'NWS alerts', timeoutMs: 15000, retries: 2, headers: { Accept: 'application/geo+json' },
  });
  if (!Array.isArray(data?.features)) throw new Error('NWS alerts response missing features[]');
  // Hundreds of alerts are active nationwide at any moment; zero is a glitch.
  if (data.features.length === 0) throw new Error('NWS returned no active alerts nationwide');
  return data.features.map(normalizeAlert).filter(Boolean);
};

const fetchZone = async (zone) => {
  const data = await fetchJson(`${ZONE_URL}/${zone.type}/${zone.id}`, {
    label: 'NWS zone', timeoutMs: 15000, retries: 2, headers: { Accept: 'application/geo+json' },
  });
  const polygons = prepPolygons(data?.geometry, ZONE_SIMPLIFY_MILES);
  return { key: zone.key, name: data?.properties?.name || zone.id, polygons, bbox: polygons.length ? polygonsBbox(polygons) : null };
};

/**
 * Active NWS alerts that could touch the route, each with the polygon(s)
 * it covers: the warned polygon when present, otherwise its zones' shapes.
 */
export const loadAlerts = async ({ route, now = Date.now() }) => {
  let all;
  let fetchedAt;
  let stale;
  try {
    ({ value: all, fetchedAt, stale } = await sourceCache.wrap(
      'nws:alerts', { ttlMs: ALERTS_TTL_MS, revalidateMs: ALERTS_REVALIDATE_MS, staleMs: ALERTS_STALE_MS }, fetchAlerts));
  } catch (err) {
    console.error('[nws-alerts] load failed:', err.message);
    return {
      status: 'error', fetchedAt: null, attribution: ATTRIBUTION, url: SOURCE_URL,
      message: 'NWS alerts unavailable — watches and warnings could not be checked',
      data: { alerts: [] },
    };
  }

  const states = statesForRoute(route);
  const live = all.filter(a => !a.end || a.end > now);
  const candidates = live.filter(a => (a.bbox
    ? bboxIntersects(a.bbox, route.paddedBbox)
    : a.zones.some(z => states.has(z.state) && STATE_CODES.has(z.state))));

  // Zones wanted, with the worst severity of any alert that needs them.
  const wantedZones = new Map();
  for (const a of candidates) {
    for (const z of a.zones) {
      if (!states.has(z.state)) continue;
      const rank = SEVERITY_RANK[a.severity] ?? 0;
      const prev = wantedZones.get(z.key);
      if (!prev || rank > prev.rank) wantedZones.set(z.key, { zone: z, rank });
    }
  }
  // Cached shapes cost nothing; the fetch budget applies only to new ones,
  // warnings first, so every request makes progress and converges.
  const zoneShapes = new Map();
  const uncached = [];
  for (const { zone, rank } of wantedZones.values()) {
    const hit = sourceCache.get(`nws:zone:${zone.key}`);
    if (hit) zoneShapes.set(zone.key, hit);
    else uncached.push({ zone, rank });
  }
  uncached.sort((a, b) => b.rank - a.rank);
  const toFetch = uncached.slice(0, MAX_ZONE_FETCHES).map(u => u.zone);
  const results = await mapLimit(toFetch, 8, (z) =>
    sourceCache.wrap(`nws:zone:${z.key}`, { ttlMs: ZONE_TTL_MS, errorTtlMs: 60 * 1000 }, () => fetchZone(z)));
  let zoneFailures = uncached.length - toFetch.length;
  results.forEach((r, i) => {
    if (r.error || !r.value?.bbox) { zoneFailures++; return; }
    zoneShapes.set(toFetch[i].key, r.value);
  });

  const alerts = [];
  for (const a of candidates) {
    const areas = a.bbox
      ? [{ name: a.areaDesc, polygons: a.polygons, bbox: a.bbox }]
      : a.zones.map(z => zoneShapes.get(z.key)).filter(Boolean);
    const near = areas.filter(ar => bboxIntersects(ar.bbox, route.paddedBbox));
    if (near.length) alerts.push({ ...a, areas: near });
  }

  let status = stale ? 'stale' : 'ok';
  if (zoneFailures > 0) status = 'partial';
  const age = Math.round((now - fetchedAt) / 60000);
  const message = [
    stale ? `NWS unreachable — alerts from ${age} min ago` : `${live.length} active alerts nationwide`,
    zoneFailures ? `${zoneFailures} alert area${zoneFailures === 1 ? '' : 's'} could not be loaded` : null,
  ].filter(Boolean).join('. ');

  return {
    status,
    fetchedAt: new Date(fetchedAt).toISOString(),
    message,
    attribution: ATTRIBUTION,
    url: SOURCE_URL,
    data: { alerts },
  };
};
