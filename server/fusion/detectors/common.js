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

/** Millisecond window [fromMs, toMs] when the hiker is expected in `chunk`, or [now, now + defaultHours]. */
export const chunkTimeWindow = (chunk, trip, now, defaultHours = 72) => {
  const startMs = trip ? Date.parse(trip.startAt) : NaN;
  if (!Number.isFinite(startMs) || !(trip?.paceMilesPerDay > 0)) {
    return { fromMs: now, toMs: now + defaultHours * 3600000 };
  }
  const dayMs = 24 * 3600000;
  const fromMs = startMs + (chunk.start / trip.paceMilesPerDay) * dayMs;
  const endMs = startMs + (chunk.end / trip.paceMilesPerDay) * dayMs;
  return { fromMs, toMs: Math.max(fromMs + 12 * 3600000, endMs) };
};

/** Min/max elevation (meters) in a 1-mile chunk from track <ele> or terrain points. */
export const chunkElevationRangeM = (chunk, terrainPoints, fallbackM = null) => {
  let minM = Infinity;
  let maxM = -Infinity;
  for (const s of chunk.samplesFine || []) {
    if (Number.isFinite(s.ele)) {
      if (s.ele < minM) minM = s.ele;
      if (s.ele > maxM) maxM = s.ele;
    }
  }
  if (!Number.isFinite(minM) && Array.isArray(terrainPoints) && terrainPoints.length) {
    let lo = 0, hi = terrainPoints.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((terrainPoints[mid].mileTo ?? terrainPoints[mid].mile) < chunk.start) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < terrainPoints.length; k++) {
      const t = terrainPoints[k];
      if ((t.mileFrom ?? t.mile) > chunk.end) break;
      if (t.elevM == null) continue;
      if (t.elevM < minM) minM = t.elevM;
      if (t.elevM > maxM) maxM = t.elevM;
    }
  }
  if (!Number.isFinite(minM)) return Number.isFinite(fallbackM) ? { minM: fallbackM, maxM: fallbackM } : null;
  return { minM, maxM };
};

/** "Oct 15" in the route's time zone (UTC when unknown). */
export const fmtDate = (ms, timeZone) => {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: timeZone || 'UTC' });
};

export const toIso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
