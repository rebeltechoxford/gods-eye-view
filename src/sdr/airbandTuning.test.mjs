import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AIRBAND_COMMON_FREQUENCIES,
  AIRBAND_SQUELCH_DEFAULT_DB,
  AIRBAND_SQUELCH_STORAGE_KEY,
  airbandCenterFrequency,
  clampAirFrequency,
  normalizeAirSquelch,
  readAirSquelch,
  writeAirSquelch,
} from './airbandTuning.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test('airband frequencies clamp to the band, round to 1 kHz and centre 250 kHz above', () => {
  assert.equal(clampAirFrequency(121_500_000), 121_500_000);
  assert.equal(clampAirFrequency(117_975_000), 118_000_000);
  assert.equal(clampAirFrequency(137_000_000), 136_975_000);
  assert.equal(clampAirFrequency(118_005_400), 118_005_000);
  assert.equal(clampAirFrequency(118_005_600), 118_006_000);
  assert.equal(clampAirFrequency(Number.NaN), 121_500_000);
  assert.equal(airbandCenterFrequency(121_500_000), 121_750_000);
  assert.equal(airbandCenterFrequency(136_975_000), 137_225_000);
  assert.equal(airbandCenterFrequency(200_000_000), 137_225_000);
  assert.deepEqual(
    AIRBAND_COMMON_FREQUENCIES.map((entry) => entry.frequencyHz),
    [121_500_000, 122_750_000, 123_025_000],
  );
});

test('squelch normalizes to whole dB in 0-30 and persists', () => {
  assert.equal(AIRBAND_SQUELCH_DEFAULT_DB, 6);
  assert.equal(normalizeAirSquelch(-1), 0);
  assert.equal(normalizeAirSquelch(31), 30);
  assert.equal(normalizeAirSquelch('7.6'), 8);
  assert.equal(normalizeAirSquelch('quiet'), null);
  assert.equal(normalizeAirSquelch(null), null);
  const storage = memoryStorage();
  assert.equal(readAirSquelch(storage), 6);
  assert.equal(writeAirSquelch(storage, 14), true);
  assert.equal(storage.values.get(AIRBAND_SQUELCH_STORAGE_KEY), '14');
  assert.equal(readAirSquelch(storage), 14);
  assert.equal(
    readAirSquelch(memoryStorage({ [AIRBAND_SQUELCH_STORAGE_KEY]: '99' })),
    30,
  );
  const throwing = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(readAirSquelch(throwing), 6);
  assert.equal(writeAirSquelch(throwing, 3), false);
  assert.equal(readAirSquelch(null), 6);
});
