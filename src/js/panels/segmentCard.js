/**
 * C4 — Source attribution defaults per hazard type
 */
const SOURCE_DEFAULTS = {
  'weather-alert': { source: 'api.weather.gov', label: 'NWS' },
  'fire':          { source: 'NIFC/IRWIN',     label: 'NIFC' },
  'avalanche':     { source: 'avalanche.org',   label: 'NAC' },
  'mud':           { source: 'NWS forecast',    label: 'NWS' },
  'snowpack':      { source: 'avalanche.org',   label: 'NAC' }
};

export const createSegmentCard = (segment) => {
  const props = segment.properties;
  const hasHazards = props.hazards && props.hazards.length > 0;

  const card = document.createElement('div');
  card.className = `segment-card status-${props.status}`;

  const header = document.createElement('div');
  header.className = 'segment-header';

  const title = document.createElement('span');
  title.className = 'mile-marker';
  title.textContent = `Mi ${props.mileStart}–${props.mileEnd}`;
  header.appendChild(title);

  if (!hasHazards) {
    const badge = document.createElement('span');
    badge.className = 'badge badge--clear';
    badge.textContent = 'CLEAR';
    header.appendChild(badge);
  }

  card.appendChild(header);

  if (hasHazards) {
    for (const hazard of props.hazards) {
      const item = document.createElement('div');
      item.className = 'hazard-item';

      const badge = document.createElement('span');
      if (hazard.source === 'ESTIMATED') {
        badge.className = 'badge badge--estimated';
        badge.textContent = 'ESTIMATED';
      } else if (hazard.type === 'weather-alert') {
        /* C7 — Weather-alert hazards get badge--alert class */
        badge.className = 'badge badge--alert';
        badge.textContent = 'ALERT';
      } else if (hazard.type === 'fire') {
        /* C7 — Fire hazards get badge--fire class */
        badge.className = 'badge badge--fire';
        badge.textContent = 'FIRE';
      } else {
        badge.className = 'badge badge--official';
        badge.textContent = 'OFFICIAL';
      }

      const label = document.createElement('div');
      label.className = 'hazard-label';
      label.textContent = hazard.label;

      item.appendChild(badge);
      item.appendChild(label);

      if (hazard.detail) {
        const detail = document.createElement('div');
        detail.className = 'hazard-detail';
        detail.textContent = hazard.detail;
        item.appendChild(detail);
      }

      /* C4 — Source attribution line below hazard details */
      const defaults = SOURCE_DEFAULTS[hazard.type] || { source: 'Unknown', label: '' };
      const sourceText = hazard.sourceAttribution || defaults.source;
      const issuedAt = hazard.issuedAt
        ? new Date(hazard.issuedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : null;

      const sourceEl = document.createElement('div');
      sourceEl.className = 'hazard-source';
      sourceEl.textContent = issuedAt
        ? `Source: ${sourceText} · issued ${issuedAt}`
        : `Source: ${sourceText}`;
      item.appendChild(sourceEl);

      card.appendChild(item);
    }
  }

  return card;
};
