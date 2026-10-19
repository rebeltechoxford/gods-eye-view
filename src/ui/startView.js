import * as Cesium from 'cesium';
import { markTakDataPrivate, takPrivacyState } from '../tak/privacy.js';

// The view the app opens on when no share link or saved map area says
// otherwise. Saved on this device only, by "Start here" in the Location tray.
export const START_VIEW_STORAGE_KEY = 'gev.startView.v1';
// Built-in start views. Each camera sits about 1 km south-southwest of its
// subject, 600 m up, looking 30° down at it.
export const START_VIEW_PRESETS = Object.freeze({
  // Downtown Austin, the original project's load view. Builds without
  // VITE_GEV_START_VIEW (CI and the browser gates) keep it.
  austin: Object.freeze({
    label: 'Austin',
    lat: 30.2672,
    lon: -97.7431,
    height: 600,
    heading: 15,
    pitch: -30,
  }),
  // The Square, Oxford, MS (Lafayette County Courthouse at 34.3662, -89.5192).
  oxford: Object.freeze({
    label: 'Oxford',
    lat: 34.3572,
    lon: -89.5221,
    height: 600,
    heading: 15,
    pitch: -30,
  }),
});

/**
 * The deployment's default start view from `VITE_GEV_START_VIEW`: a preset
 * name (`oxford`, `austin`) or `lat,lon` (a straight-down view 2.5 km up).
 * Anything else, or nothing, is Austin.
 */
export function resolveDefaultStartView(setting) {
  const value = String(setting ?? '')
    .trim()
    .toLowerCase();
  if (Object.hasOwn(START_VIEW_PRESETS, value))
    return START_VIEW_PRESETS[value];
  const match = value.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (match) {
    const view = parseStartView(
      JSON.stringify({
        label: '',
        lat: Number(match[1]),
        lon: Number(match[2]),
        height: 2_500,
        heading: 0,
        pitch: -90,
      }),
    );
    if (view)
      return Object.freeze({ ...view, label: formatStartViewPlace(view) });
  }
  return START_VIEW_PRESETS.austin;
}
// The startup flight begins this high, straight down, then flies in.
const APPROACH_HEIGHT_M = 25_000;
const MAX_HEIGHT_M = 40_000_000;
const MAX_LABEL = 60;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** A stored view, or null when it is missing, malformed or out of range. */
export function parseStartView(raw) {
  let value;
  try {
    value = typeof raw === 'string' ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const { lat, lon, height, heading, pitch } = value;
  if (![lat, lon, height, heading, pitch].every(finite)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (height < 1 || height > MAX_HEIGHT_M) return null;
  if (pitch < -90 || pitch > 0) return null;
  const label =
    typeof value.label === 'string'
      ? value.label.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_LABEL)
      : '';
  return {
    label,
    lat,
    lon,
    height,
    heading: ((heading % 360) + 360) % 360,
    pitch,
  };
}

function safeStorage(storage) {
  return {
    get(key) {
      try {
        return storage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        if (!key || !storage?.setItem || !storage?.getItem) return false;
        storage.setItem(key, value);
        return storage.getItem(key) === value;
      } catch {
        return false;
      }
    },
    remove(key) {
      try {
        if (!key || !storage?.removeItem || !storage?.getItem) return false;
        storage.removeItem(key);
        return storage.getItem(key) === null;
      } catch {
        return false;
      }
    },
  };
}

const defaultStorage = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
};

/** The saved start view, or null for the built-in default. */
export function readStartView(
  storage = defaultStorage(),
  storageKey = START_VIEW_STORAGE_KEY,
) {
  if (!storageKey) return null;
  const raw = safeStorage(storage).get(storageKey);
  const view = parseStartView(raw);
  if (!view) return null;
  const record = JSON.parse(raw);
  // Version-one records did not preserve privacy. Treat them as private, even
  // if an unversioned record contains a stray public flag. Permissions never persist.
  return { ...view, private: record.version !== 2 || record.private !== false };
}

/** Restore protection before constructing any HUD/share/voice consumers. */
export function restoreStartViewPrivacy(
  viewer,
  {
    storage = defaultStorage(),
    storageKey = START_VIEW_STORAGE_KEY,
    embedded = false,
  } = {},
) {
  if (embedded) return null;
  const view = readStartView(storage, storageKey);
  if (view?.private) markTakDataPrivate(viewer);
  return view;
}

/** The camera's current view, in the stored shape. */
export function captureStartView(viewer, label = '') {
  const carto = viewer.camera.positionCartographic;
  return parseStartView(
    JSON.stringify({
      label,
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
      height: carto.height,
      heading: Cesium.Math.toDegrees(viewer.camera.heading),
      pitch: Math.max(
        -90,
        Math.min(0, Cesium.Math.toDegrees(viewer.camera.pitch)),
      ),
    }),
  );
}

/**
 * Open on a view with a short fly-in from straight above. Views already
 * higher than the approach are set directly.
 * @returns {Function} Cancels the pending or active startup flight.
 */
export function flyToStartView(viewer, view = DEFAULT_START_VIEW) {
  const orientation = {
    heading: Cesium.Math.toRadians(view.heading),
    pitch: Cesium.Math.toRadians(view.pitch),
    roll: 0,
  };
  const destination = Cesium.Cartesian3.fromDegrees(
    view.lon,
    view.lat,
    view.height,
  );
  if (view.height >= APPROACH_HEIGHT_M) {
    viewer.camera.setView({ destination, orientation });
    return () => {};
  }
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      view.lon,
      view.lat,
      APPROACH_HEIGHT_M,
    ),
    orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
  });
  const timer = setTimeout(() => {
    if (viewer.isDestroyed()) return;
    viewer.camera.flyTo({
      destination,
      orientation,
      duration: 4.0,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 500);
  return () => {
    clearTimeout(timer);
    if (!viewer.isDestroyed()) viewer.camera.cancelFlight();
  };
}

/** "34.37°N 89.52°W" for a view without a place name. */
export function formatStartViewPlace(view) {
  const lat = `${Math.abs(view.lat).toFixed(2)}°${view.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(view.lon).toFixed(2)}°${view.lon >= 0 ? 'E' : 'W'}`;
  return `${lat} ${lon}`;
}

/** The configured default start view (see resolveDefaultStartView). */
export const DEFAULT_START_VIEW = resolveDefaultStartView(
  import.meta.env?.VITE_GEV_START_VIEW,
);

/**
 * The Location tray's start-view row: what the app opens on, "Start here"
 * to save the current camera view, "Reset" to go back to the default.
 * @param {object} options
 * @param {Cesium.Viewer} options.viewer
 * @param {{status:HTMLElement, set:HTMLButtonElement, clear:HTMLButtonElement}} options.elements
 * @param {(message:string)=>void} [options.showToast]
 * @param {Storage} [options.storage]
 */
export function bindStartViewControls({
  viewer,
  elements,
  showToast = () => {},
  storage = defaultStorage(),
  storageKey = START_VIEW_STORAGE_KEY,
  canUseStorage = () => true,
}) {
  const store = safeStorage(storage);
  const { status, set, clear } = elements || {};
  if (!status || !set || !clear) return { destroy() {} };

  function render() {
    const saved = canUseStorage() ? readStartView(storage, storageKey) : null;
    const name = saved
      ? saved.label || formatStartViewPlace(saved)
      : `${DEFAULT_START_VIEW.label} (default)`;
    status.textContent = `Start view: ${name}`;
    status.title = saved
      ? 'The app opens here on this device unless a share link or saved map says otherwise'
      : 'The built-in start view';
    clear.hidden = !saved;
  }

  function onSet() {
    // Labelled by coordinates: the tray's place line names the last city or
    // search, which may no longer be where the camera is.
    const view = captureStartView(viewer);
    if (!view) {
      showToast('This view cannot be used as the start view');
      return;
    }
    const record = {
      ...view,
      version: 2,
      private: takPrivacyState(viewer).private,
    };
    if (!canUseStorage() || !store.set(storageKey, JSON.stringify(record))) {
      showToast(
        'Browser or operator storage is blocked; the start view was not saved',
      );
      return;
    }
    render();
    showToast(
      `The app will open here: ${view.label || formatStartViewPlace(view)}`,
    );
  }

  function onClear() {
    if (!canUseStorage() || !store.remove(storageKey)) {
      render();
      showToast(
        'Browser or operator storage is blocked; the start view was not reset',
      );
      return;
    }
    render();
    showToast(`The app will open on ${DEFAULT_START_VIEW.label} again`);
  }

  set.addEventListener('click', onSet);
  clear.addEventListener('click', onClear);
  render();
  return {
    render,
    destroy() {
      set.removeEventListener('click', onSet);
      clear.removeEventListener('click', onClear);
    },
  };
}
