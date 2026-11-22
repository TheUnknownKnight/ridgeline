/**
 * Explore Trail Finder: free US trail search, Featured / Near me / Saved filter
 * chips, trail cards with region / miles / agency / Offline & severity badges,
 * and a quick "+ GPX" upload action. Constructed strictly via DOM nodes
 * (never innerHTML) with debounced, abort-safe queries and graceful offline fallback.
 */
import { searchTrails, fetchTrailTrack } from '../api/trails.js';
import { h, mount } from '../ui/dom.js';
import { icon, levelChip, fmtTotal } from './common.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SEARCH_DEBOUNCE_MS = 300;
const GEO_TIMEOUT_MS = 8000;

const CHIPS = [
  { id: 'featured', label: 'Featured' },
  { id: 'near', label: 'Near me' },
  { id: 'saved', label: 'Saved' },
];

const searchIcon = () => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon icon-search');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', '11');
  circle.setAttribute('cy', '11');
  circle.setAttribute('r', '7');
  const line = document.createElementNS(SVG_NS, 'path');
  line.setAttribute('d', 'M20 20l-4.2-4.2');
  svg.append(circle, line);
  return svg;
};

const fmtGain = (ft) => (Number.isFinite(ft) && ft > 0 ? `+${Math.round(ft).toLocaleString('en-US')} ft` : null);

const trailMetaLine = (trail) => {
  const parts = [];
  if (trail.region) parts.push(trail.region);
  if (Number.isFinite(trail.lengthMiles) && trail.lengthMiles > 0) parts.push(`${fmtTotal(trail.lengthMiles)} mi`);
  const gain = fmtGain(trail.gainFt);
  if (gain) parts.push(gain);
  if (trail.agency) parts.push(trail.agency);
  return parts.join(' · ');
};

const savedFallbackTrails = (savedRoutes = [], query = '') => {
  const needle = query.trim().toLowerCase();
  return savedRoutes
    .filter(r => !needle || String(r.name || '').toLowerCase().includes(needle))
    .map(r => ({
      id: `saved:${r.id}`,
      savedId: r.id,
      name: r.name || 'Saved route',
      region: r.meta?.region || 'Saved on this device',
      agency: r.meta?.agency || null,
      lengthMiles: Number.isFinite(r.lengthMiles) ? r.lengthMiles : (r.meta?.lengthMiles ?? null),
      gainFt: r.meta?.gainFt ?? null,
      source: 'saved',
      offlineReady: Boolean(r.offlineReady || r.offlinePack?.savedAt),
      level: Number.isFinite(r.level) ? r.level : null,
    }));
};

const savedSignature = (routes = []) =>
  routes.map(r => `${r.id}:${r.openedAt || 0}:${r.offlinePack?.savedAt || 0}:${r.level ?? ''}`).join('|');

/**
 * createExplore(container, { onOpenTrail(track, trail), onOpenSaved(id), onRemoveSaved(id), onOpenFile() })
 *   .render({ savedRoutes, online, gpsFix })
 *   .focusSearch()
 *   .cancelPending()
 */
export const createExplore = (container, { onOpenTrail, onOpenSaved, onRemoveSaved, onOpenFile } = {}) => {
  let query = '';
  let activeChip = 'featured';
  let savedRoutes = [];
  let online = true;
  let userLocation = null;
  let locating = false;
  let locationNote = null;
  let loading = false;
  let openingId = null;
  let trails = [];
  let note = null;
  let error = null;
  let initialized = false;
  let lastSavedSig = '';
  let lastOnline = true;
  let searchSeq = 0;
  let searchAbort = null;
  let openAbort = null;
  let debounceTimer = 0;

  const input = h('input', {
    type: 'search',
    id: 'explore-search',
    class: 'explore-search-input',
    placeholder: 'Search US trails or parks...',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Search US trails or parks',
  });
  const clearBtn = h('button', {
    type: 'button',
    class: 'explore-clear',
    'aria-label': 'Clear search',
    hidden: true,
  }, icon('close'));
  const gpxBtn = h('button', {
    type: 'button',
    id: 'explore-gpx-btn',
    class: 'btn btn-primary explore-gpx-btn',
    title: 'Open a GPX, KML or GeoJSON file',
    onclick: () => onOpenFile?.(),
  }, icon('plus'), h('span', {}, 'GPX'));

  const chipButtons = new Map();
  const savedBadge = h('span', { class: 'explore-chip-count', hidden: true });
  const chipsRow = h('div', { class: 'explore-chips', role: 'group', 'aria-label': 'Trail filters' },
    CHIPS.map(({ id, label }) => {
      const btn = h('button', {
        type: 'button',
        class: 'panel-pill explore-chip',
        'data-filter': id,
        'aria-pressed': String(id === activeChip),
      }, label, id === 'saved' ? savedBadge : null);
      chipButtons.set(id, btn);
      return btn;
    }));

  const statusEl = h('p', { class: 'explore-status', 'aria-live': 'polite', hidden: true });
  const listEl = h('ul', { class: 'explore-list', 'aria-label': 'Trails' });

  const root = h('div', { class: 'explore' },
    h('div', { class: 'explore-bar' },
      h('div', { class: 'explore-search-wrap' }, searchIcon(), input, clearBtn),
      gpxBtn),
    chipsRow,
    statusEl,
    listEl);
  mount(container, root);

  const effectiveFilter = () => {
    const trimmed = query.trim();
    if (!trimmed) return activeChip;
    return activeChip === 'saved' ? 'saved' : 'all';
  };

  const syncChips = () => {
    const hasQuery = query.trim().length > 0;
    for (const [id, btn] of chipButtons) {
      const pressed = !hasQuery ? id === activeChip : (activeChip === 'saved' && id === 'saved');
      btn.setAttribute('aria-pressed', String(pressed));
    }
    savedBadge.hidden = savedRoutes.length === 0;
    savedBadge.textContent = savedRoutes.length ? String(savedRoutes.length) : '';
  };

  const syncStatus = () => {
    let text = '';
    let tone = '';
    if (error) {
      text = error;
      tone = 'error';
    } else if (locating && activeChip === 'near' && !query.trim()) {
      text = 'Finding your location for nearby trails…';
    } else if (loading) {
      text = query.trim() ? `Searching for “${query.trim()}”…` : 'Loading trails…';
    } else if (note) {
      text = note;
    } else if (locationNote && activeChip === 'near' && !query.trim()) {
      text = locationNote;
    }
    statusEl.textContent = text;
    statusEl.hidden = !text;
    statusEl.classList.toggle('is-error', tone === 'error');
  };

  const renderCards = () => {
    if (!trails.length) {
      if (loading || locating) {
        mount(listEl, h('li', { class: 'explore-empty' }, 'Looking up trails…'));
        return;
      }
      let emptyTitle = 'No matching trails found';
      let emptyDetail = 'Try another trail or park name, or tap + GPX to load your own route file.';
      if (activeChip === 'saved' && !query.trim()) {
        emptyTitle = 'No saved routes yet';
        emptyDetail = 'Open any Featured trail or upload a GPX file to keep it ready on this device.';
      } else if (activeChip === 'near' && !userLocation && !query.trim()) {
        emptyTitle = 'Location needed for Near me';
        emptyDetail = 'Allow location access to find nearby trails, or search by park or trail name above.';
      }
      mount(listEl, h('li', { class: 'explore-empty' },
        h('p', { class: 'explore-empty-title' }, emptyTitle),
        h('p', { class: 'explore-empty-detail' }, emptyDetail)));
      return;
    }

    const showRemove = activeChip === 'saved';
    mount(listEl, trails.map((trail) => {
      const busy = openingId === trail.id;
      const meta = trailMetaLine(trail);
      const hasLevel = Boolean(trail.savedId) && Number.isFinite(trail.level);
      const openBtn = h('button', {
        type: 'button',
        class: `explore-card-open${busy ? ' is-loading' : ''}`,
        disabled: Boolean(openingId),
        onclick: () => handleSelectTrail(trail),
      },
      h('span', { class: 'explore-card-top' },
        h('span', { class: 'explore-card-name' }, trail.name || 'Unnamed trail'),
        h('span', { class: 'explore-card-badges' },
          trail.offlineReady ? h('span', { class: 'offline-pill' }, 'Offline') : null,
          hasLevel ? levelChip(trail.level) : null)),
      meta ? h('span', { class: 'explore-card-meta' }, meta) : null,
      busy ? h('span', { class: 'explore-card-loading' },
        h('span', { class: 'pulse', 'aria-hidden': 'true' }), 'Loading trail track…') : null);

      const removeBtn = showRemove && trail.savedId && onRemoveSaved
        ? h('button', {
          type: 'button',
          class: 'btn btn-quiet btn-icon explore-card-remove',
          'aria-label': `Remove ${trail.name || 'this trail'} from saved routes`,
          onclick: () => onRemoveSaved(trail.savedId),
        }, icon('trash'))
        : null;

      return h('li', { class: `explore-card${busy ? ' is-loading' : ''}` }, openBtn, removeBtn);
    }));
  };

  const handleSelectTrail = async (trail) => {
    if (!trail || openingId) return;
    error = null;
    if (trail.savedId) {
      onOpenSaved?.(trail.savedId);
      return;
    }
    openAbort?.abort();
    const controller = new AbortController();
    openAbort = controller;
    openingId = trail.id;
    syncStatus();
    renderCards();
    try {
      const track = await fetchTrailTrack(trail, { signal: controller.signal });
      if (openAbort !== controller) return;
      if (!track || !Array.isArray(track.coords) || track.coords.length < 2) {
        throw new Error("Couldn't find enough track points for that trail.");
      }
      openingId = null;
      openAbort = null;
      syncStatus();
      renderCards();
      onOpenTrail?.(track, trail);
    } catch (err) {
      if (err?.name === 'AbortError' || openAbort !== controller) return;
      openingId = null;
      openAbort = null;
      error = !online
        ? "You're offline — open a Saved trail or upload a GPX file."
        : (err?.message || "Couldn't load that trail right now. Try another trail or tap + GPX.");
      syncStatus();
      renderCards();
    }
  };

  const runSearch = async () => {
    clearTimeout(debounceTimer);
    searchAbort?.abort();
    const controller = new AbortController();
    searchAbort = controller;
    const seq = ++searchSeq;
    const filter = effectiveFilter();
    const trimmed = query.trim();
    loading = true;
    error = null;
    syncChips();
    syncStatus();

    try {
      const res = await searchTrails({
        query: trimmed,
        filter,
        location: userLocation,
        savedRoutes,
        signal: controller.signal,
      });
      if (seq !== searchSeq || controller.signal.aborted) return;
      trails = Array.isArray(res?.trails) ? res.trails : [];
      note = res?.note || null;
      loading = false;
      syncStatus();
      renderCards();
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== searchSeq) return;
      loading = false;
      if (filter === 'saved') {
        trails = savedFallbackTrails(savedRoutes, trimmed);
        note = null;
        error = null;
      } else {
        trails = savedFallbackTrails(savedRoutes, trimmed);
        note = !online
          ? 'Offline — showing trails saved on this device.'
          : "Couldn't reach trail search right now.";
      }
      syncStatus();
      renderCards();
    }
  };

  const requestUserLocation = () => {
    if (locating || userLocation) return;
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      locationNote = 'Location is not available on this device — search by park or trail name above.';
      syncStatus();
      return;
    }
    locating = true;
    locationNote = null;
    syncStatus();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locating = false;
        userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        locationNote = null;
        if (activeChip === 'near' && !query.trim()) runSearch();
        else syncStatus();
      },
      () => {
        locating = false;
        locationNote = 'Allow location access to find nearby trails, or search by park name above.';
        if (activeChip === 'near' && !query.trim()) runSearch();
        else syncStatus();
      },
      { enableHighAccuracy: false, timeout: GEO_TIMEOUT_MS, maximumAge: 5 * 60_000 },
    );
  };

  input.addEventListener('input', () => {
    query = input.value;
    clearBtn.hidden = query.length === 0;
    syncChips();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    } else if (e.key === 'Escape' && query) {
      e.preventDefault();
      query = '';
      input.value = '';
      clearBtn.hidden = true;
      runSearch();
    }
  });

  clearBtn.addEventListener('click', () => {
    query = '';
    input.value = '';
    clearBtn.hidden = true;
    input.focus();
    runSearch();
  });

  chipsRow.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    const next = btn.dataset.filter;
    if (!next) return;
    activeChip = next;
    if (next !== 'saved' && query.trim()) {
      query = '';
      input.value = '';
      clearBtn.hidden = true;
    }
    syncChips();
    if (next === 'near' && !userLocation) requestUserLocation();
    runSearch();
  });

  const render = ({ savedRoutes: nextSaved = [], online: nextOnline = true, gpsFix = null } = {}) => {
    const nextSig = savedSignature(nextSaved);
    const savedChanged = nextSig !== lastSavedSig;
    const onlineChanged = nextOnline !== lastOnline;
    savedRoutes = nextSaved;
    online = nextOnline;
    lastSavedSig = nextSig;
    lastOnline = nextOnline;

    if (gpsFix && Number.isFinite(gpsFix.lat) && Number.isFinite(gpsFix.lng) && !userLocation) {
      userLocation = { lat: gpsFix.lat, lng: gpsFix.lng };
    }

    syncChips();
    if (!initialized) {
      initialized = true;
      runSearch();
      return;
    }
    if (savedChanged || (onlineChanged && online)) {
      runSearch();
    }
  };

  const focusSearch = () => input.focus();

  const cancelPending = () => {
    clearTimeout(debounceTimer);
    searchAbort?.abort();
    openAbort?.abort();
    openingId = null;
  };

  return { render, focusSearch, cancelPending };
};
