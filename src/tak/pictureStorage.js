import { readTakPicture } from './picture.js';

/** One replaceable picture per operator. These records contain private data. */
export function pictureDatabaseName(context) {
  if (!context?.storageAllowed)
    throw new Error('Sign in or open an approved offline account first.');
  if (context.multiOperator === true) {
    if (!/^[a-f0-9]{64}$/.test(context.storageScope || ''))
      throw new Error('Invalid picture account scope.');
    return `gev-tak-picture-v1-${context.storageScope}`;
  }
  if (context.multiOperator !== false || context.storageScope !== null)
    throw new Error('Invalid local picture account.');
  return 'gev-tak-picture-v1-local';
}

/** Guard every asynchronous boundary against logout, changed account or abort. */
export function createPictureStorage({
  context,
  isCurrent,
  signal,
  indexedDB = globalThis.indexedDB,
}) {
  let pending = null;
  let db = null;
  let closed = false;
  const transactions = new Set();
  function guard() {
    signal?.throwIfAborted();
    if (closed || !isCurrent(context))
      throw new Error('Operator account changed; picture access is locked.');
  }
  async function open() {
    guard();
    if (!indexedDB?.open) throw new Error('Device storage is unavailable.');
    pending ??= new Promise((resolve, reject) => {
      let failed = false;
      const fail = (error) => {
        failed = true;
        reject(error);
      };
      const request = indexedDB.open(pictureDatabaseName(context), 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('pictures');
      request.onerror = () =>
        fail(request.error || new Error('Cannot open device picture storage.'));
      request.onblocked = () =>
        fail(
          new Error(
            'Device picture storage is busy in another tab. Reopen this page.',
          ),
        );
      request.onsuccess = () => {
        const opened = request.result;
        if (failed) {
          opened.close();
          return;
        }
        try {
          guard();
        } catch (error) {
          opened.close();
          reject(error);
          return;
        }
        db = opened;
        db.onversionchange = () => close();
        resolve(db);
      };
    });
    const opened = await pending;
    guard();
    return opened;
  }
  async function run(mode, action, operationSignal) {
    operationSignal?.throwIfAborted();
    const opened = await open();
    guard();
    operationSignal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const tx = opened.transaction('pictures', mode);
      transactions.add(tx);
      let result;
      let failure;
      const abort = () => {
        try {
          tx.abort();
        } catch {}
      };
      const cleanup = () => {
        transactions.delete(tx);
        operationSignal?.removeEventListener('abort', abort);
      };
      operationSignal?.addEventListener('abort', abort, { once: true });
      tx.onabort = tx.onerror = () => {
        cleanup();
        reject(
          failure ||
            operationSignal?.reason ||
            tx.error ||
            new Error('Device picture operation was cancelled.'),
        );
      };
      tx.oncomplete = () => {
        cleanup();
        try {
          guard();
          operationSignal?.throwIfAborted();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      };
      try {
        guard();
        operationSignal?.throwIfAborted();
        const request = action(tx.objectStore('pictures'));
        request.onsuccess = () => {
          try {
            guard();
            operationSignal?.throwIfAborted();
            result = request.result;
          } catch (error) {
            failure = error;
            abort();
          }
        };
      } catch (error) {
        failure = error;
        abort();
      }
    });
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const tx of transactions) {
      try {
        tx.abort();
      } catch {}
    }
    db?.close();
    signal?.removeEventListener('abort', close);
  }
  signal?.addEventListener('abort', close, { once: true });
  return Object.freeze({
    async save(payload, operationSignal) {
      guard();
      readTakPicture(payload);
      await run(
        'readwrite',
        (store) => store.put(payload, 'current'),
        operationSignal,
      );
    },
    async restore(operationSignal) {
      const payload = await run(
        'readonly',
        (store) => store.get('current'),
        operationSignal,
      );
      guard();
      return payload === undefined ? null : readTakPicture(payload);
    },
    async remove(operationSignal) {
      await run(
        'readwrite',
        (store) => store.delete('current'),
        operationSignal,
      );
    },
    close,
  });
}
