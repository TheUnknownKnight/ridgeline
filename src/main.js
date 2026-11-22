import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/map.css';
import { startApp } from './js/app.js';
import { isNativeApp } from './js/native/bridge.js';

startApp();

// Offline shell and map tiles on web. Dev builds and Capacitor native skip SW
// (native iOS/Android uses Capacitor Filesystem + MapLibre rl-tile:// instead).
if (import.meta.env.PROD && !isNativeApp() && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('[ridgeline] offline support unavailable', err));
  });
}
