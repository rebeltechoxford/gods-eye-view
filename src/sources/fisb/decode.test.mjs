// FIS-B decoding against the GDL 90 ICD worked examples and fisb-decode's
// level-0 output for the same captures (src/data/fixtures/fisb/README.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BLOCK_PRODUCTS,
  TWGO_PRODUCTS,
  UPLINK_BYTES,
  blockBounds,
  decodeApduHeader,
  decodeCrl,
  decodeGlobalBlock,
  decodeTwgo,
  decodeUplinkHeader,
  dlacText,
  infoFrames,
  parseRawLine,
} from './decode.js';
import { gdl90Crc, gdl90Frame, gdl90Unframe, gdl90Uplinks } from './gdl90.js';

const fixture = (name) =>
  readFileSync(
    new URL(`../../data/fixtures/fisb/${name}`, import.meta.url),
    'utf8',
  );

// GDL 90 ICD 560-1058-00 Rev A, 5.1.4: the two sample application data
// fields (424 bytes each) of a NEXRAD test pattern over northern Oregon.
const ICD_SAMPLE_FIELDS = fixture('icd-nexrad-sample.txt')
  .split('\n')
  .filter((line) => line.trim() && !line.startsWith('#'))
  .map((hex) =>
    Uint8Array.from(hex.trim().match(/../g), (byte) => parseInt(byte, 16)),
  );

function uplinkWithAppData(appData) {
  const uplink = new Uint8Array(UPLINK_BYTES);
  uplink[6] = 0x20; // application data valid
  uplink.set(appData, 8);
  return uplink;
}

const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

test('GDL 90 framing reproduces the ICD heartbeat example and escapes flag bytes', () => {
  // ICD 2.2.4: 7E 00 81 41 DB D0 08 02 B3 8B 7E
  const inner = Uint8Array.from([
    0x00, 0x81, 0x41, 0xdb, 0xd0, 0x08, 0x02, 0xb3, 0x8b,
  ]);
  const message = gdl90Unframe(inner);
  assert.equal(message.id, 0);
  assert.equal(
    hex(gdl90Frame(0, inner.subarray(1, 7))),
    '7e008141dbd00802b38b7e',
  );
  assert.equal(gdl90Crc(inner.subarray(0, 7)), 0x8bb3);

  const payload = new Uint8Array(3 + UPLINK_BYTES);
  payload[0] = 0x7e;
  payload[1] = 0x7d;
  payload[200] = 0x7e;
  payload.set(Uint8Array.of(0xab), 3);
  const datagram = Uint8Array.from([
    ...gdl90Frame(0, inner.subarray(1, 7)),
    ...gdl90Frame(7, payload),
  ]);
  const { uplinks, rejected } = gdl90Uplinks(datagram);
  assert.equal(rejected, 0);
  assert.equal(uplinks.length, 1);
  assert.equal(hex(uplinks[0]), hex(payload.subarray(3)));

  // One flipped bit fails the CRC and is counted, never returned.
  const corrupt = gdl90Frame(7, payload);
  corrupt[50] ^= 0x01;
  assert.deepEqual(gdl90Uplinks(corrupt), { uplinks: [], rejected: 1 });
});

test('the ICD NEXRAD sample decodes to its documented block, runs and extent', () => {
  let runLength = 0;
  let empty = 0;
  const emptyBlocks = new Set();
  for (const field of ICD_SAMPLE_FIELDS) {
    assert.equal(field.length, 424);
    for (const frame of infoFrames(uplinkWithAppData(field))) {
      const header = decodeApduHeader(frame.data);
      assert.equal(header.productId, 63);
      const payload = frame.data.subarray(header.payloadOffset);
      const block = decodeGlobalBlock(63, payload);
      assert.equal(block.consumed, payload.length);
      if (block.elementId === 0) {
        empty++;
        block.emptyBlocks.forEach((n) => emptyBlocks.add(n));
        continue;
      }
      runLength++;
      if (block.blockNumber !== 0x4a570) continue;
      // "123º 12' to 122º 24' West longitude, and from 45º 04' to 45º 08' North"
      const bounds = blockBounds(block.blockNumber, block.scale, block.south);
      assert.ok(Math.abs(bounds.south - (45 + 4 / 60)) < 1e-9);
      assert.ok(Math.abs(bounds.north - (45 + 8 / 60)) < 1e-9);
      assert.ok(Math.abs(bounds.west - -(123 + 12 / 60)) < 1e-9);
      assert.ok(Math.abs(bounds.east - -(122 + 24 / 60)) < 1e-9);
      // "the first 7 bins have Intensity value 0 … the next 18 bins … 1 …
      // the next 11 bins … 0", then Table 21's widest row.
      assert.deepEqual(
        [...block.bins.subarray(0, 36)],
        [...Array(7).fill(0), ...Array(18).fill(1), ...Array(11).fill(0)],
      );
      assert.equal(
        [...block.bins.subarray(96, 128)].map((v) => v || ' ').join(''),
        ' 11223333445555676555543333221  ',
      );
    }
  }
  // "a total of 19 APDUs; nine … run-length encoded blocks, and 10 … Empty"
  assert.equal(runLength, 9);
  assert.equal(empty, 10);
  // "from 124º 00' to 120º 00' West longitude, and from 44º 56' to 45º 32'"
  // North. The blocks reach 45º 36': 41 empty plus 9 run-length blocks fill
  // exactly 5 columns by 10 rows of 4', so 45º 32' is the top row's south edge.
  assert.equal(emptyBlocks.size, 41);
  const boxes = [...emptyBlocks].map((n) => blockBounds(n, 0, false));
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(Math.min(...boxes.map((b) => b.west)), -124));
  assert.ok(near(Math.max(...boxes.map((b) => b.east)), -120));
  assert.ok(near(Math.min(...boxes.map((b) => b.south)), 44 + 56 / 60));
  assert.ok(near(Math.max(...boxes.map((b) => b.north)), 45 + 36 / 60));
});

/**
 * Compare every frame of a raw capture with fisb-decode's level-0 output.
 * Only uplinks with APDU, CRL or service-status frames produce an oracle line.
 */
function compareWithOracle(rawName, oracleName) {
  const oracle = fixture(oracleName)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  let next = 0;
  let compared = 0;
  const products = new Set();
  for (const line of fixture(rawName).split('\n')) {
    const raw = parseRawLine(line);
    if (!raw) continue;
    const header = decodeUplinkHeader(raw.bytes);
    const frames = infoFrames(raw.bytes).filter(
      (frame) => !frame.error && [0, 14, 15].includes(frame.type),
    );
    if (!frames.length) continue;
    const expected = oracle[next++];
    assert.ok(expected, 'oracle has a line for every uplink with frames');
    const where = expected.rcvd_time;
    const round = (v) => Math.round(v * 1e6) / 1e6;
    assert.equal(
      `${round(header.lat)}~${round(header.lon)}`,
      expected.station,
      where,
    );
    assert.equal(header.appDataValid ? 1 : 0, expected.app_data_valid, where);
    assert.equal(header.positionValid ? 1 : 0, expected.position_valid, where);
    assert.equal(frames.length, expected.frames.length, where);
    frames.forEach((frame, k) => {
      const want = expected.frames[k];
      const at = `${where} frame ${k}`;
      assert.equal(frame.type, want.frame_type ?? 0, at);
      compared++;
      if (frame.type === 15) return;
      if (frame.type === 14) {
        const crl = decodeCrl(frame.data);
        assert.equal(crl.productId, want.product_id, at);
        assert.equal(crl.rangeNm, want.product_range_nm, at);
        assert.equal(crl.overflow, want.o_flag === 1, at);
        assert.equal(crl.count, want.number_of_reports, at);
        crl.reports.forEach((report, i) => {
          const w = want.reports[i];
          assert.equal(report.reportNumber, w.report_number, at);
          assert.equal(report.reportYear, w.report_year_or_month, at);
          assert.equal(report.text, w.text_flag === 1, at);
          assert.equal(report.graphics, w.graphics_flag === 1, at);
        });
        return;
      }
      const apdu = decodeApduHeader(frame.data);
      products.add(apdu.productId);
      assert.equal(apdu.productId, want.product_id, at);
      assert.equal(apdu.tOpt, want.t_opt, at);
      assert.equal(apdu.hour, want.hour, at);
      assert.equal(apdu.minute, want.minute, at);
      if (apdu.tOpt === 2) {
        assert.equal(apdu.month, want.month, at);
        assert.equal(apdu.day, want.day, at);
      }
      assert.equal(apdu.s, want.s_flag, at);
      const payload = frame.data.subarray(apdu.payloadOffset);
      if (apdu.s) {
        assert.equal(apdu.productFileId, want.product_file_id, at);
        assert.equal(apdu.productFileLength, want.product_file_length, at);
        assert.equal(apdu.apduNumber, want.apdu_number, at);
        assert.equal(hex(payload), want.contents, at);
        return;
      }
      if (apdu.productId === 413) {
        assert.equal(dlacText(payload), want.contents, at);
        return;
      }
      if (BLOCK_PRODUCTS.includes(apdu.productId)) {
        const block = decodeGlobalBlock(apdu.productId, payload);
        const c = want.contents;
        assert.equal(block.blockNumber, c.block_number, at);
        assert.equal(block.elementId, c.element_id, at);
        if ([63, 64, 84, 103].includes(apdu.productId)) {
          assert.equal(block.scale, c.scale_factor, at);
          assert.equal(block.south ? 1 : 0, c.hemisphere, at);
        } else {
          const base = [70, 90].includes(apdu.productId) ? 2000 : 18000;
          assert.equal(block.altitudeIndex * 2000 + base, c.altitude_level, at);
        }
        if (block.elementId === 0) {
          const step = block.scale === 1 ? 5 : 1;
          const marked = [...('1' + c.empty_blocks)]
            .map((bit, i) => (bit === '1' ? c.block_number + i * step : null))
            .filter((n) => n !== null);
          assert.deepEqual(block.emptyBlocks, marked, at);
        } else if (block.bins) {
          assert.equal(String.fromCharCode(...block.bins), c.bins, at);
        }
        return;
      }
      assert.ok(TWGO_PRODUCTS.includes(apdu.productId), at);
      const twgo = decodeTwgo(apdu.productId, payload);
      const c = want.contents;
      assert.equal(twgo.recordFormat, c.record_format, at);
      assert.equal(twgo.recordCount, c.record_count, at);
      assert.equal(twgo.location, c.location, at);
      assert.equal(twgo.recordReferencePoint, c.record_reference_point, at);
      twgo.records.forEach((record, i) => {
        const w = c.records[i];
        assert.equal(record.reportNumber, w.report_number, at);
        assert.equal(record.reportYear, w.report_year, at);
        if (twgo.recordFormat === 2) {
          assert.equal(record.active, w.report_status === 1, at);
          assert.equal(record.text, w.text, at);
          return;
        }
        assert.equal(record.geometryOption, w.overlay_geometry_options, at);
        assert.equal(record.objectType, w.object_type, at);
        assert.equal(record.objectStatus, w.object_status, at);
        assert.equal(record.label ?? '', w.object_label, at);
        for (const edge of ['start', 'stop']) {
          if (!record[edge]) continue;
          for (const [name, value] of Object.entries(record[edge]))
            assert.equal(value, w[`${edge}_${name}`], `${at} ${edge} ${name}`);
        }
        assert.equal(record.vertices.length, w.vertex_list?.length ?? 0, at);
        record.vertices.forEach((vertex, j) => {
          const v = w.vertex_list[j];
          const close = (a, b) =>
            assert.ok(Math.abs(a - b) < 1e-5, `${at} vertex ${j}`);
          if (record.shape === 'circle') {
            [
              vertex.lon,
              vertex.lat,
              vertex.lonTop,
              vertex.latTop,
              vertex.altBottomFt,
              vertex.altTopFt,
              vertex.radiusBottomNm,
              vertex.radiusTopNm,
              vertex.angle,
            ].forEach((value, q) => close(value, v[q]));
          } else {
            close(vertex.lon, v[0]);
            close(vertex.lat, v[1]);
            close(vertex.altFt, v[2]);
          }
        });
      });
    });
  }
  assert.equal(next, oracle.length, 'every oracle line was matched');
  return { compared, products };
}

test('a test-group capture matches fisb-decode frame for frame, every product', () => {
  const { compared, products } = compareWithOracle(
    'tg30-subset.978',
    'tg30-subset.level0.jsonl',
  );
  assert.ok(compared > 300, `compared ${compared} frames`);
  for (const id of [8, 11, 12, 13, 14, 63, 64, 70, 71, 84, 90, 91, 103, 413])
    assert.ok(products.has(id), `product ${id} covered`);
});

test('two more test-group captures match fisb-decode', () => {
  assert.ok(compareWithOracle('tg28.978', 'tg28.level0.jsonl').compared > 0);
  assert.ok(compareWithOracle('tg29.978', 'tg29.level0.jsonl').compared > 0);
});

test('raw lines: only well-formed uplinks are accepted', () => {
  const good = `+${'00'.repeat(UPLINK_BYTES)};rs=3;rssi=-12.5;t=1700000000.25;`;
  assert.deepEqual(
    { ...parseRawLine(good), bytes: undefined },
    { bytes: undefined, rs: 3, rssi: -12.5, t: 1700000000.25 },
  );
  assert.equal(parseRawLine(`-${'00'.repeat(18)};`), null, 'downlink');
  assert.equal(
    parseRawLine(`+${'00'.repeat(UPLINK_BYTES - 1)};`),
    null,
    'short',
  );
  assert.equal(parseRawLine(`+${'zz'.repeat(UPLINK_BYTES)};`), null, 'not hex');
  assert.equal(
    parseRawLine(`+${'00'.repeat(UPLINK_BYTES)};${'x'.repeat(4096)}`),
    null,
  );
  assert.equal(parseRawLine(null), null);
});

test('invalid block coordinates and reserved scales are rejected before rendering', () => {
  const block = (number, scale = 0) => Uint8Array.of(
    0x80 | (scale << 4) | (number >> 16), (number >> 8) & 255, number & 255,
    0xfa, 0xfa, 0xfa, 0xfa,
  );
  assert.throws(() => decodeGlobalBlock(63, block(0xfffff)), /latitude/);
  assert.throws(() => decodeGlobalBlock(63, block(0x4a570, 3)), /reference/);
  assert.throws(() => blockBounds(-1), /reference/);
  assert.throws(() => blockBounds(Number.NaN), /reference/);
  assert.throws(() => blockBounds(0x4a570, 3), /reference/);
  const valid = decodeGlobalBlock(63, block(0x4a570));
  assert.equal(valid.bins.length, 128);
  assert.ok(blockBounds(valid.blockNumber).north < 90);
});

test('out-of-range overlay latitude is rejected rather than wrapped onto the globe', () => {
  // One format-8 point with no validity times. Latitude occupies vertex bits
  // 19..37; all ones decode to nearly +180, outside the latitude domain.
  const vertex = new Uint8Array(6);
  for (let bit = 19; bit < 38; bit++) vertex[bit >> 3] |= 0x80 >> (bit & 7);
  const payload = Uint8Array.from([
    0x80, 0x10, 0, 0, 0, 255,
    4, 0x40, 1, 52, 0, 0, 0, 0, 15, 10, 0,
    ...vertex,
  ]);
  assert.throws(() => decodeTwgo(8, payload), /latitude/);
  payload.fill(0, payload.length - 6);
  assert.equal(decodeTwgo(8, payload).records[0].vertices[0].lat, 0);
});

test('malformed frames throw RangeError and never read past their bytes', () => {
  // Deterministic fuzz: mutate real frames and truncate them.
  let state = 12345;
  const random = () => (state = (state * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const lines = fixture('tg30-subset.978').split('\n');
  let thrown = 0;
  for (const line of lines) {
    const raw = parseRawLine(line);
    if (!raw) continue;
    for (let round = 0; round < 8; round++) {
      const bytes = raw.bytes.slice();
      for (let k = 0; k < 6; k++)
        bytes[8 + Math.floor(random() * 424)] = Math.floor(random() * 256);
      for (const frame of infoFrames(bytes)) {
        if (frame.error || frame.type !== 0) continue;
        const cut = frame.data.slice(
          0,
          Math.floor(random() * frame.data.length),
        );
        for (const data of [frame.data, cut]) {
          try {
            const header = decodeApduHeader(data);
            const payload = data.subarray(header.payloadOffset);
            if (TWGO_PRODUCTS.includes(header.productId))
              decodeTwgo(header.productId, payload);
            else if (BLOCK_PRODUCTS.includes(header.productId))
              decodeGlobalBlock(header.productId, payload);
            else dlacText(payload);
          } catch (error) {
            assert.ok(error instanceof RangeError, error.stack);
            thrown++;
          }
        }
      }
    }
  }
  assert.ok(thrown > 50, `exercised ${thrown} rejections`);
});
