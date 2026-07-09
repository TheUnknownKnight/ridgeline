/**
 * Filter Pills — Hazard type toggle buttons
 * Allows users to show/hide segment cards by hazard type.
 */

const PILL_CONFIG = [
  { type: 'fire',        label: 'Fire',      dotColor: 'var(--accent-rust)' },
  { type: 'weather-alert', label: 'Weather', dotColor: 'var(--accent-amber)' },
  { type: 'avalanche',   label: 'Avalanche', dotColor: 'var(--accent-ice)' },
  { type: 'snowpack',    label: 'Snowpack',  dotColor: 'var(--text-secondary)' }
];

/**
 * Set up filter pill buttons inside a container element.
 * @param {string} containerId — The DOM id of the container div
 * @param {function} onFilterChange — Called with a Set of active type strings whenever a pill is toggled
 */
export const setupFilterPills = (containerId, onFilterChange) => {
  const container = document.getElementById(containerId);
  if (!container) return;

  const activeTypes = new Set(PILL_CONFIG.map(p => p.type));

  container.innerHTML = '';

  for (const pill of PILL_CONFIG) {
    const btn = document.createElement('button');
    btn.className = 'filter-pill active';
    btn.dataset.type = pill.type;
    btn.id = `filter-pill-${pill.type}`;

    const dot = document.createElement('span');
    dot.className = 'pill-dot';
    dot.style.background = pill.dotColor;

    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(pill.label));

    btn.addEventListener('click', () => {
      if (activeTypes.has(pill.type)) {
        activeTypes.delete(pill.type);
        btn.classList.remove('active');
      } else {
        activeTypes.add(pill.type);
        btn.classList.add('active');
      }
      onFilterChange(new Set(activeTypes));
    });

    container.appendChild(btn);
  }

  return activeTypes;
};
