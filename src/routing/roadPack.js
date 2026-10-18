// Offline road pack: a compact, versioned binary road graph for on-device
// routing. Portable (browser worker and Node). The reader validates every
// count, offset and index before the router sees the data, so a damaged or
// hostile file fails closed instead of reading out of bounds.
//
// Layout (little-endian, every section 4-byte aligned):
//   header (64 bytes) | metadata JSON | vertices | edges | shapes | roads | strings
// Vertices are junctions and dead ends; an edge joins two vertices along one
// OSM way, with its intermediate points in `shapes`. Coordinates are 1e-7°.

import { ROAD_CLASSES } from './osmRoads.js';

export const ROAD_PACK_MAGIC = 'GEVROAD1';
export const ROAD_PACK_VERSION = 1;
export const ROAD_PACK_HEADER_BYTES = 64;
export const ROAD_PACK_LIMITS = Object.freeze({
  maxVertices: 20_000_000,
  maxEdges: 30_000_000,
  maxShapePoints: 120_000_000,
  maxRoads: 30_000_000,
  maxStrings: 10_000_000,
  maxStringBytes: 256 * 1024 * 1024,
  maxMetadataBytes: 64 * 1024,
});
/** Road record flag bits. */
export const ROAD_FLAGS = Object.freeze({ roundabout: 1 });
/** Edge direction bits: travel from `from` to `to`, and the reverse. */
export const EDGE_DIRECTION = Object.freeze({ forward: 1, backward: 2 });
const E7 = 1e7;

export class RoadPackError extends Error {
  constructor(message) {
    super(`Road pack: ${message}`);
    this.name = 'RoadPackError';
  }
}

const align4 = (n) => (n + 3) & ~3;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function sectionPlan(counts) {
  const { vertices, edges, shapePoints, roads, strings, stringBytes } = counts;
  return [
    ['vertices', Int32Array, vertices * 2],
    ['edgeFrom', Uint32Array, edges],
    ['edgeTo', Uint32Array, edges],
    ['edgeLength', Float32Array, edges],
    ['edgeRoad', Uint32Array, edges],
    ['shapeStart', Uint32Array, edges + 1],
    ['shapes', Int32Array, shapePoints * 2],
    ['roads', Uint32Array, roads * 3],
    ['edgeDirection', Uint8Array, edges],
    ['stringOffsets', Uint32Array, strings + 1],
    ['stringBytes', Uint8Array, stringBytes],
  ];
}

/** Pack the road speed (0.1 km/h), class and flags into one word. */
export function packRoadWord(classIndex, flags, speedKmh) {
  const deci = Math.max(1, Math.min(0xffff, Math.round(speedKmh * 10)));
  return ((deci << 16) | ((flags & 0xff) << 8) | (classIndex & 0xff)) >>> 0;
}

export function unpackRoadWord(word) {
  return {
    classIndex: word & 0xff,
    flags: (word >>> 8) & 0xff,
    speedKmh: (word >>> 16) / 10,
  };
}

/**
 * Serialize a road graph. `strings[0]` must be '' (no name).
 * @param {object} graph
 * @returns {Uint8Array}
 */
export function encodeRoadPack(graph) {
  const strings = graph.strings;
  if (!Array.isArray(strings) || strings[0] !== '')
    throw new RoadPackError('string table must start with ""');
  const encoded = strings.map((value) => utf8Encoder.encode(value));
  const stringOffsets = new Uint32Array(encoded.length + 1);
  let total = 0;
  encoded.forEach((bytes, index) => {
    stringOffsets[index] = total;
    total += bytes.length;
  });
  stringOffsets[encoded.length] = total;
  const stringBytes = new Uint8Array(total);
  encoded.forEach((bytes, index) =>
    stringBytes.set(bytes, stringOffsets[index]),
  );
  const counts = {
    vertices: graph.vertices.length / 2,
    edges: graph.edgeFrom.length,
    shapePoints: graph.shapes.length / 2,
    roads: graph.roads.length / 3,
    strings: strings.length,
    stringBytes: total,
  };
  const arrays = { ...graph, stringOffsets, stringBytes };
  const metadata = utf8Encoder.encode(JSON.stringify(graph.metadata || {}));
  if (metadata.length > ROAD_PACK_LIMITS.maxMetadataBytes)
    throw new RoadPackError('metadata is too large');
  const plan = sectionPlan(counts);
  let length = align4(ROAD_PACK_HEADER_BYTES + metadata.length);
  for (const [, Type, count] of plan)
    length += align4(count * Type.BYTES_PER_ELEMENT);
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  out.set(utf8Encoder.encode(ROAD_PACK_MAGIC), 0);
  const header = [
    ROAD_PACK_VERSION,
    metadata.length,
    counts.vertices,
    counts.edges,
    counts.shapePoints,
    counts.roads,
    counts.strings,
    counts.stringBytes,
  ];
  header.forEach((value, index) => view.setUint32(8 + index * 4, value, true));
  const bounds = graph.bounds;
  [bounds.west, bounds.south, bounds.east, bounds.north].forEach((value, i) =>
    view.setInt32(40 + i * 4, Math.round(value * E7), true),
  );
  out.set(metadata, ROAD_PACK_HEADER_BYTES);
  let offset = align4(ROAD_PACK_HEADER_BYTES + metadata.length);
  for (const [name, Type, count] of plan) {
    const values = arrays[name];
    if (!(values instanceof Type) || values.length !== count)
      throw new RoadPackError(`section ${name} has the wrong type or length`);
    out.set(
      new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
      offset,
    );
    offset += align4(count * Type.BYTES_PER_ELEMENT);
  }
  return out;
}

function check(condition, message) {
  if (!condition) throw new RoadPackError(message);
}

/**
 * Read and fully validate a road pack. Section arrays view `bytes` without
 * copying when it is 4-byte aligned.
 * @param {Uint8Array|ArrayBuffer} input
 */
export function decodeRoadPack(input) {
  const bytes =
    input instanceof Uint8Array ? input : new Uint8Array(input || []);
  check(bytes.length >= ROAD_PACK_HEADER_BYTES, 'file is too short');
  check(
    new TextDecoder().decode(bytes.subarray(0, 8)) === ROAD_PACK_MAGIC,
    'not a GEV road pack',
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at) => view.getUint32(at, true);
  check(u32(8) === ROAD_PACK_VERSION, `unsupported version ${u32(8)}`);
  const metadataLength = u32(12);
  const counts = {
    vertices: u32(16),
    edges: u32(20),
    shapePoints: u32(24),
    roads: u32(28),
    strings: u32(32),
    stringBytes: u32(36),
  };
  const L = ROAD_PACK_LIMITS;
  check(metadataLength <= L.maxMetadataBytes, 'metadata is too large');
  check(
    counts.vertices >= 2 && counts.vertices <= L.maxVertices,
    'vertex count out of range',
  );
  check(
    counts.edges >= 1 && counts.edges <= L.maxEdges,
    'edge count out of range',
  );
  check(counts.shapePoints <= L.maxShapePoints, 'shape count out of range');
  check(
    counts.roads >= 1 && counts.roads <= L.maxRoads,
    'road count out of range',
  );
  check(
    counts.strings >= 1 && counts.strings <= L.maxStrings,
    'string count out of range',
  );
  check(counts.stringBytes <= L.maxStringBytes, 'string table too large');
  const bounds = {
    west: view.getInt32(40, true) / E7,
    south: view.getInt32(44, true) / E7,
    east: view.getInt32(48, true) / E7,
    north: view.getInt32(52, true) / E7,
  };
  check(
    bounds.west >= -180 &&
      bounds.east <= 180 &&
      bounds.west < bounds.east &&
      bounds.south >= -90 &&
      bounds.north <= 90 &&
      bounds.south < bounds.north,
    'invalid bounds',
  );
  let metadata;
  try {
    metadata = JSON.parse(
      utf8Decoder.decode(
        bytes.subarray(
          ROAD_PACK_HEADER_BYTES,
          ROAD_PACK_HEADER_BYTES + metadataLength,
        ),
      ),
    );
  } catch {
    throw new RoadPackError('metadata is not valid JSON');
  }
  check(
    metadata && typeof metadata === 'object' && !Array.isArray(metadata),
    'metadata must be an object',
  );
  const plan = sectionPlan(counts);
  let offset = align4(ROAD_PACK_HEADER_BYTES + metadataLength);
  let expected = offset;
  for (const [, Type, count] of plan)
    expected += align4(count * Type.BYTES_PER_ELEMENT);
  check(bytes.length === expected, 'file length does not match its header');
  const aligned = bytes.byteOffset % 4 === 0;
  const base = aligned ? bytes : bytes.slice();
  const sections = {};
  for (const [name, Type, count] of plan) {
    sections[name] = new Type(base.buffer, base.byteOffset + offset, count);
    offset += align4(count * Type.BYTES_PER_ELEMENT);
  }
  validateSections(sections, counts);
  return Object.freeze({ metadata, bounds, counts, ...sections });
}

function validateSections(s, counts) {
  const { vertices, edges, shapePoints, roads, strings, stringBytes } = counts;
  for (let i = 0; i < vertices; i++) {
    const lat = s.vertices[i * 2];
    const lon = s.vertices[i * 2 + 1];
    if (lat < -90 * E7 || lat > 90 * E7 || lon < -180 * E7 || lon > 180 * E7)
      throw new RoadPackError(`vertex ${i} is out of range`);
  }
  for (let i = 0; i < shapePoints; i++) {
    const lat = s.shapes[i * 2];
    const lon = s.shapes[i * 2 + 1];
    if (lat < -90 * E7 || lat > 90 * E7 || lon < -180 * E7 || lon > 180 * E7)
      throw new RoadPackError(`shape point ${i} is out of range`);
  }
  if (s.shapeStart[0] !== 0 || s.shapeStart[edges] !== shapePoints)
    throw new RoadPackError('shape offsets do not cover the shape table');
  for (let e = 0; e < edges; e++) {
    if (s.edgeFrom[e] >= vertices || s.edgeTo[e] >= vertices)
      throw new RoadPackError(`edge ${e} references a missing vertex`);
    if (s.edgeRoad[e] >= roads)
      throw new RoadPackError(`edge ${e} references a missing road`);
    const length = s.edgeLength[e];
    if (!Number.isFinite(length) || length < 0 || length > 1e6)
      throw new RoadPackError(`edge ${e} has an invalid length`);
    const direction = s.edgeDirection[e];
    if (direction < 1 || direction > 3)
      throw new RoadPackError(`edge ${e} has no travel direction`);
    if (s.shapeStart[e + 1] < s.shapeStart[e])
      throw new RoadPackError(`edge ${e} has decreasing shape offsets`);
  }
  for (let r = 0; r < roads; r++) {
    const { classIndex, speedKmh } = unpackRoadWord(s.roads[r * 3]);
    if (classIndex >= ROAD_CLASSES.length || speedKmh <= 0)
      throw new RoadPackError(`road ${r} has an invalid class or speed`);
    if (s.roads[r * 3 + 1] >= strings || s.roads[r * 3 + 2] >= strings)
      throw new RoadPackError(`road ${r} references a missing string`);
  }
  if (s.stringOffsets[0] !== 0 || s.stringOffsets[strings] !== stringBytes)
    throw new RoadPackError('string offsets do not cover the string table');
  for (let i = 0; i < strings; i++) {
    if (s.stringOffsets[i + 1] < s.stringOffsets[i])
      throw new RoadPackError('string offsets decrease');
    // An offset inside a multi-byte character would split it.
    const first = s.stringBytes[s.stringOffsets[i]];
    if (s.stringOffsets[i] < stringBytes && (first & 0xc0) === 0x80)
      throw new RoadPackError('string offset splits a character');
  }
  if (stringBytes)
    try {
      utf8Decoder.decode(s.stringBytes);
    } catch {
      throw new RoadPackError('string table is not valid UTF-8');
    }
}

/** Decode one string from a validated pack. */
export function roadPackString(pack, index) {
  if (!index) return '';
  return utf8Decoder.decode(
    pack.stringBytes.subarray(
      pack.stringOffsets[index],
      pack.stringOffsets[index + 1],
    ),
  );
}
