/**
 * Reading the model: turn a point's hourly state into what a hiker meets
 * underfoot, with a likelihood and the reasons; then group the route into a
 * few stretches a person can hold in their head.
 */
import { SURFACES } from './surfaces.js';
import { P } from './model.js';

// rank orders conditions at a point; level is the shared 0–4 scale (estimates stay ≤ 2).
export const CONDITIONS = {
  'snow-deep':   { rank: 10, level: 2, label: 'Deep snow on the trail', regime: 'winter' },
  snow:          { rank: 9,  level: 2, label: 'Snow on the trail', regime: 'winter' },
  ice:           { rank: 8,  level: 2, label: 'Icy patches', regime: 'winter' },
  'snow-patchy': { rank: 7,  level: 1, label: 'Patchy snow', regime: 'winter' },
  frozen:        { rank: 6,  level: 0, label: 'Frozen ground', regime: 'winter' },
  mud:           { rank: 5,  level: 0, label: 'Muddy', regime: 'wet' },
  slick:         { rank: 4,  level: 0, label: 'Slick when wet', regime: 'wet' },
  wet:           { rank: 3,  level: 0, label: 'Wet', regime: 'wet' },
  loose:         { rank: 2,  level: 0, label: 'Loose rock on steep slopes', regime: 'dry' },
  dusty:         { rank: 1.5, level: 0, label: 'Dry and dusty', regime: 'dry' },
  dry:           { rank: 1,  level: 0, label: 'Dry and firm', regime: 'dry' },
};

const REGIME_RANK = { winter: 3, wet: 2, dry: 1 };
const REGIME_TITLE = { winter: 'Snow and ice', wet: 'Wet', dry: 'Dry', missing: 'Not estimated' };

export const isSnow = (code) => code === 'snow-deep' || code === 'snow' || code === 'snow-patchy';

export const snowState = (r) => {
  if (r.fresh > P.freshSnow && r.meltToday <= 0) return 'fresh';
  // A refrozen surface crust holds until the day's melt has worn it away.
  if (r.meltToday >= P.softMelt || (r.liq > 0.1 && r.cc <= 0 && r.Ta > 0 && !(r.crust > 0.5))) return 'soft';
  if (r.meltToday > 0) return 'softening';
  return 'firm';
};

export const isIcy = (r) => r.wet && (r.ground <= 0 || (r.minGround6 <= -1 && r.Ta < 3 && r.beam < 150));

const inches = (cm) => Math.max(1, Math.round(cm / 2.54));

/**
 * The conditions at one point for one reading, strongest first.
 * "likely" means the condition is there, not how sure the depth class is:
 * deeper snow is never rated less likely than shallower snow.
 */
export const classifyReading = (point, r) => {
  const surface = SURFACES[point.surface] || SURFACES.dirt;
  const out = [];
  const shaded = point.canopy >= 0.5 ? 'shaded by trees' : null;
  if (r.depthCm >= 0.5) {
    const code = r.depthCm >= 30 ? 'snow-deep' : r.depthCm >= 5 ? 'snow' : 'snow-patchy';
    const floor = code === 'snow-patchy' ? 1 : 10;
    out.push({ code, likely: r.depthCm >= floor || point.surface === 'ice', state: snowState(r), depthCm: r.depthCm, why: [`about ${inches(r.depthCm)} in of snow modeled`] });
  } else if (isIcy(r)) {
    const why = [`ground near ${Math.round(Math.min(r.ground, r.minGround6) * 9 / 5 + 32)}°F on a wet tread`];
    if (r.sweMm > 0) why.push('under a dusting of snow');
    if (shaded) why.push(shaded);
    out.push(surface.iceProne
      ? { code: 'ice', likely: r.ground <= -1, why }
      : { code: 'frozen', likely: true, why });
  } else if (r.sweMm > 0) {
    // A dusting: too thin to call snow cover, too much to call the tread dry.
    out.push({ code: 'snow-patchy', likely: false, state: snowState(r), depthCm: r.depthCm, why: ['a dusting of snow modeled'] });
  } else if (r.wet) {
    const why = [`${surface.label.toLowerCase()}, ${Math.round(r.wetness * 100)}% wet`];
    if (surface.mud) out.push({ code: 'mud', likely: r.wetness >= 0.75, why });
    else if (surface.slick) out.push({ code: 'slick', likely: r.wetness >= 0.75, why });
    else out.push({ code: 'wet', likely: true, why });
  } else if (surface.litter && r.litterWet > 0.5) {
    out.push({ code: 'slick', likely: false, why: ['wet leaves and roots'] });
  }
  if (surface.loose && (point.surface === 'scree' || point.slopeDeg >= 25)) {
    out.push({ code: 'loose', likely: point.surface === 'scree', why: [`${surface.label.toLowerCase()} on a ${Math.round(point.slopeDeg)}° slope`] });
  }
  if (!out.some(c => CONDITIONS[c.code].regime !== 'dry')) {
    // Without NOAA's snow analysis, snow older than the weather history is unknown: never a confident "dry".
    const unsure = point.unseeded ? ['snow older than 10 days not checked here'] : [];
    if (surface.dusty && r.wetness < 0.1 && r.hoursDry >= 120) {
      out.push({ code: 'dusty', likely: !point.unseeded, why: [`no rain for ${Math.floor(r.hoursDry / 24)} days`, ...unsure] });
    } else {
      out.push({ code: 'dry', likely: r.wetness < 0.2 && !point.unseeded, why: unsure });
    }
  }
  return out.sort((a, b) => CONDITIONS[b.code].rank - CONDITIONS[a.code].rank);
};

const clock = (h) => {
  const hr = ((h % 24) + 24) % 24;
  return `${hr % 12 || 12} ${hr < 12 ? 'AM' : 'PM'}`;
};

/**
 * When things change through one day, from that day's daytime readings
 * ([{ localHour, reading }] in local order): when snow softens or melts out,
 * when ice lets go.
 */
export const dayTiming = (point, hours) => {
  const snowy = hours.filter(x => x.reading.depthCm >= 0.5);
  if (snowy.length) {
    const morning = hours.find(x => x.localHour >= 7 && x.localHour <= 9)?.reading;
    // Postholing needs depth; a thin cover just turns to slush.
    const deep = Math.max(...snowy.map(x => x.reading.depthCm)) >= 15;
    const soft = deep ? 'soft' : 'slushy';
    const lastSnowy = snowy[snowy.length - 1];
    const lastHour = hours[hours.length - 1]?.localHour ?? 17;
    const state = morning && morning.depthCm >= 0.5 ? snowState(morning) : null;
    // Thin snow can melt out before it ever counts as "soft".
    if (morning && morning.depthCm >= 0.5 && lastSnowy.localHour < lastHour) {
      return { kind: 'snow', text: `${state === 'firm' ? 'firm early, ' : ''}melts out by about ${clock(lastSnowy.localHour + 1)}` };
    }
    if (state === 'soft') return { kind: 'snow', text: deep ? 'soft all day, postholing likely' : 'wet and slushy all day' };
    const morningSwe = morning?.sweMm ?? Math.max(...snowy.map(x => x.reading.sweMm));
    const threshold = Math.min(P.softMelt, 0.5 * morningSwe);
    const softAt = hours.find(x => x.localHour >= 8 && x.reading.depthCm >= 0.5
      && (x.reading.meltToday >= threshold || snowState(x.reading) === 'soft'));
    if (state === 'fresh') return { kind: 'snow', text: softAt ? `fresh snow, wet and heavy after about ${clock(softAt.localHour)}` : 'fresh snow' };
    if (softAt) return { kind: 'snow', text: `firm early, ${soft} after about ${clock(softAt.localHour)}` };
    if (snowy.some(x => snowState(x.reading) === 'softening')) return { kind: 'snow', text: 'firm early, softening in the afternoon' };
    return { kind: 'snow', text: 'stays frozen and slick all day' };
  }
  const icyHours = hours.filter(x => isIcy(x.reading));
  if (icyHours.length) {
    if (icyHours.some(x => x.localHour >= 14)) return { kind: 'ice', text: 'may stay icy all day' };
    const last = icyHours[icyHours.length - 1];
    return { kind: 'ice', text: `icy until about ${clock(last.localHour + 1)}` };
  }
  const wetMorning = hours.find(x => x.localHour === 8)?.reading;
  const wetAfternoon = hours.find(x => x.localHour === 14)?.reading;
  if (wetMorning && wetAfternoon && wetMorning.ground <= 0 && wetAfternoon.wet && (SURFACES[point.surface] || SURFACES.dirt).mud) {
    return { kind: 'mud', text: 'frozen early, muddy by afternoon' };
  }
  return null;
};

/** "mostly north-facing" when most points share a quadrant. */
const facing = (aspects) => {
  const names = ['north', 'east', 'south', 'west'];
  const counts = [0, 0, 0, 0];
  let n = 0;
  for (const a of aspects) {
    if (a == null || a < 0) continue;
    counts[Math.round((((a % 360) + 360) % 360) / 90) % 4]++;
    n++;
  }
  if (!n) return null;
  const top = counts.indexOf(Math.max(...counts));
  return counts[top] / n >= 0.6 ? `mostly ${names[top]}-facing` : null;
};

const roundTo = (v, step) => Math.round(v / step) * step;
const round1 = (v) => Math.round(v * 10) / 10;
const GAP = 1e-6;

const titleOf = (regime, parts) => {
  if (regime !== 'winter') return REGIME_TITLE[regime];
  const snow = parts.some(p => isSnow(p.code));
  const ice = parts.some(p => p.code === 'ice');
  return snow && ice ? 'Snow and ice' : snow ? 'Snow' : ice ? 'Icy patches' : 'Frozen ground';
};

const describeRun = (points, perPoint, run, timing) => {
  const byCode = new Map();
  for (const i of run.idx) {
    for (const c of perPoint[i]) {
      if (run.regime !== 'dry' && CONDITIONS[c.code].regime === 'dry' && c.code !== 'loose') continue;
      const e = byCode.get(c.code) || { n: 0, likely: 0, elev: [], aspects: [], depth: [], why: new Map(), timing: new Map() };
      e.n++;
      if (c.likely) e.likely++;
      if (Number.isFinite(points[i].elevM)) e.elev.push(points[i].elevM);
      if (Number.isFinite(c.depthCm)) e.depth.push(c.depthCm);
      e.aspects.push(points[i].slopeDeg >= 5 ? points[i].aspectDeg : null);
      for (const w of c.why) e.why.set(w.replace(/\d+/g, '#'), w);
      const t = timing?.[i];
      if (t && (t.kind === 'snow' ? isSnow(c.code) : t.kind === 'ice' ? c.code === 'ice' || c.code === 'frozen' : c.code === 'mud')) {
        e.timing.set(t.text, (e.timing.get(t.text) || 0) + 1);
      }
      byCode.set(c.code, e);
    }
  }
  const parts = [...byCode]
    .map(([code, e]) => {
      const why = [...e.why.values()];
      // Depth reads as the stretch's range, not whichever point came last.
      if (e.depth.length && why.some(w => /in of snow modeled/.test(w))) {
        const lo = inches(Math.min(...e.depth));
        const hi = inches(Math.max(...e.depth));
        why[why.findIndex(w => /in of snow modeled/.test(w))] = lo === hi ? `about ${lo} in of snow modeled` : `about ${lo}–${hi} in of snow modeled`;
      }
      return {
        code,
        label: CONDITIONS[code].label,
        level: e.likely / e.n >= 0.5 ? CONDITIONS[code].level : Math.min(1, CONDITIONS[code].level),
        share: Math.round((e.n / run.idx.length) * 100),
        likelihood: e.likely / e.n >= 0.5 ? 'likely' : 'possible',
        elevationFt: e.elev.length ? [roundTo(Math.min(...e.elev) * 3.28084, 100), roundTo(Math.max(...e.elev) * 3.28084, 100)] : null,
        facing: facing(e.aspects),
        timing: [...e.timing].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
        why: why.slice(0, 3),
      };
    })
    .filter(p => p.share >= 10 || p.level >= 1)
    .sort((a, b) => CONDITIONS[b.code].rank - CONDITIONS[a.code].rank);
  const first = points[run.idx[0]];
  const last = points[run.idx[run.idx.length - 1]];
  return {
    regime: run.regime,
    title: titleOf(run.regime, parts),
    level: Math.max(0, ...parts.map(p => p.level)),
    mileStart: round1(first.mileFrom ?? first.mile),
    mileEnd: round1(last.mileTo ?? last.mile),
    parts,
  };
};

const missing = (a, b) => ({ regime: 'missing', title: REGIME_TITLE.missing, level: 0, mileStart: round1(a), mileEnd: round1(b), parts: [] });

/**
 * Group points into stretches by regime (winter / wet / dry). A point takes
 * the strongest regime within ±smoothPoints neighbours, so one sunny
 * switchback inside a snowy stretch doesn't split it, at any spacing. Miles
 * that were not modeled (no weather) become explicit "Not estimated"
 * stretches, never part of a dry one. `range` adds leading/trailing gaps.
 */
export const toStretches = (points, perPoint, { smoothPoints = 2, timing = null, range = null } = {}) => {
  const out = [];
  if (!points.length) return range && range.end > range.start ? [missing(range.start, range.end)] : out;
  const regimeOf = (conds) => conds.reduce((best, c) => {
    const r = CONDITIONS[c.code].regime;
    return REGIME_RANK[r] > REGIME_RANK[best] ? r : best;
  }, 'dry');
  const raw = perPoint.map(regimeOf);
  const adjacent = (i) => i > 0 && points[i].mileFrom - points[i - 1].mileTo <= GAP;
  const smooth = raw.map((r, i) => {
    let best = r;
    for (let j = i - 1; j >= Math.max(0, i - smoothPoints) && adjacent(j + 1); j--) if (REGIME_RANK[raw[j]] > REGIME_RANK[best]) best = raw[j];
    for (let j = i + 1; j <= Math.min(raw.length - 1, i + smoothPoints) && adjacent(j); j++) if (REGIME_RANK[raw[j]] > REGIME_RANK[best]) best = raw[j];
    return best;
  });
  const runs = [];
  smooth.forEach((regime, i) => {
    const last = runs[runs.length - 1];
    if (last && last.regime === regime && adjacent(i)) last.idx.push(i);
    else runs.push({ regime, idx: [i] });
  });
  if (range && points[0].mileFrom - range.start > GAP) out.push(missing(range.start, points[0].mileFrom));
  runs.forEach((run, k) => {
    if (k > 0) {
      const prev = points[runs[k - 1].idx[runs[k - 1].idx.length - 1]];
      const next = points[run.idx[0]];
      if (next.mileFrom - prev.mileTo > GAP) out.push(missing(prev.mileTo, next.mileFrom));
    }
    out.push(describeRun(points, perPoint, run, timing));
  });
  const lastPoint = points[points.length - 1];
  if (range && range.end - lastPoint.mileTo > GAP) out.push(missing(lastPoint.mileTo, range.end));
  return out;
};

/**
 * One plain sentence per condition in a stretch — what the UI shows.
 * scope 'stretch' words the share relative to "that stretch" (for hazard
 * cards that sit next to route-wide ranges).
 */
export const partText = (p, { scope = 'it' } = {}) => {
  const band = !p.elevationFt ? null : p.elevationFt[0] === p.elevationFt[1]
    ? `near ${p.elevationFt[0].toLocaleString('en-US')} ft`
    : `${p.elevationFt[0].toLocaleString('en-US')}–${p.elevationFt[1].toLocaleString('en-US')} ft`;
  const where = scope === 'stretch'
    ? (p.share >= 80 ? 'most of that stretch' : p.share >= 40 ? 'about half of that stretch' : 'in places')
    : (p.share >= 80 ? 'most of the way' : p.share >= 40 ? 'about half of it' : 'in places');
  const head = p.likelihood === 'likely' ? p.label : `Possibly ${p.label.charAt(0).toLowerCase()}${p.label.slice(1)}`;
  const detail = [band, p.facing].filter(Boolean).join(', ');
  return `${head} ${where}${detail ? ` (${detail})` : ''}${p.timing ? `; ${p.timing}` : ''}.`;
};
