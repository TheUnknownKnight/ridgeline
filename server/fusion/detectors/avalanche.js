import { bboxIntersects } from '../../../shared/geo.js';
import { pointInPolygons, polygonsToGeometry } from '../../lib/spatial.js';
import { chunkElevationRangeM, toIso } from './common.js';
import { ATTRIBUTION, zoneState } from '../../sources/avalanche.js';

// North American danger scale -> app levels. Low is still official guidance,
// so it shows as "low", never as clear.
export const DANGER_LEVEL = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 4 };
const DANGER_NAME = { 1: 'Low', 2: 'Moderate', 3: 'Considerable', 4: 'High', 5: 'Extreme' };
const M_TO_FT = 3.28084;

const fmtUntil = (ms, timeZone) => new Date(ms).toLocaleString('en-US', {
  weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: timeZone || 'UTC', timeZoneName: 'short',
});

/** Summarize route terrain intersected by a single avalanche zone (never weakens official ratings). */
const summarizeZoneTerrain = (touchedChunks, terrainPoints) => {
  if (!touchedChunks.length) return null;
  let minM = Infinity;
  let maxM = -Infinity;
  let steepMiles = 0;
  let maxSlopeDeg = 0;
  for (const chunk of touchedChunks) {
    const r = chunkElevationRangeM(chunk, terrainPoints);
    if (r) {
      if (r.minM < minM) minM = r.minM;
      if (r.maxM > maxM) maxM = r.maxM;
    }
    if (Array.isArray(terrainPoints)) {
      for (const t of terrainPoints) {
        if ((t.mileTo ?? t.mile) < chunk.start || (t.mileFrom ?? t.mile) > chunk.end) continue;
        if (t.slopeDeg != null) {
          maxSlopeDeg = Math.max(maxSlopeDeg, t.slopeDeg);
          if (t.slopeDeg >= 25) {
            const overlap = Math.min(chunk.end, t.mileTo ?? t.mile) - Math.max(chunk.start, t.mileFrom ?? t.mile);
            if (overlap > 0) steepMiles += overlap;
          }
        }
      }
    }
  }
  const hasElev = Number.isFinite(minM);
  const hasSlope = Array.isArray(terrainPoints) && terrainPoints.some(t => t.slopeDeg != null);
  if (!hasElev && !hasSlope) return null;
  return {
    elevationFt: hasElev ? [Math.round(minM * M_TO_FT), Math.round(maxM * M_TO_FT)] : null,
    steepMiles: Math.round(steepMiles * 10) / 10,
    maxSlopeDeg: maxSlopeDeg > 0 ? Math.round(maxSlopeDeg) : null,
  };
};

/**
 * Returns hits for rated zones plus `coverage`: zones on the route that have
 * no usable rating right now (off-season, expired, no forecast) so the UI can
 * say "not rated" instead of implying "safe".
 */
export const detectAvalanche = (route, data, { now = Date.now(), terrainPoints = null } = {}) => {
  const hazards = [];
  const hits = [];
  const overlays = [];
  const unrated = new Map(); // zone id -> { zone, state, firstMile }
  // In-season zones with no usable rating: avalanche danger is unknown there, not "clear".
  const uncheckedChunks = new Set();

  for (const zone of data?.zones || []) {
    if (!bboxIntersects(zone.bbox, route.paddedBbox)) continue;
    const state = zoneState(zone, now);
    const scale = Math.min(5, Math.max(zone.warning ? 4 : 0, zone.dangerLevel));
    const level = state === 'rated' ? DANGER_LEVEL[scale] || 0 : 0;
    const id = `avy:${zone.id}`;
    const touchedChunks = [];
    for (const chunk of route.chunks) {
      if (!bboxIntersects(chunk.bbox, zone.bbox)) continue;
      const inside = chunk.samplesFine.some(s => pointInPolygons(s.lon, s.lat, zone.polygons));
      if (!inside) continue;
      touchedChunks.push(chunk);
      if (level) {
        hits.push({ chunk: chunk.i, id, level, note: `${DANGER_NAME[scale]} (${scale}/5)` });
        continue;
      }
      if (!unrated.has(zone.id)) unrated.set(zone.id, { zone, state, firstMile: chunk.start });
      if (state === 'expired' || state === 'no-forecast' || state === 'no-rating') uncheckedChunks.add(chunk.i);
    }
    if (!touchedChunks.length) continue;

    overlays.push({
      type: 'Feature',
      geometry: polygonsToGeometry(zone.polygons),
      properties: {
        overlay: 'avalanche-zone', hazardId: level ? id : null, level, title: `${zone.name} — ${zone.center}`,
        dangerLevel: state === 'rated' ? scale : -1,
      },
    });
    if (!level) continue;

    const terrainContext = summarizeZoneTerrain(touchedChunks, terrainPoints);
    const until = zone.endsAt ? `valid until ${fmtUntil(zone.endsAt, zone.timeZone)}` : null;
    const terrainNote = terrainContext?.steepMiles > 0
      ? `${terrainContext.steepMiles} mi >=25 deg slope${terrainContext.elevationFt ? ` (${terrainContext.elevationFt[0]}–${terrainContext.elevationFt[1]} ft)` : ''}`
      : (terrainContext?.elevationFt ? `route ${terrainContext.elevationFt[0]}–${terrainContext.elevationFt[1]} ft` : null);
    hazards.push({
      id,
      type: 'avalanche',
      kind: 'avalanche-zone',
      source: 'OFFICIAL',
      title: `${zone.warning ? 'Avalanche Warning — ' : ''}Avalanche danger ${DANGER_NAME[scale]} (${scale}/5): ${zone.name}`,
      detail: [zone.center, until, 'highest rating across elevation bands', terrainNote].filter(Boolean).join(' · '),
      advice: zone.travelAdvice || 'Read the full forecast before entering avalanche terrain.',
      terrainContext,
      attribution: ATTRIBUTION,
      url: zone.link,
      issuedAt: toIso(zone.startsAt),
      expiresAt: toIso(zone.endsAt),
    });
  }

  const coverage = [...unrated.values()].map(({ zone, state, firstMile }) => ({
    zone: zone.name, center: zone.center, state, firstMile, link: zone.link,
  }));
  // A chunk covered by a rated zone elsewhere (overlapping zones) is still checked.
  for (const h of hits) uncheckedChunks.delete(h.chunk);
  return { hazards, hits, overlays, coverage, uncheckedChunks };
};
