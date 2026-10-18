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
// A fire reported in the last few days with no size yet is usually a new,
// growing fire — not a spot fire. Grade it like a mid-size one.
const NEW_FIRE_MS = 3 * DAY_MS;
// Spot fires under 10 acres are usually caught quickly; flag them close in,
// but don't paint "High" for miles around every dispatch.
const SMALL_FIRE_ACRES = 10;

const typeLabel = (category) =>
  category === 'RX' ? 'Prescribed burn' : category === 'CX' ? 'Fire complex' : 'Wildfire';

const isContained = (f) => f.percentContained != null && f.percentContained >= 100;

/** Level for a mapped perimeter at distance d (0 = trail inside/crossing). */
export const perimeterLevel = (fire, d) => {
  const onTrail = d <= CROSSING_MILES;
  if (fire.category === 'RX') return onTrail ? 3 : d <= PERIMETER_NEAR_MILES ? 2 : 0;
  if (isContained(fire)) return onTrail ? 3 : d <= PERIMETER_NEAR_MILES ? 1 : 0;
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

/** Size class used for grading: unsized fresh fires count as 'mid'. */
const sizeClass = (inc, now) => {
  const acres = inc.acres;
  if (acres == null) {
    const fresh = (inc.discoveredAt && now - inc.discoveredAt < NEW_FIRE_MS) || (inc.updatedAt && now - inc.updatedAt < NEW_FIRE_MS);
    return fresh ? 'mid' : 'small';
  }
  if (acres < SMALL_FIRE_ACRES) return 'small';
  return acres >= 1000 ? 'large' : 'mid';
};

export const incidentLevel = (inc, d, now = Date.now()) => {
  const r = incidentRadiusMiles(inc.acres);
  const edge = Math.max(0, d - r);
  if (inc.category === 'RX') return d <= r + 1 ? 2 : d <= r + 3 ? 1 : 0;
  if (isContained(inc)) return d <= r + 1 ? 1 : 0;
  const size = sizeClass(inc, now);
  if (size === 'small') return edge <= 1 ? 2 : edge <= 3 ? 1 : 0;
  if (d <= r) return (inc.acres || 0) >= 100 ? 4 : 3;
  if (edge <= 2) return 3;
  if (edge <= (size === 'large' ? 10 : 5)) return 2;
  return 0;
};

export const incidentReachMiles = (inc, now = Date.now()) => {
  const size = sizeClass(inc, now);
  return incidentRadiusMiles(inc.acres) + (size === 'small' ? 3 : size === 'large' ? 10 : 5);
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
  if (lead.perimeterAsOf) parts.push(`perimeter mapped ${fmtDate(lead.perimeterAsOf, timeZone)}${lead.mapMethod ? ` (${lead.mapMethod})` : ''}`);
  parts.push(freshness(lead.updatedAt, now, timeZone));
  if (complex && names.some(n => n !== complex.name)) parts.push(`includes ${names.join(', ')}`);
  const anyActive = group.members.some(m => m.category !== 'RX' && !isContained(m));
  return {
    id: hazardId,
    type: 'fire',
    kind: 'fire-perimeter',
    source: 'OFFICIAL',
    title: `${typeLabel(complex ? 'CX' : lead.category)}: ${complex?.name || lead.name}${lead.state ? `, ${lead.state}` : ''}`,
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
    advice: 'Only the point of origin is known — the actual fire edge may be closer. Check InciWeb and the land manager.',
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
  const perimeters = (data?.perimeters || []).filter(p => p.bbox);
  const incidents = data?.incidents || [];

  // Complex children roll up into one hazard per complex.
  const hazardIdFor = (f) => `fire:${f.isComplexChild && f.complexId ? f.complexId : f.key}`;

  const index = buildGridIndex(perimeters);
  const reachBoxes = new Map();
  for (const chunk of route.chunks) {
    const box = padBbox(chunk.bbox, PERIMETER_AREA_MILES);
    for (const fire of queryBbox(index, box)) {
      if (!reachBoxes.has(fire)) reachBoxes.set(fire, padBbox(fire.bbox, PERIMETER_AREA_MILES));
      const { best, atMile } = minDistance(chunk.samplesFine, fire, reachBoxes.get(fire));
      const level = perimeterLevel(fire, best);
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
    if (inc.hasPerimeter) continue;
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
