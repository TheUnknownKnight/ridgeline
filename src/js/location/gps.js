/**
 * The hiker's position for On trail mode.
 *
 * States: off → acquiring → live; a live fix with nothing newer for 5 min
 * becomes stale; permission refused → denied; no GPS or no fix →
 * unavailable, or stale with the last saved fix when there is one; a
 * position picked on the map → manual (until clearManual()).
 *
 * The last real fix is saved to localStorage so a page reloaded in a canyon
 * can still show where the hiker was.
 */

const STORAGE_KEY = 'ridgeline:last-fix';
const STALE_AFTER_MS = 5 * 60 * 1000;
const WATCH_OPTIONS = { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 };
const PERMISSION_DENIED = 1;

const saveFix = (fix) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fix));
  } catch { /* storage blocked: the fix just won't survive a reload */ }
};

const loadFix = () => {
  try {
    const fix = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const valid = fix && Number.isFinite(fix.lat) && Number.isFinite(fix.lng) && Number.isFinite(fix.timestamp);
    return valid ? { lat: fix.lat, lng: fix.lng, accuracyMeters: fix.accuracyMeters ?? null, timestamp: fix.timestamp } : null;
  } catch {
    return null;
  }
};

const fixFrom = (pos) => ({
  lat: pos.coords.latitude,
  lng: pos.coords.longitude,
  accuracyMeters: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
  timestamp: pos.timestamp || Date.now(),
});

export const createGps = ({ onChange } = {}) => {
  let current = { state: 'off', fix: null };
  let watchId = null;
  let staleTimer = null;
  let wanted = false;

  const emit = (next) => {
    current = next;
    onChange?.(current);
  };

  const stopWatch = () => {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    clearTimeout(staleTimer);
  };

  const scheduleStale = (fix) => {
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      if (current.state === 'live' && current.fix === fix) emit({ state: 'stale', fix });
    }, Math.max(0, fix.timestamp + STALE_AFTER_MS - Date.now()));
  };

  const fallBack = () => {
    const saved = loadFix();
    emit(saved ? { state: 'stale', fix: saved } : { state: 'unavailable', fix: null });
  };

  const onPosition = (pos) => {
    if (current.state === 'manual') return;
    const fix = fixFrom(pos);
    saveFix(fix);
    if (Date.now() - fix.timestamp < STALE_AFTER_MS) {
      emit({ state: 'live', fix });
      scheduleStale(fix);
    } else {
      emit({ state: 'stale', fix });
    }
  };

  const onError = (err) => {
    if (current.state === 'manual') return;
    if (err.code === PERMISSION_DENIED) {
      stopWatch();
      emit({ state: 'denied', fix: null });
      return;
    }
    // A timeout between fixes keeps the last one; the stale timer ages it.
    if (current.fix && (current.state === 'live' || current.state === 'stale')) return;
    fallBack();
  };

  const start = () => {
    wanted = true;
    if (current.state === 'manual' || watchId != null) return;
    if (!('geolocation' in navigator)) {
      fallBack();
      return;
    }
    emit({ state: 'acquiring', fix: null });
    watchId = navigator.geolocation.watchPosition(onPosition, onError, WATCH_OPTIONS);
  };

  const stop = () => {
    wanted = false;
    stopWatch();
    emit({ state: 'off', fix: null });
  };

  const setManual = ({ lat, lng }) => {
    stopWatch();
    emit({ state: 'manual', fix: { lat, lng, accuracyMeters: null, timestamp: Date.now() } });
  };

  const clearManual = () => {
    if (current.state !== 'manual') return;
    current = { state: 'off', fix: null };
    if (wanted) start();
    else emit(current);
  };

  return { start, stop, setManual, clearManual, getState: () => current };
};
