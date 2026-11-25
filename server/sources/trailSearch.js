/**
 * Public-domain trail search and geometry retrieval from federal ArcGIS services:
 * - U.S. Forest Service (USFS) National Forest System Trails (EDW MapServer)
 * - National Park Service (NPS) Public Trails (NationalDatasets FeatureServer)
 *
 * Pure isomorphic ESM: zero `node:*` imports so this module runs identically
 * in Express on Node and directly on Capacitor iOS/Android.
 */
import { endpointUrl } from '../config.js';
import { fetchJson } from '../lib/http.js';
import { haversineMiles, cumulativeMiles, sliceByMiles } from '../../shared/geo.js';
import { stitchSegments, stitchCorridorSegments, extractLineSegments } from '../../shared/trails/stitch.js';
import {
  ACRONYM_EXPANSIONS,
  getCorridorById,
  serializeCorridor,
  findMatchingCorridor,
  assignCorridorRegion,
  isCorridorSpurName,
  isMainCorridorSegmentName,
} from '../../shared/trails/corridors.js';

export const USFS_TRAILS_URL =
  'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query';

export const NPS_TRAILS_URL =
  'https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/FeatureServer/0/query';

const usfsUrl = () => endpointUrl('usfsTrails', USFS_TRAILS_URL);
const npsUrl = () => endpointUrl('npsTrails', NPS_TRAILS_URL);

const SEARCH_TIMEOUT_MS = 12_000;
const GEOMETRY_TIMEOUT_MS = 20_000;
const SPATIAL_RECORD_LIMIT = 120;
const TEXT_RECORD_LIMIT = 600;
const GEOMETRY_PAGE_SIZE = 1000;
const GEOMETRY_MAX_PAGES = 5;
const MIN_SEARCH_TRAIL_MILES = 0.2;

// Compact lookup for major USFS 4-digit admin_org forest codes + fallback region names.
const USFS_FORESTS = {
  '0103': 'Bitterroot National Forest, MT',
  '0104': 'Idaho Panhandle National Forests, ID',
  '0110': 'Flathead National Forest, MT',
  '0111': 'Custer Gallatin National Forest, MT',
  '0114': 'Kootenai National Forest, MT',
  '0116': 'Lolo National Forest, MT',
  '0117': 'Nez Perce-Clearwater National Forests, ID',
  '0202': 'Bighorn National Forest, WY',
  '0203': 'Black Hills National Forest, SD',
  '0204': 'Grand Mesa, Uncompahgre & Gunnison NF, CO',
  '0206': 'Medicine Bow-Routt National Forests, WY',
  '0209': 'Rio Grande National Forest, CO',
  '0210': 'Arapaho & Roosevelt National Forests, CO',
  '0212': 'Pike & San Isabel National Forests, CO',
  '0213': 'San Juan National Forest, CO',
  '0214': 'Shoshone National Forest, WY',
  '0215': 'White River National Forest, CO',
  '0301': 'Apache-Sitgreaves National Forests, AZ',
  '0302': 'Carson National Forest, NM',
  '0303': 'Cibola National Forest, NM',
  '0304': 'Coconino National Forest, AZ',
  '0305': 'Coronado National Forest, AZ',
  '0306': 'Gila National Forest, NM',
  '0307': 'Kaibab National Forest, AZ',
  '0308': 'Lincoln National Forest, NM',
  '0309': 'Prescott National Forest, AZ',
  '0310': 'Santa Fe National Forest, NM',
  '0312': 'Tonto National Forest, AZ',
  '0402': 'Boise National Forest, ID',
  '0403': 'Bridger-Teton National Forest, WY',
  '0407': 'Dixie National Forest, UT',
  '0408': 'Fishlake National Forest, UT',
  '0412': 'Payette National Forest, ID',
  '0413': 'Salmon-Challis National Forest, ID',
  '0414': 'Sawtooth National Forest, ID',
  '0415': 'Caribou-Targhee National Forest, ID',
  '0417': 'Humboldt-Toiyabe National Forest, NV',
  '0419': 'Uinta-Wasatch-Cache National Forest, UT',
  '0501': 'Angeles National Forest, CA',
  '0502': 'Cleveland National Forest, CA',
  '0503': 'Eldorado National Forest, CA',
  '0504': 'Inyo National Forest, CA',
  '0505': 'Klamath National Forest, CA',
  '0506': 'Lassen National Forest, CA',
  '0507': 'Los Padres National Forest, CA',
  '0508': 'Mendocino National Forest, CA',
  '0511': 'Plumas National Forest, CA',
  '0512': 'San Bernardino National Forest, CA',
  '0513': 'Sequoia National Forest, CA',
  '0514': 'Shasta-Trinity National Forest, CA',
  '0515': 'Sierra National Forest, CA',
  '0516': 'Stanislaus National Forest, CA',
  '0517': 'Tahoe National Forest, CA',
  '0519': 'Lake Tahoe Basin Management Unit, CA/NV',
  '0601': 'Deschutes National Forest, OR',
  '0603': 'Gifford Pinchot National Forest, WA',
  '0605': 'Mt. Baker-Snoqualmie National Forest, WA',
  '0606': 'Mt. Hood National Forest, OR',
  '0609': 'Olympic National Forest, WA',
  '0610': 'Rogue River-Siskiyou National Forest, OR',
  '0612': 'Siuslaw National Forest, OR',
  '0614': 'Umatilla National Forest, OR/WA',
  '0615': 'Umpqua National Forest, OR',
  '0616': 'Wallowa-Whitman National Forest, OR',
  '0617': 'Okanogan-Wenatchee National Forest, WA',
  '0618': 'Willamette National Forest, OR',
  '0621': 'Colville National Forest, WA',
  '0622': 'Columbia River Gorge NSA, OR/WA',
  '0803': 'Chattahoochee-Oconee National Forests, GA',
  '0804': 'Cherokee National Forest, TN',
  '0808': 'George Washington & Jefferson NF, VA',
  '0811': 'National Forests in North Carolina, NC',
  '0920': 'Green Mountain National Forest, VT',
  '0922': 'White Mountain National Forest, NH',
  '1004': 'Chugach National Forest, AK',
  '1005': 'Tongass National Forest, AK',
};

const USFS_REGIONS = {
  '01': 'USFS Northern Region (MT/ID)',
  '02': 'USFS Rocky Mountain Region (CO/WY/SD)',
  '03': 'USFS Southwestern Region (AZ/NM)',
  '04': 'USFS Intermountain Region (UT/ID/WY/NV)',
  '05': 'USFS Pacific Southwest Region (CA)',
  '06': 'USFS Pacific Northwest Region (OR/WA)',
  '08': 'USFS Southern Region',
  '09': 'USFS Eastern Region',
  '10': 'USFS Alaska Region (AK)',
};

const KEEP_UPPER = new Set([
  'NRT', 'PCT', 'CDT', 'AT', 'JMT', 'AZT', 'OHV', 'ATV', 'NF', 'NP', 'NM', 'NSA',
  'FS', 'USFS', 'NPS', 'BLM', 'CG', 'TH', 'II', 'III', 'IV', 'NE', 'NW', 'SE', 'SW',
]);
const SMALL_WORDS = new Set(['of', 'the', 'and', 'to', 'in', 'on', 'at', 'by', 'for', 'via', 'a', 'an']);

/** Format ALL-CAPS USFS names into readable Title Case while preserving mixed-case NPS names. */
export const formatTrailName = (raw) => {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const hasLower = /[a-z]/.test(s);
  if (hasLower) return s;
  return s
    .split(' ')
    .map((word, idx) => {
      const bare = word.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');
      if (KEEP_UPPER.has(bare)) return word;
      const lower = word.toLowerCase();
      if (idx > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.replace(/(^|[-/('])([a-z])/g, (_, p, ch) => p + ch.toUpperCase());
    })
    .join(' ');
};

/** Resolve a 4- or 6-digit USFS admin_org code to a human-readable forest/region label. */
export const formatUsfsRegion = (adminOrg) => {
  const code = String(adminOrg || '').trim();
  if (!code) return 'U.S. National Forest';
  const forest = code.slice(0, 4);
  if (USFS_FORESTS[forest]) return USFS_FORESTS[forest];
  const region = code.slice(0, 2);
  if (USFS_REGIONS[region]) return USFS_REGIONS[region];
  return `U.S. National Forest (${forest})`;
};

const shortForestLabel = (regionLabel) =>
  String(regionLabel || '')
    .replace(/,\s*[A-Z]{2}(?:\/[A-Z]{2})?$/, '')
    .replace(/\bNational Forests?\b/i, 'NF')
    .trim();

/**
 * Safely escape a value for an ArcGIS SQL string literal.
 * Strips control characters, enforces a max length, and doubles single quotes.
 */
export const escapeSqlString = (value, maxLength = 100) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength)
    .replace(/'/g, "''");

/**
 * Sanitize a free-text search term for SQL LIKE clauses:
 * strips control chars and LIKE wildcards (% and _), collapses whitespace,
 * enforces safe length, and escapes single quotes.
 */
export const sanitizeLikeTerm = (value, maxLength = 60) =>
  escapeSqlString(
    String(value ?? '')
      .replace(/[%_\\;]/g, ' ')
      .replace(/\s+/g, ' '),
    maxLength,
  );

/**
 * Collapse dotted USFS sub-segment suffixes (e.g. "2000.4", "2000.14" -> "2000")
 * while keeping distinct alphanumeric trail numbers like "16E10" intact.
 */
export const baseTrailNo = (rawNo) => {
  const s = String(rawNo || '').trim().toUpperCase();
  if (!s) return '';
  const m = s.match(/^([A-Z0-9-]+?)\.\d+$/);
  return m ? m[1] : s;
};

const canonicalTrailKeyName = (rawName) =>
  String(rawName || '')
    .toUpperCase()
    .replace(/\s+(?:NATIONAL\s+SCENIC\s+TRAIL|NATIONAL\s+SCENIC|TRAIL|TRL|TR|NST|NRT)$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Build candidate LIKE patterns for a user query:
 * - strips trailing "trail"/"trl" so "Bright Angel Trail" matches "Bright Angel"
 * - handles "Mt" / "Mt." <-> "Mount" variants common in USFS/NPS names
 * - expands well-known long-trail acronyms (PCT <-> PACIFIC CREST, etc.).
 */
const buildSearchVariants = (rawQuery) => {
  const clean = sanitizeLikeTerm(rawQuery, 60).toUpperCase();
  if (clean.length < 2) return [];
  const base = clean.replace(/\s+(TRAIL|TRL|TR)$/i, '').trim();
  const core = base.length >= 2 ? base : clean;
  const variants = new Set();

  if (core === 'AT') {
    for (const exp of ACRONYM_EXPANSIONS.AT) variants.add(exp);
  } else {
    variants.add(core);
    const expansions = ACRONYM_EXPANSIONS[core] || [];
    for (const exp of expansions) variants.add(exp);
  }

  if (/^MT\.?\s+/.test(core)) {
    variants.add(core.replace(/^MT\.?\s+/, 'MOUNT '));
  } else if (/^MOUNT\s+/.test(core)) {
    variants.add(core.replace(/^MOUNT\s+/, 'MT '));
    variants.add(core.replace(/^MOUNT\s+/, 'MT. '));
  }
  return [...variants].slice(0, 4);
};

const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'trail';

const geometryLengthMiles = (geometry) => {
  const segs = extractLineSegments([geometry]);
  let total = 0;
  for (const seg of segs) {
    if (seg.length < 2) continue;
    const cum = cumulativeMiles(seg);
    total += cum[cum.length - 1];
  }
  return total;
};

const firstCoordOf = (geometry) => {
  const segs = extractLineSegments([geometry]);
  for (const seg of segs) {
    for (const c of seg) {
      if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
        return [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6];
      }
    }
  }
  return null;
};

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

const parseOptionalCoord = (val, min, max) => {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
};

const buildSpatialParams = (lat, lon, radiusMiles) => ({
  geometry: `${lon},${lat}`,
  geometryType: 'esriGeometryPoint',
  inSR: '4326',
  spatialRel: 'esriSpatialRelIntersects',
  distance: String(radiusMiles),
  units: 'esriSRUnit_StatuteMile',
});

const queryArcGis = async (url, params, { label, timeoutMs, retries = 1 }) => {
  const qs = new URLSearchParams({
    f: 'geojson',
    outSR: '4326',
    ...params,
  });
  const data = await fetchJson(`${url}?${qs}`, { label, timeoutMs, retries });
  if (data?.error) {
    throw new Error(`${label} query error: ${data.error.message || JSON.stringify(data.error).slice(0, 160)}`);
  }
  if (!Array.isArray(data?.features)) {
    throw new Error(`${label} response missing features`);
  }
  return data;
};

const queryUsfsSearch = async ({ variants, corridor, lat, lon, radiusMiles }) => {
  const isSpatial = lat != null && lon != null;
  const clauses = ["(trail_type = 'TERRA' OR trail_type IS NULL)", 'trail_name IS NOT NULL'];
  if (!isSpatial && corridor?.usfsWhere) {
    clauses.push(corridor.usfsWhere);
  } else if (variants.length) {
    const likeParts = variants.map((v) => `UPPER(trail_name) LIKE '%${v}%'`);
    clauses.push(`(${likeParts.join(' OR ')})`);
  }
  const params = {
    where: clauses.join(' AND '),
    outFields: 'trail_name,trail_no,admin_org,gis_miles,segment_length',
    returnGeometry: 'true',
    maxAllowableOffset: isSpatial ? '0.0005' : (corridor ? '0.004' : '0.001'),
    resultRecordCount: String(isSpatial ? SPATIAL_RECORD_LIMIT : TEXT_RECORD_LIMIT),
    ...(!isSpatial ? { orderByFields: 'gis_miles DESC' } : {}),
    ...(isSpatial ? buildSpatialParams(lat, lon, radiusMiles) : {}),
  };
  const data = await queryArcGis(usfsUrl(), params, {
    label: 'usfs-trails',
    timeoutMs: SEARCH_TIMEOUT_MS,
  });
  return normalizeUsfsSearchFeatures(data.features, { lat, lon, corridor });
};

const queryNpsSearch = async ({ variants, corridor, lat, lon, radiusMiles }) => {
  const isSpatial = lat != null && lon != null;
  const clauses = ['(TRLNAME IS NOT NULL OR MAPLABEL IS NOT NULL)'];
  if (!isSpatial && corridor?.npsWhere) {
    clauses.push(corridor.npsWhere);
  } else if (variants.length) {
    const likeParts = variants.flatMap((v) => [
      `UPPER(TRLNAME) LIKE '%${v}%'`,
      `UPPER(MAPLABEL) LIKE '%${v}%'`,
      `UPPER(TRLALTNAME) LIKE '%${v}%'`,
      `UPPER(UNITNAME) LIKE '%${v}%'`,
    ]);
    clauses.push(`(${likeParts.join(' OR ')})`);
  }
  const params = {
    where: clauses.join(' AND '),
    outFields: 'TRLNAME,TRLALTNAME,MAPLABEL,UNITNAME,UNITCODE,TRLSTATUS,TRLTYPE',
    returnGeometry: 'true',
    maxAllowableOffset: isSpatial ? '0.0005' : (corridor ? '0.004' : '0.001'),
    resultRecordCount: String(isSpatial ? SPATIAL_RECORD_LIMIT : TEXT_RECORD_LIMIT),
    ...(!isSpatial ? { orderByFields: 'Shape__Length DESC' } : {}),
    ...(isSpatial ? buildSpatialParams(lat, lon, radiusMiles) : {}),
  };
  const data = await queryArcGis(npsUrl(), params, {
    label: 'nps-trails',
    timeoutMs: SEARCH_TIMEOUT_MS,
  });
  return normalizeNpsSearchFeatures(data.features, { lat, lon, corridor });
};

const matchesCorridorText = (corridor, text) => isMainCorridorSegmentName(corridor, text);

/** Deduplicate and aggregate USFS trail segments into clean search items. */
export const normalizeUsfsSearchFeatures = (features, { lat = null, lon = null, corridor = null } = {}) => {
  const grouped = new Map();
  for (const f of features || []) {
    const p = f?.properties || {};
    const rawName = String(p.trail_name || '').replace(/\s+/g, ' ').trim();
    if (!rawName || /^(unnamed|unknown)$/i.test(rawName)) continue;
    const trailNo = String(p.trail_no || '').trim();
    const baseNo = baseTrailNo(trailNo);
    const adminOrg = String(p.admin_org || '').trim();
    const forestCode = adminOrg.slice(0, 4);
    const isSpur = isCorridorSpurName(rawName);
    const matchesCorridorTrunk = Boolean(corridor) && !isSpur && matchesCorridorText(corridor, rawName);

    const key = matchesCorridorTrunk
      ? `usfs|corridor:${corridor.id}|${forestCode}`
      : `usfs|${forestCode}|${canonicalTrailKeyName(rawName)}|${baseNo.toUpperCase()}`;

    const segMiles =
      (Number.isFinite(Number(p.gis_miles)) && Number(p.gis_miles) > 0 ? Number(p.gis_miles) : 0) ||
      (Number.isFinite(Number(p.segment_length)) && Number(p.segment_length) > 0 ? Number(p.segment_length) : 0) ||
      geometryLengthMiles(f.geometry);

    const start = firstCoordOf(f.geometry);
    const existing = grouped.get(key);
    if (existing) {
      existing.lengthMiles += segMiles;
      if (trailNo) existing.rawTrailNos.add(trailNo);
      existing.rawNames.add(rawName);
      if (start && (!existing.start || (lat != null && lon != null &&
        haversineMiles(lon, lat, start[0], start[1]) < haversineMiles(lon, lat, existing.start[0], existing.start[1])))) {
        existing.start = start;
      }
    } else {
      const region = formatUsfsRegion(adminOrg);
      grouped.set(key, {
        id: matchesCorridorTrunk
          ? `usfs:${forestCode || 'nf'}:corridor:${corridor.id}`
          : `usfs:${forestCode || 'nf'}:${slugify(baseNo || rawName)}:${slugify(rawName)}`,
        rawName,
        rawTrailNos: new Set(trailNo ? [trailNo] : []),
        rawNames: new Set([rawName]),
        baseNo,
        forestCode,
        matchesCorridorTrunk,
        isSpur,
        region,
        agency: 'USFS',
        lengthMiles: segMiles,
        gainFt: null,
        source: 'usfs',
        start,
      });
    }
  }

  return [...grouped.values()]
    .filter((t) => t.lengthMiles >= MIN_SEARCH_TRAIL_MILES && t.start)
    .map((t) => {
      const multiNo = t.rawTrailNos.size > 1;
      const singleNo = t.rawTrailNos.size === 1 ? [...t.rawTrailNos][0] : (t.baseNo || null);
      const multiName = t.rawNames.size > 1;
      let displayName = formatTrailName(t.rawName);
      if (t.matchesCorridorTrunk && (multiName || /^(?:pacific\s+crest(?:\s+national\s+scenic)?(?:\s+trail)?)$/i.test(displayName))) {
        const prefix = corridor.id.toUpperCase();
        displayName = `${prefix} — ${shortForestLabel(t.region)}`;
      }
      const queryMeta = {
        source: 'usfs',
        trailNo: multiNo || t.matchesCorridorTrunk ? null : singleNo,
        name: t.matchesCorridorTrunk
          ? (t.rawNames.size > 1 ? displayName : t.rawName)
          : (multiName ? formatUsfsRegion(t.forestCode) : t.rawName),
        unit: t.forestCode || null,
        ...(multiNo && t.baseNo && !t.matchesCorridorTrunk ? { trailNoPrefix: t.baseNo } : {}),
        ...(t.matchesCorridorTrunk ? { corridorId: corridor.id } : {}),
      };
      const regionInfo = corridor && t.matchesCorridorTrunk ? assignCorridorRegion(corridor, t) : null;
      return {
        id: t.id,
        name: displayName,
        region: t.region,
        agency: t.agency,
        lengthMiles: round1(t.lengthMiles),
        gainFt: t.gainFt,
        source: t.source,
        start: t.start,
        ...(regionInfo ? { corridorRegion: regionInfo } : {}),
        ...(t.isSpur ? { isSpur: true } : {}),
        queryMeta,
      };
    });
};

/** Deduplicate and aggregate NPS trail segments into clean search items. */
export const normalizeNpsSearchFeatures = (features, { lat = null, lon = null, corridor = null } = {}) => {
  const grouped = new Map();
  for (const f of features || []) {
    const p = f?.properties || {};
    const status = String(p.TRLSTATUS || '').trim();
    if (/^(decommissioned|proposed|planned|obliterated)$/i.test(status)) continue;
    const trlType = String(p.TRLTYPE || '').trim();
    if (/snow/i.test(trlType)) continue;

    const rawName = String(p.TRLNAME || p.MAPLABEL || p.TRLALTNAME || '').replace(/\s+/g, ' ').trim();
    if (!rawName || /^(unnamed|unknown)$/i.test(rawName)) continue;

    const unitCode = String(p.UNITCODE || '').trim().toUpperCase();
    const unitName = String(p.UNITNAME || '').trim() || unitCode || 'National Park';
    const isSpur = isCorridorSpurName(rawName);
    const matchesCorridorTrunk = Boolean(corridor) && !isSpur && matchesCorridorText(corridor, rawName);

    const key = matchesCorridorTrunk
      ? `nps|corridor:${corridor.id}|${unitCode}`
      : `nps|${unitCode}|${rawName.toUpperCase()}`;

    const segMiles = geometryLengthMiles(f.geometry);
    const start = firstCoordOf(f.geometry);
    const existing = grouped.get(key);
    if (existing) {
      existing.lengthMiles += segMiles;
      existing.rawNames.add(rawName);
      if (start && (!existing.start || (lat != null && lon != null &&
        haversineMiles(lon, lat, start[0], start[1]) < haversineMiles(lon, lat, existing.start[0], existing.start[1])))) {
        existing.start = start;
      }
    } else {
      grouped.set(key, {
        id: matchesCorridorTrunk
          ? `nps:${unitCode || 'np'}:corridor:${corridor.id}`
          : `nps:${unitCode || 'np'}:${slugify(rawName)}`,
        rawName,
        rawNames: new Set([rawName]),
        unitCode,
        region: unitName,
        matchesCorridorTrunk,
        isSpur,
        agency: 'NPS',
        lengthMiles: segMiles,
        gainFt: null,
        source: 'nps',
        start,
      });
    }
  }

  return [...grouped.values()]
    .filter((t) => t.lengthMiles >= MIN_SEARCH_TRAIL_MILES && t.start)
    .map((t) => {
      const displayName = t.matchesCorridorTrunk
        ? `${corridor.id.toUpperCase()} — ${t.region}`
        : formatTrailName(t.rawName);
      const regionInfo = corridor && t.matchesCorridorTrunk ? assignCorridorRegion(corridor, t) : null;
      return {
        id: t.id,
        name: displayName,
        region: t.region,
        agency: t.agency,
        lengthMiles: round1(t.lengthMiles),
        gainFt: t.gainFt,
        source: t.source,
        start: t.start,
        ...(regionInfo ? { corridorRegion: regionInfo } : {}),
        ...(t.isSpur ? { isSpur: true } : {}),
        queryMeta: {
          source: 'nps',
          trailNo: null,
          name: t.rawName,
          unit: t.unitCode || null,
          ...(t.matchesCorridorTrunk ? { corridorId: corridor.id } : {}),
        },
      };
    });
};

const rankTrail = (trail, queryLower, lat, lon, corridor) => {
  const dist = lat != null && lon != null && trail.start
    ? haversineMiles(lon, lat, trail.start[0], trail.start[1])
    : 0;
  if (!queryLower) {
    // Spatial "Near me" sort: closest trails first.
    return dist;
  }
  const nameLower = trail.name.toLowerCase();
  const regionLower = trail.region.toLowerCase();
  let tier = 3;
  if (trail.corridorRegion) {
    tier = 0;
  } else if (nameLower === queryLower || nameLower === `${queryLower} trail`) {
    tier = 0;
  } else if (nameLower.startsWith(queryLower)) {
    tier = 1;
  } else if (nameLower.includes(queryLower)) {
    tier = 2;
  } else if (regionLower.includes(queryLower)) {
    tier = 3;
  } else {
    tier = 4;
  }

  const spurPenalty = trail.isSpur || (corridor && isCorridorSpurName(trail.name)) ? 1500 : 0;
  // Smooth log reward up to full 100+ mi forest sections so trunk sections lead tiny shards.
  const lengthBonus = Math.log1p(Math.max(0, trail.lengthMiles)) * 35;
  return tier * 1000 + spurPenalty + dist * 0.5 - lengthBonus;
};

/**
 * Search public USFS and NPS trails by text query, proximity ("Near me"), or both.
 * Handles either agency timing out or failing gracefully with a non-fatal note.
 */
export const searchPublicTrails = async ({
  query = '',
  lat = null,
  lon = null,
  radiusMiles = 25,
  limit = 20,
} = {}) => {
  const safeLat = parseOptionalCoord(lat, -90, 90);
  const safeLon = parseOptionalCoord(lon, -180, 180);
  const hasCoords = safeLat != null && safeLon != null;
  const corridor = !hasCoords ? findMatchingCorridor(query) : null;
  const variants = buildSearchVariants(query);

  if (!hasCoords && variants.length === 0 && !corridor) {
    return { trails: [], totalCount: 0, corridor: null, note: null };
  }

  const clampedRadius = Math.min(100, Math.max(1, Number(radiusMiles) || 25));
  const clampedLimit = Math.min(100, Math.max(1, Math.round(Number(limit) || 20)));

  const [usfsRes, npsRes] = await Promise.allSettled([
    queryUsfsSearch({ variants, corridor, lat: safeLat, lon: safeLon, radiusMiles: clampedRadius }),
    queryNpsSearch({ variants, corridor, lat: safeLat, lon: safeLon, radiusMiles: clampedRadius }),
  ]);

  const trails = [];
  const failures = [];

  if (npsRes.status === 'fulfilled') trails.push(...npsRes.value);
  else failures.push('NPS');

  if (usfsRes.status === 'fulfilled') trails.push(...usfsRes.value);
  else failures.push('USFS');

  let note = null;
  if (failures.length === 2) {
    note = 'Public trail services (USFS and NPS) could not be reached right now. Try again shortly.';
  } else if (failures.length === 1) {
    const failedAgency = failures[0] === 'USFS' ? 'U.S. Forest Service' : 'National Park Service';
    const okAgency = failures[0] === 'USFS' ? 'National Park Service' : 'U.S. Forest Service';
    note = `${failedAgency} trail search is temporarily unavailable — showing ${okAgency} results.`;
  }

  const queryLower = variants[0]?.toLowerCase() || '';
  trails.sort((a, b) => rankTrail(a, queryLower, safeLat, safeLon, corridor) - rankTrail(b, queryLower, safeLat, safeLon, corridor));

  return {
    trails: trails.slice(0, clampedLimit),
    totalCount: trails.length,
    corridor: serializeCorridor(corridor),
    note,
  };
};

const fetchPagedGeoJson = async (url, where, label, extraParams = {}) => {
  const features = [];
  for (let page = 0; page < GEOMETRY_MAX_PAGES; page++) {
    const data = await queryArcGis(url, {
      where,
      outFields: '*',
      returnGeometry: 'true',
      resultOffset: String(page * GEOMETRY_PAGE_SIZE),
      resultRecordCount: String(GEOMETRY_PAGE_SIZE),
      ...extraParams,
    }, { label, timeoutMs: GEOMETRY_TIMEOUT_MS, retries: 1 });
    features.push(...data.features);
    const more = data.exceededTransferLimit || data.properties?.exceededTransferLimit;
    if (!more || data.features.length < GEOMETRY_PAGE_SIZE) break;
  }
  return features;
};

const nonSpurFeatures = (features, propKey) =>
  (features || []).filter((f) => !isCorridorSpurName(f?.properties?.[propKey] || f?.properties?.TRLNAME || f?.properties?.trail_name || ''));

const parseMileBound = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const sliceCorridorIfRequested = (stitched, corridor, rawStartMile, rawEndMile) => {
  const startMile = parseMileBound(rawStartMile);
  const endMile = parseMileBound(rawEndMile);
  if (startMile == null && endMile == null) {
    return { coords: stitched.coords, lengthMiles: stitched.lengthMiles, suffix: '' };
  }

  const actualLen = stitched.lengthMiles;
  const nominalTotal = Number(corridor?.totalMiles) || actualLen;
  const requestedEnd = endMile ?? nominalTotal;
  const requestedStart = Math.min(startMile ?? 0, requestedEnd);

  // Scale nominal mileposts proportionally onto the stitched public-lands centerline
  // when checking real multi-hundred-mile scenic corridors whose road-walks sit outside USFS/NPS.
  const useProportional = nominalTotal > actualLen * 1.05 && actualLen >= nominalTotal * 0.4;
  let a = useProportional ? (requestedStart / nominalTotal) * actualLen : requestedStart;
  let b = useProportional ? (requestedEnd / nominalTotal) * actualLen : requestedEnd;
  a = Math.max(0, Math.min(a, Math.max(0, actualLen - 0.3)));
  b = Math.max(a + 0.3, Math.min(b, actualLen));

  const cum = cumulativeMiles(stitched.coords);
  const sliced = sliceByMiles(stitched.coords, cum, a, b);
  const sCum = cumulativeMiles(sliced);
  const slicedLen = sCum[sCum.length - 1];
  const labelEnd = endMile != null ? Math.round(endMile) : Math.round(nominalTotal);
  const labelStart = Math.round(requestedStart);
  return {
    coords: sliced,
    lengthMiles: slicedLen,
    suffix: ` (Mi ${labelStart}–${labelEnd})`,
  };
};

/**
 * Fetch and stitch the full-resolution geometry for a specific public trail or
 * multi-agency long trail corridor (`source: "usfs" | "nps" | "corridor"`).
 */
export const fetchPublicTrailGeometry = async (meta = {}) => {
  const source = String(meta?.source || '').trim().toLowerCase();
  const rawName = String(meta?.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  const trailNo = String(meta?.trailNo || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  const trailNoPrefix = String(meta?.trailNoPrefix || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  const corridorId = String(meta?.corridorId || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24).toLowerCase();
  const unit = String(meta?.unit || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);

  if (source !== 'usfs' && source !== 'nps' && source !== 'corridor') {
    throw new Error('Trail source must be "usfs", "nps", or "corridor".');
  }

  if (source === 'corridor') {
    const corridor = getCorridorById(corridorId);
    if (!corridor) {
      const err = new Error(`Unknown long-trail corridor "${corridorId}".`);
      err.code = 'trail_not_found';
      throw err;
    }

    const usfsClause = `(${corridor.usfsWhere}) AND (trail_type = 'TERRA' OR trail_type IS NULL) AND UPPER(trail_name) NOT LIKE '%ACCESS%' AND UPPER(trail_name) NOT LIKE '%TIE%' AND UPPER(trail_name) NOT LIKE '%SPUR%' AND UPPER(trail_name) NOT LIKE '%CONNECTOR%'`;
    const npsClause = `(${corridor.npsWhere}) AND (TRLNAME IS NULL OR (UPPER(TRLNAME) NOT LIKE '%SPUR%' AND UPPER(TRLNAME) NOT LIKE '%CONNECTOR%'))`;

    const [usfsRes, npsRes] = await Promise.allSettled([
      fetchPagedGeoJson(usfsUrl(), usfsClause, 'corridor-usfs', {
        outFields: 'trail_name',
        maxAllowableOffset: '0.004',
      }),
      fetchPagedGeoJson(npsUrl(), npsClause, 'corridor-nps', {
        outFields: 'TRLNAME,MAPLABEL',
        maxAllowableOffset: '0.004',
      }),
    ]);

    const combinedFeatures = [
      ...(usfsRes.status === 'fulfilled' ? nonSpurFeatures(usfsRes.value, 'trail_name') : []),
      ...(npsRes.status === 'fulfilled' ? nonSpurFeatures(npsRes.value, 'TRLNAME') : []),
    ];

    if (!combinedFeatures.length) {
      const err = new Error(`No public trail geometry was found for "${corridor.name}". Try selecting a regional section or opening a GPX file.`);
      err.code = 'trail_not_found';
      throw err;
    }

    const stitched = stitchCorridorSegments(extractLineSegments(combinedFeatures), {
      direction: corridor.direction,
    });
    if (!stitched || stitched.coords.length < 2) {
      const err = new Error(`Could not assemble continuous geometry for "${corridor.name}".`);
      err.code = 'trail_not_found';
      throw err;
    }

    const sliced = sliceCorridorIfRequested(stitched, corridor, meta.startMile, meta.endMile);
    return {
      name: `${corridor.name.replace(/\s*\([A-Z]+\)$/, '')}${sliced.suffix}`,
      coords: sliced.coords,
      lengthMiles: round2(sliced.lengthMiles),
    };
  }

  if (!rawName && !trailNo && !trailNoPrefix && !corridorId) {
    throw new Error('Trail name or trail number is required to load geometry.');
  }

  const corridor = corridorId ? getCorridorById(corridorId) : null;
  let features = [];

  if (source === 'usfs') {
    if (corridor && unit) {
      const clauses = [
        "(trail_type = 'TERRA' OR trail_type IS NULL)",
        `admin_org LIKE '${escapeSqlString(unit, 16)}%'`,
        corridor.usfsWhere,
      ];
      features = nonSpurFeatures(
        await fetchPagedGeoJson(usfsUrl(), clauses.join(' AND '), 'usfs-corridor-unit'),
        'trail_name',
      );
    } else if (trailNoPrefix && unit) {
      const escPrefix = escapeSqlString(trailNoPrefix, 40);
      const clauses = [
        "(trail_type = 'TERRA' OR trail_type IS NULL)",
        `(trail_no = '${escPrefix}' OR trail_no LIKE '${escPrefix}.%')`,
        `admin_org LIKE '${escapeSqlString(unit, 16)}%'`,
      ];
      features = await fetchPagedGeoJson(usfsUrl(), clauses.join(' AND '), 'usfs-trail-geometry');
    } else {
      const clauses = ["(trail_type = 'TERRA' OR trail_type IS NULL)"];
      if (trailNo) clauses.push(`trail_no = '${escapeSqlString(trailNo, 40)}'`);
      if (rawName) clauses.push(`UPPER(trail_name) = '${escapeSqlString(rawName.toUpperCase(), 120)}'`);
      if (unit) clauses.push(`admin_org LIKE '${escapeSqlString(unit, 16)}%'`);

      features = await fetchPagedGeoJson(usfsUrl(), clauses.join(' AND '), 'usfs-trail-geometry');

      // Fallback to trail_no + forest if the exact trail_name spelling changed slightly.
      if (features.length === 0 && trailNo && rawName) {
        const fallback = ["(trail_type = 'TERRA' OR trail_type IS NULL)", `trail_no = '${escapeSqlString(trailNo, 40)}'`];
        if (unit) fallback.push(`admin_org LIKE '${escapeSqlString(unit, 16)}%'`);
        features = await fetchPagedGeoJson(usfsUrl(), fallback.join(' AND '), 'usfs-trail-geometry');
      }
    }
  } else {
    if (corridor && unit) {
      const clauses = [
        `UNITCODE = '${escapeSqlString(unit.toUpperCase(), 16)}'`,
        corridor.npsWhere,
      ];
      features = nonSpurFeatures(
        await fetchPagedGeoJson(npsUrl(), clauses.join(' AND '), 'nps-corridor-unit'),
        'TRLNAME',
      );
    } else {
      const escName = escapeSqlString(rawName, 120);
      const clauses = [
        `(TRLNAME = '${escName}' OR MAPLABEL = '${escName}' OR TRLALTNAME = '${escName}')`,
      ];
      if (unit) clauses.push(`UNITCODE = '${escapeSqlString(unit.toUpperCase(), 16)}'`);

      features = await fetchPagedGeoJson(npsUrl(), clauses.join(' AND '), 'nps-trail-geometry');
    }
  }

  const displayName = formatTrailName(rawName || trailNo || trailNoPrefix || corridor?.name);
  if (!features.length) {
    const err = new Error(`No public trail geometry was found for "${displayName}". Try another trail or open a GPX file.`);
    err.code = 'trail_not_found';
    throw err;
  }

  const segments = extractLineSegments(features);
  const stitched = (corridor || trailNoPrefix)
    ? stitchCorridorSegments(segments, { direction: corridor?.direction || 'south-to-north' })
    : stitchSegments(segments);
  if (!stitched || stitched.coords.length < 2) {
    const err = new Error(`The geometry returned for "${displayName}" is too short or incomplete to analyze. Try opening a GPX file instead.`);
    err.code = 'trail_not_found';
    throw err;
  }

  return {
    name: displayName,
    coords: stitched.coords,
    lengthMiles: round2(stitched.lengthMiles),
  };
};
