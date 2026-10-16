import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createOfflinePackStore } from '../../server/maps/offline/store.js';
import {
  validateOfflineManifest,
  planOfflineTiles,
  offlineTileUrl,
  validateTileBytes,
} from '../maps/offline/schema.js';

const image = await readFile(
  new URL(
    '../../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
    import.meta.url,
  ),
);
const hash = createHash('sha256').update(image).digest('hex');
const small = {
  name: 'Synthetic USGS fixture',
  bounds: { west: -90, south: 34, east: -89, north: 35 },
  minZoom: 0,
  maxZoom: 0,
};
const many = {
  ...small,
  bounds: { west: -180, south: -80, east: 180, north: 80 },
  maxZoom: 2,
};
const response = () =>
  new Response(image, { headers: { 'content-type': 'image/jpeg' } });
const opened = new Set();
async function createTestStore(options) {
  const store = await createOfflinePackStore(options);
  opened.add(store);
  return store;
}
async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gev-offline-maps-'));
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith('gev-offline-maps-'));
    for (const store of opened)
      if (store.root === absolute) await store.close();
    await rm(absolute, { recursive: true, force: true });
  });
  return root;
}
async function settled(store, id) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const manifest = store.get(id);
    if (['ready', 'failed', 'cancelled'].includes(manifest.state))
      return manifest;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Synthetic offline pack did not settle');
}
async function openStore(t, options = {}) {
  const store = await createTestStore({
    root: await directory(t),
    fetchImpl: async () => response(),
    ...options,
  });
  t.after(() => store.close());
  return store;
}

test('fixed-source packs persist verified images and survive process-store restart without refetch', async (t) => {
  validateTileBytes(image, 'image/jpeg');
  const root = await directory(t);
  const calls = [];
  let store = await createTestStore({
    root,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response();
    },
  });
  t.after(() => store.close());
  const created = await store.create(small);
  const ready = await settled(store, created.id);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.completedTiles, 1);
  assert.equal(ready.tiles['0/0/0'].sha256, hash);
  assert.equal(ready.downloadedBytes, image.length);
  validateOfflineManifest(ready, { requireReady: true });
  assert.equal(calls[0].url, offlineTileUrl(0, 0, 0));
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.deepEqual((await store.tile(ready.id, '0/0/0')).bytes, image);
  assert.equal(
    JSON.parse(
      await readFile(path.join(root, ready.id, 'manifest.json'), 'utf8'),
    ).state,
    'ready',
  );
  await store.close();
  store = await createTestStore({
    root,
    fetchImpl: () => {
      throw new Error('No refetch allowed');
    },
  });
  assert.equal(store.get(ready.id).state, 'ready');
  assert.equal(store.list()[0].tiles, undefined);
  await store.delete(ready.id);
  assert.equal(store.stats().packs, 0);
  assert.deepEqual(await readdir(root), ['.lock']);
});

test(
  'a retained closed writer cannot cancel or delete packs owned by its replacement',
  { timeout: 5000 },
  async (t) => {
    const root = await directory(t);
    let oldWrites = 0;
    const original = await createTestStore({
      root,
      fetchImpl: async () => response(),
      async writeImpl(handle, bytes) {
        oldWrites++;
        await handle.writeFile(bytes);
        await handle.sync();
      },
    });
    const created = await original.create(small);
    assert.equal((await settled(original, created.id)).state, 'ready');
    await original.close();
    const replacement = await createTestStore({
      root,
      fetchImpl: () => {
        throw new Error('A ready pack must not be fetched again');
      },
    });
    const manifestPath = path.join(root, created.id, 'manifest.json');
    const manifest = await readFile(manifestPath);
    const writesBefore = oldWrites;
    for (const operation of ['cancel', 'delete']) {
      await assert.rejects(
        original[operation](created.id),
        (error) => error.code === 'CLOSED' && error.status === 503,
      );
      assert.equal(oldWrites, writesBefore);
      assert.deepEqual(await readFile(manifestPath), manifest);
      assert.equal(replacement.get(created.id).state, 'ready');
      assert.deepEqual(
        (await replacement.tile(created.id, '0/0/0')).bytes,
        image,
      );
    }
    await assert.rejects(
      createOfflinePackStore({ root }),
      (error) => error.code === 'STORE_BUSY',
    );
    await replacement.delete(created.id);
    assert.deepEqual(await readdir(root), ['.lock']);
  },
);

test('downloads are globally bounded to four and cancelled partial packs resume only missing tiles after restart', async (t) => {
  const root = await directory(t);
  let active = 0;
  let maximum = 0;
  const urls = [];
  const fetchImpl = async (url, { signal }) => {
    urls.push(url);
    active++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 25);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('synthetic abort'));
          },
          { once: true },
        );
      });
      return response();
    } finally {
      active--;
    }
  };
  let store = await createTestStore({ root, fetchImpl });
  t.after(() => store.close());
  const first = await store.create(many);
  while (store.get(first.id).completedTiles < 4)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const cancelled = await store.cancel(first.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.ok(
    cancelled.completedTiles >= 4 &&
      cancelled.completedTiles < cancelled.plannedTiles,
  );
  assert.ok(maximum <= 4);
  const completed = new Set(Object.keys(cancelled.tiles));
  await store.close();
  urls.length = 0;
  store = await createTestStore({ root, fetchImpl });
  assert.equal(store.get(first.id).state, 'partial');
  await store.resume(first.id);
  const ready = await settled(store, first.id);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.completedTiles, planOfflineTiles(many).length);
  for (const key of completed) {
    const [z, x, y] = key.split('/').map(Number);
    assert.ok(
      !urls.includes(offlineTileUrl(z, x, y)),
      'verified completed tiles were reused',
    );
  }
});

test('untrusted source URLs, oversized plans, redirects and malformed/oversized tile bodies fail closed', async (t) => {
  const store = await openStore(t);
  await assert.rejects(
    store.create({ ...small, url: 'http://127.0.0.1/private' }),
    /fixed USGS/,
  );
  await assert.rejects(
    store.create({ ...small, sourceId: 'attacker' }),
    /fixed USGS/,
  );
  await assert.rejects(store.create({ ...many, maxZoom: 23 }), /5000/);
  assert.equal(store.stats().packs, 0);
  for (const makeResponse of [
    () =>
      new Response('', {
        status: 302,
        headers: { location: 'http://127.0.0.1/private' },
      }),
    () =>
      new Response('<html/>', { headers: { 'content-type': 'image/jpeg' } }),
    () => new Response(image, { headers: { 'content-type': 'image/svg+xml' } }),
    () =>
      new Response(image, {
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(2 * 1024 * 1024 + 1),
        },
      }),
    () =>
      new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
        headers: { 'content-type': 'image/jpeg' },
      }),
  ]) {
    const bad = await openStore(t, { fetchImpl: async () => makeResponse() });
    const pack = await bad.create(small);
    const failed = await settled(bad, pack.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.completedTiles, 0);
    assert.equal(bad.stats().payloadBytes, 0);
    assert.deepEqual(await readdir(path.join(bad.root, pack.id, 'tiles')), []);
  }
});

test('disk reservations bound pack and total data and pack/job counts cannot be raised by configuration', async (t) => {
  const packBytes = image.length + 4096 * 2;
  const store = await openStore(t, {
    limits: {
      manifestBytes: 4096,
      tileBytes: image.length,
      concurrency: 1,
      packBytes,
    },
  });
  const pack = await store.create(many);
  const failed = await settled(store, pack.id);
  assert.equal(failed.state, 'failed');
  assert.ok(failed.downloadedBytes <= image.length);
  assert.ok(store.stats().reservedBytes <= store.limits.totalBytes);
  const total = await openStore(t, {
    limits: {
      manifestBytes: 4096,
      tileBytes: image.length,
      concurrency: 1,
      totalBytes: 4096 * 2 + image.length * 2,
    },
  });
  const one = await total.create(many);
  assert.equal((await settled(total, one.id)).state, 'failed');
  assert.ok(total.stats().reservedBytes <= total.limits.totalBytes);
  await assert.rejects(
    createOfflinePackStore({
      root: await directory(t),
      limits: { concurrency: 5 },
    }),
    /resource limit/,
  );
});

test('a live writer lock cannot be replaced, manifest paths are rejected and symlink tiles never escape the cache', async (t) => {
  const root = await directory(t);
  let store = await createTestStore({
    root,
    fetchImpl: async () => response(),
  });
  t.after(() => store.close());
  await assert.rejects(createOfflinePackStore({ root }), /already in use/);
  assert.equal(
    JSON.parse(await readFile(path.join(root, '.lock'), 'utf8')).pid,
    process.pid,
  );
  const pack = await store.create(small);
  await settled(store, pack.id);
  await store.close();
  const outside = path.join(await directory(t), 'outside.jpg');
  await writeFile(outside, image);
  const tile = path.join(root, pack.id, 'tiles', '0-0-0.tile');
  await unlink(tile);
  await symlink(outside, tile, 'file');
  await assert.rejects(createOfflinePackStore({ root }), /Symlink|Unexpected/);
  assert.deepEqual(await readFile(outside), image);
  await unlink(tile);
  const file = path.join(root, pack.id, 'manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.path = outside;
  await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(
    createOfflinePackStore({ root }),
    /unknown manifest field/,
  );
});

test('queued jobs and pack counts stay bounded and stalled bodies respect the tile timeout', async (t) => {
  const stalled = async (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new Error('synthetic stop')),
        { once: true },
      );
    });
  const queued = await openStore(t, {
    fetchImpl: stalled,
    limits: { queuedJobs: 1 },
  });
  await queued.create(small);
  await queued.create({ ...small, name: 'Queued fixture' });
  await assert.rejects(
    queued.create({ ...small, name: 'Excess fixture' }),
    /queue is full/,
  );
  assert.equal(queued.stats().packs, 2);
  assert.equal(queued.stats().queued, 1);
  const bounded = await openStore(t, { limits: { packs: 1 } });
  const first = await bounded.create(small);
  await settled(bounded, first.id);
  await assert.rejects(bounded.create(small), /pack limit/);
  let cancelled = false;
  const timeout = await openStore(t, {
    limits: { tileTimeoutMs: 30 },
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'image/jpeg' } },
      ),
  });
  const pack = await timeout.create(small);
  assert.equal((await settled(timeout, pack.id)).state, 'failed');
  assert.equal(cancelled, true);
  assert.equal(timeout.stats().payloadBytes, 0);
});

test('corrupt tiles are never served and an explicit resume repairs only the invalid tile', async (t) => {
  let calls = 0;
  const store = await openStore(t, {
    fetchImpl: async () => {
      calls++;
      return response();
    },
  });
  const pack = await store.create(small);
  await settled(store, pack.id);
  const tile = path.join(store.root, pack.id, 'tiles', '0-0-0.tile');
  const changed = Buffer.from(image);
  changed[changed.length - 8] ^= 1;
  await writeFile(tile, changed);
  await assert.rejects(store.tile(pack.id, '0/0/0'), /integrity/);
  await store.resume(pack.id);
  assert.equal((await settled(store, pack.id)).state, 'ready');
  assert.equal(calls, 2);
  assert.deepEqual((await store.tile(pack.id, '0/0/0')).bytes, image);
});

test('malformed/nonpositive writer PIDs fail closed and Windows case variants cannot bypass the checkout denial', async (t) => {
  for (const pid of [0, -1, '123', null, 2147483648]) {
    const root = await directory(t);
    const bytes = JSON.stringify({ pid });
    await writeFile(path.join(root, '.lock'), bytes);
    await assert.rejects(
      createOfflinePackStore({ root }),
      /Invalid offline map writer lock/,
    );
    assert.equal(await readFile(path.join(root, '.lock'), 'utf8'), bytes);
  }
  const denied = await directory(t);
  const candidate = path.join(denied, 'private-cache');
  await assert.rejects(
    createOfflinePackStore({ root: candidate, forbiddenRoots: [denied] }),
    /outside the application/,
  );
  if (process.platform === 'win32')
    await assert.rejects(
      createOfflinePackStore({
        root: candidate.toUpperCase(),
        forbiddenRoots: [denied],
      }),
      /outside the application/,
    );
  await assert.rejects(readFile(path.join(candidate, '.lock')));
});

test('a temporary disk write failure cleans owned partial files and permits resume without restarting the writer', async (t) => {
  for (const phase of ['tile', 'ready-manifest']) {
    let failed = false;
    let calls = 0;
    const store = await openStore(t, {
      fetchImpl: async () => {
        calls++;
        return response();
      },
      async writeImpl(handle, bytes) {
        await handle.writeFile(bytes);
        const target =
          phase === 'tile'
            ? bytes[0] === 255
            : bytes[0] === 123 && JSON.parse(bytes).state === 'ready';
        if (target && !failed) {
          failed = true;
          throw new Error('Synthetic temporary disk failure');
        }
        await handle.sync();
      },
    });
    const pack = await store.create(small);
    assert.equal((await settled(store, pack.id)).state, 'failed');
    assert.ok(
      !(await readdir(path.join(store.root, pack.id))).some((name) =>
        name.endsWith('.part'),
      ),
    );
    assert.ok(
      !(await readdir(path.join(store.root, pack.id, 'tiles'))).some((name) =>
        name.endsWith('.part'),
      ),
    );
    await store.resume(pack.id);
    assert.equal((await settled(store, pack.id)).state, 'ready');
    assert.equal(calls, phase === 'tile' ? 2 : 1);
  }
});
