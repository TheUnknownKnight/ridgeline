/**
 * Pure client-side math for On-trail & offline operation: remaining distance
 * and elevation gain/loss from the local GPX track, local solar sunrise/sunset
 * with zero network, coordinate formatting for satellite/SOS sharing, route
 * corridor Web Mercator tile planning, and mobile bottom-sheet snap logic.
 */
import { pointAtMile, sliceByMiles } from '../../../shared/geo.js';
import { daylight } from '../../../shared/sun.js';

const M_TO_FT = 3.28084;
const ELEV_DEADBAND_M = 3;
const MAX_MERCATOR_LAT = 85.05112878;

export const MOBILE_SNAPS = ['peek', 'half', 'full'];

/** Remaining distance, percent complete, current elevation, and climb/descent ahead — 100% offline. */
export const computeTrailProgress = (route, mile, gpsFix = null) => {
  if (!route?.coords?.length || !Number.isFinite(mile)) return null;
  const total = route.lengthMiles || 0;
  const clamped = Math.max(0, Math.min(total, mile));
  const milesLeft = Math.max(0, total - clamped);
  const pctComplete = total > 0 ? Math.min(100, Math.max(0, Math.round((clamped / total) * 100))) : 0;

  let currentElevFt = null;
  if (Number.isFinite(gpsFix?.altitudeMeters)) {
    currentElevFt = Math.round(gpsFix.altitudeMeters * M_TO_FT);
  } else if (route.hasElevation) {
    const pt = pointAtMile(route.coords, route.cum, clamped);
    if (pt.length > 2 && Number.isFinite(pt[2])) currentElevFt = Math.round(pt[2] * M_TO_FT);
  }

  let gainAheadFt = null;
  let lossAheadFt = null;
  if (route.hasElevation && milesLeft > 0) {
    const ahead = sliceByMiles(route.coords, route.cum, clamped, total);
    let gainM = 0;
    let lossM = 0;
    let anchor = null;
    for (const c of ahead) {
      if (c.length < 3 || !Number.isFinite(c[2])) continue;
      if (anchor == null) { anchor = c[2]; continue; }
      const d = c[2] - anchor;
      if (d >= ELEV_DEADBAND_M) { gainM += d; anchor = c[2]; }
      else if (d <= -ELEV_DEADBAND_M) { lossM -= d; anchor = c[2]; }
    }
    if (anchor != null) {
      gainAheadFt = Math.round(gainM * M_TO_FT);
      lossAheadFt = Math.round(lossM * M_TO_FT);
    }
  } else if (route.hasElevation) {
    gainAheadFt = 0;
    lossAheadFt = 0;
  }

  return { milesDone: clamped, milesLeft, totalMiles: total, pctComplete, currentElevFt, gainAheadFt, lossAheadFt };
};

/** Local sunrise, sunset, civil dusk, and remaining daylight minutes — computed offline via shared/sun.js. */
export const computeOfflineDaylight = (now, { route = null, mile = null, gpsFix = null } = {}) => {
  let lon = null;
  let lat = null;
  let elevM = 0;
  if (gpsFix && Number.isFinite(gpsFix.lat) && Number.isFinite(gpsFix.lng)) {
    lon = gpsFix.lng;
    lat = gpsFix.lat;
    if (Number.isFinite(gpsFix.altitudeMeters)) elevM = Math.max(0, gpsFix.altitudeMeters);
  } else if (route?.coords?.length) {
    const pt = pointAtMile(route.coords, route.cum, Number.isFinite(mile) ? mile : 0);
    lon = pt[0];
    lat = pt[1];
    if (pt.length > 2 && Number.isFinite(pt[2])) elevM = Math.max(0, pt[2]);
  }
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const d = daylight(now, lon, lat, elevM);
  const target = d.isDaylight ? d.sunset : d.sunrise;
  const remainingMin = target != null && target > now ? Math.max(1, Math.round((target - now) / 60000)) : null;
  return {
    isDaylight: d.isDaylight,
    sunrise: d.sunrise != null ? new Date(d.sunrise).toISOString() : null,
    sunset: d.sunset != null ? new Date(d.sunset).toISOString() : null,
    civilDusk: d.civilDusk != null ? new Date(d.civilDusk).toISOString() : null,
    remainingMin,
  };
};

export const fmtDurationMinutes = (mins) => {
  if (!Number.isFinite(mins) || mins <= 0) return '';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

export const formatCoordsDisplay = (lat, lng) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lng).toFixed(4)}° ${ew}`;
};

export const formatCoordsCopy = (lat, lng, { mile = null, routeName = '' } = {}) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  const base = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  const ctx = [];
  if (Number.isFinite(mile)) ctx.push(`Mile ${mile.toFixed(1)}`);
  if (routeName) ctx.push(routeName);
  return ctx.length ? `${base} (${ctx.join(' on ')})` : base;
};

const lonToTileX = (lon, z) => {
  const n = 2 ** z;
  return Math.max(0, Math.min(n - 1, Math.floor(((lon + 180) / 360) * n)));
};

const latToTileY = (lat, z) => {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const rad = (clamped * Math.PI) / 180;
  const n = 2 ** z;
  return Math.max(0, Math.min(n - 1, Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)));
};

/**
 * Web Mercator { z, x, y } corridor tiles along `coords`, ordered lowest-zoom
 * first so overview tiles are always included before fine zoom detail, capped
 * at `maxTiles` so long thru-hikes never overwhelm phone storage.
 */
export const corridorTilesForRoute = (coords, { zooms = [9, 10, 11, 12, 13], padTiles = 1, maxTiles = 260 } = {}) => {
  if (!Array.isArray(coords) || !coords.length || !(maxTiles > 0)) return [];
  const out = [];
  const seen = new Set();

  for (const z of zooms) {
    if (out.length >= maxTiles) break;
    const n = 2 ** z;
    // Pad 1 tile around low/mid zooms; tighter corridor at high zoom to stay compact.
    const pad = z >= 13 ? 0 : padTiles;
    const addTile = (x, y) => {
      if (x < 0 || x >= n || y < 0 || y >= n) return false;
      const key = `${z}/${x}/${y}`;
      if (seen.has(key)) return false;
      seen.add(key);
      out.push({ z, x, y });
      return out.length >= maxTiles;
    };

    for (let i = 0; i < coords.length; i++) {
      const a = coords[i];
      const x0 = lonToTileX(a[0], z);
      const y0 = latToTileY(a[1], z);
      for (let dx = -pad; dx <= pad; dx++) {
        for (let dy = -pad; dy <= pad; dy++) {
          if (addTile(x0 + dx, y0 + dy)) return out;
        }
      }
      // Step across long sparse segments so intermediate tiles aren't skipped.
      if (i + 1 < coords.length) {
        const b = coords[i + 1];
        const x1 = lonToTileX(b[0], z);
        const y1 = latToTileY(b[1], z);
        const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        if (steps > 1) {
          for (let s = 1; s < steps; s++) {
            const tx = Math.round(x0 + ((x1 - x0) * s) / steps);
            const ty = Math.round(y0 + ((y1 - y0) * s) / steps);
            if (addTile(tx, ty)) return out;
          }
        }
      }
    }
  }
  return out;
};

/** Compute the next mobile bottom-sheet snap state from a drag gesture. */
export const nextMobileSheetSnap = (current, { deltaY = 0, velocityY = 0 } = {}) => {
  const idx = Math.max(0, MOBILE_SNAPS.indexOf(current));
  // Negative deltaY / velocityY = swiped upward (expand); positive = swiped downward (collapse).
  if (velocityY <= -0.45 || deltaY <= -56) return MOBILE_SNAPS[Math.min(MOBILE_SNAPS.length - 1, idx + 1)];
  if (velocityY >= 0.45 || deltaY >= 56) return MOBILE_SNAPS[Math.max(0, idx - 1)];
  return MOBILE_SNAPS[idx];
};
