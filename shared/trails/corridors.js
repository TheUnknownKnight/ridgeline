/**
 * Curated metadata, acronym matching, region grouping, and display formatting
 * for major multi-forest / multi-park U.S. National Scenic and Long Trails.
 *
 * Pure isomorphic ESM (zero `node:*` imports) shared by server search,
 * Capacitor on-device search, and the Explore Trail Finder UI.
 */

export const ACRONYM_EXPANSIONS = {
  PCT: ['PACIFIC CREST'],
  'PACIFIC CREST': ['PCT'],
  JMT: ['JOHN MUIR'],
  'JOHN MUIR': ['JMT'],
  CDT: ['CONTINENTAL DIVIDE'],
  'CONTINENTAL DIVIDE': ['CDT'],
  AZT: ['ARIZONA TRAIL', 'ARIZONA NATIONAL SCENIC'],
  AT: ['APPALACHIAN'],
};

export const CORRIDOR_SPUR_RE = /\b(ACCESS|TIE|SPUR|CONNECTOR|CONNECTING|CUTOFF|PARKING|DETOUR|LOOP|REROUTE|RELOCAT\w*|FEEDER|APPROACH|OVERLOOK|JUNCTION|JCT|ALT(?:ERNATE)?)\b/i;

const APPROACH_PHRASE_RE = /\b(?:TO|FROM|VIA|NEAR|BELOW|ABOVE)\s+(?:THE\s+)?(?:PACIFIC CREST|PCT|JOHN MUIR|JMT|APPALACHIAN|A\.?T\.?|CONTINENTAL DIVIDE|CDT|COLORADO TRAIL|ARIZONA TRAIL|AZT)\b/i;

export const isCorridorSpurName = (rawName) => {
  const s = String(rawName || '');
  return CORRIDOR_SPUR_RE.test(s) || APPROACH_PHRASE_RE.test(s);
};

export const isMainCorridorSegmentName = (corridor, rawName) => {
  if (!corridor || !rawName || isCorridorSpurName(rawName)) return false;
  const s = String(rawName).replace(/\s+/g, ' ').trim();
  if (corridor.prefixRe && corridor.prefixRe.test(s)) return true;
  if (corridor.id === 'at') return /\b(?:APPALACHIAN\s+(?:NATIONAL\s+SCENIC\s+)?TRAIL|APPALACHIAN)\b/i.test(s);
  return corridor.aliases.some((a) => a.length >= 3 && s.toUpperCase().startsWith(a.toUpperCase()));
};

export const LONG_TRAIL_CORRIDORS = [
  {
    id: 'pct',
    name: 'Pacific Crest Trail (PCT)',
    badge: 'National Scenic Trail',
    totalMiles: 2650,
    spanLabel: 'CA · OR · WA · USFS / NPS',
    direction: 'south-to-north',
    aliases: ['pct', 'pacific crest', 'pacific crest trail', 'pacific crest national scenic'],
    exactAliases: [],
    usfsWhere: "(UPPER(trail_name) LIKE '%PACIFIC CREST%' OR UPPER(trail_name) LIKE 'PCT:%' OR UPPER(trail_name) LIKE 'PCT %')",
    npsWhere: "(UPPER(TRLNAME) LIKE '%PACIFIC CREST%' OR UPPER(MAPLABEL) LIKE '%PACIFIC CREST%')",
    prefixRe: /^(?:Pacific\s+Crest(?:\s+National\s+Scenic)?(?:\s+Trail)?|PCT)\s*(?:[:\-—–]\s*)?/i,
    regions: [
      { id: 'socal', label: 'SoCal', miles: 'Mi 0–702', maxLat: 35.8 },
      { id: 'sierra', label: 'Sierra', miles: 'Mi 702–1,092', minLat: 35.8, maxLat: 39.4 },
      { id: 'norcal', label: 'NorCal', miles: 'Mi 1,092–1,691', minLat: 39.4, maxLat: 42.0 },
      { id: 'oregon', label: 'Oregon', miles: 'Mi 1,691–2,147', minLat: 42.0, maxLat: 45.67 },
      { id: 'wa', label: 'Washington', miles: 'Mi 2,147–2,650', minLat: 45.67 },
    ],
    landmarks: [
      { mi: 0, label: 'Campo (MX Border)' },
      { mi: 454, label: 'Agua Dulce' },
      { mi: 702, label: 'Kennedy Meadows' },
      { mi: 942, label: 'Tuolumne Meadows' },
      { mi: 1092, label: 'Sonora Pass' },
      { mi: 1691, label: 'CA / OR Border' },
      { mi: 2147, label: 'Bridge of the Gods' },
      { mi: 2650, label: 'Northern Terminus' },
    ],
    presets: [
      { label: 'Sierra (Mi 702–942)', start: 702, end: 942 },
      { label: 'NorCal (Mi 1092–1350)', start: 1092, end: 1350 },
      { label: 'Oregon (Mi 1691–1950)', start: 1691, end: 1950 },
      { label: 'Full 2,650 mi', start: 0, end: 2650 },
    ],
  },
  {
    id: 'jmt',
    name: 'John Muir Trail (JMT)',
    badge: 'Thru-Hike Corridor',
    totalMiles: 202.2,
    spanLabel: 'Yosemite to Mt. Whitney · CA · NPS / USFS',
    direction: 'north-to-south',
    sampleUrl: '/samples/jmt-yosemite.gpx',
    aliases: ['jmt', 'john muir', 'john muir trail'],
    exactAliases: [],
    usfsWhere: "(UPPER(trail_name) LIKE '%JOHN MUIR%' OR UPPER(trail_name) LIKE 'JMT%')",
    npsWhere: "(UPPER(TRLNAME) LIKE '%JOHN MUIR%' OR UPPER(MAPLABEL) LIKE '%JOHN MUIR%')",
    prefixRe: /^(?:John\s+Muir(?:\s+Trail)?|JMT)\s*(?:[:\-—–]\s*)?/i,
    regions: [
      { id: 'north', label: 'North (Yosemite / Inyo)', miles: 'Mi 0–100', minLat: 37.35 },
      { id: 'south', label: 'High Passes (SEKI / Whitney)', miles: 'Mi 100–202', maxLat: 37.35 },
    ],
    landmarks: [
      { mi: 0, label: 'Happy Isles (Yosemite)' },
      { mi: 24, label: 'Tuolumne Meadows' },
      { mi: 58, label: 'Reds Meadow' },
      { mi: 109, label: 'Muir Trail Ranch' },
      { mi: 175, label: 'Forester Pass' },
      { mi: 202, label: 'Mt. Whitney Summit' },
    ],
    presets: [
      { label: 'Full JMT (202 mi)', start: 0, end: 202 },
      { label: 'North (Mi 0–58)', start: 0, end: 58 },
      { label: 'High Passes (Mi 109–202)', start: 109, end: 202 },
    ],
  },
  {
    id: 'at',
    name: 'Appalachian Trail (AT)',
    badge: 'National Scenic Trail',
    totalMiles: 2197,
    spanLabel: 'GA to ME · 14 States · USFS / NPS',
    direction: 'south-to-north',
    aliases: ['appalachian', 'appalachian trail', 'appalachian national scenic'],
    exactAliases: ['at', 'a.t.'],
    usfsWhere: "(UPPER(trail_name) LIKE '%APPALACHIAN%' OR UPPER(trail_name) LIKE 'AT:%' OR UPPER(trail_name) LIKE 'A.T.%')",
    npsWhere: "(UPPER(TRLNAME) LIKE '%APPALACHIAN%' OR UPPER(MAPLABEL) LIKE '%APPALACHIAN%')",
    prefixRe: /^(?:Appalachian(?:\s+National\s+Scenic)?(?:\s+Trail)?|A\.?T\.?)\s*(?:[:\-—–]\s*)?/i,
    regions: [
      { id: 'south', label: 'South', miles: 'GA / NC / TN / SW VA', maxLat: 36.6 },
      { id: 'mid', label: 'Mid-Atlantic', miles: 'VA / WV / MD / PA / NJ / NY', minLat: 36.6, maxLat: 41.6 },
      { id: 'north', label: 'New England', miles: 'CT / MA / VT / NH / ME', minLat: 41.6 },
    ],
    landmarks: [
      { mi: 0, label: 'Springer Mtn, GA' },
      { mi: 207, label: 'Smokies (Fontana)' },
      { mi: 865, label: 'Shenandoah, VA' },
      { mi: 1025, label: 'Harpers Ferry, WV' },
      { mi: 1752, label: 'White Mountains, NH' },
      { mi: 2197, label: 'Mt. Katahdin, ME' },
    ],
    presets: [
      { label: 'Smokies (Mi 165–240)', start: 165, end: 240 },
      { label: 'Shenandoah (Mi 865–970)', start: 865, end: 970 },
      { label: 'Whites (Mi 1752–1890)', start: 1752, end: 1890 },
    ],
  },
  {
    id: 'cdt',
    name: 'Continental Divide Trail (CDT)',
    badge: 'National Scenic Trail',
    totalMiles: 3100,
    spanLabel: 'NM · CO · WY · ID · MT · USFS / NPS',
    direction: 'south-to-north',
    aliases: ['cdt', 'continental divide', 'continental divide trail'],
    exactAliases: [],
    usfsWhere: "(UPPER(trail_name) LIKE '%CONTINENTAL DIVIDE%' OR UPPER(trail_name) LIKE 'CDT%')",
    npsWhere: "(UPPER(TRLNAME) LIKE '%CONTINENTAL DIVIDE%' OR UPPER(MAPLABEL) LIKE '%CONTINENTAL DIVIDE%')",
    prefixRe: /^(?:Continental\s+Divide(?:\s+National\s+Scenic)?(?:\s+Trail)?|CDT)\s*(?:[:\-—–]\s*)?/i,
    regions: [
      { id: 'nm', label: 'New Mexico', miles: 'MX Border – Chama', maxLat: 37.0 },
      { id: 'co', label: 'Colorado', miles: 'San Juans – Steamboat', minLat: 37.0, maxLat: 41.0 },
      { id: 'wy', label: 'Wyoming', miles: 'Great Divide – Yellowstone', minLat: 41.0, maxLat: 44.5 },
      { id: 'mt', label: 'Idaho / Montana', miles: 'Lima – Glacier NP', minLat: 44.5 },
    ],
    landmarks: [
      { mi: 0, label: 'Crazy Cook (MX Border)' },
      { mi: 790, label: 'Cumbres Pass, CO' },
      { mi: 1580, label: 'Wyoming Basin' },
      { mi: 2100, label: 'Yellowstone' },
      { mi: 2950, label: 'Glacier NP' },
      { mi: 3100, label: 'Waterton Border' },
    ],
    presets: [
      { label: 'Colorado San Juans (Mi 800–1020)', start: 800, end: 1020 },
      { label: 'Wind River Range (Mi 1780–1940)', start: 1780, end: 1940 },
      { label: 'Glacier NP (Mi 2940–3100)', start: 2940, end: 3100 },
    ],
  },
  {
    id: 'ct',
    name: 'Colorado Trail',
    badge: 'Long-Distance Trail',
    totalMiles: 486,
    spanLabel: 'Denver to Durango · CO · USFS',
    direction: 'north-to-south',
    aliases: ['colorado trail'],
    exactAliases: ['ct'],
    usfsWhere: "UPPER(trail_name) LIKE '%COLORADO TRAIL%'",
    npsWhere: "UPPER(TRLNAME) LIKE '%COLORADO TRAIL%'",
    prefixRe: /^(?:The\s+)?Colorado(?:\s+Trail)?\s*(?:[:\-—–]\s*)?/i,
    regions: [
      { id: 'front', label: 'Front Range', miles: 'Waterton – Copper Mtn', minLat: 39.25 },
      { id: 'collegiate', label: 'Collegiate Peaks', miles: 'Leadville – Monarch Pass', minLat: 38.4, maxLat: 39.25 },
      { id: 'sanjuan', label: 'San Juans', miles: 'Sargents – Durango', maxLat: 38.4 },
    ],
    landmarks: [
      { mi: 0, label: 'Waterton Canyon' },
      { mi: 104, label: 'Breckenridge' },
      { mi: 220, label: 'Collegiate Peaks' },
      { mi: 350, label: 'Lake City' },
      { mi: 486, label: 'Durango' },
    ],
    presets: [
      { label: 'Collegiate East (Mi 180–265)', start: 180, end: 265 },
      { label: 'San Juans (Mi 340–486)', start: 340, end: 486 },
      { label: 'Full 486 mi', start: 0, end: 486 },
    ],
  },
  {
    id: 'azt',
    name: 'Arizona Trail (AZT)',
    badge: 'National Scenic Trail',
    totalMiles: 800,
    spanLabel: 'Mexico to Utah · AZ · USFS / NPS',
    direction: 'south-to-north',
    aliases: ['azt', 'arizona trail', 'arizona national scenic'],
    exactAliases: [],
    usfsWhere: "(UPPER(trail_name) LIKE '%ARIZONA TRAIL%' OR UPPER(trail_name) LIKE '%ARIZONA NATIONAL SCENIC%' OR UPPER(trail_name) LIKE 'AZT%')",
    npsWhere: "(UPPER(TRLNAME) LIKE '%ARIZONA TRAIL%' OR UPPER(MAPLABEL) LIKE '%ARIZONA TRAIL%' OR UPPER(TRLNAME) LIKE '%ARIZONA NATIONAL SCENIC%')",
    prefixRe: /^(?:Arizona(?:\s+National\s+Scenic)?(?:\s+Trail)?|AZT)\s*(?:[:\-—–]\s*)?/i,
    regions: [
      { id: 'south', label: 'Southern AZ', miles: 'Coronado – Catalina', maxLat: 33.5 },
      { id: 'central', label: 'Central AZ', miles: 'Tonto – Mogollon Rim', minLat: 33.5, maxLat: 35.0 },
      { id: 'north', label: 'Northern AZ', miles: 'Flagstaff – Grand Canyon / UT', minLat: 35.0 },
    ],
    landmarks: [
      { mi: 0, label: 'Montezuma Pass' },
      { mi: 190, label: 'Mt. Lemmon' },
      { mi: 410, label: 'Mazatzal Wilderness' },
      { mi: 560, label: 'Flagstaff' },
      { mi: 690, label: 'Grand Canyon' },
      { mi: 800, label: 'Stateline (UT Border)' },
    ],
    presets: [
      { label: 'Mogollon Rim (Mi 430–560)', start: 430, end: 560 },
      { label: 'Grand Canyon – UT (Mi 670–800)', start: 670, end: 800 },
      { label: 'Full 800 mi', start: 0, end: 800 },
    ],
  },
];

const CORRIDOR_BY_ID = new Map(LONG_TRAIL_CORRIDORS.map((c) => [c.id, c]));

/** Look up a long-trail corridor definition by its id (e.g. "pct"). */
export const getCorridorById = (id) => CORRIDOR_BY_ID.get(String(id || '').toLowerCase()) || null;

/**
 * Strip heavy queryMeta SQL templates when sending corridor metadata to the UI.
 */
export const serializeCorridor = (corridor) => {
  if (!corridor) return null;
  return {
    id: corridor.id,
    name: corridor.name,
    badge: corridor.badge,
    totalMiles: corridor.totalMiles,
    spanLabel: corridor.spanLabel,
    direction: corridor.direction,
    ...(corridor.sampleUrl ? { sampleUrl: corridor.sampleUrl } : {}),
    regions: corridor.regions.map((r) => ({ id: r.id, label: r.label, miles: r.miles })),
    landmarks: corridor.landmarks,
    presets: corridor.presets,
  };
};

/**
 * Match a search string to a known long-trail corridor without triggering
 * false positives on short abbreviations like "at" inside words.
 */
export const findMatchingCorridor = (rawQuery) => {
  const clean = String(rawQuery || '').replace(/[^\w.\s-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (clean.length < 2) return null;
  for (const corridor of LONG_TRAIL_CORRIDORS) {
    if (corridor.exactAliases?.includes(clean)) return corridor;
    if (corridor.aliases.some((alias) => clean === alias || (alias.length >= 3 && (clean.includes(alias) || alias.startsWith(clean))))) {
      return corridor;
    }
  }
  return null;
};

/** Assign a section/trail inside a corridor to its regional bucket. */
export const assignCorridorRegion = (corridor, trail) => {
  if (!corridor?.regions?.length) return null;
  const regionUpper = String(trail?.region || '').toUpperCase();
  if (corridor.id === 'pct') {
    if (/(?:,\s*WA\b|NORTH CASCADES|OKANOGAN|GIFFORD|BAKER|RAINIER|OLYMPIC)/i.test(regionUpper)) {
      return { id: 'wa', label: 'Washington' };
    }
    if (/(?:,\s*OR\b|HOOD|CRATER|DESCHUTES|WILLAMETTE|UMPQUA|SISKIYOU)/i.test(regionUpper)) {
      return { id: 'oregon', label: 'Oregon' };
    }
    if (/(?:YOSEMITE|INYO|TAHOE|ELDORADO|STANISLAUS|SIERRA|SEQUOIA|HUMBOLDT)/i.test(regionUpper)) {
      return { id: 'sierra', label: 'Sierra' };
    }
    if (/(?:KLAMATH|SHASTA|LASSEN|PLUMAS|MENDOCINO)/i.test(regionUpper)) {
      return { id: 'norcal', label: 'NorCal' };
    }
    if (/(?:ANGELES|SAN BERNARDINO|CLEVELAND|LOS PADRES)/i.test(regionUpper)) {
      return { id: 'socal', label: 'SoCal' };
    }
  }
  const lat = Array.isArray(trail?.start) ? Number(trail.start[1]) : null;
  if (Number.isFinite(lat)) {
    for (const r of corridor.regions) {
      const aboveMin = r.minLat == null || lat >= r.minLat;
      const belowMax = r.maxLat == null || lat < r.maxLat;
      if (aboveMin && belowMax) return { id: r.id, label: r.label };
    }
  }
  const first = corridor.regions[0];
  return { id: first.id, label: first.label };
};

/**
 * Strip redundant corridor prefixes ("PCT: Plumas" -> "Plumas") for rows rendered
 * inside a parent corridor container, falling back to `trail.region` if empty/generic.
 */
export const stripCorridorPrefix = (trail, corridor) => {
  const raw = String(trail?.name || '').trim();
  if (!corridor?.prefixRe) return raw || trail?.region || 'Trail section';
  let stripped = raw.replace(corridor.prefixRe, '').replace(/^[:\-—–,\s]+/, '').trim();
  stripped = stripped.replace(/^(?:National\s+Scenic(?:\s+Trail)?|Trail|Seg(?:ment)?\s*\d*)$/i, '').trim();
  if (!stripped || /^\d+(?:\.\d+)?$/.test(stripped)) {
    return trail?.region || raw;
  }
  return stripped;
};

/** Return the closest named landmark label near a milepost on the corridor. */
export const nearestLandmark = (corridor, mile) => {
  if (!corridor?.landmarks?.length) return `Mi ${Math.round(mile)}`;
  let best = corridor.landmarks[0];
  let bestD = Infinity;
  for (const lm of corridor.landmarks) {
    const d = Math.abs(lm.mi - mile);
    if (d < bestD) {
      bestD = d;
      best = lm;
    }
  }
  return bestD <= Math.max(45, corridor.totalMiles * 0.04) ? best.label : `Near ${best.label}`;
};
