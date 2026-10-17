import {
  OFFLINE_LIMITS,
  validateOfflineManifest,
  planOfflineTiles,
  validateTileBytes,
  hashTile,
} from './schema.js';

const MAGIC = new TextEncoder().encode('GEVMAP01');
/** Raw image bytes, not base64; Blob parts avoid one giant concatenated buffer. */
export async function exportOfflinePack(
  manifest,
  readTile,
  { signal, onProgress = () => {} } = {},
) {
  signal?.throwIfAborted();
  const pack = validateOfflineManifest(manifest, { requireReady: true });
  const metadata = new TextEncoder().encode(JSON.stringify(pack)),
    header = new Uint8Array(12);
  header.set(MAGIC);
  new DataView(header.buffer).setUint32(8, metadata.byteLength);
  const parts = [header, metadata];
  let completedTiles = 0,
    downloadedBytes = 0;
  for (const { key } of planOfflineTiles(pack)) {
    signal?.throwIfAborted();
    const tile = await readTile(pack.id, key);
    signal?.throwIfAborted();
    if (!tile) throw new Error('Saved map backup is incomplete');
    validateTileBytes(tile.bytes, tile.contentType);
    const expected = pack.tiles[key];
    if (
      tile.bytes.byteLength !== expected.bytes ||
      tile.contentType !== expected.contentType ||
      (await hashTile(tile.bytes)) !== expected.sha256
    )
      throw new Error('Saved map backup failed tile integrity validation');
    signal?.throwIfAborted();
    parts.push(tile.bytes);
    completedTiles++;
    downloadedBytes += tile.bytes.byteLength;
    try {
      onProgress({ ...pack, completedTiles, downloadedBytes });
    } catch {
      /* Presentation does not alter the file. */
    }
  }
  const blob = new Blob(parts, { type: 'application/vnd.gev.map-pack' });
  if (blob.size > OFFLINE_LIMITS.maxPackBytes)
    throw new Error('Saved map backup exceeds its size limit');
  return blob;
}
/** Validate all offsets and declared sizes before allowing any storage writes. */
export async function readOfflinePack(blob) {
  if (
    !blob ||
    typeof blob.slice !== 'function' ||
    !Number.isInteger(blob.size) ||
    blob.size < 12 ||
    blob.size > OFFLINE_LIMITS.maxPackBytes
  )
    throw new TypeError('Invalid saved map file size');
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (!MAGIC.every((byte, index) => header[index] === byte))
    throw new TypeError('Unsupported saved map file');
  const length = new DataView(header.buffer).getUint32(8);
  if (
    length < 1 ||
    length > OFFLINE_LIMITS.maxManifestBytes ||
    length + 12 > blob.size
  )
    throw new TypeError('Invalid saved map manifest length');
  const manifest = validateOfflineManifest(
    JSON.parse(await blob.slice(12, 12 + length).text()),
    { requireReady: true },
  );
  const offsets = new Map();
  let offset = 12 + length;
  for (const { key } of planOfflineTiles(manifest)) {
    const meta = manifest.tiles[key];
    offsets.set(key, {
      offset,
      length: meta.bytes,
      contentType: meta.contentType,
    });
    offset += meta.bytes;
    if (offset > blob.size) throw new TypeError('Truncated saved map file');
  }
  if (offset !== blob.size)
    throw new TypeError('Unexpected saved map file trailing bytes');
  return {
    manifest,
    async fetchTile(key, { signal } = {}) {
      signal?.throwIfAborted();
      const entry = offsets.get(key);
      if (!entry) throw new TypeError('Tile outside saved map file');
      const bytes = new Uint8Array(
        await blob
          .slice(entry.offset, entry.offset + entry.length)
          .arrayBuffer(),
      );
      signal?.throwIfAborted();
      return { bytes, contentType: entry.contentType };
    },
  };
}
