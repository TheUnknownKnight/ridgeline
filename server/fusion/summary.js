const fmtMile = (m) => (Number.isInteger(m) ? String(m) : m.toFixed(1));
export const fmtRange = ([a, b]) => `Mi ${fmtMile(a)}–${fmtMile(b)}`;

const firstMile = (h) => (h.ranges.length ? h.ranges[0][0] : Infinity);
const round2 = (n) => Math.round(n * 100) / 100;

/** "Mi 42–47" or "Mi 2342–2414 (3 sections)". */
export const spanText = (ranges) => {
  const text = fmtRange([ranges[0][0], ranges[ranges.length - 1][1]]);
  return ranges.length > 1 ? `${text} (${ranges.length} sections)` : text;
};

/** Hazards ordered by severity, official before estimated, then by where they start. */
export const rankHazards = (hazards) => Object.values(hazards).sort((a, b) =>
  b.level - a.level ||
  (a.source === 'OFFICIAL' ? 0 : 1) - (b.source === 'OFFICIAL' ? 0 : 1) ||
  firstMile(a) - firstMile(b));

const countsOf = (levels) => {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const l of levels) if (l >= 1) counts[l]++;
  return counts;
};

/**
 * The next thing the hiker will reach. Low-level *estimates* are skipped
 * when anything else is ahead — but an official notice right in front of
 * them always counts, however minor.
 */
const findNext = (segments, position, hazards) => {
  const ahead = segments.filter(s => s.level > 0 && s.mileEnd > position.mile);
  const seg = ahead.find(s => !(s.estimatedOnly && s.level < 2)) || ahead[0];
  if (!seg) return null;
  const ref = seg.refs[0];
  return {
    id: ref.id,
    mile: round2(Math.max(seg.mileStart, position.mile)),
    milesAhead: round2(Math.max(0, seg.mileStart - position.mile)),
    level: ref.level,
    title: hazards[ref.id]?.title || ref.id,
  };
};

export const buildSummary = ({ hazards, segments, sources, position = null, outsideCoverage = false, caveats = [] }) => {
  const ranked = rankHazards(hazards);
  const level = ranked.length ? ranked[0].level : 0;

  const incompleteSources = Object.entries(sources)
    .filter(([, s]) => s.status === 'error' || s.status === 'partial' || s.status === 'stale')
    .map(([k]) => k);
  const unavailable = incompleteSources.some(k => sources[k].status !== 'stale');

  let headline;
  if (ranked.length) {
    const top = ranked[0];
    headline = `${top.title}${top.ranges.length ? ` (${spanText(top.ranges)})` : ''}`;
  } else if (unavailable) {
    headline = 'No hazards found in the data we could reach — some sources are unavailable';
  } else if (outsideCoverage) {
    headline = 'No reported hazards on the US part of this route';
  } else if (incompleteSources.length) {
    headline = 'No reported hazards, but some data is out of date';
  } else {
    headline = 'No reported hazards on this route';
  }

  // On trail, what matters is what's still ahead.
  let ahead = null;
  if (position) {
    const best = new Map();
    for (const s of segments) {
      if (s.mileEnd <= position.mile) continue;
      for (const r of s.refs) best.set(r.id, Math.max(best.get(r.id) || 0, r.level));
    }
    ahead = { level: Math.max(0, ...best.values()), counts: countsOf(best.values()) };
  }

  return {
    level,
    // The AQI word when the top hazard is measured or forecast air ("Unhealthy"), so the
    // plaque never says "Moderate" over air AirNow calls unhealthy.
    levelLabel: ranked[0]?.levelLabel ?? null,
    headline,
    counts: countsOf(ranked.map(h => h.level)),
    incomplete: incompleteSources.length > 0 || outsideCoverage,
    incompleteSources,
    outsideCoverage,
    caveats,
    ahead,
    nextHazard: position ? findNext(segments, position, hazards) : null,
  };
};
