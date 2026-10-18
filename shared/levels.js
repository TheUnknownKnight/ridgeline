/**
 * One severity scale for the whole app (server scoring, map, profile,
 * cards, legend). Never hardcode a hazard color anywhere else.
 *
 * The ramp borrows the feel of the US AQI colors (green → maroon), tuned to
 * stay legible on light and dark basemaps, but it is Ridgeline's own 0–4
 * scale. Air-quality data keeps its AQI category word (levelLabel) and is
 * drawn in the official AQI colors below, so "Moderate" never means two things.
 *
 * ESTIMATED (model-derived) hazards are capped at MAX_ESTIMATED_LEVEL so an
 * inference can never outrank an official high-consequence call.
 */
export const LEVELS = [
  { level: 0, key: 'clear',    label: 'No reported hazards', short: 'Clear',    color: '#2f9e5b' },
  { level: 1, key: 'low',      label: 'Low',                 short: 'Low',      color: '#d9a400' },
  { level: 2, key: 'moderate', label: 'Moderate',            short: 'Moderate', color: '#ee7a14' },
  { level: 3, key: 'high',     label: 'High',                short: 'High',     color: '#dc3a1c' },
  { level: 4, key: 'extreme',  label: 'Extreme',             short: 'Extreme',  color: '#9e1650' },
];

export const MAX_ESTIMATED_LEVEL = 2;

/** Official US AQI category colors (EPA), by category 1 good … 6 hazardous. */
export const AQI_COLORS = ['#9aa5a0', '#00e400', '#ffff00', '#ff7e00', '#ff0000', '#8f3f97', '#7e0023'];

export const levelInfo = (level) => LEVELS[Math.max(0, Math.min(4, level | 0))];

/** Hazard categories — used by filter chips, overlay styling and badges. */
export const HAZARD_TYPES = {
  fire:      { label: 'Fire',       color: '#d9481c' },
  alert:     { label: 'NWS alerts', color: '#c98a00' },
  avalanche: { label: 'Avalanche',  color: '#3d7ebf' },
  water:     { label: 'Rivers',     color: '#1f8fa3' },
  weather:   { label: 'Forecast',   color: '#7a5bb5' },
  smoke:     { label: 'Smoke',      color: '#7d7d7d' },
  trail:     { label: 'Trail',      color: '#4f7cac' },
};

/** Data sources the engine reports health for, in display order. */
export const SOURCE_KEYS = ['fire', 'alerts', 'avalanche', 'water', 'air', 'forecast', 'smoke', 'conditions'];

export const SOURCE_LABELS = {
  fire: 'Wildfires',
  alerts: 'NWS watches & warnings',
  avalanche: 'Avalanche forecasts',
  water: 'River gauges',
  air: 'Measured air quality',
  forecast: 'Weather forecast',
  smoke: 'Smoke forecast',
  conditions: 'Trail conditions model',
};
