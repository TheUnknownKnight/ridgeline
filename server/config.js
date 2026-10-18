const env = process.env;

const intEnv = (name, fallback) => {
  const v = Number.parseInt(env[name], 10);
  return Number.isFinite(v) ? v : fallback;
};

const contact = env.CONTACT_EMAIL || 'contact@ridgeline.invalid';

const config = {
  port: intEnv('PORT', 3000),
  // `node server/index.js --production` works on every shell (no NODE_ENV=… syntax needed on Windows).
  isProduction: env.NODE_ENV === 'production' || process.argv.includes('--production'),
  // NWS asks API clients to identify themselves with a contact address.
  userAgent: `Ridgeline/2.0 (backcountry route hazard checker; ${contact})`,
  rateLimitPerMinute: intEnv('RATE_LIMIT_PER_MIN', 30),
  // Full-route uploads (new route models, cold upstream fan-out) per IP per minute.
  uploadLimitPerMinute: intEnv('UPLOAD_LIMIT_PER_MIN', 6),
  // Number of reverse-proxy hops to trust for req.ip (0 = use the socket address).
  trustProxy: intEnv('TRUST_PROXY', 0),
  logUpstream: env.LOG_UPSTREAM === '1',
  maxBodyBytes: '4mb',
};

export default config;
