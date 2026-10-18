// Turn an offline route into the Directions payload the existing layer
// renders: { ok, profile, distanceM, durationS, geometry, steps }. Steps use
// OSRM's maneuver vocabulary and src/data/routeSteps.js phrasing, so offline
// and online directions read the same. Portable.

import { ROUTE_STEPS_MAX, instructionFor } from '../data/routeSteps.js';
import { ROAD_CLASSES, isLinkClass } from './osmRoads.js';
import { ROAD_FLAGS, roadPackString, unpackRoadWord } from './roadPack.js';
import { bearingDegrees, haversineMeters } from './router.js';

const HIGHWAY_CLASSES = new Set(['motorway', 'trunk']);
/** Bearings are measured over this distance, so short kinks do not read as turns. */
const BEARING_SPAN_M = 20;

function roadOf(pack, edge) {
  const r = pack.edgeRoad[edge];
  const { classIndex, flags } = unpackRoadWord(pack.roads[r * 3]);
  return {
    classIndex,
    className: ROAD_CLASSES[classIndex],
    roundabout: (flags & ROAD_FLAGS.roundabout) !== 0,
    name: roadPackString(pack, pack.roads[r * 3 + 1]),
    ref: roadPackString(pack, pack.roads[r * 3 + 2]),
  };
}

const sameRoad = (a, b) =>
  a.name || a.ref
    ? a.name === b.name && a.ref === b.ref
    : !b.name && !b.ref && a.classIndex === b.classIndex;

/** Bearing leaving `points[0]` (or arriving at the last point when `end`). */
function bearingAt(points, end) {
  const seq = end ? [...points].reverse() : points;
  const [lat0, lon0] = seq[0];
  let target = seq[seq.length - 1];
  let travelled = 0;
  for (let i = 1; i < seq.length; i++) {
    travelled += haversineMeters(
      seq[i - 1][0],
      seq[i - 1][1],
      seq[i][0],
      seq[i][1],
    );
    if (travelled >= BEARING_SPAN_M) {
      target = seq[i];
      break;
    }
  }
  const bearing = bearingDegrees(lat0, lon0, target[0], target[1]);
  return end ? (bearing + 180) % 360 : bearing;
}

/** Signed turn angle, -180..180, positive to the right. */
export function turnAngle(inBearing, outBearing) {
  return ((outBearing - inBearing + 540) % 360) - 180;
}

export function modifierFor(angle) {
  const a = Math.abs(angle);
  const side = angle > 0 ? 'right' : 'left';
  if (a < 20) return 'straight';
  if (a < 45) return `slight ${side}`;
  if (a < 135) return side;
  if (a < 170) return `sharp ${side}`;
  return 'uturn';
}

const toward = (angle, modifier) =>
  modifier === 'straight'
    ? angle >= 0
      ? 'slight right'
      : 'slight left'
    : modifier;

/**
 * Route between two points with a loaded router and build the payload.
 * @param {ReturnType<import('./router.js').createRoadRouter>} router
 * @param {{a:{lat:number,lon:number}, b:{lat:number,lon:number}}} request
 * @param {{signal?:AbortSignal}} [options]
 */
export function offlineDirections(router, { a, b }, { signal } = {}) {
  const { pack } = router;
  const result = router.route(a, b, { signal });
  const pieces = result.traversals.map((traversal) => {
    const [edge, reversed, start, end] = traversal;
    const length = Math.abs(end - start);
    return {
      edge,
      reversed,
      points: router.traversalPoints(traversal),
      road: roadOf(pack, edge),
      length,
      duration: length / router.edgeSpeed(edge),
      endVertex: reversed ? pack.edgeFrom[edge] : pack.edgeTo[edge],
    };
  });

  const geometry = [];
  for (const piece of pieces)
    for (const [lat, lon] of piece.points) {
      const point = [Number(lon.toFixed(6)), Number(lat.toFixed(6))];
      const last = geometry[geometry.length - 1];
      if (!last || last[0] !== point[0] || last[1] !== point[1])
        geometry.push(point);
    }

  const steps = [];
  const open = (type, modifier, road, point, exit = null) => ({
    type,
    modifier,
    exit,
    name: road.name,
    ref: road.ref || null,
    distanceM: 0,
    durationS: 0,
    lat: point[0],
    lon: point[1],
  });
  let current = open('depart', null, pieces[0].road, pieces[0].points[0]);
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (i > 0) {
      const prev = pieces[i - 1];
      const angle = turnAngle(
        bearingAt(prev.points, true),
        bearingAt(piece.points, false),
      );
      let modifier = modifierFor(angle);
      const options = router
        .arcsFrom(prev.endVertex)
        .filter(
          (arc) => !(arc.edge === prev.edge && arc.reversed !== prev.reversed),
        ).length;
      let next = null;
      if (piece.road.roundabout && !prev.road.roundabout) {
        // Count exits passed until the route leaves the roundabout.
        let exit = 0;
        let leaving = piece.road;
        for (let j = i; j < pieces.length; j++) {
          const exits = router
            .arcsFrom(pieces[j - 1].endVertex)
            .filter((arc) => !roadOf(pack, arc.edge).roundabout).length;
          if (j > i && exits) exit++;
          if (!pieces[j].road.roundabout) {
            leaving = pieces[j].road;
            break;
          }
        }
        next = open(
          'roundabout',
          null,
          leaving,
          prev.points[prev.points.length - 1],
          exit || null,
        );
      } else if (prev.road.roundabout) {
        next = null; // inside or leaving: folded into the roundabout step
      } else if (
        !isLinkClass(prev.road.classIndex) &&
        isLinkClass(piece.road.classIndex)
      ) {
        const type = HIGHWAY_CLASSES.has(prev.road.className)
          ? 'off ramp'
          : 'on ramp';
        next = open(type, toward(angle, modifier), piece.road, piece.points[0]);
      } else if (
        isLinkClass(prev.road.classIndex) &&
        !isLinkClass(piece.road.classIndex)
      ) {
        if (HIGHWAY_CLASSES.has(piece.road.className))
          next = open(
            'merge',
            toward(angle, modifier),
            piece.road,
            piece.points[0],
          );
        else
          next = open(
            modifier === 'straight' ? 'new name' : 'turn',
            modifier,
            piece.road,
            piece.points[0],
          );
      } else if (sameRoad(prev.road, piece.road)) {
        if (options > 1 && Math.abs(angle) >= 45)
          next = open('continue', modifier, piece.road, piece.points[0]);
      } else if (
        modifier === 'straight' ||
        (options <= 1 && Math.abs(angle) < 45)
      ) {
        next = open(
          'new name',
          modifier === 'straight' ? null : modifier,
          piece.road,
          piece.points[0],
        );
      } else {
        next = open('turn', modifier, piece.road, piece.points[0]);
      }
      if (next) {
        steps.push(current);
        current = next;
      }
    }
    current.distanceM += piece.length;
    current.durationS += piece.duration;
  }
  steps.push(current);
  const last = pieces[pieces.length - 1];
  steps.push(
    open('arrive', null, last.road, last.points[last.points.length - 1]),
  );

  const truncated = steps.length > ROUTE_STEPS_MAX;
  const finalSteps = steps.slice(0, ROUTE_STEPS_MAX).map((step, index) => {
    const out = {
      index,
      type: step.type,
      modifier: step.modifier,
      exit: step.exit,
      name: step.name,
      ref: step.ref,
      distanceM: Math.max(0, Math.round(step.distanceM)),
      durationS: Math.max(0, Math.round(step.durationS)),
      lon: Number(step.lon.toFixed(6)),
      lat: Number(step.lat.toFixed(6)),
      instruction: '',
    };
    out.instruction = instructionFor(out);
    return out;
  });
  const distanceM = pieces.reduce((sum, piece) => sum + piece.length, 0);
  return {
    ok: true,
    profile: 'car',
    distanceM: Math.round(distanceM),
    durationS: Math.round(result.durationS),
    geometry,
    steps: finalSteps,
    ...(truncated ? { stepsTruncated: true } : {}),
    offline: {
      pack: pack.metadata.name || null,
      edition: pack.metadata.source?.edition || null,
      attribution: pack.metadata.attribution || '© OpenStreetMap contributors',
      snapStartM: Math.round(result.from.distance),
      snapEndM: Math.round(result.to.distance),
    },
  };
}
