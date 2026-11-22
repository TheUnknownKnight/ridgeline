/**
 * The two-second answer: a level-colored plaque with one plain sentence,
 * counts and freshness, plus (On trail) where the hiker is, offline progress,
 * local solar daylight, and what's next.
 * Also the On trail controls: GPS status, copyable coordinates, wake-lock,
 * and collapsible manual position / look-ahead tools.
 */
import { h, mount } from '../ui/dom.js';
import { fmtMile, fmtDistance, fmtAgo, metersToFeet, plural } from '../ui/format.js';
import { LEVELS, levelInfo, SOURCE_LABELS } from '../../../shared/levels.js';
import {
  computeTrailProgress, computeOfflineDaylight, fmtDurationMinutes,
  formatCoordsDisplay, formatCoordsCopy,
} from '../offline/trailMath.js';
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

const leadHazardId = (result) => {
  const list = Object.values(result?.hazards || {});
  if (!list.length) return null;
  list.sort((a, b) =>
    b.level - a.level ||
    (a.source === 'OFFICIAL' ? 0 : 1) - (b.source === 'OFFICIAL' ? 0 : 1) ||
    (a.ranges?.[0]?.[0] ?? Infinity) - (b.ranges?.[0]?.[0] ?? Infinity));
  return list[0]?.id ?? null;
};

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
export const nextHazardAhead = (result, mile) =>
  nextFrom(result, (result?.segments || []).filter(s => s.level > 0 && s.mileEnd > mile && s.refs.length), mile);

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
    return { level, headline, counts, incomplete: result.summary.incomplete, leadId: null };
  }
  // Name the worst thing ahead and how far away it starts.
  const worstId = [...best].sort((a, b) => b[1] - a[1])[0][0];
  // Measure to where it is at its worst, so the distance matches the title and color.
  const where = result.segments.filter(s => s.mileEnd > mile && s.refs.some(r => r.id === worstId && r.level === best.get(worstId)));
  const milesAhead = Math.max(0, where[0].mileStart - mile);
  const title = result.hazards[worstId]?.title || 'Reported hazard';
  const headline = milesAhead < NOW_MILES ? `${title}, here now` : `${title}, ${fmtDistance(milesAhead)} ahead`;
  return { level, levelLabel: result.hazards[worstId]?.levelLabel ?? null, headline, counts, incomplete: result.summary.incomplete, leadId: worstId };
};

const pendingPlaque = (route, failed, online) => h('div', { class: 'plaque plaque-pending' },
  h('p', { class: 'plaque-level' }, !online ? 'Offline' : failed ? 'Not checked' : 'Checking your route'),
  h('p', { class: 'plaque-headline' }, !online
    ? 'No saved hazard check on this device yet. GPS tracking, elevation left and daylight still work offline.'
    : failed
      ? 'Ridgeline has no data for this route yet, so there is no verdict. Missing data is not an all-clear.'
      : `Looking up wildfires, alerts, avalanche forecasts, river gauges, air quality, smoke, weather and trail conditions along ${fmtLength(route.lengthMiles)}.`));

/** view = { level, headline, counts, incomplete, leadId } — whole route (Plan) or what's ahead (On trail). */
const resultPlaque = (view, onSelectHazard) => {
  const info = levelInfo(view.level);
  // A "clear" built on missing data must not look green.
  if (info.level === 0 && view.incomplete) {
    return h('div', { class: 'plaque plaque-pending' },
      h('p', { class: 'plaque-level' }, 'Incomplete'),
      h('p', { class: 'plaque-headline' }, view.headline));
  }
  const style = `background:${info.color};color:${textOnLevel(info.level)}`;
  if (info.level > 0 && view.leadId && onSelectHazard) {
    return h('button', {
      type: 'button',
      class: `plaque plaque-${info.key} plaque-button`,
      style,
      'data-focus-key': 'plaque-lead',
      onclick: () => onSelectHazard(view.leadId),
    },
    h('span', { class: 'plaque-level' }, view.levelLabel || info.short),
    h('span', { class: 'plaque-headline' }, view.headline),
    h('span', { class: 'plaque-cta' }, h('span', {}, 'Show on map'), icon('arrow')));
  }
  return h('div', { class: `plaque plaque-${info.key}`, style },
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

/** Daylight at the hiker's position — computed locally via shared/sun.js so it works 100% offline. */
const daylightLine = ({ route, result, gps, now }) => {
  const local = computeOfflineDaylight(now, { route, mile: gps?.mile, gpsFix: gps?.fix });
  const d = local || (result?.daylight?.at === 'position' ? result.daylight : null);
  if (!d) return null;
  const tz = result?.route?.timeZone;
  const future = (iso) => iso && Date.parse(iso) > now;
  const left = fmtDurationMinutes(d.remainingMin);
  let text = null;
  if (d.isDaylight && future(d.sunset)) {
    const bits = [
      left ? `${left} daylight left` : null,
      `sunset ${fmtTimeOfDay(d.sunset, tz)}`,
      future(d.civilDusk) ? `last light ${fmtTimeOfDay(d.civilDusk, tz)}` : null,
    ].filter(Boolean);
    text = bits[0].charAt(0).toUpperCase() + bits[0].slice(1) + (bits.length > 1 ? `, ${bits.slice(1).join(', ')}` : '');
  } else if (!d.isDaylight) {
    text = future(d.sunrise)
      ? `After dark, sunrise ${fmtTimeOfDay(d.sunrise, tz)}${left ? ` (in ${left})` : ''}`
      : 'After dark';
  }
  return text ? h('p', { class: 'daylight' }, icon('sun'), h('span', {}, text)) : null;
};

const fmtFt = (n) => Math.round(n).toLocaleString('en-US');

const progressTelemetry = (progress) => {
  if (!progress) return null;
  const bits = [`${fmtTotal(progress.milesLeft)} mi left`];
  if (Number.isFinite(progress.currentElevFt)) bits.push(`elev ${fmtFt(progress.currentElevFt)} ft`);
  if (Number.isFinite(progress.gainAheadFt) && Number.isFinite(progress.lossAheadFt)) {
    bits.push(`+${fmtFt(progress.gainAheadFt)} / −${fmtFt(progress.lossAheadFt)} ft ahead`);
  }
  return h('div', { class: 'trail-progress' },
    h('div', { class: 'trail-progress-track', 'aria-hidden': 'true' },
      h('div', { class: 'trail-progress-fill', style: `width:${progress.pctComplete}%` })),
    h('p', { class: 'trail-stats' }, bits.join(', ')));
};

const trailLine = ({ result, gps, route, lookaheadMiles, now }, onSelectHazard) => {
  if (gps.mile == null) {
    return h('div', { class: 'verdict-trail' },
      h('p', { class: 'trail-mile is-unknown' }, waitingText(gps.state)),
      daylightLine({ route, result, gps, now }));
  }
  // An old fix must not read as where the hiker is now.
  const stale = gps.state === 'stale';
  const progress = computeTrailProgress(route, gps.mile, gps.fix);
  return h('div', { class: 'verdict-trail' },
    h('p', { class: `trail-mile${stale ? ' is-stale' : ''}` },
      stale ? 'Last fix: ' : null,
      h('span', { class: 'trail-mile-value' }, `Mile ${fmtPosition(gps.mile)}`),
      ` of ${fmtTotal(route.lengthMiles)}`,
      stale && gps.fix?.timestamp ? `, ${fmtAgo(gps.fix.timestamp, now)}` : null),
    progressTelemetry(progress),
    result ? nextLine(nextHazardAhead(result, gps.mile), lookaheadMiles, onSelectHazard, { incomplete: result.summary.incomplete, stale }) : null,
    daylightLine({ route, result, gps, now }));
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

export const caveatsSummaryLabel = (caveats = []) => (caveats.length ? plural(caveats.length, 'coverage note') : '');

/** What the server could not check (outside US coverage, unrated avalanche terrain, forecast scope). */
const caveatNotes = (result) => {
  const caveats = result?.summary?.caveats || [];
  if (!caveats.length) return null;
  return h('details', { class: 'verdict-caveats-fold', 'data-open-key': 'verdict-caveats' },
    h('summary', {}, icon('info'), h('span', {}, caveatsSummaryLabel(caveats)), icon('chevron')),
    h('ul', { class: 'verdict-caveats' }, caveats.map(text => h('li', {}, text))));
};

/**
 * createVerdict({ plaque, notes }, { onSelectHazard(id), onShowSources() })
 *   .render({ route, result, mode, gps, busy, failed, online, lookaheadMiles, now })
 * `plaque` holds the verdict and live On-trail HUD; `notes` sits just below it.
 */
export const createVerdict = ({ plaque, notes }, { onSelectHazard, onShowSources } = {}) => {
  const plaqueChanged = changeDetector();
  const notesChanged = changeDetector();

  const render = ({ route, result, mode, gps, busy, failed, online = true, lookaheadMiles, now }) => {
    const onTrail = mode === 'on-trail';
    const staleAgo = gps.state === 'stale' && gps.fix?.timestamp ? fmtAgo(gps.fix.timestamp, now) : '';
    const altKey = Number.isFinite(gps.fix?.altitudeMeters) ? Math.round(gps.fix.altitudeMeters) : '';
    const minuteBucket = Math.floor(now / 60000);
    const mileKey = onTrail && gps.mile != null ? `${fmtPosition(gps.mile)}|${gps.state}|${staleAgo}|${altKey}` : gps.state;
    const ago = result ? fmtAgo(Date.parse(result.generatedAt), now) : '';
    if (plaqueChanged([route, result, onTrail, mileKey, busy, failed, online, lookaheadMiles, ago, onTrail ? minuteBucket : 0])) {
      const view = !result ? null
        : onTrail && gps.mile != null ? aheadView(result, gps.mile)
          : {
            level: result.summary.level,
            levelLabel: result.summary.levelLabel,
            headline: result.summary.headline,
            counts: result.summary.counts,
            incomplete: result.summary.incomplete,
            leadId: leadHazardId(result),
          };
      remount(plaque,
        view ? resultPlaque(view, onSelectHazard) : pendingPlaque(route, failed, online),
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
    case 'denied': return 'Location access is off. Allow it in browser settings, or set your position manually.';
    case 'unavailable': return "Can't get a GPS fix. Set your position on the map or enter your trail mile.";
    case 'manual': return 'Using the position you set';
    default: return 'GPS is off';
  }
};

/**
 * createTrailStatus(container, { onTogglePick(), onRetryGps(), onUseGps(), onSetMile(mile), onLookahead(miles), onCenterMap() })
 *   .render({ route, gps, pickMode, lookaheadMiles, now })
 * Built once and updated in place: GPS fixes arrive every second and must not
 * steal focus from the stepper or the mile field.
 */
export const createTrailStatus = (container, handlers = {}) => {
  const gpsLabel = h('span', { class: 'gps-text' });
  const gpsLine = h('p', { class: 'gps-line' }, h('span', { class: 'gps-dot', 'aria-hidden': 'true' }), gpsLabel);
  const offRouteText = h('span');
  const offRoute = h('p', { class: 'offroute', hidden: true }, icon('warning'), offRouteText);

  // Offline-ready coordinates + quick SOS copy & recenter bar.
  const coordsValue = h('span', { class: 'coords-value' });
  const copyBtn = h('button', { type: 'button', class: 'btn btn-quiet btn-small coords-btn' }, icon('copy'), h('span', {}, 'Copy'));
  const centerBtn = h('button', { type: 'button', class: 'btn btn-quiet btn-small coords-btn' }, icon('locate'), h('span', {}, 'Center'));
  const coordsRow = h('div', { class: 'coords-row', hidden: true },
    coordsValue,
    h('div', { class: 'coords-actions' }, copyBtn, centerBtn));

  // Optional screen wake-lock toggle (keeps screen lit at trail junctions, fail-soft).
  const wakeSupported = typeof navigator !== 'undefined' && Boolean(navigator.wakeLock?.request);
  const wakeBtn = h('button', {
    type: 'button',
    class: 'btn btn-quiet btn-small wake-btn',
    'aria-pressed': 'false',
    hidden: !wakeSupported,
  }, 'Keep screen awake');

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

  const toolsSummary = h('span', {}, 'Position & look-ahead');
  const toolsFold = h('details', { class: 'trail-tools-fold' },
    h('summary', {}, toolsSummary, icon('chevron')),
    h('div', { class: 'trail-tools-body' },
      h('div', { class: 'trail-actions' }, pickButton, gpsButton),
      mileForm,
      lookahead));

  const headRow = h('div', { class: 'trail-head-row' }, gpsLine, wakeBtn);
  mount(container, headRow, offRoute, coordsRow, toolsFold);

  let state = { lookaheadMiles: 15, route: null, gps: null };
  let wakeSentinel = null;
  let wakeWanted = false;
  let copyTimer = 0;
  let userToggledFold = false;

  toolsFold.addEventListener('toggle', () => {
    // Track manual clicks only after initial render.
    if (state.route) userToggledFold = true;
  });

  const syncWakeButton = () => {
    const active = Boolean(wakeSentinel);
    wakeBtn.setAttribute('aria-pressed', String(active));
    wakeBtn.textContent = active ? 'Screen staying awake' : 'Keep screen awake';
  };

  const acquireWake = async () => {
    if (!wakeSupported || wakeSentinel) return;
    try {
      wakeSentinel = await navigator.wakeLock.request('screen');
      wakeSentinel.addEventListener('release', () => {
        wakeSentinel = null;
        syncWakeButton();
      });
    } catch {
      wakeWanted = false;
      wakeSentinel = null;
    }
    syncWakeButton();
  };

  const releaseWake = async () => {
    wakeWanted = false;
    const s = wakeSentinel;
    wakeSentinel = null;
    try { await s?.release(); } catch { /* ignore */ }
    syncWakeButton();
  };

  wakeBtn.addEventListener('click', () => {
    if (wakeWanted || wakeSentinel) releaseWake();
    else { wakeWanted = true; acquireWake(); }
  });

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && wakeWanted && !wakeSentinel) acquireWake();
    });
  }

  copyBtn.addEventListener('click', async () => {
    const fix = state.gps?.fix;
    if (!fix) return;
    const text = formatCoordsCopy(fix.lat, fix.lng, { mile: state.gps.mile, routeName: state.route?.name || '' });
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.lastChild.textContent = 'Copied';
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copyBtn.lastChild.textContent = 'Copy'; }, 2000);
    } catch {
      copyBtn.lastChild.textContent = 'Copy';
    }
  });

  centerBtn.addEventListener('click', () => handlers.onCenterMap?.());

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
    state = { route, lookaheadMiles, gps };
    container.dataset.gps = gps.state;
    gpsLabel.textContent = gpsText(gps, now);

    const off = gps.offRouteMiles;
    offRoute.hidden = !(off > OFF_ROUTE_WARN_MILES);
    if (!offRoute.hidden) offRouteText.textContent = `You're ${fmtDistance(off)} from the route — mileage ahead may be wrong.`;

    const hasFix = Boolean(gps.fix && gps.state !== 'off' && Number.isFinite(gps.fix.lat) && Number.isFinite(gps.fix.lng));
    coordsRow.hidden = !hasFix;
    if (hasFix) {
      coordsValue.textContent = formatCoordsDisplay(gps.fix.lat, gps.fix.lng);
    }

    pickButton.setAttribute('aria-pressed', String(Boolean(pickMode)));
    const manual = gps.state === 'manual';
    const retry = gps.state === 'denied' || gps.state === 'unavailable';
    gpsButton.hidden = !(manual || retry);
    gpsButton.dataset.action = manual ? 'manual' : 'retry';
    gpsButton.lastChild.textContent = manual ? 'Use GPS again' : 'Try GPS again';

    // Auto-open manual tools if GPS is blocked or unavailable so the hiker can place themselves right away.
    if (!userToggledFold) {
      toolsFold.open = retry || Boolean(pickMode);
    } else if (pickMode) {
      toolsFold.open = true;
    }

    toolsSummary.textContent = `Position & look-ahead (${lookaheadMiles} mi)`;

    // Live GPS can land on the wrong pass of an out-and-back; a typed mile corrects it.
    mileLabel.textContent = gps.state === 'live' ? 'Wrong mile? Enter your trail mile' : 'Or enter your trail mile';
    mileInput.max = route ? String(Math.round(route.lengthMiles * 10) / 10) : '';

    lookaheadValue.textContent = `${lookaheadMiles} mi`;
    lessButton.setAttribute('aria-disabled', String(lookaheadMiles <= LOOKAHEAD_STEPS[0]));
    moreButton.setAttribute('aria-disabled', String(lookaheadMiles >= LOOKAHEAD_STEPS[LOOKAHEAD_STEPS.length - 1]));
  };

  return { render, releaseWake };
};
