import { haversineMiles, padBbox, bboxIntersects, pointInBbox } from '../../../shared/geo.js';

/**
 * Per-chunk distance from a point to the route (min over fine samples), for
 * every chunk within maxMiles. Returns [{ chunk, distance, atMile }].
 */
export const chunksNearPoint = (route, lon, lat, maxMiles) => {
  const box = padBbox([lon, lat, lon, lat], maxMiles);
  if (!bboxIntersects(route.paddedBbox, box)) return [];
  const out = [];
  for (const c of route.chunks) {
    if (!bboxIntersects(c.bbox, box)) continue;
    let best = Infinity;
    let atMile = c.start;
    for (const s of c.samplesFine) {
      const d = haversineMiles(lon, lat, s.lon, s.lat);
      if (d < best) { best = d; atMile = s.mile; }
    }
    if (best <= maxMiles) out.push({ chunk: c.i, distance: best, atMile });
  }
  return out;
};

/** The single closest chunk to a point, or null if none within maxMiles. */
export const nearestChunk = (route, lon, lat, maxMiles) => {
  let best = null;
  for (const hit of chunksNearPoint(route, lon, lat, maxMiles)) {
    if (!best || hit.distance < best.distance) best = hit;
  }
  return best;
};

export const inRouteArea = (route, lon, lat) => pointInBbox(lon, lat, route.paddedBbox);

export const fmtMiles = (d) => (d < 0.1 ? '<0.1' : d < 10 ? d.toFixed(1) : String(Math.round(d)));

export const fmtAcres = (a) => {
  if (!Number.isFinite(a) || a <= 0) return null;
  if (a < 0.1) return '<0.1 acres';
  return a >= 1000 ? `${Math.round(a).toLocaleString('en-US')} acres` : `${a < 10 ? a.toFixed(1) : Math.round(a)} acres`;
};

/**
 * Index of the sample nearest `mile` that has data, searching outward from
 * the nearest one. Samples must be sorted by mile. Returns -1 if none within maxGap.
 */
export const nearestUsableSample = (samples, hasData, startIdx, mile, maxGap) => {
  let best = -1;
  let bestGap = Infinity;
  for (let k = Math.max(0, startIdx - 2); k <= Math.min(samples.length - 1, startIdx + 2); k++) {
    if (!hasData(k)) continue;
    const gap = Math.abs(samples[k].mile - mile);
    if (gap <= maxGap && gap < bestGap) { best = k; bestGap = gap; }
  }
  return best;
};

/** "Oct 15" in the route's time zone (UTC when unknown). */
export const fmtDate = (ms, timeZone) => {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: timeZone || 'UTC' });
};

export const toIso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
