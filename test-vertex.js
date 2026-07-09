import fs from 'fs';
import bbox from '@turf/bbox';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import along from '@turf/along';
import { getAvalancheMap } from './server/sources/avalanche.js';

async function run() {
  const avyData = await getAvalancheMap();
  
  // 1. Report Vertex Counts
  const vertexCounts = avyData.features.map(f => {
    let count = 0;
    if (f.geometry.type === 'Polygon') {
      f.geometry.coordinates.forEach(ring => count += ring.length);
    } else if (f.geometry.type === 'MultiPolygon') {
      f.geometry.coordinates.forEach(poly => {
        poly.forEach(ring => count += ring.length);
      });
    }
    return { name: f.properties.name || f.properties.center || 'Unknown', count };
  });

  vertexCounts.sort((a, b) => b.count - a.count);
  console.log("Top 5 largest avalanche zones by vertex count:");
  for (let i = 0; i < 5; i++) {
    console.log(` - ${vertexCounts[i].name}: ${vertexCounts[i].count} vertices`);
  }

  const totalAvyVertices = vertexCounts.reduce((sum, v) => sum + v.count, 0);
  console.log(`Total vertices across ${avyData.features.length} zones: ${totalAvyVertices}`);

  // Read PCT route
  const pct = JSON.parse(fs.readFileSync('dense-pct.json'));
  const mainLine = pct.features[0];

  // Generate sampled points (every 5 miles)
  const sampledPoints = [];
  const routeLength = 3410;
  for (let m = 0; m <= routeLength; m += 5) {
    try {
      sampledPoints.push(along(mainLine, m, { units: 'miles' }));
    } catch (e) {}
  }
  console.log(`\nSampled Points generated: ${sampledPoints.length}`);

  // 2. Report Elimination with and without BBox
  const beforeBboxStart = Date.now();
  const eliminatedWithoutBbox = avyData.features.filter(zone => {
    for (const pt of sampledPoints) {
      if (booleanPointInPolygon(pt, zone)) return true;
    }
    return false;
  });
  const withoutBboxTime = Date.now() - beforeBboxStart;

  const withBboxStart = Date.now();
  const eliminatedWithBbox = avyData.features.filter(zone => {
    for (const pt of sampledPoints) {
      const [lon, lat] = pt.geometry.coordinates;
      if (zone.bbox) {
        if (lon < zone.bbox[0] || lon > zone.bbox[2] || lat < zone.bbox[1] || lat > zone.bbox[3]) {
          continue;
        }
      }
      if (booleanPointInPolygon(pt, zone)) return true;
    }
    return false;
  });
  const withBboxTime = Date.now() - withBboxStart;

  console.log(`\nAvy zones hit (NO bbox guard): ${eliminatedWithoutBbox.length} out of ${avyData.features.length} (Time: ${withoutBboxTime}ms)`);
  console.log(`Avy zones hit (WITH bbox guard): ${eliminatedWithBbox.length} out of ${avyData.features.length} (Time: ${withBboxTime}ms)`);
}

run().catch(console.error);
