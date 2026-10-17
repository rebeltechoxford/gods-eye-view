import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { PbfWriter } from 'pbf';
import { buildRoadPackFromPbf } from '../../server/routing/buildRoadPack.js';
import { OsmPbfError, readOsmPbf } from '../../server/routing/osmPbf.js';
import {
  DEFAULT_SPEEDS_KMH,
  MAXSPEED_FACTOR,
  carRoad,
  parseMaxspeedKmh,
} from '../routing/osmRoads.js';
import { decodeRoadPack, roadPackString } from '../routing/roadPack.js';
import { createRoadRouter } from '../routing/router.js';
import { offlineDirections } from '../routing/offlineDirections.js';

// --- Minimal OSM PBF writer (synthetic test data only) ----------------------

function blob(type, payload) {
  const body = new PbfWriter();
  body.writeVarintField(2, payload.length);
  body.writeBytesField(3, deflateSync(payload));
  const blobBytes = body.finish();
  const header = new PbfWriter();
  header.writeStringField(1, type);
  header.writeVarintField(3, blobBytes.length);
  const headerBytes = header.finish();
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  return Buffer.concat([length, headerBytes, blobBytes]);
}

function headerBlock({
  sorted = true,
  required = ['OsmSchema-V0.6', 'DenseNodes'],
} = {}) {
  const pbf = new PbfWriter();
  for (const feature of required) pbf.writeStringField(4, feature);
  if (sorted) pbf.writeStringField(5, 'Sort.Type_then_ID');
  pbf.writeStringField(16, 'gev-test');
  pbf.writeVarintField(32, 1791936000); // 2026-10-14T00:00:00Z
  return blob('OSMHeader', pbf.finish());
}

function deltas(values) {
  let previous = 0;
  return values.map((value) => {
    const delta = value - previous;
    previous = value;
    return delta;
  });
}

/** One PrimitiveBlock of dense nodes ([id, lat, lon]) or ways ({id, tags, refs}). */
function dataBlock({ nodes, ways }) {
  const strings = [''];
  const index = (value) => {
    let i = strings.indexOf(value);
    if (i < 0) {
      i = strings.length;
      strings.push(value);
    }
    return i;
  };
  const group = new PbfWriter();
  if (nodes) {
    group.writeMessage(
      2,
      (_, pbf) => {
        pbf.writePackedSVarint(1, deltas(nodes.map(([id]) => id)));
        pbf.writePackedSVarint(
          8,
          deltas(nodes.map(([, lat]) => Math.round(lat * 1e7))),
        );
        pbf.writePackedSVarint(
          9,
          deltas(nodes.map(([, , lon]) => Math.round(lon * 1e7))),
        );
      },
      null,
    );
  }
  for (const way of ways || [])
    group.writeMessage(
      3,
      (_, pbf) => {
        pbf.writeVarintField(1, way.id);
        const entries = Object.entries(way.tags);
        pbf.writePackedVarint(
          2,
          entries.map(([key]) => index(key)),
        );
        pbf.writePackedVarint(
          3,
          entries.map(([, value]) => index(value)),
        );
        pbf.writePackedSVarint(8, deltas(way.refs));
      },
      null,
    );
  const groupBytes = group.finish();
  const block = new PbfWriter();
  block.writeMessage(
    1,
    (_, pbf) =>
      strings.forEach((value) => pbf.writeBytesField(1, Buffer.from(value))),
    null,
  );
  block.writeBytesField(2, groupBytes);
  block.writeVarintField(17, 100); // granularity: 1e-7 degrees
  return blob('OSMData', block.finish());
}

async function writePbf(dir, name, parts) {
  const file = path.join(dir, name);
  await writeFile(file, Buffer.concat(parts));
  return file;
}

// A synthetic Oxford-area street network: Jackson Avenue east-west with a
// one-way Ninth Street north, plus a private drive and a footway to ignore.
const NODES = [
  [10, 34.366, -89.53],
  [11, 34.366, -89.525],
  [12, 34.366, -89.52],
  [13, 34.366, -89.515],
  [14, 34.371, -89.52],
  [15, 34.376, -89.52],
  [16, 34.36, -89.53],
  [17, 34.355, -89.53],
  [18, 34.367, -89.5249],
];
const WAYS = [
  {
    id: 100,
    tags: {
      highway: 'secondary',
      name: 'Jackson Avenue',
      ref: 'MS 6',
      maxspeed: '35 mph',
    },
    refs: [10, 11, 12, 13],
  },
  {
    id: 101,
    tags: { highway: 'residential', name: 'Ninth Street', oneway: 'yes' },
    refs: [12, 14, 15],
  },
  {
    id: 102,
    tags: { highway: 'service', access: 'private', name: 'Private Drive' },
    refs: [10, 16, 17],
  },
  { id: 103, tags: { highway: 'footway' }, refs: [11, 18] },
];

test('the PBF reader decodes dense nodes, ways and the header', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-pbf-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await writePbf(dir, 'tiny.osm.pbf', [
    headerBlock(),
    dataBlock({ nodes: NODES }),
    dataBlock({ ways: WAYS }),
  ]);
  const seen = { nodes: [], ways: [] };
  const header = await readOsmPbf(file, {
    onNodes: (ids, lat, lon) =>
      ids.forEach((id, i) =>
        seen.nodes.push([
          id,
          Number(lat[i].toFixed(7)),
          Number(lon[i].toFixed(7)),
        ]),
      ),
    onWay: (way) =>
      seen.ways.push([way.id, way.tags.highway, Array.from(way.refs)]),
  });
  assert.deepEqual(seen.nodes, NODES);
  assert.deepEqual(
    seen.ways,
    WAYS.map((w) => [w.id, w.tags.highway, w.refs]),
  );
  assert.equal(header.replicationTimestamp, 1791936000);
  assert.deepEqual(header.optionalFeatures, ['Sort.Type_then_ID']);
});

test('a built pack keeps car roads, directions and names, and routes on them', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-pbf-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await writePbf(dir, 'oxford.osm.pbf', [
    headerBlock(),
    dataBlock({ nodes: NODES }),
    dataBlock({ ways: WAYS }),
  ]);
  const { bytes, metadata, stats } = await buildRoadPackFromPbf(file, {
    name: 'Synthetic Oxford',
    minComponentVertices: 2,
    now: () => new Date('2026-10-17T00:00:00Z'),
  });
  const pack = decodeRoadPack(bytes);
  assert.equal(stats.carWays, 2, 'private drive and footway are excluded');
  // Vertices: both Jackson ends, the Ninth junction and the Ninth end.
  assert.equal(pack.counts.vertices, 4);
  assert.equal(pack.counts.edges, 3);
  assert.equal(metadata.source.edition, '2026-10-14T00:00:00.000Z');
  assert.equal(metadata.license, 'ODbL-1.0');
  assert.equal(metadata.attribution, '© OpenStreetMap contributors');
  const names = new Set();
  for (let r = 0; r < pack.counts.roads; r++)
    names.add(roadPackString(pack, pack.roads[r * 3 + 1]));
  assert.deepEqual([...names].sort(), ['Jackson Avenue', 'Ninth Street']);
  const router = createRoadRouter(pack);
  const north = offlineDirections(router, {
    a: { lat: 34.366, lon: -89.529 },
    b: { lat: 34.375, lon: -89.52 },
  });
  assert.deepEqual(
    north.steps.map((step) => step.instruction),
    [
      'Head out on Jackson Avenue (MS 6)',
      'Turn left onto Ninth Street',
      'Arrive at your destination',
    ],
  );
  // Ninth Street is one-way north, so there is no way back south on it.
  assert.throws(
    () =>
      router.route({ lat: 34.375, lon: -89.52 }, { lat: 34.366, lon: -89.529 }),
    (error) => error.code === 'no-route',
  );
  // 35 mph posted, scaled to a travel speed.
  const jackson = router.snap(34.366, -89.527).edge;
  assert.ok(
    Math.abs(
      router.edgeSpeed(jackson) * 3.6 - 35 * 1.609344 * MAXSPEED_FACTOR,
    ) < 0.1,
  );
});

test('bounds clip roads at the boundary and small fragments are dropped', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-pbf-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await writePbf(dir, 'clip.osm.pbf', [
    headerBlock(),
    dataBlock({ nodes: NODES }),
    dataBlock({ ways: WAYS }),
  ]);
  const clipped = await buildRoadPackFromPbf(file, {
    bounds: { west: -89.531, south: 34.36, east: -89.516, north: 34.372 },
    minComponentVertices: 2,
  });
  assert.equal(
    clipped.stats.clippedRuns,
    2,
    'Jackson east end and Ninth north end',
  );
  const pack = decodeRoadPack(clipped.bytes);
  for (let v = 0; v < pack.counts.vertices; v++)
    assert.ok(pack.vertices[v * 2 + 1] / 1e7 <= -89.516);
  // Requiring a larger component removes the whole tiny network.
  await assert.rejects(
    buildRoadPackFromPbf(file, { minComponentVertices: 50 }),
    /No routable roads/,
  );
});

test('unsorted or unsupported extracts are refused', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-pbf-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const unsorted = await writePbf(dir, 'unsorted.osm.pbf', [
    headerBlock({ sorted: false }),
    dataBlock({ ways: WAYS }),
    dataBlock({ nodes: NODES }),
  ]);
  await assert.rejects(buildRoadPackFromPbf(unsorted), /not sorted/);
  const descending = await writePbf(dir, 'descending.osm.pbf', [
    headerBlock(),
    dataBlock({ nodes: [...NODES].reverse() }),
  ]);
  await assert.rejects(
    buildRoadPackFromPbf(descending),
    /not sorted ascending/,
  );
  const history = await writePbf(dir, 'history.osm.pbf', [
    headerBlock({ required: ['OsmSchema-V0.6', 'HistoricalInformation'] }),
  ]);
  await assert.rejects(readOsmPbf(history), OsmPbfError);
  const truncated = await writePbf(dir, 'truncated.osm.pbf', [
    headerBlock().subarray(0, 20),
  ]);
  await assert.rejects(readOsmPbf(truncated), /Truncated/);
});

test('car road rules follow OSM access, oneway and speed tagging', () => {
  assert.equal(carRoad({ highway: 'footway' }), null);
  assert.equal(carRoad({ highway: 'track' }), null);
  assert.equal(carRoad({ highway: 'residential', access: 'private' }), null);
  assert.ok(
    carRoad({
      highway: 'residential',
      access: 'no',
      motor_vehicle: 'destination',
    }),
  );
  assert.equal(carRoad({ highway: 'service', service: 'parking_aisle' }), null);
  assert.equal(carRoad({ highway: 'residential', oneway: 'reversible' }), null);
  assert.deepEqual(
    [
      carRoad({ highway: 'motorway' }).forward,
      carRoad({ highway: 'motorway' }).backward,
    ],
    [true, false],
  );
  assert.equal(carRoad({ highway: 'motorway', oneway: 'no' }).backward, true);
  assert.equal(carRoad({ highway: 'tertiary', oneway: '-1' }).forward, false);
  const roundabout = carRoad({ highway: 'tertiary', junction: 'roundabout' });
  assert.deepEqual([roundabout.roundabout, roundabout.backward], [true, false]);
  assert.equal(
    carRoad({ highway: 'primary' }).speedKmh,
    DEFAULT_SPEEDS_KMH.primary,
  );
  assert.equal(parseMaxspeedKmh('45 mph').toFixed(2), '72.42');
  assert.equal(parseMaxspeedKmh('80'), 80);
  assert.equal(parseMaxspeedKmh('signals'), null);
  assert.equal(parseMaxspeedKmh('999'), null);
});
