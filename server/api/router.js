import express from 'express';
import { randomUUID } from 'node:crypto';
import config from '../config.js';
import { analyze as defaultAnalyze } from '../fusion/engine.js';
import { RouteUnknownError } from '../fusion/route.js';
import { validateAnalyzeRequest, ValidationError } from '../lib/validate.js';
import { rateLimit, createLimiter, clientKey, sendRateLimited } from '../lib/rateLimit.js';
import { sourceCache } from '../lib/cache.js';
import {
  searchPublicTrails as defaultSearchTrails,
  fetchPublicTrailGeometry as defaultFetchTrailGeometry,
} from '../sources/trailSearch.js';

const cleanQueryString = (raw, maxLen) => {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new ValidationError('Query parameter must be a string', 'invalid_query');
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLen);
};

const parseTrailSearchQuery = (query) => {
  const q = cleanQueryString(query.q, 80);

  const hasLat = query.lat !== undefined && query.lat !== '';
  const hasLon = query.lon !== undefined && query.lon !== '';
  let lat = null;
  let lon = null;
  if (hasLat !== hasLon) {
    throw new ValidationError('Provide both lat and lon for proximity search', 'invalid_location');
  }
  if (hasLat && hasLon) {
    lat = Number(query.lat);
    lon = Number(query.lon);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new ValidationError('lat and lon must be valid coordinates', 'invalid_location');
    }
  }

  if (q.length < 2 && lat == null) {
    throw new ValidationError('Provide a search query of at least 2 characters, or lat and lon coordinates', 'invalid_query');
  }

  let radiusMiles = 25;
  if (query.radius !== undefined && query.radius !== '') {
    const r = Number(query.radius);
    if (!Number.isFinite(r) || r <= 0) throw new ValidationError('radius must be a positive number', 'invalid_query');
    radiusMiles = Math.min(100, Math.max(1, r));
  }

  let limit = 20;
  if (query.limit !== undefined && query.limit !== '') {
    const l = Number(query.limit);
    if (!Number.isFinite(l) || l < 1) throw new ValidationError('limit must be a positive number', 'invalid_query');
    limit = Math.min(100, Math.max(1, Math.round(l)));
  }

  return { query: q, lat, lon, radiusMiles, limit };
};

const parseOptionalMile = (raw, field) => {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 10000) {
    throw new ValidationError(`${field} must be a valid non-negative mile number`, 'invalid_trail');
  }
  return n;
};

const parseTrailGeometryQuery = (query) => {
  const source = cleanQueryString(query.source, 16).toLowerCase();
  if (source !== 'usfs' && source !== 'nps' && source !== 'corridor') {
    throw new ValidationError('source must be "usfs", "nps", or "corridor"', 'invalid_source');
  }
  const name = cleanQueryString(query.name, 120);
  const trailNo = cleanQueryString(query.trailNo, 40) || null;
  const trailNoPrefix = cleanQueryString(query.trailNoPrefix, 40) || null;
  const corridorId = cleanQueryString(query.corridorId, 24).toLowerCase() || null;
  const unit = cleanQueryString(query.unit, 40) || null;
  const startMile = parseOptionalMile(query.startMile, 'startMile');
  const endMile = parseOptionalMile(query.endMile, 'endMile');

  if (source === 'corridor') {
    if (!corridorId) throw new ValidationError('Provide a corridorId for corridor geometry', 'invalid_trail');
  } else if (!name && !(source === 'usfs' && (trailNo || trailNoPrefix || corridorId))) {
    throw new ValidationError('Provide a trail name (or trailNo for USFS)', 'invalid_trail');
  }

  return { source, name, trailNo, trailNoPrefix, corridorId, unit, startMile, endMile };
};

export const createApiRouter = ({
  analyze = defaultAnalyze,
  searchTrails = defaultSearchTrails,
  fetchTrailGeometry = defaultFetchTrailGeometry,
} = {}) => {
  const router = express.Router();
  const startedAt = Date.now();

  // The general limit runs before the body is parsed, so rejected requests
  // cost nothing. Full-route uploads build a route model and fan out to every
  // upstream for cold points, so they get a smaller budget than the
  // routeHash refreshes that On-Trail use depends on.
  const allRequests = rateLimit({ perMinute: config.rateLimitPerMinute });
  const uploads = createLimiter({ perMinute: config.uploadLimitPerMinute });

  router.post('/analyze', allRequests, express.json({ limit: config.maxBodyBytes }), async (req, res) => {
    const requestId = randomUUID().slice(0, 8);
    const started = Date.now();
    let request;
    try {
      request = validateAnalyzeRequest(req.body);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message, code: err.code });
      throw err;
    }
    if (request.coords) {
      const r = uploads.take(clientKey(req));
      if (!r.ok) return sendRateLimited(res, r.retryAfterSec, 'Too many new routes');
    }

    try {
      const result = await analyze(request);
      res.set('Cache-Control', 'no-store');
      res.json(result);
      console.log(`[analyze ${requestId}] ${result.mode} ${result.route.lengthMiles.toFixed(1)}mi ` +
        `${result.segments.length} segments ${Object.keys(result.hazards).length} hazards ${Date.now() - started}ms`);
    } catch (err) {
      if (err instanceof RouteUnknownError) return res.status(409).json({ error: err.message, code: err.code });
      console.error(`[analyze ${requestId}] failed:`, err);
      res.status(500).json({ error: 'Analysis failed. Please try again.', code: 'analysis_failed', requestId });
    }
  });

  router.get('/trails/search', allRequests, async (req, res) => {
    const requestId = randomUUID().slice(0, 8);
    let params;
    try {
      params = parseTrailSearchQuery(req.query);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message, code: err.code });
      throw err;
    }

    try {
      const result = await searchTrails(params);
      res.set('Cache-Control', result.note ? 'no-store' : 'public, max-age=300');
      res.json({
        trails: result.trails,
        totalCount: result.totalCount ?? result.trails.length,
        corridor: result.corridor ?? null,
        note: result.note ?? null,
      });
    } catch (err) {
      console.error(`[trails/search ${requestId}] failed:`, err);
      res.status(502).json({ error: 'Trail search failed. Please try again.', code: 'trail_search_failed', requestId });
    }
  });

  router.get('/trails/geometry', allRequests, async (req, res) => {
    const requestId = randomUUID().slice(0, 8);
    let meta;
    try {
      meta = parseTrailGeometryQuery(req.query);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message, code: err.code });
      throw err;
    }

    try {
      const result = await fetchTrailGeometry(meta);
      res.set('Cache-Control', 'public, max-age=3600');
      res.json({ name: result.name, coords: result.coords, lengthMiles: result.lengthMiles });
    } catch (err) {
      if (err?.code === 'trail_not_found') {
        return res.status(404).json({ error: err.message, code: 'trail_not_found' });
      }
      console.error(`[trails/geometry ${requestId}] failed:`, err);
      res.status(502).json({ error: 'Could not load trail geometry. Please try again.', code: 'trail_geometry_failed', requestId });
    }
  });

  router.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000), cache: sourceCache.stats() });
  });

  router.use((req, res) => res.status(404).json({ error: 'Not found', code: 'not_found' }));

  return router;
};
