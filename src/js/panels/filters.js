/**
 * Hazard-type chips. Only types present in the result get a chip, each with
 * its count. Pressed = shown; everything is shown by default.
 */
import { h, mount } from '../ui/dom.js';
import { HAZARD_TYPES } from '../../../shared/levels.js';
import { plural } from '../ui/format.js';

const countByType = (result) => {
  const counts = new Map();
  for (const hz of Object.values(result?.hazards || {})) {
    if (HAZARD_TYPES[hz.type]) counts.set(hz.type, (counts.get(hz.type) || 0) + 1);
  }
  return Object.keys(HAZARD_TYPES).filter(t => counts.has(t)).map(t => [t, counts.get(t)]);
};

export const createFilters = (container, { onToggle } = {}) => {
  let builtFor = '';
  let buttons = new Map();

  const build = (types) => {
    buttons = new Map();
    const chips = types.map(([type, count]) => {
      const info = HAZARD_TYPES[type];
      const button = h('button', {
        type: 'button',
        class: 'chip',
        'aria-pressed': 'true',
        'aria-label': `${info.label}, ${plural(count, 'hazard')}`,
        onclick: () => onToggle?.(type),
      },
      h('span', { class: 'chip-swatch', style: `--swatch:${info.color}`, 'aria-hidden': 'true' }),
      info.label,
      h('span', { class: 'chip-count', 'aria-hidden': 'true' }, String(count)));
      buttons.set(type, button);
      return button;
    });
    mount(container, h('div', { class: 'chips', role: 'group', 'aria-label': 'Show hazard types' }, chips));
  };

  const render = ({ result, hiddenTypes }) => {
    const types = countByType(result);
    container.hidden = types.length === 0;
    const key = types.map(([t, n]) => `${t}:${n}`).join(',');
    if (key !== builtFor) {
      build(types);
      builtFor = key;
    }
    // Update pressed state in place so the focused chip keeps focus.
    for (const [type, button] of buttons) button.setAttribute('aria-pressed', String(!hiddenTypes.has(type)));
  };

  return { render };
};
