/** One owned foreground device watch, including cancellation of late callbacks. */
export function createGeolocation(
  geo = globalThis.navigator?.geolocation,
  { documentRef = globalThis.document, now = Date.now } = {},
) {
  let watchId = null;
  let generation = 0;
  let requested = null;
  let disposed = false;
  function clearWatch() {
    generation++;
    if (watchId !== null) geo?.clearWatch(watchId);
    watchId = null;
  }
  function stop() {
    requested = null;
    clearWatch();
  }
  function startWatch() {
    if (!requested || disposed || documentRef?.hidden) return true;
    clearWatch();
    const epoch = generation;
    let pendingError = false;
    const id = geo.watchPosition(
      (pos) => {
        if (epoch !== generation || !requested || documentRef?.hidden) return;
        const c = pos.coords;
        requested.onFix({
          lat: c.latitude,
          lon: c.longitude,
          observedAtMs: Number.isFinite(pos.timestamp) ? pos.timestamp : now(),
          hae: Number.isFinite(c.altitude) ? c.altitude : null,
          ce: Number.isFinite(c.accuracy) ? c.accuracy : null,
          le: Number.isFinite(c.altitudeAccuracy) ? c.altitudeAccuracy : null,
          course: Number.isFinite(c.heading) ? c.heading : undefined,
          speed: Number.isFinite(c.speed) ? c.speed : undefined,
        });
      },
      (error) => {
        if (epoch !== generation || !requested) return;
        // Lost signal (2) and slow fixes (3) are passing: the browser keeps
        // watching and the next fix arrives on its own, while the last one
        // ages out for its consumers. Only a refusal (1, or an unknown error)
        // ends the watch.
        if (error?.code === 2 || error?.code === 3) return;
        pendingError = true;
        const { onError } = requested;
        stop();
        onError(
          `Device GPS unavailable: ${error?.message || (error?.code === 1 ? 'permission denied' : 'unknown error')}`,
        );
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
    );
    if (pendingError || epoch !== generation) geo.clearWatch(id);
    else watchId = id;
    return !pendingError;
  }
  function visibility() {
    if (documentRef?.hidden) clearWatch();
    else if (requested) startWatch();
  }
  documentRef?.addEventListener('visibilitychange', visibility);
  return {
    start(onFix, onError) {
      stop();
      if (!geo || disposed) return false;
      requested = { onFix, onError };
      return startWatch();
    },
    stop,
    isActive: () => !!requested && !disposed && !documentRef?.hidden,
    destroy() {
      stop();
      disposed = true;
      documentRef?.removeEventListener('visibilitychange', visibility);
    },
  };
}
