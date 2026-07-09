import fs from 'fs';
import { runFusion } from './server/fusion/engine.js';

async function run() {
  console.log('Loading dense-pct.json...');
  const pct = JSON.parse(fs.readFileSync('dense-pct.json'));
  
  console.log(`\n--- RUN 1 (Cold Cache) ---`);
  const start1 = Date.now();
  try {
    const res1 = await runFusion(pct, 'pct-test-1', null, 15);
    const elapsed1 = Date.now() - start1;
    console.log(`Run 1 completed in ${elapsed1} ms.`);
  } catch (e) {
    console.error('Error in Run 1:', e);
  }

  console.log(`\n--- RUN 2 (Warm Cache) ---`);
  const start2 = Date.now();
  try {
    const res2 = await runFusion(pct, 'pct-test-1', null, 15);
    const elapsed2 = Date.now() - start2;
    console.log(`Run 2 completed in ${elapsed2} ms.`);
  } catch (e) {
    console.error('Error in Run 2:', e);
  }
}

run();
