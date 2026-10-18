/**
 * Elevation profile with the hazard band underneath — the panel's hero.
 *
 * The SVG is sized to its pixel box (ResizeObserver) instead of being
 * stretched, so text never distorts. The elevation line is decimated to the
 * min and max of each pixel column, which keeps a 20,000-point track to about
 * two points per column without flattening peaks or saddles.
 */
import { LEVELS, SOURCE_KEYS, SOURCE_LABELS } from '../../../shared/levels.js';
import { pointAtMile } from '../../../shared/geo.js';
import { h } from '../ui/dom.js';
import { fmtElevation, fmtMile, fmtRange, metersToFeet } from '../ui/format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAD_X = 1;
const TOP = 20;              // room above the highest point for its label
const AXIS = 18;             // mile labels under the band
const BAND = 14;
const BAND_GAP = 4;
const MIN_BAND_PX = 3;       // short severe stretches must stay visible
const MIN_SPAN_FT = 400;     // keeps a flat route from turning GPS noise into mountains
const CLIMB_NOISE_M = 5;     // wiggles smaller than this don't count as climbing
const TICK_SPACING_PX = 64;
const KEY_STEP = 0.01;       // arrow keys move 1% of the route; Shift or Page keys 10%
const KEY_STEP_LARGE = 0.1;
const SUMMARY_STRETCHES = 4;
const NO_HIDDEN = new Set();

let instances = 0;

const svg = (tag, attrs = {}, ...children) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (n) => Math.round(n * 10) / 10;
const feet = (meters) => Math.round(metersToFeet(meters)).toLocaleString('en-US');
const fmtStretch = (a, b) => (fmtMile(a) === fmtMile(b) ? `Mi ${fmtMile(a)}` : fmtRange(a, b));

// Official sources cover the whole route whenever they load; forecasts cover
// the analyzed range only (the On trail window), and outside it the shade says so.
const OFFICIAL_KEYS = ['fire', 'alerts', 'avalanche', 'water', 'air'];

/**
 * How each segment should look once filters apply: the level of its visible
 * refs, whether that level rests only on estimates, which sources left a
 * "clear" stretch unchecked (a failed source, a stretch outside US coverage,
 * unrated avalanche terrain — missing data never reads as clear), and
 * whether hazards there are only hidden by filters.
 * Shared with the map so both draw the same thing.
 */
export const describeSegments = (result, hiddenTypes = NO_HIDDEN) => {
  if (!result?.segments) return [];
  const hazards = result.hazards || {};
  const status = (k) => result.sources?.[k]?.status;
  const [from, to] = result.window ? [result.window.start, result.window.end] : [0, Infinity];
  const expected = (k, seg) => status(k) !== 'skipped' && (OFFICIAL_KEYS.includes(k)
    || status(k) === 'error' || (seg.mileEnd > from && seg.mileStart < to));
  return result.segments.map((seg) => {
    const refs = hiddenTypes.size ? seg.refs.filter(r => !hiddenTypes.has(hazards[r.id]?.type)) : seg.refs;
    const filtered = refs.length !== seg.refs.length;
    const level = filtered ? refs.reduce((max, r) => Math.max(max, r.level), 0) : seg.level;
    const estimatedOnly = filtered
      ? level > 0 && refs.every(r => r.level < level || hazards[r.id]?.source === 'ESTIMATED')
      : seg.estimatedOnly;
    const unchecked = level === 0 ? SOURCE_KEYS.filter(k => expected(k, seg) && !seg.checked?.includes(k)) : [];
    const hiddenOnly = level === 0 && filtered && refs.length === 0;
    return { mileStart: seg.mileStart, mileEnd: seg.mileEnd, level, estimatedOnly, unchecked, hiddenOnly, refs };
  });
};

/** Consecutive segments that look the same, merged into one stretch. */
const mergeRuns = (views) => {
  const runs = [];
  for (const v of views) {
    const unchecked = v.unchecked.length > 0;
    const last = runs[runs.length - 1];
    if (last && last.level === v.level && last.estimatedOnly === v.estimatedOnly && last.unchecked === unchecked) {
      last.mileEnd = v.mileEnd;
    } else {
      runs.push({ mileStart: v.mileStart, mileEnd: v.mileEnd, level: v.level, estimatedOnly: v.estimatedOnly, unchecked });
    }
  }
  return runs;
};

const viewAt = (views, mile) => {
  let lo = 0;
  let hi = views.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (views[mid].mileStart <= mile) lo = mid; else hi = mid - 1;
  }
  return views[lo] || null;
};

/** The ref a hover readout names: highest level, official before estimated. */
const leadRef = (refs, hazards) => refs.reduce((best, r) => {
  if (!best || r.level > best.level) return r;
  const official = (ref) => hazards[ref.id]?.source === 'OFFICIAL';
  return r.level === best.level && official(r) && !official(best) ? r : best;
}, null);

/**
 * Total climb. Raw GPX/DEM elevations jitter between neighbouring points
 * (summing them overstates the JMT by ~45%), so resample every 0.05 mi,
 * smooth over ~0.15 mi, then ignore wiggles under CLIMB_NOISE_M.
 * Checked against the JMT sample: ~45,600 ft vs ~46,000–47,000 ft published.
 */
const CLIMB_STEP_MILES = 0.05;
const totalClimb = (coords, cum) => {
  const total = cum[cum.length - 1];
  const samples = [];
  let j = 0;
  for (let m = 0; m <= total; m += CLIMB_STEP_MILES) {
    while (j < coords.length - 2 && cum[j + 1] < m) j++;
    const a = coords[j][2];
    const b = coords[j + 1]?.[2];
    if (a == null || b == null) continue;
    const span = cum[j + 1] - cum[j];
    const t = span > 0 ? Math.min(1, Math.max(0, (m - cum[j]) / span)) : 0;
    samples.push(a + (b - a) * t);
  }
  let climb = 0;
  let anchor = null;
  for (let i = 0; i < samples.length; i++) {
    const lo = Math.max(0, i - 1);
    const hi = Math.min(samples.length - 1, i + 1);
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += samples[k];
    const e = sum / (hi - lo + 1);
    if (anchor == null || e < anchor - CLIMB_NOISE_M) anchor = e;
    else if (e > anchor + CLIMB_NOISE_M) { climb += e - anchor; anchor = e; }
  }
  return climb;
};

const elevationStats = ({ coords, cum }) => {
  let min = Infinity;
  let max = -Infinity;
  for (const c of coords) {
    const e = c[2];
    if (e == null) continue;
    if (e < min) min = e;
    if (e > max) max = e;
  }
  return min <= max ? { min, max, climb: totalClimb(coords, cum) } : null;
};

/** Vertex indices (in route order) of each pixel column's lowest and highest point. */
const decimate = ({ coords, cum, lengthMiles }, columns) => {
  const lo = new Float64Array(columns).fill(Infinity);
  const hi = new Float64Array(columns).fill(-Infinity);
  const loAt = new Int32Array(columns);
  const hiAt = new Int32Array(columns);
  const scale = columns / lengthMiles;
  for (let i = 0; i < coords.length; i++) {
    const e = coords[i][2];
    if (e == null) continue;
    const col = Math.min(columns - 1, Math.floor(cum[i] * scale));
    if (e < lo[col]) { lo[col] = e; loAt[col] = i; }
    if (e > hi[col]) { hi[col] = e; hiAt[col] = i; }
  }
  const out = [];
  for (let col = 0; col < columns; col++) {
    if (lo[col] === Infinity) continue;
    const first = Math.min(loAt[col], hiAt[col]);
    const second = Math.max(loAt[col], hiAt[col]);
    out.push(first);
    if (second !== first) out.push(second);
  }
  return out;
};

const niceStep = (raw) => {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};

export const createProfile = (container, { onHover, onSelect } = {}) => {
  const id = `rl-profile-${++instances}`;
  let route = null;
  let result = null;
  let hidden = NO_HIDDEN;
  let views = [];
  let stats = null;
  let hoverMile = null;
  let lastMile = null;
  let positionMile = null;
  let size = { w: 0, h: 0 };
  let geom = null;
  let decimated = null;
  let decimatedWidth = 0;
  const hatches = new Set();

  const readout = h('p', { class: 'rl-profile__readout', 'aria-hidden': 'true' });
  const chart = svg('svg', { class: 'rl-profile__svg', role: 'img' });
  const plot = h('div', {
    class: 'rl-profile__plot',
    role: 'slider',
    'aria-label': 'Position along the route',
    'aria-valuemin': '0',
  });
  container.classList.add('rl-profile');
  container.replaceChildren(readout, h('div', { class: 'rl-profile__frame' }, chart, plot));

  const defs = svg('defs');
  const layer = {
    terrain: svg('g'),
    band: svg('g', { 'shape-rendering': 'crispEdges' }),
    shade: svg('g'),
    axis: svg('g'),
    you: svg('g'),
    cursor: svg('g', { visibility: 'hidden' }),
  };
  const cursorLine = svg('line', { class: 'rl-profile__cursor' });
  const cursorDot = svg('circle', { class: 'rl-profile__cursor-dot', r: 3.5 });
  layer.cursor.append(cursorLine, cursorDot);
  defs.append(svg('linearGradient', { id: `${id}-fill`, x1: 0, y1: 0, x2: 0, y2: 1 },
    svg('stop', { class: 'rl-profile__stop', offset: 0, 'stop-opacity': 0.34 }),
    svg('stop', { class: 'rl-profile__stop', offset: 1, 'stop-opacity': 0.04 })));
  chart.append(defs, ...Object.values(layer));

  const xOf = (mile) => PAD_X + (mile / route.lengthMiles) * (size.w - 2 * PAD_X);
  const mileOfX = (x) => clamp(((x - PAD_X) / (size.w - 2 * PAD_X)) * route.lengthMiles, 0, route.lengthMiles);
  const elevationAt = (mile) => (stats ? pointAtMile(route.coords, route.cum, mile)[2] ?? null : null);

  const computeGeom = () => {
    const axisTop = size.h - AXIS;
    const bandTop = axisTop - BAND;
    const floor = bandTop - BAND_GAP;
    let y = () => floor;
    if (stats) {
      const lo = metersToFeet(stats.min);
      const hi = metersToFeet(stats.max);
      const span = Math.max(hi - lo, MIN_SPAN_FT);
      const mid = (lo + hi) / 2;
      // A little extra below so the low point doesn't sit on the band.
      const d0 = mid - span * 0.58;
      const d1 = mid + span * 0.5;
      y = (meters) => floor - ((metersToFeet(meters) - d0) / (d1 - d0)) * (floor - TOP);
    }
    return { axisTop, bandTop, floor, y };
  };

  const drawTerrain = () => {
    const g = layer.terrain;
    g.replaceChildren();
    if (!stats) {
      g.append(svg('text', { class: 'rl-profile__note', x: size.w / 2, y: (TOP + geom.floor) / 2 }, 'No elevation in this file'));
      return;
    }
    if (!decimated || decimatedWidth !== size.w) {
      decimated = decimate(route, Math.max(1, size.w));
      decimatedWidth = size.w;
    }
    const { coords, cum } = route;
    const pts = decimated.map(i => `${xOf(cum[i]).toFixed(1)},${geom.y(coords[i][2]).toFixed(1)}`);
    const first = xOf(cum[decimated[0]]).toFixed(1);
    const last = xOf(cum[decimated[decimated.length - 1]]).toFixed(1);
    const floor = geom.floor.toFixed(1);
    g.append(
      svg('path', { class: 'rl-profile__area', fill: `url(#${id}-fill)`, d: `M${first},${floor}L${pts.join('L')}L${last},${floor}Z` }),
      svg('path', { class: 'rl-profile__line', d: `M${pts.join('L')}` }),
    );
    drawElevationLabels(g);
  };

  const drawElevationLabels = (g) => {
    const yMax = geom.y(stats.max);
    const yMin = geom.y(stats.min);
    const guide = (y) => svg('line', { class: 'rl-profile__guide', x1: 0, x2: size.w, y1: y.toFixed(1), y2: y.toFixed(1) });
    const label = (y, text) => svg('text', { class: 'rl-profile__label', x: PAD_X + 2, y: (y - 4).toFixed(1) }, text);
    if (yMin - yMax < 18) {
      g.append(guide(yMax), label(yMax, `${feet(stats.min)}–${fmtElevation(stats.max)}`));
      return;
    }
    g.append(guide(yMax), guide(yMin), label(yMax, fmtElevation(stats.max)), label(yMin, fmtElevation(stats.min)));
  };

  const hatch = (level) => {
    const pid = `${id}-hatch-${level}`;
    if (!hatches.has(pid)) {
      const color = LEVELS[level].color;
      defs.append(svg('pattern', { id: pid, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
        svg('rect', { width: 6, height: 6, fill: color, 'fill-opacity': 0.3 }),
        svg('rect', { width: 3, height: 6, fill: color })));
      hatches.add(pid);
    }
    return `url(#${pid})`;
  };

  const bandFill = (run) => {
    if (run.unchecked) return { class: 'rl-profile__unchecked' };
    return { fill: run.estimatedOnly ? hatch(run.level) : LEVELS[run.level].color };
  };

  const drawBand = () => {
    const g = layer.band;
    g.replaceChildren();
    const y = geom.bandTop;
    if (!result) {
      g.append(
        svg('rect', { class: 'rl-profile__pending', x: 0, y, width: size.w, height: BAND }),
        svg('text', { class: 'rl-profile__band-label', x: size.w / 2, y: y + BAND / 2 }, 'Checking…'),
      );
      return;
    }
    // Severe stretches are drawn last so their minimum width overlaps neighbours, not the reverse.
    const runs = mergeRuns(views).sort((a, b) => a.level - b.level);
    for (const run of runs) {
      let x0 = clamp(xOf(run.mileStart), 0, size.w);
      let x1 = clamp(xOf(run.mileEnd), 0, size.w);
      if (run.level > 0 && x1 - x0 < MIN_BAND_PX) {
        const c = (x0 + x1) / 2;
        x0 = c - MIN_BAND_PX / 2;
        x1 = c + MIN_BAND_PX / 2;
      }
      g.append(svg('rect', { x: x0.toFixed(1), y, width: (x1 - x0).toFixed(1), height: BAND, ...bandFill(run) }));
    }
  };

  const drawShade = () => {
    const g = layer.shade;
    g.replaceChildren();
    const win = result?.window;
    if (!win) return;
    const x0 = clamp(xOf(win.start), 0, size.w);
    const x1 = clamp(xOf(win.end), 0, size.w);
    const rect = (x, width) => svg('rect', { class: 'rl-profile__shade', x, y: 0, width, height: geom.axisTop });
    if (x0 > 0) g.append(rect(0, x0.toFixed(1)));
    if (x1 < size.w) g.append(rect(x1.toFixed(1), (size.w - x1).toFixed(1)));
  };

  const drawAxis = () => {
    const g = layer.axis;
    g.replaceChildren();
    const length = route.lengthMiles;
    // fmtMile shows tenths, so finer steps would repeat labels on very short routes.
    const step = Math.max(0.1, niceStep((length * TICK_SPACING_PX) / size.w));
    const baseline = size.h - 4;
    const tick = (x) => svg('line', { class: 'rl-profile__tick', x1: x, x2: x, y1: geom.axisTop, y2: geom.axisTop + 4 });
    for (let k = 0; k * step < length; k++) {
      const x = xOf(k * step);
      if (x > size.w - 56) break; // leave room for the total-length label
      g.append(tick(x.toFixed(1)), svg('text', {
        class: 'rl-profile__label', x: x.toFixed(1), y: baseline, 'text-anchor': k === 0 ? 'start' : 'middle',
      }, fmtMile(k * step)));
    }
    g.append(svg('text', { class: 'rl-profile__label', x: size.w - PAD_X, y: baseline, 'text-anchor': 'end' }, `${fmtMile(length)} mi`));
  };

  const markerY = (mile) => {
    const e = elevationAt(mile);
    return e == null ? geom.bandTop + BAND / 2 : geom.y(e);
  };

  const drawPosition = () => {
    const g = layer.you;
    g.replaceChildren();
    if (positionMile == null) return;
    const x = xOf(clamp(positionMile, 0, route.lengthMiles)).toFixed(1);
    g.append(
      svg('line', { class: 'rl-profile__you-line', x1: x, x2: x, y1: TOP - 6, y2: geom.axisTop }),
      svg('circle', { class: 'rl-profile__you', cx: x, cy: markerY(positionMile).toFixed(1), r: 5 }),
    );
  };

  const drawCursor = () => {
    if (!geom || hoverMile == null) {
      layer.cursor.setAttribute('visibility', 'hidden');
      return;
    }
    const x = xOf(hoverMile).toFixed(1);
    for (const [k, v] of Object.entries({ x1: x, x2: x, y1: TOP - 6, y2: geom.axisTop })) cursorLine.setAttribute(k, v);
    cursorDot.setAttribute('cx', x);
    cursorDot.setAttribute('cy', markerY(hoverMile).toFixed(1));
    layer.cursor.setAttribute('visibility', 'visible');
  };

  const hazardAt = (mile) => {
    if (!result) return 'Checking…';
    const v = viewAt(views, mile);
    if (v && v.level > 0) {
      const lead = leadRef(v.refs, result.hazards || {});
      const title = result.hazards?.[lead?.id]?.title || lead?.note || 'Reported hazard';
      const others = new Set(v.refs.map(r => r.id)).size - 1;
      const estimate = v.estimatedOnly ? ' (estimate)' : '';
      const word = result.hazards?.[lead?.id]?.levelLabel || LEVELS[v.level].short;
      return `${word}${estimate}: ${title}${others > 0 ? ` +${others} more` : ''}`;
    }
    if (v?.unchecked.length) return `Not checked: ${v.unchecked.map(k => SOURCE_LABELS[k]).join(', ')}`;
    if (v?.hiddenOnly) return 'Hazards hidden by filters';
    return 'No reported hazards';
  };

  const describeMile = (mile) => {
    const parts = [`Mi ${fmtMile(mile)}`];
    const e = elevationAt(mile);
    if (e != null) parts.push(fmtElevation(e));
    parts.push(hazardAt(mile));
    return parts.join(', ');
  };

  const routeFacts = () => {
    const parts = [`${fmtMile(route.lengthMiles)} mi`];
    if (stats) parts.push(`${feet(stats.min)}–${fmtElevation(stats.max)}`, `about ${(Math.round(metersToFeet(stats.climb) / 100) * 100).toLocaleString('en-US')} ft of climbing`);
    return parts.join(', ');
  };

  const hazardSummary = () => {
    if (!result) return 'Hazards are still being checked.';
    const runs = mergeRuns(views).filter(r => r.level > 0);
    const hiddenNote = views.some(v => v.hiddenOnly) ? ' Some hazards are hidden by filters.' : '';
    if (!runs.length) {
      return (views.some(v => v.unchecked.length)
        ? 'No reported hazards, but some stretches could not be checked.'
        : 'No reported hazards.') + hiddenNote;
    }
    const listed = [...runs]
      .sort((a, b) => b.level - a.level || a.mileStart - b.mileStart)
      .slice(0, SUMMARY_STRETCHES)
      .map(r => `${LEVELS[r.level].short}${r.estimatedOnly ? ' (estimate)' : ''} at ${fmtStretch(r.mileStart, r.mileEnd)}`);
    const rest = runs.length - listed.length;
    return `${listed.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}.${hiddenNote}`;
  };

  const updateSummary = () => {
    if (!route) {
      chart.setAttribute('aria-label', 'Elevation profile. No route loaded.');
      return;
    }
    const terrain = stats ? `, ${feet(stats.min)} to ${fmtElevation(stats.max)}` : ', no elevation in this file';
    const you = positionMile != null ? ` You are at Mi ${fmtMile(positionMile)}.` : '';
    chart.setAttribute('aria-label',
      `Elevation and hazards along ${route.name}: ${fmtMile(route.lengthMiles)} mi${terrain}. ${hazardSummary()}${you}`);
  };

  const updateReadout = () => {
    readout.textContent = route ? (hoverMile != null ? describeMile(hoverMile) : routeFacts()) : '';
    readout.classList.toggle('rl-profile__readout--active', hoverMile != null);
    const now = hoverMile ?? positionMile ?? 0;
    plot.setAttribute('aria-valuemax', route ? round1(route.lengthMiles) : 0);
    plot.setAttribute('aria-valuenow', round1(now));
    plot.setAttribute('aria-valuetext', route ? describeMile(now) : 'No route loaded');
  };

  const drawAll = () => {
    chart.setAttribute('width', size.w);
    chart.setAttribute('height', size.h);
    chart.setAttribute('viewBox', `0 0 ${size.w} ${size.h}`);
    geom = route && size.w > 0 && size.h > 0 ? computeGeom() : null;
    if (geom) {
      drawTerrain();
      drawBand();
      drawShade();
      drawAxis();
      drawPosition();
    } else {
      for (const g of [layer.terrain, layer.band, layer.shade, layer.axis, layer.you]) g.replaceChildren();
    }
    drawCursor();
    updateSummary();
    updateReadout();
  };

  const hover = (mile, notify) => {
    const next = mile == null || !route ? null : clamp(mile, 0, route.lengthMiles);
    if (next === hoverMile) return;
    hoverMile = next;
    if (next != null) lastMile = next;
    drawCursor();
    updateReadout();
    if (notify) onHover?.(next);
  };

  const mileAt = (event) => mileOfX(event.clientX - plot.getBoundingClientRect().left);
  const interactive = () => route && size.w > 0;

  const onPointer = (event) => {
    if (interactive()) hover(mileAt(event), true);
  };

  const onKey = (event) => {
    if (!route) return;
    const length = route.lengthMiles;
    const current = hoverMile ?? lastMile ?? positionMile ?? 0;
    const small = length * (event.shiftKey ? KEY_STEP_LARGE : KEY_STEP);
    const moves = {
      ArrowRight: current + small,
      ArrowUp: current + small,
      ArrowLeft: current - small,
      ArrowDown: current - small,
      PageUp: current + length * KEY_STEP_LARGE,
      PageDown: current - length * KEY_STEP_LARGE,
      Home: 0,
      End: length,
    };
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect?.(current);
      return;
    }
    if (!(event.key in moves)) return;
    event.preventDefault();
    hover(moves[event.key], true);
  };

  plot.addEventListener('pointerdown', onPointer);
  plot.addEventListener('pointermove', onPointer);
  plot.addEventListener('pointerleave', (event) => {
    // Touch readouts stay put after a tap so the hiker can read them.
    if (event.pointerType === 'mouse') hover(null, true);
  });
  plot.addEventListener('click', (event) => {
    if (interactive()) onSelect?.(mileAt(event));
  });
  plot.addEventListener('keydown', onKey);
  plot.addEventListener('focus', () => {
    if (route) hover(hoverMile ?? lastMile ?? positionMile ?? 0, true);
  });
  plot.addEventListener('blur', () => hover(null, true));

  new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    const hgt = Math.round(entry.contentRect.height);
    if (w === size.w && hgt === size.h) return;
    size = { w, h: hgt };
    drawAll();
  }).observe(plot.parentElement);

  const setInteractive = () => {
    plot.tabIndex = route ? 0 : -1;
    plot.setAttribute('aria-disabled', String(!route));
  };
  setInteractive();
  updateSummary();
  updateReadout();

  return {
    /** result may be null while the analysis is pending. */
    render(routeData, analysis) {
      if (routeData?.id !== route?.id) {
        hoverMile = null;
        lastMile = null;
      }
      // The same track can come back with different elevation data, so caches follow the object, not the id.
      if (routeData !== route) {
        decimated = null;
        stats = routeData?.hasElevation ? elevationStats(routeData) : null;
      }
      route = routeData || null;
      result = route ? analysis || null : null;
      views = describeSegments(result, hidden);
      setInteractive();
      drawAll();
    },

    setHover(mile) {
      hover(Number.isFinite(mile) ? mile : null, false);
    },

    setPosition(mile) {
      const next = Number.isFinite(mile) ? mile : null;
      if (next === positionMile) return;
      positionMile = next;
      if (geom) drawPosition();
      updateSummary();
      updateReadout();
    },

    setFilters(hiddenTypes) {
      hidden = hiddenTypes || NO_HIDDEN;
      views = describeSegments(result, hidden);
      if (geom) drawBand();
      updateSummary();
      updateReadout();
    },
  };
};
