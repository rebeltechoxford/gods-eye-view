import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineRouteEngine } from './offlineEngine.js';
import { sha256Hex } from './packStore.js';
import { decodeRoadPack } from './roadPack.js';
import { createRoadRouter } from './router.js';
import { offlineDirections } from './offlineDirections.js';
import { gridSpec, syntheticPack } from '../testSupport/roadGraph.mjs';

// Synthetic Oxford street grid; trips stay inside it.
const GRID = syntheticPack(gridSpec(4, 4));
const TRIP = {
  a: { lat: 34.36, lon: -89.52 },
  b: { lat: 34.363, lon: -89.517 },
};

async function installed(id, bytes, bounds, extra = {}) {
  return {
    id,
    name: id,
    state: 'ready',
    sha256: await sha256Hex(bytes),
    bounds,
    ...extra,
  };
}

// Worker stand-ins that run the same steps as route.worker.js in-process.
// `hangLoads` workers swallow their load message and never answer.
function fakeWorkers({ hangLoads = 0 } = {}) {
  const made = [];
  let hangs = hangLoads;
  const createWorker = () => {
    let router = null;
    const worker = {
      loads: 0,
      terminated: false,
      postMessage(message) {
        assert.equal(worker.terminated, false, 'posted to a retired worker');
        if (message.type === 'load') {
          worker.loads++;
          if (hangs > 0) {
            hangs--;
            return;
          }
          router = createRoadRouter(
            decodeRoadPack(new Uint8Array(message.bytes)),
          );
          setImmediate(() =>
            worker.onmessage({
              data: { type: 'loaded', key: message.key, ok: true },
            }),
          );
          return;
        }
        const reply = router
          ? { ok: true, payload: offlineDirections(router, message) }
          : { ok: false, error: { message: 'not loaded', code: 'no-pack' } };
        setImmediate(() =>
          worker.onmessage({
            data: { type: 'route', id: message.id, ...reply },
          }),
        );
      },
      terminate() {
        worker.terminated = true;
      },
    };
    made.push(worker);
    return worker;
  };
  return { made, createWorker };
}

test('the smallest installed pack covering both ends routes the trip', async () => {
  const state = await installed('state', GRID, {
    west: -91,
    south: 33,
    east: -88,
    north: 35,
  });
  const town = await installed('town', GRID, {
    west: -89.53,
    south: 34.35,
    east: -89.5,
    north: 34.37,
  });
  const elsewhere = await installed('elsewhere', GRID, {
    west: -100,
    south: 40,
    east: -99,
    north: 41,
  });
  const pending = await installed('pending', GRID, town.bounds, {
    state: 'downloading',
  });
  const reads = [];
  const { made, createWorker } = fakeWorkers();
  const engine = createOfflineRouteEngine({
    listPacks: async () => [state, elsewhere, pending, town],
    readPack: async (id) => {
      reads.push(id);
      return GRID.slice();
    },
    createWorker,
  });
  const payload = await engine.route(TRIP);
  assert.equal(payload.ok, true);
  assert.ok(payload.distanceM > 0);
  assert.deepEqual(reads, ['town']);
  // A second trip reuses the decoded pack.
  await engine.route(TRIP);
  assert.deepEqual(reads, ['town']);
  assert.equal(made.length, 1);
  assert.equal(made[0].loads, 1);
  // No installed pack covers this trip: the caller falls back to online.
  assert.equal(
    await engine.route({
      a: { lat: 10, lon: 10 },
      b: { lat: 10.1, lon: 10.1 },
    }),
    null,
  );
  engine.unload();
  assert.equal(made[0].terminated, true);
});

test('a pack damaged in device storage is refused before decoding', async () => {
  const pack = await installed('town', GRID, {
    west: -89.53,
    south: 34.35,
    east: -89.5,
    north: 34.37,
  });
  const damaged = GRID.slice();
  damaged[200] ^= 0xff;
  const { made, createWorker } = fakeWorkers();
  const engine = createOfflineRouteEngine({
    listPacks: async () => [pack],
    readPack: async () => damaged,
    createWorker,
  });
  await assert.rejects(engine.route(TRIP), {
    code: 'no-pack',
    message: /is damaged; remove and download it again/,
  });
  assert.equal(made.length, 0, 'damaged bytes never reach a worker');
});

test('a hung worker is retired so the next trip still routes', async () => {
  const pack = await installed('town', GRID, {
    west: -89.53,
    south: 34.35,
    east: -89.5,
    north: 34.37,
  });
  const { made, createWorker } = fakeWorkers({ hangLoads: 1 });
  const engine = createOfflineRouteEngine({
    listPacks: async () => [pack],
    readPack: async () => GRID.slice(),
    createWorker,
    timeoutMs: 50,
  });
  await assert.rejects(engine.route(TRIP), {
    code: 'aborted',
    message: 'Offline routing timed out',
  });
  assert.equal(made[0].terminated, true);
  const payload = await engine.route(TRIP);
  assert.equal(payload.ok, true);
  assert.equal(made.length, 2, 'a fresh worker took over');
});

test('trips asked at once share one load, and only the pack bytes move', async () => {
  const pack = await installed('town', GRID, {
    west: -89.53,
    south: 34.35,
    east: -89.5,
    north: 34.37,
  });
  // The pack sits inside a larger buffer, as a storage view might hand it.
  const padded = new Uint8Array(GRID.length + 64);
  padded.set(GRID, 32);
  let reads = 0;
  const { made, createWorker } = fakeWorkers();
  const engine = createOfflineRouteEngine({
    listPacks: async () => [pack],
    readPack: async () => {
      reads++;
      return padded.subarray(32, 32 + GRID.length);
    },
    createWorker,
  });
  const results = await Promise.all([
    engine.route(TRIP),
    engine.route(TRIP),
    engine.route(TRIP),
  ]);
  assert.ok(results.every((payload) => payload.ok));
  assert.equal(reads, 1);
  assert.equal(made[0].loads, 1);
});

test('a cancelled trip rejects without disturbing the loaded pack', async () => {
  const pack = await installed('town', GRID, {
    west: -89.53,
    south: 34.35,
    east: -89.5,
    north: 34.37,
  });
  const { made, createWorker } = fakeWorkers();
  const engine = createOfflineRouteEngine({
    listPacks: async () => [pack],
    readPack: async () => GRID.slice(),
    createWorker,
  });
  await engine.route(TRIP);
  const controller = new AbortController();
  const cancelled = engine.route(TRIP, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal((await engine.route(TRIP)).ok, true);
  assert.equal(made.length, 1);
  assert.equal(made[0].loads, 1);
});

test('unload fences a pack read or digest that finishes after account retirement', async () => {
  for (const phase of ['read', 'digest']) {
    const pack = await installed('town', GRID, {
      west: -89.53,
      south: 34.35,
      east: -89.5,
      north: 34.37,
    });
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const { made, createWorker } = fakeWorkers();
    const engine = createOfflineRouteEngine({
      listPacks: async () => [pack],
      readPack: async () => {
        if (phase === 'read') {
          entered();
          await blocked;
        }
        return GRID.slice();
      },
      verify: async () => {
        if (phase === 'digest') {
          entered();
          await blocked;
        }
        return pack.sha256;
      },
      createWorker,
    });
    const route = engine.route(TRIP);
    await started;
    engine.unload();
    release();
    await assert.rejects(route, { name: 'AbortError' });
    assert.equal(
      made.length,
      0,
      `${phase} completion cannot revive the worker`,
    );
  }
});

test('cancelling an active worker search terminates its actual work', async () => {
  const pack = await installed('town', GRID, {
    west: -89.53,
    south: 34.35,
    east: -89.5,
    north: 34.37,
  });
  let searching;
  const started = new Promise((resolve) => {
    searching = resolve;
  });
  let terminated = false;
  const worker = {
    postMessage(message) {
      if (message.type === 'load')
        queueMicrotask(() =>
          worker.onmessage({
            data: { type: 'loaded', key: message.key, ok: true },
          }),
        );
      else searching(); // A busy worker that will never answer.
    },
    terminate() {
      terminated = true;
    },
  };
  const engine = createOfflineRouteEngine({
    listPacks: async () => [pack],
    readPack: async () => GRID.slice(),
    createWorker: () => worker,
  });
  const controller = new AbortController();
  const route = engine.route(TRIP, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(route, { name: 'AbortError' });
  assert.equal(terminated, true);
});
