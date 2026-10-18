import '@jtarrio/signals/demod/demodulator.js';
import { getDemod, getMode } from '@jtarrio/signals/demod/modes.js';
import { AIRBAND_SQUELCH_DEFAULT_DB } from './airbandTuning.js';

/**
 * Airband AM receiver DSP for the decoder worker: one offset-tuned AM channel
 * demodulated to 48 kHz audio, with a carrier squelch. Pure (no worker or DOM
 * globals) so it runs under Node for tests.
 */

export const AIRBAND_AUDIO_RATE = 48_000;
/** RF channel bandwidth: +/-5 kHz around the carrier (AM voice). */
export const AIRBAND_BANDWIDTH_HZ = 10_000;
/** Squelch stays open this long after the signal drops, so speech isn't chopped. */
export const AIRBAND_SQUELCH_HANG_MS = 300;
// Upper bound reported when the channel holds (almost) all the power.
const MAX_CHANNEL_SNR_DB = 60;
// Envelope peak window: 10 chunks of 5 ms. Far longer than a voice period,
// far shorter than the 0.5 s carrier tracker inside the library's detector.
const PEAK_CHUNK_S = 0.005;
const PEAK_WINDOW_CHUNKS = 10;
// DC blocker pole: about a 40 Hz corner at 48 kHz.
const DC_BLOCK_POLE = 0.995;

/**
 * Channel SNR in dB from the AM demodulator's in-band power ratio.
 *
 * `DemodAM` reports `snr` = in-band power density / average density over the
 * whole `outRate` window, which tops out at outRate/bandwidth (6.8 dB for
 * 10 kHz in 48 kHz). This converts it to in-band density / out-of-band
 * density (the receiver noise floor next to the channel): about 0 dB for
 * noise alone and rising without that ceiling as a carrier fills the channel.
 * @param {number} demodSnr `snr` returned by `DemodAM.demodulate`.
 * @param {number} [bandwidth] Channel bandwidth in Hz.
 * @param {number} [outRate] Demodulator output rate in Hz.
 * @returns {number|null} SNR in dB, or null when not measurable.
 */
export function airbandChannelSnrDb(
  demodSnr,
  bandwidth = AIRBAND_BANDWIDTH_HZ,
  outRate = AIRBAND_AUDIO_RATE,
) {
  if (!Number.isFinite(demodSnr) || demodSnr <= 0) return null;
  const fraction = bandwidth / outRate;
  const outOfBand = Math.max(1 - demodSnr * fraction, 1e-12);
  const ratio = (demodSnr * (1 - fraction)) / outOfBand;
  return Math.min(MAX_CHANNEL_SNR_DB, 10 * Math.log10(ratio));
}

/**
 * Audio cleanup after the library's AM detector, which outputs the envelope
 * divided by a slowly tracked (0.5 s) carrier level, minus one. After
 * squelched silence that tracker sits at the noise level, so the start of
 * every transmission would come out as a huge DC step with far too much
 * gain (and a freshly built detector starts from zero, a spike of thousands).
 * Dividing the envelope by its peak over the last ~50 ms keeps it within
 * 0..1 from the first sample and forgets a spike within 50 ms, and a DC
 * blocker then leaves only the modulation: a 100% modulated carrier peaks
 * near +/-0.5, never past +/-1.
 * @param {number} outRate Audio rate.
 * @returns {(samples: Float32Array) => void} In-place processor.
 */
function createEnvelopeNormalizer(outRate) {
  const chunkLength = Math.max(1, Math.round(PEAK_CHUNK_S * outRate));
  const chunkPeaks = new Float32Array(PEAK_WINDOW_CHUNKS);
  let chunkIndex = 0;
  let chunkFill = 0;
  let chunkPeak = 0;
  let windowPeak = 0;
  let previousIn = 0;
  let previousOut = 0;
  return (samples) => {
    for (let index = 0; index < samples.length; index += 1) {
      const envelope = Math.max(0, samples[index] + 1);
      chunkPeak = Math.max(chunkPeak, envelope);
      const peak = Math.max(windowPeak, chunkPeak);
      const normalized = peak > 0 ? envelope / peak : 0;
      chunkFill += 1;
      if (chunkFill >= chunkLength) {
        chunkPeaks[chunkIndex] = chunkPeak;
        chunkIndex = (chunkIndex + 1) % PEAK_WINDOW_CHUNKS;
        chunkFill = 0;
        chunkPeak = 0;
        windowPeak = Math.max(...chunkPeaks);
      }
      const blocked = normalized - previousIn + DC_BLOCK_POLE * previousOut;
      previousIn = normalized;
      previousOut = blocked;
      samples[index] = Math.max(-1, Math.min(1, blocked));
    }
  };
}

/**
 * One airband AM channel: frequency shift by `offsetHz`, resample to 48 kHz,
 * 10 kHz channel filter, AM detection, envelope normalization and squelch.
 * @param {object} options
 * @param {number} options.sampleRate IQ rate in samples per second.
 * @param {number} options.offsetHz Listened frequency minus tuner centre.
 * @param {number} [options.squelchDb] Threshold in dB; 0 disables squelch.
 * @param {number} [options.outRate] Audio rate.
 */
export function createAirbandReceiver({
  sampleRate,
  offsetHz,
  squelchDb = AIRBAND_SQUELCH_DEFAULT_DB,
  outRate = AIRBAND_AUDIO_RATE,
}) {
  const demodulator = getDemod(sampleRate, outRate, {
    ...getMode('AM'),
    bandwidth: AIRBAND_BANDWIDTH_HZ,
  });
  const normalize = createEnvelopeNormalizer(outRate);
  const hangSamples = Math.round((AIRBAND_SQUELCH_HANG_MS / 1_000) * outRate);
  let offset = Number(offsetHz) || 0;
  let threshold = Math.max(0, Number(squelchDb) || 0);
  let hangRemaining = 0;
  return {
    get offsetHz() {
      return offset;
    },
    get squelchDb() {
      return threshold;
    },
    setSquelch(db) {
      threshold = Math.max(0, Number(db) || 0);
    },
    setOffset(hz) {
      offset = Number(hz) || 0;
    },
    /**
     * Demodulate one IQ block (`i` and `q` are modified in place).
     * @param {Float32Array} i In-phase samples.
     * @param {Float32Array} q Quadrature samples.
     * @returns {{samples: Float32Array, snrDb: number|null, squelchOpen: boolean}}
     *   `samples` is a fresh array the caller may transfer; silence while the
     *   squelch is closed.
     */
    process(i, q) {
      const decoded = demodulator.demodulate(i, q, offset);
      const snrDb = airbandChannelSnrDb(
        decoded.snr,
        AIRBAND_BANDWIDTH_HZ,
        outRate,
      );
      // The demodulator owns pooled output arrays: always hand out a copy.
      const samples = new Float32Array(decoded.left);
      normalize(samples);
      let squelchOpen = true;
      if (threshold > 0) {
        if (snrDb !== null && snrDb >= threshold) {
          hangRemaining = hangSamples;
        } else if (hangRemaining > 0) {
          hangRemaining = Math.max(0, hangRemaining - samples.length);
        } else {
          squelchOpen = false;
          samples.fill(0);
        }
      }
      return { samples, snrDb, squelchOpen };
    },
  };
}
