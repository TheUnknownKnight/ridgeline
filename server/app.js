import express from 'express';
import compression from 'compression';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { createApiRouter } from './api/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

// Map styles, tiles, glyphs and fonts are third-party; everything else is same-origin.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://tiles.openfreemap.org https://s3.amazonaws.com",
  "connect-src 'self' https://tiles.openfreemap.org https://s3.amazonaws.com https://elevation-tiles-prod.s3.amazonaws.com",
  "worker-src 'self' blob:",
  "child-src blob:",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/**
 * Build the Express app. `analyze` is injectable so API tests can run
 * without touching upstream services.
 */
export const createApp = ({ analyze, serveStatic = config.isProduction } = {}) => {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
    if (serveStatic) res.setHeader('Content-Security-Policy', CSP);
    next();
  });

  // Analyses of long routes are a few hundred KB of JSON; gzip cuts that ~8x for trail-side connections.
  app.use(compression());
  app.use('/api', createApiRouter({ analyze }));

  if (serveStatic && fs.existsSync(DIST)) {
    app.use(express.static(DIST, {
      index: false,
      setHeaders: (res, filePath) => {
        // Vite fingerprints everything under /assets; the shell and service worker must revalidate.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    }));
    app.get(/^\/(?!api\/).*/, (req, res) => {
      // A missing asset must 404, not get the HTML shell (which breaks module loading and poisons caches).
      if (req.path.startsWith('/assets/') || path.extname(req.path)) {
        return res.status(404).type('text/plain').send('Not found');
      }
      res.setHeader('Cache-Control', 'no-cache');
      // `root` keeps send's dotfile check off the install path (e.g. ~/.gemini/…).
      res.sendFile('index.html', { root: DIST });
    });
  }

  // Malformed JSON, oversized bodies and anything unexpected end up here.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Route is too large to upload. Try a simplified GPX.', code: 'too_large' });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body is not valid JSON', code: 'invalid_json' });
    }
    const status = Number(err.status || err.statusCode);
    if (status >= 400 && status < 500) return res.status(status).json({ error: 'Request failed', code: 'bad_request' });
    console.error('[server] unhandled error:', err);
    res.status(500).json({ error: 'Internal error', code: 'internal' });
  });

  return app;
};
