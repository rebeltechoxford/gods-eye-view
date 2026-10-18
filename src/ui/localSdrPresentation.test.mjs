import test from 'node:test';
import assert from 'node:assert/strict';

import {
  internetRadioAudioActive,
  localSdrCardView,
  localSdrFeedLine,
  localSdrAudioActive,
  localSdrModeHasAudio,
} from './localSdrPresentation.js';

const idle = Object.freeze({
  webUsbSupported: true,
  connected: false,
  status: 'idle',
  message: 'Connect an RTL-SDR to begin.',
  mode: 'fm',
  frequencyHz: 98_500_000,
  volume: 0.8,
  gain: 'auto',
  seeking: false,
  seekMessage: '',
  decodedMessages: 0,
  messagesPerSecond: null,
  aircraftHeard: 0,
  aircraftPositioned: 0,
  deviceLabel: null,
  locationStatus: 'unknown',
  audioState: 'idle',
  samplesPerSecond: 0,
  workerBlocks: 0,
  iqLevelDbfs: null,
  audioLevelDbfs: null,
});

test('an idle card invites a connection and hides receiver stats', () => {
  const view = localSdrCardView(idle);
  assert.equal(view.statusText, 'Connect an RTL-SDR to begin.');
  assert.equal(view.connectLabel, 'CONNECT');
  assert.equal(view.connectDisabled, false);
  assert.equal(view.connectionLabel, 'IDLE');
  assert.equal(view.gainValue, 'auto');
  assert.equal(view.statsHidden, true);
  assert.equal(view.tuneDisabled, true);
  assert.equal(view.seekDisabled, true);
  assert.equal(view.frequencyValue, '98.5');
  const unsupported = localSdrCardView({
    ...idle,
    webUsbSupported: false,
    status: 'unsupported',
    message: 'WebUSB is unavailable in this browser',
  });
  assert.equal(unsupported.connectDisabled, true);
  assert.equal(unsupported.changeDeviceDisabled, true);
  assert.equal(unsupported.statusError, true);
});

test('streaming ADS-B shows message rate, heard, positioned and IQ level', () => {
  const view = localSdrCardView({
    ...idle,
    connected: true,
    status: 'streaming',
    mode: 'adsb',
    message: 'Receiving 1090 MHz ADS-B',
    gain: 20.7,
    messagesPerSecond: 13.8,
    aircraftHeard: 4,
    aircraftPositioned: 2,
    iqLevelDbfs: -21.44,
    samplesPerSecond: 2_000_000,
    decodedMessages: 276,
    deviceLabel: 'FlyCatcher_ADS_B',
  });
  assert.equal(view.statsHidden, false);
  assert.deepEqual(view.stats, {
    rate: '13.8',
    heard: '4',
    positioned: '2',
    iq: '-21.4 dBFS',
  });
  assert.equal(view.gainValue, '20.7');
  assert.equal(view.connectionLabel, '4 HEARD');
  assert.equal(view.connectLabel, 'DISCONNECT');
  assert.equal(view.frequencyDisabled, true);
  assert.equal(view.volumeDisabled, true);
  assert.equal(
    view.statusText,
    'Receiving 1090 MHz ADS-B · FlyCatcher_ADS_B · 2.00 MS/s IQ · 276 messages',
  );
});

test('local FM and internet radio audio states drive the one-listener rule', () => {
  assert.equal(localSdrAudioActive(idle), false);
  assert.equal(
    localSdrAudioActive({ ...idle, connected: true, status: 'streaming' }),
    true,
  );
  assert.equal(
    localSdrAudioActive({
      ...idle,
      connected: true,
      status: 'streaming',
      mode: 'adsb',
    }),
    false,
    'ADS-B produces no audio',
  );
  for (const audioState of ['loading', 'buffering', 'playing'])
    assert.equal(internetRadioAudioActive({ audioState }), true);
  assert.equal(internetRadioAudioActive({ audioState: 'paused' }), false);
  assert.equal(internetRadioAudioActive(null), false);
});

test('the decoder-feed line appears only when feeds are configured', () => {
  assert.equal(localSdrFeedLine(null), null);
  assert.equal(
    localSdrFeedLine({ configured: false, feeds: [], polling: false }),
    null,
  );
  const feeds = [
    { band: '1090', label: '1090 MHz', status: 'live' },
    { band: '978', label: '978 MHz UAT', status: 'unreachable' },
  ];
  assert.equal(
    localSdrFeedLine({ configured: true, polling: true, feeds }),
    'Decoder feeds: 1090 live · 978 unreachable',
  );
  assert.equal(
    localSdrFeedLine({ configured: true, polling: false, feeds }),
    'Decoder feeds: 1090 · 978 · read while Local ADS-B is on',
  );
  assert.equal(
    localSdrFeedLine({
      configured: true,
      polling: false,
      feeds: [{ band: null, label: 'entry 2', status: 'invalid' }],
    }),
    'Decoder feeds: entry 2 invalid · read while Local ADS-B is on',
  );
});

test('two feeds on one band are told apart by their ordinal labels', () => {
  const feeds = [
    { band: '1090', label: '1090 MHz', status: 'live' },
    { band: '978', label: '978 MHz UAT #1', status: 'live' },
    { band: '978', label: '978 MHz UAT #2', status: 'stale' },
  ];
  assert.equal(
    localSdrFeedLine({ configured: true, polling: true, feeds }),
    'Decoder feeds: 1090 live · 978 MHz UAT #1 live · 978 MHz UAT #2 stale',
  );
  assert.equal(
    localSdrFeedLine({ configured: true, polling: false, feeds }),
    'Decoder feeds: 1090 · 978 MHz UAT #1 · 978 MHz UAT #2 · read while Local ADS-B is on',
  );
});

test('FM shows one decimal and seeks; airband shows three decimals and steps channels', () => {
  const fm = localSdrCardView({
    ...idle,
    connected: true,
    status: 'streaming',
  });
  assert.equal(fm.fmActive, true);
  assert.equal(fm.airActive, false);
  assert.equal(fm.frequencyLabel, 'FM MHZ');
  assert.equal(fm.frequencyValue, '98.5');
  assert.deepEqual(
    [fm.frequencyMin, fm.frequencyMax, fm.frequencyStep],
    ['87.5', '108', '0.1'],
  );
  assert.equal(fm.frequencySuggestions, null);
  assert.equal(fm.seekBackLabel, '◀ SEEK');
  assert.equal(fm.seekForwardLabel, 'SEEK ▶');
  assert.equal(fm.seekGroupLabel, 'Seek broadcast FM stations');
  assert.equal(fm.squelchHidden, true);
  assert.equal(fm.airHelpHidden, true);

  const air = localSdrCardView({
    ...idle,
    connected: true,
    status: 'streaming',
    mode: 'air',
    message: 'Receiving airband AM',
    frequencyHz: 118_005_000,
    squelchDb: 6,
    squelchOpen: false,
    snr: 1.24,
    samplesPerSecond: 1_024_000,
    workerBlocks: 30,
    iqLevelDbfs: -30,
    audioState: 'running',
  });
  assert.equal(air.airActive, true);
  assert.equal(air.fmActive, false);
  assert.equal(air.adsbActive, false);
  assert.equal(air.frequencyLabel, 'AIR MHZ');
  assert.equal(air.frequencyValue, '118.005');
  assert.deepEqual(
    [air.frequencyMin, air.frequencyMax, air.frequencyStep],
    ['118.000', '136.975', '0.005'],
  );
  assert.equal(air.frequencySuggestions, 'sdr-air-frequencies');
  assert.equal(air.frequencyDisabled, false);
  assert.equal(air.tuneDisabled, false);
  assert.equal(air.seekDisabled, false, 'channel steps work while streaming');
  assert.equal(air.seekBackLabel, '◀ 25 KHZ');
  assert.equal(air.seekForwardLabel, '25 KHZ ▶');
  assert.equal(air.seekBackTitle, 'Step down one 25 kHz airband channel');
  assert.equal(air.seekForwardTitle, 'Step up one 25 kHz airband channel');
  assert.equal(air.seekGroupLabel, 'Step airband channels');
  assert.equal(air.volumeDisabled, false);
  assert.equal(air.statsHidden, true, 'ADS-B stats stay hidden');
  assert.equal(air.connectionLabel, 'STREAMING');
  assert.equal(
    air.statusText,
    'Receiving airband AM · 1.02 MS/s IQ · DSP 30 blocks · RF -30.0 dBFS · SNR 1.2 dB · squelch closed · audio running',
  );
  const open = localSdrCardView({
    ...idle,
    connected: true,
    status: 'streaming',
    mode: 'air',
    frequencyHz: 121_500_000,
    squelchDb: 6,
    squelchOpen: true,
  });
  assert.equal(open.connectionLabel, 'RECEIVING');
  assert.match(open.statusText, /squelch open/);
  assert.equal(open.frequencyValue, '121.500');
});

test('the squelch slider shows only in airband and reads OFF at 0 dB', () => {
  const air = { ...idle, mode: 'air', frequencyHz: 121_500_000 };
  const defaults = localSdrCardView(air);
  assert.equal(defaults.squelchHidden, false);
  assert.equal(defaults.airHelpHidden, false);
  assert.equal(defaults.squelchValue, '6', 'default threshold is 6 dB');
  assert.equal(defaults.squelchText, '6 dB');
  const off = localSdrCardView({ ...air, squelchDb: 0 });
  assert.equal(off.squelchValue, '0');
  assert.equal(off.squelchText, 'OFF');
  const streamingOff = { ...air, connected: true, status: 'streaming' };
  assert.match(
    localSdrCardView({ ...streamingOff, squelchDb: 0 }).statusText,
    /squelch off/,
  );
  assert.equal(
    localSdrCardView({ ...air, squelchDb: 18 }).squelchText,
    '18 dB',
  );
  for (const mode of ['fm', 'adsb'])
    assert.equal(localSdrCardView({ ...idle, mode }).squelchHidden, true);
  // Disconnected airband cannot tune or step yet.
  assert.equal(defaults.tuneDisabled, true);
  assert.equal(defaults.seekDisabled, true);
});

test('airband audio counts as local listening, like FM', () => {
  assert.equal(localSdrModeHasAudio('fm'), true);
  assert.equal(localSdrModeHasAudio('air'), true);
  assert.equal(localSdrModeHasAudio('adsb'), false);
  const streamingAir = {
    ...idle,
    connected: true,
    status: 'streaming',
    mode: 'air',
  };
  assert.equal(localSdrAudioActive(streamingAir), true);
  assert.equal(
    localSdrAudioActive({ ...streamingAir, status: 'tuning' }),
    false,
  );
  assert.equal(
    localSdrAudioActive({ ...streamingAir, connected: false }),
    false,
  );
});
