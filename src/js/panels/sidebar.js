import { createSegmentCard } from './segmentCard.js';

export const updateSyncStatus = (timestamp) => {
  const container = document.getElementById('sync-status');
  if (!timestamp) {
    container.classList.add('hidden');
    return;
  }
  
  container.classList.remove('hidden');
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMins = Math.floor(diffMs / (1000 * 60));
  
  let relativeTime = '';
  if (diffHrs >= 24) {
    const days = Math.floor(diffHrs / 24);
    relativeTime = `⚠ Last synced ${days}d ago`;
    container.classList.add('stale');
  } else if (diffHrs >= 1) {
    relativeTime = `Last synced ${diffHrs}h ago`;
    container.classList.remove('stale');
  } else if (diffMins > 0) {
    relativeTime = `Last synced ${diffMins}m ago`;
    container.classList.remove('stale');
  } else {
    relativeTime = `Last synced just now`;
    container.classList.remove('stale');
  }
  
  const time = new Date(timestamp);
  const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  container.title = `Exact time: ${timeStr}`;
  container.textContent = relativeTime;
};


export const renderSummary = (metadata, timestamp) => {
  const container = document.getElementById('route-summary');
  const time = new Date(timestamp);
  const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  container.innerHTML = `
    <div class="summary-stat">
      <span class="stat-value">${metadata.lengthMiles}</span>
      <span class="stat-label">Miles</span>
    </div>
    <div class="summary-stat">
      <span class="stat-value">${metadata.fireCount || 0}</span>
      <span class="stat-label">Fires nearby</span>
    </div>
    <div class="summary-stat">
      <span class="stat-value">${metadata.avyZonesHit || 0}</span>
      <span class="stat-label">Avy zones</span>
    </div>
    <div class="summary-stat">
      <span class="stat-value">${timeStr}</span>
      <span class="stat-label">Analyzed</span>
    </div>
  `;
};

export const renderDiff = (diff, timestamp) => {
  const section = document.getElementById('delta-section');
  const list = document.getElementById('delta-list');
  list.innerHTML = '';

  if (!diff || diff.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  const card = document.createElement('div');
  card.className = 'delta-card';

  const hasNew = diff.some(d => d.type === 'NEW');
  if (hasNew) {
    card.classList.add('has-new-hazards');
  }

  const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'recently';

  const header = document.createElement('div');
  header.className = 'delta-header';
  header.textContent = `SINCE YOU LAST CHECKED · ${timeStr}`;

  const body = document.createElement('div');
  body.className = 'delta-body';

  const newHazards = diff.filter(d => d.type === 'NEW');
  const clearedHazards = diff.filter(d => d.type === 'CLEARED');

  let prose = '';
  if (newHazards.length > 0 && clearedHazards.length > 0) {
    prose = `${newHazards.length} new hazard${newHazards.length > 1 ? 's' : ''} reported, and ${clearedHazards.length} hazard${clearedHazards.length > 1 ? 's' : ''} cleared.`;
  } else if (newHazards.length > 0) {
    prose = `${newHazards.length} new hazard${newHazards.length > 1 ? 's' : ''} reported on your route.`;
  } else if (clearedHazards.length > 0) {
    prose = `${clearedHazards.length} hazard${clearedHazards.length > 1 ? 's' : ''} cleared from your route.`;
  }

  body.textContent = prose;

  card.appendChild(header);
  card.appendChild(body);
  list.appendChild(card);
};

export const renderSegments = (segmentsGeoJSON, activeFilters = null) => {
  const container = document.getElementById('segments-list');
  container.innerHTML = '';

  const features = [...segmentsGeoJSON.features].sort(
    (a, b) => a.properties.mileStart - b.properties.mileStart
  );

  for (const feature of features) {
    const p = feature.properties;
    
    // Filtering logic
    if (activeFilters && p.status !== 'clear' && p.hazards && p.hazards.length > 0) {
      const hasActiveHazard = p.hazards.some(h => activeFilters.has(h.type));
      if (!hasActiveHazard) {
        continue; // Skip this segment if none of its hazards are active in the filter
      }
    }

    container.appendChild(createSegmentCard(feature));
  }
};
