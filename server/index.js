import config from './config.js';
import { createApp } from './app.js';

const server = createApp().listen(config.port, () => {
  console.log(`Ridgeline API listening on http://localhost:${config.port}${config.isProduction ? ' (production)' : ''}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
