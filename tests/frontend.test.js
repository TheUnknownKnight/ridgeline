/**
 * Frontend logic that decides whether a stretch reads as clear. These run in
 * Node: the functions are pure and touch no DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSegments } from '../src/js/panels/profile.js';
import { aheadView } from '../src/js/panels/verdict.js';

const ALL = ['fire', 'alerts', 'avalanche', 'water', 'air', 'forecast', 'smoke', 'conditions'];
const okSources = (overrides = {}) =>
  Object.fromEntries(ALL.map(k => [k, { status: 'ok', ...overrides[k] }]));

const seg = (mileStart, mileEnd, checked, refs = [], level = 0) =>
  ({ mileStart, mileEnd, level, estimatedOnly: false, refs, checked });

const result = (segments, extra = {}) => ({
  version: 2,
  mode: 'planning',
  sources: okSources(),
  hazards: {},
  segments,
  summary: { level: 0, headline: 'No reported hazards', counts: {}, incomplete: false, caveats: [] },
  ...extra,
});

test('a stretch outside US coverage is unchecked even when every source is ok', () => {
  const r = result([seg(0, 100, ALL), seg(100, 150, ['smoke'])]);
  const [inside, outside] = describeSegments(r);
  assert.deepEqual(inside.unchecked, []);
  assert.deepEqual(outside.unchecked, ['fire', 'alerts', 'avalanche', 'water', 'air', 'forecast', 'conditions']);
});

test('unrated avalanche terrain is unchecked, not clear', () => {
  const r = result([seg(0, 10, ALL.filter(k => k !== 'avalanche'))]);
  assert.deepEqual(describeSegments(r)[0].unchecked, ['avalanche']);
});

test('On trail: forecasts outside the look-ahead window are not flagged per stretch', () => {
  const official = ['fire', 'alerts', 'avalanche', 'water', 'air'];
  const r = result([seg(0, 10, official), seg(10, 25, ALL), seg(25, 60, official)], {
    mode: 'on-trail', window: { start: 10, end: 25, lookaheadMiles: 15 },
  });
  assert.deepEqual(describeSegments(r).map(v => v.unchecked), [[], [], []]);
});

test('a failed forecast is unchecked everywhere it did not run', () => {
  const r = result([seg(0, 10, ['fire', 'alerts', 'avalanche', 'water', 'air', 'smoke', 'conditions'])], {
    sources: okSources({ forecast: { status: 'error' } }),
  });
  assert.deepEqual(describeSegments(r)[0].unchecked, ['forecast']);
});

test('a hazard hidden by filters is reported as hidden, not as nothing', () => {
  const r = result([seg(0, 5, ALL, [{ id: 'fire:1', level: 4 }], 4)], {
    hazards: { 'fire:1': { id: 'fire:1', type: 'fire', level: 4, source: 'OFFICIAL' } },
  });
  const [view] = describeSegments(r, new Set(['fire']));
  assert.equal(view.level, 0);
  assert.equal(view.hiddenOnly, true);
});

test('On trail with nothing ahead never names a hazard behind the hiker', () => {
  const r = result([seg(0, 40, ALL), seg(42, 47, ALL, [{ id: 'fire:g', level: 4 }], 4), seg(47, 150, ALL)], {
    hazards: { 'fire:g': { id: 'fire:g', type: 'fire', level: 4, title: 'Garnet Fire', source: 'OFFICIAL' } },
    summary: { level: 4, headline: 'Garnet Fire (Mi 42–47)', counts: { 4: 1 }, incomplete: true, caveats: [] },
  });
  const view = aheadView(r, 60);
  assert.equal(view.level, 0);
  assert.doesNotMatch(view.headline, /Garnet/);
  assert.equal(view.incomplete, true);
});

test('On trail names the worst hazard ahead and its distance', () => {
  const r = result([seg(0, 40, ALL), seg(42, 47, ALL, [{ id: 'fire:g', level: 4 }], 4), seg(47, 150, ALL)], {
    hazards: { 'fire:g': { id: 'fire:g', type: 'fire', level: 4, title: 'Garnet Fire', source: 'OFFICIAL' } },
  });
  assert.equal(aheadView(r, 40).headline, 'Garnet Fire, 2.0 mi ahead');
  assert.equal(aheadView(r, 44).headline, 'Garnet Fire, here now');
});
