// EMCON freezes the layer manager: no refreshes, no new network layers,
// enabled layers keep their last data marked stale, nothing is persisted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager } from './manager.js';
import { EMCON_LOCAL_LAYER_IDS } from './lifecycle.js';

function layer(id) {
  const calls = { update: 0, enable: 0, disable: 0 };
  return {
    calls,
    module: {
      id,
      name: id,
      icon: '',
      source: 'test',
      updateInterval: -1,
      async init() {},
      enable() {
        calls.enable++;
      },
      disable() {
        calls.disable++;
      },
      async update() {
        calls.update++;
      },
      getStats() {
        return { count: 3, lastUpdate: 1 };
      },
    },
  };
}

function managerWith(...ids) {
  const manager = new DataLayerManager({});
  const layers = Object.fromEntries(ids.map((id) => [id, layer(id)]));
  for (const { module } of Object.values(layers)) manager.register(module);
  const blocked = [];
  manager.subscribe((change) => {
    if (change.type === 'visibility-blocked') blocked.push(change);
  });
  return { manager, layers, blocked };
}

test('EMCON refuses new network layers but keeps on-device ones available', async () => {
  const { manager, layers, blocked } = managerWith(
    'flights',
    'local-adsb',
    'directions',
  );
  assert.ok(EMCON_LOCAL_LAYER_IDS.includes('directions'));
  manager.setEmcon(true);
  assert.equal(manager.isEmcon(), true);
  await manager.toggle('flights', { origin: 'user' });
  assert.equal(manager.isEnabled('flights'), false);
  assert.equal(layers.flights.calls.update, 0, 'no fetch was started');
  assert.match(blocked.at(-1)?.reason ?? '', /EMCON is on/);
  // Local ADS-B reads the private host, which is a transmission too.
  await manager.toggle('local-adsb', { origin: 'user' });
  assert.equal(manager.isEnabled('local-adsb'), false);
  await manager.toggle('directions', { origin: 'user' });
  assert.equal(manager.isEnabled('directions'), true);
});

test('enabled layers stay on with their last data, frozen and marked stale', async () => {
  const { manager, layers } = managerWith('flights');
  await manager.toggle('flights', { origin: 'user' });
  assert.equal(manager.isEnabled('flights'), true);
  const before = layers.flights.calls.update;
  manager.setEmcon(true);
  assert.equal(await manager.refreshLayer('flights'), false);
  assert.equal(layers.flights.calls.update, before, 'refresh skipped');
  const stats = manager.getAll().find((row) => row.id === 'flights').stats;
  assert.equal(stats.count, 3, 'last data is still shown');
  assert.equal(stats.stale, true);
  assert.equal(stats.emcon, true);
  // Switching off is never refused under EMCON.
  await manager.toggle('flights', { origin: 'user' });
  assert.equal(manager.isEnabled('flights'), false);
  // Leaving EMCON lets the layer start and refresh again.
  manager.setEmcon(false);
  await manager.toggle('flights', { origin: 'user' });
  assert.equal(manager.isEnabled('flights'), true);
  assert.ok(layers.flights.calls.update > before);
});
