/** Recently opened routes, stored on this device. Open or remove each one. */
import { h } from '../ui/dom.js';
import { fmtAgo } from '../ui/format.js';
import { icon, remount, changeDetector, fmtTotal } from './common.js';

const metaText = (route, now) => {
  const parts = [];
  if (Number.isFinite(route.meta?.lengthMiles)) parts.push(`${fmtTotal(route.meta.lengthMiles)} mi`);
  parts.push(`opened ${fmtAgo(route.openedAt, now)}`);
  return parts.join(', ');
};

/**
 * createRecent(container, { onOpen(id), onRemove(id), fallbackFocus }).render(routes, now)
 * `routes` are summaries from db.listRoutes(); `fallbackFocus` receives focus
 * when the last route is removed.
 */
export const createRecent = (container, { onOpen, onRemove, fallbackFocus = null } = {}) => {
  const changed = changeDetector();
  let lastIds = [];

  const item = (route, now) => h('li', { class: 'recent-item' },
    h('button', { type: 'button', class: 'recent-open', 'data-focus-key': `open:${route.id}`, onclick: () => onOpen?.(route.id) },
      h('span', { class: 'recent-name' }, route.name || 'Untitled route'),
      h('span', { class: 'recent-meta' }, metaText(route, now))),
    h('button', {
      type: 'button',
      class: 'btn btn-quiet btn-icon',
      'aria-label': `Remove ${route.name || 'this route'} from recent routes`,
      'data-focus-key': `remove:${route.id}`,
      onclick: () => onRemove?.(route.id),
    }, icon('trash')));

  const render = (routes = [], now = Date.now()) => {
    if (!changed([routes, Math.floor(now / 60000)])) return;
    const ids = routes.map(r => r.id);
    // Focus was on a route that just got removed: hand it to the neighbor, or the heading.
    const active = document.activeElement;
    const removedFocus = active && container.contains(active) && /^remove:/.test(active.dataset.focusKey || '') &&
      !ids.includes(active.dataset.focusKey.slice('remove:'.length));
    const removedIndex = removedFocus ? lastIds.indexOf(active.dataset.focusKey.slice('remove:'.length)) : -1;
    lastIds = ids;

    container.hidden = routes.length === 0;
    remount(container, routes.length ? h('section', { class: 'recent', 'aria-labelledby': 'recent-title' },
      h('h2', { id: 'recent-title', class: 'section-title' }, 'Recent routes'),
      h('ul', { class: 'recent-list' }, routes.map(r => item(r, now)))) : null);

    if (removedFocus) {
      const neighbor = routes[Math.min(removedIndex, routes.length - 1)];
      const target = neighbor && container.querySelector(`[data-focus-key="${CSS.escape(`remove:${neighbor.id}`)}"]`);
      (target || fallbackFocus)?.focus();
    }
  };

  return { render };
};
