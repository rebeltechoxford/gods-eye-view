import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  altitudeText,
  cardLines,
  currentOverlays,
  fisbStatusText,
  reportCard,
  reportCategory,
  stationCard,
  stationsFromTexts,
} from './presentation.js';
import { composeRadar } from './radar.js';
import { createFisbSource } from './source.js';
import { blockBounds } from '../../sources/fisb/decode.js';

const NOW = Date.parse('2026-10-18T12:00:00Z');

test('weather text groups by station with its flight category', () => {
  const stations = stationsFromTexts([
    {
      kind: 'METAR',
      station: 'KUOX',
      category: 'MVFR',
      text: 'METAR KUOX …',
      position: [-89.54, 34.38],
      receivedAt: NOW - 120_000,
    },
    {
      kind: 'TAF',
      station: 'KUOX',
      text: 'TAF KUOX …',
      position: [-89.54, 34.38],
      receivedAt: NOW,
    },
    {
      kind: 'PIREP',
      station: 'MEM',
      text: 'PIREP …',
      position: [-89.98, 35.04],
      receivedAt: NOW,
    },
    { kind: 'METAR', station: 'KZZZ', text: 'no position', position: null },
  ]);
  assert.equal(stations.length, 2);
  const uox = stations.find((s) => s.station === 'KUOX');
  assert.equal(uox.category, 'MVFR');
  assert.equal(uox.texts.length, 2);
  const card = stationCard(uox, NOW);
  assert.equal(card.title, 'KUOX · MVFR');
  assert.equal(card.details[0], 'FIS-B · heard just now');
  assert.ok(
    card.details.indexOf('METAR KUOX …') < card.details.indexOf('TAF KUOX …'),
  );
});

test('reports: TFRs are told apart, cards carry altitude, validity and text', () => {
  const tfr = {
    productId: 8,
    kind: 'NOTAM',
    station: 'KJXN',
    text: 'NOTAM-TFR 0/1234 181200Z PART 1 OF 1 SECURITY',
    receivedAt: NOW - 5 * 60_000,
  };
  assert.equal(reportCategory(tfr), 'TFR');
  assert.equal(
    reportCategory({ ...tfr, text: 'NOTAM-D KEYE.10/028 …' }),
    'NOTAM',
  );
  const circle = {
    shape: 'circle',
    altitudeReference: 'MSL',
    start: Date.parse('2026-10-18T11:00:00Z'),
    stop: Date.parse('2026-10-18T20:00:00Z'),
    vertices: [
      { lon: -84.4, lat: 42.2, radiusNm: 3, altBottomFt: 0, altTopFt: 3000 },
    ],
  };
  const card = reportCard(tfr, circle, NOW);
  assert.equal(card.title, 'TFR · KJXN');
  assert.deepEqual(card.details.slice(0, 3), [
    'FIS-B NOTAM · heard 5 min ago',
    '0–3,000 ft MSL',
    'valid 10-18 11:00Z – 10-18 20:00Z',
  ]);
  assert.equal(
    altitudeText({
      altitudeReference: 'AGL',
      vertices: [
        [0, 0, 0],
        [1, 1, 1200],
      ],
    }),
    'up to 1,200 ft AGL',
  );
  assert.equal(
    reportCard({ kind: 'AIRMET', receivedAt: NOW }, null, NOW).details.at(-1),
    'No text received yet',
  );
});

test('only overlays valid now are drawn', () => {
  const report = {
    overlays: [
      { id: 1, start: NOW - 1000, stop: NOW + 1000 },
      { id: 2, start: NOW + 3 * 3600_000, stop: NOW + 6 * 3600_000 },
      { id: 3, start: null, stop: null },
      { id: 4, start: NOW - 7200_000, stop: NOW - 1 },
    ],
  };
  assert.deepEqual(
    currentOverlays(report, NOW).map((o) => o.id),
    [1, 3],
  );
});

test('long text wraps into bounded card lines', () => {
  const lines = cardLines(`${'WORD '.repeat(60)}\nSECOND`, 4);
  assert.ok(lines.every((line) => line.length <= 64));
  assert.equal(lines.length, 4);
  assert.equal(lines.at(-1), '…');
});

test('the status line reports receiver, METARs, reports and radar', () => {
  assert.equal(fisbStatusText(null), 'Waiting for the host');
  assert.match(
    fisbStatusText({ feeds: [{ status: 'quiet' }] }),
    /no FIS-B heard/,
  );
  assert.equal(
    fisbStatusText(
      {
        feeds: [{ status: 'live' }],
        stations: [{}],
        texts: [{ kind: 'METAR' }, { kind: 'TAF' }],
        reports: [{}, {}],
      },
      { 63: { blocks: [[1, 0, 0, '2'.repeat(128)]] } },
    ),
    '1 ground station · 1 METARs · 2 NOTAM/AIRMET/SIGMET · NEXRAD',
  );
});

test('radar blocks compose into one image over their bounds, regional over CONUS', () => {
  // The ICD example block over Oregon, all at intensity 7, plus a CONUS block
  // at intensity 3 that contains it.
  const regional = 0x4a570;
  // Medium blocks are 20′ × 4°: row 135 is 45°00′–45°20′ N, column 59 is
  // 124° W–120° W.
  const conus = 1800 + 2250 * 135 + 5 * 59;
  const image = composeRadar([
    { blocks: [[conus, 1, 0, '3'.repeat(128)]] },
    { blocks: [[regional, 0, 0, '0'.repeat(64) + '7'.repeat(64)]] },
  ]);
  const cb = blockBounds(conus, 1, false);
  assert.deepEqual([cb.west, cb.south, cb.east], [-124, 45, -120]);
  assert.ok(Math.abs(cb.north - (45 + 1 / 3)) < 1e-9);
  assert.equal(image.west, -124);
  assert.ok(image.width > 0 && image.height > 0 && image.width <= 4096);
  const pixel = (lon, lat) => {
    const x = Math.floor(
      ((lon - image.west) / (image.east - image.west)) * image.width,
    );
    const y = Math.floor(
      ((image.north - lat) / (image.north - image.south)) * image.height,
    );
    return [
      ...image.rgba.slice(
        (y * image.width + x) * 4,
        (y * image.width + x) * 4 + 4,
      ),
    ];
  };
  const rb = blockBounds(regional);
  // South half of the regional block is intensity 7 (magenta), north half clears.
  assert.deepEqual(pixel(rb.west + 0.1, rb.south + 0.005), [200, 0, 200, 230]);
  assert.deepEqual(pixel(rb.west + 0.1, rb.north - 0.005), [0, 0, 0, 0]);
  // Elsewhere the CONUS block shows (intensity 3).
  assert.deepEqual(pixel(-121, 45.25), [0, 140, 0, 190]);
  assert.equal(composeRadar([{ blocks: [] }, null]), null);
});

test('the source reads the picture and fetches radar only when it changed', async () => {
  const calls = [];
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status });
  let revision = 1;
  const source = createFisbSource({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === '/api/fisb')
        return json({
          configured: true,
          radarRevision: revision,
          texts: [],
          reports: [],
        });
      return json({
        productId: Number(url.split('=')[1]),
        revision,
        blocks: [],
      });
    },
  });
  const first = await source.fetchPicture();
  assert.equal(first.configured, true);
  assert.equal(first.radar[64].productId, 64);
  await source.fetchPicture();
  revision = 2;
  await source.fetchPicture();
  assert.deepEqual(calls, [
    '/api/fisb',
    '/api/fisb/radar?product=64',
    '/api/fisb/radar?product=63',
    '/api/fisb',
    '/api/fisb',
    '/api/fisb/radar?product=64',
    '/api/fisb/radar?product=63',
  ]);
  const unconfigured = createFisbSource({
    fetchImpl: async () => json({ configured: false }),
  });
  assert.equal((await unconfigured.fetchPicture()).configured, false);
  const missing = createFisbSource({ fetchImpl: async () => json({}, 404) });
  assert.deepEqual(await missing.fetchPicture(), {
    configured: false,
    missing: true,
  });
  const broken = createFisbSource({ fetchImpl: async () => json({}, 502) });
  await assert.rejects(broken.fetchPicture(), /502/);
});
