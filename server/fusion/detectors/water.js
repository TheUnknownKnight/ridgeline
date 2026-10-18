import { nearestChunk, fmtMiles, toIso } from './common.js';
import { ATTRIBUTION } from '../../sources/nwps.js';
import { safeHttpUrl } from '../../lib/url.js';

// A gauge counts only when it sits essentially on the trail's crossing.
// Big rivers a mile away are usually bridged or irrelevant.
export const GAUGE_MAX_MILES = 0.75;

const CATEGORY_LEVEL = { action: 1, minor: 2, moderate: 3, major: 4 };
const CATEGORY_LABEL = {
  action: 'near flood stage',
  minor: 'minor flooding',
  moderate: 'moderate flooding',
  major: 'major flooding',
};

const fmtTime = (ms, timeZone) => new Date(ms).toLocaleString('en-US', {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  timeZone: timeZone || 'UTC', timeZoneName: 'short',
});

const reading = (r, units) => (r?.value != null ? `${r.value} ${units || ''}`.trim() : null);

export const detectWater = (route, data, { timeZone } = {}) => {
  const hazards = [];
  const hits = [];
  const overlays = [];
  for (const g of data?.gauges || []) {
    const obsLevel = CATEGORY_LEVEL[g.observed?.category] || 0;
    const fcstLevel = CATEGORY_LEVEL[g.forecast?.category] || 0;
    const level = Math.max(obsLevel, fcstLevel);
    if (!level) continue;
    const near = nearestChunk(route, g.lon, g.lat, GAUGE_MAX_MILES);
    if (!near) continue;

    const id = `gauge:${g.id}`;
    const worst = fcstLevel > obsLevel ? g.forecast : g.observed;
    const facts = [];
    if (g.observed) {
      const v = reading(g.observed, g.units);
      facts.push(`Now: ${CATEGORY_LABEL[g.observed.category]}${v ? ` (${v})` : ''}${g.observed.time ? ` at ${fmtTime(g.observed.time, timeZone)}` : ''}`);
    }
    if (fcstLevel > obsLevel) {
      const v = reading(g.forecast, g.units);
      facts.push(`Forecast: ${CATEGORY_LABEL[g.forecast.category]}${v ? ` (${v})` : ''}${g.forecast.time ? ` by ${fmtTime(g.forecast.time, timeZone)}` : ''}`);
    }
    if (g.stages?.flood != null) facts.push(`flood stage ${g.stages.flood} ${g.units || ''}`.trim());
    facts.push(`gauge ${fmtMiles(near.distance)} mi from trail`);

    hazards.push({
      id,
      type: 'water',
      kind: 'river-gauge',
      source: 'OFFICIAL',
      title: `${g.name}: ${CATEGORY_LABEL[worst.category]}${fcstLevel > obsLevel ? ' forecast' : ''}`,
      detail: facts.join(' · '),
      advice: level >= 2
        ? 'Crossings on this stream may be dangerous or impassable. Look for a bridge or wait for the water to drop.'
        : 'Water is running high. Scout crossings carefully; levels peak in the afternoon on snowmelt streams.',
      attribution: ATTRIBUTION,
      url: safeHttpUrl(g.url) || `https://water.noaa.gov/gauges/${encodeURIComponent(g.id.toLowerCase())}`,
      issuedAt: toIso(g.observed?.time ?? null),
      when: fcstLevel > obsLevel ? toIso(g.forecast.time) : null,
    });
    hits.push({ chunk: near.chunk, id, level, distance: near.distance, atMile: near.atMile, note: `gauge ${fmtMiles(near.distance)} mi from trail` });
    overlays.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [g.lon, g.lat] },
      properties: { overlay: 'river-gauge', hazardId: id, level, title: g.name },
    });
  }
  return { hazards, hits, overlays };
};
