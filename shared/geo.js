/**
 * Dependency-free route geometry shared by the server (analysis) and the
 * browser (map slicing, GPS projection). Both sides MUST measure the route
 * with these functions so that "Mi 42.3" means the same place everywhere.
 *
 * Coordinates are GeoJSON order: [lon, lat] or [lon, lat, elevationMeters].
 * Distances are statute miles.
 */

// Same mean Earth radius turf.js uses (6371008.8 m), expressed in miles.
export const EARTH_RADIUS_MI = 3958.7613;
const DEG = Math.PI / 180;
export const MILES_PER_DEG_LAT = EARTH_RADIUS_MI * DEG;

export const haversineMiles = (lon1, lat1, lon2, lat2) => {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(a)));
};

/** Cumulative distance (miles) at every vertex. cum[0] === 0. */
export const cumulativeMiles = (coords) => {
  const cum = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    cum[i] = cum[i - 1] + haversineMiles(a[0], a[1], b[0], b[1]);
  }
  return cum;
};

/** Index i such that cum[i] <= mile < cum[i + 1] (clamped to a valid edge). */
const edgeIndexAt = (cum, mile) => {
  let lo = 0;
  let hi = cum.length - 1;
  if (mile <= 0) return 0;
  if (mile >= cum[hi]) return Math.max(0, hi - 1);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= mile) lo = mid; else hi = mid;
  }
  return lo;
};

const lerpCoord = (a, b, t) => {
  const out = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  if (a.length > 2 && b.length > 2 && a[2] != null && b[2] != null) {
    out.push(a[2] + (b[2] - a[2]) * t);
  }
  return out;
};

/** Interpolated coordinate at a given mile along the route. */
export const pointAtMile = (coords, cum, mile) => {
  if (coords.length === 1) return coords[0].slice();
  const i = edgeIndexAt(cum, mile);
  const span = cum[i + 1] - cum[i];
  const t = span > 0 ? Math.min(1, Math.max(0, (mile - cum[i]) / span)) : 0;
  return lerpCoord(coords[i], coords[i + 1], t);
};

/**
 * Coordinates of the route between two miles, including interpolated
 * endpoints. Always returns at least two points for a non-empty range.
 */
export const sliceByMiles = (coords, cum, startMile, endMile) => {
  const total = cum[cum.length - 1];
  const a = Math.max(0, Math.min(startMile, total));
  const b = Math.max(a, Math.min(endMile, total));
  const out = [pointAtMile(coords, cum, a)];
  let i = edgeIndexAt(cum, a) + 1;
  while (i < coords.length && cum[i] < b) {
    if (cum[i] > a) out.push(coords[i]);
    i++;
  }
  out.push(pointAtMile(coords, cum, b));
  return out;
};

/**
 * Evenly spaced samples from startMile to endMile (both included).
 * Returns [{ lon, lat, ele, mile }]. Walks forward once — O(n + samples).
 */
export const samplePoints = (coords, cum, startMile, endMile, stepMiles) => {
  const out = [];
  if (coords.length === 0 || endMile < startMile) return out;
  const count = Math.max(1, Math.ceil((endMile - startMile) / stepMiles - 1e-9));
  let i = edgeIndexAt(cum, startMile);
  for (let k = 0; k <= count; k++) {
    const mile = k === count ? endMile : startMile + k * stepMiles;
    while (i < coords.length - 2 && cum[i + 1] <= mile) i++;
    let c;
    if (coords.length === 1) {
      c = coords[0];
    } else {
      const span = cum[i + 1] - cum[i];
      const t = span > 0 ? Math.min(1, Math.max(0, (mile - cum[i]) / span)) : 0;
      c = lerpCoord(coords[i], coords[i + 1], t);
    }
    out.push({ lon: c[0], lat: c[1], ele: c.length > 2 ? c[2] : null, mile });
  }
  return out;
};

/**
 * Project a position onto the route. Returns the nearest on-route mile and
 * how far off-route (miles) the position is. Uses a local equirectangular
 * projection per edge, which is accurate to well under 1% at trail scales.
 */
export const projectOntoRoute = (coords, cum, lon, lat, hintMile = null) => {
  if (coords.length === 0) return { mile: 0, offRouteMiles: Infinity, index: 0 };
  if (coords.length === 1) {
    return { mile: 0, offRouteMiles: haversineMiles(lon, lat, coords[0][0], coords[0][1]), index: 0 };
  }
  const kx = Math.cos(lat * DEG);
  let best = { mile: 0, offRouteMiles: Infinity, index: 0 };
  const near = []; // per-edge closest points within reach, for pass disambiguation
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const ax = (a[0] - lon) * kx, ay = a[1] - lat;
    const bx = (b[0] - lon) * kx, by = b[1] - lat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t, py = ay + dy * t;
    const cand = { mile: cum[i] + (cum[i + 1] - cum[i]) * t, offRouteMiles: Math.sqrt(px * px + py * py) * MILES_PER_DEG_LAT, index: i };
    if (cand.offRouteMiles < best.offRouteMiles) best = cand;
    if (hintMile != null && cand.offRouteMiles < 1) near.push(cand);
  }
  if (hintMile == null) return best;
  // Out-and-back and loop routes pass the same spot more than once. Among the
  // passes about as close as the geometric best, take the one nearest the
  // hiker's previous mile, then its closest point.
  const close = near.filter(c => c.offRouteMiles <= best.offRouteMiles + 0.1);
  if (!close.length) return best;
  const anchor = close.reduce((p, c) => (Math.abs(c.mile - hintMile) < Math.abs(p.mile - hintMile) ? c : p));
  const pass = close.filter(c => Math.abs(c.mile - anchor.mile) <= 0.5);
  return pass.reduce((p, c) => (c.offRouteMiles < p.offRouteMiles ? c : p));
};

/** [minLon, minLat, maxLon, maxLat] of a coordinate list. */
export const coordsBbox = (coords) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of coords) {
    if (c[0] < minX) minX = c[0];
    if (c[0] > maxX) maxX = c[0];
    if (c[1] < minY) minY = c[1];
    if (c[1] > maxY) maxY = c[1];
  }
  return [minX, minY, maxX, maxY];
};

/** Grow a bbox by a distance in miles (longitude scaled at the bbox's widest latitude). */
export const padBbox = (bbox, miles) => {
  const maxAbsLat = Math.min(89, Math.max(Math.abs(bbox[1]), Math.abs(bbox[3])));
  const dLat = miles / MILES_PER_DEG_LAT;
  const dLon = miles / (MILES_PER_DEG_LAT * Math.max(0.01, Math.cos(maxAbsLat * DEG)));
  return [bbox[0] - dLon, bbox[1] - dLat, bbox[2] + dLon, bbox[3] + dLat];
};

export const bboxIntersects = (a, b) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

export const pointInBbox = (lon, lat, b) =>
  lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];

/**
 * Douglas–Peucker simplification (planar, degrees scaled by latitude).
 * toleranceMiles is the max allowed perpendicular deviation.
 */
export const simplifyLine = (coords, toleranceMiles) => {
  if (coords.length <= 2) return coords.slice();
  const lat0 = coords[0][1] * DEG;
  const kx = Math.cos(lat0) * MILES_PER_DEG_LAT;
  const ky = MILES_PER_DEG_LAT;
  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  const tol2 = toleranceMiles * toleranceMiles;
  while (stack.length) {
    const [s, e] = stack.pop();
    const ax = coords[s][0] * kx, ay = coords[s][1] * ky;
    const bx = coords[e][0] * kx, by = coords[e][1] * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const px = coords[i][0] * kx - ax, py = coords[i][1] * ky - ay;
      let d2;
      if (len2 === 0) {
        d2 = px * px + py * py;
      } else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        const qx = px - dx * t, qy = py - dy * t;
        d2 = qx * qx + qy * qy;
      }
      if (d2 > maxD) { maxD = d2; maxI = i; }
    }
    if (maxD > tol2 && maxI > 0) {
      keep[maxI] = 1;
      stack.push([s, maxI], [maxI, e]);
    }
  }
  const out = [];
  for (let i = 0; i < coords.length; i++) if (keep[i]) out.push(coords[i]);
  return out;
};

/**
 * Normalize raw coordinates for upload/analysis: drop invalid points and
 * consecutive duplicates, round to 6 decimals (~0.1 m) and elevation to
 * 0.1 m, and simplify very dense tracks down to maxPoints.
 */
export const normalizeCoords = (rawCoords, maxPoints = 20000) => {
  const out = stripPlaceholderElevation(normalizePoints(rawCoords));
  if (out.length <= maxPoints) return out;
  // Grow tolerance until the track fits. ~3 m start; each pass doubles.
  let tol = 0.002;
  let simplified = out;
  while (simplified.length > maxPoints && tol < 1) {
    simplified = simplifyLine(out, tol);
    tol *= 2;
  }
  return simplified;
};

/**
 * Many exporters (Google My Maps/Earth KML, some planners) write a constant
 * altitude, usually 0, for every point. A flat line is a placeholder, not
 * terrain — treating it as real would skew elevation-adjusted forecasts.
 */
export const stripPlaceholderElevation = (coords) => {
  let min = Infinity, max = -Infinity, n = 0;
  for (const c of coords) {
    if (c.length < 3) continue;
    n++;
    if (c[2] < min) min = c[2];
    if (c[2] > max) max = c[2];
  }
  if (!n || (coords.length > 2 && max - min >= 1)) return coords;
  return coords.map(c => (c.length > 2 ? [c[0], c[1]] : c));
};

const normalizePoints = (rawCoords) => {
  const out = [];
  for (const c of rawCoords) {
    if (!Array.isArray(c) || c.length < 2) continue;
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) continue;
    const p = [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
    const ele = c[2];
    if (typeof ele === 'number' && Number.isFinite(ele) && ele > -500 && ele < 9000) p.push(Math.round(ele * 10) / 10);
    const prev = out[out.length - 1];
    if (prev && prev[0] === p[0] && prev[1] === p[1]) continue;
    out.push(p);
  }
  return out;
};

/** Short, stable, non-cryptographic fingerprint of a coordinate list (FNV-1a 53-bit-safe pair). */
export const routeFingerprint = (coords) => {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const c of coords) {
    const s = `${c[0].toFixed(5)},${c[1].toFixed(5)};`;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ ch, 0x5bd1e995) >>> 0;
    }
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
};
