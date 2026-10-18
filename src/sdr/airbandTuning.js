/**
 * Airband (aircraft voice, AM) tuning for the local RTL-SDR: the band, the
 * offset tuning that keeps the RTL-SDR's DC spike off the listened channel,
 * channel steps and the squelch setting. Pure; shared by the controller, the
 * decoder worker and the card presentation.
 */

/** VHF aeronautical voice band edges (AM), in Hz. */
export const AIRBAND_MIN_HZ = 118_000_000;
export const AIRBAND_MAX_HZ = 136_975_000;
/** International guard / emergency frequency, the default listen frequency. */
export const AIRBAND_DEFAULT_HZ = 121_500_000;
/** IQ rate for airband: plenty for one 25 kHz channel plus the offset. */
export const AIRBAND_SAMPLE_RATE = 1_024_000;
/**
 * The tuner centre sits this far ABOVE the listened frequency, so the RTL-SDR
 * DC spike and its low-frequency IQ imbalance never land on the channel. The
 * worker demodulates at `listen - centre` (normally -250 kHz). 250 kHz stays
 * well inside the +/-512 kHz window of the 1.024 MS/s stream at every listen
 * frequency, including the band edges (centre 118.250-137.225 MHz, all
 * within the R820T/R828D tuning range).
 */
export const AIRBAND_TUNING_OFFSET_HZ = 250_000;
/** Frequencies are kept to whole kHz (8.33 kHz channel labels like 118.005). */
export const AIRBAND_FREQUENCY_RESOLUTION_HZ = 1_000;
/** One 25 kHz channel: the step of the card's channel buttons. */
export const AIRBAND_CHANNEL_STEP_HZ = 25_000;

export const AIRBAND_SQUELCH_MIN_DB = 0;
export const AIRBAND_SQUELCH_MAX_DB = 30;
/**
 * Default squelch threshold in dB of channel SNR (see `airbandChannelSnrDb`
 * in `airband.js`). Receiver noise alone reads about 0-1 dB on that scale, so
 * 6 dB keeps the speaker quiet between transmissions while a carrier only
 * about 6 dB above the noise floor (readable AM voice) still opens it.
 */
export const AIRBAND_SQUELCH_DEFAULT_DB = 6;
export const AIRBAND_SQUELCH_STORAGE_KEY = 'gev:sdr:air-squelch:v1';

/** Well-known airband channels offered as suggestions on the card. */
export const AIRBAND_COMMON_FREQUENCIES = Object.freeze([
  Object.freeze({ frequencyHz: 121_500_000, label: 'Guard / emergency' }),
  Object.freeze({ frequencyHz: 122_750_000, label: 'Air-to-air' }),
  Object.freeze({ frequencyHz: 123_025_000, label: 'Helicopter air-to-air' }),
]);

/**
 * Clamp a frequency to the airband and round it to 1 kHz.
 * @param {number} value Frequency in Hz.
 * @returns {number} A listenable airband frequency; the guard frequency when
 *   `value` is not a number.
 */
export function clampAirFrequency(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return AIRBAND_DEFAULT_HZ;
  const rounded =
    Math.round(requested / AIRBAND_FREQUENCY_RESOLUTION_HZ) *
    AIRBAND_FREQUENCY_RESOLUTION_HZ;
  return Math.max(AIRBAND_MIN_HZ, Math.min(AIRBAND_MAX_HZ, rounded));
}

/**
 * The tuner centre frequency for a listened airband frequency.
 * @param {number} listenHz Listened frequency in Hz.
 * @returns {number}
 */
export function airbandCenterFrequency(listenHz) {
  return clampAirFrequency(listenHz) + AIRBAND_TUNING_OFFSET_HZ;
}

/**
 * Normalize a squelch threshold to whole dB within 0-30 dB (0 = off).
 * @param {*} value Requested threshold in dB.
 * @returns {number|null} The threshold, or null when not a number.
 */
export function normalizeAirSquelch(value) {
  if (value === null || value === undefined || value === '') return null;
  const requested = Number(value);
  if (!Number.isFinite(requested)) return null;
  return Math.max(
    AIRBAND_SQUELCH_MIN_DB,
    Math.min(AIRBAND_SQUELCH_MAX_DB, Math.round(requested)),
  );
}

/**
 * Read the stored squelch threshold, falling back to the default.
 * @param {Storage|null} storage Browser storage or a test double.
 * @returns {number}
 */
export function readAirSquelch(storage) {
  let stored = null;
  try {
    stored = JSON.parse(
      storage?.getItem?.(AIRBAND_SQUELCH_STORAGE_KEY) || 'null',
    );
  } catch {
    stored = null;
  }
  return normalizeAirSquelch(stored) ?? AIRBAND_SQUELCH_DEFAULT_DB;
}

/**
 * Persist the squelch threshold. Storage failures are ignored.
 * @param {Storage|null} storage Browser storage or a test double.
 * @param {number} db Normalized threshold.
 * @returns {boolean} Whether the write succeeded.
 */
export function writeAirSquelch(storage, db) {
  try {
    storage?.setItem?.(AIRBAND_SQUELCH_STORAGE_KEY, JSON.stringify(db));
    return Boolean(storage?.setItem);
  } catch {
    return false;
  }
}
