import { MAX_ESTIMATED_LEVEL } from '../../../shared/levels.js';
import { chunkTimeWindow, nearestChunk, fmtMiles, toIso } from './common.js';
import { ATTRIBUTION } from '../../sources/nwps.js';
import { ATTRIBUTION as CONDITIONS_ATTRIBUTION } from '../conditions.js';
import { safeHttpUrl } from '../../lib/url.js';

// A gauge counts only when it sits essentially on the trail's crossing.
// Big rivers a mile away are usually bridged or irrelevant.
export const GAUGE_MAX_MILES = 0.75;
const FORECAST_HORIZON_MS = 72 * 3600 * 1000;
const PAST_FORECAST_GRACE_MS = 3 * 3600 * 1000;

// Thresholds for ungauged surface runoff (48 h) and snowmelt (24 h) in mm water equivalent.
export const RUNOFF_THRESHOLDS = { runoff48Mm: [25, 55], snowmelt24Mm: [20, 40] };

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
const r1 = (n) => Math.round(n * 10) / 10;

export const detectWater = (route, data, { now = Date.now(), timeZone, trip = null, hydrology = null } = {}) => {
  const hazards = [];
  const hits = [];
  const overlays = [];
  const coveredChunks = new Set();

  for (const g of data?.gauges || []) {
    const near = nearestChunk(route, g.lon, g.lat, GAUGE_MAX_MILES);
    if (near) coveredChunks.add(near.chunk);

    const obsLevel = CATEGORY_LEVEL[g.observed?.category] || 0;
    let fcstLevel = CATEGORY_LEVEL[g.forecast?.category] || 0;
    if (fcstLevel && g.forecast?.time != null && near) {
      const ft = g.forecast.time;
      if (trip) {
        const { fromMs, toMs } = chunkTimeWindow(route.chunks[near.chunk], trip, now);
        if (ft < fromMs - PAST_FORECAST_GRACE_MS || ft > toMs) fcstLevel = 0;
      } else if (ft < now - PAST_FORECAST_GRACE_MS || ft > now + FORECAST_HORIZON_MS) {
        fcstLevel = 0;
      }
    }
    const level = Math.max(obsLevel, fcstLevel);
    if (!level || !near) continue;

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

  // Ungauged snowmelt / rain-on-snow creek surge estimate outside gauged crossings.
  if (Array.isArray(hydrology) && hydrology.length) {
    const byChunk = new Map();
    const id = 'water:runoff';
    let peak = null;

    for (const h of hydrology) {
      const snowmelt24 = h.peakSnowmelt24hMm ?? h.snowmelt24hMm ?? 0;
      const runoff48 = h.peakRunoff48hMm ?? h.runoff48hMm ?? 0;
      const effRunoff = Math.max(runoff48, snowmelt24 * 1.4);
      const rawLevel = (effRunoff >= RUNOFF_THRESHOLDS.runoff48Mm[1] || snowmelt24 >= RUNOFF_THRESHOLDS.snowmelt24Mm[1]) ? 2
        : (effRunoff >= RUNOFF_THRESHOLDS.runoff48Mm[0] || snowmelt24 >= RUNOFF_THRESHOLDS.snowmelt24Mm[0]) ? 1 : 0;
      const level = Math.min(MAX_ESTIMATED_LEVEL, rawLevel);
      if (!level) continue;

      const a = h.mileFrom ?? h.mile;
      const b = h.mileTo ?? h.mile;
      for (let i = Math.max(0, Math.floor(a)); i <= Math.min(route.chunks.length - 1, Math.floor(b)); i++) {
        const c = route.chunks[i];
        if (c.end <= a || c.start >= b || coveredChunks.has(c.i)) continue;
        const prev = byChunk.get(c.i);
        if (!prev || level > prev.level || (level === prev.level && effRunoff > prev.effRunoff)) {
          byChunk.set(c.i, { level, snowmelt24, runoff48, effRunoff, mile: h.mile });
        }
        if (!peak || level > peak.level || (level === peak.level && effRunoff > peak.effRunoff)) {
          peak = { level, snowmelt24, runoff48, effRunoff, mile: h.mile };
        }
      }
    }

    if (byChunk.size > 0 && peak) {
      for (const [chunkIdx, info] of byChunk.entries()) {
        const meltDriver = info.snowmelt24 >= RUNOFF_THRESHOLDS.snowmelt24Mm[0] && info.snowmelt24 * 1.4 >= info.runoff48 * 0.7;
        const note = meltDriver
          ? `~${r1(info.snowmelt24 / 25.4)} in/24h snowmelt runoff`
          : `~${r1(info.effRunoff / 25.4)} in/48h surface runoff`;
        hits.push({ chunk: chunkIdx, id, level: info.level, note });
      }
      const meltLed = peak.snowmelt24 >= RUNOFF_THRESHOLDS.snowmelt24Mm[0] && peak.snowmelt24 * 1.4 >= peak.runoff48 * 0.7;
      const title = meltLed
        ? (peak.level >= 2 ? 'Rapid snowmelt — unbridged creeks may run high' : 'Active snowmelt — afternoon creek rise')
        : (peak.level >= 2 ? 'Heavy runoff — ungauged creeks may run high' : 'Elevated creek runoff likely');
      const driverFact = meltLed
        ? `~${r1(peak.snowmelt24 / 25.4)} in snowmelt over 24 h (${r1(peak.runoff48 / 25.4)} in total 48 h runoff)`
        : `~${r1(peak.runoff48 / 25.4)} in surface runoff over 48 h`;
      hazards.push({
        id,
        type: 'water',
        kind: 'estimated-creek',
        source: 'ESTIMATED',
        title,
        detail: [
          `Peak near Mi ${r1(peak.mile)}: ${driverFact}`,
          'modeled from snowmelt, rain and slope — not a stream gauge reading',
        ].join(' · '),
        advice: 'Expect highest, fastest flows in afternoon on snowmelt creeks and in steep drainages. Cross early and avoid waist-deep fast water.',
        attribution: CONDITIONS_ATTRIBUTION,
        url: null,
        when: null,
      });
    }
  }

  return { hazards, hits, overlays };
};
