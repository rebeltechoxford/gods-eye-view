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

test('a lost or slow fix keeps the watch; a refusal ends it', () => {
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
  watches[0].fix({ coords: { latitude: 1, longitude: 2 } });
  // Chromium reports POSITION_UNAVAILABLE with an empty message when the
  // signal drops (a tunnel, a building), then delivers the next fix itself.
  watches[0].error({ code: 2, message: '' });
  watches[0].error({ code: 3, message: 'Timeout expired' });
  assert.deepEqual(errors, []);
  assert.deepEqual(cleared, []);
  assert.equal(gps.isActive(), true);
  watches[0].fix({ coords: { latitude: 3, longitude: 4 } });
  assert.equal(fixes.length, 2);
  watches[0].error({ code: 1, message: '' });
  assert.deepEqual(cleared, [1]);
  assert.deepEqual(errors, ['Device GPS unavailable: permission denied']);
  assert.equal(gps.isActive(), false);
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

test('foreground GPS pauses on hide, resumes only an armed watch, and keeps measured timestamps', () => {
  const doc = new EventTarget();
  doc.hidden = false;
  const watches = [],
    cleared = [],
    fixes = [];
  const gps = createGeolocation(
    {
      watchPosition: (fix, error) => {
        watches.push({ fix, error });
        return watches.length;
      },
      clearWatch: (id) => cleared.push(id),
    },
    { documentRef: doc, now: () => 999 },
  );
  gps.start(
    (fix) => fixes.push(fix),
    () => {},
  );
  watches[0].fix({
    coords: { latitude: 1, longitude: 2, accuracy: 9 },
    timestamp: 123,
  });
  assert.equal(fixes[0].observedAtMs, 123);
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(cleared, [1]);
  watches[0].fix({ coords: { latitude: 8, longitude: 9 }, timestamp: 124 });
  assert.equal(fixes.length, 1);
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(watches.length, 2);
  gps.destroy();
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(watches.length, 2);
  assert.deepEqual(cleared, [1, 2]);
});
