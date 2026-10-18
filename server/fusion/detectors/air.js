import { bboxIntersects, padBbox, pointInBbox } from '../../../shared/geo.js';
import { pointInPolygons, polygonsToGeometry } from '../../lib/spatial.js';
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
// Monitors drawn on the map.
const MONITOR_MAP_MILES = 15;
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

const monitorLine = (m, distance, timeZone) =>
  `${m.name}${m.agency && !m.name.includes(m.agency) ? ` (${m.agency})` : ''}, ${fmtMiles(distance)} mi from the trail: AQI ${Math.round(m.aqi)}${m.at ? ` ${m.carried ? 'last reading' : 'at'} ${fmtTime(m.at, timeZone)}` : ''}`;

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

export const detectAir = (route, data, { timeZone, now = Date.now() } = {}) => {
  const hits = [];
  const overlays = [];
  const checkedChunks = new Set();
  const contours = (data?.contours || []).filter(c => c.bbox && bboxIntersects(c.bbox, route.paddedBbox));

  // 1. Contours: the category each stretch sits in.
  let worst = null; // { level, category, mile, by }
  const crossed = new Set(); // contours the trail passes through at an unhealthy level
  for (const chunk of route.chunks) {
    let category = 0;
    let at = null;
    for (const s of chunk.samplesCoarse) {
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
    if (!worst || level > worst.level) worst = { level, category, mile: at.mile, by: 'area' };
  }

  // 2. Monitors by the trail: a reading this close covers the stretch, good or bad.
  const near = padBbox(route.bbox || route.paddedBbox, MONITOR_NOTE_MILES);
  let nearest = null; // { monitor, distance, atMile }
  for (const m of data?.monitors || []) {
    if (m.aqi == null || !pointInBbox(m.lon, m.lat, near)) continue;
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
    if (level && onTrail && (!worst || level > worst.level)) {
      worst = { level, category: m.category, mile: closest.atMile, by: 'monitor', monitor: m, distance: closest.distance };
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
      for (const s of chunk.samplesCoarse) {
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

  // 4. Unhealthy areas near the route, for the map; only the ones the trail crosses lead to the hazard.
  for (const c of contours) {
    const level = CATEGORY_LEVEL[c.category];
    if (!level) continue;
    overlays.push({
      type: 'Feature',
      geometry: polygonsToGeometry(c.polygons),
      properties: {
        overlay: 'air-area', hazardId: worst && crossed.has(c) ? AIR_ID : null, level, category: c.category,
        levelLabel: aqiLabel(c.category), title: `Air quality: ${AQI_CATEGORIES[c.category]}`,
      },
    });
  }

  const hazards = [];
  if (worst) {
    const facts = [
      worst.by === 'monitor'
        ? `${AIR_PHRASE[worst.category]} measured at ${monitorLine(worst.monitor, worst.distance, timeZone)}`
        : `${AIR_PHRASE[worst.category]} on AirNow's map near Mi ${Math.round(worst.mile * 10) / 10}`,
    ];
    if (nearest && !(worst.by === 'monitor' && worst.monitor === nearest.monitor)) {
      facts.push(`nearest monitor: ${monitorLine(nearest.monitor, nearest.distance, timeZone)}`);
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
