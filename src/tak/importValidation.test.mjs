import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCotRecord } from './cot.js';
import { createCotStore } from './contactStore.js';

test('rejects overlength UIDs instead of truncating contact identity', () => {
  const prefix = 'a'.repeat(160);
  for (const suffix of ['A', 'B']) {
    assert.equal(normalizeCotRecord({ uid: prefix + suffix, lat: 1, lon: 2 }), null);
  }
  const store = createCotStore();
  const first = normalizeCotRecord({ uid: 'a'.repeat(159) + 'A', lat: 1, lon: 2 });
  const second = normalizeCotRecord({ uid: 'a'.repeat(159) + 'B', lat: 3, lon: 4 });
  assert.equal(first.uid.length, 160);
  assert.equal(second.uid.length, 160);
  store.ingest([first, second]);
  assert.equal(store.count(), 2);
});

test('rejects whitespace-only coordinates while retaining explicit zero', () => {
  for (const value of ['', ' ', '\t', '\n']) {
    assert.equal(normalizeCotRecord({ uid: 'test', lat: value, lon: 0 }), null);
    assert.equal(normalizeCotRecord({ uid: 'test', lat: 0, lon: value }), null);
  }
  const zero = normalizeCotRecord({ uid: 'test', lat: ' 0 ', lon: '0' });
  assert.equal(zero.lat, 0);
  assert.equal(zero.lon, 0);
});

test('rejects coercible nonnumeric coordinate types', () => {
  for (const value of [true, false, [], [0], {}]) {
    assert.equal(normalizeCotRecord({ uid: 'test', lat: value, lon: 0 }), null);
    assert.equal(normalizeCotRecord({ uid: 'test', lat: 0, lon: value }), null);
  }
});
