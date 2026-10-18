/**
 * Notices above the verdict: failed checks, offline, file problems.
 *
 * Banners are keyed. An unchanged banner is left alone, so screen readers
 * hear each one once (errors via role=alert, everything else via
 * role=status) rather than on every render.
 *
 *   render([{ key, tone: 'error'|'warning'|'info', text, detail?, action?: { label, onClick } }])
 */
import { h } from '../ui/dom.js';
import { icon } from './common.js';

const TONE_ICON = { error: 'error', warning: 'warning', info: 'info' };

const signature = (b) => [b.tone, b.text, b.detail || '', b.action?.label || ''].join('\u0001');

const buildBanner = (b) => h('div', {
  class: `banner banner-${b.tone}`,
  role: b.tone === 'error' ? 'alert' : 'status',
  'data-key': b.key,
},
icon(TONE_ICON[b.tone] || 'info'),
h('div', { class: 'banner-body' },
  h('p', { class: 'banner-text' }, b.text),
  b.detail ? h('p', { class: 'banner-detail' }, b.detail) : null,
  b.action ? h('button', {
    type: 'button',
    class: 'btn btn-small banner-action',
    'data-focus-key': `banner:${b.key}`,
    onclick: b.action.onClick,
  }, b.action.label) : null));

export const createBanner = (container) => {
  const shown = new Map(); // key -> { el, sig }

  const render = (banners = []) => {
    const keep = new Set(banners.map(b => b.key));
    for (const [key, entry] of shown) {
      if (!keep.has(key)) {
        entry.el.remove();
        shown.delete(key);
      }
    }
    let previous = null;
    for (const b of banners) {
      const sig = signature(b);
      let entry = shown.get(b.key);
      if (!entry || entry.sig !== sig) {
        const el = buildBanner(b);
        if (entry) entry.el.replaceWith(el);
        entry = { el, sig };
        shown.set(b.key, entry);
      }
      // Keep DOM order equal to the requested order.
      const expectedNext = previous ? previous.nextSibling : container.firstChild;
      if (expectedNext !== entry.el) container.insertBefore(entry.el, expectedNext);
      previous = entry.el;
    }
  };

  return { render };
};
