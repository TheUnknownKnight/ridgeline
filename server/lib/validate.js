import { cumulativeMiles, stripPlaceholderElevation } from '../../shared/geo.js';

export const MAX_POINTS = 50000;
export const MAX_ROUTE_MILES = 5000;
export const LOOKAHEAD_MIN = 5;
export const LOOKAHEAD_MAX = 50;
const HASH_RE = /^[0-9a-f]{16}$/;

export class ValidationError extends Error {
  constructor(message, code = 'invalid_request') {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

const isLon = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;
const isLat = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;

const parseCoordinates = (raw) => {
  if (!Array.isArray(raw)) throw new ValidationError('coordinates must be an array of [lon, lat] points', 'invalid_route');
  if (raw.length < 2) throw new ValidationError('Route needs at least 2 points', 'invalid_route');
  if (raw.length > MAX_POINTS) {
    throw new ValidationError(`Route has ${raw.length} points; the limit is ${MAX_POINTS}`, 'route_too_dense');
  }
  const parsed = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (!Array.isArray(c) || !isLon(c[0]) || !isLat(c[1])) {
      throw new ValidationError(`Invalid coordinate at index ${i}`, 'invalid_route');
    }
    const ele = c[2];
    parsed[i] = typeof ele === 'number' && Number.isFinite(ele) && ele > -500 && ele < 9000 ? [c[0], c[1], ele] : [c[0], c[1]];
  }
  const coords = stripPlaceholderElevation(parsed);
  const hasElevation = coords.some(c => c.length > 2);
  const cum = cumulativeMiles(coords);
  const lengthMiles = cum[cum.length - 1];
  if (!(lengthMiles > 0.05)) throw new ValidationError('Route is too short to analyze', 'invalid_route');
  if (lengthMiles > MAX_ROUTE_MILES) {
    throw new ValidationError(`Route is ${Math.round(lengthMiles)} mi; the limit is ${MAX_ROUTE_MILES} mi`, 'route_too_long');
  }
  return { coords, cum, lengthMiles, hasElevation };
};

const parseLocation = (loc) => {
  if (loc == null) return null;
  if (typeof loc !== 'object') throw new ValidationError('location must be an object', 'invalid_location');
  const { lat, lng, accuracyMeters, lastMile } = loc;
  if (!isLat(lat) || !isLon(lng)) throw new ValidationError('location must have numeric lat and lng', 'invalid_location');
  const out = { lat, lng };
  if (typeof accuracyMeters === 'number' && Number.isFinite(accuracyMeters) && accuracyMeters >= 0) {
    out.accuracyMeters = Math.min(accuracyMeters, 100000);
  }
  // The client's previous on-route mile disambiguates out-and-back/loop routes.
  if (typeof lastMile === 'number' && Number.isFinite(lastMile) && lastMile >= 0 && lastMile <= MAX_ROUTE_MILES) {
    out.lastMile = lastMile;
  }
  return out;
};

/**
 * Strictly validate POST /api/analyze. Returns a clean request object built
 * only from known fields — nothing from the raw body is passed through.
 *
 * A request carries either `coordinates` (full upload) or `routeHash` (a
 * route this server analyzed recently — saves re-uploading on refreshes).
 */
export const validateAnalyzeRequest = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Request body must be a JSON object');

  let route = null;
  let routeHash = null;
  if (body.coordinates != null) {
    route = parseCoordinates(body.coordinates);
  } else if (typeof body.routeHash === 'string' && HASH_RE.test(body.routeHash)) {
    routeHash = body.routeHash;
  } else {
    throw new ValidationError('Send coordinates (or a routeHash from a previous analysis)', 'invalid_route');
  }

  let lookaheadMiles = 15;
  if (body.lookaheadMiles != null) {
    const n = Number(body.lookaheadMiles);
    if (!Number.isFinite(n)) throw new ValidationError('lookaheadMiles must be a number');
    lookaheadMiles = Math.round(Math.min(LOOKAHEAD_MAX, Math.max(LOOKAHEAD_MIN, n)));
  }

  const name = typeof body.name === 'string' ? body.name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120) : '';

  return { ...(route || {}), routeHash, location: parseLocation(body.location), lookaheadMiles, name };
};
