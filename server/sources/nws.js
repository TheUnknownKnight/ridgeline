import { getCached } from '../cache.js';

const UA = '(ridgeline-app, dev@ridgeline.local)';

/**
 * Look up the NWS grid cell for a lat/lon coordinate.
 * Cached by rounded lat,lon — returns { gridId, gridX, gridY, forecastGridDataUrl }.
 */
const getNWSGridMeta = async (lat, lon) => {
  const cacheKey = `nws-points-${lat.toFixed(4)},${lon.toFixed(4)}`;

  return getCached(cacheKey, 3600, async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const pointsUrl = `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
    
    let pointsRes;
    let pointsData;
    try {
      pointsRes = await fetch(pointsUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'application/geo+json' },
        signal: controller.signal
      });
      if (!pointsRes.ok) {
        const text = await pointsRes.text().catch(() => '');
        throw new Error(`NWS /points failed (${pointsRes.status}): ${text.slice(0, 200)}`);
      }
      pointsData = await pointsRes.json();
    } finally {
      clearTimeout(timeout);
    }

    const props = pointsData.properties || {};
    const gridDataUrl = props.forecastGridData;
    if (!gridDataUrl) {
      throw new Error('NWS returned no forecastGridData URL');
    }

    return {
      gridId: props.gridId,
      gridX: props.gridX,
      gridY: props.gridY,
      forecastGridDataUrl: gridDataUrl
    };

    return {
      gridId: props.gridId,
      gridX: props.gridX,
      gridY: props.gridY,
      forecastGridDataUrl: gridDataUrl
    };
  });
};

/**
 * Fetch grid-level forecast data, cached by gridId/gridX,gridY so that
 * multiple nearby lat/lon pairs that map to the same NWS grid cell share
 * a single HTTP request.
 */
const getNWSGridData = async (gridMeta) => {
  const cacheKey = `nws-grid-${gridMeta.gridId}/${gridMeta.gridX},${gridMeta.gridY}`;

  return getCached(cacheKey, 3600, async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    let res;
    let data;
    try {
      res = await fetch(gridMeta.forecastGridDataUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: controller.signal
      });
      if (!res.ok) return null;
      data = await res.json();
    } finally {
      clearTimeout(timeout);
    }
    return data;
  });
};

/**
 * Fetch active NWS alerts for a specific point, cached by lat,lon
 * since alerts are point-specific.
 */
const getNWSAlerts = async (lat, lon) => {
  const cacheKey = `nws-alerts-${lat.toFixed(4)},${lon.toFixed(4)}`;

  return getCached(cacheKey, 3600, async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    let res;
    let data;
    try {
      const alertsUrl = `https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`;
      res = await fetch(alertsUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'application/geo+json' },
        signal: controller.signal
      });
      if (!res.ok) return [];
      data = await res.json();
    } finally {
      clearTimeout(timeout);
    }
    return data.features || [];
  });
};

export const getNWSForecast = async (lat, lon) => {
  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);
  if (isNaN(latNum) || isNaN(lonNum)) {
    throw new Error(`Invalid coordinates: ${lat}, ${lon}`);
  }

  // Tier 1: /points lookup (cached by lat,lon)
  const gridMeta = await getNWSGridMeta(latNum, lonNum);

  // Tier 2: grid data (cached by gridId/gridX,gridY) + alerts (cached by lat,lon)
  const [gridData, alerts] = await Promise.all([
    getNWSGridData(gridMeta),
    getNWSAlerts(latNum, lonNum)
  ]);

  return {
    gridId: gridMeta.gridId,
    forecast: {
      precipitation: gridData?.properties?.quantitativePrecipitation?.values || [],
      snowfall: gridData?.properties?.snowfallAmount?.values || [],
      snowLevel: gridData?.properties?.snowLevel?.values || [],
      temperature: gridData?.properties?.temperature?.values || [],
      windSpeed: gridData?.properties?.windSpeed?.values || []
    },
    alerts
  };
};
