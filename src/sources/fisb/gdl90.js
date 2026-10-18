// GDL 90 framing (public ICD 560-1058-00 Rev A, section 2.2), used by
// Stratux-class receivers that broadcast UAT uplinks over UDP. A frame is
// 0x7E-delimited with 0x7D escapes (next byte XOR 0x20) and a CRC-CCITT
// (polynomial 0x1021, initial 0) frame check sequence sent LSB first.
// Message 7 carries one UAT uplink: 3 bytes of time of reception, then the
// 432-byte uplink.

import { UPLINK_BYTES } from './decode.js';

export const GDL90_UPLINK_ID = 7;
const FLAG = 0x7e;
const ESCAPE = 0x7d;
const MAX_FRAME = 1024;

const CRC_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let k = 0; k < 8; k++)
      crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
    table[i] = crc;
  }
  return table;
})();

/** @param {ArrayLike<number>} bytes */
export function gdl90Crc(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++)
    crc = (CRC_TABLE[crc >> 8] ^ (crc << 8) ^ bytes[i]) & 0xffff;
  return crc;
}

/**
 * Decode the bytes between two flags.
 * @param {ArrayLike<number>} frame
 * @returns {{id:number, data:Uint8Array}|null} null when malformed or the CRC fails.
 */
export function gdl90Unframe(frame) {
  if (frame.length > MAX_FRAME * 2) return null;
  const out = [];
  for (let i = 0; i < frame.length; i++) {
    if (frame[i] === ESCAPE) {
      i++;
      if (i >= frame.length) return null;
      out.push(frame[i] ^ 0x20);
    } else out.push(frame[i]);
  }
  if (out.length < 3) return null;
  const body = Uint8Array.from(out.slice(0, -2));
  const fcs = out[out.length - 2] | (out[out.length - 1] << 8);
  if (gdl90Crc(body) !== fcs) return null;
  return { id: body[0], data: body.subarray(1) };
}

/**
 * Build a flagged, escaped frame.
 * @param {number} id
 * @param {ArrayLike<number>} data
 */
export function gdl90Frame(id, data) {
  const body = [id, ...data];
  const crc = gdl90Crc(body);
  body.push(crc & 0xff, crc >> 8);
  const out = [FLAG];
  for (const byte of body) {
    if (byte === FLAG || byte === ESCAPE) out.push(ESCAPE, byte ^ 0x20);
    else out.push(byte);
  }
  out.push(FLAG);
  return Uint8Array.from(out);
}

/**
 * Extract the UAT uplinks from one datagram (or stream chunk) of GDL 90.
 * Other message types and frames that fail their CRC are skipped.
 * @param {Uint8Array} datagram
 * @returns {{uplinks:Uint8Array[], rejected:number}}
 */
export function gdl90Uplinks(datagram) {
  const uplinks = [];
  let rejected = 0;
  let start = -1;
  for (let i = 0; i < datagram.length; i++) {
    if (datagram[i] !== FLAG) continue;
    if (start >= 0 && i - start > 1) {
      const message = gdl90Unframe(datagram.subarray(start + 1, i));
      if (!message) rejected++;
      else if (message.id === GDL90_UPLINK_ID) {
        if (message.data.length === 3 + UPLINK_BYTES)
          uplinks.push(message.data.slice(3));
        else rejected++;
      }
    }
    start = i;
  }
  return { uplinks, rejected };
}
