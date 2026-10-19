import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceLocation } from './deviceLocation.js';

function fakeGeo() {
  const watches = [];
  const cleared = [];
  return {
    watches,
    cleared,
    active: () => watches.filter((w) => !cleared.includes(w.id)),
    watchPosition(fix, error) {
      const id = watches.length + 1;
      watches.push({ id, fix, error });
      return id;
    },
    clearWatch: (id) => cleared.push(id),
  };
}

const position = (lat, lon, timestamp, accuracy = 8) => ({
  coords: { latitude: lat, longitude: lon, accuracy },
  timestamp,
});

test('consumers share one device watch and it stops with the last consumer', () => {
  const geo = fakeGeo();
  let now = 1_000_000;
  const hub = createDeviceLocation(geo, { documentRef: null, now: () => now });
  const map = hub.consumer();
  const tak = hub.consumer();
  const mapFixes = [];
  const takFixes = [];
  assert.equal(
    map.start(
      (fix) => mapFixes.push(fix),
      () => {},
    ),
    true,
  );
  geo.watches[0].fix(position(34.36, -89.52, now));
  assert.equal(
    tak.start(
      (fix) => takFixes.push(fix),
      () => {},
    ),
    true,
  );
  assert.equal(geo.watches.length, 1, 'the second consumer reuses the watch');
  assert.equal(takFixes.length, 1, 'a recent fix is handed over at once');
  assert.equal(takFixes[0].lat, 34.36);
  now += 1_000;
  geo.watches[0].fix(position(34.37, -89.53, now));
  assert.deepEqual(
    [mapFixes.length, takFixes.length],
    [2, 2],
    'both receive later fixes',
  );
  map.stop();
  assert.equal(geo.active().length, 1, 'TAK still holds the watch');
  assert.equal(map.isActive(), false);
  assert.equal(tak.isActive(), true);
  tak.stop();
  assert.equal(geo.active().length, 0, 'no consumer, no watch');
  assert.equal(hub.lastFix(), null, 'the last position is dropped');
});

test('an old fix is not handed to a late consumer', () => {
  const geo = fakeGeo();
  let now = 1_000_000;
  const hub = createDeviceLocation(geo, { documentRef: null, now: () => now });
  hub.consumer().start(
    () => {},
    () => {},
  );
  geo.watches[0].fix(position(1, 2, now));
  now += 31_000;
  const late = [];
  hub.consumer().start(
    (fix) => late.push(fix),
    () => {},
  );
  assert.equal(late.length, 0);
});

test('a device error stops the watch and tells every consumer', () => {
  const geo = fakeGeo();
  const hub = createDeviceLocation(geo, { documentRef: null });
  const errors = [];
  const a = hub.consumer();
  const b = hub.consumer();
  a.start(
    () => {},
    (message) => errors.push(['a', message]),
  );
  b.start(
    () => {},
    (message) => errors.push(['b', message]),
  );
  geo.watches[0].error({ message: 'User denied Geolocation' });
  assert.deepEqual(errors.map(([who]) => who).sort(), ['a', 'b']);
  assert.match(errors[0][1], /denied/);
  assert.equal(a.isActive(), false);
  assert.equal(b.isActive(), false);
  assert.equal(geo.active().length, 0);
  // Either may try again, which opens a fresh watch.
  assert.equal(
    a.start(
      () => {},
      () => {},
    ),
    true,
  );
  assert.equal(geo.watches.length, 2);
});

test('no device geolocation: start reports false and holds nothing', () => {
  const hub = createDeviceLocation(null, { documentRef: null });
  const consumer = hub.consumer();
  assert.equal(
    consumer.start(
      () => {},
      () => {},
    ),
    false,
  );
  assert.equal(consumer.isActive(), false);
});

test('restarting a consumer replaces its callbacks without a second watch', () => {
  const geo = fakeGeo();
  const hub = createDeviceLocation(geo, { documentRef: null });
  const consumer = hub.consumer();
  const first = [];
  const second = [];
  consumer.start(
    (fix) => first.push(fix),
    () => {},
  );
  consumer.start(
    (fix) => second.push(fix),
    () => {},
  );
  geo
    .active()
    .at(-1)
    .fix(position(5, 6, Date.now()));
  assert.equal(first.length, 0);
  assert.equal(second.length, 1);
  assert.equal(geo.active().length, 1);
});
