/**
 * Saved routes, last results and official-hazard snapshots in IndexedDB.
 *
 * Every method is async and fail-soft: when IndexedDB is missing, blocked
 * (some private modes) or out of quota, data lives in memory for the session
 * instead, and callers never see an exception.
 *
 * Stores: routes { id, name, coords, meta, addedAt, openedAt },
 *         results  key → { result, savedAt },
 *         snapshots key → snapshot (see diff.js).
 * Result and snapshot keys are per route and mode: resultKey(routeId, mode).
 */

const DB_NAME = 'ridgeline';
const DB_VERSION = 1;
const MAX_ROUTES = 20;
const MODES = ['planning', 'on-trail'];

const memory = { routes: new Map(), results: new Map(), snapshots: new Map() };

let dbPromise = null;

const openDb = () => {
  dbPromise ??= new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('routes')) db.createObjectStore('routes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('results')) db.createObjectStore('results');
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots');
    };
    req.onsuccess = () => {
      const db = req.result;
      // Let a newer version in another tab upgrade instead of being blocked by us.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
};

const transact = async (store, mode, work) => {
  const db = await openDb();
  if (!db) throw new Error('IndexedDB unavailable');
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = work(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

// Memory only holds values whose latest write could not be persisted, so it wins.
const read = async (store, key) => {
  if (memory[store].has(key)) return memory[store].get(key);
  try {
    return (await transact(store, 'readonly', s => s.get(key))) ?? null;
  } catch {
    return null;
  }
};

const readAll = async (store) => {
  const out = new Map();
  try {
    const values = await transact(store, 'readonly', s => s.getAll());
    for (const v of values || []) out.set(v.id, v);
  } catch { /* memory only */ }
  for (const [key, value] of memory[store]) out.set(key, value);
  return [...out.values()];
};

const write = async (store, key, value) => {
  try {
    await transact(store, 'readwrite', s => (store === 'routes' ? s.put(value) : s.put(value, key)));
    memory[store].delete(key);
  } catch {
    memory[store].set(key, value);
  }
};

const remove = async (store, key) => {
  memory[store].delete(key);
  try {
    await transact(store, 'readwrite', s => s.delete(key));
  } catch { /* nothing persisted to remove */ }
};

export const resultKey = (routeId, mode) => `${routeId}:${mode}`;

/** Route summaries (no coordinates), most recently opened first. */
export const listRoutes = async () => (await readAll('routes'))
  .sort((a, b) => b.openedAt - a.openedAt)
  .map(({ id, name, meta, offlinePack, addedAt, openedAt }) => ({ id, name, meta: meta || {}, offlinePack: offlinePack || null, addedAt, openedAt }));

export const getRoute = (id) => read('routes', id);

export const removeRoute = async (id) => {
  await remove('routes', id);
  await Promise.all(MODES.flatMap(mode => [
    remove('results', resultKey(id, mode)),
    remove('snapshots', resultKey(id, mode)),
  ]));
};

const evictOldRoutes = async () => {
  const routes = await listRoutes();
  await Promise.all(routes.slice(MAX_ROUTES).map(r => removeRoute(r.id)));
};

/** Save (or re-save) a route from buildRouteData() and mark it opened now. */
export const saveRoute = async (route) => {
  const now = Date.now();
  const existing = await read('routes', route.id);
  await write('routes', route.id, {
    id: route.id,
    name: route.name,
    coords: route.coords,
    meta: { ...route.meta, lengthMiles: route.lengthMiles },
    offlinePack: existing?.offlinePack ?? null,
    addedAt: existing?.addedAt ?? now,
    openedAt: now,
  });
  await evictOldRoutes();
};

export const saveOfflineMeta = async (id, offlinePack) => {
  const stored = await read('routes', id);
  if (stored) await write('routes', id, { ...stored, offlinePack });
};

export const touchRoute = async (id) => {
  const stored = await read('routes', id);
  if (stored) await write('routes', id, { ...stored, openedAt: Date.now() });
};

/** { result, savedAt } or null. */
export const getResult = (key) => read('results', key);

export const saveResult = (key, result) => write('results', key, { result, savedAt: Date.now() });

export const getSnapshot = (key) => read('snapshots', key);

export const saveSnapshot = (key, snapshot) => write('snapshots', key, snapshot);
