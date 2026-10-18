import { MILES_PER_DEG_LAT, cumulativeMiles } from '../shared/geo.js';
import { getRouteModel } from '../server/fusion/route.js';
import { prepPolygons, polygonsBbox } from '../server/lib/spatial.js';

export const LON = -120;
export const LAT0 = 37;

/** Degrees of latitude for a distance in miles (route runs due north). */
export const dLat = (miles) => miles / MILES_PER_DEG_LAT;
/** Degrees of longitude for a distance in miles at LAT0. */
export const dLon = (miles) => miles / (MILES_PER_DEG_LAT * Math.cos(LAT0 * Math.PI / 180));

/** Straight north-south route of `miles`, one vertex every 0.05 mi. */
export const straightCoords = (miles, { ele = null } = {}) => {
  const n = Math.round(miles / 0.05);
  return Array.from({ length: n + 1 }, (_, i) => {
    const c = [LON, LAT0 + dLat(i * 0.05)];
    if (ele != null) c.push(ele + i);
    return c;
  });
};

export const routeRequest = (coords, extra = {}) => {
  const cum = cumulativeMiles(coords);
  return { coords, cum, lengthMiles: cum[cum.length - 1], hasElevation: coords[0].length > 2, location: null, lookaheadMiles: 15, name: 'test', ...extra };
};

export const buildRoute = (miles) => getRouteModel(routeRequest(straightCoords(miles)));

/** Axis-aligned box spanning route miles [m0, m1], offset east by `offsetMiles`, `widthMiles` wide. */
export const boxPolygon = (m0, m1, { offsetMiles = 0, widthMiles = 0.5 } = {}) => {
  const x0 = LON + dLon(offsetMiles - widthMiles / 2);
  const x1 = LON + dLon(offsetMiles + widthMiles / 2);
  const y0 = LAT0 + dLat(m0);
  const y1 = LAT0 + dLat(m1);
  return { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] };
};

export const prepared = (geometry, extra = {}) => {
  const polygons = prepPolygons(geometry, 0);
  return { polygons, bbox: polygonsBbox(polygons), ...extra };
};

export const firePerimeter = (geometry, extra = {}) => prepared(geometry, {
  key: extra.key || '{TEST-FIRE}',
  irwinId: extra.key || '{TEST-FIRE}',
  name: 'Test Fire',
  category: 'WF',
  acres: 1200,
  percentContained: 10,
  discoveredAt: Date.UTC(2026, 9, 10),
  updatedAt: Date.now(),
  perimeterAsOf: Date.now(),
  mapMethod: 'IR Image Interpretation',
  state: 'CA',
  isComplexChild: false,
  complexId: null,
  ...extra,
});

export const okSource = (data, extra = {}) => ({ status: 'ok', fetchedAt: new Date().toISOString(), message: 'ok', attribution: 'test', url: null, data, ...extra });
export const errorSource = (data) => ({ status: 'error', fetchedAt: null, message: 'down', attribution: 'test', url: null, data });

/** A category-1 (good) AirNow contour covering the whole test area. */
export const goodAir = () => prepared({
  type: 'Polygon',
  coordinates: [[[LON - 5, LAT0 - 5], [LON + 5, LAT0 - 5], [LON + 5, LAT0 + 10], [LON - 5, LAT0 + 10], [LON - 5, LAT0 - 5]]],
}, { category: 1 });

/** Fake source loaders for the engine; override any key. */
export const fakeSources = (overrides = {}) => ({
  loadFire: async () => okSource({ perimeters: [], incidents: [] }),
  loadAlerts: async () => okSource({ alerts: [] }),
  loadAvalanche: async () => okSource({ zones: [] }),
  loadWater: async () => okSource({ gauges: [] }),
  // AirNow's contours blanket the country; one "good" box stands in for that.
  loadAir: async () => okSource({ contours: [goodAir()], monitors: [], plumes: [], validAt: null }),
  loadForecast: async ({ samples }) => okSource({ points: samples.map(s => ({ ...s, grid: null })) }),
  loadRecentPrecip: async ({ samples }) => okSource({ bySample: samples.map(() => null) }),
  loadSmoke: async ({ samples }) => okSource({ points: samples.map(s => ({ ...s, aq: null })) }),
  loadConditions: async () => ({ ...okSource({ points: [] }), status: 'skipped' }),
  ...overrides,
});
