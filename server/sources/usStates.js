/**
 * Approximate state/territory bounding boxes [w, s, e, n], padded at use.
 * Only used as a superset filter to decide which NWS zones could touch a
 * route before fetching their geometry — exactness is not required.
 */
const STATE_BBOXES = {
  AL: [-88.47, 30.14, -84.89, 35.01], AK: [-179.15, 51.21, -129.98, 71.39], AZ: [-114.82, 31.33, -109.05, 37.0],
  AR: [-94.62, 33.0, -89.64, 36.5], CA: [-124.48, 32.53, -114.13, 42.01], CO: [-109.06, 36.99, -102.04, 41.0],
  CT: [-73.73, 40.98, -71.79, 42.05], DE: [-75.79, 38.45, -75.05, 39.84], DC: [-77.12, 38.79, -76.91, 38.99],
  FL: [-87.63, 24.4, -80.03, 31.0], GA: [-85.61, 30.36, -80.84, 35.0], HI: [-160.25, 18.91, -154.81, 22.24],
  ID: [-117.24, 41.99, -111.04, 49.0], IL: [-91.51, 36.97, -87.49, 42.51], IN: [-88.1, 37.77, -84.78, 41.76],
  IA: [-96.64, 40.38, -90.14, 43.5], KS: [-102.05, 36.99, -94.59, 40.0], KY: [-89.57, 36.5, -81.96, 39.15],
  LA: [-94.04, 28.93, -88.82, 33.02], ME: [-71.08, 42.98, -66.95, 47.46], MD: [-79.49, 37.91, -75.05, 39.72],
  MA: [-73.51, 41.24, -69.93, 42.89], MI: [-90.42, 41.7, -82.41, 48.31], MN: [-97.24, 43.5, -89.49, 49.38],
  MS: [-91.66, 30.17, -88.1, 34.99], MO: [-95.77, 35.99, -89.1, 40.61], MT: [-116.05, 44.36, -104.04, 49.0],
  NE: [-104.05, 40.0, -95.31, 43.0], NV: [-120.01, 35.0, -114.04, 42.0], NH: [-72.56, 42.7, -70.61, 45.31],
  NJ: [-75.56, 38.93, -73.89, 41.36], NM: [-109.05, 31.33, -103.0, 37.0], NY: [-79.76, 40.5, -71.86, 45.02],
  NC: [-84.32, 33.84, -75.46, 36.59], ND: [-104.05, 45.94, -96.55, 49.0], OH: [-84.82, 38.4, -80.52, 41.98],
  OK: [-103.0, 33.62, -94.43, 37.0], OR: [-124.57, 41.99, -116.46, 46.29], PA: [-80.52, 39.72, -74.69, 42.27],
  RI: [-71.91, 41.15, -71.12, 42.02], SC: [-83.35, 32.03, -78.54, 35.22], SD: [-104.06, 42.48, -96.44, 45.95],
  TN: [-90.31, 34.98, -81.65, 36.68], TX: [-106.65, 25.84, -93.51, 36.5], UT: [-114.05, 37.0, -109.04, 42.0],
  VT: [-73.44, 42.73, -71.46, 45.02], VA: [-83.68, 36.54, -75.24, 39.47], WA: [-124.85, 45.54, -116.92, 49.0],
  WV: [-82.64, 37.2, -77.72, 40.64], WI: [-92.89, 42.49, -86.25, 47.31], WY: [-111.06, 40.99, -104.05, 45.01],
  PR: [-67.95, 17.88, -65.22, 18.52], VI: [-65.09, 17.67, -64.56, 18.42], GU: [144.62, 13.23, 144.96, 13.65],
};

const PAD_DEG = 0.3;

export const STATE_CODES = new Set(Object.keys(STATE_BBOXES));

const memo = new WeakMap();

/** Every state whose (padded) bbox contains at least one route sample. */
export const statesForRoute = (route) => {
  if (memo.has(route)) return memo.get(route);
  const found = new Set();
  memo.set(route, found);
  const entries = Object.entries(STATE_BBOXES);
  for (const chunk of route.chunks) {
    for (const s of chunk.samplesCoarse) {
      for (const [code, b] of entries) {
        if (s.lon >= b[0] - PAD_DEG && s.lon <= b[2] + PAD_DEG && s.lat >= b[1] - PAD_DEG && s.lat <= b[3] + PAD_DEG) {
          found.add(code);
        }
      }
    }
  }
  return found;
};

/**
 * Unpadded test: is the point inside some state/territory bbox? Bboxes
 * overreach (into Mexico along Texas, into Ontario along New York), so this
 * only catches routes clearly outside the US; callers also use the NWS
 * /points 404 signal.
 */
export const inUnitedStatesBbox = (lon, lat) => {
  for (const b of Object.values(STATE_BBOXES)) {
    if (lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]) return true;
  }
  return false;
};
