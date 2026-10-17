import {
  OFFLINE_LIMITS,
  validatePackId,
  validateOfflineManifest,
  planOfflineTiles,
  validateTileBytes,
  hashTile,
  packStorageBytes,
} from './schema.js';
import { exportOfflinePack, readOfflinePack } from './file.js';

const DB_NAME = 'gev-offline-maps-v1';
export function offlineDatabaseName(storageScope = null) {
  if (storageScope === null) return DB_NAME;
  if (typeof storageScope !== 'string' || !/^[a-f0-9]{64}$/.test(storageScope))
    throw new Error('Invalid offline map account scope');
  return `${DB_NAME}-${storageScope}`;
}
const requestResult = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () =>
      reject(tx.error || new Error('Offline storage transaction aborted'));
    tx.onerror = () => {};
  });
const abortError = () =>
  new DOMException('Offline map transfer cancelled', 'AbortError');
const bytesOf = (value) =>
  value instanceof Uint8Array
    ? new Uint8Array(value)
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : null;
const shared = new Map();

/** IndexedDB transactions keep each tile and its manifest progress atomic. */
export async function openIndexedDbDriver(
  indexedDBRef,
  { existingOnly = false, storageScope = null } = {},
) {
  if (!indexedDBRef?.open)
    throw new Error('Persistent offline map storage is unavailable');
  const request = indexedDBRef.open(offlineDatabaseName(storageScope), 1);
  request.onupgradeneeded = () => {
    if (existingOnly) {
      request.transaction.abort();
      return;
    }
    const db = request.result;
    db.createObjectStore('packs', { keyPath: 'id' });
    db.createObjectStore('tiles', { keyPath: ['packId', 'key'] });
    db.createObjectStore('settings', { keyPath: 'key' });
  };
  const db = await requestResult(request);
  db.onversionchange = () => db.close();
  async function read(store, key) {
    const tx = db.transaction(store, 'readonly');
    return requestResult(tx.objectStore(store).get(key));
  }
  return {
    async list() {
      const tx = db.transaction('packs', 'readonly');
      return requestResult(tx.objectStore('packs').getAll());
    },
    manifest: (id) => read('packs', id),
    tile: (id, key) => read('tiles', [id, key]),
    async writeManifest(manifest) {
      const tx = db.transaction('packs', 'readwrite'),
        completion = done(tx);
      tx.objectStore('packs').put(manifest);
      await completion;
    },
    async writeTile(manifest, key, bytes, contentType) {
      const tx = db.transaction(['packs', 'tiles'], 'readwrite'),
        completion = done(tx);
      tx.objectStore('tiles').put({
        packId: manifest.id,
        key,
        bytes: bytes.slice().buffer,
        contentType,
      });
      tx.objectStore('packs').put(manifest);
      await completion;
    },
    async remove(id) {
      const tx = db.transaction(['packs', 'tiles', 'settings'], 'readwrite'),
        completion = done(tx);
      tx.objectStore('packs').delete(id);
      const range = IDBKeyRange.bound([id, ''], [id, '\uffff']);
      tx.objectStore('tiles').delete(range);
      const selection = tx.objectStore('settings').get('selected');
      selection.onsuccess = () => {
        if (selection.result?.packId === id)
          tx.objectStore('settings').delete('selected');
      };
      await completion;
    },
    async selected() {
      return (await read('settings', 'selected'))?.packId || null;
    },
    async select(id) {
      const tx = db.transaction('settings', 'readwrite'),
        completion = done(tx);
      if (id) tx.objectStore('settings').put({ key: 'selected', packId: id });
      else tx.objectStore('settings').delete('selected');
      await completion;
    },
    close() {
      db.close();
    },
  };
}

/** The injected driver is a test seam; production never silently uses memory. */
export async function createOfflinePackStore({
  driver,
  storageManager = globalThis.navigator?.storage,
  now = () => new Date().toISOString(),
  onClose = () => {},
  isCurrent = () => true,
}) {
  let closed = false,
    mutation = Promise.resolve(),
    active = null;
  const ensure = () => {
    if (closed) throw new Error('Offline map store is closed');
    if (!isCurrent()) throw new Error('Offline map account context changed');
  };
  const serial = (fn) => {
    const task = mutation.then(() => {
      ensure();
      return fn();
    });
    mutation = task.catch(() => {});
    return task;
  };
  const readManifest = async (id) => {
    ensure();
    const value = await driver.manifest(validatePackId(id));
    ensure();
    return value ? validateOfflineManifest(value) : null;
  };
  const listPacks = async () => {
    ensure();
    const values = await driver.list();
    ensure();
    return values.map((value) => validateOfflineManifest(value));
  };
  async function checkSpace(next, previous = 0) {
    const packs = await listPacks();
    if (
      !packs.some((pack) => pack.id === next.id) &&
      packs.length >= OFFLINE_LIMITS.maxPacks
    )
      throw new Error('Offline map library has reached its pack limit');
    const old = packs.find((pack) => pack.id === next.id);
    const total =
      packs.reduce((sum, pack) => sum + packStorageBytes(pack), 0) -
      (old ? packStorageBytes(old) : 0) +
      packStorageBytes(next);
    if (total > OFFLINE_LIMITS.maxTotalBytes)
      throw new DOMException(
        'Offline map library exceeds its 2GiB limit',
        'QuotaExceededError',
      );
    if (storageManager?.estimate) {
      const estimate = await storageManager.estimate();
      const added = next.downloadedBytes - previous;
      if (
        added > 0 &&
        Number.isFinite(estimate.quota) &&
        Number.isFinite(estimate.usage) &&
        added > Math.max(0, estimate.quota - estimate.usage - 1024 * 1024)
      )
        throw new DOMException(
          'Insufficient device space for offline maps',
          'QuotaExceededError',
        );
    }
  }
  async function writeManifest(manifest) {
    return serial(async () => {
      const next = validateOfflineManifest(manifest),
        previous = await readManifest(next.id);
      await checkSpace(next, previous?.downloadedBytes || 0);
      await driver.writeManifest(next);
      return next;
    });
  }
  async function readVerifiedTile(manifest, key) {
    ensure();
    const meta = manifest?.tiles[key];
    if (!meta) return null;
    const tile = await driver.tile(manifest.id, key);
    ensure();
    if (!tile) return null;
    const bytes = bytesOf(tile.bytes);
    validateTileBytes(bytes, tile.contentType);
    if (
      tile.contentType !== meta.contentType ||
      bytes.byteLength !== meta.bytes ||
      (await hashTile(bytes)) !== meta.sha256
    )
      throw new Error('Saved map tile failed integrity validation');
    ensure();
    return { bytes, contentType: meta.contentType };
  }
  async function getTile(id, key) {
    return readVerifiedTile(await readManifest(id), key);
  }
  // A ready imagery source pins one private copy of its validated metadata.
  // Every read still verifies stored bytes; deletion returns null, and changed
  // or corrupted bytes fail instead of falling back to an online provider.
  function createTileReader(manifest) {
    ensure();
    const pack = validateOfflineManifest(manifest, { requireReady: true });
    return (key) => readVerifiedTile(pack, key);
  }
  async function putTile(id, key, bytes, contentType, expected) {
    validateTileBytes(bytes, contentType);
    const digest = await hashTile(bytes);
    if (
      contentType !== expected.contentType ||
      bytes.byteLength !== expected.bytes ||
      digest !== expected.sha256
    )
      throw new Error('Downloaded map tile failed SHA256/MIME validation');
    return serial(async () => {
      const current = await readManifest(id);
      if (!current) throw new Error('Offline map pack disappeared');
      const previous = current.tiles[key];
      const tiles = {
        ...current.tiles,
        [key]: { bytes: bytes.byteLength, sha256: digest, contentType },
      };
      const next = validateOfflineManifest({
        ...current,
        tiles,
        completedTiles: Object.keys(tiles).length,
        downloadedBytes:
          current.downloadedBytes - (previous?.bytes || 0) + bytes.byteLength,
        updatedAt: now(),
        state: 'downloading',
        acquiredAt: null,
      });
      await checkSpace(next, current.downloadedBytes);
      await driver.writeTile(next, key, bytes, contentType);
      return next;
    });
  }
  async function copyFromServer(
    value,
    { fetchTile, signal, onProgress = () => {} } = {},
  ) {
    ensure();
    if (active) throw new Error('An offline map transfer is already active');
    const source = validateOfflineManifest(value, { requireReady: true });
    if (typeof fetchTile !== 'function')
      throw new TypeError('A verified tile fetch function is required');
    const controller = new AbortController(),
      stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    let finish;
    const complete = new Promise((resolve) => {
      finish = resolve;
    });
    active = { id: source.id, controller, complete };
    const progress = (manifest) => {
      try {
        onProgress(manifest);
      } catch {
        /* Presentation cannot corrupt a retained pack. */
      }
    };
    try {
      controller.signal.throwIfAborted();
      let local = await readManifest(source.id);
      if (
        local &&
        (local.sourceId !== source.sourceId ||
          local.createdAt !== source.createdAt ||
          JSON.stringify(local.bounds) !== JSON.stringify(source.bounds) ||
          local.minZoom !== source.minZoom ||
          local.maxZoom !== source.maxZoom)
      )
        throw new Error('Saved pack identity differs from server manifest');
      if (!local)
        local = {
          ...source,
          tiles: {},
          completedTiles: 0,
          downloadedBytes: 0,
          acquiredAt: null,
        };
      local = await writeManifest({
        ...local,
        state: 'downloading',
        updatedAt: now(),
        error: undefined,
        acquiredAt: null,
      });
      progress(local);
      const plan = planOfflineTiles(source),
        pending = [];
      for (const tile of plan) {
        const metadata = local.tiles[tile.key],
          expected = source.tiles[tile.key];
        if (
          metadata?.sha256 === expected.sha256 &&
          metadata.bytes === expected.bytes
        ) {
          try {
            if (await getTile(source.id, tile.key)) continue;
          } catch {
            /* Redownload corrupt retained bytes. */
          }
        }
        pending.push(tile);
      }
      let cursor = 0,
        failure = null;
      const worker = async () => {
        while (!failure && cursor < pending.length) {
          controller.signal.throwIfAborted();
          const { key } = pending[cursor++];
          try {
            const response = await fetchTile(key, {
              signal: controller.signal,
            });
            controller.signal.throwIfAborted();
            const bytes = bytesOf(response?.bytes);
            validateTileBytes(bytes, response?.contentType);
            const next = await putTile(
              source.id,
              key,
              bytes,
              response.contentType,
              source.tiles[key],
            );
            progress(next);
          } catch (error) {
            failure = error;
            controller.abort();
            throw error;
          }
        }
      };
      const settled = await Promise.allSettled(
        Array.from(
          { length: Math.min(OFFLINE_LIMITS.fetchConcurrency, pending.length) },
          worker,
        ),
      );
      const rejected = settled.find((result) => result.status === 'rejected');
      if (failure || rejected) throw failure || rejected.reason;
      controller.signal.throwIfAborted();
      const current = await readManifest(source.id);
      const ready = await writeManifest({
        ...current,
        state: 'ready',
        updatedAt: now(),
        acquiredAt: source.acquiredAt,
        error: undefined,
      });
      progress(ready);
      return ready;
    } catch (error) {
      if (!closed) {
        const current = await readManifest(source.id).catch(() => null);
        if (current) {
          const cancelled = signal?.aborted || error?.name === 'AbortError';
          const failed = {
            ...current,
            state: cancelled ? 'cancelled' : 'failed',
            updatedAt: now(),
            acquiredAt: null,
            error: cancelled
              ? 'Download cancelled'
              : error?.name === 'QuotaExceededError'
                ? 'Insufficient device storage'
                : 'Map transfer failed; retry to resume',
          };
          await writeManifest(failed)
            .then(progress)
            .catch(() => {});
        }
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', stop);
      active = null;
      finish();
    }
  }
  const store = {
    listPacks,
    getManifest: readManifest,
    getTile,
    createTileReader,
    copyFromServer,
    async exportPack(id, options) {
      const manifest = await readManifest(id);
      if (!manifest) throw new Error('Saved map pack not found');
      return exportOfflinePack(manifest, getTile, options);
    },
    async importPack(blob, options) {
      const file = await readOfflinePack(blob);
      return copyFromServer(file.manifest, {
        ...options,
        fetchTile: file.fetchTile,
      });
    },
    async deletePack(id) {
      id = validatePackId(id);
      if (active?.id === id) {
        active.controller.abort();
        await active.complete;
      }
      return serial(() => driver.remove(id));
    },
    async getSelectedPackId() {
      ensure();
      const id = await driver.selected();
      ensure();
      return id ? validatePackId(id) : null;
    },
    async setSelectedPackId(id) {
      ensure();
      return serial(async () => {
        if (id) {
          const manifest = await readManifest(id);
          if (!manifest || manifest.state !== 'ready')
            throw new Error('Only a complete saved pack can be selected');
          id = manifest.id;
        }
        return driver.select(id);
      });
    },
    async requestPersistence() {
      ensure();
      return storageManager?.persist
        ? Boolean(await storageManager.persist())
        : false;
    },
    async estimate() {
      ensure();
      return storageManager?.estimate
        ? storageManager.estimate()
        : { usage: null, quota: null };
    },
    close() {
      if (closed) return;
      closed = true;
      active?.controller.abort();
      driver.close();
      onClose();
    },
  };
  return Object.freeze(store);
}

/** Default browser users share one mutation owner and transfer budget. */
export function openOfflinePackStore({
  indexedDB = globalThis.indexedDB,
  storageManager = globalThis.navigator?.storage,
  storageScope = null,
  isCurrent = () => true,
} = {}) {
  const name = offlineDatabaseName(storageScope);
  if (!isCurrent())
    return Promise.reject(new Error('Offline map account context changed'));
  if (!shared.has(name))
    shared.set(
      name,
      openIndexedDbDriver(indexedDB, { storageScope })
        .then((driver) =>
          createOfflinePackStore({
            driver,
            storageManager,
            isCurrent,
            onClose: () => {
              shared.delete(name);
            },
          }),
        )
        .catch((error) => {
          shared.delete(name);
          throw error;
        }),
    );
  return shared.get(name);
}

/** Read opt-in state without creating any database during ordinary app boot. */
export async function openExistingOfflinePackStore({
  indexedDB = globalThis.indexedDB,
  storageManager = globalThis.navigator?.storage,
  storageScope = null,
  isCurrent = () => true,
} = {}) {
  const name = offlineDatabaseName(storageScope);
  if (!isCurrent()) throw new Error('Offline map account context changed');
  if (!indexedDB?.databases) return null;
  const entries = await indexedDB.databases();
  if (!isCurrent()) throw new Error('Offline map account context changed');
  if (!entries.some((entry) => entry.name === name)) return null;
  if (!shared.has(name))
    shared.set(
      name,
      openIndexedDbDriver(indexedDB, { existingOnly: true, storageScope })
        .then((driver) =>
          createOfflinePackStore({
            driver,
            storageManager,
            isCurrent,
            onClose: () => {
              shared.delete(name);
            },
          }),
        )
        .catch((error) => {
          shared.delete(name);
          throw error;
        }),
    );
  return shared.get(name);
}
