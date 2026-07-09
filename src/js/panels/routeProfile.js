/**
 * Route Profile — Inline SVG status strip
 * Renders a simplified visual representation of route segments colored by status,
 * with mile markers at transition points and a three-tier legend.
 */

const STATUS_STROKE = {
  'clear': '#4a7c59',
  'estimated-warning': '#d4a843',
  'danger-moderate': '#c4603c',
  'danger-severe': '#8b2500'
};

/**
 * Seed-based pseudo-random for deterministic "elevation" curves.
 */
const seededRandom = (seed) => {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
};

/**
 * Render the route profile SVG into the given container.
 * @param {string} containerId — DOM id of the container
 * @param {object} segmentsGeoJSON — FeatureCollection of route segments
 * @param {object|null} windowData — Optional window metadata (currentMile, endMile)
 */
export const renderRouteProfile = (containerId, segmentsGeoJSON, windowData) => {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.classList.remove('hidden');

  const features = [...segmentsGeoJSON.features].sort(
    (a, b) => a.properties.mileStart - b.properties.mileStart
  );

  if (features.length === 0) {
    container.innerHTML = '';
    return;
  }

  const totalMileStart = features[0].properties.mileStart;
  const totalMileEnd = features[features.length - 1].properties.mileEnd;
  const totalLength = totalMileEnd - totalMileStart || 1;

  const svgW = 360;
  const svgH = 80;
  const padX = 12;
  const padTop = 10;
  const padBot = 22;
  const drawW = svgW - padX * 2;
  const drawH = svgH - padTop - padBot;

  const rand = seededRandom(42);

  // Build polyline points per segment with gentle pseudo-elevation
  let pathParts = '';
  let markerParts = '';
  let lastStatus = null;

  for (const f of features) {
    const p = f.properties;
    const x0 = padX + ((p.mileStart - totalMileStart) / totalLength) * drawW;
    const x1 = padX + ((p.mileEnd - totalMileStart) / totalLength) * drawW;
    const color = STATUS_STROKE[p.status] || STATUS_STROKE['clear'];
    const isDashed = p.status === 'estimated-warning';

    // Generate gentle pseudo-elevation points along this segment
    const segLen = x1 - x0;
    const steps = Math.max(2, Math.round(segLen / 8));
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + t * segLen;
      // Sine wave + random walk for visual interest
      const wave = Math.sin((x / svgW) * Math.PI * 3) * (drawH * 0.25);
      const jitter = (rand() - 0.5) * (drawH * 0.15);
      const y = padTop + drawH * 0.5 - wave - jitter;
      points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }

    const dashAttr = isDashed ? ' stroke-dasharray="4,3"' : '';
    pathParts += `<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"${dashAttr}/>`;

    // Mile marker at status transitions
    if (lastStatus !== null && lastStatus !== p.status) {
      const mx = x0;
      const my = padTop + drawH * 0.5;
      markerParts += `<line x1="${mx.toFixed(1)}" y1="${(my - 6).toFixed(1)}" x2="${mx.toFixed(1)}" y2="${(my + 6).toFixed(1)}" stroke="#6b6855" stroke-width="1" stroke-dasharray="2,2"/>`;
      markerParts += `<text x="${mx.toFixed(1)}" y="${(svgH - 4).toFixed(1)}" fill="#6b6855" font-size="9" font-family="'IBM Plex Mono', monospace" text-anchor="middle">${p.mileStart}</text>`;
    }
    lastStatus = p.status;
  }

  // Legend
  const legendHTML = `
    <div class="profile-legend">
      <span class="legend-item"><span style="color:#4a7c59;font-size:1rem;">●</span> Official — clear</span>
      <span class="legend-item"><span style="color:#c4603c;font-size:1rem;">●</span> Official — advisory</span>
      <span class="legend-item"><span style="color:#d4a843;font-size:1rem;">◎</span> Inferred estimate</span>
    </div>
  `;

  container.innerHTML = `
    <svg class="profile-svg" viewBox="0 0 ${svgW} ${svgH}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      ${pathParts}
      ${markerParts}
    </svg>
    ${legendHTML}
  `;
};
