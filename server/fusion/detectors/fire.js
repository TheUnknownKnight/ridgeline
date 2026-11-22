import { padBbox, pointInBbox } from '../../../shared/geo.js';
import { buildGridIndex, queryBbox, distanceToPolygonsMiles, polygonsToGeometry } from '../../lib/spatial.js';
import { chunksNearPoint, fmtMiles, fmtAcres, fmtDate, toIso } from './common.js';
import { FINE_STEP_MILES } from '../route.js';
import { ATTRIBUTION } from '../../sources/nifc.js';

// Distances from the trail at which a mapped perimeter matters.
export const PERIMETER_NEAR_MILES = 1;   // closures and spot fires are likely
export const PERIMETER_AREA_MILES = 5;   // smoke, evacuations, expanding closures
// The fire is "on the trail" when a sample is inside or within this of the edge
// (catches crossings between 0.1-mile samples).
const CROSSING_MILES = 0.03;
const STALE_RECORD_DAYS = 3;
const DAY_MS = 86400000;
// A fire reported in the last 24 h with no size in any IRWIN field yet may be a
// fast-growing initial attack; after 24 h with no size, treat as a spot dispatch.
const NEW_FIRE_MS = 1 * DAY_MS;
// Spot fires under 1 acre (e.g. 0.01-acre roadside/campfire CAD tickets) only
// matter right by the trail; 1–10 acre fires are small; 10+ are mid/large.
const SPOT_FIRE_ACRES = 1;
const SMALL_FIRE_ACRES = 10;
// A >=90% contained perimeter untouched for >21 days with non-active behavior is
// mop-up / burn-scar caution, not an advancing wildfire.
const MOPUP_CONTAINED_PCT = 90;
const MOPUP_STATIC_DAYS = 21;
const ACTIVE_BEHAVIOR_RE = /\b(active|moderate|extreme|high|running|crowning|spotting|torching|flanking|wind[- ]driven)\b/i;
const PILE_BURN_RE = /\bpiles?\b/i;

const typeLabel = (category) =>
  category === 'RX' ? 'Prescribed burn' : category === 'CX' ? 'Fire complex' : 'Wildfire';

const isContained = (f) => f.percentContained != null && f.percentContained >= 100;

/**
 * True when a mapped wildfire perimeter is in late-stage mop-up / burn-scar
 * patrol (>=90% contained, perimeter unchanged for >21 days, and behavior is
 * minimal/unreported rather than active).
 */
export const isMopUpPerimeter = (f, now = Date.now()) => {
  if (!f || f.category === 'RX') return false;
  if (f.percentContained == null || f.percentContained < MOPUP_CONTAINED_PCT || f.percentContained >= 100) return false;
  const polySrc = f.perimeterAsOf ?? f.discoveredAt;
  if (polySrc == null || (now - polySrc) / DAY_MS <= MOPUP_STATIC_DAYS) return false;
  if (ACTIVE_BEHAVIOR_RE.test(f.behavior || '')) return false;
  return true;
};

/**
 * Whether a NIFC WFIGS record represents a fire that has ended (declared out,
 * controlled, 100% contained, Final ICS-209 filed, or an abandoned unmapped
 * dispatch record with no active ICS-209).
 *
 * Safety rule: any fire with an active (non-Final) ICS-209 report or a mapped
 * perimeter reporting partial containment (0 < pct < 100) is NEVER aged out,
 * even on multi-month campaign fires.
 */
export const isFireEnded = (f, now = Date.now(), { isPerimeter = false } = {}) => {
  if (!f) return true;
  if (f.outAt != null && f.outAt <= now) return true;
  if (f.controlledAt != null && f.controlledAt <= now) return true;
  if (f.containedAt != null && f.containedAt <= now) return true;
  if (isContained(f)) {
    if (f.isComplexChild && f.complex && !isContained(f.complex) && !isFireEnded(f.complex, now)) return false;
    return true;
  }
  if (f.icsStatus === 'F') return true;

  const discDays = f.discoveredAt != null ? (now - f.discoveredAt) / DAY_MS : null;
  const polySrc = f.perimeterAsOf ?? f.discoveredAt;
  const polyDays = polySrc != null ? (now - polySrc) / DAY_MS : null;
  const icsDays = f.icsAt != null ? (now - f.icsAt) / DAY_MS : null;

  const hasActive209 = Boolean(f.icsStatus && f.icsStatus !== 'F' && (icsDays == null || icsDays <= 60));
  if (hasActive209) return false;
  if (f.percentContained != null && f.percentContained > 0 && f.percentContained < 100) return false;

  if (isPerimeter) {
    if ((discDays ?? 0) > 30 && (polyDays ?? 999) > 21) return true;
    return false;
  }

  if (discDays == null) return false;
  if ((f.acres == null || f.acres < 1) && discDays > 7) return true;
  if (f.category === 'RX' && discDays > 14) return true;
  if (discDays > 21) return true;
  return false;
};

/** Level for a mapped perimeter at distance d (0 = trail inside/crossing). */
export const perimeterLevel = (fire, d, now = Date.now()) => {
  if (isFireEnded(fire, now, { isPerimeter: true })) return 0;
  const onTrail = d <= CROSSING_MILES;
  if (fire.category === 'RX') return onTrail ? 3 : d <= PERIMETER_NEAR_MILES ? 2 : 0;
  if (isMopUpPerimeter(fire, now)) return onTrail ? 2 : d <= PERIMETER_NEAR_MILES ? 1 : 0;
  if (onTrail) return 4;
  if (d <= PERIMETER_NEAR_MILES) return 3;
  if (d <= PERIMETER_AREA_MILES) return 2;
  return 0;
};

/**
 * Incidents with no mapped perimeter only have a point of origin. Estimate a
 * footprint from reported acres (equal-area circle, ×1.5 for irregular shape,
 * ≥ 0.25 mi) and grade by distance from that footprint.
 */
export const incidentRadiusMiles = (acres) => {
  if (!Number.isFinite(acres) || acres <= 0) return 0.25;
  const r = Math.sqrt((acres * 4046.86) / Math.PI) / 1609.344;
  return Math.max(0.25, r * 1.5);
};

const isSmallRx = (inc) => inc.acres == null || inc.acres < SMALL_FIRE_ACRES || PILE_BURN_RE.test(inc.name || '');

/**
 * Size class used for grading: truly unsized fresh (<24 h) fires count as 'mid';
 * sub-acre spots (e.g. 0.01-acre CAD roadside/campfire tickets) count as 'spot'.
 * Use discovery date when present so automated IRWIN batch updates on old
 * records do not make stale dispatches look newly discovered.
 */
const sizeClass = (inc, now) => {
  const acres = inc.acres;
  if (acres == null) {
    const reportedAt = inc.discoveredAt ?? inc.updatedAt;
    const fresh = reportedAt != null && now - reportedAt < NEW_FIRE_MS;
    return fresh ? 'mid' : 'spot';
  }
  if (acres < SPOT_FIRE_ACRES) return 'spot';
  if (acres < SMALL_FIRE_ACRES) return 'small';
  return acres >= 1000 ? 'large' : 'mid';
};

export const incidentLevel = (inc, d, now = Date.now()) => {
  if (isFireEnded(inc, now, { isPerimeter: false })) return 0;
  const r = incidentRadiusMiles(inc.acres);
  const edge = Math.max(0, d - r);
  if (inc.category === 'RX') {
    if (PILE_BURN_RE.test(inc.name || '')) return d <= r ? 2 : edge <= 1 ? 1 : 0;
    if (isSmallRx(inc)) return edge <= 0.5 ? 2 : edge <= 1 ? 1 : 0;
    return edge <= 1 ? 2 : edge <= 3 ? 1 : 0;
  }
  const size = sizeClass(inc, now);
  if (size === 'spot') return edge <= 0.5 ? 2 : edge <= 1 ? 1 : 0;
  if (size === 'small') return edge <= 1 ? 2 : edge <= 3 ? 1 : 0;
  if (d <= r) return (inc.acres || 0) >= 100 ? 4 : 3;
  if (edge <= 2) return 3;
  if (edge <= (size === 'large' ? 10 : 5)) return 2;
  return 0;
};

export const incidentReachMiles = (inc, now = Date.now()) => {
  if (inc.category === 'RX') return incidentRadiusMiles(inc.acres) + (isSmallRx(inc) ? 1 : 3);
  const size = sizeClass(inc, now);
  return incidentRadiusMiles(inc.acres) + (size === 'spot' ? 1 : size === 'small' ? 3 : size === 'large' ? 10 : 5);
};

const containmentText = (pct) => (pct == null ? 'containment not reported' : `${Math.round(pct)}% contained`);

const freshness = (updatedAt, now, timeZone) => {
  if (!updatedAt) return null;
  const days = (now - updatedAt) / DAY_MS;
  return days > STALE_RECORD_DAYS ? `record last updated ${Math.floor(days)} days ago` : `updated ${fmtDate(updatedAt, timeZone)}`;
};

const ADVICE = {
  RX: 'Planned burn in progress — expect smoke and temporary closures.',
  contained: 'Burned area — closures, hazard trees and washouts may remain. Check with the land manager.',
  active: 'Check closure orders with the land manager and InciWeb before you go. Fire behavior can change quickly.',
};

/**
 * One hazard per fire, or per complex when members roll up. `group` collects
 * every member perimeter that touched the route.
 */
const perimeterHazard = (hazardId, group, now, timeZone) => {
  const lead = group.members[0];
  const complex = lead.complex;
  const names = [...new Set(group.members.map(m => m.name))];
  // For a complex prefer its own totals; otherwise the least-contained member that hit.
  const acres = complex?.acres ?? lead.acres;
  const pcts = group.members.map(m => m.percentContained).filter(p => p != null);
  const pct = complex ? complex.percentContained : (pcts.length ? Math.min(...pcts) : null);
  const parts = [fmtAcres(acres), containmentText(pct)];
  if (lead.behavior) parts.push(`fire behavior: ${lead.behavior.toLowerCase()}`);
  if (lead.perimeterAsOf) parts.push(`perimeter mapped ${fmtDate(lead.perimeterAsOf, timeZone)}${lead.mapMethod ? ` (${lead.mapMethod})` : ''}`);
  parts.push(freshness(lead.updatedAt, now, timeZone));
  if (complex && names.some(n => n !== complex.name)) parts.push(`includes ${names.join(', ')}`);
  const anyActive = group.members.some(m => m.category !== 'RX' && !isContained(m) && !isMopUpPerimeter(m, now));
  const allMopUp = !anyActive && group.members.every(m => isMopUpPerimeter(m, now));
  return {
    id: hazardId,
    type: 'fire',
    kind: 'fire-perimeter',
    source: 'OFFICIAL',
    title: `${allMopUp ? 'Burned area' : typeLabel(complex ? 'CX' : lead.category)}: ${complex?.name || lead.name}${lead.state ? `, ${lead.state}` : ''}`,
    detail: parts.filter(Boolean).join(' · '),
    advice: anyActive ? ADVICE.active : lead.category === 'RX' ? ADVICE.RX : ADVICE.contained,
    attribution: ATTRIBUTION,
    url: 'https://inciweb.wildfire.gov/',
    issuedAt: toIso(Math.max(...group.members.map(m => m.updatedAt || 0)) || null),
  };
};

const incidentHazard = (inc, hazardId, now, timeZone) => {
  const parts = [
    fmtAcres(inc.acres) || 'size not reported',
    containmentText(inc.percentContained),
    inc.behavior ? `fire behavior: ${inc.behavior.toLowerCase()}` : null,
    inc.description,
    inc.discoveredAt ? `discovered ${fmtDate(inc.discoveredAt, timeZone)}` : null,
    freshness(inc.updatedAt, now, timeZone),
  ];
  return {
    id: hazardId,
    type: 'fire',
    kind: 'fire-incident',
    source: 'OFFICIAL',
    title: `${typeLabel(inc.category)}: ${inc.name}${inc.state ? `, ${inc.state}` : ''} (no mapped perimeter)`,
    detail: parts.filter(Boolean).join(' · '),
    advice: inc.category === 'RX'
      ? ADVICE.RX
      : 'Only the point of origin is known — the actual fire edge may be closer. Check InciWeb and the land manager.',
    attribution: ATTRIBUTION,
    url: 'https://inciweb.wildfire.gov/',
    issuedAt: toIso(inc.updatedAt),
  };
};

const noteFor = (d) => (d <= CROSSING_MILES ? 'trail crosses perimeter' : `${fmtMiles(d)} mi from trail`);

/**
 * Minimum distance from a chunk's samples to a perimeter. Consecutive samples
 * are ≤ 0.1 mi apart, so a sample d miles away proves the next
 * (d − floor) / 0.1 samples can't come closer than `floor` — skip them.
 * Exact, and it keeps long routes past big perimeters cheap.
 */
const minDistance = (samples, fire, reachBox) => {
  let best = Infinity;
  let atMile = samples[0]?.mile ?? 0;
  for (let k = 0; k < samples.length;) {
    const s = samples[k];
    if (!pointInBbox(s.lon, s.lat, reachBox)) { k++; continue; }
    const d = distanceToPolygonsMiles(s.lon, s.lat, fire.polygons);
    if (d < best) { best = d; atMile = s.mile; }
    if (d === 0) break;
    const floor = Math.min(best, PERIMETER_AREA_MILES);
    k += Math.max(1, Math.floor((d - floor) / FINE_STEP_MILES));
  }
  return { best, atMile };
};

export const detectFire = (route, data, { now = Date.now(), timeZone } = {}) => {
  const groups = new Map(); // hazard id -> { members: [perimeter] }
  const incidentHazards = new Map();
  const hits = [];
  const perimeterOverlays = new Map(); // perimeter -> overlay feature (level = max over hits)
  const incidentOverlays = [];
  const perimeters = (data?.perimeters || []).filter(p => p.bbox && !isFireEnded(p, now, { isPerimeter: true }));
  const incidents = (data?.incidents || []).filter(inc => !inc.hasPerimeter && !isFireEnded(inc, now, { isPerimeter: false }));

  // Complex children roll up into one hazard per complex.
  const hazardIdFor = (f) => `fire:${f.isComplexChild && f.complexId ? f.complexId : f.key}`;

  const index = buildGridIndex(perimeters);
  const reachBoxes = new Map();
  for (const chunk of route.chunks) {
    const box = padBbox(chunk.bbox, PERIMETER_AREA_MILES);
    for (const fire of queryBbox(index, box)) {
      if (!reachBoxes.has(fire)) reachBoxes.set(fire, padBbox(fire.bbox, PERIMETER_AREA_MILES));
      const { best, atMile } = minDistance(chunk.samplesFine, fire, reachBoxes.get(fire));
      const level = perimeterLevel(fire, best, now);
      if (!level) continue;
      const id = hazardIdFor(fire);
      const group = groups.get(id) || { members: [] };
      if (!group.members.includes(fire)) group.members.push(fire);
      groups.set(id, group);
      hits.push({ chunk: chunk.i, id, level, distance: best, atMile, note: noteFor(best) });
      const overlay = perimeterOverlays.get(fire);
      if (overlay) overlay.properties.level = Math.max(overlay.properties.level, level);
      else {
        perimeterOverlays.set(fire, {
          type: 'Feature',
          geometry: polygonsToGeometry(fire.polygons),
          properties: { overlay: 'fire-perimeter', hazardId: id, level, title: fire.name },
        });
      }
    }
  }

  for (const inc of incidents) {
    const id = `fire:${inc.key}`;
    // A perimeter hazard with the same id (e.g. a complex) always wins.
    if (groups.has(id)) continue;
    const near = chunksNearPoint(route, inc.lon, inc.lat, incidentReachMiles(inc, now));
    let maxLevel = 0;
    for (const n of near) {
      const level = incidentLevel(inc, n.distance, now);
      if (!level) continue;
      maxLevel = Math.max(maxLevel, level);
      hits.push({ chunk: n.chunk, id, level, distance: n.distance, atMile: n.atMile, note: `origin ${fmtMiles(n.distance)} mi from trail` });
    }
    if (!maxLevel) continue;
    incidentHazards.set(id, incidentHazard(inc, id, now, timeZone));
    incidentOverlays.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [inc.lon, inc.lat] },
      properties: {
        overlay: 'fire-incident', hazardId: id, level: maxLevel, title: inc.name,
        radiusMiles: Math.round(incidentRadiusMiles(inc.acres) * 100) / 100,
      },
    });
  }

  const hazards = [
    ...[...groups].map(([id, group]) => perimeterHazard(id, group, now, timeZone)),
    ...incidentHazards.values(),
  ];
  return { hazards, hits, overlays: [...perimeterOverlays.values(), ...incidentOverlays] };
};
