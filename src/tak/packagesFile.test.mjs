import test from 'node:test';
import assert from 'node:assert/strict';
import { readPackageFile } from './packagesFile.js';

function fakeReader() {
  const active = [];
  class Reader {
    constructor() {
      active.push(this);
    }
    readAsArrayBuffer(file) {
      this.file = file;
    }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
    complete(result) {
      this.result = result;
      this.onload?.();
    }
  }
  return { active, Reader };
}
test('bounded file read returns bytes and removes all callbacks on completion', async () => {
  const { active, Reader } = fakeReader();
  const pending = readPackageFile(
    { size: 3 },
    { limit: 8, FileReaderImpl: Reader },
  );
  active[0].complete(new Uint8Array([1, 2, 3]).buffer);
  assert.deepEqual(await pending, new Uint8Array([1, 2, 3]));
  assert.equal(active[0].onload, null);
  assert.equal(active[0].onerror, null);
});
test('clear aborts native file I/O and ignores a late completion without exposing bytes', async () => {
  const { active, Reader } = fakeReader(),
    controller = new AbortController();
  const pending = readPackageFile(
    { size: 3 },
    { limit: 8, signal: controller.signal, FileReaderImpl: Reader },
  );
  controller.abort(new Error('session cleared'));
  await assert.rejects(pending, /session cleared/);
  assert.equal(active[0].aborted, true);
  active[0].complete(new Uint8Array([9, 9, 9]).buffer);
  assert.equal(active[0].onload, null);
});
test('oversize/pre-aborted files do not start reads; inconsistent native output is refused', async () => {
  const { active, Reader } = fakeReader();
  await assert.rejects(
    readPackageFile({ size: 9 }, { limit: 8, FileReaderImpl: Reader }),
    /size limit/,
  );
  const controller = new AbortController();
  controller.abort(new Error('already cleared'));
  assert.throws(
    () =>
      readPackageFile(
        { size: 1 },
        { limit: 8, signal: controller.signal, FileReaderImpl: Reader },
      ),
    /already cleared/,
  );
  assert.equal(active.length, 0);
  const pending = readPackageFile(
    { size: 3 },
    { limit: 8, FileReaderImpl: Reader },
  );
  active[0].complete(new ArrayBuffer(4));
  await assert.rejects(pending, /unexpected size/);
});
