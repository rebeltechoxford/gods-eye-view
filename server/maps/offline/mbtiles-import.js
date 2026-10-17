import { randomUUID, createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import {
  createImportedManifest,
  validateMbtilesImportRequest,
  validateOfflineManifest,
  validateTileBytes,
  parseTileKey,
  validatePackId,
} from '../../../src/maps/offline/schema.js';
import { readMbtiles } from './mbtiles-reader.mjs';
import { OfflinePackError } from './errors.js';

const fail = (code, message, status = 400) =>
  new OfflinePackError(code, message, status);
const MAX_RECORDS = 4,
  WAIT_MS = 5 * 60_000;

/** One transient upload/conversion owner. Restart discards unfinished staging;
 * complete packs are atomically adopted by the existing single-writer store. */
export async function createMbtilesImporter({
  root,
  limits,
  now,
  reserve,
  commit,
  isClosed,
  writeImpl,
  readMbtilesImpl = readMbtiles,
}) {
  const directory = path.join(root, '.imports'),
    jobs = new Map();
  let active = null,
    closed = false,
    quarantined = false;
  async function safeDirectory(target) {
    if (
      !target.startsWith(root + path.sep) ||
      (await lstat(target)).isSymbolicLink() ||
      (await realpath(target)) !== target
    )
      throw fail('UNSAFE_STORE', 'Unsafe MBTiles staging directory', 503);
  }
  async function entries(target, maximum) {
    await safeDirectory(target);
    const result = [];
    for await (const entry of await opendir(target)) {
      if (result.length >= maximum)
        throw fail('UNSAFE_STORE', 'MBTiles staging entry limit exceeded', 503);
      result.push(entry);
    }
    return result;
  }
  async function removeStage(target) {
    try {
      await safeDirectory(target);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const files = [],
      directories = [];
    // Validate the complete bounded inventory before deleting anything. An
    // unexpected quarantine marker must preserve even alphabetically earlier
    // source/tile entries on restart.
    for (const entry of await entries(target, 5)) {
      if (entry.isSymbolicLink())
        throw fail('UNSAFE_STORE', 'Symlink in MBTiles staging', 503);
      const file = path.join(target, entry.name);
      if (entry.name === 'tiles' && entry.isDirectory()) {
        for (const tile of await entries(file, limits.tiles + 1)) {
          if (
            !tile.isFile() ||
            tile.isSymbolicLink() ||
            !/^\d+-\d+-\d+\.tile(?:\.part)?$/.test(tile.name)
          )
            throw fail('UNSAFE_STORE', 'Unexpected MBTiles staged tile', 503);
          const location = path.join(file, tile.name);
          if ((await lstat(location)).size > limits.tileBytes)
            throw fail('UNSAFE_STORE', 'Oversized MBTiles staged tile', 503);
          files.push(location);
        }
        directories.push(file);
      } else {
        if (
          !entry.isFile() ||
          ![
            'source.mbtiles',
            'source.mbtiles.part',
            'manifest.json',
            'manifest.json.part',
          ].includes(entry.name)
        )
          throw fail('UNSAFE_STORE', 'Unexpected MBTiles staging file', 503);
        const maximum = entry.name.startsWith('source.')
          ? limits.packBytes
          : limits.manifestBytes;
        if ((await lstat(file)).size > maximum)
          throw fail('UNSAFE_STORE', 'Oversized MBTiles staging file', 503);
        files.push(file);
      }
    }
    for (const file of files) await unlink(file);
    for (const directory of directories) await rmdir(directory);
    await rmdir(target);
  }
  async function ensureRoot() {
    await mkdir(directory, { mode: 0o700 });
    await safeDirectory(directory);
  }
  try {
    for (const entry of await entries(directory, MAX_RECORDS)) {
      validatePackId(entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw fail('UNSAFE_STORE', 'Unexpected MBTiles staging entry', 503);
      await removeStage(path.join(directory, entry.name));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const ensure = () => {
    if (closed || isClosed())
      throw fail('CLOSED', 'Offline map store is closed', 503);
    if (quarantined)
      throw fail(
        'WORKER_UNCONFIRMED',
        'MBTiles worker termination is unconfirmed; private host recovery is required',
        503,
      );
  };
  const jobOf = (id) => {
    validatePackId(id);
    const job = jobs.get(id);
    if (!job) throw fail('NOT_FOUND', 'Unknown MBTiles import', 404);
    return job;
  };
  const summary = (job) => ({
    id: job.id,
    state:
      job.task &&
      !job.finished &&
      ['ready', 'failed', 'cancelled'].includes(job.state)
        ? 'converting'
        : job.state,
    fileBytes: job.input.fileBytes,
    receivedBytes: job.receivedBytes,
    completedTiles: job.completedTiles,
    plannedTiles: job.plannedTiles,
    ...(job.packId ? { packId: job.packId } : {}),
    ...(job.error ? { error: job.error } : {}),
  });
  const cleanup = (job) => {
    if (job.quarantined)
      throw fail(
        'WORKER_UNCONFIRMED',
        'MBTiles worker termination is unconfirmed; private host recovery is required',
        503,
      );
    return (job.cleanup ||= removeStage(job.directory).catch((error) => {
      job.cleanup = null;
      throw error;
    }));
  };
  async function expire() {
    for (const job of jobs.values())
      if (job.state === 'awaiting-upload' && now() - job.createdAt > WAIT_MS) {
        job.state = 'failed';
        job.error = 'Upload expired; choose the original MBTiles file again';
        await cleanup(job);
        job.releaseInput();
        job.finished = true;
      }
  }
  const expiry = setInterval(() => {
    void expire().catch(() => {});
  }, 10_000);
  expiry.unref();
  async function atomic(file, bytes) {
    await safeDirectory(path.dirname(file));
    const temporary = file + '.part';
    let handle,
      owned = false;
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
  return {
    async create(value, { isAuthorized = () => true } = {}) {
      ensure();
      await expire();
      if ((await isAuthorized()) !== true)
        throw fail('ACCESS', 'MBTiles import authorization ended', 401);
      const input = validateMbtilesImportRequest(value);
      if (input.fileBytes > limits.packBytes)
        throw fail(
          'DISK_LIMIT',
          'MBTiles source exceeds this account pack limit',
          413,
        );
      if (jobs.size >= MAX_RECORDS) {
        const retired = [...jobs.values()].find(
          (job) =>
            job.finished &&
            ['ready', 'failed', 'cancelled'].includes(job.state),
        );
        if (retired) jobs.delete(retired.id);
      }
      if (jobs.size >= MAX_RECORDS)
        throw fail('JOBS_LIMIT', 'MBTiles import limit reached', 429);
      const releaseInput = reserve(input.fileBytes);
      const id = randomUUID(),
        target = path.join(directory, id);
      try {
        await ensureRoot().catch((error) => {
          if (error.code !== 'EEXIST') throw error;
        });
        await safeDirectory(directory);
        if ((await isAuthorized()) !== true)
          throw fail('ACCESS', 'MBTiles import authorization ended', 401);
        await mkdir(target, { mode: 0o700 });
        ensure();
        if ((await isAuthorized()) !== true)
          throw fail('ACCESS', 'MBTiles import authorization ended', 401);
        const job = {
          id,
          directory: target,
          input,
          createdAt: now(),
          releaseInput,
          receivedBytes: 0,
          completedTiles: 0,
          plannedTiles: 0,
          state: 'awaiting-upload',
        };
        jobs.set(id, job);
        return summary(job);
      } catch (error) {
        await removeStage(target);
        releaseInput();
        throw error;
      }
    },
    get(id) {
      if (closed || isClosed())
        throw fail('CLOSED', 'Offline map store is closed', 503);
      return summary(jobOf(id));
    },
    count: () => jobs.size,
    async upload(id, request, { isAuthorized = () => false } = {}) {
      ensure();
      const job = jobOf(id);
      if (active || job.state !== 'awaiting-upload')
        throw fail(
          'IMPORT_BUSY',
          'An MBTiles upload is already active or must be reselected',
          409,
        );
      if (
        request.headers?.['content-type'] !== 'application/vnd.sqlite3' ||
        request.headers?.['transfer-encoding'] ||
        !/^[1-9]\d*$/.test(request.headers?.['content-length'] || '') ||
        Number(request.headers['content-length']) !== job.input.fileBytes
      )
        throw fail(
          'BODY_LIMIT',
          'MBTiles upload requires its exact bounded file size and application/vnd.sqlite3 type',
          413,
        );
      const controller = new AbortController();
      const authorized = async () => {
        if (closed || isClosed() || controller.signal.aborted) return false;
        let timer;
        try {
          const result = isAuthorized();
          if (!result || typeof result.then !== 'function')
            return result === true;
          return await Promise.race([
            Promise.resolve(result).then(
              (value) => value === true,
              () => false,
            ),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(false), 250);
            }),
          ]);
        } catch {
          return false;
        } finally {
          clearTimeout(timer);
        }
      };
      const check = async () => {
        if (!(await authorized()))
          throw fail(
            'ACCESS',
            'MBTiles import authorization ended or was cancelled',
            401,
          );
      };
      const stopRequest = () => {
        if (job.state === 'uploading') request.destroy?.();
      };
      controller.signal.addEventListener('abort', stopRequest, { once: true });
      const monitor = setInterval(async () => {
        if (!(await authorized())) controller.abort();
      }, 250);
      monitor.unref();
      job.controller = controller;
      job.state = 'uploading';
      active = job;
      let uploadFinished;
      const staged = new Promise((resolve) => {
        uploadFinished = resolve;
      });
      job.task = (async () => {
        let handle,
          releaseOutput = () => {},
          result;
        try {
          await check();
          const source = path.join(job.directory, 'source.mbtiles');
          handle = await open(source + '.part', 'wx', 0o600);
          const hash = createHash('sha256');
          request.setTimeout?.(5000, () => controller.abort());
          for await (const chunk of request) {
            await check();
            job.receivedBytes += chunk.length;
            if (job.receivedBytes > job.input.fileBytes)
              throw fail(
                'BODY_LIMIT',
                'MBTiles upload exceeded its declared byte count',
                413,
              );
            hash.update(chunk);
            await handle.writeFile(chunk);
          }
          await check();
          if (job.receivedBytes !== job.input.fileBytes)
            throw fail('BODY_LIMIT', 'MBTiles upload was incomplete', 400);
          await handle.sync();
          await handle.close();
          handle = null;
          await rename(source + '.part', source);
          const sha256 = hash.digest('hex');
          job.state = 'validating';
          uploadFinished();
          let manifest;
          await readMbtilesImpl(source, {
            signal: controller.signal,
            maxBytes: limits.packBytes,
            async onHeader(header) {
              await check();
              if (
                header.plannedKeys.length > limits.tiles ||
                !Number.isSafeInteger(header.tileBytes) ||
                header.tileBytes + limits.manifestBytes * 2 > limits.packBytes
              )
                throw fail(
                  'DISK_LIMIT',
                  'MBTiles output exceeds this account pack limit',
                  413,
                );
              releaseOutput = reserve(
                header.tileBytes + limits.manifestBytes * 2,
              );
              job.releaseOutput = releaseOutput;
              const importedAt = new Date(now()).toISOString();
              const attribution =
                header.metadata.find((row) => row.name === 'attribution')
                  ?.value || '';
              manifest = createImportedManifest({
                id,
                name: job.input.name,
                bounds: header.bounds,
                minZoom: header.minZoom,
                maxZoom: header.maxZoom,
                plannedKeys: header.plannedKeys,
                sourceUrl: job.input.sourceUrl,
                credit: [job.input.sourceTitle, attribution, job.input.license]
                  .filter(Boolean)
                  .join('\n'),
                provenance: {
                  format: 'mbtiles',
                  sha256,
                  fileBytes: job.input.fileBytes,
                  importedAt,
                  crs: 'EPSG:3857',
                  tileScheme: 'tms',
                  tileSize: 256,
                  permission: 'operator-asserted',
                  sourceTitle: job.input.sourceTitle,
                  license: job.input.license,
                  edition: job.input.edition,
                  metadata: header.metadata,
                },
                createdAt: importedAt,
              });
              job.plannedTiles = manifest.plannedTiles;
              job.state = 'converting';
              await mkdir(path.join(job.directory, 'tiles'), { mode: 0o700 });
            },
            async onTile(tile) {
              await check();
              const { z, x, y } = parseTileKey(tile.key);
              validateTileBytes(tile.bytes, tile.contentType);
              if (tile.bytes.length > limits.tileBytes)
                throw fail(
                  'TILE_LIMIT',
                  'MBTiles tile exceeds this store limit',
                  413,
                );
              await atomic(
                path.join(job.directory, 'tiles', `${z}-${x}-${y}.tile`),
                tile.bytes,
              );
              await check();
              manifest.tiles[tile.key] = {
                bytes: tile.bytes.length,
                contentType: tile.contentType,
                sha256: createHash('sha256').update(tile.bytes).digest('hex'),
              };
              manifest.downloadedBytes += tile.bytes.length;
              manifest.completedTiles++;
              job.completedTiles = manifest.completedTiles;
            },
          });
          await check();
          manifest.state = 'ready';
          manifest.updatedAt = new Date(now()).toISOString();
          manifest.acquiredAt = manifest.provenance.importedAt;
          manifest = validateOfflineManifest(manifest, { requireReady: true });
          const metadata = Buffer.from(JSON.stringify(manifest));
          if (metadata.length > limits.manifestBytes)
            throw fail(
              'MANIFEST_LIMIT',
              'Imported manifest exceeds this store limit',
              413,
            );
          await atomic(path.join(job.directory, 'manifest.json'), metadata);
          await unlink(source);
          job.releaseInput();
          await check();
          result = await commit(job.directory, manifest, {
            releaseOutput,
            isAuthorized: authorized,
          });
          job.state = 'ready';
          job.packId = manifest.id;
        } catch (error) {
          if (error?.code === 'MBTILES_WORKER_UNCONFIRMED') {
            quarantined = true;
            job.quarantined = true;
            // Deliberately outside the ordinary cleanup allowlist: a restart
            // must not remove a source still owned by an unconfirmed process.
            try {
              const marker = await open(
                path.join(job.directory, 'worker-unconfirmed.json'),
                'wx',
                0o600,
              );
              try {
                await marker.writeFile(
                  JSON.stringify({ workerPid: error.workerPid }),
                );
                await marker.sync();
              } finally {
                await marker.close();
              }
            } catch {
              /* Quarantine stays active even if a full disk prevents the marker. */
            }
          }
          job.state = job.cancelled ? 'cancelled' : 'failed';
          job.error =
            error instanceof OfflinePackError ||
            error instanceof TypeError ||
            /^MBTiles|^Only 256|^Invalid, unsupported|^The selected|^Checkpoint|^An MBTiles/.test(
              error?.message || '',
            )
              ? String(error.message).slice(0, 256)
              : 'MBTiles import failed; choose the original file again';
        } finally {
          clearInterval(monitor);
          controller.signal.removeEventListener('abort', stopRequest);
          request.setTimeout?.(0);
          await handle?.close().catch(() => {});
          try {
            if (job.quarantined)
              throw new Error('Worker termination is unconfirmed');
            await cleanup(job);
            releaseOutput();
            job.releaseInput();
          } catch {
            job.state = 'failed';
            job.error = job.quarantined
              ? 'MBTiles worker termination is unconfirmed; private host recovery is required'
              : 'MBTiles staging cleanup failed; restart the private host before retrying';
          }
          if (!job.quarantined) active = null;
          job.controller = null;
          job.finished = true;
          uploadFinished();
        }
        return result;
      })();
      // The upload response acknowledges bounded staging. Conversion progress is polled.
      await staged;
      return summary(job);
    },
    async cancel(id) {
      ensure();
      const job = jobOf(id);
      if (job.state === 'ready') return summary(job);
      job.cancelled = true;
      job.controller?.abort();
      await job.task;
      job.state = 'cancelled';
      await cleanup(job);
      job.releaseInput();
      job.releaseOutput?.();
      job.finished = true;
      return summary(job);
    },
    async delete(id) {
      ensure();
      const job = jobOf(id);
      if (job.state !== 'ready') {
        job.cancelled = true;
        job.controller?.abort();
        await job.task;
        await cleanup(job);
        job.releaseInput();
        job.releaseOutput?.();
      }
      jobs.delete(id);
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(expiry);
      for (const job of jobs.values()) {
        job.cancelled = true;
        job.controller?.abort();
      }
      await Promise.allSettled([...jobs.values()].map((job) => job.task));
      for (const job of jobs.values()) {
        if (job.quarantined) continue;
        await cleanup(job);
        job.releaseInput();
        job.releaseOutput?.();
      }
      jobs.clear();
    },
  };
}
