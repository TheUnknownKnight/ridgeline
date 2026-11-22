/**
 * Ridgeline's orchestrator: one state object, render() for the panels, and
 * the analysis lifecycle. Rules that matter for safety live here:
 * - every check has an id; a newer check aborts the older one and stale
 *   answers are dropped;
 * - a refresh never wipes the last answer; a failed refresh keeps showing it
 *   (from memory or IndexedDB) under a banner that says how old it is;
 * - On trail works offline with local GPS, trail progress, daylight and
 *   cached hazards, and refreshes automatically when signal returns.
 */
import { createMapView } from './map/mapView.js';
import { createProfile } from './panels/profile.js';
import { analyzeRoute, AnalysisError } from './api/client.js';
import { readRouteFile, parseRouteText, ImportError } from './gpx/importer.js';
import { buildRouteData, routeDataFromStored } from './route/routeData.js';
import * as db from './storage/db.js';
import { snapshotOf, diffSnapshots } from './diff.js';
import { createGps } from './location/gps.js';
import { projectOntoRoute, pointAtMile } from '../../shared/geo.js';
import { levelInfo, HAZARD_TYPES } from '../../shared/levels.js';
import { saveOfflinePack } from './offline/pack.js';
import {
  computeTrailProgress, computeOfflineDaylight, fmtDurationMinutes,
  formatCoordsDisplay, formatCoordsCopy,
} from './offline/trailMath.js';
import {
  initTheme, toggleTheme, getStoredTheme, DEFAULT_MOBILE_TAB,
  transitionMobileTab, mobileTabOnRouteOpen, mobileTabOnRouteClose,
} from './theme.js';
import { h, mount } from './ui/dom.js';
import { plural, fmtDistance, fmtMile, fmtRange, fmtAgo, splitFacts } from './ui/format.js';
import { createHazardBadgeEl } from './map/weatherBadges.js';
import { createVerdict, createTrailStatus, aheadView, nextHazardAhead, LOOKAHEAD_STEPS } from './panels/verdict.js';
import { createOfflinePackPanel } from './panels/offlinePack.js';
import { createTripPlanner } from './panels/trip.js';
import { createHazards } from './panels/hazards.js';
import { createRouteLog } from './panels/routeLog.js';
import { createConditions } from './panels/conditions.js';
import { createSources } from './panels/sources.js';
import { createFilters } from './panels/filters.js';
import { createChanges } from './panels/changes.js';
import { createRecent } from './panels/recent.js';
import { createBanner } from './panels/banner.js';
import { createExplore } from './panels/explore.js';
import { initNativeApp, isNativeApp, setNativeWakeLock, triggerHaptic } from './native/bridge.js';
import {
  createTabs, icon, textOnLevel, fmtStamp, fmtRouteMeta, fmtPosition, fmtTotal,
  fmtTimeOfDay, sameTrip, shouldShowScrollTop, remount,
} from './panels/common.js';

const SAMPLE = { url: '/samples/jmt-yosemite.gpx', fileName: 'jmt-yosemite.gpx' };
const PREFS_KEY = 'ridgeline:prefs';
const DESKTOP_MIN_WIDTH = 900;
const TICK_MS = 30_000;
const ON_TRAIL_REFRESH_MS = 15 * 60_000;
const PLANNING_REFRESH_MS = 60 * 60_000;
// Switching back to Plan within this window reuses the answer already on screen.
const REUSE_RESULT_MS = 5 * 60_000;
// Automatic checks (movement, timers) never fire closer together than this.
const MIN_AUTO_GAP_MS = 60_000;
const MOVE_REFRESH_MILES = 1;
const LOOKAHEAD_DEBOUNCE_MS = 600;
const NOW_MILES = 0.05;

const GPS_ANNOUNCEMENTS = {
  live: 'GPS position found.',
  stale: 'GPS signal lost. Showing your last fix.',
  denied: 'Location access is off.',
  unavailable: "Can't get a GPS fix.",
  manual: 'Position set.',
};

const state = {
  view: 'start',            // 'start' | 'route'
  theme: 'dark',            // 'dark' | 'light'
  route: null,              // routeData from buildRouteData()
  mode: 'planning',         // 'planning' | 'on-trail'
  activeTab: 'hazards',     // 'hazards' | 'log' | 'conditions' | 'sources'
  mobileTab: DEFAULT_MOBILE_TAB, // 'explore' | 'briefing' | 'map' | 'ontrail' (< 900px)
  mapInspect: null,         // mobile dismissible single map inspect card payload
  result: null,             // last good analysis for this route (never wiped by a refresh)
  busy: false,              // a check is in flight
  error: null,              // { message } of the latest failed check
  importing: null,          // file name being read
  importError: null,
  online: navigator.onLine,
  hiddenTypes: new Set(),
  gps: { state: 'off', fix: null, mile: null, offRouteMiles: null },
  lookaheadMiles: 15,
  trip: null,               // optional Planning itinerary { startAt, paceMilesPerDay }
  tripPaceMilesPerDay: 12,
  selectedHazardId: null,
  selectedStretch: null,
  changes: null,            // diffSnapshots() output with at least one change, or null
  changesKey: null,         // which tracked route+mode those changes belong to
  pickMode: false,
  offlinePack: null,        // { savedAt, tileCount, totalTiles, resultAt } | null
  offlineBusy: false,
  offlineProgress: null,
  recent: [],
};

let ui = null;
let map = null;
let profile = null;
let gps = null;
let offlineAbort = null;
let pickReturnTab = null;
let pendingCenterOnFix = false;

// Mobile On Trail cockpit wake-lock & SOS copy feedback state
let cockpitWakeSentinel = null;
let cockpitWakeWanted = false;
let cockpitCopied = false;
let cockpitCopyTimer = 0;

const isMobile = () => window.innerWidth < DESKTOP_MIN_WIDTH;

// ---------------------------------------------------------------- rendering

let renderQueued = false;

const set = (patch) => {
  Object.assign(state, patch);
  if (!renderQueued) {
    renderQueued = true;
    queueMicrotask(render);
  }
};

// set() renders in a microtask; queue focus moves behind it so they land on visible elements.
const focusAfterRender = (el) => queueMicrotask(() => el?.focus());

const announce = (text) => {
  if (!ui?.live) return;
  ui.live.textContent = '';
  // A fresh text node after a tick makes screen readers repeat identical messages.
  setTimeout(() => { ui.live.textContent = text; }, 60);
};

const loadPrefs = () => {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
};

const savePrefs = (patch) => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch { /* preferences are a convenience */ }
};

const syncThemeToggle = () => {
  if (!ui?.themeToggle) return;
  const light = state.theme === 'light';
  const label = light ? 'Switch to dark mode' : 'Switch to light mode';
  ui.themeToggle.setAttribute('aria-label', label);
  ui.themeToggle.setAttribute('title', label);
  ui.themeToggle.setAttribute('aria-pressed', String(light));
};

const syncMapInset = () => {
  if (!map) return;
  if (!isMobile() || state.mobileTab !== 'map') {
    map.setBottomInset(0);
    return;
  }
  const navH = ui.mobileNav?.getBoundingClientRect().height || 60;
  const cardH = state.mapInspect && ui.mapInspectCard && !ui.mapInspectCard.hidden
    ? ui.mapInspectCard.getBoundingClientRect().height + 16
    : 0;
  map.setBottomInset(Math.round(navH + cardH));
};

const syncTrailSlot = () => {
  if (!ui?.trailEl) return;
  const target = isMobile() ? ui.ontrailTrailSlot : ui.routeTrailSlot;
  if (target && ui.trailEl.parentElement !== target) target.appendChild(ui.trailEl);
};

const syncMobileNav = () => {
  if (!ui?.mobileNavButtons) return;
  for (const btn of ui.mobileNavButtons) {
    const active = btn.dataset.mobileTab === state.mobileTab;
    btn.classList.toggle('is-active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  if (ui.mobileGpsDot) {
    const live = state.gps.state === 'live' || state.gps.state === 'acquiring';
    ui.mobileGpsDot.hidden = !live;
    ui.mobileGpsDot.classList.toggle('is-live', state.gps.state === 'live');
  }
};

const clearMapInspect = () => {
  if (!state.mapInspect) return;
  state.mapInspect = null;
  map?.clearPreview?.();
  if (ui?.mapInspectCard) ui.mapInspectCard.hidden = true;
  document.body.classList.remove('has-map-inspect');
  requestAnimationFrame(syncMapInset);
};

const setMobileTab = (requestedTab, { preserveInspect = false } = {}) => {
  const prevTab = state.mobileTab;
  const tr = transitionMobileTab(state.mobileTab, requestedTab, { hasRoute: Boolean(state.route) });
  state.mobileTab = tr.tab;
  document.body.dataset.mobileTab = tr.tab;
  syncMobileNav();
  if (tr.tab !== prevTab) triggerHaptic('light');

  if (tr.closeInspectCard && !preserveInspect) clearMapInspect();

  if (tr.tab !== 'map' && ui?.panel) {
    ui.panel.scrollTop = 0;
    syncScrollTop();
  }

  if (tr.modeChange === 'on-trail') {
    if (state.mode !== 'on-trail') setMode('on-trail');
    else if (gps && gps.getState().state === 'off') gps.start();
  }

  render();

  if (tr.shouldResizeMap) {
    requestAnimationFrame(() => {
      syncMapInset();
      map?.resize();
    });
  }
};

const buildInspectFromHazard = (hz, fallback = null) => {
  if (hz) {
    const info = levelInfo(hz.level);
    const milesText = hz.ranges?.length
      ? fmtRange(hz.ranges[0][0], hz.ranges[hz.ranges.length - 1][1])
      : (hz.closest ? `Near Mi ${fmtMile(hz.closest.atMile)}` : null);
    const facts = splitFacts(hz.detail);
    const detail = hz.advice || facts.slice(0, 2).join(' · ') || null;
    return {
      kind: 'hazard',
      hazardId: hz.id,
      title: hz.title || 'Reported hazard',
      level: hz.level || 0,
      levelLabel: hz.levelLabel || (info.level === 0 ? 'Clear' : info.short),
      type: hz.type || null,
      source: hz.source || 'OFFICIAL',
      milesText,
      detail,
      mileStart: hz.ranges?.[0]?.[0] ?? hz.closest?.atMile ?? null,
      mileEnd: hz.ranges?.[hz.ranges.length - 1]?.[1] ?? hz.closest?.atMile ?? null,
      clickMile: hz.closest?.atMile ?? hz.ranges?.[0]?.[0] ?? null,
    };
  }
  if (!fallback) return null;
  const info = levelInfo(fallback.level || 0);
  return {
    kind: 'hazard',
    hazardId: fallback.hazardId || null,
    title: fallback.title || 'Map overlay',
    level: fallback.level || 0,
    levelLabel: fallback.levelLabel || (info.level === 0 ? 'Info' : info.short),
    type: fallback.type || null,
    source: 'OFFICIAL',
    milesText: HAZARD_TYPES[fallback.type]?.label || null,
    detail: null,
    mileStart: null,
    mileEnd: null,
    clickMile: null,
  };
};

const focusHazardOnMap = (id) => {
  const hz = id ? state.result?.hazards?.[id] : null;
  if (!hz) return;
  if (state.hiddenTypes.has(hz.type)) {
    const hidden = new Set(state.hiddenTypes);
    hidden.delete(hz.type);
    applyFilters(hidden);
  }
  const inspect = buildInspectFromHazard(hz);
  state.selectedHazardId = id;
  state.selectedStretch = null;
  state.mapInspect = inspect;
  map.highlightStretch(null);
  map.highlightHazard(id);
  ui.hazards.setSelected(id);
  ui.routeLog.setSelected(null);
  highlightMile(hz.closest?.atMile ?? hz.ranges?.[0]?.[0] ?? null);

  if (isMobile()) {
    setMobileTab('map', { preserveInspect: true });
    requestAnimationFrame(() => {
      map.resize();
      if (hz.ranges?.length) map.fitRange(hz.ranges[0][0], hz.ranges[hz.ranges.length - 1][1], hz.id);
      syncMapInset();
    });
  } else if (hz.ranges?.length) {
    requestAnimationFrame(() => map.fitRange(hz.ranges[0][0], hz.ranges[hz.ranges.length - 1][1], hz.id));
  }
};

const focusStretchOnMap = (mileStart, mileEnd, hazardId = null) => {
  if (!Number.isFinite(mileStart) || !Number.isFinite(mileEnd)) return;
  const hz = hazardId ? state.result?.hazards?.[hazardId] : null;
  const mid = (mileStart + mileEnd) / 2;
  const stretch = { mileStart, mileEnd };
  state.selectedStretch = stretch;
  state.selectedHazardId = hz ? hz.id : null;
  state.mapInspect = hz
    ? buildInspectFromHazard(hz)
    : {
      kind: 'segment',
      hazardId: null,
      title: `Route stretch ${fmtRange(mileStart, mileEnd)}`,
      level: 0,
      levelLabel: 'Clear',
      type: null,
      source: 'OFFICIAL',
      milesText: fmtRange(mileStart, mileEnd),
      detail: 'No reported hazards on this stretch.',
      mileStart,
      mileEnd,
      clickMile: mid,
    };
  map.highlightStretch(stretch);
  map.highlightHazard(hz ? hz.id : null);
  highlightMile(mid);

  if (isMobile()) {
    setMobileTab('map', { preserveInspect: true });
    requestAnimationFrame(() => {
      map.resize();
      map.fitRange(mileStart, mileEnd, hz?.id || null);
      syncMapInset();
    });
  } else {
    requestAnimationFrame(() => map.fitRange(mileStart, mileEnd, hz?.id || null));
  }
};

const handleMobileMapTap = (tap) => {
  if (!tap) {
    clearMapInspect();
    return;
  }
  if (tap.kind === 'hazard') {
    const inspect = buildInspectFromHazard(tap.hazard, tap.primary);
    set({ mapInspect: inspect, selectedHazardId: inspect?.hazardId || null });
    requestAnimationFrame(syncMapInset);
    return;
  }
  if (tap.kind === 'segment' && tap.segment) {
    const seg = tap.segment;
    const inspect = tap.hazard
      ? {
        ...buildInspectFromHazard(tap.hazard),
        milesText: fmtRange(seg.mileStart, seg.mileEnd),
        mileStart: seg.mileStart,
        mileEnd: seg.mileEnd,
        clickMile: tap.clickMile,
      }
      : {
        kind: 'segment',
        hazardId: null,
        title: `Stretch ${fmtRange(seg.mileStart, seg.mileEnd)}`,
        level: seg.level || 0,
        levelLabel: levelInfo(seg.level || 0).short,
        type: null,
        source: 'OFFICIAL',
        milesText: fmtRange(seg.mileStart, seg.mileEnd),
        detail: seg.level > 0 ? 'Tap Details to view hazards along this stretch.' : 'Nothing reported along this stretch.',
        mileStart: seg.mileStart,
        mileEnd: seg.mileEnd,
        clickMile: tap.clickMile,
      };
    set({
      mapInspect: inspect,
      selectedStretch: { mileStart: seg.mileStart, mileEnd: seg.mileEnd },
      selectedHazardId: tap.hazard?.id || null,
    });
    map.highlightStretch({ mileStart: seg.mileStart, mileEnd: seg.mileEnd });
    highlightMile(tap.clickMile);
    requestAnimationFrame(syncMapInset);
  }
};

// ------------------------------------------------------------ wake-lock (cockpit)

const wakeSupported = isNativeApp() || (typeof navigator !== 'undefined' && Boolean(navigator.wakeLock?.request));

const acquireCockpitWake = async () => {
  if (!wakeSupported || cockpitWakeSentinel) return;
  try {
    if (await setNativeWakeLock(true)) {
      cockpitWakeSentinel = { release: () => setNativeWakeLock(false) };
    } else {
      cockpitWakeSentinel = await navigator.wakeLock.request('screen');
      cockpitWakeSentinel.addEventListener('release', () => {
        cockpitWakeSentinel = null;
        set({});
      });
    }
  } catch {
    cockpitWakeWanted = false;
    cockpitWakeSentinel = null;
  }
  set({});
};

const releaseCockpitWake = async () => {
  cockpitWakeWanted = false;
  const s = cockpitWakeSentinel;
  cockpitWakeSentinel = null;
  try { await s?.release(); } catch { /* ignore */ }
  set({});
};

const toggleCockpitWake = () => {
  if (cockpitWakeWanted || cockpitWakeSentinel) releaseCockpitWake();
  else {
    cockpitWakeWanted = true;
    acquireCockpitWake();
  }
};

const copySosCoords = async () => {
  const fix = state.gps?.fix;
  if (!fix) return;
  const text = formatCoordsCopy(fix.lat, fix.lng, { mile: state.gps.mile, routeName: state.route?.name || '' });
  try {
    await navigator.clipboard.writeText(text);
    cockpitCopied = true;
    set({});
    announce('SOS coordinates copied.');
    clearTimeout(cockpitCopyTimer);
    cockpitCopyTimer = setTimeout(() => {
      cockpitCopied = false;
      set({});
    }, 2200);
  } catch {
    announce('Could not copy coordinates.');
  }
};

// ------------------------------------------------------------ banners & badges

const bannersFor = (now) => {
  const out = [];
  if (state.importing) out.push({ key: 'importing', tone: 'info', text: `Reading ${state.importing}…` });
  if (state.importError) {
    out.push({ key: 'import', tone: 'error', text: state.importError, action: { label: 'Choose another file', onClick: openPicker } });
  }
  const inRoute = state.view === 'route';
  if (!state.online) {
    let text = "You're offline. Featured & saved trails still open with GPS, elevation and daylight.";
    if (inRoute) {
      text = state.result
        ? `Offline mode — GPS, daylight and hazards from ${fmtStamp(state.result.generatedAt, now)} are active. Refreshes when signal returns.`
        : 'Offline mode — GPS, elevation left and daylight work locally. Live hazards load when signal returns.';
    }
    out.push({ key: 'offline', tone: 'warning', text });
  } else if (inRoute && state.error && !state.busy) {
    out.push(state.result
      ? { key: 'refresh-failed', tone: 'error', text: `Couldn't refresh — showing data from ${fmtStamp(state.result.generatedAt, now)}.`, detail: state.error.message, action: { label: 'Try again', onClick: retryCheck } }
      : { key: 'check-failed', tone: 'error', text: "Couldn't check this route.", detail: state.error.message, action: { label: 'Try again', onClick: retryCheck } });
  }
  return out;
};

const renderTabBadges = () => {
  const { result, hiddenTypes } = state;
  const shown = result ? Object.values(result.hazards).filter(hz => !hiddenTypes.has(hz.type)).length : null;
  ui.hazardCount.textContent = shown == null ? '' : String(shown);
  ui.hazardTab.setAttribute('aria-label', shown == null ? 'What to know' : `What to know, ${plural(shown, 'hazard')}`);
  if (ui.mobileHazardCount) {
    ui.mobileHazardCount.hidden = !(shown > 0 && state.view === 'route');
    ui.mobileHazardCount.textContent = shown > 99 ? '99+' : String(shown ?? '');
  }
  const issues = result?.summary?.incomplete ? result.summary.incompleteSources.length : 0;
  ui.sourceFlag.hidden = issues === 0;
  ui.sourceFlag.textContent = issues ? plural(issues, 'issue') : '';
};

const renderMapOverlays = () => {
  const { route, result, mode, gps: g, mapInspect } = state;
  if (ui.mapRoutePill) {
    if (route) {
      const view = !result ? null : (mode === 'on-trail' && g.mile != null ? aheadView(result, g.mile) : result.summary);
      const info = view ? levelInfo(view.level) : null;
      const incompleteClear = Boolean(view && view.level === 0 && view.incomplete);
      ui.mapPillSwatch.style.background = !info || incompleteClear ? 'var(--rule-strong)' : info.color;
      ui.mapPillName.textContent = route.name;
      ui.mapPillAction.textContent = 'Briefing';
      ui.mapRoutePill.setAttribute('aria-label', `Back to ${route.name} briefing`);
    } else {
      ui.mapPillSwatch.style.background = 'var(--contour)';
      ui.mapPillName.textContent = 'Explore US trails';
      ui.mapPillAction.textContent = 'Search';
      ui.mapRoutePill.setAttribute('aria-label', 'Explore US trails');
    }
  }

  if (ui.mapLocateBtn) {
    const live = g.state === 'live';
    const acquiring = g.state === 'acquiring';
    ui.mapLocateBtn.classList.toggle('is-live', live);
    ui.mapLocateBtn.classList.toggle('is-acquiring', acquiring);
  }

  if (ui.mapInspectCard) {
    const open = Boolean(mapInspect);
    ui.mapInspectCard.hidden = !open;
    document.body.classList.toggle('has-map-inspect', open && isMobile() && state.mobileTab === 'map');
    if (open) {
      const info = levelInfo(mapInspect.level || 0);
      const badgeEl = mapInspect.hazardId
        ? createHazardBadgeEl({
          id: mapInspect.hazardId,
          type: mapInspect.type || 'alert',
          level: mapInspect.level || 1,
          source: mapInspect.source || 'OFFICIAL',
          title: mapInspect.title,
        })
        : h('span', {
          class: 'map-inspect-level-pill',
          style: `background:${info.color};color:${textOnLevel(info.level)}`,
        }, mapInspect.levelLabel || info.short);

      const metaBits = [
        mapInspect.milesText,
        mapInspect.hazardId ? mapInspect.levelLabel : null,
        mapInspect.hazardId && mapInspect.source === 'ESTIMATED' ? 'Estimate' : null,
      ].filter(Boolean);

      mount(ui.mapInspectCard,
        h('div', { class: 'map-inspect-head' },
          badgeEl,
          h('div', { class: 'map-inspect-copy' },
            h('p', { class: 'map-inspect-title' }, mapInspect.title),
            metaBits.length ? h('p', { class: 'map-inspect-meta' }, metaBits.join(' · ')) : null),
          h('button', {
            type: 'button',
            id: 'map-inspect-close',
            class: 'btn btn-quiet btn-icon map-inspect-close',
            'aria-label': 'Close hazard preview',
            onclick: clearMapInspect,
          }, icon('close'))),
        mapInspect.detail ? h('p', { class: 'map-inspect-detail' }, mapInspect.detail) : null,
        h('div', { class: 'map-inspect-actions' },
          h('button', {
            type: 'button',
            id: 'map-inspect-details',
            class: 'btn btn-primary btn-small map-inspect-details',
            onclick: () => {
              const target = state.mapInspect;
              clearMapInspect();
              if (!target) return;
              if (target.hazardId) {
                setMobileTab('briefing');
                selectHazard(target.hazardId, { reveal: true, fit: false });
              } else if (Number.isFinite(target.clickMile)) {
                setMobileTab('briefing');
                showStretch(target.mileStart, target.mileEnd, target.clickMile);
              }
            },
          }, mapInspect.hazardId ? 'Details' : 'View in route log', icon('arrow'))));
    }
  }
};

let injectingMapJumps = false;

/** Add mobile-only "Show on map" jump buttons inside expanded Briefing cards without modifying panel modules. */
const injectMobileMapJumps = () => {
  if (injectingMapJumps) return;
  injectingMapJumps = true;
  try {
    const hazContainer = document.getElementById('panel-hazards');
    if (hazContainer) {
      for (const item of hazContainer.querySelectorAll('.hazard[data-hazard-id]')) {
        const body = item.querySelector('.hazard-body');
        if (!body || body.querySelector('.mobile-map-jump')) continue;
        const id = item.dataset.hazardId;
        const btn = h('button', {
          type: 'button',
          class: 'btn btn-small mobile-map-jump',
          onclick: () => focusHazardOnMap(id),
        }, icon('map'), h('span', {}, 'Show on map'));
        body.prepend(btn);
      }
    }

    const logContainer = document.getElementById('panel-log');
    if (logContainer) {
      for (const item of logContainer.querySelectorAll('.tl-entry[data-mile-start]')) {
        const body = item.querySelector('.tl-body');
        if (!body || body.querySelector('.mobile-map-jump')) continue;
        const start = Number(item.dataset.mileStart);
        const end = Number(item.dataset.mileEnd);
        const btn = h('button', {
          type: 'button',
          class: 'btn btn-small mobile-map-jump',
          onclick: () => {
            const seg = state.result?.segments?.find(s => s.mileStart <= (start + end) / 2 && (start + end) / 2 <= s.mileEnd);
            const lead = topVisibleRef(seg?.refs || []);
            focusStretchOnMap(start, end, lead?.id || null);
          },
        }, icon('map'), h('span', {}, 'Show stretch on map'));
        body.prepend(btn);
      }
    }

    const condContainer = document.getElementById('panel-conditions');
    if (condContainer) {
      for (const item of condContainer.querySelectorAll('.cond-stretch[data-mile-start]')) {
        const body = item.querySelector('.cond-body');
        if (!body || body.querySelector('.mobile-map-jump')) continue;
        const start = Number(item.dataset.mileStart);
        const end = Number(item.dataset.mileEnd);
        const btn = h('button', {
          type: 'button',
          class: 'btn btn-small mobile-map-jump',
          onclick: () => focusStretchOnMap(start, end, null),
        }, icon('map'), h('span', {}, 'Show stretch on map'));
        body.prepend(btn);
      }
    }
  } finally {
    injectingMapJumps = false;
  }
};

const observeMobileMapJumps = () => {
  if (typeof MutationObserver === 'undefined') return;
  const obs = new MutationObserver(() => injectMobileMapJumps());
  for (const id of ['panel-hazards', 'panel-log', 'panel-conditions']) {
    const el = document.getElementById(id);
    if (el) obs.observe(el, { childList: true });
  }
};

// ------------------------------------------------------------ On Trail cockpit (mobile)

const gpsBadgeText = (g) => {
  switch (g.state) {
    case 'live': return 'GPS active';
    case 'acquiring': return 'Acquiring GPS…';
    case 'stale': return 'GPS stale';
    case 'manual': return 'Manual position';
    case 'denied': return 'Location off';
    case 'unavailable': return 'No GPS fix';
    default: return 'GPS off';
  }
};

const renderOnTrailCockpit = (now) => {
  if (!ui?.ontrailCockpit) return;
  const { route, result, gps: g, online, offlinePack, busy, lookaheadMiles } = state;
  const hasFix = Boolean(g.fix && g.state !== 'off' && Number.isFinite(g.fix.lat) && Number.isFinite(g.fix.lng));
  const tz = result?.route?.timeZone;
  const wakeActive = Boolean(cockpitWakeSentinel);

  const pills = h('div', { class: 'ontrail-pills' },
    offlinePack?.savedAt
      ? h('span', { class: 'ontrail-pill ontrail-pill--ok' }, icon('ok'), 'Offline ready')
      : (!online
        ? h('span', { class: 'ontrail-pill ontrail-pill--warn' }, icon('warning'), 'Offline')
        : h('span', { class: 'ontrail-pill' }, 'Online')),
    h('span', { class: `ontrail-pill${g.state === 'live' ? ' ontrail-pill--gps' : ''}` },
      h('span', { class: `ontrail-dot${g.state === 'live' ? ' is-live' : ''}`, 'aria-hidden': 'true' }),
      gpsBadgeText(g)),
    result?.generatedAt
      ? h('span', { class: 'ontrail-pill' }, `Checked ${fmtAgo(Date.parse(result.generatedAt), now)}`)
      : null);

  if (!route) {
    remount(ui.ontrailCockpit,
      pills,
      h('div', { class: 'ontrail-empty' },
        h('h2', { class: 'ontrail-empty-title' }, 'On Trail cockpit'),
        h('p', { class: 'ontrail-empty-copy' }, 'Open a trail or GPX track to track remaining miles, climb ahead, offline sunset countdown, and next hazards ahead.'),
        h('div', { class: 'mobile-empty-actions' },
          h('button', { type: 'button', class: 'btn btn-primary', onclick: () => setMobileTab('explore') }, 'Explore trails'),
          h('button', { type: 'button', class: 'btn', onclick: importSample }, 'Try a sample route'))),
      hasFix ? h('div', { class: 'ontrail-util-grid' },
        h('button', { type: 'button', class: 'btn ontrail-util-btn', onclick: copySosCoords },
          icon('copy'),
          h('span', { class: 'ontrail-util-copy' },
            h('span', { class: 'ontrail-util-label' }, cockpitCopied ? 'SOS Coords copied' : 'Copy SOS Coords'),
            h('span', { class: 'ontrail-util-sub' }, formatCoordsDisplay(g.fix.lat, g.fix.lng))))) : null);
    return;
  }

  // Next hazard ahead solid-color callout card (always pulled from shared/levels.js)
  let nextCard;
  if (!result) {
    nextCard = h('div', { class: 'ontrail-callout ontrail-callout--pending' },
      h('p', { class: 'ontrail-callout-eyebrow' }, !online ? 'Offline — no hazard check saved' : busy ? 'Checking route hazards' : 'Not checked yet'),
      h('p', { class: 'ontrail-callout-title' }, !online
        ? 'GPS, route progress, climb and daylight still run offline.'
        : 'Checking live wildfires, NWS alerts, avalanche, river, smoke and weather data…'));
  } else {
    const mile = g.mile != null ? g.mile : 0;
    const view = aheadView(result, mile);
    const next = nextHazardAhead(result, mile);
    if (next) {
      const info = levelInfo(next.level);
      const hz = result.hazards?.[next.id];
      const distText = next.milesAhead < NOW_MILES
        ? 'Here now'
        : `${fmtDistance(next.milesAhead)} ahead · Mi ${fmtMile(next.mile)}`;
      const label = hz?.levelLabel || info.short;
      nextCard = h('button', {
        type: 'button',
        class: 'ontrail-callout ontrail-callout--action',
        style: `background:${info.color};color:${textOnLevel(info.level)}`,
        onclick: () => focusHazardOnMap(next.id),
      },
      h('span', { class: 'ontrail-callout-eyebrow' }, `Next hazard ahead · ${label}`),
      h('span', { class: 'ontrail-callout-title' }, next.title),
      h('span', { class: 'ontrail-callout-meta' },
        h('span', {}, distText),
        h('span', { class: 'ontrail-callout-cta' }, 'Show on map', icon('arrow'))));
    } else if (view.level === 0 && view.incomplete) {
      nextCard = h('div', { class: 'ontrail-callout ontrail-callout--pending' },
        h('p', { class: 'ontrail-callout-eyebrow' }, 'Incomplete check'),
        h('p', { class: 'ontrail-callout-title' }, view.headline));
    } else {
      const clear = levelInfo(0);
      nextCard = h('div', {
        class: 'ontrail-callout',
        style: `background:${clear.color};color:${textOnLevel(0)}`,
      },
      h('p', { class: 'ontrail-callout-eyebrow' }, 'Clear ahead'),
      h('p', { class: 'ontrail-callout-title' }, 'Nothing reported ahead on this route'));
    }
  }

  // Progress + remaining climb + local offline daylight (trailMath.js)
  const progress = g.mile != null ? computeTrailProgress(route, g.mile, g.fix) : null;
  const dl = computeOfflineDaylight(now, { route, mile: g.mile ?? 0, gpsFix: g.fix });
  const daylightPrimary = dl
    ? (dl.isDaylight ? (fmtDurationMinutes(dl.remainingMin) || 'Daylight') : 'After dark')
    : '—';
  const daylightSub = dl
    ? (dl.isDaylight
      ? (dl.sunset ? `Sunset ${fmtTimeOfDay(dl.sunset, tz)}` : '')
      : (dl.sunrise ? `Sunrise ${fmtTimeOfDay(dl.sunrise, tz)}` : ''))
    : '';

  const climbPrimary = progress
    ? (Number.isFinite(progress.gainAheadFt)
      ? `+${Math.round(progress.gainAheadFt).toLocaleString('en-US')} ft`
      : (Number.isFinite(progress.currentElevFt) ? `${Math.round(progress.currentElevFt).toLocaleString('en-US')} ft` : '—'))
    : '—';
  const climbSub = progress
    ? (Number.isFinite(progress.lossAheadFt)
      ? `−${Math.round(progress.lossAheadFt).toLocaleString('en-US')} ft descent`
      : 'Climb remaining')
    : 'Remaining climb';

  const progressCard = h('div', { class: 'ontrail-progress-card' },
    h('div', { class: 'ontrail-progress-head' },
      h('p', { class: 'ontrail-route-title' }, route.name),
      h('p', { class: 'ontrail-mile-big' },
        progress
          ? [h('strong', {}, `Mi ${fmtPosition(progress.milesDone)}`), ` of ${fmtTotal(progress.totalMiles)}`]
          : (g.state === 'acquiring' ? 'Waiting for GPS fix…' : `0.0 of ${fmtTotal(route.lengthMiles)} mi`))),
    h('div', { class: 'ontrail-bar-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(progress?.pctComplete ?? 0), 'aria-label': 'Route completion' },
      h('div', { class: 'ontrail-bar-fill', style: `width:${progress?.pctComplete ?? 0}%` })),
    h('div', { class: 'ontrail-metrics' },
      h('div', { class: 'ontrail-metric' },
        h('span', { class: 'ontrail-metric-label' }, 'Remaining'),
        h('span', { class: 'ontrail-metric-value' }, progress ? `${fmtTotal(progress.milesLeft)} mi` : `${fmtTotal(route.lengthMiles)} mi`),
        h('span', { class: 'ontrail-metric-sub' }, progress ? `${progress.pctComplete}% complete` : 'Set GPS or mile')),
      h('div', { class: 'ontrail-metric' },
        h('span', { class: 'ontrail-metric-label' }, 'Climb ahead'),
        h('span', { class: 'ontrail-metric-value' }, climbPrimary),
        h('span', { class: 'ontrail-metric-sub' }, climbSub)),
      h('div', { class: 'ontrail-metric' },
        h('span', { class: 'ontrail-metric-label' }, 'Daylight'),
        h('span', { class: 'ontrail-metric-value' }, daylightPrimary),
        h('span', { class: 'ontrail-metric-sub' }, daylightSub))));

  // Glove-friendly utility row
  const stepLookahead = (dir) => {
    const idx = LOOKAHEAD_STEPS.indexOf(lookaheadMiles);
    const next = LOOKAHEAD_STEPS[Math.min(LOOKAHEAD_STEPS.length - 1, Math.max(0, (idx < 0 ? 2 : idx) + dir))];
    if (next !== lookaheadMiles) setLookahead(next);
  };

  const utilRow = h('div', { class: 'ontrail-util-grid' },
    h('button', {
      type: 'button',
      class: 'btn ontrail-util-btn',
      disabled: !hasFix,
      onclick: copySosCoords,
    },
    icon('copy'),
    h('span', { class: 'ontrail-util-copy' },
      h('span', { class: 'ontrail-util-label' }, cockpitCopied ? 'SOS Coords copied' : 'Copy SOS Coords'),
      h('span', { class: 'ontrail-util-sub' }, hasFix ? formatCoordsDisplay(g.fix.lat, g.fix.lng) : 'Waiting for GPS fix'))),
    h('button', {
      type: 'button',
      class: `btn ontrail-util-btn${wakeActive ? ' is-active' : ''}`,
      'aria-pressed': String(wakeActive),
      disabled: !wakeSupported,
      onclick: toggleCockpitWake,
    },
    icon('sun'),
    h('span', { class: 'ontrail-util-copy' },
      h('span', { class: 'ontrail-util-label' }, wakeActive ? 'Screen awake' : 'Keep Screen Awake'),
      h('span', { class: 'ontrail-util-sub' }, wakeSupported ? (wakeActive ? 'Tap to turn off' : 'Prevents screen dim') : 'Not supported here'))),
    h('div', { class: 'ontrail-lookahead-card', role: 'group', 'aria-label': 'Lookahead distance' },
      h('span', { class: 'ontrail-util-label' }, 'Look ahead'),
      h('div', { class: 'stepper' },
        h('button', {
          type: 'button',
          class: 'stepper-button',
          'aria-label': 'Decrease lookahead distance',
          'aria-disabled': String(lookaheadMiles <= LOOKAHEAD_STEPS[0]),
          onclick: () => stepLookahead(-1),
        }, icon('minus')),
        h('output', { class: 'stepper-value', 'aria-live': 'polite' }, `${lookaheadMiles} mi`),
        h('button', {
          type: 'button',
          class: 'stepper-button',
          'aria-label': 'Increase lookahead distance',
          'aria-disabled': String(lookaheadMiles >= LOOKAHEAD_STEPS[LOOKAHEAD_STEPS.length - 1]),
          onclick: () => stepLookahead(1),
        }, icon('plus')))),
    h('div', { class: 'ontrail-action-pair' },
      h('button', {
        type: 'button',
        class: 'btn ontrail-action-btn',
        disabled: !online || busy,
        onclick: () => runAnalysis({ refresh: true }),
      }, icon('refresh'), busy ? 'Checking…' : online ? 'Check again' : 'Offline'),
      h('button', {
        type: 'button',
        class: 'btn ontrail-action-btn',
        onclick: () => {
          setMobileTab('map');
          requestAnimationFrame(() => {
            if (hasFix) map.centerOnPosition();
            else map.fitRoute();
          });
        },
      }, icon('map'), 'Open Map')));

  remount(ui.ontrailCockpit, pills, nextCard, progressCard, utilRow);
};

// ------------------------------------------------------------ route + root render

const renderRouteView = (now) => {
  const { route, result, mode, hiddenTypes } = state;
  const trailMile = mode === 'on-trail' ? state.gps.mile : null;
  ui.routeName.textContent = route.name;
  ui.routeMeta.textContent = fmtRouteMeta(route, result, { busy: state.busy });
  ui.verdict.render({
    route, result, mode, gps: state.gps, busy: state.busy,
    failed: Boolean(state.error) && !state.busy, online: state.online, lookaheadMiles: state.lookaheadMiles, now,
  });
  if (ui.offlinePackEl) {
    ui.offlinePackEl.hidden = false;
    ui.offlinePack.render({
      pack: state.offlinePack,
      online: state.online,
      busy: state.offlineBusy,
      progress: state.offlineProgress,
      result,
      now,
    });
  }
  const showTrail = isMobile() ? Boolean(route) : mode === 'on-trail';
  ui.trailEl.hidden = !showTrail;
  if (showTrail) {
    ui.trail.render({ route, gps: state.gps, pickMode: state.pickMode, lookaheadMiles: state.lookaheadMiles, now });
  }
  ui.tripEl.hidden = mode !== 'planning';
  if (mode === 'planning') {
    ui.trip.render({ trip: state.trip, defaultPace: state.tripPaceMilesPerDay, result });
  }
  ui.filters.render({ result, hiddenTypes });
  ui.changes.render({ changes: state.changes, now });
  ui.hazards.render({ result, hiddenTypes, mile: trailMile, now, selected: state.selectedHazardId });
  ui.routeLog.render({ result, hiddenTypes, mile: trailMile });
  ui.conditions.render({ result, mile: trailMile, now });
  ui.sources.render({ result, now });
  injectMobileMapJumps();
  renderTabBadges();
};

const render = () => {
  renderQueued = false;
  const now = Date.now();
  const mobile = isMobile();
  const hasRoute = state.view === 'route' && Boolean(state.route);
  const viewChanged = document.body.dataset.view !== state.view || document.body.dataset.mobileTab !== state.mobileTab;
  document.body.dataset.view = state.view;
  document.body.dataset.mode = state.mode;
  document.body.dataset.mobileTab = state.mobileTab;
  for (const button of ui.modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));

  syncTrailSlot();
  syncThemeToggle();

  if (mobile) {
    ui.startView.hidden = state.mobileTab !== 'explore';
    ui.briefingEmpty.hidden = !(state.mobileTab === 'briefing' && !hasRoute);
    ui.routeView.hidden = !(state.mobileTab === 'briefing' && hasRoute);
    ui.ontrailView.hidden = state.mobileTab !== 'ontrail';
  } else {
    ui.startView.hidden = hasRoute;
    ui.briefingEmpty.hidden = true;
    ui.routeView.hidden = !hasRoute;
    ui.ontrailView.hidden = true;
  }

  if (ui.brandHome) {
    ui.brandHome.setAttribute('aria-label', hasRoute ? 'Ridgeline — back to start' : 'Ridgeline');
    ui.brandHome.title = hasRoute ? 'Back to start' : '';
  }
  ui.dropzone.setAttribute('aria-busy', String(Boolean(state.importing)));
  ui.banner.render(bannersFor(now));

  ui.explore.render({ savedRoutes: state.recent, online: state.online, gpsFix: state.gps.fix });

  if (hasRoute) {
    renderRouteView(now);
  } else {
    ui.trailEl.hidden = true;
    ui.recent.render(state.recent, now);
    renderTabBadges();
  }

  if (mobile && state.mobileTab === 'ontrail') {
    renderOnTrailCockpit(now);
  }

  renderMapOverlays();
  syncMobileNav();
  syncScrollTop();

  if (viewChanged) {
    requestAnimationFrame(() => {
      syncMapInset();
      map?.resize();
    });
  }
};

const syncScrollTop = () => {
  if (!ui?.scrollTopWrap) return;
  const onBriefing = !isMobile() || state.mobileTab === 'briefing';
  ui.scrollTopWrap.hidden = !(onBriefing && shouldShowScrollTop(ui.panel?.scrollTop, state.view));
};

// ------------------------------------------------------------ map + profile

const drawResult = () => {
  map.setAnalysis(state.result, { hiddenTypes: state.hiddenTypes });
  map.highlightHazard(state.selectedHazardId);
  map.highlightStretch(state.selectedStretch);
  profile.render(state.route, state.result);
  profile.setFilters(state.hiddenTypes);
};

/** Map and profile are optional extras: a failure in either must never break the panel. */
const guarded = (label, create, methods) => {
  let impl = null;
  try {
    impl = create();
  } catch (err) {
    console.error(`[ridgeline] ${label} failed to start`, err);
  }
  const api = {};
  for (const name of methods) {
    api[name] = (...args) => {
      try {
        return impl?.[name]?.(...args);
      } catch (err) {
        console.error(`[ridgeline] ${label}.${name} failed`, err);
        return undefined;
      }
    };
  }
  return { api, ok: Boolean(impl) };
};

const MAP_METHODS = [
  'setRoute', 'setAnalysis', 'setFilters', 'setPosition', 'highlightMile', 'highlightHazard',
  'highlightStretch', 'fitRange', 'fitRoute', 'centerOnPosition', 'setBottomInset', 'setPickMode',
  'setTheme', 'clearPreview', 'resize',
];
const PROFILE_METHODS = ['render', 'setHover', 'setPosition', 'setFilters'];

// ------------------------------------------------------- analysis lifecycle

let analysisSeq = 0;
let inflight = null;
// When the latest check started, and from which mile (On trail) — drives auto-refresh.
let lastCheck = { at: 0, mile: null, onTrail: false };
// Per route+mode: { baseline, latest, diff }. The baseline is the snapshot from
// before this session (or its first check) so a quick refresh can't hide
// changes the hiker hasn't acknowledged yet.
const tracked = new Map();

const cancelAnalysis = () => {
  analysisSeq++;
  inflight?.abort();
  inflight = null;
};

const locationPayload = () => {
  const { fix, mile } = state.gps;
  if (!fix) return null;
  const location = { lat: fix.lat, lng: fix.lng };
  if (Number.isFinite(fix.accuracyMeters)) location.accuracyMeters = Math.round(fix.accuracyMeters);
  if (Number.isFinite(mile)) location.lastMile = Math.round(mile * 100) / 100;
  return location;
};

const otherMode = (mode) => (mode === 'on-trail' ? 'planning' : 'on-trail');

const cachedResult = async (route) =>
  (await db.getResult(db.resultKey(route.id, state.mode))) ||
  (await db.getResult(db.resultKey(route.id, otherMode(state.mode))));

const trackChanges = async (key, result) => {
  if (!tracked.has(key)) {
    const saved = await db.getSnapshot(key);
    tracked.set(key, { baseline: saved, latest: saved, diff: null });
  }
  const entry = tracked.get(key);
  entry.latest = snapshotOf(result, entry.latest);
  db.saveSnapshot(key, entry.latest);
  if (!entry.baseline) entry.baseline = entry.latest;
  const diff = diffSnapshots(entry.baseline, result);
  entry.diff = diff.changes.length ? diff : null;
  return entry.diff;
};

const acceptResult = async (id, route, result) => {
  const key = db.resultKey(route.id, result.mode);
  const changes = await trackChanges(key, result);
  if (id !== analysisSeq) return;
  db.saveResult(key, result);
  // An On trail answer covers only the look-ahead window; it must never stand in for a Plan check.
  if (result.mode === 'on-trail' && state.mode !== 'on-trail') return;
  const selectedHazardId = result.hazards[state.selectedHazardId] ? state.selectedHazardId : null;
  set({ result, error: null, changes, changesKey: key, selectedHazardId });
  drawResult();
  refreshRecent();
  const onTrailMile = state.mode === 'on-trail' && result.mode === 'on-trail' ? state.gps.mile : null;
  announce(`Analysis updated: ${Number.isFinite(onTrailMile) ? aheadView(result, onTrailMile).headline : result.summary.headline}`);
};

const keepLastResult = async (id, route, err) => {
  if (!(err instanceof AnalysisError)) console.error('[ridgeline] check failed', err);
  const message = err instanceof AnalysisError ? err.message : 'Something went wrong during the check. Try again in a minute.';
  const fromCache = state.result ? null : (await cachedResult(route))?.result ?? null;
  if (id !== analysisSeq) return;
  set({ error: { message }, ...(fromCache ? { result: fromCache } : {}) });
  if (fromCache) drawResult();
};

/**
 * Check the current route. In On trail mode with a position this is an
 * On trail check; without one it falls back to a whole-route check so the
 * hiker still sees something while GPS warms up. Offline checks stay quiet
 * and keep the cached analysis active.
 */
const runAnalysis = async ({ auto = false, refresh = false } = {}) => {
  const { route } = state;
  if (!route) return;
  if (!state.online) return;
  if (auto && Date.now() - lastCheck.at < MIN_AUTO_GAP_MS) return;
  const location = state.mode === 'on-trail' ? locationPayload() : null;
  const trip = state.mode === 'planning' ? state.trip : null;
  cancelAnalysis();
  const id = analysisSeq;
  const controller = new AbortController();
  inflight = controller;
  lastCheck = { at: Date.now(), mile: location ? state.gps.mile : null, onTrail: Boolean(location) };
  set({ busy: true });
  try {
    const result = await analyzeRoute({ route, location, lookaheadMiles: state.lookaheadMiles, trip, refresh, signal: controller.signal });
    if (id === analysisSeq) await acceptResult(id, route, result);
  } catch (err) {
    if (id === analysisSeq) await keepLastResult(id, route, err);
  } finally {
    if (id === analysisSeq) {
      inflight = null;
      set({ busy: false });
    }
  }
};

const retryCheck = () => {
  // The banner holding this button disappears while the check runs.
  ui.checkAgain?.focus();
  runAnalysis({ refresh: true });
};

const dismissChanges = () => {
  const entry = state.changesKey ? tracked.get(state.changesKey) : null;
  if (entry) {
    entry.baseline = entry.latest;
    entry.diff = null;
  }
  set({ changes: null, changesKey: null });
  ui.checkAgain?.focus();
};

// ------------------------------------------------------------ offline pack

const cancelOfflineSave = () => {
  offlineAbort?.abort();
  offlineAbort = null;
  set({ offlineBusy: false, offlineProgress: null });
};

const startOfflineSave = async () => {
  const { route, result, mode } = state;
  if (!route || !state.online) return;
  cancelOfflineSave();
  const controller = new AbortController();
  offlineAbort = controller;
  const theme = state.theme || getStoredTheme();
  set({ offlineBusy: true, offlineProgress: { phase: 'meta', done: 0, total: 0 } });
  try {
    const pack = await saveOfflinePack({
      route,
      result,
      mode,
      theme,
      signal: controller.signal,
      onProgress: (progress) => set({ offlineProgress: progress }),
    });
    if (offlineAbort !== controller) return;
    offlineAbort = null;
    set({ offlinePack: pack, offlineBusy: false, offlineProgress: null });
    refreshRecent();
    announce(`Saved ${route.name} for offline use (${pack.tileCount} map tiles).`);
  } catch (err) {
    if (err?.name !== 'AbortError') console.warn('[ridgeline] offline pack failed', err);
    if (offlineAbort === controller) {
      offlineAbort = null;
      set({ offlineBusy: false, offlineProgress: null });
    }
  }
};

// ------------------------------------------------------------- GPS + modes

// A mile the hiker typed: projection must land on that pass of an out-and-back.
let typedMileHint = null;
// The last mile the hiker was placed at on this route. Fix-less GPS states
// (acquiring, off) don't clear it, so the next fix stays on the same pass.
let lastRouteMile = null;

const withMile = (gpsState, hintMile) => {
  const { route } = state;
  if (!gpsState.fix || !route) return { ...gpsState, mile: null, offRouteMiles: null };
  const p = projectOntoRoute(route.coords, route.cum, gpsState.fix.lng, gpsState.fix.lat, hintMile);
  return { ...gpsState, mile: p.mile, offRouteMiles: p.offRouteMiles };
};

const maybeCheckForPosition = () => {
  const { mode, route, gps: g } = state;
  if (!state.online || mode !== 'on-trail' || !route || !g.fix || g.state === 'manual') return;
  if (!lastCheck.onTrail) {
    runAnalysis();
    return;
  }
  if (g.mile != null && lastCheck.mile != null && Math.abs(g.mile - lastCheck.mile) >= MOVE_REFRESH_MILES) {
    runAnalysis({ auto: true });
  }
};

const onGpsChange = (next) => {
  const previous = state.gps;
  const hint = typedMileHint ?? lastRouteMile;
  typedMileHint = null;
  const gpsState = withMile(next, hint);
  if (Number.isFinite(gpsState.mile)) lastRouteMile = gpsState.mile;
  set({ gps: gpsState });
  map.setPosition(gpsState);
  profile.setPosition(state.mode === 'on-trail' ? gpsState.mile : null);
  if (pendingCenterOnFix && gpsState.fix && Number.isFinite(gpsState.fix.lat)) {
    pendingCenterOnFix = false;
    map.centerOnPosition();
  }
  if (previous.state !== gpsState.state && GPS_ANNOUNCEMENTS[gpsState.state]) announce(GPS_ANNOUNCEMENTS[gpsState.state]);
  maybeCheckForPosition();
};

const setPickMode = (on) => {
  if (state.pickMode === on) return;
  set({ pickMode: on });
  map.setPickMode(on);
  ui.pickHint.hidden = !on;
  if (on && isMobile()) {
    pickReturnTab = state.mobileTab;
    setMobileTab('map');
  } else if (!on) {
    pickReturnTab = null;
  }
  if (on) announce('Tap the map where you are, or press Escape to cancel.');
};

const setManualPosition = ({ lat, lng }) => {
  const returnTo = pickReturnTab;
  setPickMode(false);
  gps.setManual({ lat, lng });
  if (state.online) runAnalysis();
  if (isMobile() && returnTo === 'ontrail') setMobileTab('ontrail');
};

// Further than this from the GPS position, a typed mile overrides GPS instead of picking the pass.
const PASS_CORRECTION_MILES = 1;

const setMileManually = (mile) => {
  const live = gps.getState();
  if (live.state === 'live' && live.fix) {
    const anchored = withMile(live, mile);
    if (Math.abs(anchored.mile - mile) <= PASS_CORRECTION_MILES) {
      lastRouteMile = anchored.mile;
      set({ gps: anchored });
      map.setPosition(anchored);
      profile.setPosition(anchored.mile);
      announce(`Position set to Mile ${anchored.mile.toFixed(1)}.`);
      if (state.online) runAnalysis();
      return;
    }
  }
  const [lng, lat] = pointAtMile(state.route.coords, state.route.cum, mile);
  typedMileHint = mile;
  setManualPosition({ lat, lng });
};

const setMode = (mode) => {
  if (mode === state.mode) return;
  savePrefs({ mode });
  setPickMode(false);
  // "Since your last check" follows the result on screen, which stays until the new mode's check lands.
  set({ mode });
  if (mode === 'on-trail') gps.start();
  else {
    gps.stop();
    ui.trail?.releaseWake?.();
    releaseCockpitWake();
  }
  profile.setPosition(mode === 'on-trail' ? state.gps.mile : null);
  if (!state.route || !state.online) return;
  if (mode === 'on-trail') {
    if (state.gps.fix || !state.result) runAnalysis();
    return;
  }
  const recent = state.result?.mode === 'planning' && Date.now() - Date.parse(state.result.generatedAt) < REUSE_RESULT_MS && sameTrip(state.trip, state.result?.trip);
  // lastCheck.onTrail: the latest check started was an On trail one (in flight or failed) — replace it.
  if (!recent || lastCheck.onTrail) runAnalysis();
};

let lookaheadTimer = null;

const setLookahead = (miles) => {
  set({ lookaheadMiles: miles });
  savePrefs({ lookaheadMiles: miles });
  clearTimeout(lookaheadTimer);
  lookaheadTimer = setTimeout(() => {
    if (state.online && state.mode === 'on-trail' && state.gps.fix) runAnalysis();
  }, LOOKAHEAD_DEBOUNCE_MS);
};

const setTrip = (trip) => {
  set({ trip, tripPaceMilesPerDay: trip.paceMilesPerDay });
  savePrefs({ tripPaceMilesPerDay: trip.paceMilesPerDay });
  runAnalysis();
};

const clearTrip = () => {
  set({ trip: null });
  runAnalysis();
};

// ------------------------------------------------- selection + filters sync

const topVisibleRef = (refs = []) => refs
  .filter(r => !state.hiddenTypes.has(state.result?.hazards?.[r.id]?.type))
  .reduce((best, r) => (!best || r.level > best.level ? r : best), null);

const segmentAt = (mile) => state.result?.segments.find(s => s.mileStart <= mile && mile <= s.mileEnd) ?? null;

const highlightMile = (mile) => {
  map.highlightMile(mile);
  profile.setHover(mile);
};

const clearStretch = () => {
  set({ selectedStretch: null });
  map.highlightStretch(null);
  ui.routeLog.setSelected(null);
};

/** Select a hazard everywhere: list, map and profile. `toggle` deselects on a second press. */
const selectHazard = (id, { reveal = false, fit = true, toggle = false, keepStretch = false } = {}) => {
  if (!keepStretch) clearStretch();
  const hz = id ? state.result?.hazards?.[id] : null;
  // Asking for a hazard whose type is filtered out shows that type again, so list and map agree.
  if (hz && state.hiddenTypes.has(hz.type)) {
    const hidden = new Set(state.hiddenTypes);
    hidden.delete(hz.type);
    applyFilters(hidden);
  }
  const next = !hz || (toggle && state.selectedHazardId === id) ? null : id;
  set({ selectedHazardId: next });
  map.highlightHazard(next);
  ui.hazards.setSelected(next);
  highlightMile(next ? hz.closest?.atMile ?? hz.ranges?.[0]?.[0] ?? null : null);
  if (!next) return;
  if (fit && hz.ranges?.length) {
    requestAnimationFrame(() => map.fitRange(hz.ranges[0][0], hz.ranges[hz.ranges.length - 1][1], hz.id));
  }
  if (reveal) {
    if (isMobile() && state.mobileTab !== 'briefing') setMobileTab('briefing');
    ui.tabs.select('hazards');
    // After the queued render, which may have just added the item (filters lifted above).
    queueMicrotask(() => ui.hazards.reveal(next));
  }
};

const showStretch = (mileStart, mileEnd, clickMile) => {
  const target = Number.isFinite(clickMile) ? clickMile : (mileStart + mileEnd) / 2;
  if (state.selectedHazardId) {
    set({ selectedHazardId: null });
    map.highlightHazard(null);
    ui.hazards.setSelected(null);
  }
  if (isMobile() && state.mobileTab !== 'briefing') setMobileTab('briefing');
  ui.tabs.select('log');
  const chunk = ui.routeLog.reveal(target);
  const stretch = chunk || { mileStart, mileEnd };
  set({ selectedStretch: stretch });
  map.highlightStretch(stretch);
  highlightMile(target);
};

const onSegmentClick = (mileStart, mileEnd, _refs, clickMile) => showStretch(mileStart, mileEnd, clickMile);

const onProfileSelect = (mile) => {
  const segment = segmentAt(mile);
  if (!segment) return;
  const top = topVisibleRef(segment.refs);
  if (isMobile()) {
    if (top) focusHazardOnMap(top.id);
    else focusStretchOnMap(segment.mileStart, segment.mileEnd, null);
    return;
  }
  map.fitRange(segment.mileStart, segment.mileEnd);
  if (top) selectHazard(top.id, { reveal: true, fit: false });
  else showStretch(segment.mileStart, segment.mileEnd, mile);
};

const onLogSelect = ({ mileStart, mileEnd, hazardId, source, clear }) => {
  if (clear) {
    set({ selectedStretch: null, selectedHazardId: null });
    map.highlightStretch(null);
    map.highlightHazard(null);
    ui.hazards.setSelected(null);
    ui.routeLog.setSelected(null);
    highlightMile(null);
    return;
  }
  requestAnimationFrame(() => map.fitRange(mileStart, mileEnd));
  const mid = (mileStart + mileEnd) / 2;
  const stretch = { mileStart, mileEnd };
  set({ selectedStretch: stretch });
  map.highlightStretch(stretch);
  ui.routeLog.setSelected(source === 'log' ? mid : null);
  if (hazardId) selectHazard(hazardId, { fit: false, keepStretch: true });
  else {
    set({ selectedHazardId: null });
    map.highlightHazard(null);
    ui.hazards.setSelected(null);
  }
  highlightMile(mid);
};

const applyFilters = (hiddenTypes) => {
  set({ hiddenTypes });
  map.setFilters(hiddenTypes);
  profile.setFilters(hiddenTypes);
  const selected = state.result?.hazards?.[state.selectedHazardId];
  if (selected && hiddenTypes.has(selected.type)) selectHazard(null);
};

const toggleType = (type) => {
  const hidden = new Set(state.hiddenTypes);
  if (hidden.has(type)) hidden.delete(type);
  else hidden.add(type);
  applyFilters(hidden);
};

// --------------------------------------------------------- routes + import

const refreshRecent = async () => {
  const routes = await db.listRoutes();
  const enriched = await Promise.all(routes.map(async (r) => {
    const cached = (await db.getResult(db.resultKey(r.id, 'planning')))
      || (await db.getResult(db.resultKey(r.id, 'on-trail')));
    const lastCheck = cached?.result ?? null;
    const level = lastCheck?.summary?.level;
    return {
      ...r,
      lastCheck,
      lengthMiles: r.meta?.lengthMiles ?? null,
      offlineReady: Boolean(r.offlinePack?.savedAt),
      level: Number.isFinite(level) ? level : null,
    };
  }));
  set({ recent: enriched });
};

const openRoute = async (route, { isNew }) => {
  cancelAnalysis();
  cancelOfflineSave();
  setPickMode(false);
  clearMapInspect();
  lastCheck = { at: 0, mile: null, onTrail: false };
  lastRouteMile = null;
  const nextMobileTab = mobileTabOnRouteOpen();
  set({
    view: 'route', route, result: null, busy: false, error: null, importError: null,
    changes: null, changesKey: null, selectedHazardId: null, selectedStretch: null,
    hiddenTypes: new Set(), trip: null, offlinePack: null, mapInspect: null,
    mobileTab: nextMobileTab,
  });
  document.body.dataset.mobileTab = nextMobileTab;
  // Project only once the new route is in state; the old mile is no hint for it.
  const gpsState = withMile(gps.getState(), null);
  set({ gps: gpsState });
  savePrefs({ lastRouteId: route.id });
  if (ui.panel) ui.panel.scrollTop = 0;
  syncScrollTop();
  ui.tabs.select('hazards');
  ui.routeLog.setSelected(null);
  map.setRoute(route);
  map.setFilters(state.hiddenTypes);
  map.setPosition(gpsState);
  profile.render(route, null);
  profile.setFilters(state.hiddenTypes);
  profile.setPosition(state.mode === 'on-trail' ? gpsState.mile : null);

  // Load saved route metadata + last saved answer right away (offline-first!).
  const [stored, cached] = await Promise.all([db.getRoute(route.id), cachedResult(route)]);
  if (state.route !== route) return;
  if (stored?.offlinePack) set({ offlinePack: stored.offlinePack });
  if (cached && !state.result) {
    set({ result: cached.result });
    drawResult();
  }

  if (state.online) runAnalysis();
  await (isNew ? db.saveRoute(route) : db.touchRoute(route.id));
  refreshRecent();
};

const closeRoute = () => {
  cancelAnalysis();
  cancelOfflineSave();
  setPickMode(false);
  clearMapInspect();
  ui.trail?.releaseWake?.();
  releaseCockpitWake();
  lastRouteMile = null;
  const nextMobileTab = mobileTabOnRouteClose();
  set({
    view: 'start', route: null, result: null, busy: false, error: null,
    changes: null, changesKey: null, selectedHazardId: null, selectedStretch: null,
    trip: null, offlinePack: null, mapInspect: null, mobileTab: nextMobileTab,
  });
  document.body.dataset.mobileTab = nextMobileTab;
  if (ui.panel) ui.panel.scrollTop = 0;
  syncScrollTop();
  ui.routeLog.setSelected(null);
  map.setRoute(null);
  profile.render(null, null);
  savePrefs({ lastRouteId: null });
  refreshRecent();
  focusAfterRender(ui.openFile);
};

let importSeq = 0;

const importWith = async (label, load) => {
  const id = ++importSeq;
  set({ importing: label, importError: null });
  try {
    const parsed = await load();
    if (id !== importSeq) return;
    let route;
    try {
      route = buildRouteData(parsed.coords, { name: parsed.name, meta: parsed.meta });
    } catch (err) {
      throw new ImportError(err.message);
    }
    set({ importing: null });
    await openRoute(route, { isNew: true });
  } catch (err) {
    if (id !== importSeq) return;
    if (!(err instanceof ImportError)) console.error('[ridgeline] import failed', err);
    set({ importing: null, importError: err instanceof ImportError ? err.message : "Ridgeline couldn't read this file. Try exporting it again as GPX." });
  }
};

const importFile = (file) => importWith(file.name, () => readRouteFile(file));

const importSample = () => importWith('the sample route', async () => {
  let res;
  try {
    res = await fetch(SAMPLE.url);
  } catch {
    throw new ImportError("Couldn't load the sample route — check your connection.");
  }
  if (!res.ok) throw new ImportError("Couldn't load the sample route. Try again in a minute.");
  return parseRouteText(await res.text(), SAMPLE.fileName);
});

const openTrailTrack = (track, trail) => importWith(trail?.name || track?.name || 'trail', async () => ({
  name: track.name || trail?.name || 'Trail route',
  coords: track.coords,
  meta: {
    trailId: trail?.id || null,
    region: trail?.region || null,
    agency: trail?.agency || null,
    gainFt: trail?.gainFt ?? null,
    source: trail?.source || null,
    ...(Array.isArray(trail?.start) ? { start: trail.start } : {}),
    ...(trail?.sampleUrl ? { sampleUrl: trail.sampleUrl } : {}),
    ...(trail?.queryMeta ? { queryMeta: trail.queryMeta } : {}),
  },
}));

const openPicker = () => ui.fileInput.click();

const openStored = async (id) => {
  const stored = await db.getRoute(id);
  if (!stored) {
    set({ importError: 'That route is no longer saved on this device.' });
    refreshRecent();
    return;
  }
  openRoute(routeDataFromStored(stored), { isNew: false });
};

const removeStored = async (id) => {
  tracked.delete(db.resultKey(id, 'planning'));
  tracked.delete(db.resultKey(id, 'on-trail'));
  await db.removeRoute(id);
  refreshRecent();
};

const restoreSession = async (prefs) => {
  // Always honor saved On-trail mode (even offline or on iOS where permissions.query is absent).
  if (prefs.mode === 'on-trail') setMode('on-trail');
  await refreshRecent();
  if (!prefs.lastRouteId) return;
  const stored = await db.getRoute(prefs.lastRouteId);
  if (stored && !state.route && !state.importing) openRoute(routeDataFromStored(stored), { isNew: false });
};

// ------------------------------------------------------------------ timers

const tick = () => {
  render();
  if (!state.online || document.visibilityState !== 'visible' || !state.route || state.busy) return;
  const age = Date.now() - lastCheck.at;
  // Without a fix, On trail still re-checks the whole route on the On trail schedule.
  if (age >= (state.mode === 'on-trail' ? ON_TRAIL_REFRESH_MS : PLANNING_REFRESH_MS)) runAnalysis({ auto: true });
};

// ------------------------------------------------------------------ wiring

const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

const wireDragAndDrop = () => {
  let depth = 0;
  const showOverlay = (on) => { ui.dropOverlay.hidden = !on; };
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    showOverlay(true);
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) showOverlay(false);
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    showOverlay(false);
    const file = e.dataTransfer.files[0];
    if (file) importFile(file);
  });
};

const wireMobileNav = () => {
  for (const btn of ui.mobileNavButtons) {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.mobileTab;
      if (targetTab) setMobileTab(targetTab);
    });
  }

  ui.mapRoutePill?.addEventListener('click', () => {
    setMobileTab(state.route ? 'briefing' : 'explore');
  });

  ui.mapLocateBtn?.addEventListener('click', () => {
    const g = state.gps;
    if (g.fix && g.state !== 'off' && Number.isFinite(g.fix.lat)) {
      map.centerOnPosition();
      return;
    }
    pendingCenterOnFix = true;
    gps.start();
    announce('Acquiring your GPS location…');
  });

  ui.briefingGoExplore?.addEventListener('click', () => setMobileTab('explore'));
  ui.briefingTrySample?.addEventListener('click', importSample);

  window.addEventListener('resize', () => {
    render();
    requestAnimationFrame(() => {
      syncMapInset();
      map?.resize();
    });
  });
};

const wireEvents = () => {
  for (const button of ui.modeButtons) button.addEventListener('click', () => setMode(button.dataset.mode));
  ui.themeToggle?.addEventListener('click', () => toggleTheme());
  window.addEventListener('ridgeline-theme', (e) => {
    const next = e.detail?.theme === 'light' ? 'light' : 'dark';
    state.theme = next;
    syncThemeToggle();
    map?.setTheme(next);
  });

  ui.brandHome?.addEventListener('click', () => {
    if (isMobile()) {
      setMobileTab('explore');
    } else if (state.view === 'route') {
      closeRoute();
    }
  });
  ui.openFile.addEventListener('click', openPicker);
  ui.fileInput.addEventListener('change', () => {
    const file = ui.fileInput.files?.[0];
    // Reset now so picking the same file again still fires "change".
    ui.fileInput.value = '';
    if (file) importFile(file);
  });
  ui.trySample.addEventListener('click', importSample);
  ui.checkAgain.addEventListener('click', () => runAnalysis({ refresh: true }));
  ui.changeRoute.addEventListener('click', closeRoute);
  ui.panel?.addEventListener('scroll', syncScrollTop, { passive: true });
  ui.scrollTop?.addEventListener('click', (e) => {
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    ui.panel?.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
    if (e.detail === 0) ui.routeName?.focus({ preventScroll: true });
  });
  ui.pickCancel.addEventListener('click', () => {
    const returnTo = pickReturnTab;
    setPickMode(false);
    if (isMobile() && returnTo === 'ontrail') setMobileTab('ontrail');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.pickMode) {
        const returnTo = pickReturnTab;
        setPickMode(false);
        if (isMobile() && returnTo === 'ontrail') setMobileTab('ontrail');
      } else if (state.mapInspect) {
        clearMapInspect();
      }
    }
  });
  window.addEventListener('online', () => {
    set({ online: true });
    if (state.route && (!state.result || state.error || Date.now() - lastCheck.at >= ON_TRAIL_REFRESH_MS)) {
      runAnalysis({ refresh: true });
    }
  });
  window.addEventListener('offline', () => set({ online: false }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (cockpitWakeWanted && !cockpitWakeSentinel) acquireCockpitWake();
      tick();
    }
  });
  wireMobileNav();
  wireDragAndDrop();
  observeMobileMapJumps();
};

const bindUi = () => {
  const $ = (id) => document.getElementById(id);
  return {
    panel: $('panel-scroll'),
    mobileNav: $('mobile-nav'),
    mobileNavButtons: [...document.querySelectorAll('#mobile-nav .mobile-nav-btn')],
    mobileHazardCount: $('mobile-count-hazards'),
    mobileGpsDot: $('mobile-gps-dot'),
    themeToggle: $('theme-toggle'),
    live: $('live'),
    brandHome: $('brand-home'),
    startView: $('start-view'),
    briefingEmpty: $('briefing-empty'),
    briefingGoExplore: $('briefing-go-explore'),
    briefingTrySample: $('briefing-try-sample'),
    routeView: $('route-view'),
    ontrailView: $('ontrail-view'),
    ontrailCockpit: $('ontrail-cockpit'),
    routeTrailSlot: $('route-trail-slot'),
    ontrailTrailSlot: $('ontrail-trail-slot'),
    dropzone: $('dropzone'),
    dropOverlay: $('drop-overlay'),
    openFile: $('open-file'),
    fileInput: $('file-input'),
    trySample: $('try-sample'),
    routeName: $('route-name'),
    routeMeta: $('route-meta'),
    checkAgain: $('check-again'),
    changeRoute: $('change-route'),
    offlinePackEl: $('offline-pack'),
    trailEl: $('trail'),
    tripEl: $('trip'),
    mapEl: $('map'),
    mapRoutePill: $('map-route-pill'),
    mapPillSwatch: $('map-pill-swatch'),
    mapPillName: $('map-pill-name'),
    mapPillAction: $('map-pill-action'),
    mapLocateBtn: $('map-locate-btn'),
    mapInspectCard: $('map-inspect-card'),
    pickHint: $('pick-hint'),
    pickCancel: $('pick-cancel'),
    hazardTab: $('tab-hazards'),
    hazardCount: $('count-hazards'),
    sourceFlag: $('flag-sources'),
    modeButtons: [...document.querySelectorAll('#mode-switch button')],
    banner: createBanner($('banner')),
    explore: createExplore($('explore-slot'), {
      onOpenTrail: openTrailTrack,
      onOpenSaved: openStored,
      onRemoveSaved: removeStored,
      onOpenFile: openPicker,
    }),
    verdict: createVerdict({ plaque: $('verdict'), notes: $('verdict-notes') }, {
      onSelectHazard: (id) => (isMobile() ? focusHazardOnMap(id) : selectHazard(id, { reveal: true, fit: true })),
      onShowSources: () => {
        if (isMobile() && state.mobileTab !== 'briefing') setMobileTab('briefing');
        ui.tabs.select('sources', { focus: true });
      },
    }),
    offlinePack: createOfflinePackPanel($('offline-pack'), {
      onSave: startOfflineSave,
      onCancel: cancelOfflineSave,
    }),
    trail: createTrailStatus($('trail'), {
      onTogglePick: () => setPickMode(!state.pickMode),
      onRetryGps: () => gps.start(),
      onUseGps: () => gps.clearManual(),
      onSetMile: setMileManually,
      onLookahead: setLookahead,
      onCenterMap: () => {
        if (isMobile()) setMobileTab('map');
        requestAnimationFrame(() => map.centerOnPosition());
      },
    }),
    trip: createTripPlanner($('trip'), { onApply: setTrip, onClear: clearTrip }),
    filters: createFilters($('filters'), { onToggle: toggleType }),
    changes: createChanges($('changes'), {
      onSelect: (id) => (isMobile() ? focusHazardOnMap(id) : selectHazard(id, { reveal: true })),
      onDismiss: dismissChanges,
    }),
    hazards: createHazards($('panel-hazards'), {
      onSelect: (id) => selectHazard(id, { toggle: true, fit: !isMobile() }),
      onShowAll: () => applyFilters(new Set()),
    }),
    routeLog: createRouteLog($('panel-log'), {
      onSelect: onLogSelect,
      onOpenHazard: (id) => selectHazard(id, { reveal: true }),
      onShowAll: () => applyFilters(new Set()),
    }),
    conditions: createConditions($('panel-conditions'), { onSelect: onLogSelect }),
    sources: createSources($('panel-sources')),
    recent: createRecent($('recent'), { onOpen: openStored, onRemove: removeStored, fallbackFocus: $('open-file') }),
    scrollTopWrap: $('scroll-top-wrap'),
    scrollTop: $('scroll-top'),
    tabs: createTabs($('tabs'), {
      onChange: (tab) => {
        state.activeTab = tab;
        savePrefs({ tab });
        syncScrollTop();
      },
    }),
  };
};

export const startApp = () => {
  state.theme = initTheme();
  initNativeApp({
    initialTheme: state.theme,
    onOpenRouteFile: ({ name, text }) => importWith(name, async () => parseRouteText(text, name)),
  });
  ui = bindUi();
  const mapView = guarded('map', () => createMapView(ui.mapEl, {
    theme: state.theme,
    onSegmentClick,
    onOverlayClick: (hazardId) => selectHazard(hazardId, { reveal: true, fit: false }),
    onHazardTap: handleMobileMapTap,
    onMileHover: (mile) => profile.setHover(mile),
    onPickPosition: setManualPosition,
  }), MAP_METHODS);
  map = mapView.api;
  if (!mapView.ok) {
    ui.mapEl.after(h('p', { class: 'map-fallback' }, "The map couldn't start on this device. Everything else still works."));
  }
  profile = guarded('profile', () => createProfile(document.getElementById('profile'), {
    onHover: (mile) => map.highlightMile(mile),
    onSelect: onProfileSelect,
  }), PROFILE_METHODS).api;
  gps = createGps({ onChange: onGpsChange });

  wireEvents();
  const prefs = loadPrefs();
  if (LOOKAHEAD_STEPS.includes(prefs.lookaheadMiles)) state.lookaheadMiles = prefs.lookaheadMiles;
  if (Number.isFinite(prefs.tripPaceMilesPerDay) && prefs.tripPaceMilesPerDay >= 1 && prefs.tripPaceMilesPerDay <= 100) {
    state.tripPaceMilesPerDay = prefs.tripPaceMilesPerDay;
  }
  ui.tabs.select('hazards');
  render();
  restoreSession(prefs);
  setInterval(tick, TICK_MS);
};
