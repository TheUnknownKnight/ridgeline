import { bboxIntersects } from '../../../shared/geo.js';
import { pointInPolygons, polygonsToGeometry, simplifyPolygons } from '../../lib/spatial.js';
import { chunkTimeWindow, toIso } from './common.js';
import { ATTRIBUTION, isTrailAlert } from '../../sources/nwsAlerts.js';

export const SEVERITY_LEVEL = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 1 };
// Smooth jagged elevation-contour NWS zones for display while keeping full resolution for hit tests.
const ALERT_DISPLAY_SIMPLIFY_MILES = 0.75;

/**
 * Map an NWS alert's severity, event class, and certainty to Ridgeline's 0–4
 * hazard level. Warnings keep full severity; Watches / Possible certainty are
 * capped at Moderate (High for Extreme watches) so 3-day-out watches don't
 * masquerade as imminent Warnings; informational Statements stay Low.
 */
export const alertLevel = (alert) => {
  if (!alert || !isTrailAlert(alert.event)) return 0;
  if (alert.urgency === 'Past' || alert.certainty === 'Unlikely') return 0;
  const base = SEVERITY_LEVEL[alert.severity] ?? 1;
  const ev = String(alert.event || '');
  if (/\b(Statement|Outlook)\b/i.test(ev)) return Math.min(base, 1);
  if (/\bWatch\b/i.test(ev) || alert.certainty === 'Possible') {
    return Math.min(base, alert.severity === 'Extreme' ? 3 : 2);
  }
  return base;
};

const fmtWhen = (ms, timeZone) => new Date(ms).toLocaleString('en-US', {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  timeZone: timeZone || 'UTC', timeZoneName: 'short',
});

// NWSheadline arrives in ALL CAPS; keep acronyms and time zones upper-case.
const sentenceCase = (s) => {
  if (!s) return null;
  const t = String(s).trim();
  if (t !== t.toUpperCase()) return t;
  return t.charAt(0) + t.slice(1).toLowerCase()
    .replace(/\b(nws|pdt|pst|mdt|mst|cdt|cst|edt|est|akdt|akst|hst|utc)\b/g, m => m.toUpperCase());
};

const firstSentence = (text, max = 280) => {
  if (!text) return null;
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max).replace(/\s\S*$/, '')}…` : clean;
};

/** Hit-test one alert segment against the route (and trip ETA if provided). Returns first sample and areas hit. */
const hitSegment = (route, alert, id, level, hits, trip, now) => {
  let first = null;
  const hitAreas = [];
  for (const area of alert.areas) {
    let areaHit = false;
    for (const chunk of route.chunks) {
      if (!bboxIntersects(chunk.bbox, area.bbox)) continue;
      if (trip) {
        const { fromMs, toMs } = chunkTimeWindow(chunk, trip, now);
        if ((alert.end != null && alert.end <= fromMs) || (alert.onset != null && alert.onset >= toMs)) continue;
      }
      const inside = chunk.samplesFine.find(s => pointInPolygons(s.lon, s.lat, area.polygons));
      if (!inside) continue;
      areaHit = true;
      if (!first || inside.mile < first.mile) first = inside;
      hits.push({ chunk: chunk.i, id, level, note: alert.event });
    }
    if (areaHit) hitAreas.push(area);
  }
  return { first, hitAreas };
};

/**
 * One hazard per NWS event (VTEC key). Each zone segment keeps its own text
 * and times; the hazard's wording comes from the segment the hiker meets
 * first, and its timing spans only the segments that touch the route.
 */
export const detectAlerts = (route, data, { now = Date.now(), timeZone, trip = null } = {}) => {
  const hits = [];
  const overlays = [];
  const groups = new Map(); // id -> [{ alert, first, level }]
  const emittedForHazard = new Set(); // `${id}|${area.key}`
  const primaryByZone = new Map(); // area.key -> highest-severity overlay feature

  for (const alert of data?.alerts || []) {
    if (alert.end && alert.end <= now) continue;
    const level = alertLevel(alert);
    if (!level) continue;
    const id = `alert:${alert.key}`;
    const { first, hitAreas } = hitSegment(route, alert, id, level, hits, trip, now);
    if (!first) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push({ alert, first, level });
    for (const area of hitAreas) {
      if (area.key) {
        const dedupeKey = `${id}|${area.key}`;
        if (emittedForHazard.has(dedupeKey)) continue;
        emittedForHazard.add(dedupeKey);
      }
      const display = simplifyPolygons(area.polygons, ALERT_DISPLAY_SIMPLIFY_MILES);
      const feature = {
        type: 'Feature',
        geometry: polygonsToGeometry(display.length ? display : area.polygons),
        properties: { overlay: 'alert-area', hazardId: id, level, title: alert.event, primary: true },
      };
      if (area.key) {
        const prev = primaryByZone.get(area.key);
        if (!prev) {
          primaryByZone.set(area.key, feature);
        } else if (level > prev.properties.level) {
          prev.properties.primary = false;
          primaryByZone.set(area.key, feature);
        } else {
          feature.properties.primary = false;
        }
      }
      overlays.push(feature);
    }
  }

  const hazards = [];
  for (const [id, segments] of groups) {
    const lead = segments.reduce((a, b) => (b.first.mile < a.first.mile ? b : a));
    const onsets = segments.map(s => s.alert.onset).filter(Boolean);
    const ends = segments.map(s => s.alert.end).filter(Boolean);
    const onset = onsets.length ? Math.min(...onsets) : null;
    const end = ends.length ? Math.max(...ends) : null;
    const upcoming = onset && onset > now;
    const otherEnd = end && lead.alert.end && end > lead.alert.end;
    const a = lead.alert;
    hazards.push({
      id,
      type: 'alert',
      kind: 'nws-alert',
      source: 'OFFICIAL',
      title: a.event,
      detail: [
        sentenceCase(a.summary),
        // `headline` already reads "… issued <time> until <time> by NWS <office>" in local time.
        a.headline || (a.end ? `until ${fmtWhen(a.end, timeZone)}` : null),
        upcoming ? `begins ${fmtWhen(onset, timeZone)}` : null,
        otherEnd ? `later on the route until ${fmtWhen(end, timeZone)}` : null,
      ].filter(Boolean).join(' · '),
      advice: firstSentence(a.instruction) || firstSentence(a.description),
      description: a.description,
      severity: a.severity,
      certainty: a.certainty,
      urgency: a.urgency,
      attribution: ATTRIBUTION,
      url: `https://forecast.weather.gov/MapClick.php?lat=${lead.first.lat.toFixed(4)}&lon=${lead.first.lon.toFixed(4)}`,
      issuedAt: toIso(a.sent),
      when: upcoming ? toIso(onset) : null,
      expiresAt: toIso(end),
    });
  }
  return { hazards, hits, overlays };
};
