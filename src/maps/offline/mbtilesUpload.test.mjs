import test from 'node:test';
import assert from 'node:assert/strict';
import {
  uploadMbtiles,
  validateImportProgress,
  MBTILES_IMPORT_API as API,
} from './mbtilesUpload.js';

const id = '11111111-1111-4111-8111-111111111111';
const packId = '22222222-2222-4222-8222-222222222222';
const metadata = {
  name: 'Private chart',
  sourceTitle: 'Synthetic source',
  license: 'Test permission',
  sourceUrl: 'https://example.invalid/chart',
  edition: '2026',
  authorized: true,
};
function file() {
  const bytes = new Uint8Array(100);
  bytes.set(new TextEncoder().encode('SQLite format 3\0'));
  const blob = new Blob([bytes]);
  blob.arrayBuffer = () => {
    throw new Error('Whole file must not be buffered');
  };
  return blob;
}
const progress = (state = 'awaiting-upload', extras = {}) => ({
  id,
  fileBytes: 100,
  receivedBytes: 0,
  completedTiles: 0,
  plannedTiles: 0,
  state,
  ...extras,
});

test('permission, file signature, size and metadata are rejected before creating any server job', async () => {
  let requests = 0;
  const request = () => {
    requests++;
    throw new Error('Unexpected request');
  };
  for (const input of [
    { file: file(), metadata: { ...metadata, authorized: false } },
    { file: new Blob([new Uint8Array(99)]), metadata },
    { file: new Blob([new Uint8Array(100)]), metadata },
    {
      file: file(),
      metadata: {
        ...metadata,
        sourceUrl: 'https://user:password@example.invalid',
      },
    },
    { file: file(), metadata: { ...metadata, license: 'x'.repeat(8193) } },
  ])
    await assert.rejects(uploadMbtiles({ ...input, request }));
  assert.equal(requests, 0);
});

test('the selected Blob is sent unchanged and observed through bounded upload/conversion status', async () => {
  const selected = file(),
    calls = [],
    seen = [];
  let uploaded = false;
  const result = await uploadMbtiles({
    file: selected,
    metadata,
    wait: async () => {},
    onProgress: (p) => seen.push(p.state),
    request: async (url, options = {}) => {
      calls.push({ url, ...options });
      if (options.method === 'POST') {
        assert.equal(options.body.fileBytes, 100);
        assert.equal(options.body.authorized, true);
        return progress();
      }
      if (options.method === 'PUT') {
        assert.equal(options.rawBody, selected);
        assert.equal(options.body, undefined);
        uploaded = true;
        return progress('validating', { receivedBytes: 100 });
      }
      assert(uploaded);
      return progress('ready', {
        receivedBytes: 100,
        completedTiles: 1,
        plannedTiles: 1,
        packId,
      });
    },
  });
  assert.equal(result.packId, packId);
  assert.deepEqual(seen, ['awaiting-upload', 'ready']);
  assert(
    calls.every((call) => call.url.startsWith(API)),
    'Provenance URL must never be fetched',
  );
  assert.equal(calls.length, 3);
});

test('account retirement during header read prevents all network work', async () => {
  let resolve,
    current = true,
    requests = 0;
  const header = new Promise((done) => {
    resolve = done;
  });
  const pending = uploadMbtiles({
    file: { size: 100, slice: () => ({ arrayBuffer: () => header }) },
    metadata,
    isCurrent: () => current,
    request: () => {
      requests++;
    },
  });
  current = false;
  resolve(new TextEncoder().encode('SQLite format 3\0').buffer);
  await assert.rejects(pending, /account context changed/);
  assert.equal(requests, 0);
});

test('cancellation aborts the active upload and poll, then waits for owned cancellation', async () => {
  const controller = new AbortController();
  let uploadFinished = false,
    cancelFinished = false,
    uploaded;
  const started = new Promise((done) => {
    uploaded = done;
  });
  const task = uploadMbtiles({
    file: file(),
    metadata,
    signal: controller.signal,
    request: async (url, options = {}) => {
      if (url.endsWith('/cancel')) {
        assert(
          uploadFinished,
          'Upload must quiesce before cancellation settles',
        );
        cancelFinished = true;
        return progress('cancelled');
      }
      if (options.method === 'POST') return progress();
      if (options.method === 'PUT') {
        uploaded();
        try {
          await new Promise((_, reject) =>
            options.signal.addEventListener(
              'abort',
              () => reject(options.signal.reason),
              { once: true },
            ),
          );
        } finally {
          uploadFinished = true;
        }
      }
      throw new Error('Poll should remain paused until cancellation');
    },
  });
  await started;
  controller.abort(new Error('Operator cancelled'));
  await assert.rejects(task, /Operator cancelled/);
  assert(uploadFinished && cancelFinished);
});

test('a retired account never issues a cleanup request under a replacement cookie', async () => {
  let current = true,
    calls = 0;
  await assert.rejects(
    uploadMbtiles({
      file: file(),
      metadata,
      wait: async () => {},
      isCurrent: () => current,
      request: async (_, options = {}) => {
        calls++;
        if (options.method === 'POST') return progress();
        current = false;
        return progress('validating', { receivedBytes: 100 });
      },
    }),
    /account context changed|upload interrupted/,
  );
  assert.equal(calls, 2);
});

test('malformed IDs, status counters and messages fail closed', () => {
  for (const value of [
    progress('ready', { packId: '../other' }),
    progress('uploading', { id: '../other' }),
    progress('uploading', { fileBytes: 99 }),
    progress('uploading', { receivedBytes: 101 }),
    progress('converting', { completedTiles: 2, plannedTiles: 1 }),
    progress('converting', { plannedTiles: 5001 }),
    progress('failed', { error: 'x'.repeat(2049) }),
    progress('invented'),
  ])
    assert.throws(() => validateImportProgress(value, 100, id));
});

test('a rejected upload cancels its own job and preserves the server error', async () => {
  let cancelled = false;
  await assert.rejects(
    uploadMbtiles({
      file: file(),
      metadata,
      request: async (url, options = {}) => {
        if (url.endsWith('/cancel')) {
          cancelled = true;
          return progress('cancelled');
        }
        if (options.method === 'POST') return progress();
        throw new Error('Upload exceeded server deadline');
      },
    }),
    /Upload exceeded server deadline/,
  );
  assert(cancelled);
});
