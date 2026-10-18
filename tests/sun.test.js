import test from 'node:test';
import assert from 'node:assert/strict';
import { daylight } from '../shared/sun.js';

const minutesApart = (a, b) => Math.abs(a - b) / 60000;

test('sun: Yosemite Valley on 2026-10-17 matches an independent source within 3 min', () => {
  // api.sunrise-sunset.org for 37.73N 119.57W: sunset 01:19:32Z, civil dusk 01:44:39Z.
  const d = daylight(Date.parse('2026-10-17T21:00:00Z'), -119.57, 37.73);
  assert.ok(minutesApart(d.sunset, Date.parse('2026-10-18T01:19:32Z')) < 3, new Date(d.sunset).toISOString());
  assert.ok(minutesApart(d.civilDusk, Date.parse('2026-10-18T01:44:39Z')) < 3, new Date(d.civilDusk).toISOString());
  assert.ok(d.civilDusk > d.sunset);
  assert.equal(d.isDaylight, true);
});

test('sun: after dark the next sunrise and sunset are tomorrow', () => {
  const now = Date.parse('2026-10-18T04:00:00Z'); // 9 PM PDT
  const d = daylight(now, -119.57, 37.73);
  assert.equal(d.isDaylight, false);
  assert.ok(d.sunrise > now && d.sunrise - now < 12 * 3600000);
  assert.ok(d.sunset > d.sunrise);
});

test('sun: polar day has no sunset', () => {
  const d = daylight(Date.parse('2026-06-21T12:00:00Z'), 20, 78);
  assert.equal(d.sunset, null);
});
