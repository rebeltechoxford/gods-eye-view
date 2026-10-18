// Synthetic road graphs for routing tests. SYNTHETIC ONLY.

import { ROAD_CLASSES } from '../routing/osmRoads.js';
import {
  EDGE_DIRECTION,
  ROAD_FLAGS,
  encodeRoadPack,
  packRoadWord,
} from '../routing/roadPack.js';

const E7 = 1e7;
const R = 6_371_008.8;

function meters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * @param {object} spec
 * @param {[number, number][]} spec.vertices [lat, lon]
 * @param {{from:number, to:number, road?:object, shape?:[number,number][], oneway?:boolean|'reverse'}[]} spec.edges
 */
export function syntheticPack({ vertices, edges, name = 'Synthetic', bounds }) {
  const strings = [''];
  const index = new Map([['', 0]]);
  const intern = (value = '') => {
    if (!index.has(value)) {
      index.set(value, strings.length);
      strings.push(value);
    }
    return index.get(value);
  };
  const roads = [];
  const roadKeys = new Map();
  const shapes = [];
  const out = {
    edgeFrom: new Uint32Array(edges.length),
    edgeTo: new Uint32Array(edges.length),
    edgeLength: new Float32Array(edges.length),
    edgeRoad: new Uint32Array(edges.length),
    edgeDirection: new Uint8Array(edges.length),
    shapeStart: new Uint32Array(edges.length + 1),
  };
  edges.forEach((edge, e) => {
    const road = {
      highway: 'residential',
      speedKmh: 36,
      name: '',
      ref: '',
      roundabout: false,
      ...edge.road,
    };
    const classIndex = ROAD_CLASSES.indexOf(road.highway);
    if (classIndex < 0) throw new Error(`unknown class ${road.highway}`);
    const flags = road.roundabout ? ROAD_FLAGS.roundabout : 0;
    const key = `${classIndex}|${flags}|${road.speedKmh}|${road.name}|${road.ref}`;
    if (!roadKeys.has(key)) {
      roadKeys.set(key, roads.length / 3);
      roads.push(
        packRoadWord(classIndex, flags, road.speedKmh),
        intern(road.name),
        intern(road.ref),
      );
    }
    out.edgeFrom[e] = edge.from;
    out.edgeTo[e] = edge.to;
    out.edgeRoad[e] = roadKeys.get(key);
    out.edgeDirection[e] =
      edge.oneway === 'reverse'
        ? EDGE_DIRECTION.backward
        : edge.oneway
          ? EDGE_DIRECTION.forward
          : EDGE_DIRECTION.forward | EDGE_DIRECTION.backward;
    out.shapeStart[e] = shapes.length / 2;
    const points = [
      vertices[edge.from],
      ...(edge.shape || []),
      vertices[edge.to],
    ];
    let length = 0;
    for (let i = 1; i < points.length; i++)
      length += meters(points[i - 1], points[i]);
    out.edgeLength[e] = length;
    for (const [lat, lon] of edge.shape || [])
      shapes.push(Math.round(lat * E7), Math.round(lon * E7));
  });
  out.shapeStart[edges.length] = shapes.length / 2;
  const lats = vertices.map(([lat]) => lat);
  const lons = vertices.map(([, lon]) => lon);
  return encodeRoadPack({
    metadata: { name, profile: 'car', source: { name: 'synthetic' } },
    bounds: bounds || {
      west: Math.min(...lons) - 0.05,
      south: Math.min(...lats) - 0.05,
      east: Math.max(...lons) + 0.05,
      north: Math.max(...lats) + 0.05,
    },
    vertices: Int32Array.from(
      vertices.flatMap(([lat, lon]) => [
        Math.round(lat * E7),
        Math.round(lon * E7),
      ]),
    ),
    ...out,
    shapes: Int32Array.from(shapes),
    roads: Uint32Array.from(roads),
    strings,
  });
}

/** A rows × cols street grid ~111 m apart near Oxford, MS (synthetic). */
export function gridSpec(
  rows,
  cols,
  { origin = [34.36, -89.52], step = 0.001, edge } = {},
) {
  const vertices = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      vertices.push([origin[0] + r * step, origin[1] + c * step]);
  const edges = [];
  const id = (r, c) => r * cols + c;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols)
        edges.push({
          from: id(r, c),
          to: id(r, c + 1),
          ...edge?.(r, c, 'east'),
        });
      if (r + 1 < rows)
        edges.push({
          from: id(r, c),
          to: id(r + 1, c),
          ...edge?.(r, c, 'north'),
        });
    }
  return { vertices, edges };
}
