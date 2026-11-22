/**
 * "What to know": every hazard on the route, most serious first, written so
 * a hiker can act on it — where it touches the trail, how close it gets,
 * when it applies, what to do, and who said so.
 */
import { h, safeUrl } from '../ui/dom.js';
import { fmtRange, fmtMile, fmtDistance, splitFacts, plural } from '../ui/format.js';
import { levelInfo } from '../../../shared/levels.js';
import { createHazardBadgeEl } from '../map/weatherBadges.js';
import {
  icon, sourceBadge, rankHazards, hiddenKey, joinList, lowerFirst, changeDetector, remount,
  fmtWhen, fmtDay, scrollIntoViewGently,
} from './common.js';

const MAX_RANGES = 3;
// Same threshold the fire detector uses for "the trail crosses the perimeter".
const CROSSING_MILES = 0.03;
// Crossings separated by less than this read as one crossing stretch.
const CROSSING_GAP_MILES = 2;

const LINK_LABELS = {
  fire: 'Fire info',
  alert: 'Official forecast',
  avalanche: 'Avalanche forecast',
  water: 'Gauge details',
  weather: 'Point forecast',
  smoke: 'Smoke map',
};

const ISSUED_WORD = { alert: 'issued', avalanche: 'issued', water: 'observed', smoke: 'as of' };

const RAW_TERRAIN_FACT = /^\d+(?:\.\d+)? mi >=25 deg slope\b|^route \d+–\d+ ft$/;
const COMPACT_WHERE_PREFIX = /^(?:Alert area covers|Forecast zone covers|Forecast for|On the route at|Measured along|Modeled along|Smoke overhead at|Affects)\s+/;

const fmtFt = (n) => Math.round(n).toLocaleString('en-US');

export const terrainContextFact = (ctx) => {
  if (!ctx) return null;
  const elev = Array.isArray(ctx.elevationFt) && ctx.elevationFt.length === 2
    ? `${fmtFt(ctx.elevationFt[0])}–${fmtFt(ctx.elevationFt[1])} ft`
    : null;
  if (ctx.steepMiles > 0) {
    const details = [ctx.maxSlopeDeg >= 25 ? `max ${ctx.maxSlopeDeg}°` : null, elev].filter(Boolean);
    return `${fmtMile(ctx.steepMiles)} mi ≥25° slope${details.length ? ` (${details.join(', ')})` : ''}`;
  }
  if (!elev) return null;
  const details = [ctx.maxSlopeDeg > 0 ? `max ${ctx.maxSlopeDeg}°` : null, elev].filter(Boolean);
  return `Route elevation: ${details.join(', ')}`;
};

export const factsForHazard = (hz) => {
  const base = splitFacts(hz.detail).filter(f =>
    !(hz.issuedAt && /^updated [A-Z][a-z]{2} \d{1,2}$/.test(f)) &&
    !(hz.terrainContext && RAW_TERRAIN_FACT.test(f)));
  const terrain = terrainContextFact(hz.terrainContext);
  if (terrain) base.push(terrain);
  return base;
};

export const rangesText = (ranges) => {
  const shown = ranges.slice(0, MAX_RANGES).map(([a, b]) => fmtRange(a, b));
  const extra = ranges.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} and ${extra} more` : joinList(shown);
};

/** Split ranked hazards into High/Extreme vs Moderate/Low tiers when helpful to scan. */
export const groupHazardsByTier = (list = []) => {
  const urgent = list.filter(hz => (hz.level || 0) >= 3);
  const watch = list.filter(hz => (hz.level || 0) < 3);
  const grouped = list.length >= 4 || (urgent.length > 0 && watch.length > 0);
  return { urgent, watch, grouped };
};

/** Mile stretches where a proximity hazard actually touches the trail, per hazard id. */
const crossingsById = (segments) => {
  const out = new Map();
  for (const s of segments) {
    for (const ref of s.refs) {
      if (!(ref.distance <= CROSSING_MILES)) continue;
      const list = out.get(ref.id) || [];
      const last = list[list.length - 1];
      if (last && s.mileStart - last[1] <= CROSSING_GAP_MILES) last[1] = s.mileEnd;
      else list.push([s.mileStart, s.mileEnd]);
      out.set(ref.id, list);
    }
  }
  return out;
};

const closestText = (closest) => `${fmtDistance(closest.miles)} from the trail (closest at Mi ${fmtMile(closest.atMile)})`;

const compactWhere = (line) => (line ? line.replace(COMPACT_WHERE_PREFIX, '') : '');

/** One or two sentences saying where the hazard meets the route. */
const whereLines = (hz, crossings) => {
  const lines = [];
  const c = hz.closest;
  const touches = crossings?.length || (c && c.miles <= CROSSING_MILES);
  if (hz.kind === 'fire-perimeter') {
    if (crossings?.length) lines.push(`Trail crosses the perimeter at ${rangesText(crossings)}`);
    else if (touches) lines.push(`Trail crosses the perimeter near Mi ${fmtMile(c.atMile)}`);
    else if (c) lines.push(`Perimeter is ${closestText(c)}`);
  } else if (hz.kind === 'fire-incident') {
    if (c) lines.push(`Reported ${touches ? `on the trail near Mi ${fmtMile(c.atMile)}` : closestText(c)}`);
  } else if (hz.kind === 'river-gauge') {
    if (c) lines.push(`Gauge is ${closestText(c)}`);
  } else if (hz.kind === 'air-quality' || hz.kind === 'smoke-plume' || hz.kind === 'trail-conditions') {
    // Their "closest" is a monitor or a sample point, not the hazard: the ranges say where it is.
  } else if (c) {
    lines.push(`${closestText(c).charAt(0).toUpperCase()}${closestText(c).slice(1)}`);
  }

  if (hz.ranges?.length) {
    const area = {
      'nws-alert': 'Alert area covers',
      'avalanche-zone': 'Forecast zone covers',
      'air-quality': 'Measured along',
      'estimated-creek': 'Modeled along',
      'smoke-plume': 'Smoke overhead at',
    }[hz.kind];
    const forecast = hz.source === 'ESTIMATED' && (hz.type === 'weather' || hz.type === 'smoke');
    const prefix = area || (forecast ? 'Forecast for' : lines.length ? 'Affects' : 'On the route at');
    lines.push(`${prefix} ${rangesText(hz.ranges)}`);
  }
  return lines;
};

const whenLine = (hz, now, tz) => {
  const parts = [];
  if (hz.when && hz.type === 'smoke' && Date.parse(hz.when) <= now + 3600e3) parts.push('Already unhealthy now');
  else if (hz.when) parts.push(`${hz.type === 'alert' ? 'Starts' : 'Expected from'} ${fmtWhen(hz.when, tz)}`);
  const expires = Date.parse(hz.expiresAt);
  if (Number.isFinite(expires)) {
    parts.push(expires < now
      ? `Expired ${fmtWhen(expires, tz)} — check for an update`
      : `Until ${fmtWhen(expires, tz)}`);
  }
  return parts.join(', ');
};

/** NWS wraps lines at ~70 characters; rejoin them into paragraphs. */
const paragraphs = (text) => String(text)
  .split(/\n\s*\n/)
  .map(p => p.replace(/\s*\n\s*/g, ' ').trim())
  .filter(Boolean);

const alertDetails = (hz) => {
  if (hz.type !== 'alert' || !hz.description) return null;
  const ratings = [['Severity', hz.severity], ['Certainty', hz.certainty], ['Urgency', hz.urgency]]
    .filter(([, v]) => v && v !== 'Unknown')
    .map(([k, v]) => `${k}: ${String(v).toLowerCase()}`);
  return h('details', { class: 'fulltext', 'data-open-key': `fulltext:${hz.id}` },
    h('summary', {}, icon('chevron'), 'Full alert text'),
    ratings.length ? h('p', { class: 'fulltext-ratings' }, ratings.join(', ')) : null,
    paragraphs(hz.description).map(p => h('p', {}, p)));
};

const sourceLine = (hz, tz) => {
  const url = safeUrl(hz.url);
  // Hourly air readings and satellite passes need the hour, not just the day.
  const hourly = hz.kind === 'air-quality' || hz.kind === 'smoke-plume';
  const issued = hz.issuedAt ? (hourly ? fmtWhen(hz.issuedAt, tz) : fmtDay(hz.issuedAt, tz)) : null;
  const parts = [hz.attribution, issued ? `${ISSUED_WORD[hz.type] || 'updated'} ${issued}` : null].filter(Boolean);
  return h('footer', { class: 'hazard-source' },
    sourceBadge(hz.source),
    parts.length ? h('span', {}, parts.join(', ')) : null,
    url ? h('a', { class: 'hazard-link', href: url, target: '_blank', rel: 'noopener noreferrer' },
      LINK_LABELS[hz.type] || 'More info', icon('external'), h('span', { class: 'visually-hidden' }, ' (opens in a new tab)')) : null);
};

const hazardItem = (hz, ctx) => {
  const where = whereLines(hz, ctx.crossings.get(hz.id));
  const when = whenLine(hz, ctx.now, ctx.tz);
  // The footer already shows the update date, in trail time; skip the server's copy of it.
  const facts = factsForHazard(hz);
  const selected = hz.id === ctx.selectedId;
  const expanded = selected || (ctx.autoExpandSingle && ctx.selectedId == null);
  const info = levelInfo(hz.level);
  const levelText = hz.levelLabel || (info.level === 0 ? 'Clear' : info.short);
  const tagText = hz.source === 'ESTIMATED' ? `${levelText}, estimate` : levelText;
  const firstWhere = compactWhere(where[0]);
  const summaryText = [firstWhere, firstWhere && when ? lowerFirst(when) : when].filter(Boolean).join(', ');

  return h('li', {
    class: `hazard${selected ? ' is-selected' : ''}${expanded ? ' is-expanded' : ''}${hz.level >= 4 ? ' is-extreme' : ''}`,
    'data-hazard-id': hz.id,
  },
  h('button', {
    type: 'button',
    class: 'hazard-title',
    'aria-pressed': String(selected),
    'aria-expanded': String(expanded),
    'data-focus-key': hz.id,
    onclick: () => ctx.onSelect?.(hz.id),
  },
  createHazardBadgeEl(hz),
  h('span', { class: 'hazard-head-main' },
    h('span', { class: 'hazard-head-top' },
      h('span', { class: 'hazard-name' }, hz.title),
      h('span', { class: `hazard-kind-tag${hz.source === 'ESTIMATED' ? ' is-estimated' : ''}${hz.level >= 4 ? ' is-extreme' : ''}` }, tagText)),
    summaryText ? h('span', { class: 'hazard-summary' }, summaryText) : null),
  icon('chevron'),
  h('span', { class: 'visually-hidden' }, ' — toggle details and show on map')),
  h('div', { class: 'hazard-body', hidden: !expanded },
    where.map((line, i) => h('p', { class: i === 0 ? 'hazard-where' : 'hazard-where-more' }, line)),
    when ? h('p', { class: 'hazard-when' }, icon('stale'), when) : null,
    facts.length ? h('ul', { class: 'facts' }, facts.map(f => h('li', {}, f))) : null,
    hz.advice ? h('p', { class: 'advice' }, h('span', { class: 'advice-label' }, 'What to do'), hz.advice) : null,
    alertDetails(hz),
    sourceLine(hz, ctx.tz)));
};

const hazardGroup = (heading, items, ctx) => h('section', { class: 'hazard-group' },
  h('h3', { class: 'hazard-group-head' },
    h('span', {}, heading),
    h('span', { class: 'hazard-group-count' }, String(items.length))),
  h('ul', { class: 'hazard-list' }, items.map(hz => hazardItem(hz, ctx))));

const hazardListNodes = (list, ctx) => {
  const { urgent, watch, grouped } = groupHazardsByTier(list);
  if (!grouped) return h('ul', { class: 'hazard-list' }, list.map(hz => hazardItem(hz, ctx)));
  return h('div', { class: 'hazard-groups' },
    urgent.length ? hazardGroup('High & Extreme', urgent, ctx) : null,
    watch.length ? hazardGroup('Moderate & Low', watch, ctx) : null);
};

const isBehind = (hz, mile) => mile != null && hz.ranges?.length > 0 && hz.ranges[hz.ranges.length - 1][1] <= mile;

/**
 * No hazards. The all-clear wording is only for a complete check; anything
 * Ridgeline couldn't cover (a source down, a stretch outside US data,
 * unrated avalanche terrain, the forecast window) is listed under it.
 */
const emptyState = (result) => {
  const { incomplete, incompleteSources = [], caveats = [] } = result.summary;
  const notes = caveats.length ? h('ul', { class: 'empty-caveats' }, caveats.map(text => h('li', {}, text))) : null;
  if (!incomplete && !caveats.length) {
    return h('div', { class: 'empty' },
      h('p', { class: 'empty-title' }, 'No reported hazards on this route'),
      h('p', {}, 'No wildfires, alerts, avalanche danger, river flooding, unhealthy air, smoke, snow, ice or forecast concerns touch this route right now.'));
  }
  if (!incomplete) {
    return h('div', { class: 'empty' },
      h('p', { class: 'empty-title' }, 'No reported hazards on this route'),
      h('p', {}, 'Nothing was found where Ridgeline could check. Keep in mind:'),
      notes);
  }
  return h('div', { class: 'empty' },
    h('p', { class: 'empty-title' }, 'Nothing found in the data Ridgeline could reach'),
    incompleteSources.length ? h('p', {}, `Some sources didn't load (see Data), so this is not an all-clear.`)
      : h('p', {}, 'Part of this route could not be checked, so this is not an all-clear.'),
    notes);
};

/**
 * createHazards(container, { onSelect(id), onShowAll() })
 *   .render({ result, hiddenTypes, mile, now, selected }), .setSelected(id), .reveal(id)
 * `mile` is the hiker's position in On trail mode (hazards behind collapse), else null.
 */
export const createHazards = (container, { onSelect, onShowAll } = {}) => {
  const changed = changeDetector();
  let selectedId = null;

  const render = ({ result, hiddenTypes, mile = null, now = Date.now(), selected = null }) => {
    const ranked = result ? rankHazards(result.hazards) : [];
    const behindKey = ranked.filter(hz => isBehind(hz, mile)).map(hz => hz.id).join(',');
    const expiredKey = ranked.filter(hz => Date.parse(hz.expiresAt) < now).map(hz => hz.id).join(',');
    if (!changed([result, hiddenKey(hiddenTypes), behindKey, expiredKey])) {
      // The app owns the selection; sync it in place so focus and scroll stay put.
      if (selected !== selectedId) setSelected(selected);
      return;
    }
    selectedId = selected;

    if (!result) {
      remount(container, h('p', { class: 'empty' }, 'Hazards appear here when the check finishes.'));
      return;
    }
    const visible = ranked.filter(hz => !hiddenTypes.has(hz.type));
    const hiddenCount = ranked.length - visible.length;
    const ahead = visible.filter(hz => !isBehind(hz, mile));
    const behind = visible.filter(hz => isBehind(hz, mile));
    const ctx = {
      crossings: crossingsById(result.segments),
      now,
      tz: result.route?.timeZone,
      selectedId,
      autoExpandSingle: visible.length === 1,
      onSelect,
    };

    remount(container,
      hiddenCount ? h('p', { class: 'hidden-note' },
        `${hiddenCount} hidden by filters. `,
        h('button', { type: 'button', class: 'link-button', 'data-focus-key': 'show-all', onclick: onShowAll }, 'Show all')) : null,
      ranked.length === 0 ? emptyState(result) : null,
      ranked.length > 0 && visible.length === 0
        ? h('p', { class: 'empty' }, `All ${plural(ranked.length, 'hazard')} are hidden by filters.`) : null,
      ahead.length ? hazardListNodes(ahead, ctx) : null,
      behind.length ? h('details', { class: 'behind', 'data-open-key': 'behind' },
        h('summary', {}, icon('chevron'), `Behind you (${plural(behind.length, 'hazard')})`),
        h('ul', { class: 'hazard-list' }, behind.map(hz => hazardItem(hz, ctx)))) : null,
      h('p', { class: 'list-footnote' }, 'Conditions change fast. Check with the land manager and official forecasts before you go.'));
  };

  const setSelected = (id) => {
    selectedId = id;
    const items = [...container.querySelectorAll('.hazard')];
    const autoExpandSingle = items.length === 1 && !id;
    for (const item of items) {
      const on = item.dataset.hazardId === id;
      const expanded = on || autoExpandSingle;
      item.classList.toggle('is-selected', on);
      item.classList.toggle('is-expanded', expanded);
      const btn = item.querySelector('.hazard-title');
      if (btn) {
        btn.setAttribute('aria-pressed', String(on));
        btn.setAttribute('aria-expanded', String(expanded));
      }
      const body = item.querySelector('.hazard-body');
      if (body) body.hidden = !expanded;
    }
  };

  /** Bring a hazard into view (e.g. after a map click) and move focus to it. */
  const reveal = (id) => {
    const item = [...container.querySelectorAll('.hazard')].find(el => el.dataset.hazardId === id);
    if (!item) return;
    const fold = item.closest('details');
    if (fold) fold.open = true;
    scrollIntoViewGently(item);
    item.querySelector('.hazard-title')?.focus({ preventScroll: true });
  };

  return { render, setSelected, reveal };
};
