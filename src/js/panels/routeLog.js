/**
 * "Along the route": the trail as a sequence, mile by mile. Hazard stretches
 * are compact expandable rows on a vertical line with matching hazard badges;
 * quiet stretches stay slim and route-wide coverage gaps are stated once at
 * the top instead of repeated under every row.
 */
import { h } from '../ui/dom.js';
import { fmtRange, plural } from '../ui/format.js';
import { levelInfo, SOURCE_KEYS, SOURCE_LABELS } from '../../../shared/levels.js';
import { createHazardBadgeEl } from '../map/weatherBadges.js';
import {
  icon, hiddenKey, joinList, lowerFirst, changeDetector, remount, fmtLength, fmtPosition, scrollIntoViewGently,
} from './common.js';

const visibleRefs = (segment, hazards, hiddenTypes) =>
  segment.refs.filter(r => !hiddenTypes.has(hazards[r.id]?.type));

const label = (key) => lowerFirst(SOURCE_LABELS[key] || key);

/** Stretches of the route a source actually covered, merged. */
const coveredSpans = (segments, key) => {
  const spans = [];
  for (const s of segments) {
    if (!(s.checked || []).includes(key)) continue;
    const last = spans[spans.length - 1];
    if (last && s.mileStart - last[1] < 1e-6) last[1] = s.mileEnd;
    else spans.push([s.mileStart, s.mileEnd]);
  }
  return spans;
};

// Official sources cover the whole route when they load; a mid-route gap in
// them (outside US coverage, unrated avalanche terrain) belongs on the rows it
// affects, while a 0%-covered source is stated once at the top.
const OFFICIAL_KEYS = ['fire', 'alerts', 'avalanche', 'water', 'air'];

/**
 * Partition incomplete coverage into:
 * - routeWideMissing: sources with 0 miles covered (stated once at the top)
 * - windowed: forecast sources covering one look-ahead span (stated once)
 * - perRow: genuine mid-route coverage gaps (shown on affected rows)
 */
export const coverageOf = (result) => {
  if (!result?.segments?.length) return { routeWideMissing: [], perRow: [], windowed: [] };
  const expected = SOURCE_KEYS.filter(k => result.sources[k] && result.sources[k].status !== 'error');
  const length = result.segments[result.segments.length - 1].mileEnd;
  const windowed = new Map(); // "a-b" -> { span, keys }
  const routeWideMissing = [];
  const perRow = [];
  for (const key of expected) {
    const spans = coveredSpans(result.segments, key);
    if (!spans.length) {
      routeWideMissing.push(key);
      continue;
    }
    const full = spans.length === 1 && spans[0][0] <= 1e-6 && spans[0][1] >= length - 1e-6;
    if (full) continue;
    if (spans.length !== 1 || OFFICIAL_KEYS.includes(key)) {
      perRow.push(key);
      continue;
    }
    const id = spans[0].join('-');
    if (!windowed.has(id)) windowed.set(id, { span: spans[0], keys: [] });
    windowed.get(id).keys.push(key);
  }
  return { routeWideMissing, perRow, windowed: [...windowed.values()] };
};

export const filterRouteEntries = (entries = [], mode = 'all') => {
  if (mode === 'hazards') return entries.filter(e => e.level > 0);
  if (mode === 'urgent') return entries.filter(e => e.level >= 3);
  return entries;
};

/**
 * Compact preview for a collapsed stretch row: always keeps every Extreme
 * (level >= 4) hazard visible so critical events are never hidden in "+N more".
 * Without Extreme hazards, shows the highest-severity lead hazard.
 */
export const previewRefsForStretch = (refs = []) => {
  if (!refs.length) return { shown: [], hiddenCount: 0 };
  const extremes = refs.filter(r => r.level >= 4);
  const shown = extremes.length ? extremes : [refs[0]];
  return { shown, hiddenCount: Math.max(0, refs.length - shown.length) };
};

const routeWideGapNote = (keys) => (keys.length
  ? h('p', { class: 'tl-coverage tl-coverage-gap' }, icon('warning'),
    `Not checked along this route: ${joinList(keys.map(label))}.`)
  : null);

const coverageNote = ({ span, keys }) => {
  const names = joinList(keys.map(label));
  return h('p', { class: 'tl-coverage' }, icon('info'),
    `${names[0].toUpperCase()}${names.slice(1)} ${keys.length > 1 ? 'cover' : 'covers'} ${fmtRange(span[0], span[1])} only.`);
};

/**
 * Merge consecutive segments that read the same once filters apply: same
 * visible hazards at the same levels, same unchecked sources.
 */
const buildEntries = (result, hiddenTypes, perRowSources) => {
  const entries = [];
  for (const s of result.segments) {
    const refs = visibleRefs(s, result.hazards, hiddenTypes);
    const level = refs.reduce((max, r) => Math.max(max, r.level), 0);
    const missing = perRowSources.filter(k => !(s.checked || []).includes(k));
    // A quiet row that only looks quiet because of filters must not merge into "Nothing reported".
    const hidden = level === 0 && refs.length < s.refs.length;
    const sig = `${level}|${refs.map(r => `${r.id}:${r.level}`).sort().join(',')}|${missing.join(',')}|${hidden ? 'h' : ''}`;
    const last = entries[entries.length - 1];
    if (last && last.sig === sig) {
      last.mileEnd = s.mileEnd;
      for (const r of refs) {
        const kept = last.refs.find(k => k.id === r.id);
        if (r.distance != null && !(kept.distance <= r.distance)) Object.assign(kept, r);
      }
      continue;
    }
    const estimatedOnly = level > 0 && refs.filter(r => r.level === level)
      .every(r => result.hazards[r.id]?.source === 'ESTIMATED');
    entries.push({ sig, mileStart: s.mileStart, mileEnd: s.mileEnd, level, estimatedOnly, hidden, refs: refs.map(r => ({ ...r })), missing });
  }
  for (const e of entries) e.refs.sort((a, b) => b.level - a.level);
  return entries;
};

const uncheckedLine = (missing) => (missing.length
  ? h('p', { class: 'tl-unchecked' }, `Not checked: ${joinList(missing.map(label))}`)
  : null);

const cleanNote = (title, rawNote) => {
  if (!rawNote) return null;
  // A note that only restates the title ("AQI unhealthy" under "Unhealthy air quality") adds nothing.
  const norm = (s) => s.toLowerCase().replace(/^aqi\s+/, '').replace(/ on airnow's map$/, '');
  return norm(title).includes(norm(rawNote)) ? null : rawNote;
};

const refLine = (ref, hazards, onOpenHazard) => {
  const hz = hazards[ref.id];
  const title = hz?.title || ref.note || 'Reported hazard';
  const note = cleanNote(title, ref.note);
  const badgeHazard = hz || { level: ref.level, type: 'alert', source: 'OFFICIAL' };
  return h('li', { class: 'tl-ref' },
    createHazardBadgeEl(badgeHazard, { size: 'sm' }),
    h('div', { class: 'tl-ref-main' },
      h('div', { class: 'tl-ref-top' },
        h('span', { class: 'tl-ref-title' }, title),
        onOpenHazard && hz
          ? h('button', {
            type: 'button',
            class: 'link-button tl-ref-open',
            onclick: () => onOpenHazard(ref.id),
          }, 'Details', h('span', { class: 'visually-hidden' }, ` for ${title}`))
          : null),
      note ? h('p', { class: 'tl-ref-note' }, note) : null));
};

export const matchEntryIndex = (ranges, mile) => {
  if (!Number.isFinite(mile) || !ranges?.length) return -1;
  const open = ranges.findIndex(r => r.mileStart <= mile && mile < r.mileEnd);
  if (open >= 0) return open;
  return ranges.findIndex(r => r.mileStart <= mile && mile <= r.mileEnd);
};

const levelTagText = (entry) => {
  const info = levelInfo(entry.level);
  const word = info.level === 0 ? 'Clear' : info.short;
  return entry.estimatedOnly ? `${word}, estimate` : word;
};

const previewLine = (refs, hazards) => {
  const { shown, hiddenCount } = previewRefsForStretch(refs);
  return h('span', { class: 'tl-preview' },
    shown.map((ref) => {
      const hz = hazards[ref.id];
      const title = hz?.title || ref.note || 'Reported hazard';
      return h('span', { class: `tl-preview-item${ref.level >= 4 ? ' is-extreme' : ''}` },
        createHazardBadgeEl(hz || { level: ref.level, type: 'alert', source: 'OFFICIAL' }, { size: 'sm' }),
        h('span', { class: 'tl-preview-title' }, title));
    }),
    hiddenCount > 0 ? h('span', { class: 'tl-preview-more' }, `+${hiddenCount} more`) : null);
};

const entryItem = (entry, result, { onToggleEntry, onOpenHazard }) => {
  const range = fmtRange(entry.mileStart, entry.mileEnd);
  const key = `tl:${entry.mileStart}`;
  const nodeStyle = `--swatch:${levelInfo(entry.level).color}`;
  if (entry.level === 0) {
    return h('li', { class: 'tl-entry tl-clear', 'data-mile-start': entry.mileStart, 'data-mile-end': entry.mileEnd },
      h('span', { class: 'tl-node', 'aria-hidden': 'true' }),
      h('button', {
        type: 'button',
        class: 'tl-button tl-button-clear',
        'aria-pressed': 'false',
        'data-focus-key': key,
        onclick: () => onToggleEntry(entry),
      },
      h('span', { class: 'tl-miles' }, range),
      h('span', { class: 'tl-len' }, fmtLength(entry.mileEnd - entry.mileStart)),
      h('span', { class: 'tl-quiet' }, entry.hidden ? 'Hidden by filters' : 'Nothing reported')),
      uncheckedLine(entry.missing));
  }
  return h('li', {
    class: `tl-entry tl-hazard${entry.estimatedOnly ? ' tl-estimated' : ''}${entry.level >= 4 ? ' is-extreme' : ''}`,
    'data-mile-start': entry.mileStart,
    'data-mile-end': entry.mileEnd,
  },
  h('span', { class: 'tl-node', style: nodeStyle, 'aria-hidden': 'true' }),
  h('button', {
    type: 'button',
    class: 'tl-button tl-button-hazard',
    'aria-pressed': 'false',
    'aria-expanded': 'false',
    'data-focus-key': key,
    onclick: () => onToggleEntry(entry),
  },
  h('span', { class: 'tl-head-main' },
    h('span', { class: 'tl-head-top' },
      h('span', { class: 'tl-head-range' },
        h('span', { class: 'tl-miles' }, range),
        h('span', { class: 'tl-len' }, fmtLength(entry.mileEnd - entry.mileStart))),
      h('span', { class: `tl-level-tag${entry.estimatedOnly ? ' is-estimated' : ''}${entry.level >= 4 ? ' is-extreme' : ''}` }, levelTagText(entry))),
    previewLine(entry.refs, result.hazards)),
  icon('chevron')),
  h('div', { class: 'tl-body', hidden: true },
    h('ul', { class: 'tl-refs' }, entry.refs.map(r => refLine(r, result.hazards, onOpenHazard)))),
  uncheckedLine(entry.missing));
};

const hereMarker = (mile) => h('li', { class: 'tl-here' },
  h('span', { class: 'tl-node', 'aria-hidden': 'true' }),
  `You're at Mi ${fmtPosition(mile)}`);

const filterBar = (entries, activeMode, onChangeMode) => {
  const allCount = entries.length;
  const hazardCount = entries.filter(e => e.level > 0).length;
  const urgentCount = entries.filter(e => e.level >= 3).length;
  const pills = [];
  const add = (mode, text, count) => pills.push(h('button', {
    type: 'button',
    class: 'panel-pill',
    'aria-pressed': String(activeMode === mode),
    'data-focus-key': `tl-filter:${mode}`,
    onclick: () => onChangeMode(mode),
  }, text, h('span', { class: 'panel-pill-count' }, String(count))));

  const showHazards = hazardCount > 0 && hazardCount < allCount && hazardCount !== urgentCount;
  const showUrgent = urgentCount > 0 && urgentCount < allCount;
  if (!showHazards && !showUrgent) return null;

  add('all', 'All stretches', allCount);
  if (showHazards) add('hazards', 'Hazards only', hazardCount);
  if (showUrgent) add('urgent', 'High & Extreme', urgentCount);
  return h('div', { class: 'panel-pills', role: 'group', 'aria-label': 'Filter stretches' }, pills);
};

/**
 * createRouteLog(container, { onSelect({ mileStart, mileEnd, hazardId, source, clear }), onOpenHazard(id), onShowAll() })
 *   .render({ result, hiddenTypes, mile }), .setSelected(mile), .reveal(mile)
 * `mile` (On trail) folds everything behind the hiker under "Behind you".
 */
export const createRouteLog = (container, { onSelect, onOpenHazard, onShowAll } = {}) => {
  const changed = changeDetector();
  let selectedMile = null;
  let filterMode = 'all';
  let lastArgs = { result: null, hiddenTypes: new Set(), mile: null };

  const syncSelected = () => {
    const els = [...container.querySelectorAll('.tl-entry')];
    const ranges = els.map(el => ({ mileStart: Number(el.dataset.mileStart), mileEnd: Number(el.dataset.mileEnd) }));
    const idx = matchEntryIndex(ranges, selectedMile);
    els.forEach((el, i) => {
      const on = i === idx;
      el.classList.toggle('is-selected', on);
      el.classList.toggle('is-expanded', on && el.classList.contains('tl-hazard'));
      const btn = el.querySelector('.tl-button');
      if (btn) {
        btn.setAttribute('aria-pressed', String(on));
        if (el.classList.contains('tl-hazard')) btn.setAttribute('aria-expanded', String(on));
      }
      const body = el.querySelector('.tl-body');
      if (body) body.hidden = !on;
    });
    return idx >= 0 ? ranges[idx] : null;
  };

  const setSelected = (mile) => {
    selectedMile = Number.isFinite(mile) ? mile : null;
    return syncSelected();
  };

  const onToggleEntry = (entry) => {
    const active = container.querySelector('.tl-entry.is-selected');
    const alreadySelected = active
      && Number(active.dataset.mileStart) === entry.mileStart
      && Number(active.dataset.mileEnd) === entry.mileEnd;
    if (alreadySelected) {
      setSelected(null);
      onSelect?.({ mileStart: null, mileEnd: null, hazardId: null, source: 'log', clear: true });
      return;
    }
    onSelect?.({
      mileStart: entry.mileStart,
      mileEnd: entry.mileEnd,
      hazardId: entry.refs[0]?.id ?? null,
      source: 'log',
    });
  };

  const setFilterMode = (mode) => {
    if (filterMode === mode) return;
    filterMode = mode;
    render(lastArgs);
  };

  const render = ({ result, hiddenTypes, mile = null }) => {
    const prevResult = lastArgs.result;
    lastArgs = { result, hiddenTypes, mile };
    if (result !== prevResult) filterMode = 'all';
    const mileKey = mile == null ? null : fmtPosition(mile);
    if (!changed([result, hiddenKey(hiddenTypes), mileKey, filterMode])) return;
    if (!result) {
      remount(container, h('p', { class: 'empty' }, 'The mile-by-mile log appears here when the check finishes.'));
      return;
    }
    const coverage = coverageOf(result);
    const entries = buildEntries(result, hiddenTypes, coverage.perRow);
    const behind = mile == null ? [] : entries.filter(e => e.mileEnd <= mile);
    const ahead = entries.slice(behind.length);
    let shownAhead = filterRouteEntries(ahead, filterMode);
    if (filterMode !== 'all' && !shownAhead.length) {
      filterMode = 'all';
      shownAhead = ahead;
    }

    const handlers = { onToggleEntry, onOpenHazard };
    const items = shownAhead.map(e => entryItem(e, result, handlers));
    if (mile != null) items.unshift(hereMarker(mile));

    const hiddenCount = Object.values(result.hazards).filter(hz => hiddenTypes.has(hz.type)).length;
    remount(container,
      hiddenCount ? h('p', { class: 'hidden-note' },
        `${plural(hiddenCount, 'hazard')} hidden by filters. `,
        h('button', { type: 'button', class: 'link-button', 'data-focus-key': 'log-show-all', onclick: onShowAll }, 'Show all')) : null,
      routeWideGapNote(coverage.routeWideMissing),
      coverage.windowed.map(coverageNote),
      filterBar(ahead, filterMode, setFilterMode),
      behind.length ? h('details', { class: 'behind', 'data-open-key': 'behind' },
        h('summary', {}, icon('chevron'), `Behind you (${fmtRange(0, behind[behind.length - 1].mileEnd)})`),
        h('ol', { class: 'timeline' }, behind.map(e => entryItem(e, result, handlers)))) : null,
      h('ol', { class: 'timeline', 'aria-label': 'Route log, in mile order' }, items));
    syncSelected();
  };

  /** Scroll to the entry containing `mile` and focus it. */
  const reveal = (mile) => {
    let range = setSelected(mile);
    if (!range && filterMode !== 'all') {
      filterMode = 'all';
      render(lastArgs);
      range = setSelected(mile);
    }
    const entry = container.querySelector('.tl-entry.is-selected');
    if (!entry) return null;
    const fold = entry.closest('details');
    if (fold) fold.open = true;
    scrollIntoViewGently(entry);
    entry.querySelector('.tl-button')?.focus({ preventScroll: true });
    return range;
  };

  return { render, setSelected, reveal };
};
