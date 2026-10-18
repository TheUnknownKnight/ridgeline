import { coordsBbox, padBbox, samplePoints, routeFingerprint } from '../../shared/geo.js';
import { createCache } from '../lib/cache.js';

// Fine samples feed fire/gauge proximity; coarse (every other fine, 0.2 mi)
// feed containment tests against large areas (alert zones, avalanche zones).
export const FINE_STEP_MILES = 0.1;

// Route geometry is location-independent: build it once per route and reuse
// across On-Trail refreshes. Keyed by a server-computed fingerprint, so a
// client cannot poison another route's entry. Bounded by total samples
// (~250 bytes each) so a burst of huge uploads can't exhaust memory.
const MAX_CACHED_SAMPLES = 300000; // ≈ 30,000 route-miles, ~75 MB
const routeCache = createCache({ maxEntries: 50, maxWeight: MAX_CACHED_SAMPLES, weigh: (m) => m.sampleCount });
const ROUTE_TTL_MS = 3 * 60 * 60 * 1000;

// The fingerprint covers lon/lat only; a re-upload of the same track with
// different (or no) elevation must rebuild rather than reuse the old model.
const elevationSignature = (coords) => {
  let n = 0;
  let sum = 0;
  for (const c of coords) {
    if (c.length > 2) { n++; sum = (sum + Math.round(c[2]) * (n % 7919)) % 1e9; }
  }
  return `${n}:${sum}`;
};

const chunkBbox = (samples) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of samples) {
    if (s.lon < minX) minX = s.lon;
    if (s.lon > maxX) maxX = s.lon;
    if (s.lat < minY) minY = s.lat;
    if (s.lat > maxY) maxY = s.lat;
  }
  return [minX, minY, maxX, maxY];
};

/**
 * Split the route into integer-aligned 1-mile chunks: [0,1), [1,2), …,
 * [n, length]. Each chunk carries pre-sampled points for detectors.
 */
const buildChunks = (coords, cum, lengthMiles) => {
  const EPS = 1e-9;
  const fine = samplePoints(coords, cum, 0, lengthMiles, FINE_STEP_MILES);
  // Measured lengths carry float noise (10.0000001 mi); don't spawn a sliver chunk for it.
  const chunkCount = Math.max(1, Math.ceil(lengthMiles - 0.01));
  const chunks = [];
  let f = 0;
  for (let i = 0; i < chunkCount; i++) {
    const start = i;
    const end = i === chunkCount - 1 ? lengthMiles : i + 1;
    const samplesFine = [];
    while (f < fine.length && fine[f].mile < start - EPS) f++;
    let j = f;
    while (j < fine.length && fine[j].mile <= end + EPS) samplesFine.push(fine[j++]);
    // The boundary sample is shared with the next chunk so nothing falls between chunks.
    f = Math.max(f, j - 1);
    const samplesCoarse = samplesFine.filter((_, idx) => idx % 2 === 0 || idx === samplesFine.length - 1);
    chunks.push({ i, start, end, samplesFine, samplesCoarse, bbox: chunkBbox(samplesFine) });
  }
  return chunks;
};

export class RouteUnknownError extends Error {
  constructor() {
    super('Route not cached on the server; resend coordinates');
    this.name = 'RouteUnknownError';
    this.code = 'route_unknown';
  }
}

export const getRouteModel = async ({ coords, cum, lengthMiles, hasElevation, routeHash: knownHash }) => {
  if (!coords) {
    const cached = routeCache.get(knownHash);
    if (!cached) throw new RouteUnknownError();
    return cached;
  }
  const routeHash = routeFingerprint(coords);
  const eleSig = elevationSignature(coords);
  const cached = routeCache.get(routeHash);
  if (cached && cached.eleSig === eleSig) return cached;

  const bbox = coordsBbox(coords);
  const chunks = buildChunks(coords, cum, lengthMiles);
  const model = {
    routeHash,
    eleSig,
    coords,
    cum,
    lengthMiles,
    hasElevation,
    bbox,
    paddedBbox: padBbox(bbox, 10),
    chunks,
    sampleCount: chunks.reduce((n, c) => n + c.samplesFine.length, 0),
  };
  routeCache.set(routeHash, model, { ttlMs: ROUTE_TTL_MS });
  return model;
};

/** Samples for forecast lookups: evenly spaced, including both ends of the range. */
export const forecastSamples = (route, startMile, endMile, spacingMiles) =>
  samplePoints(route.coords, route.cum, startMile, endMile, spacingMiles);
