/**
 * Capacitor native HTTP bridge for Ridgeline's on-device hazard engine.
 * Routes all federal upstream fetches through iOS URLSession / Android OkHttp
 * via CapacitorHttp so there are zero CORS errors, full NWS User-Agent support,
 * and zero shared backend server IP rate limits.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { setHttpTransport } from '../../../server/lib/http.js';

const serializeBody = (body) => {
  if (body == null) return undefined;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
  if (typeof body === 'string') return body;
  return body;
};

/**
 * Build a transport compatible with `server/lib/http.js#setHttpTransport`.
 * Exported as a factory so unit tests can inject a stubbed CapacitorHttp client.
 */
export const createCapacitorTransport = (httpClient = CapacitorHttp) => async (url, { method = 'GET', headers = {}, body, timeoutMs = 12000, as = 'json' } = {}) => {
  const responseType = as === 'buffer' ? 'arraybuffer' : as === 'json' ? 'json' : 'text';
  const req = {
    url,
    method: String(method || 'GET').toUpperCase(),
    headers: { ...headers },
    connectTimeout: timeoutMs,
    readTimeout: timeoutMs,
    responseType,
  };
  const data = serializeBody(body);
  if (data !== undefined) req.data = data;

  const res = await httpClient.request(req);
  return {
    status: Number(res?.status ?? 0),
    headers: res?.headers || {},
    data: res?.data,
  };
};

let installed = false;

/** Install the native HTTP transport and pull optional remote endpoint overrides in the background. */
export const installNativeHttpBridge = ({ httpClient = CapacitorHttp, endpointsUrl } = {}) => {
  if (installed || !Capacitor.isNativePlatform()) return false;
  setHttpTransport(createCapacitorTransport(httpClient));
  installed = true;
  // Non-blocking: lazy-load localEngine so web builds keep the on-device engine cleanly split.
  import('../engine/localEngine.js')
    .then(({ loadRemoteEndpoints }) => loadRemoteEndpoints(endpointsUrl))
    .catch(() => {});
  return true;
};
