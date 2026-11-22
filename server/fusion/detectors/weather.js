import { MAX_ESTIMATED_LEVEL } from '../../../shared/levels.js';
import { ATTRIBUTION as NWS_FORECAST } from '../../sources/nwsForecast.js';
import { PRECIP_ATTRIBUTION } from '../../sources/openmeteo.js';
import { chunkElevationRangeM, chunkTimeWindow, nearestUsableSample } from './common.js';

/**
 * Forecast-derived hazards. These are ESTIMATES (model output turned into a
 * hiker-relevant call) and are capped at MAX_ESTIMATED_LEVEL so they never
 * outrank an official warning.
 */
export const HORIZON_HOURS = 72;
export const MAX_GRID_HOURS = 168;
export const THRESHOLDS = {
  gustMph: [30, 45],             // NWS Wind Advisory gusts start at 46 mph; ridges run higher than the grid
  precipIn: [0.5, 1.5],          // past 48 h + next 48 h (liquid rain only)
  snowIn: [1, 6],                // next 72 h (or itinerary pass)
  iceIn: [0.05, 0.25],           // freezing rain / ice accretion (in)
  heatF: [95, 105],              // apparent temperature
  coldF: [15, 0],                // air temperature or wind chill, adjusted to trail elevation
  thunderProbPct: [15, 35],      // NWS official Slight Chance starts at 15%; solid Chance at 35%
};
const UNCOVERED_REACH_MILES = 1.5;
const STRONG_THUNDER = new Set(['chance', 'likely', 'definite', 'scattered', 'numerous', 'widespread', 'occasional', 'frequent', 'periods']);
const FREEZING_PRECIP = new Set(['freezing_rain', 'freezing_drizzle', 'sleet', 'ice_pellets']);
const LAPSE_C_PER_KM = 6.5;
// Grid cells are 2.5 km; real trail-vs-cell differences rarely exceed ~1 km.
// Anything beyond this is bad elevation data, so don't adjust at all.
const MAX_LAPSE_GAP_M = 1500;

const HOUR = 3600000;
const cToF = (c) => c * 9 / 5 + 32;
const mmToIn = (mm) => mm / 25.4;
const kmhToMph = (k) => k / 1.609344;

const lapseFor = (targetElevM, gridElevationM) => {
  if (targetElevM == null || gridElevationM == null) return 0;
  const gap = targetElevM - gridElevationM;
  return Math.abs(gap) > 150 && Math.abs(gap) <= MAX_LAPSE_GAP_M ? (gap / 1000) * LAPSE_C_PER_KM : 0;
};

/** Official NWS wind chill (°C) given air temp (°C) and wind speed (km/h). */
const nwsWindChillC = (tempC, windKmh) => {
  if (tempC == null || windKmh == null || tempC > 10 || windKmh < 4.8) return tempC;
  const v16 = Math.pow(windKmh, 0.16);
  return 13.12 + 0.6215 * tempC - 11.37 * v16 + 0.3965 * tempC * v16;
};

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

/** Latest forecast timestamp present in any grid series. */
const gridHorizonMs = (grid) => {
  let maxMs = null;
  for (const arr of Object.values(grid?.series || {})) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (Number.isFinite(item?.[1]) && (maxMs == null || item[1] > maxMs)) maxMs = item[1];
    }
  }
  return maxMs;
};

/** Snow fraction (0..1) given trail elevation and NWS snow level (m). */
const snowLevelFrac = (trailElevM, slM) => {
  if (trailElevM >= slM) return 1;
  if (trailElevM <= slM - 150) return 0;
  return (trailElevM - (slM - 150)) / 150;
};

/**
 * Estimate additional snow depth (mm) when high trail exceeds NWS grid snowLevel
 * during QPF. Integrates sub-interval by sub-interval so a late cold-front drop
 * at the end of a 6-hour QPF block does not turn earlier warm rain into snow.
 */
const mountainSnowFromSnowLevel = (s, from, to, trailElevM) => {
  if (trailElevM == null || !s.snowLevel?.length || !s.precip?.length) return 0;
  let totalSnowMm = 0;
  for (const [ps, pe, qpfMm] of s.precip) {
    const a = Math.max(ps, from);
    const b = Math.min(pe, to);
    if (b <= a || pe <= ps || qpfMm <= 0) continue;
    const rate = qpfMm / (pe - ps); // mm liquid per ms
    let covered = 0;
    let weightedSnow = 0;
    for (const [sls, sle, slVal] of s.snowLevel) {
      const ov = Math.min(sle, b) - Math.max(sls, a);
      if (ov <= 0) continue;
      covered += ov;
      weightedSnow += ov * snowLevelFrac(trailElevM, slVal);
    }
    if (covered <= 0) continue;
    // Scale the mean snow fraction observed across covered sub-intervals onto the QPF overlap.
    const meanFrac = weightedSnow / covered;
    totalSnowMm += rate * (b - a) * 10 * meanFrac;
  }
  return totalSnowMm;
};

/**
 * Liquid rain total (mm) over [from, to], excluding precipitation that falls as
 * snow at trail elevation so winter snowstorms do not fire "Heavy rain / mud" hazards.
 */
const rainOver = (s, from, to, lapseC, trailElevM) => {
  if (!s.precip?.length) return 0;
  let totalRainMm = 0;
  for (const [ps, pe, qpfMm] of s.precip) {
    const a = Math.max(ps, from);
    const b = Math.min(pe, to);
    if (b <= a || pe <= ps || qpfMm <= 0) continue;
    const spanLiquid = qpfMm * ((b - a) / (pe - ps));

    // 1. Prefer NWS snowLevel when trail elevation is known and snowLevel covers this span.
    if (trailElevM != null && s.snowLevel?.length) {
      let covered = 0;
      let weightedRain = 0;
      for (const [sls, sle, slVal] of s.snowLevel) {
        const ov = Math.min(sle, b) - Math.max(sls, a);
        if (ov <= 0) continue;
        covered += ov;
        weightedRain += ov * (1 - snowLevelFrac(trailElevM, slVal));
      }
      if (covered > 0) {
        totalRainMm += spanLiquid * (weightedRain / covered);
        continue;
      }
    }

    // 2. Otherwise partition using overlapping lapsed air temperature (0 °C = snow, >= 2 °C = rain).
    if (s.temp?.length) {
      let covered = 0;
      let weightedRain = 0;
      for (const [ts, te, rawT] of s.temp) {
        const ov = Math.min(te, b) - Math.max(ts, a);
        if (ov <= 0) continue;
        const tTrail = rawT - lapseC;
        const rainFrac = tTrail <= 0 ? 0 : tTrail >= 2 ? 1 : tTrail / 2;
        covered += ov;
        weightedRain += ov * rainFrac;
      }
      if (covered > 0) {
        totalRainMm += spanLiquid * (weightedRain / covered);
        continue;
      }
    }

    // 3. Fallback when neither snowLevel nor temp overlaps: subtract 10:1 snow SWE if present.
    const snowLiquid = s.snow?.length ? sumOver(s.snow, a, b) / 10 : 0;
    totalRainMm += Math.max(0, spanLiquid - snowLiquid);
  }
  return totalRainMm;
};

/** Lowest wind chill (°C) across exact overlapping (temp, wind/gust) sub-intervals + NWS windChill. */
const lowestWindChillC = (s, from, to, lapseC) => {
  let worst = extremeOver(s.windChill, from, to, false);
  if (worst) worst = { v: worst.v - lapseC, at: worst.at };

  const windSrc = s.wind?.length ? s.wind : null;
  const windFactor = windSrc ? 1 : 0.7;
  const winds = windSrc || s.gust || [];
  for (const [ts, te, rawT] of s.temp || []) {
    const a = Math.max(ts, from);
    const b = Math.min(te, to);
    if (b <= a) continue;
    const tTrail = rawT - lapseC;
    if (tTrail > 10) continue;
    for (const [ws, we, rawW] of winds) {
      const ovStart = Math.max(a, ws);
      const ovEnd = Math.min(b, we);
      if (ovEnd <= ovStart) continue;
      const wKmh = rawW * windFactor;
      if (wKmh < 4.8) continue;
      const wc = nwsWindChillC(tTrail, wKmh);
      if (!worst || wc < worst.v) worst = { v: wc, at: ovStart };
    }
  }
  return worst;
};

/** Reduce one forecast point over [fromMs, toMs] to the numbers the detector grades. */
export const summarizePoint = (point, now, pastPrecip, opts = {}) => {
  const g = point.grid;
  if (!g) return null;
  const from = opts.fromMs ?? now;
  const end = opts.toMs ?? (from + HORIZON_HOURS * HOUR);
  const s = g.series || {};

  const coldElevM = opts.highElevM ?? point.ele ?? null;
  const heatElevM = opts.lowElevM ?? point.ele ?? null;
  const coldLapseC = lapseFor(coldElevM, g.gridElevationM);
  const heatLapseC = lapseFor(heatElevM, g.gridElevationM);

  const gust = extremeOver(s.gust, from, end, true);
  const heat = extremeOver(s.apparent, from, end, true);
  const cold = extremeOver(s.temp, from, end, false);
  const chill = lowestWindChillC(s, from, end, coldLapseC);
  const thunderProb = extremeOver(s.thunderProb, from, end, true);
  let thunderCoverage = null;
  for (const [st, e, coverage] of s.weather || []) {
    if (e <= from || st >= end) continue;
    const strong = STRONG_THUNDER.has(coverage);
    if (!thunderCoverage || (strong && !thunderCoverage.strong)) thunderCoverage = { coverage, strong, at: Math.max(st, from) };
    if (strong) break;
  }

  let freezingHazard = null;
  for (const [st, e, h] of s.weatherHazards || []) {
    if (e <= from || st >= end || !h || !FREEZING_PRECIP.has(h.weather)) continue;
    freezingHazard = { ...h, at: Math.max(st, from) };
    break;
  }

  const precipEnd = opts.toMs != null ? Math.min(end, from + 48 * HOUR) : (from + 48 * HOUR);
  const precipStart = opts.fromMs != null && opts.fromMs > now ? Math.max(now, from - 24 * HOUR) : from;
  const nextPrecipIn = mmToIn(rainOver(s, precipStart, precipEnd, heatLapseC, heatElevM));
  const includePast = from <= now + 36 * HOUR;
  const pastIn = includePast && pastPrecip?.past48hMm != null ? mmToIn(pastPrecip.past48hMm) : null;

  const gridSnowIn = mmToIn(sumOver(s.snow, from, end));
  const elevSnowIn = mmToIn(mountainSnowFromSnowLevel(s, from, end, coldElevM));
  const snowIn = Math.max(gridSnowIn, elevSnowIn);

  const iceIn = mmToIn(sumOver(s.ice, from, end));
  const iceLevel = iceIn >= THRESHOLDS.iceIn[1] ? 2 : (iceIn >= THRESHOLDS.iceIn[0] || freezingHazard ? 1 : 0);

  const coldF = cold ? cToF(cold.v - coldLapseC) : null;
  const windChillF = chill ? cToF(chill.v) : null;
  const effectiveColdF = coldF == null && windChillF == null ? null : Math.min(coldF ?? Infinity, windChillF ?? Infinity);

  return {
    gustMph: gust ? kmhToMph(gust.v) : null,
    gustAt: gust ? firstAtOrAbove(s.gust, from, end, THRESHOLDS.gustMph[0] * 1.609344) ?? gust.at : null,
    heatF: heat ? cToF(heat.v - heatLapseC) : null,
    heatAt: heat?.at ?? null,
    coldF,
    windChillF,
    effectiveColdF,
    coldAt: chill && (cold == null || chill.v < (cold.v - coldLapseC - 2.5)) ? chill.at : (cold?.at ?? chill?.at ?? null),
    lapseAdjustedF: coldLapseC ? -coldLapseC * 9 / 5 : 0,
    snowIn,
    snowFromSnowLevel: elevSnowIn > gridSnowIn && elevSnowIn >= THRESHOLDS.snowIn[0],
    iceIn,
    iceLevel,
    iceHazard: freezingHazard?.weather ?? null,
    iceAt: freezingHazard?.at ?? (iceIn >= THRESHOLDS.iceIn[0] ? firstAtOrAbove(s.ice, from, end, 0.01) : null),
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
  ice: {
    level: (x) => x.iceLevel,
    value: (x) => Math.max(x.iceIn || 0, x.iceHazard ? 0.05 : 0),
    note: (x) => (x.iceIn >= 0.05 ? `${r1(x.iceIn)} in freezing rain/ice accretion` : `${(x.iceHazard || 'freezing_rain').replace(/_/g, ' ')} forecast`),
    title: (lvl) => (lvl >= 2 ? 'Heavy freezing rain forecast' : 'Freezing rain or wintry mix forecast'),
    advice: 'Wet tread, rock slabs, and bridges can glaze with clear ice. Carry microspikes and avoid exposed icy crossings.',
    when: (x) => x.iceAt,
  },
  precip: {
    level: (x) => grade(x.precipIn, THRESHOLDS.precipIn),
    value: (x) => x.precipIn,
    note: (x) => `${r1(x.precipIn)} in rain${x.pastPrecipIn != null ? ` (${r1(x.pastPrecipIn)} past 48 h + ${r1(x.nextPrecipIn)} forecast)` : ' forecast'}`,
    title: (lvl) => (lvl >= 2 ? 'Heavy rain — creek crossings may run high' : 'Wet trail — possible mud'),
    advice: 'Expect higher, faster creeks in the afternoon. Never cross water above your knees; burn scars can flash-flood.',
    when: () => null,
  },
  snow: {
    level: (x) => grade(x.snowIn, THRESHOLDS.snowIn),
    value: (x) => x.snowIn,
    note: (x) => `${r1(x.snowIn)} in snow${x.snowFromSnowLevel ? ' (trail above freezing snow level)' : ''}`,
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
    level: (x) => grade(x.effectiveColdF, THRESHOLDS.coldF, true),
    value: (x) => (x.effectiveColdF == null ? null : -x.effectiveColdF),
    note: (x) => {
      const chillNote = x.windChillF != null && x.coldF != null && x.windChillF < x.coldF - 5 ? ` (wind chill near ${r0(x.windChillF)}°F)` : '';
      return `low near ${r0(x.coldF ?? x.windChillF)}°F${chillNote}${x.lapseAdjustedF ? ' (adjusted to trail elevation)' : ''}`;
    },
    title: (lvl) => (lvl >= 2 ? 'Extreme cold forecast' : 'Hard freeze forecast'),
    advice: 'Check that your sleep system and layers are rated for these lows and wind chill. Water filters can freeze.',
    when: (x) => x.coldAt,
  },
};

/**
 * points: forecast samples (sorted by mile) with grid data; pastPrecip: parallel
 * array from Open-Meteo. Each chunk inside [range.start, range.end] uses the
 * nearest sample within maxGapMiles, optional trip ETA [fromMs, toMs], and
 * chunk-specific terrain min/max elevations.
 */
export const detectWeather = (route, forecast, pastPrecip, { now = Date.now(), range, maxGapMiles, trip = null, terrainPoints = null } = {}) => {
  const points = forecast?.points || [];
  const hits = [];
  const checkedChunks = new Set();
  // Chunks whose nearest forecast point is outside NWS coverage (e.g. Canada).
  const uncoveredChunks = new Set();
  const worst = new Map(); // kind -> { level, value, summary, mile, point }
  const metrics = {
    peakGustMph: null,
    peakHeatF: null,
    minColdF: null,
    minWindChillF: null,
    maxPrecipIn: null,
    maxSnowIn: null,
    maxIceIn: null,
    maxThunderPct: null,
  };
  if (!points.length || !range) {
    return { hazards: [], hits, overlays: [], checkedChunks, uncoveredChunks, itineraryBeyondForecastMiles: 0, metrics };
  }

  const cache = new Map();
  let j = 0;
  let itineraryBeyondForecastMiles = 0;

  for (const chunk of route.chunks) {
    if (chunk.end < range.start || chunk.start > range.end) continue;
    const mid = (chunk.start + chunk.end) / 2;
    while (j < points.length - 1 && Math.abs(points[j + 1].mile - mid) <= Math.abs(points[j].mile - mid)) j++;
    const k = nearestUsableSample(points, (i) => points[i]?.grid != null, j, mid, maxGapMiles);
    if (k < 0) {
      if (points[j].reason === 'outside NWS coverage' && Math.abs(points[j].mile - mid) <= UNCOVERED_REACH_MILES) {
        uncoveredChunks.add(chunk.i);
      }
      continue;
    }

    const pt = points[k];
    const { fromMs, toMs } = chunkTimeWindow(chunk, trip, now);
    if (trip) {
      const hEnd = gridHorizonMs(pt.grid);
      if (hEnd != null && fromMs >= hEnd) {
        itineraryBeyondForecastMiles += (chunk.end - chunk.start);
        continue;
      }
    }

    const elevRange = chunkElevationRangeM(chunk, terrainPoints, pt.ele ?? null);
    const lowKey = elevRange?.minM != null ? Math.round(elevRange.minM) : '';
    const highKey = elevRange?.maxM != null ? Math.round(elevRange.maxM) : '';
    const cacheKey = `${k}|${Math.round(fromMs / 3600000)}|${Math.round(toMs / 3600000)}|${lowKey}|${highKey}`;
    let summary = cache.get(cacheKey);
    if (!summary) {
      summary = summarizePoint(pt, now, pastPrecip?.bySample?.[k], {
        fromMs,
        toMs,
        lowElevM: elevRange?.minM ?? null,
        highElevM: elevRange?.maxM ?? null,
      });
      cache.set(cacheKey, summary);
    }
    if (!summary) continue;

    checkedChunks.add(chunk.i);
    if (summary.gustMph != null) metrics.peakGustMph = Math.max(metrics.peakGustMph ?? -Infinity, r0(summary.gustMph));
    if (summary.heatF != null) metrics.peakHeatF = Math.max(metrics.peakHeatF ?? -Infinity, r0(summary.heatF));
    if (summary.coldF != null) metrics.minColdF = Math.min(metrics.minColdF ?? Infinity, r0(summary.coldF));
    if (summary.windChillF != null) metrics.minWindChillF = Math.min(metrics.minWindChillF ?? Infinity, r0(summary.windChillF));
    metrics.maxPrecipIn = Math.max(metrics.maxPrecipIn ?? 0, r1(summary.precipIn));
    metrics.maxSnowIn = Math.max(metrics.maxSnowIn ?? 0, r1(summary.snowIn));
    metrics.maxIceIn = Math.max(metrics.maxIceIn ?? 0, r1(summary.iceIn));
    if (summary.thunderProb != null) metrics.maxThunderPct = Math.max(metrics.maxThunderPct ?? 0, r0(summary.thunderProb));

    for (const [kind, def] of Object.entries(KINDS)) {
      const level = Math.min(MAX_ESTIMATED_LEVEL, def.level(summary));
      if (!level) continue;
      const id = `wx:${kind}`;
      hits.push({ chunk: chunk.i, id, level, note: def.note(summary), value: def.value(summary) ?? 0 });
      const prev = worst.get(kind);
      const value = def.value(summary) ?? 0;
      if (!prev || level > prev.level || (level === prev.level && value > prev.value)) {
        worst.set(kind, { level, value, summary, point: pt, mile: mid });
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
        `Worst near Mi ${r1(w.mile ?? w.point.mile)}: ${def.note(w.summary)}`,
        'derived from the NWS gridded forecast',
      ].filter(Boolean).join(' · '),
      advice: def.advice,
      attribution: usesPast ? `${NWS_FORECAST} + ${PRECIP_ATTRIBUTION}` : NWS_FORECAST,
      url: `https://forecast.weather.gov/MapClick.php?lat=${w.point.lat.toFixed(4)}&lon=${w.point.lon.toFixed(4)}`,
      when: when ? new Date(when).toISOString() : null,
    });
  }
  return { hazards, hits, overlays: [], checkedChunks, uncoveredChunks, itineraryBeyondForecastMiles, metrics };
};
