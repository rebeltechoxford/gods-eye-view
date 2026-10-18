import test from 'node:test';
import assert from 'node:assert/strict';

// The worker module installs `self.onmessage` when imported; give it a
// stand-in global that records what it posts.
const posted = [];
globalThis.self = { postMessage: (message) => posted.push(message) };
await import('./sdr.worker.js');
const send = (data) => globalThis.self.onmessage({ data });

const RATE = 1_024_000;
const BLOCK = 32_768;

/** One 8-bit RTL-SDR block: optional AM carrier at -250 kHz plus noise. */
function rtlBlock(carrier, start) {
  let state = 12_345 + start;
  const noise = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return (state / 4_294_967_296 - 0.5) * 0.05;
  };
  const bytes = new Uint8Array(BLOCK * 2);
  for (let k = 0; k < BLOCK; k += 1) {
    const t = (start + k) / RATE;
    const envelope = carrier
      ? 0.4 * (1 + 0.8 * Math.sin(2 * Math.PI * 1_000 * t))
      : 0;
    const phase = 2 * Math.PI * -250_000 * t;
    bytes[2 * k] = Math.round(
      127.5 + 128 * (envelope * Math.cos(phase) + noise()),
    );
    bytes[2 * k + 1] = Math.round(
      127.5 + 128 * (envelope * Math.sin(phase) + noise()),
    );
  }
  return bytes.buffer;
}

test('the decoder worker demodulates airband at the configured offset with squelch', () => {
  send({
    type: 'configure',
    mode: 'air',
    sampleRate: RATE,
    location: null,
    offsetHz: -250_000,
    squelchDb: 6,
  });
  let sample = 0;
  const feed = (carrier, blocks) => {
    const start = posted.length;
    for (let block = 0; block < blocks; block += 1) {
      send({ type: 'samples', buffer: rtlBlock(carrier, sample) });
      sample += BLOCK;
    }
    return posted.slice(start);
  };
  const signal = feed(true, 12);
  assert.equal(signal.length, 12);
  for (const message of signal) {
    assert.equal(message.type, 'air');
    assert.ok(message.samples instanceof Float32Array);
    assert.equal(message.samples.length, 1_536);
    assert.equal(message.squelchOpen, true);
  }
  assert.ok(signal.at(-1).snr > 20, `SNR ${signal.at(-1).snr}`);
  assert.ok(signal.at(-1).samples.some((value) => Math.abs(value) > 0.2));

  // Carrier gone: the squelch hangs ~300 ms, then mutes the noise.
  const silence = feed(false, 20);
  assert.ok(silence.at(-1).snr < 3);
  assert.equal(silence.at(-1).squelchOpen, false);
  assert.ok(silence.at(-1).samples.every((value) => value === 0));

  // Squelch off at runtime: the noise is heard.
  send({ type: 'squelch', db: 0 });
  const open = feed(false, 1);
  assert.equal(open[0].squelchOpen, true);
  assert.ok(open[0].samples.some((value) => value !== 0));

  // A retune keeps airband mode; FM still produces FM messages.
  send({ type: 'reset', offsetHz: -250_000 });
  assert.equal(feed(false, 1)[0].type, 'air');
  send({ type: 'configure', mode: 'fm', sampleRate: 2_048_000 });
  assert.equal(feed(false, 1)[0].type, 'fm');
});
