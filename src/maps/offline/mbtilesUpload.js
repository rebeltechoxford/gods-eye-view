import {
  OFFLINE_LIMITS,
  validateMbtilesImportRequest,
  validatePackId,
} from './schema.js';

export const MBTILES_IMPORT_API = '/api/maps/offline/imports';
const states = new Set([
  'awaiting-upload',
  'uploading',
  'validating',
  'converting',
  'ready',
  'failed',
  'cancelled',
]);
const signature = new TextEncoder().encode('SQLite format 3\0');

function check(signal, isCurrent) {
  signal?.throwIfAborted();
  if (!isCurrent()) throw new Error('Saved-map account context changed');
}
function pause(signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, 750);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
export function validateImportProgress(value, fileBytes, expectedId) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid MBTiles import status');
  validatePackId(value.id);
  if ((expectedId && value.id !== expectedId) || !states.has(value.state))
    throw new Error('Invalid MBTiles import status');
  for (const [key, maximum] of [
    ['receivedBytes', fileBytes],
    ['completedTiles', OFFLINE_LIMITS.maxTiles],
    ['plannedTiles', OFFLINE_LIMITS.maxTiles],
  ]) {
    if (
      !Number.isSafeInteger(value[key]) ||
      value[key] < 0 ||
      value[key] > maximum
    )
      throw new Error('Invalid MBTiles import progress');
  }
  if (
    value.fileBytes !== fileBytes ||
    value.completedTiles > value.plannedTiles
  )
    throw new Error('Invalid MBTiles import progress');
  if (value.state === 'ready') validatePackId(value.packId);
  if (
    value.error !== undefined &&
    (typeof value.error !== 'string' || value.error.length > 2048)
  )
    throw new Error('Invalid MBTiles import error');
  return value;
}

/** A single selected File is streamed unchanged; no payload/URL is persisted or fetched. */
export async function uploadMbtiles({
  file,
  metadata,
  request,
  signal,
  isCurrent = () => true,
  onProgress = () => {},
  onJob = () => {},
  wait = pause,
}) {
  check(signal, isCurrent);
  const input = validateMbtilesImportRequest({
    ...metadata,
    fileBytes: file?.size,
  });
  if (typeof file?.slice !== 'function')
    throw new Error('Reselect an MBTiles file');
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  check(signal, isCurrent);
  if (
    header.length !== signature.length ||
    header.some((byte, i) => byte !== signature[i])
  )
    throw new Error('Select a standalone SQLite MBTiles file');
  const operation = new AbortController();
  const boundedSignal = AbortSignal.any([
    ...(signal ? [signal] : []),
    operation.signal,
    AbortSignal.timeout(90_000),
  ]);
  let id;
  let ready = false;
  let upload;
  let poll;
  try {
    const start = await request(MBTILES_IMPORT_API, {
      method: 'POST',
      body: input,
      signal: boundedSignal,
    });
    check(boundedSignal, isCurrent);
    const job = validateImportProgress(start, file.size);
    id = job.id;
    onJob(id);
    onProgress(job);
    let uploaded = false;
    upload = request(`${MBTILES_IMPORT_API}/${id}/file`, {
      method: 'PUT',
      rawBody: file,
      signal: boundedSignal,
    }).then((value) => {
      check(boundedSignal, isCurrent);
      validateImportProgress(value, file.size, id);
      uploaded = true;
    });
    // Observe the upload rejection immediately while the first poll is pending.
    upload.catch(() =>
      operation.abort(new Error('MBTiles upload interrupted')),
    );
    poll = (async () => {
      let current = job;
      while (
        !uploaded ||
        !['ready', 'failed', 'cancelled'].includes(current.state)
      ) {
        await wait(boundedSignal);
        check(boundedSignal, isCurrent);
        current = validateImportProgress(
          await request(`${MBTILES_IMPORT_API}/${id}`, {
            signal: boundedSignal,
          }),
          file.size,
          id,
        );
        check(boundedSignal, isCurrent);
        onProgress(current);
      }
      if (current.state !== 'ready')
        throw new Error(
          current.error ||
            `MBTiles import ${current.state}; reselect the original file`,
        );
      ready = true;
      return current;
    })();
    const [, result] = await Promise.all([upload, poll]);
    return result;
  } finally {
    operation.abort(
      new DOMException('Import operation finished', 'AbortError'),
    );
    await Promise.allSettled([upload, poll]);
    if (id && !ready && isCurrent()) {
      // The cancelled upload signal cannot carry the server cancellation request.
      await request(`${MBTILES_IMPORT_API}/${id}/cancel`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
        timeoutMs: 3000,
      }).catch(() => {});
    }
  }
}
