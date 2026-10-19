import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { flyToAustin } from '../camera.js';
import {
  DEFAULT_START_VIEW,
  START_VIEW_STORAGE_KEY,
  bindStartViewControls,
  captureStartView,
  flyToStartView,
  formatStartViewPlace,
  parseStartView,
  readStartView,
  restoreStartViewPrivacy,
} from './startView.js';
import {
  authorizeTakDisclosure,
  isTakPrivacyBlocked,
  markTakDataPrivate,
  takPrivacyState,
} from '../tak/privacy.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

function recordingViewer() {
  const calls = [];
  return {
    calls,
    isDestroyed: () => false,
    camera: {
      setView: (options) => calls.push(['setView', options]),
      flyTo: (options) => calls.push(['flyTo', options]),
      cancelFlight: () => calls.push(['cancel']),
    },
  };
}

const OXFORD = {
  label: '',
  lat: 34.3665,
  lon: -89.5192,
  height: 1800,
  heading: 20,
  pitch: -40,
};

test('stored views are validated; anything malformed falls back to the default', () => {
  assert.deepEqual(parseStartView(JSON.stringify(OXFORD)), OXFORD);
  for (const bad of [
    null,
    '',
    'not json',
    '[]',
    JSON.stringify({ ...OXFORD, lat: 91 }),
    JSON.stringify({ ...OXFORD, lon: -181 }),
    JSON.stringify({ ...OXFORD, height: 0 }),
    JSON.stringify({ ...OXFORD, height: 1e9 }),
    JSON.stringify({ ...OXFORD, pitch: 10 }),
    JSON.stringify({ ...OXFORD, heading: 'north' }),
    JSON.stringify({ lat: 1, lon: 2 }),
  ])
    assert.equal(parseStartView(bad), null, String(bad));
  const odd = parseStartView(
    JSON.stringify({
      ...OXFORD,
      heading: -30,
      label: 'Home\u0000\n' + 'x'.repeat(99),
    }),
  );
  assert.equal(odd.heading, 330);
  assert.equal(odd.label.length, 60);
  assert.ok(!/[\u0000-\u001f]/.test(odd.label));
  // Blocked storage reads as "no saved view".
  assert.equal(
    readStartView({
      getItem() {
        throw new Error('SecurityError');
      },
    }),
    null,
  );
});

test('the default start view flies in exactly as the original Austin start did', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const before = recordingViewer();
  flyToAustin(before);
  t.mock.timers.tick(600);
  const after = recordingViewer();
  flyToStartView(after, DEFAULT_START_VIEW);
  t.mock.timers.tick(600);
  const shape = (calls) =>
    calls.map(([kind, options]) => [
      kind,
      Cesium.Cartographic.fromCartesian(options.destination),
      options.orientation,
      options.duration,
    ]);
  const round = (value) =>
    JSON.parse(JSON.stringify(value), (_k, v) =>
      typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v,
    );
  assert.deepEqual(round(shape(after.calls)), round(shape(before.calls)));
});

test('a saved view flies in from above; a high view is set directly; teardown cancels', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const viewer = recordingViewer();
  flyToStartView(viewer, OXFORD);
  assert.equal(viewer.calls[0][0], 'setView');
  t.mock.timers.tick(600);
  const [kind, flight] = viewer.calls[1];
  assert.equal(kind, 'flyTo');
  const end = Cesium.Cartographic.fromCartesian(flight.destination);
  assert.ok(Math.abs(Cesium.Math.toDegrees(end.latitude) - OXFORD.lat) < 1e-9);
  assert.ok(Math.abs(end.height - OXFORD.height) < 1e-3);
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(flight.orientation.pitch) + 40) < 1e-9,
  );

  const high = recordingViewer();
  flyToStartView(high, { ...OXFORD, height: 9_000_000 });
  t.mock.timers.tick(600);
  assert.deepEqual(
    high.calls.map(([k]) => k),
    ['setView'],
  );

  const cancelled = recordingViewer();
  const stop = flyToStartView(cancelled, OXFORD);
  stop();
  t.mock.timers.tick(600);
  assert.deepEqual(
    cancelled.calls.map(([k]) => k),
    ['setView', 'cancel'],
  );
});

function fakeElement() {
  const listeners = {};
  return {
    textContent: '',
    title: '',
    hidden: false,
    addEventListener: (type, fn) => (listeners[type] = fn),
    removeEventListener: (type) => delete listeners[type],
    click: () => listeners.click?.(),
  };
}

function cameraAt({ lat, lon, height, heading, pitch }) {
  return {
    camera: {
      positionCartographic: Cesium.Cartographic.fromDegrees(lon, lat, height),
      heading: Cesium.Math.toRadians(heading),
      pitch: Cesium.Math.toRadians(pitch),
    },
  };
}

test('Start here saves the current camera view; Reset returns to the default', () => {
  const storage = memoryStorage();
  const elements = {
    status: fakeElement(),
    set: fakeElement(),
    clear: fakeElement(),
  };
  const toasts = [];
  const viewer = cameraAt(OXFORD);
  const controls = bindStartViewControls({
    viewer,
    elements,
    storage,
    showToast: (m) => toasts.push(m),
  });
  assert.equal(elements.status.textContent, 'Start view: Austin (default)');
  assert.equal(elements.clear.hidden, true);

  elements.set.click();
  const saved = readStartView(storage);
  assert.ok(Math.abs(saved.lat - OXFORD.lat) < 1e-9);
  assert.ok(Math.abs(saved.lon - OXFORD.lon) < 1e-9);
  assert.ok(Math.abs(saved.height - OXFORD.height) < 1e-3);
  assert.ok(Math.abs(saved.heading - OXFORD.heading) < 1e-9);
  assert.ok(Math.abs(saved.pitch - OXFORD.pitch) < 1e-9);
  assert.equal(
    elements.status.textContent,
    `Start view: ${formatStartViewPlace(OXFORD)}`,
  );
  assert.equal(formatStartViewPlace(OXFORD), '34.37°N 89.52°W');
  assert.equal(elements.clear.hidden, false);
  assert.match(toasts.at(-1), /open here: 34\.37°N 89\.52°W/);

  elements.clear.click();
  assert.equal(storage.data.has(START_VIEW_STORAGE_KEY), false);
  assert.equal(elements.status.textContent, 'Start view: Austin (default)');
  assert.equal(elements.clear.hidden, true);

  controls.destroy();
  elements.set.click();
  assert.equal(readStartView(storage), null, 'destroyed controls do nothing');
});

test('blocked storage is reported instead of pretending the view was saved', () => {
  const elements = {
    status: fakeElement(),
    set: fakeElement(),
    clear: fakeElement(),
  };
  const toasts = [];
  bindStartViewControls({
    viewer: cameraAt(OXFORD),
    elements,
    storage: {
      getItem: () => null,
      setItem() {
        throw new Error('QuotaExceededError');
      },
      removeItem() {},
    },
    showToast: (m) => toasts.push(m),
  });
  elements.set.click();
  assert.match(toasts[0], /storage is blocked/);
  assert.equal(elements.status.textContent, 'Start view: Austin (default)');
});

function startControls(viewer, storage, options = {}) {
  const elements = {
    status: fakeElement(),
    set: fakeElement(),
    clear: fakeElement(),
  };
  const toasts = [];
  const controls = bindStartViewControls({
    viewer,
    elements,
    storage,
    showToast: (message) => toasts.push(message),
    ...options,
  });
  return { elements, toasts, controls };
}

test('saved private cameras restore protection but never disclosure permissions', () => {
  const viewer = cameraAt(OXFORD);
  markTakDataPrivate(viewer);
  authorizeTakDisclosure(viewer, true);
  const storage = memoryStorage();
  const fixture = startControls(viewer, storage);
  fixture.elements.set.click();
  const record = JSON.parse(storage.data.get(START_VIEW_STORAGE_KEY));
  assert.equal(record.private, true);
  assert.equal(record.version, 2);
  assert.equal(Object.hasOwn(record, 'permissions'), false);
  const reloaded = recordingViewer();
  const view = restoreStartViewPrivacy(reloaded, { storage });
  assert.ok(Math.abs(view.lat - OXFORD.lat) < 1e-9);
  for (const scope of ['ai', 'sharing', 'recording'])
    assert.equal(isTakPrivacyBlocked(reloaded, scope), true, scope);
  assert.deepEqual(
    reloaded.calls,
    [],
    'privacy is restored before any camera move',
  );
  fixture.controls.destroy();
});

test('legacy views fail closed; an explicitly public version-two view stays public', () => {
  for (const record of [OXFORD, { ...OXFORD, private: false }]) {
    const viewer = {};
    const storage = memoryStorage({
      [START_VIEW_STORAGE_KEY]: JSON.stringify(record),
    });
    assert.equal(restoreStartViewPrivacy(viewer, { storage }).private, true);
    assert.equal(isTakPrivacyBlocked(viewer, 'sharing'), true);
  }
  const viewer = {};
  const storage = memoryStorage({
    [START_VIEW_STORAGE_KEY]: JSON.stringify({
      ...OXFORD,
      version: 2,
      private: false,
    }),
  });
  assert.equal(restoreStartViewPrivacy(viewer, { storage }).private, false);
  assert.equal(isTakPrivacyBlocked(viewer, 'ai'), false);
});

test('embedded and unavailable-account startup never read a personal saved view', () => {
  let reads = 0;
  const storage = {
    getItem() {
      reads++;
      return JSON.stringify(OXFORD);
    },
  };
  const viewer = {};
  assert.equal(
    restoreStartViewPrivacy(viewer, { storage, embedded: true }),
    null,
  );
  assert.equal(
    restoreStartViewPrivacy(viewer, { storage, storageKey: null }),
    null,
  );
  assert.equal(reads, 0, 'personal storage must not be read');
  assert.equal(takPrivacyState(viewer).private, false);
});

test('named storage keys do not inherit another operator or a legacy private camera', () => {
  const firstKey = `${START_VIEW_STORAGE_KEY}.${'a'.repeat(64)}`;
  const secondKey = `${START_VIEW_STORAGE_KEY}.${'b'.repeat(64)}`;
  const storage = memoryStorage({
    [START_VIEW_STORAGE_KEY]: JSON.stringify(OXFORD),
  });
  let current = true;
  const fixture = startControls(cameraAt(OXFORD), storage, {
    storageKey: firstKey,
    canUseStorage: () => current,
  });
  assert.equal(readStartView(storage, firstKey), null);
  fixture.elements.set.click();
  assert.ok(readStartView(storage, firstKey));
  assert.equal(readStartView(storage, secondKey), null);
  current = false;
  fixture.elements.clear.click();
  assert.ok(
    readStartView(storage, firstKey),
    'retired account cannot erase its saved view',
  );
  fixture.elements.set.click();
  assert.match(fixture.toasts.at(-1), /not saved/);
  assert.equal(readStartView(storage, secondKey), null);
  fixture.controls.destroy();
});

test('missing or silently blocked storage cannot report a successful save', () => {
  for (const storage of [null, {}, { getItem: () => null, setItem() {} }]) {
    const fixture = startControls(cameraAt(OXFORD), storage);
    fixture.elements.set.click();
    assert.match(fixture.toasts.at(-1), /not saved/);
    assert.equal(
      fixture.elements.status.textContent,
      'Start view: Austin (default)',
    );
    fixture.controls.destroy();
  }
});

test('failed Reset retains the saved view and reports failure instead of success', () => {
  for (const removeItem of [
    () => {},
    () => {
      throw new Error('SecurityError');
    },
  ]) {
    const storage = memoryStorage({
      [START_VIEW_STORAGE_KEY]: JSON.stringify(OXFORD),
    });
    storage.removeItem = removeItem;
    const fixture = startControls(cameraAt(OXFORD), storage);
    fixture.elements.clear.click();
    assert.match(fixture.toasts.at(-1), /not reset/);
    assert.equal(fixture.elements.clear.hidden, false);
    assert.equal(readStartView(storage).lat, OXFORD.lat);
    assert.equal(
      fixture.elements.status.textContent,
      `Start view: ${formatStartViewPlace(OXFORD)}`,
    );
    fixture.controls.destroy();
  }
});

test('a camera looking above the horizon is saved level, not rejected', () => {
  const view = captureStartView(cameraAt({ ...OXFORD, pitch: 12 }));
  assert.equal(view.pitch, 0);
});

test('the deployment default comes from VITE_GEV_START_VIEW; anything else is Austin', async () => {
  const { START_VIEW_PRESETS, resolveDefaultStartView } =
    await import('./startView.js');
  assert.equal(resolveDefaultStartView('oxford'), START_VIEW_PRESETS.oxford);
  assert.equal(resolveDefaultStartView(' Oxford '), START_VIEW_PRESETS.oxford);
  assert.equal(resolveDefaultStartView('austin'), START_VIEW_PRESETS.austin);
  for (const value of [undefined, '', 'paris', '91,0', '1,2,3', 'toString'])
    assert.equal(
      resolveDefaultStartView(value),
      START_VIEW_PRESETS.austin,
      String(value),
    );
  const point = resolveDefaultStartView('34.40,-89.50');
  assert.equal(point.lat, 34.4);
  assert.equal(point.lon, -89.5);
  assert.equal(point.pitch, -90);
  assert.equal(point.label, '34.40°N 89.50°W');
  // Unit tests and unconfigured builds keep the original load view.
  assert.equal(DEFAULT_START_VIEW, START_VIEW_PRESETS.austin);
});

test('the Oxford view looks at the Square', async () => {
  const { START_VIEW_PRESETS } = await import('./startView.js');
  const view = START_VIEW_PRESETS.oxford;
  // Where the view's centre line meets flat ground, on a local tangent plane.
  const reach = view.height / Math.tan(Cesium.Math.toRadians(-view.pitch));
  const heading = Cesium.Math.toRadians(view.heading);
  const lat = view.lat + (reach * Math.cos(heading)) / 110_950;
  const lon =
    view.lon +
    (reach * Math.sin(heading)) /
      (111_320 * Math.cos(Cesium.Math.toRadians(view.lat)));
  const square = { lat: 34.3662, lon: -89.5192 };
  const metres = Math.hypot(
    (lat - square.lat) * 110_950,
    (lon - square.lon) * 111_320 * Math.cos(Cesium.Math.toRadians(square.lat)),
  );
  assert.ok(metres < 50, `centre line lands ${metres.toFixed(0)} m away`);
});
