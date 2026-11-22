import { MILES_PER_DEG_LAT, simplifyLine, bboxIntersects } from '../../shared/geo.js';

const DEG = Math.PI / 180;

const closeRing = (ring) => {
  if (ring.length < 2) return ring;
  const a = ring[0];
  const b = ring[ring.length - 1];
  return a[0] === b[0] && a[1] === b[1] ? ring : [...ring, a];
};

const cleanRing = (ring, toleranceMiles) => {
  const pts = ring
    .filter(c => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))
    .map(c => [c[0], c[1]]);
  const simplified = toleranceMiles > 0 ? simplifyLine(pts, toleranceMiles) : pts;
  const closed = closeRing(simplified);
  // Simplification can collapse tiny rings; fall back to the raw ring rather than lose the shape.
  if (closed.length >= 4) return closed;
  const raw = closeRing(pts);
  return raw.length >= 4 ? raw : null;
};

/**
 * Normalize a GeoJSON Polygon/MultiPolygon into simplified ring arrays:
 * [[outer, hole, ...], ...]. Returns [] for anything unusable.
 */
export const prepPolygons = (geometry, toleranceMiles = 0) => {
  if (!geometry) return [];
  let polys;
  if (geometry.type === 'Polygon') polys = [geometry.coordinates];
  else if (geometry.type === 'MultiPolygon') polys = geometry.coordinates;
  else if (geometry.type === 'GeometryCollection') {
    return (geometry.geometries || []).flatMap(g => prepPolygons(g, toleranceMiles));
  } else return [];

  const out = [];
  for (const poly of polys || []) {
    if (!Array.isArray(poly) || poly.length === 0) continue;
    const outer = cleanRing(poly[0], toleranceMiles);
    if (!outer) continue;
    const holes = poly.slice(1).map(r => cleanRing(r, toleranceMiles)).filter(Boolean);
    out.push([outer, ...holes]);
  }
  return out;
};

export const polygonsBbox = (polygons) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polygons) {
    for (const c of poly[0]) {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    }
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
};

export const countVertices = (polygons) =>
  polygons.reduce((n, poly) => n + poly.reduce((m, ring) => m + ring.length, 0), 0);

const pointInRing = (x, y, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

export const pointInPolygons = (lon, lat, polygons) => {
  for (const poly of polygons) {
    if (!pointInRing(lon, lat, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) {
      if (pointInRing(lon, lat, poly[h])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
};

/**
 * Distance in miles from a point to the nearest polygon edge, or 0 when the
 * point is inside. Local equirectangular projection — accurate at trail scale.
 */
export const distanceToPolygonsMiles = (lon, lat, polygons) => {
  if (pointInPolygons(lon, lat, polygons)) return 0;
  const kx = Math.cos(lat * DEG);
  let best2 = Infinity;
  for (const poly of polygons) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        const ax = (ring[i][0] - lon) * kx, ay = ring[i][1] - lat;
        const bx = (ring[i + 1][0] - lon) * kx, by = ring[i + 1][1] - lat;
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + dx * t, py = ay + dy * t;
        const d2 = px * px + py * py;
        if (d2 < best2) best2 = d2;
      }
    }
  }
  return Math.sqrt(best2) * MILES_PER_DEG_LAT;
};

/**
 * Coarse grid index over feature bboxes so per-chunk lookups touch only
 * nearby features. Features need a `bbox` property.
 */
export const buildGridIndex = (features, cellDeg = 0.5) => {
  const cells = new Map();
  features.forEach((f, idx) => {
    if (!f.bbox) return;
    const x0 = Math.floor(f.bbox[0] / cellDeg), x1 = Math.floor(f.bbox[2] / cellDeg);
    const y0 = Math.floor(f.bbox[1] / cellDeg), y1 = Math.floor(f.bbox[3] / cellDeg);
    // Continental-scale polygons would flood the grid; keep them in a global bucket.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) {
      if (!cells.has('*')) cells.set('*', []);
      cells.get('*').push(idx);
      return;
    }
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x}:${y}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(idx);
      }
    }
  });
  return { features, cells, cellDeg };
};

/** Features whose bbox intersects the query bbox. */
export const queryBbox = (index, bbox) => {
  const { features, cells, cellDeg } = index;
  const seen = new Set();
  const out = [];
  const consider = (list) => {
    if (!list) return;
    for (const idx of list) {
      if (seen.has(idx)) continue;
      seen.add(idx);
      if (bboxIntersects(features[idx].bbox, bbox)) out.push(features[idx]);
    }
  };
  const x0 = Math.floor(bbox[0] / cellDeg), x1 = Math.floor(bbox[2] / cellDeg);
  const y0 = Math.floor(bbox[1] / cellDeg), y1 = Math.floor(bbox[3] / cellDeg);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) consider(cells.get(`${x}:${y}`));
  }
  consider(cells.get('*'));
  return out;
};

const simplifyDisplayRing = (ring, toleranceMiles) => {
  const closed = closeRing(simplifyLine(ring, toleranceMiles));
  return closed.length >= 4 ? closed : null;
};

/**
 * Simplify prepared polygons for map display without altering hit-test shapes.
 * Drops sub-tolerance holes and micro-islands in MultiPolygons while always
 * preserving small standalone polygons.
 */
export const simplifyPolygons = (polygons, toleranceMiles) => {
  if (!Array.isArray(polygons) || !(toleranceMiles > 0)) return polygons || [];
  const multi = polygons.length > 1;
  const out = [];
  for (const poly of polygons) {
    if (!Array.isArray(poly) || poly.length === 0) continue;
    const outer = multi ? simplifyDisplayRing(poly[0], toleranceMiles) : cleanRing(poly[0], toleranceMiles);
    if (!outer) continue;
    const holes = poly.slice(1).map(r => simplifyDisplayRing(r, toleranceMiles)).filter(Boolean);
    out.push([outer, ...holes]);
  }
  if (out.length) return out;
  return polygons.map(poly => [cleanRing(poly[0], toleranceMiles)].filter(Boolean)).filter(p => p.length);
};

/** GeoJSON geometry from prepared polygons (for map overlays). */
export const polygonsToGeometry = (polygons) =>
  polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
