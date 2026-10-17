// Offline car router over a validated road pack. Portable; meant to run in a
// Web Worker on the phone, and in Node for tests and the pack builder.
//
// Both endpoints snap to the nearest road through a coarse grid index. A*
// then searches travel time from the snapped start, whose edge it may leave
// in either allowed direction, to the snapped end. The heuristic is
// straight-line distance at the fastest speed in the pack, so it never
// overestimates and the result is a shortest-time route on this graph. Turn
// restrictions and turn costs are not modelled.

import { EDGE_DIRECTION, unpackRoadWord } from './roadPack.js';

const E7 = 1e7;
const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;
/** Grid cell size for the snapping index, degrees. */
export const SNAP_CELL_DEGREES = 0.01;
export const DEFAULT_MAX_SNAP_METERS = 2000;

export class RouteError extends Error {
  /** @param {'no-pack'|'outside'|'no-road'|'no-route'|'aborted'} code */
  constructor(message, code) {
    super(message);
    this.name = 'RouteError';
    this.code = code;
  }
}

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from point 1 to point 2, degrees clockwise from north. */
export function bearingDegrees(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * DEG) * Math.cos(lat2 * DEG);
  const x =
    Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
    Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lon2 - lon1) * DEG);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

class MinHeap {
  constructor() {
    this.keys = new Float64Array(1024);
    this.values = new Int32Array(1024);
    this.size = 0;
  }
  push(key, value) {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2);
      const values = new Int32Array(this.size * 2);
      keys.set(this.keys);
      values.set(this.values);
      this.keys = keys;
      this.values = values;
    }
    let i = this.size++;
    const { keys, values } = this;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }
  pop() {
    const { keys, values } = this;
    const top = values[0];
    const key = keys[--this.size];
    const value = values[this.size];
    let i = 0;
    for (;;) {
      let child = i * 2 + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && keys[child + 1] < keys[child]) child++;
      if (keys[child] >= key) break;
      keys[i] = keys[child];
      values[i] = values[child];
      i = child;
    }
    keys[i] = key;
    values[i] = value;
    return top;
  }
  get minKey() {
    return this.keys[0];
  }
  clear() {
    this.size = 0;
  }
}

/**
 * @param {ReturnType<import('./roadPack.js').decodeRoadPack>} pack
 * @param {{maxSnapMeters?:number}} [options]
 */
export function createRoadRouter(
  pack,
  { maxSnapMeters = DEFAULT_MAX_SNAP_METERS } = {},
) {
  if (!pack?.counts) throw new RouteError('No road pack is loaded', 'no-pack');
  const V = pack.counts.vertices;
  const E = pack.counts.edges;
  const speed = new Float32Array(pack.counts.roads); // m/s per road record
  let maxSpeed = 1;
  for (let r = 0; r < speed.length; r++) {
    speed[r] = unpackRoadWord(pack.roads[r * 3]).speedKmh / 3.6;
    if (speed[r] > maxSpeed) maxSpeed = speed[r];
  }

  // Directed arcs in compressed rows: arcEdge holds edge * 2 + (reversed ? 1 : 0).
  const outDegree = new Uint32Array(V + 1);
  for (let e = 0; e < E; e++) {
    const dir = pack.edgeDirection[e];
    if (dir & EDGE_DIRECTION.forward) outDegree[pack.edgeFrom[e]]++;
    if (dir & EDGE_DIRECTION.backward) outDegree[pack.edgeTo[e]]++;
  }
  const arcStart = new Uint32Array(V + 1);
  for (let v = 0; v < V; v++) arcStart[v + 1] = arcStart[v] + outDegree[v];
  const arcCount = arcStart[V];
  const arcTarget = new Uint32Array(arcCount);
  const arcEdge = new Uint32Array(arcCount);
  const arcCost = new Float32Array(arcCount);
  const fill = arcStart.slice(0, V);
  for (let e = 0; e < E; e++) {
    const dir = pack.edgeDirection[e];
    const cost = pack.edgeLength[e] / speed[pack.edgeRoad[e]];
    if (dir & EDGE_DIRECTION.forward) {
      const a = fill[pack.edgeFrom[e]]++;
      arcTarget[a] = pack.edgeTo[e];
      arcEdge[a] = e * 2;
      arcCost[a] = cost;
    }
    if (dir & EDGE_DIRECTION.backward) {
      const a = fill[pack.edgeTo[e]]++;
      arcTarget[a] = pack.edgeFrom[e];
      arcEdge[a] = e * 2 + 1;
      arcCost[a] = cost;
    }
  }

  // Snapping grid: each edge is listed in every cell its bounding box covers.
  const { west, south, east, north } = pack.bounds;
  const cols = Math.max(1, Math.ceil((east - west) / SNAP_CELL_DEGREES));
  const rows = Math.max(1, Math.ceil((north - south) / SNAP_CELL_DEGREES));
  const cellOf = (lat, lon) => {
    const c = Math.min(
      cols - 1,
      Math.max(0, Math.floor((lon - west) / SNAP_CELL_DEGREES)),
    );
    const r = Math.min(
      rows - 1,
      Math.max(0, Math.floor((lat - south) / SNAP_CELL_DEGREES)),
    );
    return [r, c];
  };
  const edgeBox = (e, visit) => {
    let minLat = Infinity,
      minLon = Infinity,
      maxLat = -Infinity,
      maxLon = -Infinity;
    forEachEdgePoint(e, (lat, lon) => {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    });
    const [r0, c0] = cellOf(minLat, minLon);
    const [r1, c1] = cellOf(maxLat, maxLon);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) visit(r * cols + c);
  };
  const cellCount = new Uint32Array(rows * cols + 1);
  for (let e = 0; e < E; e++) edgeBox(e, (cell) => cellCount[cell]++);
  const cellStart = new Uint32Array(rows * cols + 1);
  for (let i = 0; i < rows * cols; i++)
    cellStart[i + 1] = cellStart[i] + cellCount[i];
  const cellEdges = new Uint32Array(cellStart[rows * cols]);
  const cellFill = cellStart.slice(0, rows * cols);
  for (let e = 0; e < E; e++)
    edgeBox(e, (cell) => (cellEdges[cellFill[cell]++] = e));

  function vertexLat(v) {
    return pack.vertices[v * 2] / E7;
  }
  function vertexLon(v) {
    return pack.vertices[v * 2 + 1] / E7;
  }
  /** Visit an edge's points from `from` to `to`, in degrees. */
  function forEachEdgePoint(e, visit) {
    const from = pack.edgeFrom[e];
    visit(vertexLat(from), vertexLon(from));
    for (let p = pack.shapeStart[e]; p < pack.shapeStart[e + 1]; p++)
      visit(pack.shapes[p * 2] / E7, pack.shapes[p * 2 + 1] / E7);
    const to = pack.edgeTo[e];
    visit(vertexLat(to), vertexLon(to));
  }
  function edgePoints(e) {
    const points = [];
    forEachEdgePoint(e, (lat, lon) => points.push([lat, lon]));
    return points;
  }

  /** Nearest point on any road, or null beyond maxSnapMeters. */
  function snap(lat, lon) {
    if (!(lat >= south && lat <= north && lon >= west && lon <= east))
      return null;
    const metersPerDegLat = EARTH_RADIUS_M * DEG;
    const metersPerDegLon = metersPerDegLat * Math.cos(lat * DEG);
    const [r0, c0] = cellOf(lat, lon);
    const ringLimit = Math.ceil(
      maxSnapMeters /
        (Math.min(metersPerDegLat, metersPerDegLon) * SNAP_CELL_DEGREES),
    );
    let best = null;
    const seen = new Set();
    for (let ring = 0; ring <= ringLimit; ring++) {
      // Once the best match is closer than this ring's nearest edge, stop.
      const ringDistance =
        (ring - 1) *
        Math.min(metersPerDegLat, metersPerDegLon) *
        SNAP_CELL_DEGREES;
      if (best && best.distance <= ringDistance) break;
      for (let r = r0 - ring; r <= r0 + ring; r++) {
        if (r < 0 || r >= rows) continue;
        for (let c = c0 - ring; c <= c0 + ring; c++) {
          if (c < 0 || c >= cols) continue;
          if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== ring) continue;
          const cell = r * cols + c;
          for (let i = cellStart[cell]; i < cellStart[cell + 1]; i++) {
            const e = cellEdges[i];
            if (seen.has(e)) continue;
            seen.add(e);
            const points = edgePoints(e);
            let along = 0;
            for (let s = 0; s + 1 < points.length; s++) {
              const [aLat, aLon] = points[s];
              const [bLat, bLon] = points[s + 1];
              const ax = (aLon - lon) * metersPerDegLon;
              const ay = (aLat - lat) * metersPerDegLat;
              const bx = (bLon - lon) * metersPerDegLon;
              const by = (bLat - lat) * metersPerDegLat;
              const dx = bx - ax;
              const dy = by - ay;
              const len2 = dx * dx + dy * dy;
              const t = len2
                ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2))
                : 0;
              const px = ax + t * dx;
              const py = ay + t * dy;
              const distance = Math.hypot(px, py);
              const segment = haversineMeters(aLat, aLon, bLat, bLon);
              if (!best || distance < best.distance)
                best = {
                  edge: e,
                  segment: s,
                  t,
                  distance,
                  offset: along + t * segment,
                  lat: aLat + t * (bLat - aLat),
                  lon: aLon + t * (bLon - aLon),
                };
              along += segment;
            }
          }
        }
      }
    }
    if (!best || best.distance > maxSnapMeters) return null;
    // Offsets come from summed segments; scale to the stored edge length.
    const points = edgePoints(best.edge);
    let total = 0;
    for (let s = 0; s + 1 < points.length; s++)
      total += haversineMeters(
        points[s][0],
        points[s][1],
        points[s + 1][0],
        points[s + 1][1],
      );
    const length = pack.edgeLength[best.edge];
    best.offset = total ? (best.offset / total) * length : 0;
    return best;
  }

  // Per-query state, reused; `touched` resets only what a query changed.
  const dist = new Float64Array(V).fill(Infinity);
  const prevArc = new Int32Array(V).fill(-1);
  const closed = new Uint8Array(V);
  const touched = [];
  const heap = new MinHeap();

  function reset() {
    for (const v of touched) {
      dist[v] = Infinity;
      prevArc[v] = -1;
      closed[v] = 0;
    }
    touched.length = 0;
    heap.clear();
  }

  /**
   * Shortest-time route between two points.
   * @param {{lat:number, lon:number}} a
   * @param {{lat:number, lon:number}} b
   * @param {{signal?:AbortSignal}} [options]
   */
  function route(a, b, { signal } = {}) {
    const from = snap(a.lat, a.lon);
    if (!from)
      throw new RouteError(
        'No road near the start in this offline pack',
        'no-road',
      );
    const to = snap(b.lat, b.lon);
    if (!to)
      throw new RouteError(
        'No road near the destination in this offline pack',
        'no-road',
      );
    reset();
    const fe = from.edge;
    const te = to.edge;
    const fSpeed = speed[pack.edgeRoad[fe]];
    const tSpeed = speed[pack.edgeRoad[te]];
    const fLen = pack.edgeLength[fe];
    const tLen = pack.edgeLength[te];
    const fDir = pack.edgeDirection[fe];
    const tDir = pack.edgeDirection[te];
    const h = (v) =>
      haversineMeters(vertexLat(v), vertexLon(v), to.lat, to.lon) / maxSpeed;

    // Entering the graph from the start point; remember which way each seed left.
    const seedForward = new Map();
    const seed = (v, cost, forward) => {
      if (cost >= dist[v]) return;
      if (dist[v] === Infinity) touched.push(v);
      dist[v] = cost;
      prevArc[v] = -1;
      seedForward.set(v, forward);
      heap.push(cost + h(v), v);
    };
    if (fDir & EDGE_DIRECTION.forward)
      seed(pack.edgeTo[fe], (fLen - from.offset) / fSpeed, true);
    if (fDir & EDGE_DIRECTION.backward)
      seed(pack.edgeFrom[fe], from.offset / fSpeed, false);

    // Leaving the graph to the end point: vertex -> extra cost.
    const exitFrom = tDir & EDGE_DIRECTION.forward ? pack.edgeFrom[te] : -1;
    const exitFromCost = to.offset / tSpeed;
    const exitTo = tDir & EDGE_DIRECTION.backward ? pack.edgeTo[te] : -1;
    const exitToCost = (tLen - to.offset) / tSpeed;

    let best = Infinity;
    let bestVertex = -1;
    let bestExitForward = true;
    let direct = false;
    if (fe === te) {
      // Travel along the shared edge without reaching a vertex.
      if (fDir & EDGE_DIRECTION.forward && to.offset >= from.offset) {
        best = (to.offset - from.offset) / fSpeed;
        direct = true;
      }
      if (fDir & EDGE_DIRECTION.backward && from.offset >= to.offset) {
        const cost = (from.offset - to.offset) / fSpeed;
        if (cost < best) {
          best = cost;
          direct = true;
        }
      }
    }

    let pops = 0;
    while (heap.size && heap.minKey < best) {
      const v = heap.pop();
      // The heuristic is consistent, so a vertex's first pop is final.
      if (closed[v]) continue;
      closed[v] = 1;
      const g = dist[v];
      if ((++pops & 0xfff) === 0 && signal?.aborted)
        throw new RouteError('Route cancelled', 'aborted');
      if (v === exitFrom && g + exitFromCost < best) {
        best = g + exitFromCost;
        bestVertex = v;
        bestExitForward = true;
        direct = false;
      }
      if (v === exitTo && g + exitToCost < best) {
        best = g + exitToCost;
        bestVertex = v;
        bestExitForward = false;
        direct = false;
      }
      for (let arc = arcStart[v]; arc < arcStart[v + 1]; arc++) {
        const w = arcTarget[arc];
        const cost = g + arcCost[arc];
        if (cost < dist[w]) {
          if (dist[w] === Infinity) touched.push(w);
          dist[w] = cost;
          prevArc[w] = arc;
          heap.push(cost + h(w), w);
        }
      }
    }
    if (best === Infinity)
      throw new RouteError(
        'No drivable route between these points in this offline pack',
        'no-route',
      );

    // Traversals: [edge, reversed, startOffset, endOffset] along the route.
    const traversals = [];
    if (direct) {
      traversals.push([fe, to.offset < from.offset, from.offset, to.offset]);
    } else {
      const arcs = [];
      let v = bestVertex;
      while (prevArc[v] >= 0) {
        arcs.push(prevArc[v]);
        const e = arcEdge[prevArc[v]] >> 1;
        const reversed = arcEdge[prevArc[v]] & 1;
        v = reversed ? pack.edgeTo[e] : pack.edgeFrom[e];
      }
      arcs.reverse();
      // `v` is the seed vertex the route left the start edge by.
      if (seedForward.get(v)) traversals.push([fe, false, from.offset, fLen]);
      else traversals.push([fe, true, from.offset, 0]);
      for (const arc of arcs) {
        const e = arcEdge[arc] >> 1;
        const reversed = (arcEdge[arc] & 1) === 1;
        const len = pack.edgeLength[e];
        traversals.push([e, reversed, reversed ? len : 0, reversed ? 0 : len]);
      }
      if (bestExitForward) traversals.push([te, false, 0, to.offset]);
      else traversals.push([te, true, tLen, to.offset]);
    }
    return {
      durationS: best,
      from,
      to,
      traversals: traversals.filter(
        ([, , s, t]) => Math.abs(t - s) > 1e-9 || traversals.length === 1,
      ),
      settled: pops,
    };
  }

  /** Points of one traversal, in travel order, as [lat, lon]. */
  function traversalPoints([e, reversed, startOffset, endOffset]) {
    const points = edgePoints(e);
    const length = pack.edgeLength[e];
    let total = 0;
    const along = [0];
    for (let s = 0; s + 1 < points.length; s++) {
      total += haversineMeters(
        points[s][0],
        points[s][1],
        points[s + 1][0],
        points[s + 1][1],
      );
      along.push(total);
    }
    const scale = total ? length / total : 0;
    const at = (offset) => {
      const target = scale ? offset / scale : 0;
      for (let s = 0; s + 1 < points.length; s++) {
        if (target <= along[s + 1] || s + 2 === points.length) {
          const span = along[s + 1] - along[s];
          const t = span
            ? Math.max(0, Math.min(1, (target - along[s]) / span))
            : 0;
          return [
            points[s][0] + t * (points[s + 1][0] - points[s][0]),
            points[s][1] + t * (points[s + 1][1] - points[s][1]),
          ];
        }
      }
      return points[points.length - 1];
    };
    const lo = Math.min(startOffset, endOffset);
    const hi = Math.max(startOffset, endOffset);
    const out = [at(lo)];
    for (let s = 1; s + 1 < points.length; s++) {
      const offset = along[s] * scale;
      if (offset > lo && offset < hi) out.push(points[s]);
    }
    out.push(at(hi));
    return reversed ? out.reverse() : out;
  }

  return Object.freeze({
    pack,
    bounds: pack.bounds,
    maxSpeed,
    snap,
    route,
    traversalPoints,
    edgeSpeed: (e) => speed[pack.edgeRoad[e]],
    vertexLat,
    vertexLon,
    arcsFrom: (v) => {
      const out = [];
      for (let arc = arcStart[v]; arc < arcStart[v + 1]; arc++)
        out.push({
          target: arcTarget[arc],
          edge: arcEdge[arc] >> 1,
          reversed: (arcEdge[arc] & 1) === 1,
          cost: arcCost[arc],
        });
      return out;
    },
    covers: (lat, lon) =>
      lat >= south && lat <= north && lon >= west && lon <= east,
  });
}
