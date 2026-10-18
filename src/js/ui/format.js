/** Display formatting shared by every panel. US units first. */

export const fmtMile = (m) => {
  if (m == null || !Number.isFinite(m)) return '—';
  if (m >= 100) return String(Math.round(m));
  const r = Math.round(m * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

/** "Mi 12–18.4" */
export const fmtRange = (a, b) => `Mi ${fmtMile(a)}–${fmtMile(b)}`;

export const fmtDistance = (miles) => {
  if (miles == null || !Number.isFinite(miles)) return '—';
  if (miles < 0.1) return '<0.1 mi';
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
};

export const metersToFeet = (m) => m * 3.28084;

export const fmtElevation = (meters) =>
  (meters == null || !Number.isFinite(meters) ? '—' : `${Math.round(metersToFeet(meters)).toLocaleString('en-US')} ft`);

/** "just now", "4 min ago", "3 h ago", "2 days ago" */
export const fmtAgo = (ms, now = Date.now()) => {
  if (ms == null || !Number.isFinite(ms)) return 'unknown';
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
};

export const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const fmtDateTime = (ms) => new Date(ms).toLocaleString([], {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Server detail strings join facts with " · "; panels render them as a list. */
export const splitFacts = (detail) => (detail ? String(detail).split(' · ').map(s => s.trim()).filter(Boolean) : []);
