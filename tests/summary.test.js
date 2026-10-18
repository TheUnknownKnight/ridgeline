import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, rankHazards, spanText } from '../server/fusion/summary.js';
import { createHitTable, consolidate } from '../server/fusion/consolidate.js';

const ok = { status: 'ok' };
const sources = (overrides = {}) => ({ fire: ok, alerts: ok, avalanche: ok, water: ok, air: ok, forecast: ok, smoke: ok, ...overrides });
const hz = (id, level, source, ranges, extra = {}) => ({ id, level, source, ranges, title: id, ...extra });

test('summary: headline variants for clear, unavailable and stale data', () => {
  assert.equal(buildSummary({ hazards: {}, segments: [], sources: sources() }).headline, 'No reported hazards on this route');
  assert.match(buildSummary({ hazards: {}, segments: [], sources: sources({ fire: { status: 'error' } }) }).headline, /some sources are unavailable/);
  assert.match(buildSummary({ hazards: {}, segments: [], sources: sources({ fire: { status: 'stale' } }) }).headline, /out of date/);
});

test('summary: ranks by level, official first, then by first mile', () => {
  const ranked = rankHazards({
    a: hz('a', 2, 'ESTIMATED', [[1, 2]]),
    b: hz('b', 2, 'OFFICIAL', [[50, 51]]),
    c: hz('c', 3, 'OFFICIAL', [[90, 91]]),
    d: hz('d', 2, 'OFFICIAL', [[10, 11]]),
  });
  assert.deepEqual(ranked.map(h => h.id), ['c', 'd', 'b', 'a']);
  assert.equal(spanText([[1, 2], [5, 9.5]]), 'Mi 1–9.5 (2 sections)');
});

test('summary: next hazard skips a low estimate when something serious is ahead', () => {
  const hazards = { wind: hz('wind', 1, 'ESTIMATED', [[11, 12]]), fire: hz('fire', 4, 'OFFICIAL', [[20, 22]], { title: 'Wildfire' }) };
  const segments = [
    { mileStart: 0, mileEnd: 11, level: 0, refs: [] },
    { mileStart: 11, mileEnd: 12, level: 1, estimatedOnly: true, refs: [{ id: 'wind', level: 1 }] },
    { mileStart: 12, mileEnd: 20, level: 0, refs: [] },
    { mileStart: 20, mileEnd: 22, level: 4, refs: [{ id: 'fire', level: 4 }] },
  ];
  const s = buildSummary({ hazards, segments, sources: sources(), position: { mile: 10 } });
  assert.equal(s.nextHazard.id, 'fire');
  assert.equal(s.nextHazard.milesAhead, 10);
  const inside = buildSummary({ hazards, segments, sources: sources(), position: { mile: 21 } });
  assert.equal(inside.nextHazard.milesAhead, 0, 'standing inside a hazard reads as 0 mi ahead');
});

test('consolidate: keeps the closest distance and its note across merged chunks', () => {
  const chunks = [0, 1, 2].map(i => ({ i, start: i, end: i + 1 }));
  const table = createHitTable(3);
  table.add({ chunk: 0, id: 'f', level: 2, distance: 3.1, note: '3.1 mi', atMile: 0.5 });
  table.add({ chunk: 1, id: 'f', level: 2, distance: 2.2, note: '2.2 mi', atMile: 1.4 });
  table.add({ chunk: 1, id: 'f', level: 1, distance: 0.1, note: 'weaker' }); // lower level never replaces
  const catalog = new Map([['f', { id: 'f', source: 'OFFICIAL', title: 'Fire' }]]);
  const { segments, hazards } = consolidate(chunks, table, () => ['fire'], catalog);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0].refs, [{ id: 'f', level: 2, note: '2.2 mi', distance: 2.2 }]);
  assert.deepEqual(hazards.f.ranges, [[0, 2]]);
  assert.deepEqual(hazards.f.closest, { miles: 2.2, atMile: 1.4 });
});
