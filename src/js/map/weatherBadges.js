/**
 * Crisp custom SVG badges for NWS alerts, forecast weather hazards, and
 * sidebar hazard rows. Pure classification, placement and SVG geometry live
 * here so Node unit tests can verify them; browser helpers turn the same
 * primitives into HiDPI ImageData (for MapLibre) or DOM SVGs (for the panel).
 */
import { LEVELS, levelInfo } from '../../../shared/levels.js';
import { pointAtMile } from '../../../shared/geo.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MERGE_GAP_MILES = 20;
const SPLIT_SPAN_MILES = 180;
const BADGE_PX = 64; // rendered at pixelRatio 2 -> 32 CSS px

const GLYPH_SHAPES = {
  wind: [
    ['path', { d: 'M4 9h9.5a2 2 0 1 0-2-2' }],
    ['path', { d: 'M3 13h14.5a2.2 2.2 0 1 1-2.2 2.2' }],
    ['path', { d: 'M5 17h6.5a1.8 1.8 0 1 1-1.8 1.8' }],
  ],
  snow: [
    ['path', { d: 'M12 3.5v17M4.6 7.8l14.8 8.4M19.4 7.8L4.6 16.2' }],
    ['path', { d: 'M10 5.5L12 7l2-1.5M10 18.5L12 17l2 1.5M6.8 6.5l.7 2.2-2.2.7M17.2 17.5l-.7-2.2 2.2-.7M17.2 6.5l-.7 2.2 2.2.7M6.8 17.5l.7-2.2-2.2-.7' }],
  ],
  rain: [
    ['path', { d: 'M6.5 14h10.8a3.2 3.2 0 0 0 .4-6.4A4.8 4.8 0 0 0 8.3 6.2 3.6 3.6 0 0 0 6.5 14z' }],
    ['path', { d: 'M8.5 17.2l-1 2.3M12.5 17.2l-1 2.3M16.2 17.2l-1 2.3' }],
  ],
  ice: [
    ['path', { d: 'M4.5 6.5h15' }],
    ['path', { d: 'M6.5 6.5L8 14.5l1.8-8M11 6.5l1.3 12 1.5-12M15 6.5l1.2 8.5 1.3-8.5' }],
  ],
  thunder: [
    ['path', { d: 'M13.5 3.5L6.5 13h5l-1 7.5 7-9.5h-5l1-7.5z' }],
  ],
  heat: [
    ['circle', { cx: '12', cy: '12', r: '3.8' }],
    ['path', { d: 'M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.5 1.5M16.5 16.5L18 18M18 6l-1.5 1.5M7.5 16.5L6 18' }],
  ],
  cold: [
    ['path', { d: 'M10 4.5a2 2 0 0 1 4 0v8.7a3.6 3.6 0 1 1-4 0V4.5z' }],
    ['path', { d: 'M12 12v4.2' }],
    ['circle', { cx: '12', cy: '16.4', r: '1.2', fill: 'currentColor', stroke: 'none' }],
    ['path', { d: 'M17.5 7.5h2M17.5 10.5h2' }],
  ],
  redflag: [
    ['path', { d: 'M12.2 3.8c2.6 3.2 4.8 5.8 4.8 9.4a5 5 0 0 1-10 0c0-2.4 1.3-4.3 2.5-5.8.3 1.4 1.2 2.1 2 2.1-.4-2.3 0-4.1.7-5.7z' }],
  ],
  avalanche: [
    ['path', { d: 'M3.5 19L10.5 6.5l4 6.5 2.5-3.5L20.5 19H3.5z' }],
  ],
  water: [
    ['path', { d: 'M3.5 11.5c2-2 4-2 6 0s4 2 6 0 3.5-2 5 0' }],
    ['path', { d: 'M3.5 16.5c2-2 4-2 6 0s4 2 6 0 3.5-2 5 0' }],
  ],
  smoke: [
    ['path', { d: 'M4 9.5h10.5a2 2 0 1 0-2-2' }],
    ['path', { d: 'M3.5 13.5h14.5a2 2 0 1 1-2 2' }],
    ['path', { d: 'M6 17.5h8' }],
  ],
  trail: [
    ['path', { d: 'M4 18.5L10 8l4 6 2.5-3.5L20 18.5' }],
    ['path', { d: 'M4 18.5h16' }],
  ],
  alert: [
    ['path', { d: 'M12 4.5L3.5 19.5h17L12 4.5z' }],
    ['path', { d: 'M12 10.2v4' }],
    ['path', { d: 'M12 17v.1' }],
  ],
};

const shapesToMarkup = (shapes) => shapes.map(([tag, attrs]) => {
  const attrStr = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
  return `<${tag} ${attrStr}/>`;
}).join('');

const WEATHER_ID_GLYPH = {
  'wx:wind': 'wind',
  'wx:snow': 'snow',
  'wx:precip': 'rain',
  'wx:ice': 'ice',
  'wx:thunder': 'thunder',
  'wx:heat': 'heat',
  'wx:cold': 'cold',
};

const ALERT_RULES = [
  [/red flag|fire weather/, 'redflag'],
  [/ice storm|freezing rain|freezing drizzle|freezing fog|sleet/, 'ice'],
  [/blizzard|winter storm|winter weather|snow|lake effect|avalanche/, 'snow'],
  [/thunderstorm|tornado|severe weather|lightning/, 'thunder'],
  [/flood|rain|hydrologic|debris flow|flash/, 'rain'],
  [/wind|gale|hurricane|tropical|high surf/, 'wind'],
  [/heat/, 'heat'],
  [/cold|freeze|frost|chill/, 'cold'],
];

/** Map an NWS alert or forecast weather hazard to a crisp SVG glyph key, or null. */
export const badgeGlyphForHazard = (hz) => {
  if (!hz) return null;
  if (hz.type === 'weather') return WEATHER_ID_GLYPH[hz.id] || 'alert';
  if (hz.type !== 'alert') return null;
  const title = String(hz.title || '').toLowerCase();
  for (const [re, glyph] of ALERT_RULES) if (re.test(title)) return glyph;
  return 'alert';
};

/** Glyph key for any hazard type (used by sidebar rows to match map symbols). */
export const glyphForAnyHazard = (hz) => {
  if (!hz) return 'alert';
  const wx = badgeGlyphForHazard(hz);
  if (wx) return wx;
  if (hz.type === 'fire') return 'redflag';
  if (hz.type === 'avalanche') return 'avalanche';
  if (hz.type === 'water') return 'water';
  if (hz.type === 'smoke') return 'smoke';
  if (hz.type === 'trail') {
    if (hz.id === 'trail:ice') return 'ice';
    if (String(hz.id || '').startsWith('trail:snow')) return 'snow';
    return 'trail';
  }
  return 'alert';
};

/** Build a DOM SVG badge element safely with createElementNS (no innerHTML). */
export const createHazardBadgeEl = (hz, { size = 'md' } = {}) => {
  const info = levelInfo(hz?.level);
  const fg = info.level >= 3 ? '#ffffff' : '#1d2622';
  const glyph = glyphForAnyHazard(hz);
  const shapes = GLYPH_SHAPES[glyph] || GLYPH_SHAPES.alert;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'hazard-badge-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of shapes) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
  }
  const wrap = document.createElement('span');
  wrap.className = `hazard-badge${size === 'sm' ? ' hazard-badge-sm' : ''}${hz?.source === 'ESTIMATED' ? ' is-estimated' : ''}`;
  wrap.style.setProperty('--badge-bg', info.color);
  wrap.style.setProperty('--badge-fg', fg);
  wrap.setAttribute('aria-hidden', 'true');
  wrap.append(svg);
  return wrap;
};

export const badgeIconId = ({ glyph, level, estimated, theme }) =>
  `rl-wx:${glyph}:${level}:${estimated ? 1 : 0}:${theme}`;

/** Solid severity circular badge SVG matching Ridgeline's 0–4 palette and text contrast. */
export const badgeSvgMarkup = ({ glyph, level, estimated = false, theme = 'light' }) => {
  const lv = LEVELS[Math.max(1, Math.min(4, level | 0))] || LEVELS[1];
  const fg = lv.level >= 3 ? '#ffffff' : '#1d2622';
  const casing = theme === 'dark' ? '#141916' : '#ffffff';
  const paths = shapesToMarkup(GLYPH_SHAPES[glyph] || GLYPH_SHAPES.alert);
  const estRing = estimated
    ? `<circle cx="16" cy="16" r="13.8" fill="none" stroke="${lv.color}" stroke-width="1.4" stroke-dasharray="3 2.5"/>`
    : '';
  const innerStroke = estimated ? ` stroke="${casing}" stroke-width="1.5"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BADGE_PX}" height="${BADGE_PX}" viewBox="0 0 32 32">`
    + `<circle cx="16" cy="16" r="14.5" fill="${casing}"/>`
    + `<circle cx="16" cy="16" r="12.4" fill="${lv.color}"${innerStroke}/>`
    + estRing
    + `<g transform="translate(7.5 7.5) scale(0.708)" fill="none" stroke="${fg}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" color="${fg}">${paths}</g>`
    + '</svg>';
};

const anchorMilesFor = (hz) => {
  const ranges = (hz.ranges || []).filter(r => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]));
  if (!ranges.length) return Number.isFinite(hz.closest?.atMile) ? [hz.closest.atMile] : [];
  const merged = [];
  for (const [a, b] of ranges) {
    const last = merged[merged.length - 1];
    if (last && a - last[1] <= MERGE_GAP_MILES) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const miles = [];
  for (const [a, b] of merged) {
    const span = b - a;
    if (span >= SPLIT_SPAN_MILES) {
      miles.push(a + span * 0.3, a + span * 0.7);
    } else {
      miles.push((a + b) / 2);
    }
  }
  return miles;
};

/** GeoJSON Point features for visible alert + weather hazards along the route. */
export const buildWeatherBadgeFeatures = (route, result, hiddenTypes = new Set(), theme = 'light') => {
  if (!route?.coords?.length || !result?.hazards) return [];
  const features = [];
  for (const hz of Object.values(result.hazards)) {
    if (hz.type !== 'alert' && hz.type !== 'weather') continue;
    if (hiddenTypes.has(hz.type)) continue;
    const glyph = badgeGlyphForHazard(hz);
    if (!glyph) continue;
    const level = Math.max(1, Math.min(4, Number(hz.level) || 1));
    const estimated = hz.source === 'ESTIMATED';
    const icon = badgeIconId({ glyph, level, estimated, theme });
    const sortKey = (4 - level) * 2 + (estimated ? 1 : 0);
    for (const mile of anchorMilesFor(hz)) {
      const pt = pointAtMile(route.coords, route.cum, mile);
      if (!pt) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pt[0], pt[1]] },
        properties: {
          overlay: hz.type === 'alert' ? 'alert-badge' : 'weather-badge',
          hazardId: hz.id,
          title: hz.title,
          level,
          estimated,
          glyph,
          icon,
          sortKey,
        },
      });
    }
  }
  return features;
};

const decodedCache = new Map(); // iconId -> Promise<ImageData>

/** Decode and rasterize one solid SVG badge to 64x64 ImageData (pixelRatio 2). */
const rasterizeBadge = (spec) => {
  const id = badgeIconId(spec);
  if (decodedCache.has(id)) return decodedCache.get(id);
  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    img.width = BADGE_PX;
    img.height = BADGE_PX;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = BADGE_PX;
      canvas.height = BADGE_PX;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, BADGE_PX, BADGE_PX);
      resolve(ctx.getImageData(0, 0, BADGE_PX, BADGE_PX));
    };
    img.onerror = () => reject(new Error(`Failed to decode badge SVG: ${id}`));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(badgeSvgMarkup(spec))}`;
  });
  promise.catch(() => decodedCache.delete(id));
  decodedCache.set(id, promise);
  return promise;
};

/** Ensure every badge icon referenced by `features` is registered on `map`. */
export const ensureBadgeImages = async (map, features, theme) => {
  const unique = new Map();
  for (const f of features) {
    const p = f.properties;
    if (!map.hasImage(p.icon) && !unique.has(p.icon)) {
      unique.set(p.icon, { glyph: p.glyph, level: p.level, estimated: Boolean(p.estimated), theme });
    }
  }
  if (!unique.size) return;
  await Promise.all([...unique.entries()].map(async ([id, spec]) => {
    try {
      const imageData = await rasterizeBadge(spec);
      if (!map.hasImage(id)) map.addImage(id, imageData, { pixelRatio: 2 });
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[map]', err);
    }
  }));
};
