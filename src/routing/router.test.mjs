import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EDGE_DIRECTION,
  RoadPackError,
  decodeRoadPack,
  roadPackString,
} from './roadPack.js';
import { RouteError, createRoadRouter, haversineMeters } from './router.js';
import { gridSpec, syntheticPack } from '../testSupport/roadGraph.mjs';

const routerFor = (spec, options) =>
  createRoadRouter(decodeRoadPack(syntheticPack(spec)), options);

/** Exhaustive Dijkstra over the router's own arcs, with the same seeds/exits. */
function referenceSeconds(router, a, b) {
  const { pack } = router;
  const from = router.snap(a.lat, a.lon);
  const to = router.snap(b.lat, b.lon);
  const speed = (e) => router.edgeSpeed(e);
  const dist = new Map();
  const queue = [];
  const relax = (v, d) => {
    if (d < (dist.get(v) ?? Infinity)) {
      dist.set(v, d);
      queue.push([d, v]);
    }
  };
  const fe = from.edge;
  const te = to.edge;
  const fd = pack.edgeDirection[fe];
  const td = pack.edgeDirection[te];
  if (fd & EDGE_DIRECTION.forward)
    relax(pack.edgeTo[fe], (pack.edgeLength[fe] - from.offset) / speed(fe));
  if (fd & EDGE_DIRECTION.backward)
    relax(pack.edgeFrom[fe], from.offset / speed(fe));
  let best = Infinity;
  if (fe === te) {
    if (fd & EDGE_DIRECTION.forward && to.offset >= from.offset)
      best = (to.offset - from.offset) / speed(fe);
    if (fd & EDGE_DIRECTION.backward && from.offset >= to.offset)
      best = Math.min(best, (from.offset - to.offset) / speed(fe));
  }
  const done = new Set();
  while (queue.length) {
    queue.sort((x, y) => x[0] - y[0]);
    const [d, v] = queue.shift();
    if (done.has(v)) continue;
    done.add(v);
    if (td & EDGE_DIRECTION.forward && v === pack.edgeFrom[te])
      best = Math.min(best, d + to.offset / speed(te));
    if (td & EDGE_DIRECTION.backward && v === pack.edgeTo[te])
      best = Math.min(best, d + (pack.edgeLength[te] - to.offset) / speed(te));
    for (const arc of router.arcsFrom(v)) relax(arc.target, d + arc.cost);
  }
  return best;
}

test('road packs round-trip and expose their tables', () => {
  const bytes = syntheticPack({
    vertices: [
      [34.36, -89.52],
      [34.361, -89.52],
    ],
    edges: [
      {
        from: 0,
        to: 1,
        road: { name: 'Jackson Avenue', ref: 'MS 6', speedKmh: 72 },
        shape: [[34.3605, -89.5201]],
      },
    ],
  });
  const pack = decodeRoadPack(bytes);
  assert.equal(pack.counts.vertices, 2);
  assert.equal(pack.counts.shapePoints, 1);
  assert.equal(roadPackString(pack, pack.roads[1]), 'Jackson Avenue');
  assert.equal(roadPackString(pack, pack.roads[2]), 'MS 6');
  // Unaligned input still decodes (it is copied once).
  const shifted = new Uint8Array(bytes.length + 1);
  shifted.set(bytes, 1);
  assert.equal(decodeRoadPack(shifted.subarray(1)).counts.edges, 1);
});

test('small packs with huge coverage are refused before dense grid allocation', () => {
  const bytes = syntheticPack({
    ...gridSpec(2, 2),
    bounds: { west: -180, south: -90, east: 180, north: 90 },
  });
  assert.ok(bytes.length < 4096);
  const pack = decodeRoadPack(bytes);
  assert.throws(
    () => createRoadRouter(pack),
    /coverage exceeds the device index limit/,
  );
});

test('graph index allocations have a separate device memory ceiling', () => {
  // Count-only input proves the guard runs before accessing or allocating
  // graph arrays. A real decoded pack with these counts has the same bound.
  assert.throws(
    () =>
      createRoadRouter({
        counts: { vertices: 3_000_000, edges: 3_000_000, roads: 1 },
        bounds: { west: 0, south: 0, east: 1, north: 1 },
      }),
    /graph exceeds the device index memory limit/,
  );
});

test('damaged road packs fail closed with RoadPackError', () => {
  const bytes = syntheticPack(gridSpec(3, 3));
  for (let length = 0; length < bytes.length; length += 7)
    assert.throws(
      () => decodeRoadPack(bytes.subarray(0, length)),
      RoadPackError,
    );
  let seed = 7;
  const random = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
  for (let round = 0; round < 2000; round++) {
    const damaged = bytes.slice();
    damaged[Math.floor(random() * damaged.length)] = Math.floor(random() * 256);
    try {
      const pack = decodeRoadPack(damaged);
      // A change that still validates must still yield a usable router.
      createRoadRouter(pack);
    } catch (error) {
      assert.ok(error instanceof RoadPackError, error.stack);
    }
  }
  const view = new DataView(bytes.buffer.slice(0));
  view.setUint32(8, 2, true);
  assert.throws(
    () => decodeRoadPack(new Uint8Array(view.buffer)),
    /unsupported version/,
  );
});

test('A* matches exhaustive Dijkstra on a one-way grid', () => {
  // Alternate one-way streets, with faster avenues every third column.
  const spec = gridSpec(12, 12, {
    edge: (r, c, heading) =>
      heading === 'east'
        ? { oneway: r % 2 ? 'reverse' : true, road: { name: `Row ${r}` } }
        : {
            oneway: c % 4 === 1 ? true : false,
            road:
              c % 3 === 0
                ? { highway: 'primary', speedKmh: 72, name: `Avenue ${c}` }
                : { name: `Col ${c}` },
          },
  });
  const router = routerFor(spec);
  let seed = 3;
  const random = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
  const point = () => ({
    lat: 34.36 + random() * 0.011,
    lon: -89.52 + random() * 0.011,
  });
  let routed = 0;
  for (let i = 0; i < 150; i++) {
    const a = point();
    const b = point();
    let result;
    try {
      result = router.route(a, b);
    } catch (error) {
      assert.equal(error.code, 'no-route');
      assert.equal(referenceSeconds(router, a, b), Infinity);
      continue;
    }
    routed++;
    assert.ok(
      Math.abs(result.durationS - referenceSeconds(router, a, b)) < 1e-6,
      `trip ${i}`,
    );
    // The traversals are contiguous and obey every edge's direction.
    for (const [edge, reversed] of result.traversals) {
      const dir = router.pack.edgeDirection[edge];
      assert.ok(
        dir & (reversed ? EDGE_DIRECTION.backward : EDGE_DIRECTION.forward),
      );
    }
  }
  assert.ok(routed > 100);
});

test('one-way streets are never driven backwards, even when it is shorter', () => {
  // 0 → 1 direct is one-way the other way; the legal route loops via 2.
  const router = routerFor({
    vertices: [
      [34.36, -89.52],
      [34.36, -89.51],
      [34.37, -89.515],
    ],
    edges: [
      { from: 1, to: 0, oneway: true },
      { from: 0, to: 2 },
      { from: 2, to: 1 },
    ],
  });
  const result = router.route(
    { lat: 34.36, lon: -89.5199 },
    { lat: 34.36, lon: -89.5101 },
  );
  assert.deepEqual(
    result.traversals.map(([edge, reversed]) => [edge, reversed]),
    [
      [0, false],
      [1, false],
      [2, false],
      [0, false],
    ],
  );
  // Edge 0 runs 1 → 0; travelling it reversed would be the illegal direction.
  assert.ok(
    result.traversals.every(([edge, reversed]) => !(edge === 0 && reversed)),
  );
});

test('trips along a single edge honour its direction', () => {
  const spec = {
    vertices: [
      [34.36, -89.52],
      [34.36, -89.5],
      [34.37, -89.51],
    ],
    edges: [
      { from: 0, to: 1, oneway: true },
      { from: 1, to: 2 },
      { from: 2, to: 0 },
    ],
  };
  const router = routerFor(spec);
  const forward = router.route(
    { lat: 34.36, lon: -89.518 },
    { lat: 34.36, lon: -89.502 },
  );
  assert.equal(forward.traversals.length, 1);
  assert.deepEqual(forward.traversals[0].slice(0, 2), [0, false]);
  // Backwards on the one-way edge must go around the triangle instead.
  const around = router.route(
    { lat: 34.36, lon: -89.502 },
    { lat: 34.36, lon: -89.518 },
  );
  assert.ok(around.traversals.length >= 3);
  assert.ok(around.durationS > forward.durationS);
});

test('snapping refuses points beyond the snap radius or outside the pack', () => {
  const router = routerFor(gridSpec(3, 3), { maxSnapMeters: 200 });
  const near = router.snap(34.3605, -89.5195);
  assert.ok(near && near.distance < 60);
  assert.equal(router.snap(34.3605, -89.48), null);
  assert.equal(router.snap(40, -89.52), null);
  assert.throws(
    () =>
      router.route({ lat: 34.36, lon: -89.52 }, { lat: 34.3605, lon: -89.48 }),
    (error) => error instanceof RouteError && error.code === 'no-road',
  );
});

test('disconnected roads report no route rather than inventing one', () => {
  const router = routerFor({
    vertices: [
      [34.36, -89.52],
      [34.36, -89.519],
      [34.37, -89.52],
      [34.37, -89.519],
    ],
    edges: [
      { from: 0, to: 1 },
      { from: 2, to: 3 },
    ],
  });
  assert.throws(
    () =>
      router.route(
        { lat: 34.36, lon: -89.5195 },
        { lat: 34.37, lon: -89.5195 },
      ),
    (error) => error.code === 'no-route',
  );
});

test('a cancelled route stops with an aborted RouteError', () => {
  const router = routerFor(gridSpec(80, 80, { step: 0.0005 }));
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      router.route(
        { lat: 34.36, lon: -89.52 },
        { lat: 34.399, lon: -89.4805 },
        { signal: controller.signal },
      ),
    (error) => error.code === 'aborted',
  );
});

test('traversal points follow shapes and partial edges', () => {
  const router = routerFor({
    vertices: [
      [34.36, -89.52],
      [34.37, -89.52],
    ],
    edges: [{ from: 0, to: 1, shape: [[34.365, -89.515]] }],
  });
  const length = router.pack.edgeLength[0];
  const points = router.traversalPoints([0, false, 0, length]);
  assert.deepEqual(
    points.map(([lat]) => Number(lat.toFixed(4))),
    [34.36, 34.365, 34.37],
  );
  const half = router.traversalPoints([0, true, length / 2, 0]);
  assert.ok(Math.abs(half[0][0] - 34.365) < 1e-4);
  assert.deepEqual(
    half.at(-1).map((v) => Number(v.toFixed(4))),
    [34.36, -89.52],
  );
  const travelled = half
    .slice(1)
    .reduce(
      (sum, p, i) => sum + haversineMeters(half[i][0], half[i][1], p[0], p[1]),
      0,
    );
  assert.ok(Math.abs(travelled - length / 2) < 1);
});
