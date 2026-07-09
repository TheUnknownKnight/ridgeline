import maplibregl from 'maplibre-gl';

const STATUS_COLORS = {
  'clear': '#4a7c59',
  'estimated-warning': '#c4603c',
  'danger-moderate': '#d4a843',
  'danger-severe': '#8b2500'
};

let geolocateControl;
let lastKnownLocation = null;
let lastKnownLocationTime = null;
let locationMarker = null;
let currentMap = null;
let isGpsFallback = false;

export const initMap = (containerId, onReady) => {
  const map = new maplibregl.Map({
    container: containerId,
    style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    center: [-119.5, 37.8],
    zoom: 8,
    attributionControl: false
  });

  currentMap = map;

  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  
  geolocateControl = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true
  });
  map.addControl(geolocateControl, 'top-right');
  
  geolocateControl.on('geolocate', (e) => {
    lastKnownLocation = { lat: e.coords.latitude, lng: e.coords.longitude };
    lastKnownLocationTime = Date.now();
    isGpsFallback = false;
    if (locationMarker) {
      locationMarker.remove();
      locationMarker = null;
    }
  });

  geolocateControl.on('error', () => {
    isGpsFallback = true;
    if (lastKnownLocation && !locationMarker && currentMap) {
      locationMarker = new maplibregl.Marker({ color: '#c4603c' })
        .setLngLat([lastKnownLocation.lng, lastKnownLocation.lat])
        .addTo(currentMap);
    }
  });

  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  map.on('load', () => {
    if (onReady) onReady();
  });

  return map;
};

export const getLocationState = () => {
  return { location: lastKnownLocation, timestamp: lastKnownLocationTime, isFallback: isGpsFallback };
};

export const clearLocationState = () => {
  lastKnownLocation = null;
  lastKnownLocationTime = null;
  if (locationMarker) {
    locationMarker.remove();
    locationMarker = null;
  }
};

export const setRoute = (map, routeGeoJSON) => {
  if (map.getSource('route-raw')) {
    map.getSource('route-raw').setData(routeGeoJSON);
  } else {
    map.addSource('route-raw', { type: 'geojson', data: routeGeoJSON });
    map.addLayer({
      id: 'route-line-raw',
      type: 'line',
      source: 'route-raw',
      paint: { 'line-color': '#9a9478', 'line-width': 3, 'line-opacity': 0.7 },
      layout: { 'line-cap': 'round', 'line-join': 'round' }
    });
  }

  const coords = routeGeoJSON.features
    .filter(f => f.geometry && (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString'))
    .flatMap(f => f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.coordinates);

  if (coords.length > 0) {
    const bounds = coords.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(coords[0], coords[0])
    );
    map.fitBounds(bounds, { padding: 60, duration: 1200 });
  }
};

export const setHazardSegments = (map, segmentsGeoJSON) => {
  // Split into official (solid) and estimated (dashed) features
  const solidFeatures = [];
  const dashedFeatures = [];

  for (const f of segmentsGeoJSON.features) {
    if (f.properties.status === 'estimated-warning') {
      dashedFeatures.push(f);
    } else {
      solidFeatures.push(f);
    }
  }

  const solidGeoJSON = { type: 'FeatureCollection', features: solidFeatures };
  const dashedGeoJSON = { type: 'FeatureCollection', features: dashedFeatures };

  const colorExpr = [
    'match', ['get', 'status'],
    'clear', STATUS_COLORS['clear'],
    'estimated-warning', STATUS_COLORS['estimated-warning'],
    'danger-moderate', STATUS_COLORS['danger-moderate'],
    'danger-severe', STATUS_COLORS['danger-severe'],
    STATUS_COLORS['clear']
  ];

  const widthExpr = [
    'match', ['get', 'status'],
    'clear', 3,
    'estimated-warning', 4,
    'danger-moderate', 4,
    'danger-severe', 5,
    3
  ];

  // Dim raw route instead of hiding it to show what's outside the window
  if (map.getLayer('route-line-raw')) {
    map.setLayoutProperty('route-line-raw', 'visibility', 'visible');
    map.setPaintProperty('route-line-raw', 'line-opacity', 0.2);
  }

  // Solid segments (official data)
  if (map.getSource('segments-solid')) {
    map.getSource('segments-solid').setData(solidGeoJSON);
  } else {
    map.addSource('segments-solid', { type: 'geojson', data: solidGeoJSON });
    map.addLayer({
      id: 'segments-solid-line',
      type: 'line',
      source: 'segments-solid',
      paint: { 'line-color': colorExpr, 'line-width': widthExpr, 'line-opacity': 0.9 },
      layout: { 'line-cap': 'round', 'line-join': 'round' }
    });
  }

  // Dashed segments (estimated data)
  if (map.getSource('segments-dashed')) {
    map.getSource('segments-dashed').setData(dashedGeoJSON);
  } else {
    map.addSource('segments-dashed', { type: 'geojson', data: dashedGeoJSON });
    map.addLayer({
      id: 'segments-dashed-line',
      type: 'line',
      source: 'segments-dashed',
      paint: { 'line-color': colorExpr, 'line-width': widthExpr, 'line-opacity': 0.9, 'line-dasharray': [2, 2] },
      layout: { 'line-cap': 'butt', 'line-join': 'round' }
    });
  }
};

/**
 * A5 — Render the lookahead window boundary marker on the map.
 * @param {object} map — MapLibre map instance
 * @param {[number,number]} windowEndCoord — [lng, lat] of window end
 * @param {string} mileLabel — Label text for the marker (e.g. "Mi 15")
 */
export const setWindowBoundary = (map, windowEndCoord, mileLabel) => {
  const pointGeoJSON = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: windowEndCoord },
      properties: { label: mileLabel || '' }
    }]
  };

  if (map.getSource('window-boundary')) {
    map.getSource('window-boundary').setData(pointGeoJSON);
  } else {
    map.addSource('window-boundary', { type: 'geojson', data: pointGeoJSON });
    map.addLayer({
      id: 'window-boundary-circle',
      type: 'circle',
      source: 'window-boundary',
      paint: {
        'circle-radius': 8,
        'circle-color': '#5b8fa8',
        'circle-opacity': 0.6,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#5b8fa8'
      }
    });
    map.addLayer({
      id: 'window-boundary-label',
      type: 'symbol',
      source: 'window-boundary',
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Open Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 1.8],
        'text-anchor': 'top'
      },
      paint: {
        'text-color': '#5b8fa8',
        'text-halo-color': '#1a1a2e',
        'text-halo-width': 1
      }
    });
  }
};

/**
 * A5 — Remove the lookahead window boundary marker from the map.
 */
export const clearWindowBoundary = (map) => {
  if (map.getLayer('window-boundary-label')) map.removeLayer('window-boundary-label');
  if (map.getLayer('window-boundary-circle')) map.removeLayer('window-boundary-circle');
  if (map.getSource('window-boundary')) map.removeSource('window-boundary');
};
