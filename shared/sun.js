/**
 * Sunrise, sunset and civil twilight from the standard sunrise equation
 * (NOAA/Meeus simplification, ~1–2 min accuracy below the polar circles).
 * No network needed, so it works for any position at any time.
 */
const DEG = Math.PI / 180;
const J2000 = 2451545.0;
const DAY_MS = 86400000;

const toJulian = (ms) => ms / DAY_MS + 2440587.5;
const fromJulian = (j) => (j - 2440587.5) * DAY_MS;

/**
 * Times (ms) for the solar day nearest `ms` at lon/lat. Returns nulls for
 * polar day/night. `elevationM` lowers the horizon slightly on high ground.
 */
const solarDay = (ms, lon, lat, elevationM = 0) => {
  // Index of the solar day whose noon is nearest `ms` (lon east-positive).
  const n = Math.round(toJulian(ms) - J2000 - 0.0008 + lon / 360);
  const jStar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * DEG) + 0.02 * Math.sin(2 * M * DEG) + 0.0003 * Math.sin(3 * M * DEG);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const transit = J2000 + jStar + 0.0053 * Math.sin(M * DEG) - 0.0069 * Math.sin(2 * lambda * DEG);
  const sinDec = Math.sin(lambda * DEG) * Math.sin(23.4397 * DEG);
  const cosDec = Math.cos(Math.asin(sinDec));
  const dip = elevationM > 0 ? (2.076 * Math.sqrt(elevationM)) / 60 : 0;

  const at = (altitudeDeg) => {
    const cosW = (Math.sin(altitudeDeg * DEG) - Math.sin(lat * DEG) * sinDec) / (Math.cos(lat * DEG) * cosDec);
    if (cosW < -1 || cosW > 1) return null;
    const w = Math.acos(cosW) / DEG / 360;
    return { rise: fromJulian(transit - w), set: fromJulian(transit + w) };
  };
  const sun = at(-0.833 - dip);
  const civil = at(-6 - dip);
  return {
    sunrise: sun?.rise ?? null,
    sunset: sun?.set ?? null,
    civilDawn: civil?.rise ?? null,
    civilDusk: civil?.set ?? null,
  };
};

/**
 * Daylight relative to `now`: the next sunset/civil dusk still ahead (today's,
 * or tomorrow's after dark) and the next sunrise.
 */
export const daylight = (now, lon, lat, elevationM = 0) => {
  const today = solarDay(now, lon, lat, elevationM);
  const tomorrow = solarDay(now + DAY_MS, lon, lat, elevationM);
  const next = (key) => [today[key], tomorrow[key]].find(t => t != null && t > now) ?? null;
  const sunset = next('sunset');
  const civilDusk = next('civilDusk');
  const sunrise = next('sunrise');
  const isDaylight = today.sunrise != null && today.sunset != null && now >= today.sunrise && now < today.sunset;
  return { sunrise, sunset, civilDusk, isDaylight };
};
