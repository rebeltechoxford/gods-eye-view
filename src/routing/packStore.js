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
  // The operation token is checked in the same transaction as every write.
  // Removing a pack (including from another tab) or starting a newer install
  // revokes older writers, including ones still hashing their final bytes.
  async function putOwned(record, expected, signal, chunk = null, clear = false) {
    signal?.throwIfAborted();
    const tx = db.transaction(['packs', 'chunks'], 'readwrite');
    const completion = done(tx);
    const packs = tx.objectStore('packs');
    const request = packs.get(record.id);
    let accepted = false;
    request.onsuccess = () => {
      const current = request.result;
      if (
        signal?.aborted ||
        (expected === null
          ? current !== undefined
          : !current || current.operation !== expected)
      )
        return;
      if (clear)
        tx.objectStore('chunks').delete(IDBKeyRange.bound([record.id, 0], [record.id, Infinity]));
      if (chunk) tx.objectStore('chunks').put(chunk);
      packs.put(record);
      accepted = true;
    };
    await completion;
    if (!accepted)
      throw new DOMException('Road pack download was cancelled or replaced', 'AbortError');
  }
  const anyOperation = Symbol('any operation');
  async function remove(id, expected = anyOperation) {
    const tx = db.transaction(['packs', 'chunks'], 'readwrite');
    const completion = done(tx);
    const packs = tx.objectStore('packs');
    const request = packs.get(id);
    let accepted = false;
    request.onsuccess = () => {
      if (expected !== anyOperation && (!request.result || request.result.operation !== expected))
        return;
      packs.delete(id);
      tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
      accepted = true;
    };
    await completion;
    if (!accepted)
      throw new DOMException('Road pack download was replaced', 'AbortError');
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
    return assemble(id, record.bytes);
  }

  /** The stored chunks of a pack, which must tile exactly `totalBytes`. */
  async function assemble(id, totalBytes) {
    const chunks = await result(
      db
        .transaction('chunks')
        .objectStore('chunks')
        .getAll(IDBKeyRange.bound([id, 0], [id, Infinity])),
    );
    const out = new Uint8Array(totalBytes);
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
    signal?.throwIfAborted();
    const manifest = validateRoadPackManifest(manifestInput);
    let record = await get(manifest.id);
    signal?.throwIfAborted();
    if (
      record &&
      (record.sha256 !== manifest.sha256 || record.bytes !== manifest.bytes)
    ) {
      await remove(manifest.id, record.operation);
      record = null;
    }
    if (record?.state === 'ready') return record;
    const previousOperation = record ? record.operation : null;
    const operation = globalThis.crypto.randomUUID();
    record = {
      ...(record || {
        ...manifest,
        state: 'downloading',
        receivedBytes: 0,
        updatedAt: new Date().toISOString(),
      }),
      operation,
    };
    await putOwned(record, previousOperation, signal);
    let received = record.receivedBytes;
    if (received < manifest.bytes) {
      const response = await fetchFrom(received, signal);
      if (response.status === 200 && received) {
        // The server ignored the range: start over from the first byte, and
        // drop what was stored, which may not end on a chunk boundary.
        received = 0;
        record = { ...record, receivedBytes: 0 };
        await putOwned(record, operation, signal, null, true);
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
          record = {
            ...record,
            receivedBytes: received,
            updatedAt: new Date().toISOString(),
          };
          await putOwned(record, operation, signal, {
            id: manifest.id,
            index,
            bytes: bytes.buffer,
          });
          onProgress({ receivedBytes: received, totalBytes: manifest.bytes });
        }
      };
      try {
        for (;;) {
          signal?.throwIfAborted();
          const { value, done: finished } = await reader.read();
          signal?.throwIfAborted();
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
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    if (received !== manifest.bytes)
      throw new Error('Road pack download ended early; try again to resume');
    // Verify the stored bytes, not the bytes as they arrived, before the
    // pack is marked ready: an interruption here leaves a resumable download,
    // never an unverified "ready" pack.
    let verified = false;
    try {
      const bytes = await assemble(manifest.id, manifest.bytes);
      signal?.throwIfAborted();
      verified = (await sha256Hex(bytes)) === manifest.sha256;
    } catch {
      verified = false;
    }
    signal?.throwIfAborted();
    if (!verified) {
      // Do not delete a newer tab's replacement when this install loses ownership.
      await remove(manifest.id, operation);
      throw new Error('Road pack failed its SHA-256 check and was removed');
    }
    record = { ...record, state: 'ready' };
    await putOwned(record, operation, signal);
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
