import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  mkdir,
  open,
  lstat,
  opendir,
  realpath,
  rename,
  unlink,
  rmdir,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OfflinePackError } from './errors.js';
import { createMbtilesImporter } from './mbtiles-import.js';
export { OfflinePackError } from './errors.js';
import {
  createOfflineManifest,
  validateOfflineManifest,
  planOfflineTiles,
  parseTileKey,
  offlineTileUrl,
  validateTileBytes,
} from '../../../src/maps/offline/schema.js';

export const OFFLINE_SERVER_LIMITS = Object.freeze({
  packs: 32,
  tiles: 5000,
  packBytes: 512 * 1024 * 1024,
  totalBytes: 2 * 1024 * 1024 * 1024,
  tileBytes: 2 * 1024 * 1024,
  concurrency: 4,
  queuedJobs: 4,
  manifestBytes: 2 * 1024 * 1024,
  tileTimeoutMs: 15_000,
});
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failure = (code, message, status) =>
  new OfflinePackError(code, message, status);

export function defaultOfflinePackRoot(env = process.env) {
  return (
    env.TAK_MAP_PACKS_DIR ||
    path.join(
      env.LOCALAPPDATA ||
        env.XDG_DATA_HOME ||
        path.join(os.homedir(), '.local', 'share'),
      'gods-eye-view',
      'offline-maps',
    )
  );
}

/** Single-writer, fixed-source cache. Files and paths never come from a manifest. */
export async function createOfflinePackStore({
  root = defaultOfflinePackRoot(),
  fetchImpl = globalThis.fetch,
  now = Date.now,
  writeImpl = async (handle, bytes) => {
    await handle.writeFile(bytes);
    await handle.sync();
  },
  limits: suppliedLimits = {},
  forbiddenRoots = [],
  readMbtilesImpl,
} = {}) {
  const limits = Object.fromEntries(
    Object.entries(OFFLINE_SERVER_LIMITS).map(([key, maximum]) => {
      const value = suppliedLimits[key] ?? maximum;
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw failure('CONFIG', 'Invalid offline map resource limit');
      return [key, value];
    }),
  );
  root = path.resolve(root);
  const fold = (value) =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  if (
    forbiddenRoots.some((value) => {
      const denied = path.resolve(value);
      return (
        fold(root) === fold(denied) ||
        fold(root).startsWith(fold(denied + path.sep))
      );
    })
  )
    throw failure(
      'CONFIG',
      'Offline maps must be stored outside the application checkout',
    );
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(root);
  if (
    (await lstat(root)).isSymbolicLink() ||
    fold(canonicalRoot) !== fold(root)
  )
    throw failure('UNSAFE_STORE', 'Offline map root cannot contain a symlink');
  root = canonicalRoot;

  async function safeDirectory(directory) {
    if (
      (directory !== root && !directory.startsWith(root + path.sep)) ||
      (await lstat(directory)).isSymbolicLink() ||
      (await realpath(directory)) !== directory
    )
      throw failure(
        'UNSAFE_STORE',
        'Symlink or noncanonical offline map directory',
      );
  }
  async function readFile(file, maxBytes) {
    await safeDirectory(path.dirname(file));
    if ((await lstat(file)).isSymbolicLink())
      throw failure('UNSAFE_STORE', 'Symlink in offline map store');
    const handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes)
        throw failure('INVALID_FILE', 'Offline map file exceeds its limit');
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }
  async function atomic(file, bytes) {
    await safeDirectory(path.dirname(file));
    const temporary = file + '.part';
    let handle;
    let owned = false;
    try {
      handle = await open(temporary, 'wx', 0o600);
      owned = true;
      await writeImpl(handle, bytes);
      await handle.close();
      handle = null;
      await rename(temporary, file);
    } catch (error) {
      await handle?.close().catch(() => {});
      if (owned) await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  async function entries(directory, maximum) {
    await safeDirectory(directory);
    const result = [];
    for await (const entry of await opendir(directory)) {
      if (result.length >= maximum)
        throw failure(
          'STORE_LIMIT',
          'Offline map directory entry limit reached',
          413,
        );
      result.push(entry);
    }
    return result;
  }
  const lockFile = path.join(root, '.lock');
  let lock;
  try {
    lock = await open(lockFile, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = JSON.parse((await readFile(lockFile, 128)).toString('utf8'));
    if (
      !prior ||
      typeof prior !== 'object' ||
      Array.isArray(prior) ||
      Object.keys(prior).length !== 1 ||
      !Number.isInteger(prior.pid) ||
      prior.pid < 1 ||
      prior.pid > 0x7fffffff
    )
      throw failure('UNSAFE_STORE', 'Invalid offline map writer lock', 503);
    let alive = true;
    try {
      process.kill(prior.pid, 0);
    } catch (check) {
      if (check.code === 'ESRCH') alive = false;
    }
    if (alive)
      throw failure('STORE_BUSY', 'Offline map store is already in use', 503);
    await unlink(lockFile);
    lock = await open(lockFile, 'wx', 0o600);
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid }));
  await lock.sync();
  const packs = new Map();
  const queue = [];
  let active = null;
  let closed = false;
  let payloadBytes = 0;
  let pendingBytes = 0;
  let operations = Promise.resolve();
  const serial = (fn) => {
    const result = operations.then(fn, fn);
    operations = result.catch(() => {});
    return result;
  };
  const copy = (value) => structuredClone(value);
  function snapshot(record) {
    const value = copy(record.manifest);
    // A completed pack is observable as ready only after its final manifest is durable.
    if (record.task && ['ready', 'failed', 'cancelled'].includes(value.state)) {
      value.state = 'downloading';
      value.acquiredAt = null;
    }
    return value;
  }
  const packPath = (id) => path.join(root, id);
  function tilePath(id, key) {
    const { z, x, y } = parseTileKey(key);
    return path.join(packPath(id), 'tiles', `${z}-${x}-${y}.tile`);
  }
  const refresh = (record) => {
    const entries = Object.values(record.manifest.tiles);
    record.manifest.completedTiles = entries.length;
    record.manifest.downloadedBytes = entries.reduce(
      (sum, tile) => sum + tile.bytes,
      0,
    );
    record.manifest.updatedAt = new Date(now()).toISOString();
  };
  function recordOf(id) {
    if (!UUID.test(id) || !packs.has(id))
      throw failure('NOT_FOUND', 'Unknown offline map pack', 404);
    return packs.get(id);
  }
  function persist(record) {
    const attempt = record.writes.then(async () => {
      const bytes = Buffer.from(JSON.stringify(record.manifest));
      if (bytes.length > limits.manifestBytes)
        throw failure(
          'MANIFEST_LIMIT',
          'Offline manifest exceeds its limit',
          413,
        );
      await atomic(
        path.join(packPath(record.manifest.id), 'manifest.json'),
        bytes,
      );
    });
    record.writes = attempt.catch(() => {});
    return attempt;
  }
  const footprint = (extra = 0) =>
    payloadBytes +
    pendingBytes +
    extra +
    packs.size * limits.manifestBytes * 2 +
    limits.concurrency * limits.tileBytes;
  const reserve = (bytes) => {
    if (closed) throw failure('CLOSED', 'Offline map store is closed', 503);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      footprint(bytes) > limits.totalBytes
    )
      throw failure(
        'DISK_LIMIT',
        'Offline map source and output exceed the available store quota',
        413,
      );
    pendingBytes += bytes;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        pendingBytes -= bytes;
      }
    };
  };
  async function inspectTile(record, key) {
    const file = tilePath(record.manifest.id, key);
    let bytes;
    try {
      bytes = await readFile(file, limits.tileBytes);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const contentType = bytes[0] === 0x89 ? 'image/png' : 'image/jpeg';
    validateTileBytes(bytes, contentType);
    return { bytes: bytes.length, contentType, sha256: digest(bytes) };
  }
  async function reconcile(record) {
    for (const entry of await entries(
      path.join(packPath(record.manifest.id), 'tiles'),
      record.plan.length + limits.concurrency,
    )) {
      const file = path.join(packPath(record.manifest.id), 'tiles', entry.name);
      if (entry.isSymbolicLink() || !entry.isFile())
        throw failure('UNSAFE_STORE', 'Unexpected offline map tile entry');
      if (/^\d+-\d+-\d+\.tile\.part$/.test(entry.name)) {
        await unlink(file);
        continue;
      }
      const match = /^(\d+)-(\d+)-(\d+)\.tile$/.exec(entry.name);
      if (!match || !record.keys.has(`${match[1]}/${match[2]}/${match[3]}`))
        throw failure('UNSAFE_STORE', 'Unexpected offline map tile filename');
    }
    const tiles = {};
    for (const tile of record.plan) {
      let metadata;
      try {
        metadata = await inspectTile(record, tile.key);
      } catch (error) {
        if (
          !(error instanceof TypeError) &&
          !(error instanceof OfflinePackError && error.code === 'INVALID_FILE')
        )
          throw error;
        await unlink(tilePath(record.manifest.id, tile.key));
        continue;
      }
      if (metadata) {
        const expected = record.manifest.tiles[tile.key];
        if (
          expected &&
          (metadata.sha256 !== expected.sha256 ||
            metadata.bytes !== expected.bytes)
        ) {
          await unlink(tilePath(record.manifest.id, tile.key));
          continue;
        }
        tiles[tile.key] = metadata;
      }
    }
    payloadBytes -= record.manifest.downloadedBytes;
    record.manifest.tiles = tiles;
    refresh(record);
    payloadBytes += record.manifest.downloadedBytes;
    if (
      record.manifest.state === 'downloading' ||
      record.manifest.completedTiles !== record.manifest.plannedTiles
    )
      record.manifest.state = 'partial';
    if (record.manifest.state !== 'ready') record.manifest.acquiredAt = null;
    if (
      footprint() > limits.totalBytes ||
      record.manifest.downloadedBytes + limits.manifestBytes * 2 >
        limits.packBytes
    )
      throw failure(
        'DISK_LIMIT',
        'Offline map store exceeds its disk limit',
        413,
      );
    await persist(record);
  }
  async function download(record, tile, signal) {
    const timeout = AbortSignal.timeout(limits.tileTimeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const response = await fetchImpl(offlineTileUrl(tile.z, tile.x, tile.y), {
      redirect: 'manual',
      signal: combined,
      headers: { Accept: 'image/png, image/jpeg' },
    });
    if (response.status !== 200 || response.redirected) {
      await response.body?.cancel().catch(() => {});
      throw failure(
        'TILE_RESPONSE',
        'USGS tile request did not return an image',
        502,
      );
    }
    const contentType = String(response.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const declared = response.headers.get('content-length');
    if (
      declared &&
      (!/^\d+$/.test(declared) || Number(declared) > limits.tileBytes)
    ) {
      await response.body?.cancel().catch(() => {});
      throw failure('TILE_LIMIT', 'USGS tile exceeds its size limit', 413);
    }
    const chunks = [];
    let size = 0;
    if (!response.body)
      throw failure('TILE_RESPONSE', 'USGS tile response has no body', 502);
    const reader = response.body.getReader();
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    combined.addEventListener('abort', abort, { once: true });
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > limits.tileBytes)
          throw failure('TILE_LIMIT', 'USGS tile exceeds its size limit', 413);
        chunks.push(Buffer.from(item.value));
      }
    } finally {
      combined.removeEventListener('abort', abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (combined.aborted || closed)
      throw failure('CANCELLED', 'Offline map download stopped');
    const bytes = Buffer.concat(chunks, size);
    validateTileBytes(bytes, contentType);
    if (
      record.manifest.downloadedBytes +
        record.pending +
        size +
        limits.manifestBytes * 2 >
        limits.packBytes ||
      footprint(size) > limits.totalBytes
    )
      throw failure('DISK_LIMIT', 'Offline map disk limit reached', 413);
    record.pending += size;
    pendingBytes += size;
    try {
      await atomic(tilePath(record.manifest.id, tile.key), bytes);
      record.manifest.tiles[tile.key] = {
        bytes: size,
        sha256: digest(bytes),
        contentType,
      };
      payloadBytes += size;
      refresh(record);
    } finally {
      record.pending -= size;
      pendingBytes -= size;
    }
    if (record.manifest.completedTiles % 8 === 0) await persist(record);
  }
  function kick() {
    if (closed || active || !queue.length) return;
    const record = (active = queue.shift());
    record.controller = new AbortController();
    record.task = (async () => {
      try {
        record.manifest.state = 'downloading';
        delete record.manifest.error;
        await persist(record);
        const remaining = record.plan.filter(
          (tile) => !record.manifest.tiles[tile.key],
        );
        let cursor = 0;
        let problem;
        await Promise.all(
          Array.from({ length: limits.concurrency }, async () => {
            try {
              while (
                !record.controller.signal.aborted &&
                cursor < remaining.length
              )
                await download(
                  record,
                  remaining[cursor++],
                  record.controller.signal,
                );
            } catch (error) {
              problem ||= error;
              record.controller.abort();
            }
          }),
        );
        if (problem) throw problem;
        if (record.controller.signal.aborted || closed)
          throw failure('CANCELLED', 'Offline map download stopped');
        record.manifest.state = 'ready';
        record.manifest.acquiredAt = new Date(now()).toISOString();
      } catch (error) {
        record.manifest.state = closed
          ? 'partial'
          : record.cancelled
            ? 'cancelled'
            : 'failed';
        record.manifest.error =
          error instanceof OfflinePackError
            ? error.message
            : 'USGS tile download failed';
      } finally {
        refresh(record);
        await persist(record).catch(() => {
          record.manifest.state = 'failed';
        });
        active = null;
        record.controller = null;
        record.task = null;
        kick();
      }
    })();
  }
  function enqueue(record) {
    if (active === record || queue.includes(record)) return;
    if (queue.length >= limits.queuedJobs)
      throw failure('JOBS_LIMIT', 'Offline map download queue is full', 429);
    record.cancelled = false;
    record.manifest.state = 'downloading';
    queue.push(record);
    kick();
  }
  let importer;
  try {
    importer = await createMbtilesImporter({
      root,
      limits,
      now,
      reserve,
      writeImpl,
      readMbtilesImpl,
      isClosed: () => closed,
      commit: (stage, value, { releaseOutput, isAuthorized }) =>
        serial(async () => {
          if (closed)
            throw failure('CLOSED', 'Offline map store is closed', 503);
          const manifest = validateOfflineManifest(value, {
            requireReady: true,
          });
          if (
            manifest.schemaVersion !== 2 ||
            packs.has(manifest.id) ||
            packs.size >= limits.packs
          )
            throw failure(
              'PACK_LIMIT',
              'Imported map cannot be added to this pack library',
              413,
            );
          if ((await isAuthorized()) !== true)
            throw failure('ACCESS', 'MBTiles import authorization ended', 401);
          await safeDirectory(stage);
          const target = packPath(manifest.id);
          try {
            await lstat(target);
            throw failure(
              'UNSAFE_STORE',
              'Imported pack target already exists',
              503,
            );
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          await rename(stage, target);
          if (closed || (await isAuthorized()) !== true) {
            await rename(target, stage);
            throw failure(
              'ACCESS',
              'MBTiles import authorization ended before commit',
              401,
            );
          }
          releaseOutput();
          payloadBytes += manifest.downloadedBytes;
          const plan = planOfflineTiles(manifest);
          packs.set(manifest.id, {
            manifest,
            plan,
            keys: new Set(plan.map((tile) => tile.key)),
            writes: Promise.resolve(),
            pending: 0,
          });
          return copy(manifest);
        }),
    });
    for (const entry of await entries(root, limits.packs + 2)) {
      if (entry.name === '.lock') continue;
      if (
        entry.name === '.imports' &&
        entry.isDirectory() &&
        !entry.isSymbolicLink()
      )
        continue;
      if (
        !UUID.test(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      )
        throw failure('UNSAFE_STORE', 'Unexpected offline map store entry');
      const directory = path.join(root, entry.name);
      const names = await entries(directory, 3);
      for (const item of names) {
        if (
          item.isSymbolicLink() ||
          !['manifest.json', 'manifest.json.part', 'tiles'].includes(item.name)
        )
          throw failure('UNSAFE_STORE', 'Unexpected offline map pack entry');
        if (item.name === 'manifest.json.part')
          await unlink(path.join(directory, item.name));
      }
      const manifest = copy(
        validateOfflineManifest(
          JSON.parse(
            (
              await readFile(
                path.join(directory, 'manifest.json'),
                limits.manifestBytes,
              )
            ).toString('utf8'),
          ),
        ),
      );
      if (manifest.id !== entry.name)
        throw failure(
          'UNSAFE_STORE',
          'Offline map identity differs from its directory',
        );
      const plan = planOfflineTiles(manifest);
      const record = {
        manifest,
        plan,
        keys: new Set(plan.map((tile) => tile.key)),
        writes: Promise.resolve(),
        pending: 0,
      };
      packs.set(manifest.id, record);
      payloadBytes += manifest.downloadedBytes;
      await reconcile(record);
    }
  } catch (error) {
    await importer?.close();
    await lock.close();
    await unlink(lockFile);
    throw error;
  }

  return {
    root,
    limits,
    list: () =>
      [...packs.values()].map((record) => {
        const {
          tiles: _tiles,
          plannedKeys: _keys,
          provenance,
          ...summary
        } = snapshot(record);
        return provenance
          ? {
              ...summary,
              credit: provenance.sourceTitle,
              provenance: {
                format: provenance.format,
                importedAt: provenance.importedAt,
                edition: provenance.edition,
              },
            }
          : summary;
      }),
    get: (id) => snapshot(recordOf(id)),
    stats: () => ({
      packs: packs.size,
      queued: queue.length,
      active: active ? 1 : 0,
      payloadBytes,
      reservedBytes: footprint(),
      imports: importer.count(),
    }),
    createImport: (input, options) =>
      serial(() => importer.create(input, options)),
    getImport: (id) => importer.get(id),
    uploadImport: (id, request, options) =>
      importer.upload(id, request, options),
    cancelImport: (id) => importer.cancel(id),
    deleteImport: (id) => importer.delete(id),
    create: (input, { isAuthorized = () => true } = {}) =>
      serial(async () => {
        if (closed) throw failure('CLOSED', 'Offline map store is closed', 503);
        if ((await isAuthorized()) !== true)
          throw failure('ACCESS', 'Offline map authorization ended', 401);
        if (packs.size >= limits.packs)
          throw failure('PACK_LIMIT', 'Offline map pack limit reached', 413);
        if (queue.length >= limits.queuedJobs)
          throw failure(
            'JOBS_LIMIT',
            'Offline map download queue is full',
            429,
          );
        if (
          !input ||
          Object.keys(input).some(
            (key) =>
              !['name', 'bounds', 'minZoom', 'maxZoom', 'sourceId'].includes(
                key,
              ),
          ) ||
          (input.sourceId !== undefined && input.sourceId !== 'usgs-topo')
        )
          throw failure(
            'SOURCE',
            'Only the fixed USGS Topographic source is supported',
          );
        const manifest = copy(
          createOfflineManifest({
            ...input,
            id: randomUUID(),
            createdAt: new Date(now()).toISOString(),
          }),
        );
        const plan = planOfflineTiles(manifest);
        if (
          plan.length > limits.tiles ||
          footprint(limits.manifestBytes * 2) > limits.totalBytes
        )
          throw failure(
            'DISK_LIMIT',
            'Offline map pack exceeds its resource limit',
            413,
          );
        const record = {
          manifest,
          plan,
          keys: new Set(plan.map((tile) => tile.key)),
          writes: Promise.resolve(),
          pending: 0,
        };
        await mkdir(path.join(packPath(manifest.id), 'tiles'), {
          recursive: true,
          mode: 0o700,
        });
        packs.set(manifest.id, record);
        try {
          await persist(record);
          if (closed || (await isAuthorized()) !== true)
            throw failure('ACCESS', 'Offline map authorization ended', 401);
        } catch (error) {
          packs.delete(manifest.id);
          await unlink(path.join(packPath(manifest.id), 'manifest.json')).catch(
            () => {},
          );
          await unlink(
            path.join(packPath(manifest.id), 'manifest.json.part'),
          ).catch(() => {});
          await rmdir(path.join(packPath(manifest.id), 'tiles'));
          await rmdir(packPath(manifest.id));
          throw error;
        }
        enqueue(record);
        return snapshot(record);
      }),
    resume: (id) =>
      serial(async () => {
        if (closed) throw failure('CLOSED', 'Offline map store is closed', 503);
        const record = recordOf(id);
        if (active === record || queue.includes(record))
          return snapshot(record);
        await reconcile(record);
        if (
          record.manifest.schemaVersion === 2 &&
          record.manifest.state !== 'ready'
        )
          throw failure(
            'IMPORT_SOURCE_REQUIRED',
            'Reimport the original MBTiles file to repair missing or corrupt imported tiles',
            409,
          );
        if (record.manifest.state !== 'ready') enqueue(record);
        return snapshot(record);
      }),
    cancel: (id) =>
      serial(async () => {
        if (closed) throw failure('CLOSED', 'Offline map store is closed', 503);
        const record = recordOf(id);
        const queued = queue.indexOf(record);
        if (queued >= 0) queue.splice(queued, 1);
        record.cancelled = true;
        record.controller?.abort();
        await record.task;
        if (record.manifest.state !== 'ready')
          record.manifest.state = 'cancelled';
        refresh(record);
        await persist(record);
        return snapshot(record);
      }),
    delete: (id) =>
      serial(async () => {
        if (closed) throw failure('CLOSED', 'Offline map store is closed', 503);
        const record = recordOf(id);
        const queued = queue.indexOf(record);
        if (queued >= 0) queue.splice(queued, 1);
        record.cancelled = true;
        record.controller?.abort();
        await record.task;
        await record.writes;
        const directory = packPath(id);
        if (
          (await realpath(directory)) !== directory ||
          !directory.startsWith(root + path.sep)
        )
          throw failure('UNSAFE_STORE', 'Unsafe offline map deletion target');
        for (const item of await entries(
          path.join(directory, 'tiles'),
          record.plan.length + limits.concurrency,
        )) {
          if (
            !item.isFile() ||
            item.isSymbolicLink() ||
            !/^\d+-\d+-\d+\.tile(?:\.part)?$/.test(item.name)
          )
            throw failure('UNSAFE_STORE', 'Unsafe offline map deletion entry');
          await unlink(path.join(directory, 'tiles', item.name));
        }
        await rmdir(path.join(directory, 'tiles'));
        await unlink(path.join(directory, 'manifest.json'));
        await rmdir(directory);
        payloadBytes -= record.manifest.downloadedBytes;
        packs.delete(id);
      }),
    tile: async (id, key) => {
      const record = recordOf(id);
      const expected = record.manifest.tiles[key];
      if (!record.keys.has(key) || !expected)
        throw failure('NOT_FOUND', 'Offline map tile is not downloaded', 404);
      const bytes = await readFile(tilePath(id, key), limits.tileBytes);
      validateTileBytes(bytes, expected.contentType);
      if (bytes.length !== expected.bytes || digest(bytes) !== expected.sha256)
        throw failure(
          'CORRUPT_TILE',
          'Stored offline map tile failed integrity validation',
          409,
        );
      return {
        bytes,
        contentType: expected.contentType,
        sha256: expected.sha256,
      };
    },
    close: async () => {
      if (closed) return;
      closed = true;
      queue.length = 0;
      active?.controller?.abort();
      await active?.task;
      await operations;
      await importer.close();
      await Promise.all(
        [...packs.values()].map((record) => record.writes.catch(() => {})),
      );
      await lock.close();
      await unlink(lockFile);
    },
  };
}
