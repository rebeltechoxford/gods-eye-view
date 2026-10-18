import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeRoadPack } from './roadPack.js';
import { createRoadRouter } from './router.js';
import { offlineDirections } from './offlineDirections.js';
import { createOfflineRouteEngine } from './offlineEngine.js';
import { createOfflineFirstDirectionsSource } from './offlineSource.js';
import { gridSpec, syntheticPack } from '../testSupport/roadGraph.mjs';

const A = { lat: 34.3601, lon: -89.5199 };
const B = { lat: 34.3639, lon: -89.5161 };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Runs the worker protocol in-process, like src/routing/route.worker.js. */
function inlineWorker(log) {
  let loaded = null;
  const worker = {
    onmessage: null,
    onerror: null,
    terminate() {
      log.push('terminate');
    },
    postMessage(message) {
      log.push(message.type);
      queueMicrotask(() => {
        if (message.type === 'load') {
          const pack = decodeRoadPack(new Uint8Array(message.bytes));
          loaded = { key: message.key, router: createRoadRouter(pack) };
          worker.onmessage({
            data: { type: 'loaded', key: message.key, ok: true },
          });
        } else if (message.type === 'route') {
          try {
            const payload = offlineDirections(loaded.router, message);
            worker.onmessage({
              data: { type: 'route', id: message.id, ok: true, payload },
            });
          } catch (error) {
            worker.onmessage({
              data: {
                type: 'route',
                id: message.id,
                ok: false,
                error: { message: error.message, code: error.code },
              },
            });
          }
        }
      });
    },
  };
  return worker;
}

function engineWith(packs, { log = [], tamper = false } = {}) {
  return createOfflineRouteEngine({
    listPacks: async () => packs.map(({ record }) => record),
    readPack: async (id) => {
      const bytes = packs.find(({ record }) => record.id === id).bytes.slice();
      if (tamper) bytes[bytes.length - 1] ^= 1;
      return bytes;
    },
    createWorker: () => inlineWorker(log),
    verify: async (bytes) => sha(bytes),
  });
}

function packRecord(spec, overrides = {}) {
  const bytes = syntheticPack(spec);
  const pack = decodeRoadPack(bytes);
  return {
    bytes,
    record: {
      id: overrides.id || '5351b743-09b8-41fe-acd3-0436e449dece',
      name: overrides.name || 'Synthetic grid',
      sha256: sha(bytes),
      bytes: bytes.length,
      bounds: pack.bounds,
      state: 'ready',
      ...overrides,
    },
  };
}

test('the engine routes inside an installed pack and reuses the loaded pack', async () => {
  const log = [];
  const engine = engineWith([packRecord(gridSpec(5, 5))], { log });
  const first = await engine.route({ a: A, b: B });
  assert.equal(first.ok, true);
  assert.equal(first.offline.pack, 'Synthetic');
  const second = await engine.route({ a: B, b: A });
  assert.equal(second.ok, true);
  assert.deepEqual(log, ['load', 'route', 'route'], 'the pack decodes once');
});

test('the engine returns null when no ready pack covers both ends', async () => {
  const paused = packRecord(gridSpec(5, 5), { state: 'downloading' });
  assert.equal(await engineWith([paused]).route({ a: A, b: B }), null);
  const ready = packRecord(gridSpec(5, 5));
  assert.equal(
    await engineWith([ready]).route({ a: A, b: { lat: 40, lon: -89 } }),
    null,
  );
});

test('a damaged installed pack is refused before it is decoded', async () => {
  const log = [];
  await assert.rejects(
    engineWith([packRecord(gridSpec(5, 5))], { log, tamper: true }).route({
      a: A,
      b: B,
    }),
    /damaged; remove and download it again/,
  );
  assert.deepEqual(log, []);
});

test('the smallest covering pack is chosen', async () => {
  const log = [];
  const state = packRecord(gridSpec(5, 5), {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'State',
    bounds: { west: -91, south: 30, east: -88, north: 35 },
  });
  const town = packRecord(gridSpec(5, 5), {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Town',
  });
  const engine = createOfflineRouteEngine({
    listPacks: async () => [state.record, town.record],
    readPack: async (id) => {
      log.push(id);
      return (id === town.record.id ? town.bytes : state.bytes).slice();
    },
    createWorker: () => inlineWorker([]),
    verify: async (bytes) => sha(bytes),
  });
  await engine.route({ a: A, b: B });
  assert.deepEqual(log, [town.record.id]);
});

test('offline-first source: pack first, then online, with useful offline errors', async () => {
  const calls = [];
  const online = {
    async getRoute(request) {
      calls.push(request.mode);
      throw new TypeError('Failed to fetch');
    },
  };
  const covered = createOfflineFirstDirectionsSource({
    online,
    offline: { route: async () => ({ ok: true, offline: { pack: 'MS' } }) },
  });
  assert.equal(
    (await covered.getRoute({ mode: 'car', a: A, b: B })).offline.pack,
    'MS',
  );
  assert.deepEqual(calls, [], 'a covered drive never touches the network');

  const uncovered = createOfflineFirstDirectionsSource({
    online,
    offline: { route: async () => null },
  });
  await assert.rejects(
    uncovered.getRoute({ mode: 'car', a: A, b: B }),
    /Install an offline road pack/,
  );
  await assert.rejects(
    uncovered.getRoute({ mode: 'foot', a: A, b: B }),
    /cover driving only/,
  );

  const failing = createOfflineFirstDirectionsSource({
    online,
    offline: {
      route: async () => {
        throw new Error('No road near the start in this offline pack');
      },
    },
  });
  const callsBeforeFailure = calls.length;
  await assert.rejects(
    failing.getRoute({ mode: 'car', a: A, b: B }),
    /No road near the start in this offline pack/,
  );
  assert.equal(
    calls.length,
    callsBeforeFailure,
    'a covered-pack failure never discloses the trip online',
  );

  const reachable = createOfflineFirstDirectionsSource({
    online: { getRoute: async () => ({ ok: true, from: 'online' }) },
    offline: { route: async () => null },
  });
  assert.equal(
    (await reachable.getRoute({ mode: 'car', a: A, b: B })).from,
    'online',
  );

  const controller = new AbortController();
  controller.abort();
  const aborted = createOfflineFirstDirectionsSource({
    online,
    offline: {
      route: async (_request, { signal }) => {
        signal.throwIfAborted();
      },
    },
  });
  await assert.rejects(
    aborted.getRoute(
      { mode: 'car', a: A, b: B },
      { signal: controller.signal },
    ),
    (error) => error.name === 'AbortError',
  );
});

test('damaged, disconnected and timed-out offline packs never fall back online', async () => {
  for (const code of ['no-pack', 'no-road', 'no-route', 'aborted']) {
    const failure = Object.assign(new Error(`Synthetic ${code}`), { code });
    const source = createOfflineFirstDirectionsSource({
      online: {
        getRoute: async () =>
          assert.fail('private trip reached online routing'),
      },
      offline: {
        route: async () => {
          throw failure;
        },
      },
    });
    await assert.rejects(
      source.getRoute({ mode: 'car', a: A, b: B }),
      (error) => error === failure,
    );
  }
});
