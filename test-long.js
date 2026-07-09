import fs from 'fs';
import length from '@turf/length';
import { runFusion } from './server/fusion/engine.js';
import along from '@turf/along';

// Helper to create a straight-line GeoJSON route
function createRoute(startLon, startLat, endLon, endLat) {
  const route = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [startLon, startLat],
            [endLon, endLat]
          ]
        }
      }
    ]
  };
  return route;
}

const midRoute = createRoute(-120.0, 39.0, -121.0, 48.0); // ~600-800 miles
const coastToCoastRoute = createRoute(-122.0, 38.0, -75.0, 38.0); 

async function testRoute(name, route) {
  console.log(`\n--- Testing ${name} ---`);
  const len = length(route.features[0], { units: 'miles' });
  console.log(`Route length: ${len.toFixed(1)} miles`);
  
  const startTime = Date.now();
  try {
    const res = await runFusion(route, `test-${name}`, null, 15);
    const elapsed = Date.now() - startTime;
    console.log(`Finished ${name} in ${elapsed} ms`);
    console.log(`Fire count: ${res.metadata.fireCount}, Avy hit: ${res.metadata.avyZonesHit}`);
  } catch (e) {
    console.error(`Error in ${name}:`, e);
  }
}

async function run() {
  await testRoute('Mid-length', midRoute);
  await testRoute('Long PCT scale', coastToCoastRoute);
  process.exit(0);
}

run();
