import { bboxIntersects } from '../../../shared/geo.js';
import { pointInPolygons, polygonsToGeometry } from '../../lib/spatial.js';
import { toIso } from './common.js';
import { ATTRIBUTION, zoneState } from '../../sources/avalanche.js';

// North American danger scale -> app levels. Low is still official guidance,
// so it shows as "low", never as clear.
export const DANGER_LEVEL = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 4 };
const DANGER_NAME = { 1: 'Low', 2: 'Moderate', 3: 'Considerable', 4: 'High', 5: 'Extreme' };

const fmtUntil = (ms, timeZone) => new Date(ms).toLocaleString('en-US', {
  weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: timeZone || 'UTC', timeZoneName: 'short',
});

/**
 * Returns hits for rated zones plus `coverage`: zones on the route that have
 * no usable rating right now (off-season, expired, no forecast) so the UI can
 * say "not rated" instead of implying "safe".
 */
export const detectAvalanche = (route, data, { now = Date.now() } = {}) => {
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
    let touched = false;
    for (const chunk of route.chunks) {
      if (!bboxIntersects(chunk.bbox, zone.bbox)) continue;
      const inside = chunk.samplesCoarse.some(s => pointInPolygons(s.lon, s.lat, zone.polygons));
      if (!inside) continue;
      touched = true;
      if (level) {
        hits.push({ chunk: chunk.i, id, level, note: `${DANGER_NAME[scale]} (${scale}/5)` });
        continue;
      }
      if (!unrated.has(zone.id)) unrated.set(zone.id, { zone, state, firstMile: chunk.start });
      if (state === 'expired' || state === 'no-forecast' || state === 'no-rating') uncheckedChunks.add(chunk.i);
    }
    if (!touched) continue;

    overlays.push({
      type: 'Feature',
      geometry: polygonsToGeometry(zone.polygons),
      properties: {
        overlay: 'avalanche-zone', hazardId: level ? id : null, level, title: `${zone.name} — ${zone.center}`,
        dangerLevel: state === 'rated' ? scale : -1,
      },
    });
    if (!level) continue;

    const until = zone.endsAt ? `valid until ${fmtUntil(zone.endsAt, zone.timeZone)}` : null;
    hazards.push({
      id,
      type: 'avalanche',
      kind: 'avalanche-zone',
      source: 'OFFICIAL',
      title: `${zone.warning ? 'Avalanche Warning — ' : ''}Avalanche danger ${DANGER_NAME[scale]} (${scale}/5): ${zone.name}`,
      detail: [zone.center, until, 'highest rating across elevation bands'].filter(Boolean).join(' · '),
      advice: zone.travelAdvice || 'Read the full forecast before entering avalanche terrain.',
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
