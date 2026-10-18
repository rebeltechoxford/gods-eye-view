import { localReceiverFeedName } from '../layers/localAdsb/feedNames.js';
import {
  AIRBAND_MAX_HZ,
  AIRBAND_MIN_HZ,
  AIRBAND_SQUELCH_DEFAULT_DB,
} from '../sdr/airbandTuning.js';

/**
 * Pure presentation of the Local RTL-SDR card in the Radio panel. Receives the
 * receiver session snapshot and returns what each control should show.
 */

function formatGain(gain) {
  return gain === 'auto' || !Number.isFinite(gain) ? 'auto' : gain.toFixed(1);
}

function formatIq(state) {
  return Number.isFinite(state.iqLevelDbfs)
    ? `${state.iqLevelDbfs.toFixed(1)} dBFS`
    : '--';
}

/**
 * Whether a receiver mode plays audio (broadcast FM and airband AM do; ADS-B
 * does not).
 * @param {string} mode Receiver mode.
 * @returns {boolean}
 */
export function localSdrModeHasAudio(mode) {
  return mode === 'fm' || mode === 'air';
}

function formatSquelch(db) {
  return db > 0 ? `${db} dB` : 'OFF';
}

function squelchDb(state) {
  return Number.isFinite(state.squelchDb)
    ? state.squelchDb
    : AIRBAND_SQUELCH_DEFAULT_DB;
}

// Frequency entry per audio mode: label, input range and displayed decimals.
const FREQUENCY_FIELDS = Object.freeze({
  fm: Object.freeze({
    label: 'FM MHZ',
    min: '87.5',
    max: '108',
    step: '0.1',
    decimals: 1,
  }),
  air: Object.freeze({
    label: 'AIR CARRIER MHZ',
    min: (AIRBAND_MIN_HZ / 1_000_000).toFixed(3),
    max: (AIRBAND_MAX_HZ / 1_000_000).toFixed(3),
    step: '0.005',
    decimals: 3,
  }),
});

function statusText(state) {
  const fmActive = state.mode === 'fm';
  const airActive = state.mode === 'air';
  const audioActive = fmActive || airActive;
  const iqStatus =
    state.samplesPerSecond > 0
      ? `${(state.samplesPerSecond / 1_000_000).toFixed(2)} MS/s IQ`
      : 'waiting for IQ';
  const device = state.deviceLabel ? ` · ${state.deviceLabel}` : '';
  if (state.connected && !audioActive) {
    return `${state.message}${device} · ${iqStatus} · ${state.decodedMessages} messages`;
  }
  const detail = state.seeking
    ? state.seekMessage
    : state.seekMessage || state.message;
  if (state.connected && audioActive) {
    const workerStatus =
      state.workerBlocks > 0
        ? `DSP ${state.workerBlocks} blocks`
        : 'DSP waiting';
    const rfStatus = `RF ${formatIq(state)}`;
    if (airActive) {
      const snr = Number.isFinite(state.snr)
        ? `SNR ${state.snr.toFixed(1)} dB`
        : 'SNR --';
      const squelch =
        squelchDb(state) > 0
          ? `squelch ${state.squelchOpen ? 'open' : 'closed'}`
          : 'squelch off';
      return `${detail}${device} · ${iqStatus} · ${workerStatus} · ${rfStatus} · ${snr} · ${squelch} · audio ${state.audioState}`;
    }
    const audioSignal = Number.isFinite(state.audioLevelDbfs)
      ? `${state.audioLevelDbfs.toFixed(1)} dBFS audio`
      : 'audio signal --';
    return `${detail}${device} · ${iqStatus} · ${workerStatus} · ${rfStatus} · ${audioSignal} · audio ${state.audioState}`;
  }
  return detail;
}

/**
 * Derive the card's control states from one receiver snapshot.
 * @param {object} state SdrController.getState() snapshot.
 * @returns {object} Control presentation.
 */
export function localSdrCardView(state) {
  const transitional =
    state.status === 'connecting' || state.status === 'tuning';
  const fmActive = state.mode === 'fm';
  const airActive = state.mode === 'air';
  const adsbActive = state.mode === 'adsb';
  const audioMode = fmActive || airActive;
  const streaming = state.connected && state.status === 'streaming';
  const fmInteractive = streaming && fmActive;
  const field = FREQUENCY_FIELDS[state.mode] || FREQUENCY_FIELDS.fm;
  const squelch = squelchDb(state);
  return {
    connectionLabel: state.connected
      ? adsbActive
        ? `${state.aircraftHeard || 0} HEARD`
        : airActive && state.squelchOpen && squelch > 0
          ? 'RECEIVING'
          : 'STREAMING'
      : String(state.status || 'idle').toUpperCase(),
    connectionActive: Boolean(state.connected),
    connectLabel: transitional
      ? String(state.status).toUpperCase()
      : state.connected
        ? 'DISCONNECT'
        : 'CONNECT',
    connectDisabled: transitional || !state.webUsbSupported,
    connectPressed: Boolean(state.connected),
    fmActive,
    airActive,
    adsbActive,
    modeDisabled: transitional,
    locateLabel:
      state.locationStatus === 'requesting'
        ? 'LOCATING…'
        : state.locationStatus === 'ready'
          ? 'LOCATED'
          : 'LOCATE',
    locateDisabled: state.locationStatus === 'requesting',
    locateActive: state.locationStatus === 'ready',
    changeDeviceDisabled: transitional || !state.webUsbSupported,
    gainValue: formatGain(state.gain),
    gainDisabled: transitional,
    statsHidden: !(adsbActive && state.connected),
    stats: {
      rate: Number.isFinite(state.messagesPerSecond)
        ? state.messagesPerSecond.toFixed(1)
        : '--',
      heard: String(state.aircraftHeard || 0),
      positioned: String(state.aircraftPositioned || 0),
      iq: formatIq(state),
    },
    frequencyLabel: field.label,
    frequencyMin: field.min,
    frequencyMax: field.max,
    frequencyStep: field.step,
    frequencyDisabled: !audioMode || transitional,
    frequencyValue: audioMode
      ? (state.frequencyHz / 1_000_000).toFixed(field.decimals)
      : null,
    // Airband suggests well-known channels; FM has no suggestion list.
    frequencySuggestions: airActive ? 'sdr-air-frequencies' : null,
    tuneDisabled: !state.connected || !audioMode || transitional,
    // In airband the seek buttons step one 25 kHz channel.
    seekDisabled: airActive
      ? !streaming
      : !fmInteractive || Boolean(state.seeking),
    seekGroupLabel: airActive
      ? 'Step airband channels'
      : 'Seek broadcast FM stations',
    seekBackLabel: airActive ? '◀ 25 KHZ' : '◀ SEEK',
    seekForwardLabel: airActive ? '25 KHZ ▶' : 'SEEK ▶',
    seekBackTitle: airActive
      ? 'Step down one 25 kHz airband channel'
      : 'Seek down to the previous FM station',
    seekForwardTitle: airActive
      ? 'Step up one 25 kHz airband channel'
      : 'Seek up to the next FM station',
    squelchHidden: !airActive,
    squelchValue: String(squelch),
    squelchText: formatSquelch(squelch),
    airHelpHidden: !airActive,
    volumePercent: Math.round((Number(state.volume) || 0) * 100),
    volumeDisabled: !audioMode,
    statusText: statusText(state),
    statusError: state.status === 'error' || state.status === 'unsupported',
  };
}

/**
 * Whether the receiver is producing audio, broadcast FM or airband AM (the
 * state that must not overlap internet-radio playback).
 * @param {object} state SdrController.getState() snapshot.
 * @returns {boolean}
 */
export function localSdrAudioActive(state) {
  return Boolean(
    state?.connected &&
    localSdrModeHasAudio(state.mode) &&
    state.status === 'streaming',
  );
}

/**
 * Whether internet radio is loading or playing a station.
 * @param {object} state Radio UI state.
 * @returns {boolean}
 */
export function internetRadioAudioActive(state) {
  return ['loading', 'buffering', 'playing'].includes(state?.audioState);
}

/**
 * One-line decoder-feed summary for the card, or null when the server has no
 * feed configured. Statuses show while Local ADS-B polls the feeds; otherwise
 * the line names the configured bands.
 * @param {object|null} feedState Local receiver feed session snapshot.
 * @returns {string|null}
 */
export function localSdrFeedLine(feedState) {
  const feeds = feedState?.configured === true ? feedState.feeds : null;
  if (!Array.isArray(feeds) || !feeds.length) return null;
  const names = feeds.map((feed) => {
    const name = localReceiverFeedName(feed, feeds);
    return feedState.polling || feed?.status === 'invalid'
      ? `${name} ${feed?.status || 'unreachable'}`
      : name;
  });
  const suffix = feedState.polling ? '' : ' · read while Local ADS-B is on';
  return `Decoder feeds: ${names.join(' · ')}${suffix}`;
}
