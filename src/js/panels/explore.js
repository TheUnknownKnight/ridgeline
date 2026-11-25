/**
 * Explore Trail Finder: free US trail search, Featured / Near me / Saved filter
 * chips, unified hairline-grouped parent corridor sheets (1-tap full trail check,
 * South-to-North Region picker, Mile-Range slicer, clean section rows), sort &
 * pagination, and a quick "+ GPX" upload action. Constructed strictly via DOM nodes.
 */
import { haversineMiles } from '../../../shared/geo.js';
import {
  nearestLandmark,
  stripCorridorPrefix,
} from '../../../shared/trails/corridors.js';
import { searchTrails, fetchTrailTrack } from '../api/trails.js';
import { h, mount } from '../ui/dom.js';
import { icon, levelChip, fmtTotal } from './common.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SEARCH_DEBOUNCE_MS = 300;
const GEO_TIMEOUT_MS = 8000;
const INITIAL_PAGE_SIZE = 10;
const PAGE_STEP = 15;

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

const buildCorridorTrailPayload = (corridor, slice = null) => {
  const baseName = corridor.name.replace(/\s*\([A-Z]+\)$/, '');
  return {
    id: slice
      ? `corridor:${corridor.id}:${Math.round(slice.startMile)}-${Math.round(slice.endMile)}`
      : `corridor:${corridor.id}`,
    name: slice
      ? `${baseName} (Mi ${Math.round(slice.startMile)}–${Math.round(slice.endMile)})`
      : corridor.name,
    region: corridor.spanLabel,
    agency: 'USFS / NPS',
    lengthMiles: slice ? Math.round((slice.endMile - slice.startMile) * 10) / 10 : corridor.totalMiles,
    source: corridor.sampleUrl ? 'sample' : 'corridor',
    ...(corridor.sampleUrl
      ? { sampleUrl: corridor.sampleUrl }
      : { queryMeta: { source: 'corridor', corridorId: corridor.id } }),
  };
};

/**
 * createExplore(container, { onOpenTrail(track, trail), onOpenSaved(id), onRemoveSaved(id), onOpenFile() })
 *   .render({ savedRoutes, online, gpsFix })
 *   .focusSearch()
 *   .cancelPending()
 */
export const createExplore = (container, { onOpenTrail, onOpenSaved, onRemoveSaved, onOpenFile } = {}) => {
  let query = '';
  let activeChip = 'featured';
  let subview = 'list'; // 'list' | 'regions' | 'range'
  let sortMode = 'smart'; // 'smart' | 'longest' | 'nearest'
  let visibleCount = INITIAL_PAGE_SIZE;
  let savedRoutes = [];
  let online = true;
  let userLocation = null;
  let locating = false;
  let locationNote = null;
  let loading = false;
  let openingId = null;
  let trails = [];
  let activeCorridor = null;
  let activeRegionId = null;
  let rangeStart = 0;
  let rangeEnd = 200;
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
  const resultsEl = h('div', { class: 'explore-results' });

  const root = h('div', { class: 'explore' },
    h('div', { class: 'explore-bar' },
      h('div', { class: 'explore-search-wrap' }, searchIcon(), input, clearBtn),
      gpxBtn),
    chipsRow,
    statusEl,
    resultsEl);
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
    chipsRow.hidden = hasQuery && activeChip !== 'saved';
    savedBadge.hidden = savedRoutes.length === 0;
    savedBadge.textContent = savedRoutes.length ? String(savedRoutes.length) : '';
  };

  const syncStatus = () => {
    let text = '';
    let tone = '';
    if (error) {
      text = error;
      tone = 'error';
    } else if (locating && ((activeChip === 'near' && !query.trim()) || sortMode === 'nearest')) {
      text = 'Finding your location…';
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

  const sortList = (items, mode) => {
    const list = [...items];
    if (mode === 'longest') {
      list.sort((a, b) => (Number(b.lengthMiles) || 0) - (Number(a.lengthMiles) || 0));
    } else if (mode === 'nearest') {
      if (userLocation) {
        list.sort((a, b) => {
          const da = Array.isArray(a.start) ? haversineMiles(userLocation.lng, userLocation.lat, a.start[0], a.start[1]) : Infinity;
          const db = Array.isArray(b.start) ? haversineMiles(userLocation.lng, userLocation.lat, b.start[0], b.start[1]) : Infinity;
          return da - db;
        });
      } else {
        // Fallback while location resolves: sort South to North by start latitude.
        list.sort((a, b) => (a.start?.[1] ?? 90) - (b.start?.[1] ?? 90));
      }
    }
    return list;
  };

  const buildStandardCard = (trail, showRemove) => {
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
  };

  const buildSheetRow = (trail, corridor) => {
    const busy = openingId === trail.id;
    const cleanName = stripCorridorPrefix(trail, corridor);
    const metaParts = [];
    if (trail.corridorRegion?.label) metaParts.push(trail.corridorRegion.label);
    else if (trail.region && trail.region !== cleanName) metaParts.push(trail.region);
    if (Number.isFinite(trail.lengthMiles) && trail.lengthMiles > 0) metaParts.push(`${fmtTotal(trail.lengthMiles)} mi`);
    if (trail.agency) metaParts.push(trail.agency);
    const hasLevel = Boolean(trail.savedId) && Number.isFinite(trail.level);

    return h('button', {
      type: 'button',
      class: `explore-sheet-row${busy ? ' is-loading' : ''}`,
      disabled: Boolean(openingId),
      onclick: () => handleSelectTrail(trail),
    },
    h('span', { class: 'explore-sheet-row-main' },
      h('span', { class: 'explore-sheet-row-title' }, cleanName),
      h('span', { class: 'explore-sheet-row-meta' },
        busy ? 'Loading trail track…' : metaParts.join(' · '))),
    h('span', { class: 'explore-sheet-row-tail' },
      trail.offlineReady ? h('span', { class: 'offline-pill' }, 'Offline') : null,
      hasLevel ? levelChip(trail.level) : null,
      h('span', { class: 'explore-row-chevron', 'aria-hidden': 'true' }, '›')));
  };

  const splitCorridorTrails = (corridor) => {
    const sections = [];
    const others = [];
    for (const t of trails) {
      if (t.id === 'featured:jmt-yosemite' && corridor.id === 'jmt') continue;
      if (t.corridorRegion && !t.isSpur) sections.push(t);
      else others.push(t);
    }
    return { sections, others };
  };

  const enterRangeSubview = (corridor) => {
    const preset = corridor.presets?.[0] || {
      start: 0,
      end: Math.min(200, Math.round(corridor.totalMiles)),
    };
    rangeStart = preset.start;
    rangeEnd = preset.end;
    subview = 'range';
    renderView();
  };

  const enterRegionsSubview = (corridor) => {
    const { sections } = splitCorridorTrails(corridor);
    const populatedIds = new Set(sections.map(s => s.corridorRegion?.id).filter(Boolean));
    const preferred = corridor.regions.find(r => populatedIds.has(r.id)) || corridor.regions[0];
    activeRegionId = preferred?.id || null;
    subview = 'regions';
    renderView();
  };

  const renderRegionsSubview = (corridor) => {
    const { sections } = splitCorridorTrails(corridor);
    const byRegion = new Map();
    for (const s of sections) {
      const rid = s.corridorRegion?.id;
      if (!rid) continue;
      if (!byRegion.has(rid)) byRegion.set(rid, []);
      byRegion.get(rid).push(s);
    }

    const regionsWithCounts = corridor.regions.filter(r => !byRegion.size || byRegion.has(r.id));
    if (!regionsWithCounts.some(r => r.id === activeRegionId)) {
      activeRegionId = regionsWithCounts[0]?.id || corridor.regions[0]?.id;
    }
    const activeReg = regionsWithCounts.find(r => r.id === activeRegionId) || corridor.regions[0];
    const regSections = sortList(byRegion.get(activeReg?.id) || [], sortMode === 'nearest' ? 'nearest' : 'longest');
    const fullTrail = buildCorridorTrailPayload(corridor);
    const fullBusy = openingId === fullTrail.id;

    const nodes = [
      h('button', {
        type: 'button',
        class: 'explore-sub-back',
        onclick: () => { subview = 'list'; renderView(); },
      }, '← Back to search'),
      h('div', { class: 'explore-sub-head' },
        h('div', { class: 'explore-sub-head-text' },
          h('span', { class: 'explore-sub-kicker' }, corridor.badge),
          h('h3', { class: 'explore-sub-title' }, corridor.name),
          h('p', { class: 'explore-sub-meta' }, `${fmtTotal(corridor.totalMiles)} mi · ${corridor.spanLabel}`)),
        h('button', {
          type: 'button',
          class: 'explore-check-full-pill',
          disabled: Boolean(openingId),
          onclick: () => handleSelectTrail(fullTrail),
        }, fullBusy ? 'Loading…' : 'Check full ›')),
      h('div', { class: 'explore-region-pills', role: 'group', 'aria-label': 'Trail regions' },
        regionsWithCounts.map((r) => h('button', {
          type: 'button',
          class: 'panel-pill explore-chip',
          'aria-pressed': String(r.id === activeReg?.id),
          onclick: () => { activeRegionId = r.id; renderView(); },
        }, r.label))),
    ];

    if (activeReg) {
      nodes.push(h('div', { class: 'explore-sub-countrow' },
        h('span', {}, `${activeReg.label}${activeReg.miles ? ` (${activeReg.miles})` : ''}`),
        h('span', {}, `${regSections.length} section${regSections.length === 1 ? '' : 's'}`)));
    }

    if (regSections.length) {
      nodes.push(h('div', { class: 'explore-sheet' },
        regSections.map(s => buildSheetRow(s, corridor))));
    } else {
      nodes.push(h('div', { class: 'explore-empty' },
        h('p', { class: 'explore-empty-title' }, 'No sections loaded in this region'),
        h('p', { class: 'explore-empty-detail' }, 'Use Check full above or Mile Range below to check a specific stretch.')));
    }

    nodes.push(h('button', {
      type: 'button',
      class: 'explore-switch-btn',
      onclick: () => enterRangeSubview(corridor),
    }, 'Or slice a custom mile range →'));

    mount(resultsEl, nodes);
  };

  const renderRangeSubview = (corridor) => {
    const maxMi = Math.max(20, Math.round(corridor.totalMiles));
    const minStep = maxMi > 400 ? 5 : 1;
    const minGap = maxMi > 400 ? 10 : 5;
    rangeStart = Math.max(0, Math.min(rangeStart, maxMi - minGap));
    rangeEnd = Math.max(rangeStart + minGap, Math.min(rangeEnd, maxMi));

    const spanTitleEl = h('span', { class: 'explore-range-miles' });
    const spanPillEl = h('span', { class: 'explore-range-span' });
    const startValEl = h('strong', {});
    const startLmEl = h('span', { class: 'explore-range-landmark' });
    const endValEl = h('strong', {});
    const endLmEl = h('span', { class: 'explore-range-landmark' });
    const noteBoxEl = h('p', { class: 'explore-range-note' });
    const checkBtn = h('button', {
      type: 'button',
      class: 'btn btn-primary explore-range-submit',
      disabled: Boolean(openingId),
    });

    const startSlider = h('input', {
      type: 'range',
      class: 'explore-range-slider',
      min: '0',
      max: String(maxMi - minGap),
      step: String(minStep),
      value: String(rangeStart),
      'aria-label': 'Start mile',
    });
    const endSlider = h('input', {
      type: 'range',
      class: 'explore-range-slider',
      min: String(minGap),
      max: String(maxMi),
      step: String(minStep),
      value: String(rangeEnd),
      'aria-label': 'End mile',
    });

    const syncRangeUI = () => {
      const span = Math.max(minGap, rangeEnd - rangeStart);
      const isFast = span <= 300;
      spanTitleEl.textContent = `Mi ${rangeStart.toLocaleString()} → Mi ${rangeEnd.toLocaleString()}`;
      spanPillEl.textContent = `${span.toLocaleString()} mi`;
      spanPillEl.classList.toggle('is-long', !isFast);
      startValEl.textContent = `Mi ${rangeStart.toLocaleString()}`;
      startLmEl.textContent = nearestLandmark(corridor, rangeStart);
      endValEl.textContent = `Mi ${rangeEnd.toLocaleString()}`;
      endLmEl.textContent = nearestLandmark(corridor, rangeEnd);
      noteBoxEl.textContent = isFast
        ? 'Ideal live check — full wildfire, NWS alert, avalanche, river & trail conditions resolution.'
        : 'Long span (>300 mi) — analyzes major wildfires & alerts across the corridor; pick a shorter stage for hourly weather.';
      const slicePayload = buildCorridorTrailPayload(corridor, { startMile: rangeStart, endMile: rangeEnd });
      const busy = openingId === slicePayload.id;
      checkBtn.textContent = busy
        ? 'Loading sliced track…'
        : `Check Mi ${rangeStart.toLocaleString()}–${rangeEnd.toLocaleString()} Briefing →`;
    };

    startSlider.addEventListener('input', () => {
      rangeStart = Number(startSlider.value);
      if (rangeStart >= rangeEnd - minGap) {
        rangeEnd = Math.min(rangeStart + minGap, maxMi);
        endSlider.value = String(rangeEnd);
      }
      syncRangeUI();
    });
    endSlider.addEventListener('input', () => {
      rangeEnd = Number(endSlider.value);
      if (rangeEnd <= rangeStart + minGap) {
        rangeStart = Math.max(0, rangeEnd - minGap);
        startSlider.value = String(rangeStart);
      }
      syncRangeUI();
    });
    checkBtn.addEventListener('click', () => {
      const sliceTrail = buildCorridorTrailPayload(corridor, { startMile: rangeStart, endMile: rangeEnd });
      handleSelectTrail(sliceTrail, { startMile: rangeStart, endMile: rangeEnd });
    });

    syncRangeUI();

    const presetRow = corridor.presets?.length
      ? h('div', { class: 'explore-region-pills' }, corridor.presets.map((p) => h('button', {
        type: 'button',
        class: 'panel-pill explore-chip',
        'aria-pressed': String(rangeStart === p.start && rangeEnd === p.end),
        onclick: () => {
          rangeStart = p.start;
          rangeEnd = p.end;
          renderView();
        },
      }, p.label)))
      : null;

    mount(resultsEl, [
      h('button', {
        type: 'button',
        class: 'explore-sub-back',
        onclick: () => { subview = 'list'; renderView(); },
      }, '← Back to search'),
      h('div', { class: 'explore-sub-head-text' },
        h('span', { class: 'explore-sub-kicker' }, 'Mile-Range Slicer'),
        h('h3', { class: 'explore-sub-title' }, corridor.name),
        h('p', { class: 'explore-sub-meta' }, 'Check just the stretch you plan to hike.')),
      presetRow,
      h('div', { class: 'explore-range-card' },
        h('div', { class: 'explore-range-top' }, spanTitleEl, spanPillEl),
        h('div', { class: 'explore-range-group' },
          h('div', { class: 'explore-range-labels' }, h('span', {}, 'Start: ', startValEl), startLmEl),
          startSlider),
        h('div', { class: 'explore-range-group' },
          h('div', { class: 'explore-range-labels' }, h('span', {}, 'End: ', endValEl), endLmEl),
          endSlider),
        noteBoxEl,
        checkBtn),
    ]);
  };

  const renderView = () => {
    const q = query.trim();
    const corridor = activeCorridor && q ? activeCorridor : null;

    if (corridor && subview === 'regions') {
      renderRegionsSubview(corridor);
      return;
    }
    if (corridor && subview === 'range') {
      renderRangeSubview(corridor);
      return;
    }

    if (corridor) {
      const { sections, others } = splitCorridorTrails(corridor);
      const effectiveSort = sortMode === 'nearest' ? 'nearest' : 'longest';
      const sortedSections = sortList(sections, effectiveSort);
      const shown = sortedSections.slice(0, visibleCount);
      const hasMore = sortedSections.length > shown.length;
      const fullTrail = buildCorridorTrailPayload(corridor);
      const fullBusy = openingId === fullTrail.id;

      const sheetChildren = [
        h('button', {
          type: 'button',
          class: `explore-sheet-parent${fullBusy ? ' is-loading' : ''}`,
          disabled: Boolean(openingId),
          onclick: () => handleSelectTrail(fullTrail),
        },
        h('span', { class: 'explore-sheet-parent-top' },
          h('span', { class: 'explore-sub-kicker' }, corridor.badge),
          h('span', { class: 'explore-check-full-pill' }, fullBusy ? 'Loading track…' : 'Check full ›')),
        h('span', { class: 'explore-sheet-parent-title' }, corridor.name),
        h('span', { class: 'explore-sheet-parent-meta' },
          `${fmtTotal(corridor.totalMiles)} mi · ${corridor.spanLabel}`)),
        h('div', { class: 'explore-sheet-actions' },
          h('button', {
            type: 'button',
            class: 'explore-sheet-action-btn',
            onclick: () => enterRegionsSubview(corridor),
          }, `By Region (${corridor.regions.length})`),
          h('button', {
            type: 'button',
            class: 'explore-sheet-action-btn',
            onclick: () => enterRangeSubview(corridor),
          }, 'Mile Range')),
      ];

      if (sortedSections.length) {
        sheetChildren.push(
          h('div', { class: 'explore-sheet-subhead' },
            h('span', {}, `${sortedSections.length} section${sortedSections.length === 1 ? '' : 's'} along this trail`),
            h('div', { class: 'explore-sheet-sort', role: 'group', 'aria-label': 'Sort sections' },
              h('button', {
                type: 'button',
                class: 'explore-sort-text-btn',
                'aria-pressed': String(effectiveSort === 'longest'),
                onclick: () => { sortMode = 'longest'; renderView(); },
              }, 'Longest'),
              h('button', {
                type: 'button',
                class: 'explore-sort-text-btn',
                'aria-pressed': String(effectiveSort === 'nearest'),
                onclick: () => {
                  sortMode = 'nearest';
                  if (!userLocation) requestUserLocation();
                  syncStatus();
                  renderView();
                },
              }, 'Nearest'))),
          h('div', { class: 'explore-sheet-rows' },
            shown.map(s => buildSheetRow(s, corridor))),
        );
        if (hasMore) {
          sheetChildren.push(h('button', {
            type: 'button',
            class: 'explore-sheet-more',
            onclick: () => { visibleCount += PAGE_STEP; renderView(); },
          }, `Show ${sortedSections.length - shown.length} more sections ↓`));
        }
      }

      const out = [h('div', { class: 'explore-sheet' }, sheetChildren)];
      if (others.length && !hasMore) {
        const showRemove = activeChip === 'saved';
        out.push(
          h('p', { class: 'explore-related-label' }, 'Related trails & connectors'),
          h('ul', { class: 'explore-list', 'aria-label': 'Related trails' },
            others.slice(0, 12).map(t => buildStandardCard(t, showRemove))),
        );
      }
      mount(resultsEl, out);
      return;
    }

    if (!trails.length) {
      if (loading || locating) {
        mount(resultsEl, h('div', { class: 'explore-empty' }, 'Looking up trails…'));
        return;
      }
      let emptyTitle = 'No matching trails found';
      let emptyDetail = 'Try another trail or park name, or tap + GPX to load your own route file.';
      if (activeChip === 'saved' && !q) {
        emptyTitle = 'No saved routes yet';
        emptyDetail = 'Open any Featured trail or upload a GPX file to keep it ready on this device.';
      } else if (activeChip === 'near' && !userLocation && !q) {
        emptyTitle = 'Location needed for Near me';
        emptyDetail = 'Allow location access to find nearby trails, or search by park or trail name above.';
      }
      mount(resultsEl, h('div', { class: 'explore-empty' },
        h('p', { class: 'explore-empty-title' }, emptyTitle),
        h('p', { class: 'explore-empty-detail' }, emptyDetail)));
      return;
    }

    const showRemove = activeChip === 'saved';
    const sorted = q ? sortList(trails, sortMode) : trails;
    const shown = sorted.slice(0, visibleCount);
    const hasMore = sorted.length > shown.length;
    const out = [];

    if (q && sorted.length > 1) {
      out.push(h('div', { class: 'explore-sort-row' },
        h('div', { class: 'explore-sort-pills', role: 'group', 'aria-label': 'Sort search results' },
          [
            ['smart', 'Smart'],
            ['longest', 'Longest'],
            ['nearest', 'Nearest'],
          ].map(([id, label]) => h('button', {
            type: 'button',
            class: 'panel-pill explore-chip explore-chip-sm',
            'aria-pressed': String(sortMode === id),
            onclick: () => {
              sortMode = id;
              if (id === 'nearest' && !userLocation) requestUserLocation();
              syncStatus();
              renderView();
            },
          }, label))),
        h('span', { class: 'explore-count' }, `${sorted.length} results`)));
    }

    out.push(h('ul', { class: 'explore-list', 'aria-label': 'Trails' },
      shown.map(t => buildStandardCard(t, showRemove))));

    if (hasMore) {
      out.push(h('button', {
        type: 'button',
        class: 'btn explore-more-btn',
        onclick: () => { visibleCount += PAGE_STEP; renderView(); },
      }, `Show more trails (${shown.length} of ${sorted.length})`));
    }

    mount(resultsEl, out);
  };

  const handleSelectTrail = async (trail, sliceOpts = {}) => {
    if (!trail || openingId) return;
    error = null;
    if (trail.savedId && sliceOpts.startMile == null && sliceOpts.endMile == null) {
      onOpenSaved?.(trail.savedId);
      return;
    }
    openAbort?.abort();
    const controller = new AbortController();
    openAbort = controller;
    openingId = trail.id;
    syncStatus();
    renderView();
    try {
      const track = await fetchTrailTrack(trail, {
        ...sliceOpts,
        signal: controller.signal,
      });
      if (openAbort !== controller) return;
      if (!track || !Array.isArray(track.coords) || track.coords.length < 2) {
        throw new Error("Couldn't find enough track points for that trail.");
      }
      openingId = null;
      openAbort = null;
      syncStatus();
      renderView();
      onOpenTrail?.(track, trail);
    } catch (err) {
      if (err?.name === 'AbortError' || openAbort !== controller) return;
      openingId = null;
      openAbort = null;
      error = !online
        ? "You're offline — open a Saved trail or upload a GPX file."
        : (err?.message || "Couldn't load that trail right now. Try another trail or tap + GPX.");
      syncStatus();
      renderView();
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
      activeCorridor = res?.corridor || null;
      if (!activeCorridor) subview = 'list';
      note = res?.note || null;
      loading = false;
      syncStatus();
      renderView();
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== searchSeq) return;
      loading = false;
      activeCorridor = null;
      subview = 'list';
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
      renderView();
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
        if (activeChip === 'near' && !query.trim()) {
          runSearch();
        } else {
          syncStatus();
          if (sortMode === 'nearest') renderView();
        }
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
    subview = 'list';
    sortMode = 'smart';
    visibleCount = INITIAL_PAGE_SIZE;
    clearBtn.hidden = query.length === 0;
    syncChips();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      subview = 'list';
      visibleCount = INITIAL_PAGE_SIZE;
      runSearch();
    } else if (e.key === 'Escape' && query) {
      e.preventDefault();
      query = '';
      subview = 'list';
      sortMode = 'smart';
      visibleCount = INITIAL_PAGE_SIZE;
      input.value = '';
      clearBtn.hidden = true;
      runSearch();
    }
  });

  clearBtn.addEventListener('click', () => {
    query = '';
    subview = 'list';
    sortMode = 'smart';
    visibleCount = INITIAL_PAGE_SIZE;
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
    subview = 'list';
    sortMode = 'smart';
    visibleCount = INITIAL_PAGE_SIZE;
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
