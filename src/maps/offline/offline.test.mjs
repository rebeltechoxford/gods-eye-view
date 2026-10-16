import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  OFFLINE_SOURCE,
  OFFLINE_LIMITS,
  MERCATOR_LATITUDE,
  createOfflineManifest,
  validateOfflineManifest,
  planOfflineTiles,
  tileKey,
  parseTileKey,
  offlineTileUrl,
  validateTileBytes,
  hashTile,
  packStorageBytes,
} from './schema.js';
import {
  createOfflinePackStore,
  openExistingOfflinePackStore,
  openIndexedDbDriver,
} from './store.js';
import { exportOfflinePack, readOfflinePack } from './file.js';
import {
  createOfflineImageryProvider,
  offlineSource,
  isOfflineSource,
} from './imagery.js';
import { readSelectedOfflinePack } from './boot.js';
import { MapSourceController } from '../controller.js';
import { createDefaultMapSources } from '../defaultSources.js';

const ID = '12345678-1234-4123-8123-123456789abc';
test('truncated JPEG marker fill is rejected as invalid image data without out-of-bounds reads', () => {
  const malformed = new Uint8Array(64).fill(255);
  malformed[1] = 216;
  malformed[63] = 217;
  assert.throws(() => validateTileBytes(malformed, 'image/jpeg'), TypeError);
});
const DATE = '2026-10-01T00:00:00.000Z';
const NOW = '2026-10-16T00:00:00.000Z';
const BOUNDS = { west: -1, south: -1, east: 1, north: 1 };
const PNG = new Uint8Array(
  await sharp({
    create: {
      width: 256,
      height: 256,
      channels: 4,
      background: { r: 30, g: 100, b: 50, alpha: 1 },
    },
  })
    .png()
    .toBuffer(),
);
const JPEG = new Uint8Array(
  await sharp({
    create: { width: 256, height: 256, channels: 3, background: '#123456' },
  })
    .jpeg()
    .toBuffer(),
);
const digest = await hashTile(PNG);
const create = (options = {}) =>
  createOfflineManifest({
    id: ID,
    name: 'Synthetic public map',
    bounds: BOUNDS,
    minZoom: 0,
    maxZoom: 0,
    createdAt: DATE,
    ...options,
  });
function ready(options = {}) {
  const pack = create(options),
    tiles = {};
  for (const { key } of planOfflineTiles(pack))
    tiles[key] = {
      bytes: PNG.length,
      sha256: digest,
      contentType: 'image/png',
    };
  return validateOfflineManifest({
    ...pack,
    state: 'ready',
    tiles,
    completedTiles: Object.keys(tiles).length,
    downloadedBytes: Object.keys(tiles).length * PNG.length,
    updatedAt: NOW,
    acquiredAt: NOW,
  });
}
function memoryDriver() {
  const packs = new Map(),
    tiles = new Map(),
    writes = [];
  let selected = null,
    closed = false;
  return {
    packs,
    tiles,
    writes,
    get closed() {
      return closed;
    },
    async list() {
      return [...packs.values()].map((value) => structuredClone(value));
    },
    async manifest(id) {
      return packs.has(id) ? structuredClone(packs.get(id)) : null;
    },
    async tile(id, key) {
      return tiles.has(`${id}:${key}`)
        ? structuredClone(tiles.get(`${id}:${key}`))
        : null;
    },
    async writeManifest(manifest) {
      packs.set(manifest.id, structuredClone(manifest));
      writes.push({ type: 'manifest', manifest: structuredClone(manifest) });
    },
    async writeTile(manifest, key, bytes, contentType) {
      tiles.set(`${manifest.id}:${key}`, {
        bytes: bytes.slice().buffer,
        contentType,
      });
      packs.set(manifest.id, structuredClone(manifest));
      writes.push({ type: 'tile', key, manifest: structuredClone(manifest) });
    },
    async remove(id) {
      packs.delete(id);
      for (const key of tiles.keys())
        if (key.startsWith(`${id}:`)) tiles.delete(key);
      if (selected === id) selected = null;
    },
    async selected() {
      return selected;
    },
    async select(id) {
      selected = id;
    },
    close() {
      closed = true;
    },
  };
}
const storeFixture = async (options = {}) => {
  const driver = memoryDriver();
  return {
    driver,
    store: await createOfflinePackStore({
      driver,
      now: () => NOW,
      storageManager: {},
      ...options,
    }),
  };
};
const fetchTile = async () => ({
  bytes: PNG.slice(),
  contentType: 'image/png',
});

test('tile planning respects Mercator boundaries, antimeridian overlap and XYZ row ordering', () => {
  assert.deepEqual(
    planOfflineTiles({ bounds: BOUNDS, minZoom: 0, maxZoom: 0 }),
    [{ key: '0/0/0', z: 0, x: 0, y: 0 }],
  );
  const crossing = planOfflineTiles({
    bounds: { west: 179, south: -1, east: -179, north: 1 },
    minZoom: 0,
    maxZoom: 2,
  });
  assert.equal(crossing.length, 9);
  assert.equal(new Set(crossing.map((tile) => tile.key)).size, 9);
  assert.deepEqual(
    crossing.filter((tile) => tile.z === 2).map((tile) => tile.x),
    [0, 0, 3, 3],
  );
  assert.equal(
    planOfflineTiles({
      bounds: {
        west: -180,
        south: -MERCATOR_LATITUDE,
        east: 180,
        north: MERCATOR_LATITUDE,
      },
      minZoom: 0,
      maxZoom: 0,
    }).length,
    1,
  );
  assert.equal(offlineTileUrl(3, 4, 2), `${OFFLINE_SOURCE.url}/tile/3/2/4`);
  assert.deepEqual(parseTileKey('3/4/2'), { key: '3/4/2', z: 3, x: 4, y: 2 });
});

test('planning rejects coercion, invalid areas and excessive work before allocating tiles', () => {
  for (const bounds of [
    { ...BOUNDS, west: '' },
    { ...BOUNDS, north: 91 },
    { ...BOUNDS, north: -1 },
    { ...BOUNDS, east: -1 },
    { ...BOUNDS, url: 'https://example.com' },
  ])
    assert.throws(
      () => planOfflineTiles({ bounds, minZoom: 0, maxZoom: 0 }),
      TypeError,
    );
  for (const [minZoom, maxZoom] of [
    ['0', 1],
    [2, 1],
    [-1, 2],
    [0, 24],
    [0, NaN],
  ])
    assert.throws(
      () => planOfflineTiles({ bounds: BOUNDS, minZoom, maxZoom }),
      TypeError,
    );
  assert.throws(
    () =>
      planOfflineTiles({
        bounds: { west: -180, south: -80, east: 180, north: 80 },
        minZoom: 23,
        maxZoom: 23,
      }),
    /5000 tiles/,
  );
  for (const key of ['0/1/0', '3/04/2', '3/-1/0', '../a/b', '3/4/2?url=x'])
    assert.throws(() => parseTileKey(key));
  assert.throws(() => tileKey(2, '1', 0));
});

test('manifest is a closed portable contract with source, byte, hash and readiness checks', () => {
  const pack = ready();
  assert.equal(pack.plannedTiles, 1);
  assert.equal(
    packStorageBytes(pack),
    PNG.length + new TextEncoder().encode(JSON.stringify(pack)).length + 12,
  );
  for (const change of [
    { token: 'secret' },
    { sourceUrl: 'https://example.com' },
    { sourceId: 'google' },
    { credit: '' },
    { schemaVersion: 2 },
    { id: '../../escape' },
    { name: ' bad ' },
    { plannedTiles: 2 },
    { downloadedBytes: PNG.length + 1 },
    { completedTiles: 0 },
    { acquiredAt: null },
    {
      tiles: {
        '0/0/0': { bytes: PNG.length, sha256: 'bad', contentType: 'image/png' },
      },
    },
    { tiles: { '1/0/0': pack.tiles['0/0/0'] } },
    { tiles: { '0/0/0': { ...pack.tiles['0/0/0'], path: 'elsewhere' } } },
  ])
    assert.throws(
      () => validateOfflineManifest({ ...pack, ...change }),
      TypeError,
    );
  assert.throws(
    () => validateOfflineManifest(create(), { requireReady: true }),
    /not ready/,
  );
  assert.equal(
    validateOfflineManifest({ ...pack, id: ID.toUpperCase() }).id,
    ID,
  );
});

test('PNG/JPEG bounds and MIME are checked; hashes cover the exact view bytes', async () => {
  assert.equal(validateTileBytes(PNG, 'image/png'), PNG);
  assert.equal(validateTileBytes(JPEG, 'image/jpeg'), JPEG);
  const prefixed = new Uint8Array(PNG.length + 7);
  prefixed.set(PNG, 7);
  assert.equal(await hashTile(prefixed.subarray(7)), digest);
  for (const [bytes, mime] of [
    [PNG, 'image/jpeg'],
    [JPEG, 'image/png'],
    [new TextEncoder().encode('<svg/>'), 'image/svg+xml'],
    [PNG, 'image/webp'],
    [new Uint8Array(OFFLINE_LIMITS.maxTileBytes + 1), 'image/png'],
    [PNG.buffer, 'image/png'],
  ])
    assert.throws(() => validateTileBytes(bytes, mime), TypeError);
  const small = new Uint8Array(
    await sharp({
      create: { width: 1, height: 1, channels: 4, background: '#0000' },
    })
      .png()
      .toBuffer(),
  );
  assert.throws(() => validateTileBytes(small, 'image/png'));
});

test('copy validates each byte before atomic progress and uses at most four fetches', async () => {
  const { store, driver } = await storeFixture(),
    pack = ready({ minZoom: 1, maxZoom: 2 });
  let inFlight = 0,
    peak = 0;
  const progress = [];
  await store.copyFromServer(pack, {
    fetchTile: async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      return fetchTile();
    },
    onProgress: (value) => progress.push(value),
  });
  assert.equal(peak, 4);
  assert.equal((await store.getManifest(ID)).state, 'ready');
  assert.equal(
    driver.writes.filter((write) => write.type === 'tile').length,
    pack.plannedTiles,
  );
  for (const write of driver.writes.filter((write) => write.type === 'tile')) {
    assert.equal(
      write.manifest.completedTiles,
      Object.keys(write.manifest.tiles).length,
    );
    assert.equal(
      write.manifest.downloadedBytes,
      write.manifest.completedTiles * PNG.length,
    );
    assert.notEqual(write.manifest.state, 'ready');
  }
  assert.equal(progress.at(-1).completedTiles, pack.plannedTiles);
  assert.equal(progress.at(-1).state, 'ready');
  assert.deepEqual((await store.getTile(ID, '1/0/0')).bytes, PNG);
  store.close();
});

test('cancel keeps partial verified work and resume downloads only missing tiles', async () => {
  const { store } = await storeFixture(),
    pack = ready({ minZoom: 1, maxZoom: 2 }),
    controller = new AbortController();
  await assert.rejects(
    store.copyFromServer(pack, {
      fetchTile,
      signal: controller.signal,
      onProgress: (value) => {
        if (value.completedTiles === 1) controller.abort();
      },
    }),
    { name: 'AbortError' },
  );
  const partial = await store.getManifest(ID);
  assert.equal(partial.state, 'cancelled');
  assert.ok(
    partial.completedTiles > 0 && partial.completedTiles < pack.plannedTiles,
  );
  let calls = 0;
  await store.copyFromServer(pack, {
    fetchTile: async () => {
      calls++;
      return fetchTile();
    },
  });
  assert.equal(calls, pack.plannedTiles - partial.completedTiles);
  assert.equal((await store.getManifest(ID)).state, 'ready');
  store.close();
});

test('wrong hashes, corrupted retained bytes and quota failures never publish a ready pack', async () => {
  const { store, driver } = await storeFixture();
  const bad = PNG.slice();
  bad[bad.length - 20] ^= 1;
  await assert.rejects(
    store.copyFromServer(ready(), {
      fetchTile: async () => ({ bytes: bad, contentType: 'image/png' }),
    }),
    /SHA256/,
  );
  assert.equal((await store.getManifest(ID)).state, 'failed');
  assert.equal(driver.tiles.size, 0);
  await store.copyFromServer(ready(), { fetchTile });
  driver.tiles.get(`${ID}:0/0/0`).bytes = bad.buffer;
  await assert.rejects(store.getTile(ID, '0/0/0'), /integrity/);
  let repaired = 0;
  await store.copyFromServer(ready(), {
    fetchTile: async () => {
      repaired++;
      return fetchTile();
    },
  });
  assert.equal(repaired, 1);
  store.close();
  const quota = await storeFixture({
    storageManager: {
      estimate: async () => ({ quota: 1024 * 1024, usage: 0 }),
    },
  });
  await assert.rejects(quota.store.copyFromServer(ready(), { fetchTile }), {
    name: 'QuotaExceededError',
  });
  assert.equal((await quota.store.getManifest(ID)).state, 'failed');
  assert.equal(quota.driver.tiles.size, 0);
  quota.store.close();
});

test('only complete packs can be selected, and deletion clears selection and retained bytes', async () => {
  const { store, driver } = await storeFixture();
  await assert.rejects(store.setSelectedPackId(ID), /complete/);
  await store.copyFromServer(ready(), { fetchTile });
  await store.setSelectedPackId(ID);
  assert.equal(await store.getSelectedPackId(), ID);
  await store.deletePack(ID);
  assert.equal(await store.getSelectedPackId(), null);
  assert.equal(await store.getManifest(ID), null);
  assert.equal(driver.tiles.size, 0);
  assert.equal(await store.requestPersistence(), false);
  store.close();
  store.close();
  assert.equal(driver.closed, true);
  await assert.rejects(store.listPacks(), /closed/);
});

test('library pack count and total byte limits reject new writes without allocating claimed tile bytes', async () => {
  const count = await storeFixture();
  const idAt = (value) =>
    `12345678-1234-4123-8123-${String(value).padStart(12, '0')}`;
  for (let index = 0; index < OFFLINE_LIMITS.maxPacks; index++) {
    const pack = create({ id: idAt(index) });
    count.driver.packs.set(pack.id, pack);
  }
  let fetched = 0;
  await assert.rejects(
    count.store.copyFromServer(ready(), {
      fetchTile: async () => {
        fetched++;
        return fetchTile();
      },
    }),
    /pack limit/,
  );
  assert.equal(fetched, 0);
  count.store.close();

  // Manifest summaries account for storage independently of tile allocation.
  const total = await storeFixture();
  const template = create({
    bounds: {
      west: -180,
      south: -MERCATOR_LATITUDE,
      east: 180,
      north: MERCATOR_LATITUDE,
    },
    minZoom: 4,
    maxZoom: 4,
  });
  const metadata = (size) =>
    Object.fromEntries(
      planOfflineTiles(template).map(({ key }) => [
        key,
        { bytes: size, sha256: digest, contentType: 'image/png' },
      ]),
    );
  let low = 1,
    high = OFFLINE_LIMITS.maxTileBytes,
    large;
  while (low <= high) {
    const size = Math.floor((low + high) / 2);
    try {
      large = validateOfflineManifest({
        ...template,
        state: 'ready',
        tiles: metadata(size),
        completedTiles: template.plannedTiles,
        downloadedBytes: template.plannedTiles * size,
        updatedAt: NOW,
        acquiredAt: NOW,
      });
      low = size + 1;
    } catch {
      high = size - 1;
    }
  }
  for (let index = 0; index < 4; index++)
    total.driver.packs.set(idAt(index), { ...large, id: idAt(index) });
  await assert.rejects(
    total.store.copyFromServer(ready({ minZoom: 1, maxZoom: 1 }), {
      fetchTile,
    }),
    { name: 'QuotaExceededError' },
  );
  assert.notEqual((await total.store.getManifest(ID))?.state, 'ready');
  assert.ok(
    (await total.store.listPacks()).reduce(
      (sum, pack) => sum + packStorageBytes(pack),
      0,
    ) <= OFFLINE_LIMITS.maxTotalBytes,
  );
  total.store.close();
});

test('actual storage quota aborts preserve a failed manifest without publishing missing bytes', async () => {
  const fixture = await storeFixture();
  fixture.driver.writeTile = async () => {
    throw new DOMException('Disk full', 'QuotaExceededError');
  };
  await assert.rejects(fixture.store.copyFromServer(ready(), { fetchTile }), {
    name: 'QuotaExceededError',
  });
  const pack = await fixture.store.getManifest(ID);
  assert.equal(pack.state, 'failed');
  assert.equal(pack.completedTiles, 0);
  assert.equal(fixture.driver.tiles.size, 0);
  fixture.store.close();
});

test('deleting an active copy waits for cancellation so late writes cannot resurrect it', async () => {
  const { store } = await storeFixture();
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const copy = store.copyFromServer(ready(), {
    fetchTile: async () => {
      entered();
      await pending;
      return fetchTile();
    },
  });
  await started;
  const deletion = store.deletePack(ID);
  release();
  await assert.rejects(copy, { name: 'AbortError' });
  await deletion;
  assert.equal(await store.getManifest(ID), null);
  store.close();
});

test('portable binary backup restores exact tiles and rejects altered, truncated and trailing data', async () => {
  const first = await storeFixture();
  await first.store.copyFromServer(ready(), { fetchTile });
  const progress = [];
  const file = await first.store.exportPack(ID, {
    onProgress: (value) => progress.push(value.completedTiles),
  });
  assert.deepEqual(progress, [1]);
  assert.equal(file.size, packStorageBytes(ready()));
  const second = await storeFixture();
  await second.store.importPack(file);
  assert.deepEqual(await second.store.getManifest(ID), ready());
  assert.deepEqual((await second.store.getTile(ID, '0/0/0')).bytes, PNG);
  await assert.rejects(readOfflinePack(file.slice(0, -1)), /Truncated/);
  await assert.rejects(
    readOfflinePack(new Blob([file, new Uint8Array([0])])),
    /trailing/,
  );
  const altered = new Uint8Array(await file.arrayBuffer());
  altered[altered.length - 20] ^= 1;
  const third = await storeFixture();
  await assert.rejects(third.store.importPack(new Blob([altered])), /SHA256/);
  assert.equal((await third.store.getManifest(ID)).state, 'failed');
  const huge = {
    size: OFFLINE_LIMITS.maxPackBytes + 1,
    slice() {
      throw new Error('must not read');
    },
  };
  await assert.rejects(readOfflinePack(huge), /size/);
  first.store.close();
  second.store.close();
  third.store.close();
});

test('backup cancellation and missing/corrupt bytes fail before producing a file', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    exportOfflinePack(ready(), fetchTile, { signal: controller.signal }),
    { name: 'AbortError' },
  );
  await assert.rejects(
    exportOfflinePack(ready(), async () => null),
    /incomplete/,
  );
  await assert.rejects(
    exportOfflinePack(ready(), async () => ({
      bytes: JPEG,
      contentType: 'image/jpeg',
    })),
    /integrity/,
  );
  const during = new AbortController();
  await assert.rejects(
    exportOfflinePack(
      ready({ minZoom: 1, maxZoom: 1 }),
      async () => ({ bytes: PNG, contentType: 'image/png' }),
      { signal: during.signal, onProgress: () => during.abort() },
    ),
    { name: 'AbortError' },
  );
});

test('ordinary boot never opens or creates IndexedDB before map-storage opt-in', async () => {
  let opens = 0;
  assert.equal(
    await openExistingOfflinePackStore({
      indexedDB: {
        open() {
          opens++;
          throw new Error('unexpected');
        },
        databases: async () => [],
      },
    }),
    null,
  );
  assert.equal(
    await openExistingOfflinePackStore({
      indexedDB: {
        open() {
          opens++;
          throw new Error('unexpected');
        },
      },
    }),
    null,
  );
  assert.equal(opens, 0);
  let aborted = false;
  const request = {
    transaction: {
      abort() {
        aborted = true;
        queueMicrotask(() => {
          request.error = new DOMException('Absent', 'AbortError');
          request.onerror();
        });
      },
    },
  };
  const opening = openIndexedDbDriver(
    {
      open() {
        queueMicrotask(() => request.onupgradeneeded());
        return request;
      },
    },
    { existingOnly: true },
  );
  await assert.rejects(opening, { name: 'AbortError' });
  assert.equal(aborted, true);
});

test('boot restores only a ready explicit selection and owns store cleanup', async () => {
  assert.equal(
    await readSelectedOfflinePack({ openStore: async () => null }),
    null,
  );
  const fixture = await storeFixture();
  assert.equal(
    await readSelectedOfflinePack({ openStore: async () => fixture.store }),
    null,
  );
  assert.equal(fixture.driver.closed, true);
  const selected = await storeFixture();
  await selected.store.copyFromServer(ready(), { fetchTile });
  await selected.store.setSelectedPackId(ID);
  const result = await readSelectedOfflinePack({
    openStore: async () => selected.store,
  });
  assert.equal(result.manifest.id, ID);
  assert.equal(result.store, selected.store);
  assert.equal(selected.driver.closed, false);
  selected.store.close();
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    readSelectedOfflinePack({
      openStore: async () => {
        throw new Error('must not open');
      },
      signal: aborted.signal,
    }),
    { name: 'AbortError' },
  );
});

function sdkFixture() {
  const urls = [],
    events = [];
  return {
    urls,
    sdk: {
      Resource: {
        fetchImage: async ({ url }) => {
          urls.push(url);
          if (url.startsWith('data:')) {
            const image = await sharp(Buffer.from(url.split(',')[1], 'base64'))
              .raw()
              .toBuffer({ resolveWithObject: true });
            assert.equal(image.info.width, 1);
            assert.equal(image.data[3], 0);
          }
          return { url };
        },
      },
      WebMercatorTilingScheme: class {
        rectangle = { west: -Math.PI, east: Math.PI };
      },
      Event: class {
        constructor() {
          events.push(this);
        }
        addEventListener() {
          return () => {};
        }
      },
      Credit: class {
        constructor(html) {
          this.html = html;
        }
      },
      EllipsoidTerrainProvider: class {
        local = true;
      },
    },
  };
}
test('local imagery reads verified storage only, returns transparent coverage misses and revokes image URLs', async () => {
  const { sdk, urls } = sdkFixture();
  let reads = 0;
  const provider = createOfflineImageryProvider(
    {
      manifest: ready({ minZoom: 1, maxZoom: 1, name: '<Saved & safe>' }),
      store: {
        getTile: async () => {
          reads++;
          return fetchTile();
        },
      },
    },
    sdk,
  );
  assert.equal(provider.minimumLevel, 0);
  assert.equal(provider.maximumLevel, 1);
  assert.match(provider.credit.html, /&lt;Saved &amp; safe&gt;/);
  assert.match(provider.credit.html, /Flat ellipsoid/);
  await provider.requestImage(0, 0, 0);
  assert.equal(reads, 0);
  assert.ok(urls[0].startsWith('data:image/png'));
  const image = await provider.requestImage(0, 0, 1);
  assert.equal(reads, 1);
  assert.ok(image.url.startsWith('blob:'));
  await assert.rejects(fetch(image.url));
  provider.destroy();
  provider.destroy();
  await provider.requestImage(0, 0, 1);
  assert.equal(reads, 1);
  assert.equal(provider.isDestroyed(), true);
});
test('corrupt local tiles do not trigger retry loops or online fallback', async () => {
  const { sdk, urls } = sdkFixture();
  let reads = 0;
  const provider = createOfflineImageryProvider(
    {
      manifest: ready(),
      store: {
        getTile: async () => {
          reads++;
          throw new Error('corrupt');
        },
      },
    },
    sdk,
  );
  await provider.requestImage(0, 0, 0);
  await provider.requestImage(0, 0, 0);
  assert.equal(reads, 1);
  assert.equal(urls.length, 1);
  assert.ok(urls[0].startsWith('data:'));
});

test('ready imagery pins validated metadata once while checking each stored tile and deletion', async () => {
  const fixture = await storeFixture();
  const pack = ready({ minZoom: 1, maxZoom: 1 });
  await fixture.store.copyFromServer(pack, { fetchTile });
  let metadataReads = 0;
  const original = fixture.driver.manifest;
  fixture.driver.manifest = async (id) => {
    metadataReads++;
    return original(id);
  };
  const { sdk } = sdkFixture();
  const provider = createOfflineImageryProvider(
    { manifest: pack, store: fixture.store },
    sdk,
  );
  await provider.requestImage(0, 0, 1);
  await provider.requestImage(1, 1, 1);
  assert.equal(metadataReads, 0);
  const key = `${ID}:1/0/1`;
  const corrupt = PNG.slice();
  corrupt[corrupt.length - 20] ^= 1;
  fixture.driver.tiles.get(key).bytes = corrupt.buffer;
  const invalid = await provider.requestImage(0, 1, 1);
  assert.ok(invalid.url.startsWith('data:'));
  assert.equal(metadataReads, 0);
  await fixture.store.deletePack(ID);
  const deleted = await provider.requestImage(1, 0, 1);
  assert.ok(deleted.url.startsWith('data:'));
  assert.equal(metadataReads, 0);
  provider.destroy();
  fixture.store.close();
});

test('saved-map sessions can request configured Google lazily and failures retain the local source', async () => {
  let calls = 0,
    destroyed = 0;
  const tileset = {
    show: false,
    destroy() {
      destroyed++;
    },
    isDestroyed() {
      return destroyed > 0;
    },
  };
  const registry = createDefaultMapSources({
    googleApiKey: 'synthetic-configured-key',
    createGoogleTileset: async () => {
      calls++;
      if (calls === 1) throw new Error('Synthetic unavailable Google source');
      return tileset;
    },
  });
  assert.equal(registry.defaultId, 'esri-imagery');
  assert.equal(
    registry.sources.find((source) => source.descriptor.id === 'photoreal')
      .available,
    true,
  );
  assert.equal(calls, 0);
  const layers = [],
    primitives = [];
  const viewer = {
    scene: {
      globe: { show: true },
      requestRender() {},
      primitives: {
        add(value) {
          primitives.push(value);
        },
        remove(value) {
          primitives.splice(primitives.indexOf(value), 1);
        },
      },
    },
    imageryLayers: {
      add(layer) {
        layers.push(layer);
      },
      remove(layer) {
        layers.splice(layers.indexOf(layer), 1);
      },
    },
  };
  const controller = new MapSourceController(viewer, {
    registry,
    createImageryLayer: (provider) => ({ provider }),
  });
  const { sdk } = sdkFixture();
  const source = offlineSource(ready(), { getTile: fetchTile }, sdk);
  const id = controller.registerLocalSource(source);
  await controller.setStack(id);
  assert.equal(calls, 0);
  assert.equal(controller.getActiveId(), id);
  const failure = await controller.setStack('photoreal');
  assert.match(failure.lastError, /Synthetic unavailable/);
  assert.equal(controller.getActiveId(), id);
  assert.equal(viewer.scene.globe.show, true);
  await controller.setStack('photoreal');
  assert.equal(calls, 2);
  assert.equal(controller.getActiveId(), 'photoreal');
  assert.equal(viewer.scene.globe.show, false);
  assert.equal(controller.getImageryHostTileset(), tileset);
  assert.equal(primitives.length, 1);
  controller.destroy();
  controller.destroy();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(destroyed, 1);
});

test('controller admits branded immutable local sources and removes active resources without public fallback', async () => {
  const { sdk } = sdkFixture();
  const layers = [];
  let online = 0;
  const viewer = {
    scene: { globe: { show: true }, requestRender() {} },
    imageryLayers: {
      add(layer) {
        layers.push(layer);
      },
      remove(layer) {
        layers.splice(layers.indexOf(layer), 1);
      },
    },
  };
  const controller = new MapSourceController(viewer, {
    registry: {
      defaultId: 'online',
      sources: [
        {
          descriptor: { id: 'online' },
          imagery: async () => {
            online++;
            return {};
          },
        },
      ],
    },
    createImageryLayer: (provider) => ({ provider }),
  });
  const source = offlineSource(ready(), { getTile: fetchTile }, sdk);
  assert.equal(isOfflineSource(source), true);
  assert.equal(Object.isFrozen(source), true);
  assert.throws(
    () => controller.registerLocalSource({ ...source }),
    /approved/,
  );
  assert.equal(controller.registerLocalSource(source), `offline-${ID}`);
  assert.equal(controller.registerLocalSource(source), `offline-${ID}`);
  await controller.setStack(`offline-${ID}`);
  assert.equal(online, 0);
  assert.equal(viewer.terrainProvider.local, true);
  assert.equal(layers.length, 1);
  const provider = layers[0].provider;
  controller.removeLocalSource(`offline-${ID}`);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(controller.getActiveId(), null);
  assert.equal(online, 0);
  assert.equal(layers.length, 0);
  assert.equal(provider.isDestroyed(), true);
  assert.equal(controller.removeLocalSource('online'), false);
  controller.destroy();
  assert.throws(() => controller.registerLocalSource(source), /destroyed/);
});
