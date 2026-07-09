import fs from 'fs';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'differ_db.json');

const loadDb = () => {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('[DIFFER] Failed to load db:', e.message);
  }
  return {};
};

const saveDb = (db) => {
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('[DIFFER] Failed to save db:', e.message);
  }
};

export const saveFusionState = (routeId, fusionResult) => {
  const db = loadDb();
  const previousState = db[routeId] || null;

  db[routeId] = {
    timestamp: fusionResult.timestamp,
    segments: fusionResult.segments.features.map(f => ({
      mileStart: f.properties.mileStart,
      mileEnd: f.properties.mileEnd,
      status: f.properties.status,
      hazards: f.properties.hazards
    }))
  };

  saveDb(db);
  return previousState;
};

export const getDiff = (routeId) => {
  const db = loadDb();
  return db[routeId] || null;
};
