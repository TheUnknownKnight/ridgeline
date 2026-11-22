const env = typeof process !== 'undefined' && process.env ? process.env : {};
const argv = typeof process !== 'undefined' && Array.isArray(process.argv) ? process.argv : [];

const intEnv = (name, fallback) => {
  const v = Number.parseInt(env[name], 10);
  return Number.isFinite(v) ? v : fallback;
};

const contact = env.CONTACT_EMAIL || 'https://github.com/TheUnknownKnight/ridgeline';

let endpointOverrides = {};

const NESTED_ENDPOINT_MAP = [
  ['nifcPerimeters', (o) => o?.nifc?.perimeters],
  ['nifcIncidents', (o) => o?.nifc?.incidents],
  ['airnowContours', (o) => o?.airnow?.contours],
  ['airnowMonitors', (o) => o?.airnow?.monitors],
  ['nwpsService', (o) => o?.nwps?.service],
  ['nwsAlerts', (o) => o?.nws?.alerts],
  ['nwsZones', (o) => o?.nws?.zones],
  ['snodasService', (o) => o?.snodas?.base],
  ['usfsTrails', (o) => o?.usfsTrails?.query],
  ['npsTrails', (o) => o?.npsTrails?.query],
];

/**
 * Install optional remote endpoint URL overrides (e.g. from docs/endpoints.json)
 * so federal API URL changes can be patched without an app release.
 * Accepts both flat key-value maps and the nested docs/endpoints.json layout.
 */
export const setEndpointOverrides = (overrides) => {
  if (!overrides || typeof overrides !== 'object') {
    endpointOverrides = {};
    return;
  }
  const src = overrides.endpoints && typeof overrides.endpoints === 'object' ? overrides.endpoints : overrides;
  const next = {};
  const put = (key, value) => {
    if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) {
      next[key] = value.trim();
    }
  };
  for (const [key, value] of Object.entries(src)) put(key, value);
  for (const [key, pick] of NESTED_ENDPOINT_MAP) {
    if (!next[key]) put(key, pick(src));
  }
  endpointOverrides = next;
};

/** Return the remote override URL for `key` if configured, otherwise `fallback`. */
export const endpointUrl = (key, fallback) => {
  const override = endpointOverrides[key];
  return typeof override === 'string' && override.length > 0 ? override : fallback;
};

const config = {
  port: intEnv('PORT', 3000),
  // `node server/index.js --production` works on every shell (no NODE_ENV=… syntax needed on Windows).
  isProduction: env.NODE_ENV === 'production' || argv.includes('--production'),
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
