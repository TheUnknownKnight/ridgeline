/**
 * "Data": where every part of the answer came from, how fresh it is, and
 * what failed. Status is always an icon plus words, never color alone.
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
  skipped: { icon: 'skipped', text: 'Not used for this check' },
};

const extLink = (url, text) => {
  const href = safeUrl(url);
  if (!href) return text;
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' },
    text, h('span', { class: 'visually-hidden' }, ' (opens in a new tab)'));
};

/** "Sampled every 1 mi along Mi 99–115, next 72 h" for model-backed sources. */
const coverageText = (source) => {
  const parts = [];
  if (source.sampledEveryMiles) {
    const along = Array.isArray(source.range) ? ` along Mi ${fmtMile(source.range[0])}–${fmtMile(source.range[1])}` : '';
    parts.push(`Sampled every ${fmtMile(source.sampledEveryMiles)} mi${along}`);
  }
  if (source.horizonHours) parts.push(`next ${source.horizonHours} h`);
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

const sourceRow = (key, source, now) => {
  const status = STATUS[source?.status] || STATUS.error;
  const fetched = Date.parse(source?.fetchedAt);
  const coverage = source ? coverageText(source) : '';
  return h('li', { class: `source source-${source?.status || 'error'}` },
    h('div', { class: 'source-head' },
      h('span', { class: 'source-name' }, SOURCE_LABELS[key] || key),
      h('span', { class: 'status' }, icon(status.icon), status.text)),
    source?.message ? h('p', { class: 'source-message' }, source.message) : null,
    coverage ? h('p', { class: 'source-meta' }, coverage) : null,
    h('p', { class: 'source-meta' },
      Number.isFinite(Date.parse(source?.validAt)) ? `Readings from ${fmtAgo(Date.parse(source.validAt), now)}. ` : null,
      Number.isFinite(fetched) ? `Fetched ${fmtAgo(fetched, now)}. ` : null,
      source?.attribution ? extLink(source.url, source.attribution) : 'Source unknown'),
    key === 'avalanche' ? avalancheCoverage(source?.coverage) : null,
    key === 'air' ? monitorLine(source?.nearestMonitor) : null);
};

const footer = () => h('footer', { class: 'sources-footer' },
  h('p', { class: 'disclaimer' },
    'Ridgeline summarizes public data. Conditions change fast — always check with the land manager and official forecasts before you go.'),
  h('p', {},
    'Data from the National Interagency Fire Center (WFIGS), the National Weather Service, avalanche.org, the NOAA National Water Prediction Service, ',
    'EPA AirNow, the NOAA National Air Quality Forecast Capability and the NOAA Hazard Mapping System. ',
    'Recent rainfall, and air quality where NOAA has no forecast, from ', extLink('https://open-meteo.com/', 'Open-Meteo'),
    ' (', extLink('https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0'),
    '), which contains modified Copernicus Atmosphere Monitoring Service information.'));

/** createSources(container).render({ result, now }) */
export const createSources = (container) => {
  const changed = changeDetector();

  const render = ({ result, now = Date.now() }) => {
    if (!changed([result, Math.floor(now / 60000)])) return;
    if (!result) {
      remount(container, h('p', { class: 'empty' }, 'Source status appears here when the check finishes.'), footer());
      return;
    }
    remount(container,
      h('ul', { class: 'source-list' }, SOURCE_KEYS.map(key => sourceRow(key, result.sources[key], now))),
      footer());
  };

  return { render };
};
