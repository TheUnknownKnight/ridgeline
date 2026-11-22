import { pointAtMile, haversineMiles } from '../../shared/geo.js';
import { sunHour } from '../../shared/conditions/solar.js';
import { runPoint } from '../../shared/conditions/model.js';
import { surfaceFromLandCover } from '../../shared/conditions/surfaces.js';
import { classifyReading, dayTiming, toStretches, CONDITIONS, partText } from '../../shared/conditions/classify.js';
import { MAX_ESTIMATED_LEVEL } from '../../shared/levels.js';
import { loadTerrain, ATTRIBUTION as TERRAIN_ATTRIBUTION } from '../sources/terrain.js';
import { loadSnow, ATTRIBUTION as SNOW_ATTRIBUTION } from '../sources/snodas.js';
import { loadCells, loadTimeZone, cellKeyOf, MAX_CELLS, ATTRIBUTION as WEATHER_ATTRIBUTION } from '../sources/weatherHistory.js';
import { inUnitedStatesBbox } from '../sources/usStates.js';

/**
 * Trail conditions: what is likely underfoot (snow, ice, mud, slick rock,
 * dust) along the route now and over the next days. Inputs are public data —
 * hourly weather, terrain, tree cover, land cover and the national snow
 * analysis; the inference is the deterministic model in shared/conditions.
 * Everything here is an estimate and is capped like every other estimate.
 */
export const SOURCE_URL = 'https://landfire.gov/';
export const ATTRIBUTION = 'Ridgeline model from Open-Meteo weather, LANDFIRE terrain, USFS canopy, NLCD land cover and NOAA SNODAS';

const MAX_POINTS = 2000;
const GRID_STEP = 0.25;
// Terrain and the snow analysis improve the estimate but must never hold it up.
// Both have 13.5 s internal soft budgets so completed layers/tiles are preserved.
const OPTIONAL_INPUT_SOFT_MS = 13500;
const OPTIONAL_INPUT_BUDGET_MS = 14500;
// A file elevation this far from the terrain model is a unit or data error: trust the terrain.
const ELEVATION_MISMATCH_M = 300;
const CM_TO_IN = 1 / 2.54;
const M_TO_FT = 3.28084;

/** Sample spacing: 0.25 mi, or a multiple of it on long routes (so every sample sits on one route-wide grid). */
export const conditionsSpacing = (spanMiles) => Math.max(GRID_STEP, Math.ceil(spanMiles / MAX_POINTS / GRID_STEP) * GRID_STEP);

/** Indices of at most `max` items spread evenly along a list. */
const pickEvenly = (n, max) => (n <= max
  ? Array.from({ length: n }, (_, i) => i)
  : Array.from({ length: max }, (_, k) => Math.round((k * (n - 1)) / (max - 1))));

const withBudget = (promise, ms, fallback) => {
  let timer;
  const budget = new Promise(resolve => { timer = setTimeout(resolve, ms, fallback); });
  return Promise.race([promise, budget]).finally(() => clearTimeout(timer));
};

/**
 * Sample points on a route-wide grid (multiples of the spacing), so On trail
 * windows reuse Planning's cached terrain. Each point stands for the miles
 * halfway to its neighbours, clipped to the range.
 */
const gridPoints = (route, range, spacing) => {
  const miles = [];
  for (let m = Math.ceil(range.start / spacing - 1e-9) * spacing; m <= range.end + 1e-9; m += spacing) miles.push(Math.min(m, range.end));
  if (!miles.length) miles.push((range.start + range.end) / 2);
  return miles.map((mile, i) => {
    const c = pointAtMile(route.coords, route.cum, mile);
    return {
      mile, lon: c[0], lat: c[1], ele: c.length > 2 ? c[2] : null,
      mileFrom: i === 0 ? range.start : (miles[i - 1] + mile) / 2,
      mileTo: i === miles.length - 1 ? range.end : (mile + miles[i + 1]) / 2,
    };
  });
};

/** Pick the fetched cell closest in horizontal distance + vertical elevation (200 m ≈ 1 mi). */
const bestBorrowedCell = (point, pointElevM, candidates) => {
  let bestKey = candidates[0].key;
  let bestCost = Infinity;
  for (const c of candidates) {
    let cost = haversineMiles(c.lon, c.lat, point.lon, point.lat);
    if (pointElevM != null && c.elevation != null) cost += Math.abs(pointElevM - c.elevation) / 200;
    if (cost < bestCost) { bestCost = cost; bestKey = c.key; }
  }
  return bestKey;
};

/**
 * Gather the inputs. Weather cells are capped (Open-Meteo quota): beyond
 * MAX_CELLS, points borrow the closest matching fetched cell in space and
 * elevation — lapse correction to each point's own elevation still applies.
 */
export const loadConditions = async ({ route, range, now = Date.now(), timeZone = null }) => {
  const spacing = conditionsSpacing(Math.max(0.01, range.end - range.start));
  const points = gridPoints(route, range, spacing);
  const ownKeys = points.map(cellKeyOf);
  const order = [...new Set(ownKeys)];
  const picked = pickEvenly(order.length, MAX_CELLS).map(i => order[i]);
  const pickedSet = new Set(picked);

  const [terrain, snow, weather, zone] = await Promise.all([
    withBudget(loadTerrain({ points, budgetMs: OPTIONAL_INPUT_SOFT_MS }), OPTIONAL_INPUT_BUDGET_MS, { status: 'error', byPoint: points.map(() => null), failedLayers: ['timeout'] }),
    withBudget(loadSnow({ points, budgetMs: OPTIONAL_INPUT_SOFT_MS }), OPTIONAL_INPUT_BUDGET_MS, { status: 'error', validAt: null, byPoint: points.map(() => null) }),
    loadCells(picked),
    timeZone ? Promise.resolve(timeZone) : withBudget(loadTimeZone(points[0].lat, points[0].lon), 4000, null),
  ]);

  const candidates = picked
    .filter(key => weather.cells.get(key))
    .map((key) => {
      const [lat, lon] = key.split(',').map(Number);
      return { key, lat, lon, elevation: weather.cells.get(key)?.elevation ?? null };
    });
  const cellOf = ownKeys.map((k, i) => {
    if ((pickedSet.has(k) && weather.cells.get(k)) || !candidates.length) return k;
    const p = points[i];
    const pElev = p.ele ?? terrain.byPoint[i]?.elevationM ?? null;
    return bestBorrowedCell(p, pElev, candidates);
  });

  const withWeather = cellOf.filter(k => weather.cells.get(k)).length;
  // Old snow is only known where NOAA's analysis answered; elsewhere (Alaska, Hawaii, an outage) it's a gap.
  const snowGap = snow.status === 'error' || snow.status === 'partial'
    || (snow.status === 'skipped' && points.some(p => inUnitedStatesBbox(p.lon, p.lat)));
  const reasons = [];
  if (withWeather < points.length) reasons.push('weather');
  if (snowGap) reasons.push('snow');
  if (terrain.status === 'error') reasons.push('terrain');
  const status = withWeather === 0 ? 'error' : reasons.length ? 'partial' : weather.stale ? 'stale' : 'ok';

  const notes = [];
  if (reasons.includes('weather')) notes.push('weather history missing for part of the route');
  if (terrain.status === 'error') notes.push('terrain and land cover unavailable (assumed flat dirt trail)');
  else if (terrain.status === 'partial') notes.push(`some terrain layers unavailable (${terrain.failedLayers.join(', ')})`);
  if (snow.status === 'error') notes.push('snow analysis unavailable, so snow older than ten days may be missed');
  else if (snow.status === 'partial') notes.push('snow analysis missing for part of the route');
  else if (snow.status === 'skipped') notes.push('outside the snow analysis area, so snow older than ten days may be missed');
  return {
    status,
    fetchedAt: new Date(now).toISOString(),
    message: status === 'error'
      ? 'Trail conditions unavailable — weather history could not be loaded'
      : `Modeled every ${spacing} mi from 10 days of weather and the 3-day forecast${notes.length ? `; ${notes.join('; ')}` : ''}`,
    attribution: [WEATHER_ATTRIBUTION, TERRAIN_ATTRIBUTION, SNOW_ATTRIBUTION].join('; '),
    url: SOURCE_URL,
    data: {
      points, cellOf, cells: weather.cells, spacing, range, timeZone: zone,
      terrain: terrain.byPoint, snow: snow.byPoint, snowValidAt: snow.validAt,
      confidence: {
        weather: reasons.includes('weather') ? 'partial' : 'ok',
        terrain: terrain.status,
        snow: snow.status,
        surface: 'inferred from land cover, slope and tree cover',
      },
    },
  };
};

// ------------------------------------------------------------------ model run

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HOUR = 3600 * 1000;

/** Local calendar day and hour for a UTC instant: the route's zone, or solar time from longitude. */
const localClock = (timeZone, lon) => {
  let fmt = null;
  try {
    if (timeZone) fmt = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
  } catch { fmt = null; }
  return (ms) => {
    if (fmt) {
      const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
      return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, weekday: DAY_NAMES.findIndex(d => d.startsWith(parts.weekday)) };
    }
    const d = new Date(ms + Math.round(lon / 15) * HOUR);
    return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), weekday: d.getUTCDay() };
  };
};

/**
 * Cells fetched on different UTC days start their hourly arrays a day apart.
 * Put them all on one axis by timestamp (copies — cached cells are shared and
 * read-only); a cell that can't be aligned is treated as missing.
 */
const alignCells = (cells) => {
  const present = [...cells].filter(([, c]) => c?.time?.length);
  if (!present.length) return { cells: new Map(), time: null };
  const start = Math.max(...present.map(([, c]) => c.time[0]));
  const end = Math.min(...present.map(([, c]) => c.time[c.time.length - 1]));
  const len = Math.round((end - start) / HOUR) + 1;
  const out = new Map();
  let axis = null;
  for (const [k, c] of present) {
    const off = Math.round((start - c.time[0]) / HOUR);
    if (len <= 0 || c.time[off] !== start || c.time[off + len - 1] !== end) continue;
    const cut = (a) => (Array.isArray(a) ? a.slice(off, off + len) : a);
    const aligned = {
      ...c,
      time: cut(c.time), Ta: cut(c.Ta), Td: cut(c.Td), P: cut(c.P),
      cloud: cut(c.cloud), et0: cut(c.et0),
      wind: cut(c.wind), gust: cut(c.gust),
    };
    out.set(k, aligned);
    axis ??= aligned.time;
  }
  return { cells: out, time: axis };
};

const windowLabel = (dayIndex, weekday, part) =>
  `${dayIndex === 0 ? 'This' : dayIndex === 1 ? 'Tomorrow' : DAY_NAMES[weekday]} ${part}`;

/** Route chunks (1-mile, numbered from mile 0) overlapping [a, b]. */
const chunksBetween = (route, a, b) => {
  const out = [];
  const n = route.chunks.length;
  for (let i = Math.max(0, Math.floor(a) - 1); i <= Math.min(n - 1, Math.floor(b) + 1); i++) {
    const c = route.chunks[i];
    if (c.end > a && c.start < b) out.push(c);
  }
  return out;
};

// Each snow class is its own hazard, so a title, its color and the distance to it always agree.
const HAZARD_OF = { 'snow-deep': 'trail:snow-deep', snow: 'trail:snow', 'snow-patchy': 'trail:snow-patchy', ice: 'trail:ice' };

const adviceFor = (id, timing) => {
  if (id === 'trail:ice') {
    return /all day/.test(timing || '')
      ? 'Ice may not melt off today, even in the afternoon. Carry microspikes and take care on rock and bridges.'
      : 'Ice lingers on shaded and wet stretches in the morning. Carry microspikes and take care on rock and bridges.';
  }
  if (/soft all day|slushy all day/.test(timing || '')) {
    return 'Snow stays soft all day: expect postholing and slow going. Snowshoes help; carry traction for steep or shaded slopes.';
  }
  if (/^fresh snow/.test(timing || '')) {
    return 'Fresh snow can hide the trail and ice underneath. Allow extra time for route-finding and carry traction.';
  }
  return 'Carry traction (microspikes, or crampons and an ice axe on steep snow) and start early while snow is firm. Check recent trip reports.';
};

const fmtMi = (m) => (m < 10 ? m.toFixed(1) : String(Math.round(m)));
// "Tomorrow morning" → "tomorrow morning" inside a sentence; weekdays keep their capital.
const inSentence = (label) => (/^(This|Tomorrow) /.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label);
const r1 = (n) => Math.round(n * 10) / 10;

/**
 * Run the model at every point and read it at a few useful moments: now,
 * and mornings/afternoons for the next days. Returns the hazards (snow and
 * ice, as estimates), per-chunk hits, checked chunks, hydrology/terrain
 * metrics for downstream detectors, and the conditions block the UI shows.
 */
export const detectConditions = (route, data, { now = Date.now(), timeZone } = {}) => {
  const empty = { hazards: [], hits: [], overlays: [], checkedChunks: new Set(), block: null, hydrology: [], terrainPoints: [] };
  const points = data?.points || [];
  const { cells, time } = alignCells(data?.cells || new Map());
  if (!points.length || !time || time[0] > now || time[time.length - 1] < now) return empty;

  const zone = timeZone || data.timeZone || null;
  const lons = points.map(p => p.lon);
  const midLon = lons.reduce((s, v) => s + v, 0) / lons.length;
  const multiZone = !zone && (Math.max(...lons) - Math.min(...lons) > 10);
  const clock = localClock(zone, midLon);
  const zoneClockCache = new Map();
  const clockFor = (lon) => {
    if (!multiZone) return clock;
    const band = Math.round(lon / 15);
    if (!zoneClockCache.has(band)) zoneClockCache.set(band, localClock(null, band * 15));
    return zoneClockCache.get(band);
  };
  const local = time.map(clock);
  let nowIdx = 0;
  for (let i = 0; i < time.length; i++) if (time[i] <= now) nowIdx = i;

  // Windows: now, then 8 AM and 2 PM for up to three local days.
  const days = [];
  for (let i = nowIdx; i < time.length; i++) {
    if (!days.length || days[days.length - 1].day !== local[i].day) days.push({ day: local[i].day, weekday: local[i].weekday, hours: [] });
    if (local[i].hour >= 6 && local[i].hour <= 17) days[days.length - 1].hours.push(i);
  }
  // Earlier hours of today matter for timing (melt so far today).
  for (let i = nowIdx - 1; i >= 0 && local[i].day === days[0]?.day; i--) if (local[i].hour >= 6 && local[i].hour <= 17) days[0].hours.unshift(i);
  // After the day's last daytime hour, today's timing ("soft after 11 AM") is already history.
  const windows = [{ key: 'now', label: 'Now', idx: nowIdx, day: local[nowIdx].hour < 17 ? 0 : -1 }];
  days.slice(0, 3).forEach((d, di) => {
    for (const [part, hour] of [['morning', 8], ['afternoon', 14]]) {
      const idx = d.hours.find(i => local[i].hour === hour);
      if (idx != null && idx > nowIdx) windows.push({ key: `d${di}-${part === 'morning' ? 'am' : 'pm'}`, label: windowLabel(di, d.weekday, part), idx, day: di });
    }
  });
  const readIdx = [...new Set([...windows.map(w => w.idx), ...days.slice(0, 3).flatMap(d => d.hours)])];
  const seedAt = Number.isFinite(data.snowValidAt) ? time.findIndex(tm => tm >= data.snowValidAt) : -1;

  // Sun per cell and hour, shared by every point in the cell.
  const sunCache = new Map();
  const sunFor = (key, cell) => {
    if (!sunCache.has(key)) {
      const [lat, lon] = key.split(',').map(Number);
      sunCache.set(key, cell.time.map(t => sunHour(t, lat, lon, cell.elevation ?? 0)));
    }
    return sunCache.get(key);
  };

  const modelPoints = [];
  const perWindow = windows.map(() => []);
  const timingByDay = [[], [], []];
  const checkedChunks = new Set();
  const hydrology = [];
  const terrainPoints = [];
  let horizonShadedPoints = 0;
  let minElevM = Infinity;
  let maxElevM = -Infinity;
  let maxSlopeDeg = 0;
  let steepMiles = 0;
  let maxSnowDepthCm = 0;
  let maxSnowmelt24hMm = 0;
  let maxRunoff48hMm = 0;

  points.forEach((p, i) => {
    const cell = cells.get(data.cellOf[i]);
    if (!cell) return;
    const t = data.terrain?.[i] || {};
    const fileElev = Number.isFinite(p.ele) && route.hasElevation ? p.ele : null;
    const elevM = fileElev != null && !(Number.isFinite(t.elevationM) && Math.abs(fileElev - t.elevationM) > ELEVATION_MISMATCH_M)
      ? fileElev : t.elevationM ?? fileElev ?? cell.elevation ?? 0;
    const hasElev = fileElev != null || t.elevationM != null || cell.elevation != null;
    const horizonDeg = Array.isArray(t.horizonDeg) ? t.horizonDeg : null;
    if (horizonDeg?.some(a => a > 0)) horizonShadedPoints++;

    const point = {
      mile: p.mile, mileFrom: p.mileFrom, mileTo: p.mileTo, lat: p.lat, lon: p.lon, elevM,
      slopeDeg: t.slopeDeg ?? 0,
      aspectDeg: t.aspectDeg ?? -1,
      canopy: t.canopy ?? 0,
      horizonDeg,
    };
    point.surface = t.nlcd != null ? surfaceFromLandCover({ nlcd: t.nlcd, slopeDeg: point.slopeDeg, canopy: point.canopy, elevationM: elevM }) : 'dirt';
    const swe = data.snow?.[i];
    const seed = swe != null && seedAt >= 0 && seedAt <= nowIdx ? { atIndex: seedAt, sweMm: swe } : null;
    point.unseeded = !seed && point.surface !== 'ice';
    const readings = runPoint(point, { ...cell, sun: sunFor(data.cellOf[i], cell) }, { seed, reads: readIdx });
    modelPoints.push(point);

    const span = Math.max(0, (point.mileTo ?? point.mile) - (point.mileFrom ?? point.mile));
    if (hasElev) {
      minElevM = Math.min(minElevM, elevM);
      maxElevM = Math.max(maxElevM, elevM);
    }
    if (t.slopeDeg != null) {
      maxSlopeDeg = Math.max(maxSlopeDeg, t.slopeDeg);
      if (t.slopeDeg >= 25) steepMiles += span;
    }
    terrainPoints.push({ mile: point.mile, mileFrom: point.mileFrom, mileTo: point.mileTo, elevM: hasElev ? elevM : null, slopeDeg: t.slopeDeg ?? null, surface: point.surface });

    const nowR = readings.get(nowIdx);
    let peakMelt24 = nowR?.snowmelt24hMm ?? 0;
    let peakRunoff48 = nowR?.runoff48hMm ?? 0;
    for (const w of windows) {
      const wr = readings.get(w.idx);
      if (!wr) continue;
      if ((wr.snowmelt24hMm ?? 0) > peakMelt24) peakMelt24 = wr.snowmelt24hMm;
      if ((wr.runoff48hMm ?? 0) > peakRunoff48) peakRunoff48 = wr.runoff48hMm;
      if ((wr.depthCm ?? 0) > maxSnowDepthCm) maxSnowDepthCm = wr.depthCm;
    }
    maxSnowmelt24hMm = Math.max(maxSnowmelt24hMm, peakMelt24);
    maxRunoff48hMm = Math.max(maxRunoff48hMm, peakRunoff48);
    hydrology.push({
      mile: point.mile,
      mileFrom: point.mileFrom,
      mileTo: point.mileTo,
      lat: point.lat,
      lon: point.lon,
      elevM: hasElev ? elevM : null,
      slopeDeg: point.slopeDeg,
      snowmelt24hMm: nowR?.snowmelt24hMm ?? 0,
      runoff48hMm: nowR?.runoff48hMm ?? 0,
      peakSnowmelt24hMm: peakMelt24,
      peakRunoff48hMm: peakRunoff48,
    });

    windows.forEach((w, k) => perWindow[k].push(classifyReading(point, readings.get(w.idx))));
    const ptClock = multiZone ? clockFor(point.lon) : null;
    days.slice(0, 3).forEach((d, di) => {
      timingByDay[di].push(dayTiming(point, d.hours.map(h => ({
        localHour: ptClock ? ptClock(time[h]).hour : local[h].hour,
        reading: readings.get(h),
      }))));
    });
    for (const c of chunksBetween(route, point.mileFrom, point.mileTo)) checkedChunks.add(c.i);
  });
  if (!modelPoints.length) return empty;

  const range = data.range || { start: points[0].mileFrom, end: points[points.length - 1].mileTo };
  const stretches = Object.fromEntries(windows.map((w, k) => [w.key, toStretches(modelPoints, perWindow[k], { timing: w.day >= 0 ? timingByDay[w.day] : null, range })]));

  // Aggregate condition miles from current window for machine-readable metrics.
  const nowConds = perWindow[0] || [];
  let snowMiles = 0;
  let iceMiles = 0;
  let mudMiles = 0;
  let wetMiles = 0;
  modelPoints.forEach((p, idx) => {
    const span = Math.max(0, (p.mileTo ?? p.mile) - (p.mileFrom ?? p.mile));
    const codes = new Set((nowConds[idx] || []).map(c => c.code));
    if (codes.has('snow-deep') || codes.has('snow') || codes.has('snow-patchy')) snowMiles += span;
    if (codes.has('ice')) iceMiles += span;
    if (codes.has('mud')) mudMiles += span;
    if (codes.has('wet') || codes.has('slick')) wetMiles += span;
  });

  // Snow and ice become estimated hazards over now and the next ~48 h of windows.
  const hits = [];
  const seen = new Map(); // hazard id -> { level, code, first window, worst window, nowLevel }
  windows.forEach((w, k) => {
    if (w.day > 1) return;
    perWindow[k].forEach((conds, j) => {
      for (const c of conds) {
        const id = HAZARD_OF[c.code];
        if (!id) continue;
        // Trace sub-0.5 cm dustings and dry-ground morning frost belong in the
        // modeled conditions breakdown, not as top-level traction hazards.
        if (c.code === 'snow-patchy' && !c.likely && (c.depthCm ?? 0) < 0.5) continue;
        if (c.code === 'ice' && !c.likely && c.why?.length && c.why.every(w => /frost/i.test(w))) continue;
        const level = Math.min(MAX_ESTIMATED_LEVEL, c.likely ? CONDITIONS[c.code].level : Math.min(1, CONDITIONS[c.code].level));
        if (!level) continue;
        const p = modelPoints[j];
        for (const ch of chunksBetween(route, p.mileFrom, p.mileTo)) hits.push({ chunk: ch.i, id, level, note: CONDITIONS[c.code].label });
        const e = seen.get(id) || { level: 0, first: w, worst: w, nowLevel: 0 };
        if (level > e.level) { e.level = level; e.worst = w; }
        if (w.key === 'now') e.nowLevel = Math.max(e.nowLevel, level);
        seen.set(id, e);
      }
    });
  });

  const hazards = [];
  for (const [id, e] of seen) {
    const code = Object.keys(HAZARD_OF).find(c => HAZARD_OF[c] === id);
    const parts = stretches[e.worst.key].flatMap(s => s.parts.filter(p => HAZARD_OF[p.code] === id).map(p => ({ ...p, mileStart: s.mileStart, mileEnd: s.mileEnd })));
    const lead = parts.sort((a, b) => b.level - a.level || b.share - a.share)[0];
    const present = e.nowLevel > 0;
    const base = CONDITIONS[code].label;
    hazards.push({
      id,
      type: 'trail',
      kind: 'trail-conditions',
      source: 'ESTIMATED',
      // Present tense only for what the model says is there now.
      title: present ? base : `${base} likely ${inSentence(e.first.label)}`,
      detail: [
        lead ? `${parts.length > 1 ? `Worst at Mi ${fmtMi(lead.mileStart)}–${fmtMi(lead.mileEnd)}: ` : ''}${partText(lead, { scope: parts.length > 1 ? 'stretch' : 'it' })}` : null,
        present && e.worst.key !== 'now' ? `worse ${inSentence(e.worst.label)}` : null,
        'modeled from weather history, terrain and the national snow analysis — not an observation',
      ].filter(Boolean).join(' · '),
      advice: adviceFor(id, lead?.timing),
      attribution: ATTRIBUTION,
      url: null,
      when: present ? null : new Date(time[e.first.idx]).toISOString(),
    });
  }

  return {
    hazards,
    hits,
    overlays: [],
    checkedChunks,
    timeZone: zone,
    hydrology,
    terrainPoints,
    block: {
      spacingMiles: data.spacing,
      windows: windows.map(w => ({ key: w.key, label: w.label, at: new Date(time[w.idx]).toISOString() })),
      stretches,
      confidence: data.confidence,
      metrics: {
        modeledPoints: modelPoints.length,
        snowMiles: r1(snowMiles),
        iceMiles: r1(iceMiles),
        mudMiles: r1(mudMiles),
        wetMiles: r1(wetMiles),
        maxSnowDepthIn: r1(maxSnowDepthCm * CM_TO_IN),
        maxSnowmelt24hMm: Math.round(maxSnowmelt24hMm),
        maxRunoff48hMm: Math.round(maxRunoff48hMm),
        horizonShadedPoints,
        elevationRangeFt: Number.isFinite(minElevM) ? [Math.round(minElevM * M_TO_FT), Math.round(maxElevM * M_TO_FT)] : null,
        steepMiles: r1(steepMiles),
        maxSlopeDeg: Math.round(maxSlopeDeg),
      },
    },
  };
};
