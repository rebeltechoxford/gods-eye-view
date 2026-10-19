import { createGeolocation } from '../tak/geolocation.js';

// A fix this recent is handed to a consumer that joins a running watch, so a
// second consumer does not wait for the next device update.
const SHARED_FIX_MAX_AGE_MS = 30_000;

/**
 * One device position watch shared by every consumer (the map's own location
 * dot, TAK self position). The watch runs while any consumer wants it and
 * pauses while the page is hidden; each consumer gets the same fixes.
 * Positions stay in memory on this device: nothing here stores or sends them.
 */
export function createDeviceLocation(
  geo = globalThis.navigator?.geolocation,
  { documentRef = globalThis.document, now = Date.now } = {},
) {
  const watch = createGeolocation(geo, { documentRef, now });
  const consumers = new Set();
  let lastFix = null;

  function deliver(fix) {
    lastFix = fix;
    for (const consumer of [...consumers]) consumer.onFix(fix);
  }
  function fail(message) {
    // The underlying watch has stopped; every consumer is told and released.
    const failed = [...consumers];
    consumers.clear();
    lastFix = null;
    for (const consumer of failed) consumer.onError(message);
  }
  function release(consumer) {
    if (!consumers.delete(consumer)) return;
    if (!consumers.size) {
      watch.stop();
      lastFix = null;
    }
  }

  /** A handle with the single-owner interface TAK's panel already uses. */
  function consumer() {
    let current = null;
    return {
      start(onFix, onError) {
        if (current) release(current);
        current = { onFix, onError };
        const entry = current;
        const wasRunning = consumers.size > 0 && watch.isActive();
        consumers.add(entry);
        if (wasRunning) {
          if (lastFix && now() - lastFix.observedAtMs <= SHARED_FIX_MAX_AGE_MS)
            entry.onFix(lastFix);
          return true;
        }
        const started = watch.start(deliver, fail);
        if (!started) {
          consumers.delete(entry);
          if (current === entry) current = null;
        }
        return started;
      },
      stop() {
        if (current) release(current);
        current = null;
      },
      isActive: () =>
        current !== null && consumers.has(current) && watch.isActive(),
      destroy() {
        this.stop();
      },
    };
  }

  return {
    consumer,
    lastFix: () => lastFix,
    destroy() {
      consumers.clear();
      lastFix = null;
      watch.destroy();
    },
  };
}

let shared = null;
/** The page-wide device location hub, created on first use. */
export function deviceLocation() {
  shared ??= createDeviceLocation();
  return shared;
}
