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
    positionCartographic: { height },
    flyTo(options) {
      this.flights.push(options);
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
