// Road pack device storage: resumable install, restart when a server ignores
// Range, and a pack is never marked ready before its SHA-256 matches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRoadPackStore, sha256Hex } from './packStore.js';

// A minimal in-memory IndexedDB: object stores with key paths (including
// compound keys), get/put/delete/getAll with bound key ranges, and
// transactions that complete after their requests.
const compare = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compare(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
};
const inRange = (range, key) =>
  compare(key, range.lower) >= 0 && compare(key, range.upper) <= 0;
// JSON cannot hold Infinity; ranges never need to be stored, only keys.
const encode = (key) => JSON.stringify(key);

function fakeIndexedDb() {
  const databases = new Map();
  const later = (fn) => setTimeout(fn, 0);
  function request(compute, tx) {
    const req = { onsuccess: null, onerror: null };
    tx.pending++;
    later(() => {
      try {
        req.result = compute();
        req.onsuccess?.();
      } catch (error) {
        req.error = error;
        req.onerror?.();
      }
      if (--tx.pending === 0) later(() => tx.oncomplete?.());
    });
    return req;
  }
  function database(stores) {
    return {
      onversionchange: null,
      close() {},
      createObjectStore(name, { keyPath }) {
        stores.set(name, { keyPath, rows: new Map() });
      },
      transaction() {
        const tx = {
          pending: 0,
          oncomplete: null,
          onabort: null,
          onerror: null,
        };
        tx.objectStore = (name) => {
          const store = stores.get(name);
          const keyOf = (value) =>
            Array.isArray(store.keyPath)
              ? store.keyPath.map((part) => value[part])
              : value[store.keyPath];
          const entries = () =>
            [...store.rows.entries()].map(([k, value]) => [
              JSON.parse(k),
              value,
            ]);
          return {
            get: (key) =>
              request(() => {
                const row = entries().find(([k]) => compare(k, key) === 0);
                return row ? structuredClone(row[1]) : undefined;
              }, tx),
            put: (value) =>
              request(() => {
                store.rows.set(encode(keyOf(value)), structuredClone(value));
              }, tx),
            delete: (keyOrRange) =>
              request(() => {
                for (const [key] of entries())
                  if (
                    keyOrRange?.lower !== undefined
                      ? inRange(keyOrRange, key)
                      : compare(key, keyOrRange) === 0
                  )
                    store.rows.delete(encode(key));
              }, tx),
            getAll: (range) =>
              request(
                () =>
                  entries()
                    .filter(([key]) => !range || inRange(range, key))
                    .sort(([a], [b]) => compare(a, b))
                    .map(([, value]) => structuredClone(value)),
                tx,
              ),
          };
        };
        // A transaction with no requests still completes.
        later(() => {
          if (tx.pending === 0) tx.oncomplete?.();
        });
        return tx;
      },
    };
  }
  return {
    open(name) {
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null };
      later(() => {
        const fresh = !databases.has(name);
        if (fresh) databases.set(name, new Map());
        req.result = database(databases.get(name));
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

globalThis.IDBKeyRange ??= {
  bound: (lower, upper) => ({ lower, upper }),
};

async function packFixture(size = 3000) {
  const bytes = Uint8Array.from(
    { length: size },
    (_, i) => (i * 31 + 7) & 0xff,
  );
  return {
    bytes,
    manifest: {
      manifestVersion: 1,
      id: '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7',
      name: 'Mississippi',
      bytes: size,
      sha256: await sha256Hex(bytes),
      profile: 'car',
      bounds: { west: -91.7, south: 30.1, east: -88.05, north: 35.05 },
      edition: '2026-10-17T00:27:00.000Z',
      builtAt: '2026-10-17T04:00:00.000Z',
      license: 'ODbL-1.0',
      attribution: '© OpenStreetMap contributors',
    },
  };
}

const response = (status, bytes) => new Response(bytes, { status });

test('a server that ignores Range restarts the download without stale chunks', async () => {
  const { bytes, manifest } = await packFixture();
  const store = await openRoadPackStore({ indexedDB: fakeIndexedDb() });
  // Two short attempts leave chunks that do not end on a chunk boundary.
  await assert.rejects(
    store.install(manifest, {
      fetchFrom: async () => response(200, bytes.slice(0, 1000)),
    }),
    /ended early/,
  );
  await assert.rejects(
    store.install(manifest, {
      fetchFrom: async (start) => {
        assert.equal(start, 1000, 'resumes where it stopped');
        return response(206, bytes.slice(1000, 1500));
      },
    }),
    /ended early/,
  );
  // The third attempt's server ignores Range and sends everything.
  const record = await store.install(manifest, {
    fetchFrom: async (start) => {
      assert.equal(start, 1500);
      return response(200, bytes);
    },
  });
  assert.equal(record.state, 'ready');
  assert.deepEqual(await store.readBytes(manifest.id), bytes);
});

test('a pack is marked ready only after its stored bytes pass SHA-256', async (t) => {
  const { bytes, manifest } = await packFixture();
  const store = await openRoadPackStore({ indexedDB: fakeIndexedDb() });
  const states = [];
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', async (...args) => {
    states.push((await store.get(manifest.id))?.state);
    return digest(...args);
  });
  await store.install(manifest, {
    fetchFrom: async () => response(200, bytes),
  });
  assert.deepEqual(states, ['downloading'], 'verified before marked ready');
  assert.equal((await store.get(manifest.id)).state, 'ready');
});

test('a pack that fails verification is removed, not left ready', async () => {
  const { bytes, manifest } = await packFixture();
  const store = await openRoadPackStore({ indexedDB: fakeIndexedDb() });
  const damaged = bytes.slice();
  damaged[10] ^= 0xff;
  await assert.rejects(
    store.install(manifest, { fetchFrom: async () => response(200, damaged) }),
    /SHA-256/,
  );
  assert.equal(await store.get(manifest.id), undefined);
  // A fresh install then succeeds from the first byte.
  const record = await store.install(manifest, {
    fetchFrom: async (start) => {
      assert.equal(start, 0);
      return response(200, bytes);
    },
  });
  assert.equal(record.state, 'ready');
});
