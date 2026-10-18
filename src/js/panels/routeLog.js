/**
 * "Along the route": the trail as a sequence, mile by mile. Hazard stretches
 * are entries on a vertical line; quiet stretches collapse into one row.
 * Stretches a source did not cover say so ("Not checked: weather forecast"),
 * because unchecked is not the same as clear.
 */
import { h } from '../ui/dom.js';
import { fmtRange, plural } from '../ui/format.js';
import { levelInfo, SOURCE_KEYS, SOURCE_LABELS } from '../../../shared/levels.js';
import {
  icon, levelChip, hiddenKey, joinList, lowerFirst, changeDetector, remount, fmtLength, fmtPosition, scrollIntoViewGently,
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

// Official sources cover the whole route when they load; a gap in them (outside
// US coverage, unrated avalanche terrain) belongs on the rows it affects.
const OFFICIAL_KEYS = ['fire', 'alerts', 'avalanche', 'water', 'air'];

/**
 * Forecasts that cover only one stretch (the On trail look-ahead window) are
 * stated once above the log, instead of as "Not checked" on every row
 * outside that stretch. Official sources and patchy coverage stay on the rows.
 */
const coverageOf = (result) => {
  const expected = SOURCE_KEYS.filter(k => result.sources[k] && result.sources[k].status !== 'error');
  const length = result.segments.length ? result.segments[result.segments.length - 1].mileEnd : 0;
  const windowed = new Map(); // "a-b" -> { span, keys }
  const perRow = [];
  for (const key of expected) {
    const spans = coveredSpans(result.segments, key);
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
  return { perRow, windowed: [...windowed.values()] };
};

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

const refLine = (ref, hazards) => {
  const title = hazards[ref.id]?.title || ref.note || 'Reported hazard';
  // A note that only restates the title ("AQI unhealthy" under "Unhealthy air quality") adds nothing.
  const norm = (s) => s.toLowerCase().replace(/^aqi\s+/, '').replace(/ on airnow's map$/, '');
  const note = ref.note && !norm(title).includes(norm(ref.note)) ? ref.note : null;
  return h('li', { class: 'tl-ref' },
    h('span', { class: 'swatch', style: `--swatch:${levelInfo(ref.level).color}`, 'aria-hidden': 'true' }),
    h('span', {}, h('span', { class: 'tl-ref-title' }, title), note ? ` (${note})` : null));
};

const entryItem = (entry, result, onSelect) => {
  const range = fmtRange(entry.mileStart, entry.mileEnd);
  const key = `tl:${entry.mileStart}`;
  const select = () => onSelect?.({ mileStart: entry.mileStart, mileEnd: entry.mileEnd, hazardId: entry.refs[0]?.id ?? null });
  const nodeStyle = `--swatch:${levelInfo(entry.level).color}`;
  if (entry.level === 0) {
    return h('li', { class: 'tl-entry tl-clear', 'data-mile-start': entry.mileStart, 'data-mile-end': entry.mileEnd },
      h('span', { class: 'tl-node', 'aria-hidden': 'true' }),
      h('button', { type: 'button', class: 'tl-button', 'data-focus-key': key, onclick: select },
        h('span', { class: 'tl-miles' }, range),
        h('span', { class: 'tl-len' }, fmtLength(entry.mileEnd - entry.mileStart)),
        h('span', { class: 'tl-quiet' }, entry.hidden ? 'Hidden by filters' : 'Nothing reported')),
      uncheckedLine(entry.missing));
  }
  return h('li', {
    class: `tl-entry tl-hazard${entry.estimatedOnly ? ' tl-estimated' : ''}`,
    'data-mile-start': entry.mileStart,
    'data-mile-end': entry.mileEnd,
  },
  h('span', { class: 'tl-node', style: nodeStyle, 'aria-hidden': 'true' }),
  h('button', { type: 'button', class: 'tl-button', 'data-focus-key': key, onclick: select },
    h('span', { class: 'tl-miles' }, range),
    h('span', { class: 'tl-len' }, fmtLength(entry.mileEnd - entry.mileStart)),
    levelChip(entry.level, { estimated: entry.estimatedOnly })),
  h('ul', { class: 'tl-refs' }, entry.refs.map(r => refLine(r, result.hazards))),
  uncheckedLine(entry.missing));
};

const hereMarker = (mile) => h('li', { class: 'tl-here' },
  h('span', { class: 'tl-node', 'aria-hidden': 'true' }),
  `You're at Mi ${fmtPosition(mile)}`);

/**
 * createRouteLog(container, { onSelect({ mileStart, mileEnd, hazardId }), onShowAll() })
 *   .render({ result, hiddenTypes, mile }), .reveal(mile)
 * `mile` (On trail) folds everything behind the hiker under "Behind you".
 */
export const createRouteLog = (container, { onSelect, onShowAll } = {}) => {
  const changed = changeDetector();

  const render = ({ result, hiddenTypes, mile = null }) => {
    const mileKey = mile == null ? null : fmtPosition(mile);
    if (!changed([result, hiddenKey(hiddenTypes), mileKey])) return;
    if (!result) {
      remount(container, h('p', { class: 'empty' }, 'The mile-by-mile log appears here when the check finishes.'));
      return;
    }
    const coverage = coverageOf(result);
    const entries = buildEntries(result, hiddenTypes, coverage.perRow);
    const behind = mile == null ? [] : entries.filter(e => e.mileEnd <= mile);
    const ahead = entries.slice(behind.length);
    const items = ahead.map(e => entryItem(e, result, onSelect));
    if (mile != null) items.unshift(hereMarker(mile));

    const hiddenCount = Object.values(result.hazards).filter(hz => hiddenTypes.has(hz.type)).length;
    remount(container,
      hiddenCount ? h('p', { class: 'hidden-note' },
        `${plural(hiddenCount, 'hazard')} hidden by filters. `,
        h('button', { type: 'button', class: 'link-button', 'data-focus-key': 'log-show-all', onclick: onShowAll }, 'Show all')) : null,
      coverage.windowed.map(coverageNote),
      behind.length ? h('details', { class: 'behind', 'data-open-key': 'behind' },
        h('summary', {}, icon('chevron'), `Behind you (${fmtRange(0, behind[behind.length - 1].mileEnd)})`),
        h('ol', { class: 'timeline' }, behind.map(e => entryItem(e, result, onSelect)))) : null,
      h('ol', { class: 'timeline', 'aria-label': 'Route log, in mile order' }, items));
  };

  /** Scroll to the entry containing `mile` and focus it. */
  const reveal = (mile) => {
    const entry = [...container.querySelectorAll('.tl-entry')].find(el =>
      Number(el.dataset.mileStart) <= mile && mile <= Number(el.dataset.mileEnd));
    if (!entry) return;
    const fold = entry.closest('details');
    if (fold) fold.open = true;
    scrollIntoViewGently(entry);
    entry.querySelector('.tl-button')?.focus({ preventScroll: true });
  };

  return { render, reveal };
};
