import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { expandApplicationHtml } from '../../build/application-html.js';
import { createBrowserViteConfig } from '../../build/vite.js';
import { R820T_GAIN_STEPS_DB } from '../sdr/gain.js';

const html = expandApplicationHtml(
  readFileSync(new URL('../../index.html', import.meta.url), 'utf8'),
);
const css = readFileSync(
  new URL('./styles/radio.css', import.meta.url),
  'utf8',
);

test('the Local RTL-SDR card lives inside the Radio panel with every control', () => {
  const radioStart = html.indexOf('id="radio-panel"');
  const cardStart = html.indexOf('id="sdr-radio-card"');
  const radioEnd = html.indexOf('</section>', radioStart);
  assert.ok(radioStart >= 0 && cardStart > radioStart && cardStart < radioEnd);
  for (const id of [
    'sdr-connection-state',
    'sdr-connect-btn',
    'sdr-locate-btn',
    'sdr-change-device-btn',
    'sdr-mode-fm-btn',
    'sdr-mode-air-btn',
    'sdr-mode-adsb-btn',
    'sdr-gain-select',
    'sdr-adsb-stats',
    'sdr-stat-rate',
    'sdr-stat-heard',
    'sdr-stat-positioned',
    'sdr-stat-iq',
    'sdr-frequency-label',
    'sdr-frequency-input',
    'sdr-tune-btn',
    'sdr-air-frequencies',
    'sdr-air-help',
    'sdr-seek-row',
    'sdr-seek-back-btn',
    'sdr-seek-forward-btn',
    'sdr-squelch-row',
    'sdr-squelch',
    'sdr-squelch-value',
    'sdr-volume',
    'sdr-status',
    'sdr-feed-status',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} is missing`);
  }
  assert.match(html, /id="sdr-status"[^>]*>Connect an RTL-SDR to begin\.</);
  assert.match(css, /\.sdr-radio-card\s*\{/);
});

test('the AIR mode sits between FM and ADS-B with airband help and a squelch slider', () => {
  const row = html.slice(
    html.indexOf('aria-label="RTL-SDR receiver mode"'),
    html.indexOf('</div>', html.indexOf('aria-label="RTL-SDR receiver mode"')),
  );
  const order = [
    'sdr-mode-fm-btn',
    'sdr-mode-air-btn',
    'sdr-mode-adsb-btn',
  ].map((id) => row.indexOf(`id="${id}"`));
  assert.ok(order.every((index, n) => index > (n ? order[n - 1] : -1)));
  assert.match(
    html,
    /id="sdr-mode-air-btn" type="button" aria-pressed="false"[^>]*>AIR</,
  );
  const datalist = html.slice(
    html.indexOf('id="sdr-air-frequencies"'),
    html.indexOf('</datalist>'),
  );
  assert.deepEqual(
    [...datalist.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]),
    ['121.500', '122.750', '123.025'],
  );
  assert.match(
    html,
    /id="sdr-air-help"[^>]*hidden>Enter the actual carrier frequency in MHz\. 8\.33 kHz channel labels are not converted \(channel 118\.005 uses a 118\.000 MHz carrier\)\. 121\.500 guard\/emergency · 122\.750 air-to-air · 123\.025 helicopter air-to-air\. No receiver\? <a href="https:\/\/www\.liveatc\.net\/" target="_blank" rel="noopener noreferrer">Listen online at LiveATC<\/a> \(opens liveatc\.net; not available under EMCON\)\.</,
  );
  assert.match(
    html,
    /id="sdr-squelch-row"[^>]*for="sdr-squelch" hidden>/,
    'squelch starts hidden (FM is the default mode)',
  );
  assert.match(
    html,
    /id="sdr-squelch" class="gev-quantitative-slider" type="range" min="0" max="30" step="1" value="6" aria-label="[^"]+"/,
  );
  assert.match(
    html,
    /id="sdr-frequency-label" for="sdr-frequency-input"[^>]*>FM MHZ</,
  );
  assert.match(css, /\.sdr-squelch-row\[hidden\]/);
});

test('the gain control offers AUTO plus every R820T step', () => {
  const start = html.indexOf('id="sdr-gain-select"');
  const select = html.slice(start, html.indexOf('</select>', start));
  const values = [...select.matchAll(/<option value="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(values, [
    'auto',
    ...R820T_GAIN_STEPS_DB.map((step) => step.toFixed(1)),
  ]);
});

test('worker-reached SDR dependencies are pre-bundled and builds keep a separate cache', () => {
  const serve = createBrowserViteConfig();
  for (const dependency of [
    '@jtarrio/signals/demod/demodulator.js',
    '@jtarrio/signals/demod/modes.js',
    '@jtarrio/webrtlsdr/rtlsdr.js',
  ]) {
    assert.ok(serve.optimizeDeps.include.includes(dependency), dependency);
  }
  assert.equal(serve.cacheDir, undefined);
  assert.equal(
    createBrowserViteConfig({ command: 'build' }).cacheDir,
    'node_modules/.vite-build',
  );
});
