/** Abortable browser file read. Clearing a session stops native I/O as well as callbacks. */
export function readPackageFile(
  file,
  { limit, signal, FileReaderImpl = globalThis.FileReader } = {},
) {
  signal?.throwIfAborted();
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    !file ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > limit
  )
    return Promise.reject(
      new Error('Mission package file exceeds its size limit'),
    );
  return new Promise((resolve, reject) => {
    const reader = new FileReaderImpl();
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      reader.onload = reader.onerror = reader.onabort = null;
      if (error) reject(error);
      else resolve(result);
    };
    const cancel = () => {
      const error =
        signal?.reason ??
        new DOMException('Package read aborted', 'AbortError');
      finish(error);
      reader.abort();
    };
    reader.onload = () => {
      const result = reader.result;
      if (
        !(result instanceof ArrayBuffer) ||
        result.byteLength !== file.size ||
        result.byteLength > limit
      )
        finish(
          new Error('Mission package file read returned an unexpected size'),
        );
      else finish(null, new Uint8Array(result));
    };
    reader.onerror = () =>
      finish(new Error('Unable to read the selected mission package file'));
    reader.onabort = () =>
      finish(new DOMException('Package read aborted', 'AbortError'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }
    try {
      reader.readAsArrayBuffer(file);
    } catch {
      finish(new Error('Unable to read the selected mission package file'));
    }
  });
}
