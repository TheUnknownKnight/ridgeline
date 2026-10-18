/**
 * Sun position and clear-sky direct beam on a slope. Dependency-free and
 * deterministic, shared by server and browser.
 *
 * Sun position: USNO "Approximate Solar Coordinates" (~1 arcmin; checked
 * against the USNO API to 0.01°). Beam: Hock (1999) clear-sky direct
 * radiation with transmissivity 0.75 and a standard-atmosphere pressure term.
 */
const DEG = Math.PI / 180;
const SOLAR_CONSTANT = 1368;
const TRANSMISSIVITY = 0.75;

/** { altitude, azimuth (clockwise from north), R (sun distance, AU) } in degrees. */
export const sunPosition = (ms, lat, lon) => {
  const D = ms / 86400000 + 2440587.5 - 2451545.0;
  const g = ((357.529 + 0.98560028 * D) % 360) * DEG;
  const q = (280.459 + 0.98564736 * D) % 360;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const R = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
  const e = (23.439 - 0.00000036 * D) * DEG;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / DEG;
  const decl = Math.asin(Math.sin(e) * Math.sin(L));
  let eqtH = q / 15 - (((ra / 15) % 24) + 24) % 24;
  eqtH = (((eqtH + 12) % 24) + 24) % 24 - 12;
  const utH = (((ms / 3600000) % 24) + 24) % 24;
  const ha = (utH + lon / 15 + eqtH - 12) * 15 * DEG;
  const phi = lat * DEG;
  const cosZ = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const Z = Math.acos(Math.max(-1, Math.min(1, cosZ)));
  const sinZ = Math.sin(Z);
  let az = 180;
  if (sinZ > 1e-9) {
    const c = (Math.sin(decl) - Math.sin(phi) * cosZ) / (Math.cos(phi) * sinZ);
    az = Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
    if (Math.sin(ha) > 0) az = 360 - az;
  }
  return { altitude: 90 - Z / DEG, azimuth: az, R };
};

/**
 * Sun for one hour at one weather cell, shared by every trail point in it:
 * unit vector and clear-sky direct-normal irradiance at the middle of the hour.
 * Returns null when the sun is down.
 */
export const sunHour = (hourStartMs, lat, lon, elevationM = 0) => {
  const s = sunPosition(hourStartMs + 1800000, lat, lon);
  if (s.altitude <= 0) return null;
  const Z = (90 - s.altitude) * DEG;
  const a = s.azimuth * DEG;
  const pressure = Math.pow(Math.max(0.3, (293 - 0.0065 * elevationM) / 293), 5.26);
  const dni = (SOLAR_CONSTANT / (s.R * s.R)) * Math.pow(TRANSMISSIVITY, pressure / Math.cos(Z));
  return { x: Math.sin(Z) * Math.sin(a), y: Math.sin(Z) * Math.cos(a), z: Math.cos(Z), dni, altitude: s.altitude };
};

/** Unit normal of a slope (aspect = the direction it faces, clockwise from north). */
export const slopeNormal = (slopeDeg, aspectDeg) => {
  if (!(slopeDeg > 0) || aspectDeg == null || aspectDeg < 0) return { x: 0, y: 0, z: 1 };
  const b = slopeDeg * DEG;
  const g = aspectDeg * DEG;
  return { x: Math.sin(b) * Math.sin(g), y: Math.sin(b) * Math.cos(g), z: Math.cos(b) };
};

/** Clear-sky direct beam (W/m²) on a slope for one sunHour(); 0 when the slope faces away. */
export const beamOnSlope = (sun, normal) => {
  if (!sun) return 0;
  const c = normal.x * sun.x + normal.y * sun.y + normal.z * sun.z;
  return c > 0 ? sun.dni * c : 0;
};
