/** One owned device watch, including cancellation of late callbacks. */
export function createGeolocation(geo = globalThis.navigator?.geolocation) {
  let watchId = null;
  let generation = 0;
  function stop() {
    generation++;
    if (watchId !== null) geo?.clearWatch(watchId);
    watchId = null;
  }
  return {
    start(onFix, onError) {
      stop();
      if (!geo) return false;
      const epoch = generation;
      let pendingError = false;
      const id = geo.watchPosition(
        (pos) => {
          if (epoch !== generation) return;
          const c = pos.coords;
          onFix({
            lat: c.latitude,
            lon: c.longitude,
            hae: Number.isFinite(c.altitude) ? c.altitude : null,
            ce: Number.isFinite(c.accuracy) ? c.accuracy : null,
            le: Number.isFinite(c.altitudeAccuracy) ? c.altitudeAccuracy : null,
            course: Number.isFinite(c.heading) ? c.heading : undefined,
            speed: Number.isFinite(c.speed) ? c.speed : undefined,
          });
        },
        (error) => {
          if (epoch !== generation) return;
          pendingError = true;
          stop();
          onError(
            `Device GPS unavailable: ${error.message || 'permission denied'}`,
          );
        },
        { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
      );
      if (pendingError || epoch !== generation) geo.clearWatch(id);
      else watchId = id;
      return !pendingError;
    },
    stop,
  };
}
