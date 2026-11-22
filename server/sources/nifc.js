import { padBbox } from '../../shared/geo.js';
import { endpointUrl } from '../config.js';
import { sourceCache } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { prepPolygons, polygonsBbox, distanceToPolygonsMiles } from '../lib/spatial.js';
import { isFireEnded } from '../fusion/detectors/fire.js';

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
  'OBJECTID', 'attr_IrwinID', 'poly_IRWINID', 'attr_UniqueFireIdentifier', 'attr_IncidentName', 'poly_IncidentName',
  'attr_IncidentTypeCategory', 'poly_GISAcres', 'attr_IncidentSize', 'attr_FinalAcres', 'attr_DiscoveryAcres',
  'poly_Acres_AutoCalc', 'attr_PercentContained', 'attr_FireDiscoveryDateTime', 'attr_ContainmentDateTime',
  'attr_ControlDateTime', 'attr_FireOutDateTime', 'attr_ICS209ReportDateTime', 'attr_ICS209ReportStatus',
  'attr_ModifiedOnDateTime_dt', 'poly_DateCurrent',
  'poly_PolygonDateTime', 'poly_MapMethod', 'attr_POOState', 'attr_IsCpxChild', 'attr_CpxID',
  'attr_IncidentComplexityLevel', 'attr_FireBehaviorGeneral',
];

const INCIDENT_FIELDS = [
  'OBJECTID', 'IrwinID', 'UniqueFireIdentifier', 'IncidentName', 'IncidentTypeCategory', 'IncidentSize',
  'FinalAcres', 'InitialResponseAcres', 'DiscoveryAcres',
  'PercentContained', 'FireDiscoveryDateTime', 'ContainmentDateTime', 'ControlDateTime', 'FireOutDateTime',
  'ICS209ReportDateTime', 'ICS209ReportStatus', 'ModifiedOnDateTime_dt', 'POOState', 'IsCpxChild', 'CpxID',
  'CpxName', 'IncidentComplexityLevel', 'IncidentShortDescription', 'FireBehaviorGeneral',
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const firstNum = (...vals) => vals.map(num).find(v => v != null && v > 0) ?? null;
const normId = (v) => (typeof v === 'string' && v.trim() ? v.trim().toUpperCase() : null);
const normIcs = (v) => (typeof v === 'string' && v.trim() ? v.trim().toUpperCase() : null);

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
  const irwinId = normId(p.attr_IrwinID || p.poly_IRWINID);
  return {
    key: irwinId || `OBJ${p.OBJECTID}`,
    irwinId,
    name: tidyName(p.attr_IncidentName || p.poly_IncidentName),
    polyName: p.poly_IncidentName ? String(p.poly_IncidentName).trim() : null,
    category: p.attr_IncidentTypeCategory || 'WF',
    acres: firstNum(p.poly_GISAcres, p.attr_IncidentSize, p.attr_FinalAcres, p.poly_Acres_AutoCalc, p.attr_DiscoveryAcres),
    // null (unknown) must stay distinct from 0 (no containment).
    percentContained: num(p.attr_PercentContained),
    discoveredAt: num(p.attr_FireDiscoveryDateTime),
    containedAt: num(p.attr_ContainmentDateTime),
    controlledAt: num(p.attr_ControlDateTime),
    outAt: num(p.attr_FireOutDateTime),
    icsAt: num(p.attr_ICS209ReportDateTime),
    icsStatus: normIcs(p.attr_ICS209ReportStatus),
    updatedAt: num(p.attr_ModifiedOnDateTime_dt),
    perimeterAsOf: num(p.poly_PolygonDateTime) ?? num(p.poly_DateCurrent),
    mapMethod: p.poly_MapMethod || null,
    state: p.attr_POOState ? String(p.attr_POOState).replace(/^US-/, '') : null,
    complexity: p.attr_IncidentComplexityLevel || null,
    behavior: p.attr_FireBehaviorGeneral || null,
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
    // Fall back to Final/InitialResponse/DiscoveryAcres so 0.01-acre CAD spots are never treated as unsized.
    acres: firstNum(p.IncidentSize, p.FinalAcres, p.InitialResponseAcres, p.DiscoveryAcres),
    percentContained: num(p.PercentContained),
    discoveredAt: num(p.FireDiscoveryDateTime),
    containedAt: num(p.ContainmentDateTime),
    controlledAt: num(p.ControlDateTime),
    outAt: num(p.FireOutDateTime),
    icsAt: num(p.ICS209ReportDateTime),
    icsStatus: normIcs(p.ICS209ReportStatus),
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

const CORRIDOR_PAD_MILES = 15;

const corridorEnvelope = (bbox, padMiles) => {
  const [w, s, e, n] = padBbox(bbox, padMiles);
  const xmin = Math.max(-180, Math.floor(w * 100) / 100);
  const ymin = Math.max(-90, Math.floor(s * 100) / 100);
  const xmax = Math.min(180, Math.ceil(e * 100) / 100);
  const ymax = Math.min(90, Math.ceil(n * 100) / 100);
  return {
    cacheKey: `${xmin.toFixed(2)},${ymin.toFixed(2)},${xmax.toFixed(2)},${ymax.toFixed(2)}`,
    params: {
      geometry: JSON.stringify({ xmin, ymin, xmax, ymax, spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryEnvelope',
      spatialRel: 'esriSpatialRelIntersects',
      inSR: '4326',
    },
  };
};

const fetchFireData = async ({ spatialParams = {}, corridor = false } = {}) => {
  const perimetersUrl = endpointUrl('nifcPerimeters', PERIMETERS_URL);
  const incidentsUrl = endpointUrl('nifcIncidents', INCIDENTS_URL);
  const [rawPerimeters, rawIncidents] = await Promise.all([
    queryAll(perimetersUrl, {
      where: '1=1',
      outFields: PERIMETER_FIELDS.join(','),
      geometryPrecision: '5',
      maxAllowableOffset: '0.0002',
      ...spatialParams,
    }, 'NIFC perimeters'),
    queryAll(incidentsUrl, {
      where: '1=1',
      outFields: INCIDENT_FIELDS.join(','),
      geometryPrecision: '5',
      ...spatialParams,
    }, 'NIFC incidents'),
  ]);

  const allPerimeters = rawPerimeters.map(normalizePerimeter).filter(Boolean);
  const normalizedIncidents = rawIncidents.map(normalizeIncident).filter(Boolean);
  // The incident feed always lists dozens of fires and burns nationwide;
  // an empty one is an upstream glitch and must not replace good data.
  if (!corridor && normalizedIncidents.length === 0) throw new Error('NIFC returned no incidents nationwide');

  // Link incidents to perimeters before filtering out ended fires so an ended
  // perimeter's matching origin point never reappears as an "unmapped" fire.
  const perimeterIds = new Set(allPerimeters.map(p => p.irwinId).filter(Boolean));
  // Perimeters by the complex they belong to (or are).
  const byComplex = new Map();
  for (const p of allPerimeters) {
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
  const linkedIncidents = normalizedIncidents.map(inc => ({
    ...inc,
    hasPerimeter: perimeterIds.has(inc.irwinId)
      || (inc.category === 'CX' && byComplex.has(inc.irwinId))
      || (inc.complexId != null && coveredByComplex(inc)),
  }));

  // Rolled-up complex hazards report the complex's own totals and lifecycle fields.
  const complexes = new Map(linkedIncidents.filter(i => i.category === 'CX' && i.irwinId)
    .map(i => [i.irwinId, {
      name: i.name,
      acres: i.acres,
      percentContained: i.percentContained,
      discoveredAt: i.discoveredAt,
      containedAt: i.containedAt,
      controlledAt: i.controlledAt,
      outAt: i.outAt,
      icsAt: i.icsAt,
      icsStatus: i.icsStatus,
    }]));
  for (const p of allPerimeters) {
    if (p.isComplexChild && p.complexId && complexes.has(p.complexId)) p.complex = complexes.get(p.complexId);
  }

  const now = Date.now();
  const perimeters = allPerimeters.filter(p => !isFireEnded(p, now, { isPerimeter: true }));
  const incidents = linkedIncidents.filter(i => !isFireEnded(i, now, { isPerimeter: i.hasPerimeter }));

  console.log(`[nifc] ${perimeters.length}/${allPerimeters.length} active perimeters, ${incidents.length}/${linkedIncidents.length} active incidents (${incidents.filter(i => !i.hasPerimeter).length} without perimeter)`);
  return { perimeters, incidents };
};

/** Nationwide (or route-corridor) active fire perimeters + incident points. */
export const loadFire = async ({ route, scope = 'nationwide' } = {}) => {
  const corridor = scope === 'corridor' && Boolean(route?.paddedBbox);
  const env = corridor ? corridorEnvelope(route.paddedBbox, CORRIDOR_PAD_MILES) : null;
  const cacheKey = env ? `nifc:corridor:${env.cacheKey}` : 'nifc:all';
  try {
    const { value, fetchedAt, stale } = await sourceCache.wrap(
      cacheKey,
      { ttlMs: TTL_MS, revalidateMs: REVALIDATE_MS, staleMs: STALE_MS },
      () => fetchFireData({ spatialParams: env ? env.params : {}, corridor }),
    );
    return {
      status: stale ? 'stale' : 'ok',
      fetchedAt: new Date(fetchedAt).toISOString(),
      message: stale
        ? `NIFC unreachable — showing fire data from ${Math.round((Date.now() - fetchedAt) / 60000)} min ago`
        : `${value.perimeters.length} active perimeters and ${value.incidents.length} incidents ${corridor ? 'near route' : 'nationwide'}`,
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
