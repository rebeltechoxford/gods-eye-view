import { t } from '../i18n/index.js';
import * as Cesium from 'cesium';

const DOT_COLOR = Cesium.Color.fromCssColorString('#1a73e8');
const STALE_COLOR = Cesium.Color.fromCssColorString('#8a94a6');
const RING_ALPHA = 0.18;
// A fix older than this is drawn gray: the device has stopped updating.
export const MY_LOCATION_STALE_MS = 30_000;
// Center on me frames this high above the ground unless already closer.
export const MY_LOCATION_FRAME_HEIGHT_M = 2_500;
const MIN_FRAME_HEIGHT_M = 300;
// A one-finger drag longer than this hands the camera back to the user.
const DRAG_RELEASE_PX = 8;

/**
 * The map's own "my location": a blue dot with an accuracy ring from the
 * device's GPS, a button that centers on it, and FOLLOW, which keeps the
 * camera over the dot until the user drags the map or another view takes the
 * camera. Zooming does not end FOLLOW. The position stays on this device:
 * it is drawn, never stored or sent. Because FOLLOW puts the camera over the
 * user, the first fix calls `onPrivate`, which marks the page session private
 * like TAK self position: camera-derived AI lookups, share links and
 * recording stay blocked until the operator allows them.
 *
 * Button cycle: off → locating (then FOLLOW on the first fix) → shown after
 * the user pans → FOLLOW again on tap; a tap while following or locating
 * turns it off.
 *
 * @param {object} options
 * @param {Cesium.Viewer} options.viewer
 * @param {HTMLButtonElement} options.button
 * @param {{start:Function, stop:Function, isActive:Function}} options.location
 *   A device location consumer (see src/location/deviceLocation.js).
 * @param {{run:(noun:string, move:Function)=>boolean,
 *   subscribeHandoff:(listener:Function)=>Function}} [options.navigation]
 *   The application's camera authority. FOLLOW claims the camera once with
 *   `run`; any later handoff to another owner ends FOLLOW.
 * @param {() => void} [options.onPrivate] The first fix marks the view private.
 * @param {(message:string)=>void} [options.showToast]
 * @param {() => boolean} [options.isSecureContext]
 * @param {() => number} [options.now]
 */
export function createMyLocation({
  viewer,
  button,
  location,
  navigation = null,
  onPrivate = () => {},
  showToast = () => {},
  isSecureContext = () => globalThis.isSecureContext !== false,
  now = Date.now,
  setIntervalFn = globalThis.setInterval.bind(globalThis),
  clearIntervalFn = globalThis.clearInterval.bind(globalThis),
}) {
  let state = 'off';
  let fix = null;
  let followOnFix = false;
  let flying = false;
  let flightGeneration = 0;
  let destroyed = false;
  let staleTimer = null;
  const pointers = new Map();
  const dataSource = new Cesium.CustomDataSource('my-location');
  void viewer.dataSources.add(dataSource);
  const ring = dataSource.entities.add({
    id: 'my-location-accuracy',
    show: false,
    position: Cesium.Cartesian3.fromDegrees(0, 0),
    ellipse: {
      semiMajorAxis: 1,
      semiMinorAxis: 1,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      classificationType: Cesium.ClassificationType.BOTH,
      material: DOT_COLOR.withAlpha(RING_ALPHA),
    },
  });
  const dot = dataSource.entities.add({
    id: 'my-location',
    name: t('My location'),
    show: false,
    position: Cesium.Cartesian3.fromDegrees(0, 0),
    point: {
      pixelSize: 14,
      color: DOT_COLOR,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 3,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });

  const render = () => viewer.scene?.requestRender?.();

  function sync() {
    if (!button) return;
    button.dataset.state = state;
    button.setAttribute('aria-pressed', String(state !== 'off'));
    const label = {
      off: t('Show my location'),
      locating: t('Finding your location. Tap to stop'),
      shown: t('Center on my location and follow'),
      following: t('Following your location. Tap to turn off'),
    }[state];
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  function setState(next) {
    state = next;
    sync();
  }

  function draw() {
    if (!fix) {
      dot.show = false;
      ring.show = false;
      render();
      return;
    }
    const position = Cesium.Cartesian3.fromDegrees(fix.lon, fix.lat);
    dot.position = position;
    ring.position = position;
    const accuracy = Number.isFinite(fix.ce) ? Math.max(fix.ce, 2) : null;
    ring.show = accuracy !== null;
    if (accuracy !== null) {
      ring.ellipse.semiMajorAxis = accuracy;
      ring.ellipse.semiMinorAxis = accuracy;
    }
    const stale = now() - fix.observedAtMs > MY_LOCATION_STALE_MS;
    dot.point.color = stale ? STALE_COLOR : DOT_COLOR;
    ring.ellipse.material = (stale ? STALE_COLOR : DOT_COLOR).withAlpha(
      RING_ALPHA,
    );
    dot.show = true;
    if (button) button.dataset.stale = String(stale);
    render();
  }

  function groundHeight(lon, lat) {
    try {
      const height = viewer.scene?.globe?.getHeight(
        Cesium.Cartographic.fromDegrees(lon, lat),
      );
      // getHeight intersects the currently loaded terrain mesh. At a distant
      // fix its coarse triangles can lie kilometres below the ellipsoid even
      // with a zero-height terrain provider. Never turn that transient mesh
      // depth (or real below-sea-level terrain) into an underground camera.
      return Number.isFinite(height) ? Math.max(0, height) : 0;
    } catch {
      return 0;
    }
  }

  function cameraHeight() {
    const height = viewer.camera?.positionCartographic?.height;
    return Number.isFinite(height) ? height : Infinity;
  }

  function safeFollowHeight(next, height) {
    const ground = groundHeight(next.lon, next.lat);
    return Number.isFinite(height)
      ? Math.max(height, ground + MIN_FRAME_HEIGHT_M)
      : ground + MY_LOCATION_FRAME_HEIGHT_M;
  }

  function cancelOwnedFlight() {
    const owned = flying;
    flightGeneration++;
    flying = false;
    if (owned) viewer.camera.cancelFlight?.();
  }

  /** Claim the camera and fly to the fix; FOLLOW when the claim is granted. */
  function centerAndFollow() {
    if (!fix) return false;
    const target = fix;
    const move = () => {
      const ground = groundHeight(target.lon, target.lat);
      const height = Math.min(
        Math.max(cameraHeight(), ground + MIN_FRAME_HEIGHT_M),
        ground + MY_LOCATION_FRAME_HEIGHT_M,
      );
      const generation = ++flightGeneration;
      flying = true;
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          target.lon,
          target.lat,
          height,
        ),
        orientation: {
          heading: viewer.camera.heading,
          pitch: -Cesium.Math.PI_OVER_TWO,
          roll: 0,
        },
        duration: 1.0,
        complete: () => {
          if (destroyed || generation !== flightGeneration) return;
          flying = false;
          // Finish at the planned framing height. A completion callback must
          // not turn an intermediate camera altitude into the follow altitude.
          if (state === 'following') followTo(fix, height);
        },
        cancel: () => {
          if (generation !== flightGeneration) return;
          flying = false;
        },
      });
      return true;
    };
    // The application stamps its handoff before `move` runs, while this is
    // still locating or shown, so our own claim does not end FOLLOW.
    const granted = navigation?.run ? navigation.run('location', move) : move();
    setState(granted === true ? 'following' : 'shown');
    return granted === true;
  }

  /** Keep the camera over the fix at the user's current zoom. */
  function followTo(next, height = cameraHeight()) {
    if (state !== 'following' || flying || !next) return;
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        next.lon,
        next.lat,
        safeFollowHeight(next, height),
      ),
      orientation: {
        heading: viewer.camera.heading,
        pitch: -Cesium.Math.PI_OVER_TWO,
        roll: 0,
      },
    });
    render();
  }

  function onFix(next) {
    if (destroyed || state === 'off') return;
    // Before anything is drawn or the camera moves toward the user.
    if (!fix) onPrivate();
    fix = next;
    draw();
    if (followOnFix) {
      followOnFix = false;
      centerAndFollow();
    } else {
      if (state === 'locating') setState('shown');
      followTo(fix);
    }
  }

  function onError(message) {
    if (destroyed) return;
    turnOff();
    showToast(t(message) || t('Device location unavailable'));
  }

  function turnOn() {
    if (!isSecureContext()) {
      showToast(
        t('Your location needs the app opened over HTTPS (or localhost)'),
      );
      return;
    }
    followOnFix = true;
    setState('locating');
    const started = location.start(onFix, onError);
    if (!started) {
      // A synchronous permission error has already turned off and said why.
      if (state !== 'off') {
        turnOff();
        showToast(t('Device location is not available in this browser'));
      }
      return;
    }
    staleTimer ??= setIntervalFn(() => {
      if (fix) draw();
    }, 5_000);
  }

  function turnOff() {
    cancelOwnedFlight();
    location.stop();
    followOnFix = false;
    fix = null;
    pointers.clear();
    if (staleTimer !== null) clearIntervalFn(staleTimer);
    staleTimer = null;
    if (button) delete button.dataset.stale;
    setState('off');
    draw();
  }

  function onClick() {
    if (destroyed) return;
    if (state === 'off') turnOn();
    else if (state === 'shown') centerAndFollow();
    else turnOff();
  }

  /** The user took the camera: keep the dot, stop moving the map. */
  function release() {
    // New navigation also supersedes a location request that has not produced
    // its first fix yet. Receiving that fix may draw the dot, not steal back
    // the camera from a search, tracked contact or a physical map gesture.
    followOnFix = false;
    cancelOwnedFlight();
    if (state === 'following') setState('shown');
  }

  const unsubscribeHandoff = navigation?.subscribeHandoff?.(release) || null;

  // One-finger drags end FOLLOW; pinch and wheel zoom keep it.
  const canvas = viewer.scene?.canvas;
  const onPointerDown = (event) =>
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const onPointerMove = (event) => {
    const start = pointers.get(event.pointerId);
    if (!start || pointers.size !== 1) return;
    if (
      Math.hypot(event.clientX - start.x, event.clientY - start.y) >
      DRAG_RELEASE_PX
    )
      release();
  };
  const onPointerUp = (event) => pointers.delete(event.pointerId);
  canvas?.addEventListener('pointerdown', onPointerDown);
  canvas?.addEventListener('pointermove', onPointerMove);
  canvas?.addEventListener('pointerup', onPointerUp);
  canvas?.addEventListener('pointercancel', onPointerUp);
  button?.addEventListener('click', onClick);
  sync();

  return {
    state: () => state,
    fix: () => fix,
    toggle: onClick,
    destroy() {
      if (destroyed) return;
      turnOff();
      destroyed = true;
      unsubscribeHandoff?.();
      button?.removeEventListener('click', onClick);
      canvas?.removeEventListener('pointerdown', onPointerDown);
      canvas?.removeEventListener('pointermove', onPointerMove);
      canvas?.removeEventListener('pointerup', onPointerUp);
      canvas?.removeEventListener('pointercancel', onPointerUp);
      viewer.dataSources?.remove(dataSource, true);
    },
  };
}
