/**
 * Ridgeline's orchestrator: one state object, render() for the panels, and
 * the analysis lifecycle. Rules that matter for safety live here:
 * - every check has an id; a newer check aborts the older one and stale
 *   answers are dropped;
 * - a refresh never wipes the last answer; a failed refresh keeps showing it
 *   (from memory or IndexedDB) under a banner that says how old it is;
 * - On trail re-checks when the hiker moves a mile, every 15 minutes while
 *   the page is visible, and when the look-ahead distance changes.
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
import { h } from './ui/dom.js';
import { plural } from './ui/format.js';
import { createVerdict, createTrailStatus, aheadView, LOOKAHEAD_STEPS } from './panels/verdict.js';
import { createHazards } from './panels/hazards.js';
import { createRouteLog } from './panels/routeLog.js';
import { createConditions } from './panels/conditions.js';
import { createSources } from './panels/sources.js';
import { createFilters } from './panels/filters.js';
import { createChanges } from './panels/changes.js';
import { createRecent } from './panels/recent.js';
import { createBanner } from './panels/banner.js';
import { createTabs, fmtStamp, fmtTotal } from './panels/common.js';

const SAMPLE = { url: '/samples/jmt-yosemite.gpx', fileName: 'jmt-yosemite.gpx' };
const PREFS_KEY = 'ridgeline:prefs';
const TABS = ['hazards', 'log', 'conditions', 'sources'];
const TICK_MS = 30_000;
const ON_TRAIL_REFRESH_MS = 15 * 60_000;
const PLANNING_REFRESH_MS = 60 * 60_000;
// Switching back to Plan within this window reuses the answer already on screen.
const REUSE_RESULT_MS = 5 * 60_000;
// Automatic checks (movement, timers) never fire closer together than this.
const MIN_AUTO_GAP_MS = 60_000;
const MOVE_REFRESH_MILES = 1;
const LOOKAHEAD_DEBOUNCE_MS = 600;

const GPS_ANNOUNCEMENTS = {
  live: 'GPS position found.',
  stale: 'GPS signal lost. Showing your last fix.',
  denied: 'Location access is off.',
  unavailable: "Can't get a GPS fix.",
  manual: 'Position set.',
};

const state = {
  view: 'start',            // 'start' | 'route'
  route: null,              // routeData from buildRouteData()
  mode: 'planning',         // 'planning' | 'on-trail'
  result: null,             // last good analysis for this route (never wiped by a refresh)
  busy: false,              // a check is in flight
  error: null,              // { message } of the latest failed check
  importing: null,          // file name being read
  importError: null,
  online: navigator.onLine,
  hiddenTypes: new Set(),
  gps: { state: 'off', fix: null, mile: null, offRouteMiles: null },
  lookaheadMiles: 15,
  selectedHazardId: null,
  changes: null,            // diffSnapshots() output with at least one change, or null
  changesKey: null,         // which tracked route+mode those changes belong to
  pickMode: false,
  recent: [],
};

let ui = null;
let map = null;
let profile = null;
let gps = null;

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
const focusAfterRender = (el) => queueMicrotask(() => el.focus());

const announce = (text) => {
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

const routeMetaText = (route) => {
  const parts = [`${fmtTotal(route.lengthMiles)} mi`];
  if (route.meta?.trackCount > 1) parts.push(`joined ${route.meta.trackCount} tracks`);
  if (!route.hasElevation) parts.push('no elevation data');
  return parts.join(', ');
};

const bannersFor = (now) => {
  const out = [];
  if (state.importing) out.push({ key: 'importing', tone: 'info', text: `Reading ${state.importing}…` });
  if (state.importError) {
    out.push({ key: 'import', tone: 'error', text: state.importError, action: { label: 'Choose another file', onClick: openPicker } });
  }
  const inRoute = state.view === 'route';
  if (!state.online) {
    let text = "You're offline. Saved routes still open, but checks need a connection.";
    if (inRoute) {
      text = state.result
        ? `You're offline — showing data from ${fmtStamp(state.result.generatedAt, now)}. Ridgeline checks again when you reconnect.`
        : "You're offline. Ridgeline checks this route when you reconnect.";
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
  const issues = result?.summary?.incomplete ? result.summary.incompleteSources.length : 0;
  ui.sourceFlag.hidden = issues === 0;
  ui.sourceFlag.textContent = issues ? plural(issues, 'issue') : '';
};

const renderRouteView = (now) => {
  const { route, result, mode, hiddenTypes } = state;
  const trailMile = mode === 'on-trail' ? state.gps.mile : null;
  ui.routeName.textContent = route.name;
  ui.routeMeta.textContent = routeMetaText(route);
  ui.verdict.render({
    route, result, mode, gps: state.gps, busy: state.busy,
    failed: Boolean(state.error) && !state.busy, lookaheadMiles: state.lookaheadMiles, now,
  });
  ui.trailEl.hidden = mode !== 'on-trail';
  if (mode === 'on-trail') {
    ui.trail.render({ route, gps: state.gps, pickMode: state.pickMode, lookaheadMiles: state.lookaheadMiles, now });
  }
  ui.filters.render({ result, hiddenTypes });
  ui.changes.render({ changes: state.changes, now });
  ui.hazards.render({ result, hiddenTypes, mile: trailMile, now, selected: state.selectedHazardId });
  ui.routeLog.render({ result, hiddenTypes, mile: trailMile });
  ui.conditions.render({ result, mile: trailMile, now });
  ui.sources.render({ result, now });
  renderTabBadges();
};

const render = () => {
  renderQueued = false;
  const now = Date.now();
  const viewChanged = document.body.dataset.view !== state.view;
  document.body.dataset.view = state.view;
  document.body.dataset.mode = state.mode;
  for (const button of ui.modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
  ui.startView.hidden = state.view !== 'start';
  ui.routeView.hidden = state.view !== 'route';
  ui.dropzone.setAttribute('aria-busy', String(Boolean(state.importing)));
  ui.banner.render(bannersFor(now));
  if (state.view === 'route') renderRouteView(now);
  else ui.recent.render(state.recent, now);
  // The map's box changes height between views on phones.
  if (viewChanged) requestAnimationFrame(() => map.resize());
};

// ------------------------------------------------------------ map + profile

const drawResult = () => {
  map.setAnalysis(state.result, { hiddenTypes: state.hiddenTypes });
  map.highlightHazard(state.selectedHazardId);
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

const MAP_METHODS = ['setRoute', 'setAnalysis', 'setFilters', 'setPosition', 'highlightMile', 'highlightHazard', 'fitRange', 'fitRoute', 'setPickMode', 'resize'];
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
 * hiker still sees something while GPS warms up.
 */
const runAnalysis = async ({ auto = false } = {}) => {
  const { route } = state;
  if (!route) return;
  if (auto && (!state.online || Date.now() - lastCheck.at < MIN_AUTO_GAP_MS)) return;
  const location = state.mode === 'on-trail' ? locationPayload() : null;
  cancelAnalysis();
  const id = analysisSeq;
  const controller = new AbortController();
  inflight = controller;
  lastCheck = { at: Date.now(), mile: location ? state.gps.mile : null, onTrail: Boolean(location) };
  set({ busy: true });
  try {
    const result = await analyzeRoute({ route, location, lookaheadMiles: state.lookaheadMiles, signal: controller.signal });
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
  ui.checkAgain.focus();
  runAnalysis();
};

const dismissChanges = () => {
  const entry = state.changesKey ? tracked.get(state.changesKey) : null;
  if (entry) {
    entry.baseline = entry.latest;
    entry.diff = null;
  }
  set({ changes: null, changesKey: null });
  ui.checkAgain.focus();
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
  if (mode !== 'on-trail' || !route || !g.fix || g.state === 'manual') return;
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
  if (previous.state !== gpsState.state && GPS_ANNOUNCEMENTS[gpsState.state]) announce(GPS_ANNOUNCEMENTS[gpsState.state]);
  maybeCheckForPosition();
};

const setPickMode = (on) => {
  if (state.pickMode === on) return;
  set({ pickMode: on });
  map.setPickMode(on);
  ui.pickHint.hidden = !on;
  if (on) announce('Tap the map where you are, or press Escape to cancel.');
};

const setManualPosition = ({ lat, lng }) => {
  setPickMode(false);
  gps.setManual({ lat, lng });
  runAnalysis();
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
      runAnalysis();
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
  else gps.stop();
  profile.setPosition(mode === 'on-trail' ? state.gps.mile : null);
  if (!state.route) return;
  if (mode === 'on-trail') {
    if (state.gps.fix || !state.result) runAnalysis();
    return;
  }
  const recent = state.result?.mode === 'planning' && Date.now() - Date.parse(state.result.generatedAt) < REUSE_RESULT_MS;
  // lastCheck.onTrail: the latest check started was an On trail one (in flight or failed) — replace it.
  if (!recent || lastCheck.onTrail) runAnalysis();
};

let lookaheadTimer = null;

const setLookahead = (miles) => {
  set({ lookaheadMiles: miles });
  savePrefs({ lookaheadMiles: miles });
  clearTimeout(lookaheadTimer);
  lookaheadTimer = setTimeout(() => {
    if (state.mode === 'on-trail' && state.gps.fix) runAnalysis();
  }, LOOKAHEAD_DEBOUNCE_MS);
};

const locationAlreadyAllowed = async () => {
  try {
    return (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted';
  } catch {
    return false;
  }
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

/** Select a hazard everywhere: list, map and profile. `toggle` deselects on a second press. */
const selectHazard = (id, { reveal = false, fit = true, toggle = false } = {}) => {
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
  if (fit && hz.ranges?.length) map.fitRange(hz.ranges[0][0], hz.ranges[hz.ranges.length - 1][1], hz.id);
  if (reveal) {
    ui.tabs.select('hazards');
    // After the queued render, which may have just added the item (filters lifted above).
    queueMicrotask(() => ui.hazards.reveal(next));
  }
};

const showStretch = (mileStart, mileEnd) => {
  ui.tabs.select('log');
  ui.routeLog.reveal((mileStart + mileEnd) / 2);
};

const onSegmentClick = (mileStart, mileEnd, refs) => {
  const top = topVisibleRef(refs);
  if (top) selectHazard(top.id, { reveal: true, fit: false });
  else showStretch(mileStart, mileEnd);
};

const onProfileSelect = (mile) => {
  const segment = segmentAt(mile);
  if (!segment) return;
  map.fitRange(segment.mileStart, segment.mileEnd);
  const top = topVisibleRef(segment.refs);
  if (top) selectHazard(top.id, { reveal: true, fit: false });
  else showStretch(segment.mileStart, segment.mileEnd);
};

const onLogSelect = ({ mileStart, mileEnd, hazardId }) => {
  map.fitRange(mileStart, mileEnd);
  if (hazardId) selectHazard(hazardId, { fit: false });
  highlightMile((mileStart + mileEnd) / 2);
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

const refreshRecent = async () => set({ recent: await db.listRoutes() });

const openRoute = async (route, { isNew }) => {
  cancelAnalysis();
  setPickMode(false);
  lastCheck = { at: 0, mile: null, onTrail: false };
  lastRouteMile = null;
  set({
    view: 'route', route, result: null, busy: false, error: null, importError: null,
    changes: null, changesKey: null, selectedHazardId: null, hiddenTypes: new Set(),
  });
  // Project only once the new route is in state; the old mile is no hint for it.
  const gpsState = withMile(gps.getState(), null);
  set({ gps: gpsState });
  savePrefs({ lastRouteId: route.id });
  map.setRoute(route);
  map.setFilters(state.hiddenTypes);
  map.setPosition(gpsState);
  profile.render(route, null);
  profile.setFilters(state.hiddenTypes);
  profile.setPosition(state.mode === 'on-trail' ? gpsState.mile : null);
  runAnalysis();

  // Show the last saved answer right away (offline-friendly) until the fresh one lands.
  const cached = await cachedResult(route);
  if (cached && !state.result && state.route === route) {
    set({ result: cached.result });
    drawResult();
  }
  await (isNew ? db.saveRoute(route) : db.touchRoute(route.id));
  refreshRecent();
};

const closeRoute = () => {
  cancelAnalysis();
  setPickMode(false);
  lastRouteMile = null;
  set({ view: 'start', route: null, result: null, busy: false, error: null, changes: null, changesKey: null, selectedHazardId: null });
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
  if (prefs.mode === 'on-trail' && await locationAlreadyAllowed()) setMode('on-trail');
  await refreshRecent();
  if (!prefs.lastRouteId) return;
  const stored = await db.getRoute(prefs.lastRouteId);
  if (stored && !state.route && !state.importing) openRoute(routeDataFromStored(stored), { isNew: false });
};

// ------------------------------------------------------------------ timers

const tick = () => {
  render();
  if (document.visibilityState !== 'visible' || !state.route || state.busy) return;
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

const wireEvents = () => {
  for (const button of ui.modeButtons) button.addEventListener('click', () => setMode(button.dataset.mode));
  ui.openFile.addEventListener('click', openPicker);
  ui.fileInput.addEventListener('change', () => {
    const file = ui.fileInput.files?.[0];
    // Reset now so picking the same file again still fires "change".
    ui.fileInput.value = '';
    if (file) importFile(file);
  });
  ui.trySample.addEventListener('click', importSample);
  ui.checkAgain.addEventListener('click', () => runAnalysis());
  ui.changeRoute.addEventListener('click', closeRoute);
  ui.pickCancel.addEventListener('click', () => setPickMode(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.pickMode) setPickMode(false);
  });
  window.addEventListener('online', () => {
    set({ online: true });
    if (state.route && (state.error || Date.now() - lastCheck.at >= ON_TRAIL_REFRESH_MS)) runAnalysis();
  });
  window.addEventListener('offline', () => set({ online: false }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick();
  });
  wireDragAndDrop();
};

const bindUi = () => {
  const $ = (id) => document.getElementById(id);
  return {
    live: $('live'),
    startView: $('start-view'),
    routeView: $('route-view'),
    dropzone: $('dropzone'),
    dropOverlay: $('drop-overlay'),
    openFile: $('open-file'),
    fileInput: $('file-input'),
    trySample: $('try-sample'),
    routeName: $('route-name'),
    routeMeta: $('route-meta'),
    checkAgain: $('check-again'),
    changeRoute: $('change-route'),
    trailEl: $('trail'),
    mapEl: $('map'),
    pickHint: $('pick-hint'),
    pickCancel: $('pick-cancel'),
    hazardTab: $('tab-hazards'),
    hazardCount: $('count-hazards'),
    sourceFlag: $('flag-sources'),
    modeButtons: [...document.querySelectorAll('#mode-switch button')],
    banner: createBanner($('banner')),
    verdict: createVerdict({ plaque: $('verdict'), notes: $('verdict-notes') }, {
      onSelectHazard: (id) => selectHazard(id, { reveal: true }),
      onShowSources: () => ui.tabs.select('sources', { focus: true }),
    }),
    trail: createTrailStatus($('trail'), {
      onTogglePick: () => setPickMode(!state.pickMode),
      onRetryGps: () => gps.start(),
      onUseGps: () => gps.clearManual(),
      onSetMile: setMileManually,
      onLookahead: setLookahead,
    }),
    filters: createFilters($('filters'), { onToggle: toggleType }),
    changes: createChanges($('changes'), { onSelect: (id) => selectHazard(id, { reveal: true }), onDismiss: dismissChanges }),
    hazards: createHazards($('panel-hazards'), {
      onSelect: (id) => selectHazard(id, { toggle: true }),
      onShowAll: () => applyFilters(new Set()),
    }),
    routeLog: createRouteLog($('panel-log'), { onSelect: onLogSelect, onShowAll: () => applyFilters(new Set()) }),
    conditions: createConditions($('panel-conditions'), { onSelect: onLogSelect }),
    sources: createSources($('panel-sources')),
    recent: createRecent($('recent'), { onOpen: openStored, onRemove: removeStored, fallbackFocus: $('open-file') }),
    tabs: createTabs($('tabs'), { onChange: (tab) => savePrefs({ tab }) }),
  };
};

export const startApp = () => {
  ui = bindUi();
  const mapView = guarded('map', () => createMapView(ui.mapEl, {
    onSegmentClick,
    onOverlayClick: (hazardId) => selectHazard(hazardId, { reveal: true, fit: false }),
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
  ui.tabs.select(TABS.includes(prefs.tab) ? prefs.tab : 'hazards');
  render();
  restoreSession(prefs);
  setInterval(tick, TICK_MS);
};
