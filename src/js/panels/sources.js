/**
 * "Data": where every part of the answer came from, how fresh it is, and
 * what failed. Status is always an icon plus words, never color alone.
 * Degraded or unavailable sources stay expanded at the top; healthy sources
 * fold into compact rows so status is scannable at a glance.
 */
import { h, safeUrl } from '../ui/dom.js';
import { fmtAgo, fmtMile } from '../ui/format.js';
import { SOURCE_KEYS, SOURCE_LABELS } from '../../../shared/levels.js';
import { icon, changeDetector, remount } from './common.js';

const STATUS = {
  ok: { icon: 'ok', text: 'Up to date' },
  stale: { icon: 'stale', text: 'Using older data' },
  partial: { icon: 'partial', text: 'Partly loaded' },
  error: { icon: 'error', text: 'Unavailable' },
  skipped: { icon: 'skipped', text: 'Not used' },
};

const HEALTHY_STATUSES = new Set(['ok', 'skipped']);

export const partitionSources = (sources = {}) => {
  const attention = [];
  const healthy = [];
  for (const key of SOURCE_KEYS) {
    const st = sources[key]?.status || 'error';
    if (HEALTHY_STATUSES.has(st)) healthy.push(key);
    else attention.push(key);
  }
  return { attention, healthy };
};

export const sourceHealthSummary = (sources = {}) => {
  let ok = 0;
  let skipped = 0;
  let attention = 0;
  for (const key of SOURCE_KEYS) {
    const st = sources[key]?.status || 'error';
    if (st === 'ok') ok++;
    else if (st === 'skipped') skipped++;
    else attention++;
  }
  const total = SOURCE_KEYS.length;
  if (attention > 0) {
    const issueText = attention === 1 ? '1 needs attention' : `${attention} need attention`;
    return `${ok} of ${total} sources up to date, ${issueText}`;
  }
  if (skipped > 0) return `${ok} of ${total} sources up to date, ${skipped} not used`;
  return `All ${total} sources up to date`;
};

const extLink = (url, text) => {
  const href = safeUrl(url);
  if (!href) return text;
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' },
    text, h('span', { class: 'visually-hidden' }, ' (opens in a new tab)'));
};

/** "Sampled every 1 mi along Mi 99–115, next 72 h" for model-backed sources. */
export const coverageText = (source) => {
  const parts = [];
  if (source.sampledEveryMiles) {
    const along = Array.isArray(source.range) ? ` along Mi ${fmtMile(source.range[0])}–${fmtMile(source.range[1])}` : '';
    parts.push(`Sampled every ${fmtMile(source.sampledEveryMiles)} mi${along}`);
  }
  if (source.horizonHours) parts.push(`next ${source.horizonHours} h`);
  if (source.beyondHorizonMiles > 0) parts.push(`${fmtMile(source.beyondHorizonMiles)} mi past horizon`);
  return parts.join(', ');
};

const ZONE_STATE_TEXT = {
  'off-season': 'off-season',
  expired: 'forecast expired, not yet re-issued',
  'no-forecast': 'no current forecast',
  'no-rating': 'no danger rating issued',
  'info-only': 'observations only, no ratings',
};

const avalancheCoverage = (coverage) => {
  if (!Array.isArray(coverage) || !coverage.length) return null;
  return h('div', { class: 'coverage' },
    h('p', { class: 'coverage-title' }, 'Forecast zones on this route'),
    h('ul', {}, coverage.map(zone => h('li', {},
      h('span', { class: 'coverage-zone' }, extLink(zone.link, zone.zone || 'Forecast zone')),
      [zone.center, ZONE_STATE_TEXT[zone.state] || zone.state, Number.isFinite(zone.firstMile) ? `from Mi ${fmtMile(zone.firstMile)}` : null]
        .filter(Boolean).map(part => `, ${part}`)))));
};

/** "Nearest monitor: Bishop, 2.1 mi from the trail at Mi 120: AQI 14" */
const monitorLine = (m) => (m
  ? h('p', { class: 'source-meta' }, `Nearest monitor: ${m.name}, ${fmtMile(m.miles)} mi from the trail at Mi ${fmtMile(m.atMile)}: AQI ${m.aqi}`)
  : null);

const sourceBody = (key, source, now) => {
  const fetched = Date.parse(source?.fetchedAt);
  const coverage = source ? coverageText(source) : '';
  return [
    source?.message ? h('p', { class: 'source-message' }, source.message) : null,
    coverage ? h('p', { class: 'source-meta' }, coverage) : null,
    h('p', { class: 'source-meta' },
      Number.isFinite(Date.parse(source?.validAt)) ? `Readings from ${fmtAgo(Date.parse(source.validAt), now)}. ` : null,
      Number.isFinite(fetched) ? `Fetched ${fmtAgo(fetched, now)}. ` : null,
      source?.attribution ? extLink(source.url, source.attribution) : 'Source unknown'),
    key === 'avalanche' ? avalancheCoverage(source?.coverage) : null,
    key === 'air' ? monitorLine(source?.nearestMonitor) : null,
  ];
};

const sourceRow = (key, source, now, { collapsible = false } = {}) => {
  const st = source?.status || 'error';
  const status = STATUS[st] || STATUS.error;
  if (!collapsible) {
    return h('li', { class: `source source-${st}` },
      h('div', { class: 'source-head' },
        h('span', { class: 'source-name' }, SOURCE_LABELS[key] || key),
        h('span', { class: 'status' }, icon(status.icon), status.text)),
      sourceBody(key, source, now));
  }
  return h('li', { class: `source source-${st} source-compact` },
    h('details', { class: 'source-fold', 'data-open-key': `src:${key}` },
      h('summary', { class: 'source-head' },
        h('span', { class: 'source-name' }, SOURCE_LABELS[key] || key),
        h('span', { class: 'status' }, icon(status.icon), status.text),
        icon('chevron')),
      h('div', { class: 'source-fold-body' }, sourceBody(key, source, now))));
};

const footer = () => h('footer', { class: 'sources-footer' },
  h('p', { class: 'disclaimer' },
    'Ridgeline summarizes public data. Conditions change fast — always check with the land manager and official forecasts before you go.'),
  h('p', {},
    'Data from the National Interagency Fire Center (WFIGS), the National Weather Service, avalanche.org, the NOAA National Water Prediction Service, ',
    'EPA AirNow, the NOAA National Air Quality Forecast Capability and the NOAA Hazard Mapping System. ',
    'Recent rainfall, and air quality where NOAA has no forecast, from ', extLink('https://open-meteo.com/', 'Open-Meteo'),
    ' (', extLink('https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0'),
    '), which contains modified Copernicus Atmosphere Monitoring Service information.'),
  h('p', {}, extLink('https://github.com/TheUnknownKnight/ridgeline', 'Ridgeline source code'), ' is free software under the ', extLink('https://www.gnu.org/licenses/agpl-3.0.html', 'GNU Affero General Public License v3.0'), '.'));

const fmtNum = (n) => Math.round(n).toLocaleString('en-US');

export const diagnosticSummaryRows = (d) => {
  if (!d) return [];
  const rows = [];
  if (d.elevation && Number.isFinite(d.elevation.min) && Number.isFinite(d.elevation.max)) {
    const src = d.elevation.source === 'landfire' ? 'LANDFIRE 30 m DEM' : 'route file';
    rows.push(['Elevation', `${fmtNum(d.elevation.min)}–${fmtNum(d.elevation.max)} ft (+${fmtNum(d.elevation.gain)} / −${fmtNum(d.elevation.loss)} ft, ${src})`]);
  }
  const w = d.weather;
  if (w) {
    const bits = [];
    if (w.peakGustMph != null) bits.push(`gusts to ${w.peakGustMph} mph`);
    if (w.peakHeatF != null) bits.push(`high near ${w.peakHeatF}°F`);
    if (w.minColdF != null) bits.push(`low near ${w.minColdF}°F`);
    if (w.minWindChillF != null && (w.minColdF == null || w.minWindChillF < w.minColdF - 2)) bits.push(`wind chill ${w.minWindChillF}°F`);
    if (w.maxPrecipIn > 0) bits.push(`precip max ${w.maxPrecipIn} in`);
    if (w.maxSnowIn > 0) bits.push(`snow max ${w.maxSnowIn} in`);
    if (w.maxIceIn > 0) bits.push(`ice max ${w.maxIceIn} in`);
    if (w.maxThunderPct > 0) bits.push(`thunder ${w.maxThunderPct}%`);
    if (bits.length) rows.push(['Forecast extrema', bits.join(', ')]);
  }
  const c = d.conditions;
  if (c && c.modeledPoints > 0) {
    const bits = [`${fmtNum(c.modeledPoints)} sample points`];
    if (c.maxSlopeDeg > 0) bits.push(`max slope ${c.maxSlopeDeg}°`);
    if (c.horizonShadedPoints > 0) bits.push(`${fmtNum(c.horizonShadedPoints)} ridge-shaded`);
    if (c.maxSnowDepthIn >= 0.5) bits.push(`snow up to ${c.maxSnowDepthIn} in`);
    if (c.maxSnowmelt24hMm >= 3) bits.push(`24 h melt ${c.maxSnowmelt24hMm} mm`);
    if (c.maxRunoff48hMm >= 10) bits.push(`48 h runoff ${c.maxRunoff48hMm} mm`);
    rows.push(['Conditions & hydrology', bits.join(', ')]);
  }
  const o = d.overlays;
  if (o && o.total > 0) {
    const bits = [`${o.kept} of ${o.total} layers (${fmtNum(o.vertices)} vertices)`];
    if (o.simplified > 0) bits.push(`${o.simplified} simplified`);
    if (o.dropped > 0) bits.push(`${o.dropped} trimmed for size`);
    rows.push(['Map overlays', bits.join(', ')]);
  }
  return rows;
};

const diagnosticsSection = (diagnostics) => {
  const rows = diagnosticSummaryRows(diagnostics);
  if (!rows.length) return null;
  return h('details', { class: 'behind sources-diagnostics', 'data-open-key': 'diagnostics' },
    h('summary', {}, icon('chevron'), 'Model & payload diagnostics'),
    h('dl', { class: 'diag-list' }, rows.map(([k, v]) => h('div', { class: 'diag-row' }, h('dt', {}, k), h('dd', {}, v)))));
};

/** createSources(container).render({ result, now }) */
export const createSources = (container) => {
  const changed = changeDetector();

  const render = ({ result, now = Date.now() }) => {
    if (!changed([result, Math.floor(now / 60000)])) return;
    if (!result) {
      remount(container, h('p', { class: 'empty' }, 'Source status appears here when the check finishes.'), footer());
      return;
    }
    const { attention, healthy } = partitionSources(result.sources);
    remount(container,
      h('p', { class: `sources-summary${attention.length ? ' has-issues' : ''}` },
        icon(attention.length ? 'warning' : 'ok'),
        sourceHealthSummary(result.sources)),
      attention.length ? h('ul', { class: 'source-list source-list-attention', 'aria-label': 'Sources needing attention' },
        attention.map(key => sourceRow(key, result.sources[key], now, { collapsible: false }))) : null,
      healthy.length ? h('ul', { class: 'source-list', 'aria-label': 'Healthy sources' },
        healthy.map(key => sourceRow(key, result.sources[key], now, { collapsible: true }))) : null,
      diagnosticsSection(result.diagnostics),
      footer());
  };

  return { render };
};
