/**
 * Build and verify static trail catalogs for GitHub Pages hosting (`docs/trails/`).
 *
 * Usage:
 *   node scripts/build-trail-catalog.js --verify-only
 *     Verify every entry in `public/data/featured-trails.json` against local
 *     sample files and live USFS/NPS ArcGIS endpoints without writing files.
 *
 *   node scripts/build-trail-catalog.js
 *     Verify featured trails and write `docs/trails/featured.json` and
 *     `docs/trails/index.json` (updates verified start coords and lengths).
 *
 *   node scripts/build-trail-catalog.js --regions
 *     Also query live USFS/NPS services for major U.S. backcountry regions
 *     and write `docs/trails/regions/<region>.json` for fast static browsing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchPublicTrails, fetchPublicTrailGeometry } from '../server/sources/trailSearch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FEATURED_PATH = path.join(ROOT, 'public', 'data', 'featured-trails.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_DIR = path.join(ROOT, 'docs', 'trails');

const REGIONS = [
  { slug: 'sierra-nevada', name: 'Sierra Nevada', lat: 37.74, lon: -119.55, radiusMiles: 40 },
  { slug: 'pacific-northwest', name: 'Pacific Northwest', lat: 46.85, lon: -121.75, radiusMiles: 40 },
  { slug: 'northern-rockies', name: 'Northern Rockies', lat: 48.70, lon: -113.72, radiusMiles: 40 },
  { slug: 'colorado-rockies', name: 'Colorado Rockies', lat: 39.20, lon: -106.82, radiusMiles: 40 },
  { slug: 'desert-southwest', name: 'Desert Southwest', lat: 37.26, lon: -112.95, radiusMiles: 40 },
  { slug: 'northeast', name: 'Northeast & Acadia', lat: 44.34, lon: -68.21, radiusMiles: 35 },
];

const args = new Set(process.argv.slice(2));
const verifyOnly = args.has('--verify-only');
const includeRegions = args.has('--regions');

const round1 = (n) => Math.round(n * 10) / 10;

const verifyFeatured = async () => {
  const raw = JSON.parse(fs.readFileSync(FEATURED_PATH, 'utf8'));
  const entries = Array.isArray(raw) ? raw : raw.trails || [];
  const verified = [];
  let failures = 0;

  console.log(`Verifying ${entries.length} featured trails...`);
  for (const trail of entries) {
    if (trail.sampleUrl) {
      const localPath = path.join(PUBLIC_DIR, trail.sampleUrl.replace(/^\/+/, ''));
      if (!fs.existsSync(localPath)) {
        console.error(`  [FAIL] ${trail.name}: missing sample file ${localPath}`);
        failures++;
        continue;
      }
      const stat = fs.statSync(localPath);
      console.log(`  [OK]   ${trail.name} (bundled sample, ${(stat.size / 1024).toFixed(0)} KB)`);
      verified.push(trail);
      continue;
    }

    if (!trail.queryMeta) {
      console.error(`  [FAIL] ${trail.name}: missing sampleUrl or queryMeta`);
      failures++;
      continue;
    }

    try {
      const t0 = Date.now();
      const geom = await fetchPublicTrailGeometry(trail.queryMeta);
      console.log(
        `  [OK]   ${trail.name} (${trail.agency}): ${geom.lengthMiles} mi, ${geom.coords.length} pts (${Date.now() - t0} ms)`,
      );
      verified.push({
        ...trail,
        lengthMiles: round1(geom.lengthMiles),
        start: [geom.coords[0][0], geom.coords[0][1]],
      });
    } catch (err) {
      console.error(`  [FAIL] ${trail.name}: ${err.message}`);
      failures++;
    }
  }

  return { verified, failures };
};

const writeJson = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const main = async () => {
  const { verified, failures } = await verifyFeatured();
  if (failures > 0) {
    console.error(`\nVerification failed for ${failures} trail(s).`);
    process.exitCode = 1;
    return;
  }

  if (verifyOnly) {
    console.log(`\nAll ${verified.length} featured trails verified cleanly.`);
    return;
  }

  const updatedAt = new Date().toISOString();
  writeJson(path.join(OUT_DIR, 'featured.json'), {
    version: 1,
    updatedAt,
    trails: verified,
  });
  console.log(`\nWrote ${path.relative(ROOT, path.join(OUT_DIR, 'featured.json'))} (${verified.length} trails).`);

  const regionManifest = [];
  if (includeRegions) {
    console.log(`\nBuilding ${REGIONS.length} regional catalogs...`);
    for (const region of REGIONS) {
      const { trails, note } = await searchPublicTrails({
        lat: region.lat,
        lon: region.lon,
        radiusMiles: region.radiusMiles,
        limit: 40,
      });
      const rel = `regions/${region.slug}.json`;
      writeJson(path.join(OUT_DIR, rel), {
        version: 1,
        updatedAt,
        region: region.name,
        center: [region.lon, region.lat],
        radiusMiles: region.radiusMiles,
        note,
        trails,
      });
      regionManifest.push({
        slug: region.slug,
        name: region.name,
        path: rel,
        count: trails.length,
      });
      console.log(`  [OK]   ${region.name}: ${trails.length} trails${note ? ` (${note})` : ''}`);
    }
  }

  writeJson(path.join(OUT_DIR, 'index.json'), {
    version: 1,
    updatedAt,
    featured: 'featured.json',
    regions: regionManifest,
  });
  console.log(`Wrote ${path.relative(ROOT, path.join(OUT_DIR, 'index.json'))}.`);
};

await main();
