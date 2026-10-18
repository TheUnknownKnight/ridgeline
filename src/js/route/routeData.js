import { normalizeCoords, cumulativeMiles, coordsBbox, routeFingerprint } from '../../../shared/geo.js';

/** Max points sent to the server; denser tracks are simplified (≈ <1% length change). */
export const MAX_UPLOAD_POINTS = 20000;

/**
 * The client-side route model. `id` is the same fingerprint the server
 * computes, so refreshes can reference the route by hash instead of
 * re-uploading it.
 *
 * { id, name, coords, cum, lengthMiles, hasElevation, bbox, meta }
 */
export const buildRouteData = (rawCoords, { name = '', meta = {} } = {}) => {
  const coords = normalizeCoords(rawCoords, MAX_UPLOAD_POINTS);
  if (coords.length < 2) throw new Error('This file has no usable track — it needs at least two points.');
  const cum = cumulativeMiles(coords);
  return {
    id: routeFingerprint(coords),
    name: name || 'Untitled route',
    coords,
    cum,
    lengthMiles: cum[cum.length - 1],
    hasElevation: coords.some(c => c.length > 2),
    bbox: coordsBbox(coords),
    meta: { ...meta, uploadedPoints: coords.length },
  };
};

/** Rebuild from the compact form stored in IndexedDB. */
export const routeDataFromStored = (stored) => {
  const cum = cumulativeMiles(stored.coords);
  return {
    id: stored.id,
    name: stored.name,
    coords: stored.coords,
    cum,
    lengthMiles: cum[cum.length - 1],
    hasElevation: stored.coords.some(c => c.length > 2),
    bbox: coordsBbox(stored.coords),
    meta: stored.meta || {},
  };
};
