import { sourceCache } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { prepPolygons, polygonsBbox, distanceToPolygonsMiles } from '../lib/spatial.js';

const ORG = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services';
const PERIMETERS_URL = `${ORG}/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query`;
const INCIDENTS_URL = `${ORG}/WFIGS_Incident_Locations_Current/FeatureServer/0/query`;

export const ATTRIBUTION = 'NIFC WFIGS (IRWIN)';
export const SOURCE_URL = 'https://data-nifc.opendata.arcgis.com/';

// Upstream refreshes every 5 minutes; serve the last good copy for up to 6 h
// if NIFC is down, flagged stale, rather than ever reporting "no fires".
const TTL_MS = 5 * 60 * 1000;
const REVALIDATE_MS = 10 * 60 * 1000;
const STALE_MS = 6 * 60 * 60 * 1000;
const PAGE_SIZE = 2000;
const COMPLEX_COVER_MILES = 0.5;
const MAX_PAGES = 10;

const PERIMETER_FIELDS = [
  'OBJECTID', 'attr_IrwinID', 'attr_UniqueFireIdentifier', 'attr_IncidentName', 'poly_IncidentName',
  'attr_IncidentTypeCategory', 'poly_GISAcres', 'attr_IncidentSize', 'poly_Acres_AutoCalc',
  'attr_PercentContained', 'attr_FireDiscoveryDateTime', 'attr_ModifiedOnDateTime_dt', 'poly_DateCurrent',
  'poly_PolygonDateTime', 'poly_MapMethod', 'attr_POOState', 'attr_IsCpxChild', 'attr_CpxID',
  'attr_IncidentComplexityLevel',
];

const INCIDENT_FIELDS = [
  'OBJECTID', 'IrwinID', 'UniqueFireIdentifier', 'IncidentName', 'IncidentTypeCategory', 'IncidentSize',
  'PercentContained', 'FireDiscoveryDateTime', 'ModifiedOnDateTime_dt', 'POOState', 'IsCpxChild', 'CpxID',
  'CpxName', 'IncidentComplexityLevel', 'IncidentShortDescription', 'FireBehaviorGeneral',
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const firstNum = (...vals) => vals.map(num).find(v => v != null && v > 0) ?? null;
const normId = (v) => (typeof v === 'string' && v.trim() ? v.trim().toUpperCase() : null);

// Names arrive in mixed case, often ALL CAPS; title-case only the shouting ones.
const tidyName = (s) => {
  const name = String(s || '').trim();
  if (!name) return 'Unnamed fire';
  if (name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bRx\b/i, 'RX');
};

const queryAll = async (url, params, label) => {
  const features = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      ...params,
      f: 'geojson',
      outSR: '4326',
      returnGeometry: 'true',
      resultOffset: String(page * PAGE_SIZE),
      resultRecordCount: String(PAGE_SIZE),
    });
    const data = await fetchJson(`${url}?${qs}`, { label, timeoutMs: 20000, retries: 2 });
    // ArcGIS reports query errors as HTTP 200 with an error body.
    if (data?.error) throw new Error(`${label} query error: ${JSON.stringify(data.error).slice(0, 200)}`);
    if (!Array.isArray(data?.features)) throw new Error(`${label} response missing features[]`);
    features.push(...data.features);
    const more = data.exceededTransferLimit || data.properties?.exceededTransferLimit;
    if (!more || data.features.length === 0) return features;
  }
  console.warn(`[nifc] ${label}: stopped after ${MAX_PAGES} pages`);
  return features;
};

const normalizePerimeter = (f) => {
  const p = f.properties || {};
  // 0.02 mi (~30 m) on top of ArcGIS's own generalization keeps vertex counts low for PIP.
  const polygons = prepPolygons(f.geometry, 0.02);
  if (!polygons.length) return null;
  const irwinId = normId(p.attr_IrwinID);
  return {
    key: irwinId || `OBJ${p.OBJECTID}`,
    irwinId,
    name: tidyName(p.attr_IncidentName || p.poly_IncidentName),
    polyName: p.poly_IncidentName ? String(p.poly_IncidentName).trim() : null,
    category: p.attr_IncidentTypeCategory || 'WF',
    acres: firstNum(p.poly_GISAcres, p.attr_IncidentSize, p.poly_Acres_AutoCalc),
    // null (unknown) must stay distinct from 0 (no containment).
    percentContained: num(p.attr_PercentContained),
    discoveredAt: num(p.attr_FireDiscoveryDateTime),
    updatedAt: num(p.attr_ModifiedOnDateTime_dt),
    perimeterAsOf: num(p.poly_PolygonDateTime) ?? num(p.poly_DateCurrent),
    mapMethod: p.poly_MapMethod || null,
    state: p.attr_POOState ? String(p.attr_POOState).replace(/^US-/, '') : null,
    complexity: p.attr_IncidentComplexityLevel || null,
    isComplexChild: p.attr_IsCpxChild === 1 || p.attr_IsCpxChild === '1',
    complexId: normId(p.attr_CpxID),
    polygons,
    bbox: polygonsBbox(polygons),
  };
};

const normalizeIncident = (f) => {
  const p = f.properties || {};
  const c = f.geometry?.type === 'Point' ? f.geometry.coordinates : null;
  // The point geometry is the point of origin; InitialLatitude/Longitude can be far off.
  if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
  const irwinId = normId(p.IrwinID);
  return {
    key: irwinId || `OBJ${p.OBJECTID}`,
    irwinId,
    name: tidyName(p.IncidentName),
    category: p.IncidentTypeCategory || 'WF',
    acres: firstNum(p.IncidentSize),
    percentContained: num(p.PercentContained),
    discoveredAt: num(p.FireDiscoveryDateTime),
    updatedAt: num(p.ModifiedOnDateTime_dt),
    state: p.POOState ? String(p.POOState).replace(/^US-/, '') : null,
    complexity: p.IncidentComplexityLevel || null,
    isComplexChild: p.IsCpxChild === 1 || p.IsCpxChild === '1',
    complexId: normId(p.CpxID),
    complexName: p.CpxName ? tidyName(p.CpxName) : null,
    description: p.IncidentShortDescription || null,
    behavior: p.FireBehaviorGeneral || null,
    lon: c[0],
    lat: c[1],
  };
};

const fetchFireData = async () => {
  const [rawPerimeters, rawIncidents] = await Promise.all([
    queryAll(PERIMETERS_URL, {
      where: '1=1',
      outFields: PERIMETER_FIELDS.join(','),
      geometryPrecision: '5',
      maxAllowableOffset: '0.0002',
    }, 'NIFC perimeters'),
    queryAll(INCIDENTS_URL, {
      where: '1=1',
      outFields: INCIDENT_FIELDS.join(','),
      geometryPrecision: '5',
    }, 'NIFC incidents'),
  ]);

  const perimeters = rawPerimeters.map(normalizePerimeter).filter(Boolean);
  const normalizedIncidents = rawIncidents.map(normalizeIncident).filter(Boolean);
  // The incident feed always lists dozens of fires and burns nationwide;
  // an empty one is an upstream glitch and must not replace good data.
  if (normalizedIncidents.length === 0) throw new Error('NIFC returned no incidents nationwide');

  const perimeterIds = new Set(perimeters.map(p => p.irwinId).filter(Boolean));
  // Perimeters by the complex they belong to (or are).
  const byComplex = new Map();
  for (const p of perimeters) {
    for (const key of [p.complexId, p.irwinId]) {
      if (!key) continue;
      if (!byComplex.has(key)) byComplex.set(key, []);
      byComplex.get(key).push(p);
    }
  }
  // A complex child without its own perimeter is covered only if a perimeter of
  // its complex actually contains its origin (complex shapes are not unions
  // of their children — a child can burn miles from the mapped part).
  const coveredByComplex = (inc) => (byComplex.get(inc.complexId) || [])
    .some(p => distanceToPolygonsMiles(inc.lon, inc.lat, p.polygons) <= COMPLEX_COVER_MILES);
  const incidents = normalizedIncidents.map(inc => ({
    ...inc,
    hasPerimeter: perimeterIds.has(inc.irwinId)
      || (inc.category === 'CX' && byComplex.has(inc.irwinId))
      || (inc.complexId != null && coveredByComplex(inc)),
  }));

  // Rolled-up complex hazards report the complex's own totals.
  const complexes = new Map(incidents.filter(i => i.category === 'CX' && i.irwinId)
    .map(i => [i.irwinId, { name: i.name, acres: i.acres, percentContained: i.percentContained }]));
  for (const p of perimeters) {
    if (p.isComplexChild && p.complexId && complexes.has(p.complexId)) p.complex = complexes.get(p.complexId);
  }

  console.log(`[nifc] ${perimeters.length} perimeters, ${incidents.length} incidents (${incidents.filter(i => !i.hasPerimeter).length} without perimeter)`);
  return { perimeters, incidents };
};

/** Nationwide active fire perimeters + incident points, shared across all routes. */
export const loadFire = async () => {
  try {
    const { value, fetchedAt, stale } = await sourceCache.wrap(
      'nifc:all', { ttlMs: TTL_MS, revalidateMs: REVALIDATE_MS, staleMs: STALE_MS }, fetchFireData);
    return {
      status: stale ? 'stale' : 'ok',
      fetchedAt: new Date(fetchedAt).toISOString(),
      message: stale
        ? `NIFC unreachable — showing fire data from ${Math.round((Date.now() - fetchedAt) / 60000)} min ago`
        : `${value.perimeters.length} active perimeters and ${value.incidents.length} incidents nationwide`,
      attribution: ATTRIBUTION,
      url: SOURCE_URL,
      data: value,
    };
  } catch (err) {
    console.error('[nifc] load failed:', err.message);
    return {
      status: 'error',
      fetchedAt: null,
      message: 'Wildfire data unavailable — fire hazards could not be checked',
      attribution: ATTRIBUTION,
      url: SOURCE_URL,
      data: { perimeters: [], incidents: [] },
    };
  }
};
