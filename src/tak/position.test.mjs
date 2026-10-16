import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isGpsFixFresh,
  describePosition,
  GPS_FIX_MAX_AGE_MS,
} from './position.js';

test('device position freshness uses measured age and foreground/source stays explicit', () => {
  const fix = {
    lat: 0,
    lon: -89.5,
    ce: 12.1,
    source: 'GPS',
    observedAtMs: 10_000,
  };
  assert.equal(isGpsFixFresh(fix, 10_001), true);
  assert.equal(isGpsFixFresh(fix, 10_000 + GPS_FIX_MAX_AGE_MS + 1), false);
  assert.equal(isGpsFixFresh({ ...fix, observedAtMs: 100_000 }, 10_000), false);
  assert.match(
    describePosition(fix, { nowMs: 12_000 }),
    /±13 m reported accuracy.*2s old.*FRESH/,
  );
  assert.match(
    describePosition(fix, { nowMs: 12_000, foreground: false }),
    /BACKGROUND.*broadcast paused/,
  );
  assert.match(
    describePosition(fix, { nowMs: 100_000 }),
    /STALE.*broadcast paused/,
  );
  assert.match(
    describePosition({ ...fix, source: 'USER' }),
    /OPERATOR SET.*not device GPS/,
  );
});
