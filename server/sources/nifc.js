import { getCached } from '../cache.js';
import bbox from '@turf/bbox';
import simplify from '@turf/simplify';

const NIFC_BASE = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services';
const PERIMETERS_URL = `${NIFC_BASE}/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query`;

export const getFires = async (routeBbox) => {
  const cacheKey = `nifc-${routeBbox}`;

  return getCached(cacheKey, 900, async () => {
    let allFeatures = [];
    let offset = 0;
    const limit = 2000;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({
        where: '1=1', // Endpoint natively filters to active fires only
        outFields: '*',
        f: 'geojson',
        outSR: '4326',
        returnGeometry: 'true',
        geometryType: 'esriGeometryEnvelope',
        spatialRel: 'esriSpatialRelIntersects',
        geometry: routeBbox,
        inSR: '4326',
        resultOffset: offset.toString(),
        resultRecordCount: limit.toString()
      });

      const url = `${PERIMETERS_URL}?${params}`;
      if (offset === 0) console.log('[NIFC] Querying:', url.slice(0, 120) + '...');
      
      const fetchStart = Date.now();
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`[NIFC] HTTP ${res.status}`);
        break;
      }
      const fetchTime = Date.now() - fetchStart;

      const parseStart = Date.now();
      const data = await res.json();
      const parseTime = Date.now() - parseStart;
      
      if (data.error) {
        console.error('[NIFC] API error:', data.error);
        break;
      }

      const features = data.features || [];
      
      const bboxStart = Date.now();
      // Simplify geometry and pre-compute bbox for spatial pre-filtering inside the engine
      features.forEach(f => {
        if (f.geometry) {
          // 0.0005 degrees is ~55 meters, accurate enough for fire boundaries
          try {
            const simplified = simplify(f, { tolerance: 0.0005, highQuality: false });
            f.geometry = simplified.geometry;
          } catch (e) {
            console.error('Simplify error on fire perimeter:', e.message);
          }
          f.bbox = bbox(f);
        }
      });
      const bboxTime = Date.now() - bboxStart;
      
      console.log(`[NIFC] Page timing: Fetch=${fetchTime}ms, Parse=${parseTime}ms, BBoxCompute=${bboxTime}ms for ${features.length} features`);

      allFeatures = allFeatures.concat(features);

      if (features.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
      }
    }

    console.log(`[NIFC] Found ${allFeatures.length} active fire perimeters with cached bboxes`);
    return { type: 'FeatureCollection', features: allFeatures };
  });
};
