import { bboxIntersects } from '../../../shared/geo.js';
import { pointInPolygons, polygonsToGeometry } from '../../lib/spatial.js';
import { toIso } from './common.js';
import { ATTRIBUTION } from '../../sources/nwsAlerts.js';

export const SEVERITY_LEVEL = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 1 };

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

/** Hit-test one alert segment against the route. Returns the first sample inside, or null. */
const hitSegment = (route, alert, id, level, hits) => {
  let first = null;
  for (const area of alert.areas) {
    for (const chunk of route.chunks) {
      if (!bboxIntersects(chunk.bbox, area.bbox)) continue;
      const inside = chunk.samplesCoarse.find(s => pointInPolygons(s.lon, s.lat, area.polygons));
      if (!inside) continue;
      if (!first || inside.mile < first.mile) first = inside;
      hits.push({ chunk: chunk.i, id, level, note: alert.event });
    }
  }
  return first;
};

/**
 * One hazard per NWS event (VTEC key). Each zone segment keeps its own text
 * and times; the hazard's wording comes from the segment the hiker meets
 * first, and its timing spans only the segments that touch the route.
 */
export const detectAlerts = (route, data, { now = Date.now(), timeZone } = {}) => {
  const hits = [];
  const overlays = [];
  const groups = new Map(); // id -> [{ alert, first, level }]

  for (const alert of data?.alerts || []) {
    if (alert.end && alert.end <= now) continue;
    const level = SEVERITY_LEVEL[alert.severity] ?? 1;
    const id = `alert:${alert.key}`;
    const first = hitSegment(route, alert, id, level, hits);
    if (!first) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push({ alert, first, level });
    for (const area of alert.areas) {
      overlays.push({
        type: 'Feature',
        geometry: polygonsToGeometry(area.polygons),
        properties: { overlay: 'alert-area', hazardId: id, level, title: alert.event },
      });
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
