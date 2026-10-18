import { inflateSync } from 'node:zlib';
import { validateTileBytes } from '../../../src/maps/offline/schema.js';

const fail = () => {
  throw new Error('MBTiles raster tile is malformed or unsupported');
};
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

/** Validate bounded raster structures, not just a claimed MIME/IHDR/SOF.
 * PNG data is inflated to its exact 256px row budget. JPEG structure is checked;
 * actual browser decoding remains part of the end-to-end acceptance gate. */
export function validateImportedRaster(bytes, contentType) {
  validateTileBytes(bytes, contentType);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (contentType === 'image/png') {
    let offset = 8,
      chunks = 0,
      ihdr = null,
      palette = false,
      ended = false,
      dataEnded = false;
    const compressed = [];
    while (offset < bytes.length && chunks++ < 2048) {
      if (offset + 12 > bytes.length) fail();
      const size = view.getUint32(offset),
        end = offset + 12 + size;
      if (end > bytes.length) fail();
      const type = String.fromCharCode(
        ...bytes.subarray(offset + 4, offset + 8),
      );
      if (
        !/^[A-Za-z]{4}$/.test(type) ||
        crc(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)
      )
        fail();
      // Initial scope is static raster imagery. Reject animation and compressed
      // ancillary profiles/text rather than permit a second unbounded decode.
      if (['acTL', 'fcTL', 'fdAT', 'iCCP', 'zTXt', 'iTXt'].includes(type))
        fail();
      if (compressed.length && type !== 'IDAT') dataEnded = true;
      if (chunks === 1 && type !== 'IHDR') fail();
      if (type === 'IHDR') {
        if (ihdr || size !== 13) fail();
        ihdr = bytes.subarray(offset + 8, end - 4);
      } else if (type === 'PLTE') {
        if (palette || compressed.length || size < 3 || size > 768 || size % 3)
          fail();
        palette = true;
      } else if (type === 'IDAT') {
        if (dataEnded) fail();
        compressed.push(bytes.subarray(offset + 8, end - 4));
      } else if (type === 'IEND') {
        if (size || end !== bytes.length) fail();
        ended = true;
        offset = end;
        break;
      } else if (type[0] === type[0].toUpperCase()) fail();
      offset = end;
    }
    if (!ihdr || !ended || !compressed.length || offset !== bytes.length)
      fail();
    const depth = ihdr[8],
      color = ihdr[9],
      interlace = ihdr[12];
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
    const depths = {
      0: [1, 2, 4, 8, 16],
      2: [8, 16],
      3: [1, 2, 4, 8],
      4: [8, 16],
      6: [8, 16],
    }[color];
    if (
      !channels ||
      !depths.includes(depth) ||
      ihdr[10] ||
      ihdr[11] ||
      interlace > 1 ||
      (color === 3 && !palette)
    )
      fail();
    const passes = interlace
      ? [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ]
      : [[0, 0, 1, 1]];
    const rows = [];
    for (const [x, y, dx, dy] of passes) {
      const width = Math.ceil((256 - x) / dx),
        height = Math.ceil((256 - y) / dy);
      for (let row = 0; row < height; row++)
        rows.push(1 + Math.ceil((width * channels * depth) / 8));
    }
    const budget = rows.reduce((sum, size) => sum + size, 0),
      source = Buffer.concat(compressed);
    let decoded;
    try {
      const result = inflateSync(source, {
        maxOutputLength: budget,
        info: true,
      });
      if (result.engine.bytesWritten !== source.length) fail();
      decoded = result.buffer;
    } catch {
      fail();
    }
    if (decoded.length !== budget) fail();
    let rowStart = 0;
    for (const size of rows) {
      if (decoded[rowStart] > 4) fail();
      rowStart += size;
    }
  } else {
    let offset = 2,
      markers = 0,
      frame = false,
      scans = 0;
    while (offset < bytes.length && markers++ < 4096) {
      if (bytes[offset++] !== 255) fail();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9) {
        if (!frame || !scans || offset !== bytes.length) fail();
        return bytes;
      }
      if (marker === 1) continue;
      if (
        !marker ||
        marker === 0xd8 ||
        (marker >= 0xd0 && marker <= 0xd7) ||
        offset + 2 > bytes.length
      )
        fail();
      const length = view.getUint16(offset),
        end = offset + length;
      if (length < 2 || end > bytes.length) fail();
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (
          frame ||
          length < 11 ||
          bytes[offset + 2] !== 8 ||
          view.getUint16(offset + 3) !== 256 ||
          view.getUint16(offset + 5) !== 256 ||
          bytes[offset + 7] < 1 ||
          bytes[offset + 7] > 4 ||
          length !== 8 + 3 * bytes[offset + 7]
        )
          fail();
        frame = true;
      }
      if (marker === 0xda) {
        if (!frame || length < 8 || length !== 6 + 2 * bytes[offset + 2])
          fail();
        scans++;
        offset = end;
        let data = 0;
        while (offset < bytes.length) {
          if (bytes[offset] !== 255) {
            data++;
            offset++;
            continue;
          }
          const start = offset++;
          while (bytes[offset] === 255) offset++;
          const next = bytes[offset];
          if (next === 0 || (next >= 0xd0 && next <= 0xd7)) {
            offset++;
            data++;
            continue;
          }
          offset = start;
          break;
        }
        if (!data) fail();
      } else offset = end;
    }
    fail();
  }
  return bytes;
}
