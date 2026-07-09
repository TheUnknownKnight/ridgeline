import 'maplibre-gl/dist/maplibre-gl.css';
import { setupImporter } from './gpx/importer.js';
import { analyzeRoute } from './api/client.js';
import { renderRouteProfile } from './panels/routeProfile.js';
import { renderSegments, renderSummary, renderDiff, updateSyncStatus } from './panels/sidebar.js';
import { setupFilterPills } from './panels/filterPills.js';
import { initMap, setRoute, setHazardSegments, getLocationState, clearLocationState, setWindowBoundary, clearWindowBoundary } from './map/mapManager.js';

let map;
let mapReady = false;
let pendingRoute = null;
let currentRouteGeoJson = null;
let currentRouteId = null;
let isOnTrailMode = false;
let currentActiveFilters = null;
let latestResult = null; // Store latest result to re-render when filters change

const onMapReady = () => {
  mapReady = true;
  if (pendingRoute) {
    setRoute(map, pendingRoute);
    pendingRoute = null;
  }
};

const runAnalysis = async () => {
  if (!currentRouteGeoJson) return;

  document.getElementById('loading-indicator').classList.remove('hidden');
  document.getElementById('results-container').classList.add('hidden');
  document.getElementById('import-zone').classList.add('hidden');

  let locState = null;
  const gpsNotice = document.getElementById('gps-fallback-notice');
  if (isOnTrailMode) {
    locState = getLocationState();
    if (locState && locState.isFallback) {
      gpsNotice.classList.remove('hidden');
    } else {
      gpsNotice.classList.add('hidden');
    }
  } else {
    gpsNotice.classList.add('hidden');
  }

  let lookaheadDistance = 15;
  const lookaheadInput = document.getElementById('lookahead-range');
  if (lookaheadInput) {
    lookaheadDistance = parseInt(lookaheadInput.value, 10);
  }

  try {
    const result = await analyzeRoute(currentRouteGeoJson, currentRouteId, locState?.location, lookaheadDistance);

    document.getElementById('loading-indicator').classList.add('hidden');
    document.getElementById('results-container').classList.remove('hidden');

    updateSyncStatus(Date.parse(result.timestamp));

    latestResult = result;
    setHazardSegments(map, result.segments);
    renderSummary(result.metadata, result.timestamp);
    renderRouteProfile('route-profile', { features: result.segments.features }, result.window);
    renderSegments(result.segments, currentActiveFilters);

    if (result.diff && result.diff.length > 0) {
      renderDiff(result.diff, result.timestamp);
    }

    if (isOnTrailMode && result.window && result.segments && result.segments.features.length > 0) {
      const lastFeature = result.segments.features[result.segments.features.length - 1];
      let endCoord = null;
      if (lastFeature.geometry.type === 'LineString') {
        const coords = lastFeature.geometry.coordinates;
        endCoord = coords[coords.length - 1];
      } else if (lastFeature.geometry.type === 'MultiLineString') {
        const coords = lastFeature.geometry.coordinates;
        const lastLine = coords[coords.length - 1];
        endCoord = lastLine[lastLine.length - 1];
      }
      
      if (endCoord) {
        setWindowBoundary(map, endCoord, `Mi ${lastFeature.properties.mileEnd}`);
      } else {
        clearWindowBoundary(map);
      }
    } else {
      clearWindowBoundary(map);
    }

  } catch (e) {
    console.error('Analysis error:', e);
    document.getElementById('loading-indicator').classList.add('hidden');
    document.getElementById('import-zone').classList.remove('hidden');
    alert('Analysis failed: ' + e.message);
  }
};

document.addEventListener('DOMContentLoaded', () => {
  map = initMap('map-container', onMapReady);

  const modePlanning = document.getElementById('mode-planning');
  const modeOntrail = document.getElementById('mode-ontrail');
  
  currentActiveFilters = setupFilterPills('filter-pills', (newFilters) => {
    currentActiveFilters = newFilters;
    if (latestResult && latestResult.segments) {
      renderSegments(latestResult.segments, currentActiveFilters);
    }
  });

  const setMode = (isOntrail) => {
    isOnTrailMode = isOntrail;
    if (isOnTrailMode) {
      modeOntrail.classList.add('active');
      modePlanning.classList.remove('active');
    } else {
      modePlanning.classList.add('active');
      modeOntrail.classList.remove('active');
      clearLocationState();
    }
    
    // Show/hide lookahead setting based on mode
    const lookaheadSetting = document.getElementById('lookahead-setting');
    if (lookaheadSetting) {
      if (isOnTrailMode) {
        lookaheadSetting.classList.remove('hidden');
      } else {
        lookaheadSetting.classList.add('hidden');
      }
    }

    if (currentRouteGeoJson) {
      runAnalysis();
    }
  };

  modePlanning.addEventListener('click', () => setMode(false));
  modeOntrail.addEventListener('click', () => setMode(true));

  const lookaheadInput = document.getElementById('lookahead-range');
  const lookaheadValue = document.getElementById('lookahead-value');
  let debounceTimeout = null;

  if (lookaheadInput && lookaheadValue) {
    lookaheadInput.addEventListener('input', (e) => {
      lookaheadValue.textContent = e.target.value + ' mi';
      if (debounceTimeout) clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        if (currentRouteGeoJson) runAnalysis();
      }, 500);
    });
  }

  setupImporter('import-zone', 'file-input', 'btn-import', (geoJson) => {
    currentRouteGeoJson = geoJson;
    currentRouteId = 'route_' + Date.now();
    
    if (mapReady) {
      setRoute(map, geoJson);
    } else {
      pendingRoute = geoJson;
    }

    runAnalysis();
  });
});
