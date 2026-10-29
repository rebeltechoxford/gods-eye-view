import '@jtarrio/signals/demod/demodulator.js';
import { getDemod, getMode } from '@jtarrio/signals/demod/modes.js';
import {
  AdsbStreamDecoder,
  decodeAdsbMessage,
  pruneAircraftTracks,
  updateAircraftTrack,
} from './adsbDecoder.js';
import { analyzeSpectrum } from './spectrum.js';
import { createAirbandReceiver } from './airband.js';
import {
  AIRBAND_SAMPLE_RATE,
  AIRBAND_SQUELCH_DEFAULT_DB,
  AIRBAND_TUNING_OFFSET_HZ,
} from './airbandTuning.js';
import { recordFromDecoderTrack } from '../sources/adsbRecords.js';

let mode = 'fm';
let sampleRate = 2_048_000;
let receiverLocation = null;
let demodulator = null;
// Airband: the listened channel sits at this offset from the tuner centre.
let airOffsetHz = -AIRBAND_TUNING_OFFSET_HZ;
let airSquelchDb = AIRBAND_SQUELCH_DEFAULT_DB;
let airReceiver = null;
let blockCount = 0;
let tune = 0;
// True while handling a block the controller stamped for diagnostics.
let timedBlock = false;
const aircraft = new Map();
// Positions refused by the decoder's speed check since the last clear.
const decoderStats = { positionsRejected: 0 };
const adsbStream = new AdsbStreamDecoder();

function workerMode(value) {
  return value === 'adsb' || value === 'air' ? value : 'fm';
}

function defaultSampleRate(value) {
  if (value === 'adsb') return 2_000_000;
  return value === 'air' ? AIRBAND_SAMPLE_RATE : 2_048_000;
}

function configure(nextMode, nextSampleRate, location, options = {}) {
  const modeChanged = mode !== workerMode(nextMode);
  mode = workerMode(nextMode);
  sampleRate = Number(nextSampleRate) || defaultSampleRate(mode);
  receiverLocation = location || receiverLocation;
  if (Number.isFinite(options.offsetHz)) airOffsetHz = options.offsetHz;
  if (Number.isFinite(options.squelchDb)) airSquelchDb = options.squelchDb;
  blockCount = 0;
  demodulator =
    mode === 'fm'
      ? getDemod(sampleRate, 48_000, { ...getMode('WBFM'), stereo: false })
      : null;
  airReceiver =
    mode === 'air'
      ? createAirbandReceiver({
          sampleRate,
          offsetHz: airOffsetHz,
          squelchDb: airSquelchDb,
        })
      : null;
  if (modeChanged) {
    adsbStream.reset();
    aircraft.clear();
  }
}

function normalizedIq(buffer) {
  const bytes = new Uint8Array(buffer);
  const length = Math.floor(bytes.length / 2);
  const i = new Float32Array(length);
  const q = new Float32Array(length);
  let power = 0;
  for (let index = 0; index < length; index += 1) {
    i[index] = (bytes[index * 2] - 127.5) / 128;
    q[index] = (bytes[index * 2 + 1] - 127.5) / 128;
    power += i[index] * i[index] + q[index] * q[index];
  }
  return {
    i,
    q,
    iqLevelDbfs: 10 * Math.log10(Math.max(power / Math.max(length, 1), 1e-12)),
  };
}

function sampledIqLevel(buffer) {
  const bytes = new Uint8Array(buffer);
  let power = 0;
  let count = 0;
  for (let index = 0; index + 1 < bytes.length; index += 32) {
    const i = (bytes[index] - 127.5) / 128;
    const q = (bytes[index + 1] - 127.5) / 128;
    power += i * i + q * q;
    count += 1;
  }
  return 10 * Math.log10(Math.max(power / Math.max(count, 1), 1e-12));
}

function audioLevel(samples) {
  let power = 0;
  for (const sample of samples) power += sample * sample;
  return (
    20 *
    Math.log10(Math.max(Math.sqrt(power / Math.max(samples.length, 1)), 1e-12))
  );
}

function publicAircraft() {
  const records = [];
  for (const track of aircraft.values()) {
    const record = recordFromDecoderTrack(track);
    if (record) records.push(record);
  }
  return records;
}

/**
 * Every samples message the controller numbered is acknowledged once, after
 * any decoder output, whatever this worker did with it (FM, ADS-B, nothing,
 * or an error, which still reaches onerror). The controller bounds unacked
 * work, so an acknowledgement must never depend on producing output.
 */
self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type !== 'samples' || !Number.isSafeInteger(message.id)) {
    handleMessage(message);
    return;
  }
  // Diagnostic mode only: the controller stamped the block, so time it here.
  const timed = Number.isFinite(message.postedAt);
  const receivedAt = timed ? absoluteNow() : 0;
  const started = timed ? performance.now() : 0;
  timedBlock = timed;
  try {
    handleMessage(message);
  } finally {
    timedBlock = false;
    self.postMessage(
      timed
        ? {
            type: 'ack',
            id: message.id,
            receivedAt,
            computeMs: performance.now() - started,
            ackPostedAt: absoluteNow(),
          }
        : { type: 'ack', id: message.id },
    );
  }
};

/** Wall-aligned milliseconds comparable across the page and its workers. */
function absoluteNow() {
  return performance.timeOrigin + performance.now();
}

function handleMessage(message) {
  if (message.type === 'configure') {
    if (Number.isSafeInteger(message.tune)) tune = message.tune;
    configure(message.mode, message.sampleRate, message.location, {
      offsetHz: message.offsetHz,
      squelchDb: message.squelchDb,
    });
    return;
  }
  if (message.type === 'squelch') {
    if (Number.isFinite(message.db)) airSquelchDb = message.db;
    airReceiver?.setSquelch(airSquelchDb);
    return;
  }
  if (message.type === 'location') {
    receiverLocation = message.location || null;
    return;
  }
  if (message.type === 'reset') {
    blockCount = 0;
    tune = message.tune;
    adsbStream.reset();
    if (message.clearAircraft) {
      aircraft.clear();
      decoderStats.positionsRejected = 0;
    }
    if (mode === 'fm' || mode === 'air')
      configure(mode, sampleRate, receiverLocation, {
        offsetHz: message.offsetHz,
      });
    return;
  }
  if (message.type !== 'samples' || !(message.buffer instanceof ArrayBuffer))
    return;

  blockCount += 1;
  if (mode === 'fm') {
    // Only seek reads spectra: skip the FFT and its transfer otherwise.
    const bins =
      message.spectrum === true && blockCount % 3 === 0
        ? analyzeSpectrum(message.buffer)
        : null;
    const { i, q, iqLevelDbfs } = normalizedIq(message.buffer);
    const decoded = demodulator.demodulate(i, q, 0);
    // The demodulator owns pooled output arrays. Transfer a copy so detaching
    // the message buffer cannot invalidate the pool used by the next block.
    const samples = new Float32Array(decoded.left);
    self.postMessage(
      {
        type: 'fm',
        ...(timedBlock ? { workerPostedAt: absoluteNow() } : {}),
        samples,
        bins,
        tune,
        snr:
          Number.isFinite(decoded.snr) && decoded.snr > 0
            ? 10 * Math.log10(decoded.snr)
            : null,
        diagnostics:
          blockCount % 15 === 0
            ? {
                workerBlocks: blockCount,
                iqLevelDbfs,
                audioLevelDbfs: audioLevel(samples),
              }
            : null,
      },
      [samples.buffer, ...(bins ? [bins.buffer] : [])],
    );
    return;
  }

  if (mode === 'air') {
    const { i, q, iqLevelDbfs } = normalizedIq(message.buffer);
    const { samples, snrDb, squelchOpen } = airReceiver.process(i, q);
    self.postMessage(
      {
        type: 'air',
        tune,
        samples,
        snr: snrDb,
        squelchOpen,
        diagnostics:
          blockCount % 15 === 0
            ? {
                workerBlocks: blockCount,
                iqLevelDbfs,
                audioLevelDbfs: audioLevel(samples),
              }
            : null,
      },
      [samples.buffer],
    );
    return;
  }

  const now = Date.now();
  let decodedCount = 0;
  for (const bytes of adsbStream.extract(message.buffer, sampleRate)) {
    const decoded = decodeAdsbMessage(bytes, { receivedAt: now });
    if (!decoded) continue;
    updateAircraftTrack(aircraft, decoded, receiverLocation, decoderStats);
    decodedCount += 1;
  }
  const removed = pruneAircraftTracks(aircraft, now);
  if (decodedCount || removed || blockCount % 30 === 0) {
    self.postMessage({
      type: 'adsb',
      tune,
      aircraft: publicAircraft(),
      decodedCount,
      positionsRejected: decoderStats.positionsRejected,
      diagnostics:
        blockCount % 30 === 0
          ? {
              workerBlocks: blockCount,
              iqLevelDbfs: sampledIqLevel(message.buffer),
            }
          : null,
    });
  }
}

configure(mode, sampleRate, receiverLocation);
// Module loaded and configured: the controller may start sending blocks.
self.postMessage({ type: 'ready' });
