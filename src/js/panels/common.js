/** Building blocks shared by the panels: icons, level chips, badges, time formats, tabs. */
import { h, mount } from '../ui/dom.js';
import { levelInfo } from '../../../shared/levels.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING = 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z';

const ICON_PATHS = {
  ok: `${RING}M8 12.5l2.8 2.8L16.2 9.5`,
  error: `${RING}M9 9l6 6M15 9l-6 6`,
  stale: `${RING}M12 7v5l3.2 2`,
  partial: `${RING}M12 3v18M12 12h9`,
  skipped: `${RING}M8 12h8`,
  warning: 'M12 3.8L2.6 20h18.8L12 3.8zM12 10v4.2M12 17.2v.1',
  info: `${RING}M12 11v5.5M12 7.8v.1`,
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4',
  upload: 'M12 15V4M7.5 8.5L12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  locate: 'M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM12 2v3M12 19v3M2 12h3M19 12h3M12 12.5v-1',
  pin: 'M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  plus: 'M12 6v12M6 12h12',
  minus: 'M6 12h12',
  close: 'M6 6l12 12M18 6L6 18',
  external: 'M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4',
  chevron: 'M6 9l6 6 6-6',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2V6zM9 4v14M15 6v14',
  route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 17h4a3 3 0 0 0 3-3v-2a3 3 0 0 1 3-3',
  mountain: 'M3 19l6-11 4 6 3-4 5 9H3z',
  database: 'M4 6c0 1.66 3.58 3 8 3s8-1.34 8-3-3.58-3-8-3-8 1.34-8 3zM4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3',
  download: 'M12 4v11M7.5 11.5L12 16l4.5-4.5M4 19h16',
  copy: 'M9 9h10v10H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
};

/** Decorative stroke icon (aria-hidden); the adjacent text carries the meaning. */
export const icon = (name) => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.append(path);
  return svg;
};

/** Readable text on a solid level color (contrast ≥ 4.5:1 for every level). */
export const textOnLevel = (level) => (levelInfo(level).level >= 3 ? '#ffffff' : '#1d2622');

/** A small swatch + word. Never color alone; hatched when the level is only an estimate. */
export const levelChip = (level, { estimated = false, label = null } = {}) => {
  const info = levelInfo(level);
  return h('span', { class: `level-chip level-${info.key}` },
    h('span', {
      class: `swatch${estimated ? ' swatch-estimated' : ''}`,
      style: `--swatch:${info.color}`,
      'aria-hidden': 'true',
    }),
    label || (info.level === 0 ? 'Clear' : info.short));
};

export const sourceBadge = (source) => (source === 'ESTIMATED'
  ? h('span', { class: 'badge badge-estimate' }, 'Estimate')
  : h('span', { class: 'badge badge-official' }, 'Official'));

/** Hazards by severity, official before estimated, then by where they start on the route. */
export const rankHazards = (hazards = {}) => Object.values(hazards).sort((a, b) =>
  b.level - a.level ||
  (a.source === 'OFFICIAL' ? 0 : 1) - (b.source === 'OFFICIAL' ? 0 : 1) ||
  firstMile(a) - firstMile(b));

const firstMile = (hz) => (hz.ranges?.length ? hz.ranges[0][0] : Infinity);

/** Stable string for a Set of hidden types, used to skip redundant re-renders. */
export const hiddenKey = (hiddenTypes) => [...hiddenTypes].sort().join(',');

/** Lowercase a leading capitalized word for use mid-sentence; leaves acronyms like "NWS" alone. */
export const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

/** "A", "A and B", "A, B and C". */
export const joinList = (items) => {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
};

/** Returns true when any dependency differs from the previous call. */
export const changeDetector = () => {
  let prev = null;
  return (deps) => {
    const same = prev && prev.length === deps.length && deps.every((d, i) => Object.is(d, prev[i]));
    prev = deps;
    return !same;
  };
};

/**
 * Replace a container's children without losing what the reader was doing:
 * the focused element (by data-focus-key) gets focus back, and <details>
 * with a data-open-key stay open.
 */
export const remount = (container, ...children) => {
  const active = document.activeElement;
  const key = active && container.contains(active) ? active.dataset.focusKey : null;
  const open = new Set([...container.querySelectorAll('details[open][data-open-key]')].map(d => d.dataset.openKey));
  mount(container, ...children);
  for (const d of container.querySelectorAll('details[data-open-key]')) {
    if (open.has(d.dataset.openKey)) d.open = true;
  }
  if (!key) return;
  const next = container.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
  next?.focus({ preventScroll: true });
};

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const scrollIntoViewGently = (el) =>
  el.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });

const zoneCache = new Map();
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const validZone = (tz) => {
  if (!tz) return undefined;
  if (!zoneCache.has(tz)) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      zoneCache.set(tz, tz);
    } catch {
      zoneCache.set(tz, undefined);
    }
  }
  return zoneCache.get(tz);
};

/**
 * Format a timestamp in the route's own time zone, so a trip planned from
 * another state still reads "until 8:00 PM" in trail time. The zone name is
 * shown when it differs from the viewer's, and whenever the route's zone is
 * unknown, so a time in the viewer's zone is never mistaken for trail time.
 */
const fmtIn = (iso, timeZone, options) => {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const tz = validZone(timeZone);
  const opts = { ...options, timeZone: tz };
  if (options.hour && (!tz || tz !== localZone)) opts.timeZoneName = 'short';
  return new Date(ms).toLocaleString([], opts);
};

/** "Sat, Oct 18, 2:00 PM" */
export const fmtWhen = (iso, timeZone) =>
  fmtIn(iso, timeZone, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** "6:12 PM" */
export const fmtTimeOfDay = (iso, timeZone) => fmtIn(iso, timeZone, { hour: 'numeric', minute: '2-digit' });

/** "Oct 15" */
export const fmtDay = (iso, timeZone) => fmtIn(iso, timeZone, { month: 'short', day: 'numeric' });

/** "2:15 PM" today, otherwise "Oct 15, 2:15 PM" — stable text for banners that should not tick. */
export const fmtStamp = (iso, now = Date.now()) => {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return 'an earlier check';
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  return new Date(ms).toLocaleString([], sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

/** Route totals: "210.4", "3,410" (format.js fmtMile rounds past 100 mi, which reads as imprecise here). */
export const fmtTotal = (miles) => (miles >= 1000 ? Math.round(miles).toLocaleString('en-US') : String(Math.round(miles * 10) / 10));

const fmtInt = (n) => Math.round(n).toLocaleString('en-US');

/** Compact route line under #route-name, incorporating DEM backfill when GPX lacked Z. */
export const fmtRouteMeta = (route, result = null, { busy = false } = {}) => {
  const parts = [`${fmtTotal(route.lengthMiles)} mi`];
  if (route.meta?.trackCount > 1) parts.push(`joined ${route.meta.trackCount} tracks`);
  const elev = result?.route?.elevationFt;
  if (elev && Number.isFinite(elev.min) && Number.isFinite(elev.max)) {
    const range = elev.min === elev.max ? `${fmtInt(elev.max)} ft` : `${fmtInt(elev.min)}–${fmtInt(elev.max)} ft`;
    const dem = elev.source === 'landfire' ? ', DEM' : '';
    parts.push(elev.gain > 0 ? `+${fmtInt(elev.gain)} ft (${range}${dem})` : `${range}${dem ? ' (DEM)' : ''}`);
  } else if (!route.hasElevation && !busy) {
    parts.push('no elevation data');
  }
  return parts.join(', ');
};

/** Whether two optional trip itineraries describe the same start timestamp and pace. */
export const sameTrip = (a, b) => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return Date.parse(a.startAt) === Date.parse(b.startAt) && Math.abs((a.paceMilesPerDay || 12) - (b.paceMilesPerDay || 12)) < 0.05;
};

export const shouldShowScrollTop = (scrollTop, view, threshold = 160) =>
  view === 'route' && Number.isFinite(scrollTop) && scrollTop > threshold;

/** "4 mi", "0.6 mi" — segment lengths without a trailing ".0". */
export const fmtLength = (miles) => {
  const r = miles >= 10 ? Math.round(miles) : Math.round(miles * 10) / 10;
  return `${r < 0.1 ? '<0.1' : r.toLocaleString('en-US')} mi`;
};

/** The hiker's own mile always keeps one decimal — it is matched against trail apps and signs. */
export const fmtPosition = (mile) => (Math.round(mile * 10) / 10).toFixed(1);

/**
 * WAI-ARIA tabs: roving tabindex, arrow keys / Home / End move and select.
 * Tabs carry data-tab and aria-controls pointing at their panel.
 */
export const createTabs = (tablist, { onChange } = {}) => {
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const select = (name, { focus = false } = {}) => {
    for (const tab of tabs) {
      const on = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !on;
      if (on && focus) tab.focus();
    }
    onChange?.(name);
  };
  tablist.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) select(tab.dataset.tab);
  });
  tablist.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const target = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (target === undefined) return;
    e.preventDefault();
    select(tabs[(target + tabs.length) % tabs.length].dataset.tab, { focus: true });
  });
  return { select };
};
