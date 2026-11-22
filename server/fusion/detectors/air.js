import { bboxIntersects, haversineMiles, padBbox, pointInBbox } from '../../../shared/geo.js';
import { distanceToPolygonsMiles, pointInPolygons, polygonsToGeometry } from '../../lib/spatial.js';
import { chunksNearPoint, fmtMiles, toIso } from './common.js';
import { ATTRIBUTION, SOURCE_URL, AQI_CATEGORIES } from '../../sources/airnow.js';
import { ATTRIBUTION as HMS_ATTRIBUTION, SOURCE_URL as HMS_URL } from '../../sources/hms.js';

/**
 * Measured air quality along the route. AirNow contours say what category
 * the air is in; a monitor right by the trail overrides a smoothed contour
 * (fire-camp monitors catch smoke the interpolation flattens) and, good or
 * bad, counts as coverage. Levels follow the AQI categories: sensitive
 * groups → low … hazardous → extreme; the AQI word itself travels with the
 * hazard (levelLabel) so the UI can show the scale hikers know.
 */
export const CATEGORY_LEVEL = [0, 0, 0, 1, 2, 3, 4];
// A monitor this close speaks for the trail itself.
export const MONITOR_HIT_MILES = 3;
// The nearest monitor within this distance is named in the hazard.
const MONITOR_NOTE_MILES = 25;
// Monitors, AirNow contours, and satellite plumes drawn on the map (strictly by
// distance to the trail polyline, never the route's giant rectangular bounding box).
const MONITOR_MAP_MILES = 15;
export const AIR_MAP_MILES = 15;
export const PLUME_MAP_MILES = 25;
// Satellite plumes: drawn for 24 h, but only a recent heavy one is a note on the route.
const PLUME_NOTE_MAX_AGE_MS = 12 * 3600 * 1000;
const PLUME_FRESH_MS = 6 * 3600 * 1000;
const AIR_ID = 'air:pm25';
const PLUME_ID = 'smoke:plume';

const TITLES = {
  1: 'Air quality: unhealthy for sensitive groups',
  2: 'Unhealthy air quality',
  3: 'Very unhealthy air quality',
  4: 'Hazardous air quality',
};

const ADVICE = {
  1: 'Smoke or haze is in the air. People with asthma or heart or lung conditions, children and older adults should take it easier and watch for symptoms.',
  2: 'Everyone may feel it on hard climbs. Shorten the day, slow the pace, and consider a well-fitted N95 mask.',
  3: 'Breathing this air during sustained effort is harmful. Consider changing plans or waiting for the smoke to clear.',
  4: 'Avoid hiking in this smoke. Leave the area or wait it out if you can.',
};

// "<phrase> measured at …" by AQI category.
const AIR_PHRASE = { 3: 'Air unhealthy for sensitive groups', 4: 'Unhealthy air', 5: 'Very unhealthy air', 6: 'Hazardous air' };

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
export const aqiLabel = (category) => (category ? cap(AQI_CATEGORIES[category]) : null);

const fmtTime = (ms, timeZone) => new Date(ms).toLocaleString('en-US', {
  weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: timeZone || 'UTC', timeZoneName: 'short',
});

const monitorLine = (m, distance, timeZone, ref = 'from the trail') =>
  `${m.name}${m.agency && !m.name.includes(m.agency) ? ` (${m.agency})` : ''}, ${fmtMiles(distance)} mi ${ref}: AQI ${Math.round(m.aqi)}${m.at ? ` ${m.carried ? 'last reading' : 'at'} ${fmtTime(m.at, timeZone)}` : ''}`;

const DENSITY_RANK = { light: 1, medium: 2, heavy: 3 };

/**
 * The newest satellite observation over a point: plumes containing it with
 * the latest end time, the densest of those (HMS nests light/medium/heavy
 * within one analysis). A newer light trace replaces yesterday's heavy one;
 * a point no newer analysis covers keeps the older trace, so cloud gaps
 * don't read as clear.
 */
const newestPlumeAt = (plumes, lon, lat) => {
  let best = null;
  for (const p of plumes) {
    if (!pointInBbox(lon, lat, p.bbox) || !pointInPolygons(lon, lat, p.polygons)) continue;
    const end = p.end ?? p.start ?? 0;
    if (!best || end > best.end || (end === best.end && DENSITY_RANK[p.density] > DENSITY_RANK[best.plume.density])) best = { plume: p, end };
  }
  return best?.plume ?? null;
};

const ageText = (ms, now) => {
  const h = Math.round((now - ms) / 3600000);
  return h < 1 ? 'within the hour' : h === 1 ? '1 h ago' : `${h} h ago`;
};

/** True when any point of the trail polyline comes within maxMiles of polygons. */
const polygonsNearRoute = (route, polygons, bbox, maxMiles) => {
  if (!bbox || !polygons?.length) return false;
  const searchBox = padBbox(bbox, maxMiles);
  if (!bboxIntersects(searchBox, route.bbox || route.paddedBbox)) return false;
  for (const chunk of route.chunks) {
    if (!bboxIntersects(chunk.bbox, searchBox)) continue;
    const samples = chunk.samplesCoarse?.length ? chunk.samplesCoarse : chunk.samplesFine;
    const mid = samples[Math.floor(samples.length / 2)];
    if (mid && distanceToPolygonsMiles(mid.lon, mid.lat, polygons) <= maxMiles) return true;
    for (const s of samples) {
      if (distanceToPolygonsMiles(s.lon, s.lat, polygons) <= maxMiles) return true;
    }
  }
  return false;
};

/**
 * True when an Unhealthy+ interpolated contour (category >= 4) is contradicted
 * by >= 2 live ground monitors inside/within 5 mi all reading Good (AQI <= 50),
 * with zero live monitors within 15 mi reading >= 101. Catches residual AirNow
 * interpolation artifacts left behind by a glitched or QA-pulled sensor without
 * touching remote backcountry contours that lack nearby ground monitors.
 */
const isContradictedContour = (contour, liveMonitors) => {
  if (contour.category < 4 || liveMonitors.length < 2) return false;
  const box15 = padBbox(contour.bbox, 15);
  const box5 = padBbox(contour.bbox, 5);
  let goodNear = 0;
  for (const m of liveMonitors) {
    if (!pointInBbox(m.lon, m.lat, box15)) continue;
    const d = distanceToPolygonsMiles(m.lon, m.lat, contour.polygons);
    if (d <= 15 && m.aqi >= 101) return false;
    if (d <= 5 && pointInBbox(m.lon, m.lat, box5) && m.aqi <= 50) goodNear++;
  }
  return goodNear >= 2;
};

export const detectAir = (route, data, { timeZone, now = Date.now() } = {}) => {
  const hits = [];
  const overlays = [];
  const checkedChunks = new Set();
  const allMonitors = (data?.monitors || []).filter(m => m.aqi != null);
  const liveMonitors = allMonitors.filter(m => !m.carried);
  const contours = (data?.contours || [])
    .filter(c => c.bbox && bboxIntersects(c.bbox, route.paddedBbox) && !isContradictedContour(c, liveMonitors));

  // 1. Contours: the category each stretch sits in.
  let worst = null; // { level, category, mile, lon, lat, by }
  const crossed = new Set(); // contours the trail passes through at an unhealthy level
  for (const chunk of route.chunks) {
    let category = 0;
    let at = null;
    for (const s of chunk.samplesFine) {
      for (const c of contours) {
        // Once a stretch is covered, only a worse category can change anything.
        if (c.category <= category || !pointInBbox(s.lon, s.lat, c.bbox) || !pointInPolygons(s.lon, s.lat, c.polygons)) continue;
        category = c.category;
        at = s;
        if (CATEGORY_LEVEL[c.category]) crossed.add(c);
      }
    }
    // Inside any contour (even "good") means AirNow covers this stretch.
    if (!category) continue;
    checkedChunks.add(chunk.i);
    const level = CATEGORY_LEVEL[category] || 0;
    if (!level) continue;
    hits.push({ chunk: chunk.i, id: AIR_ID, level, note: `${AQI_CATEGORIES[category]} on AirNow's map` });
    if (!worst || level > worst.level) worst = { level, category, mile: at.mile, lon: at.lon, lat: at.lat, by: 'area' };
  }

  // 2. Monitors by the trail: a reading this close covers the stretch, good or bad.
  const near = padBbox(route.bbox || route.paddedBbox, MONITOR_NOTE_MILES);
  let nearest = null; // { monitor, distance, atMile } — route-wide closest for source metadata
  for (const m of allMonitors) {
    if (!pointInBbox(m.lon, m.lat, near)) continue;
    const chunks = chunksNearPoint(route, m.lon, m.lat, MONITOR_NOTE_MILES);
    if (!chunks.length) continue;
    const closest = chunks.reduce((a, b) => (b.distance < a.distance ? b : a));
    if (!nearest || closest.distance < nearest.distance) nearest = { monitor: m, distance: closest.distance, atMile: closest.atMile };
    const level = CATEGORY_LEVEL[m.category] || 0;
    const onTrail = closest.distance <= MONITOR_HIT_MILES;
    for (const c of chunks) {
      if (c.distance > MONITOR_HIT_MILES) continue;
      checkedChunks.add(c.chunk);
      if (level) hits.push({ chunk: c.chunk, id: AIR_ID, level, note: `AQI ${Math.round(m.aqi)} at ${m.name}`, distance: c.distance });
    }
    if (level && onTrail && (!worst || level > worst.level || (level === worst.level && (worst.by !== 'monitor' || m.aqi > worst.monitor.aqi)))) {
      worst = { level, category: m.category, mile: closest.atMile, lon: m.lon, lat: m.lat, by: 'monitor', monitor: m, distance: closest.distance };
    }
    if (closest.distance <= MONITOR_MAP_MILES) {
      overlays.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [m.lon, m.lat] },
        properties: {
          overlay: 'air-monitor', hazardId: level && onTrail ? AIR_ID : null, level, category: m.category,
          levelLabel: aqiLabel(m.category), title: `${m.name}: AQI ${Math.round(m.aqi)}${m.carried ? ' (last reading)' : ''}`,
        },
      });
    }
  }

  // 3. Satellite plumes: map context, and a low note where the newest analysis shows heavy smoke over the trail.
  const plumes = (data?.plumes || []).filter(p => p.bbox && bboxIntersects(p.bbox, route.paddedBbox));
  const recent = plumes.filter(p => now - (p.end ?? p.start ?? 0) <= PLUME_NOTE_MAX_AGE_MS);
  let heavyOver = null;
  if (recent.some(p => p.density === 'heavy')) {
    for (const chunk of route.chunks) {
      for (const s of chunk.samplesFine) {
        const p = newestPlumeAt(recent, s.lon, s.lat);
        if (p?.density !== 'heavy') continue;
        const seen = p.end ?? p.start;
        hits.push({ chunk: chunk.i, id: PLUME_ID, level: 1, note: `satellite, seen ${seen ? ageText(seen, now) : 'recently'}` });
        if (!heavyOver || (seen ?? 0) > (heavyOver.seen ?? 0)) heavyOver = { seen, mile: s.mile };
        break;
      }
    }
  }
  for (const p of plumes) {
    if (!polygonsNearRoute(route, p.polygons, p.bbox, PLUME_MAP_MILES)) continue;
    const seen = p.end ?? p.start;
    overlays.push({
      type: 'Feature',
      geometry: polygonsToGeometry(p.polygons),
      properties: {
        overlay: 'smoke-plume', hazardId: null, level: 0, density: p.density,
        start: toIso(p.start), end: toIso(p.end),
        title: `${cap(p.density)} smoke overhead (satellite${seen ? `, ${ageText(seen, now)}` : ''})`,
      },
    });
  }

  // 4. Unhealthy areas within AIR_MAP_MILES of the trail, for the map; only crossed ones lead to the hazard.
  for (const c of contours) {
    const level = CATEGORY_LEVEL[c.category];
    if (!level) continue;
    if (!crossed.has(c) && !polygonsNearRoute(route, c.polygons, c.bbox, AIR_MAP_MILES)) continue;
    const stamp = c.at ? ` (AirNow, ${fmtTime(c.at, timeZone)})` : '';
    overlays.push({
      type: 'Feature',
      geometry: polygonsToGeometry(c.polygons),
      properties: {
        overlay: 'air-area', hazardId: worst && crossed.has(c) ? AIR_ID : null, level, category: c.category,
        levelLabel: aqiLabel(c.category), title: `Air quality: ${AQI_CATEGORIES[c.category]}${stamp}`,
      },
    });
  }

  const hazards = [];
  if (worst) {
    // Cite the monitor nearest to the affected stretch itself, never one hundreds of miles away.
    let nearestToWorst = null;
    if (worst.lon != null && worst.lat != null) {
      for (const m of allMonitors) {
        const d = haversineMiles(m.lon, m.lat, worst.lon, worst.lat);
        if (d <= MONITOR_NOTE_MILES && (!nearestToWorst || d < nearestToWorst.distance)) {
          nearestToWorst = { monitor: m, distance: d };
        }
      }
    }
    const facts = [
      worst.by === 'monitor'
        ? `${AIR_PHRASE[worst.category]} measured at ${monitorLine(worst.monitor, worst.distance, timeZone)}`
        : `${AIR_PHRASE[worst.category]} on AirNow's map near Mi ${Math.round(worst.mile * 10) / 10}`,
    ];
    if (nearestToWorst && !(worst.by === 'monitor' && worst.monitor === nearestToWorst.monitor)) {
      facts.push(`nearest monitor: ${monitorLine(nearestToWorst.monitor, nearestToWorst.distance, timeZone, 'away')}`);
    }
    if (heavyOver) facts.push(`satellite saw heavy smoke over the trail near Mi ${Math.round(heavyOver.mile * 10) / 10}`);
    facts.push('AirNow readings are hourly and smoke shifts with the wind');
    hazards.push({
      id: AIR_ID,
      type: 'smoke',
      kind: 'air-quality',
      source: 'OFFICIAL',
      title: TITLES[worst.level],
      levelLabel: aqiLabel(worst.category),
      detail: facts.join(' · '),
      advice: ADVICE[worst.level],
      attribution: ATTRIBUTION,
      url: SOURCE_URL,
      issuedAt: toIso(data?.validAt),
    });
  }
  if (heavyOver) {
    const old = heavyOver.seen && now - heavyOver.seen > PLUME_FRESH_MS;
    hazards.push({
      id: PLUME_ID,
      type: 'smoke',
      kind: 'smoke-plume',
      source: 'OFFICIAL',
      title: old ? `Heavy smoke seen overhead ${ageText(heavyOver.seen, now)}` : 'Heavy smoke overhead',
      detail: [
        `NOAA analysts traced heavy smoke over the trail near Mi ${Math.round(heavyOver.mile * 10) / 10}`,
        heavyOver.seen ? `last seen ${fmtTime(heavyOver.seen, timeZone)}` : null,
        'satellites see the whole air column — air at ground level can be better or worse',
      ].filter(Boolean).join(' · '),
      advice: 'Expect haze and poor views. Check measured air quality before long or hard days.',
      attribution: HMS_ATTRIBUTION,
      url: HMS_URL,
      issuedAt: toIso(heavyOver.seen),
    });
  }

  return {
    hazards,
    hits,
    overlays,
    checkedChunks,
    nearestMonitor: nearest ? { name: nearest.monitor.name, aqi: Math.round(nearest.monitor.aqi), miles: Math.round(nearest.distance * 10) / 10, atMile: Math.round(nearest.atMile * 10) / 10 } : null,
  };
};
