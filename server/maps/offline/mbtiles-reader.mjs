import { fork } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OFFLINE_LIMITS,
  parseTileKey,
  validateTileBytes,
} from '../../../src/maps/offline/schema.js';

export const MBTILES_READER_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  heapMiB: 64,
});

/** SQLite is synchronous: a disposable, killable child keeps the HTTPS loop responsive. */
export async function readMbtiles(
  file,
  {
    signal,
    onHeader = () => {},
    onTile = () => {},
    maxBytes = OFFLINE_LIMITS.maxPackBytes,
    timeoutMs = MBTILES_READER_LIMITS.timeoutMs,
    forkImpl = fork,
    stopTimeoutMs = 2000,
  } = {},
) {
  signal?.throwIfAborted();
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 100 ||
    maxBytes > OFFLINE_LIMITS.maxPackBytes
  )
    throw new Error('Invalid MBTiles reader byte limit');
  file = path.resolve(file);
  const stat = await lstat(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (await realpath(file)) !== file ||
    stat.size < 100 ||
    stat.size > maxBytes
  )
    throw new Error('MBTiles source must be a bounded regular private file');
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MBTILES_READER_LIMITS.timeoutMs
  )
    throw new Error('Invalid MBTiles reader deadline');
  if (
    typeof forkImpl !== 'function' ||
    !Number.isInteger(stopTimeoutMs) ||
    stopTimeoutMs < 1 ||
    stopTimeoutMs > 2000
  )
    throw new Error('Invalid MBTiles process dependency or stop deadline');
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR'])
    if (process.env[name]) env[name] = process.env[name];
  env.TEMP = env.TMP = path.dirname(file);
  const child = forkImpl(
    fileURLToPath(new URL('./mbtiles-sqlite.mjs', import.meta.url)),
    [],
    {
      cwd: path.dirname(file),
      env,
      windowsHide: true,
      execArgv: [`--max-old-space-size=${MBTILES_READER_LIMITS.heapMiB}`],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  return new Promise((resolve, reject) => {
    let ended = false,
      header = null,
      received = 0,
      pending = Promise.resolve(),
      stderrBytes = 0;
    let callbackActive = false,
      stopped = false,
      terminationUnconfirmed = false,
      resultError,
      settled = false;
    const seen = new Set();
    let planned;
    const settle = () => {
      if (
        !ended ||
        (!stopped && !terminationUnconfirmed) ||
        callbackActive ||
        settled
      )
        return;
      settled = true;
      resultError ? reject(resultError) : resolve(header);
    };
    const finish = (error) => {
      if (ended) return;
      ended = true;
      resultError = error;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
        stopped = true;
        settle();
        return;
      }
      // In particular on Windows, neither the source file nor the child's cwd
      // can be removed safely until termination has actually completed.
      const onStopped = () => {
        clearTimeout(stopTimer);
        stopped = true;
        settle();
      };
      const stopTimer = setTimeout(() => {
        child.removeListener('exit', onStopped);
        resultError = Object.assign(
          new Error(
            'MBTiles validation process termination is unconfirmed; private host recovery is required',
          ),
          {
            code: 'MBTILES_WORKER_UNCONFIRMED',
            workerPid: child.pid,
          },
        );
        terminationUnconfirmed = true;
        settle();
      }, stopTimeoutMs);
      child.once('exit', onStopped);
      child.kill('SIGKILL');
    };
    const abort = () =>
      finish(signal.reason || new Error('MBTiles import cancelled'));
    const timer = setTimeout(
      () => finish(new Error('MBTiles validation exceeded its time limit')),
      timeoutMs,
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 4096)
        finish(new Error('MBTiles reader diagnostic limit exceeded'));
    });
    child.on('error', () =>
      finish(new Error('MBTiles validation process could not start')),
    );
    child.on('exit', () => {
      if (!ended)
        finish(
          new Error('MBTiles validation process stopped before completion'),
        );
    });
    child.on('message', (message) => {
      pending = pending
        .then(async () => {
          if (ended) return;
          callbackActive = true;
          try {
            if (!message || typeof message !== 'object')
              throw new Error('Invalid MBTiles reader response');
            if (message.op === 'error')
              throw new Error(
                typeof message.message === 'string' &&
                  message.message.length <= 256
                  ? message.message
                  : 'Invalid MBTiles database',
              );
            if (message.op === 'header') {
              if (
                header ||
                !Array.isArray(message.value?.plannedKeys) ||
                !message.value.plannedKeys.length ||
                message.value.plannedKeys.length > OFFLINE_LIMITS.maxTiles
              )
                throw new Error('Invalid MBTiles tile inventory');
              header = message.value;
              for (const key of header.plannedKeys) parseTileKey(key);
              planned = new Set(header.plannedKeys);
              if (planned.size !== header.plannedKeys.length)
                throw new Error('Duplicate MBTiles tile inventory');
              await onHeader(header);
            } else if (message.op === 'tile') {
              if (
                !header ||
                received >= header.plannedKeys.length ||
                !planned.has(message.key) ||
                seen.has(message.key)
              )
                throw new Error('Invalid or duplicate MBTiles tile response');
              parseTileKey(message.key);
              validateTileBytes(message.bytes, message.contentType);
              seen.add(message.key);
              received++;
              await onTile({
                key: message.key,
                bytes: message.bytes,
                contentType: message.contentType,
              });
            } else if (message.op === 'done') {
              if (!header || received !== header.plannedKeys.length)
                throw new Error('MBTiles tile inventory was incomplete');
              finish();
              return;
            } else throw new Error('Unknown MBTiles reader response');
            signal?.throwIfAborted();
            if (!ended) child.send({ op: 'next' });
          } finally {
            // External abort/deadline may stop SQLite while a parent callback is
            // still writing. Never let the importer remove staging until that
            // callback has quiesced. This also avoids waiting on this own chain.
            callbackActive = false;
            settle();
          }
        })
        .catch(finish);
    });
    child.send({ op: 'start', file, maxBytes });
  });
}
