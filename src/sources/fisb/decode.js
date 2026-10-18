// FIS-B (Flight Information Service – Broadcast) uplink decoding.
//
// A 978 MHz UAT ground station broadcasts 432-byte uplink messages: an 8-byte
// header (station position, flags) and 424 bytes of information frames. Type 0
// frames carry an APDU: weather text (product 413), NOTAM/AIRMET/SIGMET text
// and graphics (TWGO products 8–17), and gridded images such as NEXRAD
// (products 63/64). Type 14 frames list current reports (CRL).
//
// Written from the field layouts published in the GDL 90 Data Interface
// Specification (560-1058-00 Rev A, sections 4–5), checked against its worked
// examples and against fisb-decode's level-0 output on the same captures (see
// src/data/fixtures/fisb/README.md). Input comes from a radio, so every read
// is bounds-checked: a malformed frame throws a RangeError and never reads
// past its own bytes. Works in browsers and Node; no dependencies.

export const UPLINK_BYTES = 432;
const HEADER_BYTES = 8;
const BLOCK_BINS = 128;
const MAX_RAW_LINE = 2048;

export const FRAME_APDU = 0;
export const FRAME_CRL = 14;
export const FRAME_SERVICE_STATUS = 15;

/** TWGO (text with graphical overlay) product ids. */
export const TWGO_PRODUCTS = Object.freeze([8, 11, 12, 13, 14, 15, 16, 17]);
/** Global block (gridded image) product ids. */
export const BLOCK_PRODUCTS = Object.freeze([63, 64, 70, 71, 84, 90, 91, 103]);
export const TEXT_PRODUCT = 413;

/** Read `length` bits MSB-first starting `bit` bits after `offset`. */
function readBits(bytes, offset, end, bit, length) {
  let value = 0;
  for (let i = 0; i < length; i++) {
    const position = bit + i;
    const index = offset + (position >> 3);
    if (index >= end) throw new RangeError('read past end of field');
    value = value * 2 + ((bytes[index] >> (7 - (position & 7))) & 1);
  }
  return value;
}

function need(bytes, end, label) {
  if (end > bytes.length) throw new RangeError(`${label} overruns its frame`);
}

function hexBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const value = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isInteger(value)) return null;
    bytes[i] = value;
  }
  return bytes;
}

/**
 * Parse one line of dump978-fa raw output. Uplinks start with `+`; downlinks
 * (`-`), metadata (`!`) and anything malformed return null.
 * @param {string} line
 * @returns {{bytes:Uint8Array, rs:number|null, rssi:number|null, t:number|null}|null}
 */
export function parseRawLine(line) {
  if (typeof line !== 'string' || line.length > MAX_RAW_LINE) return null;
  const text = line.trim();
  if (text[0] !== '+') return null;
  const semi = text.indexOf(';');
  const hex = semi < 0 ? text.slice(1) : text.slice(1, semi);
  if (hex.length !== UPLINK_BYTES * 2 || !/^[0-9a-fA-F]+$/.test(hex))
    return null;
  const bytes = hexBytes(hex);
  if (!bytes) return null;
  const meta = {};
  if (semi >= 0)
    for (const pair of text.slice(semi + 1).split(';')) {
      const eq = pair.indexOf('=');
      if (eq > 0) meta[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  const number = (value) =>
    value === undefined || value === '' || !Number.isFinite(Number(value))
      ? null
      : Number(value);
  return {
    bytes,
    rs: number(meta.rs),
    rssi: number(meta.rssi),
    t: number(meta.t),
  };
}

/**
 * Decode the 8-byte uplink header.
 * @param {Uint8Array} uplink 432-byte uplink.
 */
export function decodeUplinkHeader(uplink) {
  need(uplink, HEADER_BYTES, 'uplink header');
  const read = (bit, length) => readBits(uplink, 0, HEADER_BYTES, bit, length);
  let lat = (read(0, 23) * 360) / 2 ** 24;
  if (lat > 90) lat -= 180;
  let lon = (read(23, 24) * 360) / 2 ** 24;
  if (lon > 180) lon -= 360;
  return {
    lat,
    lon,
    positionValid: read(47, 1) === 1,
    utcCoupled: read(48, 1) === 1,
    appDataValid: read(50, 1) === 1,
    slotId: read(51, 5),
    tisbSiteId: read(56, 4),
  };
}

/**
 * Split the application data of an uplink into information frames. A frame
 * whose length runs past the uplink ends the list with an `error` entry.
 * @param {Uint8Array} uplink
 * @returns {Array<{type:number, length:number, data:Uint8Array}|{error:string}>}
 */
export function infoFrames(uplink) {
  const frames = [];
  if (uplink.length !== UPLINK_BYTES) return [{ error: 'uplink-length' }];
  let offset = HEADER_BYTES;
  while (offset + 2 <= UPLINK_BYTES) {
    const length = (uplink[offset] << 1) | (uplink[offset + 1] >> 7);
    const type = uplink[offset + 1] & 0x0f;
    if (length === 0) break;
    if (offset + 2 + length > UPLINK_BYTES) {
      frames.push({ error: 'frame-overrun', type, length });
      break;
    }
    frames.push({
      type,
      length,
      data: uplink.subarray(offset + 2, offset + 2 + length),
    });
    offset += 2 + length;
  }
  return frames;
}

/**
 * Decode an APDU header. `payloadOffset` is where the product data starts.
 * @param {Uint8Array} data Type 0 frame data.
 */
export function decodeApduHeader(data) {
  const read = (bit, length) => readBits(data, 0, data.length, bit, length);
  const header = {
    a: read(0, 1),
    g: read(1, 1),
    p: read(2, 1),
    productId: read(3, 11),
    s: read(14, 1),
    tOpt: read(15, 2),
  };
  let bit = 17;
  if (header.tOpt & 2) {
    header.month = read(bit, 4);
    header.day = read(bit + 4, 5);
    bit += 9;
  }
  header.hour = read(bit, 5);
  header.minute = read(bit + 5, 6);
  bit += 11;
  if (header.tOpt & 1) {
    header.second = read(bit, 6);
    bit += 6;
  }
  if (header.s) {
    header.productFileId = read(bit, 10);
    header.productFileLength = read(bit + 10, 9);
    header.apduNumber = read(bit + 19, 9);
    bit += 28;
  }
  header.payloadOffset = Math.ceil(bit / 8);
  if (header.payloadOffset > data.length)
    throw new RangeError('APDU header overruns its frame');
  return header;
}

// DLAC: 6-bit characters, four per three bytes. Code 0 is end of text, 27 is
// "no character", 28 is a tab whose next character is a count of spaces, 29
// a record separator, 30 a line feed.
const DLAC_ALPHABET =
  '\x03ABCDEFGHIJKLMNOPQRSTUVWXYZ\x00\t\x1e\n| !"#$%&\'()*+,-./0123456789:;<=>?';

/**
 * Decode DLAC text, dropping end-of-text, no-character and record separators.
 * @param {Uint8Array} data
 * @param {number} [start]
 * @param {number} [byteLength]
 */
export function dlacText(data, start = 0, byteLength = data.length - start) {
  need(data, start + byteLength, 'DLAC text');
  const codes = [];
  for (let i = 0; i < byteLength; i++) {
    const current = data[start + i];
    const previous = i ? data[start + i - 1] : 0;
    const phase = i % 3;
    if (phase === 0) codes.push(current >> 2);
    else if (phase === 1) codes.push(((previous & 0x03) << 4) | (current >> 4));
    else codes.push(((previous & 0x0f) << 2) | (current >> 6), current & 0x3f);
  }
  let text = '';
  let tab = false;
  for (const code of codes) {
    if (tab) {
      text += ' '.repeat(code);
      tab = false;
    } else if (code === 28) tab = true;
    else if (code !== 0 && code !== 27 && code !== 29)
      text += DLAC_ALPHABET[code];
  }
  return text;
}

function latOf(raw, bits) {
  const value = (raw * 360) / 2 ** bits;
  const latitude = value > 90 ? value - 180 : value;
  if (latitude < -90 || latitude > 90)
    throw new RangeError('overlay latitude out of range');
  return latitude;
}

function lonOf(raw, bits) {
  const value = (raw * 360) / 2 ** bits;
  return value > 180 ? value - 360 : value;
}

/** Overlay geometry option → shape and altitude reference. */
export const OVERLAY_GEOMETRY = Object.freeze({
  3: { shape: 'polygon', altitude: 'MSL' },
  4: { shape: 'polygon', altitude: 'AGL' },
  7: { shape: 'circle', altitude: 'MSL' },
  8: { shape: 'circle', altitude: 'AGL' },
  9: { shape: 'point', altitude: 'AGL' },
  10: { shape: 'point', altitude: 'MSL' },
  11: { shape: 'polyline', altitude: 'MSL' },
  12: { shape: 'polyline', altitude: 'AGL' },
});

const TIME_FIELDS = Object.freeze({
  1: ['month', 'day', 'hour', 'minute'],
  2: ['day', 'hour', 'minute'],
  3: ['hour', 'minute'],
});

function readTime(data, offset, format) {
  const fields = TIME_FIELDS[format];
  if (!fields) return null;
  need(data, offset + fields.length, 'overlay time');
  const time = {};
  fields.forEach((name, i) => (time[name] = data[offset + i]));
  return time;
}

function decodeTextRecord(data, offset) {
  need(data, offset + 5, 'text record header');
  const length = (data[offset] << 8) | data[offset + 1];
  if (length < 5) throw new RangeError('text record too short');
  need(data, offset + length, 'text record');
  return {
    length,
    record: {
      reportNumber: (data[offset + 2] << 6) | (data[offset + 3] >> 2),
      reportYear: ((data[offset + 3] & 3) << 5) | (data[offset + 4] >> 3),
      active: ((data[offset + 4] >> 2) & 1) === 1,
      text: dlacText(data, offset + 5, length - 5),
    },
  };
}

function decodeOverlayRecord(productId, data, start) {
  need(data, start + 5, 'overlay record header');
  const length = (data[start] << 2) | (data[start + 1] >> 6);
  if (length < 5) throw new RangeError('overlay record too short');
  const end = start + length;
  need(data, end, 'overlay record');
  const record = {
    reportNumber: ((data[start + 1] & 0x3f) << 8) | data[start + 2],
    reportYear: data[start + 3] >> 1,
    overlayRecordId: ((data[start + 4] & 0x1e) >> 1) + 1,
    label: null,
  };
  const labelled = (data[start + 4] & 1) === 1;
  let at = start + 5;
  if (labelled) {
    record.label = dlacText(data, at, 9).trim();
    at += 9;
  } else at += 2;
  need(data, at + 2, 'overlay object fields');
  const flags = data[at];
  const qualified = ((flags >> 6) & 1) === 1;
  const parameters = ((flags >> 5) & 1) === 1;
  record.objectElement = flags & 0x1f;
  record.objectType = data[at + 1] >> 4;
  record.objectStatus = data[at + 1] & 0x0f;
  at += 2;
  if (productId === 14 && qualified) at += 3;
  if (parameters) at += 2;
  need(data, at + 2, 'overlay geometry fields');
  const applicability = data[at] >> 6;
  const timeFormat = (data[at] >> 4) & 3;
  record.geometryOption = data[at] & 0x0f;
  at += 1;
  record.operator = data[at] >> 6;
  const vertexCount = record.geometryOption ? (data[at] & 0x3f) + 1 : 0;
  at += 1;
  const timeLength = (TIME_FIELDS[timeFormat] || []).length;
  record.start = applicability & 1 ? readTime(data, at, timeFormat) : null;
  if (applicability & 1) at += timeLength;
  record.stop = applicability & 2 ? readTime(data, at, timeFormat) : null;
  if (applicability & 2) at += timeLength;
  const geometry = OVERLAY_GEOMETRY[record.geometryOption];
  record.shape = geometry?.shape ?? null;
  record.altitudeReference = geometry?.altitude ?? null;
  record.vertices = [];
  for (let v = 0; v < vertexCount; v++) {
    if (!geometry) throw new RangeError('unknown overlay geometry');
    if (geometry.shape === 'circle') {
      need(data, at + 14, 'circle vertex');
      const read = (bit, n) => readBits(data, at, end, bit, n);
      record.vertices.push({
        lon: lonOf(read(0, 18), 18),
        lat: latOf(read(18, 18), 18),
        lonTop: lonOf(read(36, 18), 18),
        latTop: latOf(read(54, 18), 18),
        altBottomFt: read(72, 7) * 500,
        altTopFt: read(79, 7) * 500,
        radiusBottomNm: read(86, 9) * 0.2,
        radiusTopNm: read(95, 9) * 0.2,
        angle: read(104, 8),
      });
      at += 14;
    } else {
      need(data, at + 6, 'vertex');
      const read = (bit, n) => readBits(data, at, end, bit, n);
      record.vertices.push({
        lon: lonOf(read(0, 19), 19),
        lat: latOf(read(19, 19), 19),
        altFt: read(38, 10) * 100,
      });
      at += 6;
    }
  }
  if (at > end) throw new RangeError('overlay vertices overrun the record');
  return { length, record };
}

/**
 * Decode a TWGO payload (text records, format 2, or graphical overlay
 * records, format 8). Other record formats return no records.
 * @param {number} productId
 * @param {Uint8Array} payload
 */
export function decodeTwgo(productId, payload) {
  need(payload, 6, 'TWGO header');
  const result = {
    recordFormat: payload[0] >> 4,
    productVersion: payload[0] & 0x0f,
    recordCount: payload[1] >> 4,
    location: dlacText(payload, 2, 3).trim(),
    recordReferencePoint: payload[5],
    records: [],
  };
  let offset = 6;
  for (let n = 0; n < result.recordCount; n++) {
    let decoded;
    if (result.recordFormat === 2) decoded = decodeTextRecord(payload, offset);
    else if (result.recordFormat === 8)
      decoded = decodeOverlayRecord(productId, payload, offset);
    else break;
    result.records.push(decoded.record);
    offset += decoded.length;
  }
  return result;
}

/**
 * Decode a current report list (CRL) frame.
 * @param {Uint8Array} data Type 14 frame data.
 */
export function decodeCrl(data) {
  need(data, 4, 'CRL header');
  const result = {
    productId: (data[0] << 3) | (data[1] >> 5),
    tfr: ((data[1] >> 4) & 1) === 1,
    overflow: ((data[1] >> 1) & 1) === 1,
    location: null,
    rangeNm: data[2] * 5,
  };
  let offset;
  if (data[1] & 1) {
    need(data, 7, 'CRL location');
    result.location = dlacText(data, 3, 3).trim();
    result.count = data[6];
    offset = 7;
  } else {
    result.count = data[3];
    offset = 4;
  }
  need(data, offset + 3 * result.count, 'CRL reports');
  result.reports = [];
  for (let i = 0; i < result.count; i++, offset += 3)
    result.reports.push({
      reportYear: data[offset] & 0x7f,
      text: data[offset + 1] >> 7 === 1,
      graphics: ((data[offset + 1] >> 6) & 1) === 1,
      reportNumber: ((data[offset + 1] & 0x3f) << 8) | data[offset + 2],
    });
  return result;
}

const RADAR_PRODUCTS = new Set([63, 64, 84, 103]);

/**
 * Decode one global block APDU payload. Run-length blocks return 128 `bins`
 * (4 rows of 32, north row first, west to east); empty-element blocks return
 * the block numbers they mark empty in `emptyBlocks`.
 * @param {number} productId
 * @param {Uint8Array} payload
 */
export function decodeGlobalBlock(productId, payload) {
  need(payload, 3, 'block reference');
  const elementId = payload[0] >> 7;
  const field = (payload[0] >> 4) & 7;
  const blockNumber =
    ((payload[0] & 0x0f) << 16) | (payload[1] << 8) | payload[2];
  const block = { productId, elementId, blockNumber };
  if (RADAR_PRODUCTS.has(productId)) {
    block.scale = field & 3;
    block.south = field >> 2 === 1;
  } else {
    block.scale = 0;
    block.south = false;
    block.altitudeIndex = field;
  }
  blockBounds(blockNumber, block.scale, block.south);
  if (elementId === 0) {
    need(payload, 4, 'empty block bitmap');
    const length = payload[3] & 0x0f;
    need(payload, 4 + length, 'empty block bitmap');
    const step = blockStep(block.scale, blockNumber);
    const flags = [1];
    for (let k = 4; k < 8; k++) flags.push((payload[3] >> k) & 1);
    for (let i = 0; i < length; i++)
      for (let k = 0; k < 8; k++) flags.push((payload[4 + i] >> k) & 1);
    block.emptyBlocks = [];
    flags.forEach((flag, i) => {
      if (flag) {
        const number = blockNumber + i * step;
        blockBounds(number, block.scale, block.south);
        block.emptyBlocks.push(number);
      }
    });
    block.consumed = 4 + length;
    return block;
  }
  const bins = new Uint8Array(BLOCK_BINS);
  let filled = 0;
  let at = 3;
  const fill = (value, count) => {
    if (filled + count > BLOCK_BINS) throw new RangeError('too many bins');
    bins.fill(value, filled, filled + count);
    filled += count;
  };
  while (filled < BLOCK_BINS) {
    need(payload, at + 1, 'run-length data');
    const value = payload[at];
    if (productId === 63 || productId === 64) {
      fill(value & 7, (value >> 3) + 1);
      at += 1;
    } else if (productId === 84 || productId === 90 || productId === 91) {
      if (value >> 4 === 0x0e) {
        need(payload, at + 2, 'run-length data');
        fill(value & 0x0f, payload[at + 1] + 1);
        at += 2;
      } else {
        fill(value & 0x0f, (value >> 4) + 1);
        at += 1;
      }
    } else if (productId === 70 || productId === 71) {
      need(payload, at + 2, 'run-length data');
      fill(payload[at + 1], value + 1);
      at += 2;
    } else {
      // Lightning (103) uses a different bin encoding; not decoded.
      block.bins = null;
      block.consumed = payload.length;
      return block;
    }
  }
  block.bins = bins;
  block.consumed = at;
  return block;
}

/** Block-number distance between neighbouring blocks at a scale. */
function blockStep(scale, blockNumber) {
  if (scale === 1) return 5;
  if (scale === 2) return 9;
  // Above 60° latitude only even high-resolution blocks are used.
  return blockNumber >= 405000 ? 2 : 1;
}

/**
 * Geographic bounds of a block. High resolution (scale 0) blocks span 4′ of
 * latitude and 48′ of longitude (96′ above 60°); medium (1) and low (2)
 * resolution blocks are 5× and 9× larger.
 * @param {number} blockNumber
 * @param {number} scale
 * @param {boolean} south
 */
export function blockBounds(blockNumber, scale = 0, south = false) {
  if (
    !Number.isInteger(blockNumber) ||
    blockNumber < 0 ||
    !Number.isInteger(scale) ||
    scale < 0 ||
    scale > 2
  )
    throw new RangeError('invalid block reference');
  const multiple = [1, 5, 9][scale];
  const wide = blockNumber >= 405000;
  const number = wide ? blockNumber & ~1 : blockNumber;
  const row = Math.floor(number / 450);
  let west = (number % 450) * 0.8;
  if (west >= 180) west -= 360;
  const height = (4 / 60) * multiple;
  const width = (wide ? 1.6 : 0.8) * multiple;
  const north = south ? -(row * 4) / 60 : ((row + 1) * 4) / 60;
  const bottom = north - height;
  if (north > 90 || bottom < -90)
    throw new RangeError('block latitude out of range');
  return { north, south: bottom, west, east: west + width };
}
