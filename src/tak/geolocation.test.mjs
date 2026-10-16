import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeolocation } from './geolocation.js';

test('GPS errors stop the watch; retry and teardown reject late fixes', () => {
  const watches = [],
    cleared = [],
    fixes = [],
    errors = [];
  const gps = createGeolocation({
    watchPosition: (fix, error) => {
      watches.push({ fix, error });
      return watches.length;
    },
    clearWatch: (id) => cleared.push(id),
  });
  gps.start(
    (fix) => fixes.push(fix),
    (error) => errors.push(error),
  );
  watches[0].error({ message: 'timeout' });
  watches[0].fix({ coords: { latitude: 10, longitude: 11 } });
  assert.deepEqual(cleared, [1]);
  assert.equal(fixes.length, 0);
  assert.equal(errors.length, 1);
  gps.start(
    (fix) => fixes.push(fix),
    () => {},
  );
  watches[1].fix({
    coords: { latitude: 20, longitude: 21, altitude: 3000, accuracy: 7 },
  });
  assert.equal(fixes[0].hae, 3000);
  gps.start(
    (fix) => fixes.push(fix),
    () => {},
  );
  assert.deepEqual(cleared, [1, 2]);
  gps.stop();
  watches[2].fix({ coords: { latitude: 30, longitude: 31 } });
  assert.deepEqual(cleared, [1, 2, 3]);
  assert.equal(fixes.length, 1);
});

test('GPS handles unavailable devices and synchronous permission failure', () => {
  assert.equal(
    createGeolocation(null).start(
      () => {},
      () => {},
    ),
    false,
  );
  const cleared = [];
  const gps = createGeolocation({
    watchPosition: (_fix, error) => {
      error({ message: 'denied' });
      return 9;
    },
    clearWatch: (id) => cleared.push(id),
  });
  assert.equal(
    gps.start(
      () => {},
      () => {},
    ),
    false,
  );
  assert.deepEqual(cleared, [9]);
});
