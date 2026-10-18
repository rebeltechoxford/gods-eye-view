import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AIRBAND_AUDIO_RATE,
  AIRBAND_SQUELCH_HANG_MS,
  airbandChannelSnrDb,
  createAirbandReceiver,
} from './airband.js';
import {
  AIRBAND_SAMPLE_RATE,
  AIRBAND_TUNING_OFFSET_HZ,
  airbandCenterFrequency,
} from './airbandTuning.js';

// End-to-end DSP checks on synthetic IQ at the rate and offset the
// controller tunes: the listened channel sits AIRBAND_TUNING_OFFSET_HZ below
// the tuner centre, so the worker demodulates at -250 kHz.
const RATE = AIRBAND_SAMPLE_RATE;
const BLOCK = 32_768; // one controller read
const OFFSET_HZ = 121_500_000 - airbandCenterFrequency(121_500_000);
const BLOCK_SECONDS = BLOCK / RATE;

/** Deterministic standard normal noise. */
function gaussian(seed) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return (state + 1) / 4_294_967_297;
  };
  return () =>
    Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

/**
 * IQ blocks of receiver noise plus, optionally, an AM carrier at
 * `carrierHz` from the centre modulated by a `toneHz` tone.
 */
function* iqBlocks({
  blocks,
  carrierHz = null,
  amplitude = 0.3,
  depth = 0.8,
  toneHz = 1_000,
  noise = 0.02,
  seed = 7,
  startSample = 0,
}) {
  const nextNoise = gaussian(seed);
  let n = startSample;
  for (let block = 0; block < blocks; block += 1) {
    const i = new Float32Array(BLOCK);
    const q = new Float32Array(BLOCK);
    for (let k = 0; k < BLOCK; k += 1, n += 1) {
      const t = n / RATE;
      if (carrierHz !== null) {
        const envelope =
          amplitude * (1 + depth * Math.sin(2 * Math.PI * toneHz * t));
        const phase = 2 * Math.PI * carrierHz * t;
        i[k] = envelope * Math.cos(phase);
        q[k] = envelope * Math.sin(phase);
      }
      i[k] += noise * nextNoise();
      q[k] += noise * nextNoise();
    }
    yield [i, q];
  }
}

/** Goertzel power of one frequency in a real signal. */
function tonePower(samples, frequency, rate = AIRBAND_AUDIO_RATE) {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / rate);
  let s1 = 0;
  let s2 = 0;
  for (const sample of samples) {
    const s0 = sample + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coefficient * s1 * s2;
}

/** Fraction of a signal's power in one tone (1 for a pure sinusoid). */
function toneShare(samples, frequency) {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  if (energy === 0) return 0;
  return (2 * tonePower(samples, frequency)) / (energy * samples.length);
}

function run(receiver, blocks) {
  const results = [];
  for (const [i, q] of blocks) results.push(receiver.process(i, q));
  return results;
}

/** Audio after the first half second, once the detector has settled. */
function settledAudio(results) {
  const skip = Math.ceil(0.5 / BLOCK_SECONDS);
  const tail = results.slice(skip).map((result) => result.samples);
  const audio = new Float32Array(tail.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const samples of tail) {
    audio.set(samples, offset);
    offset += samples.length;
  }
  return audio;
}

test('the worker offset puts the listened channel 250 kHz below the centre', () => {
  assert.equal(OFFSET_HZ, -AIRBAND_TUNING_OFFSET_HZ);
  assert.equal(OFFSET_HZ, -250_000);
});

test('an AM carrier at the listened channel demodulates to its 1 kHz tone', () => {
  const receiver = createAirbandReceiver({
    sampleRate: RATE,
    offsetHz: OFFSET_HZ,
  });
  const results = run(receiver, iqBlocks({ blocks: 24, carrierHz: OFFSET_HZ }));
  // 32,768 IQ samples at 1.024 MS/s are 32 ms: 1,536 samples at 48 kHz.
  assert.equal(results[0].samples.length, 1_536);
  assert.ok(results.every((result) => result.squelchOpen));
  assert.ok(results.at(-1).snrDb > 20, `SNR ${results.at(-1).snrDb} dB`);
  const audio = settledAudio(results);
  const at1k = tonePower(audio, 1_000);
  assert.ok(at1k > 1_000 * tonePower(audio, 3_000), '1 kHz >> 3 kHz');
  assert.ok(at1k > 1_000 * tonePower(audio, 2_000), '1 kHz >> 2 kHz');
  assert.ok(toneShare(audio, 1_000) > 0.9, 'the tone carries the audio power');
  let peak = 0;
  for (const result of results)
    for (const sample of result.samples)
      peak = Math.max(peak, Math.abs(sample));
  assert.ok(peak <= 1, 'audio never exceeds full scale, even at start-up');
  // 80% modulation comes out near 0.8 / 1.8 = 0.44 peak (0.31 RMS).
  let energy = 0;
  for (const sample of audio) energy += sample * sample;
  const rms = Math.sqrt(energy / audio.length);
  assert.ok(rms > 0.2 && rms < 0.45, `RMS ${rms}`);
});

test('a carrier at the wrong offset is not demodulated', () => {
  const listen = (carrierHz) => {
    const receiver = createAirbandReceiver({
      sampleRate: RATE,
      offsetHz: OFFSET_HZ,
      squelchDb: 0, // squelch off: compare the raw demodulated audio
    });
    const results = run(receiver, iqBlocks({ blocks: 24, carrierHz }));
    return { results, audio: settledAudio(results) };
  };
  const right = listen(OFFSET_HZ);
  // The mirror image of the channel (+250 kHz) and a carrier two channels
  // (50 kHz) away both stay out of the 10 kHz channel.
  for (const carrierHz of [-OFFSET_HZ, OFFSET_HZ + 50_000]) {
    const wrong = listen(carrierHz);
    assert.ok(toneShare(wrong.audio, 1_000) < 0.01, `${carrierHz} Hz`);
    assert.ok(
      tonePower(right.audio, 1_000) > 1_000 * tonePower(wrong.audio, 1_000),
      `${carrierHz} Hz`,
    );
    assert.ok(wrong.results.at(-1).snrDb < 3, `${carrierHz} Hz`);
  }
});

test('the default squelch mutes receiver noise and passes the tone', () => {
  const noiseReceiver = createAirbandReceiver({
    sampleRate: RATE,
    offsetHz: OFFSET_HZ,
  });
  assert.equal(noiseReceiver.squelchDb, 6);
  const noise = run(noiseReceiver, iqBlocks({ blocks: 24 }));
  for (const result of noise) {
    assert.equal(result.squelchOpen, false);
    assert.ok(result.snrDb < 3, `noise reads ${result.snrDb} dB`);
    assert.ok(result.samples.every((sample) => sample === 0));
  }

  // A weak carrier (-3 dB against the noise across the whole 1 MHz) is
  // still well above the threshold inside its 10 kHz channel.
  const weak = run(
    createAirbandReceiver({ sampleRate: RATE, offsetHz: OFFSET_HZ }),
    iqBlocks({ blocks: 24, carrierHz: OFFSET_HZ, amplitude: 0.02 }),
  );
  assert.ok(weak.every((result) => result.squelchOpen));
  assert.ok(toneShare(settledAudio(weak), 1_000) > 0.8);

  // Squelch off: the same noise is heard.
  const open = run(
    createAirbandReceiver({
      sampleRate: RATE,
      offsetHz: OFFSET_HZ,
      squelchDb: 0,
    }),
    iqBlocks({ blocks: 4 }),
  );
  assert.ok(open.every((result) => result.squelchOpen));
  assert.ok(open.at(-1).samples.some((sample) => sample !== 0));
});

test('squelch holds open for its hang time after a transmission ends', () => {
  const receiver = createAirbandReceiver({
    sampleRate: RATE,
    offsetHz: OFFSET_HZ,
  });
  const toneBlocks = 12;
  run(receiver, iqBlocks({ blocks: toneBlocks, carrierHz: OFFSET_HZ }));
  const after = run(
    receiver,
    iqBlocks({ blocks: 20, seed: 11, startSample: toneBlocks * BLOCK }),
  );
  const openBlocks = after.filter((result) => result.squelchOpen).length;
  const hangBlocks = AIRBAND_SQUELCH_HANG_MS / 1_000 / BLOCK_SECONDS;
  // The first block after the carrier still holds the filters' tail of it,
  // so the hang can start one block late.
  assert.ok(
    openBlocks >= Math.floor(hangBlocks) &&
      openBlocks <= Math.ceil(hangBlocks) + 1,
    `${openBlocks} blocks open after the carrier left`,
  );
  // Open blocks come first, then the squelch stays shut.
  assert.ok(after.slice(0, openBlocks).every((result) => result.squelchOpen));
  assert.ok(after.slice(openBlocks).every((result) => !result.squelchOpen));

  // Raising the threshold live closes it on a signal below the new level.
  receiver.setSquelch(30);
  const weak = run(
    receiver,
    iqBlocks({ blocks: 16, carrierHz: OFFSET_HZ, amplitude: 0.02, seed: 3 }),
  );
  assert.ok(weak.at(-1).snrDb < 30);
  assert.equal(weak.at(-1).squelchOpen, false);
});

test('channel SNR is 0 dB for flat noise and unbounded by the 48 kHz window', () => {
  // DemodAM reports in-band density / average density; noise gives 1.
  assert.equal(airbandChannelSnrDb(1), 0);
  assert.equal(airbandChannelSnrDb(0), null);
  assert.equal(airbandChannelSnrDb(Number.NaN), null);
  // Its ceiling (all power in band) maps to the 60 dB cap.
  assert.equal(airbandChannelSnrDb(48_000 / 10_000), 60);
  // Half the power in the channel: in-band density is 3.8x out-of-band.
  const half = airbandChannelSnrDb(0.5 * (48_000 / 10_000));
  assert.ok(Math.abs(half - 10 * Math.log10(38 / 10)) < 1e-9);
});
