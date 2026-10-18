import { MAX_ESTIMATED_LEVEL } from '../../../shared/levels.js';
import { ATTRIBUTION as NWS_FORECAST } from '../../sources/nwsForecast.js';
import { PRECIP_ATTRIBUTION } from '../../sources/openmeteo.js';
import { nearestUsableSample } from './common.js';

/**
 * Forecast-derived hazards. These are ESTIMATES (model output turned into a
 * hiker-relevant call) and are capped at MAX_ESTIMATED_LEVEL so they never
 * outrank an official warning.
 */
export const HORIZON_HOURS = 72;
export const THRESHOLDS = {
  gustMph: [30, 45],             // NWS Wind Advisory gusts start at 46 mph; ridges run higher than the grid
  precipIn: [0.5, 1.5],          // past 48 h + next 48 h
  snowIn: [1, 6],                // next 72 h
  heatF: [95, 105],              // apparent temperature
  coldF: [15, 0],                // air temperature, adjusted to trail elevation
  thunderProbPct: [10, 25],
};
const UNCOVERED_REACH_MILES = 1.5;
const STRONG_THUNDER = new Set(['chance', 'likely', 'definite', 'scattered', 'numerous', 'widespread', 'occasional', 'frequent', 'periods']);
const LAPSE_C_PER_KM = 6.5;
// Grid cells are 2.5 km; real trail-vs-cell differences rarely exceed ~1 km.
// Anything beyond this is bad elevation data, so don't adjust at all.
const MAX_LAPSE_GAP_M = 1500;

const HOUR = 3600000;
const cToF = (c) => c * 9 / 5 + 32;
const mmToIn = (mm) => mm / 25.4;
const kmhToMph = (k) => k / 1.609344;

const sumOver = (series, from, to) => {
  let total = 0;
  for (const [s, e, v] of series || []) {
    const overlap = Math.min(e, to) - Math.max(s, from);
    if (overlap > 0 && e > s) total += v * (overlap / (e - s));
  }
  return total;
};

const extremeOver = (series, from, to, pickMax) => {
  let best = null;
  for (const [s, e, v] of series || []) {
    if (e <= from || s >= to) continue;
    if (!best || (pickMax ? v > best.v : v < best.v)) best = { v, at: Math.max(s, from) };
  }
  return best;
};

const firstAtOrAbove = (series, from, to, threshold) => {
  for (const [s, e, v] of series || []) {
    if (e > from && s < to && v >= threshold) return Math.max(s, from);
  }
  return null;
};

const grade = (value, [t1, t2], lowerIsWorse = false) => {
  if (value == null) return 0;
  if (lowerIsWorse) return value <= t2 ? 2 : value <= t1 ? 1 : 0;
  return value >= t2 ? 2 : value >= t1 ? 1 : 0;
};

/** Reduce one forecast point to the numbers the detector grades. */
export const summarizePoint = (point, now, pastPrecip) => {
  const g = point.grid;
  if (!g) return null;
  const end = now + HORIZON_HOURS * HOUR;
  const s = g.series;

  let lapseC = 0;
  const gap = point.ele != null && g.gridElevationM != null ? point.ele - g.gridElevationM : 0;
  if (Math.abs(gap) > 150 && Math.abs(gap) <= MAX_LAPSE_GAP_M) lapseC = (gap / 1000) * LAPSE_C_PER_KM;

  const gust = extremeOver(s.gust, now, end, true);
  const heat = extremeOver(s.apparent, now, end, true);
  const cold = extremeOver(s.temp, now, end, false);
  const thunderProb = extremeOver(s.thunderProb, now, end, true);
  let thunderCoverage = null;
  for (const [st, e, coverage] of s.weather || []) {
    if (e <= now || st >= end) continue;
    const strong = STRONG_THUNDER.has(coverage);
    if (!thunderCoverage || (strong && !thunderCoverage.strong)) thunderCoverage = { coverage, strong, at: Math.max(st, now) };
    if (strong) break;
  }

  const nextPrecipIn = mmToIn(sumOver(s.precip, now, now + 48 * HOUR));
  const pastIn = pastPrecip?.past48hMm != null ? mmToIn(pastPrecip.past48hMm) : null;

  return {
    gustMph: gust ? kmhToMph(gust.v) : null,
    gustAt: gust ? firstAtOrAbove(s.gust, now, end, THRESHOLDS.gustMph[0] * 1.609344) ?? gust.at : null,
    heatF: heat ? cToF(heat.v - lapseC) : null,
    heatAt: heat?.at ?? null,
    coldF: cold ? cToF(cold.v - lapseC) : null,
    coldAt: cold?.at ?? null,
    lapseAdjustedF: lapseC ? -lapseC * 9 / 5 : 0,
    snowIn: mmToIn(sumOver(s.snow, now, end)),
    nextPrecipIn,
    pastPrecipIn: pastIn,
    precipIn: nextPrecipIn + (pastIn || 0),
    thunderProb: thunderProb?.v ?? null,
    thunderAt: thunderCoverage?.at ?? (thunderProb && thunderProb.v >= THRESHOLDS.thunderProbPct[0] ? thunderProb.at : null),
    thunderCoverage: thunderCoverage?.coverage ?? null,
    thunderLevel: Math.max(
      thunderCoverage ? (thunderCoverage.strong ? 2 : 1) : 0,
      grade(thunderProb?.v ?? null, THRESHOLDS.thunderProbPct)),
  };
};

const r0 = (n) => Math.round(n);
const r1 = (n) => Math.round(n * 10) / 10;

const KINDS = {
  thunderstorm: {
    level: (x) => x.thunderLevel,
    value: (x) => x.thunderProb ?? 0,
    note: (x) => (x.thunderCoverage ? `${x.thunderCoverage.replace('_', ' ')} of thunderstorms` : `${r0(x.thunderProb)}% chance of thunder`),
    title: (lvl) => (lvl >= 2 ? 'Thunderstorms forecast' : 'Slight chance of thunderstorms'),
    advice: 'Lightning risk on exposed ridges and summits. Plan to be below treeline by early afternoon.',
    when: (x) => x.thunderAt,
  },
  wind: {
    level: (x) => grade(x.gustMph, THRESHOLDS.gustMph),
    value: (x) => x.gustMph,
    note: (x) => `gusts to ${r0(x.gustMph)} mph`,
    title: (lvl) => (lvl >= 2 ? 'Strong wind gusts forecast' : 'Gusty winds forecast'),
    advice: 'Exposed ridgelines run windier than the forecast grid. Watch for falling trees in burned areas.',
    when: (x) => x.gustAt,
  },
  precip: {
    level: (x) => grade(x.precipIn, THRESHOLDS.precipIn),
    value: (x) => x.precipIn,
    note: (x) => `${r1(x.precipIn)} in rain${x.pastPrecipIn != null ? ` (${r1(x.pastPrecipIn)} past 48 h + ${r1(x.nextPrecipIn)} next 48 h)` : ' next 48 h'}`,
    title: (lvl) => (lvl >= 2 ? 'Heavy rain — creek crossings may run high' : 'Wet trail — possible mud'),
    advice: 'Expect higher, faster creeks in the afternoon. Never cross water above your knees; burn scars can flash-flood.',
    when: () => null,
  },
  snow: {
    level: (x) => grade(x.snowIn, THRESHOLDS.snowIn),
    value: (x) => x.snowIn,
    note: (x) => `${r1(x.snowIn)} in snow next 72 h`,
    title: (lvl) => (lvl >= 2 ? 'Significant snow forecast' : 'Snow forecast'),
    advice: 'Trail may be obscured and icy. Carry traction and navigation; new snow loads avalanche terrain.',
    when: () => null,
  },
  heat: {
    level: (x) => grade(x.heatF, THRESHOLDS.heatF),
    value: (x) => x.heatF,
    note: (x) => `feels like ${r0(x.heatF)}°F`,
    title: (lvl) => (lvl >= 2 ? 'Dangerous heat forecast' : 'Hot conditions forecast'),
    advice: 'Carry extra water, hike early, and rest in shade during the hottest hours.',
    when: (x) => x.heatAt,
  },
  cold: {
    level: (x) => grade(x.coldF, THRESHOLDS.coldF, true),
    value: (x) => (x.coldF == null ? null : -x.coldF),
    note: (x) => `low near ${r0(x.coldF)}°F${x.lapseAdjustedF ? ' (adjusted to trail elevation)' : ''}`,
    title: (lvl) => (lvl >= 2 ? 'Extreme cold forecast' : 'Hard freeze forecast'),
    advice: 'Check that your sleep system and layers are rated for these lows. Water filters can freeze.',
    when: (x) => x.coldAt,
  },
};

/**
 * points: forecast samples (sorted by mile) with grid data; pastPrecip: parallel
 * array from Open-Meteo. Each chunk inside [range.start, range.end] uses the
 * nearest sample within maxGapMiles.
 */
export const detectWeather = (route, forecast, pastPrecip, { now = Date.now(), range, maxGapMiles } = {}) => {
  const points = forecast?.points || [];
  const summaries = points.map((p, i) => summarizePoint(p, now, pastPrecip?.bySample?.[i]));
  const hits = [];
  const checkedChunks = new Set();
  // Chunks whose nearest forecast point is outside NWS coverage (e.g. Canada).
  const uncoveredChunks = new Set();
  const worst = new Map(); // kind -> { level, value, summary, mile, point }
  if (!points.length || !range) return { hazards: [], hits, overlays: [], checkedChunks, uncoveredChunks };

  let j = 0;
  for (const chunk of route.chunks) {
    if (chunk.end < range.start || chunk.start > range.end) continue;
    const mid = (chunk.start + chunk.end) / 2;
    while (j < points.length - 1 && Math.abs(points[j + 1].mile - mid) <= Math.abs(points[j].mile - mid)) j++;
    const k = nearestUsableSample(points, (i) => summaries[i] != null, j, mid, maxGapMiles);
    if (k < 0) {
      // A point NWS won't serve says little about stretches miles away
      // (Planning samples are sparse), so only flag the chunks right beside it.
      if (points[j].reason === 'outside NWS coverage' && Math.abs(points[j].mile - mid) <= UNCOVERED_REACH_MILES) {
        uncoveredChunks.add(chunk.i);
      }
      continue;
    }
    const summary = summaries[k];
    checkedChunks.add(chunk.i);
    for (const [kind, def] of Object.entries(KINDS)) {
      const level = Math.min(MAX_ESTIMATED_LEVEL, def.level(summary));
      if (!level) continue;
      const id = `wx:${kind}`;
      hits.push({ chunk: chunk.i, id, level, note: def.note(summary), value: def.value(summary) ?? 0 });
      const prev = worst.get(kind);
      const value = def.value(summary) ?? 0;
      if (!prev || level > prev.level || (level === prev.level && value > prev.value)) {
        worst.set(kind, { level, value, summary, point: points[k] });
      }
    }
  }

  const hazards = [];
  for (const [kind, w] of worst) {
    const def = KINDS[kind];
    const when = def.when(w.summary);
    const usesPast = kind === 'precip' && w.summary.pastPrecipIn != null;
    hazards.push({
      id: `wx:${kind}`,
      type: 'weather',
      kind,
      source: 'ESTIMATED',
      title: def.title(w.level),
      detail: [
        `Worst near Mi ${r1(w.point.mile)}: ${def.note(w.summary)}`,
        'derived from the NWS gridded forecast',
      ].filter(Boolean).join(' · '),
      advice: def.advice,
      attribution: usesPast ? `${NWS_FORECAST} + ${PRECIP_ATTRIBUTION}` : NWS_FORECAST,
      url: `https://forecast.weather.gov/MapClick.php?lat=${w.point.lat.toFixed(4)}&lon=${w.point.lon.toFixed(4)}`,
      when: when ? new Date(when).toISOString() : null,
    });
  }
  return { hazards, hits, overlays: [], checkedChunks, uncoveredChunks };
};
