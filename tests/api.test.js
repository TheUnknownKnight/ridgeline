import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { RouteUnknownError } from '../server/fusion/route.js';
import { straightCoords } from './helpers.js';

const withServer = async (opts, fn) => {
  const server = createApp(opts).listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise(r => server.close(r));
  }
};

const post = (base, body, raw = false) => fetch(`${base}/api/analyze`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: raw ? body : JSON.stringify(body),
});

test('api: validation errors are 400 JSON with a code; no stack traces', async () => {
  await withServer({ analyze: async () => ({}) }, async (base) => {
    const bad = await post(base, { coordinates: 'nope' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'invalid_route');
    const malformed = await post(base, '{"coordinates":', true);
    assert.equal(malformed.status, 400);
    const text = await malformed.text();
    assert.ok(!text.includes('node_modules'), 'no stack trace leaks');
    assert.equal(JSON.parse(text).code, 'invalid_json');
  });
});

test('api: oversized bodies get 413, unknown routes 409, unknown paths 404', async () => {
  const analyze = async (req) => { if (req.routeHash) throw new RouteUnknownError(); return {}; };
  await withServer({ analyze }, async (base) => {
    const huge = await post(base, `{"coordinates":[${'[1,2],'.repeat(800000)}[1,2]]}`, true);
    assert.equal(huge.status, 413);
    const unknown = await post(base, { routeHash: '0123456789abcdef' });
    assert.equal(unknown.status, 409);
    assert.equal((await unknown.json()).code, 'route_unknown');
    const nf = await fetch(`${base}/api/nope`);
    assert.equal(nf.status, 404);
  });
});

test('api: analysis failures are generic 500s with a request id', async () => {
  await withServer({ analyze: async () => { throw new Error('secret internal detail'); } }, async (base) => {
    const res = await post(base, { coordinates: straightCoords(2) });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.code, 'analysis_failed');
    assert.ok(body.requestId);
    assert.ok(!JSON.stringify(body).includes('secret'));
  });
});

test('static: serves the app shell (even under a dot-directory) and 404s missing assets', async (t) => {
  const { existsSync } = await import('node:fs');
  if (!existsSync(new URL('../dist/index.html', import.meta.url))) return t.skip('run `npm run build` first');
  await withServer({ analyze: async () => ({}), serveStatic: true }, async (base) => {
    const shell = await fetch(`${base}/`);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get('content-type'), /html/);
    assert.ok(shell.headers.get('content-security-policy'));
    assert.equal((await fetch(`${base}/some/deep/link`)).status, 200);
    assert.equal((await fetch(`${base}/assets/missing-abc123.js`)).status, 404);
    assert.equal((await fetch(`${base}/favicon.ico`)).status, 404);
  });
});

test('api: security headers, health, no x-powered-by', async () => {
  await withServer({ analyze: async () => ({}) }, async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal((await res.json()).ok, true);
  });
});
