export const analyzeRoute = async (routeGeoJSON, routeId, location = null, lookaheadMiles = 15) => {
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ route: routeGeoJSON, routeId, location, lookaheadMiles })
  });
  
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to analyze route');
  }
  
  return res.json();
};
