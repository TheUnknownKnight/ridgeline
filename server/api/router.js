import express from 'express';
import { randomUUID } from 'node:crypto';
import config from '../config.js';
import { analyze as defaultAnalyze } from '../fusion/engine.js';
import { RouteUnknownError } from '../fusion/route.js';
import { validateAnalyzeRequest, ValidationError } from '../lib/validate.js';
import { rateLimit, createLimiter, clientKey, sendRateLimited } from '../lib/rateLimit.js';
import { sourceCache } from '../lib/cache.js';

export const createApiRouter = ({ analyze = defaultAnalyze } = {}) => {
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

  router.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000), cache: sourceCache.stats() });
  });

  router.use((req, res) => res.status(404).json({ error: 'Not found', code: 'not_found' }));

  return router;
};
