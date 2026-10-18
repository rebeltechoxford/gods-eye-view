// Synthetic FIS-B uplinks for tests and browser gates: METAR/TAF text, a TFR
// (NOTAM text plus polygon), an AIRMET polygon and NEXRAD blocks, dated
// around a given time. The decoder is verified separately against reference
// captures; this encoder only lets a gate broadcast "current" weather.

const UPLINK_BYTES = 432;
const DLAC =
  '\x03ABCDEFGHIJKLMNOPQRSTUVWXYZ\x00\t\x1e\n| !"#$%&\'()*+,-./0123456789:;<=>?';

class BitWriter {
  constructor() {
    this.bits = [];
  }
  write(value, length) {
    for (let i = length - 1; i >= 0; i--)
      this.bits.push(Math.floor(value / 2 ** i) % 2);
  }
  bytes() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, i) => {
      if (bit) out[i >> 3] |= 0x80 >> (i & 7);
    });
    return out;
  }
}

/** DLAC-encode text (upper case, the DLAC character set only). */
export function dlacEncode(text) {
  const writer = new BitWriter();
  for (const char of text.toUpperCase()) {
    const code = DLAC.indexOf(char);
    writer.write(code < 0 ? DLAC.indexOf(' ') : code, 6);
  }
  return writer.bytes();
}

function apdu(productId, payload, at) {
  const date = new Date(at);
  const writer = new BitWriter();
  writer.write(0, 3); // A, G, P
  writer.write(productId, 11);
  writer.write(0, 1); // not segmented
  writer.write(0, 2); // hours and minutes only
  writer.write(date.getUTCHours(), 5);
  writer.write(date.getUTCMinutes(), 6);
  return Uint8Array.from([...writer.bytes(), ...payload]);
}

function twgoHeader(format, count = 1) {
  return [(format << 4) | 0, count << 4, 0, 0, 0, 255];
}

function textRecord(reportNumber, year, text) {
  const body = dlacEncode(text);
  const length = 5 + body.length;
  return [
    length >> 8,
    length & 0xff,
    reportNumber >> 6,
    ((reportNumber & 0x3f) << 2) | (year >> 5),
    ((year & 0x1f) << 3) | (1 << 2), // active
    ...body,
  ];
}

function timeBytes(ms) {
  const d = new Date(ms);
  return [
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
  ];
}

function polygonRecord(reportNumber, year, objectType, vertices, start, stop) {
  const geometry = [];
  for (const [lon, lat, altFt] of vertices) {
    const writer = new BitWriter();
    const raw = (deg, bits, wrap) =>
      Math.round((((deg % wrap) + wrap) % wrap) * (2 ** bits / 360));
    writer.write(raw(lon, 19, 360), 19);
    writer.write(raw(lat, 19, 180), 19);
    writer.write(Math.round(altFt / 100), 10);
    geometry.push(...writer.bytes());
  }
  const body = [
    0, // object label (unlabelled)
    0,
    0, // element/qualifier/parameter flags, object element
    (objectType << 4) | 15, // object type, status active
    (3 << 6) | (1 << 4) | 3, // start and stop, month/day/hour/minute, polygon MSL
    vertices.length - 1,
    ...timeBytes(start),
    ...timeBytes(stop),
    ...geometry,
  ];
  const length = 5 + body.length;
  return [
    length >> 2,
    ((length & 3) << 6) | (reportNumber >> 8),
    reportNumber & 0xff,
    year << 1,
    0, // overlay record 1, no label
    ...body,
  ];
}

function nexradBlock(blockNumber, runs) {
  const bytes = [
    0x80 | (blockNumber >> 16),
    (blockNumber >> 8) & 0xff,
    blockNumber & 0xff,
  ];
  for (const [value, count] of runs) {
    let left = count;
    while (left > 0) {
      const n = Math.min(32, left);
      bytes.push(((n - 1) << 3) | value);
      left -= n;
    }
  }
  return bytes;
}

/** High-resolution block number containing a point (northern hemisphere). */
export function blockNumberAt(lon, lat) {
  const row = Math.floor((lat * 60) / 4);
  const column = Math.floor((((lon % 360) + 360) % 360) / 0.8);
  return row * 450 + column;
}

function uplink(station, frames) {
  const bytes = new Uint8Array(UPLINK_BYTES);
  const header = new BitWriter();
  header.write(
    Math.round((((station.lat % 180) + 180) % 180) * (2 ** 24 / 360)),
    23,
  );
  header.write(
    Math.round((((station.lon % 360) + 360) % 360) * (2 ** 24 / 360)),
    24,
  );
  header.write(1, 1); // position valid
  header.write(1, 1); // UTC coupled
  header.write(0, 1);
  header.write(1, 1); // application data valid
  header.write(0, 5);
  header.write(0, 4);
  bytes.set(header.bytes(), 0);
  let offset = 8;
  for (const data of frames) {
    if (offset + 2 + data.length > UPLINK_BYTES)
      throw new RangeError('uplink full');
    bytes[offset] = data.length >> 1;
    bytes[offset + 1] = ((data.length & 1) << 7) | 0; // type 0 (APDU)
    bytes.set(data, offset + 2);
    offset += 2 + data.length;
  }
  return bytes;
}

const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * dump978-fa raw lines for a small, current FIS-B picture around Oxford, MS.
 * @param {number} at Epoch ms the products are valid around.
 */
export function syntheticFisbLines(at = Date.now()) {
  const station = { lat: 34.38, lon: -89.54 };
  const d = new Date(at);
  const ddhhmm = `${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const year = d.getUTCFullYear() % 100;
  const hour = 3_600_000;
  const metars = [
    `METAR KUOX ${ddhhmm}Z AUTO 18005KT 10SM CLR 22/12 A3001 RMK AO2`,
    `METAR KTUP ${ddhhmm}Z 20008KT 3SM BR OVC008 19/18 A2998 RMK AO2`,
    `METAR KMEM ${ddhhmm}Z 21010KT 10SM BKN025 24/15 A2999 RMK AO2`,
    `TAF KMEM ${ddhhmm}Z ${ddhhmm.slice(0, 4)}/${ddhhmm.slice(0, 2)}24 21010KT P6SM BKN025`,
  ];
  const tfrText = `NOTAM-TFR 6/4321 ${ddhhmm}Z PART 1 OF 1 FLIGHT RESTRICTIONS OXFORD, MS. VIP MOVEMENT.`;
  const tfr = [
    [-89.62, 34.33, 0],
    [-89.46, 34.33, 0],
    [-89.46, 34.43, 0],
    [-89.62, 34.43, 0],
  ].map(([lon, lat]) => [lon, lat, 3000]);
  const airmet = [
    [-90.4, 34.9, 0],
    [-88.6, 34.9, 0],
    [-88.6, 33.6, 0],
    [-90.4, 33.6, 0],
  ].map(([lon, lat]) => [lon, lat, 12000]);
  const block = blockNumberAt(-89.7, 34.6);
  const lines = [];
  const push = (frames) =>
    lines.push(`+${hex(uplink(station, frames))};rs=0;rssi=-20.0;`);
  push(metars.map((text) => apdu(413, dlacEncode(text), at)));
  push([
    apdu(8, [...twgoHeader(2), ...textRecord(4321, year, tfrText)], at),
    apdu(
      8,
      [
        ...twgoHeader(8),
        ...polygonRecord(4321, year, 0, tfr, at - hour, at + 5 * hour),
      ],
      at,
    ),
  ]);
  push([
    apdu(
      11,
      [
        ...twgoHeader(2),
        ...textRecord(
          777,
          year,
          `AIRMET KDFW ${ddhhmm} DFWS WA\nAIRMET SIERRA FOR IFR. CIG BLW 010/VIS BLW 3SM BR.`,
        ),
      ],
      at,
    ),
    apdu(
      11,
      [
        ...twgoHeader(8),
        ...polygonRecord(777, year, 14, airmet, at - hour, at + 4 * hour),
      ],
      at,
    ),
  ]);
  push(
    [0, 1, 2].map((k) =>
      apdu(
        63,
        nexradBlock(block + k, [
          [0, 8],
          [3, 16],
          [5, 8],
          [3, 32],
          [6, 16],
          [2, 48],
        ]),
        at,
      ),
    ),
  );
  return lines;
}
