import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRoadPack } from './roadPack.js';
import { createRoadRouter } from './router.js';
import {
  modifierFor,
  offlineDirections,
  turnAngle,
} from './offlineDirections.js';
import { syntheticPack } from '../testSupport/roadGraph.mjs';

const directions = (spec, a, b) =>
  offlineDirections(createRoadRouter(decodeRoadPack(syntheticPack(spec))), {
    a,
    b,
  });
const kinds = (payload) =>
  payload.steps.map((step) => [
    step.type,
    step.modifier,
    step.name || step.ref,
  ]);

test('turn angles map to OSRM modifiers', () => {
  assert.equal(turnAngle(0, 90), 90);
  assert.equal(turnAngle(350, 10), 20);
  assert.equal(turnAngle(10, 350), -20);
  assert.equal(modifierFor(5), 'straight');
  assert.equal(modifierFor(-30), 'slight left');
  assert.equal(modifierFor(90), 'right');
  assert.equal(modifierFor(-150), 'sharp left');
  assert.equal(modifierFor(178), 'uturn');
});

test('a T-junction left turn reads like the online directions', () => {
  // Main Street runs east; Oak Street leaves north from vertex 1.
  const payload = directions(
    {
      vertices: [
        [34.36, -89.53],
        [34.36, -89.52],
        [34.36, -89.51],
        [34.37, -89.52],
      ],
      edges: [
        { from: 0, to: 1, road: { name: 'Main Street' } },
        { from: 1, to: 2, road: { name: 'Main Street' } },
        { from: 1, to: 3, road: { name: 'Oak Street' } },
      ],
    },
    { lat: 34.36, lon: -89.528 },
    { lat: 34.368, lon: -89.52 },
  );
  assert.deepEqual(kinds(payload), [
    ['depart', null, 'Main Street'],
    ['turn', 'left', 'Oak Street'],
    ['arrive', null, 'Oak Street'],
  ]);
  assert.equal(payload.steps[1].instruction, 'Turn left onto Oak Street');
  assert.equal(payload.steps[0].instruction, 'Head out on Main Street');
  assert.equal(payload.profile, 'car');
  // Step distances add up to the route, and geometry ends at the snapped points.
  const stepTotal = payload.steps.reduce(
    (sum, step) => sum + step.distanceM,
    0,
  );
  assert.ok(Math.abs(stepTotal - payload.distanceM) <= payload.steps.length);
  assert.deepEqual(payload.geometry[0], [-89.528, 34.36]);
  assert.deepEqual(payload.geometry.at(-1), [-89.52, 34.368]);
  assert.match(payload.offline.attribution, /OpenStreetMap/);
});

test('a straight name change reads "Continue onto"', () => {
  const payload = directions(
    {
      vertices: [
        [34.36, -89.53],
        [34.36, -89.52],
        [34.36, -89.51],
      ],
      edges: [
        { from: 0, to: 1, road: { name: 'Jackson Avenue', ref: 'MS 6' } },
        { from: 1, to: 2, road: { name: 'University Avenue', ref: 'MS 6' } },
      ],
    },
    { lat: 34.36, lon: -89.529 },
    { lat: 34.36, lon: -89.511 },
  );
  assert.deepEqual(kinds(payload), [
    ['depart', null, 'Jackson Avenue'],
    ['new name', null, 'University Avenue'],
    ['arrive', null, 'University Avenue'],
  ]);
  assert.equal(
    payload.steps[1].instruction,
    'Continue onto University Avenue (MS 6)',
  );
});

test('roundabouts count exits and fold the exit into one instruction', () => {
  // US-style counterclockwise ring: S → E → N → W → S, with an arm at each.
  const c = [34.36, -89.52];
  const d = 0.0005;
  const ring = { highway: 'tertiary', speedKmh: 25, roundabout: true };
  const payload = directions(
    {
      vertices: [
        [c[0] - d, c[1]], // 0 S
        [c[0], c[1] + d], // 1 E
        [c[0] + d, c[1]], // 2 N
        [c[0], c[1] - d], // 3 W
        [c[0] - 0.006, c[1]], // 4 south arm
        [c[0], c[1] + 0.006], // 5 east arm
        [c[0] + 0.006, c[1]], // 6 north arm
        [c[0], c[1] - 0.006], // 7 west arm
      ],
      edges: [
        { from: 0, to: 1, oneway: true, road: ring },
        { from: 1, to: 2, oneway: true, road: ring },
        { from: 2, to: 3, oneway: true, road: ring },
        { from: 3, to: 0, oneway: true, road: ring },
        { from: 4, to: 0, road: { name: 'South Street' } },
        { from: 1, to: 5, road: { name: 'East Street' } },
        { from: 2, to: 6, road: { name: 'North Street' } },
        { from: 3, to: 7, road: { name: 'West Street' } },
      ],
    },
    { lat: c[0] - 0.005, lon: c[1] },
    { lat: c[0], lon: c[1] - 0.005 },
  );
  assert.deepEqual(
    payload.steps.map((step) => step.instruction),
    [
      'Head out on South Street',
      'At the roundabout, take the 3rd exit onto West Street',
      'Arrive at your destination',
    ],
  );
  assert.equal(payload.steps[1].exit, 3);
});

test('highway ramps produce on-ramp, merge and off-ramp steps', () => {
  const payload = directions(
    {
      vertices: [
        [34.3, -89.6], // 0 town road
        [34.3, -89.59], // 1 ramp start
        [34.305, -89.585], // 2 merge onto I-22
        [34.31, -89.55], // 3 exit split
        [34.312, -89.545], // 4 ramp end
        [34.32, -89.545], // 5 destination road
      ],
      edges: [
        {
          from: 0,
          to: 1,
          road: { highway: 'primary', name: 'Old Highway', speedKmh: 72 },
        },
        {
          from: 1,
          to: 2,
          oneway: true,
          road: { highway: 'motorway_link', speedKmh: 60 },
        },
        {
          from: 2,
          to: 3,
          oneway: true,
          road: { highway: 'motorway', ref: 'I 22', speedKmh: 105 },
        },
        {
          from: 3,
          to: 4,
          oneway: true,
          road: { highway: 'motorway_link', speedKmh: 60 },
        },
        {
          from: 4,
          to: 5,
          road: { highway: 'secondary', name: 'Tupelo Road', speedKmh: 72 },
        },
      ],
    },
    { lat: 34.3, lon: -89.599 },
    { lat: 34.319, lon: -89.545 },
  );
  assert.deepEqual(
    payload.steps.map((step) => step.type),
    ['depart', 'on ramp', 'merge', 'off ramp', 'turn', 'arrive'],
  );
  assert.equal(payload.steps[2].instruction, 'Merge slightly right onto I 22');
  assert.match(payload.steps[3].instruction, /^Take the exit slightly left$/);
});
