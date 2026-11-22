/**
 * Unified native runtime bridge for Capacitor iOS & Android (`com.nickb.ridgeline`).
 * Safely no-ops on desktop/mobile web browsers so one codebase serves both.
 */
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Filesystem, Encoding } from '@capacitor/filesystem';
import { StatusBar, Style } from '@capacitor/status-bar';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { installNativeHttpBridge } from './httpBridge.js';

export const isNativeApp = () => typeof Capacitor?.isNativePlatform === 'function' && Capacitor.isNativePlatform();

const ROUTE_EXT_RE = /\.(gpx|kml|geojson|json)$/i;

const fileNameFromUrl = (rawUrl) => {
  try {
    const clean = decodeURIComponent(String(rawUrl || '')).split(/[?#]/)[0];
    const base = clean.split('/').pop() || 'shared-route.gpx';
    return ROUTE_EXT_RE.test(base) ? base : `${base}.gpx`;
  } catch {
    return 'shared-route.gpx';
  }
};

const readOpenedRouteUrl = async (rawUrl) => {
  if (!rawUrl) return null;
  const textUrl = String(rawUrl);
  // Skip plain http(s) deep links that are not route files.
  if (/^https?:\/\//i.test(textUrl) && !ROUTE_EXT_RE.test(textUrl.split(/[?#]/)[0])) return null;
  try {
    const res = await Filesystem.readFile({ path: textUrl, encoding: Encoding.UTF8 });
    const text = typeof res?.data === 'string' ? res.data : '';
    if (!text.trim()) return null;
    return { name: fileNameFromUrl(textUrl), text };
  } catch (err) {
    console.warn('[ridgeline-native] could not read opened file:', err?.message || err);
    return null;
  }
};

const syncStatusBarTheme = async (theme) => {
  if (!isNativeApp()) return;
  try {
    const dark = theme !== 'light';
    await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
    if (Capacitor.getPlatform() === 'android') {
      await StatusBar.setBackgroundColor({ color: dark ? '#141916' : '#edf0ea' });
    }
  } catch { /* status bar plugin optional on some platforms */ }
};

let initialized = false;

/**
 * Bootstrap native Capacitor services on iOS/Android:
 * 1. Native HTTP transport (zero CORS, direct federal fetches, GitHub Pages endpoint overrides)
 * 2. Status bar dark/light theme synchronization
 * 3. OS "Open in Ridgeline" handler for .gpx / .kml / .geojson files
 */
export const initNativeApp = ({ onOpenRouteFile, initialTheme = 'dark' } = {}) => {
  if (!isNativeApp() || initialized) return false;
  initialized = true;

  installNativeHttpBridge();
  syncStatusBarTheme(initialTheme);
  window.addEventListener('ridgeline-theme', (e) => syncStatusBarTheme(e?.detail?.theme || 'dark'));

  const handleOpenUrl = async (url) => {
    const opened = await readOpenedRouteUrl(url);
    if (opened) onOpenRouteFile?.(opened);
  };

  App.addListener('appUrlOpen', ({ url }) => { handleOpenUrl(url); }).catch(() => {});
  App.getLaunchUrl().then((launch) => {
    if (launch?.url) handleOpenUrl(launch.url);
  }).catch(() => {});

  return true;
};

/** Native screen wake lock (falls back to returning false on web so browser Wake Lock runs). */
export const setNativeWakeLock = async (enabled) => {
  if (!isNativeApp()) return false;
  try {
    if (enabled) await KeepAwake.keepAwake();
    else await KeepAwake.allowSleep();
    return true;
  } catch {
    return false;
  }
};

/** Subtle native tactile feedback on tab switches and map marker inspection. */
export const triggerHaptic = (style = 'light') => {
  if (!isNativeApp()) return;
  const map = { light: ImpactStyle.Light, medium: ImpactStyle.Medium, heavy: ImpactStyle.Heavy };
  Haptics.impact({ style: map[style] || ImpactStyle.Light }).catch(() => {});
};
