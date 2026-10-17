// Choose an installed road pack for a trip and route on it in a worker.
// Browser-only; tests inject `listPacks`, `readPack` and `createWorker`.

import { roadPackCovers } from './packManifest.js';
import { RouteError } from './router.js';
import { sha256Hex } from './packStore.js';

const area = ({ bounds: b }) => (b.east - b.west) * (b.north - b.south);

/**
 * @param {object} options
 * @param {() => Promise<object[]>} options.listPacks Installed pack records.
 * @param {(id:string) => Promise<Uint8Array>} options.readPack
 * @param {() => Worker} [options.createWorker]
 * @param {number} [options.timeoutMs]
 */
export function createOfflineRouteEngine({
  listPacks,
  readPack,
  createWorker = () =>
    new Worker(new URL('./route.worker.js', import.meta.url), {
      type: 'module',
    }),
  verify = sha256Hex,
  timeoutMs = 60_000,
}) {
  let worker = null;
  let loadedKey = null;
  let loading = null;
  let loadingKey = null;
  let nextId = 1;
  const pending = new Map();

  // Stop the worker and fail whatever it still owed. The next request starts
  // a fresh worker, so one that crashed or hung never blocks later routes.
  function retire(error) {
    worker?.terminate();
    worker = null;
    loadedKey = null;
    loading = null;
    loadingKey = null;
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) entry.reject(error);
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = createWorker();
    worker.onmessage = (event) => {
      const message = event.data || {};
      const entry = pending.get(
        message.type === 'loaded' ? `load:${message.key}` : message.id,
      );
      if (!entry) return;
      pending.delete(
        message.type === 'loaded' ? `load:${message.key}` : message.id,
      );
      entry.resolve(message);
    };
    worker.onerror = (event) =>
      retire(new Error(event?.message || 'Offline routing worker failed'));
    return worker;
  }

  function request(key, message, transfer, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new RouteError('Offline routing timed out', 'aborted'));
        retire(new RouteError('Offline routing timed out', 'aborted'));
      }, timeoutMs);
      const settle = (fn) => (value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () => {
        pending.delete(key);
        settle(reject)(new DOMException('Route cancelled', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(key, { resolve: settle(resolve), reject: settle(reject) });
      ensureWorker().postMessage(message, transfer);
    });
  }

  async function load(pack) {
    const key = `${pack.id}:${pack.sha256}`;
    // One pack loads at a time; a different pack waits for the current load.
    while (loading) {
      if (loadingKey === key) return loading;
      await loading.catch(() => {});
    }
    if (loadedKey === key) return key;
    loadingKey = key;
    const current = (async () => {
      const bytes = await readPack(pack.id);
      // Device storage can be damaged after install; check before trusting it.
      if ((await verify(bytes)) !== pack.sha256)
        throw new RouteError(
          `Installed road pack "${pack.name}" is damaged; remove and download it again`,
          'no-pack',
        );
      // Transfer exactly the pack, even if `bytes` is a view into more.
      const { buffer } =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes
          : bytes.slice();
      const reply = await request(
        `load:${key}`,
        { type: 'load', key, bytes: buffer },
        [buffer],
      );
      if (!reply.ok)
        throw new RouteError(
          `Road pack "${pack.name}" could not be loaded: ${reply.error}`,
          'no-pack',
        );
      loadedKey = key;
      return key;
    })().finally(() => {
      // A retired worker may already have a newer load under way.
      if (loading !== current) return;
      loading = null;
      loadingKey = null;
    });
    loading = current;
    return current;
  }

  return Object.freeze({
    /**
     * Route with the smallest installed pack covering both points, or return
     * null when no installed pack covers the trip.
     */
    async route({ a, b }, { signal } = {}) {
      const packs = (await listPacks()).filter(
        (pack) =>
          pack.state === 'ready' &&
          roadPackCovers(pack, a.lat, a.lon) &&
          roadPackCovers(pack, b.lat, b.lon),
      );
      if (!packs.length) return null;
      const pack = packs.sort((x, y) => area(x) - area(y))[0];
      const key = await load(pack);
      signal?.throwIfAborted();
      const id = nextId++;
      const reply = await request(
        id,
        { type: 'route', id, key, a, b },
        [],
        signal,
      );
      if (!reply.ok)
        throw new RouteError(reply.error.message, reply.error.code);
      return reply.payload;
    },
    /** Drop the decoded pack, e.g. after it is removed or the account changes. */
    unload() {
      retire(new Error('Offline routing stopped'));
    },
  });
}
