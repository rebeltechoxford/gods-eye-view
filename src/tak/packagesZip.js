// Original ZIP32 implementation from the published PKWARE APPNOTE structure.
// No filesystem extraction, worker, network request, or third-party ZIP code.
export const PACKAGE_LIMITS = Object.freeze({
  archiveBytes: 32 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  entryBytes: 8 * 1024 * 1024,
  manifestBytes: 128 * 1024,
  entries: 128,
  ratio: 100,
});

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  for (let bit = 0; bit < 8; bit++) i = (i >>> 1) ^ (i & 1 ? 0xedb88320 : 0);
  return i >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function refuse(message) {
  throw new Error(`Mission package: ${message}`);
}
export function validatePackagePath(name, directory = false) {
  if (
    typeof name !== 'string' ||
    name.length > 240 ||
    name !== name.normalize('NFC')
  )
    refuse('invalid archive path');
  const value = directory && name.endsWith('/') ? name.slice(0, -1) : name;
  if (!value || /[\\:%<>"|?*\x00-\x1f\x7f]/.test(value) || /^[/.]/.test(value))
    refuse('unsafe archive path');
  for (const part of value.split('/')) {
    if (
      !part ||
      part.length > 100 ||
      part !== part.trim() ||
      /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
      refuse('unsafe archive path segment');
  }
  return value;
}
function extraFields(bytes, at, length) {
  const end = at + length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (at < end) {
    if (at + 4 > end) refuse('truncated ZIP extra field');
    const id = view.getUint16(at, true),
      size = view.getUint16(at + 2, true);
    if ([0x0001, 0x000d, 0x756e, 0x7075, 0x9901].includes(id))
      refuse(
        'ZIP64, Unix link metadata, filename overrides and encrypted entries are unsupported',
      );
    at += 4 + size;
    if (at > end) refuse('truncated ZIP extra field');
  }
}
function zipName(bytes, flags) {
  if (!(flags & 0x800) && bytes.some((byte) => byte >= 128))
    refuse('non-ASCII ZIP names require UTF-8');
  try {
    return decoder.decode(bytes);
  } catch {
    return refuse('invalid UTF-8 ZIP name');
  }
}
async function inflate(bytes, expected, signal) {
  if (typeof DecompressionStream !== 'function')
    refuse(
      'this browser cannot read deflated packages; use a current browser or a stored ZIP',
    );
  let stream;
  try {
    stream = new DecompressionStream('deflate-raw');
  } catch {
    return refuse(
      'this browser cannot read deflated packages; use a stored ZIP',
    );
  }
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const parts = [];
  let length = 0;
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > expected || length > PACKAGE_LIMITS.entryBytes)
        refuse('decompressed entry exceeds its declared or allowed size');
      parts.push(value);
    }
    signal?.throwIfAborted();
    if (length !== expected) refuse('decompressed ZIP length mismatch');
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.message?.startsWith('Mission package:')) throw error;
    return refuse('invalid DEFLATE payload');
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
  }
}

/** Validate every central/local entry before inflating any payload. */
export async function readPackageZip(input, { signal } = {}) {
  signal?.throwIfAborted();
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 22 || bytes.length > PACKAGE_LIMITS.archiveBytes)
    refuse('archive exceeds the 32 MiB limit or is incomplete');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at) => view.getUint16(at, true),
    u32 = (at) => view.getUint32(at, true);
  let end = -1;
  for (
    let at = bytes.length - 22;
    at >= Math.max(0, bytes.length - 65557);
    at--
  ) {
    if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === bytes.length) {
      end = at;
      break;
    }
  }
  if (end < 0 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10))
    refuse('missing ZIP directory or multi-disk archive');
  const count = u16(end + 10),
    directorySize = u32(end + 12),
    directoryAt = u32(end + 16);
  if (
    !count ||
    count > PACKAGE_LIMITS.entries ||
    directoryAt + directorySize !== end
  )
    refuse('ZIP directory count or bounds exceed the limit');
  const entries = [],
    names = new Set();
  let at = directoryAt,
    total = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || u32(at) !== 0x02014b50)
      refuse('invalid ZIP directory entry');
    const flags = u16(at + 8),
      method = u16(at + 10),
      compressed = u32(at + 20),
      size = u32(at + 24),
      nameLength = u16(at + 28),
      extraLength = u16(at + 30),
      commentLength = u16(at + 32),
      local = u32(at + 42),
      external = u32(at + 38);
    if (
      u16(at + 6) > 20 ||
      flags & ~0x080e ||
      ![0, 8].includes(method) ||
      (method === 0 && flags & 6) ||
      u16(at + 34) ||
      [compressed, size, local].includes(0xffffffff)
    )
      refuse(
        'unsupported ZIP encryption, flags, compression, disk or ZIP64 entry',
      );
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (!nameLength || next > end) refuse('truncated ZIP directory name');
    const name = zipName(bytes.subarray(at + 46, at + 46 + nameLength), flags);
    const isDirectory = name.endsWith('/');
    const key = validatePackagePath(name, isDirectory).toLowerCase();
    if (names.has(key)) refuse('duplicate or ambiguous ZIP path');
    names.add(key);
    const fileType = (external >>> 16) & 0xf000;
    if (
      ![0, 0x8000, 0x4000].includes(fileType) ||
      (fileType === 0x4000 && !isDirectory) ||
      (fileType === 0x8000 && isDirectory) ||
      (external & 0x10 && !isDirectory)
    )
      refuse('links and special ZIP files are refused');
    if (
      size > PACKAGE_LIMITS.entryBytes ||
      (isDirectory && size) ||
      (method === 0 && compressed !== size) ||
      size > Math.max(1, compressed) * PACKAGE_LIMITS.ratio
    )
      refuse('ZIP entry size or expansion ratio exceeds the limit');
    total += size;
    if (total > PACKAGE_LIMITS.expandedBytes)
      refuse('expanded archive exceeds 32 MiB');
    extraFields(bytes, at + 46 + nameLength, extraLength);
    if (local + 30 > directoryAt || u32(local) !== 0x04034b50)
      refuse('invalid local ZIP header');
    const localNameLength = u16(local + 26),
      localExtraLength = u16(local + 28);
    const dataAt = local + 30 + localNameLength + localExtraLength;
    if (
      dataAt + compressed > directoryAt ||
      u16(local + 6) !== flags ||
      u16(local + 8) !== method ||
      u16(local + 4) > 20 ||
      zipName(
        bytes.subarray(local + 30, local + 30 + localNameLength),
        flags,
      ) !== name
    )
      refuse('local and directory ZIP headers disagree');
    extraFields(bytes, local + 30 + localNameLength, localExtraLength);
    const crc = u32(at + 16);
    let finish = dataAt + compressed;
    if (flags & 8) {
      if (
        ![0, crc].includes(u32(local + 14)) ||
        ![0, compressed].includes(u32(local + 18)) ||
        ![0, size].includes(u32(local + 22))
      )
        refuse('local ZIP descriptor metadata does not match its directory');
      if (finish + 12 > directoryAt) refuse('truncated ZIP descriptor');
      if (u32(finish) === 0x08074b50) finish += 4;
      if (
        finish + 12 > directoryAt ||
        u32(finish) !== crc ||
        u32(finish + 4) !== compressed ||
        u32(finish + 8) !== size
      )
        refuse('ZIP descriptor does not match its directory');
      finish += 12;
    } else if (
      u32(local + 14) !== crc ||
      u32(local + 18) !== compressed ||
      u32(local + 22) !== size
    )
      refuse('local ZIP length or CRC does not match its directory');
    entries.push({
      name,
      isDirectory,
      local,
      dataAt,
      finish,
      size,
      compressed,
      crc,
      method,
    });
    at = next;
  }
  if (at !== end) refuse('unexpected ZIP directory data');
  let finish = 0;
  for (const entry of [...entries].sort((a, b) => a.local - b.local)) {
    if (entry.local !== finish)
      refuse('overlapping ZIP entries or hidden archive data');
    finish = entry.finish;
  }
  if (finish !== directoryAt) refuse('hidden data before ZIP directory');
  const output = new Map();
  for (const entry of entries) {
    signal?.throwIfAborted();
    const compressed = bytes.subarray(
      entry.dataAt,
      entry.dataAt + entry.compressed,
    );
    const data =
      entry.method === 0
        ? compressed.slice()
        : await inflate(compressed, entry.size, signal);
    if (crc32(data) !== entry.crc) refuse('ZIP CRC check failed');
    if (!entry.isDirectory) output.set(entry.name, data);
  }
  return output;
}

/** Stored ZIP32: deliberately no compressor, credentials, platform paths or timestamps. */
export function writePackageZip(entries) {
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    entries.length > PACKAGE_LIMITS.entries
  )
    refuse('too many archive entries');
  const seen = new Set();
  let size = 22,
    expanded = 0;
  const records = entries.map(({ name, data }) => {
    const key = validatePackagePath(name).toLowerCase();
    if (seen.has(key)) refuse('duplicate ZIP path');
    seen.add(key);
    if (
      !(data instanceof Uint8Array) ||
      data.length > PACKAGE_LIMITS.entryBytes
    )
      refuse('invalid or oversized archive entry');
    const encodedName = encoder.encode(name);
    size += 30 + 46 + encodedName.length * 2 + data.length;
    expanded += data.length;
    if (
      size > PACKAGE_LIMITS.archiveBytes ||
      expanded > PACKAGE_LIMITS.expandedBytes
    )
      refuse('archive exceeds 32 MiB');
    return { data, encodedName, crc: crc32(data) };
  });
  if (
    size > PACKAGE_LIMITS.archiveBytes ||
    expanded > PACKAGE_LIMITS.expandedBytes
  )
    refuse('archive exceeds 32 MiB');
  const bytes = new Uint8Array(size),
    view = new DataView(bytes.buffer);
  const u16 = (at, value) => view.setUint16(at, value, true),
    u32 = (at, value) => view.setUint32(at, value, true);
  let at = 0;
  for (const record of records) {
    record.local = at;
    u32(at, 0x04034b50);
    u16(at + 4, 20);
    u16(at + 6, 0x800);
    u16(at + 12, 33);
    u32(at + 14, record.crc);
    u32(at + 18, record.data.length);
    u32(at + 22, record.data.length);
    u16(at + 26, record.encodedName.length);
    bytes.set(record.encodedName, at + 30);
    bytes.set(record.data, at + 30 + record.encodedName.length);
    at += 30 + record.encodedName.length + record.data.length;
  }
  const directoryAt = at;
  for (const record of records) {
    u32(at, 0x02014b50);
    u16(at + 4, 20);
    u16(at + 6, 20);
    u16(at + 8, 0x800);
    u16(at + 14, 33);
    u32(at + 16, record.crc);
    u32(at + 20, record.data.length);
    u32(at + 24, record.data.length);
    u16(at + 28, record.encodedName.length);
    u32(at + 42, record.local);
    bytes.set(record.encodedName, at + 46);
    at += 46 + record.encodedName.length;
  }
  u32(at, 0x06054b50);
  u16(at + 8, records.length);
  u16(at + 10, records.length);
  u32(at + 12, at - directoryAt);
  u32(at + 16, directoryAt);
  return bytes;
}
