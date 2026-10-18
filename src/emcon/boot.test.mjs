import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { EmconError } from './guard.js';

test('cold startup waits for cache-only acknowledgment and timeout stays closed', async (t) => {
  const requests = [];
  const messages = [];
  const controller = {
    postMessage(message, ports) {
      messages.push({ message, port: ports[0] });
    },
  };
  const replacements = {
    navigator: { serviceWorker: { controller, addEventListener() {} } },
    location: { origin: 'https://tak.internal' },
    localStorage: {
      getItem: () =>
        JSON.stringify({
          version: 1,
          active: true,
          since: '2026-10-18T00:00:00Z',
        }),
    },
    fetch: async (url) => {
      requests.push(url);
      return { ok: true };
    },
  };
  const originals = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  const boot = await import('./boot.js');
  const asset = '/cesium/Assets/approximateTerrainHeights.json';
  let started = false;
  const startup = boot.emconStartupReady.then(async (confirmed) => {
    assert.equal(confirmed, true);
    started = true;
    await globalThis.fetch(asset);
  });
  await setImmediate();
  assert.equal(
    started,
    false,
    'scene startup waits while the worker is pending',
  );
  assert.deepEqual(requests, []);
  await assert.rejects(globalThis.fetch(asset), EmconError);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].message, { type: 'GEV_EMCON', active: true });
  messages[0].port.postMessage({ ok: true, active: true });
  await startup;
  assert.deepEqual(
    requests,
    [asset],
    'cached static reads start after acknowledgment',
  );
  await assert.rejects(globalThis.fetch('/api/tak/status'), EmconError);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timedOut = boot.syncEmconWorker(true);
  t.mock.timers.tick(1000);
  assert.equal(await timedOut, false);
  await assert.rejects(globalThis.fetch(asset), EmconError);
  assert.equal(await boot.syncEmconWorker(true, { controller: null }), false);
  await assert.rejects(globalThis.fetch(asset), EmconError);
  boot.emconState.destroy();
});
