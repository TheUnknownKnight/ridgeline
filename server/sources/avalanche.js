import { getCached } from '../cache.js';
import bbox from '@turf/bbox';
import simplify from '@turf/simplify';

const AVALANCHE_URL = 'https://api.avalanche.org/v2/public/products/map-layer';

export const getAvalancheMap = async () => {
  return getCached('avalanche-map-layer', 21600, async () => {
    console.log('[AVY] Fetching avalanche map layer...');
    const res = await fetch(AVALANCHE_URL, {
      headers: { 'User-Agent': '(ridgeline-app, dev@ridgeline.local)' }
    });

    if (!res.ok) {
      console.error(`[AVY] HTTP ${res.status}`);
      return { type: 'FeatureCollection', features: [] };
    }

    const data = await res.json();
    
    // Simplify geometry to reduce memory overhead and speed up PiP checks
    // Attach bounding box to each feature to speed up spatial filtering
    if (data.features) {
      data.features.forEach(feature => {
        if (feature.geometry) {
          // 0.001 degrees is ~111 meters, plenty accurate for backcountry avalanche zones
          try {
            const simplified = simplify(feature, { tolerance: 0.001, highQuality: false });
            feature.geometry = simplified.geometry;
          } catch (e) {
            console.error('Simplify error on avy zone:', e.message);
          }
          feature.bbox = bbox(feature);
        }
      });
    }

    console.log(`[AVY] Loaded ${data.features?.length || 0} forecast zones with cached bboxes`);
    return data;
  });
};

