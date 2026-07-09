import NodeCache from 'node-cache';

// Shared cache instance
// stdTTL: 0 (unlimited by default, will override per item)
// checkperiod: 120 seconds
const cache = new NodeCache({ stdTTL: 0, checkperiod: 120, useClones: false });

export const getCached = async (key, ttl, fetchFn) => {
  const cachedVal = cache.get(key);
  if (cachedVal) {
    return cachedVal;
  }
  
  try {
    const freshVal = await fetchFn();
    cache.set(key, freshVal, ttl);
    return freshVal;
  } catch (error) {
    console.error(`Cache fetch error for key ${key}:`, error.message);
    throw error;
  }
};

export default cache;
