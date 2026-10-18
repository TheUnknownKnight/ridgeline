import { MAX_ESTIMATED_LEVEL } from '../../../shared/levels.js';
import { AQ_ATTRIBUTION } from '../../sources/openmeteo.js';
import { ATTRIBUTION as NOAA_ATTRIBUTION } from '../../sources/naqfc.js';
import { nearestUsableSample } from './common.js';

const fmtWhen = (ms, timeZone) => new Date(ms).toLocaleString('en-US', {
  weekday: 'short', hour: 'numeric', timeZone: timeZone || 'UTC', timeZoneName: 'short',
});

// US AQI: 101–150 unhealthy for sensitive groups, 151+ unhealthy for everyone.
export const AQI_THRESHOLDS = [101, 151];

const aqiLabel = (aqi) => (aqi >= 301 ? 'hazardous' : aqi >= 201 ? 'very unhealthy' : aqi >= 151 ? 'unhealthy'
  : aqi >= 101 ? 'unhealthy for sensitive groups' : aqi >= 51 ? 'moderate' : 'good');

export const detectSmoke = (route, smoke, { range, maxGapMiles, timeZone } = {}) => {
  const points = smoke?.points || [];
  const hits = [];
  const checkedChunks = new Set();
  let worst = null;
  let onset = null; // first time any stretch reaches "unhealthy for sensitive groups"
  if (!points.length || !range) return { hazards: [], hits, overlays: [], checkedChunks };

  let j = 0;
  for (const chunk of route.chunks) {
    if (chunk.end < range.start || chunk.start > range.end) continue;
    const mid = (chunk.start + chunk.end) / 2;
    while (j < points.length - 1 && Math.abs(points[j + 1].mile - mid) <= Math.abs(points[j].mile - mid)) j++;
    const k = nearestUsableSample(points, (i) => points[i].aq != null, j, mid, maxGapMiles);
    if (k < 0) continue;
    const p = points[k];
    checkedChunks.add(chunk.i);
    const aqi = p.aq.aqi;
    const level = Math.min(MAX_ESTIMATED_LEVEL, aqi >= AQI_THRESHOLDS[1] ? 2 : aqi >= AQI_THRESHOLDS[0] ? 1 : 0);
    if (!level) continue;
    hits.push({ chunk: chunk.i, id: 'smoke:aqi', level, note: `AQI up to ${Math.round(aqi)}`, value: aqi });
    if (!worst || aqi > worst.aqi) worst = { aqi, at: p.aq.at, point: p, level };
    const from = p.aq.from ?? p.aq.at;
    if (Number.isFinite(from) && (onset == null || from < onset)) onset = from;
  }

  const noaa = worst?.point.aq.model === 'noaa';
  const hazards = worst ? [{
    id: 'smoke:aqi',
    type: 'smoke',
    kind: 'smoke',
    source: 'ESTIMATED',
    title: worst.level >= 2 ? 'Unhealthy air forecast' : 'Air quality forecast: unhealthy for sensitive groups',
    detail: [
      `Forecast AQI up to ${Math.round(worst.aqi)} (${aqiLabel(worst.aqi)}) near Mi ${Math.round(worst.point.mile * 10) / 10}${worst.at ? `, worst around ${fmtWhen(worst.at, timeZone)}` : ''}`,
      noaa && worst.point.aq.pm25 != null ? `PM2.5 about ${worst.point.aq.pm25} µg/m³` : null,
      noaa ? 'NOAA 5 km forecast — smoke right next to a fire can be worse' : 'coarse global model — smoke near active fires can be much worse',
    ].filter(Boolean).join(' · '),
    advice: 'Smoke cuts how hard you can safely push. Check measured air quality on AirNow before you go and plan easier days when it is bad.',
    attribution: noaa ? NOAA_ATTRIBUTION : AQ_ATTRIBUTION,
    url: 'https://fire.airnow.gov/',
    levelLabel: aqiLabel(worst.aqi).replace(/^./, c => c.toUpperCase()),
    when: onset != null ? new Date(onset).toISOString() : worst.at ? new Date(worst.at).toISOString() : null,
  }] : [];

  return { hazards, hits, overlays: [], checkedChunks };
};
