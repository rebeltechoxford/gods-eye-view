import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FISB_LIMITS,
  FISB_RETENTION_MS,
  createFisbStore,
  resolveOverlayInterval,
  resolveOverlayTime,
} from './store.js';
import { decodeApduHeader, infoFrames, parseRawLine } from './decode.js';

const capture = readFileSync(
  new URL('../../data/fixtures/fisb/tg30-subset.978', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter(Boolean);
const T0 = Date.parse('2020-10-30T08:45:00Z');

function loaded() {
  let at = T0;
  const store = createFisbStore({ now: () => at });
  for (const line of capture) store.ingestRawLine(line, at);
  return { store, setNow: (value) => (at = value) };
}

test('a capture becomes weather text, reports with geometry and radar', () => {
  const { store } = loaded();
  const snapshot = store.snapshot(T0);
  assert.equal(snapshot.counts.decodeErrors, 0);
  assert.equal(snapshot.counts.uplinks, capture.length);
  const metar = snapshot.texts.find((t) => t.kind === 'METAR');
  assert.match(metar.text, /^(METAR|SPECI) [A-Z0-9]{4} \d{6}Z/);
  assert.ok(['VFR', 'MVFR', 'IFR', 'LIFR', null].includes(metar.category));
  for (const kind of ['TAF', 'WINDS', 'PIREP'])
    assert.ok(
      snapshot.texts.some((t) => t.kind === kind),
      kind,
    );

  const kinds = new Set(snapshot.reports.map((r) => r.kind));
  for (const kind of ['NOTAM', 'AIRMET', 'SIGMET', 'G-AIRMET', 'SUA status'])
    assert.ok(kinds.has(kind), kind);
  const polygon = snapshot.reports
    .flatMap((r) => r.overlays)
    .find((o) => o.shape === 'polygon');
  assert.ok(polygon.vertices.length >= 3);
  for (const [lon, lat, alt] of polygon.vertices) {
    assert.ok(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90);
    assert.ok(Number.isFinite(alt));
  }
  assert.ok(snapshot.radar[63].blocks > 0 || snapshot.radar[64].blocks > 0);
  // The snapshot is plain JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test('a segmented NOTAM is reassembled from its parts in any order', () => {
  const parts = capture.filter((line) => {
    const raw = parseRawLine(line);
    return infoFrames(raw.bytes).some(
      (f) => !f.error && f.type === 0 && decodeApduHeader(f.data).s === 1,
    );
  });
  assert.ok(parts.length >= 3);
  const forward = createFisbStore({ now: () => T0 });
  const backward = createFisbStore({ now: () => T0 });
  for (const line of parts) forward.ingestRawLine(line, T0);
  for (const line of [...parts].reverse()) backward.ingestRawLine(line, T0);
  const ids = (store) =>
    store
      .snapshot(T0)
      .reports.map((r) => `${r.id}:${r.overlays.length}:${r.text ?? ''}`)
      .sort();
  assert.ok(ids(forward).length > 0, 'segmented products were reassembled');
  assert.deepEqual(ids(forward), ids(backward));
  assert.equal(forward.snapshot(T0).counts.decodeErrors, 0);
});

test('a cancelled text report is removed', () => {
  // Find a single-record text TWGO frame and clear its active bit.
  for (const line of capture) {
    const raw = parseRawLine(line);
    for (const frame of infoFrames(raw.bytes)) {
      if (frame.error || frame.type !== 0) continue;
      const header = decodeApduHeader(frame.data);
      if (header.s || ![11, 12].includes(header.productId)) continue;
      const payload = frame.data.subarray(header.payloadOffset);
      if (payload[0] >> 4 !== 2 || payload[1] >> 4 !== 1) continue;
      const store = createFisbStore({ now: () => T0 });
      store.ingestUplink(raw.bytes, T0);
      const before = store.snapshot(T0).reports.length;
      assert.equal(before, 1);
      const cancelled = raw.bytes.slice();
      const statusByte =
        frame.data.byteOffset -
        raw.bytes.byteOffset +
        header.payloadOffset +
        6 +
        4;
      cancelled[statusByte] &= ~0x04;
      store.ingestUplink(cancelled, T0 + 1000);
      assert.equal(store.snapshot(T0 + 1000).reports.length, 0);
      return;
    }
  }
  assert.fail('no single text report in the capture');
});

test('items expire when not heard within their retention time', () => {
  const { store } = loaded();
  const metars = (at) =>
    store.snapshot(at).texts.filter((t) => t.kind === 'METAR').length;
  assert.ok(metars(T0) > 0);
  assert.ok(metars(T0 + FISB_RETENTION_MS.METAR - 1000) > 0);
  assert.equal(metars(T0 + FISB_RETENTION_MS.METAR + 1000), 0);
  const later = store.snapshot(T0 + FISB_RETENTION_MS.radar64 + 1000);
  assert.equal(later.radar[63].blocks, 0);
  assert.equal(later.radar[64].blocks, 0);
  assert.equal(later.reports.length, 0);
  // TAFs are kept longer than METARs.
  assert.ok(FISB_RETENTION_MS.TAF > FISB_RETENTION_MS.METAR);
});

test('radar blocks carry 128 intensity digits and only precipitation', () => {
  const { store } = loaded();
  for (const productId of [63, 64]) {
    const radar = store.radarBlocks(productId, T0);
    for (const [number, scale, south, bins] of radar.blocks) {
      assert.ok(Number.isInteger(number));
      assert.ok([0, 1, 2].includes(scale));
      assert.equal(south, 0);
      assert.match(bins, /^[0-7]{128}$/);
      // Background-only blocks (0 and 1) are not kept.
      assert.ok(Math.max(...bins) >= 2);
    }
  }
  assert.equal(store.radarBlocks(70, T0), null);
});

test('collections stay within their caps under a flood', () => {
  const store = createFisbStore({ now: () => T0 });
  // Feed the same capture many times under shifting station positions.
  for (let round = 0; round < 3; round++)
    for (const line of capture) store.ingestRawLine(line, T0 + round);
  const snapshot = store.snapshot(T0);
  assert.ok(snapshot.texts.length <= FISB_LIMITS.texts + FISB_LIMITS.pireps);
  assert.ok(snapshot.reports.length <= FISB_LIMITS.reports);
  for (const report of snapshot.reports)
    assert.ok(report.overlays.length <= FISB_LIMITS.overlaysPerReport);
});

test('non-uplink and garbage input is ignored without throwing', () => {
  const store = createFisbStore({ now: () => T0 });
  assert.equal(store.ingestRawLine('-00ff;'), null);
  assert.equal(store.ingestRawLine('garbage'), null);
  const noise = new Uint8Array(432).map((_, i) => (i * 97 + 13) & 0xff);
  noise[6] |= 0x20;
  assert.doesNotThrow(() => store.ingestUplink(noise, T0));
  assert.doesNotThrow(() => store.ingestUplink(new Uint8Array(10), T0));
});

test('overlay times resolve to the nearest year around now', () => {
  const now = Date.parse('2026-01-01T02:00:00Z');
  assert.equal(
    resolveOverlayTime({ month: 12, day: 31, hour: 23, minute: 0 }, now),
    Date.parse('2025-12-31T23:00:00Z'),
  );
  assert.equal(
    resolveOverlayTime({ hour: 5, minute: 30 }, now),
    Date.parse('2026-01-01T05:30:00Z'),
  );
  assert.equal(
    resolveOverlayTime({ month: 13, day: 1, hour: 0, minute: 0 }, now),
    null,
  );
  assert.equal(resolveOverlayTime(null, now), null);
});

test('partial overlay dates cross midnight and month boundaries without normalizing invalid dates', () => {
  const at = Date.parse('2026-10-31T23:30:00Z');
  assert.equal(
    resolveOverlayTime({ hour: 1, minute: 0 }, at),
    Date.parse('2026-11-01T01:00:00Z'),
  );
  assert.equal(
    resolveOverlayTime({ day: 1, hour: 1, minute: 0 }, at),
    Date.parse('2026-11-01T01:00:00Z'),
  );
  assert.equal(
    resolveOverlayTime(
      { day: 31, hour: 23, minute: 0 },
      Date.parse('2027-01-01T01:00:00Z'),
    ),
    Date.parse('2026-12-31T23:00:00Z'),
  );
  assert.equal(
    resolveOverlayTime({ month: 2, day: 30, hour: 1, minute: 0 }, at),
    null,
  );
  assert.equal(resolveOverlayTime({ hour: -1, minute: 0 }, at), null);
  assert.deepEqual(
    resolveOverlayInterval({ hour: 23, minute: 0 }, { hour: 1, minute: 0 }, at),
    {
      start: Date.parse('2026-10-31T23:00:00Z'),
      stop: Date.parse('2026-11-01T01:00:00Z'),
    },
  );
  assert.deepEqual(
    resolveOverlayInterval(
      { hour: 8, minute: 0 },
      { hour: 10, minute: 0 },
      Date.parse('2026-10-31T12:00:00Z'),
    ),
    {
      start: Date.parse('2026-10-31T08:00:00Z'),
      stop: Date.parse('2026-10-31T10:00:00Z'),
    },
    'an expired interval is not extended to tomorrow',
  );
  assert.throws(
    () => resolveOverlayInterval(null, { hour: 25, minute: 0 }, at),
    RangeError,
  );
});

test('a synthetic current picture decodes into a TFR, an AIRMET, METARs and radar', async () => {
  const { syntheticFisbLines } =
    await import('../../testSupport/fisbUplinks.mjs');
  const at = Date.parse('2026-10-18T12:00:00Z');
  const store = createFisbStore({ now: () => at });
  for (const line of syntheticFisbLines(at)) store.ingestRawLine(line, at);
  const snapshot = store.snapshot(at);
  assert.equal(snapshot.counts.decodeErrors, 0);
  assert.equal(snapshot.station.lat.toFixed(2), '34.38');
  const categories = Object.fromEntries(
    snapshot.texts
      .filter((t) => t.kind === 'METAR')
      .map((t) => [t.station, t.category]),
  );
  assert.deepEqual(categories, { KUOX: 'VFR', KTUP: 'IFR', KMEM: 'MVFR' });
  const tfr = snapshot.reports.find((r) => r.productId === 8);
  assert.match(tfr.text, /^NOTAM-TFR 6\/4321/);
  assert.equal(tfr.overlays.length, 1);
  assert.equal(tfr.overlays[0].shape, 'polygon');
  assert.ok(tfr.overlays[0].start < at && at < tfr.overlays[0].stop);
  const [lon, lat, alt] = tfr.overlays[0].vertices[0];
  assert.ok(Math.abs(lon - -89.62) < 1e-3 && Math.abs(lat - 34.33) < 1e-3);
  assert.equal(alt, 3000);
  const airmet = snapshot.reports.find((r) => r.productId === 11);
  assert.match(airmet.text, /AIRMET SIERRA/);
  assert.equal(airmet.overlays.length, 1);
  assert.equal(store.radarBlocks(63, at).blocks.length, 3);
});
