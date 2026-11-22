/**
 * Compact "Offline pack" bar: lets a hiker save the route GPX, latest hazard
 * check, and corridor map tiles to the device before heading out of cell service,
 * and shows clearly whether the current route is ready for offline On-trail use.
 */
import { h, mount } from '../ui/dom.js';
import { fmtAgo } from '../ui/format.js';
import { icon } from './common.js';

export const offlinePackSummary = (pack, { online = true, busy = false, progress = null, result = null, now = Date.now() } = {}) => {
  if (busy) {
    if (progress?.phase === 'tiles' && progress.total > 0) {
      return `Saving offline map (${progress.done}/${progress.total} tiles)…`;
    }
    return 'Preparing offline trail pack…';
  }
  if (pack?.savedAt) {
    const bits = [];
    if (pack.tileCount > 0) bits.push(`${pack.tileCount} map tiles`);
    bits.push(`saved ${fmtAgo(pack.savedAt, now)}`);
    if (!result) bits.push('no hazard check saved yet');
    return `Offline ready, ${bits.join(', ')}`;
  }
  if (!online) {
    return result
      ? 'Offline mode, route & last check are cached (map tiles not pre-saved)'
      : 'Offline mode, GPX & GPS work locally (no hazard check cached)';
  }
  return 'Save map tiles & hazard check for no-service use';
};

export const createOfflinePackPanel = (container, { onSave, onCancel } = {}) => {
  const statusIcon = h('span', { class: 'offline-bar-icon', 'aria-hidden': 'true' });
  const statusText = h('span', { class: 'offline-bar-text' });
  const actionBtn = h('button', { type: 'button', class: 'btn btn-small offline-bar-btn' });
  const progressBar = h('div', { class: 'offline-progress', hidden: true },
    h('div', { class: 'offline-progress-fill' }));
  const progressFill = progressBar.firstChild;

  const row = h('div', { class: 'offline-bar-row' }, statusIcon, statusText, actionBtn);
  mount(container, row, progressBar);

  let mode = 'idle'; // 'idle' | 'busy'
  actionBtn.addEventListener('click', () => {
    if (mode === 'busy') onCancel?.();
    else onSave?.();
  });

  const render = ({ pack = null, online = true, busy = false, progress = null, result = null, now = Date.now() } = {}) => {
    mode = busy ? 'busy' : 'idle';
    container.classList.toggle('is-ready', Boolean(pack?.savedAt) && !busy);
    container.classList.toggle('is-busy', busy);

    statusIcon.replaceChildren(icon(busy ? 'download' : pack?.savedAt ? 'ok' : online ? 'download' : 'info'));
    statusText.textContent = offlinePackSummary(pack, { online, busy, progress, result, now });

    if (busy) {
      actionBtn.hidden = false;
      actionBtn.disabled = false;
      actionBtn.className = 'btn btn-quiet btn-small offline-bar-btn';
      actionBtn.textContent = 'Cancel';
    } else if (!online) {
      actionBtn.hidden = true;
    } else {
      actionBtn.hidden = false;
      actionBtn.disabled = false;
      actionBtn.className = pack?.savedAt ? 'btn btn-quiet btn-small offline-bar-btn' : 'btn btn-small offline-bar-btn';
      actionBtn.textContent = pack?.savedAt ? 'Update pack' : 'Save offline';
    }

    const showBar = busy && progress?.phase === 'tiles' && progress.total > 0;
    progressBar.hidden = !showBar;
    if (showBar) {
      const pct = Math.min(100, Math.max(4, Math.round((progress.done / progress.total) * 100)));
      progressFill.style.width = `${pct}%`;
    }
  };

  return { render };
};
