import { fetchJson } from './http.js';

const PAGE_SIZE = 2000;
const MAX_PAGES = 10;

/**
 * Every feature of an ArcGIS FeatureServer query, as GeoJSON features,
 * following exceededTransferLimit pages. ArcGIS reports query errors as
 * HTTP 200 with an `error` body, so those throw too.
 */
export const queryAllGeoJson = async (url, params, label, { timeoutMs = 20000, retries = 2 } = {}) => {
  const features = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      ...params,
      f: 'geojson',
      outSR: '4326',
      resultOffset: String(page * PAGE_SIZE),
      resultRecordCount: String(PAGE_SIZE),
    });
    const data = await fetchJson(`${url}?${qs}`, { label, timeoutMs, retries });
    if (data?.error) throw new Error(`${label} query error: ${JSON.stringify(data.error).slice(0, 200)}`);
    if (!Array.isArray(data?.features)) throw new Error(`${label} response missing features[]`);
    features.push(...data.features);
    const more = data.exceededTransferLimit || data.properties?.exceededTransferLimit;
    if (!more || data.features.length === 0) return features;
  }
  console.warn(`[arcgis] ${label}: stopped after ${MAX_PAGES} pages`);
  return features;
};
