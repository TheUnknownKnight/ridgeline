/**
 * Live benchmark: runs the full engine against the real upstream services.
 *
 *   npm run bench                       # synthetic 3,410-mi PCT-scale fixture
 *   npm run bench -- path/to/route.gpx  # any GPX
 *   npm run bench -- route.gpx 37.73,-119.55   # On Trail from a position
 *
 * Prints cold and warm timings, source health, and the top hazards.
 */
import fs from 'node:fs';
import { normalizeCoords } from '../shared/geo.js';
import { validateAnalyzeRequest } from '../server/lib/validate.js';
import { analyze } from '../server/fusion/engine.js';

const [, , file = 'tests/fixtures/synthetic-pct.json', position] = process.argv;

const readCoords = (path) => {
  const text = fs.readFileSync(path, 'utf8');
  if (path.endsWith('.json')) {
    const gj = JSON.parse(text);
    return gj.features.flatMap(f => (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.coordinates));
  }
  // Minimal GPX reader for the benchmark only (the app uses @tmcw/togeojson in the browser).
  const pts = [];
  const re = /<(?:trkpt|rtept)\s[^>]*?lat="([-\d.]+)"[^>]*?lon="([-\d.]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/(?:trkpt|rtept)>)/g;
  for (const m of text.matchAll(re)) {
    const ele = /<ele>([-\d.]+)<\/ele>/.exec(m[3] || '');
    pts.push(ele ? [Number(m[2]), Number(m[1]), Number(ele[1])] : [Number(m[2]), Number(m[1])]);
  }
  return pts;
};

const body = { coordinates: normalizeCoords(readCoords(file)), name: file };
if (position) {
  const [lat, lng] = position.split(',').map(Number);
  body.location = { lat, lng };
}
const request = validateAnalyzeRequest(body);

for (const label of ['cold', 'warm']) {
  const t = performance.now();
  const r = await analyze(request);
  const ms = Math.round(performance.now() - t);
  console.log(`\n${label}: ${ms} ms · ${r.mode} · ${r.route.lengthMiles} mi · ${r.segments.length} segments · ${Object.keys(r.hazards).length} hazards · ${(JSON.stringify(r).length / 1024).toFixed(0)} KB`);
  if (label === 'cold') {
    for (const [k, s] of Object.entries(r.sources)) console.log(`  ${k.padEnd(9)} ${s.status.padEnd(8)} ${s.message}`);
    console.log(`  summary: level ${r.summary.level} — ${r.summary.headline}`);
    for (const h of Object.values(r.hazards).sort((a, b) => b.level - a.level).slice(0, 10)) {
      console.log(`  [${h.level}] ${h.source === 'OFFICIAL' ? 'official ' : 'estimate '} ${h.title} — ${h.ranges.map(([a, b]) => `${a}–${b}`).join(', ')}`);
    }
  }
}
