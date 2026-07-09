import fs from 'fs';
import http from 'http';

async function run() {
  const pct = JSON.parse(fs.readFileSync('dense-pct.json'));
  const start = Date.now();
  console.log(`Sending dense PCT route to backend...`);
  
  const postData = JSON.stringify({
    route: pct,
    routeId: 'pct-test-1',
    location: null,
    lookaheadMiles: 15
  });

  const options = {
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/analyze',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const req = http.request(options, (res) => {
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
      if (res.statusCode !== 200) {
        console.error('Backend returned error:', res.statusCode, body);
        return;
      }
      try {
        const data = JSON.parse(body);
        const elapsed = Date.now() - start;
        console.log(`Success! Request completed in ${elapsed} ms.`);
        console.log(`Route length: ${data.metadata.lengthMiles} miles`);
        console.log(`Segments returned: ${data.segments.features.length}`);
        console.log(`Fire count metadata: ${data.metadata.fireCount}`);
        console.log(`Avy hit metadata: ${data.metadata.avyZonesHit}`);
      } catch (e) {
        console.error('Failed to parse JSON:', e.message);
      }
    });
  });

  req.on('error', (e) => {
    console.error('Request failed:', e.message);
  });

  req.write(postData);
  req.end();
}

run();
