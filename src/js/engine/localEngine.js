import { setEndpointOverrides } from '../../../server/config.js';
import { fetchJson } from '../../../server/lib/http.js';
import { validateAnalyzeRequest } from '../../../server/lib/validate.js';
import { analyze } from '../../../server/fusion/engine.js';

export const DEFAULT_ENDPOINTS_URL = 'https://theunknownknight.github.io/ridgeline/endpoints.json';

/**
 * Run the hazard-fusion engine directly on-device with corridor-scoped federal
 * queries so mobile checks download only data near the route.
 */
export const analyzeLocally = async (payload, { signal, ...engineOpts } = {}) => {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  const req = validateAnalyzeRequest(payload);
  const result = await analyze(req, { scope: 'corridor', ...engineOpts });
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  return result;
};

/**
 * Optionally fetch remote endpoint overrides (e.g. GitHub Pages `endpoints.json`)
 * without blocking or failing startup if offline or unreachable.
 */
export const loadRemoteEndpoints = async (url = DEFAULT_ENDPOINTS_URL) => {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const data = await fetchJson(url.trim(), { label: 'endpoint overrides', timeoutMs: 4000, retries: 0 });
    const overrides = data && typeof data.endpoints === 'object' && data.endpoints !== null ? data.endpoints : data;
    if (!overrides || typeof overrides !== 'object') return null;
    setEndpointOverrides(overrides);
    return overrides;
  } catch {
    return null;
  }
};
