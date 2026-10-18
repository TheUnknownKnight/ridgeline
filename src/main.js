import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/map.css';
import { startApp } from './js/app.js';

startApp();

// Offline shell and map tiles. Dev builds skip it so hot reload never serves stale code.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('[ridgeline] offline support unavailable', err));
  });
}
