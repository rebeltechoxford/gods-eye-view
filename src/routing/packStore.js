// Device storage for offline road packs (IndexedDB), scoped per operator
// account like saved maps. A pack downloads in fixed-size chunks so a broken
// connection resumes from the last stored chunk, and it is marked ready only
// after its SHA-256 matches the manifest. Browser-only (IndexedDB, WebCrypto).

import { validateRoadPackManifest } from './packManifest.js';

const DB_NAME = 'gev-road-packs-v1';
/** Stored chunk size; resumable downloads restart at a chunk boundary. */
export const ROAD_PACK_CHUNK_BYTES = 4 * 1024 * 1024;

export function roadPackDatabaseName(storageScope = null) {
  if (storageScope === null) return DB_NAME;
  if (typeof storageScope !== 'string' || !/^[a-f0-9]{64}$/.test(storageScope))
    throw new Error('Invalid road pack account scope');
  return `${DB_NAME}-${storageScope}`;
}

const result = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () =>
      reject(tx.error || new Error('Road pack storage transaction aborted'));
    tx.onerror = () => {};
  });

export async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * @param {object} [options]
 * @param {?string} [options.storageScope] Operator account scope (64 hex) or null.
 * @param {IDBFactory} [options.indexedDB]
 */
export async function openRoadPackStore({
  storageScope = null,
  indexedDB = globalThis.indexedDB,
} = {}) {
  if (!indexedDB?.open)
    throw new Error('Device storage for road packs is unavailable');
  const request = indexedDB.open(roadPackDatabaseName(storageScope), 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('packs', { keyPath: 'id' });
    db.createObjectStore('chunks', { keyPath: ['id', 'index'] });
  };
  const db = await result(request);
  db.onversionchange = () => db.close();

  async function get(id) {
    return result(db.transaction('packs').objectStore('packs').get(id));
  }
  async function put(record) {
    const tx = db.transaction('packs', 'readwrite');
    const completion = done(tx);
    tx.objectStore('packs').put(record);
    await completion;
  }
  async function remove(id) {
    const tx = db.transaction(['packs', 'chunks'], 'readwrite');
    const completion = done(tx);
    tx.objectStore('packs').delete(id);
    tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
    await completion;
  }

  /** Every stored pack record, newest first. */
  async function list() {
    const records = await result(
      db.transaction('packs').objectStore('packs').getAll(),
    );
    return records.sort((a, b) =>
      String(b.updatedAt).localeCompare(String(a.updatedAt)),
    );
  }

  /** Assemble a ready pack's bytes; the length must match the manifest. */
  async function readBytes(id) {
    const record = await get(id);
    if (record?.state !== 'ready')
      throw new Error('Road pack is not installed');
    const chunks = await result(
      db
        .transaction('chunks')
        .objectStore('chunks')
        .getAll(IDBKeyRange.bound([id, 0], [id, Infinity])),
    );
    const out = new Uint8Array(record.bytes);
    let offset = 0;
    chunks.sort((a, b) => a.index - b.index);
    for (const chunk of chunks) {
      const bytes = new Uint8Array(chunk.bytes);
      if (
        chunk.index * ROAD_PACK_CHUNK_BYTES !== offset ||
        offset + bytes.length > out.length
      )
        throw new Error(
          'Stored road pack is damaged; remove and download it again',
        );
      out.set(bytes, offset);
      offset += bytes.length;
    }
    if (offset !== out.length)
      throw new Error(
        'Stored road pack is incomplete; remove and download it again',
      );
    return out;
  }

  /**
   * Download (or resume) a pack. `fetchFrom(start, signal)` returns a Response
   * for the bytes from `start` to the end (HTTP 206 or 200 from 0).
   */
  async function install(
    manifestInput,
    { fetchFrom, signal, onProgress = () => {} },
  ) {
    const manifest = validateRoadPackManifest(manifestInput);
    let record = await get(manifest.id);
    if (
      record &&
      (record.sha256 !== manifest.sha256 || record.bytes !== manifest.bytes)
    ) {
      await remove(manifest.id);
      record = null;
    }
    if (record?.state === 'ready') return record;
    record ||= {
      ...manifest,
      state: 'downloading',
      receivedBytes: 0,
      updatedAt: new Date().toISOString(),
    };
    await put(record);
    let received = record.receivedBytes;
    if (received < manifest.bytes) {
      const response = await fetchFrom(received, signal);
      if (response.status === 200 && received) {
        // The server ignored the range: start over from the first byte.
        received = 0;
      } else if (response.status !== 206 && response.status !== 200)
        throw new Error(`Road pack download failed (HTTP ${response.status})`);
      const reader = response.body.getReader();
      let pending = new Uint8Array(0);
      const flush = async (final) => {
        while (
          pending.length >= ROAD_PACK_CHUNK_BYTES ||
          (final && pending.length)
        ) {
          const size = Math.min(ROAD_PACK_CHUNK_BYTES, pending.length);
          const bytes = pending.slice(0, size);
          pending = pending.subarray(size);
          const index = received / ROAD_PACK_CHUNK_BYTES;
          received += size;
          const tx = db.transaction(['packs', 'chunks'], 'readwrite');
          const completion = done(tx);
          tx.objectStore('chunks').put({
            id: manifest.id,
            index,
            bytes: bytes.buffer,
          });
          record = {
            ...record,
            receivedBytes: received,
            updatedAt: new Date().toISOString(),
          };
          tx.objectStore('packs').put(record);
          await completion;
          onProgress({ receivedBytes: received, totalBytes: manifest.bytes });
        }
      };
      for (;;) {
        signal?.throwIfAborted();
        const { value, done: finished } = await reader.read();
        if (finished) break;
        if (received + pending.length + value.length > manifest.bytes)
          throw new Error('Road pack download is larger than its manifest');
        const next = new Uint8Array(pending.length + value.length);
        next.set(pending);
        next.set(value, pending.length);
        pending = next;
        await flush(false);
      }
      await flush(true);
    }
    if (received !== manifest.bytes)
      throw new Error('Road pack download ended early; try again to resume');
    record = { ...record, state: 'ready' };
    await put(record);
    // Verify the stored bytes, not the bytes as they arrived.
    const bytes = await readBytes(manifest.id);
    if ((await sha256Hex(bytes)) !== manifest.sha256) {
      await remove(manifest.id);
      throw new Error('Road pack failed its SHA-256 check and was removed');
    }
    return record;
  }

  return Object.freeze({
    list,
    get,
    install,
    readBytes,
    remove,
    close: () => db.close(),
  });
}
