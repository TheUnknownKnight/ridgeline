/**
 * "Modeled Trail Conditions": what is likely underfoot, stretch by stretch —
 * now, and on the next mornings and afternoons. Every line is a model estimate
 * built from public data, and says why it thinks so.
 *
 * Window labels are worked out here from each window's time and the clock,
 * not taken from the server: a result saved last night must not call this
 * morning "tomorrow".
 */
import { h } from '../ui/dom.js';
import { fmtRange, fmtAgo } from '../ui/format.js';
import { levelInfo } from '../../../shared/levels.js';
import { partText } from '../../../shared/conditions/classify.js';
import { icon, fmtLength, changeDetector, remount, scrollIntoViewGently } from './common.js';

const HOUR = 3600 * 1000;
// "Now" from a check older than this is no longer now.
const NOW_FRESH_MS = HOUR;

const CONFIDENCE_NOTES = {
  weather: {
    partial: 'Weather history was missing for part of the route; those miles are marked "Not estimated".',
  },
  terrain: {
    error: 'Terrain and land cover were unavailable, so every stretch is treated as a flat dirt trail.',
    partial: 'Some terrain layers were unavailable, so slope direction or tree cover may be missing in places.',
  },
  snow: {
    error: "NOAA's snow analysis was unavailable, so snow that fell more than ten days ago may be missed.",
    partial: "NOAA's snow analysis was missing for part of the route, so older snow may be missed there.",
    skipped: "This route is outside NOAA's snow analysis, so snow that fell more than ten days ago may be missed.",
  },
};

const validZone = (tz) => {
  try {
    if (tz) new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz || undefined;
  } catch {
    return undefined;
  }
};

const dayKey = (ms, timeZone) => new Date(ms).toLocaleDateString('en-CA', { timeZone });

/** "This morning", "Tomorrow afternoon", "Monday morning" — relative to the device clock, in trail time. */
const labelFor = (w, now, timeZone) => {
  const at = Date.parse(w.at);
  const hour = Number(new Date(at).toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }));
  const part = hour < 12 ? 'morning' : 'afternoon';
  const today = dayKey(now, timeZone);
  const tomorrow = dayKey(now + 24 * HOUR, timeZone);
  const day = dayKey(at, timeZone);
  const when = day === today ? 'This' : day === tomorrow ? 'Tomorrow' : new Date(at).toLocaleDateString('en-US', { weekday: 'long', timeZone });
  return `${when} ${part}`;
};

/** Windows still worth showing, labelled for now. A stale "now" becomes "At last check". */
const liveWindows = (block, result, now) => {
  const timeZone = validZone(result.route?.timeZone);
  const checkedAt = Date.parse(result.generatedAt);
  const out = [];
  for (const w of block.windows || []) {
    const at = Date.parse(w.at);
    if (w.key === 'now') {
      const fresh = !(now - checkedAt > NOW_FRESH_MS);
      out.push({ ...w, label: fresh ? 'Now' : `At last check (${new Date(at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone })})`, stale: !fresh });
    } else if (at > now - HOUR) {
      out.push({ ...w, label: labelFor(w, now, timeZone) });
    }
  }
  return out;
};

/** High/Extreme stretches, unmodeled safety gaps, and single-stretch routes start expanded. */
export const shouldExpandConditionStretch = (stretch, totalCount = 2) =>
  totalCount === 1 || stretch?.regime === 'missing' || (stretch?.level || 0) >= 3;

export const filterConditionStretches = (stretches = [], mode = 'all') =>
  (mode === 'notable' ? stretches.filter(s => (s.level || 0) > 0 || s.regime === 'missing') : stretches);

const emptyState = (source) => h('div', { class: 'empty' },
  h('p', { class: 'empty-title' }, 'Trail conditions not available'),
  h('p', {}, source?.status === 'error'
    ? 'The weather history behind the estimate could not be loaded. This is not a sign the trail is clear.'
    : 'Trail conditions are estimated for the stretch Ridgeline checked.'));

const partItem = (part) => h('li', { class: 'cond-part' },
  h('p', {}, partText(part)),
  part.why?.length ? h('p', { class: 'cond-why' }, `Why: ${part.why.join('; ')}`) : null);

const stretchKey = (s) => `${s.mileStart}:${s.mileEnd}`;

const stretchTag = (s) => {
  if (s.regime === 'missing') return 'Not estimated';
  if (s.level > 0) return `${levelInfo(s.level).short}, estimate`;
  return s.regime === 'wet' ? 'Wet' : s.regime === 'winter' ? 'Snow' : 'Dry';
};

const stretchBody = (s) => (s.regime === 'missing'
  ? [h('p', { class: 'cond-why' }, 'Weather history was unavailable here, so nothing was estimated. This is not a sign the trail is clear.')]
  : s.parts?.length ? [h('ul', { class: 'cond-parts' }, s.parts.map(partItem))] : []);

const stretchItem = (s, { expanded, onToggle }) => {
  const key = stretchKey(s);
  const bodyNodes = stretchBody(s);
  const expandable = bodyNodes.length > 0;
  const isOpen = expandable && expanded;
  const tagClass = `cond-tag${s.level >= 4 ? ' is-extreme' : s.level >= 3 ? ' is-high' : ''}`;
  return h('li', {
    class: `cond-stretch cond-${s.regime}${isOpen ? ' is-expanded' : ''}${s.level >= 4 ? ' is-extreme' : ''}`,
    'data-stretch-key': key,
    'data-mile-start': s.mileStart,
    'data-mile-end': s.mileEnd,
  },
  h('button', {
    type: 'button',
    class: 'cond-head',
    ...(expandable ? { 'aria-expanded': String(isOpen) } : {}),
    'data-focus-key': `cond:${s.mileStart}`,
    onclick: () => onToggle(s, expandable),
  },
  h('span', { class: 'cond-head-main' },
    h('span', { class: 'cond-head-top' },
      h('span', { class: 'cond-head-range' },
        h('span', { class: 'cond-miles' }, fmtRange(s.mileStart, s.mileEnd)),
        h('span', { class: 'cond-len' }, fmtLength(s.mileEnd - s.mileStart))),
      h('span', { class: tagClass }, stretchTag(s))),
    h('span', { class: 'cond-title' }, s.title)),
  expandable ? icon('chevron') : null,
  h('span', { class: 'visually-hidden' }, expandable ? ' — toggle details and show on map' : ' — show on map')),
  expandable ? h('div', { class: 'cond-body', hidden: !isOpen }, bodyNodes) : null);
};

const notes = (block) => {
  const lines = [];
  for (const [key, states] of Object.entries(CONFIDENCE_NOTES)) {
    const text = states[block.confidence?.[key]];
    if (text) lines.push(text);
  }
  return lines.length ? h('div', { class: 'cond-notes cond-notes-top' }, lines.map(text => h('p', { class: 'cond-note' }, icon('warning'), text))) : null;
};

const fmtDec = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export const conditionsSnapshotText = (m) => {
  if (!m) return null;
  const parts = [];
  if (m.maxSnowDepthIn >= 0.5) parts.push(`snowpack up to ${fmtDec(m.maxSnowDepthIn)} in`);
  if (m.maxSnowmelt24hMm >= 3) parts.push(`24 h melt peak ${m.maxSnowmelt24hMm} mm`);
  if (m.maxRunoff48hMm >= 10) parts.push(`48 h runoff peak ${m.maxRunoff48hMm} mm`);
  if (m.horizonShadedPoints > 0 && m.modeledPoints > 0) {
    const pct = Math.max(1, Math.round((m.horizonShadedPoints / m.modeledPoints) * 100));
    parts.push(`${pct}% ridge-shaded`);
  }
  if (m.steepMiles >= 0.1) parts.push(`${fmtDec(m.steepMiles)} mi ≥25° slope`);
  return parts.length ? `Route snapshot: ${parts.join(', ')}.` : null;
};

const footnote = (block, result, now) => h('p', { class: 'list-footnote' },
  `Estimated every ${block.spacingMiles} mi from the last 10 days of weather, the 3-day forecast, slope direction, tree cover, land cover and NOAA's snow analysis`,
  Number.isFinite(Date.parse(result.generatedAt)) ? `, in a check ${fmtAgo(Date.parse(result.generatedAt), now)}. ` : '. ',
  'The surface underfoot is inferred, not mapped. Not an observation: check recent trip reports and ranger updates.');

const filterBar = (stretches, activeMode, onChangeMode) => {
  const notableCount = filterConditionStretches(stretches, 'notable').length;
  if (notableCount === 0 || notableCount === stretches.length) return null;
  const pill = (mode, text, count) => h('button', {
    type: 'button',
    class: 'panel-pill',
    'aria-pressed': String(activeMode === mode),
    'data-focus-key': `cond-filter:${mode}`,
    onclick: () => onChangeMode(mode),
  }, text, h('span', { class: 'panel-pill-count' }, String(count)));
  return h('div', { class: 'panel-pills', role: 'group', 'aria-label': 'Filter condition stretches' },
    pill('all', 'All stretches', stretches.length),
    pill('notable', 'Notable only', notableCount));
};

/**
 * createConditions(container, { onSelect({ mileStart, mileEnd }) })
 *   .render({ result, mile, now }), .reveal(mile)
 * `mile` (On trail) folds stretches behind the hiker.
 */
export const createConditions = (container, { onSelect } = {}) => {
  const changed = changeDetector();
  let windowKey = null;
  let filterMode = 'all';
  let openStateKey = '';
  let expandedKeys = new Set();
  let last = { result: null, mile: null, now: Date.now() };

  const syncExpanded = (key, open) => {
    const item = [...container.querySelectorAll('.cond-stretch')].find(el => el.dataset.stretchKey === key);
    if (!item) return;
    item.classList.toggle('is-expanded', open);
    item.querySelector('.cond-head')?.setAttribute('aria-expanded', String(open));
    const body = item.querySelector('.cond-body');
    if (body) body.hidden = !open;
  };

  const onToggle = (stretch, expandable) => {
    const key = stretchKey(stretch);
    if (!expandable) {
      onSelect?.({ mileStart: stretch.mileStart, mileEnd: stretch.mileEnd });
      return;
    }
    const nextOpen = !expandedKeys.has(key);
    if (nextOpen) expandedKeys.add(key);
    else expandedKeys.delete(key);
    syncExpanded(key, nextOpen);
    if (nextOpen) onSelect?.({ mileStart: stretch.mileStart, mileEnd: stretch.mileEnd });
  };

  const setFilterMode = (mode) => {
    if (filterMode === mode) return;
    filterMode = mode;
    render(last);
  };

  const picker = (windows) => h('div', { class: 'segmented cond-windows', role: 'group', 'aria-label': 'When' },
    windows.map(w => h('button', {
      type: 'button',
      'aria-pressed': String(w.key === windowKey),
      'data-focus-key': `when:${w.key}`,
      onclick: () => {
        windowKey = w.key;
        render(last);
      },
    }, w.label)));

  const render = ({ result, mile = null, now = Date.now() }) => {
    const prevResult = last.result;
    last = { result, mile, now };
    if (result !== prevResult) filterMode = 'all';
    const block = result?.conditions;
    const windows = block && result ? liveWindows(block, result, now) : [];
    if (!windows.some(w => w.key === windowKey)) {
      // A stale "now" is still shown, but a fresh window is the better default.
      windowKey = (windows.find(w => !w.stale) || windows[0])?.key ?? null;
    }
    const labels = windows.map(w => w.label).join('|');
    if (!changed([result, windowKey, labels, mile == null ? null : Math.floor(mile * 10), filterMode])) return;
    if (!result) {
      remount(container, h('p', { class: 'empty' }, 'Trail conditions appear here when the check finishes.'));
      return;
    }
    if (!block || !windows.length) {
      remount(container, emptyState(result.sources?.conditions));
      return;
    }
    const stretches = block.stretches?.[windowKey] || [];
    const behind = mile == null ? [] : stretches.filter(s => s.mileEnd <= mile);
    const ahead = stretches.slice(behind.length);
    const stateKey = `${result.generatedAt || ''}|${windowKey}`;
    if (stateKey !== openStateKey) {
      openStateKey = stateKey;
      expandedKeys = new Set(
        stretches.filter(s => shouldExpandConditionStretch(s, ahead.length)).map(stretchKey),
      );
    }
    let shownAhead = filterConditionStretches(ahead, filterMode);
    if (filterMode !== 'all' && !shownAhead.length) {
      filterMode = 'all';
      shownAhead = ahead;
    }

    const snapshot = conditionsSnapshotText(block.metrics);
    remount(container,
      picker(windows),
      notes(block),
      snapshot ? h('p', { class: 'cond-snapshot' }, snapshot) : null,
      filterBar(ahead, filterMode, setFilterMode),
      shownAhead.length ? h('ol', { class: 'cond-list', 'aria-label': 'Trail conditions, in mile order' },
        shownAhead.map(s => stretchItem(s, { expanded: expandedKeys.has(stretchKey(s)), onToggle }))) : null,
      behind.length ? h('details', { class: 'behind', 'data-open-key': 'cond-behind' },
        h('summary', {}, icon('chevron'), `Behind you (${fmtRange(behind[0].mileStart, behind[behind.length - 1].mileEnd)})`),
        h('ol', { class: 'cond-list' }, behind.map(s => stretchItem(s, { expanded: expandedKeys.has(stretchKey(s)), onToggle })))) : null,
      footnote(block, result, now));
  };

  /** Scroll to the stretch containing `mile`, expand it, and focus it. */
  const reveal = (mile) => {
    const findItem = () => [...container.querySelectorAll('.cond-stretch')].find(el =>
      Number(el.dataset.mileStart) <= mile && mile <= Number(el.dataset.mileEnd));
    let item = findItem();
    if (!item && filterMode !== 'all') {
      filterMode = 'all';
      render(last);
      item = findItem();
    }
    if (!item) return;
    const key = item.dataset.stretchKey;
    if (key) {
      expandedKeys.add(key);
      syncExpanded(key, true);
    }
    const fold = item.closest('details');
    if (fold) fold.open = true;
    scrollIntoViewGently(item);
    item.querySelector('.cond-head')?.focus({ preventScroll: true });
  };

  return { render, reveal };
};
