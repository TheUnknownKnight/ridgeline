import { loadNaqfc, ATTRIBUTION as NOAA_ATTRIBUTION, SOURCE_URL } from './naqfc.js';
import { loadCamsSmoke, AQ_ATTRIBUTION as CAMS_ATTRIBUTION } from './openmeteo.js';

/**
 * Smoke forecast (next 48 h): NOAA's ~5 km PM2.5 forecast first; points it
 * can't answer (outside its grid, a failed or slow request) fall back to the
 * coarse global CAMS model, so a gap in one service is never a silent gap.
 * Anything neither answers is reported, never counted as clear.
 */
// NOAA gets this long; CAMS then has the rest of the engine's 20 s source deadline.
const NOAA_BUDGET_MS = 8000;
// CAMS is ~40 km: one value speaks for samples this far along the trail.
const CAMS_REACH_MILES = 25;
// Enough picks to cover ~3,000 trail miles at that reach.
const MAX_CAMS_POINTS = 60;

const withBudget = (promise, ms, fallback) => {
  let timer;
  const budget = new Promise(resolve => { timer = setTimeout(resolve, ms, fallback); });
  return Promise.race([promise, budget]).finally(() => clearTimeout(timer));
};

/** Gap samples (mile-ordered) to read from CAMS so every gap is within reach of one. */
const camsPicks = (gaps, samples) => {
  const picks = [];
  let i = 0;
  while (i < gaps.length && picks.length < MAX_CAMS_POINTS) {
    const startMile = samples[gaps[i]].mile;
    // Farthest gap within reach of the first uncovered one: it then covers both sides.
    let j = i;
    while (j + 1 < gaps.length && samples[gaps[j + 1]].mile - startMile <= CAMS_REACH_MILES) j++;
    picks.push(gaps[j]);
    const pickMile = samples[gaps[j]].mile;
    i = j + 1;
    while (i < gaps.length && samples[gaps[i]].mile - pickMile <= CAMS_REACH_MILES) i++;
  }
  return picks;
};

export const loadSmoke = async ({ samples, now = Date.now() }) => {
  if (!samples?.length) {
    return { status: 'skipped', fetchedAt: null, message: 'No air-quality points requested', attribution: NOAA_ATTRIBUTION, url: SOURCE_URL, data: { points: [] } };
  }
  const noaa = await withBudget(loadNaqfc({ samples, now }), NOAA_BUDGET_MS, {
    status: 'error', bySample: samples.map(() => null), failed: samples.length, total: samples.length, issued: null, horizonHours: null, timedOut: true,
  });
  const aq = noaa.bySample.map(v => (v ? { ...v, model: 'noaa' } : null));

  const gaps = aq.flatMap((v, i) => (v ? [] : [i]));
  let filled = 0;
  let camsStatus = null;
  if (gaps.length) {
    const picks = camsPicks(gaps, samples);
    const cams = await loadCamsSmoke({ samples: picks.map(i => samples[i]), now, timeoutMs: 8000, retries: 0 });
    camsStatus = cams.status;
    const read = picks.map((i, k) => ({ mile: samples[i].mile, aq: cams.data?.points?.[k]?.aq })).filter(r => r.aq);
    for (const i of gaps) {
      let best = null;
      for (const r of read) if (!best || Math.abs(r.mile - samples[i].mile) < Math.abs(best.mile - samples[i].mile)) best = r;
      if (best && Math.abs(best.mile - samples[i].mile) <= CAMS_REACH_MILES) { aq[i] = { ...best.aq, model: 'cams' }; filled++; }
    }
  }

  const answered = aq.filter(Boolean).length;
  const missing = samples.length - answered;
  const noaaPoints = answered - filled;
  const shortHorizon = noaa.status === 'partial' && noaa.horizonHours != null && noaa.horizonHours < 40;
  const status = answered === 0 ? 'error'
    : missing || shortHorizon ? 'partial'
      : noaa.status === 'stale' || camsStatus === 'stale' ? 'stale' : 'ok';
  const horizon = noaaPoints && noaa.horizonHours != null ? Math.min(48, Math.round(noaa.horizonHours)) : 48;
  const parts = [];
  if (noaaPoints) parts.push(`NOAA 5 km PM2.5 forecast for ${noaaPoints} points`);
  if (filled) {
    parts.push(noaaPoints
      ? `${filled} more from the coarser CAMS global model`
      : `CAMS global model PM2.5 forecast for ${filled} points${noaa.status === 'error' ? ' (NOAA forecast unavailable)' : ''}`);
  }
  if (missing) parts.push(`no forecast for ${missing} of ${samples.length} points`);
  return {
    status,
    fetchedAt: new Date(now).toISOString(),
    message: status === 'error' ? 'Smoke forecast unavailable' : `${parts.join(', ')} — next ${horizon} hours`,
    attribution: filled && noaaPoints ? `${NOAA_ATTRIBUTION}; ${CAMS_ATTRIBUTION}` : filled ? CAMS_ATTRIBUTION : NOAA_ATTRIBUTION,
    url: SOURCE_URL,
    data: { points: samples.map((s, i) => ({ ...s, aq: aq[i] })) },
  };
};
