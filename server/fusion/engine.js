import bbox from '@turf/bbox';

import length from '@turf/length';
import along from '@turf/along';
import lineChunk from '@turf/line-chunk';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import distance from '@turf/distance';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import lineSlice from '@turf/line-slice';
import { getNWSForecast } from '../sources/nws.js';
import { getFires } from '../sources/nifc.js';
import { getAvalancheMap } from '../sources/avalanche.js';
import { saveFusionState } from '../fusion/differ.js';

export const runFusion = async (routeGeoJSON, routeId, location = null, lookaheadMiles = 15) => {
  const lines = routeGeoJSON.features.filter(
    f => f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString'
  );
  if (lines.length === 0) throw new Error('No valid route lines found');

  const mainLine = lines[0];
  const routeBbox = bbox(mainLine);
  // Pad bounding box by roughly 8km (0.08 degrees) to catch nearby fires, avoiding expensive buffer on massive GPX
  routeBbox[0] -= 0.08;
  routeBbox[1] -= 0.08;
  routeBbox[2] += 0.08;
  routeBbox[3] += 0.08;
  const bboxStr = routeBbox.join(',');

  const [firesData, avyData] = await Promise.all([
    getFires(bboxStr).catch(e => { console.error('Fire fetch error:', e.message); return { type: 'FeatureCollection', features: [] }; }),
    getAvalancheMap().catch(e => { console.error('Avy fetch error:', e.message); return { type: 'FeatureCollection', features: [] }; })
  ]);

  const routeLength = length(mainLine, { units: 'miles' });
  
  let windowStart = 0;
  let windowEnd = routeLength;
  let currentMileMarker = null;

  if (location && typeof location.lat === 'number' && typeof location.lng === 'number') {
    const userPt = { type: 'Point', coordinates: [location.lng, location.lat] };
    const nearestPt = nearestPointOnLine(mainLine, userPt, { units: 'miles' });
    currentMileMarker = nearestPt.properties.location;
    windowStart = Math.max(0, currentMileMarker - 2);
    windowEnd = Math.min(routeLength, currentMileMarker + lookaheadMiles);
  }

  // D5 — Reduce sampled points density:
  // On-Trail mode: only sample within [windowStart - 5, windowEnd + 5]
  // Planning mode: increase sampling interval from 3 miles to 5 miles
  const sampledPoints = [];
  if (location) {
    const sampleStart = Math.max(0, windowStart - 5);
    const sampleEnd = Math.min(routeLength, windowEnd + 5);
    for (let m = sampleStart; m <= sampleEnd; m += 3) {
      sampledPoints.push(along(mainLine, m, { units: 'miles' }));
    }
  } else {
    for (let m = 0; m <= routeLength; m += 5) {
      sampledPoints.push(along(mainLine, m, { units: 'miles' }));
    }
  }

  // Filter avy zones to only those near the route
  const avyPreFilterStart = Date.now();
  let avyZonesNearRoute = [];
  if (avyData.features && avyData.features.length > 0) {
    avyZonesNearRoute = avyData.features.filter(zone => {
      if (!zone.geometry) return false;
      try {
        // Check if any of our pre-computed points fall in the zone
        for (const pt of sampledPoints) {
          const [lon, lat] = pt.geometry.coordinates;
          if (zone.bbox) {
            if (lon < zone.bbox[0] || lon > zone.bbox[2] || lat < zone.bbox[1] || lat > zone.bbox[3]) {
              continue;
            }
          }
          if (booleanPointInPolygon(pt, zone)) return true;
        }
        return false;
      } catch {
        return false;
      }
    });
  }
  const avyPreFilterTime = Date.now() - avyPreFilterStart;
  console.log(`[INSTRUMENTATION] avyZonesNearRoute pre-filter took ${avyPreFilterTime} ms`);

  // Sample 3 weather points within the lookahead window
  const weatherSampleMiles = [windowStart, windowStart + (windowEnd - windowStart) / 2, windowEnd].filter(m => m <= routeLength);

  // D1 — Parallelize weather fetches with Promise.allSettled
  const weatherSettled = await Promise.allSettled(
    weatherSampleMiles.map(async (mile) => {
      const pt = along(mainLine, mile, { units: 'miles' });
      const [lon, lat] = pt.geometry.coordinates;
      const forecast = await getNWSForecast(lat, lon);
      return { point: pt, forecast, mile };
    })
  );
  const weatherResults = weatherSettled
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
  // Log any failed weather fetches
  weatherSettled.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`Weather fetch failed for mile ${weatherSampleMiles[i]}:`, r.reason?.message || r.reason);
    }
  });

  // D4 — Pre-filter fire features by bbox:
  // The bounding boxes are pre-computed in nifc.js at cache-time
  const fireFeaturesWithBbox = (firesData.features || []).map(fire => ({
    feature: fire,
    bbox: fire.bbox || (fire.geometry ? bbox(fire) : null)
  }));

  // D3 — Score only within the window:
  // In On-Trail mode, slice the mainLine to the lookahead window and only
  // chunk + score that portion. A separate "override scan" uses a lightweight
  // bbox check of fire/avy features against the full route bbox.
  // In Planning mode, score the full route as before.
  let lineToScore;
  let chunkMileOffset = 0;
  if (location) {
    // Extract the window portion of mainLine using lineSlice
    const startPt = along(mainLine, windowStart, { units: 'miles' });
    const endPt = along(mainLine, windowEnd, { units: 'miles' });
    lineToScore = lineSlice(startPt, endPt, mainLine);
    chunkMileOffset = windowStart;
  } else {
    lineToScore = mainLine;
    chunkMileOffset = 0;
  }

  // Chunk the route (or sliced portion) into 1-mile segments
  const chunks = lineChunk(lineToScore, 1, { units: 'miles' });

  // Adjust mile markers for the offset
  chunks.features.forEach((segment, idx) => {
    segment.properties = segment.properties || {};
    segment.properties.mileStart = Math.floor(chunkMileOffset) + idx;
    segment.properties.mileEnd = Math.floor(chunkMileOffset) + idx + 1;
    segment.properties.hazards = [];
    segment.properties.status = 'clear';
  });

  // D3 — Override scan: In On-Trail mode, also create segments for fire/avy
  // hazards outside the window by checking the full route bbox
  let overrideSegments = [];
  if (location) {
    // Chunk the full route to find segments with severe hazards outside the window
    const fullChunks = lineChunk(mainLine, 1, { units: 'miles' });
    for (let idx = 0; idx < fullChunks.features.length; idx++) {
      const mileStart = idx;
      const mileEnd = idx + 1;
      // Skip segments already within the window (we already have them)
      if (mileEnd >= windowStart && mileStart <= windowEnd) continue;

      const segment = fullChunks.features[idx];
      segment.properties = segment.properties || {};
      segment.properties.mileStart = mileStart;
      segment.properties.mileEnd = mileEnd;
      segment.properties.hazards = [];
      segment.properties.status = 'clear';

      let midpoint;
      try {
        const segLen = length(segment, { units: 'miles' });
        midpoint = along(segment, Math.min(0.5, segLen), { units: 'miles' });
      } catch {
        continue;
      }

      const [midLon, midLat] = midpoint.geometry.coordinates;

      // Only check fires (lightweight bbox pre-filter)
      for (const { feature: fire, bbox: fireBbox } of fireFeaturesWithBbox) {
        if (!fire.geometry || !fireBbox) continue;
        // D4 — Fast bbox guard
        if (midLon < fireBbox[0] || midLon > fireBbox[2] || midLat < fireBbox[1] || midLat > fireBbox[3]) continue;
        try {
          if (booleanPointInPolygon(midpoint, fire)) {
            let typePrefix = "Active Fire";
            const cat = fire.properties?.attr_IncidentTypeCategory;
            if (cat === 'RX') typePrefix = "Prescribed Burn in Progress";
            else if (cat === 'CX') typePrefix = "Incident Complex";
            else if (cat === 'WF') typePrefix = "Active Wildfire";

            segment.properties.hazards.push({
              type: 'fire',
              source: 'OFFICIAL',
              label: `${typePrefix}: ${fire.properties?.poly_IncidentName || fire.properties?.IncidentName || 'Unknown'}`,
              detail: `${Math.round(fire.properties?.poly_GISAcres || fire.properties?.GISAcres || 0)} acres, ${fire.properties?.attr_PercentContained || '?'}% contained`
            });
            segment.properties.status = 'danger-severe';
            break;
          }
        } catch {}
      }

      // Only check severe avy zones
      for (const zone of avyZonesNearRoute) {
        if (zone.bbox) {
          if (midLon < zone.bbox[0] || midLon > zone.bbox[2] || midLat < zone.bbox[1] || midLat > zone.bbox[3]) continue;
        }
        try {
          if (booleanPointInPolygon(midpoint, zone)) {
            const dangerLevel = zone.properties?.danger_level ?? 0;
            if (dangerLevel >= 3) {
              segment.properties.hazards.push({
                type: 'avalanche',
                source: 'OFFICIAL',
                label: `Avalanche: ${(zone.properties?.danger || 'unknown').toUpperCase()} (Level ${dangerLevel}/5)`,
                detail: zone.properties?.travel_advice || ''
              });
              segment.properties.status = 'danger-severe';
            }
            break;
          }
        } catch {}
      }

      // Only keep this segment if it has override-worthy hazards
      if (segment.properties.hazards.length > 0) {
        overrideSegments.push(segment);
      }
    }
  }

  // Score the windowed (or full) chunks
  let debugFireChecks = 0;
  let debugBboxSkips = 0;
  let debugAvyChecks = 0;
  const loopStartTime = Date.now();

  for (let idx = 0; idx < chunks.features.length; idx++) {
    const segment = chunks.features[idx];
    let midpoint;
    try {
      const segLen = length(segment, { units: 'miles' });
      midpoint = along(segment, Math.min(0.5, segLen), { units: 'miles' });
    } catch {
      return;
    }

    const [midLon, midLat] = midpoint.geometry.coordinates;

    // Fire intersection
    // D4 — Use pre-computed bbox to skip far-away fire polygons
    for (const { feature: fire, bbox: fireBbox } of fireFeaturesWithBbox) {
      if (!fire.geometry || !fireBbox) continue;
      // Fast bbox guard: skip if midpoint is outside the fire's bounding box
      if (midLon < fireBbox[0] || midLon > fireBbox[2] || midLat < fireBbox[1] || midLat > fireBbox[3]) {
        debugBboxSkips++;
        continue;
      }
      debugFireChecks++;
      try {
        if (booleanPointInPolygon(midpoint, fire)) {
          let typePrefix = "Active Fire";
          const cat = fire.properties?.attr_IncidentTypeCategory;
          if (cat === 'RX') typePrefix = "Prescribed Burn in Progress";
          else if (cat === 'CX') typePrefix = "Incident Complex";
          else if (cat === 'WF') typePrefix = "Active Wildfire";

          segment.properties.hazards.push({
            type: 'fire',
            source: 'OFFICIAL',
            label: `${typePrefix}: ${fire.properties?.poly_IncidentName || fire.properties?.IncidentName || 'Unknown'}`,
            detail: `${Math.round(fire.properties?.poly_GISAcres || fire.properties?.GISAcres || 0)} acres, ${fire.properties?.attr_PercentContained || '?'}% contained`
          });
          segment.properties.status = 'danger-severe';
          break;
        }
      } catch {}
    }

    // Avalanche zone intersection
    for (const zone of avyZonesNearRoute) {
      if (zone.bbox) {
        if (midLon < zone.bbox[0] || midLon > zone.bbox[2] || midLat < zone.bbox[1] || midLat > zone.bbox[3]) {
          continue;
        }
      }
      debugAvyChecks++;
      try {
        if (booleanPointInPolygon(midpoint, zone)) {
          const dangerLevel = zone.properties?.danger_level ?? 0;
          if (dangerLevel > 0) {
            segment.properties.hazards.push({
              type: 'avalanche',
              source: 'OFFICIAL',
              label: `Avalanche: ${(zone.properties?.danger || 'unknown').toUpperCase()} (Level ${dangerLevel}/5)`,
              detail: zone.properties?.travel_advice || ''
            });
            if (segment.properties.status !== 'danger-severe') {
              segment.properties.status = dangerLevel >= 3 ? 'danger-severe' : 'danger-moderate';
            }
          }
          break;
        }
      } catch {}
    }

    // Weather / reasoning layer
    if (weatherResults.length > 0) {
      const nearest = weatherResults.reduce((prev, curr) => {
        const dPrev = distance(midpoint, prev.point);
        const dCurr = distance(midpoint, curr.point);
        return dCurr < dPrev ? curr : prev;
      });

      const precip = nearest.forecast?.forecast?.precipitation || [];
      let totalPrecipMm = 0;
      for (const entry of precip.slice(0, 6)) {
        if (entry && typeof entry.value === 'number') {
          totalPrecipMm += entry.value;
        }
      }

      if (totalPrecipMm > 5) {
        segment.properties.hazards.push({
          type: 'mud',
          source: 'ESTIMATED',
          label: totalPrecipMm > 15
            ? 'Likely muddy — elevated creek crossings'
            : 'Possible mud — recent precipitation',
          detail: `${totalPrecipMm.toFixed(1)}mm forecast precip (next 36h)`
        });
        if (segment.properties.status === 'clear') {
          segment.properties.status = 'estimated-warning';
        }
      }

      // Check for active NWS alerts
      const alerts = nearest.forecast?.alerts || [];
      for (const alert of alerts) {
        segment.properties.hazards.push({
          type: 'weather-alert',
          source: 'OFFICIAL',
          label: alert.properties?.headline || alert.properties?.event || 'Weather Alert',
          detail: alert.properties?.description?.slice(0, 200) || ''
        });
        if (segment.properties.status === 'clear' || segment.properties.status === 'estimated-warning') {
          segment.properties.status = 'danger-moderate';
        }
      }
    }
    
    // Yield event loop every 500 chunks to prevent blocking
    if (idx > 0 && idx % 500 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  
  const loopEndTime = Date.now();
  console.log(`[INSTRUMENTATION] Intersection Loop Time: ${loopEndTime - loopStartTime} ms`);
  console.log(`[INSTRUMENTATION] Chunks: ${chunks.features.length}`);
  console.log(`[INSTRUMENTATION] Fire features checked: ${fireFeaturesWithBbox.length}`);
  console.log(`[INSTRUMENTATION] BBox Skips: ${debugBboxSkips}`);
  console.log(`[INSTRUMENTATION] Expensive Fire PointInPolygon checks: ${debugFireChecks}`);
  console.log(`[INSTRUMENTATION] Expensive Avy PointInPolygon checks: ${debugAvyChecks}`);

  // Merge override segments from the full-route scan
  if (overrideSegments.length > 0) {
    chunks.features = chunks.features.concat(overrideSegments);
    // Sort by mileStart so output is ordered
    chunks.features.sort((a, b) => a.properties.mileStart - b.properties.mileStart);
  }

  // Filter chunks to lookahead window + overrides
  chunks.features = chunks.features.filter(segment => {
    const inWindow = segment.properties.mileEnd >= windowStart && segment.properties.mileStart <= windowEnd;
    if (inWindow) return true;
    return segment.properties.hazards.some(h => 
      h.type === 'fire' || 
      h.type === 'weather-alert' || 
      (h.type === 'avalanche' && segment.properties.status === 'danger-severe')
    );
  });

  const result = {
    routeId,
    timestamp: new Date().toISOString(),
    segments: chunks,
    window: { start: windowStart, end: windowEnd, currentMile: currentMileMarker },
    metadata: {
      lengthMiles: routeLength.toFixed(1),
      fireCount: firesData.features?.length || 0,
      avyZonesHit: avyZonesNearRoute.length,
      weatherPoints: weatherResults.length
    }
  };

  // Save state for diffing on next check
  try {
    const previousState = saveFusionState(routeId, result);
    if (previousState) {
      result.diff = computeDiff(previousState, result);
    }
  } catch (e) {
    console.error('Differ save error:', e.message);
  }

  return result;
};

function computeDiff(previous, current) {
  const changes = [];
  const prevSegments = previous.segments || [];
  const currSegments = current.segments.features || [];

  for (const seg of currSegments) {
    const mile = seg.properties.mileStart;
    const prevSeg = prevSegments.find(p => p.mileStart === mile);

    if (!prevSeg) continue;

    // New hazards
    for (const hazard of seg.properties.hazards) {
      const existed = prevSeg.hazards.some(
        h => h.type === hazard.type && h.source === hazard.source
      );
      if (!existed) {
        changes.push({
          type: 'NEW',
          mile,
          hazard
        });
      }
    }

    // Cleared hazards
    for (const prevHazard of prevSeg.hazards) {
      const stillExists = seg.properties.hazards.some(
        h => h.type === prevHazard.type && h.source === prevHazard.source
      );
      if (!stillExists) {
        changes.push({
          type: 'CLEARED',
          mile,
          hazard: prevHazard
        });
      }
    }
  }

  return changes;
}
