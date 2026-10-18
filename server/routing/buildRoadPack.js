// Build an offline car road pack from an OpenStreetMap PBF extract.
//
// One streaming pass: PBF files sorted by type then ID (Geofabrik, OSM France
// and BBBike extracts are) deliver every node before any way, so node
// coordinates are known when ways arrive. Only nodes inside the optional
// bounding box are kept. Ways a car may use become runs of known nodes; nodes
// shared by runs or ending them become graph vertices, and the points between
// vertices become edge shapes. Small disconnected fragments are dropped so a
// route cannot snap onto an island.

import { readOsmPbf, OsmPbfError } from './osmPbf.js';
import { carRoad } from '../../src/routing/osmRoads.js';
import {
  EDGE_DIRECTION,
  ROAD_FLAGS,
  encodeRoadPack,
  packRoadWord,
} from '../../src/routing/roadPack.js';

const E7 = 1e7;
const EARTH_RADIUS_M = 6_371_008.8;

class Growable {
  constructor(Type, capacity = 1 << 16) {
    this.Type = Type;
    this.data = new Type(capacity);
    this.length = 0;
  }
  reserve(extra) {
    if (this.length + extra <= this.data.length) return;
    let size = this.data.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new this.Type(size);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
  push(value) {
    this.reserve(1);
    this.data[this.length++] = value;
  }
  view() {
    return this.data.subarray(0, this.length);
  }
}

function haversineE7(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180 / E7;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function inBounds(bounds, lat, lon) {
  return (
    !bounds ||
    (lat >= bounds.south &&
      lat <= bounds.north &&
      lon >= bounds.west &&
      lon <= bounds.east)
  );
}

function findIndex(ids, count, id) {
  let lo = 0;
  let hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const value = ids[mid];
    if (value === id) return mid;
    if (value < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * @param {string} input Path to an .osm.pbf extract.
 * @param {object} [options]
 * @param {{west:number,south:number,east:number,north:number}} [options.bounds] Keep only this area.
 * @param {string} [options.name] Human name, e.g. "Mississippi".
 * @param {number} [options.minComponentVertices] Drop smaller disconnected fragments.
 * @param {number} [options.maxNodes] Fail instead of exceeding this many stored nodes.
 * @param {(progress:object)=>void} [options.onProgress]
 * @returns {Promise<{bytes:Uint8Array, metadata:object, stats:object}>}
 */
export async function buildRoadPackFromPbf(input, options = {}) {
  const {
    bounds = null,
    name = 'Road pack',
    minComponentVertices = 50,
    maxNodes = 200_000_000,
    onProgress,
    now = () => new Date(),
  } = options;
  const started = Date.now();
  const ids = new Growable(Float64Array, 1 << 20);
  const lats = new Growable(Int32Array, 1 << 20);
  const lons = new Growable(Int32Array, 1 << 20);
  let lastId = -Infinity;
  let waysStarted = false;
  let nodeCount = 0;
  let useCount = null;
  let endpoint = null;
  const runNodes = new Growable(Int32Array, 1 << 20);
  const runStart = new Growable(Uint32Array, 1 << 16);
  const runRoad = new Growable(Uint32Array, 1 << 16);
  const runDirection = new Growable(Uint8Array, 1 << 16);
  const strings = [''];
  const stringIndex = new Map([['', 0]]);
  const roads = new Growable(Uint32Array, 3 << 12);
  const roadIndex = new Map();
  let header = null;
  let carWays = 0;
  let clippedRuns = 0;

  const internString = (value) => {
    let index = stringIndex.get(value);
    if (index === undefined) {
      index = strings.length;
      strings.push(value);
      stringIndex.set(value, index);
    }
    return index;
  };

  const onNodes = (nodeIds, lat, lon) => {
    if (waysStarted)
      throw new OsmPbfError('PBF is not sorted: nodes follow ways');
    for (let i = 0; i < nodeIds.length; i++) {
      const id = nodeIds[i];
      if (id <= lastId)
        throw new OsmPbfError('PBF node IDs are not sorted ascending');
      lastId = id;
      if (!inBounds(bounds, lat[i], lon[i])) continue;
      if (ids.length >= maxNodes)
        throw new OsmPbfError(`More than ${maxNodes} nodes in the area`);
      ids.push(id);
      lats.push(Math.round(lat[i] * E7));
      lons.push(Math.round(lon[i] * E7));
    }
  };

  const flushRun = (start, roadId, direction) => {
    const count = runNodes.length - start;
    if (count < 2) {
      runNodes.length = start;
      return;
    }
    runStart.push(start);
    runRoad.push(roadId);
    runDirection.push(direction);
    const nodes = runNodes.data;
    endpoint[nodes[start]] = 1;
    endpoint[nodes[runNodes.length - 1]] = 1;
    for (let i = start; i < runNodes.length; i++) {
      const node = nodes[i];
      if (useCount[node] < 255) useCount[node]++;
    }
  };

  const onWay = (way) => {
    if (!waysStarted) {
      waysStarted = true;
      nodeCount = ids.length;
      useCount = new Uint8Array(nodeCount);
      endpoint = new Uint8Array(nodeCount);
    }
    const road = carRoad(way.tags);
    if (!road) return;
    carWays++;
    const flags = road.roundabout ? ROAD_FLAGS.roundabout : 0;
    const key = `${road.classIndex}|${flags}|${Math.round(road.speedKmh * 10)}|${road.name}|${road.ref}`;
    let roadId = roadIndex.get(key);
    if (roadId === undefined) {
      roadId = roads.length / 3;
      roads.reserve(3);
      roads.push(packRoadWord(road.classIndex, flags, road.speedKmh));
      roads.push(internString(road.name));
      roads.push(internString(road.ref));
      roadIndex.set(key, roadId);
    }
    const direction =
      (road.forward ? EDGE_DIRECTION.forward : 0) |
      (road.backward ? EDGE_DIRECTION.backward : 0);
    let start = runNodes.length;
    let previous = -1;
    for (const ref of way.refs) {
      const index = findIndex(ids.data, nodeCount, ref);
      if (index < 0) {
        // Outside the area (or missing): end the run at the boundary.
        if (runNodes.length > start) clippedRuns++;
        flushRun(start, roadId, direction);
        start = runNodes.length;
        previous = -1;
        continue;
      }
      if (index === previous) continue; // repeated node, zero length
      runNodes.push(index);
      previous = index;
    }
    flushRun(start, roadId, direction);
  };

  header = await readOsmPbf(input, {
    onHeader(value) {
      header = value;
    },
    onNodes,
    onWay,
    onProgress,
  });
  if (!waysStarted) throw new OsmPbfError('The extract contains no ways');

  // Vertices: run endpoints and nodes shared between or within runs.
  const vertexOf = new Int32Array(nodeCount).fill(-1);
  let vertexCount = 0;
  for (let i = 0; i < nodeCount; i++)
    if (endpoint[i] || useCount[i] >= 2) vertexOf[i] = vertexCount++;

  const edgeFrom = new Growable(Uint32Array);
  const edgeTo = new Growable(Uint32Array);
  const edgeLength = new Growable(Float32Array);
  const edgeRoad = new Growable(Uint32Array);
  const edgeDirection = new Growable(Uint8Array);
  const shapeStart = new Growable(Uint32Array);
  const shapes = new Growable(Int32Array, 1 << 20);
  const latData = lats.data;
  const lonData = lons.data;
  const nodes = runNodes.data;
  for (let r = 0; r < runStart.length; r++) {
    const start = runStart.data[r];
    const end =
      r + 1 < runStart.length ? runStart.data[r + 1] : runNodes.length;
    let from = nodes[start];
    let length = 0;
    shapeStart.push(shapes.length / 2);
    for (let i = start + 1; i < end; i++) {
      const node = nodes[i];
      const prev = nodes[i - 1];
      length += haversineE7(
        latData[prev],
        lonData[prev],
        latData[node],
        lonData[node],
      );
      if (vertexOf[node] >= 0) {
        edgeFrom.push(vertexOf[from]);
        edgeTo.push(vertexOf[node]);
        edgeLength.push(length);
        edgeRoad.push(runRoad.data[r]);
        edgeDirection.push(runDirection.data[r]);
        from = node;
        length = 0;
        if (i < end - 1) shapeStart.push(shapes.length / 2);
      } else {
        shapes.push(latData[node]);
        shapes.push(lonData[node]);
      }
    }
  }
  shapeStart.push(shapes.length / 2);

  // Weakly connected components; keep the ones a route can meaningfully use.
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let e = 0; e < edgeFrom.length; e++) {
    const a = find(edgeFrom.data[e]);
    const b = find(edgeTo.data[e]);
    if (a !== b) parent[a] = b;
  }
  const componentSize = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) componentSize[find(i)]++;
  const keepVertex = new Int32Array(vertexCount).fill(-1);
  let keptVertices = 0;
  for (let i = 0; i < vertexCount; i++)
    if (componentSize[find(i)] >= minComponentVertices)
      keepVertex[i] = keptVertices++;

  const vertices = new Int32Array(keptVertices * 2);
  for (let node = 0; node < nodeCount; node++) {
    const vertex = vertexOf[node];
    if (vertex < 0 || keepVertex[vertex] < 0) continue;
    vertices[keepVertex[vertex] * 2] = latData[node];
    vertices[keepVertex[vertex] * 2 + 1] = lonData[node];
  }
  let keptEdges = 0;
  let keptShapes = 0;
  for (let e = 0; e < edgeFrom.length; e++)
    if (keepVertex[edgeFrom.data[e]] >= 0) {
      keptEdges++;
      keptShapes += shapeStart.data[e + 1] - shapeStart.data[e];
    }
  const out = {
    edgeFrom: new Uint32Array(keptEdges),
    edgeTo: new Uint32Array(keptEdges),
    edgeLength: new Float32Array(keptEdges),
    edgeRoad: new Uint32Array(keptEdges),
    edgeDirection: new Uint8Array(keptEdges),
    shapeStart: new Uint32Array(keptEdges + 1),
    shapes: new Int32Array(keptShapes * 2),
  };
  let k = 0;
  let s = 0;
  for (let e = 0; e < edgeFrom.length; e++) {
    if (keepVertex[edgeFrom.data[e]] < 0) continue;
    out.edgeFrom[k] = keepVertex[edgeFrom.data[e]];
    out.edgeTo[k] = keepVertex[edgeTo.data[e]];
    out.edgeLength[k] = edgeLength.data[e];
    out.edgeRoad[k] = edgeRoad.data[e];
    out.edgeDirection[k] = edgeDirection.data[e];
    out.shapeStart[k] = s;
    const a = shapeStart.data[e] * 2;
    const b = shapeStart.data[e + 1] * 2;
    out.shapes.set(shapes.data.subarray(a, b), s * 2);
    s += (b - a) / 2;
    k++;
  }
  out.shapeStart[keptEdges] = s;
  if (!keptEdges) throw new OsmPbfError('No routable roads in the area');

  let packBounds = bounds;
  if (!packBounds) {
    packBounds = { west: 180, south: 90, east: -180, north: -90 };
    for (let i = 0; i < keptVertices; i++) {
      const lat = vertices[i * 2] / E7;
      const lon = vertices[i * 2 + 1] / E7;
      packBounds.west = Math.min(packBounds.west, lon);
      packBounds.east = Math.max(packBounds.east, lon);
      packBounds.south = Math.min(packBounds.south, lat);
      packBounds.north = Math.max(packBounds.north, lat);
    }
  }
  const edition = header.replicationTimestamp
    ? new Date(header.replicationTimestamp * 1000).toISOString()
    : null;
  const metadata = {
    name,
    profile: 'car',
    bounds: packBounds,
    source: {
      name: 'OpenStreetMap',
      edition,
      sequence: header.replicationSequence || null,
      writingProgram: header.writingProgram || null,
    },
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    licenseUrl: 'https://www.openstreetmap.org/copyright',
    builtAt: now().toISOString(),
    builder: 'gev-road-pack/1',
  };
  const bytes = encodeRoadPack({
    metadata,
    bounds: packBounds,
    vertices,
    ...out,
    roads: roads.view().slice(),
    strings,
  });
  return {
    bytes,
    metadata,
    stats: {
      storedNodes: nodeCount,
      carWays,
      clippedRuns,
      vertices: keptVertices,
      droppedVertices: vertexCount - keptVertices,
      edges: keptEdges,
      shapePoints: keptShapes,
      roads: roads.length / 3,
      strings: strings.length,
      seconds: (Date.now() - started) / 1000,
    },
  };
}
