import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  MY_LOCATION_FRAME_HEIGHT_M,
  MY_LOCATION_STALE_MS,
  createMyLocation,
} from './myLocation.js';

function fakeButton() {
  const listeners = {};
  const attributes = {};
  return {
    dataset: {},
    title: '',
    attributes,
    setAttribute: (name, value) => (attributes[name] = value),
    addEventListener: (type, fn) => (listeners[type] = fn),
    removeEventListener: (type) => delete listeners[type],
    click: () => listeners.click?.(),
  };
}

function fakeViewer({ height = 20_000_000 } = {}) {
  const canvas = new EventTarget();
  const added = [];
  const removed = [];
  const camera = {
    heading: 0.3,
    flights: [],
    views: [],
    cancelledFlights: 0,
    positionCartographic: { height },
    flyTo(options) {
      this.flights.push(options);
    },
    cancelFlight() {
      this.cancelledFlights++;
      this.flights.at(-1)?.cancel?.();
    },
    setView(options) {
      this.views.push(options);
      const carto = Cesium.Cartographic.fromCartesian(options.destination);
      this.positionCartographic = { height: carto.height };
    },
  };
  return {
    camera,
    canvas,
    added,
    removed,
    renders: 0,
    dataSources: {
      add: (source) => added.push(source),
      remove: (source) => removed.push(source),
    },
    scene: {
      canvas,
      globe: { getHeight: () => 150 },
      requestRender() {
        this.owner.renders++;
      },
    },
  };
}

function setup({ grant = true, ...viewerOptions } = {}) {
  const viewer = fakeViewer(viewerOptions);
  viewer.scene.owner = viewer;
  const button = fakeButton();
  const toasts = [];
  let handoff = null;
  let now = 1_000_000;
  const location = {
    started: 0,
    stopped: 0,
    onFix: null,
    onError: null,
    start(onFix, onError) {
      this.started++;
      this.onFix = onFix;
      this.onError = onError;
      return true;
    },
    stop() {
      this.stopped++;
    },
    isActive: () => true,
  };
  const claims = [];
  const privacy = [];
  const control = createMyLocation({
    viewer,
    button,
    location,
    navigation: {
      run(noun, move) {
        claims.push(noun);
        // A real claim stamps a handoff while it runs.
        handoff?.();
        return grant ? move() : false;
      },
      subscribeHandoff(listener) {
        handoff = listener;
        return () => (handoff = null);
      },
    },
    onPrivate: () => privacy.push(location.onFix ? 'fix' : 'early'),
    showToast: (message) => toasts.push(message),
    isSecureContext: () => true,
    now: () => now,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  const dataSource = viewer.added[0];
  const entity = (id) => dataSource.entities.getById(id);
  return {
    viewer,
    button,
    toasts,
    location,
    claims,
    privacy,
    control,
    entity,
    handoff: () => handoff?.(),
    fix: (lat, lon, ce = 12) =>
      location.onFix({ lat, lon, ce, observedAtMs: now }),
    advance: (ms) => (now += ms),
  };
}

test('first tap finds you, draws the dot and ring, and follows', () => {
  const t = setup();
  assert.equal(t.button.dataset.state, 'off');
  assert.equal(t.button.attributes['aria-pressed'], 'false');
  t.button.click();
  assert.equal(t.location.started, 1);
  assert.equal(t.button.dataset.state, 'locating');
  assert.equal(t.entity('my-location').show, false, 'no dot before a fix');
  assert.deepEqual(t.privacy, [], 'nothing is private until a position exists');
  t.fix(34.3665, -89.5192, 9);
  assert.deepEqual(t.privacy, ['fix'], 'the first fix marks the view private');
  const dot = t.entity('my-location');
  const ring = t.entity('my-location-accuracy');
  assert.equal(dot.show, true);
  assert.equal(ring.show, true);
  assert.equal(ring.ellipse.semiMajorAxis.getValue(), 9);
  const carto = Cesium.Cartographic.fromCartesian(
    dot.position.getValue(Cesium.JulianDate.now()),
  );
  assert.ok(Math.abs(Cesium.Math.toDegrees(carto.latitude) - 34.3665) < 1e-9);
  assert.deepEqual(t.claims, ['location'], 'the camera is claimed once');
  assert.equal(t.control.state(), 'following');
  assert.equal(t.button.dataset.state, 'following');
  const flight = t.viewer.camera.flights[0];
  const target = Cesium.Cartographic.fromCartesian(flight.destination);
  assert.equal(
    Math.round(target.height),
    150 + MY_LOCATION_FRAME_HEIGHT_M,
    'a whole-globe view comes down to the framing height above ground',
  );
  assert.equal(flight.orientation.heading, 0.3, 'map bearing is kept');
  assert.ok(t.viewer.renders > 0, 'request-render mode is asked to redraw');
  t.fix(34.3666, -89.5193, 9);
  assert.equal(t.privacy.length, 1, 'marked private once');
});

test('following moves the camera with each fix at the current zoom, without new claims', () => {
  const t = setup({ height: 900 });
  t.button.click();
  t.fix(34, -89);
  t.viewer.camera.flights[0].complete();
  t.fix(34.001, -89.001);
  assert.equal(t.claims.length, 1);
  const view = t.viewer.camera.views.at(-1);
  const carto = Cesium.Cartographic.fromCartesian(view.destination);
  assert.ok(Math.abs(Cesium.Math.toDegrees(carto.latitude) - 34.001) < 1e-9);
  assert.equal(Math.round(carto.height), 900, 'a closer zoom is kept');
});

test('flight completion uses the safe destination height, not an intermediate underground pose', () => {
  const t = setup({ height: 900 });
  t.button.click();
  t.fix(34, -89);
  t.viewer.camera.positionCartographic.height = -52_893;
  t.viewer.camera.flights[0].complete();
  const target = Cesium.Cartographic.fromCartesian(
    t.viewer.camera.views.at(-1).destination,
  );
  assert.equal(Math.round(target.height), 900);
  assert.equal(t.control.state(), 'following');
});

test('later fixes cannot preserve an underground or non-finite camera height', () => {
  const t = setup({ height: 900 });
  t.button.click();
  t.fix(34, -89);
  t.viewer.camera.flights[0].complete();
  for (const height of [-52_893, 0, NaN, Infinity]) {
    t.viewer.camera.positionCartographic.height = height;
    t.fix(34.001, -89.001);
    const target = Cesium.Cartographic.fromCartesian(
      t.viewer.camera.views.at(-1).destination,
    );
    assert.ok(Number.isFinite(target.height));
    assert.ok(target.height >= 150 + 300 - 0.001, String(height));
  }
  t.viewer.scene.globe.getHeight = () => 2_000;
  t.viewer.camera.positionCartographic.height = 900;
  t.fix(34.002, -89.002);
  const uphill = Cesium.Cartographic.fromCartesian(
    t.viewer.camera.views.at(-1).destination,
  );
  assert.ok(uphill.height >= 2_300 - 0.001, 'new terrain also owns clearance');
});

test('coarse terrain below the ellipsoid cannot bury first framing or later FOLLOW', () => {
  // Globe.getHeight samples loaded triangles, not the ideal ellipsoid. These
  // initial mesh depths produce the negative destinations seen in browser QA
  // even though the mesh subsequently refines toward zero metres.
  for (const meshHeight of [-11_189, -2_511.7, -12.7, -0.006]) {
    const t = setup();
    t.viewer.scene.globe.getHeight = () => meshHeight;
    t.button.click();
    t.fix(34.3665, -89.5192);
    const flight = t.viewer.camera.flights[0];
    assert.equal(
      Math.round(Cesium.Cartographic.fromCartesian(flight.destination).height),
      MY_LOCATION_FRAME_HEIGHT_M,
      `first destination stays above the reference surface for mesh ${meshHeight}`,
    );
    flight.complete();
    assert.equal(
      Math.round(t.viewer.camera.positionCartographic.height),
      MY_LOCATION_FRAME_HEIGHT_M,
    );
    // Neither an invalid incoming pose nor the next stale coarse-mesh sample
    // may reduce the follow floor below 300 m above the reference ellipsoid.
    t.viewer.camera.positionCartographic.height = -8_689;
    t.fix(34.3666, -89.5193);
    assert.equal(Math.round(t.viewer.camera.positionCartographic.height), 300);
    t.viewer.scene.globe.getHeight = () => 0;
    t.fix(34.3667, -89.5194);
    assert.equal(Math.round(t.viewer.camera.positionCartographic.height), 300);
    t.control.destroy();
  }
});

test('navigation or a drag before the first fix prevents a delayed camera takeover', () => {
  for (const gesture of ['handoff', 'drag']) {
    const t = setup();
    t.button.click();
    if (gesture === 'handoff') t.handoff();
    else {
      for (const [type, x] of [
        ['pointerdown', 0],
        ['pointermove', 20],
      ]) {
        const event = new Event(type);
        Object.assign(event, { pointerId: 1, clientX: x, clientY: 0 });
        t.viewer.canvas.dispatchEvent(event);
      }
    }
    t.fix(34, -89);
    assert.equal(t.control.state(), 'shown', gesture);
    assert.equal(t.entity('my-location').show, true, gesture);
    assert.equal(t.viewer.camera.flights.length, 0, gesture);
    assert.equal(t.viewer.camera.views.length, 0, gesture);
    t.button.click();
    assert.equal(
      t.control.state(),
      'following',
      'a new explicit tap can follow',
    );
    assert.equal(t.viewer.camera.flights.length, 1);
    t.control.destroy();
  }
});

test('off, handoff and teardown cancel only the owned flight and fence old callbacks', () => {
  for (const action of ['off', 'handoff', 'destroy']) {
    const t = setup();
    t.button.click();
    t.fix(34, -89);
    const oldFlight = t.viewer.camera.flights[0];
    if (action === 'off') t.button.click();
    else if (action === 'handoff') t.handoff();
    else t.control.destroy();
    assert.equal(t.viewer.camera.cancelledFlights, 1, action);
    oldFlight.complete();
    assert.equal(
      t.viewer.camera.views.length,
      0,
      'retired completion does not move',
    );
    if (action !== 'destroy') {
      if (action === 'off') {
        t.button.click();
        t.fix(35, -90);
      } else t.button.click();
      const newFlight = t.viewer.camera.flights.at(-1);
      oldFlight.cancel();
      oldFlight.complete();
      t.fix(35.01, -90.01);
      assert.equal(
        t.viewer.camera.views.length,
        0,
        'old callbacks cannot finish the new flight',
      );
      newFlight.complete();
      assert.equal(t.viewer.camera.views.length, 1);
      t.handoff();
      assert.equal(
        t.viewer.camera.cancelledFlights,
        1,
        'completed flights are not owned',
      );
      t.control.destroy();
    }
  }
});

test('a drag or another camera owner ends FOLLOW but keeps the dot; tap follows again', () => {
  const t = setup();
  t.button.click();
  t.fix(34, -89);
  t.viewer.camera.flights[0].complete();
  const pointer = (type, x, y, pointerId = 1) => {
    const event = new Event(type);
    Object.assign(event, { pointerId, clientX: x, clientY: y });
    t.viewer.canvas.dispatchEvent(event);
  };
  // A pinch (two pointers) keeps FOLLOW.
  pointer('pointerdown', 0, 0, 1);
  pointer('pointerdown', 50, 0, 2);
  pointer('pointermove', 30, 30, 1);
  assert.equal(t.control.state(), 'following');
  pointer('pointerup', 30, 30, 1);
  pointer('pointerup', 50, 0, 2);
  // A one-finger drag hands the camera back.
  pointer('pointerdown', 0, 0);
  pointer('pointermove', 20, 0);
  assert.equal(t.control.state(), 'shown');
  const views = t.viewer.camera.views.length;
  t.fix(34.01, -89.01);
  assert.equal(t.viewer.camera.views.length, views, 'the camera stays put');
  assert.equal(t.entity('my-location').show, true, 'the dot keeps updating');
  t.button.click();
  assert.equal(t.control.state(), 'following');
  assert.equal(t.claims.length, 2);
  t.viewer.camera.flights.at(-1).complete();
  t.handoff(); // e.g. the user tracks an aircraft
  assert.equal(t.control.state(), 'shown');
});

test('a refused claim (cockpit) shows the dot without moving the camera', () => {
  const t = setup({ grant: false });
  t.button.click();
  t.fix(34, -89);
  assert.equal(t.control.state(), 'shown');
  assert.equal(t.viewer.camera.flights.length, 0);
  assert.equal(t.entity('my-location').show, true);
});

test('tap while following turns it off and releases the device watch', () => {
  const t = setup();
  t.button.click();
  t.fix(34, -89);
  t.button.click();
  assert.equal(t.control.state(), 'off');
  assert.equal(t.location.stopped, 1);
  assert.equal(t.entity('my-location').show, false);
  assert.equal(t.entity('my-location-accuracy').show, false);
  assert.equal(t.button.attributes['aria-pressed'], 'false');
  t.location.onFix?.({ lat: 1, lon: 2, observedAtMs: 0 });
  assert.equal(t.entity('my-location').show, false, 'late fixes are ignored');
});

test('a device error turns it off and says why', () => {
  const t = setup();
  t.button.click();
  t.location.onError('Device GPS unavailable: User denied Geolocation');
  assert.equal(t.control.state(), 'off');
  assert.match(t.toasts[0], /denied/);
});

test('without HTTPS it explains instead of asking the device', () => {
  const viewer = fakeViewer();
  viewer.scene.owner = viewer;
  const button = fakeButton();
  const toasts = [];
  let started = 0;
  createMyLocation({
    viewer,
    button,
    location: {
      start: () => ++started,
      stop() {},
      isActive: () => false,
    },
    showToast: (message) => toasts.push(message),
    isSecureContext: () => false,
  });
  button.click();
  assert.equal(started, 0);
  assert.match(toasts[0], /HTTPS/);
  assert.equal(button.dataset.state, 'off');
});

test('an old fix is drawn gray', () => {
  const t = setup();
  t.button.click();
  t.fix(34, -89);
  assert.equal(t.button.dataset.stale, 'false');
  t.advance(MY_LOCATION_STALE_MS + 1);
  t.location.onFix({ lat: 34, lon: -89, ce: 5, observedAtMs: 1_000_000 });
  assert.equal(t.button.dataset.stale, 'true');
  const color = t.entity('my-location').point.color.getValue();
  assert.notDeepEqual(color, Cesium.Color.fromCssColorString('#1a73e8'));
});

test('destroy removes the layer, listeners and device watch', () => {
  const t = setup();
  t.button.click();
  t.fix(34, -89);
  t.control.destroy();
  assert.equal(t.viewer.removed.length, 1);
  assert.equal(t.location.stopped, 1);
  t.button.click();
  assert.equal(t.location.started, 1, 'the button no longer acts');
});
