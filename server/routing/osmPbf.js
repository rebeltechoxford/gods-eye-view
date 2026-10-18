// Streaming reader for OpenStreetMap PBF files (the .osm.pbf extracts that
// Geofabrik, OpenStreetMap France and BBBike publish). It reads one blob at
// a time, so memory stays proportional to a single block, and hands nodes and
// ways to callbacks. Only what road-pack building needs is decoded: dense and
// plain nodes, ways and their tags. Relations are skipped.
//
// Format: https://wiki.openstreetmap.org/wiki/PBF_Format

import { open } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { PbfReader } from 'pbf';

/** The format caps a BlobHeader at 64 KiB and a blob at 32 MiB. */
export const PBF_LIMITS = Object.freeze({
  maxHeaderBytes: 64 * 1024,
  maxBlobBytes: 32 * 1024 * 1024,
});
const SUPPORTED_REQUIRED = new Set(['OsmSchema-V0.6', 'DenseNodes']);

export class OsmPbfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OsmPbfError';
  }
}

async function readExactly(handle, position, length) {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(
      buffer,
      read,
      length - read,
      position + read,
    );
    if (!bytesRead) return read ? null : undefined;
    read += bytesRead;
  }
  return buffer;
}

function readBlobHeader(bytes) {
  const header = { type: '', datasize: -1 };
  new PbfReader(bytes).readFields((tag, out, pbf) => {
    if (tag === 1) out.type = pbf.readString();
    else if (tag === 3) out.datasize = pbf.readVarint();
  }, header);
  return header;
}

function readBlob(bytes) {
  const blob = { raw: null, rawSize: -1, zlib: null, unsupported: null };
  new PbfReader(bytes).readFields((tag, out, pbf) => {
    if (tag === 1) out.raw = pbf.readBytes();
    else if (tag === 2) out.rawSize = pbf.readVarint();
    else if (tag === 3) out.zlib = pbf.readBytes();
    else if (tag === 4) out.unsupported = 'lzma';
    else if (tag === 6) out.unsupported = 'lz4';
    else if (tag === 7) out.unsupported = 'zstd';
  }, blob);
  if (blob.raw) return blob.raw;
  if (blob.zlib) {
    if (blob.rawSize < 0 || blob.rawSize > PBF_LIMITS.maxBlobBytes)
      throw new OsmPbfError('Blob raw size is missing or too large');
    const out = inflateSync(blob.zlib, {
      maxOutputLength: PBF_LIMITS.maxBlobBytes,
    });
    if (out.length !== blob.rawSize)
      throw new OsmPbfError('Blob size does not match its declared raw size');
    return out;
  }
  throw new OsmPbfError(
    `Unsupported blob compression: ${blob.unsupported || 'none'}`,
  );
}

function readHeaderBlock(bytes) {
  const header = {
    requiredFeatures: [],
    optionalFeatures: [],
    writingProgram: '',
    source: '',
    replicationTimestamp: 0,
    replicationSequence: 0,
    replicationBaseUrl: '',
    bbox: null,
  };
  new PbfReader(bytes).readFields((tag, out, pbf) => {
    if (tag === 1) {
      const bbox = { left: 0, right: 0, top: 0, bottom: 0 };
      pbf.readMessage((t, b, p) => {
        const value = p.readSVarint() * 1e-9;
        if (t === 1) b.left = value;
        else if (t === 2) b.right = value;
        else if (t === 3) b.top = value;
        else if (t === 4) b.bottom = value;
      }, bbox);
      out.bbox = bbox;
    } else if (tag === 4) out.requiredFeatures.push(pbf.readString());
    else if (tag === 5) out.optionalFeatures.push(pbf.readString());
    else if (tag === 16) out.writingProgram = pbf.readString();
    else if (tag === 17) out.source = pbf.readString();
    else if (tag === 32) out.replicationTimestamp = pbf.readVarint();
    else if (tag === 33) out.replicationSequence = pbf.readVarint();
    else if (tag === 34) out.replicationBaseUrl = pbf.readString();
  }, header);
  return header;
}

/** Decode a packed sint64 delta stream into `out` starting at `offset`. */
function readDeltaPacked(pbf, out, offset) {
  const end = pbf.readVarint() + pbf.pos;
  let value = 0;
  let index = offset;
  while (pbf.pos < end) {
    value += pbf.readSVarint();
    out[index++] = value;
  }
  return index - offset;
}

function countPacked(pbf) {
  // Count varints in a packed field without decoding them.
  const end = pbf.readVarint() + pbf.pos;
  let count = 0;
  for (let i = pbf.pos; i < end; i++) if (pbf.buf[i] < 0x80) count++;
  pbf.pos = end;
  return count;
}

function decodeDense(pbf, block, onNodes) {
  // First pass over the message finds the field spans so each packed array is
  // decoded once into a typed array of the right length.
  const end = pbf.readVarint() + pbf.pos;
  const spans = {};
  while (pbf.pos < end) {
    const key = pbf.readVarint();
    const tag = key >> 3;
    const start = pbf.pos;
    if ((key & 7) !== 2) {
      pbf.skip(key & 7);
      continue;
    }
    if (tag === 1 || tag === 8 || tag === 9 || tag === 10)
      spans[tag] = { start, count: countPacked(pbf) };
    else pbf.skip(2);
  }
  const count = spans[1]?.count || 0;
  if (!count) return;
  if (spans[8]?.count !== count || spans[9]?.count !== count)
    throw new OsmPbfError('Dense node arrays have different lengths');
  const ids = new Float64Array(count);
  const lat = new Float64Array(count);
  const lon = new Float64Array(count);
  for (const [tag, out] of [
    [1, ids],
    [8, lat],
    [9, lon],
  ]) {
    pbf.pos = spans[tag].start;
    readDeltaPacked(pbf, out, 0);
  }
  for (let i = 0; i < count; i++) {
    lat[i] = (block.latOffset + block.granularity * lat[i]) * 1e-9;
    lon[i] = (block.lonOffset + block.granularity * lon[i]) * 1e-9;
  }
  pbf.pos = end;
  onNodes(ids, lat, lon);
}

function decodePlainNode(pbf, block, onNodes) {
  const node = { id: 0, lat: 0, lon: 0 };
  pbf.readMessage((tag, out, p) => {
    if (tag === 1) out.id = p.readSVarint();
    else if (tag === 8) out.lat = p.readSVarint();
    else if (tag === 9) out.lon = p.readSVarint();
  }, node);
  onNodes(
    Float64Array.of(node.id),
    Float64Array.of((block.latOffset + block.granularity * node.lat) * 1e-9),
    Float64Array.of((block.lonOffset + block.granularity * node.lon) * 1e-9),
  );
}

function decodeWay(pbf, strings, onWay) {
  const way = { id: 0, keys: [], vals: [], refs: null };
  pbf.readMessage((tag, out, p) => {
    if (tag === 1) out.id = p.readVarint();
    else if (tag === 2) p.readPackedVarint(out.keys);
    else if (tag === 3) p.readPackedVarint(out.vals);
    else if (tag === 8) {
      const start = p.pos;
      const count = countPacked(p);
      p.pos = start;
      out.refs = new Float64Array(count);
      readDeltaPacked(p, out.refs, 0);
    }
  }, way);
  if (way.keys.length !== way.vals.length)
    throw new OsmPbfError(`Way ${way.id} has mismatched tag arrays`);
  const tags = Object.create(null);
  for (let i = 0; i < way.keys.length; i++) {
    const key = strings[way.keys[i]];
    const value = strings[way.vals[i]];
    if (key === undefined || value === undefined)
      throw new OsmPbfError(`Way ${way.id} references a missing string`);
    tags[key] = value;
  }
  onWay({ id: way.id, tags, refs: way.refs || new Float64Array(0) });
}

const utf8 = new TextDecoder('utf-8');

function decodePrimitiveBlock(bytes, { onNodes, onWay, wantWays }) {
  const pbf = new PbfReader(bytes);
  const block = {
    strings: [],
    granularity: 100,
    latOffset: 0,
    lonOffset: 0,
    groups: [],
  };
  // Scalars may follow the groups on the wire, so groups are decoded last.
  while (pbf.pos < pbf.length) {
    const key = pbf.readVarint();
    const tag = key >> 3;
    if (tag === 1) {
      const end = pbf.readVarint() + pbf.pos;
      while (pbf.pos < end) {
        const k = pbf.readVarint();
        if (k >> 3 === 1) block.strings.push(utf8.decode(pbf.readBytes()));
        else pbf.skip(k & 7);
      }
    } else if (tag === 2) {
      const length = pbf.readVarint();
      block.groups.push([pbf.pos, pbf.pos + length]);
      pbf.pos += length;
    } else if (tag === 17) block.granularity = pbf.readVarint();
    else if (tag === 19) block.latOffset = pbf.readVarint(true);
    else if (tag === 20) block.lonOffset = pbf.readVarint(true);
    else pbf.skip(key & 7);
  }
  for (const [start, end] of block.groups) {
    pbf.pos = start;
    while (pbf.pos < end) {
      const key = pbf.readVarint();
      const tag = key >> 3;
      if (tag === 2 && onNodes) decodeDense(pbf, block, onNodes);
      else if (tag === 1 && onNodes) decodePlainNode(pbf, block, onNodes);
      else if (tag === 3 && wantWays) decodeWay(pbf, block.strings, onWay);
      else pbf.skip(key & 7);
    }
  }
}

/**
 * Read an OSM PBF file once, in order. Callbacks receive nodes as parallel
 * typed arrays (id, lat, lon in degrees) and ways as { id, tags, refs }.
 * @param {string} path
 * @param {object} handlers
 * @param {(header:object)=>void} [handlers.onHeader]
 * @param {(ids:Float64Array, lat:Float64Array, lon:Float64Array)=>void} [handlers.onNodes]
 * @param {(way:{id:number, tags:Record<string,string>, refs:Float64Array})=>void} [handlers.onWay]
 * @param {(progress:{bytes:number, total:number})=>void} [handlers.onProgress]
 */
export async function readOsmPbf(path, handlers = {}) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    let position = 0;
    let header = null;
    while (position < size) {
      const lengthBytes = await readExactly(handle, position, 4);
      if (!lengthBytes) throw new OsmPbfError('Truncated blob length');
      const headerLength = lengthBytes.readUInt32BE(0);
      if (headerLength > PBF_LIMITS.maxHeaderBytes)
        throw new OsmPbfError('BlobHeader exceeds the format limit');
      position += 4;
      const headerBytes = await readExactly(handle, position, headerLength);
      if (!headerBytes) throw new OsmPbfError('Truncated BlobHeader');
      position += headerLength;
      const blobHeader = readBlobHeader(headerBytes);
      if (
        blobHeader.datasize < 0 ||
        blobHeader.datasize > PBF_LIMITS.maxBlobBytes
      )
        throw new OsmPbfError('Blob size is missing or exceeds the limit');
      const blobBytes = await readExactly(
        handle,
        position,
        blobHeader.datasize,
      );
      if (!blobBytes) throw new OsmPbfError('Truncated blob');
      position += blobHeader.datasize;
      if (blobHeader.type === 'OSMHeader') {
        header = readHeaderBlock(readBlob(blobBytes));
        const unsupported = header.requiredFeatures.filter(
          (feature) => !SUPPORTED_REQUIRED.has(feature),
        );
        if (unsupported.length)
          throw new OsmPbfError(
            `Unsupported required PBF features: ${unsupported.join(', ')}`,
          );
        handlers.onHeader?.(header);
      } else if (blobHeader.type === 'OSMData') {
        if (!header) throw new OsmPbfError('OSMData before OSMHeader');
        decodePrimitiveBlock(readBlob(blobBytes), {
          onNodes: handlers.onNodes,
          onWay: handlers.onWay,
          wantWays: !!handlers.onWay,
        });
      }
      // Unknown blob types are skipped, as the format requires.
      handlers.onProgress?.({ bytes: position, total: size });
    }
    if (!header) throw new OsmPbfError('No OSMHeader block');
    return header;
  } finally {
    await handle.close();
  }
}
