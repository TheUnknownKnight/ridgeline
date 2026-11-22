/**
 * Frontend logic that decides whether a stretch reads as clear. These run in
 * Node: the functions are pure and touch no DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSegments } from '../src/js/panels/profile.js';
import { fmtRouteMeta, sameTrip, shouldShowScrollTop } from '../src/js/panels/common.js';
import { parseTripForm, toLocalDatetimeValue } from '../src/js/panels/trip.js';
import { factsForHazard, groupHazardsByTier } from '../src/js/panels/hazards.js';
import { conditionsSnapshotText, shouldExpandConditionStretch, filterConditionStretches } from '../src/js/panels/conditions.js';
import { coverageText, diagnosticSummaryRows, partitionSources, sourceHealthSummary } from '../src/js/panels/sources.js';
import { matchEntryIndex, coverageOf, filterRouteEntries, previewRefsForStretch } from '../src/js/panels/routeLog.js';
import { badgeGlyphForHazard, badgeSvgMarkup, buildWeatherBadgeFeatures, glyphForAnyHazard } from '../src/js/map/weatherBadges.js';
import { cumulativeMiles } from '../shared/geo.js';
import { aheadView, caveatsSummaryLabel } from '../src/js/panels/verdict.js';
import { computeTrailProgress, computeOfflineDaylight, fmtDurationMinutes, formatCoordsDisplay, formatCoordsCopy, corridorTilesForRoute, nextMobileSheetSnap } from '../src/js/offline/trailMath.js';
import { offlinePackSummary } from '../src/js/panels/offlinePack.js';
import {
  DEFAULT_THEME, THEME_STORAGE_KEY, THEME_COLORS, getStoredTheme, initTheme, setTheme, toggleTheme,
  MOBILE_TABS, DEFAULT_MOBILE_TAB, normalizeMobileTab, transitionMobileTab,
  mobileTabOnRouteOpen, mobileTabOnRouteClose,
} from '../src/js/theme.js';

const ALL = ['fire', 'alerts', 'avalanche', 'water', 'air', 'forecast', 'smoke', 'conditions'];
const okSources = (overrides = {}) =>
  Object.fromEntries(ALL.map(k => [k, { status: 'ok', ...overrides[k] }]));

const seg = (mileStart, mileEnd, checked, refs = [], level = 0) =>
  ({ mileStart, mileEnd, level, estimatedOnly: false, refs, checked });

const result = (segments, extra = {}) => ({
  version: 2,
  mode: 'planning',
  sources: okSources(),
  hazards: {},
  segments,
  summary: { level: 0, headline: 'No reported hazards', counts: {}, incomplete: false, caveats: [] },
  ...extra,
});

test('a stretch outside US coverage is unchecked even when every source is ok', () => {
  const r = result([seg(0, 100, ALL), seg(100, 150, ['smoke'])]);
  const [inside, outside] = describeSegments(r);
  assert.deepEqual(inside.unchecked, []);
  assert.deepEqual(outside.unchecked, ['fire', 'alerts', 'avalanche', 'water', 'air', 'forecast', 'conditions']);
});

test('unrated avalanche terrain is unchecked, not clear', () => {
  const r = result([seg(0, 10, ALL.filter(k => k !== 'avalanche'))]);
  assert.deepEqual(describeSegments(r)[0].unchecked, ['avalanche']);
});

test('On trail: forecasts outside the look-ahead window are not flagged per stretch', () => {
  const official = ['fire', 'alerts', 'avalanche', 'water', 'air'];
  const r = result([seg(0, 10, official), seg(10, 25, ALL), seg(25, 60, official)], {
    mode: 'on-trail', window: { start: 10, end: 25, lookaheadMiles: 15 },
  });
  assert.deepEqual(describeSegments(r).map(v => v.unchecked), [[], [], []]);
});

test('a failed forecast is unchecked everywhere it did not run', () => {
  const r = result([seg(0, 10, ['fire', 'alerts', 'avalanche', 'water', 'air', 'smoke', 'conditions'])], {
    sources: okSources({ forecast: { status: 'error' } }),
  });
  assert.deepEqual(describeSegments(r)[0].unchecked, ['forecast']);
});

test('a hazard hidden by filters is reported as hidden, not as nothing', () => {
  const r = result([seg(0, 5, ALL, [{ id: 'fire:1', level: 4 }], 4)], {
    hazards: { 'fire:1': { id: 'fire:1', type: 'fire', level: 4, source: 'OFFICIAL' } },
  });
  const [view] = describeSegments(r, new Set(['fire']));
  assert.equal(view.level, 0);
  assert.equal(view.hiddenOnly, true);
});

test('On trail with nothing ahead never names a hazard behind the hiker', () => {
  const r = result([seg(0, 40, ALL), seg(42, 47, ALL, [{ id: 'fire:g', level: 4 }], 4), seg(47, 150, ALL)], {
    hazards: { 'fire:g': { id: 'fire:g', type: 'fire', level: 4, title: 'Garnet Fire', source: 'OFFICIAL' } },
    summary: { level: 4, headline: 'Garnet Fire (Mi 42–47)', counts: { 4: 1 }, incomplete: true, caveats: [] },
  });
  const view = aheadView(r, 60);
  assert.equal(view.level, 0);
  assert.doesNotMatch(view.headline, /Garnet/);
  assert.equal(view.incomplete, true);
});

test('On trail names the worst hazard ahead and its distance', () => {
  const r = result([seg(0, 40, ALL), seg(42, 47, ALL, [{ id: 'fire:g', level: 4 }], 4), seg(47, 150, ALL)], {
    hazards: { 'fire:g': { id: 'fire:g', type: 'fire', level: 4, title: 'Garnet Fire', source: 'OFFICIAL' } },
  });
  assert.equal(aheadView(r, 40).headline, 'Garnet Fire, 2.0 mi ahead');
  assert.equal(aheadView(r, 44).headline, 'Garnet Fire, here now');
});

test('fmtRouteMeta shows DEM elevation stats once loaded and avoids false missing note while busy', () => {
  const noZ = { lengthMiles: 42.1, hasElevation: false, meta: {} };
  assert.equal(fmtRouteMeta(noZ, null, { busy: true }), '42.1 mi');
  assert.equal(fmtRouteMeta(noZ, null, { busy: false }), '42.1 mi, no elevation data');
  assert.equal(
    fmtRouteMeta(noZ, { route: { elevationFt: { min: 4820, max: 9140, gain: 6420, loss: 4180, source: 'landfire' } } }),
    '42.1 mi, +6,420 ft (4,820–9,140 ft, DEM)',
  );
  assert.equal(
    fmtRouteMeta({ lengthMiles: 12, hasElevation: true, meta: {} }, { route: { elevationFt: { min: 5000, max: 6200, gain: 1200, loss: 200, source: 'route' } } }),
    '12 mi, +1,200 ft (5,000–6,200 ft)',
  );
});

test('parseTripForm and sameTrip validate itinerary bounds cleanly', () => {
  assert.ok(parseTripForm('', '12').error);
  assert.ok(parseTripForm('2026-11-15T07:00', '0').error);
  assert.ok(parseTripForm('2026-11-15T07:00', '150').error);
  const ok = parseTripForm('2026-11-15T07:00', '14.24');
  assert.equal(ok.trip.paceMilesPerDay, 14.2);
  assert.equal(sameTrip(ok.trip, { startAt: ok.trip.startAt, paceMilesPerDay: 14.2 }), true);
  assert.equal(sameTrip(ok.trip, { startAt: ok.trip.startAt, paceMilesPerDay: 18 }), false);
  assert.equal(toLocalDatetimeValue(NaN), '');
});

test('factsForHazard upgrades avalanche terrain bullet cleanly without duplicating it', () => {
  const hz = {
    type: 'avalanche',
    detail: 'Utah Avalanche Center · highest rating across elevation bands · 1.8 mi >=25 deg slope (8400–10900 ft)',
    terrainContext: { steepMiles: 1.8, maxSlopeDeg: 38, elevationFt: [8400, 10900] },
  };
  assert.deepEqual(factsForHazard(hz), [
    'Utah Avalanche Center',
    'highest rating across elevation bands',
    '1.8 mi ≥25° slope (max 38°, 8,400–10,900 ft)',
  ]);
});

test('conditionsSnapshotText stays empty on dry routes and summarizes active winter signals', () => {
  assert.equal(conditionsSnapshotText({
    modeledPoints: 40, maxSnowDepthIn: 0, maxSnowmelt24hMm: 0, maxRunoff48hMm: 2, horizonShadedPoints: 0, steepMiles: 0,
  }), null);
  assert.equal(conditionsSnapshotText({
    modeledPoints: 40, maxSnowDepthIn: 14.2, maxSnowmelt24hMm: 12, maxRunoff48hMm: 25, horizonShadedPoints: 10, steepMiles: 2.3,
  }), 'Route snapshot: snowpack up to 14.2 in, 24 h melt peak 12 mm, 48 h runoff peak 25 mm, 25% ridge-shaded, 2.3 mi ≥25° slope.');
});

test('sources helpers report beyond-horizon miles and compact diagnostics', () => {
  assert.equal(
    coverageText({ sampledEveryMiles: 2, range: [0, 120], horizonHours: 168, beyondHorizonMiles: 18.4 }),
    'Sampled every 2 mi along Mi 0–120, next 168 h, 18.4 mi past horizon',
  );
  const rows = diagnosticSummaryRows({
    elevation: { min: 4820, max: 9140, gain: 6420, loss: 4180, source: 'landfire' },
    weather: { peakGustMph: 42, peakHeatF: null, minColdF: 18, minWindChillF: 5, maxPrecipIn: 0.4, maxSnowIn: 3.2, maxIceIn: 0, maxThunderPct: 0 },
    conditions: { modeledPoints: 48, maxSlopeDeg: 34, horizonShadedPoints: 12, maxSnowDepthIn: 8.5, maxSnowmelt24hMm: 10, maxRunoff48hMm: 18 },
    overlays: { total: 5, kept: 5, simplified: 1, dropped: 0, vertices: 4200 },
  });
  assert.equal(rows.length, 4);
  assert.match(rows[0][1], /LANDFIRE 30 m DEM/);
  assert.match(rows[1][1], /wind chill 5°F/);
  assert.match(rows[3][1], /1 simplified/);
});

test('matchEntryIndex selects the unique route-overview chunk spanning a clicked mile', () => {
  const entries = [
    { mileStart: 0, mileEnd: 12.5 },
    { mileStart: 12.5, mileEnd: 24.0 },
    { mileStart: 24.0, mileEnd: 30.2 },
  ];
  assert.equal(matchEntryIndex(entries, 0), 0);
  assert.equal(matchEntryIndex(entries, 12.5), 1);
  assert.equal(matchEntryIndex(entries, 18.2), 1);
  assert.equal(matchEntryIndex(entries, 30.2), 2);
  assert.equal(matchEntryIndex(entries, 40), -1);
  assert.equal(matchEntryIndex(entries, null), -1);
});

test('shouldShowScrollTop stays hidden near top or outside route view and appears when scrolled', () => {
  assert.equal(shouldShowScrollTop(300, 'start'), false);
  assert.equal(shouldShowScrollTop(0, 'route'), false);
  assert.equal(shouldShowScrollTop(160, 'route'), false);
  assert.equal(shouldShowScrollTop(161, 'route'), true);
  assert.equal(shouldShowScrollTop(NaN, 'route'), false);
});


test('weatherBadges classifies hazards, emits valid solid SVGs, and anchors/sorts badges along the route', () => {
  assert.equal(badgeGlyphForHazard({ type: 'alert', title: 'Winter Storm Warning' }), 'snow');
  assert.equal(badgeGlyphForHazard({ type: 'alert', title: 'Red Flag Warning' }), 'redflag');
  assert.equal(badgeGlyphForHazard({ type: 'alert', title: 'High Wind Advisory' }), 'wind');
  assert.equal(badgeGlyphForHazard({ type: 'alert', title: 'Ice Storm Warning' }), 'ice');
  assert.equal(badgeGlyphForHazard({ type: 'alert', title: 'Special Weather Statement' }), 'alert');
  assert.equal(badgeGlyphForHazard({ type: 'weather', id: 'wx:cold', title: 'Hard freeze' }), 'cold');
  assert.equal(badgeGlyphForHazard({ type: 'fire', title: 'Garnet Fire' }), null);

  const officialSvg = badgeSvgMarkup({ glyph: 'snow', level: 3, estimated: false, theme: 'dark' });
  assert.match(officialSvg, /fill="#dc3a1c"/);
  assert.match(officialSvg, /stroke="#ffffff"/);
  assert.doesNotMatch(officialSvg, /stroke-dasharray/);

  const estSvg = badgeSvgMarkup({ glyph: 'wind', level: 2, estimated: true, theme: 'light' });
  assert.match(estSvg, /stroke-dasharray/);

  const coords = Array.from({ length: 241 }, (_, i) => [-120, 36 + i / 69.05]);
  const cum = cumulativeMiles(coords);
  const route = { coords, cum };
  const r = {
    hazards: {
      'alert:1': { id: 'alert:1', type: 'alert', level: 3, source: 'OFFICIAL', title: 'Winter Storm Warning', ranges: [[10, 220]] },
      'wx:wind': { id: 'wx:wind', type: 'weather', level: 2, source: 'ESTIMATED', title: 'Strong wind gusts', ranges: [[20, 40]] },
      'fire:1': { id: 'fire:1', type: 'fire', level: 4, source: 'OFFICIAL', title: 'Fire', ranges: [[50, 55]] },
    },
  };
  const badges = buildWeatherBadgeFeatures(route, r, new Set(), 'dark');
  const alertBadges = badges.filter(f => f.properties.hazardId === 'alert:1');
  const windBadges = badges.filter(f => f.properties.hazardId === 'wx:wind');
  assert.equal(alertBadges.length, 2, 'long >=180 mi alert span places two spaced anchors');
  assert.equal(windBadges.length, 1);
  assert.ok(alertBadges[0].properties.sortKey < windBadges[0].properties.sortKey, 'higher-severity official badge wins collision');
  assert.equal(buildWeatherBadgeFeatures(route, r, new Set(['alert', 'weather']), 'dark').length, 0);
});

test('sidepanel digestibility helpers group hazard tiers, label coverage notes, and map all hazard glyphs', () => {
  const mixed = [
    { id: 'a', level: 4 },
    { id: 'b', level: 3 },
    { id: 'c', level: 2 },
  ];
  const tiered = groupHazardsByTier(mixed);
  assert.equal(tiered.grouped, true);
  assert.deepEqual(tiered.urgent.map(h => h.id), ['a', 'b']);
  assert.deepEqual(tiered.watch.map(h => h.id), ['c']);

  const smallUniform = [{ id: 'c', level: 2 }, { id: 'd', level: 1 }];
  assert.equal(groupHazardsByTier(smallUniform).grouped, false);
  assert.equal(groupHazardsByTier([{ id: '1', level: 2 }, { id: '2', level: 2 }, { id: '3', level: 1 }, { id: '4', level: 1 }]).grouped, true);

  assert.equal(caveatsSummaryLabel([]), '');
  assert.equal(caveatsSummaryLabel(['one']), '1 coverage note');
  assert.equal(caveatsSummaryLabel(['one', 'two']), '2 coverage notes');

  assert.equal(glyphForAnyHazard({ type: 'fire', title: 'Garnet Fire' }), 'redflag');
  assert.equal(glyphForAnyHazard({ type: 'avalanche', title: 'Avalanche danger' }), 'avalanche');
  assert.equal(glyphForAnyHazard({ type: 'water', title: 'River flood' }), 'water');
  assert.equal(glyphForAnyHazard({ type: 'smoke', title: 'Heavy smoke' }), 'smoke');
  assert.equal(glyphForAnyHazard({ type: 'trail', id: 'trail:ice', title: 'Icy trail' }), 'ice');
  assert.equal(glyphForAnyHazard({ type: 'trail', id: 'trail:snow', title: 'Deep snowpack' }), 'snow');
  assert.equal(glyphForAnyHazard({ type: 'trail', id: 'trail:mud', title: 'Muddy tread' }), 'trail');
});

test('routeLog consolidation deduplicates route-wide gaps, filters stretches, and never hides Extreme events in previews', () => {
  const r = result([
    seg(0, 10, ['fire', 'alerts', 'water', 'air', 'forecast', 'smoke', 'conditions']),
    seg(10, 20, ['fire', 'alerts', 'water', 'forecast', 'smoke', 'conditions']),
  ]);
  const cov = coverageOf(r);
  assert.deepEqual(cov.routeWideMissing, ['avalanche']);
  assert.deepEqual(cov.perRow, ['air']);
  assert.deepEqual(cov.windowed, []);

  const entries = [
    { level: 0 },
    { level: 2 },
    { level: 3 },
    { level: 4 },
  ];
  assert.equal(filterRouteEntries(entries, 'all').length, 4);
  assert.equal(filterRouteEntries(entries, 'hazards').length, 3);
  assert.equal(filterRouteEntries(entries, 'urgent').length, 2);

  const twoExtremes = [
    { id: 'fire:1', level: 4 },
    { id: 'alert:1', level: 4 },
    { id: 'wx:wind', level: 2 },
    { id: 'trail:snow', level: 1 },
  ];
  const extPreview = previewRefsForStretch(twoExtremes);
  assert.deepEqual(extPreview.shown.map(x => x.id), ['fire:1', 'alert:1']);
  assert.equal(extPreview.hiddenCount, 2);

  const nonExtreme = [{ id: 'alert:2', level: 3 }, { id: 'wx:wind', level: 2 }];
  const leadPreview = previewRefsForStretch(nonExtreme);
  assert.deepEqual(leadPreview.shown.map(x => x.id), ['alert:2']);
  assert.equal(leadPreview.hiddenCount, 1);
});

test('conditions consolidation keeps high/extreme and unmodeled stretches expanded and filters notable stretches', () => {
  assert.equal(shouldExpandConditionStretch({ regime: 'dry', level: 0 }, 4), false);
  assert.equal(shouldExpandConditionStretch({ regime: 'winter', level: 2 }, 4), false);
  assert.equal(shouldExpandConditionStretch({ regime: 'winter', level: 3 }, 4), true);
  assert.equal(shouldExpandConditionStretch({ regime: 'missing', level: 0 }, 4), true);
  assert.equal(shouldExpandConditionStretch({ regime: 'dry', level: 0 }, 1), true);

  const stretches = [
    { regime: 'dry', level: 0 },
    { regime: 'wet', level: 1 },
    { regime: 'winter', level: 3 },
    { regime: 'missing', level: 0 },
  ];
  assert.equal(filterConditionStretches(stretches, 'all').length, 4);
  assert.equal(filterConditionStretches(stretches, 'notable').length, 3);
});

test('sources consolidation puts degraded feeds ahead of healthy ones and summarizes status', () => {
  const mixed = okSources({ avalanche: { status: 'partial' }, forecast: { status: 'error' }, conditions: { status: 'skipped' } });
  const parts = partitionSources(mixed);
  assert.deepEqual(parts.attention, ['avalanche', 'forecast']);
  assert.equal(parts.healthy.includes('fire'), true);
  assert.equal(parts.healthy.includes('conditions'), true);
  assert.equal(sourceHealthSummary(mixed), '5 of 8 sources up to date, 2 need attention');
  assert.equal(sourceHealthSummary(okSources()), 'All 8 sources up to date');
});

test('offline trailMath computes progress, remaining climb, local daylight, and SOS coordinates without network', () => {
  const coords = [
    [-119.59, 37.75, 1200],
    [-119.59, 37.7645, 1400],
    [-119.59, 37.779, 1300],
    [-119.59, 37.7935, 1600],
  ];
  const cum = cumulativeMiles(coords);
  const route = { coords, cum, lengthMiles: cum[cum.length - 1], hasElevation: true, name: 'JMT' };
  const prog = computeTrailProgress(route, cum[1], { altitudeMeters: 1410 });
  assert.equal(prog.pctComplete, 33);
  assert.ok(prog.milesLeft > 1.9 && prog.milesLeft < 2.1);
  assert.equal(prog.currentElevFt, Math.round(1410 * 3.28084));
  // Remaining segment drops 100 m (328 ft) then climbs 300 m (984 ft).
  assert.ok(prog.gainAheadFt > 950 && prog.gainAheadFt < 1020);
  assert.ok(prog.lossAheadFt > 300 && prog.lossAheadFt < 360);

  const noonUtc = Date.UTC(2026, 9, 17, 19, 30); // ~12:30 PM PDT in Yosemite
  const dl = computeOfflineDaylight(noonUtc, { route, mile: cum[1] });
  assert.equal(dl.isDaylight, true);
  assert.ok(dl.remainingMin > 250 && dl.remainingMin < 400);
  assert.equal(fmtDurationMinutes(135), '2h 15m');

  assert.equal(formatCoordsDisplay(37.7489, -119.5882), '37.7489\u00b0 N, 119.5882\u00b0 W');
  assert.equal(formatCoordsCopy(37.7489, -119.5882, { mile: 42.3, routeName: 'JMT' }), '37.74890, -119.58820 (Mile 42.3 on JMT)');
});

test('corridorTilesForRoute bounds tiles along the trail corridor and prioritizes lower zooms', () => {
  const coords = Array.from({ length: 40 }, (_, i) => [-119.5 + i * 0.02, 37.5 + i * 0.02]);
  const tiles = corridorTilesForRoute(coords, { zooms: [9, 10, 11, 12], maxTiles: 30 });
  assert.equal(tiles.length, 30);
  assert.equal(tiles[0].z, 9);
  assert.ok(tiles.every((t, i) => i === 0 || t.z >= tiles[i - 1].z));
  const unique = new Set(tiles.map(t => `${t.z}/${t.x}/${t.y}`));
  assert.equal(unique.size, 30);
});

test('mobile sheet snap transitions and offlinePackSummary cover all states cleanly', () => {
  assert.equal(nextMobileSheetSnap('peek', { deltaY: -80 }), 'half');
  assert.equal(nextMobileSheetSnap('half', { deltaY: -80 }), 'full');
  assert.equal(nextMobileSheetSnap('full', { deltaY: -80 }), 'full');
  assert.equal(nextMobileSheetSnap('full', { deltaY: 80 }), 'half');
  assert.equal(nextMobileSheetSnap('half', { velocityY: 0.7 }), 'peek');
  assert.equal(nextMobileSheetSnap('half', { deltaY: 12, velocityY: 0.1 }), 'half');

  assert.match(offlinePackSummary(null, { online: true }), /Save map tiles/);
  assert.match(offlinePackSummary(null, { online: true, busy: true, progress: { phase: 'tiles', done: 12, total: 80 } }), /12\/80 tiles/);
  assert.match(offlinePackSummary({ savedAt: Date.now() - 60000, tileCount: 140 }, { online: false, result: {} }), /Offline ready, 140 map tiles/);
  assert.match(offlinePackSummary(null, { online: false, result: {} }), /Offline mode, route & last check are cached/);
});


test('theme defaults to dark, persists in localStorage, updates meta theme-color, and dispatches ridgeline-theme', () => {
  assert.equal(DEFAULT_THEME, 'dark');
  assert.equal(THEME_STORAGE_KEY, 'ridgeline-theme');
  assert.equal(THEME_COLORS.dark, '#141916');
  assert.equal(THEME_COLORS.light, '#edf0ea');

  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  let metaContent = '#141916';
  const metaEl = {
    setAttribute: (k, v) => { if (k === 'content') metaContent = v; },
  };
  const doc = {
    documentElement: { dataset: {} },
    querySelectorAll: (sel) => (sel === 'meta[name="theme-color"]' ? [metaEl] : []),
  };
  const events = [];
  const win = {
    dispatchEvent: (ev) => { events.push({ type: ev.type, detail: ev.detail }); },
  };

  assert.equal(getStoredTheme(storage), 'dark');
  assert.equal(initTheme({ storage, doc }), 'dark');
  assert.equal(doc.documentElement.dataset.theme, 'dark');
  assert.equal(metaContent, '#141916');

  assert.equal(toggleTheme({ storage, doc, win }), 'light');
  assert.equal(store.get('ridgeline-theme'), 'light');
  assert.equal(doc.documentElement.dataset.theme, 'light');
  assert.equal(metaContent, '#edf0ea');
  assert.deepEqual(events[events.length - 1], { type: 'ridgeline-theme', detail: { theme: 'light' } });

  assert.equal(toggleTheme({ storage, doc, win }), 'dark');
  assert.equal(store.get('ridgeline-theme'), 'dark');
  assert.equal(doc.documentElement.dataset.theme, 'dark');
  assert.equal(metaContent, '#141916');
  assert.deepEqual(events[events.length - 1], { type: 'ridgeline-theme', detail: { theme: 'dark' } });

  // Invalid theme values fall back safely to dark.
  assert.equal(setTheme('invalid-value', { storage, doc, win }), 'dark');
  assert.equal(getStoredTheme({ getItem: () => 'sepia' }), 'dark');
});

test('mobile 4-tab navigation transitions cover explore, briefing, map, and ontrail cleanly', () => {
  assert.deepEqual(MOBILE_TABS, ['explore', 'briefing', 'map', 'ontrail']);
  assert.equal(DEFAULT_MOBILE_TAB, 'explore');
  assert.equal(normalizeMobileTab('briefing'), 'briefing');
  assert.equal(normalizeMobileTab('unknown'), 'explore');

  assert.equal(mobileTabOnRouteOpen(), 'briefing');
  assert.equal(mobileTabOnRouteClose(), 'explore');

  const toBriefingNoRoute = transitionMobileTab('explore', 'briefing', { hasRoute: false });
  assert.equal(toBriefingNoRoute.tab, 'briefing');
  assert.equal(toBriefingNoRoute.changed, true);
  assert.equal(toBriefingNoRoute.needsRoutePrompt, true);
  assert.equal(toBriefingNoRoute.modeChange, null);
  assert.equal(toBriefingNoRoute.shouldResizeMap, false);
  assert.equal(toBriefingNoRoute.closeInspectCard, true);

  const toMap = transitionMobileTab('briefing', 'map', { hasRoute: true });
  assert.equal(toMap.tab, 'map');
  assert.equal(toMap.shouldResizeMap, true);
  assert.equal(toMap.closeInspectCard, false);
  assert.equal(toMap.modeChange, null);

  const toOnTrail = transitionMobileTab('map', 'ontrail', { hasRoute: true });
  assert.equal(toOnTrail.tab, 'ontrail');
  assert.equal(toOnTrail.modeChange, 'on-trail');
  assert.equal(toOnTrail.startGps, true);
  assert.equal(toOnTrail.closeInspectCard, true);
  assert.equal(toOnTrail.needsRoutePrompt, false);

  const toExplore = transitionMobileTab('ontrail', 'explore', { hasRoute: true });
  assert.equal(toExplore.tab, 'explore');
  assert.equal(toExplore.modeChange, null);
  assert.equal(toExplore.startGps, false);
  assert.equal(toExplore.needsRoutePrompt, false);
});
