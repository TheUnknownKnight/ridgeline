/**
 * The two-second answer: a level-colored plaque with one plain sentence,
 * counts and freshness, plus (On trail) where the hiker is and what's next.
 * Also the On trail controls: GPS status, manual position and look-ahead.
 */
import { h, mount } from '../ui/dom.js';
import { fmtMile, fmtDistance, fmtAgo, metersToFeet } from '../ui/format.js';
import { LEVELS, levelInfo, SOURCE_LABELS } from '../../../shared/levels.js';
import {
  icon, textOnLevel, joinList, lowerFirst, changeDetector, remount, fmtLength, fmtTotal, fmtPosition, fmtTimeOfDay,
} from './common.js';

export const LOOKAHEAD_STEPS = [5, 10, 15, 20, 25, 30, 40, 50];

const OLD_RESULT_MS = 6 * 60 * 60 * 1000;
const OFF_ROUTE_WARN_MILES = 0.5;
const NOW_MILES = 0.05;

const STATUS_PHRASE = { error: 'unavailable', stale: 'using older data', partial: 'only partly loaded' };

const countsText = (counts = {}) => [4, 3, 2, 1]
  .filter(level => counts[level] > 0)
  .map(level => `${counts[level]} ${LEVELS[level].label.toLowerCase()}`)
  .join(', ');

const topRef = (refs) => refs.reduce((best, r) => (!best || r.level > best.level ? r : best), null);

const nextFrom = (result, segments, mile) => {
  const seg = segments.find(s => !(s.estimatedOnly && s.level < 2)) || segments[0];
  if (!seg) return null;
  const ref = topRef(seg.refs);
  return {
    id: ref.id,
    level: ref.level,
    title: result.hazards[ref.id]?.title || ref.note || 'Reported hazard',
    mile: Math.max(seg.mileStart, mile),
    milesAhead: Math.max(0, seg.mileStart - mile),
  };
};

/**
 * First hazard at or beyond `mile`, from the live position rather than the
 * last analysis. Like the server: a low-level estimate is skipped when
 * anything else lies ahead, but an official notice always counts.
 */
const nextHazardAhead = (result, mile) =>
  nextFrom(result, result.segments.filter(s => s.level > 0 && s.mileEnd > mile && s.refs.length), mile);

/** Severity, counts and a headline for what's still ahead of the hiker (On trail). */
export const aheadView = (result, mile) => {
  const best = new Map();
  for (const s of result.segments) {
    if (s.mileEnd <= mile) continue;
    for (const r of s.refs) best.set(r.id, Math.max(best.get(r.id) || 0, r.level));
  }
  const level = Math.max(0, ...best.values());
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const l of best.values()) if (l >= 1) counts[l]++;
  if (!level) {
    // The server's headline names the worst hazard on the whole route, which may be behind
    // the hiker; it only describes "nothing ahead" when the route has no hazards at all.
    let headline = 'Nothing reported ahead on this route';
    if (result.summary.incomplete) {
      headline = Object.keys(result.hazards).length ? 'Nothing reported ahead, but some data is missing' : result.summary.headline;
    }
    return { level, headline, counts, incomplete: result.summary.incomplete };
  }
  // Name the worst thing ahead and how far away it starts.
  const worstId = [...best].sort((a, b) => b[1] - a[1])[0][0];
  // Measure to where it is at its worst, so the distance matches the title and color.
  const where = result.segments.filter(s => s.mileEnd > mile && s.refs.some(r => r.id === worstId && r.level === best.get(worstId)));
  const milesAhead = Math.max(0, where[0].mileStart - mile);
  const title = result.hazards[worstId]?.title || 'Reported hazard';
  const headline = milesAhead < NOW_MILES ? `${title}, here now` : `${title}, ${fmtDistance(milesAhead)} ahead`;
  return { level, levelLabel: result.hazards[worstId]?.levelLabel ?? null, headline, counts, incomplete: result.summary.incomplete };
};

const pendingPlaque = (route, failed) => h('div', { class: 'plaque plaque-pending' },
  h('p', { class: 'plaque-level' }, failed ? 'Not checked' : 'Checking your route'),
  h('p', { class: 'plaque-headline' }, failed
    ? 'Ridgeline has no data for this route yet, so there is no verdict. Missing data is not an all-clear.'
    : `Looking up wildfires, alerts, avalanche forecasts, river gauges, air quality, smoke, weather and trail conditions along ${fmtLength(route.lengthMiles)}.`));

/** view = { level, headline, counts, incomplete } — whole route (Plan) or what's ahead (On trail). */
const resultPlaque = (view) => {
  const info = levelInfo(view.level);
  // A "clear" built on missing data must not look green.
  if (info.level === 0 && view.incomplete) {
    return h('div', { class: 'plaque plaque-pending' },
      h('p', { class: 'plaque-level' }, 'Incomplete'),
      h('p', { class: 'plaque-headline' }, view.headline));
  }
  return h('div', { class: `plaque plaque-${info.key}`, style: `background:${info.color};color:${textOnLevel(info.level)}` },
    h('p', { class: 'plaque-level' }, view.levelLabel || info.short),
    h('p', { class: 'plaque-headline' }, view.headline));
};

const metaLine = (result, view, { busy, now }) => {
  const generated = Date.parse(result?.generatedAt);
  const old = Number.isFinite(generated) && now - generated > OLD_RESULT_MS;
  const counts = view ? countsText(view.counts) : '';
  return h('div', { class: 'verdict-meta' },
    h('span', { class: 'verdict-counts' }, counts || (result ? 'Nothing reported' : '')),
    h('span', { class: `verdict-time${old ? ' is-old' : ''}` },
      old ? icon('stale') : null,
      result ? `Checked ${fmtAgo(generated, now)}` : null,
      busy ? h('span', { class: 'updating' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), result ? 'Updating…' : 'Checking…') : null));
};

const waitingText = (state) => ({
  acquiring: 'Waiting for a GPS fix…',
  denied: 'Position unknown — location access is off',
  unavailable: 'Position unknown — no GPS fix',
}[state] || 'Position unknown');

const nextLine = (next, lookaheadMiles, onSelectHazard, { incomplete = false, stale = false } = {}) => {
  if (!next) {
    // Green only when the check was complete, like the plaque.
    return incomplete
      ? h('p', { class: 'next-hazard' }, 'Nothing found ahead in the data Ridgeline could reach')
      : h('p', { class: 'next-hazard is-clear' }, 'Nothing reported ahead');
  }
  const select = () => onSelectHazard?.(next.id);
  const swatch = h('span', { class: 'swatch', style: `--swatch:${levelInfo(next.level).color}`, 'aria-hidden': 'true' });
  if (next.milesAhead > lookaheadMiles) {
    return h('div', { class: 'next-hazard' },
      h('p', {}, `Nothing reported in the next ${lookaheadMiles} mi`),
      h('button', { type: 'button', class: 'link-button next-later', 'data-focus-key': 'next', onclick: select },
        `Next: ${next.title} at Mi ${fmtMile(next.mile)}`));
  }
  let text = next.milesAhead < NOW_MILES ? `Now: ${next.title}` : `Next: ${next.title} in ${fmtDistance(next.milesAhead)}`;
  if (stale) text = next.milesAhead < NOW_MILES ? `At your last fix: ${next.title}` : `Next: ${next.title}, ${fmtDistance(next.milesAhead)} past your last fix`;
  return h('button', { type: 'button', class: 'next-hazard next-button', 'data-focus-key': 'next', onclick: select },
    swatch, h('span', {}, text), icon('arrow'));
};

/** Daylight at the hiker's position — the server computes it for the analyzed point. */
const daylightLine = (result, now) => {
  const d = result?.daylight;
  if (!d || d.at !== 'position') return null;
  const tz = result.route?.timeZone;
  const future = (iso) => Date.parse(iso) > now;
  let text = null;
  if (d.isDaylight && future(d.sunset)) {
    text = `Sunset ${fmtTimeOfDay(d.sunset, tz)}${future(d.civilDusk) ? `, last light ${fmtTimeOfDay(d.civilDusk, tz)}` : ''}`;
  } else if (!d.isDaylight) {
    text = future(d.sunrise) ? `After dark, sunrise ${fmtTimeOfDay(d.sunrise, tz)}` : 'After dark';
  }
  return text ? h('p', { class: 'daylight' }, text) : null;
};

const trailLine = ({ result, gps, route, lookaheadMiles, now }, onSelectHazard) => {
  if (gps.mile == null) {
    return h('div', { class: 'verdict-trail' }, h('p', { class: 'trail-mile is-unknown' }, waitingText(gps.state)));
  }
  // An old fix must not read as where the hiker is now.
  const stale = gps.state === 'stale';
  return h('div', { class: 'verdict-trail' },
    h('p', { class: `trail-mile${stale ? ' is-stale' : ''}` },
      stale ? 'Last fix: ' : null,
      h('span', { class: 'trail-mile-value' }, `Mile ${fmtPosition(gps.mile)}`),
      ` of ${fmtTotal(route.lengthMiles)}`,
      stale && gps.fix?.timestamp ? `, ${fmtAgo(gps.fix.timestamp, now)}` : null),
    result ? nextLine(nextHazardAhead(result, gps.mile), lookaheadMiles, onSelectHazard, { incomplete: result.summary.incomplete, stale }) : null,
    daylightLine(result, now));
};

const incompleteNote = (result, onShowSources) => {
  const keys = result?.summary?.incompleteSources || [];
  if (!result?.summary?.incomplete || !keys.length) return null;
  const parts = keys.map((key, i) => {
    const label = SOURCE_LABELS[key] || key;
    return `${i === 0 ? label : lowerFirst(label)} ${STATUS_PHRASE[result.sources[key]?.status] || 'unavailable'}`;
  });
  return h('div', { class: 'verdict-note', role: 'note' },
    icon('warning'),
    h('p', {},
      `${joinList(parts)}. Treat that data as unknown, not clear. `,
      h('button', { type: 'button', class: 'link-button', 'data-focus-key': 'sources', onclick: onShowSources }, 'See data sources')));
};

/** What the server could not check (outside US coverage, unrated avalanche terrain, forecast scope). */
const caveatNotes = (result) => {
  const caveats = result?.summary?.caveats || [];
  if (!caveats.length) return null;
  return h('ul', { class: 'verdict-caveats' }, caveats.map(text => h('li', {}, text)));
};

/**
 * createVerdict({ plaque, notes }, { onSelectHazard(id), onShowSources() })
 *   .render({ route, result, mode, gps, busy, failed, lookaheadMiles, now })
 * `plaque` is the sticky block; `notes` sits just below it and scrolls away.
 */
export const createVerdict = ({ plaque, notes }, { onSelectHazard, onShowSources } = {}) => {
  const plaqueChanged = changeDetector();
  const notesChanged = changeDetector();

  const render = ({ route, result, mode, gps, busy, failed, lookaheadMiles, now }) => {
    const onTrail = mode === 'on-trail';
    const staleAgo = gps.state === 'stale' && gps.fix?.timestamp ? fmtAgo(gps.fix.timestamp, now) : '';
    const mileKey = onTrail && gps.mile != null ? `${fmtPosition(gps.mile)}|${gps.state}|${staleAgo}` : gps.state;
    const ago = result ? fmtAgo(Date.parse(result.generatedAt), now) : '';
    if (plaqueChanged([route, result, onTrail, mileKey, busy, failed, lookaheadMiles, ago])) {
      const view = !result ? null
        : onTrail && gps.mile != null ? aheadView(result, gps.mile)
          : { level: result.summary.level, levelLabel: result.summary.levelLabel, headline: result.summary.headline, counts: result.summary.counts, incomplete: result.summary.incomplete };
      remount(plaque,
        view ? resultPlaque(view) : pendingPlaque(route, failed),
        metaLine(result, view, { busy, now }),
        onTrail ? trailLine({ result, gps, route, lookaheadMiles, now }, onSelectHazard) : null);
    }
    if (notesChanged([result])) remount(notes, incompleteNote(result, onShowSources), caveatNotes(result));
  };

  return { render };
};

const accuracyText = (meters) => {
  if (!Number.isFinite(meters)) return '';
  const feet = metersToFeet(meters);
  return feet < 5280 ? `, accurate to ${Math.round(feet).toLocaleString('en-US')} ft` : `, accurate to ${(feet / 5280).toFixed(1)} mi`;
};

const gpsText = (gps, now) => {
  switch (gps.state) {
    case 'acquiring': return 'Acquiring GPS…';
    case 'live': return `GPS live${accuracyText(gps.fix?.accuracyMeters)}`;
    case 'stale': return `GPS signal lost, last fix ${fmtAgo(gps.fix?.timestamp, now)}`;
    case 'denied': return 'Location access is off for this site. Allow it in your browser settings, or set your position yourself.';
    case 'unavailable': return "Can't get a GPS fix. Set your position on the map or enter your trail mile.";
    case 'manual': return 'Using the position you set';
    default: return 'GPS is off';
  }
};

/**
 * createTrailStatus(container, { onTogglePick(), onRetryGps(), onUseGps(), onSetMile(mile), onLookahead(miles) })
 *   .render({ route, gps, pickMode, lookaheadMiles, now })
 * Built once and updated in place: GPS fixes arrive every second and must not
 * steal focus from the stepper or the mile field.
 */
export const createTrailStatus = (container, handlers = {}) => {
  const gpsLabel = h('span', { class: 'gps-text' });
  const gpsLine = h('p', { class: 'gps-line' }, h('span', { class: 'gps-dot', 'aria-hidden': 'true' }), gpsLabel);
  const offRouteText = h('span');
  const offRoute = h('p', { class: 'offroute', hidden: true }, icon('warning'), offRouteText);

  const pickButton = h('button', { type: 'button', class: 'btn', 'aria-pressed': 'false', onclick: () => handlers.onTogglePick?.() },
    icon('pin'), 'Set my position on the map');
  const gpsButton = h('button', { type: 'button', class: 'btn btn-quiet', hidden: true }, icon('locate'), h('span'));

  const mileInput = h('input', { id: 'mile-input', class: 'input', type: 'number', inputmode: 'decimal', min: '0', step: '0.1', 'aria-describedby': 'mile-error' });
  const mileError = h('p', { id: 'mile-error', class: 'field-error', role: 'alert', hidden: true });
  const mileLabel = h('label', { for: 'mile-input', class: 'field-label' }, 'Or enter your trail mile');
  const mileForm = h('form', { class: 'mile-form', novalidate: true },
    mileLabel,
    h('div', { class: 'field-row' }, mileInput, h('button', { type: 'submit', class: 'btn' }, 'Set mile')),
    mileError);

  const lessButton = h('button', { type: 'button', class: 'stepper-button', 'aria-label': 'Look ahead less' }, icon('minus'));
  const moreButton = h('button', { type: 'button', class: 'stepper-button', 'aria-label': 'Look ahead farther' }, icon('plus'));
  const lookaheadValue = h('output', { class: 'stepper-value', 'aria-live': 'polite' });
  const lookahead = h('div', { class: 'lookahead' },
    h('span', { id: 'lookahead-label', class: 'field-label' }, 'Look ahead'),
    h('div', { class: 'stepper', role: 'group', 'aria-labelledby': 'lookahead-label' }, lessButton, lookaheadValue, moreButton));

  mount(container, gpsLine, offRoute, h('div', { class: 'trail-actions' }, pickButton, gpsButton), mileForm, lookahead);

  let state = { lookaheadMiles: 15, route: null };

  const step = (dir) => {
    const i = LOOKAHEAD_STEPS.indexOf(state.lookaheadMiles);
    const next = LOOKAHEAD_STEPS[Math.min(LOOKAHEAD_STEPS.length - 1, Math.max(0, (i < 0 ? 2 : i) + dir))];
    if (next !== state.lookaheadMiles) handlers.onLookahead?.(next);
  };
  lessButton.addEventListener('click', () => step(-1));
  moreButton.addEventListener('click', () => step(1));

  gpsButton.addEventListener('click', () => (gpsButton.dataset.action === 'manual' ? handlers.onUseGps?.() : handlers.onRetryGps?.()));

  mileForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const total = state.route?.lengthMiles ?? 0;
    const mile = Number(mileInput.value);
    const valid = mileInput.value.trim() !== '' && Number.isFinite(mile) && mile >= 0 && mile <= total;
    mileError.hidden = valid;
    mileInput.setAttribute('aria-invalid', String(!valid));
    if (!valid) {
      mileError.textContent = `Enter a mile from 0 to ${fmtTotal(total)}.`;
      mileInput.focus();
      return;
    }
    handlers.onSetMile?.(mile);
    mileInput.value = '';
  });

  const render = ({ route, gps, pickMode, lookaheadMiles, now }) => {
    state = { route, lookaheadMiles };
    container.dataset.gps = gps.state;
    gpsLabel.textContent = gpsText(gps, now);

    const off = gps.offRouteMiles;
    offRoute.hidden = !(off > OFF_ROUTE_WARN_MILES);
    if (!offRoute.hidden) offRouteText.textContent = `You're ${fmtDistance(off)} from the route — mileage ahead may be wrong.`;

    pickButton.setAttribute('aria-pressed', String(Boolean(pickMode)));
    const manual = gps.state === 'manual';
    const retry = gps.state === 'denied' || gps.state === 'unavailable';
    gpsButton.hidden = !(manual || retry);
    gpsButton.dataset.action = manual ? 'manual' : 'retry';
    gpsButton.lastChild.textContent = manual ? 'Use GPS again' : 'Try GPS again';

    // Live GPS can land on the wrong pass of an out-and-back; a typed mile corrects it.
    mileLabel.textContent = gps.state === 'live' ? 'Wrong mile? Enter your trail mile' : 'Or enter your trail mile';
    mileInput.max = route ? String(Math.round(route.lengthMiles * 10) / 10) : '';

    lookaheadValue.textContent = `${lookaheadMiles} mi`;
    lessButton.setAttribute('aria-disabled', String(lookaheadMiles <= LOOKAHEAD_STEPS[0]));
    moreButton.setAttribute('aria-disabled', String(lookaheadMiles >= LOOKAHEAD_STEPS[LOOKAHEAD_STEPS.length - 1]));
  };

  return { render };
};
