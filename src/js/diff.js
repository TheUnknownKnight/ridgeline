/**
 * "Since your last check": compare official hazards between two analyses of
 * the same route in the same mode. Estimates are left out on purpose — model
 * forecasts wobble run to run and would bury real changes in noise.
 *
 * snapshot = { generatedAt, mode, sources: { key: status }, hazards: { id: { level, title, type, ranges } } }
 */

/** Which source reports each hazard type (keys of result.sources). */
const SOURCE_OF_TYPE = {
  fire: 'fire',
  alert: 'alerts',
  avalanche: 'avalanche',
  water: 'water',
  weather: 'forecast',
  // Official smoke hazards are measured (AirNow, satellite plumes); forecasts never reach the diff.
  smoke: 'air',
  trail: 'conditions',
};

const KIND_ORDER = { new: 0, escalated: 1, eased: 2, cleared: 3 };

// Hazards whose health comes from a feed other than their type's source.
const SOURCE_OF_ID = { 'smoke:plume': 'airPlumes' };

const sourceStatuses = (result) => {
  const out = {};
  for (const [key, source] of Object.entries(result.sources || {})) out[key] = source?.status ?? 'error';
  // Satellite plumes ride on the AirNow source but can fail on their own.
  const air = result.sources?.air;
  out.airPlumes = air?.status === 'ok' && air?.plumesStatus === 'ok' ? 'ok' : 'error';
  return out;
};

const officialHazards = (result) => {
  const out = {};
  for (const hz of Object.values(result.hazards || {})) {
    if (hz.source !== 'OFFICIAL') continue;
    out[hz.id] = { level: hz.level, title: hz.title, type: hz.type, ranges: hz.ranges || [] };
  }
  return out;
};

const sourceIsOk = (sources, id, type) => sources[SOURCE_OF_ID[id] ?? SOURCE_OF_TYPE[type]] === 'ok';

/**
 * Snapshot of a result's official hazards. Pass the previous snapshot to
 * carry forward hazards whose source did not fully load this time — an
 * outage is not an all-clear, and forgetting them would report them as
 * "new" once the source recovers.
 */
export const snapshotOf = (result, previous = null) => {
  const sources = sourceStatuses(result);
  const hazards = officialHazards(result);
  for (const [id, hz] of Object.entries(previous?.hazards || {})) {
    if (!(id in hazards) && !sourceIsOk(sources, id, hz.type)) hazards[id] = hz;
  }
  return { generatedAt: result.generatedAt, mode: result.mode, sources, hazards };
};

const change = (kind, id, hz, from, to) => ({ kind, id, title: hz.title, type: hz.type, from, to, ranges: hz.ranges });

/** Changes from `prev` (a snapshot) to `result` (a fresh analysis), most important first. */
export const diffSnapshots = (prev, result) => {
  const sources = sourceStatuses(result);
  const current = officialHazards(result);
  const before = prev?.hazards || {};
  const changes = [];

  for (const [id, hz] of Object.entries(current)) {
    const old = before[id];
    if (!old) changes.push(change('new', id, hz, null, hz.level));
    else if (hz.level > old.level) changes.push(change('escalated', id, hz, old.level, hz.level));
    else if (hz.level < old.level) changes.push(change('eased', id, hz, old.level, hz.level));
  }
  for (const [id, old] of Object.entries(before)) {
    if (id in current || !sourceIsOk(sources, id, old.type)) continue;
    changes.push(change('cleared', id, old, old.level, 0));
  }

  changes.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    Math.max(b.from ?? 0, b.to) - Math.max(a.from ?? 0, a.to));
  return { previousAt: prev?.generatedAt ?? null, changes };
};
