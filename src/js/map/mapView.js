/**
 * The route map. Public calls only record state; sync functions push that
 * state into MapLibre whenever a style is ready — including after every style
 * swap (theme change, offline fallback) — so the panel never waits on the map
 * and a basemap that fails to load costs only the basemap.
 */
import { Map as MapLibreMap, Marker, NavigationControl, Popup, ScaleControl, addProtocol, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { HAZARD_TYPES, LEVELS, AQI_COLORS } from '../../../shared/levels.js';
import { MILES_PER_DEG_LAT, coordsBbox, haversineMiles, pointAtMile, projectOntoRoute, sliceByMiles } from '../../../shared/geo.js';
import { h } from '../ui/dom.js';
import { fmtElevation, fmtMile } from '../ui/format.js';
import { describeSegments } from '../panels/profile.js';
import { buildWeatherBadgeFeatures, ensureBadgeImages } from './weatherBadges.js';
import { registerNativeTileProtocol, transformNativeMapRequest } from '../native/tileStore.js';

const FIT_OVERLAYS = new Set(['fire-perimeter', 'fire-incident', 'river-gauge']);

// MapLibre 6 ships its worker as a separate module that bundlers don't follow on their own.
setWorkerUrl(workerUrl);
// On native iOS/Android, serve downloaded corridor tiles from Capacitor Filesystem.
registerNativeTileProtocol({ addProtocol });

const BASEMAPS = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const BASEMAP_OVERRIDE = import.meta.env.VITE_BASEMAP_STYLE;
const TERRAIN_SOURCE = {
  type: 'raster-dem',
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  encoding: 'terrarium',
  tileSize: 256,
  maxzoom: 15,
  attribution: 'Terrain: Mapzen, USGS',
};
const STYLE_TIMEOUT_MS = 12000;
const DESKTOP_MIN_WIDTH = 900;
const PANEL_WIDTH = 420;
const HIT_BOX_PX = 4;
const BADGE_HIT_BOX_PX = 12;
const MAX_POPUP_ITEMS = 4;
const METERS_PER_MILE = 1609.344;
const LOOP_JOIN_MILES = 0.15;
const EMPTY = { type: 'FeatureCollection', features: [] };

// Paint properties can't read CSS variables, so these mirror the neutral tokens in tokens.css.
const THEMES = {
  light: {
    casing: '#ffffff', neutral: '#66726b', ink: '#1d2622', paper: '#edf0ea', you: '#1f6fd1',
    shadow: '#3d3328', highlight: '#ffffff', relief: 0.25,
  },
  dark: {
    casing: '#000000', neutral: '#8e9891', ink: '#e8ece6', paper: '#141916', you: '#6aa8ff',
    shadow: '#000000', highlight: '#4c5750', relief: 0.28,
  },
};

const OVERLAY_TYPE = {
  'fire-perimeter': 'fire',
  'fire-incident': 'fire',
  'avalanche-zone': 'avalanche',
  'alert-area': 'alert',
  'alert-badge': 'alert',
  'weather-badge': 'weather',
  'river-gauge': 'water',
  'air-area': 'smoke',
  'air-monitor': 'smoke',
  'smoke-plume': 'smoke',
};

// Overlays that are places in their own right (a monitor, a plume) keep their own name in popups.
const OWN_TITLE = new Set(['air-area', 'air-monitor', 'smoke-plume']);

const LEVEL_COLOR = ['match', ['get', 'level'], ...LEVELS.flatMap(l => [l.level, l.color]), LEVELS[0].color];
// Air data is drawn in the official AQI colors of its own category.
const AQI_COLOR = ['match', ['coalesce', ['get', 'category'], 0], ...AQI_COLORS.flatMap((c, i) => [i, c]), AQI_COLORS[0]];
const SEGMENT_WIDTH = ['match', ['get', 'level'], 1, 4, 2, 5, 3, 6, 4, 7, 3];
const isKind = (kind) => ['==', ['get', 'overlay'], kind];
const IS_POINT = ['in', ['get', 'overlay'], ['literal', ['fire-incident', 'river-gauge', 'air-monitor']]];
const IS_ESTIMATED = ['==', ['get', 'estimatedOnly'], true];

/** Base filter of every overlay layer; hidden hazard types are and-ed onto these. */
const OVERLAY_FILTERS = {
  'rl-avy-fill': isKind('avalanche-zone'),
  'rl-avy-line': isKind('avalanche-zone'),
  'rl-alert-hit': isKind('alert-area'),
  'rl-fire-fill': isKind('fire-perimeter'),
  'rl-fire-line': isKind('fire-perimeter'),
  'rl-ring-fill': isKind('fire-incident'),
  'rl-ring-line': isKind('fire-incident'),
  'rl-points': IS_POINT,
  'rl-air-fill': isKind('air-area'),
  'rl-air-line': isKind('air-area'),
  'rl-plume-fill': isKind('smoke-plume'),
  'rl-plume-line': isKind('smoke-plume'),
};
const ROUTE_HIT_LAYERS = ['rl-route-hit', 'rl-seg-hit'];
const POINTER_LAYERS = ['rl-wx-badges', ...ROUTE_HIT_LAYERS, 'rl-points'];
const OVERLAY_HIT_LAYERS = ['rl-points', 'rl-ring-fill', 'rl-fire-fill', 'rl-avy-fill', 'rl-air-fill', 'rl-plume-fill'];
const GEOJSON_SOURCES = ['rl-route', 'rl-segments', 'rl-stretch', 'rl-overlays', 'rl-rings', 'rl-dim', 'rl-wx-badges', 'rl-position', 'rl-hover'];

const ROUND = { 'line-cap': 'round', 'line-join': 'round' };
const hitLine = (id, source) => ({
  id, source, type: 'line', layout: ROUND, paint: { 'line-color': '#000000', 'line-width': 24, 'line-opacity': 0 },
});

/**
 * Bottom to top. `belowLabels` layers sit under the basemap's first symbol
 * layer so place names stay readable over fills; the route draws above them.
 */
const layerSpecs = (t) => {
  const avyColor = ['case', ['>', ['get', 'level'], 0], LEVEL_COLOR, t.neutral];
  const belowLabels = [
    {
      // Skip Terrarium PNG fetches when zoomed out to continental scale (coarse tiles + slow cold loads).
      id: 'rl-hillshade', type: 'hillshade', source: 'rl-terrain', minzoom: 6,
      paint: {
        'hillshade-exaggeration': t.relief,
        'hillshade-shadow-color': t.shadow,
        'hillshade-highlight-color': t.highlight,
        'hillshade-accent-color': t.shadow,
      },
    },
    {
      // Satellite smoke: a grey haze that thickens with density, under everything else.
      id: 'rl-plume-fill', type: 'fill', source: 'rl-overlays', filter: OVERLAY_FILTERS['rl-plume-fill'],
      paint: {
        'fill-color': HAZARD_TYPES.smoke.color,
        'fill-opacity': ['match', ['get', 'density'], 'heavy', 0.28, 'medium', 0.16, 0.08],
      },
    },
    {
      id: 'rl-plume-line', type: 'line', source: 'rl-overlays', filter: OVERLAY_FILTERS['rl-plume-line'],
      paint: { 'line-color': HAZARD_TYPES.smoke.color, 'line-width': 1, 'line-opacity': 0.6, 'line-dasharray': [1, 2] },
    },
    {
      // Measured unhealthy air (AirNow): a wash in the severity color.
      id: 'rl-air-fill', type: 'fill', source: 'rl-overlays', filter: OVERLAY_FILTERS['rl-air-fill'],
      paint: { 'fill-color': AQI_COLOR, 'fill-opacity': 0.18 },
    },
    {
      id: 'rl-air-line', type: 'line', source: 'rl-overlays', filter: OVERLAY_FILTERS['rl-air-line'],
      paint: { 'line-color': AQI_COLOR, 'line-width': 1.2, 'line-opacity': 0.9 },
    },
    {
      id: 'rl-avy-fill', type: 'fill', source: 'rl-overlays', filter: OVERLAY_FILTERS['rl-avy-fill'],
      paint: { 'fill-color': avyColor, 'fill-opacity': ['case', ['>', ['get', 'level'], 0], 0.2, 0.08] },
    },
    {
      id: 'rl-avy-line', type: 'line', source: 'rl-overlays', filter: OVERLAY_FILTERS['rl-avy-line'],
      paint: { 'line-color': avyColor, 'line-width': 1, 'line-opacity': 0.7 },
    },
    {
      // Invisible alert-area hit layer used to list co-located alerts when tapping a weather badge;
      // zone footprints themselves appear cleanly via rl-overlay-hl-fill/hl when previewed or selected.
      id: 'rl-alert-hit', type: 'fill', source: 'rl-overlays', filter: OVERLAY_FILTERS['rl-alert-hit'],
      paint: { 'fill-color': LEVEL_COLOR, 'fill-opacity': 0 },
    },
    {
      id: 'rl-fire-fill', type: 'fill', source: 'rl-overlays', filter: OVERLAY_FILTERS['rl-fire-fill'],
      paint: { 'fill-color': HAZARD_TYPES.fire.color, 'fill-opacity': 0.22 },
    },
    {
      id: 'rl-fire-line', type: 'line', source: 'rl-overlays', filter: OVERLAY_FILTERS['rl-fire-line'],
      paint: { 'line-color': HAZARD_TYPES.fire.color, 'line-width': 1.5 },
    },
    {
      id: 'rl-ring-fill', type: 'fill', source: 'rl-rings', filter: OVERLAY_FILTERS['rl-ring-fill'],
      paint: { 'fill-color': HAZARD_TYPES.fire.color, 'fill-opacity': 0.05 },
    },
    {
      id: 'rl-ring-line', type: 'line', source: 'rl-rings', filter: OVERLAY_FILTERS['rl-ring-line'],
      paint: { 'line-color': HAZARD_TYPES.fire.color, 'line-width': 1.5, 'line-dasharray': [2, 2] },
    },
    {
      id: 'rl-overlay-hl-fill', type: 'fill', source: 'rl-overlays', layout: { visibility: 'none' },
      paint: { 'fill-color': LEVEL_COLOR, 'fill-opacity': 0.18 },
    },
    {
      id: 'rl-overlay-hl', type: 'line', source: 'rl-overlays', layout: { visibility: 'none' },
      paint: { 'line-color': t.ink, 'line-width': 2.5 },
    },
  ];
  const aboveLabels = [
    { id: 'rl-route-casing', type: 'line', source: 'rl-route', layout: ROUND, paint: { 'line-color': t.casing, 'line-width': 6 } },
    {
      id: 'rl-stretch-hl', type: 'line', source: 'rl-stretch', layout: ROUND,
      paint: { 'line-color': t.you, 'line-width': 13, 'line-opacity': 0.35 },
    },
    {
      id: 'rl-seg-halo', type: 'line', source: 'rl-segments', layout: { ...ROUND, visibility: 'none' },
      paint: { 'line-color': t.ink, 'line-width': ['+', SEGMENT_WIDTH, 8], 'line-opacity': 0.9 },
    },
    {
      id: 'rl-seg-casing', type: 'line', source: 'rl-segments', layout: ROUND,
      paint: { 'line-color': t.casing, 'line-width': ['+', SEGMENT_WIDTH, 3] },
    },
    { id: 'rl-route-base', type: 'line', source: 'rl-route', layout: ROUND, paint: { 'line-color': t.neutral, 'line-width': 3 } },
    {
      id: 'rl-seg-solid', type: 'line', source: 'rl-segments', layout: ROUND, filter: ['!', IS_ESTIMATED],
      paint: { 'line-color': ['case', ['get', 'unchecked'], t.neutral, ['get', 'color']], 'line-width': SEGMENT_WIDTH },
    },
    {
      id: 'rl-seg-dashed', type: 'line', source: 'rl-segments', layout: { 'line-cap': 'butt', 'line-join': 'round' },
      filter: IS_ESTIMATED,
      paint: { 'line-color': ['get', 'color'], 'line-width': SEGMENT_WIDTH, 'line-dasharray': [1.5, 1.2] },
    },
    {
      id: 'rl-dim', type: 'line', source: 'rl-dim', layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': t.paper, 'line-width': 16, 'line-opacity': 0.7 },
    },
    {
      id: 'rl-points-hl', type: 'circle', source: 'rl-overlays', layout: { visibility: 'none' },
      paint: { 'circle-radius': 11, 'circle-opacity': 0, 'circle-stroke-color': t.ink, 'circle-stroke-width': 2.5 },
    },
    {
      id: 'rl-points', type: 'circle', source: 'rl-overlays', filter: OVERLAY_FILTERS['rl-points'],
      paint: {
        'circle-radius': ['match', ['get', 'overlay'], 'air-monitor', 5, 6],
        'circle-color': ['match', ['get', 'overlay'],
          'river-gauge', HAZARD_TYPES.water.color,
          'air-monitor', AQI_COLOR,
          HAZARD_TYPES.fire.color],
        'circle-stroke-color': t.casing,
        'circle-stroke-width': 2,
      },
    },
    {
      // Solid SVG badges for NWS alerts and forecast hazards; MapLibre declutters by severity.
      id: 'rl-wx-badges', type: 'symbol', source: 'rl-wx-badges',
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.85, 8, 0.95, 12, 1.05],
        'icon-allow-overlap': false,
        'icon-padding': 4,
        'symbol-sort-key': ['get', 'sortKey'],
      },
    },
    {
      id: 'rl-position-accuracy', type: 'fill', source: 'rl-position', filter: ['==', ['get', 'kind'], 'accuracy'],
      paint: { 'fill-color': t.you, 'fill-opacity': 0.12, 'fill-outline-color': t.you },
    },
    {
      // Live fixes are a solid dot; stale or hand-placed ones are hollow and grey.
      id: 'rl-position-dot', type: 'circle', source: 'rl-position', filter: ['==', ['get', 'kind'], 'dot'],
      paint: {
        'circle-radius': 7,
        'circle-color': t.you,
        'circle-opacity': ['case', ['get', 'live'], 1, 0],
        'circle-stroke-color': ['case', ['get', 'live'], t.casing, t.neutral],
        'circle-stroke-width': ['case', ['get', 'live'], 2.5, 3],
      },
    },
    {
      id: 'rl-hover', type: 'circle', source: 'rl-hover',
      paint: { 'circle-radius': 6, 'circle-color': t.ink, 'circle-stroke-color': t.casing, 'circle-stroke-width': 2 },
    },
    hitLine('rl-route-hit', 'rl-route'),
    hitLine('rl-seg-hit', 'rl-segments'),
  ];
  return { belowLabels, aboveLabels };
};

const blankStyle = (t) => ({
  version: 8,
  sources: {},
  layers: [{ id: 'rl-background', type: 'background', paint: { 'background-color': t.paper } }],
});

const fc = (features) => ({ type: 'FeatureCollection', features });
const flat = (coords) => coords.map(c => [c[0], c[1]]);
const lineFeature = (coords, properties = {}) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties });
const pointFeature = (lng, lat, properties = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties });

/** 48-gon approximating a circle on the ground; fine at trail scales. */
const circlePolygon = (lng, lat, radiusMiles, steps = 48) => {
  const dy = radiusMiles / MILES_PER_DEG_LAT;
  const dx = dy / Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const ring = [];
  for (let k = 0; k < steps; k++) {
    const a = (k / steps) * 2 * Math.PI;
    ring.push([lng + dx * Math.cos(a), lat + dy * Math.sin(a)]);
  }
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
};

const incidentRings = (overlays) => fc(overlays.features
  .filter(f => f.properties?.overlay === 'fire-incident' && f.properties.radiusMiles > 0)
  .map(f => ({
    type: 'Feature',
    geometry: circlePolygon(f.geometry.coordinates[0], f.geometry.coordinates[1], f.properties.radiusMiles),
    properties: { overlay: 'fire-incident', hazardId: f.properties.hazardId, level: f.properties.level, title: f.properties.title },
  })));

/** The route outside the On trail window, drawn under a wash so the window stands out. */
const outsideWindow = (route, win) => {
  if (!win) return EMPTY;
  const parts = [];
  if (win.start > 0) parts.push(sliceByMiles(route.coords, route.cum, 0, win.start));
  if (win.end < route.lengthMiles) parts.push(sliceByMiles(route.coords, route.cum, win.end, route.lengthMiles));
  return fc(parts.map(p => lineFeature(flat(p))));
};

const positionData = (gps) => {
  const fix = gps?.fix;
  if (!fix || gps.state === 'off' || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return EMPTY;
  const live = gps.state === 'live';
  const features = [];
  if (live && fix.accuracyMeters > 0) {
    features.push({ type: 'Feature', geometry: circlePolygon(fix.lng, fix.lat, fix.accuracyMeters / METERS_PER_MILE), properties: { kind: 'accuracy' } });
  }
  features.push(pointFeature(fix.lng, fix.lat, { kind: 'dot', live }));
  return fc(features);
};

/** Distinct hazards under a click, most severe first. */
const popupItems = (features, hazards = {}) => {
  const seen = new Set();
  const items = [];
  for (const { properties: p } of features) {
    const own = OWN_TITLE.has(p.overlay);
    const key = own || !p.hazardId ? `${p.overlay}:${p.title}` : p.hazardId;
    if (seen.has(key)) continue;
    seen.add(key);
    const hazard = p.hazardId ? hazards[p.hazardId] : null;
    items.push({
      hazardId: hazard ? p.hazardId : null,
      title: (own ? p.title : hazard?.title || p.title) || 'Unnamed area',
      level: Number(p.level) || 0,
      type: OVERLAY_TYPE[p.overlay],
      overlay: p.overlay,
      levelLabel: p.levelLabel || null,
      category: Number(p.category) || null,
    });
  }
  return items.sort((a, b) => b.level - a.level).slice(0, MAX_POPUP_ITEMS);
};

const levelText = (item) => {
  if (item.levelLabel) return item.levelLabel;
  if (item.level > 0) return LEVELS[item.level].label;
  if (item.overlay === 'air-monitor') return 'Good or moderate air';
  if (item.overlay === 'smoke-plume') return 'Map context only';
  return item.type === 'avalanche' ? 'Not rated right now' : 'No rating';
};

const legendSwatch = (color, extraClass = '') =>
  h('span', { class: `rl-legend__swatch${extraClass ? ` ${extraClass}` : ''}`, style: color ? `--swatch:${color};background:${color}` : null, 'aria-hidden': 'true' });

const buildLegend = () => h('div', { class: 'rl-legend', role: 'region', 'aria-label': 'Map key', hidden: true },
  h('p', { class: 'rl-legend__heading' }, 'Route severity'),
  h('ul', { class: 'rl-legend__list' },
    LEVELS.map(l => h('li', { class: 'rl-legend__row' }, legendSwatch(l.color), h('span', {}, l.short))),
    h('li', { class: 'rl-legend__row' }, legendSwatch(null, 'rl-legend__swatch--unchecked'), h('span', {}, 'Not checked')),
  ),
  h('p', { class: 'rl-legend__heading' }, 'Line & overlays'),
  h('ul', { class: 'rl-legend__list' },
    h('li', { class: 'rl-legend__row' }, h('span', { class: 'rl-legend__line rl-legend__line--solid', 'aria-hidden': 'true' }), h('span', {}, 'Official data')),
    h('li', { class: 'rl-legend__row' }, h('span', { class: 'rl-legend__line rl-legend__line--dashed', 'aria-hidden': 'true' }), h('span', {}, 'Estimated trail condition')),
    h('li', { class: 'rl-legend__row' }, legendSwatch(HAZARD_TYPES.fire.color, 'rl-legend__swatch--area'), h('span', {}, 'Active fire perimeter / origin')),
    h('li', { class: 'rl-legend__row' }, legendSwatch(HAZARD_TYPES.alert.color, 'rl-legend__swatch--badge'), h('span', {}, 'Weather & alert badges')),
  ));

const unavailableView = (container) => {
  container.append(h('p', { class: 'rl-map-unavailable' },
    "This browser can't draw the map — it needs WebGL 2. Everything else works without it."));
  const noop = () => {};
  return {
    setRoute: noop, setAnalysis: noop, setFilters: noop, setPosition: noop, highlightMile: noop,
    highlightHazard: noop, highlightStretch: noop, fitRange: noop, fitRoute: noop, centerOnPosition: noop,
    setBottomInset: noop, setPickMode: noop, setTheme: noop, clearPreview: noop, resize: noop,
  };
};

export const createMapView = (container, { theme: initialTheme, onSegmentClick, onOverlayClick, onHazardTap, onMileHover, onPickPosition } = {}) => {
  let map;
  try {
    map = new MapLibreMap({
      container,
      center: [-98.6, 39.8],
      zoom: 3,
      maxZoom: 17,
      fadeDuration: 150,
      dragRotate: false,
      touchPitch: false,
      transformRequest: transformNativeMapRequest,
      locale: { 'Map.Title': 'Map of route and hazards' },
    });
  } catch (err) {
    console.warn('[map]', err);
    return unavailableView(container);
  }
  container.classList.add('rl-map');
  // North-up only: a rotated map is easy to misread against a paper map or compass.
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new ScaleControl({ unit: 'imperial' }), 'bottom-right');

  const state = { route: null, result: null, hidden: new Set(), gps: null, hoverMile: null, hazardId: null, stretch: null };
  const resolveTheme = (value) => (value === 'light' ? 'light' : 'dark');
  let themeKey = initialTheme === 'light' || initialTheme === 'dark'
    ? initialTheme
    : resolveTheme(document.documentElement?.dataset?.theme);
  let theme = THEMES[themeKey];
  let ready = false;
  let usingBlankStyle = false;
  let styleTimer = 0;
  let pendingCamera = null;
  let pickMode = false;
  let popup = null;
  let previewHazardId = null;
  let badgeSeq = 0;
  let windowMarker = null;
  let startMarker = null;
  let endMarker = null;
  let bottomInset = 0;
  let hoverFrame = 0;
  let moveFrame = 0;
  let lastMove = null;
  let emittedMile;

  let routeData = EMPTY;
  let segmentGeometry = [];
  let overlayData = EMPTY;
  let ringData = EMPTY;
  let dimData = EMPTY;

  // On-map toolbar: Fit route, Map key (legend), and live hover readout pill.
  const fitBtn = h('button', {
    type: 'button',
    class: 'rl-map-btn',
    title: 'Fit full route in view',
    onclick: () => {
      if (state.route) fitBbox(state.route.bbox);
    },
  }, 'Fit route');
  const legendEl = buildLegend();
  const keyBtn = h('button', {
    type: 'button',
    class: 'rl-map-btn',
    'aria-expanded': 'false',
    onclick: () => {
      const open = legendEl.hidden;
      legendEl.hidden = !open;
      keyBtn.setAttribute('aria-expanded', String(open));
    },
  }, 'Map key');
  const locateBtn = h('button', {
    type: 'button',
    class: 'rl-map-btn rl-map-btn--locate',
    title: 'Center on my GPS position',
    hidden: true,
    onclick: () => centerOnPosition(),
  }, 'My location');
  const hoverPill = h('div', { class: 'rl-hover-pill', hidden: true, 'aria-hidden': 'true' });
  const toolsEl = h('div', { class: 'rl-map-tools', hidden: true },
    h('div', { class: 'rl-map-tools__row' }, fitBtn, locateBtn, keyBtn, hoverPill),
    legendEl);
  container.append(toolsEl);

  const setData = (id, data) => {
    if (ready) map.getSource(id)?.setData(data);
  };

  const segmentData = () => {
    const { result } = state;
    if (!result || !segmentGeometry.length) return EMPTY;
    const views = describeSegments(result, state.hidden);
    return fc(segmentGeometry.map((coords, i) => lineFeature(coords, {
      i,
      level: views[i].level,
      color: LEVELS[views[i].level].color,
      estimatedOnly: views[i].estimatedOnly,
      unchecked: views[i].unchecked.length > 0,
      // Wrapped in commas so a substring test can't match one id inside another.
      refIds: `,${result.segments[i].refs.map(r => r.id).join(',')},`,
    })));
  };

  const syncFilters = () => {
    if (!ready) return;
    const hiddenKinds = Object.keys(OVERLAY_TYPE).filter(kind => state.hidden.has(OVERLAY_TYPE[kind]));
    const visible = ['!', ['in', ['get', 'overlay'], ['literal', hiddenKinds]]];
    for (const [id, base] of Object.entries(OVERLAY_FILTERS)) {
      map.setFilter(id, hiddenKinds.length ? ['all', base, visible] : base);
    }
  };

  const syncBadges = () => {
    if (!ready) return;
    const seq = ++badgeSeq;
    const features = buildWeatherBadgeFeatures(state.route, state.result, state.hidden, themeKey);
    if (!features.length) {
      setData('rl-wx-badges', EMPTY);
      return;
    }
    ensureBadgeImages(map, features, themeKey).then(() => {
      if (seq !== badgeSeq || !ready) return;
      setData('rl-wx-badges', fc(features));
    });
  };

  /** Filters recolor segments and hide overlays without re-slicing any geometry. */
  const applyFilters = () => {
    setData('rl-segments', segmentData());
    syncFilters();
    syncBadges();
  };

  const syncHighlight = () => {
    if (!ready) return;
    const id = state.hazardId || previewHazardId;
    const layers = ['rl-seg-halo', 'rl-overlay-hl-fill', 'rl-overlay-hl', 'rl-points-hl'];
    for (const layer of layers) map.setLayoutProperty(layer, 'visibility', id ? 'visible' : 'none');
    if (!id) return;
    const isHazard = ['==', ['get', 'hazardId'], id];
    map.setFilter('rl-seg-halo', ['in', `,${id},`, ['get', 'refIds']]);
    map.setFilter('rl-overlay-hl-fill', ['all', isKind('alert-area'), isHazard]);
    map.setFilter('rl-overlay-hl', isHazard);
    map.setFilter('rl-points-hl', ['all', IS_POINT, isHazard]);
  };

  const syncHover = () => {
    const { route, hoverMile } = state;
    if (!route || hoverMile == null) {
      setData('rl-hover', EMPTY);
      hoverPill.hidden = true;
      return;
    }
    const pt = pointAtMile(route.coords, route.cum, hoverMile);
    setData('rl-hover', fc([pointFeature(pt[0], pt[1])]));
    const parts = [`Mi ${fmtMile(hoverMile)}`];
    if (route.hasElevation && Number.isFinite(pt[2])) parts.push(fmtElevation(pt[2]));
    hoverPill.textContent = parts.join(', ');
    hoverPill.hidden = false;
  };

  const syncStretch = () => {
    const { route, stretch } = state;
    if (!route || !stretch) {
      setData('rl-stretch', EMPTY);
      return;
    }
    const a = Math.min(stretch.mileStart, stretch.mileEnd);
    const b = Math.max(stretch.mileStart, stretch.mileEnd);
    const coords = flat(sliceByMiles(route.coords, route.cum, a, b));
    setData('rl-stretch', coords.length >= 2 ? fc([lineFeature(coords)]) : EMPTY);
  };

  const syncEndpoints = () => {
    startMarker?.remove();
    endMarker?.remove();
    startMarker = null;
    endMarker = null;
    const { route } = state;
    toolsEl.hidden = !route;
    if (!route || !route.coords.length) return;
    const first = route.coords[0];
    const last = route.coords[route.coords.length - 1];
    const isLoop = route.lengthMiles > LOOP_JOIN_MILES && haversineMiles(first, last) <= LOOP_JOIN_MILES;
    const startEl = h('div', { class: 'rl-endpoint rl-endpoint--start', 'aria-hidden': 'true' },
      isLoop ? `Start / End, Mi ${fmtMile(route.lengthMiles)}` : 'Start');
    startMarker = new Marker({ element: startEl, anchor: 'bottom', offset: [0, -5] })
      .setLngLat([first[0], first[1]])
      .addTo(map);
    if (!isLoop && route.lengthMiles > 0) {
      const endEl = h('div', { class: 'rl-endpoint rl-endpoint--end', 'aria-hidden': 'true' },
        `End, Mi ${fmtMile(route.lengthMiles)}`);
      endMarker = new Marker({ element: endEl, anchor: 'top', offset: [0, 5] })
        .setLngLat([last[0], last[1]])
        .addTo(map);
    }
  };

  const syncAnalysis = () => {
    setData('rl-segments', segmentData());
    setData('rl-overlays', overlayData);
    setData('rl-rings', ringData);
    setData('rl-dim', dimData);
    syncBadges();
  };

  const syncAll = () => {
    setData('rl-route', routeData);
    syncAnalysis();
    syncFilters();
    syncHighlight();
    syncStretch();
    setData('rl-position', positionData(state.gps));
    syncHover();
  };

  const syncWindowMarker = () => {
    const win = state.result?.window;
    if (!win || !state.route) {
      windowMarker?.remove();
      windowMarker = null;
      return;
    }
    const [lng, lat] = pointAtMile(state.route.coords, state.route.cum, win.end);
    if (!windowMarker) {
      const element = h('div', { class: 'rl-window-marker', 'aria-hidden': 'true' });
      windowMarker = new Marker({ element, anchor: 'bottom', offset: [0, -6] }).setLngLat([lng, lat]).addTo(map);
    }
    windowMarker.getElement().textContent = `Mi ${fmtMile(win.end)}`;
    windowMarker.setLngLat([lng, lat]);
  };

  const closePopup = () => {
    const p = popup;
    popup = null;
    p?.remove();
    if (previewHazardId) {
      previewHazardId = null;
      syncHighlight();
    }
  };

  const popupContent = (items) => h('div', { class: 'rl-pop' }, items.map(item => h('section', { class: 'rl-pop__item' },
    h('p', { class: 'rl-pop__title' }, item.title),
    h('p', { class: 'rl-pop__meta' },
      h('span', {
        class: item.level || item.category ? 'rl-pop__swatch' : 'rl-pop__swatch rl-pop__swatch--unrated',
        // Air data shows its own AQI color, like the map.
        style: item.category ? { background: AQI_COLORS[item.category] } : item.level ? { background: LEVELS[item.level].color } : null,
        'aria-hidden': 'true',
      }),
      [levelText(item), HAZARD_TYPES[item.type]?.label].filter(Boolean).join(', ')),
    item.hazardId && h('button', {
      type: 'button',
      class: 'rl-pop__button',
      'aria-label': `Show details for ${item.title}`,
      onclick: () => {
        closePopup();
        onOverlayClick?.(item.hazardId);
      },
    }, 'Show details'),
  )));

  const showPopup = (lngLat, features, { previewId = null } = {}) => {
    closePopup();
    const items = popupItems(features, state.result?.hazards);
    if (!items.length) return;
    if (previewId) {
      previewHazardId = previewId;
      syncHighlight();
    }
    const nextPopup = new Popup({ className: 'rl-popup', maxWidth: '280px', closeOnClick: false })
      .setLngLat(lngLat)
      .setDOMContent(popupContent(items))
      .addTo(map);
    popup = nextPopup;
    nextPopup.on('close', () => {
      if (popup === nextPopup) popup = null;
      if (previewHazardId) {
        previewHazardId = null;
        syncHighlight();
      }
    });
    nextPopup.getElement().addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      closePopup();
      map.getCanvas().focus();
    });
  };

  const rebuildAnalysis = () => {
    const { route, result } = state;
    const usable = route && result;
    segmentGeometry = usable
      ? result.segments.map(s => flat(sliceByMiles(route.coords, route.cum, s.mileStart, s.mileEnd)))
      : [];
    overlayData = usable && result.overlays?.features ? result.overlays : EMPTY;
    ringData = usable ? incidentRings(overlayData) : EMPTY;
    dimData = usable ? outsideWindow(route, result.window) : EMPTY;
    closePopup();
    syncWindowMarker();
    syncAnalysis();
    syncFilters();
    syncHighlight();
  };

  // Camera moves wait for a ready style so they never run against a zero-size or half-built map.
  const camera = (move) => {
    if (ready) move(); else pendingCamera = move;
  };

  const fitPadding = () => {
    const { clientWidth: w, clientHeight: hgt } = map.getContainer();
    const docked = window.innerWidth >= DESKTOP_MIN_WIDTH;
    const edge = Math.max(0, Math.min(docked ? 40 : 20, (Math.min(w, hgt) - 80) / 2));
    // Desktop docks a 420px panel on the left; mobile docks a bottom sheet below.
    const left = docked ? Math.max(edge, Math.min(PANEL_WIDTH + 40, w - edge - 160)) : edge;
    const top = docked ? edge : Math.min(68, Math.max(edge, hgt - 180));
    const bottom = docked ? edge : Math.min(Math.max(edge, bottomInset + 16), Math.max(edge, hgt - top - 110));
    return { top, right: edge, bottom, left };
  };

  const centerOnPosition = () => {
    const fix = state.gps?.fix;
    if (!fix || state.gps.state === 'off' || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return;
    camera(() => map.easeTo({
      center: [fix.lng, fix.lat],
      zoom: Math.max(map.getZoom(), 13),
      padding: fitPadding(),
      duration: 500,
    }));
  };

  const fitBbox = (bbox, { immediate = false } = {}) => camera(() => map.fitBounds(
    [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
    { padding: fitPadding(), maxZoom: 14, duration: immediate ? 0 : 700 },
  ));

  const ensureLayers = () => {
    if (!map.getSource('rl-terrain')) map.addSource('rl-terrain', TERRAIN_SOURCE);
    for (const id of GEOJSON_SOURCES) {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY });
    }
    const order = map.getLayersOrder();
    const firstLabel = order.find(id => map.getLayer(id)?.type === 'symbol');
    const underWater = map.getLayer('water') ? 'water' : firstLabel;
    const { belowLabels, aboveLabels } = layerSpecs(theme);
    for (const spec of belowLabels) {
      if (!map.getLayer(spec.id)) map.addLayer(spec, spec.id === 'rl-hillshade' ? underWater : firstLabel);
    }
    for (const spec of aboveLabels) if (!map.getLayer(spec.id)) map.addLayer(spec);
  };

  const loadStyle = () => {
    theme = THEMES[themeKey];
    ready = false;
    clearTimeout(styleTimer);
    if (usingBlankStyle) {
      map.setStyle(blankStyle(theme), { diff: false });
      return;
    }
    map.setStyle(BASEMAP_OVERRIDE || (themeKey === 'light' ? BASEMAPS.light : BASEMAPS.dark), { diff: false });
    styleTimer = setTimeout(useBlankStyle, STYLE_TIMEOUT_MS);
  };

  // Offline or blocked basemap: draw the route and hazards on a plain background instead of nothing.
  const useBlankStyle = () => {
    if (ready || usingBlankStyle) return;
    usingBlankStyle = true;
    loadStyle();
  };

  map.on('style.load', () => {
    clearTimeout(styleTimer);
    ready = true;
    ensureLayers();
    syncAll();
    if (pendingCamera) {
      const move = pendingCamera;
      pendingCamera = null;
      move();
    }
  });

  map.on('error', (event) => {
    // A failed tile (terrain, one basemap tile) is not a failed style; only
    // give up on the basemap when the style itself can't load.
    if (!ready && !event.sourceId && !event.tile) useBlankStyle();
    if (import.meta.env.DEV) console.warn('[map]', event.error?.message || event);
  });

  // The basemap style references a few icons its sprite doesn't ship; a
  // transparent stand-in keeps the console quiet and the label layout intact.
  map.on('styleimagemissing', ({ id }) => {
    if (id.startsWith('rl-wx:')) return;
    if (!map.hasImage(id)) map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
  });

  window.addEventListener('online', () => {
    if (!usingBlankStyle) return;
    usingBlankStyle = false;
    loadStyle();
  });

  const scheduleHover = () => {
    if (!hoverFrame) {
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        syncHover();
      });
    }
  };

  const emitHover = (mile) => {
    if (mile === emittedMile) return;
    emittedMile = mile;
    state.hoverMile = mile;
    scheduleHover();
    onMileHover?.(mile);
  };

  const hitBox = ({ x, y }, pad = HIT_BOX_PX) => [[x - pad, y - pad], [x + pad, y + pad]];

  const handleMove = () => {
    moveFrame = 0;
    const { route } = state;
    if (!ready || !lastMove || !route) return;
    const features = map.queryRenderedFeatures(hitBox(lastMove.point), { layers: POINTER_LAYERS });
    if (!pickMode) map.getCanvas().style.cursor = features.length ? 'pointer' : '';
    const onBadge = features.some(f => f.layer.id === 'rl-wx-badges');
    const onRoute = !onBadge && features.some(f => ROUTE_HIT_LAYERS.includes(f.layer.id));
    const { lng, lat } = lastMove.lngLat;
    emitHover(onRoute ? projectOntoRoute(route.coords, route.cum, lng, lat, state.hoverMile).mile : null);
  };

  map.on('mousemove', (event) => {
    lastMove = event;
    if (!moveFrame) moveFrame = requestAnimationFrame(handleMove);
  });

  map.on('mouseout', () => {
    cancelAnimationFrame(moveFrame);
    moveFrame = 0;
    lastMove = null;
    if (!pickMode) map.getCanvas().style.cursor = '';
    emitHover(null);
  });

  map.on('click', (event) => {
    if (pickMode) {
      setPickMode(false);
      onPickPosition?.({ lat: event.lngLat.lat, lng: event.lngLat.lng });
      return;
    }
    if (!ready) return;
    const mobileTap = window.innerWidth < DESKTOP_MIN_WIDTH && typeof onHazardTap === 'function';
    const box = hitBox(event.point);
    const badges = map.queryRenderedFeatures(hitBox(event.point, BADGE_HIT_BOX_PX), { layers: ['rl-wx-badges'] });
    if (badges.length) {
      const alertsAtSpot = map.queryRenderedFeatures(box, { layers: ['rl-alert-hit'] });
      if (mobileTap) {
        closePopup();
        const items = popupItems([...badges, ...alertsAtSpot], state.result?.hazards);
        if (items.length) {
          previewHazardId = badges[0].properties.hazardId || items[0].hazardId || null;
          syncHighlight();
          onHazardTap({
            kind: 'hazard',
            items,
            primary: items[0],
            hazard: items[0].hazardId ? state.result?.hazards?.[items[0].hazardId] || null : null,
            lngLat: event.lngLat,
          });
        }
        return;
      }
      showPopup(event.lngLat, [...badges, ...alertsAtSpot], { previewId: badges[0].properties.hazardId || null });
      return;
    }
    const segment = map.queryRenderedFeatures(box, { layers: ['rl-seg-hit'] })[0];
    let seg = segment && state.result?.segments[segment.properties.i];
    const clickHit = state.route ? projectOntoRoute(state.route.coords, state.route.cum, event.lngLat.lng, event.lngLat.lat) : null;
    if (!seg && state.result?.segments?.length && clickHit && map.queryRenderedFeatures(box, { layers: ['rl-route-hit'] }).length) {
      seg = state.result.segments.find(s => s.mileStart <= clickHit.mile && clickHit.mile <= s.mileEnd) ?? null;
    }
    if (seg) {
      closePopup();
      const clickMile = clickHit && clickHit.mile >= seg.mileStart && clickHit.mile <= seg.mileEnd
        ? clickHit.mile
        : (seg.mileStart + seg.mileEnd) / 2;
      if (mobileTap) {
        const visibleRefs = (seg.refs || [])
          .filter(r => !state.hidden.has(state.result?.hazards?.[r.id]?.type))
          .sort((a, b) => b.level - a.level);
        const topRef = visibleRefs[0] || null;
        const topHazard = topRef ? state.result?.hazards?.[topRef.id] || null : null;
        previewHazardId = topHazard?.id || null;
        syncHighlight();
        onHazardTap({
          kind: 'segment',
          segment: seg,
          clickMile,
          hazard: topHazard,
          primary: topHazard
            ? { hazardId: topHazard.id, title: topHazard.title, level: topHazard.level, type: topHazard.type, levelLabel: topHazard.levelLabel || null }
            : null,
          lngLat: event.lngLat,
        });
        return;
      }
      onSegmentClick?.(seg.mileStart, seg.mileEnd, seg.refs, clickMile);
      return;
    }
    const overlays = map.queryRenderedFeatures(box, { layers: OVERLAY_HIT_LAYERS });
    if (overlays.length) {
      if (mobileTap) {
        closePopup();
        const items = popupItems(overlays, state.result?.hazards);
        if (items.length) {
          previewHazardId = items[0].hazardId || null;
          syncHighlight();
          onHazardTap({
            kind: 'hazard',
            items,
            primary: items[0],
            hazard: items[0].hazardId ? state.result?.hazards?.[items[0].hazardId] || null : null,
            lngLat: event.lngLat,
          });
        }
        return;
      }
      showPopup(event.lngLat, overlays);
    } else {
      closePopup();
      if (mobileTap) onHazardTap(null);
    }
  });

  const setPickMode = (on) => {
    pickMode = !!on;
    container.classList.toggle('rl-map--picking', pickMode);
    map.getCanvas().style.cursor = '';
    if (pickMode) closePopup();
  };

  loadStyle();
  // Dev-only handle for poking at the map from the console; stripped from production builds.
  if (import.meta.env.DEV) window.__ridgelineMap = map;

  return {
    setRoute(next) {
      const route = next || null;
      if (route?.id === state.route?.id) return;
      const hadRoute = Boolean(state.route);
      state.route = route;
      state.hoverMile = null;
      state.stretch = null;
      // A stored result belongs to the route it was computed for.
      if (state.result?.routeHash !== route?.id) state.result = null;
      routeData = route ? fc([lineFeature(flat(route.coords))]) : EMPTY;
      setData('rl-route', routeData);
      syncEndpoints();
      syncHover();
      syncStretch();
      rebuildAnalysis();
      if (route) fitBbox(route.bbox, { immediate: !hadRoute });
    },

    setAnalysis(result, { hiddenTypes } = {}) {
      const next = result || null;
      if (hiddenTypes) state.hidden = hiddenTypes;
      if (next === state.result) {
        applyFilters();
        return;
      }
      state.result = next;
      rebuildAnalysis();
    },

    setFilters(hiddenTypes) {
      state.hidden = hiddenTypes || new Set();
      applyFilters();
    },

    setPosition(gps) {
      state.gps = gps || null;
      const hasFix = Boolean(gps?.fix && gps.state !== 'off' && Number.isFinite(gps.fix.lat) && Number.isFinite(gps.fix.lng));
      locateBtn.hidden = !hasFix;
      setData('rl-position', positionData(state.gps));
    },

    highlightMile(mile) {
      state.hoverMile = Number.isFinite(mile) ? mile : null;
      scheduleHover();
    },

    highlightHazard(hazardId) {
      state.hazardId = hazardId || null;
      syncHighlight();
    },

    highlightStretch(range) {
      state.stretch = range && Number.isFinite(range.mileStart) && Number.isFinite(range.mileEnd)
        ? { mileStart: range.mileStart, mileEnd: range.mileEnd }
        : null;
      syncStretch();
    },

    /** Fit part of the route; with a hazard id, also bring a nearby fire or gauge into view. */
    fitRange(mileStart, mileEnd, hazardId = null) {
      const { route } = state;
      if (!route) return;
      const a = Math.min(mileStart, mileEnd);
      const b = Math.max(mileStart, mileEnd);
      const box = coordsBbox(sliceByMiles(route.coords, route.cum, a, b));
      // Only compact overlays: alert and avalanche zones can span half a state.
      for (const f of state.result?.overlays?.features || []) {
        const p = f.properties;
        if (p.hazardId !== hazardId || !FIT_OVERLAYS.has(p.overlay)) continue;
        const pad = p.radiusMiles ? p.radiusMiles / MILES_PER_DEG_LAT : 0;
        const fb = coordsBbox(f.geometry.type === 'Point' ? [f.geometry.coordinates]
          : (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).flatMap(poly => poly[0]));
        box[0] = Math.min(box[0], fb[0] - pad); box[1] = Math.min(box[1], fb[1] - pad);
        box[2] = Math.max(box[2], fb[2] + pad); box[3] = Math.max(box[3], fb[3] + pad);
      }
      fitBbox(box);
    },

    fitRoute() {
      if (state.route) fitBbox(state.route.bbox);
    },

    centerOnPosition,

    setBottomInset(px) {
      bottomInset = Number.isFinite(px) && px > 0 ? px : 0;
    },

    setPickMode,

    setTheme(nextTheme) {
      const next = resolveTheme(nextTheme);
      if (next === themeKey) return;
      themeKey = next;
      theme = THEMES[themeKey];
      loadStyle();
    },

    clearPreview() {
      if (!previewHazardId) return;
      previewHazardId = null;
      syncHighlight();
    },

    resize() {
      map.resize();
    },
  };
};
