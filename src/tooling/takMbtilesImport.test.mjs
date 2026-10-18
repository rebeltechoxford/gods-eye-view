import test from 'node:test';
import assert from 'node:assert/strict';
import * as sqlite from 'node:sqlite';
import { Readable, PassThrough } from 'node:stream';
import {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  unlink,
  rm,
  mkdir,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { createOfflinePackStore } from '../../server/maps/offline/store.js';
import { validateOfflineManifest } from '../maps/offline/schema.js';

const Database = sqlite.Database || sqlite.DatabaseSync;
const image = await readFile(
  new URL(
    '../../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
    import.meta.url,
  ),
);
async function fixture(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'gev-mbtiles-import-'),
  );
  const stores = [];
  t.after(async () => {
    await Promise.all(stores.map((store) => store.close()));
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    assert.match(path.basename(directory), /^gev-mbtiles-import-/);
    await rm(directory, { recursive: true, force: true });
  });
  const source = path.join(directory, 'fixture.mbtiles'),
    root = path.join(directory, 'packs');
  const db = new Database(source);
  db.exec(
    "CREATE TABLE metadata(name TEXT,value TEXT); INSERT INTO metadata VALUES('name','Synthetic approved map'),('format','jpg'),('attribution','<b>Original & notice</b>'); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB); BEGIN",
  );
  const insert = db.prepare('INSERT INTO tiles VALUES(?,?,?,?)');
  insert.run(2, 1, 0, image);
  insert.run(2, 1, 3, image);
  db.exec('COMMIT');
  db.close();
  const bytes = await readFile(source);
  const input = {
    name: 'Approved local raster',
    fileBytes: bytes.length,
    sourceTitle: 'Synthetic operator-owned map',
    sourceUrl: 'https://example.invalid/source',
    license: 'Owned fixture, permission to copy and retain.',
    edition: '2026 fixture',
    authorized: true,
  };
  const upload = (value = bytes) =>
    Object.assign(Readable.from([value]), {
      headers: {
        'content-type': 'application/vnd.sqlite3',
        'content-length': String(bytes.length),
      },
    });
  const openStore = async (options = {}) => {
    const store = await createOfflinePackStore({
      root,
      fetchImpl: async () => {
        throw new Error(
          'Imported maps must never fetch metadata URLs or the USGS source',
        );
      },
      ...options,
    });
    stores.push(store);
    return store;
  };
  return { root, source, bytes, input, upload, openStore };
}
async function finished(store, id) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = store.getImport(id);
    if (['ready', 'failed', 'cancelled'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('MBTiles fixture import did not finish');
}

test('approved raster import is atomic, provenance-preserving, durable and never a URL fetch', async (t) => {
  const f = await fixture(t);
  let store = await f.openStore();
  const initial = await store.createImport(f.input);
  assert.equal(initial.state, 'awaiting-upload');
  assert.equal(store.list().length, 0);
  assert.ok(store.stats().reservedBytes >= f.bytes.length);
  const staged = await store.uploadImport(initial.id, f.upload(), {
    isAuthorized: () => true,
  });
  assert.ok(['validating', 'converting', 'ready'].includes(staged.state));
  const result = await finished(store, initial.id);
  assert.equal(result.state, 'ready', result.error);
  const manifest = validateOfflineManifest(store.get(result.packId), {
    requireReady: true,
  });
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.plannedKeys, ['2/1/0', '2/1/3']);
  assert.equal(
    manifest.provenance.sha256,
    createHash('sha256').update(f.bytes).digest('hex'),
  );
  assert.equal(manifest.provenance.license, f.input.license);
  assert.equal(manifest.provenance.edition, f.input.edition);
  assert.match(manifest.credit, /Original & notice/);
  assert.equal(store.list()[0].plannedKeys, undefined);
  assert.equal(store.list()[0].provenance.metadata, undefined);
  assert.equal(store.list()[0].provenance.edition, f.input.edition);
  assert.deepEqual((await store.tile(manifest.id, '2/1/0')).bytes, image);
  assert.deepEqual(await readdir(path.join(f.root, '.imports')), []);
  await store.deleteImport(initial.id);
  assert.equal(store.list().length, 1);
  await store.close();
  store = await f.openStore();
  const retained = store.get(manifest.id);
  assert.ok(Date.parse(retained.updatedAt) >= Date.parse(manifest.updatedAt));
  assert.deepEqual({ ...retained, updatedAt: manifest.updatedAt }, manifest);
  await store.resume(manifest.id); // A complete imported pack remains complete.
  await unlink(path.join(f.root, manifest.id, 'tiles', '2-1-0.tile'));
  await store.close();
  store = await f.openStore();
  assert.equal(store.get(manifest.id).state, 'partial');
  await assert.rejects(
    () => store.resume(manifest.id),
    (error) => error.code === 'IMPORT_SOURCE_REQUIRED',
  );
  await store.delete(manifest.id);
  assert.equal(store.list().length, 0);
});

test('selected import retains original hash/notices and selected envelope, charges the entire source and persists its exact keys', async (t) => {
  const f = await fixture(t);
  const selection = {
    bounds: { west: -89, south: 10, east: -1, north: 80 },
    minZoom: 2,
    maxZoom: 2,
  };
  let store = await f.openStore();
  const job = await store.createImport({ ...f.input, selection });
  assert.ok(store.stats().reservedBytes >= f.bytes.length);
  await store.uploadImport(job.id, f.upload(), { isAuthorized: () => true });
  const result = await finished(store, job.id);
  assert.equal(result.state, 'ready', result.error);
  const manifest = store.get(result.packId);
  assert.deepEqual(manifest.plannedKeys, ['2/1/0']);
  assert.deepEqual(manifest.provenance.selection, selection);
  assert.equal(manifest.provenance.fileBytes, f.bytes.length);
  assert.equal(
    manifest.provenance.sha256,
    createHash('sha256').update(f.bytes).digest('hex'),
  );
  assert.equal(manifest.provenance.license, f.input.license);
  assert.match(manifest.credit, /^Imported subset\n/);
  assert.deepEqual(store.list()[0].provenance.selection, selection);
  await store.close();
  store = await f.openStore();
  assert.deepEqual(store.get(manifest.id).provenance.selection, selection);
  assert.equal(store.list().length, 1);
  const limited = await f.openStore({
    root: f.root + '-limited',
    limits: { packBytes: f.bytes.length - 1 },
  });
  await assert.rejects(
    () => limited.createImport({ ...f.input, selection }),
    /source exceeds/,
  );
});

test('selected conversion revoked while a tile write is paused cannot publish or leave late staged files', async (t) => {
  const f = await fixture(t);
  let authorized = true,
    entered,
    release;
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  const writing = new Promise((resolve) => {
    entered = resolve;
  });
  const store = await f.openStore({
    writeImpl: async (handle, bytes) => {
      if (bytes[0] !== 123) {
        entered();
        await paused;
      }
      await handle.writeFile(bytes);
      await handle.sync();
    },
  });
  const selection = {
    bounds: { west: -89, south: 10, east: -1, north: 80 },
    minZoom: 2,
    maxZoom: 2,
  };
  const job = await store.createImport({ ...f.input, selection });
  await store.uploadImport(job.id, f.upload(), {
    isAuthorized: () => authorized,
  });
  try {
    await writing;
    authorized = false;
  } finally {
    release();
  }
  assert.equal((await finished(store, job.id)).state, 'failed');
  assert.equal(store.list().length, 0);
  assert.deepEqual(await readdir(path.join(f.root, '.imports')), []);
});

test('source plus normalized output share the existing quota; no incomplete pack becomes visible', async (t) => {
  const f = await fixture(t);
  const store = await f.openStore({
    limits: {
      concurrency: 1,
      tileBytes: image.length,
      manifestBytes: 2048,
      totalBytes: f.bytes.length + image.length + 1000,
    },
  });
  const job = await store.createImport(f.input);
  await store.uploadImport(job.id, f.upload(), { isAuthorized: () => true });
  const result = await finished(store, job.id);
  assert.equal(result.state, 'failed');
  assert.match(result.error, /quota|limit/);
  assert.equal(store.list().length, 0);
  assert.equal(store.stats().payloadBytes, 0);
  assert.equal(store.stats().reservedBytes, image.length);
  assert.deepEqual(await readdir(path.join(f.root, '.imports')), []);
});

test('authorization expiry and explicit cancellation stop upload/conversion and clear staged bytes', async (t) => {
  const f = await fixture(t),
    store = await f.openStore();
  const first = await store.createImport(f.input);
  const request = Object.assign(new PassThrough(), {
    headers: {
      'content-type': 'application/vnd.sqlite3',
      'content-length': String(f.bytes.length),
    },
  });
  const uploading = store.uploadImport(first.id, request, {
    isAuthorized: () => true,
  });
  request.write(f.bytes.subarray(0, 128));
  await store.cancelImport(first.id);
  await uploading;
  assert.equal(store.getImport(first.id).state, 'cancelled');
  const second = await store.createImport(f.input);
  let authorized = true;
  await store.uploadImport(second.id, f.upload(), {
    isAuthorized: () => authorized,
  });
  authorized = false;
  const result = await finished(store, second.id);
  assert.equal(result.state, 'failed');
  assert.equal(store.list().length, 0);
  assert.deepEqual(await readdir(path.join(f.root, '.imports')), []);
});

test('async permission failure and revocation at the ready-manifest boundary never publish a pack', async (t) => {
  const f = await fixture(t);
  let authorized = true;
  const store = await f.openStore({
    writeImpl: async (handle, bytes) => {
      if (bytes[0] === 123 && JSON.parse(bytes.toString()).state === 'ready')
        authorized = false;
      await handle.writeFile(bytes);
      await handle.sync();
    },
  });
  const first = await store.createImport(f.input);
  await store.uploadImport(first.id, f.upload(), {
    isAuthorized: async () => authorized,
  });
  assert.equal((await finished(store, first.id)).state, 'failed');
  assert.equal(store.list().length, 0);
  const second = await store.createImport(f.input);
  await store.uploadImport(second.id, f.upload(), {
    isAuthorized: async () => {
      throw new Error('Rejected continuation');
    },
  });
  assert.equal((await finished(store, second.id)).state, 'failed');
  const third = await store.createImport(f.input);
  await store.uploadImport(third.id, f.upload(), {
    isAuthorized: () => new Promise(() => {}),
  });
  assert.equal((await finished(store, third.id)).state, 'failed');
  assert.deepEqual(await readdir(path.join(f.root, '.imports')), []);
});

test('exact upload framing, declared byte count and explicit rights are required', async (t) => {
  const f = await fixture(t),
    store = await f.openStore();
  for (const input of [
    { ...f.input, authorized: false },
    { ...f.input, filePath: f.source },
    { ...f.input, sourceUrl: 'file:///private' },
  ])
    await assert.rejects(() => store.createImport(input));
  const job = await store.createImport(f.input);
  for (const headers of [
    { 'content-type': 'application/vnd.sqlite3' },
    {
      'content-type': 'application/octet-stream',
      'content-length': String(f.bytes.length),
    },
    {
      'content-type': 'application/vnd.sqlite3',
      'content-length': String(f.bytes.length),
      'transfer-encoding': 'chunked',
    },
  ])
    await assert.rejects(
      () =>
        store.uploadImport(
          job.id,
          Object.assign(Readable.from([]), { headers }),
          { isAuthorized: () => true },
        ),
      (error) => error.code === 'BODY_LIMIT',
    );
  await store.uploadImport(job.id, f.upload(f.bytes.subarray(0, 120)), {
    isAuthorized: () => true,
  });
  assert.equal(store.getImport(job.id).state, 'failed');
  assert.equal(store.list().length, 0);
});

test('disk failure does not poison future imports, and close prevents an old writer mutating a replacement', async (t) => {
  const f = await fixture(t);
  let fail = true;
  const old = await f.openStore({
    writeImpl: async (handle, bytes) => {
      if (fail)
        throw Object.assign(new Error('synthetic disk-full failure'), {
          code: 'ENOSPC',
        });
      await handle.writeFile(bytes);
      await handle.sync();
    },
  });
  const first = await old.createImport(f.input);
  await old.uploadImport(first.id, f.upload(), { isAuthorized: () => true });
  assert.equal((await finished(old, first.id)).state, 'failed');
  assert.equal(old.list().length, 0);
  fail = false;
  const second = await old.createImport(f.input);
  await old.uploadImport(second.id, f.upload(), { isAuthorized: () => true });
  const ready = await finished(old, second.id);
  assert.equal(ready.state, 'ready', ready.error);
  await old.close();
  const replacement = await f.openStore();
  for (const action of [
    () => old.cancelImport(second.id),
    () => old.deleteImport(second.id),
    () => old.createImport(f.input),
  ])
    await assert.rejects(action, (error) => error.code === 'CLOSED');
  assert.equal(replacement.get(ready.packId).state, 'ready');
});

test('bounded staging is discarded on restart and never interprets metadata paths', async (t) => {
  const f = await fixture(t),
    store = await f.openStore();
  const job = await store.createImport(f.input);
  await store.close();
  await mkdir(path.join(f.root, '.imports', job.id));
  await writeFile(
    path.join(f.root, '.imports', job.id, 'source.mbtiles.part'),
    f.bytes.subarray(0, 128),
  );
  const replacement = await f.openStore();
  assert.equal(replacement.stats().imports, 0);
  assert.deepEqual(await readdir(path.join(f.root, '.imports')), []);
});

for (const mode of ['cancel', 'close', 'revoke'])
  test(`${mode} during an actual staged tile write waits for quiescence and leaves no late files`, async (t) => {
    const f = await fixture(t);
    let authorized = true,
      enter,
      release,
      active = false,
      pausedOnce = false;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const paused = new Promise((resolve) => {
      release = resolve;
    });
    const store = await f.openStore({
      writeImpl: async (handle, bytes) => {
        if (!pausedOnce && bytes[0] !== 123) {
          pausedOnce = true;
          active = true;
          enter();
          await paused;
        }
        await handle.writeFile(bytes);
        await handle.sync();
        active = false;
      },
    });
    const job = await store.createImport(f.input);
    await store.uploadImport(job.id, f.upload(), {
      isAuthorized: () => authorized,
    });
    let stopping,
      stopped = false;
    try {
      await entered;
      if (mode === 'revoke') {
        authorized = false;
        stopping = finished(store, job.id);
      } else
        stopping =
          mode === 'close' ? store.close() : store.cancelImport(job.id);
      stopping = stopping.then((value) => {
        stopped = true;
        return value;
      });
      await new Promise((resolve) =>
        setTimeout(resolve, mode === 'revoke' ? 300 : 30),
      );
      assert.equal(active, true);
      assert.equal(stopped, false);
    } finally {
      release();
    }
    await stopping;
    assert.equal(active, false);
    assert.equal(store.list().length, 0);
    assert.deepEqual(await readdir(path.join(f.root, '.imports')), []);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(await readdir(path.join(f.root, '.imports')), []);
  });

test('unconfirmed reader termination quarantines staging and reservations until host recovery', async (t) => {
  const f = await fixture(t),
    store = await f.openStore({
      readMbtilesImpl: async () => {
        throw Object.assign(
          new Error('internal synthetic worker stop failure'),
          { code: 'MBTILES_WORKER_UNCONFIRMED', workerPid: 12345 },
        );
      },
    });
  const job = await store.createImport(f.input);
  await store.uploadImport(job.id, f.upload(), { isAuthorized: () => true });
  const result = await finished(store, job.id);
  assert.equal(result.state, 'failed');
  assert.match(result.error, /termination is unconfirmed/);
  assert.ok(store.stats().reservedBytes >= f.bytes.length);
  assert.equal(JSON.stringify(result).includes('12345'), false);
  for (const action of [
    () => store.createImport(f.input),
    () => store.cancelImport(job.id),
    () => store.deleteImport(job.id),
  ])
    await assert.rejects(
      action,
      (error) => error.code === 'WORKER_UNCONFIRMED',
    );
  const stage = path.join(f.root, '.imports', job.id);
  assert.deepEqual((await readdir(stage)).sort(), [
    'source.mbtiles',
    'worker-unconfirmed.json',
  ]);
  await store.close();
  await mkdir(path.join(stage, 'tiles'));
  await writeFile(path.join(stage, 'tiles', '2-1-0.tile'), image);
  const sourceBefore = await readFile(path.join(stage, 'source.mbtiles'));
  assert.deepEqual((await readdir(stage)).sort(), [
    'source.mbtiles',
    'tiles',
    'worker-unconfirmed.json',
  ]);
  await assert.rejects(
    () => f.openStore(),
    (error) => error.code === 'UNSAFE_STORE',
  );
  assert.deepEqual(
    await readFile(path.join(stage, 'source.mbtiles')),
    sourceBefore,
  );
  assert.deepEqual(
    await readFile(path.join(stage, 'tiles', '2-1-0.tile')),
    image,
  );
});

for (const action of ['cancelImport', 'deleteImport'])
  test(`${action} begun before unconfirmed worker termination cannot clean quarantined bytes`, async (t) => {
    const f = await fixture(t);
    let enter, release;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const paused = new Promise((resolve) => {
      release = resolve;
    });
    const store = await f.openStore({
      readMbtilesImpl: async () => {
        enter();
        await paused;
        throw Object.assign(
          new Error('internal synthetic worker stop failure'),
          { code: 'MBTILES_WORKER_UNCONFIRMED', workerPid: 12345 },
        );
      },
    });
    const job = await store.createImport(f.input);
    await store.uploadImport(job.id, f.upload(), { isAuthorized: () => true });
    await entered;
    const stopping = store[action](job.id);
    stopping.catch(() => {});
    release();
    await assert.rejects(
      stopping,
      (error) => error.code === 'WORKER_UNCONFIRMED',
    );
    const stage = path.join(f.root, '.imports', job.id);
    assert.deepEqual(
      await readFile(path.join(stage, 'source.mbtiles')),
      f.bytes,
    );
    assert.deepEqual((await readdir(stage)).sort(), [
      'source.mbtiles',
      'worker-unconfirmed.json',
    ]);
    assert.ok(store.stats().reservedBytes >= f.bytes.length);
  });
