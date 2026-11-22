import { sourceCache } from '../lib/cache.js';
import { fetchText, HttpError } from '../lib/http.js';
import { prepPolygons, polygonsBbox } from '../lib/spatial.js';

/**
 * NOAA Hazard Mapping System smoke polygons: analysts trace smoke plumes on
 * GOES imagery several times a day and grade them light / medium / heavy.
 * This is smoke anywhere in the air column, not a ground-level reading, so
 * it is map context and a "smoke overhead" note, never an air-quality value.
 *
 * One KML file per UTC day (~100–300 KB). NOAA keeps appending to it until
 * ~10Z the next day (the evening analyses land late), so a day's file is
 * re-read often until it settles. Today's file 404s until the first analysis.
 */
const BASE = 'https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML';
export const ATTRIBUTION = 'NOAA Hazard Mapping System (satellite smoke analysis)';
export const SOURCE_URL = 'https://www.ospo.noaa.gov/products/land/hms.html';

const DAY_MS = 86400000;
const GROWING_TTL_MS = 20 * 60 * 1000;
const SETTLED_TTL_MS = 6 * 60 * 60 * 1000;
const SETTLE_AFTER_DAY_END_MS = 12 * 60 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
const ERROR_TTL_MS = 15 * 1000;
const MAX_KML_BYTES = 5 * 1024 * 1024;
const MAX_PLACEMARKS = 5000;
const MAX_POLYGONS_PER_PLACEMARK = 200;
// A plume traced in the last day still says something about this morning's sky.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DENSITIES = ['light', 'medium', 'heavy'];

const pad = (n) => String(n).padStart(2, '0');
const dayPath = (ms) => {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  return `${BASE}/${y}/${m}/hms_smoke${y}${m}${pad(d.getUTCDate())}.kml`;
};

/** "2026289 1200UTC" (year, day of year, hhmm) → ms. */
export const parseHmsTime = (text) => {
  const m = /(\d{4})(\d{3})\s+(\d{2})(\d{2})/.exec(text || '');
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), 0, 1, Number(m[3]), Number(m[4])) + (Number(m[2]) - 1) * DAY_MS;
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Text between successive open/close tags. A linear scan that stops at the
 * first unclosed tag — never a lazy regex, which goes quadratic on a corrupt
 * file and would block the event loop.
 */
function* between(text, open, close, limit = Infinity) {
  let i = 0;
  let n = 0;
  while (n < limit) {
    const a = text.indexOf(open, i);
    if (a < 0) return;
    const b = text.indexOf(close, a + open.length);
    if (b < 0) return;
    yield text.slice(a + open.length, b);
    i = b + close.length;
    n++;
  }
}

const parseCoords = (text) => (text || '').trim().split(/\s+/)
  .map(t => t.split(',').map(Number))
  .filter(c => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90)
  .map(c => [c[0], c[1]]);

const ringsOf = (polygonXml, boundary) => [...between(polygonXml, `<${boundary}>`, `</${boundary}>`)]
  .map(b => parseCoords([...between(b, '<coordinates>', '</coordinates>', 1)][0]));

const fieldOf = (mark, label) => {
  const i = mark.indexOf(label);
  if (i < 0) return null;
  return mark.slice(i + label.length, i + label.length + 40);
};

/** Parse an HMS smoke KML into plumes. Text-only scanning: no entity expansion, no DOM. */
export const parseHmsKml = (kml) => {
  const plumes = [];
  let placemarks = 0;
  for (const mark of between(kml, '<Placemark>', '</Placemark>', MAX_PLACEMARKS)) {
    placemarks++;
    const style = /(light|medium|heavy)/i.exec([...between(mark, '<styleUrl>', '</styleUrl>', 1)][0] || '')?.[1]
      || /Density:\s*(light|medium|heavy)/i.exec(mark)?.[1];
    const density = style?.toLowerCase();
    if (!DENSITIES.includes(density)) continue;
    const coordinates = [];
    for (const poly of between(mark, '<Polygon>', '</Polygon>', MAX_POLYGONS_PER_PLACEMARK)) {
      const [outer] = ringsOf(poly, 'outerBoundaryIs');
      if (outer?.length >= 4) coordinates.push([outer, ...ringsOf(poly, 'innerBoundaryIs').filter(r => r.length >= 4)]);
    }
    const polygons = prepPolygons({ type: 'MultiPolygon', coordinates }, 0.25);
    if (!polygons.length) continue;
    plumes.push({
      density,
      start: parseHmsTime(fieldOf(mark, 'Start Time:')),
      end: parseHmsTime(fieldOf(mark, 'End Time:')),
      polygons,
      bbox: polygonsBbox(polygons),
    });
  }
  return { plumes, placemarks };
};

/** One day's file: { ok, missing, plumes }. Today's 404 is "not posted yet", cached like an empty file. */
const loadDay = async (dayMs, now) => {
  const d = new Date(dayMs);
  const dayEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  const isToday = now < dayEnd;
  const settling = now - dayEnd < SETTLE_AFTER_DAY_END_MS;
  const url = dayPath(dayMs);
  try {
    const { value } = await sourceCache.wrap(`hms:${url}`, {
      ttlMs: settling ? GROWING_TTL_MS : SETTLED_TTL_MS,
      revalidateMs: settling ? GROWING_TTL_MS : 0,
      staleMs: STALE_MS,
      errorTtlMs: ERROR_TTL_MS,
    }, async () => {
      let kml;
      try {
        kml = await fetchText(url, { label: 'NOAA HMS smoke', timeoutMs: 6000, retries: 1, maxBytes: MAX_KML_BYTES });
      } catch (err) {
        if (isToday && err instanceof HttpError && err.status === 404) return { plumes: [], missing: true };
        throw err;
      }
      const parsed = parseHmsKml(kml);
      // Placemarks that parse to nothing mean the format changed — not "no smoke".
      if (parsed.placemarks > 0 && !parsed.plumes.length && !/Smoke_(Light|Medium|Heavy)/i.test(kml)) {
        throw new Error('HMS smoke KML format not recognized');
      }
      return { plumes: parsed.plumes, missing: false };
    });
    return { ok: true, ...value };
  } catch (err) {
    console.error('[hms] load failed:', err.message);
    return { ok: false, missing: false, plumes: [] };
  }
};

/**
 * Smoke plumes traced in the last 24 hours (today's and yesterday's files).
 * status: ok when both days answered (today's file not existing yet counts),
 * partial when one failed, error when neither gave anything usable.
 */
export const loadSmokePlumes = async ({ now = Date.now() } = {}) => {
  const [today, yesterday] = await Promise.all([loadDay(now, now), loadDay(now - DAY_MS, now)]);
  const plumes = [...today.plumes, ...yesterday.plumes]
    .filter(p => (p.end ?? p.start ?? 0) >= now - MAX_AGE_MS);
  const usable = (today.ok && !today.missing) || yesterday.ok;
  return {
    status: !usable ? 'error' : today.ok && yesterday.ok ? 'ok' : 'partial',
    attribution: ATTRIBUTION,
    url: SOURCE_URL,
    data: { plumes },
  };
};
