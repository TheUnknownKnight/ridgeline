/**
 * Generate source PNG assets for @capacitor/assets (Android & iOS icons/splashes)
 * and Google Play Store listing graphics (512x512 icon, 1024x500 feature graphic)
 * strictly using Ridgeline's exact palette (#141916, #1d2622, #edf0ea, #c9a06e,
 * and shared/levels.js severity ramp).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const ROOT = path.resolve(import.meta.dirname, '..');
const ASSETS_DIR = path.join(ROOT, 'assets');
const STORE_DIR = path.join(ROOT, 'store', 'google-play');
fs.mkdirSync(ASSETS_DIR, { recursive: true });
fs.mkdirSync(STORE_DIR, { recursive: true });

// Full square icon (1024x1024) — iOS AppIcon + legacy Android + Play 512x512.
const iconFullSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#1d2622"/>
  <path d="M112 328 L196 204 L254 276 L326 176 L400 328" fill="none" stroke="#edf0ea" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M152 372 H360" fill="none" stroke="#c9a06e" stroke-width="18" stroke-linecap="round"/>
</svg>`;

// Adaptive foreground (1024x1024 transparent) — inset safely inside Android's 66% inner circle.
const iconForegroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 512 512">
  <g transform="translate(256 256) scale(0.68) translate(-256 -256)">
    <path d="M112 328 L196 204 L254 276 L326 176 L400 328" fill="none" stroke="#edf0ea" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M152 372 H360" fill="none" stroke="#c9a06e" stroke-width="20" stroke-linecap="round"/>
  </g>
</svg>`;

const iconBackgroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#1d2622"/>
</svg>`;

// Dark topo splash screen (2732x2732) — centered mark survives all portrait/landscape center-crops.
const splashSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="2732" height="2732" viewBox="0 0 2732 2732">
  <rect width="2732" height="2732" fill="#141916"/>
  <g fill="none" stroke="#c9a06e" stroke-opacity="0.11" stroke-width="4">
    <ellipse cx="1366" cy="1366" rx="520" ry="390" transform="rotate(-14 1366 1366)"/>
    <ellipse cx="1366" cy="1366" rx="740" ry="560" transform="rotate(-14 1366 1366)"/>
    <ellipse cx="1366" cy="1366" rx="980" ry="740" transform="rotate(-14 1366 1366)"/>
    <ellipse cx="1366" cy="1366" rx="1240" ry="940" transform="rotate(-14 1366 1366)"/>
  </g>
  <g transform="translate(1110 1090)">
    <rect width="512" height="512" rx="108" fill="#1d2622" stroke="#333b36" stroke-width="4"/>
    <path d="M112 328 L196 204 L254 276 L326 176 L400 328" fill="none" stroke="#edf0ea" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M152 372 H360" fill="none" stroke="#c9a06e" stroke-width="18" stroke-linecap="round"/>
  </g>
</svg>`;

// Google Play Feature Graphic (1024x500) — exact Ridgeline dark palette & 0-4 severity ramp.
const featureGraphicSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500" viewBox="0 0 1024 500">
  <rect width="1024" height="500" fill="#141916"/>
  <!-- Subtle topographic contour lines -->
  <g fill="none" stroke="#c9a06e" stroke-opacity="0.14" stroke-width="2">
    <path d="M-40 420 Q 220 260, 480 350 T 1060 220"/>
    <path d="M-40 465 Q 240 315, 510 395 T 1060 275"/>
    <path d="M-40 370 Q 210 210, 460 300 T 1060 160"/>
    <path d="M-40 120 Q 300 40, 620 110 T 1060 55"/>
    <path d="M-40 170 Q 310 85, 640 155 T 1060 105"/>
  </g>
  <!-- Left brand tile -->
  <g transform="translate(96 142)">
    <rect width="208" height="208" rx="44" fill="#1d2622" stroke="#333b36" stroke-width="2.5"/>
    <g transform="scale(0.40625)">
      <path d="M112 328 L196 204 L254 276 L326 176 L400 328" fill="none" stroke="#edf0ea" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M152 372 H360" fill="none" stroke="#c9a06e" stroke-width="20" stroke-linecap="round"/>
    </g>
  </g>
  <!-- Wordmark + tagline -->
  <text x="348" y="226" fill="#e8ece6" font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="68" font-weight="800" letter-spacing="-1.5">Ridgeline</text>
  <text x="350" y="272" fill="#b7c0b9" font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="25" font-weight="500">Backcountry Route Hazard Checker</text>
  <text x="350" y="310" fill="#8e9891" font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="18" font-weight="500">Wildfire · Alerts · Avalanche · Rivers · Air Quality · Trail Conditions</text>
  <!-- Exact Ridgeline 0-4 severity ramp bar -->
  <g transform="translate(350 338)">
    <rect x="0"   y="0" width="98" height="12" rx="4" fill="#2f9e5b"/>
    <rect x="106" y="0" width="98" height="12" rx="4" fill="#d9a400"/>
    <rect x="212" y="0" width="98" height="12" rx="4" fill="#ee7a14"/>
    <rect x="318" y="0" width="98" height="12" rx="4" fill="#dc3a1c"/>
    <rect x="424" y="0" width="98" height="12" rx="4" fill="#9e1650"/>
  </g>
</svg>`;

const renderPng = async (svg, dest, width, height) => {
  await sharp(Buffer.from(svg)).resize(width, height).png({ compressionLevel: 9 }).toFile(dest);
  console.log('Generated:', path.relative(ROOT, dest), `(${width}x${height})`);
};

if (process.argv.includes('--post-android')) {
  const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
  const resDir = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
  for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    fs.writeFileSync(path.join(resDir, 'mipmap-anydpi-v26', name), adaptiveXml, 'utf8');
  }
  fs.writeFileSync(
    path.join(resDir, 'values', 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#1d2622</color>\n</resources>\n`,
    'utf8'
  );
  console.log('Updated Android adaptive icon XML (edge-to-edge #1d2622 background, no double foreground inset).');
  process.exit(0);
}

await renderPng(iconFullSvg, path.join(ASSETS_DIR, 'icon-only.png'), 1024, 1024);
await renderPng(iconForegroundSvg, path.join(ASSETS_DIR, 'icon-foreground.png'), 1024, 1024);
await renderPng(iconBackgroundSvg, path.join(ASSETS_DIR, 'icon-background.png'), 1024, 1024);
await renderPng(splashSvg, path.join(ASSETS_DIR, 'splash.png'), 2732, 2732);
await renderPng(splashSvg, path.join(ASSETS_DIR, 'splash-dark.png'), 2732, 2732);
await renderPng(iconFullSvg, path.join(STORE_DIR, 'app-icon-512.png'), 512, 512);
await renderPng(featureGraphicSvg, path.join(STORE_DIR, 'feature-graphic-1024x500.png'), 1024, 500);
