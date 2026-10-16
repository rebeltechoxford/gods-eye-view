import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { cotTrailPositions, isAirborne } from './cotOverlay.js';

test('aircraft history uses each CoT ellipsoid height and omits unknown altitude fixes', () => {
  const aircraft = {
    type: 'a-f-A-M-F',
    point: { hae: 3000 },
    trail: [
      { lat: 35, lon: -89, hae: 2500 },
      { lat: 35.1, lon: -89, hae: null },
      { lat: 35.2, lon: -89, hae: 3000 },
    ],
  };
  assert.equal(isAirborne(aircraft), true);
  const positions = cotTrailPositions(aircraft);
  assert.equal(positions.length, 2);
  assert.ok(
    Math.abs(Cesium.Cartographic.fromCartesian(positions[0]).height - 2500) <
      0.001,
  );
  assert.ok(
    Math.abs(Cesium.Cartographic.fromCartesian(positions[1]).height - 3000) <
      0.001,
  );
  const ground = { ...aircraft, type: 'a-f-G-U-C' };
  assert.equal(isAirborne(ground), false);
  assert.ok(
    cotTrailPositions(ground).every(
      (point) =>
        Math.abs(Cesium.Cartographic.fromCartesian(point).height) < 0.001,
    ),
  );
});
