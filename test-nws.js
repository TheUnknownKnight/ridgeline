import { getNWSForecast } from './server/sources/nws.js';

async function test() {
  console.log('Fetching NWS for Mexico point...');
  const start = Date.now();
  try {
    await getNWSForecast(32.5800, -116.4700);
    console.log('Success in', Date.now() - start, 'ms');
  } catch (e) {
    console.log('Error caught in', Date.now() - start, 'ms:', e.message);
  }
}

test();
