/**
 * "Since your last check": official hazards that are new, cleared, worse or
 * better than at the previous check of this route. Hidden when nothing
 * changed, so it never shows yesterday's news.
 */
import { h } from '../ui/dom.js';
import { fmtAgo } from '../ui/format.js';
import { levelInfo } from '../../../shared/levels.js';
import { levelChip, changeDetector, remount } from './common.js';
import { rangesText } from './hazards.js';

const KIND_WORD = { new: 'New', cleared: 'Cleared', escalated: 'Worse', eased: 'Better' };

const detailText = (c) => {
  if (c.kind === 'cleared') return 'No longer reported';
  if (c.kind === 'new') return c.ranges?.length ? rangesText(c.ranges) : '';
  return `was ${levelInfo(c.from).short.toLowerCase()}`;
};

const changeItem = (c, onSelect) => {
  const title = c.kind === 'cleared'
    ? h('span', { class: 'change-title' }, c.title)
    : h('button', { type: 'button', class: 'change-title link-button', 'data-focus-key': `change:${c.id}`, onclick: () => onSelect?.(c.id) }, c.title);
  return h('li', { class: `change change-${c.kind}` },
    h('span', { class: 'change-kind' }, KIND_WORD[c.kind]),
    h('span', { class: 'change-body' },
      title,
      h('span', { class: 'change-detail' }, c.kind === 'cleared' ? null : levelChip(c.to), detailText(c))));
};

/**
 * createChanges(container, { onSelect(id), onDismiss() })
 *   .render({ changes: { previousAt, changes: [...] } | null, now })
 */
export const createChanges = (container, { onSelect, onDismiss } = {}) => {
  const changed = changeDetector();

  const render = ({ changes, now = Date.now() }) => {
    const list = changes?.changes || [];
    const ago = changes?.previousAt ? fmtAgo(Date.parse(changes.previousAt), now) : '';
    if (!changed([changes, ago])) return;
    container.hidden = list.length === 0;
    if (!list.length) {
      remount(container);
      return;
    }
    remount(container, h('section', { class: 'changes', 'aria-labelledby': 'changes-title' },
      h('div', { class: 'changes-head' },
        h('h2', { id: 'changes-title', class: 'changes-title' }, ago ? `Since your last check (${ago})` : 'Since your last check'),
        h('button', { type: 'button', class: 'btn btn-quiet btn-small', 'data-focus-key': 'dismiss', onclick: onDismiss }, 'Mark as seen')),
      h('ul', { class: 'change-list' }, list.map(c => changeItem(c, onSelect)))));
  };

  return { render };
};
