/**
 * Pure-JS polyline stitcher and continuity validator for multi-segment
 * public trail geometries (USFS / NPS ArcGIS GeoJSON layers).
 *
 * Zero Node dependencies so the exact same stitcher runs in Express, on
 * Capacitor iOS/Android, and in browser bundles.
 *
 * Coordinates are GeoJSON order: [lon, lat] or [lon, lat, elevationMeters].
 * Distances are statute miles.
 */
import {
  haversineMiles,
  cumulativeMiles,
  simplifyLine,
  stripPlaceholderElevation,
} from '../geo.js';

const DEFAULT_MAX_VERTICES = 2500;
const EXACT_SNAP_MILES = 0.01;     // ~16 m: exact GIS junction tolerance
const SAME_POINT_MILES = 0.0005;   // ~0.8 m: avoid duplicate joint vertices
const DUP_SEG_TOL_MILES = 0.003;   // ~5 m: detect duplicate overlapping rows

const cleanPoint = (raw) => {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const lon = Number(raw[0]);
  const lat = Number(raw[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  const p = [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
  const ele = raw[2];
  if (typeof ele === 'number' && Number.isFinite(ele) && ele > -500 && ele < 9000) {
    p.push(Math.round(ele * 10) / 10);
  }
  return p;
};

const cleanPolyline = (raw) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const pt of raw) {
    const p = cleanPoint(pt);
    if (!p) continue;
    const prev = out[out.length - 1];
    if (prev && prev[0] === p[0] && prev[1] === p[1]) continue;
    out.push(p);
  }
  return out;
};

const polylineLength = (coords) => {
  if (coords.length < 2) return 0;
  const cum = cumulativeMiles(coords);
  return cum[cum.length - 1];
};

const ptDist = (a, b) => haversineMiles(a[0], a[1], b[0], b[1]);

const isDuplicateSegment = (a, b) => {
  const maxLen = Math.max(a.len, b.len);
  if (Math.abs(a.len - b.len) > Math.max(0.01, maxLen * 0.02)) return false;
  const aStart = a.coords[0];
  const aEnd = a.coords[a.coords.length - 1];
  const aMid = a.coords[a.coords.length >> 1];
  const bStart = b.coords[0];
  const bEnd = b.coords[b.coords.length - 1];
  const bMid = b.coords[b.coords.length >> 1];
  if (ptDist(aMid, bMid) > DUP_SEG_TOL_MILES) return false;
  const sameDir = ptDist(aStart, bStart) <= DUP_SEG_TOL_MILES && ptDist(aEnd, bEnd) <= DUP_SEG_TOL_MILES;
  const revDir = ptDist(aStart, bEnd) <= DUP_SEG_TOL_MILES && ptDist(aEnd, bStart) <= DUP_SEG_TOL_MILES;
  return sameDir || revDir;
};

const isBetterCandidate = (cand, best) => {
  if (!best) return true;
  const candExact = cand.dist <= EXACT_SNAP_MILES;
  const bestExact = best.dist <= EXACT_SNAP_MILES;
  if (candExact && bestExact) {
    // At a shared junction (e.g. main trail vs. short spur), follow the longer trunk.
    if (cand.len !== best.len) return cand.len > best.len;
    return cand.dist < best.dist;
  }
  if (candExact !== bestExact) return candExact;
  if (cand.dist !== best.dist) return cand.dist < best.dist;
  return cand.len > best.len;
};

/**
 * Extract all LineString coordinate arrays from GeoJSON features or geometries.
 */
export const extractLineSegments = (features) => {
  if (!Array.isArray(features)) return [];
  const segments = [];
  const pushGeom = (geom) => {
    if (!geom || typeof geom !== 'object') return;
    if (geom.type === 'LineString' && Array.isArray(geom.coordinates)) {
      segments.push(geom.coordinates);
    } else if (geom.type === 'MultiLineString' && Array.isArray(geom.coordinates)) {
      for (const part of geom.coordinates) {
        if (Array.isArray(part)) segments.push(part);
      }
    } else if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
      for (const child of geom.geometries) pushGeom(child);
    }
  };
  for (const item of features) {
    pushGeom(item?.geometry ?? item);
  }
  return segments;
};

const chainComponents = (segments, maxGapMiles) => {
  const cleaned = [];
  for (const seg of segments) {
    const coords = cleanPolyline(seg);
    if (coords.length < 2) continue;
    const len = polylineLength(coords);
    if (len <= 0) continue;
    cleaned.push({ coords, len });
  }

  const totalSegments = cleaned.length;
  if (totalSegments === 0) return { components: [], totalSegments: 0 };

  // Deduplicate exact overlapping GIS rows so we never double-back over the same line.
  const unique = [];
  for (const seg of cleaned) {
    if (!unique.some((existing) => isDuplicateSegment(existing, seg))) {
      unique.push(seg);
    }
  }

  const used = new Uint8Array(unique.length);
  let remaining = unique.length;
  const components = [];

  while (remaining > 0) {
    // Seed each component with the longest unused segment so we start on the trunk.
    let seedIdx = -1;
    let seedLen = -1;
    for (let i = 0; i < unique.length; i++) {
      if (!used[i] && unique[i].len > seedLen) {
        seedIdx = i;
        seedLen = unique[i].len;
      }
    }
    if (seedIdx < 0) break;

    used[seedIdx] = 1;
    remaining--;
    let chain = unique[seedIdx].coords.slice();
    let segmentsUsed = 1;

    while (remaining > 0) {
      const head = chain[0];
      const tail = chain[chain.length - 1];
      let best = null;

      for (let i = 0; i < unique.length; i++) {
        if (used[i]) continue;
        const seg = unique[i];
        const sStart = seg.coords[0];
        const sEnd = seg.coords[seg.coords.length - 1];

        const options = [
          { index: i, where: 'tail', reverse: false, dist: ptDist(tail, sStart), len: seg.len },
          { index: i, where: 'tail', reverse: true,  dist: ptDist(tail, sEnd),   len: seg.len },
          { index: i, where: 'head', reverse: false, dist: ptDist(head, sEnd),   len: seg.len },
          { index: i, where: 'head', reverse: true,  dist: ptDist(head, sStart), len: seg.len },
        ];

        for (const opt of options) {
          if (opt.dist <= maxGapMiles && isBetterCandidate(opt, best)) {
            best = opt;
          }
        }
      }

      if (!best) break;

      used[best.index] = 1;
      remaining--;
      segmentsUsed++;

      const part = best.reverse
        ? unique[best.index].coords.slice().reverse()
        : unique[best.index].coords;

      if (best.where === 'tail') {
        const dropFirst = ptDist(tail, part[0]) <= SAME_POINT_MILES;
        for (let k = dropFirst ? 1 : 0; k < part.length; k++) chain.push(part[k]);
      } else {
        const dropLast = ptDist(part[part.length - 1], head) <= SAME_POINT_MILES;
        const prefix = dropLast ? part.slice(0, -1) : part.slice();
        chain = prefix.concat(chain);
      }
    }

    components.push({ coords: chain, lengthMiles: polylineLength(chain), segmentsUsed });
  }

  return { components, totalSegments };
};

const finalizeStitchedCoords = (rawCoords, maxVertices, minLengthMiles) => {
  let coords = stripPlaceholderElevation(cleanPolyline(rawCoords));
  if (coords.length > maxVertices) {
    let tol = 0.002; // ~3.2 m starting Douglas-Peucker tolerance
    let simplified = coords;
    while (simplified.length > maxVertices && tol < 1) {
      simplified = simplifyLine(coords, tol);
      tol *= 1.5;
    }
    coords = simplified;
  }

  if (coords.length < 2) return null;
  const lengthMiles = polylineLength(coords);
  if (lengthMiles < minLengthMiles) return null;
  return { coords, lengthMiles };
};

/**
 * Stitch an unordered array of polyline segments belonging to one named trail
 * into a single continuous track.
 *
 * - Strips invalid/duplicate coordinates.
 * - Greedily chains segments endpoint-to-endpoint (both ends of the active
 *   chain, reversing segments when needed) while the endpoint gap is within
 *   `maxGapMiles`.
 * - If disconnected components remain (separate trails sharing a name, or
 *   disconnected spurs), returns ONLY the longest continuous component so no
 *   bogus straight teleport line is ever drawn across miles of terrain.
 * - Simplifies slightly if the stitched line exceeds `maxVertices` (default 2500).
 *
 * Returns `{ coords, lengthMiles, segmentsUsed, totalSegments, start, end }`
 * or `null` when the longest continuous component is shorter than
 * `minLengthMiles` or has fewer than 2 points.
 */
export const stitchSegments = (
  segments,
  { maxGapMiles = 0.35, minLengthMiles = 0.25, maxVertices = DEFAULT_MAX_VERTICES } = {},
) => {
  if (!Array.isArray(segments) || segments.length === 0) return null;

  const { components, totalSegments } = chainComponents(segments, maxGapMiles);
  if (!components.length) return null;

  let bestComponent = components[0];
  for (let i = 1; i < components.length; i++) {
    if (components[i].lengthMiles > bestComponent.lengthMiles) {
      bestComponent = components[i];
    }
  }

  const finalized = finalizeStitchedCoords(bestComponent.coords, maxVertices, minLengthMiles);
  if (!finalized) return null;

  return {
    coords: finalized.coords,
    lengthMiles: finalized.lengthMiles,
    segmentsUsed: bestComponent.segmentsUsed,
    totalSegments,
    start: finalized.coords[0],
    end: finalized.coords[finalized.coords.length - 1],
  };
};

const shouldReverseForAxis = (coords, direction) => {
  const first = coords[0];
  const last = coords[coords.length - 1];
  switch (direction) {
    case 'north-to-south': return first[1] < last[1];
    case 'west-to-east':   return first[0] > last[0];
    case 'east-to-west':   return first[0] < last[0];
    case 'south-to-north':
    default:               return first[1] > last[1];
  }
};

const axisMidpoint = (coords, direction) => {
  const first = coords[0];
  const last = coords[coords.length - 1];
  const isLon = direction === 'west-to-east' || direction === 'east-to-west';
  return isLon ? (first[0] + last[0]) / 2 : (first[1] + last[1]) / 2;
};

const axisSign = (direction) =>
  direction === 'north-to-south' || direction === 'east-to-west' ? -1 : 1;

/**
 * Assemble a long multi-agency corridor (e.g. PCT spanning dozens of National Forests
 * and Parks) from unordered GeoJSON segments without dropping disconnected forests.
 */
export const stitchCorridorSegments = (
  segments,
  { direction = 'south-to-north', maxGapMiles = 0.5, minComponentMiles = 0.5, maxVertices = DEFAULT_MAX_VERTICES } = {},
) => {
  if (!Array.isArray(segments) || segments.length === 0) return null;

  const { components, totalSegments } = chainComponents(segments, maxGapMiles);
  if (!components.length) return null;

  const substantial = components.filter((c) => c.lengthMiles >= minComponentMiles);
  const chosen = substantial.length ? substantial : components;

  const sign = axisSign(direction);
  for (const comp of chosen) {
    if (shouldReverseForAxis(comp.coords, direction)) {
      comp.coords = comp.coords.slice().reverse();
    }
    comp.mid = axisMidpoint(comp.coords, direction);
  }
  chosen.sort((a, b) => (a.mid - b.mid) * sign);

  const combined = [];
  let segmentsUsed = 0;
  for (const comp of chosen) {
    segmentsUsed += comp.segmentsUsed;
    for (const pt of comp.coords) {
      const prev = combined[combined.length - 1];
      if (prev && prev[0] === pt[0] && prev[1] === pt[1]) continue;
      combined.push(pt);
    }
  }

  const finalized = finalizeStitchedCoords(combined, maxVertices, 0.25);
  if (!finalized) return null;

  return {
    coords: finalized.coords,
    lengthMiles: finalized.lengthMiles,
    segmentsUsed,
    totalSegments,
    componentCount: chosen.length,
    start: finalized.coords[0],
    end: finalized.coords[finalized.coords.length - 1],
  };
};
