import express from 'express';
import { runFusion } from '../fusion/engine.js';
import { getDiff } from '../fusion/differ.js';
import { getNWSForecast } from '../sources/nws.js';
import { getFires } from '../sources/nifc.js';
import { getAvalancheMap } from '../sources/avalanche.js';

const router = express.Router();

router.post('/analyze', async (req, res) => {
  try {
    const { route, routeId, location, lookaheadMiles } = req.body;
    if (!route || !routeId) {
      return res.status(400).json({ error: 'Missing route or routeId' });
    }
    const result = await runFusion(route, routeId, location, lookaheadMiles);
    res.json(result);
  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/diff', (req, res) => {
  const { routeId } = req.query;
  if (!routeId) return res.status(400).json({ error: 'Missing routeId' });
  const diff = getDiff(routeId);
  res.json({ diff });
});

// Debug proxy routes — development only
if (process.env.NODE_ENV !== 'production') {
  router.get('/weather', async (req, res) => {
    const { lat, lon } = req.query;
    try {
      const data = await getNWSForecast(lat, lon);
      res.json(data);
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/fires', async (req, res) => {
    const { bbox } = req.query;
    try {
      const data = await getFires(bbox);
      res.json(data);
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/avalanche', async (req, res) => {
    try {
      const data = await getAvalancheMap();
      res.json(data);
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });
}

export default router;
